/**
 * build-snapshots.ts — Step 2 of KB pipeline
 *
 * Reads ohlcv_1m + macro_events from PostgreSQL, computes 1m snapshots
 * with streak_1m, streak_5m, outcomes (t1m → t1d), and writes to
 * kb_snapshots. Resumable (ON CONFLICT DO NOTHING).
 *
 * Run AFTER build-raw.
 *
 * Usage:
 *   npm run build:snapshots
 *   npm run build:snapshots -- --from 2023-01-01 --to 2024-01-01
 */

import { config as dotenv } from 'dotenv';
import { parseArgs } from 'node:util';
dotenv({ override: true });

process.env.ANTHROPIC_API_KEY   ??= 'build-placeholder';
process.env.VOYAGE_API_KEY      ??= 'build-placeholder';
process.env.TELEGRAM_TOKEN      ??= 'build-placeholder';
process.env.TELEGRAM_CHANNEL_ID ??= '-100000000000';

const { values } = parseArgs({
  options: {
    from:     { type: 'string', default: '2022-01-01' },
    to:       { type: 'string', default: '2025-01-01' },
    symbol:   { type: 'string', default: 'BTC/USDT' },
    exchange: { type: 'string', default: 'binance' },
  },
  strict: false,
});

const FROM     = new Date(values['from']    as string);
const TO       = new Date(values['to']      as string);
const SYMBOL   = values.symbol              as string;
const EXCHANGE = values.exchange            as string;

async function main(): Promise<void> {
  const { closePool }       = await import('../src/db/client.js');
  const { migrate }         = await import('../src/db/migrate.js');
  const { SnapshotBuilder } = await import('../src/knowledge/SnapshotBuilder.js');

  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  Step 2 — Build Snapshots → kb_snapshots                     ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(`  Exchange: ${EXCHANGE}  Symbol: ${SYMBOL}`);
  console.log(`  Period:   ${fmt(FROM)} → ${fmt(TO)}`);
  console.log('');

  await migrate();

  // Reset any rows that have empty embedding_text (can happen if a previous run was
  // interrupted between INSERT and the UPDATE that set embedding_text).
  const { getPool } = await import('../src/db/client.js');
  const resetResult = await getPool().query(
    `DELETE FROM kb_snapshots WHERE exchange=$1 AND symbol=$2 AND length(embedding_text) <= 20`,
    [EXCHANGE, SYMBOL],
  );
  if ((resetResult.rowCount ?? 0) > 0) {
    console.log(`  Cleared ${resetResult.rowCount} rows with missing embedding_text`);
  }

  const t0 = Date.now();
  const builder = new SnapshotBuilder(EXCHANGE, SYMBOL);
  const written = await builder.build(FROM, TO);

  const duration = ((Date.now() - t0) / 1000 / 60).toFixed(1);
  console.log(`\n  Snapshots written: ${written.toLocaleString()}`);
  console.log(`  Duration: ${duration} minutes`);

  await closePool();
  console.log('\n  Done. Run `npm run build:embed` next.\n');
}

function fmt(d: Date): string { return d.toISOString().split('T')[0]!; }

main().catch(err => { console.error('\nbuild-snapshots failed:', err); process.exit(1); });
