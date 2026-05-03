/**
 * BTC-only focused analysis: streak=2 behavior in a specific intraday window.
 *
 * Driven by observation: "Sáng VN 7-11h hôm nay (= 00-04 UTC) đa số streak=2
 * đã đảo chiều rồi". Test:
 *   1. List every streak=2 event in that window for the most recent N days
 *      with the next bar's actual outcome — see if observation holds across days.
 *   2. Compare reversal rate of 00-04 UTC window vs other 4-hour windows (BTC only).
 *   3. Compare today's window vs the historical average for the same window.
 */
import { withRetry } from '@trading-bot/core/retry';

const SYMBOL = 'BTCUSDT';

interface Bar { openTime: number; open: number; high: number; low: number; close: number; closeTime: number }

async function fetch5m(start: number, end: number): Promise<Bar[]> {
  const out: Bar[] = [];
  let cursor = start;
  while (cursor < end) {
    const url = `https://api.binance.com/api/v3/klines`
      + `?symbol=${SYMBOL}&interval=5m&startTime=${cursor}&endTime=${end}&limit=1000`;
    const resp = await withRetry(`Binance ${SYMBOL}`, async () => {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`Binance ${r.status}`);
      return r.json() as Promise<Array<Array<string | number>>>;
    });
    if (!resp.length) break;
    for (const k of resp) {
      out.push({
        openTime:  Number(k[0]),
        open:      Number(k[1]),
        high:      Number(k[2]),
        low:       Number(k[3]),
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
const dirSym = (d: 1 | -1 | 0) => d === 1 ? 'UP  ' : d === -1 ? 'DOWN' : 'doji';

function fmtVnTime(ms: number): string {
  // Display in VN (UTC+7) for user clarity
  const d = new Date(ms + 7 * 3600_000);
  const yyyy = d.getUTCFullYear();
  const mm   = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd   = String(d.getUTCDate()).padStart(2, '0');
  const HH   = String(d.getUTCHours()).padStart(2, '0');
  const MM   = String(d.getUTCMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${HH}:${MM}VN`;
}

interface Event {
  closeMs:  number;
  hourUtc:  number;       // hour-of-day at close (UTC)
  streakDir: 1 | -1;
  bodyPct:  number;       // |close - open| / open × 100, the 2nd bar's body
  nextDir:  1 | -1 | 0;
  nextBodyPct: number;
}

function emitStreakEvents(bars: Bar[], targetStreak: number): Event[] {
  const events: Event[] = [];
  let runDir: 1 | -1 | 0 = 0;
  let runLen = 0;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    const d = dirOf(b);
    if (d === 0) { runDir = 0; runLen = 0; continue; }
    if (d === runDir) runLen++; else { runDir = d; runLen = 1; }
    if (runLen !== targetStreak) continue;
    if (i + 1 >= bars.length) continue;
    const next = bars[i + 1]!;
    const nDir = dirOf(next);
    const nextDir: 1 | -1 | 0 =
      nDir === 0 ? 0 : nDir === d ? 1 : -1;
    events.push({
      closeMs:     b.closeTime,
      hourUtc:     new Date(b.closeTime).getUTCHours(),
      streakDir:   d,
      bodyPct:     Math.abs(b.close - b.open) / b.open * 100,
      nextDir,
      nextBodyPct: Math.abs(next.close - next.open) / next.open * 100,
    });
  }
  return events;
}

async function main(): Promise<void> {
  const args = Object.fromEntries(
    process.argv.slice(2).map(a => {
      const [k, v] = a.replace(/^--/, '').split('=');
      return [k, v ?? 'true'];
    }),
  ) as Record<string, string>;
  const days = Number(args['days'] ?? 30);

  const now = Date.now();
  const start = now - days * 24 * 3600_000;

  console.log(`fetching BTC 5m bars for ${days}d…`);
  const bars = await fetch5m(start, now);
  console.log(`got ${bars.length} bars`);
  const events = emitStreakEvents(bars, 2);
  console.log(`streak=2 events: ${events.length}\n`);

  // ── Today's events in 7-11 VN (00-04 UTC) ───────────────────────────────
  const todayUtc = new Date(); todayUtc.setUTCHours(0, 0, 0, 0);
  const todayStart = todayUtc.getTime();
  const todayEnd   = todayStart + 4 * 3600_000;   // 04:00 UTC = 11:00 VN
  console.log('========================================================');
  console.log(`Today's streak=2 events in 7-11 VN window (00-04 UTC)`);
  console.log(`  ${new Date(todayStart).toISOString()} → ${new Date(todayEnd).toISOString()}`);
  console.log('========================================================');
  const todayEvents = events.filter(e => e.closeMs >= todayStart && e.closeMs < todayEnd);
  if (todayEvents.length === 0) {
    console.log('  (no events yet, market might still be in early hours)');
  } else {
    console.log(' time            | streak dir  | body% | next bar  | nextbody% | result');
    console.log(' ----------------+-------------+-------+-----------+-----------+----------');
    for (const e of todayEvents) {
      const result = e.nextDir === -1 ? '✓ REVERSED' : e.nextDir === 1 ? '✗ continued' : 'doji';
      console.log(
        ` ${fmtVnTime(e.closeMs)} | ${dirSym(e.streakDir)}        | ${e.bodyPct.toFixed(2).padStart(5, ' ')} | `
        + `${dirSym(e.nextDir as 1 | -1 | 0).padEnd(9, ' ')} | ${e.nextBodyPct.toFixed(2).padStart(5, ' ')}     | ${result}`
      );
    }
    const revs = todayEvents.filter(e => e.nextDir === -1).length;
    const cont = todayEvents.filter(e => e.nextDir === 1).length;
    console.log(`\n  today: ${revs}/${todayEvents.length} reversed (${(100 * revs / todayEvents.length).toFixed(0)}%), `
              + `${cont}/${todayEvents.length} continued`);
  }

  // ── Historical 7-11 VN window: each day's reversal rate ───────────────
  console.log('\n========================================================');
  console.log(`Last ${days} days: streak=2 reversal rate during 7-11 VN window per day`);
  console.log('========================================================');
  console.log(' date       | n events | reversed | continued | doji | rev rate');
  console.log(' -----------+----------+----------+-----------+------+---------');
  const byDay = new Map<string, { n: number; revs: number; conts: number; dojis: number }>();
  for (const e of events) {
    const closeUtc = new Date(e.closeMs);
    const h = closeUtc.getUTCHours();
    if (h < 0 || h >= 4) continue;          // 0-4 UTC = 7-11 VN
    const dayKey = closeUtc.toISOString().slice(0, 10);
    const c = byDay.get(dayKey) ?? { n: 0, revs: 0, conts: 0, dojis: 0 };
    c.n++;
    if (e.nextDir === -1) c.revs++;
    else if (e.nextDir === 1) c.conts++;
    else c.dojis++;
    byDay.set(dayKey, c);
  }
  const days_sorted = [...byDay.keys()].sort().reverse();
  for (const d of days_sorted) {
    const c = byDay.get(d)!;
    console.log(
      ` ${d} | ${String(c.n).padStart(8, ' ')} | ${String(c.revs).padStart(8, ' ')} | `
      + `${String(c.conts).padStart(9, ' ')} | ${String(c.dojis).padStart(4, ' ')} | `
      + `${(100 * c.revs / c.n).toFixed(0).padStart(7, ' ')}%`
    );
  }
  // Aggregate
  const total = [...byDay.values()].reduce((s, c) => ({
    n: s.n + c.n, revs: s.revs + c.revs, conts: s.conts + c.conts, dojis: s.dojis + c.dojis,
  }), { n: 0, revs: 0, conts: 0, dojis: 0 });
  console.log(' -----------+----------+----------+-----------+------+---------');
  console.log(
    ` TOTAL      | ${String(total.n).padStart(8, ' ')} | ${String(total.revs).padStart(8, ' ')} | `
    + `${String(total.conts).padStart(9, ' ')} | ${String(total.dojis).padStart(4, ' ')} | `
    + `${(100 * total.revs / total.n).toFixed(1).padStart(6, ' ')}%`
  );

  // ── Compare 7-11 VN vs other 4-hour windows ─────────────────────────────
  console.log('\n========================================================');
  console.log(`BTC streak=2 reversal rate by 4-hour window of day (last ${days}d)`);
  console.log('========================================================');
  const windows = [
    { label: '7-11 VN  / 00-04 UTC', lo: 0,  hi: 4  },
    { label: '11-15 VN / 04-08 UTC', lo: 4,  hi: 8  },
    { label: '15-19 VN / 08-12 UTC', lo: 8,  hi: 12 },
    { label: '19-23 VN / 12-16 UTC', lo: 12, hi: 16 },
    { label: '23-03 VN / 16-20 UTC', lo: 16, hi: 20 },
    { label: '03-07 VN / 20-24 UTC', lo: 20, hi: 24 },
  ];
  console.log(' window               | n   | reversed | continued | doji | rev rate');
  console.log(' --------------------+-----+----------+-----------+------+---------');
  for (const w of windows) {
    const inWin = events.filter(e => e.hourUtc >= w.lo && e.hourUtc < w.hi);
    const revs  = inWin.filter(e => e.nextDir === -1).length;
    const conts = inWin.filter(e => e.nextDir === 1).length;
    const dojis = inWin.filter(e => e.nextDir === 0).length;
    const rate  = inWin.length ? revs / inWin.length : 0;
    console.log(
      ` ${w.label.padEnd(20, ' ')} | ${String(inWin.length).padStart(3, ' ')} | `
      + `${String(revs).padStart(8, ' ')} | ${String(conts).padStart(9, ' ')} | ${String(dojis).padStart(4, ' ')} | `
      + `${(100 * rate).toFixed(1).padStart(6, ' ')}%`
    );
  }
  const baseline = events.filter(e => e.nextDir === -1).length / events.length;
  console.log(` baseline (all hours) | ${String(events.length).padStart(3, ' ')} |          |           |      | ${(100 * baseline).toFixed(1).padStart(6, ' ')}%`);

  console.log('\nDone.');
}

main().catch(err => { console.error(err); process.exit(1); });
