/**
 * BacktestEngine — event-driven replay of historical candles + trades.
 *
 * Uses the REAL AIService + VectorStoreService — the same pipeline as production.
 * The only difference from live trading:
 *   - No WebSocket (candles/trades are replayed from cached OHLCV)
 *   - No Telegram alerts
 *   - Signal timestamps are fixed to candle time (not wall clock)
 *   - Outcome evaluation happens inline when the eval window expires
 *
 * Model defaults to 'claude-haiku-4-5' for cost efficiency.
 * Override with BacktestConfig.aiModel = 'claude-sonnet-4-5' for full quality.
 */

import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import type { Candle, Trade, CVDState } from '../types/market.js';
import type { Signal, Horizon } from '../types/signal.js';
import { MMDetectorService } from '../services/MMDetectorService.js';
import { AIService } from '../services/AIService.js';
import { MockAIService } from './MockAIService.js';
import { StatisticalSignalService } from '../services/StatisticalSignalService.js';
import { VectorStoreService } from '../services/VectorStoreService.js';
import { MacroEventStore } from '../services/MacroEventStore.js';
import { SignalPipeline } from '../pipeline/SignalPipeline.js';
import { SignalRepository } from '../services/SignalRepository.js';
import { migrate } from '@trading-bot/db/migrate';
import type { TrendContext } from '../services/AIService.js';
import type { BacktestConfig, HistoricalDataset, SignalOutcome } from './types.js';

// ── Null Telegram stub — no alerts during backtest ────────────────────────────

class NullTelegramService {
  async sendSignal(_signal: Signal): Promise<void> {}
}

// ── Constants ─────────────────────────────────────────────────────────────────

const EMA_PERIOD = 20;
const ANOMALY_THRESHOLD = 0.02;
const CVD_WINDOW = 200;
const CANDLE_HISTORY = 1440;   // 1 day of 1m candles — enough for 24h/7d trend
const STREAK_MIN     = 3;      // minimum streak_1m length to evaluate a signal
// Use the canonical minimum from SignalPipeline — single source of truth
const STREAK_5M_MIN  = SignalPipeline.STREAK_5M_MIN;

// Anomaly: 1 signal per hour max
const ANOMALY_COOLDOWN_MS = 60 * 60_000;
// Streak: 1 signal per 5 minutes — avoids flooding during long runs, but captures each new streak candle
const STREAK_COOLDOWN_MS = 5 * 60_000;

// Default TP/SL ratios when AI doesn't provide them (as fraction of entry price).
// Used only for non-scale horizons (anomaly mid signals). Scale/streak signals use
// poly mode: entry = prev 5m close (signal-fire candle close), exit = close of the
// 4th 1m candle of the applied 5m session.
const DEFAULT_TP: Record<string, number> = { scale: 0.003, short: 0.008, mid: 0.020, long: 0.050 };
const DEFAULT_SL: Record<string, number> = { scale: 0.0015, short: 0.004, mid: 0.010, long: 0.025 };

// Poly-mode exit offset from the applied-session start: 3 minutes = close of the
// 4th 1m candle (candles are at offsets 0,1,2,3,4 — exit at index 3).
const POLY_EXIT_OFFSET_MS = 3 * 60_000;

// ── Pending evaluation entry ──────────────────────────────────────────────────

interface PendingEval {
  signal: Signal;
  entryPrice: number;
  entryTimestamp: number;
  evalDeadline: number;
  /**
   * Poly mode (scale signals): no TP/SL — exit at close of candle at evalDeadline.
   * Non-poly (other horizons): use tp/sl as hit levels.
   */
  polyMode: boolean;
  tp?: number;   // take-profit price level (non-poly only)
  sl?: number;   // stop-loss price level   (non-poly only)
}

// Signal fired at end of candle N; entry/TP/SL are finalised when candle N+1 opens
// (realistic execution: you cannot trade AT the bar that closes with the signal).
interface DeferredSignal {
  signal: Signal;
  firedAt: number;     // candle.timestamp of the bar that completed the streak
  firedClose: number;  // close of the fire candle = prev 5m close (entry ref for poly)
}

// ── Engine ────────────────────────────────────────────────────────────────────

export class BacktestEngine extends EventEmitter {
  private pipeline!: SignalPipeline;
  private mmDetector!: MMDetectorService;
  private vectorStore!: VectorStoreService;

  // CVD state
  private cvd = 0;
  private cvdWindow: Trade[] = [];

  // EMA state
  private ema = 0;
  private lastPrice = 0;
  private candleCount = 0;

  // Trend state — rolling candle history for 24h / 7d change
  private candleHistory: Candle[] = [];

  // Streak state — consecutive same-direction 1m candles
  private streakCount = 0;
  private streakDir: 'up' | 'down' = 'up';

  // Cooldown state — prevent firing hundreds of identical signals
  private lastAnomalyTs = 0;

  // streak_5m trigger state — fire each time streak_5m reaches a new higher level
  // Reset when streak direction flips
  private lastFired5mLevel = 0;   // abs(streak_5m) at last fire for current direction
  private lastFired5mDir: 'up' | 'down' | null = null;

  // Signal evaluation state
  private pendingEvals: PendingEval[] = [];
  private deferredSignals: DeferredSignal[] = [];  // signals fired at N, activated at N+1.open
  private outcomes: SignalOutcome[] = [];

  // Diagnostic counters — reveal where signals are lost between fire → emit
  private firesByKind = { streak5m: 0, anomaly: 0 };
  private emittedByKind = { streak5m: 0, anomaly: 0 };
  private pipelineErrors = 0;
  private firesByLevel: Record<number, number> = {};
  private emittedByLevel: Record<number, number> = {};

  constructor(private readonly config: BacktestConfig) {
    super();
  }

  private async init(): Promise<void> {
    // Use a dedicated LanceDB path for backtest so it doesn't pollute production data
    const dbPath = `${this.config.cacheDir}/lancedb_backtest`;

    this.vectorStore = new VectorStoreService(dbPath);
    await this.vectorStore.init();

    this.mmDetector = new MMDetectorService();

    const aiService = this.config.mockAI
      ? new MockAIService()
      : new AIService(this.config.aiModel ?? 'claude-haiku-4-5');
    const nullTelegram = new NullTelegramService();

    // Statistical k-NN engine — uses kb_snapshots if available, returns null otherwise
    const statisticalAI = new StatisticalSignalService(this.config.formulaWeights);

    const macroStore = new MacroEventStore(this.vectorStore);
    await macroStore.init();

    this.pipeline = new SignalPipeline(
      aiService,
      this.vectorStore,
      this.mmDetector,
      nullTelegram as any, // eslint-disable-line @typescript-eslint/no-explicit-any
      undefined,
      macroStore,
      undefined,
      undefined,
      statisticalAI,
      this.config.knnOnly ?? false,
    );

    this.pipeline.on('pipelineError', () => { this.pipelineErrors++; });

    // Diagnostic-only listener: counts emissions. pendingEvals are pushed by
    // fireStreakWithTimestamp / fireAnomalyWithTimestamp which override timestamp
    // with candle time (pipeline emits with Date.now() which is wrong for backtest).
    this.pipeline.on('signal', (signal: Signal) => {
      const m = /s5m=(-?\d+)/.exec(signal.rationale ?? '');
      if (m) {
        const lvl = Math.abs(parseInt(m[1]!, 10));
        this.emittedByLevel[lvl] = (this.emittedByLevel[lvl] ?? 0) + 1;
        this.emittedByKind.streak5m++;
      } else {
        this.emittedByKind.anomaly++;
      }
    });
  }

  async run(dataset: HistoricalDataset): Promise<SignalOutcome[]> {
    await this.init();
    this.pendingEvals = [];
    this.outcomes = [];

    const { candles, trades } = dataset;
    let tradeIdx = 0;

    console.log(`[BacktestEngine] Replaying ${candles.length} candles + ${trades.length} trades`);
    console.log(`[BacktestEngine] AI model: ${this.config.aiModel ?? 'claude-haiku-4-5'}`);

    for (let i = 0; i < candles.length; i++) {
      const candle = candles[i]!;

      // Step 0: activate signals that fired on the PREVIOUS candle — entry = this candle's open,
      // TP/SL re-anchored from that entry. Realistic: signal is known only when bar N closes,
      // the earliest tradeable price is bar N+1's open.
      this.activateDeferred(candle);

      // Step 1: settle any pending signals whose eval window has expired
      this.settlePending(candle);

      // Step 2: feed trades in this candle's 1-minute window
      const candleEnd = candle.timestamp + 59_999;
      while (tradeIdx < trades.length && trades[tradeIdx]!.timestamp <= candleEnd) {
        this.processTrade(trades[tradeIdx]!);
        tradeIdx++;
      }

      // Step 3: process candle → may emit new signals via pipeline
      await this.processCandle(candle);

      if (i > 0 && i % 100 === 0) {
        const pct = ((i / candles.length) * 100).toFixed(1);
        const msg = `${pct}% — ${i}/${candles.length} candles | ${this.outcomes.length} settled`;
        process.stdout.write(`\r[BacktestEngine] ${msg}  `);
        this.config.onProgress?.(parseFloat(pct), msg);
      }
    }

    process.stdout.write('\n');

    // Remaining pending signals didn't get enough future data
    for (const p of this.pendingEvals) {
      this.outcomes.push({
        signal: p.signal,
        entryPrice: p.entryPrice,
        evalPrice: null,
        returnPct: null,
        outcome: 'pending',
        exitReason: 'timeout',
        pnlPct: null,
      });
    }

    console.log(
      `[BacktestEngine] Done — ${this.outcomes.length} signals  ` +
      `(${this.outcomes.filter(o => o.outcome === 'pending').length} pending)`,
    );

    // ── Diagnostic: fire vs emit gap ─────────────────────────────────────────
    console.log('\n[BacktestEngine] ── Fire → Emit gap ──');
    console.log(`  streak5m fires : ${this.firesByKind.streak5m}`);
    console.log(`  streak5m emits : ${this.emittedByKind.streak5m}`);
    console.log(`  anomaly  fires : ${this.firesByKind.anomaly}`);
    console.log(`  anomaly  emits : ${this.emittedByKind.anomaly}`);
    console.log(`  pipeline errors: ${this.pipelineErrors}`);
    console.log('  by |s5m| level :');
    const levels = new Set([...Object.keys(this.firesByLevel), ...Object.keys(this.emittedByLevel)]);
    for (const k of [...levels].map(Number).sort((a, b) => a - b)) {
      const f = this.firesByLevel[k] ?? 0;
      const e = this.emittedByLevel[k] ?? 0;
      const gap = f - e;
      console.log(`    |s5m|=${String(k).padStart(2)}  fired=${String(f).padStart(3)}  emitted=${String(e).padStart(3)}  gap=${gap}`);
    }
    console.log('');

    if (this.config.persistToDb) {
      await this.persistRunToDb(dataset);
    }

    return this.outcomes;
  }

  // ── Pending evaluation ────────────────────────────────────────────────────

  /**
   * Called once per candle. For each pending signal:
   *  - Poly mode (scale/streak): wait for eval deadline, settle at that candle's close.
   *    No TP/SL — win = exit beat entry in predicted direction.
   *  - Non-poly (other horizons): check TP/SL hits intra-candle; fall back to timeout close.
   *
   * For a BUY:  TP hit when candle.high >= tp,  SL hit when candle.low <= sl
   * For a SELL: TP hit when candle.low  <= tp,  SL hit when candle.high >= sl
   *
   * If both TP and SL are touched in the same candle (gap / spike), we conservatively
   * assume SL was hit first (worst-case).
   */
  private settlePending(candle: Candle): void {
    const stillPending: PendingEval[] = [];

    for (const p of this.pendingEvals) {
      const isBuy = p.signal.direction === 'BUY';

      // ── Poly mode: session exit, no TP/SL ────────────────────────────────
      if (p.polyMode) {
        if (candle.timestamp < p.evalDeadline) {
          stillPending.push(p);
          continue;
        }
        const evalPrice = candle.close;
        const pnl = isBuy
          ? (evalPrice - p.entryPrice) / p.entryPrice
          : (p.entryPrice - evalPrice) / p.entryPrice;
        this.outcomes.push({
          signal: p.signal,
          entryPrice: p.entryPrice,
          evalPrice,
          returnPct: pnl,
          outcome: pnl > 0 ? 'win' : pnl < 0 ? 'loss' : 'neutral',
          exitReason: 'session',
          pnlPct: pnl,
        });
        continue;
      }

      // ── Non-poly: TP/SL mode ─────────────────────────────────────────────
      const tp = p.tp!;
      const sl = p.sl!;

      const tpTouched = isBuy ? candle.high >= tp : candle.low  <= tp;
      const slTouched = isBuy ? candle.low  <= sl : candle.high >= sl;

      if (slTouched) {
        // SL hit (or both hit — conservative assumption)
        const pnlPct = isBuy
          ? (sl - p.entryPrice) / p.entryPrice
          : (p.entryPrice - sl) / p.entryPrice;
        this.outcomes.push({
          signal: p.signal,
          entryPrice: p.entryPrice,
          evalPrice: sl,
          returnPct: pnlPct,
          outcome: 'loss',
          exitReason: 'sl',
          pnlPct,
        });
        continue;
      }

      if (tpTouched) {
        const pnlPct = isBuy
          ? (tp - p.entryPrice) / p.entryPrice
          : (p.entryPrice - tp) / p.entryPrice;
        this.outcomes.push({
          signal: p.signal,
          entryPrice: p.entryPrice,
          evalPrice: tp,
          returnPct: pnlPct,
          outcome: 'win',
          exitReason: 'tp',
          pnlPct,
        });
        continue;
      }

      // Neither TP nor SL hit yet
      if (candle.timestamp < p.evalDeadline) {
        stillPending.push(p);
        continue;
      }

      // Deadline reached — settle at close price
      const evalPrice = candle.close;
      const rawReturn = isBuy
        ? (evalPrice - p.entryPrice) / p.entryPrice
        : (p.entryPrice - evalPrice) / p.entryPrice;

      this.outcomes.push({
        signal: p.signal,
        entryPrice: p.entryPrice,
        evalPrice,
        returnPct: rawReturn,
        outcome: rawReturn > 0 ? 'win' : rawReturn < 0 ? 'loss' : 'neutral',
        exitReason: 'timeout',
        pnlPct: rawReturn,
      });
    }

    this.pendingEvals = stillPending;
  }

  // ── Trade processing ──────────────────────────────────────────────────────

  private processTrade(trade: Trade): void {
    const delta = trade.side === 'buy' ? trade.amount : -trade.amount;
    this.cvd += delta;
    this.cvdWindow.push(trade);
    if (this.cvdWindow.length > CVD_WINDOW) this.cvdWindow.shift();

    this.lastPrice = trade.price;
    this.pipeline.onTrade(trade);
    this.pipeline.onCVD(this.buildCVDState(trade));
  }

  private buildCVDState(trade: Trade): CVDState {
    if (this.cvdWindow.length < 2) {
      return { cvd: this.cvd, price: trade.price, divergence: 0, windowTrades: [] };
    }
    const first = this.cvdWindow[0]!;
    const last  = this.cvdWindow[this.cvdWindow.length - 1]!;
    const priceChange = (last.price - first.price) / first.price;
    const buyVol  = this.cvdWindow.filter(t => t.side === 'buy').reduce((s, t) => s + t.amount, 0);
    const sellVol = this.cvdWindow.filter(t => t.side === 'sell').reduce((s, t) => s + t.amount, 0);
    const totalVol = buyVol + sellVol;
    const cvdDir   = totalVol === 0 ? 0 : (buyVol - sellVol) / totalVol;
    return { cvd: this.cvd, price: trade.price, divergence: priceChange - cvdDir, windowTrades: [...this.cvdWindow] };
  }

  // ── Candle processing ─────────────────────────────────────────────────────

  private async processCandle(candle: Candle): Promise<void> {
    this.candleCount++;
    this.lastPrice = candle.close;

    // Maintain rolling history
    this.candleHistory.push(candle);
    if (this.candleHistory.length > CANDLE_HISTORY) this.candleHistory.shift();

    // Update EMA
    const k = 2 / (EMA_PERIOD + 1);
    this.ema = this.ema === 0 ? candle.close : candle.close * k + this.ema * (1 - k);

    // Track streak (skip very first candle — no prior close)
    if (this.candleHistory.length >= 2) {
      const prev = this.candleHistory[this.candleHistory.length - 2]!;
      const dir: 'up' | 'down' = candle.close >= prev.close ? 'up' : 'down';
      if (dir === this.streakDir) {
        this.streakCount++;
      } else {
        this.streakDir = dir;
        this.streakCount = 1;
      }
    }

    const trendContext = this.buildTrendContext(candle);

    // Fire anomaly signal — max once per ANOMALY_COOLDOWN_MS to avoid flooding
    if (this.candleCount >= EMA_PERIOD && this.ema > 0) {
      const deviation = (candle.close - this.ema) / this.ema;
      const cooldownExpired = candle.timestamp - this.lastAnomalyTs >= ANOMALY_COOLDOWN_MS;
      if (Math.abs(deviation) >= ANOMALY_THRESHOLD && cooldownExpired) {
        this.lastAnomalyTs = candle.timestamp;
        this.firesByKind.anomaly++;
        await this.fireAnomalyWithTimestamp(deviation, candle.timestamp, trendContext);
      }
    }

    // Primary trigger: streak_5m reaching a new higher level (>= STREAK_5M_MIN).
    // streak_1m is only entry timing confirmation — must be same direction as streak_5m.
    // Fires once per new level (3, 4, 5, 6…), resets when streak_5m direction flips.
    const streak5m    = computeStreak5m(this.candleHistory);
    const abs5m       = Math.abs(streak5m);
    const dir5m: 'up' | 'down' = streak5m >= 0 ? 'up' : 'down';
    const dirFlipped  = this.lastFired5mDir !== null && dir5m !== this.lastFired5mDir;

    if (dirFlipped) {
      this.lastFired5mLevel = 0;
      this.lastFired5mDir   = null;
    }

    const isNewLevel = abs5m >= STREAK_5M_MIN && abs5m > this.lastFired5mLevel;
    if (isNewLevel) {
      this.lastFired5mLevel = abs5m;
      this.lastFired5mDir   = dir5m;
      this.firesByKind.streak5m++;
      this.firesByLevel[abs5m] = (this.firesByLevel[abs5m] ?? 0) + 1;
      const brokeLiq = computeBrokeLiq(this.candleHistory, candle);
      await this.fireStreakWithTimestamp(this.streakCount, this.streakDir, candle, trendContext, streak5m, brokeLiq);
    }
  }

  /** Build TrendContext from rolling candle history */
  private buildTrendContext(candle: Candle): TrendContext | undefined {
    if (this.ema === 0) return undefined;

    const hist = this.candleHistory;
    const deviationFromEma = (candle.close - this.ema) / this.ema;

    // 24h change: compare to candle ~1440 minutes ago (or earliest available)
    const candle24h = hist.length >= 1440 ? hist[hist.length - 1440]! : hist[0]!;
    const change24h = (candle.close - candle24h.close) / candle24h.close;

    // 7d change: compare to candle ~10080 minutes ago (often not available early in backtest)
    const candle7d = hist.length >= 10_080 ? hist[hist.length - 10_080]! : hist[0]!;
    const change7d = (candle.close - candle7d.close) / candle7d.close;

    let trend: TrendContext['trend'];
    if (change24h > 0.01) trend = 'uptrend';
    else if (change24h < -0.01) trend = 'downtrend';
    else trend = 'sideways';

    return { trend, change24h, change7d, ema20: this.ema, deviationFromEma };
  }

  private async fireAnomalyWithTimestamp(deviation: number, timestamp: number, trendContext?: TrendContext): Promise<void> {
    const intercepted: Signal[] = [];
    const intercept = (s: Signal) => intercepted.push(s);

    this.pipeline.on('signal', intercept);
    await this.pipeline.onPriceAnomaly(deviation, trendContext);
    this.pipeline.off('signal', intercept);

    for (const signal of intercepted) {
      const fixed = { ...signal, timestamp };
      this.deferredSignals.push({ signal: fixed, firedAt: timestamp, firedClose: this.lastPrice });
    }
  }

  private async fireStreakWithTimestamp(
    streakCount: number,
    streakDir: 'up' | 'down',
    candle: Candle,
    trendContext?: TrendContext,
    streak5m?: number,
    brokeLiq?: boolean,
  ): Promise<void> {
    const intercepted: Signal[] = [];
    const intercept = (s: Signal) => intercepted.push(s);

    this.pipeline.on('signal', intercept);
    await this.pipeline.onStreak(streakCount, streakDir, candle.close, trendContext, candle.timestamp, streak5m, brokeLiq);
    this.pipeline.off('signal', intercept);

    for (const signal of intercepted) {
      const fixed = { ...signal, timestamp: candle.timestamp };
      this.deferredSignals.push({ signal: fixed, firedAt: candle.timestamp, firedClose: candle.close });
    }
  }

  /**
   * Activate any signal that was fired on the previous candle.
   *
   * Scale (streak) signals use poly mode: entry = prev 5m close (the close of the
   * fire candle, which is the last 1m of the prev 5m session), exit = close of the
   * 4th 1m candle of the applied 5m session. Aligns PnL with a 5m-chart reading.
   *
   * Non-scale signals use TP/SL with entry = current (applied) candle's open —
   * the earliest tradeable price after the signal is known.
   */
  private activateDeferred(candle: Candle): void {
    if (this.deferredSignals.length === 0) return;

    const appliedOpen = candle.open;

    for (const d of this.deferredSignals) {
      const s = d.signal;

      if (s.direction === 'HOLD') {
        this.outcomes.push({
          signal: s,
          entryPrice: appliedOpen,
          evalPrice: null,
          returnPct: null,
          outcome: 'neutral',
          exitReason: 'hold',
          pnlPct: null,
        });
        continue;
      }

      const horizon = s.horizon as Horizon;

      if (horizon === 'scale') {
        // Poly mode: entry = prev 5m close (fire-candle close); exit = close of
        // the 4th 1m candle of the applied session (3 min after applied start).
        this.pendingEvals.push({
          signal: s,
          entryPrice: d.firedClose,
          entryTimestamp: candle.timestamp,
          evalDeadline: candle.timestamp + POLY_EXIT_OFFSET_MS,
          polyMode: true,
        });
        continue;
      }

      const { tp, sl } = this.resolveTpSl(s, appliedOpen);
      const fixed: Signal = { ...s, priceTarget: tp, stopLoss: sl };

      this.pendingEvals.push({
        signal: fixed,
        entryPrice: appliedOpen,
        entryTimestamp: candle.timestamp,
        evalDeadline: candle.timestamp + this.evalWindowMs(horizon),
        polyMode: false,
        tp,
        sl,
      });
    }

    this.deferredSignals = [];
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private evalWindowMs(horizon: Horizon): number {
    switch (horizon) {
      case 'scale': return this.config.evalWindows.scale * 60_000;
      case 'short': return this.config.evalWindows.short * 60_000;
      case 'mid':   return this.config.evalWindows.mid   * 60_000;
      default:      return this.config.evalWindows.mid   * 60_000;
    }
  }

  private winThreshold(horizon: Horizon): number {
    switch (horizon) {
      case 'scale': return this.config.winThresholdPct.scale;
      case 'short': return this.config.winThresholdPct.short;
      default:      return this.config.winThresholdPct.mid;
    }
  }

  // ── DB persistence ────────────────────────────────────────────────────────

  private async persistRunToDb(dataset: HistoricalDataset): Promise<void> {
    try {
      await migrate();
      const repo = new SignalRepository();

      const fromTs = dataset.candles[0]?.timestamp ?? 0;
      const toTs   = dataset.candles[dataset.candles.length - 1]?.timestamp ?? 0;
      const from   = new Date(fromTs).toISOString().split('T')[0];
      const to     = new Date(toTs).toISOString().split('T')[0];
      const runId  = uuidv4();

      const label = this.config.runLabel
        ?? `${this.config.symbol} ${from} → ${to} (${this.config.aiModel ?? 'haiku'})`;

      await repo.saveRun({
        id: runId,
        label,
        exchange: this.config.exchangeId,
        symbol: this.config.symbol,
        fromTs,
        toTs,
        aiModel: this.config.aiModel,
        formulaConfigId: this.config.formulaConfigId,
        totalSignals: this.outcomes.length,
      });

      await repo.saveOutcomes(runId, this.outcomes);
      console.log(`[BacktestEngine] Saved run ${runId} + ${this.outcomes.length} signals to DB`);
    } catch (err) {
      console.error('[BacktestEngine] DB persist failed (non-fatal):', err);
    }
  }

  /**
   * Resolve TP and SL price levels for a signal.
   * Uses signal.priceTarget / signal.stopLoss if AI provided them,
   * otherwise falls back to DEFAULT_TP / DEFAULT_SL ratios from entry.
   */
  private resolveTpSl(signal: Signal, entry: number): { tp: number; sl: number } {
    const horizon = signal.horizon as Horizon;
    const isBuy = signal.direction === 'BUY';

    const tpRatio = DEFAULT_TP[horizon] ?? DEFAULT_TP['mid']!;
    const slRatio = DEFAULT_SL[horizon] ?? DEFAULT_SL['mid']!;

    const tp = signal.priceTarget ?? (isBuy ? entry * (1 + tpRatio) : entry * (1 - tpRatio));
    const sl = signal.stopLoss   ?? (isBuy ? entry * (1 - slRatio) : entry * (1 + slRatio));

    return { tp, sl };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Compute signed 5m streak from a rolling window of 1m candles.
 * Groups candles by 5-minute boundary (floor to 5m), then counts consecutive
 * same-direction 5m candles ending at the most recent one.
 * Returns +N = N consecutive bullish 5m candles, -N = bearish.
 */
function computeStreak5m(history: Candle[]): number {
  if (history.length < 5) return 0;

  // Group by 5m boundary
  const groups = new Map<number, Candle[]>();
  for (const c of history) {
    const key = Math.floor(c.timestamp / 300_000) * 300_000;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(c);
  }

  // Build 5m candles from COMPLETE groups only (5 candles each).
  // The current in-progress 5m bar has < 5 candles — including it causes false direction flips.
  const fiveMin = [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .filter(([, candles]) => candles.length === 5)
    .map(([, candles]) => {
      const s = [...candles].sort((a, b) => a.timestamp - b.timestamp);
      return { open: s[0]!.open, close: s[s.length - 1]!.close };
    });

  if (fiveMin.length < 2) return 0;

  const lastIsUp = fiveMin[fiveMin.length - 1]!.close >= fiveMin[fiveMin.length - 1]!.open;
  let len = 1;
  for (let i = fiveMin.length - 2; i >= 0; i--) {
    const isUp = fiveMin[i]!.close >= fiveMin[i]!.open;
    if (isUp === lastIsUp) len++;
    else break;
  }
  return lastIsUp ? len : -len;
}

/**
 * Detect whether the current candle's wick pierced a major liquidity level.
 * Levels considered:
 *   - Rolling 4h high/low (prior to current candle)
 *   - Rolling 24h high/low (prior to current candle)
 *   - Nearest round number (every $500 for BTC) within wick range
 *
 * Returns true if the candle's high OR low crossed any of these levels
 * (i.e. wick extended past prior high/low, or spanned a round number).
 */
export function computeBrokeLiq(history: Candle[], current: Candle, roundStep = 500): boolean {
  if (history.length === 0) return false;

  // Prior window excludes the current candle itself
  const prior = history[history.length - 1] === current ? history.slice(0, -1) : history;
  if (prior.length === 0) return false;

  const last4h  = prior.slice(-240);   // 240 * 1m = 4h
  const last24h = prior.slice(-1440);  // 1440 * 1m = 24h

  const hi4 = Math.max(...last4h.map(c => c.high));
  const lo4 = Math.min(...last4h.map(c => c.low));
  const hi24 = Math.max(...last24h.map(c => c.high));
  const lo24 = Math.min(...last24h.map(c => c.low));

  // Wick pierced prior high/low (including small overshoot beyond)
  if (current.high > hi4 || current.high > hi24) return true;
  if (current.low  < lo4 || current.low  < lo24) return true;

  // Round-number sweep: candle range spans a round-number level
  const nearestRoundBelow = Math.floor(current.low / roundStep) * roundStep;
  const nearestRoundAbove = Math.ceil(current.high / roundStep) * roundStep;
  // If high and low straddle at least one round level strictly inside (not equal to endpoints)
  if (nearestRoundAbove > nearestRoundBelow &&
      current.low < nearestRoundAbove && nearestRoundAbove < current.high) return true;

  return false;
}
