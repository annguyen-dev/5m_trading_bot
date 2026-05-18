/**
 * Backtest "post-volatility-cluster" strategy.
 *
 * Hypothesis: after a recent burst of long streaks (volatility cluster),
 * short streaks (3-4) are more likely to MEAN-REVERT quickly. Volatility
 * begets volatility — but in a clustered regime, big moves often whipsaw.
 *
 * Trigger conditions:
 *   - Entry candidate when streak first reaches 3 or 4 (configurable).
 *   - Cluster filter: ≥ N streaks of length ≥ M ENDED within last L minutes.
 *     Default N=1, M=5, L=60 (= "1 long streak in last hour").
 *
 * Entry:
 *   - Bet contrarian to current short streak.
 *   - Flat $0.55 entry (Polymarket book reality, see other backtests).
 *   - Optional body3 floor.
 *
 * No DCA — focus on edge of trigger condition.
 *
 * Usage:
 *   pnpm --filter @trading-bot/api exec tsx scripts/backtest-volcluster.ts \
 *     [--days=30] [--base=10] \
 *     [--entry-streaks=3,4] [--trigger-min-streak=5] \
 *     [--trigger-count=1] [--lookback-min=60] \
 *     [--body3-min=0] [--entry-price=0.55]
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
  entryStreaks: number[];
  triggerMinStreak: number;
  triggerCount: number;
  lookbackMin: number;
  body3Min: number;
  entryPrice: number;
}

function parseArgs(): Args {
  const a: Args = {
    days: 30, base: 10,
    entryStreaks: [3, 4],
    triggerMinStreak: 5,
    triggerCount: 1,
    lookbackMin: 60,
    body3Min: 0,
    entryPrice: 0.55,
  };
  for (const arg of process.argv.slice(2)) {
    const eq = arg.indexOf('=');
    if (eq < 0) continue;
    const k = arg.slice(2, eq);
    const v = arg.slice(eq + 1);
    const num = Number(v);
    switch (k) {
      case 'days':                a.days = num; break;
      case 'base':                a.base = num; break;
      case 'entry-streaks':       a.entryStreaks = v.split(',').map(Number); break;
      case 'trigger-min-streak':  a.triggerMinStreak = num; break;
      case 'trigger-count':       a.triggerCount = num; break;
      case 'lookback-min':        a.lookbackMin = num; break;
      case 'body3-min':           a.body3Min = num; break;
      case 'entry-price':         a.entryPrice = num; break;
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
  clusterCount: number;
  outcomeDir: 1|-1|0;
  won: boolean;
  pnl: number;
}

async function main(): Promise<void> {
  const args = parseArgs();
  console.error(`Fetching ${args.days}d of BTC 5m bars (Spot)…`);
  const bars = await fetchKlines(args.days);
  console.error(`Got ${bars.length} bars\n`);

  // 1) Compute streak length ending at each bar.
  const streakLen = new Array<number>(bars.length).fill(0);
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    if (b.dir === 0) { streakLen[i] = 0; continue; }
    streakLen[i] = (i > 0 && bars[i-1]!.dir === b.dir) ? streakLen[i-1]! + 1 : 1;
  }

  // 2) Identify "long streak END" events: bar i where streakLen[i] ≥ M and
  //    streakLen[i+1] < streakLen[i] (next bar breaks). Record bar i's ts.
  const longStreakEndTs: number[] = [];
  for (let i = 0; i < bars.length - 1; i++) {
    if (streakLen[i]! >= args.triggerMinStreak
        && (i === bars.length - 1 || streakLen[i+1]! <= streakLen[i]! - streakLen[i]! + 1)) {
      // streakLen[i+1] === 1 (new opposite streak) or 0 (doji) → streak just ended at i
      if (streakLen[i+1]! === 0 || streakLen[i+1]! === 1) {
        longStreakEndTs.push(bars[i]!.ts);
      }
    }
  }

  // 3) Build trades: for each bar i where streakLen[i] is in entryStreaks AND
  //    it's the FIRST hit (streakLen[i-1] < entryStreak), check cluster filter.
  const trades: Trade[] = [];
  const lookbackMs = args.lookbackMin * 60_000;
  for (let i = 3; i + 1 < bars.length; i++) {
    if (!args.entryStreaks.includes(streakLen[i]!)) continue;
    if (i > 0 && streakLen[i-1] === streakLen[i]) continue;  // not first hit

    const regime = bars[i]!.dir;
    if (regime === 0) continue;

    // Cluster filter: count long-streak-ends in last lookbackMs.
    const nowTs = bars[i]!.ts;
    const cutoff = nowTs - lookbackMs;
    const clusterCount = longStreakEndTs.filter(t => t > cutoff && t < nowTs).length;
    if (clusterCount < args.triggerCount) continue;

    // Body3 floor.
    const body3 = Math.abs(bars[i]!.body) + Math.abs(bars[i-1]!.body) + Math.abs(bars[i-2]!.body);
    if (body3 < args.body3Min) continue;

    // Place bet for window i+1.
    const betDir = (regime === 1 ? -1 : 1) as -1 | 1;
    const next = bars[i + 1]!;
    const won = next.dir !== 0 && next.dir === betDir;
    const shares = args.base / args.entryPrice;
    const pnl = won ? shares * (1 - args.entryPrice) : -args.base;

    trades.push({
      ts: next.ts, streak: streakLen[i]!, body3, regime, betDir,
      clusterCount,
      outcomeDir: next.dir, won, pnl,
    });
  }

  // === Reporting ===
  const fmt = (n: number) => (n >= 0 ? '+' : '') + n.toFixed(2);
  function summary(label: string, list: Trade[]): void {
    if (list.length === 0) { console.log(`  ${label.padEnd(40)} (none)`); return; }
    const wins = list.filter(t => t.won).length;
    const pnl  = list.reduce((s, t) => s + t.pnl, 0);
    console.log(
      `  ${label.padEnd(40)} n=${String(list.length).padStart(4)}  ` +
      `wins=${String(wins).padStart(3)}/${String(list.length).padEnd(3)} (${(wins/list.length*100).toFixed(1)}%)  ` +
      `pnl=$${fmt(pnl).padStart(9)}`
    );
  }

  console.log('═══════════════════ CONFIG ═══════════════════');
  console.log(`  Period            : ${args.days} days`);
  console.log(`  Entry streaks     : ${args.entryStreaks.join(', ')} (first hit)`);
  console.log(`  Trigger filter    : ≥ ${args.triggerCount} streak(s) ≥ ${args.triggerMinStreak} ended in last ${args.lookbackMin} min`);
  console.log(`  Body3 floor       : $${args.body3Min}`);
  console.log(`  Base size         : $${args.base}`);
  console.log(`  Entry price       : $${args.entryPrice} flat`);
  console.log();
  console.log(`  Long streak ends (≥${args.triggerMinStreak}) in 30d : ${longStreakEndTs.length}`);
  console.log();

  console.log('═══════════════════ RESULTS ══════════════════');
  summary('TOTAL', trades);
  console.log();
  console.log('  ── by entry streak ──');
  for (const s of args.entryStreaks) summary(`    streak=${s}`, trades.filter(t => t.streak === s));
  console.log();
  console.log('  ── by cluster count ──');
  const byCluster = new Map<number, Trade[]>();
  for (const t of trades) {
    if (!byCluster.has(t.clusterCount)) byCluster.set(t.clusterCount, []);
    byCluster.get(t.clusterCount)!.push(t);
  }
  for (const k of Array.from(byCluster.keys()).sort((a,b)=>a-b)) {
    summary(`    ${k} long-streak-end(s) in last ${args.lookbackMin}m`, byCluster.get(k)!);
  }
  console.log();

  // risk
  let runEquity = 0, peakEquity = 0, maxDD = 0;
  let curStreakLoss = 0, maxStreakLoss = 0;
  for (const t of trades) {
    if (t.won) curStreakLoss = 0;
    else { curStreakLoss++; maxStreakLoss = Math.max(maxStreakLoss, curStreakLoss); }
    runEquity += t.pnl;
    peakEquity = Math.max(peakEquity, runEquity);
    maxDD = Math.max(maxDD, peakEquity - runEquity);
  }
  console.log('  ── risk ──');
  console.log(`    max consec losses : ${maxStreakLoss}`);
  console.log(`    max drawdown      : $${maxDD.toFixed(2)}`);
  console.log(`    final equity      : $${runEquity.toFixed(2)}`);
  console.log(`    PnL/DD ratio      : ${maxDD > 0 ? (runEquity / maxDD).toFixed(2) : 'inf'}`);
}

main().catch(err => { console.error(err); process.exit(1); });
