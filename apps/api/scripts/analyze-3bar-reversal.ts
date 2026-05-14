/**
 * Pull 5m BTCUSDT klines directly from Binance and analyze reversal
 * probability conditional on:
 *   - streak length (N consecutive same-direction bars ending at last closed bar)
 *   - sum of the LAST 3 bodies of that streak
 *
 * Reversal = the NEXT bar (the one we'd be betting on) closes in the
 * direction OPPOSITE to the streak.
 *
 * Usage:
 *   pnpm --filter @trading-bot/api exec tsx scripts/analyze-3bar-reversal.ts \
 *     [--days=365] [--futures] \
 *     [--streak=3,4,5,6] [--bucket=50] [--focus=250-300]
 *
 *   --days=N         days of history (default 365)
 *   --futures        use fapi (perp) instead of spot
 *   --streak=LIST    only analyse these streak lengths (default any ≥3)
 *   --bucket=N       bucket width in $ for body-sum histogram (default 50)
 *   --focus=LO-HI    print extra cross-tab of streak × this body-sum band
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
  futures: boolean;
  streaks: number[] | null;
  bucket: number;
  focus: { lo: number; hi: number } | null;
}

function parseArgs(): Args {
  let days = 365;
  let futures = false;
  let streaks: number[] | null = null;
  let bucket = 50;
  let focus: { lo: number; hi: number } | null = null;
  for (const a of process.argv.slice(2)) {
    if      (a.startsWith('--days='))    days = Number(a.slice(7));
    else if (a === '--futures')          futures = true;
    else if (a.startsWith('--streak='))  streaks = a.slice(9).split(',').map(Number);
    else if (a.startsWith('--bucket='))  bucket = Number(a.slice(9));
    else if (a.startsWith('--focus=')) {
      const [loS, hiS] = a.slice(8).split('-');
      focus = { lo: Number(loS), hi: Number(hiS) };
    }
    else if (a === '-h' || a === '--help') {
      console.log('usage: analyze-3bar-reversal.ts [--days=365] [--futures] [--streak=3,4,5,6] [--bucket=50] [--focus=250-300]');
      process.exit(0);
    } else { console.error(`unknown: ${a}`); process.exit(1); }
  }
  return { days, futures, streaks, bucket, focus };
}

interface Bar { ts: number; open: number; close: number; body: number; dir: 1|-1|0 }

async function fetchKlines(args: Args): Promise<Bar[]> {
  const base = args.futures ? 'https://fapi.binance.com/fapi/v1' : 'https://api.binance.com/api/v3';
  const sym = 'BTCUSDT', interval = '5m';
  const endMs = Date.now();
  const startMs = endMs - args.days * 86400_000;
  const all: Bar[] = [];
  let cursor = startMs;
  let pages = 0;
  while (cursor < endMs) {
    const url = `${base}/klines?symbol=${sym}&interval=${interval}&startTime=${cursor}&endTime=${endMs}&limit=1000`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Binance ${res.status}: ${(await res.text()).slice(0,200)}`);
    const rows = (await res.json()) as unknown[][];
    if (!rows.length) break;
    for (const r of rows) {
      const ts = Number(r[0]), open = Number(r[1]), close = Number(r[4]);
      const body = close - open;
      const dir: 1|-1|0 = body > 0 ? 1 : body < 0 ? -1 : 0;
      all.push({ ts, open, close, body, dir });
    }
    const lastTs = Number(rows[rows.length - 1]?.[0] ?? 0);
    if (lastTs <= cursor) break;
    cursor = lastTs + 1; pages++;
    if (pages % 10 === 0) process.stderr.write(`  fetched ${all.length} bars…\n`);
    await new Promise(r => setTimeout(r, 80));
  }
  return all;
}

async function main(): Promise<void> {
  const args = parseArgs();
  console.error(`Fetching ${args.days}d of BTC 5m bars from ${args.futures ? 'fapi' : 'api'}.binance.com …`);
  const bars = await fetchKlines(args);
  console.error(`Got ${bars.length} bars (${(bars.length / 288).toFixed(1)} days)\n`);

  // For each bar i, compute streak length ENDING at i (inclusive).
  // streakLen[i] = how many consecutive same-direction bars up to and including i.
  const streakLen = new Array<number>(bars.length).fill(0);
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    if (b.dir === 0) { streakLen[i] = 0; continue; }
    streakLen[i] = (i > 0 && bars[i-1]!.dir === b.dir) ? streakLen[i-1]! + 1 : 1;
  }

  // A sample = at index j (= bar we're trying to predict), look back: the
  // streak running up to j-1 has length S = streakLen[j-1]. The "last 3
  // bodies of the streak" are bars[j-3..j-1] (only valid if S ≥ 3 and same
  // direction throughout — guaranteed by streak definition).
  interface Sample { streak: number; body3: number; regime: 1|-1; reversed: boolean }
  const samples: Sample[] = [];
  for (let j = 3; j < bars.length; j++) {
    const s = streakLen[j-1]!;
    if (s < 3) continue;                  // need at least 3 to sum 3 bodies
    const next = bars[j]!;
    if (next.dir === 0) continue;         // skip doji predictions
    const regime = bars[j-1]!.dir;
    if (regime === 0) continue;
    const body3 = bars[j-3]!.body + bars[j-2]!.body + bars[j-1]!.body;
    samples.push({
      streak: s, body3,
      regime: regime as 1|-1,
      reversed: next.dir !== regime,
    });
  }

  console.log(`Total bars                          : ${bars.length}`);
  console.log(`Samples (streak ≥ 3, next non-doji) : ${samples.length}`);
  console.log(`Base reversal rate                  : ${(samples.filter(s=>s.reversed).length/samples.length*100).toFixed(2)}%`);
  console.log();

  // 1) Cross-tab: streak length × |body3| bucket → P(reversal).
  const targetStreaks = args.streaks ?? Array.from(new Set(samples.map(s => s.streak)))
    .filter(n => n >= 3 && n <= 12).sort((a,b)=>a-b);
  const buckets: Array<{ lo: number; hi: number; label: string }> = [];
  const maxBucket = 1000;
  for (let lo = 0; lo < maxBucket; lo += args.bucket) {
    buckets.push({ lo, hi: lo + args.bucket, label: `$${lo.toString().padStart(4,' ')}-${(lo+args.bucket).toString().padStart(4,' ')}` });
  }
  buckets.push({ lo: maxBucket, hi: Infinity, label: `≥$${maxBucket}` });

  console.log(`Cross-tab: P(reversal) by streak × |sum(last-3 body)| (bucket=${args.bucket}, sample-floor=20)`);
  const header = '| body |' + targetStreaks.map(s => ` streak=${s} `.padStart(15)).join('|') + '|';
  console.log(header);
  console.log('|' + '-'.repeat(header.length - 2) + '|');
  for (const b of buckets) {
    const cells: string[] = [];
    let nonEmpty = false;
    for (const s of targetStreaks) {
      const sub = samples.filter(x => x.streak === s && Math.abs(x.body3) >= b.lo && Math.abs(x.body3) < b.hi);
      if (sub.length < 20) { cells.push('    —   '.padStart(15)); continue; }
      nonEmpty = true;
      const p = sub.filter(x => x.reversed).length / sub.length;
      cells.push(`${(p*100).toFixed(1)}% (${sub.length})`.padStart(15));
    }
    if (nonEmpty) console.log(`| ${b.label.padStart(10)} |` + cells.join('|') + '|');
  }
  console.log();

  // 2) If --focus given, show stats for each streak in that band.
  if (args.focus) {
    const { lo, hi } = args.focus;
    console.log(`Focus band: |body3| in $${lo}–$${hi}`);
    console.log('| streak | samples | reversals | P(reversal) | 95% CI       |');
    console.log('|--------|---------|-----------|-------------|--------------|');
    for (const s of targetStreaks) {
      const sub = samples.filter(x => x.streak === s && Math.abs(x.body3) >= lo && Math.abs(x.body3) < hi);
      if (sub.length === 0) continue;
      const n = sub.length;
      const k = sub.filter(x => x.reversed).length;
      const p = k / n;
      // Wilson 95% CI
      const z = 1.96, denom = 1 + z*z/n;
      const centre = (p + z*z/(2*n)) / denom;
      const margin = z * Math.sqrt(p*(1-p)/n + z*z/(4*n*n)) / denom;
      const lo95 = Math.max(0, centre - margin) * 100;
      const hi95 = Math.min(1, centre + margin) * 100;
      console.log(
        `|   ${String(s).padStart(2)}   | ${String(n).padStart(7)} | ${String(k).padStart(9)} |    ${(p*100).toFixed(2).padStart(5)}%  | ${lo95.toFixed(1)}% – ${hi95.toFixed(1)}%${(lo95.toFixed(1)+hi95.toFixed(1)).length < 8 ? ' ' : ''} |`
      );
    }
  }
}

main().catch(err => { console.error(err); process.exit(1); });
