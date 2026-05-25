/**
 * Analyze whether the Echo Hunt ARM trigger should gate on body3-at-trigger.
 *
 * Today the bot arms purely on streak count: `absStreak >= echo_trigger_streak`
 * (PriceMonitoringWorker.ts:620). body3 only gates PLACEMENT later (Gate 2b),
 * never the arm decision. This script asks: if we ALSO required the triggering
 * streak's body3 ≥ X to open the arm window, do the fades enabled by arming
 * improve, and what's the net effect on the full strategy?
 *
 * Two views, both off the same Binance 5m klines so numbers are comparable to
 * backtest-echo-rules.ts:
 *
 *   (A) DIAGNOSTIC — armed-base fade win-rate bucketed by body3-at-trigger.
 *       Isolates the quality of the arming signal itself. Win-rate is
 *       pricing-independent (next bar reverses or not), so it's the headline.
 *
 *   (B) SWEEP — full strategy (idle + armed + body3 placement gate + DCA),
 *       run for several arm_trigger_body3_min values. Shows net trades / WR /
 *       PnL / max-drawdown so the threshold choice is decision-ready.
 *
 * Prod-faithful vs backtest-echo-rules.ts (which has stale script defaults):
 *   - arm window = 30 min (echo_window_minutes), not 90.
 *   - armed mode applies from the NEXT window onward — the window that armed
 *     the bot still uses the idle/baseline gate (lastEchoTriggerAt = windowEnd,
 *     PriceMonitoringWorker.ts:621-630). Implemented by computing `armed` from
 *     PRIOR triggers before registering the current bar's trigger.
 *   - thresholds = prod BTC: trigger 5, armed(signal) 4, idle(baseline) 6,
 *     armed_body3 300, idle_body3 400, dca_body3 150/200, dca scale [3,4].
 *
 * Pricing: flat $0.55 entry (backtest-echo-rules.ts notes the decay model
 * over-estimates; live 5m books sit near $0.50-0.55 at all streaks). Tune with
 * --entry. PnL is directional only — read win-rate as the primary signal.
 *
 * Usage:
 *   pnpm --filter @trading-bot/api exec tsx scripts/analyze-arm-body3.ts \
 *     [--days=180] [--symbol=BTCUSDT] [--entry=0.55] [--base-size=10]
 */
// No env needed — hits the public Binance klines API only.

// ── Prod BTC echo config (packages/core/src/CoinConfig.ts) ──────────────────
const ARM_TRIGGER     = 5;             // echo_trigger_streak
const ARM_DURATION_MS = 30 * 60_000;   // echo_window_minutes
const ARMED_STREAK    = 4;             // echo_signal_min_streak
const IDLE_STREAK     = 6;             // echo_baseline_streak
const ARMED_BODY      = 300;           // armed_body3_min (BTC)
const IDLE_BODY       = 400;           // idle_body3_min (BTC)
const DCA_BODY_ARMED  = 150;           // dca_body3_min_armed (BTC)
const DCA_BODY_IDLE   = 200;           // dca_body3_min_idle (BTC)
const DCA_SCALE       = [3, 4];        // echo_dca_scale (idle falls back to it)

interface Args { days: number; symbol: string; entry: number; baseSize: number }

function parseArgs(): Args {
  const a: Args = { days: 180, symbol: 'BTCUSDT', entry: 0.55, baseSize: 10 };
  for (const arg of process.argv.slice(2)) {
    const eq = arg.indexOf('=');
    if (eq < 0) continue;
    const k = arg.slice(2, eq), v = arg.slice(eq + 1);
    switch (k) {
      case 'days':      a.days = Number(v); break;
      case 'symbol':    a.symbol = v; break;
      case 'entry':     a.entry = Number(v); break;
      case 'base-size': a.baseSize = Number(v); break;
      default: console.error(`unknown arg: --${k}`); process.exit(1);
    }
  }
  return a;
}

interface Bar { ts: number; open: number; close: number; body: number; dir: 1|-1|0 }

async function fetchKlines(symbol: string, days: number): Promise<Bar[]> {
  const endMs = Date.now(), startMs = endMs - days * 86400_000;
  const all: Bar[] = []; let cursor = startMs, pages = 0;
  while (cursor < endMs) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=5m&startTime=${cursor}&endTime=${endMs}&limit=1000`;
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
  mode: 'idle' | 'armed';
  dcaRound: number;
  streak: number;
  body3: number;            // body3 at entry (placement gate input)
  body3AtTrigger: number;   // body3 of the arm event that armed this bet (armed only; -1 if idle)
  won: boolean;
  pnl: number;
}

/**
 * Full-strategy walk. `armBody3Min` gates the arm trigger: an arm event only
 * opens/extends the window when the triggering streak's body3 ≥ armBody3Min.
 * armBody3Min = 0 reproduces today's prod behaviour (count-only arming).
 */
function simulate(bars: Bar[], streakLen: number[], a: Args, armBody3Min: number): Trade[] {
  const trades: Trade[] = [];
  let armUntilTs = 0;
  let lastArmBody3 = -1;   // body3 of the most recent qualifying arm event

  let j = 3;
  while (j + 1 < bars.length) {
    const s = streakLen[j-1]!;
    const regime = bars[j-1]!.dir;
    if (regime === 0 || s < 1) { j++; continue; }

    const body3 = Math.abs(bars[j-1]!.body) + Math.abs(bars[j-2]!.body) + Math.abs(bars[j-3]!.body);

    // Prod-faithful: decide `armed` from PRIOR triggers BEFORE registering this
    // bar's trigger — the window that arms still bets under the idle gate.
    const armed = bars[j]!.ts < armUntilTs;
    const body3AtTrigger = armed ? lastArmBody3 : -1;

    // Register this bar's arm event (effective from the NEXT window).
    if (s >= ARM_TRIGGER && body3 >= armBody3Min) {
      armUntilTs   = Math.max(armUntilTs, bars[j-1]!.ts + ARM_DURATION_MS);
      lastArmBody3 = body3;
    }

    // Mode + thresholds.
    let mode: 'idle' | 'armed' | null = null;
    let entryBody3Min = 0, dcaBody3Min = 0;
    if (armed && s >= ARMED_STREAK)       { mode = 'armed'; entryBody3Min = ARMED_BODY; dcaBody3Min = DCA_BODY_ARMED; }
    else if (!armed && s >= IDLE_STREAK)  { mode = 'idle';  entryBody3Min = IDLE_BODY;  dcaBody3Min = DCA_BODY_IDLE; }
    if (!mode) { j++; continue; }
    if (body3 < entryBody3Min) { j++; continue; }

    // Base fade on bar j.
    const betDir = (regime === 1 ? -1 : 1) as -1 | 1;
    const next = bars[j]!;
    const won = next.dir !== 0 && next.dir === betDir;
    const shares = a.baseSize / a.entry;
    const pnl = won ? shares * (1 - a.entry) : -a.baseSize;
    trades.push({ ts: next.ts, mode, dcaRound: 0, streak: s, body3, body3AtTrigger, won, pnl });

    // DCA on loss (mirrors backtest-echo-rules.ts).
    let curJ = j, curStreak = s, dcaRound = 0;
    while (!trades[trades.length-1]!.won && dcaRound < DCA_SCALE.length && curJ + 1 < bars.length) {
      const newStreak = curStreak + 1;
      const newBody3 = Math.abs(bars[curJ]!.body) + Math.abs(bars[curJ-1]!.body) + Math.abs(bars[curJ-2]!.body);
      if (dcaBody3Min > 0 && newBody3 < dcaBody3Min) break;
      const dcaTargetJ = curJ + 1;
      const dcaSize = a.baseSize * DCA_SCALE[dcaRound]!;
      const dcaShares = dcaSize / a.entry;
      const dcaBar = bars[dcaTargetJ]!;
      const dcaWon = dcaBar.dir !== 0 && dcaBar.dir === betDir;
      const dcaPnl = dcaWon ? dcaShares * (1 - a.entry) : -dcaSize;
      trades.push({ ts: dcaBar.ts, mode, dcaRound: dcaRound + 1, streak: newStreak, body3: newBody3, body3AtTrigger, won: dcaWon, pnl: dcaPnl });
      curJ = dcaTargetJ; curStreak = newStreak; dcaRound++;
      if (dcaWon) break;
    }
    j = curJ + 1;
  }
  return trades;
}

function wr(list: Trade[]): string {
  if (!list.length) return '   —  ';
  return `${(list.filter(t => t.won).length / list.length * 100).toFixed(1)}%`;
}
function pnlOf(list: Trade[]): number { return list.reduce((s, t) => s + t.pnl, 0); }
function maxDD(list: Trade[]): number {
  let eq = 0, peak = 0, dd = 0;
  for (const t of list) { eq += t.pnl; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  return dd;
}

async function main(): Promise<void> {
  const a = parseArgs();
  console.error(`Fetching ${a.days}d of ${a.symbol} 5m bars…`);
  const bars = await fetchKlines(a.symbol, a.days);
  console.error(`Got ${bars.length} bars (${(bars.length / 288).toFixed(1)} days)\n`);

  const streakLen = new Array<number>(bars.length).fill(0);
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    if (b.dir === 0) { streakLen[i] = 0; continue; }
    streakLen[i] = (i > 0 && bars[i-1]!.dir === b.dir) ? streakLen[i-1]! + 1 : 1;
  }

  console.log('══════════════════════════════════════════════════════════════');
  console.log(`  ARM-vs-body3 analysis — ${a.symbol}  ${a.days}d  (${(bars.length/288).toFixed(0)} days)`);
  console.log(`  prod cfg: trigger≥${ARM_TRIGGER} arm=${ARM_DURATION_MS/60000}m  armed≥${ARMED_STREAK}/body${ARMED_BODY}  idle≥${IDLE_STREAK}/body${IDLE_BODY}  dca[${DCA_SCALE}]`);
  console.log(`  entry flat $${a.entry}  base $${a.baseSize}  (WR is pricing-independent → primary signal)`);
  console.log('══════════════════════════════════════════════════════════════\n');

  // ── (A) DIAGNOSTIC ────────────────────────────────────────────────────────
  // Today's behaviour (armBody3Min=0): bucket ARMED-BASE fades by body3-at-trigger.
  const base = simulate(bars, streakLen, a, 0);
  const armedBase = base.filter(t => t.mode === 'armed' && t.dcaRound === 0);

  console.log('(A) ARMED-BASE fade win-rate by body3-AT-TRIGGER  (current prod = no arm gate)');
  console.log('    body3-at-trigger = |body| sum of the 3 streak bars that opened the arm window\n');
  const buckets: [number, number][] = [[0,100],[100,200],[200,300],[300,400],[400,500],[500,1e9]];
  console.log('    bucket($)      n    wins    WR     net$    avg$/trade');
  for (const [lo, hi] of buckets) {
    const g = armedBase.filter(t => t.body3AtTrigger >= lo && t.body3AtTrigger < hi);
    const p = pnlOf(g);
    const label = hi >= 1e9 ? `${lo}+` : `${lo}-${hi}`;
    console.log(
      `    ${label.padEnd(10)} ${String(g.length).padStart(4)}  ${String(g.filter(t=>t.won).length).padStart(4)}   ${wr(g).padStart(6)}  ${(p>=0?'+':'')+p.toFixed(0)}`.padEnd(58)
      + (g.length ? `$${(p/g.length).toFixed(2)}` : ''),
    );
  }
  console.log(`    ${'ALL armed-base'.padEnd(10)} ${String(armedBase.length).padStart(4)}  ${String(armedBase.filter(t=>t.won).length).padStart(4)}   ${wr(armedBase).padStart(6)}  ${(pnlOf(armedBase)>=0?'+':'')+pnlOf(armedBase).toFixed(0)}`);
  // Reference: unconditional next-bar reversal rate for streak≥trigger.
  let revN = 0, revHit = 0;
  for (let i = ARM_TRIGGER; i + 1 < bars.length; i++) {
    if (streakLen[i]! >= ARM_TRIGGER && bars[i]!.dir !== 0 && bars[i+1]!.dir !== 0) {
      revN++; if (bars[i+1]!.dir === -bars[i]!.dir) revHit++;
    }
  }
  console.log(`\n    reference: P(next bar reverses | streak≥${ARM_TRIGGER}) = ${(revHit/revN*100).toFixed(1)}%  (n=${revN})`);
  console.log(`    → buckets BELOW this line add no edge; buckets at/above it are where arming pays.\n`);

  // ── (B) SWEEP ─────────────────────────────────────────────────────────────
  console.log('(B) FULL-STRATEGY sweep of arm_trigger_body3_min  (0 = current prod)\n');
  console.log('    thr$   armEvts | armed-base: n   WR    net$ || TOTAL: n    WR    net$    maxDD');
  for (const thr of [0, 100, 150, 200, 250, 300, 350, 400, 450, 500]) {
    const tr = simulate(bars, streakLen, a, thr);
    const ab = tr.filter(t => t.mode === 'armed' && t.dcaRound === 0);
    // Count distinct arm events that pass the gate.
    let armEvts = 0;
    for (let i = ARM_TRIGGER; i < bars.length; i++) {
      const s = streakLen[i]!;
      const b3 = i>=3 ? Math.abs(bars[i]!.body)+Math.abs(bars[i-1]!.body)+Math.abs(bars[i-2]!.body) : 0;
      const prevS = streakLen[i-1] ?? 0;
      if (s >= ARM_TRIGGER && prevS < ARM_TRIGGER && b3 >= thr) armEvts++; // fresh crossings only
    }
    const marker = thr === 0 ? ' ←prod' : '';
    console.log(
      `    ${String(thr).padStart(4)}  ${String(armEvts).padStart(6)}  | `
      + `${String(ab.length).padStart(11)}  ${wr(ab).padStart(5)}  ${((pnlOf(ab)>=0?'+':'')+pnlOf(ab).toFixed(0)).padStart(6)} || `
      + `${String(tr.length).padStart(5)}  ${wr(tr).padStart(5)}  ${((pnlOf(tr)>=0?'+':'')+pnlOf(tr).toFixed(0)).padStart(7)}  ${('$'+maxDD(tr).toFixed(0)).padStart(7)}${marker}`,
    );
  }
  console.log('\n    armed-base = the fades that ONLY exist because of arming (streak in [4,6)).');
  console.log('    Raising thr removes weak-body3 arms; watch armed-base WR rise vs n/PnL lost.\n');

  // No-arm reference (disable armed mode entirely → idle-only).
  const noArm = simulate(bars, streakLen, { ...a }, Number.POSITIVE_INFINITY);
  console.log(`    reference (arm fully OFF, idle-only): n=${noArm.length}  WR=${wr(noArm)}  net=$${pnlOf(noArm).toFixed(0)}  maxDD=$${maxDD(noArm).toFixed(0)}`);
}

main().catch(err => { console.error(err); process.exit(1); });
