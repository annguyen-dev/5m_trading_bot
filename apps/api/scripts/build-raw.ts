/**
 * build-raw.ts — Step 1 of KB pipeline
 *
 * Fetches 1m OHLCV candles + funding rates from exchanges
 * and fetches macro events (GDELT + FRED), persisting all data
 * to PostgreSQL.
 *
 * Resumable: already-stored rows are skipped (INSERT ON CONFLICT DO NOTHING).
 *
 * Usage:
 *   npm run build:raw
 *   npm run build:raw -- --from 2023-01-01 --to 2024-01-01
 *   npm run build:raw -- --from 2023-01-01 --to 2024-01-01 --exchanges binance
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
    from:        { type: 'string',  default: '2022-01-01' },
    to:          { type: 'string',  default: '2025-01-01' },
    symbol:      { type: 'string',  default: 'BTC/USDT' },
    exchanges:   { type: 'string',  default: 'binance,okx,bybit' },
    'cache-dir': { type: 'string',  default: './data/kb_cache' },
    'no-cache':  { type: 'boolean', default: false },
  },
  strict: false,
});

const FROM       = new Date(values['from']    as string);
const TO         = new Date(values['to']      as string);
const SYMBOL     = values.symbol              as string;
const EXCHANGES  = (values.exchanges as string).split(',').map(s => s.trim());
const CACHE_DIR  = values['cache-dir']        as string;

async function main(): Promise<void> {
  const { closePool }                  = await import('../src/db/client.js');
  const { migrate }                    = await import('../src/db/migrate.js');
  const { HistoricalDataBuilder }      = await import('../src/knowledge/HistoricalDataBuilder.js');
  const { GDELTHistoricalFetcher }     = await import('../src/knowledge/GDELTHistoricalFetcher.js');

  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  Step 1 — Fetch Raw Data → PostgreSQL                        ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(`  Symbol:    ${SYMBOL}`);
  console.log(`  Exchanges: ${EXCHANGES.join(', ')}`);
  console.log(`  Period:    ${fmt(FROM)} → ${fmt(TO)}`);
  console.log('');

  await migrate();

  // ── OHLCV + funding ────────────────────────────────────────────────────
  console.log('── Fetching OHLCV (1m) + funding rates ───────────────────────');
  const dataBuilder = new HistoricalDataBuilder(EXCHANGES);
  await dataBuilder.build(SYMBOL, FROM, TO);
  await dataBuilder.close();

  // ── Macro events (GDELT + FRED) ────────────────────────────────────────
  console.log('\n── Fetching macro events (GDELT + FRED) ──────────────────────');
  const macroFetcher = new GDELTHistoricalFetcher(CACHE_DIR);
  const events = await macroFetcher.fetch(FROM, TO);
  console.log(`  ${events.length} macro events persisted`);

  await closePool();
  console.log('\n  Done. Run `npm run build:snapshots` next.\n');
}

function fmt(d: Date): string { return d.toISOString().split('T')[0]!; }

main().catch(err => { console.error('\nbuild-raw failed:', err); process.exit(1); });
