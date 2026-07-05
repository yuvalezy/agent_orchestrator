import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { databaseUrl } from '../config/env';
import { logger } from '../logger';

export const pool = new Pool({ connectionString: databaseUrl() });

pool.on('error', (err) => {
  logger.error({ err }, 'Unexpected PostgreSQL pool error');
});

/** Run a parameterized query using the shared pool. */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<QueryResult<T>> {
  return pool.query<T>(text, params as unknown[] | undefined);
}

/** Borrow a client from the pool and always release it. */
export async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
