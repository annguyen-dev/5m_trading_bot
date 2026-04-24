/**
 * Temporal analysis — when should bot be aggressive (low threshold) vs
 * conservative (high threshold)?
 *
 * Questions:
 *   1. Time-of-day: which hours (UTC) concentrate large streaks (≥5)?
 *   2. Clustering: after a large streak, how long until the next? (gap dist)
 *   3. Burst duration: how long does a "hot" period last before going cold?
 *   4. Prior context: what does it look like BEFORE a large streak starts?
 *
 * Run: npx tsx analysis/temporal.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(HERE, 'data');

interface Kline {
  openTime: number; open: number; high: number; low: number;
  close: number; volume: number; closeTime: number;
}

const LARGE_STREAK = 5;  // from earlier analysis: edge starts here for BTC

function load(sym: string): Kline[] {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, `${sym}_5m_7d.json`), 'utf-8'));
}

function color(k: Kline): 'g' | 'r' | 'd' {
  return k.close > k.open ? 'g' : k.close < k.open ? 'r' : 'd';
}

/** For each candle index, the current streak that ENDS at it (signed). */
function computeStreakAtEach(k: Kline[]): number[] {
  const out: number[] = new Array(k.length).fill(0);
  let sign = 0;
  let run = 0;
  for (let i = 0; i < k.length; i++) {
    const c = color(k[i]!);
    if (c === 'd') { run = 0; sign = 0; out[i] = 0; continue; }
    const s = c === 'g' ? 1 : -1;
    if (s === sign) run++;
    else { sign = s; run = 1; }
    out[i] = run * sign;
  }
  return out;
}

function pctl(arr: number[], p: number): number {
  const s = [...arr].sort((a, b) => a - b);
  if (!s.length) return 0;
  return s[Math.max(0, Math.min(s.length - 1, Math.floor(p * s.length)))]!;
}

// ─── 1. Time of day ─────────────────────────────────────────────────────────

function analyzeTimeOfDay(sym: string, k: Kline[]): void {
  console.log(`\n━━━ ${sym} · TIME OF DAY (UTC) ━━━`);
  const streaks = computeStreakAtEach(k);

  // Per-hour buckets: count of large-streak events (first time streak reaches ≥LARGE)
  const hourlyLarge: Record<number, number> = {};
  const hourlyAny: Record<number, number> = {};
  const hourlyMax: Record<number, number> = {};
  for (let i = 0; i < 24; i++) { hourlyLarge[i] = 0; hourlyAny[i] = 0; hourlyMax[i] = 0; }

  // Identify unique large-streak events: a streak is "reached" exactly once
  // per run (when its abs reaches LARGE_STREAK for the first time).
  let inLargeRun = false;
  for (let i = 0; i < k.length; i++) {
    const h = new Date(k[i]!.openTime).getUTCHours();
    hourlyAny[h]!++;
    const abs = Math.abs(streaks[i]!);
    hourlyMax[h] = Math.max(hourlyMax[h]!, abs);
    if (abs >= LARGE_STREAK) {
      if (!inLargeRun) { hourlyLarge[h]!++; inLargeRun = true; }
    } else {
      inLargeRun = false;
    }
  }

  console.log(`Hour  total_candles  large_events  per_100_candles  max_streak_seen`);
  for (let h = 0; h < 24; h++) {
    const n = hourlyAny[h]!;
    const l = hourlyLarge[h]!;
    const rate = n ? (100 * l / n) : 0;
    const bar = '█'.repeat(Math.round(rate * 2));
    console.log(`  ${String(h).padStart(2, '0')}   ${String(n).padStart(6)}   ${String(l).padStart(6)}   ${rate.toFixed(2).padStart(6)}%   ${String(hourlyMax[h]).padStart(3)}    ${bar}`);
  }
}

// ─── 2. Inter-burst gap ─────────────────────────────────────────────────────

function analyzeBurstGaps(sym: string, k: Kline[]): void {
  console.log(`\n━━━ ${sym} · GAP BETWEEN LARGE-STREAK BURSTS ━━━`);
  const streaks = computeStreakAtEach(k);

  // Mark start of each large-streak run (first candle where abs hits LARGE_STREAK).
  const burstStarts: number[] = [];   // candle indices
  let inLargeRun = false;
  for (let i = 0; i < k.length; i++) {
    const abs = Math.abs(streaks[i]!);
    if (abs >= LARGE_STREAK) {
      if (!inLargeRun) { burstStarts.push(i); inLargeRun = true; }
    } else inLargeRun = false;
  }

  console.log(`  total large bursts in 7d: ${burstStarts.length}`);
  if (burstStarts.length < 2) return;

  // Gaps in candles (5m each).
  const gaps: number[] = [];
  for (let i = 1; i < burstStarts.length; i++) {
    gaps.push(burstStarts[i]! - burstStarts[i - 1]!);
  }

  const gapMin = gaps.map(g => g * 5);
  const p10 = pctl(gapMin, 0.10);
  const p25 = pctl(gapMin, 0.25);
  const p50 = pctl(gapMin, 0.50);
  const p75 = pctl(gapMin, 0.75);
  const p90 = pctl(gapMin, 0.90);
  const mean = gapMin.reduce((a, b) => a + b, 0) / gapMin.length;

  console.log(`  gap minutes: p10=${p10}  p25=${p25}  p50=${p50}  p75=${p75}  p90=${p90}  mean=${mean.toFixed(0)}`);

  // Bucket gaps for actionable thresholds
  const buckets = { '<15m': 0, '15-60m': 0, '60-120m': 0, '2-4h': 0, '>4h': 0 };
  for (const g of gapMin) {
    if      (g < 15)  buckets['<15m']++;
    else if (g < 60)  buckets['15-60m']++;
    else if (g < 120) buckets['60-120m']++;
    else if (g < 240) buckets['2-4h']++;
    else              buckets['>4h']++;
  }
  const tot = gapMin.length;
  console.log(`  bucket distribution:`);
  for (const [k, v] of Object.entries(buckets)) {
    console.log(`    ${k.padEnd(10)} ${String(v).padStart(3)}  (${(100 * v / tot).toFixed(1)}%)`);
  }

  // Show the largest 10 gaps — these are "cold periods"
  const indexed = gapMin.map((g, i) => ({ gap: g, atBurst: burstStarts[i + 1]!, priorBurst: burstStarts[i]! }))
    .sort((a, b) => b.gap - a.gap).slice(0, 10);
  console.log(`\n  Top 10 cold periods (gap between bursts):`);
  for (const x of indexed) {
    const start = new Date(k[x.priorBurst]!.openTime).toISOString().slice(5, 16).replace('T', ' ');
    const end   = new Date(k[x.atBurst]!.openTime).toISOString().slice(5, 16).replace('T', ' ');
    console.log(`    ${start}  →  ${end}   ${x.gap} min  (${(x.gap / 60).toFixed(1)}h)`);
  }
}

// ─── 3. Burst duration ──────────────────────────────────────────────────────

function analyzeBurstDuration(sym: string, k: Kline[]): void {
  console.log(`\n━━━ ${sym} · DURATION OF "HOT" PERIODS ━━━`);
  const streaks = computeStreakAtEach(k);

  // Define "hot period" = sliding 60-min windows where a large streak is active.
  // Practical: merge bursts that are within 30 min (6 candles) of each other.
  const MERGE_GAP = 6;   // candles
  const burstStarts: number[] = [];
  let inLargeRun = false;
  for (let i = 0; i < k.length; i++) {
    const abs = Math.abs(streaks[i]!);
    if (abs >= LARGE_STREAK) {
      if (!inLargeRun) { burstStarts.push(i); inLargeRun = true; }
    } else inLargeRun = false;
  }

  if (!burstStarts.length) return;

  // Merge nearby bursts into "hot periods".
  const periods: { start: number; end: number; burstCount: number }[] = [];
  let cur = { start: burstStarts[0]!, end: burstStarts[0]!, burstCount: 1 };
  for (let i = 1; i < burstStarts.length; i++) {
    if (burstStarts[i]! - cur.end <= MERGE_GAP) {
      cur.end = burstStarts[i]!;
      cur.burstCount++;
    } else {
      periods.push(cur);
      cur = { start: burstStarts[i]!, end: burstStarts[i]!, burstCount: 1 };
    }
  }
  periods.push(cur);

  console.log(`  total hot periods (merged): ${periods.length}  (merge threshold: ${MERGE_GAP * 5} min gap)`);
  const durations = periods.map(p => (p.end - p.start + 1) * 5);  // minutes
  const bursts = periods.map(p => p.burstCount);
  console.log(`  duration min: p25=${pctl(durations, 0.25)}  p50=${pctl(durations, 0.50)}  p75=${pctl(durations, 0.75)}  max=${Math.max(...durations)}`);
  console.log(`  bursts per period: p25=${pctl(bursts, 0.25)}  p50=${pctl(bursts, 0.50)}  p75=${pctl(bursts, 0.75)}  max=${Math.max(...bursts)}`);

  const bucket = { 'single (1 burst)': 0, 'short (≤30m)': 0, 'medium (30-90m)': 0, 'long (>90m)': 0 };
  for (const p of periods) {
    const dur = (p.end - p.start + 1) * 5;
    if (p.burstCount === 1) bucket['single (1 burst)']++;
    else if (dur <= 30) bucket['short (≤30m)']++;
    else if (dur <= 90) bucket['medium (30-90m)']++;
    else bucket['long (>90m)']++;
  }
  console.log(`  bucket:`);
  for (const [k, v] of Object.entries(bucket)) {
    console.log(`    ${k.padEnd(20)} ${v}  (${(100 * v / periods.length).toFixed(0)}%)`);
  }

  // Top 10 longest hot periods
  const longest = [...periods].sort((a, b) =>
    ((b.end - b.start) || 0) - ((a.end - a.start) || 0)
  ).slice(0, 10);
  console.log(`\n  Top 10 longest hot periods:`);
  for (const p of longest) {
    const start = new Date(k[p.start]!.openTime).toISOString().slice(5, 16).replace('T', ' ');
    const end   = new Date(k[p.end]!.openTime).toISOString().slice(5, 16).replace('T', ' ');
    const dur = (p.end - p.start + 1) * 5;
    console.log(`    ${start}  →  ${end}   ${dur} min   ${p.burstCount} bursts`);
  }
}

// ─── 4. Rolling "is-hot" diagnostic ─────────────────────────────────────────

function analyzeRollingHot(sym: string, k: Kline[]): void {
  console.log(`\n━━━ ${sym} · ROLLING "HOT" INDICATOR ━━━`);
  const streaks = computeStreakAtEach(k);

  // Rolling window: in the last N candles, count of candles with abs ≥ LARGE.
  // A simple "hot score". Use 24 candles (2 hours).
  const W = 24;
  const isLarge = streaks.map(s => Math.abs(s) >= LARGE_STREAK ? 1 : 0);
  const rolling: number[] = [];
  let running = 0;
  for (let i = 0; i < k.length; i++) {
    running += isLarge[i]!;
    if (i >= W) running -= isLarge[i - W]!;
    rolling.push(i >= W - 1 ? running : 0);
  }

  // Distribution of hot-score
  const p25 = pctl(rolling.slice(W), 0.25);
  const p50 = pctl(rolling.slice(W), 0.50);
  const p75 = pctl(rolling.slice(W), 0.75);
  const p90 = pctl(rolling.slice(W), 0.90);
  const p95 = pctl(rolling.slice(W), 0.95);
  console.log(`  rolling-${W} (2h) "large-candle" count:  p25=${p25}  p50=${p50}  p75=${p75}  p90=${p90}  p95=${p95}`);

  // How often do we see elevated activity?
  const elevated = rolling.filter(x => x >= 3).length;
  const veryElevated = rolling.filter(x => x >= 6).length;
  const total = rolling.length - W;
  console.log(`  fraction of time ≥3 large candles in last 2h: ${(100 * elevated / total).toFixed(1)}%`);
  console.log(`  fraction of time ≥6 large candles in last 2h: ${(100 * veryElevated / total).toFixed(1)}%`);

  // Key question: when we're "hot" (rolling ≥3), is NEXT large candle near?
  // If yes → during hot periods, large streaks cluster. Adaptive should
  // LOWER threshold during hot periods (opportunities are frequent).
  let hotFollowed = 0, hotTotal = 0;
  let coldFollowed = 0, coldTotal = 0;
  const LOOKAHEAD = 12;  // 1 hour
  for (let i = W; i < k.length - LOOKAHEAD; i++) {
    const nextLarge = isLarge.slice(i + 1, i + 1 + LOOKAHEAD).some(x => x);
    if (rolling[i]! >= 3) {
      hotTotal++; if (nextLarge) hotFollowed++;
    } else if (rolling[i]! <= 1) {
      coldTotal++; if (nextLarge) coldFollowed++;
    }
  }
  console.log(`\n  Predictive power (hot vs cold):`);
  console.log(`    when rolling ≥3: P(large streak in next 60 min) = ${(100*hotFollowed/hotTotal).toFixed(1)}% (n=${hotTotal})`);
  console.log(`    when rolling ≤1: P(large streak in next 60 min) = ${(100*coldFollowed/coldTotal).toFixed(1)}% (n=${coldTotal})`);
}

// ─── 5. Hour-of-day heat map (large-candle % by hour+day) ──────────────────

function analyzeHourDayHeat(sym: string, k: Kline[]): void {
  console.log(`\n━━━ ${sym} · HOUR × DAY HEAT MAP (large candle %) ━━━`);
  const streaks = computeStreakAtEach(k);
  const isLarge = streaks.map(s => Math.abs(s) >= LARGE_STREAK);

  const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const total: Record<string, Record<number, number>> = {};
  const hits: Record<string, Record<number, number>> = {};
  for (const d of DAYS) { total[d] = {}; hits[d] = {}; for (let h = 0; h < 24; h++) { total[d]![h] = 0; hits[d]![h] = 0; } }

  for (let i = 0; i < k.length; i++) {
    const dt = new Date(k[i]!.openTime);
    const d = DAYS[dt.getUTCDay()]!;
    const h = dt.getUTCHours();
    total[d]![h]!++;
    if (isLarge[i]!) hits[d]![h]!++;
  }

  console.log(`     ` + Array.from({length:24}, (_, h) => String(h).padStart(4,' ')).join(''));
  for (const d of DAYS) {
    const row = Array.from({length: 24}, (_, h) => {
      const t = total[d]![h]!;
      const hi = hits[d]![h]!;
      if (t === 0) return '   -';
      const pct = 100 * hi / t;
      return `${pct.toFixed(1).padStart(4)}`;
    }).join('');
    console.log(`  ${d}  ${row}`);
  }
  console.log(`  (each cell = % of candles in that hour-of-day showing large streak)`);
}

async function main() {
  for (const sym of ['BTCUSDT', 'SOLUSDT']) {
    const k = load(sym);
    console.log(`\n\n════════ ${sym} (${k.length} candles × 5m / ~7d) ════════`);
    analyzeTimeOfDay(sym, k);
    analyzeBurstGaps(sym, k);
    analyzeBurstDuration(sym, k);
    analyzeRollingHot(sym, k);
    analyzeHourDayHeat(sym, k);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
