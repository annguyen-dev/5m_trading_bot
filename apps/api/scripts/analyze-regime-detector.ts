/**
 * Find adaptive regime detectors that predict streak 3-4 reversal.
 *
 * Hypothesis: market alternates between CHOP (lots of short streaks
 * reversing) and TREND (long streaks). Past bar-pattern reveals the
 * current regime. Best signal = highest WR spread between regime states.
 *
 * Indicators tested (all computed at each streak 3-4 entry candidate):
 *
 *   1. RecentEndsAt34Rate(2h) — % of streak ENDS in last 2h that were
 *      length 3 or 4 (vs 5+). High = chop, low = trend.
 *
 *   2. AvgRecentStreakLen(N) — average length of last N completed
 *      streaks. Low (<3) = chop, high (>4) = trend.
 *
 *   3. ShortStreakDensity(2h) — count of streak 3-4 events in last 2h
 *      / total streak events in window.
 *
 *   4. ReversalRateAtSimilarSetup(20)  — for the last 20 fresh
 *      streak-3-or-4 entries, what was their actual reversal rate?
 *      Pure adaptive: "if recent fades worked, fade now".
 *
 *   5. DirectionChangePer Hour — # direction changes in last hour
 *      divided by bars. High = chop.
 *
 *   6. RangeContraction — (range_now / range_baseline). Low = contraction
 *      = mean reversion likely.
 *
 * Bucket each entry by indicator quintile, report P(reversal) per
 * bucket. Best indicator = biggest Q5-Q1 spread.
 *
 * Usage:
 *   pnpm --filter @trading-bot/api exec tsx scripts/analyze-regime-detector.ts \
 *     [--days=365] [--entry-streaks=3,4]
 */
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config({
  path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.env'),
  override: true,
});

interface Args { days: number; entryStreaks: number[] }
function parseArgs(): Args {
  let days = 365, entryStreaks = [3, 4];
  for (const a of process.argv.slice(2)) {
    if (a.startsWith('--days=')) days = Number(a.slice(7));
    else if (a.startsWith('--entry-streaks=')) entryStreaks = a.slice(16).split(',').map(Number);
  }
  return { days, entryStreaks };
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

function pct(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
}

interface Sample {
  ts: number;
  reversed: boolean;
  // indicators
  recentEnds34Rate: number;
  avgRecentStreakLen: number;
  shortStreakDensity: number;
  recentSimilarReversalRate: number;
  recentSimilarN: number;
  directionChangesHourly: number;
  rangeContraction: number;
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

  // Identify all completed streaks (end at bar i if streakLen[i+1] < streakLen[i] or =1 new streak)
  interface StreakEnd { idx: number; ts: number; len: number; dir: 1|-1; }
  const streakEnds: StreakEnd[] = [];
  for (let i = 0; i < bars.length - 1; i++) {
    if (streakLen[i]! >= 1 && bars[i+1]!.dir !== bars[i]!.dir) {
      streakEnds.push({ idx: i, ts: bars[i]!.ts, len: streakLen[i]!, dir: bars[i]!.dir as 1|-1 });
    }
  }

  // Track historical streak-3,4 fade outcomes for "adaptive recent" indicator
  interface PastEntry { ts: number; reversed: boolean }
  const pastFadeEntries: PastEntry[] = [];

  // Build samples
  const samples: Sample[] = [];
  const LOOKBACK_MS = 2 * 60 * 60_000;          // 2h
  const HOUR_MS = 60 * 60_000;
  for (let i = 24; i + 1 < bars.length; i++) {
    if (!args.entryStreaks.includes(streakLen[i]!)) continue;
    if (i > 0 && streakLen[i-1] === streakLen[i]) continue;  // first hit only
    const regime = bars[i]!.dir;
    if (regime === 0) continue;
    const next = bars[i+1]!;
    if (next.dir === 0) continue;
    const reversed = next.dir !== regime;
    const nowTs = bars[i]!.ts;

    // (1) RecentEnds34Rate(2h) — only ends knowable at decision time (after
    // bar i closed, before bar i+1). Ends at j ≤ i-1 are observable; end at
    // j=i requires bars[i+1] (the prediction target) → would leak outcome.
    const endsIn2h = streakEnds.filter(e =>
      e.idx <= i - 1 && e.ts > nowTs - LOOKBACK_MS
    );
    const ends34 = endsIn2h.filter(e => e.len === 3 || e.len === 4).length;
    const recentEnds34Rate = endsIn2h.length > 0 ? ends34 / endsIn2h.length : 0;

    // (2) AvgRecentStreakLen — last 10 completed streaks
    const last10 = streakEnds.filter(e => e.idx < i).slice(-10);
    const avgRecentLen = last10.length > 0
      ? last10.reduce((s, e) => s + e.len, 0) / last10.length
      : 0;

    // (3) ShortStreakDensity — streak-3,4 fresh hits in last 2h / total bars in window
    let s34Count = 0;
    for (let k = i - 24; k < i; k++) {     // 24 bars = 2h
      if (k < 1) continue;
      if ((streakLen[k] === 3 || streakLen[k] === 4) && streakLen[k-1] !== streakLen[k]) {
        s34Count++;
      }
    }
    const shortStreakDensity = s34Count / 24;

    // (4) Recent similar reversal rate (adaptive — last 20 fades)
    const recentSimilar = pastFadeEntries.slice(-20);
    const recentSimilarRev = recentSimilar.length > 0
      ? recentSimilar.filter(p => p.reversed).length / recentSimilar.length
      : 0;

    // (5) Direction changes per hour
    let dirChanges = 0;
    for (let k = i - 12; k < i; k++) {       // last 12 bars = 1h
      if (k < 1) continue;
      if (bars[k]!.dir !== 0 && bars[k-1]!.dir !== 0 && bars[k]!.dir !== bars[k-1]!.dir) {
        dirChanges++;
      }
    }

    // (6) Range contraction (last 12 bars range / prior 12 bars range)
    let hi1 = -Infinity, lo1 = Infinity, hi2 = -Infinity, lo2 = Infinity;
    for (let k = i - 12; k < i; k++) {
      if (k < 0) continue;
      hi1 = Math.max(hi1, bars[k]!.close);
      lo1 = Math.min(lo1, bars[k]!.close);
    }
    for (let k = i - 24; k < i - 12; k++) {
      if (k < 0) continue;
      hi2 = Math.max(hi2, bars[k]!.close);
      lo2 = Math.min(lo2, bars[k]!.close);
    }
    const range1 = hi1 - lo1;
    const range2 = hi2 - lo2;
    const rangeContraction = range2 > 0 ? range1 / range2 : 1;

    samples.push({
      ts: nowTs, reversed,
      recentEnds34Rate, avgRecentStreakLen: avgRecentLen,
      shortStreakDensity, recentSimilarReversalRate: recentSimilarRev,
      recentSimilarN: recentSimilar.length,
      directionChangesHourly: dirChanges, rangeContraction,
    });
    pastFadeEntries.push({ ts: nowTs, reversed });
  }

  const baseline = samples.filter(s => s.reversed).length / samples.length;
  console.log(`Total samples: ${samples.length}`);
  console.log(`Baseline P(reversal): ${(baseline*100).toFixed(2)}%\n`);

  function bucket(name: string, getKey: (s: Sample) => number, descLow: string, descHigh: string): void {
    const values = samples.map(getKey);
    const bounds = [0, 0.2, 0.4, 0.6, 0.8, 1].map(p => pct(values, p));
    console.log(`── ${name} (${descLow} → ${descHigh}) ──`);
    console.log('| Quintile      |     range         |    n  | P(rev)   | edge   |');
    console.log('|---------------|-------------------|-------|----------|--------|');
    for (let q = 0; q < 5; q++) {
      const lo = bounds[q]!, hi = bounds[q+1]!;
      const sub = samples.filter(s => {
        const v = getKey(s);
        return q === 4 ? v >= lo : v >= lo && v < hi;
      });
      if (sub.length === 0) continue;
      const p = sub.filter(s => s.reversed).length / sub.length;
      const edge = (p - baseline) * 100;
      console.log(
        `| Q${q+1} ${q===0?'(lowest)':q===4?'(highest)':'       '}  | ${lo.toFixed(2).padStart(8)}-${hi.toFixed(2).padStart(8)} | ${String(sub.length).padStart(5)} | ${(p*100).toFixed(2).padStart(6)}%  | ${edge>=0?'+':''}${edge.toFixed(1).padStart(5)}% |`
      );
    }
    console.log();
  }

  bucket('RecentEnds34Rate(2h)', s => s.recentEnds34Rate, 'few short ends (trend)', 'many short ends (chop)');
  bucket('AvgRecentStreakLen(10)', s => s.avgRecentStreakLen, 'short (chop)', 'long (trend)');
  bucket('ShortStreakDensity(2h)', s => s.shortStreakDensity, 'low', 'high');
  bucket('RecentSimilarReversalRate(20)', s => s.recentSimilarReversalRate, 'recent fades failed', 'recent fades worked');
  bucket('DirectionChangesHourly(12)', s => s.directionChangesHourly, 'few flips', 'many flips');
  bucket('RangeContraction(now/prior)', s => s.rangeContraction, 'expanding', 'contracting → expanding?');

  // Spread ranking
  console.log('═══ SPREAD RANKING (Q5 - Q1) ═══');
  const indicators = [
    { name: 'recentEnds34Rate',        fn: (s: Sample) => s.recentEnds34Rate },
    { name: 'avgRecentStreakLen',      fn: (s: Sample) => s.avgRecentStreakLen },
    { name: 'shortStreakDensity',      fn: (s: Sample) => s.shortStreakDensity },
    { name: 'recentSimilarRev',        fn: (s: Sample) => s.recentSimilarReversalRate },
    { name: 'directionChangesHourly',  fn: (s: Sample) => s.directionChangesHourly },
    { name: 'rangeContraction',        fn: (s: Sample) => s.rangeContraction },
  ];
  const ranking = indicators.map(ind => {
    const values = samples.map(ind.fn);
    const bounds = [0, 0.2, 0.4, 0.6, 0.8, 1].map(p => pct(values, p));
    const q1 = samples.filter(s => ind.fn(s) <= bounds[1]!);
    const q5 = samples.filter(s => ind.fn(s) >= bounds[4]!);
    const p1 = q1.length > 0 ? q1.filter(s => s.reversed).length / q1.length : 0;
    const p5 = q5.length > 0 ? q5.filter(s => s.reversed).length / q5.length : 0;
    return { name: ind.name, p1, p5, spread: p5 - p1 };
  }).sort((a, b) => Math.abs(b.spread) - Math.abs(a.spread));
  for (const r of ranking) {
    console.log(`  ${r.name.padEnd(28)} Q1=${(r.p1*100).toFixed(1)}%  Q5=${(r.p5*100).toFixed(1)}%  spread=${(r.spread*100).toFixed(1)}pp`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
