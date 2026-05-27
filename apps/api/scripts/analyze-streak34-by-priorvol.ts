/**
 * Test the hypothesis: "after large surges/drops, BTC tends to sideways with
 * many streak3/4 patterns" — and crucially, do these streak3/4 edge fires
 * still reverse well in that post-large-move regime, or do they chop and lose?
 *
 * For each bar j where streak[j-1] ∈ {3, 4} and body3 ≥ edge.body3Min (live
 * config: 440 / 420 respectively), compute the PRIOR 1h volatility (sum of
 * |body| over the preceding 12 bars). Bucket the fires by prior-vol. Within
 * each bucket, compute reversal % (single-bar fade hit rate, no DCA).
 *
 * Usage:
 *   pnpm --filter @trading-bot/api exec tsx scripts/analyze-streak34-by-priorvol.ts \
 *     [--days=365] [--s3-body3=440] [--s4-body3=420]
 */
import { writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

interface Args { days: number; s3Body: number; s4Body: number; out: string }
function parseArgs(): Args {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const a: Args = { days: 365, s3Body: 440, s4Body: 420, out: path.join(here, 'results', 'analyze-streak34-by-priorvol.md') };
  for (const arg of process.argv.slice(2)) {
    const eq = arg.indexOf('='); if (eq < 0) continue;
    const k = arg.slice(2, eq), v = arg.slice(eq + 1);
    if (k === 'days') a.days = Number(v);
    else if (k === 's3-body3') a.s3Body = Number(v);
    else if (k === 's4-body3') a.s4Body = Number(v);
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

// prior 1h vol buckets (sum |body| over preceding 12 bars, USD).
const VOL_BUCKETS: Array<[number, number, string]> = [
  [0,     400,  'calm <400'],
  [400,   700,  'mid 400-700'],
  [700,   1200, 'high 700-1200'],
  [1200,  2000, 'very-high 1.2-2k'],
  [2000,  1e9,  'extreme ≥2k'],
];

interface Cell { n: number; rev: number; sumPrior: number }

async function run(): Promise<void> {
  const a = parseArgs();
  console.error(`Fetching ${a.days}d BTCUSDT 5m bars…`);
  const bars = await fetchKlines(a.days);
  console.error(`Got ${bars.length} bars (${(bars.length/288).toFixed(0)}d)\n`);

  // Streak length array.
  const streak = new Array<number>(bars.length).fill(0);
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    if (b.dir === 0) { streak[i] = 0; continue; }
    streak[i] = (i > 0 && bars[i-1]!.dir === b.dir) ? streak[i-1]! + 1 : 1;
  }

  // Loop: for each bar j where streak[j-1] ∈ {3,4} AND body3≥edge.body3Min,
  // record (priorVol12, reversed).
  // grids[streak][bucket] = Cell
  const grid: Record<3|4, Cell[]> = {
    3: VOL_BUCKETS.map(() => ({ n: 0, rev: 0, sumPrior: 0 })),
    4: VOL_BUCKETS.map(() => ({ n: 0, rev: 0, sumPrior: 0 })),
  };
  // Also: per-streak totals (no bucketing).
  const totals: Record<3|4, Cell> = {
    3: { n: 0, rev: 0, sumPrior: 0 },
    4: { n: 0, rev: 0, sumPrior: 0 },
  };
  // Sample distribution: prior vol histogram across ALL bars j (not just edge fires).
  const allBarVol: Cell[] = VOL_BUCKETS.map(() => ({ n: 0, rev: 0, sumPrior: 0 }));

  for (let j = 13; j + 1 < bars.length; j++) {
    // prior 1h vol = sum |body| of bars [j-13, j-1) — i.e., 12 bars BEFORE the
    // 3-bar streak that ends at j-1.
    let priorVol = 0;
    for (let k = j - 13; k < j - 1; k++) {
      priorVol += Math.abs(bars[k]!.close - bars[k]!.open);
    }
    // Track distribution of priorVol across ALL bars (denominator for "how often
    // is X regime") — bucket the regime.
    const rb = bucket(priorVol);
    allBarVol[rb]!.n++;

    const s = streak[j-1]!;
    if (s !== 3 && s !== 4) continue;
    const body3 = Math.abs(bars[j-1]!.close - bars[j-1]!.open)
                + Math.abs(bars[j-2]!.close - bars[j-2]!.open)
                + Math.abs(bars[j-3]!.close - bars[j-3]!.open);
    const bodyMin = s === 3 ? a.s3Body : a.s4Body;
    if (body3 < bodyMin) continue;

    const regime = bars[j-1]!.dir;
    if (regime === 0) continue;
    const betDir = regime === 1 ? -1 : 1;
    const reversed = bars[j]!.dir === betDir;

    grid[s][rb]!.n++;
    grid[s][rb]!.sumPrior += priorVol;
    if (reversed) grid[s][rb]!.rev++;
    totals[s].n++;
    totals[s].sumPrior += priorVol;
    if (reversed) totals[s].rev++;
  }

  // Build report.
  const M: string[] = [];
  M.push('# Streak 3/4 edge-fire reversal % by prior 1h vol (BTC)');
  M.push('');
  M.push(`_Generated ${new Date().toISOString()}_ · ${a.days}d · ${bars.length} bars (${(bars.length/288).toFixed(0)}d) · entries gated by s3≥\$${a.s3Body}, s4≥\$${a.s4Body}`);
  M.push('');
  M.push('Tests the user observation: "after big surges/drops BTC sideways with lots of streak3/4."');
  M.push('Prior 1h vol = sum |body| of the 12 bars BEFORE the 3-bar streak window (i.e., the regime');
  M.push('before this fade setup forms). Compares fade reversal-rate across vol regimes.');
  M.push('');

  M.push('## Universe — % of ALL bars in each prior-1h-vol regime');
  M.push('');
  M.push('| regime | bars | % of total |');
  M.push('|---|---|---|');
  const allTot = allBarVol.reduce((a,c)=>a+c.n,0);
  VOL_BUCKETS.forEach(([_,__,label], i) => {
    const c = allBarVol[i]!;
    M.push(`| ${label} | ${c.n} | ${(c.n/allTot*100).toFixed(1)}% |`);
  });
  M.push('');

  for (const s of [3, 4] as const) {
    M.push(`## Streak=${s} edge fires (body3 ≥ \$${s === 3 ? a.s3Body : a.s4Body})`);
    M.push('');
    M.push('| prior 1h vol | n | reversal WR | avg prior vol |');
    M.push('|---|---|---|---|');
    VOL_BUCKETS.forEach(([_,__,label], i) => {
      const c = grid[s][i]!;
      if (c.n < 5) {
        M.push(`| ${label} | ${c.n} | — (n<5) | — |`);
      } else {
        M.push(`| ${label} | ${c.n} | **${(c.rev/c.n*100).toFixed(1)}%** | $${(c.sumPrior/c.n).toFixed(0)} |`);
      }
    });
    const t = totals[s];
    M.push(`| **all** | ${t.n} | **${(t.rev/t.n*100).toFixed(1)}%** | $${(t.sumPrior/t.n).toFixed(0)} |`);
    M.push('');
  }

  // Console summary.
  console.error('streak | regime               | n    | WR%    | avg prior vol');
  for (const s of [3, 4] as const) {
    VOL_BUCKETS.forEach(([_,__,label], i) => {
      const c = grid[s][i]!;
      if (c.n < 5) console.error(`  s=${s}  | ${label.padEnd(20)} | ${String(c.n).padStart(4)} | —`);
      else console.error(`  s=${s}  | ${label.padEnd(20)} | ${String(c.n).padStart(4)} | ${(c.rev/c.n*100).toFixed(1).padStart(5)}% | $${(c.sumPrior/c.n).toFixed(0)}`);
    });
    const t = totals[s];
    console.error(`  s=${s}  | ${'ALL'.padEnd(20)} | ${String(t.n).padStart(4)} | ${(t.rev/t.n*100).toFixed(1).padStart(5)}%`);
  }

  writeFileSync(a.out, M.join('\n') + '\n');
  console.error(`\nWrote ${a.out}`);
}

function bucket(v: number): number {
  for (let i = 0; i < VOL_BUCKETS.length; i++)
    if (v >= VOL_BUCKETS[i]![0] && v < VOL_BUCKETS[i]![1]) return i;
  return VOL_BUCKETS.length - 1;
}

run().catch(e => { console.error(e); process.exit(1); });
