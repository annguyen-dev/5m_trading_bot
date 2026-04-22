import type { Candle } from '../types/market.js';
import type { Horizon } from '../types/signal.js';
import type {
  BacktestConfig,
  BacktestResult,
  HorizonMetrics,
  SignalOutcome,
} from './types.js';

export class PerformanceAnalyzer {
  constructor(private readonly config: BacktestConfig) {}

  /**
   * Compute aggregate metrics from already-evaluated outcomes.
   * The BacktestEngine handles evaluation inline during replay — this class
   * only aggregates the numbers.
   */
  analyze(outcomes: SignalOutcome[], candles: Candle[]): BacktestResult {
    const horizons: Horizon[] = ['scale', 'short', 'mid', 'long'];
    const byHorizon: Record<string, HorizonMetrics> = {};
    for (const h of horizons) {
      byHorizon[h] = computeHorizonMetrics(outcomes.filter(o => o.signal.horizon === h));
    }

    return {
      config: this.config,
      totalSignals: outcomes.length,
      signalOutcomes: outcomes,
      byHorizon,
      mmTrapStats: computeMMTrapStats(outcomes),
      dataRange: {
        from: this.config.startDate.toISOString(),
        to: this.config.endDate.toISOString(),
        totalCandles: candles.length,
        totalTrades: 0, // set by runner
      },
    };
  }
}

// ── Pure metric functions ─────────────────────────────────────────────────────

function computeMMTrapStats(outcomes: SignalOutcome[]) {
  const trap  = outcomes.filter(o => o.signal.mmTrapFlag);
  const clean = outcomes.filter(o => !o.signal.mmTrapFlag);

  const byType: Record<string, number> = {};
  for (const o of trap) byType[o.signal.mmTrapType] = (byType[o.signal.mmTrapType] ?? 0) + 1;

  return {
    total: trap.length,
    byType,
    trapSignalWinRate:  winRate(trap),
    cleanSignalWinRate: winRate(clean),
  };
}

function winRate(outcomes: SignalOutcome[]): number {
  const decided = outcomes.filter(o => o.outcome === 'win' || o.outcome === 'loss');
  if (decided.length === 0) return 0;
  return decided.filter(o => o.outcome === 'win').length / decided.length;
}

function computeHorizonMetrics(outcomes: SignalOutcome[]): HorizonMetrics {
  const wins    = outcomes.filter(o => o.outcome === 'win');
  const losses  = outcomes.filter(o => o.outcome === 'loss');
  const neutral = outcomes.filter(o => o.outcome === 'neutral');
  const pending = outcomes.filter(o => o.outcome === 'pending');

  const decided = [...wins, ...losses];
  const wr = decided.length === 0 ? 0 : wins.length / decided.length;

  const returns = outcomes.filter(o => o.returnPct !== null).map(o => o.returnPct!);
  const avgReturn = returns.length === 0 ? 0 : returns.reduce((a, b) => a + b, 0) / returns.length;

  // TP/SL breakdown
  const tpHits = decided.filter(o => o.exitReason === 'tp').length;
  const tpHitRate = decided.length === 0 ? 0 : tpHits / decided.length;

  const winPnls  = wins.map(o => o.pnlPct ?? o.returnPct ?? 0);
  const lossPnls = losses.map(o => o.pnlPct ?? o.returnPct ?? 0);
  const avgWinPct  = winPnls.length  === 0 ? 0 : winPnls.reduce((a, b) => a + b, 0)  / winPnls.length;
  const avgLossPct = lossPnls.length === 0 ? 0 : lossPnls.reduce((a, b) => a + b, 0) / lossPnls.length;
  const lossRate   = decided.length  === 0 ? 0 : losses.length / decided.length;
  const expectancy = wr * avgWinPct + lossRate * avgLossPct;

  return {
    total:          outcomes.length,
    wins:           wins.length,
    losses:         losses.length,
    neutral:        neutral.length,
    pending:        pending.length,
    winRate:        wr,
    avgReturnPct:   avgReturn,
    sharpeRatio:    computeSharpe(returns),
    maxDrawdownPct: computeMaxDrawdown(returns),
    profitFactor:   profitFactor(winPnls, lossPnls),
    tpHitRate,
    avgWinPct,
    avgLossPct,
    expectancy,
  };
}

function computeSharpe(returns: number[]): number {
  if (returns.length < 2) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / returns.length;
  const stdDev = Math.sqrt(variance);
  if (stdDev === 0) return 0;
  return (mean / stdDev) * Math.sqrt(252);
}

function computeMaxDrawdown(returns: number[]): number {
  if (returns.length === 0) return 0;
  let equity = 1, peak = 1, maxDD = 0;
  for (const r of returns) {
    equity *= (1 + r);
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD;
}

function profitFactor(winReturns: number[], lossReturns: number[]): number {
  const grossProfit = winReturns.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(lossReturns.reduce((a, b) => a + b, 0));
  if (grossLoss === 0) return grossProfit > 0 ? Infinity : 1;
  return grossProfit / grossLoss;
}
