/**
 * Grid-search echo config params around the live prod BTC config to find sets
 * with higher WR AND PnL than baseline, robust across 90/180/365d.
 *
 * Same prod-faithful sim as backtest-prod-config.ts (arm_trigger_body3 gate +
 * next-window arm timing + idle/armed thresholds + edge cases + DCA). Edge
 * cases and echo_trigger_streak are held at the live values (edge cases are the
 * only consistently-positive mode); we sweep the levers the by-mode/by-streak
 * breakdown flagged as lossy: idle baseline, body3 floors, DCA, armed streak.
 *
 * Pricing: flat entry (default $0.55). WR is pricing-independent and primary.
 *
 * Usage:
 *   tsx scripts/optimize-echo-config.ts --config-file=/tmp/prod-coin-configs.json \
 *     [--entry=0.55] [--out=scripts/optimize-echo-config.md] [--top=15]
 */
import { writeFileSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

interface EdgeCase { label: string; enabled: boolean; streakMin: number; streakMax: number; body3Min: number; dcaBody3Min: number }
interface Cfg {
  trigger: number; windowMin: number;
  armedStreak: number; idleStreak: number;
  armTriggerBody: number; idleBody: number; armedBody: number;
  dcaBodyIdle: number; dcaBodyArmed: number;
  dcaScale: number[]; dcaScaleIdle: number[];
  edgeCases: EdgeCase[]; size: number;
}

function liveCfg(file: string | undefined): Cfg {
  // Fallback = the 2026-05-25 live snapshot.
  const fb: Record<string, unknown> = {
    echo_trigger_streak: 5, echo_window_minutes: 120, echo_signal_min_streak: 3,
    echo_baseline_streak: 5, arm_trigger_body3_min: 100, idle_body3_min: 150,
    armed_body3_min: 150, dca_body3_min_idle: 200, dca_body3_min_armed: 150,
    echo_dca_scale: [2], echo_dca_scale_idle: [2], size_usdc: 5,
    echo_edge_cases: [
      { label: 'streak3', enabled: true, streakMin: 3, streakMax: 3, body3Min: 440, dcaBody3Min: 250 },
      { label: 'streak4', enabled: true, streakMin: 4, streakMax: 4, body3Min: 420, dcaBody3Min: 300 },
      { label: '7',       enabled: true, streakMin: 7, streakMax: 7, body3Min: 120, dcaBody3Min: 100 },
    ],
  };
  let b = fb;
  if (file) {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    b = ((raw['BTC'] ?? raw) as Record<string, unknown>);
  }
  const n = (k: string, d: number) => (typeof b[k] === 'number' ? b[k] as number : d);
  const arr = (k: string, d: number[]) => (Array.isArray(b[k]) ? b[k] as number[] : d);
  return {
    trigger: n('echo_trigger_streak', 5), windowMin: n('echo_window_minutes', 120),
    armedStreak: n('echo_signal_min_streak', 3), idleStreak: n('echo_baseline_streak', 5),
    armTriggerBody: n('arm_trigger_body3_min', 100), idleBody: n('idle_body3_min', 150),
    armedBody: n('armed_body3_min', 150), dcaBodyIdle: n('dca_body3_min_idle', 200),
    dcaBodyArmed: n('dca_body3_min_armed', 150),
    dcaScale: arr('echo_dca_scale', [2]),
    dcaScaleIdle: (arr('echo_dca_scale_idle', []).length ? arr('echo_dca_scale_idle', []) : arr('echo_dca_scale', [2])),
    edgeCases: (Array.isArray(b['echo_edge_cases']) ? b['echo_edge_cases'] as EdgeCase[] : fb['echo_edge_cases'] as EdgeCase[]),
    size: n('size_usdc', 5),
  };
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

interface Trade { ts: number; won: boolean; pnl: number }
function simulate(bars: Bar[], streakLen: number[], body3At: number[], c: Cfg, entry: number): Trade[] {
  const armDurMs = c.windowMin * 60_000;
  const trades: Trade[] = [];
  let armUntilTs = 0, j = 3;
  while (j + 1 < bars.length) {
    const s = streakLen[j-1]!;
    const regime = bars[j-1]!.dir;
    if (regime === 0 || s < 1) { j++; continue; }
    const body3 = body3At[j-1]!;
    const armed = bars[j]!.ts < armUntilTs;
    if (s >= c.trigger && body3 >= c.armTriggerBody) armUntilTs = Math.max(armUntilTs, bars[j-1]!.ts + armDurMs);

    let entryBody = 0, dcaBody = 0, dcaScale: number[] = [], fire = false, edge = false;
    if (armed && s >= c.armedStreak) { fire = true; entryBody = c.armedBody; dcaBody = c.dcaBodyArmed; dcaScale = c.dcaScale; }
    else if (!armed && s >= c.idleStreak) { fire = true; entryBody = c.idleBody; dcaBody = c.dcaBodyIdle; dcaScale = c.dcaScaleIdle; }
    else if (!armed) {
      for (const ec of c.edgeCases) {
        if (!ec.enabled || s < ec.streakMin || s > ec.streakMax || body3 < ec.body3Min) continue;
        fire = true; edge = true; entryBody = 0; dcaBody = ec.dcaBody3Min; dcaScale = c.dcaScaleIdle; break;
      }
    }
    if (!fire) { j++; continue; }
    if (!edge && body3 < entryBody) { j++; continue; }

    const betDir = (regime === 1 ? -1 : 1) as -1|1;
    const next = bars[j]!;
    const won = next.dir !== 0 && next.dir === betDir;
    trades.push({ ts: next.ts, won, pnl: won ? (c.size / entry) * (1 - entry) : -c.size });

    let curJ = j, dcaRound = 0, lastWon = won;
    while (!lastWon && dcaRound < dcaScale.length && curJ + 1 < bars.length) {
      const nb3 = Math.abs(bars[curJ]!.close - bars[curJ]!.open)
                + Math.abs(bars[curJ-1]!.close - bars[curJ-1]!.open)
                + Math.abs(bars[curJ-2]!.close - bars[curJ-2]!.open);
      if (dcaBody > 0 && nb3 < dcaBody) break;
      const dt = curJ + 1, dcaSize = c.size * dcaScale[dcaRound]!;
      const db = bars[dt]!, dw = db.dir !== 0 && db.dir === betDir;
      trades.push({ ts: db.ts, won: dw, pnl: dw ? (dcaSize / entry) * (1 - entry) : -dcaSize });
      curJ = dt; dcaRound++; lastWon = dw;
      if (dw) break;
    }
    j = curJ + 1;
  }
  return trades;
}

function stat(list: Trade[]) {
  const n = list.length, w = list.filter(t => t.won).length;
  let eq = 0, peak = 0, dd = 0;
  for (const t of list) { eq += t.pnl; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  return { n, wr: n ? +(w / n * 100).toFixed(1) : 0, pnl: +list.reduce((s, t) => s + t.pnl, 0).toFixed(0), dd: +dd.toFixed(0) };
}

async function main(): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  let configFile: string | undefined, entry = 0.55, out = path.join(here, 'optimize-echo-config.md'), top = 20, minPerDay = 5, maxPerDay = 8;
  for (const arg of process.argv.slice(2)) {
    const eq = arg.indexOf('='); if (eq < 0) continue;
    const k = arg.slice(2, eq), v = arg.slice(eq + 1);
    if (k === 'config-file') configFile = path.isAbsolute(v) ? v : path.join(here, v);
    else if (k === 'entry') entry = Number(v);
    else if (k === 'out') out = path.isAbsolute(v) ? v : path.join(here, v);
    else if (k === 'top') top = Number(v);
    else if (k === 'min-per-day') minPerDay = Number(v);
    else if (k === 'max-per-day') maxPerDay = Number(v);
  }
  const base = liveCfg(configFile);

  console.error('Fetching 365d BTCUSDT 5m…');
  const bars = await fetchKlines(365);
  console.error(`Got ${bars.length} bars\n`);
  const streakLen = new Array<number>(bars.length).fill(0);
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    streakLen[i] = b.dir === 0 ? 0 : (i > 0 && bars[i-1]!.dir === b.dir ? streakLen[i-1]! + 1 : 1);
  }
  const body3At = new Array<number>(bars.length).fill(0);
  for (let i = 2; i < bars.length; i++)
    body3At[i] = Math.abs(bars[i]!.close-bars[i]!.open) + Math.abs(bars[i-1]!.close-bars[i-1]!.open) + Math.abs(bars[i-2]!.close-bars[i-2]!.open);

  const now = Date.now();
  const cuts = { 90: now - 90*86400_000, 180: now - 180*86400_000, 365: now - 365*86400_000 };
  const evalCfg = (c: Cfg) => {
    const tr = simulate(bars, streakLen, body3At, c, entry);
    return {
      d90: stat(tr.filter(t => t.ts >= cuts[90])),
      d180: stat(tr.filter(t => t.ts >= cuts[180])),
      d365: stat(tr.filter(t => t.ts >= cuts[365])),
    };
  };

  const baseR = evalCfg(base);

  // ── Grid — pushed toward TIGHTER (higher body3/streak, SHORTER arm window) to
  // lift WR & cut trade count; ≥minPerDay floor stops over-filtering to ~0.
  // echo_window_minutes is the dominant trade-COUNT lever (long window = armed
  // most of the time = many streak-3 fires regardless of body3).
  const G = {
    windowMin:      [30, 60, 90, 120],
    armedStreak:    [3, 4, 5],
    idleStreak:     [6, 7, 8, 99],          // 99 = disable generic idle baseline
    armTriggerBody: [100, 300],
    idleBody:       [300, 500, 700],
    armedBody:      [350, 500, 650],
    dca:            [[] as number[], [2], [3,4]],
  };
  type Row = { c: Cfg; r: ReturnType<typeof evalCfg>; label: string };
  const rows: Row[] = [];
  for (const windowMin of G.windowMin)
  for (const armedStreak of G.armedStreak)
  for (const idleStreak of G.idleStreak)
  for (const armTriggerBody of G.armTriggerBody)
  for (const idleBody of G.idleBody)
  for (const armedBody of G.armedBody)
  for (const dca of G.dca) {
    const c: Cfg = { ...base, windowMin, armedStreak, idleStreak, armTriggerBody, idleBody, armedBody, dcaScale: dca, dcaScaleIdle: dca };
    const r = evalCfg(c);
    const label = `win=${windowMin} sig=${armedStreak} base=${idleStreak===99?'off':idleStreak} armT=${armTriggerBody} idleB=${idleBody} armB=${armedBody} dca=${dca.length?'['+dca.join(',')+']':'none'}`;
    rows.push({ c, r, label });
  }

  // Objective: MAX WR subject to a frequency floor (≥ minPerDay orders/day in
  // EVERY period) and PnL not worse than baseline. Rank by min-WR across
  // periods (robust), then trades/day, then total PnL.
  const perDay = (n: number, days: number) => +(n / days).toFixed(1);
  // Band: every period must trade within [minPerDay, maxPerDay] orders/day —
  // floor keeps volume, CEILING keeps it genuinely selective (no 9-25/day).
  const freqOk = (r: Row['r']) =>
    [[r.d90.n,90],[r.d180.n,180],[r.d365.n,365]].every(([n,d]) => n!/d! >= minPerDay && n!/d! <= maxPerDay);
  const minWr  = (r: Row['r']) => Math.min(r.d90.wr, r.d180.wr, r.d365.wr);
  const totPnl = (r: Row['r']) => r.d90.pnl + r.d180.pnl + r.d365.pnl;
  const pnlOk  = (r: Row['r']) => r.d90.pnl >= baseR.d90.pnl && r.d180.pnl >= baseR.d180.pnl && r.d365.pnl >= baseR.d365.pnl;
  const rankWr = (a: Row, b: Row) => (minWr(b.r) - minWr(a.r)) || (totPnl(b.r) - totPnl(a.r));
  const cands   = rows.filter(x => freqOk(x.r) && pnlOk(x.r)).sort(rankWr);  // freq + ≥baseline PnL
  const freqAll = rows.filter(x => freqOk(x.r)).sort(rankWr);               // freq only (fallback)

  // ── Markdown ───────────────────────────────────────────────────────────────
  const M: string[] = [];
  M.push('# Echo config — max WR with frequency floor (BTC)');
  M.push('');
  M.push(`_Generated ${new Date().toISOString()}_ · grid ${rows.length} combos · entry $${entry} · band ${minPerDay}–${maxPerDay} orders/day`);
  M.push('');
  M.push(`Objective: **maximise WR** subject to **${minPerDay}–${maxPerDay} orders/day** in EVERY period and PnL ≥ baseline.`);
  M.push('Held fixed: `echo_trigger_streak`, `echo_window_minutes`, edge cases, `dca_body3_min_*`. Swept: armed streak, idle baseline (99=off), arm-trigger/idle/armed body3, DCA scale.');
  M.push('');
  const fmt = (s: {n:number;wr:number;pnl:number;dd:number}, days: number) => `${s.n} (${perDay(s.n,days)}/d) / ${s.wr}% / ${s.pnl>=0?'+':''}${s.pnl} / ${s.dd}`;
  M.push('## Baseline (current live config)');
  M.push('');
  M.push('`sig=3 base=5 armT=100 idleB=150 armB=150 dca=[2]` (live)');
  M.push('');
  M.push('| period | trades (per day) / WR / pnl$ / maxDD$ |');
  M.push('|---|---|');
  M.push(`| 90d  | ${fmt(baseR.d90,90)} |`);
  M.push(`| 180d | ${fmt(baseR.d180,180)} |`);
  M.push(`| 365d | ${fmt(baseR.d365,365)} |`);
  M.push('');
  const tbl = (list: Row[]) => {
    M.push('| config | 90d WR / per-day | 180d WR / per-day | 365d WR / per-day | 365d pnl$ |');
    M.push('|---|---|---|---|---|');
    for (const x of list.slice(0, top))
      M.push(`| \`${x.label}\` | ${x.r.d90.wr}% / ${perDay(x.r.d90.n,90)} | ${x.r.d180.wr}% / ${perDay(x.r.d180.n,180)} | ${x.r.d365.wr}% / ${perDay(x.r.d365.n,365)} | ${x.r.d365.pnl>=0?'+':''}${x.r.d365.pnl} |`);
  };
  M.push(`## Top by WR — ${minPerDay}–${maxPerDay}/day AND PnL ≥ baseline (${cands.length} qualify)`);
  M.push('');
  if (cands.length) tbl(cands); else M.push('_(none — see band-only list below)_');
  M.push('');
  M.push(`## Top by WR — ${minPerDay}–${maxPerDay}/day only (${freqAll.length} qualify)`);
  M.push('');
  tbl(freqAll);
  M.push('');

  const pick = (cands[0] ?? freqAll[0])!;
  M.push('## Recommended (highest WR meeting the frequency floor)');
  M.push('');
  M.push(`\`${pick.label}\``);
  M.push('');
  M.push('| period | baseline: trades(/d)/WR/pnl/DD | recommended |');
  M.push('|---|---|---|');
  M.push(`| 90d  | ${fmt(baseR.d90,90)} | ${fmt(pick.r.d90,90)} |`);
  M.push(`| 180d | ${fmt(baseR.d180,180)} | ${fmt(pick.r.d180,180)} |`);
  M.push(`| 365d | ${fmt(baseR.d365,365)} | ${fmt(pick.r.d365,365)} |`);
  M.push('');
  M.push('Full config to apply (other fields unchanged from live):');
  M.push('');
  M.push('```json');
  M.push(JSON.stringify({
    echo_window_minutes: pick.c.windowMin,
    echo_signal_min_streak: pick.c.armedStreak,
    echo_baseline_streak: pick.c.idleStreak,
    arm_trigger_body3_min: pick.c.armTriggerBody,
    idle_body3_min: pick.c.idleBody,
    armed_body3_min: pick.c.armedBody,
    echo_dca_scale: pick.c.dcaScale,
    echo_dca_scale_idle: pick.c.dcaScale,
  }, null, 2));
  M.push('```');
  M.push('');
  M.push(`_Caveat: higher WR comes from tighter filters → fewer trades. Frequency floor = ${minPerDay}/day keeps volume. Single in-sample period per window (no walk-forward); PnL at flat $0.55 — real entries differ. Validate at small size before scaling._`);

  writeFileSync(out, M.join('\n') + '\n');
  console.error(`Wrote ${out}`);
  console.error(`baseline 365d: ${baseR.d365.wr}% / ${perDay(baseR.d365.n,365)}/d / $${baseR.d365.pnl}`);
  console.error(`recommended:   ${pick.label}`);
  console.error(`  365d: ${pick.r.d365.wr}% / ${perDay(pick.r.d365.n,365)}/d / $${pick.r.d365.pnl} | 180d: ${pick.r.d180.wr}% / ${perDay(pick.r.d180.n,180)}/d | 90d: ${pick.r.d90.wr}% / ${perDay(pick.r.d90.n,90)}/d`);
  console.error(`freq≥${minPerDay}/day: ${freqAll.length} configs, ${cands.length} also ≥baseline PnL`);
}

main().catch(err => { console.error(err); process.exit(1); });
