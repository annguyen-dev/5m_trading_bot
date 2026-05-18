/**
 * Backtest "wait-for-next-streak-5" strategy.
 *
 * Rules:
 *   - Entry trigger: streak FIRST reaches 5 (i.e., streakLen transitions
 *     4 → 5). NOT every bar where streak ≥ 5 — only the FRESH event.
 *   - Entry condition: body3 (sum of last 3 closed bars' |body|) ≥ minBody3.
 *     User-set floor (default $100) just to filter out near-zero bodies.
 *   - Bet direction: contrarian to streak (streak UP → bet DOWN).
 *   - Size logic:
 *       lossCount = 0 → base ($10)
 *       lossCount = 1 → DCA size (base × 2 = $20)
 *       lossCount ≥ 2 → reset to 0, size = base
 *   - Outcome update:
 *       win  → lossCount = 0
 *       loss → lossCount += 1 (capped at 2 → reset to 0)
 *   - NO immediate DCA on next bar. Wait for next FRESH streak=5 event.
 *
 * Entry pricing: flat $0.55 (per 30d prod data, Polymarket 5m binary book
 * stays near 50/50 even at extreme streaks — see backtest-echo-rules.ts
 * comment for details).
 *
 * Usage:
 *   pnpm --filter @trading-bot/api exec tsx scripts/backtest-streak5-simple.ts \
 *     [--days=30] [--base=10] [--dca-mult=2] [--streak=5] [--min-body3=100] [--entry=0.55]
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
  base: number;
  dcaMult: number;
  streak: number;
  minBody3: number;
  entry: number;
}

function parseArgs(): Args {
  const a: Args = { days: 30, base: 10, dcaMult: 2, streak: 5, minBody3: 100, entry: 0.55 };
  for (const arg of process.argv.slice(2)) {
    const eq = arg.indexOf('=');
    if (eq < 0) continue;
    const k = arg.slice(2, eq);
    const v = Number(arg.slice(eq + 1));
    switch (k) {
      case 'days':       a.days = v; break;
      case 'base':       a.base = v; break;
      case 'dca-mult':   a.dcaMult = v; break;
      case 'streak':     a.streak = v; break;
      case 'min-body3':  a.minBody3 = v; break;
      case 'entry':      a.entry = v; break;
    }
  }
  return a;
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

interface Trade {
  ts: number;
  streak: number;
  body3: number;
  regime: 1|-1;
  betDir: 1|-1;
  size: number;
  isDca: boolean;
  outcomeDir: 1|-1|0;
  won: boolean;
  pnl: number;
}

async function main(): Promise<void> {
  const args = parseArgs();
  console.error(`Fetching ${args.days}d of BTC 5m bars (Spot)…`);
  const bars = await fetchKlines(args.days);
  console.error(`Got ${bars.length} bars\n`);

  // Compute streak length ENDING at each i.
  const streakLen = new Array<number>(bars.length).fill(0);
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    if (b.dir === 0) { streakLen[i] = 0; continue; }
    streakLen[i] = (i > 0 && bars[i-1]!.dir === b.dir) ? streakLen[i-1]! + 1 : 1;
  }

  const trades: Trade[] = [];
  let lossCount = 0;

  // Walk bars: trigger when streak FIRST reaches args.streak.
  for (let i = 0; i + 1 < bars.length; i++) {
    if (streakLen[i] !== args.streak) continue;          // not the trigger level
    if (i > 0 && streakLen[i-1] === args.streak) continue; // not the FIRST hit (still same streak)
    if (i < 3) continue;

    const regime = bars[i]!.dir;
    if (regime === 0) continue;

    // body3: sum of |body| of last 3 closed bars (i-2, i-1, i — all in streak
    // since streak ≥ 3).
    const body3 = Math.abs(bars[i]!.body) + Math.abs(bars[i-1]!.body) + Math.abs(bars[i-2]!.body);
    if (body3 < args.minBody3) continue;                 // weak signal

    // Place bet for window i+1.
    const betDir = (regime === 1 ? -1 : 1) as -1 | 1;
    const isDca = lossCount > 0;
    const size  = isDca ? args.base * args.dcaMult : args.base;
    const nextBar = bars[i + 1]!;
    const won  = nextBar.dir !== 0 && nextBar.dir === betDir;
    const shares = size / args.entry;
    const pnl  = won ? shares * (1 - args.entry) : -size;

    trades.push({
      ts: nextBar.ts, streak: streakLen[i]!, body3,
      regime, betDir, size, isDca,
      outcomeDir: nextBar.dir, won, pnl,
    });

    // Update lossCount: 0 → 1 on loss; 1 → 0 on win OR second loss (cap+reset).
    if (won) {
      lossCount = 0;
    } else {
      lossCount += 1;
      if (lossCount >= 2) lossCount = 0;
    }
  }

  // === Reporting ===
  const fmt = (n: number) => (n >= 0 ? '+' : '') + n.toFixed(2);
  function summary(label: string, list: Trade[]): void {
    if (list.length === 0) { console.log(`  ${label.padEnd(28)} (none)`); return; }
    const wins = list.filter(t => t.won).length;
    const pnl  = list.reduce((s, t) => s + t.pnl, 0);
    const grossWin = list.filter(t => t.won).reduce((s, t) => s + t.pnl, 0);
    const grossLoss = list.filter(t => !t.won).reduce((s, t) => s + t.pnl, 0);
    console.log(
      `  ${label.padEnd(28)} n=${String(list.length).padStart(4)}  ` +
      `wins=${String(wins).padStart(3)}/${String(list.length).padEnd(3)} (${(wins/list.length*100).toFixed(1)}%)  ` +
      `pnl=$${fmt(pnl).padStart(9)}  ` +
      `gross win=$${grossWin.toFixed(2).padStart(8)}  loss=$${grossLoss.toFixed(2).padStart(8)}`
    );
  }

  console.log('═══════════════════ CONFIG ═══════════════════');
  console.log(`  Period            : ${args.days} days (${bars.length} 5m bars)`);
  console.log(`  Entry trigger     : streak FIRST reaches ${args.streak} (fresh event)`);
  console.log(`  Body3 floor       : ≥ $${args.minBody3}`);
  console.log(`  Base size         : $${args.base}`);
  console.log(`  DCA size (after L): $${args.base * args.dcaMult}  (×${args.dcaMult})`);
  console.log(`  Reset rule        : after 2 losses in chain → back to base`);
  console.log(`  Entry price       : $${args.entry} (flat)`);
  console.log();

  console.log('═══════════════════ RESULTS ══════════════════');
  summary('TOTAL', trades);
  summary('  base bets (lossCount=0)', trades.filter(t => !t.isDca));
  summary('  DCA bets  (lossCount=1)', trades.filter(t => t.isDca));
  console.log();

  // Distribution by streak (should mostly be 5 since we trigger on FIRST hit)
  const byStreak = new Map<number, Trade[]>();
  for (const t of trades) {
    if (!byStreak.has(t.streak)) byStreak.set(t.streak, []);
    byStreak.get(t.streak)!.push(t);
  }
  console.log('  ── by streak at entry ──');
  for (const k of Array.from(byStreak.keys()).sort((a,b)=>a-b)) summary(`    streak=${k}`, byStreak.get(k)!);
  console.log();

  // Streak count of consecutive losses encountered
  let curStreakLoss = 0, maxStreakLoss = 0;
  let runEquity = 0, peakEquity = 0, maxDD = 0;
  for (const t of trades) {
    if (t.won) curStreakLoss = 0;
    else { curStreakLoss++; maxStreakLoss = Math.max(maxStreakLoss, curStreakLoss); }
    runEquity += t.pnl;
    peakEquity = Math.max(peakEquity, runEquity);
    maxDD = Math.max(maxDD, peakEquity - runEquity);
  }
  console.log('  ── risk ──');
  console.log(`    max consec losses (in trade-log) : ${maxStreakLoss}`);
  console.log(`    max drawdown                     : $${maxDD.toFixed(2)}`);
  console.log(`    final equity                     : $${runEquity.toFixed(2)}`);
  console.log();

  // Win/Loss patterns
  const wlPattern = trades.map(t => t.won ? 'W' : 'L').join('');
  console.log(`  W/L pattern (oldest→newest): ${wlPattern}`);
  console.log();

  // Daily PnL
  const daily = new Map<string, number>();
  for (const t of trades) {
    const d = new Date(t.ts).toISOString().slice(0, 10);
    daily.set(d, (daily.get(d) ?? 0) + t.pnl);
  }
  console.log('  ── daily pnl ──');
  for (const d of Array.from(daily.keys()).sort()) {
    const v = daily.get(d)!;
    const bar = v >= 0 ? '+'.repeat(Math.min(40, Math.round(v))) : '-'.repeat(Math.min(40, Math.round(-v)));
    console.log(`    ${d}   $${fmt(v).padStart(8)}   ${bar}`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
