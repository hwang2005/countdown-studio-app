import pg, { Pool, PoolClient } from 'pg';

const { types } = pg;

// Keep BIGINT values as numbers because the application uses numeric user IDs.
types.setTypeParser(20, (value) => Number(value));

let dbPool: Pool | null = null;

export function getDbPool(): Pool {
  if (!dbPool) {
    const connectionString = process.env.DATABASE_URL;
    const ssl = process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false };
    dbPool = connectionString
      ? new Pool({ connectionString, ssl, max: 10 })
      : new Pool({
          host: process.env.DB_HOST || '127.0.0.1',
          port: Number(process.env.DB_PORT) || 5432,
          database: process.env.DB_NAME,
          user: process.env.DB_USER,
          password: process.env.DB_PASSWORD,
          ssl,
          max: 10,
        });
  }
  return dbPool;
}

export type { PoolClient };
