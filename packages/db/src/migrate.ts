/**
 * src/db/migrate.ts
 *
 * Runs pending SQL migrations from src/db/migrations/ in lexicographic order.
 * Each migration is applied exactly once and recorded in schema_migrations.
 *
 * Usage (programmatic):
 *   import { migrate } from './migrate.js';
 *   await migrate();
 *
 * Usage (CLI):
 *   npm run migrate
 */

import { readdir, readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { getPool } from './client.js';

const MIGRATIONS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'migrations',
);

export async function migrate(): Promise<void> {
  const client = await getPool().connect();
  try {
    // Tracking table — idempotent
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    TEXT   PRIMARY KEY,
        applied_at BIGINT NOT NULL
      )
    `);

    const { rows } = await client.query<{ version: string }>(
      'SELECT version FROM schema_migrations ORDER BY version',
    );
    const applied = new Set(rows.map(r => r.version));

    const files = (await readdir(MIGRATIONS_DIR))
      .filter(f => f.endsWith('.sql'))
      .sort();

    let ran = 0;
    for (const file of files) {
      if (applied.has(file)) continue;

      const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf-8');
      console.log(`  → ${file}`);

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2)',
          [file, Date.now()],
        );
        await client.query('COMMIT');
        ran++;
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }

    if (ran === 0) {
      console.log('  Already up to date.');
    } else {
      console.log(`  ${ran} migration(s) applied.`);
    }
  } finally {
    client.release();
  }
}
