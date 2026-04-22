/**
 * build-embed.ts — Step 3 of KB pipeline
 *
 * Reads all kb_snapshots WHERE embedded=0 from PostgreSQL, calls Voyage AI
 * to get vectors (128 texts per call), inserts into LanceDB, and marks
 * rows embedded=1 in pg.
 *
 * Fully resumable: re-run at any time to continue from where it stopped.
 *
 * Run AFTER build-snapshots.
 *
 * Usage:
 *   npm run build:embed
 *   npm run build:embed -- --db-path ./data/lancedb_kb
 */

import { config as dotenv } from 'dotenv';
import { parseArgs } from 'node:util';
dotenv({ override: true });

process.env.TELEGRAM_TOKEN      ??= 'build-placeholder';
process.env.TELEGRAM_CHANNEL_ID ??= '-100000000000';
process.env.ANTHROPIC_API_KEY   ??= 'build-placeholder';

if (!process.env['VOYAGE_API_KEY']) {
  console.error('Error: VOYAGE_API_KEY is required for build:embed');
  process.exit(1);
}

const { values } = parseArgs({
  options: {
    'db-path': { type: 'string', default: './data/lancedb_kb' },
  },
  strict: false,
});

const DB_PATH = values['db-path'] as string;

async function main(): Promise<void> {
  const { closePool }          = await import('../src/db/client.js');
  const { KnowledgeBaseEmbedder } = await import('../src/knowledge/KnowledgeBaseEmbedder.js');

  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  Step 3 — Embed Snapshots → LanceDB                          ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(`  LanceDB path: ${DB_PATH}`);
  console.log('');

  const embedder = new KnowledgeBaseEmbedder(DB_PATH);
  await embedder.init();

  const t0 = Date.now();
  let lastPct = 0;

  const total = await embedder.embedFromDB((done, total) => {
    const pct = Math.floor((done / total) * 100);
    if (pct >= lastPct + 2) {
      process.stdout.write(`\r  Progress: ${pct}% (${done}/${total})`);
      lastPct = pct;
    }
  });

  process.stdout.write('\n');
  const lanceTotal = await embedder.count();
  const duration   = ((Date.now() - t0) / 1000 / 60).toFixed(1);

  console.log(`\n  Vectors written this run: ${total.toLocaleString()}`);
  console.log(`  LanceDB total:            ${lanceTotal.toLocaleString()}`);
  console.log(`  Duration:                 ${duration} minutes`);

  await closePool();
  console.log('\n  Knowledge base ready.\n');
}

main().catch(err => { console.error('\nbuild-embed failed:', err); process.exit(1); });
