/**
 * Find which volatility indicator(s) best predict short-streak (3-4)
 * mean reversion. Goal: discriminate "we're in high-vol cluster, fade
 * will work" vs "trend regime, fade will fail".
 *
 * Indicators tested per entry candidate (bar where streak=3 or 4 freshly):
 *   1. ATR(N)            — rolling mean |body| over last N bars
 *   2. StdDev(N)         — rolling stddev of |body|
 *   3. Range(N)          — high(N) - low(N) of close prices
 *   4. RecentExtEnds(L)  — # streak ≥5 endings in last L minutes
 *   5. TimeSinceExt      — minutes since last streak ≥5 ended
 *   6. AvgStreakLen(N)   — average streak length of last N completed streaks
 *
 * For each indicator, bucket samples into quintiles (Q1 lowest .. Q5 highest)
 * and report P(reversal at next bar) per bucket. Best indicator = bucket
 * variation high (Q5 vs Q1 spread big).
 *
 * Usage:
 *   pnpm --filter @trading-bot/api exec tsx scripts/analyze-volregime-indicators.ts \
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
    if (a.startsWith('--days='))          days = Number(a.slice(7));
    else if (a.startsWith('--entry-streaks=')) entryStreaks = a.slice(16).split(',').map(Number);
  }
  return { days, entryStreaks };
}

interface Bar { ts: number; open: number; close: number; high: number; low: number; body: number; dir: 1|-1|0 }

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
      const ts = Number(r[0]), open = Number(r[1]), high = Number(r[2]), low = Number(r[3]), close = Number(r[4]);
      const body = close - open;
      all.push({ ts, open, close, high, low, body, dir: body > 0 ? 1 : body < 0 ? -1 : 0 });
    }
    const lastTs = Number(rows[rows.length-1]?.[0] ?? 0);
    if (lastTs <= cursor) break;
    cursor = lastTs + 1; pages++;
    if (pages % 10 === 0) process.stderr.write(`  fetched ${all.length} bars…\n`);
    await new Promise(r => setTimeout(r, 80));
  }
  return all;
}

interface Sample {
  ts: number;
  streak: number;
  body3: number;
  // indicators
  atr20:           number;
  atrRatio:        number;   // |last bar| / atr20
  stdDev20:        number;
  range20:         number;
  recentExtEnds60: number;   // count streak ≥5 ends in last 60m
  timeSinceExt:    number;   // minutes since last ext end (Infinity if none)
  avgStreakLen10:  number;   // avg over last 10 completed streaks
  reversed:        boolean;
}

function quintileBuckets(values: number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  return [0, 0.2, 0.4, 0.6, 0.8, 1].map(p => sorted[Math.min(n-1, Math.floor(n * p))]!);
}

async function main(): Promise<void> {
  const args = parseArgs();
  console.error(`Fetching ${args.days}d of BTC 5m bars…`);
  const bars = await fetchKlines(args.days);
  console.error(`Got ${bars.length} bars\n`);

  // Streak length ending at each bar
  const streakLen = new Array<number>(bars.length).fill(0);
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    if (b.dir === 0) { streakLen[i] = 0; continue; }
    streakLen[i] = (i > 0 && bars[i-1]!.dir === b.dir) ? streakLen[i-1]! + 1 : 1;
  }

  // Identify completed streak boundaries (each streak end gives a streak-length record)
  const completedStreaks: Array<{ endIdx: number; len: number; endTs: number }> = [];
  for (let i = 0; i < bars.length - 1; i++) {
    if (streakLen[i]! >= 1 && (streakLen[i+1]! === 0 || streakLen[i+1]! < streakLen[i]!)) {
      completedStreaks.push({ endIdx: i, len: streakLen[i]!, endTs: bars[i]!.ts });
    }
  }
  const extStreakEnds = completedStreaks.filter(s => s.len >= 5);

  // Build samples
  const samples: Sample[] = [];
  const WIN = 20;
  for (let i = WIN; i + 1 < bars.length; i++) {
    if (!args.entryStreaks.includes(streakLen[i]!)) continue;
    if (i > 0 && streakLen[i-1] === streakLen[i]) continue; // not first hit
    const next = bars[i + 1]!;
    if (next.dir === 0) continue;
    const regime = bars[i]!.dir;
    if (regime === 0) continue;

    // ATR(20)
    let absBodySum = 0, absBodySq = 0;
    let hi = -Infinity, lo = Infinity;
    for (let k = i - WIN; k < i; k++) {
      const b = bars[k]!;
      const abs = Math.abs(b.body);
      absBodySum += abs;
      absBodySq  += abs * abs;
      hi = Math.max(hi, b.close);
      lo = Math.min(lo, b.close);
    }
    const atr20 = absBodySum / WIN;
    const variance = absBodySq / WIN - atr20 * atr20;
    const stdDev20 = Math.sqrt(Math.max(0, variance));
    const range20 = hi - lo;
    const atrRatio = atr20 > 0 ? Math.abs(bars[i-1]!.body) / atr20 : 0;

    // Recent extreme streak ends in last 60min
    const cutoff60 = bars[i]!.ts - 60 * 60_000;
    const recent60 = extStreakEnds.filter(e => e.endTs > cutoff60 && e.endTs < bars[i]!.ts).length;

    // Time since last extreme streak end
    const lastExt = extStreakEnds.filter(e => e.endTs < bars[i]!.ts).pop();
    const timeSince = lastExt ? (bars[i]!.ts - lastExt.endTs) / 60_000 : 9999;

    // Avg streak length of last 10 completed streaks
    const recentStreaks = completedStreaks.filter(s => s.endIdx < i).slice(-10);
    const avgLen = recentStreaks.length > 0
      ? recentStreaks.reduce((s, x) => s + x.len, 0) / recentStreaks.length
      : 0;

    const body3 = Math.abs(bars[i]!.body) + Math.abs(bars[i-1]!.body) + Math.abs(bars[i-2]!.body);

    samples.push({
      ts: bars[i]!.ts,
      streak: streakLen[i]!,
      body3,
      atr20, atrRatio, stdDev20, range20,
      recentExtEnds60: recent60,
      timeSinceExt: timeSince,
      avgStreakLen10: avgLen,
      reversed: next.dir !== regime,
    });
  }

  console.log(`Samples (entry candidate at streak ∈ ${JSON.stringify(args.entryStreaks)}, fresh hit): ${samples.length}`);
  const baseline = samples.filter(s => s.reversed).length / samples.length;
  console.log(`Baseline P(reversal): ${(baseline*100).toFixed(2)}%\n`);

  // Analyse each indicator: bucket by quintile, report P(rev) per bucket
  function analyse(name: string, getKey: (s: Sample) => number, descLow: string, descHigh: string): void {
    const values = samples.map(getKey);
    const bounds = quintileBuckets(values);
    console.log(`── ${name} (${descLow} → ${descHigh}) ──`);
    console.log('|  Quintile     |     range         |    n | P(rev)  | edge   |');
    console.log('|---------------|-------------------|------|---------|--------|');
    for (let q = 0; q < 5; q++) {
      const lo = bounds[q]!;
      const hi = bounds[q + 1]!;
      const sub = samples.filter(s => {
        const v = getKey(s);
        return q === 4 ? v >= lo : v >= lo && v < hi;
      });
      if (sub.length === 0) continue;
      const p = sub.filter(s => s.reversed).length / sub.length;
      const edge = (p - baseline) * 100;
      console.log(
        `| Q${q+1} ${q===0?'(lowest)':q===4?'(highest)':'       '} | ${lo.toFixed(1).padStart(8)}-${hi.toFixed(1).padStart(8)} | ${String(sub.length).padStart(4)} | ${(p*100).toFixed(2).padStart(6)}% |  ${edge>=0?'+':''}${edge.toFixed(1).padStart(5)}% |`
      );
    }
    console.log();
  }

  analyse('ATR(20) — avg |body| of last 20 bars', s => s.atr20, 'calm', 'volatile');
  analyse('ATR ratio — last bar / ATR(20)', s => s.atrRatio, 'last bar small', 'last bar big vs avg');
  analyse('StdDev(20) — variability of bodies', s => s.stdDev20, 'consistent', 'erratic');
  analyse('Range(20) — close max-min', s => s.range20, 'narrow', 'wide');
  analyse('Recent ext-streak ends in 60m', s => s.recentExtEnds60, 'few', 'many');
  analyse('Time since last ext-streak end (min)', s => s.timeSinceExt, 'recent', 'long ago');
  analyse('Avg streak length last 10 streaks', s => s.avgStreakLen10, 'short', 'long');
  analyse('body3 — last 3 bars |body| sum', s => s.body3, 'weak', 'strong climax');

  // Combo: best individual + body3 cross-tab
  console.log('═══ COMBO: best vol indicator × body3 ═══');
  console.log('Picking the indicator with biggest Q5-Q1 spread for cross-tab.\n');

  const indicators: Array<{ name: string; fn: (s: Sample) => number }> = [
    { name: 'atr20',           fn: s => s.atr20 },
    { name: 'atrRatio',        fn: s => s.atrRatio },
    { name: 'stdDev20',        fn: s => s.stdDev20 },
    { name: 'range20',         fn: s => s.range20 },
    { name: 'recentExtEnds60', fn: s => s.recentExtEnds60 },
    { name: 'timeSinceExt',    fn: s => -s.timeSinceExt }, // negate so "recent" = high
    { name: 'avgStreakLen10',  fn: s => s.avgStreakLen10 },
  ];
  for (const ind of indicators) {
    const values = samples.map(ind.fn);
    const bounds = quintileBuckets(values);
    const q1 = samples.filter(s => ind.fn(s) <= bounds[1]!);
    const q5 = samples.filter(s => ind.fn(s) >= bounds[4]!);
    const p1 = q1.length > 0 ? q1.filter(s => s.reversed).length / q1.length : 0;
    const p5 = q5.length > 0 ? q5.filter(s => s.reversed).length / q5.length : 0;
    console.log(`  ${ind.name.padEnd(18)} Q5 P(rev)=${(p5*100).toFixed(1)}%  Q1 P(rev)=${(p1*100).toFixed(1)}%  spread=${((p5-p1)*100).toFixed(1)}%`);
  }

  // Combo: Range(20) Q5 ∩ body3 Q5
  console.log('\n═══ COMBO TESTS ═══');
  const rangeValues = samples.map(s => s.range20);
  const rangeBounds = quintileBuckets(rangeValues);
  const body3Values = samples.map(s => s.body3);
  const body3Bounds = quintileBuckets(body3Values);
  const timeSinceValues = samples.map(s => s.timeSinceExt);
  const tsBounds = quintileBuckets(timeSinceValues);

  function combo(label: string, predicate: (s: Sample) => boolean): void {
    const sub = samples.filter(predicate);
    if (sub.length === 0) { console.log(`  ${label.padEnd(45)} (empty)`); return; }
    const p = sub.filter(s => s.reversed).length / sub.length;
    const edge = (p - baseline) * 100;
    console.log(`  ${label.padEnd(45)} n=${String(sub.length).padStart(4)}  P(rev)=${(p*100).toFixed(2).padStart(6)}%  edge=${edge>=0?'+':''}${edge.toFixed(1)}%`);
  }

  combo('Range Q5 (top 20%)',                       s => s.range20 >= rangeBounds[4]!);
  combo('body3 Q5',                                  s => s.body3 >= body3Bounds[4]!);
  combo('Range Q5 ∩ body3 Q5',                       s => s.range20 >= rangeBounds[4]! && s.body3 >= body3Bounds[4]!);
  combo('Range Q4+Q5 ∩ body3 Q5',                    s => s.range20 >= rangeBounds[3]! && s.body3 >= body3Bounds[4]!);
  combo('timeSinceExt Q1 (15-45m) ∩ body3 Q5',       s => s.timeSinceExt <= tsBounds[1]! && s.body3 >= body3Bounds[4]!);
  combo('timeSinceExt Q1-Q2 (15-90m) ∩ body3 Q4-Q5', s => s.timeSinceExt <= tsBounds[2]! && s.body3 >= body3Bounds[3]!);
  combo('Range Q5 ∩ body3 Q5 ∩ timeSinceExt Q1-Q2', s => s.range20 >= rangeBounds[4]! && s.body3 >= body3Bounds[4]! && s.timeSinceExt <= tsBounds[2]!);
}

main().catch(err => { console.error(err); process.exit(1); });
