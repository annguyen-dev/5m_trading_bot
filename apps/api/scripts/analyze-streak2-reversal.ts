/**
 * Streak=N reversal-rate analysis by hour-of-day.
 *
 * Question we're answering: "After a streak of length N closes, how often
 * does the NEXT 5m bar reverse — and does that probability cluster at certain
 * hours?" If certain UTC hours have reversal rate >> baseline, that's an
 * exploitable contrarian edge for the bot's streak=N entry.
 *
 * Method:
 *   1. Fetch 60 days of 5m Binance klines for all 6 enabled coins.
 *   2. Walk bars, classify each as up / down / doji (close>open / </ ==).
 *   3. Track running same-direction streak. When a streak of length N "lands"
 *      (the N-th bar just closed), record the NEXT bar's outcome:
 *        - continuation (same direction)
 *        - reversal     (opposite direction)
 *        - doji         (close == open, very rare on crypto 5m)
 *   4. Bucket by hour-of-day (UTC) of the streak-ending bar's close time.
 *   5. Output reversal rate per (hour, streak_N) — and ranked hours where
 *      streak=2 reversals are most over-represented vs baseline.
 *
 * Run:
 *   pnpm --filter @trading-bot/api exec tsx scripts/analyze-streak2-reversal.ts
 *   # optional: --days=30 --coin=BTC
 *
 * No DB writes — pure read + console output.
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
  hourUtc:    number;          // 0..23
  coin:       string;
  streakLen:  number;          // 1..N (positive = UP streak, |.| stored)
  streakDir:  1 | -1;
  nextDir:    1 | -1 | 0;      // 1=cont (same), -1=reversal, 0=doji
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
    // Polite throttle to avoid rate limit.
    await new Promise(r => setTimeout(r, 50));
  }
  return out;
}

function dirOf(b: Bar): 1 | -1 | 0 {
  if (b.close > b.open) return 1;
  if (b.close < b.open) return -1;
  return 0;
}

/**
 * For each bar at index i, determine the streak length ENDING AT i (signed).
 * Then the "next bar" is i+1. If i+1 is a doji, count separately.
 *
 * A streak of length L ending at i means bars [i-L+1 .. i] all share the
 * same direction, and bar [i-L] (if exists) is opposite OR doji.
 */
function emitEvents(bars: Bar[], coin: string): Event[] {
  const events: Event[] = [];
  let runDir: 1 | -1 | 0 = 0;
  let runLen = 0;
  for (let i = 0; i < bars.length; i++) {
    const d = dirOf(bars[i]!);
    if (d === 0) { runDir = 0; runLen = 0; continue; }
    if (d === runDir) runLen++; else { runDir = d; runLen = 1; }

    // Look at next bar (i+1)
    if (i + 1 >= bars.length) continue;
    const next = dirOf(bars[i + 1]!);
    const nextDir: 1 | -1 | 0 =
      next === 0     ? 0
      : next === d   ? 1     // continuation
      : -1;                  // reversal

    const closeTime = bars[i]!.closeTime;
    events.push({
      hourUtc:   new Date(closeTime).getUTCHours(),
      coin,
      streakLen: runLen,
      streakDir: d,
      nextDir,
    });
  }
  return events;
}

interface Cell { events: number; reversals: number; continuations: number; dojis: number }

function bucketByHour(events: Event[], streakN: number): Map<number, Cell> {
  const out = new Map<number, Cell>();
  for (let h = 0; h < 24; h++) out.set(h, { events: 0, reversals: 0, continuations: 0, dojis: 0 });
  for (const e of events) {
    if (e.streakLen !== streakN) continue;
    const c = out.get(e.hourUtc)!;
    c.events++;
    if      (e.nextDir === -1) c.reversals++;
    else if (e.nextDir ===  1) c.continuations++;
    else                       c.dojis++;
  }
  return out;
}

function fmtHour(hUtc: number): string {
  const hVn = (hUtc + 7) % 24;
  return `${String(hUtc).padStart(2, '0')}h UTC (${String(hVn).padStart(2, '0')}h VN)`;
}

function fmtPct(n: number, d: number): string {
  if (d === 0) return '   -  ';
  return `${(100 * n / d).toFixed(1).padStart(5, ' ')}%`;
}

async function main(): Promise<void> {
  const args = Object.fromEntries(
    process.argv.slice(2).map(a => {
      const [k, v] = a.replace(/^--/, '').split('=');
      return [k, v ?? 'true'];
    }),
  ) as Record<string, string>;
  const days = Number(args['days'] ?? 60);
  const coinFilter = args['coin']?.toUpperCase();
  const now = Date.now();
  const start = now - days * 24 * 60 * 60 * 1000;

  console.log(`fetching ${days}d 5m bars for ${coinFilter ? coinFilter : 'all coins'}…`);
  const allEvents: Event[] = [];
  for (const [coin, sym] of Object.entries(COINS)) {
    if (coinFilter && coin !== coinFilter) continue;
    process.stdout.write(`  ${coin}… `);
    const bars = await fetchBinance5m(sym, start, now);
    const events = emitEvents(bars, coin);
    allEvents.push(...events);
    console.log(`${bars.length} bars → ${events.length} events`);
  }

  console.log('\n========================================================');
  console.log('  Streak length distribution (all coins, all hours)');
  console.log('========================================================');
  const byLen = new Map<number, { events: number; reversals: number }>();
  for (const e of allEvents) {
    const c = byLen.get(e.streakLen) ?? { events: 0, reversals: 0 };
    c.events++;
    if (e.nextDir === -1) c.reversals++;
    byLen.set(e.streakLen, c);
  }
  console.log(' streak | n events | reversal rate');
  console.log(' -------+----------+---------------');
  const lens = [...byLen.keys()].sort((a, b) => a - b);
  for (const L of lens) {
    if (L > 8) continue;
    const c = byLen.get(L)!;
    console.log(` ${String(L).padStart(6, ' ')} | ${String(c.events).padStart(8, ' ')} | ${fmtPct(c.reversals, c.events)}`);
  }

  for (const STREAK_N of [2, 3, 4]) {
    console.log(`\n========================================================`);
    console.log(`  Streak=${STREAK_N} reversal rate by hour (all coins combined)`);
    console.log(`========================================================`);
    const buckets = bucketByHour(allEvents, STREAK_N);
    const totalEvents = [...buckets.values()].reduce((s, c) => s + c.events, 0);
    const totalRevs   = [...buckets.values()].reduce((s, c) => s + c.reversals, 0);
    const baseline    = totalRevs / totalEvents;
    console.log(`  baseline (all hours): ${(100 * baseline).toFixed(1)}%   n=${totalEvents}`);
    console.log(' hour                       | n events | reversal | edge vs baseline');
    console.log(' --------------------------+----------+----------+-----------------');
    const sorted = [...buckets.entries()].sort((a, b) => {
      const ra = a[1].events ? a[1].reversals / a[1].events : 0;
      const rb = b[1].events ? b[1].reversals / b[1].events : 0;
      return rb - ra;
    });
    for (const [h, c] of sorted) {
      const rate = c.events ? c.reversals / c.events : 0;
      const edge = rate - baseline;
      const edgePct = c.events ? `${edge >= 0 ? '+' : ''}${(100 * edge).toFixed(1)}pp` : '   -  ';
      console.log(
        ` ${fmtHour(h).padEnd(25, ' ')} | ${String(c.events).padStart(8, ' ')} | `
        + `${fmtPct(c.reversals, c.events)} | ${edgePct.padStart(10, ' ')}`
      );
    }
  }

  // Per-coin streak=2 reversal rate at each hour (top 3 hours per coin)
  console.log(`\n========================================================`);
  console.log(`  Top-5 reversal hours @ streak=2 per coin`);
  console.log(`========================================================`);
  for (const coin of Object.keys(COINS)) {
    if (coinFilter && coin !== coinFilter) continue;
    const coinEvents = allEvents.filter(e => e.coin === coin);
    if (coinEvents.length === 0) continue;
    const buckets = bucketByHour(coinEvents, 2);
    const totalEvents = [...buckets.values()].reduce((s, c) => s + c.events, 0);
    const totalRevs   = [...buckets.values()].reduce((s, c) => s + c.reversals, 0);
    const baseline    = totalEvents ? totalRevs / totalEvents : 0;
    const sorted = [...buckets.entries()]
      .filter(([, c]) => c.events >= 5)            // skip noisy small-n buckets
      .sort((a, b) => (b[1].reversals / b[1].events) - (a[1].reversals / a[1].events));
    console.log(`\n  ${coin}  baseline ${(100 * baseline).toFixed(1)}%`);
    for (const [h, c] of sorted.slice(0, 5)) {
      const rate = c.reversals / c.events;
      const edge = rate - baseline;
      console.log(
        `    ${fmtHour(h).padEnd(25, ' ')}  n=${String(c.events).padStart(4, ' ')}  `
        + `rev=${(100 * rate).toFixed(1).padStart(5, ' ')}%  edge=${edge >= 0 ? '+' : ''}${(100 * edge).toFixed(1)}pp`
      );
    }
  }

  console.log('\nDone.');
}

main().catch(err => { console.error(err); process.exit(1); });
