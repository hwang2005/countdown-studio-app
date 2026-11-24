import crypto from 'crypto';
import type { PoolClient } from 'pg';
import type { Request, Response } from 'express';
import { getDbPool } from './db.js';
import type { AppRole, AuthUser } from './types.js';
import { hashPassword } from './security.js';
import { readSessionToken, signSession } from './session.js';

export const ROLE_PERMISSIONS: Record<AppRole, string[]> = {
  individual: ['solo:practice'],
  organization: ['stage:display', 'host:operations'],
  admin: ['solo:practice', 'stage:display', 'host:operations', 'user:manage', 'role:manage'],
};

export function publicUser(user: AuthUser) {
  return {
    id: user.publicId,
    username: user.username,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    permissions: user.permissions,
  };
}

export type DbQueryable = Pick<PoolClient, 'query'>;

export async function loadUser(userId: number, db: DbQueryable = getDbPool()): Promise<AuthUser | null> {
  const { rows } = await db.query<any>(
    `SELECT u.id, u.public_id, u.username,
            COALESCE(e.email, '') AS email,
            COALESCE(p.display_name, u.username) AS display_name,
            r.code AS role
       FROM users u
       JOIN user_statuses s ON s.id = u.status_id AND s.code = 'active'
       JOIN user_roles ur ON ur.user_id = u.id AND (ur.expires_at IS NULL OR ur.expires_at > NOW())
       JOIN roles r ON r.id = ur.role_id
  LEFT JOIN LATERAL (
         SELECT email
           FROM user_emails
          WHERE user_id = u.id
          ORDER BY is_primary DESC, id ASC
          LIMIT 1
       ) e ON TRUE
  LEFT JOIN user_profiles p ON p.user_id = u.id
      WHERE u.id = $1 AND u.deleted_at IS NULL
      ORDER BY CASE r.code
        WHEN 'admin' THEN 1
        WHEN 'organization' THEN 2
        WHEN 'individual' THEN 3
        ELSE 4
      END
      LIMIT 1`,
    [userId]
  );
  const row = rows[0];
  if (!row || !['individual', 'organization', 'admin'].includes(row.role)) return null;
  const role = row.role as AppRole;
  // Database-side RBAC (seeded by database/auth-rbac.sql) is authoritative.
  // The hardcoded ROLE_PERMISSIONS map is the fallback when the permissions
  // tables have not been seeded so the server still boots without them.
  let permissions: string[] = ROLE_PERMISSIONS[role];
  try {
    const { rows: permRows } = await db.query<{ code: string }>(
      `SELECT p.code FROM role_permissions rp
         JOIN roles r ON r.id=rp.role_id
         JOIN permissions p ON p.id=rp.permission_id
       WHERE r.code=$1`, [role]
    );
    if (permRows.length) {
      const dbPerms = permRows.map((permRow) => String(permRow.code));
      permissions = role === 'admin'
        ? Array.from(new Set([...dbPerms, ...ROLE_PERMISSIONS.admin]))
        : dbPerms;
    }
  } catch (error) {
    console.warn('[Auth] Falling back to static role permissions:', error instanceof Error ? error.message : error);
  }
  return { id: row.id, publicId: row.public_id, username: row.username, email: row.email, displayName: row.display_name, role, permissions };
}

export async function insertUserAccount(
  connection: PoolClient,
  account: { username: string; email: string; password: string; displayName: string; role: AppRole; markLoggedIn?: boolean },
): Promise<number> {
  const publicId = crypto.randomUUID();
  const cleanUsername = account.username.trim();
  const cleanEmail = account.email.trim().toLowerCase();
  const cleanDisplayName = account.displayName.trim();
  const userResult = await connection.query<{ id: number }>(
    'INSERT INTO users (public_id, username, status_id) SELECT $1::uuid, $2, id FROM user_statuses WHERE code=\'active\' RETURNING id',
    [publicId, cleanUsername]
  );
  const userId = userResult.rows[0]?.id;
  if (!userId) throw new Error('Active user status is missing.');
  const passHash = await hashPassword(account.password);
  await connection.query(
    `INSERT INTO user_credentials (user_id, password_hash, password_changed_at, failed_attempts, last_login_at)
     VALUES ($1, $2, NOW(), 0, ${account.markLoggedIn ? 'NOW()' : 'NULL'})`,
    [userId, passHash]
  );
  await connection.query(
    'INSERT INTO user_emails (user_id, email, is_primary, verified_at) VALUES ($1, LOWER($2), TRUE, NOW())',
    [userId, cleanEmail]
  );
  await connection.query(
    'INSERT INTO user_profiles (user_id, display_name) VALUES ($1, $2)',
    [userId, cleanDisplayName]
  );
  const roleRes = await connection.query(
    'INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code=$2',
    [userId, account.role]
  );
  if (!roleRes.rowCount) {
    throw new Error(`Role '${account.role}' is missing from roles table.`);
  }
  return userId;
}

export async function authenticateToken(token: string | undefined): Promise<AuthUser | null> {
  const session = token ? readSessionToken(token) : null;
  return session ? loadUser(session.sub) : null;
}

export function bearer(req: Request): string | undefined {
  return req.get('Authorization')?.replace(/^Bearer\s+/i, '') || undefined;
}

export function requirePermission(permission: string) {
  return async (req: Request, res: Response, next: () => void) => {
    try {
      const user = await authenticateToken(bearer(req));
      if (!user) return res.status(401).json({ error: 'UNAUTHENTICATED' });
      if (!user.permissions.includes(permission)) return res.status(403).json({ error: 'FORBIDDEN' });
      (req as any).user = user;
      next();
    } catch {
      res.status(503).json({ error: 'AUTH_DATABASE_UNAVAILABLE' });
    }
  };
}
