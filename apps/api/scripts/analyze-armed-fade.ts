/**
 * After bot ARMS (post-extreme-streak), the fader wants to enter at streak
 * 3, 4, or 5. The risk: streak extends into a new extreme (≥7) before
 * reversing, leading to chained losses ("trapped"). For each (streak, body3)
 * combo, compute:
 *
 *   - P(reversal at next bar)               ← primary win prob
 *   - P(streak extends ≥2 more bars)        ← "next-leg" risk
 *   - P(streak extends to ≥7 total)         ← extreme trap risk
 *   - Expected leg length if we lose        ← how deep is the trap
 *
 * Combined score for a "safe fade":
 *   high P(reversal)  AND  low P(extreme trap)
 *
 * Usage:
 *   pnpm --filter @trading-bot/api exec tsx scripts/analyze-armed-fade.ts \
 *     [--days=365] [--streak=3,4,5] [--bucket=50] [--extreme=7]
 */
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config({
  path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.env'),
  override: true,
});

interface Args { days: number; streaks: number[]; bucket: number; extreme: number }
function parseArgs(): Args {
  let days = 365, streaks = [3,4,5], bucket = 50, extreme = 7;
  for (const a of process.argv.slice(2)) {
    if      (a.startsWith('--days='))    days = Number(a.slice(7));
    else if (a.startsWith('--streak='))  streaks = a.slice(9).split(',').map(Number);
    else if (a.startsWith('--bucket='))  bucket = Number(a.slice(9));
    else if (a.startsWith('--extreme=')) extreme = Number(a.slice(10));
    else if (a === '-h')                 { console.log('usage: ... [--days=N] [--streak=3,4,5] [--bucket=50] [--extreme=7]'); process.exit(0); }
  }
  return { days, streaks, bucket, extreme };
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
      const body = close - open;
      all.push({ ts, open, close, body, dir: body > 0 ? 1 : body < 0 ? -1 : 0 });
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
  streak:     number;
  body3:      number;     // abs sum of last 3 bodies
  reversed:   boolean;    // next bar reverses
  finalStreak: number;    // how long the streak grew to (≥ streak)
  trapped:    boolean;    // finalStreak ≥ extreme
}

function wilsonCI(k: number, n: number): [number, number] {
  if (n === 0) return [0, 0];
  const p = k / n, z = 1.96, denom = 1 + z*z/n;
  const c = (p + z*z/(2*n)) / denom;
  const m = z * Math.sqrt(p*(1-p)/n + z*z/(4*n*n)) / denom;
  return [Math.max(0, c-m)*100, Math.min(1, c+m)*100];
}

async function main(): Promise<void> {
  const args = parseArgs();
  console.error(`Fetching ${args.days}d of BTC 5m bars…`);
  const bars = await fetchKlines(args.days);
  console.error(`Got ${bars.length} bars\n`);

  // streak ending at i
  const streakLen = new Array<number>(bars.length).fill(0);
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    if (b.dir === 0) { streakLen[i] = 0; continue; }
    streakLen[i] = (i > 0 && bars[i-1]!.dir === b.dir) ? streakLen[i-1]! + 1 : 1;
  }

  // Build samples.
  const samples: Sample[] = [];
  for (let j = 3; j < bars.length; j++) {
    const s = streakLen[j-1]!;
    if (s < 3) continue;
    const regime = bars[j-1]!.dir;
    if (regime === 0) continue;
    const nextDir = bars[j]!.dir;
    // Walk forward to find how long this streak grew.
    let ext = 0;
    for (let k = j; k < bars.length; k++) {
      if (bars[k]!.dir === regime) ext++;
      else break;
    }
    const finalStreak = s + ext;
    samples.push({
      streak: s,
      body3:  Math.abs(bars[j-1]!.body + bars[j-2]!.body + bars[j-3]!.body),
      reversed: nextDir !== 0 && nextDir !== regime,
      finalStreak,
      trapped: finalStreak >= args.extreme,
    });
  }

  console.log(`Extreme threshold                       : streak ≥ ${args.extreme}`);
  console.log(`Total samples (streak ∈ ${JSON.stringify(args.streaks)}, body any) : ${samples.filter(s => args.streaks.includes(s.streak)).length}`);
  console.log();

  // For each target streak, bucket by |body3| and compute metrics.
  for (const targetStreak of args.streaks) {
    const subset = samples.filter(s => s.streak === targetStreak);
    if (subset.length === 0) { console.log(`(no samples for streak=${targetStreak})`); continue; }
    const overallRev   = subset.filter(s => s.reversed).length / subset.length;
    const overallTrap  = subset.filter(s => s.trapped).length / subset.length;
    console.log(`── STREAK = ${targetStreak}  (n=${subset.length}, overall P(rev)=${(overallRev*100).toFixed(1)}%, overall P(trap)=${(overallTrap*100).toFixed(1)}%) ──`);
    console.log('| body3       |    n | P(rev)   |  CI(rev)     | P(trap)  |  E[finalStreak] | score |');
    console.log('|-------------|------|----------|--------------|----------|-----------------|-------|');
    const buckets: Array<{ lo: number; hi: number }> = [];
    for (let lo = 0; lo < 1000; lo += args.bucket) buckets.push({ lo, hi: lo + args.bucket });
    buckets.push({ lo: 1000, hi: Infinity });
    for (const b of buckets) {
      const sub = subset.filter(s => s.body3 >= b.lo && s.body3 < b.hi);
      if (sub.length < 25) continue;
      const n = sub.length;
      const kRev  = sub.filter(s => s.reversed).length;
      const kTrap = sub.filter(s => s.trapped).length;
      const pRev  = kRev / n;
      const pTrap = kTrap / n;
      const [ciLo, ciHi] = wilsonCI(kRev, n);
      const eFinal = sub.reduce((s, x) => s + x.finalStreak, 0) / n;
      // Score: edge in pRev minus penalty for trap risk (each trap = lose +K bars worth)
      // Simple combined: pRev - 0.5 × pTrap (subjective weight)
      const score = pRev - 0.5 * pTrap;
      const label = b.hi === Infinity ? `≥$1000      ` : `$${b.lo.toString().padStart(4,' ')}-${b.hi.toString().padStart(4,' ')}`;
      console.log(
        `| ${label} | ${String(n).padStart(4)} |  ${(pRev*100).toFixed(2).padStart(5)}%  | ${ciLo.toFixed(1)}% – ${ciHi.toFixed(1).padStart(4)}% |  ${(pTrap*100).toFixed(2).padStart(5)}% |     ${eFinal.toFixed(2).padStart(4)}        | ${(score*100).toFixed(1).padStart(5)} |`
      );
    }
    console.log();
  }

  // Recommendation summary: per streak, find best bucket by score.
  console.log('═══ RECOMMENDATIONS (best body3 bucket per streak, score = P(rev) − 0.5×P(trap)) ═══');
  for (const targetStreak of args.streaks) {
    const subset = samples.filter(s => s.streak === targetStreak);
    if (subset.length === 0) continue;
    const buckets: Array<{ label: string; n: number; pRev: number; pTrap: number; score: number }> = [];
    const stepLo: Array<{ lo: number; hi: number }> = [];
    for (let lo = 0; lo < 1000; lo += args.bucket) stepLo.push({ lo, hi: lo + args.bucket });
    stepLo.push({ lo: 1000, hi: Infinity });
    for (const b of stepLo) {
      const sub = subset.filter(s => s.body3 >= b.lo && s.body3 < b.hi);
      if (sub.length < 25) continue;
      const pRev = sub.filter(s => s.reversed).length / sub.length;
      const pTrap = sub.filter(s => s.trapped).length / sub.length;
      const label = b.hi === Infinity ? `≥$1000` : `$${b.lo}-${b.hi}`;
      buckets.push({ label, n: sub.length, pRev, pTrap, score: pRev - 0.5*pTrap });
    }
    buckets.sort((a, b) => b.score - a.score);
    console.log(`  streak=${targetStreak}: top 3 by score`);
    for (const b of buckets.slice(0, 3)) {
      console.log(`    ${b.label.padEnd(12)} n=${b.n}  P(rev)=${(b.pRev*100).toFixed(1)}%  P(trap)=${(b.pTrap*100).toFixed(1)}%  score=${(b.score*100).toFixed(1)}`);
    }
  }
}

main().catch(err => { console.error(err); process.exit(1); });
