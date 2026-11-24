import pg from 'pg';
import { env } from './env';

// DATE -> 'YYYY-MM-DD' string (no JS timezone shifting); BIGINT -> number; NUMERIC stays a string (exact decimals).
pg.types.setTypeParser(1082, (v) => v);
pg.types.setTypeParser(20, (v) => Number(v));

export interface Q {
  query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export const pool = new pg.Pool({
  connectionString: env.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 15_000,
});
pool.on('error', (err) => console.error('[db] idle client error', err.message));

export const db: Q = {
  query: (sql, params) => pool.query(sql, params as any[]) as any,
};

/** Runs fn inside one database transaction. Any throw rolls everything back. */
export async function tx<T>(fn: (q: Q) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn({ query: (sql, params) => client.query(sql, params as any[]) as any });
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function one<T = any>(q: Q, sql: string, params?: unknown[]): Promise<T | undefined> {
  return (await q.query<T>(sql, params)).rows[0];
}
