/**
 * For setups where the streak is likely to CONTINUE (low reversal prob),
 * is there a sub-pattern that predicts continuation more reliably?
 *
 * Tests two hypotheses:
 *   H1: accelerating bodies (b1 < b2 < b3) → continuation higher
 *   H2: last body bigger than streak average → continuation higher
 *
 * For each (streak, body3 bucket), splits samples into:
 *   - accel (b1 < b2 < b3)
 *   - decel (b1 > b2 > b3)
 *   - flat / mixed
 *   - last-larger (|b3| > avg|streak body|)
 *
 * Usage:
 *   pnpm --filter @trading-bot/api exec tsx scripts/analyze-continuation-shape.ts \
 *     [--days=365] [--streak=5,6] [--body=250-350]
 */
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config({
  path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.env'),
  override: true,
});

interface Args { days: number; streaks: number[]; body: { lo: number; hi: number } | null }

function parseArgs(): Args {
  let days = 365; let streaks = [5, 6]; let body: Args['body'] = null;
  for (const a of process.argv.slice(2)) {
    if      (a.startsWith('--days='))   days = Number(a.slice(7));
    else if (a.startsWith('--streak=')) streaks = a.slice(9).split(',').map(Number);
    else if (a.startsWith('--body='))   { const [lo, hi] = a.slice(7).split('-').map(Number); body = { lo: lo!, hi: hi! }; }
    else if (a === '-h')                { console.log('usage: ... [--days=N] [--streak=5,6] [--body=250-350]'); process.exit(0); }
  }
  return { days, streaks, body };
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
  streak: number;
  body3:  number;          // signed
  b1: number; b2: number; b3: number; // signed last-3 of streak
  streakAvgBody: number;   // avg |body| across whole streak
  regime: 1|-1;
  reversed: boolean;       // next bar opposite to regime
  continued: boolean;      // next bar same as regime (non-doji)
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

  // Compute streak ending at each i.
  const streakLen = new Array<number>(bars.length).fill(0);
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    if (b.dir === 0) { streakLen[i] = 0; continue; }
    streakLen[i] = (i > 0 && bars[i-1]!.dir === b.dir) ? streakLen[i-1]! + 1 : 1;
  }

  // Build samples.
  const samples: Sample[] = [];
  for (let j = 6; j < bars.length; j++) {
    const s = streakLen[j-1]!;
    if (s < 3) continue;
    const next = bars[j]!;
    const regime = bars[j-1]!.dir;
    if (regime === 0 || next.dir === 0) continue;
    const b3 = bars[j-1]!.body, b2 = bars[j-2]!.body, b1 = bars[j-3]!.body;
    // Average |body| over entire streak.
    let sumAbs = 0;
    for (let k = j - s; k < j; k++) sumAbs += Math.abs(bars[k]!.body);
    const streakAvgBody = sumAbs / s;
    samples.push({
      streak: s, body3: b1+b2+b3, b1, b2, b3,
      streakAvgBody,
      regime: regime as 1|-1,
      reversed: next.dir !== regime,
      continued: next.dir === regime,
    });
  }

  // Filter to requested streak lengths + body band.
  const subset = samples.filter(s =>
    args.streaks.includes(s.streak) &&
    (args.body == null || (Math.abs(s.body3) >= args.body.lo && Math.abs(s.body3) < args.body.hi))
  );
  console.log(`Filter: streak in [${args.streaks.join(',')}]` +
    (args.body ? `  AND  |body3| in $${args.body.lo}-$${args.body.hi}` : '  (any body)'));
  console.log(`Total samples in filter            : ${subset.length}`);
  console.log(`Base continuation rate (filtered)  : ${(subset.filter(s=>s.continued).length/subset.length*100).toFixed(2)}%`);
  console.log();

  // Helper: given a list of samples, print P(continuation) + CI.
  function row(label: string, items: Sample[]): string {
    const n = items.length;
    const k = items.filter(x => x.continued).length;
    if (n === 0) return `${label.padEnd(36)} | ${'—'.padStart(7)} |`;
    const p = k / n;
    const [lo, hi] = wilsonCI(k, n);
    return `${label.padEnd(36)} | ${String(n).padStart(5)} | ${String(k).padStart(5)} | ${(p*100).toFixed(2).padStart(6)}%  | ${lo.toFixed(1)}% – ${hi.toFixed(1).padStart(4)}% |`;
  }

  console.log('| pattern                              |     n |  cont |  P(cont) | 95% CI       |');
  console.log('|--------------------------------------|-------|-------|----------|--------------|');
  console.log(row('all in filter',                                          subset));

  // H1: shape of last 3 (b1, b2, b3 magnitudes), in regime direction.
  // Normalise to absolute since regime sign is known.
  const accel = subset.filter(s => Math.abs(s.b3) > Math.abs(s.b2) && Math.abs(s.b2) > Math.abs(s.b1));
  const decel = subset.filter(s => Math.abs(s.b3) < Math.abs(s.b2) && Math.abs(s.b2) < Math.abs(s.b1));
  const vShape = subset.filter(s => Math.abs(s.b2) < Math.abs(s.b1) && Math.abs(s.b2) < Math.abs(s.b3));
  const invV   = subset.filter(s => Math.abs(s.b2) > Math.abs(s.b1) && Math.abs(s.b2) > Math.abs(s.b3));
  console.log(row('  H1: accelerating (b1<b2<b3)',                          accel));
  console.log(row('  H1: decelerating (b1>b2>b3)',                          decel));
  console.log(row('  H1: V-shape (b2 smallest)',                            vShape));
  console.log(row('  H1: invV / peak (b2 biggest)',                         invV));

  // H2: last body vs streak average.
  const lastBig   = subset.filter(s => Math.abs(s.b3) > s.streakAvgBody * 1.5);
  const lastSmall = subset.filter(s => Math.abs(s.b3) < s.streakAvgBody * 0.5);
  const lastMid   = subset.filter(s => Math.abs(s.b3) >= s.streakAvgBody * 0.5 && Math.abs(s.b3) <= s.streakAvgBody * 1.5);
  console.log(row('  H2: last body > 1.5× streak avg',                      lastBig));
  console.log(row('  H2: last body 0.5×-1.5× avg (steady)',                 lastMid));
  console.log(row('  H2: last body < 0.5× streak avg',                      lastSmall));

  // Combo: accel AND last big.
  const comboStrong   = subset.filter(s =>
    Math.abs(s.b3) > Math.abs(s.b2) && Math.abs(s.b2) > Math.abs(s.b1) &&
    Math.abs(s.b3) > s.streakAvgBody * 1.2);
  const comboTired = subset.filter(s =>
    Math.abs(s.b3) < Math.abs(s.b2) && Math.abs(s.b3) < s.streakAvgBody * 0.7);
  console.log(row('  combo: accel + last>1.2× avg',                         comboStrong));
  console.log(row('  combo: decel + last<0.7× avg',                         comboTired));
}

main().catch(err => { console.error(err); process.exit(1); });
