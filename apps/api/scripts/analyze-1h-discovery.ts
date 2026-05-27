/**
 * BTC 1h discovery — strategy calibration from scratch.
 *
 * 1h candles have a very different USD scale than 5m. A typical 5m BTC body
 * is ~$50-200, a 1h body is ~$300-2000. Cannot reuse 5m body3 thresholds
 * (400/700/etc). Need a fresh look at:
 *
 *   (1) body3 distribution — what are the natural quartile/decile buckets?
 *   (2) per-streak base reversal rate — does the same "flat ~50-55%, streak
 *       doesn't predict reversal" pattern from 5m hold at 1h?
 *   (3) per-(streak × body3) reversal grid — sweet spots, traps
 *   (4) momentum lifetime — at high body3 streak=N, when does it exhaust?
 *
 * Output: results/analyze-1h-discovery.md
 *
 * Usage:
 *   pnpm --filter @trading-bot/api exec tsx scripts/analyze-1h-discovery.ts [--days=365]
 */
import { writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

interface Args { days: number; out: string }
function parseArgs(): Args {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const a: Args = { days: 365, out: path.join(here, 'results', 'analyze-1h-discovery.md') };
  for (const arg of process.argv.slice(2)) {
    const eq = arg.indexOf('='); if (eq < 0) continue;
    const k = arg.slice(2, eq), v = arg.slice(eq + 1);
    if (k === 'days') a.days = Number(v);
    else if (k === 'out') a.out = path.isAbsolute(v) ? v : path.join(here, v);
  }
  return a;
}

interface Bar { ts: number; open: number; close: number; dir: 1|-1|0 }
async function fetchKlines1h(days: number): Promise<Bar[]> {
  const endMs = Date.now(), startMs = endMs - days * 86400_000;
  const all: Bar[] = []; let cursor = startMs;
  while (cursor < endMs) {
    const url = `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h&startTime=${cursor}&endTime=${endMs}&limit=1000`;
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

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[idx]!;
}

async function run(): Promise<void> {
  const a = parseArgs();
  console.error(`Fetching ${a.days}d BTCUSDT 1h bars…`);
  const bars = await fetchKlines1h(a.days);
  console.error(`Got ${bars.length} bars (${(bars.length/24).toFixed(0)}d) — ${(bars.length/(a.days)).toFixed(1)}/day\n`);

  // ── Streak length array ─────────────────────────────────────────────────
  const streak = new Array<number>(bars.length).fill(0);
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    if (b.dir === 0) { streak[i] = 0; continue; }
    streak[i] = (i > 0 && bars[i-1]!.dir === b.dir) ? streak[i-1]! + 1 : 1;
  }

  // ── (1) Body3 distribution ──────────────────────────────────────────────
  const body3s: number[] = [];
  for (let i = 2; i < bars.length; i++) {
    body3s.push(Math.abs(bars[i]!.close - bars[i]!.open)
              + Math.abs(bars[i-1]!.close - bars[i-1]!.open)
              + Math.abs(bars[i-2]!.close - bars[i-2]!.open));
  }
  const sorted = [...body3s].sort((a,b) => a-b);
  const dist = {
    p10:  quantile(sorted, 0.10),
    p25:  quantile(sorted, 0.25),
    p50:  quantile(sorted, 0.50),
    p75:  quantile(sorted, 0.75),
    p90:  quantile(sorted, 0.90),
    p95:  quantile(sorted, 0.95),
    p99:  quantile(sorted, 0.99),
    max:  sorted[sorted.length - 1] ?? 0,
    mean: body3s.reduce((s,x)=>s+x,0) / body3s.length,
  };

  // Pick buckets from quantiles for the reversal grid
  const BUCKETS: Array<[number, number, string]> = [
    [0, dist.p10, `<$${dist.p10.toFixed(0)} (p10)`],
    [dist.p10, dist.p25, `$${dist.p10.toFixed(0)}-${dist.p25.toFixed(0)} (p10-25)`],
    [dist.p25, dist.p50, `$${dist.p25.toFixed(0)}-${dist.p50.toFixed(0)} (p25-50)`],
    [dist.p50, dist.p75, `$${dist.p50.toFixed(0)}-${dist.p75.toFixed(0)} (p50-75)`],
    [dist.p75, dist.p90, `$${dist.p75.toFixed(0)}-${dist.p90.toFixed(0)} (p75-90)`],
    [dist.p90, dist.p99, `$${dist.p90.toFixed(0)}-${dist.p99.toFixed(0)} (p90-99)`],
    [dist.p99, 1e10, `≥$${dist.p99.toFixed(0)} (top 1%)`],
  ];

  function bucketOf(v: number): number {
    for (let i = 0; i < BUCKETS.length; i++) if (v >= BUCKETS[i]![0] && v < BUCKETS[i]![1]) return i;
    return BUCKETS.length - 1;
  }

  // ── (2) Per-streak base reversal + count ────────────────────────────────
  const STREAKS = [2,3,4,5,6,7,8,9,10];
  const totalByStreak: Record<number, { n: number; rev: number }> = {};
  const gridByStreak: Record<number, Array<{ n: number; rev: number }>> = {};
  for (const s of STREAKS) {
    totalByStreak[s] = { n: 0, rev: 0 };
    gridByStreak[s] = BUCKETS.map(() => ({ n: 0, rev: 0 }));
  }

  for (let j = 3; j + 1 < bars.length; j++) {
    const s = streak[j-1]!;
    const regime = bars[j-1]!.dir;
    if (regime === 0 || s < 2) continue;
    const sk = s >= 10 ? 10 : s;
    if (!totalByStreak[sk]) continue;
    const body3 = Math.abs(bars[j-1]!.close - bars[j-1]!.open)
                + Math.abs(bars[j-2]!.close - bars[j-2]!.open)
                + Math.abs(bars[j-3]!.close - bars[j-3]!.open);
    const betDir = regime === 1 ? -1 : 1;
    const reversed = bars[j]!.dir === betDir;
    const bi = bucketOf(body3);
    gridByStreak[sk]![bi]!.n++; if (reversed) gridByStreak[sk]![bi]!.rev++;
    totalByStreak[sk]!.n++; if (reversed) totalByStreak[sk]!.rev++;
  }

  // ── Build report ────────────────────────────────────────────────────────
  const M: string[] = [];
  M.push('# BTC 1h discovery (strategy calibration)');
  M.push('');
  M.push(`_Generated ${new Date().toISOString()}_ · ${a.days}d · ${bars.length} bars · interval=1h`);
  M.push('');

  M.push('## (1) Body3 distribution (1h bars, sum |body| over 3 consecutive bars)');
  M.push('');
  M.push('| quantile | body3 ($) |');
  M.push('|---|---|');
  M.push(`| p10  | $${dist.p10.toFixed(0)} |`);
  M.push(`| p25  | $${dist.p25.toFixed(0)} |`);
  M.push(`| p50 (median) | $${dist.p50.toFixed(0)} |`);
  M.push(`| p75  | $${dist.p75.toFixed(0)} |`);
  M.push(`| p90  | $${dist.p90.toFixed(0)} |`);
  M.push(`| p95  | $${dist.p95.toFixed(0)} |`);
  M.push(`| p99  | $${dist.p99.toFixed(0)} |`);
  M.push(`| max  | $${dist.max.toFixed(0)} |`);
  M.push(`| mean | $${dist.mean.toFixed(0)} |`);
  M.push('');
  M.push('5m comparison: 5m body3 typical p50 ≈ $150, p75 ≈ $300, p95 ≈ $700.');
  M.push(`1h scale factor vs 5m p50: ${(dist.p50 / 150).toFixed(1)}× — body3 thresholds must scale up by ~this much.`);
  M.push('');

  M.push('## (2) Per-streak reversal rate (single-bar fade hit rate)');
  M.push('');
  M.push('| streak | n total | base WR |');
  M.push('|---|---|---|');
  for (const s of STREAKS) {
    const t = totalByStreak[s]!;
    if (t.n === 0) { M.push(`| ${s === 10 ? '10+' : s} | 0 | — |`); continue; }
    M.push(`| **${s === 10 ? '10+' : s}** | ${t.n} | ${(t.rev/t.n*100).toFixed(1)}% |`);
  }
  M.push('');

  M.push('## (3) Reversal grid (streak × body3 bucket) — `WR% (n)`');
  M.push('');
  M.push('| streak \\ body3 | ' + BUCKETS.map(b => b[2]).join(' | ') + ' | **all** |');
  M.push('|' + '---|'.repeat(BUCKETS.length + 2));
  for (const s of STREAKS) {
    const label = s === 10 ? '10+' : String(s);
    const cells = gridByStreak[s]!.map(c => c.n === 0 ? '—' : `${(c.rev/c.n*100).toFixed(0)} (${c.n})`);
    const tot = totalByStreak[s]!;
    const totCell = tot.n === 0 ? '—' : `**${(tot.rev/tot.n*100).toFixed(0)} (${tot.n})**`;
    M.push(`| **${label}** | ${cells.join(' | ')} | ${totCell} |`);
  }
  M.push('');
  M.push('_Cells with n<5 are noise — ignore._');
  M.push('');

  writeFileSync(a.out, M.join('\n') + '\n');
  console.error(`Wrote ${a.out}\n`);

  // Console summary
  console.error('=== body3 distribution ===');
  for (const [q, v] of Object.entries(dist)) {
    console.error(`  ${q.padStart(5)}: $${(v as number).toFixed(0)}`);
  }
  console.error('\n=== per-streak base WR ===');
  for (const s of STREAKS) {
    const t = totalByStreak[s]!;
    const wr = t.n > 0 ? (t.rev/t.n*100).toFixed(1) : '—';
    console.error(`  streak ${String(s === 10 ? '10+' : s).padStart(3)}: n=${String(t.n).padStart(4)} WR=${wr}%`);
  }
  console.error('\n=== reversal grid (streak × body3 quantile) ===');
  console.error('  s | ' + BUCKETS.map(b => b[2].padStart(15)).join(' | ') + ' | all');
  for (const s of STREAKS) {
    const cells = gridByStreak[s]!.map(c => (c.n === 0 ? '—' : `${(c.rev/c.n*100).toFixed(0)}(${c.n})`).padStart(15));
    const tot = totalByStreak[s]!;
    const totStr = tot.n === 0 ? '—' : `${(tot.rev/tot.n*100).toFixed(0)}(${tot.n})`;
    console.error(`  ${String(s === 10 ? '10+' : s).padStart(2)}| ${cells.join(' | ')} | ${totStr}`);
  }
}

run().catch(e => { console.error(e); process.exit(1); });
