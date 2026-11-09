import type { Express, Request, Response } from 'express';
import type { PoolClient } from 'pg';
import { getDbPool } from '../db.js';
import type { AppRole, AuthUser } from '../types.js';
import { checkRateLimit, getClientIp, hashPassword } from '../security.js';
import { insertUserAccount, loadUser, publicUser, requirePermission, ROLE_PERMISSIONS } from '../users.js';
import { rooms } from '../rooms.js';
import { isMailConfigured, sendMail } from '../../mailer.js';

// Authentication and RBAC API. Organization accounts are provisioned by an
// administrator; public registration intentionally exposes only Individual
// and Admin (the latter requires the private bootstrap code).
export function registerAdminRoutes(app: Express) {
  app.post('/api/admin/users', requirePermission('user:manage'), async (req: Request, res: Response) => {
    const clientIp = getClientIp(req);
    if (!checkRateLimit(clientIp, 'admin_users', 30, 10 * 60 * 1000)) {
      return res.status(429).json({ error: 'TOO_MANY_REQUESTS', message: 'Too many admin provisioning requests. Please try again after 10 minutes.' });
    }

    const body = req.body || {};
    const username = String(body.username || '').trim();
    const email = String(body.email || '').trim();
    const password = String(body.password || '');
    const displayName = String(body.displayName || '').trim();
    // Only non-escalating roles may be provisioned via the admin API. Admin
    // accounts are bootstrapped through /api/auth/register + ADMIN_REGISTRATION_CODE.
    const featuresRole = String(body.role || 'organization').toLowerCase();
    if (featuresRole !== 'organization' && featuresRole !== 'individual') {
      return res.status(400).json({ error: 'INVALID_ROLE', message: "Role must be 'organization' or 'individual'." });
    }
    if (
      !/^[a-zA-Z0-9_.-]{3,32}$/.test(username) ||
      !/^\S+@\S+\.\S+$/.test(email) ||
      password.length < 8 ||
      password.length > 128 ||
      !displayName ||
      displayName.length > 64
    ) {
      return res.status(400).json({ error: 'INVALID_INPUT', message: 'Username, email, display name, and password (8-128 characters) are required.' });
    }

    let connection: PoolClient | undefined;
    try {
      connection = await getDbPool().connect(); await connection.query('BEGIN');
      const userId = await insertUserAccount(connection, { username, email, password, displayName, role: featuresRole });
      await connection.query('COMMIT');
      const user = await loadUser(userId); if (!user) throw new Error('Created user could not be loaded.');
      return res.status(201).json({
        user: publicUser(user),
        // No session token is issued here: the provisioned account should not
        // be usable by the administrator. The account owner signs in normally.
        message: `${featuresRole === 'organization' ? 'Organization' : 'Individual'} account '${user.username}' has been provisioned.`,
      });
    } catch (error: any) {
      if (connection) await connection.query('ROLLBACK');
      const duplicate = error?.code === '23505';
      return res.status(duplicate ? 409 : 503).json({ error: duplicate ? 'ACCOUNT_EXISTS' : 'ADMIN_DATABASE_UNAVAILABLE', message: duplicate ? 'Username or email already exists.' : 'Cannot connect to authentication database.' });
    } finally { connection?.release(); }
  });

  app.get('/api/admin/users', requirePermission('user:manage'), async (req: Request, res: Response) => {
    const roleFilter = String(req.query.role || '').toLowerCase();
    const validRoles = ['individual', 'organization', 'admin'];
    const statusFilter = String(req.query.status || '').toLowerCase();
    const validStatuses = ['active', 'suspended', 'deleted', 'pending', 'banned'];
    const search = String(req.query.q || '').trim();
    const limit = Math.min(200, Math.max(1, Number.parseInt(String(req.query.limit || '50'), 10) || 50));
    const offset = Math.max(0, Number.parseInt(String(req.query.offset || '0'), 10) || 0);
    if (roleFilter && !validRoles.includes(roleFilter)) {
      return res.status(400).json({ error: 'INVALID_ROLE', message: 'Unknown role filter.' });
    }
    if (statusFilter && !validStatuses.includes(statusFilter)) {
      return res.status(400).json({ error: 'INVALID_STATUS', message: 'Unknown status filter.' });
    }

    const filters: string[] = [];
    const values: unknown[] = [];
    if (roleFilter) { values.push(roleFilter); filters.push(`r.code=$${values.length}`); }
    if (statusFilter) { values.push(statusFilter); filters.push(`s.code=$${values.length}`); }
    if (search) {
      values.push(`%${search}%`);
      filters.push(`(u.username ILIKE $${values.length} OR e.email ILIKE $${values.length} OR p.display_name ILIKE $${values.length})`);
    }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    try {
      const countResult = await getDbPool().query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM users u
           JOIN user_emails e ON e.user_id=u.id AND e.is_primary=TRUE
           JOIN user_profiles p ON p.user_id=u.id
           JOIN user_roles ur ON ur.user_id=u.id
           JOIN roles r ON r.id=ur.role_id
           JOIN user_statuses s ON s.id=u.status_id
          ${where}`, values
      );
      const listValues = [...values, limit, offset];
      const { rows } = await getDbPool().query<any>(
        `SELECT u.public_id, u.username, u.created_at, u.updated_at, e.email, p.display_name,
                r.code role, s.code status,
                c.last_login_at, c.locked_until, c.failed_attempts
           FROM users u
           JOIN user_emails e ON e.user_id=u.id AND e.is_primary=TRUE
           JOIN user_profiles p ON p.user_id=u.id
           JOIN user_roles ur ON ur.user_id=u.id
           JOIN roles r ON r.id=ur.role_id
           JOIN user_statuses s ON s.id=u.status_id
           LEFT JOIN user_credentials c ON c.user_id=u.id
          ${where} ORDER BY u.created_at DESC LIMIT $${listValues.length - 1} OFFSET $${listValues.length}`,
        listValues
      );
      return res.json({ items: rows, total: Number(countResult.rows[0]?.count || 0), limit, offset });
    } catch (error) {
      console.error('[Admin users] List failed:', error);
      return res.status(503).json({ error: 'ADMIN_DATABASE_UNAVAILABLE' });
    }
  });

  app.get('/api/admin/users/:publicId', requirePermission('user:manage'), async (req: Request, res: Response) => {
    const publicId = String(req.params.publicId || '').trim();
    if (!/^[0-9a-fA-F-]{32,36}$/.test(publicId)) {
      return res.status(400).json({ error: 'INVALID_USER_ID', message: 'The user identifier must be a UUID.' });
    }
    try {
      const { rows } = await getDbPool().query<any>(
        `SELECT u.public_id, u.username, u.created_at, u.updated_at, u.deleted_at,
                e.email, p.display_name, r.code role, s.code status,
                c.last_login_at, c.locked_until, c.failed_attempts, c.password_changed_at
           FROM users u
           JOIN user_emails e ON e.user_id=u.id AND e.is_primary=TRUE
           JOIN user_profiles p ON p.user_id=u.id
           JOIN user_roles ur ON ur.user_id=u.id
           JOIN roles r ON r.id=ur.role_id
           JOIN user_statuses s ON s.id=u.status_id
           LEFT JOIN user_credentials c ON c.user_id=u.id
          WHERE u.public_id=$1 LIMIT 1`,
        [publicId]
      );
      if (!rows[0]) return res.status(404).json({ error: 'USER_NOT_FOUND' });
      return res.json({ user: rows[0] });
    } catch (error) {
      console.error('[Admin users] Detail failed:', error);
      return res.status(503).json({ error: 'ADMIN_DATABASE_UNAVAILABLE' });
    }
  });

  // Clear login lockout and restore a suspended account. Other terminal or
  // onboarding statuses are intentionally never changed by this operation.
  app.post('/api/admin/users/:publicId/unlock', requirePermission('user:manage'), async (req: Request, res: Response) => {
    const actor = (req as any).user as AuthUser;
    const publicId = String(req.params.publicId || '').trim();
    if (!/^[0-9a-fA-F-]{32,36}$/.test(publicId)) {
      return res.status(400).json({ error: 'INVALID_USER_ID', message: 'The user identifier must be a UUID.' });
    }
    if (publicId === actor.publicId) {
      return res.status(400).json({ error: 'SELF_MODIFICATION', message: 'Administrators cannot unlock their own account through user management.' });
    }

    let connection: PoolClient | undefined;
    try {
      connection = await getDbPool().connect();
      await connection.query('BEGIN');
      const target = await connection.query<any>(
        `SELECT u.id, s.code AS status, c.user_id AS credential_user_id,
                c.failed_attempts, c.locked_until
           FROM users u
           JOIN user_statuses s ON s.id=u.status_id
           LEFT JOIN user_credentials c ON c.user_id=u.id
          WHERE u.public_id=$1
          FOR UPDATE OF u`,
        [publicId]
      );
      const row = target.rows[0];
      if (!row) {
        await connection.query('ROLLBACK');
        return res.status(404).json({ error: 'USER_NOT_FOUND' });
      }
      if (row.status !== 'active' && row.status !== 'suspended') {
        await connection.query('ROLLBACK');
        return res.status(409).json({ error: 'ACCOUNT_STATUS_NOT_UNLOCKABLE', message: 'Banned, deleted, and pending accounts cannot be unlocked by this operation.' });
      }
      if (!row.failed_attempts && !row.locked_until && row.status !== 'suspended') {
        await connection.query('ROLLBACK');
        return res.status(409).json({ error: 'ACCOUNT_NOT_LOCKED', message: 'This account is not locked or suspended.' });
      }
      const nextStatus = row.status === 'suspended' ? 'active' : row.status;
      if (row.credential_user_id) {
        await connection.query(
          `UPDATE user_credentials SET failed_attempts=0, locked_until=NULL WHERE user_id=$1`,
          [row.id]
        );
      }
      if (row.status === 'suspended') {
        await connection.query(
          `UPDATE users SET status_id=(SELECT id FROM user_statuses WHERE code='active'), updated_at=NOW()
            WHERE id=$1`,
          [row.id]
        );
      }
      await connection.query(
        `INSERT INTO auth_events (event_type_id, user_id, ip_address, user_agent, details)
         SELECT id, $2, $3::inet, $4, $5::jsonb
           FROM auth_event_types WHERE code='account_unlocked'`,
        [row.id, getClientIp(req), String(req.get('user-agent') || '').slice(0, 255), JSON.stringify({
          actor_user_id: actor.id,
          actor_public_id: actor.publicId,
          target_public_id: publicId,
          previous_status: row.status,
          next_status: nextStatus,
          previous_failed_attempts: row.failed_attempts || 0,
          previous_locked_until: row.locked_until || null,
        })]
      );
      await connection.query('COMMIT');
      return res.json({
        message: row.status === 'suspended' ? 'Account unlocked and activated.' : 'Account login lockout cleared.',
        userId: publicId,
        previousStatus: row.status,
        status: nextStatus,
        failedAttempts: 0,
        lockedUntil: null,
      });
    } catch (error) {
      if (connection) await connection.query('ROLLBACK');
      console.error('[Admin users] Unlock failed:', error);
      return res.status(503).json({ error: 'ADMIN_DATABASE_UNAVAILABLE' });
    } finally { connection?.release(); }
  });

  // Administrative lifecycle changes: account status, role, and display name.
  // Suspension takes effect immediately because loadUser() only authenticates
  // accounts whose status is 'active'.
  app.patch('/api/admin/users/:publicId', requirePermission('user:manage'), async (req: Request, res: Response) => {
    const actor = (req as any).user as AuthUser;
    const publicId = String(req.params.publicId || '').trim();
    if (!/^[0-9a-fA-F-]{32,36}$/.test(publicId)) {
      return res.status(400).json({ error: 'INVALID_USER_ID', message: 'The user identifier must be a UUID.' });
    }
    if (publicId === actor.publicId) {
      return res.status(400).json({ error: 'SELF_MODIFICATION', message: 'Administrators cannot change their own role or status.' });
    }

    const body = req.body || {};
    const status = body.status === undefined ? undefined : String(body.status).toLowerCase();
    const role = body.role === undefined ? undefined : String(body.role).toLowerCase();
    const displayName = body.displayName === undefined ? undefined : String(body.displayName || '').trim();
    const appRoles: AppRole[] = ['individual', 'organization', 'admin'];
    if (status !== undefined && status !== 'active' && status !== 'suspended') {
      return res.status(400).json({ error: 'INVALID_STATUS', message: "Status must be 'active' or 'suspended'." });
    }
    if (role !== undefined && !appRoles.includes(role as AppRole)) {
      return res.status(400).json({ error: 'INVALID_ROLE', message: "Role must be 'individual', 'organization', or 'admin'." });
    }
    if (displayName !== undefined && (!displayName || displayName.length > 64)) {
      return res.status(400).json({ error: 'INVALID_DISPLAY_NAME', message: 'Display name is required (max 64 characters).' });
    }
    if (status === undefined && role === undefined && displayName === undefined) {
      return res.status(400).json({ error: 'NO_CHANGES', message: 'Provide at least one field to update (status, role, or displayName).' });
    }

    let connection: PoolClient | undefined;
    try {
      connection = await getDbPool().connect(); await connection.query('BEGIN');
      const target = await connection.query<{ id: number }>(
        'SELECT id FROM users WHERE public_id=$1 AND deleted_at IS NULL FOR UPDATE', [publicId]
      );
      const userId = target.rows[0]?.id;
      if (!userId) { await connection.query('ROLLBACK'); return res.status(404).json({ error: 'USER_NOT_FOUND' }); }
      if (status !== undefined) {
        await connection.query('UPDATE users SET status_id=(SELECT id FROM user_statuses WHERE code=$2), updated_at=NOW() WHERE id=$1', [userId, status]);
      }
      if (role !== undefined) {
        const roleRow = await connection.query('SELECT id FROM roles WHERE code=$1', [role]);
        if (!roleRow.rows[0]) {
          await connection.query('ROLLBACK');
          return res.status(400).json({ error: 'INVALID_ROLE', message: 'The requested role does not exist in the database. Run database/auth-rbac.sql.' });
        }
        await connection.query('DELETE FROM user_roles WHERE user_id=$1', [userId]);
        await connection.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [userId, roleRow.rows[0].id]);
      }
      if (displayName !== undefined) {
        await connection.query('UPDATE user_profiles SET display_name=$2, updated_at=NOW() WHERE user_id=$1', [userId, displayName]);
      }
      await connection.query('COMMIT');
      return res.json({ message: 'User updated successfully.', userId: publicId });
    } catch (error: any) {
      if (connection) await connection.query('ROLLBACK');
      console.error('[Admin users] Update failed:', error);
      return res.status(503).json({ error: 'ADMIN_DATABASE_UNAVAILABLE' });
    } finally { connection?.release(); }
  });

  // Soft delete: the user is marked deleted and immediately loses access. No
  // data is destroyed so the audit history and archived matches stay intact.
  app.delete('/api/admin/users/:publicId', requirePermission('user:manage'), async (req: Request, res: Response) => {
    const actor = (req as any).user as AuthUser;
    const publicId = String(req.params.publicId || '').trim();
    if (!/^[0-9a-fA-F-]{32,36}$/.test(publicId)) {
      return res.status(400).json({ error: 'INVALID_USER_ID', message: 'The user identifier must be a UUID.' });
    }
    if (publicId === actor.publicId) {
      return res.status(400).json({ error: 'SELF_MODIFICATION', message: 'Administrators cannot delete their own account.' });
    }
    try {
      const result = await getDbPool().query<{ id: number }>(
        `UPDATE users SET deleted_at=NOW(), updated_at=NOW(),
             status_id=(SELECT id FROM user_statuses WHERE code='deleted')
           WHERE public_id=$1 AND deleted_at IS NULL RETURNING id`,
        [publicId]
      );
      if (!result.rows[0]) return res.status(404).json({ error: 'USER_NOT_FOUND' });
      return res.json({ message: 'User deleted (soft delete). Archived matches are preserved.' });
    } catch (error) {
      console.error('[Admin users] Delete failed:', error);
      return res.status(503).json({ error: 'ADMIN_DATABASE_UNAVAILABLE' });
    }
  });

  app.post('/api/admin/users/:publicId/reset-password', requirePermission('user:manage'), async (req: Request, res: Response) => {
    const clientIp = getClientIp(req);
    if (!checkRateLimit(clientIp, 'admin_pw_reset', 20, 10 * 60 * 1000)) {
      return res.status(429).json({ error: 'TOO_MANY_REQUESTS', message: 'Too many password reset requests. Please try again after 10 minutes.' });
    }
    const publicId = String(req.params.publicId || '').trim();
    if (!/^[0-9a-fA-F-]{32,36}$/.test(publicId)) {
      return res.status(400).json({ error: 'INVALID_USER_ID', message: 'The user identifier must be a UUID.' });
    }
    const password = String((req.body || {}).password || '');
    if (password.length < 8 || password.length > 128) {
      return res.status(400).json({ error: 'INVALID_PASSWORD', message: 'Password must be 8-128 characters.' });
    }
    let connection: PoolClient | undefined;
    try {
      connection = await getDbPool().connect(); await connection.query('BEGIN');
      const target = await connection.query<{ id: number }>(
        'SELECT id FROM users WHERE public_id=$1 AND deleted_at IS NULL FOR UPDATE', [publicId]
      );
      const userId = target.rows[0]?.id;
      if (!userId) { await connection.query('ROLLBACK'); return res.status(404).json({ error: 'USER_NOT_FOUND' }); }
      const passHash = await hashPassword(password);
      await connection.query(
        `INSERT INTO user_credentials (user_id, password_hash) VALUES ($1, $2)
           ON CONFLICT (user_id) DO UPDATE
             SET password_hash=$2, password_changed_at=NOW(), failed_attempts=0, locked_until=NULL`,
        [userId, passHash]
      );
      await connection.query('COMMIT');
      return res.json({ message: 'Password has been reset. The account owner must sign in with the new password.' });
    } catch (error: any) {
      if (connection) await connection.query('ROLLBACK');
      if (error?.code === '42P01') {
        return res.status(404).json({ error: 'USER_NOT_FOUND', message: 'This account has no password credential (social-login only).' });
      }
      console.error('[Admin users] Password reset failed:', error);
      return res.status(503).json({ error: 'ADMIN_DATABASE_UNAVAILABLE' });
    } finally { connection?.release(); }
  });

  // Aggregate dashboard statistics. Every query degrades independently so a
  // missing versus_match_archive table cannot blank the whole panel.
  app.get('/api/admin/stats', requirePermission('user:manage'), async (_req: Request, res: Response) => {
    const pool = getDbPool();
    const [roleResult, statusResult, deletedResult, newUsersResult, matchResult] = await Promise.allSettled([
      pool.query<{ role: string; count: number }>(
        `SELECT r.code role, COUNT(*)::int count
           FROM users u
           JOIN user_roles ur ON ur.user_id=u.id
           JOIN roles r ON r.id=ur.role_id
          WHERE u.deleted_at IS NULL GROUP BY r.code`
      ),
      pool.query<{ status: string; count: number }>(
        `SELECT s.code status, COUNT(*)::int count
           FROM users u
           JOIN user_statuses s ON s.id=u.status_id
          WHERE u.deleted_at IS NULL GROUP BY s.code`
      ),
      pool.query<{ count: number }>(
        'SELECT COUNT(*)::int count FROM users WHERE deleted_at IS NOT NULL'
      ),
      pool.query<{ last_7d: number; last_30d: number }>(
        `SELECT
             COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')::int last_7d,
             COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days')::int last_30d
           FROM users WHERE deleted_at IS NULL`
      ),
      pool.query<{ total: number; last_7d: number; rooms: number; hosts: number }>(
        `SELECT COUNT(*)::int total,
                COUNT(*) FILTER (WHERE closed_at >= NOW() - INTERVAL '7 days')::int last_7d,
                COUNT(DISTINCT room_code)::int rooms,
                COUNT(DISTINCT host_user_id)::int hosts
           FROM versus_match_archive`
      ),
    ]);
    const byRole = roleResult.status === 'fulfilled' ? roleResult.value.rows : [];
    const byStatus = statusResult.status === 'fulfilled' ? statusResult.value.rows : [];
    const pair = (rows: any[], key: string) => rows.reduce((acc: Record<string, number>, row) => { acc[row[key]] = Number(row.count); return acc; }, {});
    const allFulfilled = roleResult.status === 'fulfilled' && statusResult.status === 'fulfilled' && newUsersResult.status === 'fulfilled';
    if (!allFulfilled) console.warn('[Admin stats] Some aggregates failed; degraded response served.');
    const counts = {
      users: {
        total: byRole.reduce((sum, row) => sum + Number(row.count), 0),
        byRole: pair(byRole, 'role'),
        byStatus: pair(byStatus, 'status'),
        deleted: deletedResult.status === 'fulfilled' ? Number(deletedResult.value.rows[0]?.count || 0) : 0,
        newLast7d: newUsersResult.status === 'fulfilled' ? Number(newUsersResult.value.rows[0]?.last_7d || 0) : 0,
        newLast30d: newUsersResult.status === 'fulfilled' ? Number(newUsersResult.value.rows[0]?.last_30d || 0) : 0,
      },
      matches: matchResult.status === 'fulfilled'
        ? {
            archivedTotal: Number(matchResult.value.rows[0]?.total || 0),
            archivedLast7d: Number(matchResult.value.rows[0]?.last_7d || 0),
            distinctRooms: Number(matchResult.value.rows[0]?.rooms || 0),
            distinctHosts: Number(matchResult.value.rows[0]?.hosts || 0),
          }
        : { archivedTotal: 0, archivedLast7d: 0, distinctRooms: 0, distinctHosts: 0 },
      liveRooms: (() => {
        let displays = 0;
        let hosts = 0;
        for (const room of rooms.values()) {
          displays += room.displays.size;
          if (room.hostSocket) hosts += 1;
        }
        return { active: rooms.size, displays, hosts };
      })(),
      generatedAt: new Date().toISOString(),
    };
    return res.json({ stats: counts });
  });

  // Role/permission matrix from the RBAC tables. When the tables have not been
  // seeded the static ROLE_PERMISSIONS fallback keeps the panel usable.
  app.get('/api/admin/rbac', requirePermission('role:manage'), async (_req: Request, res: Response) => {
    try {
      const [rolesResult, permissionsResult] = await Promise.all([
        getDbPool().query<{ id: number; code: string; name: string; description: string | null; is_system: boolean; permissions: string[]; member_count: number }>(
          `SELECT r.id, r.code, r.name, r.description, r.is_system,
                  COALESCE(json_agg(DISTINCT p.code) FILTER (WHERE p.code IS NOT NULL), '[]')::jsonb permissions,
                  (SELECT COUNT(*)::int FROM user_roles ur
                     JOIN users u ON u.id=ur.user_id
                    WHERE ur.role_id=r.id AND u.deleted_at IS NULL) member_count
             FROM roles r
             LEFT JOIN role_permissions rp ON rp.role_id=r.id
             LEFT JOIN permissions p ON p.id=rp.permission_id
            GROUP BY r.id ORDER BY r.code`
        ),
        getDbPool().query<{ code: string; description: string | null }>(
          'SELECT code, description FROM permissions ORDER BY code'
        ),
      ]);
      return res.json({ roles: rolesResult.rows, permissions: permissionsResult.rows, source: 'database' });
    } catch (error) {
      console.warn('[Admin RBAC] Falling back to static role map:', error instanceof Error ? error.message : error);
      const roles = Object.entries(ROLE_PERMISSIONS).map(([code, permissions]) => ({
        code, name: code, description: null, is_system: true, permissions, member_count: 0,
      }));
      return res.json({ roles, permissions: [], source: 'static-fallback' });
    }
  });

  app.put('/api/admin/rbac/roles/:roleCode/permissions', requirePermission('role:manage'), async (req: Request, res: Response) => {
    const roleCode = String(req.params.roleCode || '').trim().toLowerCase();
    const requested = Array.isArray((req.body || {}).permissions) ? (req.body as any).permissions : null;
    if (!roleCode || !requested) {
      return res.status(400).json({ error: 'INVALID_INPUT', message: 'Provide the role code in the path and a permissions array in the body.' });
    }
    if (roleCode === 'admin') {
      return res.status(403).json({ error: 'ADMIN_ROLE_LOCKED', message: "The 'admin' role permissions are fixed to keep every administrator able to administer." });
    }
    const uniquePermissions: string[] = [...new Set((requested as string[]).map((code) => String(code).trim()).filter(Boolean))];
    let connection: PoolClient | undefined;
    try {
      connection = await getDbPool().connect(); await connection.query('BEGIN');
      const role = await connection.query<{ id: number }>('SELECT id FROM roles WHERE code=$1 FOR UPDATE', [roleCode]);
      const roleId = role.rows[0]?.id;
      if (!roleId) { await connection.query('ROLLBACK'); return res.status(404).json({ error: 'ROLE_NOT_FOUND' }); }
      const { rows: known } = await connection.query<{ code: string }>('SELECT code FROM permissions');
      const knownCodes = new Set(known.map((row) => row.code));
      const unknown = uniquePermissions.filter((code) => !knownCodes.has(code));
      if (unknown.length) {
        await connection.query('ROLLBACK');
        return res.status(400).json({ error: 'UNKNOWN_PERMISSION', message: `Unknown permission codes: ${unknown.join(', ')}` });
      }
      await connection.query('DELETE FROM role_permissions WHERE role_id=$1', [roleId]);
      if (uniquePermissions.length) {
        await connection.query(
          'INSERT INTO role_permissions (role_id, permission_id) SELECT $1, id FROM permissions WHERE code = ANY($2)',
          [roleId, uniquePermissions]
        );
      }
      await connection.query('COMMIT');
      return res.json({ role: roleCode, permissions: uniquePermissions.sort(), message: 'Role permissions updated.' });
    } catch (error) {
      if (connection) await connection.query('ROLLBACK');
      console.error('[Admin RBAC] Update failed:', error);
      return res.status(503).json({ error: 'ADMIN_DATABASE_UNAVAILABLE' });
    } finally { connection?.release(); }
  });

  // ── Audit log viewer ────────────────────────────────────────────────────────
  // Read-only inspection of auth_events (logins, password resets, role changes,
  // account suspensions, etc.). Degrades gracefully if the table is missing.
  app.get('/api/admin/audit-logs', requirePermission('user:manage'), async (req: Request, res: Response) => {
    const limit = Math.min(100, Math.max(1, Number.parseInt(String(req.query.limit || '50'), 10) || 50));
    const offset = Math.max(0, Number.parseInt(String(req.query.offset || '0'), 10) || 0);
    const eventFilter = String(req.query.event || '').trim();
    const userFilter = String(req.query.user || '').trim();
    const from = String(req.query.from || '').trim();
    const to = String(req.query.to || '').trim();

    const filters: string[] = [];
    const values: unknown[] = [];
    if (eventFilter) { values.push(eventFilter); filters.push(`et.code=$${values.length}`); }
    if (userFilter) { values.push(`%${userFilter}%`); filters.push(`(u.username ILIKE $${values.length} OR u.email ILIKE $${values.length})`); }
    if (from) { values.push(from); filters.push(`ae.created_at >= $${values.length}::timestamptz`); }
    if (to) { values.push(to); filters.push(`ae.created_at < ($${values.length}::date + INTERVAL '1 day')`); }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

    try {
      const countResult = await getDbPool().query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM auth_events ae
           LEFT JOIN users u ON u.id = ae.user_id
           LEFT JOIN auth_event_types et ON et.id = ae.event_type_id
          ${where}`, values
      );
      const listValues = [...values, limit, offset];
      const { rows } = await getDbPool().query<any>(
        `SELECT ae.id, ae.created_at, et.code AS event_type, u.username, u.email,
                ae.ip_address, ae.user_agent, ae.details
           FROM auth_events ae
           LEFT JOIN users u ON u.id = ae.user_id
           LEFT JOIN auth_event_types et ON et.id = ae.event_type_id
          ${where} ORDER BY ae.created_at DESC LIMIT $${listValues.length - 1} OFFSET $${listValues.length}`,
        listValues
      );
      return res.json({
        items: rows.map((row) => ({
          id: row.id,
          created_at: row.created_at,
          event_type: row.event_type || 'unknown',
          username: row.username || '—',
          email: row.email || '—',
          ip_address: row.ip_address,
          user_agent: row.user_agent,
          details: row.details || {},
        })),
        total: Number(countResult.rows[0]?.count || 0),
        limit,
        offset,
      });
    } catch (error) {
      console.error('[Admin audit-logs] List failed:', error);
      return res.status(503).json({ error: 'ADMIN_AUDIT_LOGS_UNAVAILABLE' });
    }
  });

  // ── System configuration (read-only safe flags) ─────────────────────────────
  app.get('/api/admin/config', requirePermission('user:manage'), async (_req: Request, res: Response) => {
    return res.json({
      config: {
        adminRegistrationEnabled: Boolean(process.env.ADMIN_REGISTRATION_CODE),
        googleAuthEnabled: true,
        googleClientIdConfigured: Boolean(process.env.GOOGLE_CLIENT_ID),
        mailConfigured: isMailConfigured(),
        cspMode: process.env.CSP_MODE || 'report-only',
        nodeEnv: process.env.NODE_ENV || 'development',
        tokenTtlSeconds: Number(process.env.AUTH_TOKEN_TTL_SECONDS) || 60 * 60 * 24 * 7,
        resetLinkTtlMinutes: Math.min(Number(process.env.RESET_LINK_TTL_MINUTES) || 30, 1440),
        pinLockMaxAttempts: Number(process.env.PIN_LOCK_MAX_ATTEMPTS) || 5,
        pinLockWindowMinutes: Math.round((Number(process.env.PIN_LOCK_WINDOW_MS) || 15 * 60 * 1000) / 60000),
      },
      generatedAt: new Date().toISOString(),
    });
  });

  // ── SMTP test connection ───────────────────────────────────────────────────
  app.post('/api/admin/test-smtp', requirePermission('user:manage'), async (req: Request, res: Response) => {
    const clientIp = getClientIp(req);
    if (!checkRateLimit(clientIp, 'admin_smtp_test', 10, 10 * 60 * 1000)) {
      return res.status(429).json({ error: 'TOO_MANY_REQUESTS', message: 'Too many SMTP test requests. Please try again after 10 minutes.' });
    }
    if (!isMailConfigured()) {
      return res.status(503).json({ error: 'MAIL_NOT_CONFIGURED', message: 'SMTP is not configured on the server.' });
    }
    const to = String((req.body || {}).to || '').trim();
    if (!to || !/^\S+@\S+\.\S+$/.test(to)) {
      return res.status(400).json({ error: 'INVALID_EMAIL', message: 'A valid recipient email is required.' });
    }
    try {
      const info = await sendMail({
        to,
        subject: 'Countdown Studio — SMTP Test',
        text: 'This is a test email from Countdown Studio to confirm your SMTP configuration is working.',
        html: '<p>This is a test email from <strong>Countdown Studio</strong> to confirm your SMTP configuration is working.</p>',
      });
      return res.json({ message: 'Test email sent successfully.', messageId: info.messageId, accepted: info.accepted });
    } catch (error) {
      console.error('[Admin test-smtp] Failed:', error);
      return res.status(503).json({ error: 'MAIL_SEND_FAILED', message: 'Could not send test email. Please check SMTP settings.' });
    }
  });
}
