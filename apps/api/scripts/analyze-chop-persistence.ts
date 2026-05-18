/**
 * Test user hypothesis: chop regime PERSISTS longer after big moves,
 * especially during BTC sideways periods. Refine the chop detector:
 *
 *   1. Lookback sensitivity: 2h vs 4h vs 6h vs 12h
 *      → if user is right, longer lookback should boost edge (more
 *      stable signal of sustained chop).
 *
 *   2. Post-spike combo: was there a big move (range expansion) in the
 *      last 4-12h? If yes + chop indicator high → stronger predictor.
 *
 *   3. Daily-level chop classification: classify each day as "chop day"
 *      vs "trend day" based on max streak / day. Check if fade WR
 *      differs significantly.
 *
 *   4. Regime duration histogram: once a chop regime starts, how long
 *      does it typically last?
 *
 * Usage:
 *   pnpm --filter @trading-bot/api exec tsx scripts/analyze-chop-persistence.ts \
 *     [--days=365]
 */
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config({
  path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.env'),
  override: true,
});

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

async function main(): Promise<void> {
  const days = Number(process.argv.find(a => a.startsWith('--days='))?.slice(7) ?? 365);
  console.error(`Fetching ${days}d…`);
  const bars = await fetchKlines(days);
  console.error(`Got ${bars.length} bars\n`);

  // Streak length
  const streakLen = new Array<number>(bars.length).fill(0);
  for (let i = 0; i < bars.length; i++) {
    streakLen[i] = bars[i]!.dir === 0 ? 0
      : (i > 0 && bars[i-1]!.dir === bars[i]!.dir ? streakLen[i-1]! + 1 : 1);
  }

  // Streak ends
  const ends: Array<{ idx: number; ts: number; len: number }> = [];
  for (let i = 0; i < bars.length - 1; i++) {
    if (streakLen[i]! >= 1 && bars[i+1]!.dir !== bars[i]!.dir) {
      ends.push({ idx: i, ts: bars[i]!.ts, len: streakLen[i]! });
    }
  }

  function rateAt(nowTs: number, lookbackHours: number): { rate: number; n: number } {
    const cutoff = nowTs - lookbackHours * 60 * 60_000;
    const recent = ends.filter(e => e.ts > cutoff && e.ts <= nowTs);
    if (recent.length === 0) return { rate: 0, n: 0 };
    const ends34 = recent.filter(e => e.len === 3 || e.len === 4).length;
    return { rate: ends34 / recent.length, n: recent.length };
  }

  function priceRange(idx: number, hours: number): number {
    const cutoff = bars[idx]!.ts - hours * 60 * 60_000;
    let hi = -Infinity, lo = Infinity;
    for (let j = idx; j >= 0; j--) {
      if (bars[j]!.ts < cutoff) break;
      hi = Math.max(hi, bars[j]!.close);
      lo = Math.min(lo, bars[j]!.close);
    }
    return hi - lo;
  }

  // Build samples (streak 3-4 fresh hits)
  interface Sample {
    idx: number;
    reversed: boolean;
    rate2h: number;
    rate4h: number;
    rate6h: number;
    rate12h: number;
    /** Price range last 4h / range last 12h. Low = recent contraction. */
    rangeContractionRatio: number;
    /** Was there a big move (range expansion) in last 4-12h before now-2h? */
    priorRange4to12h: number;
    avgBody6h: number;
  }
  const samples: Sample[] = [];
  for (let i = 144; i + 1 < bars.length; i++) {  // 144 bars = 12h history needed
    if (streakLen[i] !== 3 && streakLen[i] !== 4) continue;
    if (streakLen[i-1] === streakLen[i]) continue;
    const regime = bars[i]!.dir;
    if (regime === 0) continue;
    const next = bars[i+1]!;
    if (next.dir === 0) continue;
    const reversed = next.dir !== regime;
    const nowTs = bars[i]!.ts;

    const rate2h = rateAt(nowTs, 2).rate;
    const rate4h = rateAt(nowTs, 4).rate;
    const rate6h = rateAt(nowTs, 6).rate;
    const rate12h = rateAt(nowTs, 12).rate;

    const range4h = priceRange(i, 4);
    const range12h = priceRange(i, 12);
    const rangeContractionRatio = range12h > 0 ? range4h / range12h : 1;

    // Prior big move: range in [now-12h, now-2h]
    let hi = -Infinity, lo = Infinity;
    for (let j = i - 144; j < i - 24; j++) {
      hi = Math.max(hi, bars[j]!.close);
      lo = Math.min(lo, bars[j]!.close);
    }
    const priorRange4to12h = hi - lo;

    // Avg |body| in last 6h
    let absBodySum = 0;
    for (let j = i - 72; j < i; j++) absBodySum += Math.abs(bars[j]!.body);
    const avgBody6h = absBodySum / 72;

    samples.push({
      idx: i, reversed,
      rate2h, rate4h, rate6h, rate12h,
      rangeContractionRatio, priorRange4to12h, avgBody6h,
    });
  }

  const baseline = samples.filter(s => s.reversed).length / samples.length;
  console.log(`Total samples: ${samples.length}`);
  console.log(`Baseline P(reversal): ${(baseline*100).toFixed(2)}%\n`);

  function showQuintiles(name: string, getKey: (s: Sample) => number, descLow: string, descHigh: string): void {
    const values = samples.map(getKey);
    const bounds = [0, 0.2, 0.4, 0.6, 0.8, 1].map(p => pct(values, p));
    console.log(`── ${name} (${descLow} → ${descHigh}) ──`);
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
        `  Q${q+1} ${q===0?'(low)':q===4?'(high)':'    '} ${lo.toFixed(2)}-${hi.toFixed(2)}: n=${String(sub.length).padStart(4)}  P(rev)=${(p*100).toFixed(1).padStart(5)}%  edge=${edge>=0?'+':''}${edge.toFixed(1)}%`
      );
    }
    console.log();
  }

  // (1) Lookback sensitivity
  console.log('═══ 1. LOOKBACK SENSITIVITY (chop indicator) ═══');
  showQuintiles('rate2h',  s => s.rate2h,  'trend', 'chop');
  showQuintiles('rate4h',  s => s.rate4h,  'trend', 'chop');
  showQuintiles('rate6h',  s => s.rate6h,  'trend', 'chop');
  showQuintiles('rate12h', s => s.rate12h, 'trend', 'chop');

  // (2) Range contraction ratio
  console.log('═══ 2. RANGE CONTRACTION (4h range / 12h range) ═══');
  showQuintiles('rangeContractionRatio', s => s.rangeContractionRatio, 'contracted', 'expanded');

  // (3) Combo: chop + prior big move
  console.log('═══ 3. COMBO: rate4h ≥ 0.33 × prior range last 12h ═══');
  const priorRangeBounds = [0, 0.25, 0.5, 0.75, 1].map(p => pct(samples.map(s => s.priorRange4to12h), p));
  console.log(`(priorRange4to12h quartiles: ${priorRangeBounds.map(b => b.toFixed(0)).join(' → ')})`);
  for (let q = 0; q < 4; q++) {
    const lo = priorRangeBounds[q]!, hi = priorRangeBounds[q+1]!;
    const sub = samples.filter(s =>
      s.rate4h >= 0.33 &&
      (q === 3 ? s.priorRange4to12h >= lo : s.priorRange4to12h >= lo && s.priorRange4to12h < hi)
    );
    if (sub.length === 0) continue;
    const p = sub.filter(s => s.reversed).length / sub.length;
    const edge = (p - baseline) * 100;
    console.log(`  Prior 12h range Q${q+1} (${lo.toFixed(0)}-${hi.toFixed(0)}): n=${String(sub.length).padStart(4)}  P(rev)=${(p*100).toFixed(1)}%  edge=${edge>=0?'+':''}${edge.toFixed(1)}%`);
  }
  console.log();

  // (4) Daily-level chop classification
  console.log('═══ 4. DAILY CHOP CLASSIFICATION ═══');
  console.log('(For each day, compute MAX streak length. Days with maxStreak ≤ 5 = "chop day", maxStreak ≥ 7 = "trend day")');
  const byDay = new Map<string, { maxStreak: number; samples: Sample[] }>();
  for (const s of samples) {
    const d = new Date(bars[s.idx]!.ts).toISOString().slice(0,10);
    if (!byDay.has(d)) byDay.set(d, { maxStreak: 0, samples: [] });
    byDay.get(d)!.samples.push(s);
  }
  // Compute maxStreak per day
  for (let i = 0; i < bars.length; i++) {
    const d = new Date(bars[i]!.ts).toISOString().slice(0,10);
    if (byDay.has(d)) {
      byDay.get(d)!.maxStreak = Math.max(byDay.get(d)!.maxStreak, streakLen[i]!);
    }
  }
  let chopDayBuckets = new Map<string, Sample[]>([
    ['≤5 (chop)', []], ['6 (mixed)', []], ['7+ (trend)', []],
  ]);
  for (const { maxStreak, samples: ss } of byDay.values()) {
    const key = maxStreak <= 5 ? '≤5 (chop)' : maxStreak === 6 ? '6 (mixed)' : '7+ (trend)';
    chopDayBuckets.get(key)!.push(...ss);
  }
  for (const [k, ss] of chopDayBuckets) {
    if (ss.length === 0) continue;
    const p = ss.filter(s => s.reversed).length / ss.length;
    const edge = (p - baseline) * 100;
    console.log(`  Day class "${k}":  n=${String(ss.length).padStart(4)}  P(rev)=${(p*100).toFixed(1)}%  edge=${edge>=0?'+':''}${edge.toFixed(1)}%`);
  }
  console.log();

  // (5) Regime duration: once rate2h ≥ 0.33, how many consecutive bars stay ≥ 0.33?
  console.log('═══ 5. CHOP REGIME DURATION ═══');
  const chopRuns: number[] = [];
  let curRun = 0;
  for (let i = 24; i < bars.length; i++) {
    const r = rateAt(bars[i]!.ts, 2).rate;
    if (r >= 0.33) curRun++;
    else { if (curRun > 0) chopRuns.push(curRun); curRun = 0; }
  }
  if (curRun > 0) chopRuns.push(curRun);
  console.log(`  Total chop regimes (rate2h ≥ 0.33 streaks of bars): ${chopRuns.length}`);
  console.log(`  Avg duration (bars / minutes):  ${(chopRuns.reduce((a,b)=>a+b,0)/chopRuns.length).toFixed(1)} bars / ${(chopRuns.reduce((a,b)=>a+b,0)/chopRuns.length*5).toFixed(0)}m`);
  console.log(`  Median duration:                ${pct(chopRuns, 0.5).toFixed(0)} bars / ${(pct(chopRuns, 0.5)*5).toFixed(0)}m`);
  console.log(`  p75 duration:                   ${pct(chopRuns, 0.75).toFixed(0)} bars / ${(pct(chopRuns, 0.75)*5).toFixed(0)}m`);
  console.log(`  p90 duration:                   ${pct(chopRuns, 0.9).toFixed(0)} bars / ${(pct(chopRuns, 0.9)*5).toFixed(0)}m`);
  console.log(`  Max duration:                   ${Math.max(...chopRuns)} bars / ${Math.max(...chopRuns)*5}m`);
}

main().catch(err => { console.error(err); process.exit(1); });
