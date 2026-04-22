/**
 * build-kb.ts — Full KB pipeline (pull → snapshots)
 *
 * Step 1: Fetch 1m OHLCV + funding rates + macro events → PostgreSQL
 * Step 2: Compute kb_snapshots (streaks, outcomes, pattern_hash, etc.)
 *
 * Embed is excluded until the embedding strategy is finalised.
 *
 * Usage:
 *   pnpm --filter @trading-bot/backend run build:kb
 *   pnpm --filter @trading-bot/backend run build:kb -- --from 2023-01-01 --to 2024-01-01
 *   pnpm --filter @trading-bot/backend run build:kb:test   # 2023-01 only, fast
 */

import { config as dotenv } from 'dotenv';
import { parseArgs } from 'node:util';

dotenv({ override: true });

// Silence services that aren't needed for KB builds
process.env.ANTHROPIC_API_KEY   ??= 'build-placeholder';
process.env.VOYAGE_API_KEY      ??= 'build-placeholder';
process.env.TELEGRAM_TOKEN      ??= 'build-placeholder';
process.env.TELEGRAM_CHANNEL_ID ??= '-100000000000';

const { values } = parseArgs({
  options: {
    from:        { type: 'string',  default: '2022-01-01' },
    to:          { type: 'string',  default: '2025-01-01' },
    symbol:      { type: 'string',  default: 'BTC/USDT' },
    exchange:    { type: 'string',  default: 'binance' },
    exchanges:   { type: 'string',  default: 'binance,okx,bybit' },
    'cache-dir': { type: 'string',  default: './data/kb_cache' },
    'skip-pull': { type: 'boolean', default: false },
  },
  strict: false,
});

const FROM      = new Date(values['from']     as string);
const TO        = new Date(values['to']       as string);
const SYMBOL    = values.symbol               as string;
const EXCHANGE  = values.exchange             as string;
const EXCHANGES = (values.exchanges as string).split(',').map(s => s.trim());
const CACHE_DIR = values['cache-dir']         as string;
const SKIP_PULL = values['skip-pull']         as boolean;

function fmt(d: Date) { return d.toISOString().split('T')[0]!; }
function hr(label: string) { console.log(`\n── ${label} ${'─'.repeat(Math.max(0, 54 - label.length))}`); }

async function main() {
  const { getPool, closePool } = await import('../src/db/client.js');
  const { migrate }            = await import('../src/db/migrate.js');

  const t0 = Date.now();

  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  KB Pipeline  (pull → snapshots)                             ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(`  Symbol:    ${SYMBOL}`);
  console.log(`  Exchanges: ${EXCHANGES.join(', ')}`);
  console.log(`  Period:    ${fmt(FROM)} → ${fmt(TO)}`);
  if (SKIP_PULL) console.log('  Mode:      --skip-pull (snapshots only)');
  console.log('');

  // ── Migrate schema ────────────────────────────────────────────────────
  console.log('Running migrations...');
  await migrate();

  // ── Step 1: Pull raw data ─────────────────────────────────────────────
  if (!SKIP_PULL) {
    hr('Step 1 / 2 — Fetch raw data');

    const { HistoricalDataBuilder } = await import('../src/knowledge/HistoricalDataBuilder.js');
    const { GDELTHistoricalFetcher } = await import('../src/knowledge/GDELTHistoricalFetcher.js');

    console.log('  Fetching OHLCV (1m) + funding rates...');
    const dataBuilder = new HistoricalDataBuilder(EXCHANGES, CACHE_DIR);
    await dataBuilder.build(SYMBOL, FROM, TO);
    await dataBuilder.close();

    console.log('  Fetching macro events (GDELT + FRED)...');
    const macroFetcher = new GDELTHistoricalFetcher(CACHE_DIR);
    const events = await macroFetcher.fetch(FROM, TO);
    console.log(`  ${events.length} macro events persisted`);
  } else {
    hr('Step 1 / 2 — Skipped (--skip-pull)');
  }

  // ── Step 2: Build snapshots ───────────────────────────────────────────
  hr('Step 2 / 2 — Build kb_snapshots');

  const { SnapshotBuilder } = await import('../src/knowledge/SnapshotBuilder.js');

  // Clear rows with empty embedding_text (interrupted previous run)
  const pool = getPool();
  const cleared = await pool.query(
    `DELETE FROM kb_snapshots WHERE exchange=$1 AND symbol=$2 AND length(embedding_text) <= 20`,
    [EXCHANGE, SYMBOL],
  );
  if ((cleared.rowCount ?? 0) > 0) {
    console.log(`  Cleared ${cleared.rowCount} incomplete rows`);
  }

  const t1 = Date.now();
  const builder = new SnapshotBuilder(EXCHANGE, SYMBOL);
  const written = await builder.build(FROM, TO);
  const snapMin = ((Date.now() - t1) / 60_000).toFixed(1);

  console.log(`  Written: ${written.toLocaleString()} snapshots (${snapMin} min)`);

  // ── Summary ───────────────────────────────────────────────────────────
  const totalMin = ((Date.now() - t0) / 60_000).toFixed(1);

  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  DONE                                                        ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(`  Total time: ${totalMin} minutes`);
  console.log(`  Next: run \`pnpm --filter @trading-bot/backend run build:kb\` again to add new data\n`);

  await closePool();
}

main().catch(err => { console.error('\nbuild-kb failed:', err); process.exit(1); });
