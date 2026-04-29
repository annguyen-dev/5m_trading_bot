/**
 * Poly-driven backtest types.
 *
 * Distinct from /backtest/types.ts (formula-based engine) to avoid coupling.
 * This engine replays the live PMW + OrderResolver strategy against historical
 * `poly_share_ticks` to estimate PnL of the streak/DCA approach over time.
 */

/** Single coin's strategy config — mirrors the runtime CoinConfig fields the
 *  PMW reads. Other fields (mode, enabled) are ignored — backtest always
 *  simulates as if `signal_and_order` enabled.
 *
 *  Time-based behavior is expressed entirely via `auto_schedule` (per-hour
 *  threshold overrides) — same model as the live Settings page. No separate
 *  skip/filter layer. */
export interface PolyBacktestCoinConfig {
  symbol:                 'BTC';        // v1: BTC only
  size_usdc:              number;
  streak_min:             number;
  auto_order_min_streak:  number;
  limit_price_cents:      number;
  tp_cents:               number;
  sl_cents:               number;
  dca_multiplier:         number;
  dca_streak_whitelist:   number[];     // empty = fire DCA on every loss
  auto_schedule:          PolyAutoScheduleEntry[];
}

export interface PolyAutoScheduleEntry {
  start_hour:     number;   // UTC
  duration_hours: number;
  threshold:      number;   // overrides auto_order_min_streak when window matches
}

/** Single backtest run input. */
export interface PolyBacktestRequest {
  fromMs:    number;        // inclusive
  toMs:      number;        // exclusive
  config:    PolyBacktestCoinConfig;
}

// ── Result shapes ──────────────────────────────────────────────────────────

/** One closed-position trade. BUY → exit (TP/SL/resolution). */
export interface PolyBacktestTrade {
  /** Window the BUY targeted (= window the BUY was placed for). */
  windowStart:    number;
  windowEnd:      number;
  /** Bet direction (contrarian → opposite of streak). */
  direction:      'up' | 'down';
  /** Streak length AT placement (positive = up, negative = down). */
  streakAtEntry:  number;
  /** Path that placed this order. */
  signalPath:     'boundary' | 'dca';
  /** DCA round within cycle (0 = boundary entry, 1 = first DCA, etc.). */
  dcaRound:       number;
  /** Entry price (best ask at BUY time). */
  entryPrice:     number;
  /** Sized in USDC at entry (boundary = base; dca = previous × multiplier). */
  sizeUsdc:       number;
  /** Shares bought = sizeUsdc / entryPrice. */
  shares:         number;
  /** Exit reason. */
  exitReason:     'tp' | 'sl' | 'resolution_win' | 'resolution_loss';
  /** Exit price (bid at TP/SL trigger; 1.0 / 0.0 for resolution). */
  exitPrice:      number;
  /** Exit timestamp (when the trigger fired or window closed). */
  exitTs:         number;
  /** Realized PnL in USDC. */
  pnlUsdc:        number;
}

/** Per-window decision log — useful even when no order placed (skip reasons). */
export interface PolyBacktestDecision {
  windowStart:    number;
  windowEnd:      number;
  /** Computed at T+4-equivalent. */
  streak:         number;
  /** What we would have bet if a placement happened. */
  contrarianDirection: 'up' | 'down' | null;
  /** Cycle state at decision time. */
  cycleActive:    boolean;
  /** Why an order DID or DID NOT place. */
  action:         'boundary' | 'dca' | 'skip';
  skipReason?:    string;
  /** If action=boundary|dca, the trade row's index in trades[]. */
  tradeIndex?:    number;
}

export interface PolyBacktestEquityPoint {
  ts:       number;
  equity:   number;       // running PnL in USDC
}

export interface PolyBacktestSummary {
  trades:           number;
  wins:             number;
  losses:           number;
  winRate:          number;     // wins / (wins + losses)
  totalPnlUsdc:     number;
  avgPnlPerTrade:   number;
  maxDrawdownUsdc:  number;
  /** Span of windows actually evaluated (data may not cover full request range). */
  coveredFromMs:    number | null;
  coveredToMs:      number | null;
  windowsEvaluated: number;
  /** Reason categories from skipped decisions, summed. */
  skipReasons:      Record<string, number>;
}

export interface PolyBacktestResult {
  request:     PolyBacktestRequest;
  summary:     PolyBacktestSummary;
  trades:      PolyBacktestTrade[];
  equity:      PolyBacktestEquityPoint[];
  /** Capped to last N (configurable in handler) to keep payload small. */
  decisions:   PolyBacktestDecision[];
}

/** SSE events streamed back during a long-running backtest. */
export type PolyBacktestStreamEvent =
  | { type: 'progress'; pct: number; msg: string }
  | { type: 'done';     result: PolyBacktestResult }
  | { type: 'error';    msg: string };
