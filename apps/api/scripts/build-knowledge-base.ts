/**
 * build-knowledge-base.ts
 *
 * CLI to build the historical knowledge base used for RAG.
 *
 * Usage:
 *   npx tsx scripts/build-knowledge-base.ts [options]
 *
 * Options:
 *   --from      <date>   Start date YYYY-MM-DD (default: 2020-01-01)
 *   --to        <date>   End date   YYYY-MM-DD (default: 2024-01-01)
 *   --symbol    <sym>    Symbol (default: BTC/USDT)
 *   --exchanges <list>   Comma-separated (default: binance,okx,bybit)
 *   --db-path   <path>   LanceDB path (default: ./data/lancedb_kb)
 *   --cache-dir <path>   Raw data cache (default: ./data/kb_cache)
 *   --skip-embed         Build snapshots but skip embedding (dry run)
 */

// Only safe to have static imports of modules that don't transitively load config.
// Knowledge modules are loaded via dynamic import() inside main() AFTER env vars are set.
import { config as dotenv } from 'dotenv';
import { parseArgs } from 'node:util';
import fs from 'fs';

// Load .env with override:true so vars in the file always win over stale shell env.
dotenv({ override: true });

// Set placeholders for keys the build script doesn't need (Telegram, etc.)
// so config/index.ts doesn't throw when dynamically imported inside main().
process.env.ANTHROPIC_API_KEY   ??= 'build-placeholder';
process.env.VOYAGE_API_KEY      ??= 'build-placeholder';
process.env.TELEGRAM_TOKEN      ??= 'build-placeholder';
process.env.TELEGRAM_CHANNEL_ID ??= '-100000000000';

// ── Parse args ────────────────────────────────────────────────────────────────

const { values } = parseArgs({
  options: {
    from:          { type: 'string',  default: '2020-01-01' },
    to:            { type: 'string',  default: '2024-01-01' },
    symbol:        { type: 'string',  default: 'BTC/USDT' },
    exchanges:     { type: 'string',  default: 'binance,okx,bybit' },
    'db-path':     { type: 'string',  default: './data/lancedb_kb' },
    'cache-dir':   { type: 'string',  default: './data/kb_cache' },
    'skip-embed':  { type: 'boolean', default: false },
  },
  strict: false,
});

const FROM       = new Date(values['from']      as string);
const TO         = new Date(values['to']        as string);
const SYMBOL     = values.symbol                as string;
const EXCHANGES  = (values.exchanges as string).split(',').map(s => s.trim());
const DB_PATH    = values['db-path']            as string;
const CACHE_DIR  = values['cache-dir']          as string;
const SKIP_EMBED = values['skip-embed']         as boolean;

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Dynamic imports run AFTER the process.env placeholders above are set,
  // so config/index.ts sees them and doesn't throw.
  const { HistoricalDataBuilder }    = await import('../src/knowledge/HistoricalDataBuilder.js');
  const { LiquidationSynthesizer }   = await import('../src/knowledge/LiquidationSynthesizer.js');
  const { GDELTHistoricalFetcher }   = await import('../src/knowledge/GDELTHistoricalFetcher.js');
  const { CorrelatedSnapshotBuilder } = await import('../src/knowledge/CorrelatedSnapshotBuilder.js');
  const { KnowledgeBaseEmbedder }    = await import('../src/knowledge/KnowledgeBaseEmbedder.js');

  const t0 = Date.now();

  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  Knowledge Base Builder                                      ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(`  Symbol:    ${SYMBOL}`);
  console.log(`  Exchanges: ${EXCHANGES.join(', ')}`);
  console.log(`  Period:    ${fmt(FROM)} → ${fmt(TO)}`);
  console.log(`  DB path:   ${DB_PATH}`);
  console.log(`  Mode:      ${SKIP_EMBED ? 'dry run (no embed)' : 'full build'}`);
  console.log('');

  // ── Step 1: Fetch historical OHLCV + funding + OI ─────────────────────
  console.log('── Step 1/5: Fetching historical market data ─────────────────');
  const dataBuilder = new HistoricalDataBuilder(EXCHANGES, CACHE_DIR);
  const datasets = await dataBuilder.build(SYMBOL, FROM, TO);
  await dataBuilder.close();

  if (datasets.length === 0) {
    console.error('No datasets fetched — aborting');
    process.exit(1);
  }

  const primaryDataset = datasets.find(d => d.exchange === 'binance') ?? datasets[0]!;
  console.log(`\n  Primary dataset: ${primaryDataset.exchange} — ${primaryDataset.candles.length} candles`);

  // ── Step 2: Synthesize liquidations ───────────────────────────────────
  console.log('\n── Step 2/5: Synthesizing liquidation proxies ────────────────');
  const synthesizer = new LiquidationSynthesizer();
  const liqMap = synthesizer.synthesize(primaryDataset.candles, primaryDataset.funding);

  const cascadeCount = [...liqMap.values()].filter(l => l.isCascade).length;
  const spikeCount   = [...liqMap.values()].filter(l => l.totalLiqUsd > 20_000_000).length;
  console.log(`  ${liqMap.size} liquidation windows`);
  console.log(`  ${cascadeCount} cascade events detected`);
  console.log(`  ${spikeCount} spike events detected`);

  // ── Step 3: Fetch macro events (GDELT + FRED) ─────────────────────────
  console.log('\n── Step 3/5: Fetching macro events (GDELT + FRED) ────────────');
  const macroFetcher = new GDELTHistoricalFetcher(CACHE_DIR);
  const macroEvents  = await macroFetcher.fetch(FROM, TO);
  console.log(`  ${macroEvents.length} macro events`);

  const byCategory = macroEvents.reduce<Record<string, number>>((acc, e) => {
    acc[e.category] = (acc[e.category] ?? 0) + 1;
    return acc;
  }, {});
  for (const [cat, count] of Object.entries(byCategory)) {
    console.log(`    ${cat.padEnd(18)} ${count}`);
  }

  // ── Step 4: Build correlated snapshots ────────────────────────────────
  console.log('\n── Step 4/5: Building correlated snapshots ───────────────────');
  const snapshotBuilder = new CorrelatedSnapshotBuilder();
  const snapshots = snapshotBuilder.build(
    primaryDataset.exchange,
    SYMBOL,
    primaryDataset.candles,
    liqMap,
    macroEvents,
  );

  console.log(`  ${snapshots.length} snapshots built`);
  const withCascade = snapshots.filter(s => s.liquidations.isCascade).length;
  const withMacro   = snapshots.filter(s => s.macroEvents.length > 0).length;
  const outcomes    = { up: 0, down: 0, flat: 0 };
  for (const s of snapshots) outcomes[s.outcome.direction]++;
  console.log(`  With cascade:    ${withCascade} (${pct(withCascade, snapshots.length)})`);
  console.log(`  With macro ctx:  ${withMacro} (${pct(withMacro, snapshots.length)})`);
  console.log(`  Outcomes:  up ${outcomes.up}  down ${outcomes.down}  flat ${outcomes.flat}`);

  // Save manifest for inspection
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const manifestPath = `${CACHE_DIR}/snapshots_${fmt(FROM)}_${fmt(TO)}.jsonl`;
  const manifestStream = fs.createWriteStream(manifestPath);
  for (const s of snapshots) {
    manifestStream.write(JSON.stringify({
      id: s.id, timestamp: s.timestamp, price: s.price,
      direction: s.outcome.direction,
      liqCascade: s.liquidations.isCascade,
      macroTone: s.aggregateMacroTone,
    }) + '\n');
  }
  manifestStream.end();
  console.log(`  Manifest saved: ${manifestPath}`);

  // ── Step 5: Embed into LanceDB ────────────────────────────────────────
  if (SKIP_EMBED) {
    console.log('\n── Step 5/5: Skipping embed (--skip-embed) ───────────────────');
  } else {
    console.log('\n── Step 5/5: Embedding into LanceDB ──────────────────────────');
    console.log(`  ~${Math.ceil(snapshots.length / 20)} Voyage AI API calls`);
    console.log(`  Estimated cost: ~$${(snapshots.length * 0.00002).toFixed(2)}`);
    console.log('');

    const embedder = new KnowledgeBaseEmbedder(DB_PATH);
    await embedder.init();

    let lastPct = 0;
    await embedder.embedBatch(snapshots, (done, total) => {
      const p = Math.floor((done / total) * 100);
      if (p >= lastPct + 5) {
        process.stdout.write(`\r  Progress: ${p}% (${done}/${total})`);
        lastPct = p;
      }
    });

    process.stdout.write('\n');
    const total = await embedder.count();
    console.log(`  Knowledge base total: ${total} entries`);
  }

  // ── Summary ───────────────────────────────────────────────────────────
  const durationMs = Date.now() - t0;

  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  BUILD COMPLETE                                              ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(`  Snapshots:    ${snapshots.length.toLocaleString()}`);
  console.log(`  Macro events: ${macroEvents.length}`);
  console.log(`  Duration:     ${(durationMs / 1000 / 60).toFixed(1)} minutes`);
  console.log(`  Output:       ${DB_PATH}`);
  console.log('');
}

function fmt(d: Date): string { return d.toISOString().split('T')[0]!; }
function pct(n: number, total: number): string { return `${((n / total) * 100).toFixed(1)}%`; }

main().catch(err => {
  console.error('\nBuild failed:', err);
  process.exit(1);
});
