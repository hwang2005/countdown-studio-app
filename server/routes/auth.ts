import crypto from 'crypto';
import type { Express, Request, Response } from 'express';
import type { PoolClient } from 'pg';
import { getDbPool } from '../db.js';
import { isMailConfigured, sendMail } from '../../mailer.js';
import { checkRateLimit, getClientIp, DUMMY_HASH, hashPassword, verifyPassword } from '../security.js';
import {
  authenticateToken, bearer, insertUserAccount, loadUser, publicUser,
} from '../users.js';
import {
  readGoogleSetupToken, sanitizeGoogleUsername, signGoogleSetupToken, signSession, verifyGoogleIdToken,
} from '../session.js';
import type { AppRole } from '../types.js';

// Best-effort audit trail; never fails the surrounding request.
function passwordResetEvent(eventCode: string, userId: number | null, ip: string, userAgent: string, details: Record<string, unknown> = {}) {
  getDbPool()
    .query(
      `INSERT INTO auth_events (event_type_id, user_id, ip_address, user_agent, details)
       SELECT id, $2, $3::inet, $4, $5::jsonb FROM auth_event_types WHERE code=$1`,
      [eventCode, userId, ip, userAgent.slice(0, 255), JSON.stringify(details)]
    )
    .catch(() => { /* audit insert is optional */ });
}

export function registerAuthRoutes(app: Express) {
  app.post('/api/auth/register', async (req: Request, res: Response) => {
    const clientIp = getClientIp(req);
    if (!checkRateLimit(clientIp, 'register', 5, 10 * 60 * 1000)) {
      return res.status(429).json({ error: 'TOO_MANY_REQUESTS', message: 'Too many registration requests from this address. Please try again after 10 minutes.' });
    }

    const { username, email, password, displayName, role = 'individual', adminCode } = req.body || {};
    const normalizedRole = String(role).toLowerCase() as AppRole;
    if (
      !/^[a-zA-Z0-9_.-]{3,32}$/.test(String(username || '')) ||
      !/^\S+@\S+\.\S+$/.test(String(email || '')) ||
      String(password || '').length < 8 ||
      String(password || '').length > 128 ||
      !String(displayName || '').trim() ||
      String(displayName || '').length > 64
    ) {
      return res.status(400).json({ error: 'INVALID_INPUT', message: 'Username, email, display name, and password (8-128 characters) are required.' });
    }
    if (normalizedRole !== 'individual' && normalizedRole !== 'admin') return res.status(403).json({ error: 'ROLE_NOT_REGISTERABLE', message: 'Organization accounts can only be provisioned by an administrator.' });

    if (normalizedRole === 'admin') {
      const serverAdminCode = process.env.ADMIN_REGISTRATION_CODE;
      if (!serverAdminCode || !adminCode) return res.status(403).json({ error: 'INVALID_ADMIN_CODE' });
      const clientBuf = Buffer.from(String(adminCode));
      const serverBuf = Buffer.from(String(serverAdminCode));
      if (clientBuf.length !== serverBuf.length || !crypto.timingSafeEqual(clientBuf, serverBuf)) {
        return res.status(403).json({ error: 'INVALID_ADMIN_CODE' });
      }
    }

    let connection: PoolClient | undefined;
    try {
      connection = await getDbPool().connect(); await connection.query('BEGIN');
      const userId = await insertUserAccount(connection, { username: String(username).trim(), email: String(email).trim(), password: String(password), displayName: String(displayName).trim(), role: normalizedRole });
      await connection.query('COMMIT');
      const user = await loadUser(userId); if (!user) throw new Error('Created user could not be loaded.');
      return res.status(201).json({ user: publicUser(user), token: signSession(user) });
    } catch (error: any) { if (connection) await connection.query('ROLLBACK'); const duplicate = error?.code === '23505'; return res.status(duplicate ? 409 : 503).json({ error: duplicate ? 'ACCOUNT_EXISTS' : 'AUTH_DATABASE_UNAVAILABLE', message: duplicate ? 'Username or email already exists.' : 'Cannot connect to authentication database.' }); }
    finally { connection?.release(); }
  });

  app.post('/api/auth/login', async (req: Request, res: Response) => {
    const clientIp = getClientIp(req);
    if (!checkRateLimit(clientIp, 'login', 10, 60 * 1000)) {
      return res.status(429).json({ error: 'TOO_MANY_REQUESTS', message: 'Too many login attempts. Please try again after 1 minute.' });
    }

    const identifier = String(req.body?.identifier || '').trim();
    const password = String(req.body?.password || '');
    if (!identifier || !password || identifier.length > 100 || password.length > 128) {
      return res.status(400).json({ error: 'INVALID_INPUT', message: 'Invalid login input.' });
    }

    try {
      const { rows } = await getDbPool().query<any>(`SELECT u.id, c.password_hash, c.failed_attempts, c.locked_until FROM users u JOIN user_credentials c ON c.user_id=u.id
        JOIN user_emails e ON e.user_id=u.id AND e.is_primary=TRUE
        WHERE LOWER(u.username)=LOWER($1) OR LOWER(e.email)=LOWER($2) LIMIT 1`, [identifier, identifier]);

      const record = rows[0];
      if (record && record.locked_until && new Date(record.locked_until) > new Date()) {
        const remainingMinutes = Math.ceil((new Date(record.locked_until).getTime() - Date.now()) / (60 * 1000));
        return res.status(423).json({
          error: 'ACCOUNT_LOCKED',
          message: `Account is temporarily locked due to multiple failed attempts. Please try again after ${remainingMinutes} minute(s).`,
        });
      }

      if (!record) {
        // Run dummy verification to eliminate username/email enumeration timing attacks
        await verifyPassword(password, DUMMY_HASH);
        return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'Invalid credentials.' });
      }

      const isValid = await verifyPassword(password, record.password_hash);
      if (!isValid) {
        const nextAttempts = (record.failed_attempts || 0) + 1;
        if (nextAttempts >= 5) {
          await getDbPool().query(
            `UPDATE user_credentials SET failed_attempts=$1, locked_until=NOW() + INTERVAL '15 minutes' WHERE user_id=$2`,
            [nextAttempts, record.id]
          );
          return res.status(423).json({
            error: 'ACCOUNT_LOCKED',
            message: 'Account has been temporarily locked for 15 minutes due to 5 consecutive failed login attempts.',
          });
        } else {
          await getDbPool().query(
            `UPDATE user_credentials SET failed_attempts=$1 WHERE user_id=$2`,
            [nextAttempts, record.id]
          );
          return res.status(401).json({
            error: 'INVALID_CREDENTIALS',
            message: `Invalid credentials. ${5 - nextAttempts} attempt(s) remaining.`,
          });
        }
      }

      const user = await loadUser(record.id);
      if (!user) return res.status(403).json({ error: 'ACCOUNT_INACTIVE_OR_ROLE_INVALID' });
      await getDbPool().query('UPDATE user_credentials SET last_login_at=NOW(), failed_attempts=0, locked_until=NULL WHERE user_id=$1', [user.id]);
      return res.json({ user: publicUser(user), token: signSession(user) });
    } catch (error) {
      console.error('[Auth] Login failed:', error);
      return res.status(503).json({ error: 'AUTH_DATABASE_UNAVAILABLE', message: 'Cannot connect to authentication database.' });
    }
  });

  // ── Forgot credentials (self-service password reset) ─────────────────────
  // Uses the one_time_tokens table (type 'password_reset') seeded in
  // countdown-auth-schema.sql. Tokens are single-use, 30 minutes, hashed at
  // rest; the reset email is sent through the Resend SMTP relay (mailer.ts).
  app.post('/api/auth/forgot-password', async (req: Request, res: Response) => {
    const clientIp = getClientIp(req);
    if (!checkRateLimit(clientIp, 'forgot_password', 5, 10 * 60 * 1000)) {
      return res.status(429).json({ error: 'TOO_MANY_REQUESTS', message: 'Too many reset requests. Please try again after 10 minutes.' });
    }

    const email = String(req.body?.email || '').trim();
    if (!email || email.length > 254 || !/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(400).json({ error: 'INVALID_INPUT', message: 'A valid email address is required.' });
    }

    // The response is always identical whether or not the email exists, so
    // callers cannot enumerate registered accounts.
    const genericSuccess = () => res.json({
      message: 'If that email address belongs to an account, a password reset link has been sent. Please check your inbox.',
    });

    if (!isMailConfigured()) {
      console.error('[Auth] Forgot password skipped: SMTP is not configured.');
      return res.status(503).json({ error: 'MAIL_NOT_CONFIGURED', message: 'Password recovery is temporarily unavailable. Please try again later.' });
    }

    try {
      const { rows } = await getDbPool().query<{ id: number; user_id: number }>(
        `SELECT e.id, u.id AS user_id
         FROM users u
         JOIN user_emails e ON e.user_id = u.id AND e.is_primary = TRUE
         JOIN user_statuses s ON s.id = u.status_id AND s.code = 'active'
         WHERE LOWER(e.email) = LOWER($1) LIMIT 1`,
        [email]
      );
      const record = rows[0];
      passwordResetEvent('password_reset_requested', record?.user_id ?? null, clientIp, req.get('user-agent') || '');

      if (record) {
        // Single-use opaque token; only its SHA-256 hash is stored.
        const token = crypto.randomBytes(32).toString('base64url');
        const tokenHash = crypto.createHash('sha256').update(token).digest();
        const expiresAt = new Date(Date.now() + 30 * 60 * 1000);

        const connection = await getDbPool().connect();
        try {
          await connection.query('BEGIN');
          // A new request invalidates every still-unused reset token for the
          // account so only the latest email link works.
          await connection.query(
            `UPDATE one_time_tokens t SET used_at = NOW()
             FROM one_time_token_types tt
             WHERE t.type_id = tt.id AND tt.code = 'password_reset'
               AND t.user_id = $1 AND t.used_at IS NULL`,
            [record.user_id]
          );
          await connection.query(
            `INSERT INTO one_time_tokens (user_id, type_id, user_email_id, token_hash, expires_at)
             SELECT $1, tt.id, $2, $3, $4 FROM one_time_token_types tt WHERE tt.code = 'password_reset'`,
            [record.user_id, record.id, tokenHash, expiresAt]
          );
          await connection.query('COMMIT');
        } finally {
          connection.release();
        }

        const resetBase = (process.env.APP_URL?.trim() || 'https://www.countdown-studio.id.vn').replace(/\/+$/, '');
        const resetLink = `${resetBase}/reset-password.html?token=${encodeURIComponent(token)}`;
        await sendMail({
          to: email.trim().toLowerCase(),
          subject: 'Reset your Countdown Studio password',
          text:
            'We received a request to reset the password for your Countdown Studio account.\n\n' +
            `Open this link within 30 minutes to choose a new password:\n${resetLink}\n\n` +
            'If you did not request this, you can safely ignore this email — your current password keeps working.\n',
          html:
            '<p>We received a request to reset the password for your <strong>Countdown Studio</strong> account.</p>' +
            `<p><a href="${resetLink}" style="display:inline-block;padding:12px 22px;border-radius:10px;background:#2563eb;color:#ffffff;text-decoration:none;font-weight:600">Choose a new password</a></p>` +
            '<p style="color:#6b7280">This link is single-use and expires in 30 minutes.</p>' +
            '<p style="color:#6b7280">If you did not request it, ignore this email — your current password keeps working.</p>',
        });
      }

      return genericSuccess();
    } catch (error) {
      console.error('[Auth] Forgot password failed:', error);
      return res.status(503).json({ error: 'MAIL_SEND_FAILED', message: 'Could not send the reset email. Please try again later.' });
    }
  });

  // Exchanges a valid reset token for a new password. Token claiming uses a
  // single conditional UPDATE so a link cannot be redeemed twice.
  app.post('/api/auth/reset-password', async (req: Request, res: Response) => {
    const clientIp = getClientIp(req);
    if (!checkRateLimit(clientIp, 'reset_password', 10, 10 * 60 * 1000)) {
      return res.status(429).json({ error: 'TOO_MANY_REQUESTS', message: 'Too many attempts. Please try again after 10 minutes.' });
    }

    const token = String(req.body?.token || '').trim();
    const password = String(req.body?.password || '');
    if (!token || token.length > 200) {
      return res.status(400).json({ error: 'INVALID_INPUT', message: 'Reset token is missing or malformed.' });
    }
    if (password.length < 8 || password.length > 128) {
      return res.status(400).json({ error: 'INVALID_PASSWORD', message: 'Password must be between 8 and 128 characters.' });
    }

    try {
      const tokenHash = crypto.createHash('sha256').update(token).digest();
      // Atomically claim the token: the conditional UPDATE fails once the
      // row already carries used_at, so replays are impossible.
      const { rows } = await getDbPool().query<{ user_id: number }>(
        `UPDATE one_time_tokens SET used_at = NOW()
         WHERE token_hash = $1
           AND type_id = (SELECT id FROM one_time_token_types WHERE code = 'password_reset')
           AND used_at IS NULL
           AND expires_at > NOW()
         RETURNING user_id`,
        [tokenHash]
      );
      const claimed = rows[0];
      if (!claimed) {
        return res.status(400).json({ error: 'EXPIRED_OR_INVALID_TOKEN', message: 'This reset link is invalid or has expired. Please request a new one.' });
      }

      const passHash = await hashPassword(password);
      const result = await getDbPool().query(
        `INSERT INTO user_credentials (user_id, password_hash, password_changed_at, failed_attempts, last_login_at)
         VALUES ($1, $2, NOW(), 0, NOW())
         ON CONFLICT (user_id) DO UPDATE
           SET password_hash = EXCLUDED.password_hash, password_changed_at = NOW(),
               failed_attempts = 0, locked_until = NULL`,
        [claimed.user_id, passHash]
      );
      if (!result.rowCount) throw new Error('Credential upsert failed.');

      passwordResetEvent('password_changed', claimed.user_id, clientIp, req.get('user-agent') || '');

      return res.json({ message: 'Password updated. You can now sign in with your new password.' });
    } catch (error) {
      console.error('[Auth] Reset password failed:', error);
      return res.status(503).json({ error: 'AUTH_DATABASE_UNAVAILABLE', message: 'Cannot update the password right now. Please try again later.' });
    }
  });

  // Google OAuth endpoint: verifies Google credential & checks whether password initialization is required
  app.post('/api/auth/google', async (req: Request, res: Response) => {
    const clientIp = getClientIp(req);
    if (!checkRateLimit(clientIp, 'google_auth', 20, 60 * 1000)) {
      return res.status(429).json({ error: 'TOO_MANY_REQUESTS', message: 'Too many requests. Please wait a minute.' });
    }

    const { credential } = req.body || {};
    let googleUser: { sub: string; email: string; name: string; picture?: string } | null = null;

    if (credential) {
      googleUser = await verifyGoogleIdToken(String(credential));
    }

    if (!googleUser || !googleUser.email || !googleUser.sub) {
      return res.status(400).json({
        error: 'INVALID_CREDENTIAL',
        message: 'Google authentication credential verification failed.',
      });
    }

    const normalizedEmail = googleUser.email.trim().toLowerCase();

    try {
      // 1. Check if user already exists by Google provider_user_id
      const identityQuery = await getDbPool().query<any>(
        `SELECT u.id, u.username, u.status_id, c.password_hash
         FROM users u
         JOIN user_identities ui ON ui.user_id = u.id
         JOIN auth_providers ap ON ap.id = ui.provider_id AND ap.code = 'google'
         LEFT JOIN user_credentials c ON c.user_id = u.id
         WHERE ui.provider_user_id = $1 LIMIT 1`,
        [googleUser.sub]
      );

      let record = identityQuery.rows[0];

      // 2. If not found by Google provider ID, check by primary email
      if (!record) {
        const emailQuery = await getDbPool().query<any>(
          `SELECT u.id, u.username, u.status_id, c.password_hash
           FROM users u
           JOIN user_emails e ON e.user_id = u.id AND LOWER(e.email) = LOWER($1)
           LEFT JOIN user_credentials c ON c.user_id = u.id LIMIT 1`,
          [normalizedEmail]
        );
        record = emailQuery.rows[0];
      }

      // Google authentication is login-only. The account must already exist
      // from the web registration flow and have a password credential.
      if (!record || !record.password_hash) {
        return res.status(403).json({
          error: 'ACCOUNT_NOT_REGISTERED',
          message: 'This account is not registered on the website. Please register first.',
        });
      }

      // Existing registered user: authenticate session directly.
      if (record && record.password_hash) {
        const user = await loadUser(record.id);
        if (!user) {
          return res.status(403).json({
            error: 'ACCOUNT_INACTIVE_OR_ROLE_INVALID',
            message: 'Account is suspended or invalid.',
          });
        }

        // Ensure Google identity is linked if not already
        await getDbPool().query(
          `INSERT INTO auth_providers (code) VALUES ('google') ON CONFLICT (code) DO NOTHING`
        );
        await getDbPool().query(
          `INSERT INTO user_identities (user_id, provider_id, provider_user_id)
           SELECT $1, id, $2 FROM auth_providers WHERE code = 'google'
           ON CONFLICT (provider_id, provider_user_id) DO NOTHING`,
          [user.id, googleUser.sub]
        );

        await getDbPool().query(
          'UPDATE user_credentials SET last_login_at=NOW(), failed_attempts=0, locked_until=NULL WHERE user_id=$1',
          [user.id]
        );

        return res.json({
          requirePasswordSetup: false,
          user: publicUser(user),
          token: signSession(user),
        });
      }

      // If user is new OR user does not have a password initialized:
      // MANDATORY: Require initializing password to save into database!
      const setupToken = signGoogleSetupToken({
        sub: googleUser.sub,
        email: normalizedEmail,
        displayName: googleUser.name,
        avatarUrl: googleUser.picture || null,
        existingUserId: record ? record.id : null,
      });

      return res.json({
        requirePasswordSetup: true,
        setupToken,
        email: normalizedEmail,
        displayName: googleUser.name,
        avatarUrl: googleUser.picture || null,
        suggestedUsername: record ? record.username : sanitizeGoogleUsername(normalizedEmail.split('@')[0]),
      });
    } catch (error) {
      console.error('[Google Auth] Error during lookup:', error);
      return res.status(503).json({
        error: 'AUTH_DATABASE_UNAVAILABLE',
        message: 'Cannot connect to authentication database.',
      });
    }
  });

  // Password Initialization Endpoint: Saves initialized password into database
  app.post('/api/auth/google/set-password', async (req: Request, res: Response) => {
    const clientIp = getClientIp(req);
    if (!checkRateLimit(clientIp, 'google_set_password', 10, 60 * 1000)) {
      return res.status(429).json({ error: 'TOO_MANY_REQUESTS', message: 'Too many requests. Please wait a minute.' });
    }

    const { setupToken, password, username, displayName } = req.body || {};
    if (!setupToken || !password) {
      return res.status(400).json({ error: 'INVALID_INPUT', message: 'Setup token and password are required.' });
    }

    const payload = readGoogleSetupToken(String(setupToken));
    if (!payload) {
      return res.status(401).json({
        error: 'EXPIRED_OR_INVALID_TOKEN',
        message: 'Password setup session has expired or is invalid. Please sign in with Google again.',
      });
    }

    const trimmedPassword = String(password);
    if (trimmedPassword.length < 8 || trimmedPassword.length > 128) {
      return res.status(400).json({
        error: 'INVALID_PASSWORD',
        message: 'Password must be between 8 and 128 characters.',
      });
    }

    const finalUsername = String(username || payload.email.split('@')[0]).trim();
    if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(finalUsername)) {
      return res.status(400).json({
        error: 'INVALID_USERNAME',
        message: 'Username must be 3-32 characters (letters, numbers, hyphens, dots, underscores).',
      });
    }

    const finalDisplayName = String(displayName || payload.displayName || finalUsername).trim().slice(0, 64);
    if (!finalDisplayName) {
      return res.status(400).json({ error: 'INVALID_NAME', message: 'Display name is required.' });
    }

    let connection: PoolClient | undefined;
    try {
      connection = await getDbPool().connect();
      await connection.query('BEGIN');

      // Ensure 'google' provider exists in auth_providers
      await connection.query(`INSERT INTO auth_providers (code) VALUES ('google') ON CONFLICT (code) DO NOTHING`);

      const passHash = await hashPassword(trimmedPassword);
      let targetUserId: number;

      if (payload.existingUserId) {
        targetUserId = payload.existingUserId;

        // Save password into user_credentials
        await connection.query(
          `INSERT INTO user_credentials (user_id, password_hash, password_changed_at, failed_attempts, last_login_at)
           VALUES ($1, $2, NOW(), 0, NOW())
           ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash, password_changed_at = NOW(), failed_attempts = 0, locked_until = NULL, last_login_at = NOW()`,
          [targetUserId, passHash]
        );

        // Ensure Google identity is linked
        await connection.query(
          `INSERT INTO user_identities (user_id, provider_id, provider_user_id)
           SELECT $1, id, $2 FROM auth_providers WHERE code = 'google'
           ON CONFLICT (provider_id, provider_user_id) DO NOTHING`,
          [targetUserId, payload.sub]
        );

        // Update profile
        await connection.query(
          `UPDATE user_profiles SET display_name = $2, avatar_url = COALESCE($3, avatar_url), updated_at = NOW() WHERE user_id = $1`,
          [targetUserId, finalDisplayName, payload.avatarUrl]
        );

        // Update username if requested and changed
        if (finalUsername) {
          await connection.query(`UPDATE users SET username = $2, updated_at = NOW() WHERE id = $1`, [targetUserId, finalUsername]);
        }
      } else {
        // Create new user in users table
        const publicId = crypto.randomUUID();
        const userRes = await connection.query<{ id: number }>(
          `INSERT INTO users (public_id, username, status_id)
           SELECT $1::uuid, $2, id FROM user_statuses WHERE code='active'
           RETURNING id`,
          [publicId, finalUsername]
        );
        const newId = userRes.rows[0]?.id;
        if (!newId) throw new Error('Failed to create user record.');
        targetUserId = newId;

        // Save password into user_credentials
        await connection.query(
          `INSERT INTO user_credentials (user_id, password_hash, password_changed_at, last_login_at)
           VALUES ($1, $2, NOW(), NOW())`,
          [targetUserId, passHash]
        );

        // Save email into user_emails
        await connection.query(
          `INSERT INTO user_emails (user_id, email, is_primary, verified_at)
           VALUES ($1, LOWER($2), TRUE, NOW())`,
          [targetUserId, payload.email]
        );

        // Save profile into user_profiles
        await connection.query(
          `INSERT INTO user_profiles (user_id, display_name, avatar_url)
           VALUES ($1, $2, $3)`,
          [targetUserId, finalDisplayName, payload.avatarUrl]
        );

        // Save identity into user_identities
        await connection.query(
          `INSERT INTO user_identities (user_id, provider_id, provider_user_id)
           SELECT $1, id, $2 FROM auth_providers WHERE code = 'google'`,
          [targetUserId, payload.sub]
        );

        // Assign individual role
        await connection.query(
          `INSERT INTO user_roles (user_id, role_id)
           SELECT $1, id FROM roles WHERE code = 'individual'`,
          [targetUserId]
        );
      }

      await connection.query('COMMIT');

      const user = await loadUser(targetUserId);
      if (!user) throw new Error('Active user could not be loaded after creation.');

      return res.status(201).json({
        user: publicUser(user),
        token: signSession(user),
        message: 'Password successfully initialized and saved to database.',
      });
    } catch (error: any) {
      if (connection) await connection.query('ROLLBACK');
      const isDuplicate = error?.code === '23505';
      if (isDuplicate) {
        return res.status(409).json({
          error: 'USERNAME_OR_EMAIL_EXISTS',
          message: 'Username or email already exists. Please choose a different username.',
        });
      }
      console.error('[Google Auth] Set password failed:', error);
      return res.status(503).json({
        error: 'AUTH_DATABASE_UNAVAILABLE',
        message: 'Cannot save credentials to database.',
      });
    } finally {
      connection?.release();
    }
  });

  app.get('/api/auth/me', async (req: Request, res: Response) => {
    try {
      const user = await authenticateToken(bearer(req));
      if (!user) return res.status(401).json({ error: 'UNAUTHENTICATED' });
      return res.json({ user: publicUser(user) });
    } catch {
      return res.status(503).json({ error: 'AUTH_DATABASE_UNAVAILABLE' });
    }
  });

  app.get('/api/auth/config', (_req: Request, res: Response) =>
    res.json({
      adminRegistrationEnabled: Boolean(process.env.ADMIN_REGISTRATION_CODE),
      googleClientId: process.env.GOOGLE_CLIENT_ID || '',
      googleAuthEnabled: true,
    })
  );
}
