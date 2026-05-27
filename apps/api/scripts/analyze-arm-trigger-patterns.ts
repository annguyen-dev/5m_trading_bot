/**
 * Pattern-mining for arm triggers: which (streak, body3, prior_vol, hour)
 * combinations both (a) happen often AND (b) lead to high reversal WR?
 *
 * For each bar that triggers arm (streak >= echo_trigger_streak AND body3 >=
 * arm_trigger_body3_min), record features at the trigger moment. Outcomes
 * measured on subsequent bars:
 *   - WR1: single-bar reversal rate (next bar closes opposite to streak)
 *   - WR5: avg reversal rate over next 5 bars (chop intensity proxy)
 *   - WRwin: % of next 30 bars that went opposite (whole arm-window quality)
 *
 * Usage:
 *   pnpm --filter @trading-bot/api exec tsx scripts/analyze-arm-trigger-patterns.ts \
 *     [--days=365] [--trigger-streak=5] [--trigger-body3=100]
 */
import { writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

interface Args { days: number; trigStreak: number; trigBody3: number; out: string }
function parseArgs(): Args {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const a: Args = { days: 365, trigStreak: 5, trigBody3: 100, out: path.join(here, 'results', 'analyze-arm-trigger-patterns.md') };
  for (const arg of process.argv.slice(2)) {
    const eq = arg.indexOf('='); if (eq < 0) continue;
    const k = arg.slice(2, eq), v = arg.slice(eq + 1);
    if (k === 'days') a.days = Number(v);
    else if (k === 'trigger-streak') a.trigStreak = Number(v);
    else if (k === 'trigger-body3')  a.trigBody3 = Number(v);
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

const BODY3_BUCKETS: Array<[number, number, string]> = [
  [100, 200,  '100-200'],
  [200, 300,  '200-300'],
  [300, 400,  '300-400'],
  [400, 600,  '400-600'],
  [600, 900,  '600-900'],
  [900, 1500, '900-1500'],
  [1500,1e9,  '1500+'],
];
const PRIORVOL_BUCKETS: Array<[number, number, string]> = [
  [0,    700,  '<700'],
  [700,  1200, '700-1200'],
  [1200, 2000, '1.2-2k'],
  [2000, 1e9,  '≥2k'],
];

interface Stat { n: number; wr1: number; wr5sum: number; wr30sum: number }
function newStat(): Stat { return { n: 0, wr1: 0, wr5sum: 0, wr30sum: 0 } }

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

  // For each arm-trigger bar j, accumulate features + outcomes.
  // Trigger bar j: streak[j] >= trigStreak AND body3 (sum |body| j-2..j) >= trigBody3.
  // Outcome: reversal of bars j+1..j+30 relative to bar[j].dir.
  const streakBuckets = [5, 6, 7, 8, 9]; // bucket 9 = "9+"
  // 3D map: trigger_streak × body3_bucket × prior_vol_bucket
  const cube: Record<string, Stat> = {};
  const byStreak: Record<number, Stat> = {};
  const byBody3:  Record<number, Stat> = {};
  const byVol:    Record<number, Stat> = {};
  const byHour:   Record<number, Stat> = {};
  function key(s: number, b: number, v: number): string { return `${s}|${b}|${v}` }

  for (let j = 12; j + 30 < bars.length; j++) {
    const s = streak[j]!;
    if (s < a.trigStreak) continue;
    const body3 = Math.abs(bars[j]!.close - bars[j]!.open)
                + Math.abs(bars[j-1]!.close - bars[j-1]!.open)
                + Math.abs(bars[j-2]!.close - bars[j-2]!.open);
    if (body3 < a.trigBody3) continue;
    const dir = bars[j]!.dir;
    if (dir === 0) continue;

    // prior 1h vol = sum |body| of bars j-12..j-1
    let pv = 0;
    for (let k = j - 12; k < j; k++) pv += Math.abs(bars[k]!.close - bars[k]!.open);

    // outcomes
    const next1Rev = bars[j+1]!.dir !== 0 && bars[j+1]!.dir !== dir ? 1 : 0;
    let rev5 = 0; for (let k = j+1; k <= j+5; k++) if (bars[k]!.dir !== 0 && bars[k]!.dir !== dir) rev5++;
    let rev30 = 0; for (let k = j+1; k <= j+30; k++) if (bars[k]!.dir !== 0 && bars[k]!.dir !== dir) rev30++;

    const sb = Math.min(s, 9);
    const bb = BODY3_BUCKETS.findIndex(([lo,hi]) => body3>=lo && body3<hi);
    const vb = PRIORVOL_BUCKETS.findIndex(([lo,hi]) => pv>=lo && pv<hi);
    const hr = new Date(bars[j]!.ts).getUTCHours();

    const k1 = key(sb, bb, vb);
    if (!cube[k1]) cube[k1] = newStat();
    const cell = cube[k1];
    cell.n++; cell.wr1 += next1Rev; cell.wr5sum += rev5; cell.wr30sum += rev30;
    for (const map of [byStreak, byBody3, byVol, byHour]) {
      const k2 = map === byStreak ? sb : map === byBody3 ? bb : map === byVol ? vb : hr;
      if (!map[k2]) map[k2] = newStat();
      map[k2].n++; map[k2].wr1 += next1Rev; map[k2].wr5sum += rev5; map[k2].wr30sum += rev30;
    }
  }

  // Build report.
  const M: string[] = [];
  M.push('# Arm-trigger pattern mining (BTC)');
  M.push('');
  M.push(`_Generated ${new Date().toISOString()}_ · ${a.days}d · trigger gate: streak≥${a.trigStreak} & body3≥\$${a.trigBody3}`);
  M.push('');
  M.push('For each bar that triggers arm, measure outcome of next 30 bars (=arm window 150min).');
  M.push('**WR1** = next bar reversed (single-bar fade hit). **rev/5** = of next 5 bars, how many reversed.');
  M.push('**rev/30** = of next 30 bars, how many reversed (chop intensity in armed window).');
  M.push('');

  const fmtStat = (st: Stat | undefined): string =>
    !st || st.n < 5 ? '—' : `n=${st.n} · WR1 ${(st.wr1/st.n*100).toFixed(1)}% · rev/5 ${(st.wr5sum/st.n).toFixed(2)} · rev/30 ${(st.wr30sum/st.n).toFixed(1)}`;

  M.push('## By trigger streak');
  M.push('');
  M.push('| streak | metric |');
  M.push('|---|---|');
  for (const s of streakBuckets) {
    M.push(`| ${s === 9 ? '9+' : s} | ${fmtStat(byStreak[s])} |`);
  }
  M.push('');

  M.push('## By trigger body3');
  M.push('');
  M.push('| body3 | metric |');
  M.push('|---|---|');
  BODY3_BUCKETS.forEach(([_,__,label], i) => {
    M.push(`| ${label} | ${fmtStat(byBody3[i])} |`);
  });
  M.push('');

  M.push('## By prior 1h vol');
  M.push('');
  M.push('| prior vol | metric |');
  M.push('|---|---|');
  PRIORVOL_BUCKETS.forEach(([_,__,label], i) => {
    M.push(`| ${label} | ${fmtStat(byVol[i])} |`);
  });
  M.push('');

  M.push('## By hour (UTC)');
  M.push('');
  M.push('| hour | metric |');
  M.push('|---|---|');
  for (let h = 0; h < 24; h++) {
    M.push(`| ${String(h).padStart(2,'0')}:00 | ${fmtStat(byHour[h])} |`);
  }
  M.push('');

  // Top patterns: filter to n>=20 (meaningful sample), rank by WR1 desc.
  M.push('## Top patterns — by single-bar reversal rate (n ≥ 20)');
  M.push('');
  M.push('| streak · body3 · priorVol | n | WR1 | rev/5 | rev/30 |');
  M.push('|---|---|---|---|---|');
  const rows = Object.entries(cube)
    .map(([k, st]) => {
      const [s,b,v] = k.split('|').map(Number);
      return { s, b, v, st };
    })
    .filter(r => r.st.n >= 20)
    .sort((a,b) => (b.st.wr1/b.st.n) - (a.st.wr1/a.st.n));
  for (const r of rows.slice(0, 20)) {
    const lbl = `${r.s === 9 ? '9+' : r.s} · ${BODY3_BUCKETS[r.b]?.[2] ?? '?'} · ${PRIORVOL_BUCKETS[r.v]?.[2] ?? '?'}`;
    M.push(`| ${lbl} | ${r.st.n} | **${(r.st.wr1/r.st.n*100).toFixed(1)}%** | ${(r.st.wr5sum/r.st.n).toFixed(2)} | ${(r.st.wr30sum/r.st.n).toFixed(1)} |`);
  }
  M.push('');

  // Worst patterns
  M.push('## Worst patterns (low WR1, n ≥ 20)');
  M.push('');
  M.push('| streak · body3 · priorVol | n | WR1 | rev/5 | rev/30 |');
  M.push('|---|---|---|---|---|');
  for (const r of rows.slice(-10).reverse()) {
    const lbl = `${r.s === 9 ? '9+' : r.s} · ${BODY3_BUCKETS[r.b]?.[2] ?? '?'} · ${PRIORVOL_BUCKETS[r.v]?.[2] ?? '?'}`;
    M.push(`| ${lbl} | ${r.st.n} | **${(r.st.wr1/r.st.n*100).toFixed(1)}%** | ${(r.st.wr5sum/r.st.n).toFixed(2)} | ${(r.st.wr30sum/r.st.n).toFixed(1)} |`);
  }
  M.push('');

  writeFileSync(a.out, M.join('\n') + '\n');
  console.error(`Wrote ${a.out}\n`);

  // Console summary
  console.error('=== By trigger streak ===');
  for (const s of streakBuckets) console.error(`  s=${s===9?'9+':s}: ${fmtStat(byStreak[s])}`);
  console.error('=== By body3 ===');
  BODY3_BUCKETS.forEach(([_,__,l], i) => console.error(`  ${l.padStart(10)}: ${fmtStat(byBody3[i])}`));
  console.error('=== By prior vol ===');
  PRIORVOL_BUCKETS.forEach(([_,__,l], i) => console.error(`  ${l.padStart(10)}: ${fmtStat(byVol[i])}`));
}

run().catch(e => { console.error(e); process.exit(1); });
