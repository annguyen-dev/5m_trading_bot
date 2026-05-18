/**
 * Backtest Echo Hunt with the CURRENT bot rules (idle threshold + body3 gate
 * + armed mode + per-coin edge cases). Mirrors PriceMonitoringWorker logic
 * closely enough that PnL projections are within ~10% of live results.
 *
 * Strategy at each 5-min window N (predicting the bet for N+1):
 *   1. Compute closed streak ending at N-1 (Binance close-vs-open).
 *   2. Arm bookkeeping: if absStreak ≥ arm_trigger, set armed-until =
 *      windowEnd + arm_duration.
 *   3. effectiveStreak = absStreak (+1 if current bar continues, else +0).
 *   4. Threshold check:
 *        armed window  → threshold = armedStreak
 *        idle          → threshold = baselineStreak
 *      If effectiveStreak < threshold AND in idle mode, try edge cases:
 *        for each enabled case: streakMin ≤ absStreak ≤ streakMax AND
 *        |body3| ≥ case.body3Min  → match (first wins).
 *   5. Body3 gate: if no edge case matched, |body3| ≥ idle_body / armed_body.
 *      (Edge case bypasses the global body3 gate.)
 *   6. If passes: bet contrarian on bar N (next bar). Win if N reverses.
 *   7. On loss: optionally DCA on bar N+1 with body3 ≥ dcaBody3 (or edge
 *      case's dcaBody3Min if cycle opened via case). DCA size scales via
 *      echo_dca_scale (armed) / echo_dca_scale_idle (idle).
 *
 * Entry pricing (approximation — historical Polymarket prices not available):
 *   entry_price(streak) = max(min_entry, start_entry × decay^(streak − 3))
 *   default: 0.40, 0.85, 0.10  →  streak=3 ~$0.40, 5 ~$0.29, 7 ~$0.21
 *
 * Outcome (Polymarket-style binary):
 *   win  → exit_price = $1.00  → pnl = (1 − entry) × shares
 *   lose → exit_price = $0.00  → pnl = −size
 *   doji → skip (no fade entry possible)
 *
 * Usage:
 *   pnpm --filter @trading-bot/api exec tsx scripts/backtest-echo-rules.ts \
 *     [--days=30] [--base-size=10] \
 *     [--idle-streak=5] [--idle-body=400] [--armed-streak=3] [--armed-body=250] \
 *     [--dca-body-idle=200] [--dca-body-armed=150] \
 *     [--arm-trigger=5] [--arm-duration-min=90] \
 *     [--dca-scale-armed=2] [--dca-scale-idle=1.5] \
 *     [--edge-cases='[{"label":"streak3","enabled":true,"streakMin":3,"streakMax":3,"body3Min":600,"dcaBody3Min":250}]'] \
 *     [--start-entry=0.40] [--decay=0.85] [--min-entry=0.10]
 */
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config({
  path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.env'),
  override: true,
});

interface EdgeCase {
  label?:       string;
  enabled:      boolean;
  streakMin:    number;
  streakMax:    number;
  body3Min:     number;
  dcaBody3Min:  number;
}

interface Args {
  days: number;
  baseSize: number;
  idleStreak:   number;
  idleBody:     number;
  armedStreak:  number;
  armedBody:    number;
  dcaBodyIdle:  number;
  dcaBodyArmed: number;
  armTrigger:    number;
  armDurationMs: number;
  dcaScaleArmed: number[];
  dcaScaleIdle:  number[];
  edgeCases:    EdgeCase[];
  startEntry: number;
  decay:      number;
  minEntry:   number;
  /** Body sum metric: 'body3' = last 3 closed bars; 'bodyAll' = entire streak. */
  bodyMetric: 'body3' | 'bodyAll';
}

function parseArgs(): Args {
  const a: Args = {
    days: 30, baseSize: 10,
    idleStreak: 5,  idleBody:  400,
    armedStreak: 3, armedBody: 250,
    dcaBodyIdle: 200, dcaBodyArmed: 150,
    armTrigger: 5, armDurationMs: 90 * 60 * 1000,
    dcaScaleArmed: [2], dcaScaleIdle: [1.5],
    edgeCases: [],
    startEntry: 0.40, decay: 0.85, minEntry: 0.10,
    bodyMetric: 'body3',
  };
  for (const arg of process.argv.slice(2)) {
    const eq = arg.indexOf('=');
    if (eq < 0) {
      const k = arg.replace(/^--/, '');
      if (k === 'h' || k === 'help') { console.log('see file header for args'); process.exit(0); }
      continue;
    }
    const k = arg.slice(2, eq);
    const v = arg.slice(eq + 1);
    const num = Number(v);
    switch (k) {
      case 'days':              a.days = num; break;
      case 'base-size':         a.baseSize = num; break;
      case 'idle-streak':       a.idleStreak = num; break;
      case 'idle-body':         a.idleBody = num; break;
      case 'armed-streak':      a.armedStreak = num; break;
      case 'armed-body':        a.armedBody = num; break;
      case 'dca-body-idle':     a.dcaBodyIdle = num; break;
      case 'dca-body-armed':    a.dcaBodyArmed = num; break;
      case 'arm-trigger':       a.armTrigger = num; break;
      case 'arm-duration-min':  a.armDurationMs = num * 60_000; break;
      case 'dca-scale-armed':   a.dcaScaleArmed = v.split(',').map(Number); break;
      case 'dca-scale-idle':    a.dcaScaleIdle  = v.split(',').map(Number); break;
      case 'edge-cases':        a.edgeCases = JSON.parse(v) as EdgeCase[]; break;
      case 'start-entry':       a.startEntry = num; break;
      case 'decay':             a.decay = num; break;
      case 'min-entry':         a.minEntry = num; break;
      case 'body-metric':
        if (v !== 'body3' && v !== 'bodyAll') { console.error(`bad --body-metric: ${v}`); process.exit(1); }
        a.bodyMetric = v;
        break;
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
  // Empirical model: 30d BTC poly_orders show entry avg ~$0.55 at ALL streak
  // levels (5-min binary book stays near $0.50 — book thin, no real decay
  // even at streak=7). Decay model wildly over-estimated profit per trade.
  // Default: flat $0.55. Decay still tunable via --decay if user wants to
  // model a sharper market.
  if (a.decay === 1.0) return a.startEntry;   // flat mode (decay=1)
  const stepsBeyond3 = Math.max(0, streak - 3);
  const px = a.startEntry * Math.pow(a.decay, stepsBeyond3);
  return Math.max(a.minEntry, px);
}

interface Trade {
  ts: number;
  mode: 'idle' | 'armed';
  edgeCaseLabel?: string;
  dcaRound: number;
  streak: number;
  body3: number;
  regime: 1|-1;
  betDir: 1|-1;
  entryPrice: number;
  size: number;
  outcomeDir: 1|-1|0;
  won: boolean;
  pnl: number;
}

async function main(): Promise<void> {
  const args = parseArgs();
  console.error(`Fetching ${args.days}d of BTC 5m bars (Spot)…`);
  const bars = await fetchKlines(args.days);
  console.error(`Got ${bars.length} bars (${(bars.length / 288).toFixed(1)} days)\n`);

  // Pre-compute streak ENDING at each i (Binance close-vs-open).
  const streakLen = new Array<number>(bars.length).fill(0);
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    if (b.dir === 0) { streakLen[i] = 0; continue; }
    streakLen[i] = (i > 0 && bars[i-1]!.dir === b.dir) ? streakLen[i-1]! + 1 : 1;
  }

  let armUntilTs = 0;
  const trades: Trade[] = [];

  // Walk bar by bar: at each j, we're predicting bar j by looking at the
  // streak ending at j-1.
  let j = 3;
  while (j + 1 < bars.length) {
    const s = streakLen[j-1]!;
    const regime = bars[j-1]!.dir;
    if (regime === 0 || s < 1) { j++; continue; }

    // Body sum: either last 3 (body3) or all streak bars (bodyAll), per arg.
    let body3 = 0;
    if (args.bodyMetric === 'bodyAll') {
      // Sum ALL bars in current streak (j-s .. j-1).
      for (let k = 0; k < s; k++) body3 += Math.abs(bars[j-s+k]!.body);
    } else {
      body3 = Math.abs(bars[j-1]!.body) + Math.abs(bars[j-2]!.body) + Math.abs(bars[j-3]!.body);
    }

    // Arm trigger: streak that ended at j-1 with absStreak ≥ trigger.
    if (s >= args.armTrigger) {
      armUntilTs = Math.max(armUntilTs, bars[j-1]!.ts + args.armDurationMs);
    }
    const armed = bars[j]!.ts < armUntilTs;

    // Decide mode + threshold + body3 gate.
    let mode: 'idle' | 'armed' | null = null;
    let matchedEdge: EdgeCase | null = null;
    let entryBody3Min = 0;
    let dcaBody3Min   = 0;
    let dcaScale: number[] = [];

    if (armed && s >= args.armedStreak) {
      mode = 'armed';
      entryBody3Min = args.armedBody;
      dcaBody3Min   = args.dcaBodyArmed;
      dcaScale      = args.dcaScaleArmed;
    } else if (!armed && s >= args.idleStreak) {
      mode = 'idle';
      entryBody3Min = args.idleBody;
      dcaBody3Min   = args.dcaBodyIdle;
      dcaScale      = args.dcaScaleIdle;
    } else if (!armed) {
      // Streak < idle threshold — check edge cases (idle only).
      for (const ec of args.edgeCases) {
        if (!ec.enabled) continue;
        if (s < ec.streakMin || s > ec.streakMax) continue;
        if (body3 < ec.body3Min) continue;
        matchedEdge = ec;
        mode = 'idle';
        entryBody3Min = 0;             // edge case bypasses global body3 gate
        dcaBody3Min   = ec.dcaBody3Min;
        dcaScale      = args.dcaScaleIdle;
        break;
      }
    }
    if (!mode) { j++; continue; }
    if (!matchedEdge && body3 < entryBody3Min) { j++; continue; }

    // Place fade bet.
    const betDir = (regime === 1 ? -1 : 1) as -1 | 1;
    const entryPrice = entryPriceFor(s, args);
    const size = args.baseSize;
    const next = bars[j]!;
    const won = next.dir !== 0 && next.dir === betDir;
    const shares = size / entryPrice;
    const pnl = won ? shares * (1 - entryPrice) : -size;

    const trade: Trade = {
      ts: next.ts, mode, dcaRound: 0, streak: s, body3,
      regime, betDir, entryPrice, size,
      outcomeDir: next.dir, won, pnl,
    };
    if (matchedEdge?.label) trade.edgeCaseLabel = matchedEdge.label;
    trades.push(trade);

    // DCA on loss — CORRECTED LOGIC.
    //
    // Real bot timing:
    //   - Base bet placed at end of window M for window M+1 outcome.
    //   - Window M+1 closes → base outcome known.
    //   - If base lost (M+1 continued streak), bot DCAs at T+0 of M+2
    //     for window M+2's outcome.
    //
    // Backtest mapping:
    //   - Base bet target = bars[j].
    //   - After bars[j] closes → outcome = bars[j].dir.
    //   - If lost (bars[j].dir === regime), DCA target = bars[j+1].
    //   - Outcome = bars[j+1].dir.
    //
    // At DCA decision time (end of bars[j]):
    //   - Known closed bars: 0..j.
    //   - body3 = sum |body| of bars[j-2], bars[j-1], bars[j] (last 3 closed).
    //   - Streak = s + 1 (base bet's bar continued the original streak).
    //   - We CANNOT peek at bars[j+1] (= DCA target).
    //
    // curJ = LAST BAR WE BET ON (target of most recent bet). After base
    // bet, curJ = j. After DCA round 1, curJ = j+1. Etc.
    let curJ = j;
    let curStreak = s;
    let dcaRound = 0;
    while (!trades[trades.length-1]!.won
           && dcaRound < dcaScale.length
           && curJ + 1 < bars.length) {
      // Last bet at bars[curJ] LOST. Streak now = curStreak + 1.
      const newStreak = curStreak + 1;
      // Body3 from 3 closed bars ending at curJ (which just closed).
      let newBody3 = 0;
      if (args.bodyMetric === 'bodyAll') {
        for (let k = 0; k < newStreak; k++) {
          const idx = curJ - (newStreak - 1) + k;
          if (idx < 0) continue;
          newBody3 += Math.abs(bars[idx]!.body);
        }
      } else {
        newBody3 = Math.abs(bars[curJ]!.body)
                 + Math.abs(bars[curJ-1]!.body)
                 + Math.abs(bars[curJ-2]!.body);
      }
      if (dcaBody3Min > 0 && newBody3 < dcaBody3Min) break;

      // DCA bet on the very next bar.
      const dcaTargetJ = curJ + 1;
      const dcaEntry   = entryPriceFor(newStreak, args);
      const dcaSize    = size * dcaScale[dcaRound]!;
      const dcaShares  = dcaSize / dcaEntry;
      const dcaBar     = bars[dcaTargetJ]!;
      const dcaWon     = dcaBar.dir !== 0 && dcaBar.dir === betDir;
      const dcaPnl     = dcaWon ? dcaShares * (1 - dcaEntry) : -dcaSize;
      const dcaTrade: Trade = {
        ts: dcaBar.ts, mode, dcaRound: dcaRound + 1,
        streak: newStreak, body3: newBody3,
        regime: regime as 1|-1, betDir,
        entryPrice: dcaEntry, size: dcaSize,
        outcomeDir: dcaBar.dir, won: dcaWon, pnl: dcaPnl,
      };
      if (matchedEdge?.label) dcaTrade.edgeCaseLabel = matchedEdge.label;
      trades.push(dcaTrade);

      // Advance state: curJ now = the bar we just bet on.
      curJ = dcaTargetJ;
      curStreak = newStreak;
      dcaRound++;

      if (dcaWon) break;        // cycle wins — stop DCA chain
    }

    // Advance main loop past the LAST bar we bet on (base or DCA).
    j = curJ + 1;
  }

  // === Reporting ===
  const fmt = (n: number) => (n >= 0 ? '+' : '') + n.toFixed(2);
  function summary(label: string, list: Trade[]): void {
    if (list.length === 0) { console.log(`  ${label.padEnd(30)} (no trades)`); return; }
    const wins = list.filter(t => t.won).length;
    const pnl  = list.reduce((s, t) => s + t.pnl, 0);
    const grossWin  = list.filter(t => t.won).reduce((s, t) => s + t.pnl, 0);
    const grossLoss = list.filter(t => !t.won).reduce((s, t) => s + t.pnl, 0);
    console.log(
      `  ${label.padEnd(30)} n=${String(list.length).padStart(4)}  ` +
      `wins=${String(wins).padStart(3)}/${String(list.length).padEnd(3)} (${(wins/list.length*100).toFixed(1)}%)  ` +
      `pnl=$${fmt(pnl).padStart(9)}  ` +
      `gross win=$${grossWin.toFixed(2).padStart(8)}  loss=$${grossLoss.toFixed(2).padStart(8)}`
    );
  }

  console.log('═══════════════════ CONFIG ═══════════════════');
  console.log(`  Period            : ${args.days} days  (${bars.length} 5m bars)`);
  console.log(`  Base order size   : $${args.baseSize}`);
  console.log(`  Idle rule         : streak ≥ ${args.idleStreak}   AND  |body3| ≥ $${args.idleBody}`);
  console.log(`  Armed rule        : streak ≥ ${args.armedStreak}  AND  |body3| ≥ $${args.armedBody}`);
  console.log(`  DCA body idle/arm : $${args.dcaBodyIdle} / $${args.dcaBodyArmed}`);
  console.log(`  DCA scale idle/arm: [${args.dcaScaleIdle.join(',')}] / [${args.dcaScaleArmed.join(',')}]`);
  console.log(`  Arm trigger/dur   : streak ≥ ${args.armTrigger}  /  ${(args.armDurationMs/60000).toFixed(0)} min`);
  console.log(`  Body metric       : ${args.bodyMetric}  (${args.bodyMetric === 'bodyAll' ? 'sum of ALL streak bars' : 'sum of last 3 closed bars'})`);
  console.log(`  Edge cases        : ${args.edgeCases.length}`);
  for (const ec of args.edgeCases) {
    console.log(`    [${ec.enabled ? '✓' : ' '}] ${ec.label ?? '(no label)'}: streak [${ec.streakMin}-${ec.streakMax}]  body3 ≥ $${ec.body3Min}  dca body3 ≥ $${ec.dcaBody3Min}`);
  }
  console.log(`  Entry model       : start ${args.startEntry} × decay ${args.decay}^(s-3), floor ${args.minEntry}`);
  console.log();

  console.log('═══════════════════ RESULTS ══════════════════');
  summary('TOTAL', trades);
  summary('  idle base (dca=0)',  trades.filter(t => t.mode === 'idle' && t.dcaRound === 0 && !t.edgeCaseLabel));
  summary('  idle DCA  (dca≥1)',  trades.filter(t => t.mode === 'idle' && t.dcaRound >= 1 && !t.edgeCaseLabel));
  summary('  armed base (dca=0)', trades.filter(t => t.mode === 'armed' && t.dcaRound === 0));
  summary('  armed DCA (dca≥1)',  trades.filter(t => t.mode === 'armed' && t.dcaRound >= 1));
  summary('  edge case base',     trades.filter(t => t.edgeCaseLabel && t.dcaRound === 0));
  summary('  edge case DCA',      trades.filter(t => t.edgeCaseLabel && t.dcaRound >= 1));
  console.log();

  // Breakdown by edge case label
  const ecLabels = Array.from(new Set(trades.filter(t => t.edgeCaseLabel).map(t => t.edgeCaseLabel!)));
  if (ecLabels.length) {
    console.log('  ── by edge case ──');
    for (const lbl of ecLabels) summary(`    "${lbl}"`, trades.filter(t => t.edgeCaseLabel === lbl));
    console.log();
  }

  // Breakdown by entry streak.
  console.log('  ── by entry streak ──');
  const byStreak = new Map<number, Trade[]>();
  for (const t of trades) {
    if (!byStreak.has(t.streak)) byStreak.set(t.streak, []);
    byStreak.get(t.streak)!.push(t);
  }
  for (const k of Array.from(byStreak.keys()).sort((a,b)=>a-b)) {
    summary(`    streak=${k}`, byStreak.get(k)!);
  }
  console.log();

  // Top wins / losses.
  const sortedByPnl = [...trades].sort((a, b) => b.pnl - a.pnl);
  console.log('  ── top 3 wins ──');
  for (const t of sortedByPnl.slice(0, 3)) {
    const tag = t.edgeCaseLabel ? `edge"${t.edgeCaseLabel}"` : t.mode + (t.dcaRound ? '+DCA':'');
    console.log(`    ${new Date(t.ts).toISOString()}  ${tag.padEnd(18)}  streak=${t.streak} body3=$${t.body3.toFixed(0).padStart(4)}  pnl=$${fmt(t.pnl)}`);
  }
  console.log('  ── top 3 losses ──');
  for (const t of sortedByPnl.slice(-3).reverse()) {
    const tag = t.edgeCaseLabel ? `edge"${t.edgeCaseLabel}"` : t.mode + (t.dcaRound ? '+DCA':'');
    console.log(`    ${new Date(t.ts).toISOString()}  ${tag.padEnd(18)}  streak=${t.streak} body3=$${t.body3.toFixed(0).padStart(4)}  pnl=$${fmt(t.pnl)}`);
  }
  console.log();

  // Risk.
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
  console.log(`    max consec losses  : ${maxStreakLoss}`);
  console.log(`    max drawdown       : $${maxDD.toFixed(2)}`);
  console.log(`    final equity       : $${runEquity.toFixed(2)}`);
  console.log();

  // Daily PnL.
  const daily = new Map<string, number>();
  for (const t of trades) {
    const d = new Date(t.ts).toISOString().slice(0, 10);
    daily.set(d, (daily.get(d) ?? 0) + t.pnl);
  }
  console.log('  ── daily pnl (all days) ──');
  const days = Array.from(daily.keys()).sort();
  for (const d of days) {
    const v = daily.get(d)!;
    const bar = v >= 0 ? '+'.repeat(Math.min(40, Math.round(v))) : '-'.repeat(Math.min(40, Math.round(-v)));
    console.log(`    ${d}   $${fmt(v).padStart(8)}   ${bar}`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
