/**
 * Post-cluster behavior analysis. Tests user hypothesis:
 *   "After 3 streaks ≥5 happen within 1 hour, market enters sideways
 *    regime where streak 3-4 events happen frequently."
 *
 * For each "cluster trigger" (3 streaks ≥5 in 60m), analyzes the next
 * 1h / 2h / 3h windows and reports:
 *   - Count of streak 3-4 entry candidates per window (vs baseline)
 *   - Avg max streak length in window (low = sideways, high = trending)
 *   - P(reversal at streak 3-4 entries) (= fade quality)
 *   - Avg |body| per bar (lower = calmer)
 *
 * Compare against BASELINE (random period not following any cluster).
 *
 * Usage:
 *   pnpm --filter @trading-bot/api exec tsx scripts/analyze-post-cluster-behavior.ts \
 *     [--days=365] [--cluster-size=3] [--cluster-window-min=60] [--ext-len=5]
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
  clusterSize: number;
  clusterWindowMin: number;
  extLen: number;
}
function parseArgs(): Args {
  const a: Args = { days: 365, clusterSize: 3, clusterWindowMin: 60, extLen: 5 };
  for (const arg of process.argv.slice(2)) {
    const eq = arg.indexOf('=');
    if (eq < 0) continue;
    const k = arg.slice(2, eq);
    const v = Number(arg.slice(eq + 1));
    switch (k) {
      case 'days':                a.days = v; break;
      case 'cluster-size':        a.clusterSize = v; break;
      case 'cluster-window-min':  a.clusterWindowMin = v; break;
      case 'ext-len':             a.extLen = v; break;
    }
  }
  return a;
}

interface Bar { ts: number; open: number; close: number; body: number; dir: 1|-1|0 }

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
      all.push({ ts, open, close, body: close - open, dir: close > open ? 1 : close < open ? -1 : 0 });
    }
    const lastTs = Number(rows[rows.length-1]?.[0] ?? 0);
    if (lastTs <= cursor) break;
    cursor = lastTs + 1; pages++;
    if (pages % 10 === 0) process.stderr.write(`  fetched ${all.length} bars…\n`);
    await new Promise(r => setTimeout(r, 80));
  }
  return all;
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

  // Find all streak ≥extLen end events
  const extEnds: Array<{ idx: number; ts: number }> = [];
  for (let i = 0; i < bars.length - 1; i++) {
    if (streakLen[i]! >= args.extLen && bars[i+1]!.dir !== bars[i]!.dir) {
      extEnds.push({ idx: i, ts: bars[i]!.ts });
    }
  }

  // Find cluster triggers (clusterSize ext ends in clusterWindowMin)
  const windowMs = args.clusterWindowMin * 60_000;
  const triggers: Array<{ idx: number; ts: number }> = [];
  for (let i = args.clusterSize - 1; i < extEnds.length; i++) {
    const cur = extEnds[i]!;
    const oldest = extEnds[i - args.clusterSize + 1]!;
    if (cur.ts - oldest.ts > windowMs) continue;
    // De-dupe: triggers must be at least clusterWindowMin apart
    const last = triggers[triggers.length - 1];
    if (last && cur.ts - last.ts < windowMs) continue;
    triggers.push({ idx: cur.idx, ts: cur.ts });
  }

  console.log(`Total bars                  : ${bars.length}`);
  console.log(`Extreme streak ends (≥${args.extLen})  : ${extEnds.length}`);
  console.log(`Cluster triggers (${args.clusterSize} in ${args.clusterWindowMin}m): ${triggers.length}`);
  console.log();

  // Analyse post-trigger windows: 1h, 2h, 3h
  const LOOKFORWARD_HOURS = [1, 2, 3];

  function analyzePeriod(startIdx: number, hours: number): {
    streak34Count: number;
    maxStreak: number;
    avgBody: number;
    streak34Reversals: number;
    streak34Total: number;
  } {
    const endTs = bars[startIdx]!.ts + hours * 60 * 60_000;
    const bodies: number[] = [];
    let s34Count = 0;
    let s34Reversals = 0;
    let s34Total = 0;
    let maxS = 0;
    for (let i = startIdx + 1; i < bars.length; i++) {
      if (bars[i]!.ts > endTs) break;
      const s = streakLen[i]!;
      bodies.push(Math.abs(bars[i]!.body));
      maxS = Math.max(maxS, s);
      // Fresh streak hit at 3 or 4
      if ((s === 3 || s === 4) && streakLen[i-1] !== s && i + 1 < bars.length) {
        s34Count++;
        const regime = bars[i]!.dir;
        const next = bars[i+1]!;
        if (regime !== 0 && next.dir !== 0) {
          s34Total++;
          if (next.dir !== regime) s34Reversals++;
        }
      }
    }
    return {
      streak34Count: s34Count,
      maxStreak: maxS,
      avgBody: bodies.length > 0 ? bodies.reduce((a, b) => a + b, 0) / bodies.length : 0,
      streak34Reversals: s34Reversals,
      streak34Total: s34Total,
    };
  }

  // Baseline: sample random non-cluster periods
  // Use ALL bars not within 3h of a trigger
  const triggerTsSet = new Set(triggers.map(t => t.ts));
  const baselineStartIdxs: number[] = [];
  for (let i = 0; i + 36 < bars.length; i++) {
    // Skip if within 3h after any trigger
    let inCluster = false;
    for (const t of triggers) {
      if (bars[i]!.ts >= t.ts && bars[i]!.ts < t.ts + 3 * 60 * 60_000) { inCluster = true; break; }
    }
    if (!inCluster) baselineStartIdxs.push(i);
  }
  // Sample N baseline starts evenly
  const baselineSamples = 200;
  const baselineStride = Math.max(1, Math.floor(baselineStartIdxs.length / baselineSamples));
  const sampledBaseline = baselineStartIdxs.filter((_, i) => i % baselineStride === 0).slice(0, baselineSamples);

  // Aggregate stats
  for (const hours of LOOKFORWARD_HOURS) {
    console.log(`══════ Post-trigger window: ${hours}h ══════`);
    const triggerStats = triggers.map(t => analyzePeriod(t.idx, hours));
    const baselineStats = sampledBaseline.map(i => analyzePeriod(i, hours));

    function avg(list: number[]): number {
      return list.length > 0 ? list.reduce((a, b) => a + b, 0) / list.length : 0;
    }

    const t = {
      s34: avg(triggerStats.map(s => s.streak34Count)),
      maxS: avg(triggerStats.map(s => s.maxStreak)),
      body: avg(triggerStats.map(s => s.avgBody)),
      rev: triggerStats.reduce((a, s) => a + s.streak34Reversals, 0)
         / Math.max(1, triggerStats.reduce((a, s) => a + s.streak34Total, 0)),
      revN: triggerStats.reduce((a, s) => a + s.streak34Total, 0),
    };
    const b = {
      s34: avg(baselineStats.map(s => s.streak34Count)),
      maxS: avg(baselineStats.map(s => s.maxStreak)),
      body: avg(baselineStats.map(s => s.avgBody)),
      rev: baselineStats.reduce((a, s) => a + s.streak34Reversals, 0)
         / Math.max(1, baselineStats.reduce((a, s) => a + s.streak34Total, 0)),
      revN: baselineStats.reduce((a, s) => a + s.streak34Total, 0),
    };

    console.log('  Metric                            | After cluster trigger  | Baseline (no cluster) | Δ      |');
    console.log('  ----------------------------------|------------------------|-----------------------|--------|');
    console.log(`  Avg streak 3/4 entries per window | ${t.s34.toFixed(2).padStart(6)} (per ${hours}h)        | ${b.s34.toFixed(2).padStart(6)} (per ${hours}h)        | ${((t.s34/b.s34 - 1)*100).toFixed(1).padStart(5)}% |`);
    console.log(`  Avg MAX streak in window          | ${t.maxS.toFixed(2).padStart(6)}                 | ${b.maxS.toFixed(2).padStart(6)}                | ${((t.maxS/b.maxS - 1)*100).toFixed(1).padStart(5)}% |`);
    console.log(`  Avg |body| per bar                | $${t.body.toFixed(2).padStart(7)}               | $${b.body.toFixed(2).padStart(7)}              | ${((t.body/b.body - 1)*100).toFixed(1).padStart(5)}% |`);
    console.log(`  P(reversal) at streak 3/4 entries | ${(t.rev*100).toFixed(2).padStart(6)}%  (n=${t.revN}) | ${(b.rev*100).toFixed(2).padStart(6)}%  (n=${b.revN}) | ${((t.rev - b.rev)*100).toFixed(1).padStart(5)}pp |`);
    console.log();
  }

  // Trigger-level distribution: how many streak 3/4 events per trigger window
  console.log('══════ Distribution of streak-3/4 count after cluster trigger (1h window) ══════');
  const counts1h = triggers.map(t => analyzePeriod(t.idx, 1).streak34Count);
  const dist = new Map<number, number>();
  for (const c of counts1h) dist.set(c, (dist.get(c) ?? 0) + 1);
  for (const k of Array.from(dist.keys()).sort((a,b)=>a-b)) {
    const n = dist.get(k)!;
    const pct = (n / triggers.length * 100).toFixed(1);
    console.log(`  ${k} streak-3/4 events: ${n.toString().padStart(4)} triggers (${pct.padStart(5)}%) ${'█'.repeat(Math.round(n/triggers.length*40))}`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
