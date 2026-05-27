/**
 * For "momentum continuation" bars (streak ≥ 5 AND body3 large enough that bot
 * would normally skip = body3 > momentum_threshold), measure:
 *
 *   (1) How many MORE same-direction bars follow before reversal? (lifetime)
 *   (2) Distribution of TERMINAL streak length (where does it finally exhaust?)
 *   (3) Conditional reversal rate at each subsequent streak length, given the
 *       streak started from a high-momentum trigger.
 *
 * Answers the user's question: "if momentum continues past streak X, when do we
 * fade, at what streak length is the bot statistically right?"
 *
 * Usage:
 *   pnpm --filter @trading-bot/api exec tsx scripts/analyze-momentum-lifetime.ts \
 *     [--days=365] [--start-streak=5] [--momentum-body3=700]
 */
import { writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

interface Args { days: number; startStreak: number; momBody3: number; out: string }
function parseArgs(): Args {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const a: Args = { days: 365, startStreak: 5, momBody3: 700, out: path.join(here, 'results', 'analyze-momentum-lifetime.md') };
  for (const arg of process.argv.slice(2)) {
    const eq = arg.indexOf('='); if (eq < 0) continue;
    const k = arg.slice(2, eq), v = arg.slice(eq + 1);
    if (k === 'days') a.days = Number(v);
    else if (k === 'start-streak') a.startStreak = Number(v);
    else if (k === 'momentum-body3') a.momBody3 = Number(v);
    else if (k === 'out') a.out = path.isAbsolute(v) ? v : path.join(here, v);
  }
  return a;
}

interface Bar { ts: number; open: number; close: number; dir: 1|-1|0 }
async function fetchKlines(days: number): Promise<Bar[]> {
  const endMs = Date.now(), startMs = endMs - days * 86400_000;
  const all: Bar[] = []; let cursor = startMs;
  while (cursor < endMs) {
    const url = `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=5m&startTime=${cursor}&endTime=${endMs}&limit=1000`;
    const res = await fetch(url); if (!res.ok) throw new Error(`Binance ${res.status}`);
    const rows = (await res.json()) as unknown[][];
    if (!rows.length) break;
    for (const r of rows) {
      const ts = Number(r[0]), open = Number(r[1]), close = Number(r[4]);
      all.push({ ts, open, close, dir: close > open ? 1 : close < open ? -1 : 0 });
    }
    const lastTs = Number(rows[rows.length-1]?.[0] ?? 0);
    if (lastTs <= cursor) break;
    cursor = lastTs + 1;
    await new Promise(r => setTimeout(r, 80));
  }
  return all;
}

async function run(): Promise<void> {
  const a = parseArgs();
  console.error(`Fetching ${a.days}d BTCUSDT 5m bars…`);
  const bars = await fetchKlines(a.days);
  console.error(`Got ${bars.length} bars\n`);

  const streak = new Array<number>(bars.length).fill(0);
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    if (b.dir === 0) { streak[i] = 0; continue; }
    streak[i] = (i > 0 && bars[i-1]!.dir === b.dir) ? streak[i-1]! + 1 : 1;
  }

  // For each bar j where streak[j]==startStreak AND body3@j > momBody3 → "momentum event"
  // Walk forward until streak ends (direction flips or 0 doji).
  // Record:
  //   - terminal streak length (the highest streak achieved)
  //   - bar offsets where reversal could've been taken (1 = next bar, 2 = bar after, ...)
  //   - reversal rate at each subsequent streak length

  // events[k] = number of bars that reach streak length k after a momentum event
  // revs[k]   = number of those bars where the NEXT bar reverses
  const events = new Map<number, number>();
  const revs   = new Map<number, number>();
  let totalEvents = 0;
  const terminalDist = new Map<number, number>();   // terminal streak distribution
  const continuationLen = new Map<number, number>(); // length AFTER trigger bar (0,1,2,...)

  for (let j = 3; j + 30 < bars.length; j++) {
    if (streak[j]! !== a.startStreak) continue;
    const body3 = Math.abs(bars[j]!.close - bars[j]!.open)
                + Math.abs(bars[j-1]!.close - bars[j-1]!.open)
                + Math.abs(bars[j-2]!.close - bars[j-2]!.open);
    if (body3 <= a.momBody3) continue;
    const dir = bars[j]!.dir;
    if (dir === 0) continue;
    totalEvents++;

    // Walk forward. At each step, we're at streak length L (starting from startStreak).
    // For each forward bar k:
    //   - If bars[k].dir === dir → streak extends to L+1
    //   - If bars[k].dir !== dir → streak terminates here, reversal happened
    let L = a.startStreak;
    let terminated = false;
    for (let k = j + 1; k <= j + 30 && k < bars.length; k++) {
      // At this point: streak so far is at L. Record one observation.
      events.set(L, (events.get(L) ?? 0) + 1);
      // Did bar k reverse the streak?
      const reversedHere = bars[k]!.dir !== 0 && bars[k]!.dir !== dir;
      if (reversedHere) revs.set(L, (revs.get(L) ?? 0) + 1);
      if (reversedHere) {
        const contLen = k - j;   // 1 = next bar reversed
        continuationLen.set(contLen - 1, (continuationLen.get(contLen - 1) ?? 0) + 1);
        terminalDist.set(L, (terminalDist.get(L) ?? 0) + 1);
        terminated = true;
        break;
      }
      // Bar continued (or doji — treat doji as non-reversal, streak continues).
      if (bars[k]!.dir === dir) L++;
    }
    if (!terminated) {
      continuationLen.set(30, (continuationLen.get(30) ?? 0) + 1);
    }
  }

  // Build report
  const M: string[] = [];
  M.push('# Momentum continuation lifetime (BTC)');
  M.push('');
  M.push(`_Generated ${new Date().toISOString()}_ · ${a.days}d · ${bars.length} bars`);
  M.push('');
  M.push(`Event = bar at streak=${a.startStreak} with body3 > \$${a.momBody3} (the "momentum continuation" regime we'd skip in arm).`);
  M.push(`Total momentum events: **${totalEvents}** in ${a.days} days.`);
  M.push('');

  M.push('## Terminal streak — where does momentum exhaust?');
  M.push('');
  M.push(`After a momentum event at streak=${a.startStreak}, at what streak length does the direction finally flip?`);
  M.push('');
  M.push('| terminal streak | n | % of events |');
  M.push('|---|---|---|');
  const keys = [...terminalDist.keys()].sort((a,b)=>a-b);
  for (const k of keys) {
    const n = terminalDist.get(k)!;
    M.push(`| ${k} | ${n} | ${(n/totalEvents*100).toFixed(1)}% |`);
  }
  M.push('');

  M.push('## Continuation length distribution (bars after trigger)');
  M.push('');
  M.push(`How many MORE same-direction bars follow before reversal? (0 = next bar reverses, 1 = +1 more bar, etc.)`);
  M.push('');
  M.push('| continuation bars after trigger | n | %        | cumulative % |');
  M.push('|---|---|---|---|');
  const contKeys = [...continuationLen.keys()].sort((a,b)=>a-b);
  let cum = 0;
  for (const k of contKeys) {
    const n = continuationLen.get(k)!;
    cum += n;
    M.push(`| ${k}${k===30?' (still running >30)':''} | ${n} | ${(n/totalEvents*100).toFixed(1)}% | ${(cum/totalEvents*100).toFixed(1)}% |`);
  }
  M.push('');

  M.push('## Conditional reversal rate — given streak is currently at length L (post-momentum)');
  M.push('');
  M.push('Standing at streak length L (started from a momentum event at startStreak),');
  M.push('what is P(next bar reverses)? Use to decide "best streak to fade after momentum."');
  M.push('');
  M.push('| streak L | n (bars reaching L) | revs at L | **P(rev next) %** | hit rate vs flat $0.55 |');
  M.push('|---|---|---|---|---|');
  const evKeys = [...events.keys()].sort((a,b)=>a-b);
  for (const L of evKeys) {
    const n = events.get(L)!;
    const r = revs.get(L) ?? 0;
    const wr = n > 0 ? r/n*100 : 0;
    const ev = (wr/100)*0.45 - (1-wr/100)*0.55;
    M.push(`| ${L} | ${n} | ${r} | **${wr.toFixed(1)}%** | ${ev > 0 ? '✅' : '⚠️'} EV \$${ev.toFixed(3)}/sh |`);
  }
  M.push('');

  writeFileSync(a.out, M.join('\n') + '\n');
  console.error(`Wrote ${a.out}\n`);

  // Console: compact
  console.error(`Total momentum events (streak=${a.startStreak}, body3>${a.momBody3}): ${totalEvents}`);
  console.error('\nTerminal streak (where reverses):');
  for (const k of keys) {
    const n = terminalDist.get(k)!;
    console.error(`  streak ${k}: ${String(n).padStart(4)}  (${(n/totalEvents*100).toFixed(1)}%)`);
  }
  console.error('\nReversal rate by post-momentum streak length:');
  for (const L of evKeys) {
    const n = events.get(L)!;
    const r = revs.get(L) ?? 0;
    if (n < 5) continue;
    const wr = n > 0 ? r/n*100 : 0;
    console.error(`  L=${L}: n=${String(n).padStart(4)} → P(rev)=${wr.toFixed(1)}%`);
  }
}

run().catch(e => { console.error(e); process.exit(1); });
