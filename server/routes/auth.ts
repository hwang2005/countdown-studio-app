import crypto from 'crypto';
import type { Express, Request, Response } from 'express';
import type { PoolClient } from 'pg';
import { getDbPool } from '../db.js';
import { readPositiveInteger } from '../env.js';
import { isMailConfigured, sendMail } from '../../mailer.js';
import { isAllowedOrigin } from '../middleware.js';
import { checkRateLimit, getClientIp, DUMMY_HASH, hashPassword, verifyPassword } from '../security.js';
import {
  authenticateToken, bearer, insertUserAccount, loadUser, publicUser,
} from '../users.js';
import {
  readGoogleSetupToken, sanitizeGoogleUsername, signGoogleSetupToken, signSession, verifyGoogleIdToken,
} from '../session.js';
import type { AppRole } from '../types.js';

// Best-effort audit trail; never fails the surrounding request.
function recordAuthEvent(eventCode: string, userId: number | null, ip: string, userAgent: string, details: Record<string, unknown> = {}) {
  getDbPool()
    .query(
      `INSERT INTO auth_events (event_type_id, user_id, ip_address, user_agent, details)
       SELECT id, $2, $3::inet, $4, $5::jsonb FROM auth_event_types WHERE code=$1`,
      [eventCode, userId, ip, userAgent.slice(0, 255), JSON.stringify(details)]
    )
    .catch(() => { /* audit insert is optional */ });
}

function resolveResetBaseUrl(req: Request): string {
  const envUrl = String(process.env.APP_URL || '').trim();
  if (/^https?:\/\/[^/\s]+/i.test(envUrl)) {
    return envUrl.replace(/\/+$/, '');
  }
  const origin = req.get('Origin');
  if (origin && isAllowedOrigin(origin, req) && /^https?:\/\/[^/\s]+/i.test(origin)) {
    return origin.replace(/\/+$/, '');
  }
  const host = req.get('host');
  if (host) {
    return `${req.protocol}://${host}`.replace(/\/+$/, '');
  }
  return 'https://www.countdown-studio.id.vn';
}

export function registerAuthRoutes(app: Express) {
  app.post('/api/auth/register', async (req: Request, res: Response) => {
    const clientIp = getClientIp(req);
    if (!checkRateLimit(clientIp, 'register', 5, 10 * 60 * 1000)) {
      return res.status(429).json({ error: 'TOO_MANY_REQUESTS', message: 'Too many registration requests from this address. Please try again after 10 minutes.' });
    }

    const body = req.body || {};
    const username = String(body.username || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    const displayName = String(body.displayName || '').trim();
    const adminCode = body.adminCode;
    const normalizedRole = String(body.role || 'individual').trim().toLowerCase() as AppRole;
    if (
      !/^[a-zA-Z0-9_.-]{3,32}$/.test(username) ||
      !/^\S+@\S+\.\S+$/.test(email) ||
      email.length > 254 ||
      password.length < 8 ||
      password.length > 128 ||
      !displayName ||
      displayName.length > 64
    ) {
      return res.status(400).json({ error: 'INVALID_INPUT', message: 'Username (3-32 chars), valid email, display name (max 64 chars), and password (8-128 characters) are required.' });
    }
    if (body.passwordConfirm !== undefined && String(body.passwordConfirm) !== password) {
      return res.status(400).json({ error: 'PASSWORD_MISMATCH', message: 'Confirmation password does not match.' });
    }
    if (normalizedRole !== 'individual' && normalizedRole !== 'admin') return res.status(403).json({ error: 'ROLE_NOT_REGISTERABLE', message: 'Organization accounts can only be provisioned by an administrator.' });

    if (normalizedRole === 'admin') {
      const serverAdminCode = process.env.ADMIN_REGISTRATION_CODE;
      if (!serverAdminCode || !adminCode) return res.status(403).json({ error: 'INVALID_ADMIN_CODE', message: 'Invalid admin registration code.' });
      const clientBuf = Buffer.from(String(adminCode));
      const serverBuf = Buffer.from(String(serverAdminCode));
      if (clientBuf.length !== serverBuf.length || !crypto.timingSafeEqual(clientBuf, serverBuf)) {
        return res.status(403).json({ error: 'INVALID_ADMIN_CODE', message: 'Invalid admin registration code.' });
      }
    }

    let connection: PoolClient | undefined;
    try {
      connection = await getDbPool().connect(); await connection.query('BEGIN');
      const existingCheck = await connection.query<{
        id: number;
        username: string;
        deleted_at: Date | null;
        status: string;
        email: string | null;
      }>(
        `SELECT u.id, u.username, u.deleted_at, s.code AS status, e.email
         FROM users u
         LEFT JOIN user_statuses s ON s.id = u.status_id
         LEFT JOIN user_emails e ON e.user_id = u.id
         WHERE LOWER(u.username) = LOWER($1) OR LOWER(e.email) = LOWER($2)`,
        [username, email]
      );
      if (existingCheck.rows.length > 0) {
        await connection.query('ROLLBACK');
        const emailMatch = existingCheck.rows.find((row) => row.email && row.email.toLowerCase() === email);
        if (emailMatch) {
          if (emailMatch.deleted_at || emailMatch.status === 'deleted') {
            return res.status(409).json({
              error: 'ACCOUNT_DELETED',
              message: 'This email belongs to a deactivated account. Please contact an administrator.',
            });
          }
          return res.status(409).json({
            error: 'EMAIL_EXISTS',
            message: 'An account with this email already exists. Please sign in or use "Forgot credentials?" to reset your password.',
          });
        }
        const usernameMatch = existingCheck.rows[0];
        if (usernameMatch.deleted_at || usernameMatch.status === 'deleted') {
          return res.status(409).json({
            error: 'ACCOUNT_DELETED',
            message: 'This username belongs to a deactivated account. Please choose a different username.',
          });
        }
        return res.status(409).json({
          error: 'USERNAME_EXISTS',
          message: 'This username is already taken. Please choose a different username.',
        });
      }
      const userId = await insertUserAccount(connection, { username, email, password, displayName, role: normalizedRole, markLoggedIn: true });
      const user = await loadUser(userId, connection);
      if (!user) throw new Error('Created user could not be loaded.');
      await connection.query('COMMIT');
      recordAuthEvent('register', user.id, clientIp, req.get('user-agent') || '', { role: normalizedRole, method: 'password' });
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
    if (!identifier || !password || identifier.length > 254 || password.length > 128) {
      return res.status(400).json({ error: 'INVALID_INPUT', message: 'Invalid login input.' });
    }

    const userAgent = req.get('user-agent') || '';
    try {
      const { rows } = await getDbPool().query<any>(
        `SELECT u.id, s.code AS status,
                (c.user_id IS NOT NULL) AS has_credentials,
                c.password_hash, c.failed_attempts, c.last_failed_at, c.locked_until
         FROM users u
         JOIN user_statuses s ON s.id = u.status_id
         LEFT JOIN user_credentials c ON c.user_id = u.id
         WHERE u.deleted_at IS NULL
           AND (
             LOWER(u.username) = LOWER($1)
             OR EXISTS (
               SELECT 1 FROM user_emails e
               WHERE e.user_id = u.id AND LOWER(e.email) = LOWER($1)
             )
           )
         ORDER BY CASE WHEN LOWER(u.username) = LOWER($1) THEN 0 ELSE 1 END, u.id ASC
         LIMIT 1`,
        [identifier]
      );

      const record = rows[0];
      if (!record) {
        // Run dummy verification to eliminate username/email enumeration timing attacks
        await verifyPassword(password, DUMMY_HASH);
        recordAuthEvent('login_failed', null, clientIp, userAgent, { reason: 'unknown_account' });
        return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'Invalid username/email or password.' });
      }

      if (record.locked_until && new Date(record.locked_until).getTime() > Date.now()) {
        const remainingMinutes = Math.ceil((new Date(record.locked_until).getTime() - Date.now()) / (60 * 1000));
        return res.status(423).json({
          error: 'ACCOUNT_LOCKED',
          message: `Account is temporarily locked due to multiple failed attempts. Please try again after ${remainingMinutes} minute(s).`,
        });
      }

      if (!record.has_credentials || !record.password_hash) {
        await verifyPassword(password, DUMMY_HASH);
        if (record.status !== 'active') {
          return res.status(403).json({
            error: 'ACCOUNT_INACTIVE_OR_ROLE_INVALID',
            message: 'Your account is suspended or inactive. Please contact an administrator.',
          });
        }
        recordAuthEvent('login_failed', record.id, clientIp, userAgent, { reason: 'password_not_initialized' });
        return res.status(401).json({
          error: 'PASSWORD_NOT_INITIALIZED',
          message: 'This account has not set a password yet. Please sign in with Google or use "Forgot credentials?" to set one.',
        });
      }

      const MAX_LOGIN_ATTEMPTS = 5;
      const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;
      const isValid = await verifyPassword(password, record.password_hash);
      if (!isValid) {
        if (record.status !== 'active') {
          recordAuthEvent('login_failed', record.id, clientIp, userAgent, { reason: 'invalid_password_inactive' });
          return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'Invalid credentials.' });
        }
        const lockExpired = Boolean(record.locked_until && new Date(record.locked_until).getTime() <= Date.now());
        const windowExpired = Boolean(record.last_failed_at && Date.now() - new Date(record.last_failed_at).getTime() > LOCKOUT_WINDOW_MS);
        const baseAttempts = (lockExpired || windowExpired) ? 0 : Number(record.failed_attempts || 0);
        const nextAttempts = baseAttempts + 1;
        if (nextAttempts >= MAX_LOGIN_ATTEMPTS) {
          await getDbPool().query(
            `UPDATE user_credentials
                SET failed_attempts=$1, last_failed_at=NOW(), locked_until=NOW() + INTERVAL '15 minutes'
              WHERE user_id=$2`,
            [nextAttempts, record.id]
          );
          recordAuthEvent('account_locked', record.id, clientIp, userAgent, { attempts: nextAttempts });
          return res.status(423).json({
            error: 'ACCOUNT_LOCKED',
            message: `Account has been temporarily locked for 15 minutes due to ${MAX_LOGIN_ATTEMPTS} consecutive failed login attempts.`,
          });
        } else {
          await getDbPool().query(
            `UPDATE user_credentials
                SET failed_attempts=$1, last_failed_at=NOW(), locked_until=NULL
              WHERE user_id=$2`,
            [nextAttempts, record.id]
          );
          recordAuthEvent('login_failed', record.id, clientIp, userAgent, { attempts: nextAttempts });
          return res.status(401).json({
            error: 'INVALID_CREDENTIALS',
            remainingAttempts: MAX_LOGIN_ATTEMPTS - nextAttempts,
            message: `Invalid credentials. ${MAX_LOGIN_ATTEMPTS - nextAttempts} attempt(s) remaining before temporary lockout.`,
          });
        }
      }

      if (record.status !== 'active') {
        return res.status(403).json({
          error: 'ACCOUNT_INACTIVE_OR_ROLE_INVALID',
          message: 'Your account is suspended or inactive. Please contact an administrator.',
        });
      }

      const user = await loadUser(record.id);
      if (!user) {
        return res.status(403).json({
          error: 'ACCOUNT_INACTIVE_OR_ROLE_INVALID',
          message: 'Your account is suspended or lacks a valid role.',
        });
      }
      await getDbPool().query(
        'UPDATE user_credentials SET last_login_at=NOW(), failed_attempts=0, last_failed_at=NULL, locked_until=NULL WHERE user_id=$1',
        [user.id]
      );
      recordAuthEvent('login_success', user.id, clientIp, userAgent, { method: 'password' });
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
         JOIN user_statuses s ON s.id = u.status_id AND s.code IN ('active', 'pending')
         LEFT JOIN LATERAL (
           SELECT id, email
             FROM user_emails
            WHERE user_id = u.id
            ORDER BY is_primary DESC, id ASC
            LIMIT 1
         ) e ON TRUE
         WHERE u.deleted_at IS NULL
           AND LOWER(e.email) = LOWER($1)
         LIMIT 1`,
        [email]
      );
      const record = rows[0];
      recordAuthEvent('password_reset_requested', record?.user_id ?? null, clientIp, req.get('user-agent') || '');

      if (record) {
        // Single-use opaque token; only its SHA-256 hash is stored.
        const token = crypto.randomBytes(32).toString('base64url');
        const tokenHash = crypto.createHash('sha256').update(token).digest();
        // Validity window is configurable via RESET_LINK_TTL_MINUTES (minutes,
        // default 30, capped at 1440 = 1 day as a safety net).
        const ttlMinutes = Math.min(readPositiveInteger(process.env.RESET_LINK_TTL_MINUTES, 30), 1440);
        const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);

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

        const resetBase = resolveResetBaseUrl(req);
        const resetLink = `${resetBase}/reset-password.html?token=${encodeURIComponent(token)}`;
        await sendMail({
          to: email.trim().toLowerCase(),
          subject: 'Reset your Countdown Studio password',
          text:
            'We received a request to reset the password for your Countdown Studio account.\n\n' +
            `Open this link within ${ttlMinutes} ${ttlMinutes === 1 ? 'minute' : 'minutes'} to choose a new password:\n${resetLink}\n\n` +
            'If you did not request this, you can safely ignore this email — your current password keeps working.\n',
          html:
            '<p>We received a request to reset the password for your <strong>Countdown Studio</strong> account.</p>' +
            `<p><a href="${resetLink}" style="display:inline-block;padding:12px 22px;border-radius:10px;background:#2563eb;color:#ffffff;text-decoration:none;font-weight:600">Choose a new password</a></p>` +
            `<p style="color:#6b7280">This link is single-use and expires in ${ttlMinutes} minutes.</p>` +
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
        `INSERT INTO user_credentials (user_id, password_hash, password_changed_at, failed_attempts, last_failed_at, locked_until, last_login_at)
         VALUES ($1, $2, NOW(), 0, NULL, NULL, NOW())
         ON CONFLICT (user_id) DO UPDATE
           SET password_hash = EXCLUDED.password_hash, password_changed_at = NOW(),
               failed_attempts = 0, last_failed_at = NULL, locked_until = NULL`,
        [claimed.user_id, passHash]
      );
      if (!result.rowCount) throw new Error('Credential upsert failed.');

      await getDbPool().query(
        `UPDATE user_emails SET verified_at = COALESCE(verified_at, NOW()) WHERE user_id = $1`,
        [claimed.user_id]
      );
      await getDbPool().query(
        `UPDATE users
            SET status_id = (SELECT id FROM user_statuses WHERE code = 'active'),
                updated_at = NOW()
          WHERE id = $1
            AND deleted_at IS NULL
            AND status_id = (SELECT id FROM user_statuses WHERE code = 'pending')`,
        [claimed.user_id]
      );

      recordAuthEvent('password_changed', claimed.user_id, clientIp, req.get('user-agent') || '');

      return res.json({ message: 'Password updated. You can now sign in with your new password.' });
    } catch (error) {
      console.error('[Auth] Reset password failed:', error);
      return res.status(503).json({ error: 'AUTH_DATABASE_UNAVAILABLE', message: 'Cannot update the password right now. Please try again later.' });
    }
  });

  // Google OAuth endpoint: verifies Google credential & handles login or password-setup registration
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
    const userAgent = req.get('user-agent') || '';

    try {
      // 1. Check if user already exists by Google provider_user_id
      const identityQuery = await getDbPool().query<any>(
        `SELECT u.id, u.username, s.code AS status, c.password_hash
         FROM users u
         JOIN user_statuses s ON s.id = u.status_id
         JOIN user_identities ui ON ui.user_id = u.id
         JOIN auth_providers ap ON ap.id = ui.provider_id AND ap.code = 'google'
         LEFT JOIN user_credentials c ON c.user_id = u.id
         WHERE u.deleted_at IS NULL AND ui.provider_user_id = $1
         LIMIT 1`,
        [googleUser.sub]
      );

      let record = identityQuery.rows[0];

      // 2. If not found by Google provider ID, check by verified email
      if (!record) {
        const emailQuery = await getDbPool().query<any>(
          `SELECT u.id, u.username, s.code AS status, c.password_hash
           FROM users u
           JOIN user_statuses s ON s.id = u.status_id
           JOIN user_emails e ON e.user_id = u.id AND LOWER(e.email) = LOWER($1)
           LEFT JOIN user_credentials c ON c.user_id = u.id
           WHERE u.deleted_at IS NULL
           LIMIT 1`,
          [normalizedEmail]
        );
        record = emailQuery.rows[0];
      }

      if (record && record.status !== 'active') {
        return res.status(403).json({
          error: 'ACCOUNT_INACTIVE_OR_ROLE_INVALID',
          message: 'Your account is suspended or inactive. Please contact an administrator.',
        });
      }

      // Existing registered user with password: authenticate session directly.
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
           ON CONFLICT DO NOTHING`,
          [user.id, googleUser.sub]
        );

        await getDbPool().query(
          'UPDATE user_credentials SET last_login_at=NOW(), failed_attempts=0, last_failed_at=NULL, locked_until=NULL WHERE user_id=$1',
          [user.id]
        );

        recordAuthEvent('login_success', user.id, clientIp, userAgent, { method: 'google' });
        return res.json({
          requirePasswordSetup: false,
          user: publicUser(user),
          token: signSession(user),
        });
      }

      // New user (or legacy account missing password): issue signed setup token for Step 2/2.
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
        message: 'Password setup session has expired or is invalid. Please try again.',
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

    const finalDisplayName = String(displayName || payload.displayName || finalUsername).trim();
    if (!finalDisplayName || finalDisplayName.length > 64) {
      return res.status(400).json({ error: 'INVALID_NAME', message: 'Display name is required (max 64 characters).' });
    }

    let connection: PoolClient | undefined;
    try {
      connection = await getDbPool().connect();
      await connection.query('BEGIN');

      // Case-insensitive username uniqueness check across active/existing accounts
      const dupUsername = await connection.query<{ id: number }>(
        `SELECT id FROM users WHERE LOWER(username) = LOWER($1) AND id <> COALESCE($2, -1) LIMIT 1`,
        [finalUsername, payload.existingUserId]
      );
      if (dupUsername.rows[0]) {
        await connection.query('ROLLBACK');
        return res.status(409).json({
          error: 'USERNAME_OR_EMAIL_EXISTS',
          message: 'Username is already taken. Please choose a different username.',
        });
      }

      // Ensure 'google' provider exists in auth_providers
      await connection.query(`INSERT INTO auth_providers (code) VALUES ('google') ON CONFLICT (code) DO NOTHING`);

      const passHash = await hashPassword(trimmedPassword);
      let targetUserId: number;

      if (payload.existingUserId) {
        const existingRes = await connection.query<{ id: number; status: string }>(
          `SELECT u.id, s.code AS status
           FROM users u
           JOIN user_statuses s ON s.id = u.status_id
           WHERE u.id = $1 AND u.deleted_at IS NULL
           FOR UPDATE OF u`,
          [payload.existingUserId]
        );
        const existingRow = existingRes.rows[0];
        if (!existingRow || existingRow.status !== 'active') {
          await connection.query('ROLLBACK');
          return res.status(403).json({
            error: 'ACCOUNT_INACTIVE_OR_ROLE_INVALID',
            message: 'Account is suspended or unavailable.',
          });
        }

        targetUserId = payload.existingUserId;

        // Save password into user_credentials
        await connection.query(
          `INSERT INTO user_credentials (user_id, password_hash, password_changed_at, failed_attempts, last_failed_at, locked_until, last_login_at)
           VALUES ($1, $2, NOW(), 0, NULL, NULL, NOW())
           ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash, password_changed_at = NOW(), failed_attempts = 0, last_failed_at = NULL, locked_until = NULL, last_login_at = NOW()`,
          [targetUserId, passHash]
        );

        // Ensure Google identity is linked
        await connection.query(
          `INSERT INTO user_identities (user_id, provider_id, provider_user_id)
           SELECT $1, id, $2 FROM auth_providers WHERE code = 'google'
           ON CONFLICT DO NOTHING`,
          [targetUserId, payload.sub]
        );

        // Upsert profile
        await connection.query(
          `INSERT INTO user_profiles (user_id, display_name, avatar_url)
           VALUES ($1, $2, $3)
           ON CONFLICT (user_id) DO UPDATE SET display_name = EXCLUDED.display_name, avatar_url = COALESCE(EXCLUDED.avatar_url, user_profiles.avatar_url), updated_at = NOW()`,
          [targetUserId, finalDisplayName, payload.avatarUrl]
        );

        // Ensure user has at least the individual role if none exists
        await connection.query(
          `INSERT INTO user_roles (user_id, role_id)
           SELECT $1, id FROM roles WHERE code = 'individual'
           AND NOT EXISTS (SELECT 1 FROM user_roles WHERE user_id = $1)
           ON CONFLICT DO NOTHING`,
          [targetUserId]
        );

        await connection.query(`UPDATE users SET username = $2, updated_at = NOW() WHERE id = $1`, [targetUserId, finalUsername]);
      } else {
        const dupEmail = await connection.query<{ id: number }>(
          `SELECT id FROM user_emails WHERE LOWER(email) = LOWER($1) LIMIT 1`,
          [payload.email]
        );
        if (dupEmail.rows[0]) {
          await connection.query('ROLLBACK');
          return res.status(409).json({
            error: 'USERNAME_OR_EMAIL_EXISTS',
            message: 'An account with this email already exists. Please sign in instead.',
          });
        }

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
           SELECT $1, id, $2 FROM auth_providers WHERE code = 'google'
           ON CONFLICT DO NOTHING`,
          [targetUserId, payload.sub]
        );

        // Assign individual role
        await connection.query(
          `INSERT INTO user_roles (user_id, role_id)
           SELECT $1, id FROM roles WHERE code = 'individual'`,
          [targetUserId]
        );
      }

      const user = await loadUser(targetUserId, connection);
      if (!user) throw new Error('Active user could not be loaded after creation.');

      await connection.query('COMMIT');

      recordAuthEvent('register', user.id, clientIp, req.get('user-agent') || '', { role: user.role, method: 'google' });
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
