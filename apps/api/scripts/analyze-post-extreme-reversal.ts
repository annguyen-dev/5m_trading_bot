/**
 * Test the hypothesis: "streak=2 reversals don't cluster by hour-of-day —
 * they cluster after recent extreme streaks (≥6)."
 *
 * Method:
 *   1. Fetch 60 days of 5m bars per coin.
 *   2. Walk bars, track BOTH:
 *      (a) running streak length
 *      (b) `lastExtremeAtIdx` = index of the last bar that completed an
 *          extreme streak (run length ≥ EXTREME_THRESHOLD)
 *   3. For each "streak=2 event" (= a bar that just made the streak hit 2):
 *      record `barsSinceExtreme = i - lastExtremeAtIdx` (∞ if no prior extreme)
 *      and the next bar's outcome (continuation/reversal/doji).
 *   4. Bucket by `barsSinceExtreme` ranges and report reversal rate per bucket.
 *      Also do a 2D cross-tab: hour × bucket — if user is right, the hour
 *      effect should DISAPPEAR after controlling for time-since-extreme.
 *
 * Run:
 *   cd apps/api
 *   pnpm exec tsx scripts/analyze-post-extreme-reversal.ts
 *   # optional: --days=60 --extreme=6
 */
import { withRetry } from '@trading-bot/core/retry';

const COINS: Record<string, string> = {
  BTC:  'BTCUSDT',
  ETH:  'ETHUSDT',
  SOL:  'SOLUSDT',
  XRP:  'XRPUSDT',
  DOGE: 'DOGEUSDT',
  BNB:  'BNBUSDT',
};

interface Bar { openTime: number; open: number; close: number; closeTime: number }
interface Event {
  hourUtc:           number;
  barsSinceExtreme:  number;     // bars since last completed extreme streak; Infinity if none
  nextDir:           1 | -1 | 0; // 1=cont, -1=reversal, 0=doji
}

async function fetchBinance5m(symbol: string, startMs: number, endMs: number): Promise<Bar[]> {
  const out: Bar[] = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const url = `https://api.binance.com/api/v3/klines`
      + `?symbol=${symbol}&interval=5m&startTime=${cursor}&endTime=${endMs}&limit=1000`;
    const resp = await withRetry(`Binance ${symbol}`, async () => {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`Binance ${r.status}`);
      return r.json() as Promise<Array<Array<string | number>>>;
    });
    if (!resp.length) break;
    for (const k of resp) {
      out.push({
        openTime:  Number(k[0]),
        open:      Number(k[1]),
        close:     Number(k[4]),
        closeTime: Number(k[6]),
      });
    }
    cursor = Number(resp[resp.length - 1]![0]) + 1;
    await new Promise(r => setTimeout(r, 50));
  }
  return out;
}

function dirOf(b: Bar): 1 | -1 | 0 {
  if (b.close > b.open) return 1;
  if (b.close < b.open) return -1;
  return 0;
}

function emit(bars: Bar[], extremeThreshold: number): Event[] {
  const events: Event[] = [];
  let runDir: 1 | -1 | 0 = 0;
  let runLen = 0;
  let lastExtremeAtIdx = -1;
  let lastExtremeWasBelow = true;   // tracks the "first hit" semantic
  for (let i = 0; i < bars.length; i++) {
    const d = dirOf(bars[i]!);
    if (d === 0) {
      runDir = 0; runLen = 0;
      // doji doesn't reset extreme tracker
    } else {
      const wasBelow = runLen < extremeThreshold;
      if (d === runDir) runLen++; else { runDir = d; runLen = 1; }
      if (runLen >= extremeThreshold) {
        // Update on EVERY bar that's still in an extreme run (so "last extreme"
        // = most recent bar still extreme, not just the first-hit). This
        // matches the bot's `lastExtremeStreakAt` semantics.
        lastExtremeAtIdx = i;
        lastExtremeWasBelow = wasBelow;
      }
    }

    // Streak=2 trigger: runLen exactly 2 right now, and we have a next bar.
    if (runLen !== 2) continue;
    if (i + 1 >= bars.length) continue;
    const next = dirOf(bars[i + 1]!);
    const nextDir: 1 | -1 | 0 =
      next === 0   ? 0
      : next === d ? 1
      : -1;

    const barsSinceExtreme = lastExtremeAtIdx >= 0 ? (i - lastExtremeAtIdx) : Number.POSITIVE_INFINITY;
    events.push({
      hourUtc:          new Date(bars[i]!.closeTime).getUTCHours(),
      barsSinceExtreme,
      nextDir,
    });
  }
  return events;
}

interface Bucket { label: string; min: number; max: number }
const TIME_BUCKETS: Bucket[] = [
  { label: '0-6 bars   (≤30min)',  min: 0,    max: 6   },
  { label: '7-12 bars  (30-60m)',  min: 7,    max: 12  },
  { label: '13-24 bars (1-2h)',    min: 13,   max: 24  },
  { label: '25-48 bars (2-4h)',    min: 25,   max: 48  },
  { label: '49-144 bars (4-12h)',  min: 49,   max: 144 },
  { label: '145-432 bars (12-36h)',min: 145,  max: 432 },
  { label: '>432 bars (>36h)',     min: 433,  max: Number.POSITIVE_INFINITY },
];

function bucketOf(barsSince: number): number {
  for (let i = 0; i < TIME_BUCKETS.length; i++) {
    const b = TIME_BUCKETS[i]!;
    if (barsSince >= b.min && barsSince <= b.max) return i;
  }
  return -1;
}

function fmtHour(hUtc: number): string {
  const hVn = (hUtc + 7) % 24;
  return `${String(hUtc).padStart(2, '0')}h UTC (${String(hVn).padStart(2, '0')}h VN)`;
}

function fmtPct(n: number, d: number, w = 5): string {
  if (d === 0) return '   -  '.padStart(w + 1, ' ');
  return `${(100 * n / d).toFixed(1).padStart(w, ' ')}%`;
}

async function main(): Promise<void> {
  const args = Object.fromEntries(
    process.argv.slice(2).map(a => {
      const [k, v] = a.replace(/^--/, '').split('=');
      return [k, v ?? 'true'];
    }),
  ) as Record<string, string>;
  const days       = Number(args['days'] ?? 60);
  const EXTREME    = Number(args['extreme'] ?? 6);
  const now = Date.now();
  const start = now - days * 24 * 60 * 60 * 1000;

  console.log(`fetching ${days}d 5m bars; extreme threshold = streak ≥ ${EXTREME}\n`);
  const all: Event[] = [];
  for (const [coin, sym] of Object.entries(COINS)) {
    process.stdout.write(`  ${coin}… `);
    const bars = await fetchBinance5m(sym, start, now);
    const events = emit(bars, EXTREME);
    all.push(...events);
    console.log(`${bars.length} bars → ${events.length} streak=2 events`);
  }
  const baseline = all.filter(e => e.nextDir === -1).length / all.length;
  console.log(`\nstreak=2 baseline reversal rate: ${(100 * baseline).toFixed(1)}%   n=${all.length}`);

  // ─── Test 1: reversal rate by bars-since-extreme ──────────────────────────
  console.log('\n========================================================');
  console.log(`  Streak=2 reversal rate by bars-since-extreme (≥${EXTREME})`);
  console.log('========================================================');
  console.log(' bucket                       | n events | reversal | edge vs baseline');
  console.log(' ----------------------------+----------+----------+-----------------');
  for (let bi = 0; bi < TIME_BUCKETS.length; bi++) {
    const inBucket = all.filter(e => bucketOf(e.barsSinceExtreme) === bi);
    const revs     = inBucket.filter(e => e.nextDir === -1).length;
    const rate     = inBucket.length ? revs / inBucket.length : 0;
    const edge     = rate - baseline;
    const edgeStr  = inBucket.length ? `${edge >= 0 ? '+' : ''}${(100*edge).toFixed(1)}pp` : '   -  ';
    console.log(
      ` ${TIME_BUCKETS[bi]!.label.padEnd(28, ' ')} | `
      + `${String(inBucket.length).padStart(8, ' ')} | `
      + `${fmtPct(revs, inBucket.length)} | ${edgeStr.padStart(10, ' ')}`
    );
  }

  // ─── Test 2: 2D cross-tab — hour × bars-since-extreme ──────────────────────
  console.log('\n========================================================');
  console.log('  Cross-tab: reversal rate (%) — hour (rows) × time-since-extreme (cols)');
  console.log('  Goal: does the hour-effect persist after controlling for "recent extreme"?');
  console.log('========================================================');
  // Header
  process.stdout.write(' hour                       | ');
  for (const b of TIME_BUCKETS.slice(0, 5)) {
    process.stdout.write(b.label.split(' ')[0]!.padStart(8, ' ') + ' | ');
  }
  process.stdout.write('all\n');
  process.stdout.write(' --------------------------+----------+----------+----------+----------+----------+----------\n');

  for (let h = 0; h < 24; h++) {
    process.stdout.write(` ${fmtHour(h).padEnd(25, ' ')} | `);
    for (let bi = 0; bi < 5; bi++) {
      const inCell = all.filter(e => e.hourUtc === h && bucketOf(e.barsSinceExtreme) === bi);
      const revs = inCell.filter(e => e.nextDir === -1).length;
      const rateStr = inCell.length >= 10 ? fmtPct(revs, inCell.length) : '   -  ';
      const annot = inCell.length < 10 ? ` (${inCell.length})` : ` (${inCell.length})`;
      process.stdout.write(`${rateStr}${annot.padStart(7, ' ')} | `);
    }
    const allInHour = all.filter(e => e.hourUtc === h);
    const revsAll = allInHour.filter(e => e.nextDir === -1).length;
    process.stdout.write(`${fmtPct(revsAll, allInHour.length)}\n`);
  }

  // ─── Test 3: After controlling for time-since-extreme, is hour still significant? ─
  console.log('\n========================================================');
  console.log('  Hour effect WITHIN the highest-edge bucket (bucket 0: ≤30min post-extreme)');
  console.log('  If hour effect disappears here, hour was just a proxy for post-extreme.');
  console.log('========================================================');
  const inBucket0 = all.filter(e => bucketOf(e.barsSinceExtreme) === 0);
  const b0Baseline = inBucket0.filter(e => e.nextDir === -1).length / inBucket0.length;
  console.log(`bucket 0 overall: ${(100*b0Baseline).toFixed(1)}%   n=${inBucket0.length}`);
  const byHourInB0 = new Map<number, { n: number; revs: number }>();
  for (let h = 0; h < 24; h++) byHourInB0.set(h, { n: 0, revs: 0 });
  for (const e of inBucket0) {
    const c = byHourInB0.get(e.hourUtc)!;
    c.n++; if (e.nextDir === -1) c.revs++;
  }
  const sortedB0 = [...byHourInB0.entries()].sort((a, b) =>
    (b[1].n ? b[1].revs / b[1].n : 0) - (a[1].n ? a[1].revs / a[1].n : 0),
  );
  console.log(' hour                       | n events | reversal | edge vs bucket-0 baseline');
  console.log(' --------------------------+----------+----------+--------------------------');
  for (const [h, c] of sortedB0) {
    const rate = c.n ? c.revs / c.n : 0;
    const edge = rate - b0Baseline;
    const edgeStr = c.n ? `${edge >= 0 ? '+' : ''}${(100*edge).toFixed(1)}pp` : '   -  ';
    console.log(
      ` ${fmtHour(h).padEnd(25, ' ')} | ${String(c.n).padStart(8, ' ')} | `
      + `${fmtPct(c.revs, c.n)} | ${edgeStr.padStart(10, ' ')}`
    );
  }

  // ─── Test 4: Same analysis but for streak=3 (where edge was bigger) ─────
  console.log('\n========================================================');
  console.log('  STREAK=3 reversal rate by bars-since-extreme');
  console.log('========================================================');
  // Re-emit for streak=3
  const all3: Event[] = [];
  for (const [coin, sym] of Object.entries(COINS)) {
    const bars = await fetchBinance5m(sym, start, now);
    let runDir: 1 | -1 | 0 = 0; let runLen = 0; let lastExtremeAtIdx = -1;
    for (let i = 0; i < bars.length; i++) {
      const d = dirOf(bars[i]!);
      if (d === 0) { runDir = 0; runLen = 0; }
      else {
        if (d === runDir) runLen++; else { runDir = d; runLen = 1; }
        if (runLen >= EXTREME) lastExtremeAtIdx = i;
      }
      if (runLen !== 3) continue;
      if (i + 1 >= bars.length) continue;
      const next = dirOf(bars[i + 1]!);
      const nextDir: 1 | -1 | 0 = next === 0 ? 0 : next === d ? 1 : -1;
      all3.push({
        hourUtc: new Date(bars[i]!.closeTime).getUTCHours(),
        barsSinceExtreme: lastExtremeAtIdx >= 0 ? (i - lastExtremeAtIdx) : Number.POSITIVE_INFINITY,
        nextDir,
      });
    }
  }
  const baseline3 = all3.filter(e => e.nextDir === -1).length / all3.length;
  console.log(`streak=3 baseline: ${(100*baseline3).toFixed(1)}%   n=${all3.length}`);
  console.log(' bucket                       | n events | reversal | edge vs baseline');
  console.log(' ----------------------------+----------+----------+-----------------');
  for (let bi = 0; bi < TIME_BUCKETS.length; bi++) {
    const inBucket = all3.filter(e => bucketOf(e.barsSinceExtreme) === bi);
    const revs     = inBucket.filter(e => e.nextDir === -1).length;
    const rate     = inBucket.length ? revs / inBucket.length : 0;
    const edge     = rate - baseline3;
    const edgeStr  = inBucket.length ? `${edge >= 0 ? '+' : ''}${(100*edge).toFixed(1)}pp` : '   -  ';
    console.log(
      ` ${TIME_BUCKETS[bi]!.label.padEnd(28, ' ')} | `
      + `${String(inBucket.length).padStart(8, ' ')} | `
      + `${fmtPct(revs, inBucket.length)} | ${edgeStr.padStart(10, ' ')}`
    );
  }

  console.log('\nDone.');
}

main().catch(err => { console.error(err); process.exit(1); });
