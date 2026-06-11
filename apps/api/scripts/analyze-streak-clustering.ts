/**
 * Streak-clustering / arm-mode hypothesis test.
 *
 * User intuition: a big streak (≥K, same direction) "primes" the regime, so a
 * FOLLOWING smaller streak (4/5) within ~1h fades better than a standalone one.
 * This is exactly what generic arm mode bets on — so this one test answers both
 * "should we enable arm mode?" and "is the streak6→streak4/5 edge real?".
 *
 * Two competing forces, only data decides:
 *   - exhaustion: clustered same-dir streaks = over-extended → fade better
 *   - trend:      clustered same-dir streaks = strong trend → fade WORSE
 *
 * "primed" = a SEPARATE prior streak peak ≥ K, same direction, that ended within
 * W minutes BEFORE the current run started (not the current run's own lower bars).
 *
 * Entry $0.55 flat, base $5. WIN +$4.09, LOSS -$5, breakeven WR 55%. TRAIN/TEST
 * 70/30 OOS split. Reports primed vs unprimed vs baseline so we can see if the
 * priming actually adds anything over just fading that streak length.
 *
 * Usage: tsx scripts/analyze-streak-clustering.ts [--days=365] [--dir=same|opp|any]
 */
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.env'), override: true });

interface Bar { ts: number; open: number; close: number; body: number; dir: 1|-1|0 }

async function fetchKlines(days: number, interval = '5m'): Promise<Bar[]> {
  const endMs = Date.now(), startMs = endMs - days * 86400_000;
  const all: Bar[] = []; let cursor = startMs, pages = 0;
  while (cursor < endMs) {
    const url = `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=${interval}&startTime=${cursor}&endTime=${endMs}&limit=1000`;
    const res = await fetch(url); if (!res.ok) throw new Error(`Binance ${res.status}`);
    const rows = (await res.json()) as unknown[][]; if (!rows.length) break;
    for (const r of rows) { const ts = Number(r[0]), o = Number(r[1]), c = Number(r[4]); all.push({ ts, open: o, close: c, body: c - o, dir: c > o ? 1 : c < o ? -1 : 0 }); }
    const lastTs = Number(rows[rows.length-1]?.[0] ?? 0); if (lastTs <= cursor) break; cursor = lastTs + 1; pages++;
    if (pages % 15 === 0) process.stderr.write(`  ${all.length}…\n`); await new Promise(r => setTimeout(r, 75));
  }
  return all;
}

const BASE = 5, ENTRY = 0.55, WIN = BASE*(1-ENTRY)/ENTRY, LOSS = -BASE, BE = BASE/(BASE+WIN);

interface Trig { ts: number; i: number; streak: number; regime: 1|-1; ratio: number; nextDir: 1|-1|0; primedMax: number }

function stat(list: Trig[]): { wr: number; pnl: number; n: number } {
  const sub = list.filter(t => t.nextDir !== 0);
  if (!sub.length) return { wr: 0, pnl: 0, n: 0 };
  const wins = sub.filter(t => t.nextDir !== t.regime).length;
  return { wr: wins/sub.length, n: sub.length, pnl: wins*WIN + (sub.length-wins)*LOSS };
}

async function main(): Promise<void> {
  const days = Number(process.argv.find(a => a.startsWith('--days='))?.slice(7) ?? 365);
  const dirMode = (process.argv.find(a => a.startsWith('--dir='))?.slice(6) ?? 'same') as 'same'|'opp'|'any';
  console.error(`Fetching ${days}d 5m…`); const bars = await fetchKlines(days); console.error(`${bars.length} bars\n`);

  const sl = new Array<number>(bars.length).fill(0);
  for (let i = 0; i < bars.length; i++) sl[i] = bars[i]!.dir === 0 ? 0 : (i>0 && bars[i-1]!.dir===bars[i]!.dir ? sl[i-1]!+1 : 1);

  // Peaks: last bar of each run (next bar differs in direction). peak[i] = {streak, dir, ts}
  interface Peak { i: number; ts: number; streak: number; dir: 1|-1 }
  const peaks: Peak[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (bars[i]!.dir === 0) continue;
    const isPeak = i+1 >= bars.length || bars[i+1]!.dir !== bars[i]!.dir;
    if (isPeak) peaks.push({ i, ts: bars[i]!.ts, streak: sl[i]!, dir: bars[i]!.dir as 1|-1 });
  }

  const ratioAt = (i: number, s: number): number => {
    let b3 = 0; for (let j=0;j<Math.min(3,s);j++) b3 += Math.abs(bars[i-j]!.body);
    let sb = 0; for (let j=i-48;j<i;j++) sb += Math.abs(bars[j]!.body); const avg = sb/48;
    return avg>0 ? b3/(avg*3) : 0;
  };

  const dirMatch = (a: 1|-1, b: 1|-1): boolean => dirMode==='same' ? a===b : dirMode==='opp' ? a!==b : true;

  // For each trigger (first-hit of streak s), compute primedMax = max prior peak
  // streak (dir per dirMode) that ENDED within W before this run started.
  // We store primedMax per W as a map; to keep it simple, compute on the fly per W.
  function buildTriggers(W_bars: number): Trig[] {
    const out: Trig[] = [];
    let pk = 0; // pointer into peaks
    for (let i = 48; i+1 < bars.length; i++) {
      const s = sl[i]!; if (s < 2 || s > 12) continue;
      if (sl[i-1]! !== s-1) continue;            // first-hit of streak s
      const regime = bars[i]!.dir; if (regime === 0) continue;
      const runStart = i - s + 1;
      const winStartTs = bars[runStart]!.ts - W_bars * 5 * 60_000;
      const runStartTs = bars[runStart]!.ts;
      // scan peaks that ended in [winStartTs, runStartTs) — separate prior run
      let primedMax = 0;
      for (const p of peaks) {
        if (p.ts >= runStartTs) break;            // peaks sorted by ts; past the run start
        if (p.ts < winStartTs) continue;
        if (p.i >= runStart) continue;            // must be a strictly-prior run
        if (!dirMatch(p.dir, regime as 1|-1)) continue;
        if (p.streak > primedMax) primedMax = p.streak;
      }
      out.push({ ts: bars[i]!.ts, i, streak: s, regime: regime as 1|-1, ratio: ratioAt(i, s), nextDir: bars[i+1]!.dir, primedMax });
    }
    return out;
  }

  console.log(`══════════ STREAK CLUSTERING / ARM-MODE TEST — 5m (${days}d, ${bars.length} bars) ══════════`);
  console.log(`Entry $${ENTRY}, breakeven ${(BE*100).toFixed(0)}%. priming dir=${dirMode}. "primed" = prior peak≥K (${dirMode} dir) ended within W before this run.\n`);

  // Baseline: fade WR per streak length (no priming) — the bar to beat.
  const allT = buildTriggers(12);
  console.log('── BASELINE fade WR per streak (no priming filter) ──');
  for (let s = 3; s <= 7; s++) { const st = stat(allT.filter(t => t.streak===s)); if (st.n>=10) console.log(`  streak=${s}: WR ${(st.wr*100).toFixed(0)}% n=${st.n} $${(st.pnl/days).toFixed(2)}/day  ${st.wr>=BE?'✓ profitable raw':'✗ loses raw'}`); }
  console.log();

  // train/test split
  const cutTs = allT.length ? [...allT].sort((a,b)=>a.ts-b.ts)[Math.floor(allT.length*0.7)]!.ts : 0;
  const trainDays = days*0.7, testDays = days*0.3;

  console.log('── PRIMED vs UNPRIMED (does a prior big streak change the fade?) ──');
  console.log('  trig | K≥ | W(min) | PRIMED WR/n/$d | UNPRIMED WR/n | OOS primed WR/n | verdict');
  console.log('  -----+----+--------+----------------+---------------+-----------------+--------');
  interface Edge { trig: number; K: number; W: number; wr: number; n: number; perDay: number; oosWr: number; oosN: number; lift: number }
  const edges: Edge[] = [];
  for (const trig of [3,4,5]) {
    for (const W of [6,12,18,24]) {              // 30/60/90/120 min
      const T = buildTriggers(W).filter(t => t.streak===trig);
      const base = stat(T);
      for (const K of [5,6,7]) {
        const primed = T.filter(t => t.primedMax >= K);
        const unprimed = T.filter(t => t.primedMax < K);
        const ps = stat(primed), us = stat(unprimed);
        if (ps.n < 12) continue;
        const oosP = stat(primed.filter(t => t.ts >= cutTs));
        const lift = ps.wr - base.wr;            // vs fading this streak with no filter
        const good = ps.wr >= BE && ps.wr > us.wr + 0.02 && oosP.wr >= BE && oosP.n >= 5;
        const verdict = good ? '★ EDGE' : ps.wr >= BE ? 'profit' : 'no';
        console.log(`  ${String(trig).padStart(4)} | ${K} | ${String(W*5).padStart(6)} | ${(ps.wr*100).toFixed(0)}% n${String(ps.n).padStart(4)} $${(ps.pnl/days).toFixed(2).padStart(5)} | ${(us.wr*100).toFixed(0)}% n${String(us.n).padStart(4)} | ${(oosP.wr*100).toFixed(0)}% n${String(oosP.n).padStart(3)} | ${verdict} ${lift>=0?'+':''}${(lift*100).toFixed(0)}pp`);
        if (good && ps.n >= 20) edges.push({ trig, K, W: W*5, wr: ps.wr, n: ps.n, perDay: ps.pnl/days, oosWr: oosP.wr, oosN: oosP.n, lift });
      }
    }
    console.log('  -----+----+--------+----------------+---------------+-----------------+--------');
  }
  console.log();

  console.log('── ROBUST CLUSTERING EDGES (primed WR≥BE, > unprimed +2pp, OOS≥BE, n≥20) ──');
  if (!edges.length) console.log('  (none survive — clustering does NOT add edge; arm mode not worth enabling)');
  else {
    edges.sort((a,b)=>b.perDay-a.perDay);
    for (const e of edges) console.log(`  streak=${e.trig} + prior≥${e.K} within ${e.W}m: WR ${(e.wr*100).toFixed(0)}% n=${e.n} $${e.perDay.toFixed(2)}/day · OOS ${(e.oosWr*100).toFixed(0)}% (n${e.oosN}) · +${(e.lift*100).toFixed(0)}pp vs raw`);
  }
  console.log();
  console.log('Interpretation: ★ EDGE rows = priming HELPS (exhaustion wins). If all "no"/negative lift = priming HURTS (trend wins) → arm mode would lose money.');
}

main().catch(e => { console.error(e); process.exit(1); });
