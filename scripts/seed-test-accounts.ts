import 'dotenv/config';
import crypto from 'node:crypto';
import pg from 'pg';

const { Pool } = pg;

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.length < 8) throw new Error(`${name} must be set and contain at least 8 characters.`);
  return value;
}

function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString('hex');
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(`scrypt$${salt}$${derivedKey.toString('hex')}`);
    });
  });
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false },
});

function buildAccounts() {
  return [
    { username: 'test-individual', email: process.env.TEST_INDIVIDUAL_EMAIL || 'test-individual@example.invalid', role: 'individual', displayName: 'Test Individual', password: required('TEST_INDIVIDUAL_PASSWORD') },
    { username: 'test-organization', email: process.env.TEST_ORGANIZATION_EMAIL || 'test-organization@example.invalid', role: 'organization', displayName: 'Test Organization', password: required('TEST_ORGANIZATION_PASSWORD') },
    { username: 'test-admin', email: process.env.TEST_ADMIN_EMAIL || 'test-admin@example.invalid', role: 'admin', displayName: 'Test Administrator', password: required('TEST_ADMIN_PASSWORD') },
  ];
}

async function main() {
  const accounts = buildAccounts();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const account of accounts) {
      const existing = await client.query<{ id: number }>('SELECT id FROM users WHERE username=$1 LIMIT 1', [account.username]);
      let userId = existing.rows[0]?.id;
      if (!userId) {
        const created = await client.query<{ id: number }>(
          `INSERT INTO users (public_id, username, status_id)
           SELECT $1::uuid, $2, id FROM user_statuses WHERE code='active' RETURNING id`,
          [crypto.randomUUID(), account.username]
        );
        userId = created.rows[0]?.id;
      }
      if (!userId) throw new Error(`Could not create ${account.username}.`);
      await client.query(
        `UPDATE users SET status_id=(SELECT id FROM user_statuses WHERE code='active'), deleted_at=NULL, updated_at=NOW() WHERE id=$1`,
        [userId]
      );
      const passwordHash = await hashPassword(account.password);
      await client.query(
        `INSERT INTO user_credentials (user_id, password_hash, password_changed_at, failed_attempts, locked_until)
         VALUES ($1, $2, NOW(), 0, NULL)
         ON CONFLICT (user_id) DO UPDATE SET password_hash=EXCLUDED.password_hash, password_changed_at=NOW(), failed_attempts=0, locked_until=NULL`,
        [userId, passwordHash]
      );
      await client.query(
        `INSERT INTO user_emails (user_id, email, is_primary, verified_at)
         VALUES ($1, LOWER($2), TRUE, NOW())
         ON CONFLICT (user_id) WHERE is_primary
         DO UPDATE SET email=EXCLUDED.email, is_primary=TRUE, verified_at=NOW()`,
        [userId, account.email]
      );
      await client.query(
        `INSERT INTO user_profiles (user_id, display_name) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET display_name=EXCLUDED.display_name, updated_at=NOW()`,
        [userId, account.displayName]
      );
      await client.query(
        `INSERT INTO user_roles (user_id, role_id)
         SELECT $1, id FROM roles WHERE code=$2
         ON CONFLICT (user_id, role_id) DO NOTHING`,
        [userId, account.role]
      );
      console.log(`Seeded ${account.username} (${account.role}).`);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error('[seed-test-accounts] Failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

