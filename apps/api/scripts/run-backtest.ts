/**
 * Backtest CLI runner
 *
 * Usage:
 *   npx tsx scripts/run-backtest.ts [options]
 *
 * Options:
 *   --days   <n>      Days of history to backtest (default: 30)
 *   --symbol <sym>    Symbol (default: BTC/USDT)
 *   --exchange <id>   Exchange (default: binance)
 *   --real-trades     Use real trades from exchange (slow, accurate CVD)
 *                     Default: simulate trades from OHLCV (fast)
 *   --output <file>   Save full JSON result to file (single-period mode)
 *   --multi           Run yearly periods in parallel (2022 → present)
 *   --years <list>    Comma-separated years to run (default: 2022,2023,2024,2025)
 *                     Only applies with --multi
 *
 * Examples:
 *   npx tsx scripts/run-backtest.ts --days 30
 *   npx tsx scripts/run-backtest.ts --multi
 *   npx tsx scripts/run-backtest.ts --multi --years 2023,2024
 *   npx tsx scripts/run-backtest.ts --days 14 --real-trades
 */

import 'dotenv/config';
import { parseArgs } from 'node:util';
import fs from 'fs';
import path from 'path';
import { DataFetcher } from '../src/backtest/DataFetcher.js';
import { BacktestEngine } from '../src/backtest/BacktestEngine.js';
import { PerformanceAnalyzer } from '../src/backtest/PerformanceAnalyzer.js';
import { DEFAULT_CONFIG } from '../src/backtest/types.js';
import type { BacktestConfig, BacktestResult } from '../src/backtest/types.js';

// ── Silence OTel / logger during backtest ────────────────────────────────────
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? 'backtest-placeholder';
process.env.VOYAGE_API_KEY = process.env.VOYAGE_API_KEY ?? 'backtest-placeholder';
process.env.TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN ?? 'backtest-placeholder';
process.env.TELEGRAM_CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID ?? '-100000000000';

// ── Parse CLI args ────────────────────────────────────────────────────────────

const { values } = parseArgs({
  options: {
    days:          { type: 'string',  default: '30' },
    from:          { type: 'string' },   // e.g. 2024-01-01
    to:            { type: 'string' },   // e.g. 2024-12-31  (defaults to now)
    symbol:        { type: 'string',  default: 'BTC/USDT' },
    exchange:      { type: 'string',  default: 'binance' },
    'real-trades': { type: 'boolean', default: false },
    output:        { type: 'string' },
    multi:         { type: 'boolean', default: false },
    years:         { type: 'string',  default: '2022,2023,2024,2025' },
    model:         { type: 'string',  default: 'claude-haiku-4-5' },
    'mock-ai':     { type: 'boolean', default: false },
    'knn-only':    { type: 'boolean', default: false },
  },
  strict: false,
});

const SYMBOL   = values.symbol   as string;
const EXCHANGE = values.exchange as string;
const SIMULATE = !(values['real-trades'] as boolean);
const CACHE_DIR = './data/backtest';

// ── Period helpers ────────────────────────────────────────────────────────────

interface Period {
  label: string;
  startDate: Date;
  endDate: Date;
}

function buildYearPeriods(years: number[]): Period[] {
  const now = new Date();
  return years.map(year => {
    const start = new Date(`${year}-01-01T00:00:00.000Z`);
    const end   = year < now.getUTCFullYear()
      ? new Date(`${year}-12-31T23:59:59.999Z`)
      : new Date(now.getTime() - 24 * 60 * 60_000); // yesterday (current year)
    return { label: String(year), startDate: start, endDate: end };
  });
}

// ── Single-period runner ──────────────────────────────────────────────────────

async function runPeriod(period: Period, silent = false): Promise<BacktestResult> {
  const config: BacktestConfig = {
    ...DEFAULT_CONFIG,
    symbol: SYMBOL,
    exchangeId: EXCHANGE,
    startDate: period.startDate,
    endDate: period.endDate,
    simulateTrades: SIMULATE,
    cacheDir: CACHE_DIR,
    aiModel: values.model as string,
    mockAI:   values['mock-ai']  as boolean,
    knnOnly:  values['knn-only'] as boolean,
    persistToDb: true,
    runLabel: period.label,
  };

  if (!silent) {
    console.log(`[${period.label}] Fetching data ${period.startDate.toISOString().split('T')[0]} → ${period.endDate.toISOString().split('T')[0]}`);
  }

  const fetcher = new DataFetcher(config);
  const dataset = await fetcher.fetch();
  await fetcher.close();

  const engine = new BacktestEngine(config);
  const outcomes = await engine.run(dataset);

  const analyzer = new PerformanceAnalyzer(config);
  const result   = analyzer.analyze(outcomes, dataset.candles);
  result.dataRange.totalTrades = dataset.trades.length;

  if (!silent) {
    console.log(`[${period.label}] Done — ${result.totalSignals} signals`);
  }

  return result;
}

// ── Multi-period runner ───────────────────────────────────────────────────────

async function runMulti(): Promise<void> {
  const years = (values.years as string).split(',').map(y => parseInt(y.trim(), 10)).filter(y => !isNaN(y));
  const periods = buildYearPeriods(years);

  console.log('\n══════════════════════════════════════════════════════════════');
  console.log(`  Multi-period Backtest  |  ${SYMBOL}  |  ${EXCHANGE}`);
  console.log(`  Periods: ${periods.map(p => p.label).join(', ')}`);
  console.log(`  Running ${periods.length} periods in parallel…`);
  console.log('══════════════════════════════════════════════════════════════\n');

  // Run all periods concurrently
  const results = await Promise.all(
    periods.map(async (period) => {
      try {
        const result = await runPeriod(period, false);
        return { period, result, error: null };
      } catch (err) {
        console.error(`[${period.label}] FAILED:`, err);
        return { period, result: null, error: String(err) };
      }
    }),
  );

  // Save each result to its own file
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  for (const { period, result } of results) {
    if (!result) continue;
    const label = period.label.replace(/\s+/g, '_');
    const from  = period.startDate.toISOString().split('T')[0];
    const to    = period.endDate.toISOString().split('T')[0];
    const file  = path.join(CACHE_DIR, `backtest_${label}_${from}_${to}.json`);
    fs.writeFileSync(file, JSON.stringify(result, null, 2));
    console.log(`  Saved: ${file}`);
  }

  // Print comparison table
  printComparisonReport(
    results.map(r => ({ label: r.period.label, result: r.result })),
  );
}

// ── Single-period CLI entry ───────────────────────────────────────────────────

async function runSingle(): Promise<void> {
  let startDate: Date;
  let endDate: Date;
  let label: string;

  if (values.from) {
    // Explicit date range: --from 2024-01-01 [--to 2024-12-31]
    startDate = new Date(values.from as string);
    endDate   = values.to ? new Date(values.to as string) : new Date();
    label     = `${fmt(startDate)}_${fmt(endDate)}`;
  } else {
    // Default: last N days
    const days = parseInt(values.days as string, 10);
    endDate    = new Date();
    startDate  = new Date(endDate.getTime() - days * 24 * 60 * 60_000);
    label      = `${days}d`;
  }

  const period: Period = { label, startDate, endDate };

  console.log('\n══════════════════════════════════════════════════════');
  console.log('  BTC/USDT Backtest');
  console.log(`  Symbol:   ${SYMBOL}`);
  console.log(`  Exchange: ${EXCHANGE}`);
  console.log(`  Period:   ${fmt(startDate)} → ${fmt(endDate)}`);
  console.log(`  Trades:   ${SIMULATE ? 'simulated from OHLCV' : 'real (fetched)'}`);
  console.log('══════════════════════════════════════════════════════\n');

  const result = await runPeriod(period);
  printReport(period.label, result);

  // Auto-save to data/backtest/ so the dashboard shows it
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const autoFile = path.join(CACHE_DIR, `backtest_${label.replace(/\s+/g, '_')}.json`);
  fs.writeFileSync(autoFile, JSON.stringify(result, null, 2));
  console.log(`Result saved: ${autoFile}`);

  if (values.output) {
    const outPath = values.output as string;
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
    console.log(`Also saved to: ${outPath}`);
  }
}

// ── Report printers ───────────────────────────────────────────────────────────

function printReport(label: string, result: BacktestResult): void {
  const { byHorizon, mmTrapStats, dataRange, totalSignals } = result;

  console.log('\n══════════════════════════════════════════════════════');
  console.log(`  BACKTEST REPORT — ${label}`);
  console.log('══════════════════════════════════════════════════════');
  console.log(`  Data range:     ${dataRange.from.split('T')[0]} → ${dataRange.to.split('T')[0]}`);
  console.log(`  Candles:        ${dataRange.totalCandles.toLocaleString()}`);
  console.log(`  Trades:         ${dataRange.totalTrades.toLocaleString()}`);
  console.log(`  Total signals:  ${totalSignals}`);

  console.log('\n── Signal Performance by Horizon ──────────────────────');
  console.log(
    pad('Horizon', 8) +
    pad('Total', 7) + pad('Win', 6) + pad('Loss', 6) + pad('Neutral', 9) +
    pad('Win%', 7) + pad('AvgRet%', 9) + pad('Sharpe', 8) + pad('MaxDD%', 8) + pad('PF', 6),
  );
  console.log('─'.repeat(74));

  for (const [horizon, m] of Object.entries(byHorizon)) {
    if (m.total === 0) continue;
    console.log(
      pad(horizon, 8) + pad(String(m.total), 7) + pad(String(m.wins), 6) +
      pad(String(m.losses), 6) + pad(String(m.neutral), 9) +
      pad(pct(m.winRate), 7) + pad(pct(m.avgReturnPct), 9) +
      pad(m.sharpeRatio.toFixed(2), 8) + pad(pct(m.maxDrawdownPct), 8) +
      pad(m.profitFactor === Infinity ? '∞' : m.profitFactor.toFixed(2), 6),
    );
  }

  console.log('\n── MM Trap Analysis ────────────────────────────────────');
  console.log(`  Total traps detected:      ${mmTrapStats.total}`);
  if (Object.keys(mmTrapStats.byType).length > 0) {
    for (const [type, count] of Object.entries(mmTrapStats.byType)) {
      console.log(`    ${type.padEnd(14)} ${count}`);
    }
  }
  console.log(`  Win rate — trap signals:   ${pct(mmTrapStats.trapSignalWinRate)}`);
  console.log(`  Win rate — clean signals:  ${pct(mmTrapStats.cleanSignalWinRate)}`);
  if (mmTrapStats.cleanSignalWinRate > mmTrapStats.trapSignalWinRate) {
    console.log('\n  ✓ MM filter is working — clean signals outperform trapped ones');
  } else if (mmTrapStats.total > 0) {
    console.log('\n  ⚠ MM filter needs tuning — trap signals performing similarly to clean ones');
  }
  console.log('\n══════════════════════════════════════════════════════\n');
}

/**
 * Side-by-side comparison table across all periods.
 *
 * Layout (per horizon):
 *   Metric        | 2022 | 2023 | 2024 | 2025
 *   Signals       |  ...
 *   Win%          |  ...
 *   AvgReturn%    |  ...
 *   Sharpe        |  ...
 *   MaxDD%        |  ...
 */
function printComparisonReport(entries: { label: string; result: BacktestResult | null }[]): void {
  const valid = entries.filter(e => e.result !== null) as { label: string; result: BacktestResult }[];
  if (valid.length === 0) {
    console.log('\nNo results to compare.');
    return;
  }

  const horizons = ['short', 'mid', 'long'];
  const COL = 10;

  console.log('\n');
  console.log('╔' + '═'.repeat(80) + '╗');
  console.log('║' + '  MULTI-PERIOD COMPARISON'.padEnd(80) + '║');
  console.log('╚' + '═'.repeat(80) + '╝');

  for (const horizon of horizons) {
    // Check if any period has data for this horizon
    if (!valid.some(e => (e.result.byHorizon[horizon]?.total ?? 0) > 0)) continue;

    console.log(`\n  ── ${horizon.toUpperCase()} horizon ${'─'.repeat(50 - horizon.length)}`);

    // Header
    const header = '  ' + 'Metric'.padEnd(16) + valid.map(e => e.label.padStart(COL)).join('');
    console.log(header);
    console.log('  ' + '─'.repeat(16 + COL * valid.length));

    const row = (label: string, fn: (m: BacktestResult) => string) =>
      '  ' + label.padEnd(16) + valid.map(e => fn(e.result).padStart(COL)).join('');

    const m = (e: BacktestResult) => e.byHorizon[horizon] ?? { total: 0, wins: 0, losses: 0, neutral: 0, pending: 0, winRate: 0, avgReturnPct: 0, sharpeRatio: 0, maxDrawdownPct: 0, profitFactor: 0 };

    console.log(row('Signals',    e => String(m(e).total)));
    console.log(row('Win%',       e => pct(m(e).winRate)));
    console.log(row('AvgReturn%', e => pct(m(e).avgReturnPct)));
    console.log(row('Sharpe',     e => m(e).sharpeRatio.toFixed(2)));
    console.log(row('MaxDD%',     e => pct(m(e).maxDrawdownPct)));
    console.log(row('ProfitFact', e => {
      const pf = m(e).profitFactor;
      return pf === Infinity ? '∞' : pf.toFixed(2);
    }));
  }

  // MM traps overview
  console.log('\n  ── MM TRAP OVERVIEW ' + '─'.repeat(45));
  const trapHeader = '  ' + 'Metric'.padEnd(16) + valid.map(e => e.label.padStart(COL)).join('');
  console.log(trapHeader);
  console.log('  ' + '─'.repeat(16 + COL * valid.length));
  console.log('  ' + 'Traps'.padEnd(16)      + valid.map(e => String(e.result.mmTrapStats.total).padStart(COL)).join(''));
  console.log('  ' + 'Trap WinRate'.padEnd(16) + valid.map(e => pct(e.result.mmTrapStats.trapSignalWinRate).padStart(COL)).join(''));
  console.log('  ' + 'Clean WinRate'.padEnd(16) + valid.map(e => pct(e.result.mmTrapStats.cleanSignalWinRate).padStart(COL)).join(''));

  // Overall signals
  console.log('\n  ── OVERALL ' + '─'.repeat(53));
  console.log('  ' + 'Metric'.padEnd(16) + valid.map(e => e.label.padStart(COL)).join(''));
  console.log('  ' + '─'.repeat(16 + COL * valid.length));
  console.log('  ' + 'Total Signals'.padEnd(16) + valid.map(e => String(e.result.totalSignals).padStart(COL)).join(''));
  console.log('  ' + 'Candles'.padEnd(16)       + valid.map(e => e.result.dataRange.totalCandles.toLocaleString().padStart(COL)).join(''));
  console.log('  ' + 'Trades'.padEnd(16)        + valid.map(e => e.result.dataRange.totalTrades.toLocaleString().padStart(COL)).join(''));

  console.log('');
}

function pad(s: string, width: number): string { return s.padEnd(width); }
function pct(n: number): string { return (n * 100).toFixed(1) + '%'; }
function fmt(d: Date): string { return d.toISOString().split('T')[0]!; }

// ── Entry ─────────────────────────────────────────────────────────────────────

const isMulti = values.multi as boolean;

(isMulti ? runMulti() : runSingle()).catch(err => {
  console.error('\nBacktest failed:', err);
  process.exit(1);
});
