/**
 * src/db/client.ts
 *
 * Singleton pg.Pool.
 * Schema management is handled by src/db/migrate.ts.
 */

import pg from 'pg';

let _pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!_pool) {
    const url = process.env['DATABASE_URL']
      ?? 'postgresql://trading:trading@localhost:5432/trading';
    _pool = new pg.Pool({
      connectionString: url,
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    _pool.on('error', (err) => {
      console.error('[pg] Idle client error:', err.message);
    });
  }
  return _pool;
}

export async function closePool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}

/**
 * Refresh the kb_daily_reversal_stats materialized view.
 * Call this after each snapshot build completes.
 */
export async function refreshKbStats(): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query('REFRESH MATERIALIZED VIEW kb_daily_reversal_stats');
  } finally {
    client.release();
  }
}
