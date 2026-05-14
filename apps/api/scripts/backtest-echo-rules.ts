/**
 * Backtest Echo Hunt with body-conditioned entry rules.
 *
 * Strategy:
 *   - Pull BTC 5m bars from Binance for the window.
 *   - Walk bar by bar. Track streak, arm state.
 *   - At each window boundary, decide whether to ENTER a fade (bet against
 *     the current streak) using mode-specific rules:
 *       idle  : streak ≥ idle_streak_min  AND |body3| ≥ idle_body_min
 *       armed : streak ≥ armed_streak_min AND |body3| ≥ armed_body_min
 *   - If we lose, optionally DCA at next boundary using dca_body_min.
 *   - Arming: when a "trigger" streak appears (default ≥ arm_trigger_streak),
 *     armed mode is on for arm_duration_min minutes.
 *
 * Entry pricing model (approximation — actual Polymarket prices we don't have
 * historically):
 *   entry_price(streak) = max( min_entry,
 *                              start_entry × decay^(streak − 3) )
 *   defaults: start_entry=0.40, decay=0.85, min_entry=0.10
 *   → streak=3 ≈ $0.40, streak=5 ≈ $0.29, streak=7 ≈ $0.21, streak=10 ≈ $0.15
 *
 * Resolution: simplified binary (Polymarket-style)
 *   win  → exit_price = $1.00 (full payout)
 *   lose → exit_price = $0.00 (total loss of size)
 *   doji bar → skip (cycle invalid, no entry)
 *
 * Usage:
 *   pnpm --filter @trading-bot/api exec tsx scripts/backtest-echo-rules.ts \
 *     [--days=30] \
 *     [--base-size=5] [--dca-mult=1.5] [--max-dca=1] \
 *     [--idle-streak=5] [--idle-body=400] \
 *     [--armed-streak=3] [--armed-body=300] \
 *     [--dca-body-idle=200] [--dca-body-armed=150] \
 *     [--arm-trigger=6] [--arm-duration-min=60] \
 *     [--start-entry=0.40] [--decay=0.85] [--min-entry=0.10]
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
  baseSize: number;
  dcaMult: number;
  maxDca: number;
  idleStreak: number;     // min streak for idle entry
  idleBody:   number;     // min |body3| for idle entry
  armedStreak: number;
  armedBody:  number;
  dcaBodyIdle:  number;
  dcaBodyArmed: number;
  armTrigger:    number;  // streak that activates arm
  armDurationMs: number;
  startEntry: number;
  decay:      number;
  minEntry:   number;
}

function parseArgs(): Args {
  const a: Args = {
    days: 30, baseSize: 5, dcaMult: 1.5, maxDca: 1,
    idleStreak: 5,  idleBody:  400,
    armedStreak: 3, armedBody: 300,
    dcaBodyIdle: 200, dcaBodyArmed: 150,
    armTrigger: 6, armDurationMs: 60 * 60 * 1000,
    startEntry: 0.40, decay: 0.85, minEntry: 0.10,
  };
  for (const arg of process.argv.slice(2)) {
    const [k, v] = arg.replace(/^--/, '').split('=');
    if (v == null) { if (k === 'h' || k === 'help') { console.log('see file header for args'); process.exit(0); } continue; }
    const num = Number(v);
    switch (k) {
      case 'days':              a.days = num; break;
      case 'base-size':         a.baseSize = num; break;
      case 'dca-mult':          a.dcaMult = num; break;
      case 'max-dca':           a.maxDca = num; break;
      case 'idle-streak':       a.idleStreak = num; break;
      case 'idle-body':         a.idleBody = num; break;
      case 'armed-streak':      a.armedStreak = num; break;
      case 'armed-body':        a.armedBody = num; break;
      case 'dca-body-idle':     a.dcaBodyIdle = num; break;
      case 'dca-body-armed':    a.dcaBodyArmed = num; break;
      case 'arm-trigger':       a.armTrigger = num; break;
      case 'arm-duration-min':  a.armDurationMs = num * 60_000; break;
      case 'start-entry':       a.startEntry = num; break;
      case 'decay':             a.decay = num; break;
      case 'min-entry':         a.minEntry = num; break;
      default: console.error(`unknown arg: --${k}`); process.exit(1);
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

function entryPriceFor(streak: number, a: Args): number {
  const stepsBeyond3 = Math.max(0, streak - 3);
  const px = a.startEntry * Math.pow(a.decay, stepsBeyond3);
  return Math.max(a.minEntry, px);
}

interface Trade {
  ts: number;            // entry time = bar.ts of the bar we're betting on
  mode: 'idle' | 'armed';
  dcaRound: number;
  streak: number;        // streak length right before our bet
  body3: number;         // |body3| right before our bet
  regime: 1|-1;          // streak direction
  betDir: 1|-1;          // opposite of regime (what we bet on)
  entryPrice: number;
  size: number;
  outcomeDir: 1|-1|0;    // bar's actual direction
  won: boolean;
  pnl: number;
}

async function main(): Promise<void> {
  const args = parseArgs();
  console.error(`Fetching ${args.days}d of BTC 5m bars…`);
  const bars = await fetchKlines(args.days);
  console.error(`Got ${bars.length} bars (${(bars.length / 288).toFixed(1)} days)\n`);

  // Streak ending at each i.
  const streakLen = new Array<number>(bars.length).fill(0);
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    if (b.dir === 0) { streakLen[i] = 0; continue; }
    streakLen[i] = (i > 0 && bars[i-1]!.dir === b.dir) ? streakLen[i-1]! + 1 : 1;
  }

  let armUntilTs = 0;        // armed mode active until this ms timestamp
  const trades: Trade[] = [];

  // Walk: at each j (≥3), decide whether to bet on bar j.
  // After resolving, possibly DCA on next bar j+1.
  for (let j = 3; j < bars.length - 1; j++) {
    const s = streakLen[j-1]!;
    const regime = bars[j-1]!.dir;
    if (regime === 0) continue;
    const body3 = Math.abs(bars[j-1]!.body + bars[j-2]!.body + bars[j-3]!.body);

    // Check arm trigger from current closed bar (j-1): if a previous streak
    // just reached or extended past armTrigger, arm starts at end of that bar.
    if (s >= args.armTrigger) {
      armUntilTs = Math.max(armUntilTs, bars[j-1]!.ts + args.armDurationMs);
    }
    const armed = bars[j]!.ts < armUntilTs;

    // Decide whether to enter on bar j.
    let mode: 'idle' | 'armed' | null = null;
    if (armed && s >= args.armedStreak && body3 >= args.armedBody) {
      mode = 'armed';
    } else if (!armed && s >= args.idleStreak && body3 >= args.idleBody) {
      mode = 'idle';
    }
    if (!mode) continue;

    // Place fade bet.
    const betDir = (regime === 1 ? -1 : 1) as -1 | 1;
    const entryPrice = entryPriceFor(s, args);
    const size = args.baseSize;
    const next = bars[j]!;
    const won = next.dir !== 0 && next.dir === betDir;
    const shares = size / entryPrice;
    // Simplified binary payout: win → +($1 - entry)*shares; lose → -size; doji → -size (treat as continuation loss for conservatism)
    const pnl = won ? shares * (1 - entryPrice) : -size;

    trades.push({
      ts: next.ts, mode, dcaRound: 0, streak: s, body3,
      regime, betDir, entryPrice, size,
      outcomeDir: next.dir, won, pnl,
    });

    // DCA on loss.
    let dcaRound = 0;
    let curJ = j;
    let curStreak = s;
    while (!trades[trades.length-1]!.won && dcaRound < args.maxDca && curJ + 2 < bars.length) {
      // After loss, regime extended (or doji). For DCA we look at bar curJ+1.
      const nextJ = curJ + 1;
      const newRegime = bars[nextJ]!.dir;
      // If doji, can't DCA.
      if (newRegime === 0) break;
      // Streak extended: if continuation, +1; else (which shouldn't happen since we lost), break.
      if (newRegime !== regime) break;
      const newStreak = curStreak + 1;
      const newBody3  = Math.abs(bars[nextJ]!.body + bars[curJ]!.body + bars[curJ-1]!.body);
      const dcaMin = mode === 'armed' ? args.dcaBodyArmed : args.dcaBodyIdle;
      if (newBody3 < dcaMin) break;

      // Place DCA at bar nextJ+1.
      const dcaEntry = entryPriceFor(newStreak, args);
      const dcaSize  = size * Math.pow(args.dcaMult, dcaRound + 1);
      const dcaShares = dcaSize / dcaEntry;
      const dcaBar = bars[nextJ + 1]!;
      const dcaWon = dcaBar.dir !== 0 && dcaBar.dir === betDir;
      const dcaPnl = dcaWon ? dcaShares * (1 - dcaEntry) : -dcaSize;

      trades.push({
        ts: dcaBar.ts, mode, dcaRound: dcaRound + 1,
        streak: newStreak, body3: newBody3,
        regime: regime as 1|-1, betDir,
        entryPrice: dcaEntry, size: dcaSize,
        outcomeDir: dcaBar.dir, won: dcaWon, pnl: dcaPnl,
      });
      dcaRound++;
      curJ = nextJ + 1;
      curStreak = newStreak + (dcaWon ? 0 : 1);   // if DCA also lost, streak extends another
      if (!dcaWon) {
        // Continue DCA loop check
      } else {
        break;
      }
    }

    // Skip ahead so we don't re-enter while resolving DCAs.
    j = curJ;
  }

  // === Stats ===
  const fmt = (n: number) => (n >= 0 ? '+' : '') + n.toFixed(2);
  function summary(label: string, list: Trade[]): void {
    if (list.length === 0) { console.log(`  ${label.padEnd(24)} (no trades)`); return; }
    const wins = list.filter(t => t.won).length;
    const pnl  = list.reduce((s, t) => s + t.pnl, 0);
    const grossWin  = list.filter(t => t.won).reduce((s, t) => s + t.pnl, 0);
    const grossLoss = list.filter(t => !t.won).reduce((s, t) => s + t.pnl, 0);
    console.log(
      `  ${label.padEnd(24)} n=${String(list.length).padStart(4)}  ` +
      `wins=${String(wins).padStart(3)}/${String(list.length).padEnd(3)} (${(wins/list.length*100).toFixed(1)}%)  ` +
      `pnl=$${fmt(pnl).padStart(8)}  ` +
      `gross win=$${grossWin.toFixed(2).padStart(7)}  loss=$${grossLoss.toFixed(2).padStart(7)}`
    );
  }

  console.log('═════════════════ CONFIG ═════════════════');
  console.log(`  Period               : ${args.days} days  (${bars.length} 5m bars)`);
  console.log(`  Base order size      : $${args.baseSize}`);
  console.log(`  DCA mult / max round : ${args.dcaMult}× / ${args.maxDca}`);
  console.log(`  Idle  rule           : streak ≥ ${args.idleStreak}   AND  |body3| ≥ $${args.idleBody}`);
  console.log(`  Armed rule           : streak ≥ ${args.armedStreak}  AND  |body3| ≥ $${args.armedBody}`);
  console.log(`  DCA body idle/armed  : $${args.dcaBodyIdle} / $${args.dcaBodyArmed}`);
  console.log(`  Arm trigger / dur    : streak ≥ ${args.armTrigger}  /  ${(args.armDurationMs/60000).toFixed(0)} min`);
  console.log(`  Entry model          : start ${args.startEntry} × decay ${args.decay}^(streak-3), floor ${args.minEntry}`);
  console.log();

  console.log('═════════════════ RESULTS ════════════════');
  summary('TOTAL', trades);
  summary('idle base (dca=0)',  trades.filter(t => t.mode === 'idle' && t.dcaRound === 0));
  summary('idle DCA  (dca≥1)',  trades.filter(t => t.mode === 'idle' && t.dcaRound >= 1));
  summary('armed base (dca=0)', trades.filter(t => t.mode === 'armed' && t.dcaRound === 0));
  summary('armed DCA (dca≥1)',  trades.filter(t => t.mode === 'armed' && t.dcaRound >= 1));
  console.log();

  // Breakdown by streak.
  console.log('  ── by entry streak ──');
  const byStreak = new Map<number, Trade[]>();
  for (const t of trades) {
    if (!byStreak.has(t.streak)) byStreak.set(t.streak, []);
    byStreak.get(t.streak)!.push(t);
  }
  for (const k of Array.from(byStreak.keys()).sort((a,b)=>a-b)) {
    summary(`streak=${k}`, byStreak.get(k)!);
  }
  console.log();

  // Largest single wins / losses.
  const sortedByPnl = [...trades].sort((a, b) => b.pnl - a.pnl);
  console.log('  ── top 3 wins ──');
  for (const t of sortedByPnl.slice(0, 3)) {
    console.log(`    ${new Date(t.ts).toISOString()}  ${t.mode}${t.dcaRound ? '+DCA':''}  streak=${t.streak} body3=$${t.body3.toFixed(0)}  pnl=$${fmt(t.pnl)}`);
  }
  console.log('  ── top 3 losses ──');
  for (const t of sortedByPnl.slice(-3).reverse()) {
    console.log(`    ${new Date(t.ts).toISOString()}  ${t.mode}${t.dcaRound ? '+DCA':''}  streak=${t.streak} body3=$${t.body3.toFixed(0)}  pnl=$${fmt(t.pnl)}`);
  }
  console.log();

  // Max consecutive losses.
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
  console.log(`    max consec losses   : ${maxStreakLoss}`);
  console.log(`    max drawdown        : $${maxDD.toFixed(2)}`);
  console.log(`    final equity        : $${runEquity.toFixed(2)}`);
  console.log();

  // Daily PnL.
  const daily = new Map<string, number>();
  for (const t of trades) {
    const d = new Date(t.ts).toISOString().slice(0, 10);
    daily.set(d, (daily.get(d) ?? 0) + t.pnl);
  }
  console.log('  ── daily pnl (last 14 days) ──');
  const days = Array.from(daily.keys()).sort();
  for (const d of days.slice(-14)) {
    const v = daily.get(d)!;
    const bar = v >= 0 ? '+'.repeat(Math.min(40, Math.round(v))) : '-'.repeat(Math.min(40, Math.round(-v)));
    console.log(`    ${d}   $${fmt(v).padStart(8)}   ${bar}`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
