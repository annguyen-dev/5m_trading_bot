/**
 * Analyzes Binance 5m + 1s data saved by fetch.ts.
 *
 * Questions we try to answer:
 *   1. Volatility regimes — when is BTC/SOL moving hard, and how long does it last?
 *   2. Streak stats — for each streak length L (e.g. 3 green candles), what %
 *      of the time does the next candle reverse (break the streak)?
 *   3. Intra-window path — in 1s resolution, when does the reversal occur?
 *      Early (within first minute) or late?
 *   4. Trap patterns — windows where price moved early in one direction then
 *      reversed past the open by end. These are losing scenarios for a naive
 *      TP/SL: TP might get hit then SL, or vice versa.
 *
 * Run: npx tsx analysis/analyze.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(HERE, 'data');
const OUT_DIR  = path.join(HERE, 'output');
fs.mkdirSync(OUT_DIR, { recursive: true });

interface Kline {
  openTime: number; open: number; high: number; low: number;
  close: number; volume: number; closeTime: number;
}

function load(symbol: string, interval: string, span: string): Kline[] {
  const p = path.join(DATA_DIR, `${symbol}_${interval}_${span}.json`);
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

// ─── helpers ────────────────────────────────────────────────────────────────

function color(k: Kline): 'green' | 'red' | 'doji' {
  if (k.close > k.open) return 'green';
  if (k.close < k.open) return 'red';
  return 'doji';
}

function absReturnPct(k: Kline): number {
  return Math.abs(k.close - k.open) / k.open * 100;
}

function pctl(arr: number[], p: number): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor(p * sorted.length)));
  return sorted[idx]!;
}

function fmtTime(ms: number): string {
  const d = new Date(ms);
  return `${d.toISOString().slice(5, 16).replace('T', ' ')}`;
}

// ─── 1. Volatility regime ───────────────────────────────────────────────────

function analyzeVolatilityRegimes(symbol: string, k5m: Kline[]): void {
  console.log(`\n━━━ ${symbol} · VOLATILITY REGIMES (5m × 7d) ━━━`);

  const returns = k5m.map(absReturnPct);
  const p25 = pctl(returns, 0.25);
  const p50 = pctl(returns, 0.50);
  const p75 = pctl(returns, 0.75);
  const p90 = pctl(returns, 0.90);
  const p95 = pctl(returns, 0.95);
  const p99 = pctl(returns, 0.99);
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;

  console.log(`Per-candle abs-return %:`);
  console.log(`  mean ${mean.toFixed(3)}  p25 ${p25.toFixed(3)}  p50 ${p50.toFixed(3)}  p75 ${p75.toFixed(3)}  p90 ${p90.toFixed(3)}  p95 ${p95.toFixed(3)}  p99 ${p99.toFixed(3)}`);

  // Define regimes
  const HIGH = p90;  // top 10% = "high vol"
  const EXTREME = p99;

  // Find consecutive high-vol runs
  const runs: { start: number; end: number; length: number; peakPct: number }[] = [];
  let runStart = -1;
  let runPeak = 0;
  for (let i = 0; i < k5m.length; i++) {
    const r = returns[i]!;
    if (r >= HIGH) {
      if (runStart < 0) runStart = i;
      runPeak = Math.max(runPeak, r);
    } else if (runStart >= 0) {
      runs.push({ start: runStart, end: i - 1, length: i - runStart, peakPct: runPeak });
      runStart = -1;
      runPeak = 0;
    }
  }
  if (runStart >= 0) runs.push({ start: runStart, end: k5m.length - 1, length: k5m.length - runStart, peakPct: runPeak });

  const runLens = runs.map(r => r.length);
  const avgRunLen = runLens.reduce((a, b) => a + b, 0) / (runLens.length || 1);
  const maxRunLen = Math.max(...runLens, 0);

  console.log(`\nHigh-vol runs (consecutive candles ≥ p90 = ${HIGH.toFixed(3)}%):`);
  console.log(`  total runs: ${runs.length},  avg len: ${avgRunLen.toFixed(1)} candles (${(avgRunLen * 5).toFixed(0)} min),  max: ${maxRunLen} (${maxRunLen * 5} min)`);

  // Length distribution
  const lenHist: Record<number, number> = {};
  for (const l of runLens) lenHist[l] = (lenHist[l] ?? 0) + 1;
  const lenKeys = Object.keys(lenHist).map(Number).sort((a, b) => a - b);
  console.log(`  length distribution: ${lenKeys.map(k => `${k}:${lenHist[k]}`).join('  ')}`);

  // Top 5 most extreme runs
  const topRuns = [...runs].sort((a, b) => b.peakPct - a.peakPct).slice(0, 5);
  console.log(`\n  Top 5 most extreme runs:`);
  for (const r of topRuns) {
    console.log(`    ${fmtTime(k5m[r.start]!.openTime)} → ${fmtTime(k5m[r.end]!.closeTime)} | ${r.length} candles (${r.length * 5} min) | peak ${r.peakPct.toFixed(3)}%`);
  }

  // Extreme candles (≥ p99)
  const extreme = returns.map((r, i) => ({ r, i })).filter(x => x.r >= EXTREME).slice(0, 10);
  console.log(`\n  Top 10 extreme candles (≥ p99 = ${EXTREME.toFixed(3)}%):`);
  for (const e of extreme) {
    const k = k5m[e.i]!;
    console.log(`    ${fmtTime(k.openTime)} | ${e.r.toFixed(3)}% | ${color(k)} | O ${k.open.toFixed(1)} → C ${k.close.toFixed(1)}`);
  }
}

// ─── 2. Streak stats ────────────────────────────────────────────────────────

function analyzeStreaks(symbol: string, k5m: Kline[]): void {
  console.log(`\n━━━ ${symbol} · STREAK STATISTICS (5m × 7d) ━━━`);

  // Walk candles and emit {signedStreak, nextCandleColor}
  // signedStreak: +N = N consecutive green, -N = N consecutive red
  const events: { streak: number; nextColor: 'green' | 'red' | 'doji'; preStreak: number; preStreakColors: string }[] = [];
  let sign = 0;   // +1 green run, -1 red run, 0 doji
  let run = 0;
  let priorRunLen = 0;
  let priorRunSign = 0;

  for (let i = 0; i < k5m.length - 1; i++) {
    const c = color(k5m[i]!);
    if (c === 'doji') {
      if (run > 0) {
        priorRunLen = run;
        priorRunSign = sign;
        run = 0;
        sign = 0;
      }
      continue;
    }
    const s = c === 'green' ? 1 : -1;
    if (s === sign) {
      run++;
    } else {
      // Streak ended, new direction. Check next candle for reversal stats on current run.
      priorRunLen = run;
      priorRunSign = sign;
      run = 1;
      sign = s;
    }
    // Record event: at index i, we have run of length `run` in direction `sign`.
    // Next candle is at i+1.
    if (run >= 2) {
      events.push({
        streak: run * sign,
        nextColor: color(k5m[i + 1]!),
        preStreak: priorRunLen * priorRunSign,
        preStreakColors: '',
      });
    }
  }

  // Reversal rate by absolute streak length (abs only; up and down symmetric in aggregate)
  const buckets: Record<number, { n: number; reversed: number; continued: number; doji: number }> = {};
  for (const e of events) {
    const absLen = Math.abs(e.streak);
    buckets[absLen] ??= { n: 0, reversed: 0, continued: 0, doji: 0 };
    const b = buckets[absLen]!;
    b.n++;
    const streakColor = e.streak > 0 ? 'green' : 'red';
    if (e.nextColor === 'doji') b.doji++;
    else if (e.nextColor !== streakColor) b.reversed++;
    else b.continued++;
  }

  console.log(`\nReversal rate by streak length:`);
  console.log(`  len  n    reverse%  continue%  doji%`);
  const keys = Object.keys(buckets).map(Number).sort((a, b) => a - b);
  for (const l of keys) {
    const b = buckets[l]!;
    const rev = (100 * b.reversed / b.n).toFixed(1);
    const con = (100 * b.continued / b.n).toFixed(1);
    const doji = (100 * b.doji / b.n).toFixed(1);
    console.log(`  ${String(l).padStart(2)}   ${String(b.n).padStart(4)}   ${rev.padStart(5)}%    ${con.padStart(5)}%    ${doji.padStart(4)}%`);
  }

  // Reversal given prior streak — does "long streak after long streak" differ?
  // Group by current absLen ∈ [3,4,5+] and prior absLen ∈ [1,2,3+]
  const preBuckets: Record<string, { n: number; reversed: number }> = {};
  for (const e of events) {
    const cur = Math.abs(e.streak);
    const prior = Math.abs(e.preStreak);
    if (cur < 3) continue;   // focus on ≥3 — that's where bot fires
    const curKey = cur >= 5 ? '5+' : String(cur);
    const priorKey = prior === 0 ? '0' : prior >= 3 ? '3+' : String(prior);
    const k = `cur=${curKey}_prior=${priorKey}`;
    preBuckets[k] ??= { n: 0, reversed: 0 };
    const b = preBuckets[k]!;
    b.n++;
    const streakColor = e.streak > 0 ? 'green' : 'red';
    if (e.nextColor !== streakColor && e.nextColor !== 'doji') b.reversed++;
  }
  console.log(`\nReversal rate by (current streak, prior streak):`);
  const preKeys = Object.keys(preBuckets).sort();
  for (const k of preKeys) {
    const b = preBuckets[k]!;
    if (b.n < 5) continue;
    console.log(`  ${k.padEnd(22)} n=${String(b.n).padStart(4)}  reverse ${(100 * b.reversed / b.n).toFixed(1)}%`);
  }
}

// ─── 3. Intra-window path (1s data) ─────────────────────────────────────────

/**
 * For each 5m window in 1s data, compute the path shape:
 *   open, close, high, low, time-of-max-high, time-of-max-low,
 *   max excursion up from open, max excursion down from open.
 *
 * Classify as:
 *   trend_up     — went up, never went down > eps
 *   trend_down   — opposite
 *   trap_up      — went up > trapPct% then closed below open
 *   trap_down    — went down > trapPct% then closed above open
 *   whipsaw      — went both directions, ambiguous
 */
interface WindowPath {
  startMs: number;
  open: number; close: number; high: number; low: number;
  maxUpPct: number;    timeMaxUpSec: number;
  maxDownPct: number;  timeMaxDownSec: number;
  closePct: number;    // (close-open)/open * 100
  pattern: 'trend_up' | 'trend_down' | 'trap_up' | 'trap_down' | 'whipsaw' | 'flat';
}

function computeWindowPaths(k1s: Kline[]): WindowPath[] {
  if (!k1s.length) return [];
  const WIN = 5 * 60 * 1000;
  const windows: WindowPath[] = [];
  let curStart = Math.floor(k1s[0]!.openTime / WIN) * WIN;
  let curEnd = curStart + WIN;
  let buf: Kline[] = [];

  const TRAP_PCT = 0.08;   // move must exceed this to count as "trap" (0.08% = meaningful)

  const flush = () => {
    if (!buf.length) return;
    const open = buf[0]!.open;
    const close = buf[buf.length - 1]!.close;
    const high = Math.max(...buf.map(k => k.high));
    const low  = Math.min(...buf.map(k => k.low));
    const tHigh = buf.findIndex(k => k.high === high);
    const tLow  = buf.findIndex(k => k.low === low);
    const maxUpPct = (high - open) / open * 100;
    const maxDownPct = (open - low) / open * 100;
    const closePct = (close - open) / open * 100;

    let pattern: WindowPath['pattern'];
    if (Math.abs(closePct) < 0.02 && maxUpPct < TRAP_PCT && maxDownPct < TRAP_PCT) {
      pattern = 'flat';
    } else if (closePct > 0 && maxDownPct >= TRAP_PCT) {
      pattern = 'trap_down';   // dipped down first, recovered to green close
    } else if (closePct < 0 && maxUpPct >= TRAP_PCT) {
      pattern = 'trap_up';     // spiked up first, reversed to red close
    } else if (closePct > 0) {
      pattern = 'trend_up';
    } else if (closePct < 0) {
      pattern = 'trend_down';
    } else {
      pattern = 'whipsaw';
    }

    windows.push({
      startMs: curStart, open, close, high, low,
      maxUpPct, timeMaxUpSec: tHigh,
      maxDownPct, timeMaxDownSec: tLow,
      closePct, pattern,
    });
    buf = [];
  };

  for (const k of k1s) {
    if (k.openTime >= curEnd) {
      flush();
      curStart = Math.floor(k.openTime / WIN) * WIN;
      curEnd = curStart + WIN;
    }
    buf.push(k);
  }
  flush();

  return windows;
}

function analyzePaths(symbol: string, k1s: Kline[]): WindowPath[] {
  console.log(`\n━━━ ${symbol} · INTRA-WINDOW PATH (1s × 2d) ━━━`);
  const paths = computeWindowPaths(k1s);
  console.log(`  total 5m windows: ${paths.length}`);

  const patternCount: Record<string, number> = {};
  for (const p of paths) patternCount[p.pattern] = (patternCount[p.pattern] ?? 0) + 1;
  console.log(`  pattern distribution:`);
  for (const [pat, n] of Object.entries(patternCount).sort(([, a], [, b]) => b - a)) {
    console.log(`    ${pat.padEnd(12)} ${String(n).padStart(4)}  (${(100 * n / paths.length).toFixed(1)}%)`);
  }

  // For TRAP windows: where does the trap peak occur within window? (seconds into window)
  const trapsUp = paths.filter(p => p.pattern === 'trap_up');
  const trapsDown = paths.filter(p => p.pattern === 'trap_down');

  if (trapsUp.length) {
    const times = trapsUp.map(p => p.timeMaxUpSec);
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const p25 = pctl(times, 0.25), p50 = pctl(times, 0.50), p75 = pctl(times, 0.75);
    const peaksAvg = trapsUp.reduce((s, p) => s + p.maxUpPct, 0) / trapsUp.length;
    console.log(`\n  trap_up (up first, red close): n=${trapsUp.length}`);
    console.log(`    peak timing (sec into window): p25=${p25}  p50=${p50}  p75=${p75}  mean=${avg.toFixed(0)}`);
    console.log(`    avg peak up-excursion: ${peaksAvg.toFixed(3)}%`);
  }
  if (trapsDown.length) {
    const times = trapsDown.map(p => p.timeMaxDownSec);
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const p25 = pctl(times, 0.25), p50 = pctl(times, 0.50), p75 = pctl(times, 0.75);
    const peaksAvg = trapsDown.reduce((s, p) => s + p.maxDownPct, 0) / trapsDown.length;
    console.log(`\n  trap_down (down first, green close): n=${trapsDown.length}`);
    console.log(`    trough timing (sec into window): p25=${p25}  p50=${p50}  p75=${p75}  mean=${avg.toFixed(0)}`);
    console.log(`    avg trough down-excursion: ${peaksAvg.toFixed(3)}%`);
  }

  // Also: for trend windows, check if the "decisive move" happens early or late
  const upTrends = paths.filter(p => p.pattern === 'trend_up');
  const downTrends = paths.filter(p => p.pattern === 'trend_down');
  if (upTrends.length) {
    const times = upTrends.map(p => p.timeMaxUpSec);
    console.log(`\n  trend_up: n=${upTrends.length}, avg time-of-max at ${(times.reduce((a,b)=>a+b,0)/times.length).toFixed(0)}s`);
  }
  if (downTrends.length) {
    const times = downTrends.map(p => p.timeMaxDownSec);
    console.log(`  trend_down: n=${downTrends.length}, avg time-of-min at ${(times.reduce((a,b)=>a+b,0)/times.length).toFixed(0)}s`);
  }

  return paths;
}

// ─── 4. Streak × path joined analysis ───────────────────────────────────────

/**
 * The bot bets contrarian on N+1 after seeing a streak ending at N. Given a
 * 5m streak history, we look up the path shape of the NEXT window (in 1s) and
 * classify: did the reversal happen early enough to hit TP, did it trap, etc.
 */
function analyzeStreakReversalPaths(
  symbol: string, k5m: Kline[], paths5m: WindowPath[],
): void {
  console.log(`\n━━━ ${symbol} · STREAK → NEXT WINDOW PATH ━━━`);

  // Only analyze windows that are within the 1s window coverage.
  const pathByStart = new Map<number, WindowPath>();
  for (const p of paths5m) pathByStart.set(p.startMs, p);

  // For each 5m index, check if prior candles form a streak ending at this one,
  // then inspect NEXT window's path.
  const results: { streakLen: number; streakSign: number; nextPattern: string; closePct: number }[] = [];
  for (let i = 3; i < k5m.length - 1; i++) {
    const c = color(k5m[i]!);
    if (c === 'doji') continue;
    const s = c === 'green' ? 1 : -1;
    // Determine length backward
    let len = 1;
    for (let j = i - 1; j >= 0; j--) {
      if (color(k5m[j]!) === c) len++; else break;
    }
    if (len < 3) continue;   // bot only fires at streak ≥ 3

    const nextKey = k5m[i + 1]!.openTime;
    const nextPath = pathByStart.get(nextKey);
    if (!nextPath) continue;
    results.push({
      streakLen: len,
      streakSign: s,
      nextPattern: nextPath.pattern,
      closePct: nextPath.closePct,
    });
  }

  if (!results.length) {
    console.log(`  (no overlapping data — 1s window too short)`);
    return;
  }

  // Bot bets contrarian — "reversal" means next window closes in opposite color
  let winN = 0, lossN = 0, trapLossN = 0;
  const byStreakLen: Record<string, { n: number; wins: number; trapLosses: number }> = {};
  for (const r of results) {
    const streakColor = r.streakSign > 0 ? 'green' : 'red';
    const betColor = streakColor === 'green' ? 'red' : 'green';
    const nextColor = r.closePct > 0 ? 'green' : r.closePct < 0 ? 'red' : 'doji';
    const bucket = r.streakLen >= 5 ? '5+' : String(r.streakLen);
    byStreakLen[bucket] ??= { n: 0, wins: 0, trapLosses: 0 };
    const b = byStreakLen[bucket]!;
    b.n++;
    if (nextColor === betColor) {
      b.wins++;
      winN++;
    } else {
      lossN++;
      // "Trap" loss: we bet betColor, window first moved betColor-direction
      // significantly (TP might have triggered) then reversed to streakColor close.
      if (
        (betColor === 'red' && r.nextPattern === 'trap_down') ||
        (betColor === 'green' && r.nextPattern === 'trap_up')
      ) {
        b.trapLosses++;
        trapLossN++;
      }
    }
  }

  console.log(`\n  Contrarian bet on next window after streak (hypothetical):`);
  console.log(`  streak  n    win%   trap_loss%`);
  for (const k of Object.keys(byStreakLen).sort()) {
    const b = byStreakLen[k]!;
    console.log(`  ${k.padEnd(6)}  ${String(b.n).padStart(4)}  ${(100 * b.wins / b.n).toFixed(1).padStart(5)}%  ${(100 * b.trapLosses / b.n).toFixed(1).padStart(5)}%`);
  }
  const totalN = winN + lossN;
  console.log(`\n  Overall: n=${totalN},  wins ${winN} (${(100*winN/totalN).toFixed(1)}%),  losses ${lossN},  trap-losses ${trapLossN} (${(100*trapLossN/totalN).toFixed(1)}%)`);
}

// ─── main ───────────────────────────────────────────────────────────────────

async function main() {
  for (const symbol of ['BTCUSDT', 'SOLUSDT']) {
    const k5m = load(symbol, '5m', '7d');
    const k1s = load(symbol, '1s', '2d');
    console.log(`\n\n════════ ${symbol} — loaded ${k5m.length} × 5m, ${k1s.length} × 1s ════════`);

    analyzeVolatilityRegimes(symbol, k5m);
    analyzeStreaks(symbol, k5m);
    const paths = analyzePaths(symbol, k1s);
    analyzeStreakReversalPaths(symbol, k5m, paths);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
