import type { Signal } from '../types/signal.js';
import type { Candle, Trade } from '../types/market.js';

export interface FormulaWeights {
  wKnn: number;             // default 0.20
  wStreak: number;          // default 0.35
  wIntraday: number;        // default 0.35
  wVolume: number;          // default 0.10
  confidenceThreshold: number; // default 0.58 — used when thresholdByStreak has no entry
  // Configurable P_streak formula: P_reversal = min(streakCap, |streak| * streakScale)
  // e.g. streakScale=0.10 → streak=5 → P=50%, streak=6 → P=60%
  streakScale?: number;  // default 0.10 — probability added per streak candle
  streakCap?: number;    // default 0.85 — max P_reversal from streak
  // Per-|streak_5m| confidence thresholds. If |streak_5m|=N has entry, use it;
  // else fall back to confidenceThreshold.
  thresholdByStreak?: Record<number, number>; // e.g. { 4: 0.60, 5: 0.62, 6: 0.63, ... }
  // Volume exhaustion boost: when volumeRatio > volBoostMinRatio AND wickRatio > volBoostMinWick,
  // add volBoostGain * (volumeRatio - volBoostMinRatio) to pStreak (capped at volBoostMax).
  volBoostMinRatio?: number; // default 1.5
  volBoostMinWick?:  number; // default 0.4
  volBoostGain?:     number; // default 0.10  (per 1.0 volRatio above threshold)
  volBoostMax?:      number; // default 0.15  (max added to pStreak)
  // Liquidity break boost: added to pStreak when current candle wick pierced
  // prior 4h/24h high/low or a round-number level ($500 step).
  liqBoost?: number; // default 0.10
}

export interface BacktestConfig {
  symbol: string;          // e.g. 'BTC/USDT'
  exchangeId: string;      // e.g. 'binance'
  startDate: Date;
  endDate: Date;
  // Evaluation windows per horizon
  evalWindows: {
    scale: number;         // minutes (default 5  = 5m scalp)
    short: number;         // minutes (default 30)
    mid: number;           // minutes (default 4320 = 3 days)
  };
  // Win threshold: price must move this % in signal direction to count as a win
  winThresholdPct: {
    scale: number;         // default 0.002 (0.2% in 5m)
    short: number;         // default 0.005 (0.5%)
    mid: number;           // default 0.015 (1.5%)
  };
  // Whether to simulate trades from OHLCV (true) or use real fetchTrades (false)
  simulateTrades: boolean;
  // Directory for backtest result JSON files + lancedb
  cacheDir: string;
  // Claude model — 'claude-haiku-4-5' (default, cheap) or 'claude-sonnet-4-5' (full quality)
  aiModel?: string;
  // Use rule-based MockAIService instead of real Claude (free, instant, deterministic)
  mockAI?: boolean;
  // Only use k-NN statistical engine — skip Claude entirely when k-NN has no result
  knnOnly?: boolean;
  // If set, save the run + all signal outcomes to PostgreSQL after completion
  persistToDb?: boolean;
  // Run label shown in the simulate dashboard (defaults to date range)
  runLabel?: string;
  // Skip DB cache and fetch fresh from exchange API (still UPSERTs on success)
  noCache?: boolean;
  // Formula weights override (uses DB active config if omitted)
  formulaWeights?: FormulaWeights;
  formulaConfigId?: string;
  // Progress callback — called every ~100 candles during run
  onProgress?: (pct: number, msg: string) => void;
}

export const DEFAULT_CONFIG: Omit<BacktestConfig, 'startDate' | 'endDate'> = {
  symbol: 'BTC/USDT',
  exchangeId: 'binance',
  evalWindows: { scale: 5, short: 30, mid: 4_320 },
  winThresholdPct: { scale: 0.002, short: 0.005, mid: 0.015 },
  simulateTrades: true,
  cacheDir: './data/backtest',
};

// A single signal with its evaluated outcome
export interface SignalOutcome {
  signal: Signal;
  entryPrice: number;
  evalPrice: number | null;     // null if not enough future data
  returnPct: number | null;     // positive = price moved in signal direction
  outcome: 'win' | 'loss' | 'neutral' | 'pending';
  // How the trade ended:
  //   'session' = poly mode, exit at close of minute 4 of next 5m session
  //   'tp' | 'sl' = TP/SL hit (non-poly horizons)
  //   'timeout' = eval deadline reached without TP/SL hit
  //   'hold' = HOLD signal, no trade
  exitReason: 'tp' | 'sl' | 'timeout' | 'hold' | 'session';
  pnlPct: number | null;        // realised P&L
}

// Full backtest result
export interface BacktestResult {
  config: BacktestConfig;
  totalSignals: number;
  signalOutcomes: SignalOutcome[];
  byHorizon: {
    [horizon: string]: HorizonMetrics;
  };
  mmTrapStats: {
    total: number;
    byType: Record<string, number>;
    trapSignalWinRate: number;     // win rate of signals WITH mm trap flag (should be low)
    cleanSignalWinRate: number;    // win rate of signals WITHOUT mm trap flag
  };
  dataRange: {
    from: string;
    to: string;
    totalCandles: number;
    totalTrades: number;
  };
}

export interface HorizonMetrics {
  total: number;
  wins: number;
  losses: number;
  neutral: number;
  pending: number;
  winRate: number;           // wins / (wins + losses)
  avgReturnPct: number;      // mean of returnPct for decided outcomes
  sharpeRatio: number;       // annualised Sharpe (returns / std dev * sqrt(252))
  maxDrawdownPct: number;    // max peak-to-trough in equity curve
  profitFactor: number;      // sum(wins) / abs(sum(losses))
  // TP/SL breakdown
  tpHitRate: number;         // fraction of decided signals that hit TP
  avgWinPct: number;         // average pnlPct on winning trades
  avgLossPct: number;        // average pnlPct on losing trades (negative number)
  expectancy: number;        // winRate * avgWin + lossRate * avgLoss (per-trade EV)
}

// Raw historical dataset loaded by DataFetcher
export interface HistoricalDataset {
  candles: Candle[];
  trades: Trade[];           // may be simulated from candles
}
