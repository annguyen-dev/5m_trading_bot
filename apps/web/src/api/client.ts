/**
 * Typed API client — all calls go through /api (proxied to backend in dev).
 */

export interface CandleRow {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface SignalRow {
  id: string;
  ts: number;
  direction: 'BUY' | 'SELL' | 'HOLD';
  horizon: string;
  confidence: number | null;
  engine: string;
  /** 'auto' = confidence ≥ threshold (bot trades); 'manual' = user reviews */
  status?: 'auto' | 'manual';
  price_entry: number | null;
  price_target: number | null;
  stop_loss: number | null;
  exit_price: number | null;
  exit_reason: 'tp' | 'sl' | 'timeout' | 'hold' | 'session' | null;
  outcome: string;
  return_pct: number | null;
  pnl_pct: number | null;
  rationale: string | null;
}

export interface HorizonMetrics {
  total: number;
  wins: number;
  losses: number;
  neutral: number;
  pending: number;
  winRate: number;
  avgReturnPct: number;
  sharpeRatio: number;
  maxDrawdownPct: number;
  profitFactor: number;
  tpHitRate: number;
  avgWinPct: number;
  avgLossPct: number;
  expectancy: number;
}

export interface SummaryRow {
  total: number;
  wins: number;
  losses: number;
  neutral: number;
  pending: number;
  win_rate: number;
  avg_return_pct: number | null;
  total_pnl: number | null;
  by_horizon: Record<string, HorizonMetrics>;
  mm_trap_stats: {
    total: number;
    byType: Record<string, number>;
    trapSignalWinRate: number;
    cleanSignalWinRate: number;
  } | null;
  data_range: { from: string; to: string; totalCandles: number; totalTrades: number } | null;
}

export interface Environment {
  id: string;               // "run/<uuid>", "test/<file>", or "production"
  type: 'test' | 'production';
  label: string;
  createdAt: string;
  signalCount: number;
  formulaName?: string;
  formulaWeights?: Record<string, number>;
}

export interface EquityPoint {
  ts: number;
  equity: number;
}

export interface FormulaWeights {
  wKnn: number;
  wStreak: number;
  wIntraday: number;
  wVolume: number;
  confidenceThreshold: number;
  streakScale?: number;  // P_reversal per streak candle, e.g. 0.10 → streak5=50% (default 0.10)
  streakCap?: number;    // max P_reversal from streak formula (default 0.85)
  thresholdByStreak?: Record<number, number>; // per |s5m| override, e.g. { 4: 0.60, 5: 0.62 }
  volBoostMinRatio?: number; // default 1.5
  volBoostMinWick?:  number; // default 0.4
  volBoostGain?:     number; // default 0.10
  volBoostMax?:      number; // default 0.15
  liqBoost?:         number; // default 0.10 — added to pStreak when brokeLiq=true
}

export interface FormulaConfig {
  id: string;
  name: string;
  description: string | null;
  weights: FormulaWeights;
  is_active: boolean;
  created_at: number;
}

export interface FormulaAnalysisStats {
  byStreak1m: { absStreak: number; total: number; reversals: number; reversalRate: number; avgVolRatio: number; avgWickRatio: number }[];
  byStreak5m: { absStreak: number; total: number; reversals: number; reversalRate: number; avgVolRatio: number; avgWickRatio: number }[];
  byVolume:   { bucket: string; total: number; reversals: number; reversalRate: number }[];
  byCombo:    { combo: string; total: number; reversals: number; reversalRate: number }[];
  byTiming:   { absStreak: number; total: number; reversal5mRate: number; reversal1hRate: number; contRate: number }[];
  crossTab:   { streak5mRange: string; volBucket: string; alignment: string; total: number; reversals: number; reversalRate: number }[];
  byStreakVolume: { absStreak5m: number; volBucket: string; total: number; reversals: number; reversalRate: number }[];
  byLiqBreak:     { absStreak5m: number; brokeLiq: boolean; total: number; reversals: number; reversalRate: number }[];
  totalSamples: number;
  daysOfData:   number;
}

export interface FormulaAnalyzeResult {
  stats:            FormulaAnalysisStats;
  suggestedWeights: FormulaWeights;
  reasoning:        Record<string, string>;
  insights:         string[];
}

export interface SimulateResult {
  engine: string;
  direction: string;
  confidence: number;
  horizon: string;
  price_entry: number;
  price_target: number;
  stop_loss: number;
  rationale: string;
  mm_trap_flag: number;
  mm_trap_type: string;
}

export interface PolyResult {
  timestamp:   number;
  price:       number;
  direction:   'up' | 'down' | 'skip';
  p_signal:    number;
  ev:          number;
  share_price: number;
  spread:      number;
  skipReason?: string;
  macroBias: {
    bias:      'bullish' | 'bearish' | 'neutral';
    strength:  number;
    change24h: number;
    change7d:  number;
    ema1h:     number;
  };
  components: {
    quota:   { p: number; streak5m: number; todayCount: number; avgCount: number; pReversal: number };
    trend:   { p: number; trend15m: string; trend1h: string; score: number };
    pattern: { p: number; upVotes: number; downVotes: number; total: number; pUp: number };
    liq:     { p: number; liqLong: number; liqShort: number; cascade: number; pUp: number };
  };
  outcome?: {
    actual:     'up' | 'down';
    correct:    boolean;
    pnlPct:     number;
    entryPrice: number;
    exitPrice:  number;
    changePct:  number;
    changeUsd:  number;
  };
}

import { getStoredToken, handleUnauthorized } from '../auth/AuthContext.js';

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  // Attach the admin JWT on every API call. The AuthContext manages the token
  // lifecycle; if it's missing/expired, the server returns 401 and we bounce
  // the user back to the login page via handleUnauthorized().
  const token = getStoredToken();
  const headers = new Headers(options?.headers);
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  const res = await fetch(url, { ...options, headers });
  if (res.status === 401) {
    handleUnauthorized();
    throw new Error(`API ${url} → 401: unauthenticated`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`API ${url} → ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  getEnvironments: () =>
    request<{ environments: Environment[] }>('/api/environments')
      .then(r => r.environments),

  getSignals: (envId: string, page = 0, pageSize = 100) =>
    request<{ signals: SignalRow[]; total: number }>(
      `/api/signals/${encodeURIComponent(envId)}?page=${page}&pageSize=${pageSize}`,
    ),

  /** Convenience: load all signals (up to 5000) in one shot for client-side filter/pagination. */
  getAllSignals: (envId: string) =>
    request<{ signals: SignalRow[]; total: number }>(
      `/api/signals/${encodeURIComponent(envId)}?page=0&pageSize=5000`,
    ),

  getSummary: (envId: string) =>
    request<SummaryRow>(`/api/summary/${encodeURIComponent(envId)}`),

  getCandles: (envId: string, from?: string, to?: string) => {
    const q = new URLSearchParams();
    if (from) q.set('from', from);
    if (to)   q.set('to', to);
    return request<CandleRow[]>(`/api/candles/${encodeURIComponent(envId)}?${q}`);
  },

  getEquity: (runId: string) =>
    request<EquityPoint[]>(`/api/backtest/equity/${encodeURIComponent(runId)}`),

  /** All 1m OHLCV candles for a DB-backed backtest run. */
  getRunCandles: (runId: string) =>
    request<CandleRow[]>(`/api/run-candles/${encodeURIComponent(runId)}`),

  // ── Backtest runner ────────────────────────────────────────────────────────
  deleteBacktestRun: (envId: string) =>
    request<{ ok: boolean }>(`/api/backtest/runs/${encodeURIComponent(envId)}`, { method: 'DELETE' }),

  runBacktest: (from: string, to: string, formulaConfigId?: string, noCache?: boolean) =>
    request<{ jobId: string }>('/api/backtest/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, formulaConfigId, noCache }),
    }),

  // Poly-driven backtest — mirrors live PMW strategy on historical Poly ticks.
  // Returns a jobId; subscribe to /api/backtest/poly/progress/:jobId via SSE
  // to get progress + final result.
  runPolyBacktest: (body: PolyBacktestRequestBody) =>
    request<{ jobId: string }>('/api/backtest/poly/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),

  // ── Formula configs ────────────────────────────────────────────────────────
  getFormulaConfigs: () =>
    request<{ configs: FormulaConfig[] }>('/api/formula/configs')
      .then(r => r.configs),

  getActiveFormulaConfig: () =>
    request<{ config: FormulaConfig | null }>('/api/formula/configs/active')
      .then(r => r.config),

  createFormulaConfig: (name: string, weights: FormulaWeights, description?: string) =>
    request<{ id: string }>('/api/formula/configs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, weights, description }),
    }),

  updateFormulaConfig: (id: string, name: string, weights: FormulaWeights) =>
    request<{ ok: boolean }>(`/api/formula/configs/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, weights }),
    }),

  activateFormulaConfig: (id: string) =>
    request<{ ok: boolean }>(`/api/formula/configs/${id}/activate`, { method: 'PUT' }),

  deleteFormulaConfig: (id: string) =>
    request<{ ok: boolean }>(`/api/formula/configs/${id}`, { method: 'DELETE' }),

  analyzeFormula: (days: number, minSamples: number) =>
    request<FormulaAnalyzeResult>('/api/formula/analyze', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ days, minSamples }),
    }),

  // ── Simulate ────────────────────────────────────────────────────────────────
  getSimulateCandles: (from: string, to: string) =>
    request<CandleRow[]>(`/api/simulate/candles?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),

  runSimulate: (timestamp: number) =>
    request<SimulateResult>('/api/simulate/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ timestamp }),
    }),

  runPolySimulate: (timestamp: number, sharePrice?: number) =>
    request<PolyResult>('/api/poly-simulate/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ timestamp, sharePrice }),
    }),

  // ── Settings ────────────────────────────────────────────────────────────────
  getSettings: () =>
    request<SettingsResponse>('/api/settings'),

  updateSetting: (key: string, value: string) =>
    request<{ ok: boolean; effectiveTradingMode: 'simulate' | 'live' }>(`/api/settings/${encodeURIComponent(key)}`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ value }),
    }),

  // ── Polymarket Live ────────────────────────────────────────────────────────
  getPolyCurrentMarket: () =>
    request<PolyCurrentMarket>('/api/poly/market/current'),

  getPolyUpcomingMarkets: (limit = 5) =>
    request<{ markets: PolyMarketRow[] }>(`/api/poly/markets/upcoming?limit=${limit}`)
      .then(r => r.markets),

  getPolyShareHistory: (tokenId: string, range: PolyRange = '5m') =>
    request<{ ticks: PolyShareTick[] }>(
      `/api/poly/share-history?tokenId=${encodeURIComponent(tokenId)}&range=${range}`,
    ).then(r => r.ticks),

  getPolyBtcHistory: (range: PolyRange = '5m') =>
    request<{ ticks: PolyBtcTick[] }>(`/api/poly/btc-history?range=${range}`)
      .then(r => r.ticks),

  getPolyPastWindows: (count = 5) =>
    request<{ windows: PolyPastWindow[] }>(`/api/poly/past-windows?count=${count}`)
      .then(r => r.windows),

  placePolySimulatedOrder: (body: {
    conditionId: string; direction: 'up' | 'down';
    sharePrice:  number; sizeUsdc:  number;
  }) =>
    request<{ id: string; mode: string; ts: number }>('/api/poly/orders/simulate', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    }),

  // ── Balance ────────────────────────────────────────────────────────────────
  // Returns user's CLOB USDC collateral balance + allowance. Returns
  // {available:false} in simulate-only setups (no POLY_PRIVATE_KEY).
  getPolyBalance: () =>
    request<
      { available: false; reason: string }
      | { available: true; balance: number; allowance: number; address: string }
    >('/api/poly/balance'),

  // ── Manual sell ────────────────────────────────────────────────────────────
  // GET aggregates open BUY orders into per-direction "shares owned".
  // POST closes BUYs LIFO at the supplied exit price (current bid).
  getPolyPosition: (conditionId: string) =>
    request<{
      conditionId: string;
      up:   { shares: number; costBasis: number; avgPrice: number; openOrderCount: number };
      down: { shares: number; costBasis: number; avgPrice: number; openOrderCount: number };
    }>(`/api/poly/positions/${encodeURIComponent(conditionId)}`),

  sellPolyPosition: (body: {
    conditionId: string; direction: 'up' | 'down';
    sharesToSell: number;        // 0 = all
    exitPrice:    number;        // 0..1 — pass current bid
  }) =>
    request<{
      ok: boolean; mode: 'simulate' | 'live';
      closed: number; sharesSold: number;
      proceedUsdc: number; pnlUsdc: number; exitPrice: number;
      liveSoldShares: number | null;
    }>('/api/poly/orders/sell', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    }),

  /** Pull on-chain trades for a market straight from Polymarket data-api.
   *  Useful for cross-checking the bot's local order ledger against reality. */
  getPolyTrades: (conditionId: string) =>
    request<{ trades: PolyTradeRow[]; fromCache: boolean }>(
      `/api/poly/trades?conditionId=${encodeURIComponent(conditionId)}`,
    ),

  getPolyOrders: (status?: 'pending' | 'closed', limit = 100) => {
    const q = new URLSearchParams();
    if (status) q.set('status', status);
    q.set('limit', String(limit));
    return request<{ orders: PolyOrderRow[] }>(`/api/poly/orders?${q}`)
      .then(r => r.orders);
  },

  getPolyPortfolio: (mode: 'simulate' | 'live' = 'simulate') =>
    request<PolyPortfolio>(`/api/poly/portfolio?mode=${mode}`),

  resetTestData: () =>
    request<{ deleted: number; kept_live: number }>(
      '/api/poly/admin/reset-test-data', { method: 'DELETE' }),

  // ── Per-coin strategy config ───────────────────────────────────────────────
  getCoinConfigs: () =>
    request<CoinConfigRow[]>('/api/coin-configs'),

  updateCoinConfig: (symbol: string, patch: Partial<CoinConfigPatch>) =>
    request<CoinConfigRow>(`/api/coin-configs/${encodeURIComponent(symbol)}`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(patch),
    }),

  getTelegramChannels: () =>
    request<{ channels: TelegramChannel[] }>('/api/telegram-channels')
      .then(r => r.channels),

  saveTelegramChannels: (channels: TelegramChannel[]) =>
    request<{ channels: TelegramChannel[] }>('/api/telegram-channels', {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ channels }),
    }).then(r => r.channels),

  getStreakStats: (coin: string, days: number) =>
    request<StreakStatsResponse>(
      `/api/analyze/streak-stats?coin=${encodeURIComponent(coin)}&days=${days}`,
    ),
};

// ── Per-coin config types ───────────────────────────────────────────────────

export type CoinSymbol  = 'BTC' | 'ETH' | 'SOL' | 'XRP' | 'DOGE' | 'HYPE' | 'BNB' | 'BTC_1H';
export type CoinMode    = 'signal_only' | 'signal_and_order';
/** Strategy choice — 'streak' = baseline simple, 'echo' = Echo Hunt (arm-window). */
export type CoinStrategy = 'streak' | 'echo';

/** Echo idle-mode override edge case (see backend `EchoEdgeCase`).
 *  User-defined object: streak range + body3 thresholds (entry + DCA). */
export interface EchoEdgeCase {
  id:           string;
  label?:       string;
  enabled:      boolean;
  streakMin:    number;
  streakMax:    number;
  body3Min:     number;
  /** Upper bound on body3 to filter out the momentum-continuation trap
   *  zone (e.g. streak=5 body3>$700 on 5m has 46% reversal vs sweet spot
   *  $400-700 at 61%). Empty / undefined = no cap. */
  body3Max?:    number;
  /** Regime-relative entry gate: body3 / (avgBody×3) ≥ this. When set (>0),
   *  replaces the dollar body3Min/Max gate — self-adapts to volatility.
   *  Recommended: streak=3 → 1.2, streak=6/7 → 1.0. 0/undefined = dollar gate. */
  body3OverAvgMin?: number;
  dcaBody3Min:  number;
}

export interface AutoScheduleEntry {
  start_hour:     number;   // 0-23 UTC
  duration_hours: number;   // 1-24
  threshold:      number;   // override for auto_order_min_streak
}

// ── Streak analysis ────────────────────────────────────────────────────────

export interface StreakLengthRow {
  length:       number;
  count:        number;
  perDay:       number;
  lastSeenMs:   number;
  lastSeenAgo:  string;
}

export interface PostExtremeBucket {
  afterStreakAtLeast: number;
  occurrences:        number;
  avgMinsToSideways:  number;
  avgMaxStreakNext60: number;
  sidewaysFraction:   number;
}

export interface StreakGapBucket {
  thresholdLength: number;
  occurrences:     number;
  meanGapMin:      number;
  medianGapMin:    number;
  p10GapMin:       number;
  p90GapMin:       number;
  maxGapMin:       number;
}

export interface StreakGapEvent {
  endedAt:      number;
  signed:       number;          // signed length: + UP, − DOWN
  length:       number;          // abs
  gapBeforeMin: number | null;
}

/** Cluster of N streak-end events of |length| ≥ extLen within `windowMin`. */
export interface ClusterGapBucket {
  clusterSize:     number;
  windowMin:       number;
  extLen:          number;
  occurrences:     number;
  meanGapMin:      number;
  medianGapMin:    number;
  p10GapMin:       number;
  p90GapMin:       number;
  maxGapMin:       number;
}

export interface ClusterGapEvent {
  triggeredAt:        number;
  contributingEndsAt: number[];
  gapBeforeMin:       number | null;
}

export interface StreakStatsResponse {
  coin:          string;
  rangeStartMs:  number;
  rangeEndMs:    number;
  totalBars:     number;
  totalRuns:     number;
  streakLengths: StreakLengthRow[];
  highVol: {
    threshold:        number;
    occurrences:      number;
    perDay:           number;
    p50RunDurationMin: number;
    p90RunDurationMin: number;
    longestRunMin:    number;
  };
  postExtreme:      PostExtremeBucket[];
  hourlyHotness:    Array<{ hourUtc: number; perCandle: number }>;
  dayOfWeekHotness: Array<{
    dayUtc:    number;       // 0=Sun, 6=Sat (UTC)
    dayName:   string;
    perCandle: number;
    bigCount:  number;
    totalBars: number;
  }>;
  streakGaps: {
    byThreshold:  StreakGapBucket[];
    recentEvents: StreakGapEvent[];
  };
  clusterGaps: {
    byCluster:    ClusterGapBucket[];
    recentBySize: Record<string, ClusterGapEvent[]>;
  };
  suggested: {
    auto_order_min_streak: number;
    dca_streak_whitelist:  number[];
    reasoning:             string;
  };
}

export interface CoinConfigPatch {
  enabled:               boolean;
  strategy:              CoinStrategy;
  mode:                  CoinMode;
  /** Emit T+4 signal when |streak| ≥ this. */
  streak_min:            number;
  /** Place order at T-3s when |streak| ≥ this (only if mode=signal_and_order). */
  auto_order_min_streak: number;
  /** Hour-of-day (UTC) overrides for auto_order_min_streak. Empty = no overrides. */
  auto_schedule:         AutoScheduleEntry[];
  size_usdc:             number;
  limit_price_cents:     number;
  tp_cents:              number;
  sl_cents:              number;
  /** DCA size = previous_loser_size × dca_multiplier. Default 1.5. */
  dca_multiplier:        number;
  /**
   * Whitelist of |parent_streak| values at which DCA is allowed to fire.
   * Empty = always allowed (default). Non-empty = strict whitelist.
   */
  dca_streak_whitelist:  number[];

  // ── Echo Hunt strategy params (only used when strategy === 'echo') ─────────
  /** Streak length that, when it ENDS, opens the arm window. */
  echo_trigger_streak:       number;
  /** How long the arm window stays open after a trigger. */
  echo_window_minutes:       number;
  /** Inside the arm window, fire signal/order when |streak| ≥ this. */
  echo_signal_min_streak:    number;
  /** Idle baseline threshold for echo (when not armed). Independent from
   *  auto_order_min_streak so the two strategies don't interfere. */
  echo_baseline_streak:      number;
  /** V9 body filter: require ≥1 high-body bar (>1.5× avg) in the streak. */
  echo_require_high_body:    boolean;
  /** Idle-mode override edge cases (each lets the bot fire at lower streak when matched). */
  echo_edge_cases:           EchoEdgeCase[];
  /** ARMED-mode DCA size multipliers (e.g. [3,4] = base×3 after L1, base×4 after L2). */
  echo_dca_scale: number[];
  /** IDLE-mode DCA scale (empty = fall back to echo_dca_scale). */
  echo_dca_scale_idle: number[];
  // Defensive regime detection
  echo_defensive_enabled:          boolean;
  echo_defensive_streak_threshold: number;
  echo_defensive_overdue_minutes:  number;
  echo_defensive_action:           'disable_armed' | 'skip_all';
  /** Body-3 idle gate: |body3| ≥ this (price USD) required to fire in idle mode. 0 = disabled. */
  idle_body3_min:                  number;
  /** Body-3 armed gate: same but for armed mode. 0 = disabled. */
  armed_body3_min:                 number;
  /** Body-3 arm-trigger gate: triggering streak's |body3| ≥ this to OPEN the
   *  arm window (gates arming, not placement). 0 = disabled (count only). */
  arm_trigger_body3_min:           number;
  /** Body-3 arm-trigger UPPER cap: skip arming when body3 > this (momentum
   *  continuation trap). Empirical (BTC 5m 365d): streak=5 body3>$700 →
   *  reversal 46.5%, momentum exhausts at streak=7. Empty/0 = no cap. */
  arm_trigger_body3_max?:          number;
  /** Skip arming when streak > this (over-extension trap). Empirical (BTC 5m
   *  365d): streak≥9 reverses only 47%. Empty/0 = no cap. */
  arm_trigger_streak_max?:         number;
  /** Body-3 DCA gate when the cycle was opened in IDLE mode. 0 = disabled. */
  dca_body3_min_idle:              number;
  /** Body-3 DCA gate when the cycle was opened in ARMED mode. 0 = disabled. */
  dca_body3_min_armed:             number;
}

export interface CoinConfigRow extends CoinConfigPatch {
  symbol: CoinSymbol;
}

// ── Telegram channels ─────────────────────────────────────────────────────
export type TelegramInfoType = 'signal' | 'order';

export interface TelegramChannel {
  id:         string;
  name:       string;
  channel_id: string;
  enabled:    boolean;
  coins:      CoinSymbol[];         // empty = all coins
  info_types: TelegramInfoType[];   // empty = all types
}

export interface PolyPortfolio {
  mode: 'simulate' | 'live';
  totals: {
    total: number; pending: number; closed: number;
    wins: number; losses: number;
    realizedPnl: number; totalSize: number;
  };
  byCloseReason: Array<{ reason: string; count: number; avgPnl: number }>;
  bySignalPath:  Array<{ path: string; count: number; totalPnl: number }>;
  recent: Array<{
    id: string; direction: string; share_price: number;
    pnl_usdc: number | null; close_reason: string | null;
    ts_entry: string; status: string;
  }>;
}

export interface SettingsResponse {
  settings:              Record<string, string>;
  hasPolymarketKey:      boolean;
  effectiveTradingMode:  'simulate' | 'live';
}

// ── Polymarket Live page types ──────────────────────────────────────────────

export type PolyRange = '5m' | '15m' | '1h' | '1d' | '3d';

export interface PolyMarketRow {
  condition_id:    string;
  slug:            string;
  question:        string;
  window_start:    string;          // pg returns BIGINT as text
  window_end:      string;
  token_up:        string;
  token_down:      string;
  resolution_src:  string;
}

export interface PolyShareTickLatest {
  ts:          string;
  best_bid:    number | null;
  best_ask:    number | null;
  last_price:  number | null;
}

export interface PolyCurrentMarket {
  market: PolyMarketRow | null;
  shares?: { up: PolyShareTickLatest | null; down: PolyShareTickLatest | null };
}

export interface PolyShareTick {
  ts:          string;              // ms
  best_bid:    number | null;
  best_ask:    number | null;
  last_price:  number | null;
  event_type:  string;
}

export interface PolyBtcTick {
  ts:               string;
  price:            number;
  volume_5s:        number;
  price_change_5s:  number;
  ob_imbalance:     number;
  vol_spike_z:      number;
}

export interface PolyPastWindow {
  windowStart: number;
  windowEnd:   number;
  btcOpen:     number | null;
  btcClose:    number | null;
  outcome:     'up' | 'down' | null;
}

export type PolyOrderMode   = 'simulate' | 'live';
export type PolyOrderSource = 'manual' | 'auto' | 'backtest';
/** UI categorisation: simulate | backtest | live (derived from mode + source). */
export type PolyOrderKind   = 'simulate' | 'backtest' | 'live';
/** Strategy path that placed an auto order. */
export type PolySignalPath  = 'boundary' | 'dca' | 'panic';

export type PolyCloseReason = 'resolution' | 'tp' | 'sl' | 'manual' | 'cancelled';
export type PolyOrderSide   = 'buy' | 'sell';

/** On-chain trade pulled from Polymarket data-api (NOT our DB). */
export interface PolyTradeRow {
  transactionHash: string;
  /** Unix SECONDS (not ms) — Polymarket returns seconds. */
  timestamp:       number;
  side:            'BUY' | 'SELL';
  price:           number;     // 0..1 — per-share dollar price
  size:            number;     // shares
  asset:           string;     // ERC-1155 token id
  outcome:         string;     // "Up" / "Down" / coin label
  proxyWallet:     string | null;
}

export interface PolyOrderRow {
  id:               string;
  market_id:        string;
  ts_entry:         string;
  direction:        'up' | 'down';
  share_price:      number;
  size_usdc:        number;
  mode:             PolyOrderMode;
  source:           PolyOrderSource;
  side:             PolyOrderSide;
  parent_order_id:  string | null;
  status:           'pending' | 'closed';
  pnl_usdc:     number | null;
  exit_price:   number | null;
  close_reason: PolyCloseReason | null;
  resolved_at:  string | null;
  /** Per-order TP in cents. null → resolver uses global auto_order_tp_cents. */
  tp_cents:     number | null;
  /** Per-order SL in cents. null → no SL for this order (hold to resolution). */
  sl_cents:     number | null;
  /** Which auto-signal path placed this (null for manual orders). */
  signal_path:  PolySignalPath | null;
  slug?:        string | null;
  question?:    string | null;
  window_start?: string | null;
  window_end?:   string | null;
  /** Token IDs for the order's market — used to look up live bid/ask in the
   *  shares stream so we can show unrealized PnL on pending positions. */
  token_up?:    string | null;
  token_down?:  string | null;
}

/** Map (mode, source) → which UI tab the order belongs in. */
export function polyOrderKind(o: Pick<PolyOrderRow, 'mode' | 'source'>): PolyOrderKind {
  if (o.source === 'backtest') return 'backtest';
  if (o.mode === 'live')       return 'live';
  return 'simulate';
}

// ────────────────────────────────────────────────────────────────────────────
// Poly backtest types (see apps/api/src/backtest/poly/types.ts for source)
// ────────────────────────────────────────────────────────────────────────────

export interface PolyBacktestAutoScheduleEntry {
  start_hour:     number;
  duration_hours: number;
  threshold:      number;
}

export interface PolyBacktestCoinConfig {
  symbol:                'BTC';
  /** 'streak' = legacy baseline; 'echo' = arm-window strategy. */
  strategy:              CoinStrategy;
  size_usdc:             number;
  streak_min:            number;
  auto_order_min_streak: number;
  limit_price_cents:     number;
  tp_cents:              number;
  sl_cents:              number;
  dca_multiplier:        number;
  dca_streak_whitelist:  number[];
  auto_schedule:         PolyBacktestAutoScheduleEntry[];
  echo_trigger_streak:    number;
  echo_window_minutes:    number;
  echo_signal_min_streak: number;
  echo_baseline_streak:   number;
  echo_require_high_body: boolean;
  echo_edge_cases:        EchoEdgeCase[];
  echo_dca_scale:         number[];
  echo_dca_scale_idle:    number[];
  echo_defensive_enabled:          boolean;
  echo_defensive_streak_threshold: number;
  echo_defensive_overdue_minutes:  number;
  echo_defensive_action:           'disable_armed' | 'skip_all';
}

export interface PolyBacktestRequestBody {
  fromMs:    number;
  toMs:      number;
  config:    PolyBacktestCoinConfig;
}

export interface PolyBacktestTrade {
  windowStart:   number;
  windowEnd:     number;
  direction:     'up' | 'down';
  streakAtEntry: number;
  signalPath:    'boundary' | 'dca';
  dcaRound:      number;
  entryPrice:    number;
  sizeUsdc:      number;
  shares:        number;
  exitReason:    'tp' | 'sl' | 'resolution_win' | 'resolution_loss';
  exitPrice:     number;
  exitTs:        number;
  pnlUsdc:       number;
}

export interface PolyBacktestEquityPoint { ts: number; equity: number }

export interface PolyBacktestSummary {
  trades:           number;
  wins:             number;
  losses:           number;
  winRate:          number;
  totalPnlUsdc:     number;
  avgPnlPerTrade:   number;
  maxDrawdownUsdc:  number;
  coveredFromMs:    number | null;
  coveredToMs:      number | null;
  windowsEvaluated: number;
  skipReasons:      Record<string, number>;
}

export interface PolyBacktestDecision {
  windowStart:         number;
  windowEnd:           number;
  streak:              number;
  contrarianDirection: 'up' | 'down' | null;
  cycleActive:         boolean;
  action:              'boundary' | 'dca' | 'skip';
  skipReason?:         string;
}

export interface PolyBacktestResult {
  request:   PolyBacktestRequestBody;
  summary:   PolyBacktestSummary;
  trades:    PolyBacktestTrade[];
  equity:    PolyBacktestEquityPoint[];
  decisions: PolyBacktestDecision[];
}
