/**
 * Backtest CHOP-REGIME strategy: fade streak 3-4 ONLY when recent
 * 2h shows high rate of short streak ends (RecentEnds34Rate ≥ threshold).
 *
 * From analyze-regime-detector.ts: this single indicator has +14pp edge
 * at Q5 (66.7% WR vs 52.6% baseline). Spread 36.9pp Q1-Q5 — biggest
 * single-indicator edge ever found.
 *
 * Usage:
 *   pnpm --filter @trading-bot/api exec tsx scripts/backtest-chop-regime.ts \
 *     [--days=30] [--base=10] [--threshold=0.33]
 */
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config({
  path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.env'),
  override: true,
});

interface Args {
  days: number;
  base: number;
  threshold: number;
  entryPrice: number;
  body3Min: number;
  priorRangeMin: number;
  priorRangeMax: number;
}

function parseArgs(): Args {
  const a: Args = {
    days: 30, base: 10, threshold: 0.33, entryPrice: 0.55, body3Min: 0,
    priorRangeMin: 0, priorRangeMax: 99999,
  };
  for (const arg of process.argv.slice(2)) {
    const eq = arg.indexOf('=');
    if (eq < 0) continue;
    const k = arg.slice(2, eq);
    const v = Number(arg.slice(eq + 1));
    switch (k) {
      case 'days':              a.days = v; break;
      case 'base':              a.base = v; break;
      case 'threshold':         a.threshold = v; break;
      case 'entry':             a.entryPrice = v; break;
      case 'body3-min':         a.body3Min = v; break;
      case 'prior-range-min':   a.priorRangeMin = v; break;
      case 'prior-range-max':   a.priorRangeMax = v; break;
    }
  }
  return a;
}

interface Bar { ts: number; close: number; body: number; dir: 1|-1|0 }

async function fetchKlines(days: number): Promise<Bar[]> {
  const endMs = Date.now(), startMs = endMs - days * 86400_000;
  const all: Bar[] = []; let cursor = startMs, pages = 0;
  while (cursor < endMs) {
    const url = `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=5m&startTime=${cursor}&endTime=${endMs}&limit=1000`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Binance ${res.status}`);
    const rows = (await res.json()) as unknown[][];
    if (!rows.length) break;
    for (const r of rows) {
      const ts = Number(r[0]), open = Number(r[1]), close = Number(r[4]);
      all.push({ ts, close, body: close - open, dir: close > open ? 1 : close < open ? -1 : 0 });
    }
    const lastTs = Number(rows[rows.length-1]?.[0] ?? 0);
    if (lastTs <= cursor) break;
    cursor = lastTs + 1; pages++;
    if (pages % 10 === 0) process.stderr.write(`  fetched ${all.length} bars…\n`);
    await new Promise(r => setTimeout(r, 80));
  }
  return all;
}

interface Trade {
  ts: number;
  streak: number;
  body3: number;
  recentEnds34Rate: number;
  betDir: 1|-1;
  won: boolean;
  pnl: number;
}

async function main(): Promise<void> {
  const args = parseArgs();
  console.error(`Fetching ${args.days}d…`);
  const bars = await fetchKlines(args.days);
  console.error(`Got ${bars.length} bars\n`);

  const streakLen = new Array<number>(bars.length).fill(0);
  for (let i = 0; i < bars.length; i++) {
    streakLen[i] = bars[i]!.dir === 0 ? 0
      : (i > 0 && bars[i-1]!.dir === bars[i]!.dir ? streakLen[i-1]! + 1 : 1);
  }

  // Streak end events
  interface StreakEnd { idx: number; ts: number; len: number }
  const ends: StreakEnd[] = [];
  for (let i = 0; i < bars.length - 1; i++) {
    if (streakLen[i]! >= 1 && bars[i+1]!.dir !== bars[i]!.dir) {
      ends.push({ idx: i, ts: bars[i]!.ts, len: streakLen[i]! });
    }
  }

  const trades: Trade[] = [];
  const LOOKBACK_MS = 2 * 60 * 60_000;
  for (let i = 3; i + 1 < bars.length; i++) {
    if (streakLen[i] !== 3 && streakLen[i] !== 4) continue;
    if (streakLen[i-1] === streakLen[i]) continue;  // not first hit
    const regime = bars[i]!.dir;
    if (regime === 0) continue;
    const next = bars[i+1]!;
    if (next.dir === 0) continue;

    // RecentEnds34Rate(2h) — only ends fully observable at decision time.
    // At "bar i closed, deciding for bar i+1", we know bars[0..i]. An end
    // at bar j requires bars[j+1] known, so we observe ends for j ≤ i-1.
    // End at j=i is UNKNOWABLE (depends on bars[i+1] = the prediction
    // target). Including j=i leaks the trade outcome into the indicator.
    const nowTs = bars[i]!.ts;
    const endsIn2h = ends.filter(e =>
      e.idx <= i - 1 && e.ts > nowTs - LOOKBACK_MS
    );
    if (endsIn2h.length === 0) continue;
    const ends34 = endsIn2h.filter(e => e.len === 3 || e.len === 4).length;
    const rate = ends34 / endsIn2h.length;
    if (rate < args.threshold) continue;

    // Optional body3 filter
    const body3 = Math.abs(bars[i]!.body) + Math.abs(bars[i-1]!.body) + Math.abs(bars[i-2]!.body);
    if (body3 < args.body3Min) continue;

    // Optional prior 12h range filter (Goldilocks zone $977-2143 ⇒ best edge)
    if (args.priorRangeMin > 0 || args.priorRangeMax < 99999) {
      let hi = -Infinity, lo = Infinity;
      for (let j = Math.max(0, i - 144); j < i - 24; j++) {
        hi = Math.max(hi, bars[j]!.close);
        lo = Math.min(lo, bars[j]!.close);
      }
      const priorRange = hi - lo;
      if (priorRange < args.priorRangeMin || priorRange > args.priorRangeMax) continue;
    }

    // Bet contrarian
    const betDir = (regime === 1 ? -1 : 1) as -1 | 1;
    const won = next.dir === betDir;
    const shares = args.base / args.entryPrice;
    const pnl = won ? shares * (1 - args.entryPrice) : -args.base;

    trades.push({ ts: nowTs, streak: streakLen[i]!, body3, recentEnds34Rate: rate, betDir, won, pnl });
  }

  // Reporting
  const fmt = (n: number) => (n >= 0 ? '+' : '') + n.toFixed(2);
  function summary(label: string, list: Trade[]): void {
    if (list.length === 0) { console.log(`  ${label.padEnd(36)} (none)`); return; }
    const wins = list.filter(t => t.won).length;
    const pnl  = list.reduce((s, t) => s + t.pnl, 0);
    console.log(`  ${label.padEnd(36)} n=${String(list.length).padStart(4)}  wins=${wins}/${list.length} (${(wins/list.length*100).toFixed(1)}%)  pnl=$${fmt(pnl).padStart(9)}`);
  }

  console.log('═══════════════════ CONFIG ═══════════════════');
  console.log(`  Period       : ${args.days} days`);
  console.log(`  Threshold    : RecentEnds34Rate(2h) ≥ ${args.threshold}`);
  console.log(`  Body3 floor  : $${args.body3Min}`);
  console.log(`  Base size    : $${args.base}`);
  console.log(`  Entry price  : $${args.entryPrice} flat`);
  console.log();

  console.log('═══════════════════ RESULTS ══════════════════');
  summary('TOTAL', trades);
  summary('  streak=3', trades.filter(t => t.streak === 3));
  summary('  streak=4', trades.filter(t => t.streak === 4));
  console.log();

  // By rate quartile
  console.log('  ── by RecentEnds34Rate quartile ──');
  const rateValues = trades.map(t => t.recentEnds34Rate).sort((a,b)=>a-b);
  const q = [0, 0.25, 0.5, 0.75, 1].map(p => rateValues[Math.min(rateValues.length-1, Math.floor(rateValues.length * p))]!);
  for (let i = 0; i < 4; i++) {
    const lo = q[i]!, hi = q[i+1]!;
    const sub = trades.filter(t => i === 3 ? t.recentEnds34Rate >= lo : t.recentEnds34Rate >= lo && t.recentEnds34Rate < hi);
    summary(`    Q${i+1} ${lo.toFixed(2)}-${hi.toFixed(2)}`, sub);
  }
  console.log();

  let curStreakLoss = 0, maxStreakLoss = 0;
  let runEquity = 0, peakEquity = 0, maxDD = 0;
  for (const t of trades) {
    if (t.won) curStreakLoss = 0;
    else { curStreakLoss++; maxStreakLoss = Math.max(maxStreakLoss, curStreakLoss); }
    runEquity += t.pnl;
    peakEquity = Math.max(peakEquity, runEquity);
    maxDD = Math.max(maxDD, peakEquity - runEquity);
  }
  console.log('  ── risk ──');
  console.log(`    max consec losses : ${maxStreakLoss}`);
  console.log(`    max drawdown      : $${maxDD.toFixed(2)}`);
  console.log(`    final equity      : $${runEquity.toFixed(2)}`);
  console.log(`    PnL/DD ratio      : ${maxDD > 0 ? (runEquity/maxDD).toFixed(2) : 'inf'}`);
  console.log();

  // Daily PnL
  const daily = new Map<string, number>();
  for (const t of trades) {
    const d = new Date(t.ts).toISOString().slice(0, 10);
    daily.set(d, (daily.get(d) ?? 0) + t.pnl);
  }
  console.log('  ── daily pnl ──');
  for (const d of Array.from(daily.keys()).sort()) {
    const v = daily.get(d)!;
    const bar = v >= 0 ? '+'.repeat(Math.min(40, Math.round(v))) : '-'.repeat(Math.min(40, Math.round(-v)));
    console.log(`    ${d}   $${fmt(v).padStart(8)}   ${bar}`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
