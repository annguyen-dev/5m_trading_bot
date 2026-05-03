/**
 * PolyBacktestEngine — orchestrate a single backtest run.
 *
 * 1. Load 5m windows for BTC from poly_clob_markets in [from, to)
 * 2. For each window, ensure outcome is populated (use DB cache, fall back
 *    to NULL — strategy treats NULL as 'unknown' and skips)
 * 3. Pre-load BookReplay for every distinct token_id in those windows
 *    (typically 2 × N windows because each window has token_up + token_down)
 * 4. Run StrategyReplay
 * 5. Compute equity curve + summary stats from trades
 *
 * Progress callback fires at coarse milestones (load, books, replay, stats).
 */

import { getPool } from '@trading-bot/db';
import { BookReplay } from './BookReplay.js';
import { replayStrategy, type ReplayWindow } from './StrategyReplay.js';
import type {
  PolyBacktestRequest, PolyBacktestResult,
  PolyBacktestEquityPoint, PolyBacktestSummary,
} from './types.js';

const MAX_DECISIONS_RETURNED = 2000;   // cap to keep payload bounded

export type ProgressFn = (pct: number, msg: string) => void;

export async function runPolyBacktest(
  req:      PolyBacktestRequest,
  progress: ProgressFn,
): Promise<PolyBacktestResult> {
  const pool = getPool();

  // ── 1. Load windows + derive outcome ──────────────────────────────────
  // Outcome priority (mirrors live PMW's `fetchSourceOutcome` for BTC):
  //   1. poly_clob_markets.outcome (if Polymarket sync populated it)
  //   2. derived from future_ticks_5s: close >= open → up else down
  //      (Chainlink-aligned BTC price stream — what bot uses at runtime)
  // Lateral subqueries get the first/last 5s tick per window.
  progress(5, 'Loading BTC windows + deriving outcomes...');
  const { rows: rawWindows } = await pool.query<{
    window_start: string; window_end: string;
    token_up: string; token_down: string;
    outcome: string | null;
    open_price: number | null; close_price: number | null;
  }>(
    `SELECT
        m.window_start::text, m.window_end::text, m.token_up, m.token_down,
        m.outcome,
        (SELECT price FROM future_ticks_5s
           WHERE ts >= m.window_start AND ts < m.window_end
           ORDER BY ts ASC  LIMIT 1) AS open_price,
        (SELECT price FROM future_ticks_5s
           WHERE ts >= m.window_start AND ts < m.window_end
           ORDER BY ts DESC LIMIT 1) AS close_price
      FROM poly_clob_markets m
     WHERE m.symbol = 'BTC'
       AND m.window_start >= $1 AND m.window_end <= $2
     ORDER BY m.window_start ASC`,
    [req.fromMs, req.toMs],
  );

  if (rawWindows.length === 0) {
    return emptyResult(req, 'no BTC windows in date range');
  }

  let polyHits = 0, derivedHits = 0, stillUnknown = 0;
  const windows: ReplayWindow[] = rawWindows.map(r => {
    let outcome: 'up' | 'down' | 'unknown' = 'unknown';
    if (r.outcome === 'up' || r.outcome === 'down') {
      outcome = r.outcome;
      polyHits++;
    } else if (r.open_price != null && r.close_price != null) {
      outcome = Number(r.close_price) >= Number(r.open_price) ? 'up' : 'down';
      derivedHits++;
    } else {
      stillUnknown++;
    }
    // Body for V9 high-body filter — abs(close - open) when both prices known.
    const o = r.open_price != null ? Number(r.open_price)  : null;
    const c = r.close_price != null ? Number(r.close_price) : null;
    const body = (o != null && c != null) ? Math.abs(c - o) : undefined;
    return {
      windowStart: Number(r.window_start),
      windowEnd:   Number(r.window_end),
      tokenUp:     r.token_up,
      tokenDown:   r.token_down,
      outcome,
      ...(body !== undefined ? { body } : {}),
    };
  });

  progress(15, `Loaded ${windows.length} windows (poly=${polyHits}, derived=${derivedHits}, unknown=${stillUnknown})`);

  // ── 2. Pre-load tick books for all involved tokens ────────────────────
  // One BookReplay per distinct tokenId. Tick range = whole backtest span.
  const tokenIds = new Set<string>();
  for (const w of windows) { tokenIds.add(w.tokenUp); tokenIds.add(w.tokenDown); }

  progress(20, `Loading tick data for ${tokenIds.size} tokens...`);
  const books = new Map<string, BookReplay>();
  let loaded = 0;
  for (const tokenId of tokenIds) {
    const book = new BookReplay(tokenId);
    await book.load(req.fromMs, req.toMs);
    books.set(tokenId, book);
    loaded++;
    // Every 50 tokens, surface progress (loading is the slowest phase).
    if (loaded % 50 === 0) {
      progress(20 + Math.floor((60 * loaded) / tokenIds.size),
               `Tick books: ${loaded}/${tokenIds.size}`);
    }
  }
  progress(80, 'Tick books loaded');

  // ── 3. Run replay ─────────────────────────────────────────────────────
  progress(85, 'Running strategy replay...');
  const { trades, decisions } = replayStrategy(
    windows, req.config,
    (tokenId) => books.get(tokenId) ?? null,
  );

  // ── 4. Equity curve + summary ─────────────────────────────────────────
  progress(95, 'Computing summary...');
  // Sort trades by exitTs for a chronological equity curve.
  const sortedTrades = [...trades].sort((a, b) => a.exitTs - b.exitTs);
  const equity: PolyBacktestEquityPoint[] = [];
  let running = 0;
  for (const t of sortedTrades) {
    running += t.pnlUsdc;
    equity.push({ ts: t.exitTs, equity: running });
  }

  const summary = computeSummary(req, sortedTrades, decisions, windows);

  progress(100, 'Done');

  return {
    request:   req,
    summary,
    trades:    sortedTrades,
    equity,
    decisions: decisions.slice(-MAX_DECISIONS_RETURNED),
  };
}

function computeSummary(
  req:       PolyBacktestRequest,
  trades:    PolyBacktestResult['trades'],
  decisions: PolyBacktestResult['decisions'],
  windows:   ReplayWindow[],
): PolyBacktestSummary {
  let wins = 0, losses = 0, totalPnl = 0;
  for (const t of trades) {
    totalPnl += t.pnlUsdc;
    if (t.pnlUsdc > 0) wins++;
    else if (t.pnlUsdc < 0) losses++;
  }

  // Max drawdown: walk equity curve, track peak, find max trough below it.
  let peak = 0, running = 0, maxDd = 0;
  for (const t of trades) {
    running += t.pnlUsdc;
    if (running > peak) peak = running;
    const dd = peak - running;
    if (dd > maxDd) maxDd = dd;
  }

  const skipReasons: Record<string, number> = {};
  for (const d of decisions) {
    if (d.action === 'skip' && d.skipReason) {
      skipReasons[d.skipReason] = (skipReasons[d.skipReason] ?? 0) + 1;
    }
  }

  const decided = wins + losses;
  return {
    trades:           trades.length,
    wins, losses,
    winRate:          decided > 0 ? wins / decided : 0,
    totalPnlUsdc:     totalPnl,
    avgPnlPerTrade:   trades.length > 0 ? totalPnl / trades.length : 0,
    maxDrawdownUsdc:  maxDd,
    coveredFromMs:    windows[0]?.windowStart ?? null,
    coveredToMs:      windows[windows.length - 1]?.windowEnd ?? null,
    windowsEvaluated: windows.length,
    skipReasons,
  };
}

function emptyResult(req: PolyBacktestRequest, _reason: string): PolyBacktestResult {
  return {
    request: req,
    summary: {
      trades: 0, wins: 0, losses: 0, winRate: 0,
      totalPnlUsdc: 0, avgPnlPerTrade: 0, maxDrawdownUsdc: 0,
      coveredFromMs: null, coveredToMs: null, windowsEvaluated: 0,
      skipReasons: {},
    },
    trades:    [],
    equity:    [],
    decisions: [],
  };
}
