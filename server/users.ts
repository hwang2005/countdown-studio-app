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

export async function loadUser(userId: number): Promise<AuthUser | null> {
  const { rows } = await getDbPool().query<any>(`SELECT u.id, u.public_id, u.username, e.email, p.display_name, r.code role
    FROM users u JOIN user_emails e ON e.user_id=u.id AND e.is_primary=TRUE JOIN user_profiles p ON p.user_id=u.id
    JOIN user_roles ur ON ur.user_id=u.id JOIN roles r ON r.id=ur.role_id
    JOIN user_statuses s ON s.id=u.status_id AND s.code='active' WHERE u.id=$1 AND (ur.expires_at IS NULL OR ur.expires_at>NOW())`, [userId]);
  const row = rows[0];
  if (!row || !['individual', 'organization', 'admin'].includes(row.role)) return null;
  const role = row.role as AppRole;
  // Database-side RBAC (seeded by database/auth-rbac.sql) is authoritative.
  // The hardcoded ROLE_PERMISSIONS map is the fallback when the permissions
  // tables have not been seeded so the server still boots without them.
  let permissions: string[] = ROLE_PERMISSIONS[role];
  try {
    const { rows: permRows } = await getDbPool().query<{ code: string }>(
      `SELECT p.code FROM role_permissions rp
         JOIN roles r ON r.id=rp.role_id
         JOIN permissions p ON p.id=rp.permission_id
       WHERE r.code=$1`, [role]
    );
    if (permRows.length) permissions = permRows.map((permRow) => String(permRow.code));
  } catch (error) {
    console.warn('[Auth] Falling back to static role permissions:', error instanceof Error ? error.message : error);
  }
  return { id: row.id, publicId: row.public_id, username: row.username, email: row.email, displayName: row.display_name, role, permissions };
}

export async function insertUserAccount(
  connection: PoolClient,
  account: { username: string; email: string; password: string; displayName: string; role: AppRole },
): Promise<number> {
  const publicId = crypto.randomUUID();
  const userResult = await connection.query<{ id: number }>(
    'INSERT INTO users (public_id, username, status_id) SELECT $1::uuid, $2, id FROM user_statuses WHERE code=\'active\' RETURNING id',
    [publicId, account.username]
  );
  const userId = userResult.rows[0]?.id;
  if (!userId) throw new Error('Active user status is missing.');
  const passHash = await hashPassword(account.password);
  await connection.query('INSERT INTO user_credentials (user_id, password_hash) VALUES ($1, $2)', [userId, passHash]);
  await connection.query('INSERT INTO user_emails (user_id, email, is_primary, verified_at) VALUES ($1, LOWER($2), TRUE, NOW())', [userId, account.email]);
  await connection.query('INSERT INTO user_profiles (user_id, display_name) VALUES ($1, $2)', [userId, account.displayName]);
  await connection.query('INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code=$2', [userId, account.role]);
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
