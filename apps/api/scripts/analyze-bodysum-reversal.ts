/**
 * Analyse reversal probability using SUM of ALL streak bar bodies
 * (not just last 3). Captures climax-first patterns where a huge
 * early bar followed by small bars still signals exhaustion — but
 * body3 (last 3) misses because the small late bars dominate.
 *
 * Test hypothesis: bodySum-of-streak is a BETTER predictor than body3.
 *
 * For each (streak, bodySum bucket) combo, compute:
 *   - P(reversal at next bar)
 *   - P(streak extends to ≥extreme threshold)
 *   - sample count
 *
 * Compare top buckets side-by-side with body3 metric (from
 * analyze-armed-fade.ts).
 *
 * Usage:
 *   pnpm --filter @trading-bot/api exec tsx scripts/analyze-bodysum-reversal.ts \
 *     [--days=365] [--streak=3,4,5,6] [--bucket=50] [--extreme=7]
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
  let days = 365, streaks = [3,4,5,6], bucket = 50, extreme = 7;
  for (const a of process.argv.slice(2)) {
    if      (a.startsWith('--days='))    days = Number(a.slice(7));
    else if (a.startsWith('--streak='))  streaks = a.slice(9).split(',').map(Number);
    else if (a.startsWith('--bucket='))  bucket = Number(a.slice(9));
    else if (a.startsWith('--extreme=')) extreme = Number(a.slice(10));
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
  streak:    number;
  bodyAll:   number;   // signed sum of streak bars
  body3:     number;   // signed sum of last 3 streak bars (for comparison)
  reversed:  boolean;
  trapped:   boolean;
  finalStreak: number;
  /** Position of largest body in streak (1=first, N=last). For climax detection. */
  maxBodyPos: number;
  /** First bar body / total body — high = climax-first pattern. */
  firstShare: number;
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
  console.error(`Fetching ${args.days}d of BTC 5m bars (Spot)…`);
  const bars = await fetchKlines(args.days);
  console.error(`Got ${bars.length} bars\n`);

  // streak ending at each i
  const streakLen = new Array<number>(bars.length).fill(0);
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    if (b.dir === 0) { streakLen[i] = 0; continue; }
    streakLen[i] = (i > 0 && bars[i-1]!.dir === b.dir) ? streakLen[i-1]! + 1 : 1;
  }

  const samples: Sample[] = [];
  for (let j = 3; j < bars.length; j++) {
    const s = streakLen[j-1]!;
    if (s < 3) continue;
    const regime = bars[j-1]!.dir;
    if (regime === 0) continue;
    const nextDir = bars[j]!.dir;
    if (nextDir === 0) continue;

    // Sum ALL streak bars: bars[j-s], bars[j-s+1], ..., bars[j-1]
    let bodyAll = 0, body3 = 0;
    let maxAbs = -1, maxPos = 0;
    for (let k = 0; k < s; k++) {
      const body = bars[j-s+k]!.body;
      bodyAll += body;
      if (k >= s - 3) body3 += body;     // last 3 only
      if (Math.abs(body) > maxAbs) {
        maxAbs = Math.abs(body);
        maxPos = k + 1;                  // 1-indexed
      }
    }
    const firstAbs = Math.abs(bars[j-s]!.body);
    const firstShare = Math.abs(bodyAll) > 0 ? firstAbs / Math.abs(bodyAll) : 0;

    // Walk forward to find streak extension
    let ext = 0;
    for (let k = j; k < bars.length; k++) {
      if (bars[k]!.dir === regime) ext++;
      else break;
    }
    const finalStreak = s + ext;

    samples.push({
      streak: s,
      bodyAll: Math.abs(bodyAll),
      body3:   Math.abs(body3),
      reversed: nextDir !== regime,
      trapped:  finalStreak >= args.extreme,
      finalStreak,
      maxBodyPos: maxPos,
      firstShare,
    });
  }

  // Cross-tab: bodyAll bucket × streak
  console.log(`Total samples (streak ≥ 3, next non-doji): ${samples.length}\n`);

  for (const targetStreak of args.streaks) {
    const subset = samples.filter(s => s.streak === targetStreak);
    if (subset.length === 0) continue;
    const baselineRev  = subset.filter(s => s.reversed).length / subset.length;
    const baselineTrap = subset.filter(s => s.trapped).length / subset.length;
    console.log(`── STREAK = ${targetStreak} (n=${subset.length}, P(rev)=${(baselineRev*100).toFixed(1)}%, P(trap≥${args.extreme})=${(baselineTrap*100).toFixed(1)}%) ──`);
    console.log('| |bodyAll| bucket  |    n | P(rev)   |   CI(rev)    | P(trap) | edge vs baseline |');
    console.log('|--------------------|------|----------|--------------|---------|------------------|');
    const buckets: Array<{ lo: number; hi: number }> = [];
    for (let lo = 0; lo < 2000; lo += args.bucket) buckets.push({ lo, hi: lo + args.bucket });
    buckets.push({ lo: 2000, hi: Infinity });
    for (const b of buckets) {
      const sub = subset.filter(s => s.bodyAll >= b.lo && s.bodyAll < b.hi);
      if (sub.length < 25) continue;
      const n = sub.length;
      const kRev  = sub.filter(s => s.reversed).length;
      const kTrap = sub.filter(s => s.trapped).length;
      const pRev  = kRev / n;
      const pTrap = kTrap / n;
      const [ciLo, ciHi] = wilsonCI(kRev, n);
      const edge = (pRev - baselineRev) * 100;
      const label = b.hi === Infinity ? `≥$2000          ` : `$${b.lo.toString().padStart(5,' ')}-${b.hi.toString().padStart(5,' ')}`;
      console.log(
        `| ${label} | ${String(n).padStart(4)} |  ${(pRev*100).toFixed(2).padStart(5)}%  | ${ciLo.toFixed(1)}% – ${ciHi.toFixed(1).padStart(4)}% |  ${(pTrap*100).toFixed(2).padStart(5)}% |  ${edge >= 0 ? '+' : ''}${edge.toFixed(1).padStart(5)}%        |`
      );
    }
    console.log();
  }

  // Compare body3 vs bodyAll metric power
  console.log('═══ COMPARE: body3 (last 3) vs bodyAll (entire streak) ═══');
  console.log('Top body3 buckets (by P(rev), min 25 samples):');
  for (const targetStreak of [3, 4, 5]) {
    const subset = samples.filter(s => s.streak === targetStreak);
    if (subset.length === 0) continue;
    const buckets: Array<{ lo: number; hi: number; label: string }> = [];
    for (let lo = 0; lo < 1000; lo += 50) buckets.push({ lo, hi: lo + 50, label: `$${lo}-${lo+50}` });
    const top = buckets
      .map(b => {
        const sub = subset.filter(s => s.body3 >= b.lo && s.body3 < b.hi);
        if (sub.length < 25) return null;
        const p = sub.filter(s => s.reversed).length / sub.length;
        return { ...b, n: sub.length, p };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => b.p - a.p)
      .slice(0, 3);
    console.log(`  streak=${targetStreak} top body3:`);
    for (const t of top) console.log(`    ${t.label.padEnd(12)}  n=${t.n.toString().padStart(3)}  P(rev)=${(t.p*100).toFixed(1)}%`);
  }
  console.log('\nTop bodyAll buckets (same streak levels):');
  for (const targetStreak of [3, 4, 5]) {
    const subset = samples.filter(s => s.streak === targetStreak);
    if (subset.length === 0) continue;
    const buckets: Array<{ lo: number; hi: number; label: string }> = [];
    for (let lo = 0; lo < 2000; lo += 100) buckets.push({ lo, hi: lo + 100, label: `$${lo}-${lo+100}` });
    const top = buckets
      .map(b => {
        const sub = subset.filter(s => s.bodyAll >= b.lo && s.bodyAll < b.hi);
        if (sub.length < 25) return null;
        const p = sub.filter(s => s.reversed).length / sub.length;
        return { ...b, n: sub.length, p };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => b.p - a.p)
      .slice(0, 3);
    console.log(`  streak=${targetStreak} top bodyAll:`);
    for (const t of top) console.log(`    ${t.label.padEnd(12)}  n=${t.n.toString().padStart(3)}  P(rev)=${(t.p*100).toFixed(1)}%`);
  }

  // Climax-first analysis: does maxBodyPos matter?
  console.log('\n═══ CLIMAX POSITION ANALYSIS ═══');
  console.log('When IS the biggest body usually? (relative to streak length)\n');
  for (const targetStreak of [3, 4, 5, 6]) {
    const subset = samples.filter(s => s.streak === targetStreak);
    if (subset.length < 50) continue;
    console.log(`  streak=${targetStreak} (n=${subset.length}):`);
    const byPos = new Map<number, Sample[]>();
    for (const s of subset) {
      if (!byPos.has(s.maxBodyPos)) byPos.set(s.maxBodyPos, []);
      byPos.get(s.maxBodyPos)!.push(s);
    }
    for (const pos of Array.from(byPos.keys()).sort((a,b)=>a-b)) {
      const list = byPos.get(pos)!;
      const p = list.filter(s => s.reversed).length / list.length;
      console.log(`    biggest at bar ${pos}: n=${list.length.toString().padStart(3)}  P(rev)=${(p*100).toFixed(1)}%`);
    }
  }

  // First-bar climax (firstShare ≥ 0.5 = first bar is ≥50% of total move)
  console.log('\n═══ FIRST-BAR CLIMAX (first body / total body ≥ 0.5) ═══');
  for (const targetStreak of [4, 5, 6]) {
    const subset = samples.filter(s => s.streak === targetStreak);
    const climaxFirst = subset.filter(s => s.firstShare >= 0.5);
    const other      = subset.filter(s => s.firstShare < 0.5);
    if (climaxFirst.length < 20) continue;
    const pClimax = climaxFirst.filter(s => s.reversed).length / climaxFirst.length;
    const pOther  = other.filter(s => s.reversed).length / other.length;
    console.log(`  streak=${targetStreak}:  first ≥50% of move → P(rev)=${(pClimax*100).toFixed(1)}% (n=${climaxFirst.length})  |  evenly distributed → P(rev)=${(pOther*100).toFixed(1)}% (n=${other.length})`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
