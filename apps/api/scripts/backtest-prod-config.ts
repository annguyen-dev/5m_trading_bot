/**
 * Backtest the CURRENT prod BTC config (snapshot from settings.coin_configs on
 * 13.235.115.6) and emit a Markdown report with the config block FIRST.
 *
 * Combines the two prior tools so the run is faithful to live behaviour:
 *   - analyze-arm-body3.ts : arm_trigger_body3_min gate + prod-faithful arm
 *                            timing (armed applies from the NEXT window).
 *   - backtest-echo-rules.ts: idle/armed thresholds, body3 placement gates,
 *                            edge-case overrides (idle-only), DCA scales.
 *
 * IMPORTANT: the live runtime value of `arm_trigger_body3_min` for BTC is the
 * STORED DB value (150), which overrides the code PER_COIN_OVERRIDES default
 * (100) — `getCoinConfig` merges {DEFAULT, PER_COIN_OVERRIDES, stored} and
 * stored wins. This backtest uses the live DB value.
 *
 * Pricing: flat entry (default $0.55 — live 5m books sit near $0.50-0.55 at all
 * streaks; the decay model over-estimates). PnL is directional/relative; WR is
 * pricing-independent and is the primary signal. Outcome is binary settlement
 * (win → $1, lose → $0), matching Polymarket resolution.
 *
 * Usage:
 *   pnpm --filter @trading-bot/api exec tsx scripts/backtest-prod-config.ts \
 *     [--days=90,180,365] [--entry=0.55] [--out=scripts/backtest-prod-config.md]
 */
import { writeFileSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

interface EdgeCase { label: string; enabled: boolean; streakMin: number; streakMax: number; body3Min: number; body3Max?: number; dcaBody3Min: number }
interface BtcCfg {
  fetched_at: string; source: string;
  enabled: boolean; strategy: string; mode: string;
  size_usdc: number; limit_price_cents: number; tp_cents: number; sl_cents: number;
  echo_trigger_streak: number; echo_window_minutes: number;
  echo_signal_min_streak: number; echo_baseline_streak: number; echo_require_high_body: boolean;
  arm_trigger_body3_min: number; idle_body3_min: number; armed_body3_min: number;
  dca_body3_min_idle: number; dca_body3_min_armed: number;
  echo_dca_scale: number[]; echo_dca_scale_idle: number[]; echo_edge_cases: EdgeCase[];
  echo_defensive_enabled: boolean; echo_chain_enabled: boolean;
  streak_min: number; auto_order_min_streak: number; dca_multiplier: number; dca_streak_whitelist: number[];
}

// ── prod BTC config snapshot (settings.coin_configs, fetched 2026-05-25) ─────
// Fallback/default. Pass --config-file=<btc.json> (the BTC object straight from
// the DB) to override with live values without editing this file — known keys
// below are overwritten, legacy/unknown DB keys are ignored.
// Only echo-relevant fields drive the sim; streak-strategy fields
// (auto_*, dca_multiplier, dca_streak_whitelist) do NOT apply to echo.
const PROD_BTC: BtcCfg = {
  fetched_at: '2026-05-25',
  source: 'settings.coin_configs @ 13.235.115.6',
  enabled: true,
  strategy: 'echo',
  mode: 'signal_and_order',
  size_usdc: 5,
  limit_price_cents: 69,
  tp_cents: 95,
  sl_cents: 10,
  // echo gates
  echo_trigger_streak: 5,
  echo_window_minutes: 120,
  echo_signal_min_streak: 3,   // armed threshold
  echo_baseline_streak: 5,     // idle threshold
  echo_require_high_body: false,
  arm_trigger_body3_min: 100,
  idle_body3_min: 150,
  armed_body3_min: 150,
  dca_body3_min_idle: 200,
  dca_body3_min_armed: 150,
  echo_dca_scale: [2],
  echo_dca_scale_idle: [2],
  echo_edge_cases: [
    { label: 'streak3', enabled: true, streakMin: 3, streakMax: 3, body3Min: 440, dcaBody3Min: 250 },
    { label: 'streak4', enabled: true, streakMin: 4, streakMax: 4, body3Min: 420, dcaBody3Min: 300 },
    { label: '7',       enabled: true, streakMin: 7, streakMax: 7, body3Min: 120, dcaBody3Min: 100 },
  ],
  echo_defensive_enabled: false,
  echo_chain_enabled: false,
  // streak-strategy fields (NOT used by echo sim, recorded for provenance)
  streak_min: 2,
  auto_order_min_streak: 7,
  dca_multiplier: 1.8,
  dca_streak_whitelist: [4, 5, 9, 10],
};

/** Load live BTC config object from a JSON file and override known keys. */
function loadConfig(file: string | undefined): BtcCfg {
  if (!file) return PROD_BTC;
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  // File may be the whole coin_configs object or just the BTC slice.
  const btc = (raw['BTC'] ?? raw) as Record<string, unknown>;
  const cfg: BtcCfg = { ...PROD_BTC, fetched_at: new Date().toISOString().slice(0, 10), source: `${file} (live DB)` };
  for (const k of Object.keys(PROD_BTC) as (keyof BtcCfg)[]) {
    if (k === 'fetched_at' || k === 'source') continue;
    if (k in btc && btc[k] != null) (cfg as Record<string, unknown>)[k] = btc[k];
  }
  return cfg;
}

type EdgeMode = 'legacy' | 'universal' | 'fallback';
interface Args {
  days: number[]; entry: number; out: string; configFile?: string;
  edgeMode: EdgeMode; armOnEdge: boolean;
  // arm-trigger filters (sim-only flags, NOT live code yet).
  armStreakMax?: number;                // skip arm if streak > this
  armBody3Max?: number;                 // skip arm if body3 > this (caps momentum bars)
  armPriorVolSkip?: [number, number];   // skip arm if prior 1h vol in [lo, hi]
  armPriorVolRange?: [number, number];  // arm ONLY if prior 1h vol in [lo, hi]
}
function parseArgs(): Args {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const a: Args = { days: [90, 180, 365], entry: 0.55, out: path.join(here, 'results', 'backtest-prod-config.md'), edgeMode: 'legacy', armOnEdge: false };
  for (const arg of process.argv.slice(2)) {
    if (arg === '--edges-universal') { a.edgeMode = 'universal'; continue; }
    if (arg === '--edges-fallback')  { a.edgeMode = 'fallback';  continue; }
    if (arg === '--arm-on-edge')     { a.armOnEdge = true; continue; }
    const eq = arg.indexOf('='); if (eq < 0) continue;
    const k = arg.slice(2, eq), v = arg.slice(eq + 1);
    if (k === 'days')  a.days = v.split(',').map(Number);
    else if (k === 'entry') a.entry = Number(v);
    else if (k === 'out')   a.out = path.isAbsolute(v) ? v : path.join(here, v);
    else if (k === 'config-file') a.configFile = path.isAbsolute(v) ? v : path.join(here, v);
    else if (k === 'arm-streak-max') a.armStreakMax = Number(v);
    else if (k === 'arm-body3-max')  a.armBody3Max = Number(v);
    else if (k === 'arm-skip-vol') {
      const [lo, hi] = v.split(',').map(Number);
      a.armPriorVolSkip = [lo ?? 0, hi ?? 1e9];
    }
    else if (k === 'arm-vol-range') {
      const [lo, hi] = v.split(',').map(Number);
      a.armPriorVolRange = [lo ?? 0, hi ?? 1e9];
    }
    else { console.error(`unknown arg: --${k}`); process.exit(1); }
  }
  return a;
}

interface Bar { ts: number; open: number; close: number; dir: 1|-1|0 }
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
      all.push({ ts, open, close, dir: close > open ? 1 : close < open ? -1 : 0 });
    }
    const lastTs = Number(rows[rows.length-1]?.[0] ?? 0);
    if (lastTs <= cursor) break;
    cursor = lastTs + 1; pages++;
    if (pages % 10 === 0) process.stderr.write(`  fetched ${all.length} bars…\n`);
    await new Promise(r => setTimeout(r, 80));
  }
  return all;
}

type Mode = 'idle' | 'armed' | 'edge';
interface Trade { ts: number; mode: Mode; edgeLabel?: string; dcaRound: number; streak: number; body3: number; won: boolean; pnl: number }

/** Full prod-faithful echo walk. Records trades whose bet bar ts >= recordFrom
 *  (state warms up from before that). */
function simulate(
  bars: Bar[], streakLen: number[], entry: number, recordFrom: number,
  c: BtcCfg, edgeMode: EdgeMode, armOnEdge: boolean,
  armStreakMax: number | undefined, armBody3Max: number | undefined,
  armPriorVolSkip: [number, number] | undefined,
  armPriorVolRange: [number, number] | undefined,
): Trade[] {
  const armDurMs = c.echo_window_minutes * 60_000;
  const dcaScaleIdle = c.echo_dca_scale_idle.length ? c.echo_dca_scale_idle : c.echo_dca_scale;
  const trades: Trade[] = [];
  let armUntilTs = 0;
  let j = 3;
  // Diagnostic: arm triggers by streak (counts only bars at ts >= recordFrom).
  const armTrigByStreak = new Map<number, number>();
  while (j + 1 < bars.length) {
    const s = streakLen[j-1]!;
    const regime = bars[j-1]!.dir;
    if (regime === 0 || s < 1) { j++; continue; }
    const body3 = Math.abs(bars[j-1]!.close - bars[j-1]!.open)
                + Math.abs(bars[j-2]!.close - bars[j-2]!.open)
                + Math.abs(bars[j-3]!.close - bars[j-3]!.open);

    // armed decided from PRIOR triggers (arm applies from NEXT window).
    const armed = bars[j]!.ts < armUntilTs;
    // Discovery filters (CLI-only flags, NOT in live worker code yet):
    //   --arm-streak-max=N    → skip arm if streak > N (avoids over-extension trap)
    //   --arm-body3-max=N     → skip arm if body3 > N (caps extreme-momentum bars)
    //   --arm-skip-vol=lo,hi  → skip arm if prior 1h vol IN [lo,hi]
    //   --arm-vol-range=lo,hi → arm ONLY if prior 1h vol IN [lo,hi]
    let triggerOk = s >= c.echo_trigger_streak && body3 >= c.arm_trigger_body3_min;
    if (triggerOk && armStreakMax != null && s > armStreakMax) triggerOk = false;
    if (triggerOk && armBody3Max  != null && body3 > armBody3Max) triggerOk = false;
    if (triggerOk && (armPriorVolSkip || armPriorVolRange)) {
      let pv = 0;
      const lo = Math.max(0, j - 13);
      for (let k = lo; k < j - 1; k++) pv += Math.abs(bars[k]!.close - bars[k]!.open);
      if (armPriorVolSkip  && pv >= armPriorVolSkip[0]  && pv < armPriorVolSkip[1])  triggerOk = false;
      if (armPriorVolRange && (pv < armPriorVolRange[0] || pv >= armPriorVolRange[1])) triggerOk = false;
    }
    if (triggerOk) {
      armUntilTs = Math.max(armUntilTs, bars[j-1]!.ts + armDurMs);
      if (bars[j-1]!.ts >= recordFrom) {
        armTrigByStreak.set(s, (armTrigByStreak.get(s) ?? 0) + 1);
      }
    }

    let mode: Mode | null = null;
    let edgeLabel: string | undefined;
    let entryBody = 0, dcaBody = 0, dcaScale: readonly number[] = [];

    const tryEdge = (): boolean => {
      for (const ec of c.echo_edge_cases) {
        if (!ec.enabled || s < ec.streakMin || s > ec.streakMax || body3 < ec.body3Min) continue;
        if (ec.body3Max != null && body3 > ec.body3Max) continue;
        mode = 'edge'; edgeLabel = ec.label; entryBody = 0; dcaBody = ec.dcaBody3Min;
        dcaScale = armed ? c.echo_dca_scale : dcaScaleIdle;
        return true;
      }
      return false;
    };

    // universal: edge FIRST (takes precedence over normal when both match).
    if (edgeMode === 'universal') tryEdge();

    // normal gates.
    if (!mode && armed && s >= c.echo_signal_min_streak) {
      mode = 'armed'; entryBody = c.armed_body3_min; dcaBody = c.dca_body3_min_armed; dcaScale = c.echo_dca_scale;
    } else if (!mode && !armed && s >= c.echo_baseline_streak) {
      mode = 'idle'; entryBody = c.idle_body3_min; dcaBody = c.dca_body3_min_idle; dcaScale = dcaScaleIdle;
    } else if (!mode && !armed && edgeMode === 'legacy') {
      // legacy: edges only when idle + streak < baseline.
      tryEdge();
    }

    // fallback: if normal didn't pass body3 either, try edge as rescue.
    if (mode && mode !== 'edge' && body3 < entryBody && edgeMode === 'fallback') {
      mode = null; entryBody = 0;
      tryEdge();
    } else if (!mode && edgeMode === 'fallback') {
      // streak gate failed in armed/idle → still try edge.
      tryEdge();
    }

    // arm-on-edge: edge fire ALSO arms (in addition to the streak>=trigger rule above).
    // Captures the case streak3/streak4 edges fire but streak<5 means the normal arm
    // trigger wouldn't fire — under this flag, the edge fire itself counts as a trigger.
    if (armOnEdge && mode === 'edge') {
      const streakPathArmed = (s >= c.echo_trigger_streak && body3 >= c.arm_trigger_body3_min);
      const newArm = bars[j-1]!.ts + armDurMs;
      if (newArm > armUntilTs) armUntilTs = newArm;
      if (!streakPathArmed && bars[j-1]!.ts >= recordFrom) {
        // separately track edge-only arms (negate the key to distinguish in the report)
        armTrigByStreak.set(-s, (armTrigByStreak.get(-s) ?? 0) + 1);
      }
    }

    if (!mode) { j++; continue; }
    if (mode !== 'edge' && body3 < entryBody) { j++; continue; }

    const betDir = (regime === 1 ? -1 : 1) as -1|1;
    const next = bars[j]!;
    const won = next.dir !== 0 && next.dir === betDir;
    const shares = c.size_usdc / entry;
    const pnl = won ? shares * (1 - entry) : -c.size_usdc;
    if (next.ts >= recordFrom) {
      const t: Trade = { ts: next.ts, mode, dcaRound: 0, streak: s, body3, won, pnl };
      if (edgeLabel) t.edgeLabel = edgeLabel;
      trades.push(t);
    }

    // DCA on loss.
    let curJ = j, curStreak = s, dcaRound = 0, lastWon = won;
    while (!lastWon && dcaRound < dcaScale.length && curJ + 1 < bars.length) {
      const newStreak = curStreak + 1;
      const nb3 = Math.abs(bars[curJ]!.close - bars[curJ]!.open)
                + Math.abs(bars[curJ-1]!.close - bars[curJ-1]!.open)
                + Math.abs(bars[curJ-2]!.close - bars[curJ-2]!.open);
      if (dcaBody > 0 && nb3 < dcaBody) break;
      const dcaTargetJ = curJ + 1;
      const dcaSize = c.size_usdc * dcaScale[dcaRound]!;
      const dcaBar = bars[dcaTargetJ]!;
      const dcaWon = dcaBar.dir !== 0 && dcaBar.dir === betDir;
      const dcaPnl = dcaWon ? (dcaSize / entry) * (1 - entry) : -dcaSize;
      if (dcaBar.ts >= recordFrom) {
        const t: Trade = { ts: dcaBar.ts, mode, dcaRound: dcaRound + 1, streak: newStreak, body3: nb3, won: dcaWon, pnl: dcaPnl };
        if (edgeLabel) t.edgeLabel = edgeLabel;
        trades.push(t);
      }
      curJ = dcaTargetJ; curStreak = newStreak; dcaRound++; lastWon = dcaWon;
      if (dcaWon) break;
    }
    j = curJ + 1;
  }
  if (armTrigByStreak.size > 0) {
    const streakPath = [...armTrigByStreak.entries()].filter(([s])=>s>0);
    const edgePath   = [...armTrigByStreak.entries()].filter(([s])=>s<0);
    const sTot = streakPath.reduce((a,[,n])=>a+n,0);
    const eTot = edgePath.reduce((a,[,n])=>a+n,0);
    const sStr = streakPath.sort((a,b)=>a[0]-b[0]).map(([s,n])=>`s=${s}:${n}`).join(' ');
    const eStr = edgePath.sort((a,b)=>b[0]-a[0]).map(([s,n])=>`s=${-s}:${n}`).join(' ');
    process.stderr.write(`  arm via streak-path (s>=${c.echo_trigger_streak},body3>=${c.arm_trigger_body3_min}): ${sTot} · ${sStr}\n`);
    if (eTot > 0) process.stderr.write(`  arm via EDGE-path (extra ${armOnEdge?'enabled':'?'}): ${eTot} · ${eStr}\n`);
  }
  return trades;
}

function stats(list: Trade[]) {
  const n = list.length, wins = list.filter(t => t.won).length;
  const pnl = list.reduce((s, t) => s + t.pnl, 0);
  let eq = 0, peak = 0, dd = 0;
  for (const t of list) { eq += t.pnl; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  return { trades: n, wins, win_rate_pct: n ? +(wins / n * 100).toFixed(1) : null, pnl_usd: +pnl.toFixed(2), max_drawdown_usd: +dd.toFixed(2) };
}

function main(): Promise<void> { return run(); }
async function run(): Promise<void> {
  const a = parseArgs();
  const cfg = loadConfig(a.configFile);
  const maxDays = Math.max(...a.days);
  console.error(`Fetching ${maxDays}d of BTCUSDT 5m bars…`);
  const bars = await fetchKlines(maxDays);
  console.error(`Got ${bars.length} bars (${(bars.length/288).toFixed(1)} days)\n`);

  const streakLen = new Array<number>(bars.length).fill(0);
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    if (b.dir === 0) { streakLen[i] = 0; continue; }
    streakLen[i] = (i > 0 && bars[i-1]!.dir === b.dir) ? streakLen[i-1]! + 1 : 1;
  }

  const now = Date.now();
  const periods = a.days.sort((x, y) => x - y).map(d => {
    const cutoff = now - d * 86400_000;
    const tr = simulate(bars, streakLen, a.entry, cutoff, cfg, a.edgeMode, a.armOnEdge,
      a.armStreakMax, a.armBody3Max, a.armPriorVolSkip, a.armPriorVolRange);
    const inPeriod = bars.filter(b => b.ts >= cutoff).length;
    const byMode = (m: Mode, dca: 'base'|'dca') =>
      stats(tr.filter(t => t.mode === m && (dca === 'base' ? t.dcaRound === 0 : t.dcaRound >= 1)));
    const streaks = Array.from(new Set(tr.map(t => t.streak))).sort((x, y) => x - y);
    const byStreak: Record<string, ReturnType<typeof stats>> = {};
    for (const k of streaks) byStreak[String(k)] = stats(tr.filter(t => t.streak === k));
    return { period_days: d, bars_in_period: inPeriod, total: stats(tr),
      by_mode: { idle_base: byMode('idle','base'), idle_dca: byMode('idle','dca'),
                 armed_base: byMode('armed','base'), armed_dca: byMode('armed','dca'),
                 edge_base: byMode('edge','base'), edge_dca: byMode('edge','dca') },
      by_streak: byStreak };
  });

  // ── Build Markdown report (config block FIRST) ─────────────────────────────
  const M: string[] = [];
  M.push('# Backtest — current prod BTC config');
  M.push('');
  M.push(`_Generated ${new Date().toISOString()}_ · source: \`${cfg.source}\` (fetched ${cfg.fetched_at})`);
  M.push('');
  M.push(`> **WR is the primary signal** (pricing-independent). PnL is directional/relative — flat $${a.entry} entry, binary settlement (win=$1, lose=$0), **not real PnL**.`);
  M.push('>');
  M.push(`> \`arm_trigger_body3_min\` = **${cfg.arm_trigger_body3_min}** (live DB value — runtime uses this; it overrides the code PER_COIN_OVERRIDES default).`);
  M.push('');
  M.push('## Config');
  M.push('');
  M.push('| field | value |');
  M.push('|---|---|');
  M.push('| coin | BTC |');
  for (const [k, v] of Object.entries(cfg)) {
    if (k === 'echo_edge_cases') continue;
    const val = Array.isArray(v) ? `[${(v as unknown[]).join(', ')}]` : String(v);
    M.push(`| ${k} | ${val} |`);
  }
  M.push(`| entry_model_flat | ${a.entry} |`);
  M.push('');
  M.push('**Edge cases:**');
  M.push('');
  M.push('| label | streakMin | streakMax | body3Min | dcaBody3Min |');
  M.push('|---|---|---|---|---|');
  for (const ec of cfg.echo_edge_cases)
    M.push(`| ${ec.label} | ${ec.streakMin} | ${ec.streakMax} | ${ec.body3Min} | ${ec.dcaBody3Min} |`);
  M.push('');
  M.push('_streak-strategy fields (`auto_*`, `dca_multiplier`, `dca_streak_whitelist`) do NOT apply to echo and are ignored by the sim._');
  M.push('');
  M.push('## Results');
  const row = (label: string, s: ReturnType<typeof stats>) =>
    `| ${label} | ${s.trades} | ${s.wins} | ${s.win_rate_pct ?? '—'} | ${s.pnl_usd} | ${s.max_drawdown_usd} |`;
  for (const p of periods) {
    M.push('');
    M.push(`### ${p.period_days} days (${p.bars_in_period} bars)`);
    M.push('');
    const t = p.total;
    M.push(`**Total:** ${t.trades} trades · WR **${t.win_rate_pct}%** · pnl $${t.pnl_usd} · maxDD $${t.max_drawdown_usd}`);
    M.push('');
    M.push('**By mode:**');
    M.push('');
    M.push('| mode | trades | wins | WR% | pnl$ | maxDD$ |');
    M.push('|---|---|---|---|---|---|');
    for (const [k, v] of Object.entries(p.by_mode)) M.push(row(k, v));
    M.push('');
    M.push('**By entry streak:**');
    M.push('');
    M.push('| streak | trades | wins | WR% | pnl$ | maxDD$ |');
    M.push('|---|---|---|---|---|---|');
    for (const [k, v] of Object.entries(p.by_streak)) M.push(row(k, v));
  }
  const md = M.join('\n') + '\n';
  writeFileSync(a.out, md);
  console.error(`\nWrote ${a.out}`);
  // Console summary.
  for (const p of periods)
    console.error(`  ${p.period_days}d: ${p.total.trades} trades, WR ${p.total.win_rate_pct}%, pnl $${p.total.pnl_usd}, maxDD $${p.total.max_drawdown_usd}`);
}

main().catch(err => { console.error(err); process.exit(1); });
