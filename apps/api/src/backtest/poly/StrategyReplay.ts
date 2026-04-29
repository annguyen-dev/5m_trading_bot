/**
 * StrategyReplay — pure-function mirror of the live PMW + OrderResolver
 * strategy, run deterministically against historical Poly data.
 *
 * Mirrors (keep in sync with apps/workers/src/PriceMonitoringWorker.ts):
 *   • T-3s of N: boundary placement for N+1 if cycle inactive AND
 *     effective_streak (|streak| + 1) >= adaptive_threshold AND
 *     in-progress candle direction matches streak.
 *   • T+0 of N: resolve incoming order, then DCA for N+1 if cycle still
 *     active AND outcome opposed cycleDirection AND |new_streak| ∈ whitelist.
 *   • Cycle reset on win (outcome matches cycleDirection).
 *   • TP/SL: walk N's ticks; first bid >= tp_cents triggers TP, first
 *     bid <= sl_cents triggers SL. Otherwise resolve at window close
 *     (1.0 if outcome matches direction, 0.0 if not).
 *
 * Intentional simplifications (v1):
 *   - In-progress candle direction at T-3s of N approximated by N's full
 *     outcome (≈ accurate since 99%+ of bar has formed by T-3s).
 *   - Adaptive schedule applied via direct UTC-hour lookup.
 *   - No order-cancellation modeling (T-3s placements always succeed if gates
 *     pass; no streak-break-cancel mid-flight).
 */

import type {
  PolyBacktestCoinConfig,
  PolyBacktestTrade, PolyBacktestDecision,
} from './types.js';
import type { BookReplay } from './BookReplay.js';

const WINDOW_MS = 5 * 60 * 1000;

/** Single 5-min window — enough metadata to drive a placement decision +
 *  resolve any order targeting it. */
export interface ReplayWindow {
  windowStart:    number;
  windowEnd:      number;
  outcome:        'up' | 'down' | 'unknown';
  /** Token IDs for placing orders on N+1 (we only use this window's tokens
   *  when this window IS the target N+1 of a placement decision). */
  tokenUp:        string;
  tokenDown:      string;
}

/** Mutable cycle state — same shape as PMW's CoinState (cycle slice). */
interface Cycle {
  active:        boolean;
  direction?:    'up' | 'down';
  lastSize:      number | null;
  dcaCount:      number;
}

interface PendingOrder {
  windowStart:   number;
  windowEnd:     number;
  direction:     'up' | 'down';
  entryPrice:    number;
  sizeUsdc:      number;
  signalPath:    'boundary' | 'dca';
  dcaRound:      number;
  streakAtEntry: number;
  /** Token id of the bet side (used for tick-walk on resolution). */
  tokenId:       string;
}

export interface ReplayResult {
  trades:    PolyBacktestTrade[];
  decisions: PolyBacktestDecision[];
}

/**
 * Run the strategy against an ordered list of windows + per-window books.
 *
 * `windows` MUST be sorted ascending by windowStart with no gaps (we check
 * window N+1's outcome by index, not by lookup).
 *
 * `bookFor(tokenId)` returns the BookReplay for that token. Caller is
 * responsible for pre-loading every needed token (typically token_up and
 * token_down for each window).
 */
export function replayStrategy(
  windows: ReplayWindow[],
  cfg:     PolyBacktestCoinConfig,
  bookFor: (tokenId: string) => BookReplay | null,
): ReplayResult {
  const trades:    PolyBacktestTrade[]    = [];
  const decisions: PolyBacktestDecision[] = [];
  const cycle: Cycle = { active: false, lastSize: null, dcaCount: 0 };

  /** Map of windowStart → pending order(s) targeting that window.
   *  In practice at most one per window because of the dedup gate, but use
   *  array for safety. */
  const pendingByWindow = new Map<number, PendingOrder[]>();

  // Pre-streak buffer: the rolling lookback of past outcomes.
  // We compute streak at index i from the most-recent N closed windows.

  for (let i = 0; i < windows.length; i++) {
    const w = windows[i]!;

    // ── 1. Resolve any incoming order targeting THIS window ────────────────
    const incoming = pendingByWindow.get(w.windowStart) ?? [];
    pendingByWindow.delete(w.windowStart);
    for (const order of incoming) {
      const trade = resolveOrder(order, w, bookFor(order.tokenId), cfg);
      trades.push(trade);

      // Update cycle from THIS order's outcome (only if cycle context matches)
      if (cycle.active && cycle.direction === order.direction) {
        const won = trade.exitReason === 'tp' || trade.exitReason === 'resolution_win';
        if (won) {
          cycle.active = false;
          delete cycle.direction;
          cycle.lastSize = null;
          cycle.dcaCount = 0;
        }
        // loss → cycle continues; DCA decision below uses underlying outcome
      }
    }

    // Independent of incoming-order resolution, also update cycle state from
    // the underlying outcome — mirrors PMW's "cycle state update applies
    // whether or not we had an incoming order" branch.
    if (cycle.active && cycle.direction != null && w.outcome !== 'unknown') {
      if (w.outcome === cycle.direction) {
        // win → reset
        cycle.active = false;
        delete cycle.direction;
        cycle.lastSize = null;
        cycle.dcaCount = 0;
      }
      // loss → continues
    }

    // ── 2. DCA placement for N+1 (T+0 of N+1 timing) ─────────────────────
    const nextW = windows[i + 1];
    let placedThisIteration: 'boundary' | 'dca' | null = null;

    if (cycle.active && cycle.direction != null && w.outcome !== 'unknown'
        && w.outcome !== cycle.direction      // = loss this window
        && nextW != null) {

      const dcaDecision = tryDca(windows, i + 1, cfg, cycle);
      if (dcaDecision.place) {
        const tokenId = cycle.direction === 'up' ? nextW.tokenUp : nextW.tokenDown;
        const book    = bookFor(tokenId);
        const ask     = book ? book.bestAskAt(nextW.windowStart) : null;
        if (ask != null && ask * 100 <= cfg.limit_price_cents) {
          const baseSize = cycle.lastSize ?? cfg.size_usdc;
          const size     = baseSize * cfg.dca_multiplier;
          const order: PendingOrder = {
            windowStart:   nextW.windowStart,
            windowEnd:     nextW.windowEnd,
            direction:     cycle.direction,
            entryPrice:    ask,
            sizeUsdc:      size,
            signalPath:    'dca',
            dcaRound:      cycle.dcaCount + 1,
            streakAtEntry: dcaDecision.streak,
            tokenId,
          };
          pushPending(pendingByWindow, order);
          cycle.lastSize = size;
          cycle.dcaCount += 1;
          decisions.push({
            windowStart:         nextW.windowStart,
            windowEnd:           nextW.windowEnd,
            streak:              dcaDecision.streak,
            contrarianDirection: cycle.direction,
            cycleActive:         true,
            action:              'dca',
            tradeIndex:          undefined,    // back-fill skipped — caller sees order in trades
          });
          placedThisIteration = 'dca';
        } else {
          decisions.push({
            windowStart:         nextW.windowStart,
            windowEnd:           nextW.windowEnd,
            streak:              dcaDecision.streak,
            contrarianDirection: cycle.direction,
            cycleActive:         true,
            action:              'skip',
            skipReason:          ask == null ? 'no_ask' : `ask>${cfg.limit_price_cents}c`,
          });
        }
      } else if (dcaDecision.skipReason) {
        decisions.push({
          windowStart:         nextW.windowStart,
          windowEnd:           nextW.windowEnd,
          streak:              dcaDecision.streak,
          contrarianDirection: cycle.direction,
          cycleActive:         true,
          action:              'skip',
          skipReason:          dcaDecision.skipReason,
        });
      }
    }

    // ── 3. Boundary placement for N+1 (T-3s of N timing) ──────────────────
    if (placedThisIteration == null && !cycle.active && nextW != null) {
      const decision = tryBoundary(windows, i, cfg);
      if (decision.place && decision.direction) {
        const tokenId = decision.direction === 'up' ? nextW.tokenUp : nextW.tokenDown;
        const book    = bookFor(tokenId);
        const ask     = book ? book.bestAskAt(nextW.windowStart) : null;
        if (ask != null && ask * 100 <= cfg.limit_price_cents) {
          const order: PendingOrder = {
            windowStart:   nextW.windowStart,
            windowEnd:     nextW.windowEnd,
            direction:     decision.direction,
            entryPrice:    ask,
            sizeUsdc:      cfg.size_usdc,
            signalPath:    'boundary',
            dcaRound:      0,
            streakAtEntry: decision.streak,
            tokenId,
          };
          pushPending(pendingByWindow, order);
          cycle.active   = true;
          cycle.direction = decision.direction;
          cycle.lastSize = null;
          cycle.dcaCount = 0;
          decisions.push({
            windowStart:         nextW.windowStart,
            windowEnd:           nextW.windowEnd,
            streak:              decision.streak,
            contrarianDirection: decision.direction,
            cycleActive:         false,    // pre-placement
            action:              'boundary',
          });
        } else {
          decisions.push({
            windowStart:         nextW.windowStart,
            windowEnd:           nextW.windowEnd,
            streak:              decision.streak,
            contrarianDirection: decision.direction,
            cycleActive:         false,
            action:              'skip',
            skipReason:          ask == null ? 'no_ask' : `ask>${cfg.limit_price_cents}c`,
          });
        }
      } else if (decision.skipReason) {
        decisions.push({
          windowStart:         nextW.windowStart,
          windowEnd:           nextW.windowEnd,
          streak:              decision.streak,
          contrarianDirection: decision.direction ?? null,
          cycleActive:         false,
          action:              'skip',
          skipReason:          decision.skipReason,
        });
      }
    }
  }

  // Drain anything that remained pending past the last window — resolve via
  // the last window's outcome equivalent (no further windows to walk).
  for (const orders of pendingByWindow.values()) {
    for (const order of orders) {
      // Use the order's targeted window outcome — but we never reached it,
      // so mark as unknown / null pnl. Skip from trades to keep stats clean.
      // (Edge case: only happens for orders placed in the very last window.)
      void order;
    }
  }

  return { trades, decisions };
}

// ── Boundary decision (T-3s of N for N+1 placement) ───────────────────────

interface BoundaryDecision {
  place:       boolean;
  direction?:  'up' | 'down';
  streak:      number;
  skipReason?: string;
}

function tryBoundary(
  windows: ReplayWindow[],
  i:       number,                             // index of current window N
  cfg:     PolyBacktestCoinConfig,
): BoundaryDecision {
  // streak as of N's start (= excludes N's outcome) — we need lookback
  // through prior 48 closed windows.
  const streak = computeStreak(windows, i);
  const absStreak = Math.abs(streak);
  if (absStreak < cfg.streak_min) {
    return { place: false, streak, skipReason: `streak<${cfg.streak_min}` };
  }

  const direction: 'up' | 'down' = streak > 0 ? 'down' : 'up';   // contrarian

  // In-progress candle gate (PMW's "current flipped" check). Approximate
  // by the just-closed window's outcome — by T-3s of N, ~99% of N's bar
  // is formed.
  const w = windows[i]!;
  if (w.outcome !== 'unknown') {
    const expectedOutcome: 'up' | 'down' = streak > 0 ? 'up' : 'down';
    if (w.outcome !== expectedOutcome) {
      return { place: false, direction, streak, skipReason: 'in_progress_flipped' };
    }
  }

  // Adaptive threshold — schedule overrides applied to N's hour at T-3s.
  const threshold = effectiveThreshold(cfg, w.windowEnd);
  const effectiveStreak = absStreak + 1;
  if (effectiveStreak < threshold) {
    return { place: false, direction, streak,
             skipReason: `eff_streak<${threshold}_(adaptive)` };
  }

  return { place: true, direction, streak };
}

// ── DCA decision (T+0 of N+1 — "should we double-down?") ──────────────────

interface DcaDecision {
  place:       boolean;
  streak:      number;
  skipReason?: string;
}

function tryDca(
  windows: ReplayWindow[],
  iNext:   number,                             // index of N+1 (target window)
  cfg:     PolyBacktestCoinConfig,
  cycle:   Cycle,
): DcaDecision {
  // streak as of N+1's start (= INCLUDES N's loss outcome)
  const streak = computeStreak(windows, iNext);
  const absStreak = Math.abs(streak);

  // Whitelist gate (empty = fire on every loss)
  if (cfg.dca_streak_whitelist.length > 0 && !cfg.dca_streak_whitelist.includes(absStreak)) {
    return { place: false, streak,
             skipReason: `whitelist[${cfg.dca_streak_whitelist.join(',')}]` };
  }

  // Defensive: streak direction must still oppose our bet.
  const streakDirection: 'up' | 'down' = streak > 0 ? 'up' : 'down';
  if (streakDirection === cycle.direction) {
    return { place: false, streak, skipReason: 'streak_flipped' };
  }

  void windows; void iNext;
  return { place: true, streak };
}

// ── Order resolution (walk ticks for TP/SL, fall back to outcome) ────────

function resolveOrder(
  order:   PendingOrder,
  w:       ReplayWindow,
  book:    BookReplay | null,
  cfg:     PolyBacktestCoinConfig,
): PolyBacktestTrade {
  // Default → resolve at window close based on outcome
  let exitReason: PolyBacktestTrade['exitReason'];
  let exitPrice  = 0;
  let exitTs     = w.windowEnd;

  if (book != null) {
    const tpPrice = cfg.tp_cents / 100;
    const slPrice = cfg.sl_cents / 100;

    // Search forward for first trigger
    const tpHit = book.scanForward(w.windowStart, w.windowEnd, b => b >= tpPrice);
    const slHit = book.scanForward(w.windowStart, w.windowEnd, b => b <= slPrice);

    // Whichever fires first wins the close
    let firstHit: { ts: number; bid: number; reason: 'tp' | 'sl' } | null = null;
    if (tpHit && slHit) firstHit = tpHit.ts <= slHit.ts
      ? { ...tpHit, reason: 'tp' }
      : { ...slHit, reason: 'sl' };
    else if (tpHit) firstHit = { ...tpHit, reason: 'tp' };
    else if (slHit) firstHit = { ...slHit, reason: 'sl' };

    if (firstHit) {
      exitReason = firstHit.reason;
      exitPrice  = firstHit.bid;
      exitTs     = firstHit.ts;
    } else {
      // no trigger → resolve at window close via outcome
      const won  = w.outcome === order.direction;
      exitReason = won ? 'resolution_win' : 'resolution_loss';
      exitPrice  = won ? 1.0 : 0.0;
    }
  } else {
    // No tick book — resolve via outcome only
    const won  = w.outcome === order.direction;
    exitReason = won ? 'resolution_win' : 'resolution_loss';
    exitPrice  = won ? 1.0 : 0.0;
  }

  const shares  = order.sizeUsdc / order.entryPrice;
  const pnlUsdc = (exitPrice - order.entryPrice) * shares;

  return {
    windowStart:   order.windowStart,
    windowEnd:     order.windowEnd,
    direction:     order.direction,
    streakAtEntry: order.streakAtEntry,
    signalPath:    order.signalPath,
    dcaRound:      order.dcaRound,
    entryPrice:    order.entryPrice,
    sizeUsdc:      order.sizeUsdc,
    shares,
    exitReason,
    exitPrice,
    exitTs,
    pnlUsdc,
  };
}

// ── Streak compute (newest closed → oldest, while same direction) ────────

const BASELINE_BARS = 48;

/** Streak signed (+up, -down) computed from outcomes of windows[start-N..start-1].
 *  Returns 0 if first newest is unknown (= can't decide direction). */
function computeStreak(windows: ReplayWindow[], startIdx: number): number {
  if (startIdx === 0) return 0;
  const lo = Math.max(0, startIdx - BASELINE_BARS);
  let n = 0;
  let dir: 'up' | 'down' | null = null;
  for (let i = startIdx - 1; i >= lo; i--) {
    const o = windows[i]!.outcome;
    if (o === 'unknown') break;
    if (dir == null) { dir = o; n = 1; continue; }
    if (o !== dir) break;
    n++;
  }
  if (dir == null) return 0;
  return dir === 'up' ? n : -n;
}

// ── Adaptive threshold (auto_schedule UTC hour overrides) ────────────────

function effectiveThreshold(cfg: PolyBacktestCoinConfig, atMs: number): number {
  const hour = new Date(atMs).getUTCHours();
  for (const e of cfg.auto_schedule) {
    const start = e.start_hour;
    const end   = (start + e.duration_hours) % 24;
    const inWindow = start <= end
      ? hour >= start && hour < end
      : hour >= start || hour < end;       // wraps midnight
    if (inWindow) return e.threshold;
  }
  return cfg.auto_order_min_streak;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function pushPending(map: Map<number, PendingOrder[]>, order: PendingOrder): void {
  const list = map.get(order.windowStart) ?? [];
  list.push(order);
  map.set(order.windowStart, list);
}
