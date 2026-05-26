/**
 * Deep analysis: raw single-bar REVERSAL RATE as a function of
 * (streak length × body3 bucket) for BTC 5m bars.
 *
 * Purpose: test the hypothesis "longer streak → can accept a smaller body3"
 * (i.e. should the body3 floor scale DOWN as streak grows?). This isolates the
 * pure placement edge: at a closed streak of length L with a given body3
 * (sum |body| of the 3 streak-aligned closing bars), what is P(next bar
 * reverses)? No DCA, no arm gating — just the one-shot fade hit rate.
 *
 * A fade is "won" if the NEXT bar closes opposite to the streak direction.
 * Break-even WR at a flat entry e is e (win pays 1-e, loss costs e). Live
 * limit entries are below $0.55 so true break-even is lower; raw reversal %
 * is reported so you can apply your own entry assumption.
 *
 * Usage:
 *   pnpm --filter @trading-bot/api exec tsx scripts/analyze-body3-by-streak.ts \
 *     [--days=365] [--out=scripts/analyze-body3-by-streak.md]
 */
import { writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

interface Args { days: number; out: string }
function parseArgs(): Args {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const a: Args = { days: 365, out: path.join(here, 'results', 'analyze-body3-by-streak.md') };
  for (const arg of process.argv.slice(2)) {
    const eq = arg.indexOf('='); if (eq < 0) continue;
    const k = arg.slice(2, eq), v = arg.slice(eq + 1);
    if (k === 'days') a.days = Number(v);
    else if (k === 'out') a.out = path.isAbsolute(v) ? v : path.join(here, v);
    else { console.error(`unknown arg: --${k}`); process.exit(1); }
  }
  return a;
}

interface Bar { ts: number; open: number; close: number; dir: 1|-1|0 }
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
      all.push({ ts, open, close, dir: close > open ? 1 : close < open ? -1 : 0 });
    }
    const lastTs = Number(rows[rows.length-1]?.[0] ?? 0);
    if (lastTs <= cursor) break;
    cursor = lastTs + 1; pages++;
    if (pages % 10 === 0) process.stderr.write(`  fetched ${all.length} bars…\n`);
    await new Promise(r => setTimeout(r, 80));
  }
  return all;
}

// body3 buckets (USD). Upper bound exclusive; last is open-ended.
const BUCKETS: Array<[number, number, string]> = [
  [0,   100,  '0-100'],
  [100, 200,  '100-200'],
  [200, 300,  '200-300'],
  [300, 400,  '300-400'],
  [400, 500,  '400-500'],
  [500, 700,  '500-700'],
  [700, 1e9,  '700+'],
];
function bucketOf(b3: number): number {
  for (let i = 0; i < BUCKETS.length; i++) if (b3 >= BUCKETS[i]![0] && b3 < BUCKETS[i]![1]) return i;
  return BUCKETS.length - 1;
}

interface Cell { n: number; rev: number }   // rev = reversal count
const STREAKS = [2,3,4,5,6,7,8,9,10];        // rows we report

async function run(): Promise<void> {
  const a = parseArgs();
  console.error(`Fetching ${a.days}d of BTCUSDT 5m bars…`);
  const bars = await fetchKlines(a.days);
  console.error(`Got ${bars.length} bars (${(bars.length/288).toFixed(1)} days)\n`);

  const streakLen = new Array<number>(bars.length).fill(0);
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    if (b.dir === 0) { streakLen[i] = 0; continue; }
    streakLen[i] = (i > 0 && bars[i-1]!.dir === b.dir) ? streakLen[i-1]! + 1 : 1;
  }

  // grid[streak][bucket] = Cell ; also keep per-streak totals + raw body3 samples
  const grid: Record<number, Cell[]> = {};
  const totalByStreak: Record<number, Cell> = {};
  const samples: Record<number, Array<{ b3: number; rev: boolean }>> = {};
  for (const s of STREAKS) {
    grid[s] = BUCKETS.map(() => ({ n: 0, rev: 0 }));
    totalByStreak[s] = { n: 0, rev: 0 };
    samples[s] = [];
  }

  for (let j = 3; j + 1 < bars.length; j++) {
    const s = streakLen[j-1]!;
    const regime = bars[j-1]!.dir;
    if (regime === 0 || s < 2) continue;
    const sk = s >= 10 ? 10 : s;            // bucket 10+ into row 10
    if (!grid[sk]) continue;
    const body3 = Math.abs(bars[j-1]!.close - bars[j-1]!.open)
                + Math.abs(bars[j-2]!.close - bars[j-2]!.open)
                + Math.abs(bars[j-3]!.close - bars[j-3]!.open);
    const betDir = regime === 1 ? -1 : 1;
    const reversed = bars[j]!.dir === betDir;   // next bar closed opposite → fade wins
    const bi = bucketOf(body3);
    grid[sk]![bi]!.n++; if (reversed) grid[sk]![bi]!.rev++;
    totalByStreak[sk]!.n++; if (reversed) totalByStreak[sk]!.rev++;
    samples[sk]!.push({ b3: body3, rev: reversed });
  }

  // For each streak, the minimum body3 floor to reach a target reversal rate.
  // Sweep candidate floors; pick lowest floor where reversal% over samples with
  // body3>=floor meets target AND sample size >= 25.
  const FLOORS = [0,50,100,150,200,250,300,350,400,450,500,600,700,800];
  const TARGETS = [0.55, 0.58, 0.60];
  function minFloorFor(s: number, target: number): { floor: number; wr: number; n: number } | null {
    let best: { floor: number; wr: number; n: number } | null = null;
    for (const f of FLOORS) {
      const sub = samples[s]!.filter(x => x.b3 >= f);
      if (sub.length < 25) continue;
      const wr = sub.filter(x => x.rev).length / sub.length;
      if (wr >= target) { best = { floor: f, wr, n: sub.length }; break; }
    }
    return best;
  }

  const M: string[] = [];
  M.push('# Body3 floor by streak — reversal-rate analysis (BTC)');
  M.push('');
  M.push(`_Generated ${new Date().toISOString()}_ · ${a.days}d · ${bars.length} bars (${(bars.length/288).toFixed(0)}d)`);
  M.push('');
  M.push('Single-bar fade hit rate: at a closed streak of length L with body3 = sum|body| of');
  M.push('the 3 streak-aligned closing bars, P(next bar closes opposite). No DCA / no arm gating.');
  M.push('Break-even WR at flat $0.55 entry = 55%; real limit entries are lower so true break-even is below that.');
  M.push('');

  // ── Table 1: reversal % by streak × body3 bucket ──
  M.push('## Reversal % by streak × body3 bucket  — `WR% (n)`');
  M.push('');
  M.push('| streak \\ body3 | ' + BUCKETS.map(b => b[2]).join(' | ') + ' | **all** |');
  M.push('|' + '---|'.repeat(BUCKETS.length + 2));
  for (const s of STREAKS) {
    const label = s === 10 ? '10+' : String(s);
    const cells = grid[s]!.map(c => c.n === 0 ? '—' : `${(c.rev/c.n*100).toFixed(0)} (${c.n})`);
    const tot = totalByStreak[s]!;
    const totCell = tot.n === 0 ? '—' : `**${(tot.rev/tot.n*100).toFixed(0)} (${tot.n})**`;
    M.push(`| **${label}** | ${cells.join(' | ')} | ${totCell} |`);
  }
  M.push('');
  M.push('_Cells with n<25 are noise — ignore. Read DOWN a column to see if a fixed body3 band');
  M.push('improves with streak; read ACROSS a row to see body3 dependence at a fixed streak._');
  M.push('');

  // ── Table 2: minimum body3 floor to hit targets ──
  M.push('## Minimum body3 floor to reach a reversal target (n≥25)');
  M.push('');
  M.push('| streak | base WR% (n) | ≥55% needs | ≥58% needs | ≥60% needs |');
  M.push('|---|---|---|---|---|');
  for (const s of STREAKS) {
    const label = s === 10 ? '10+' : String(s);
    const tot = totalByStreak[s]!;
    const base = tot.n === 0 ? '—' : `${(tot.rev/tot.n*100).toFixed(1)} (${tot.n})`;
    const cells = TARGETS.map(t => {
      const r = minFloorFor(s, t);
      return r ? `≥$${r.floor} → ${(r.wr*100).toFixed(0)}% (n=${r.n})` : '—';
    });
    M.push(`| **${label}** | ${base} | ${cells[0]} | ${cells[1]} | ${cells[2]} |`);
  }
  M.push('');
  M.push('_"≥$X → Y% (n)" = lowest floor whose body3≥X subset hits the target; "—" = unreachable with n≥25._');
  M.push('');

  const md = M.join('\n') + '\n';
  writeFileSync(a.out, md);
  console.error(`Wrote ${a.out}\n`);

  // Console: compact reversal grid
  console.error('streak | ' + BUCKETS.map(b => b[2].padStart(9)).join(' | ') + ' |   all');
  for (const s of STREAKS) {
    const label = (s === 10 ? '10+' : String(s)).padStart(6);
    const cells = grid[s]!.map(c => (c.n === 0 ? '—' : `${(c.rev/c.n*100).toFixed(0)}(${c.n})`).padStart(9));
    const tot = totalByStreak[s]!;
    const totStr = tot.n === 0 ? '—' : `${(tot.rev/tot.n*100).toFixed(0)}(${tot.n})`;
    console.error(`${label} | ${cells.join(' | ')} | ${totStr}`);
  }
}

run().catch(err => { console.error(err); process.exit(1); });
