import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { Signal, Horizon } from '../types/signal.js';
import { NewsEvent } from '../types/news.js';
import { CVDState, Trade, OrderBookSnapshot } from '../types/market.js';
import { MMTrapResult } from '../types/mm.js';
import type { PanicSignal } from '../types/onchain.js';
import { AIService, type TrendContext } from '../services/AIService.js';
import { StatisticalSignalService } from '../services/StatisticalSignalService.js';
import { VectorStoreService } from '../services/VectorStoreService.js';
import { MMDetectorService } from '../services/MMDetectorService.js';
import { MacroEventStore } from '../services/MacroEventStore.js';
import { LagAnalyzer } from '../services/LagAnalyzer.js';
import { PanicDetector } from '../services/PanicDetector.js';
import { KnowledgeBaseEmbedder } from '../knowledge/KnowledgeBaseEmbedder.js';
import { TelegramService } from '@trading-bot/core/TelegramService';
import { SignalStore } from '../services/SignalStore.js';
import { getTracer } from '../observability/tracing.js';
import { getSignalCounter } from '../observability/metrics.js';
import { log } from '../observability/logger.js';
import { context, trace } from '@opentelemetry/api';

// Sentiment thresholds for horizon selection
const THRESHOLD_ALL_HORIZONS = 0.6;   // |sentiment| ≥ 0.6 → short + mid + long
const THRESHOLD_MID_LONG = 0.3;       // |sentiment| ≥ 0.3 → mid + long

// Default TP/SL ratios (fraction of entry) when AI omits them
const TP_RATIO: Record<string, number> = { scale: 0.003, short: 0.008, mid: 0.020, long: 0.050 };
const SL_RATIO: Record<string, number> = { scale: 0.0015, short: 0.004, mid: 0.010, long: 0.025 };

export class SignalPipeline extends EventEmitter {
  private tracer = getTracer('SignalPipeline');
  private signalCounter = getSignalCounter();
  private lagAnalyzer = new LagAnalyzer();

  // Live market state
  private currentCVDState: CVDState | null = null;
  private recentTrades: Trade[] = [];
  private lastPrice = 0;
  private lastPanicSignal: PanicSignal | null = null;
  private currentTrendContext: TrendContext | null = null;

  constructor(
    private readonly ai: { reason(input: Parameters<AIService['reason']>[0]): ReturnType<AIService['reason']> },
    private readonly vectorStore: VectorStoreService,
    private readonly mmDetector: MMDetectorService,
    private readonly telegram: TelegramService,
    private readonly signalStore?: SignalStore,
    private readonly macroStore?: MacroEventStore,
    private readonly panicDetector?: PanicDetector,
    private readonly knowledgeBase?: KnowledgeBaseEmbedder,
    private readonly statisticalAI?: StatisticalSignalService,
    private readonly knnOnly: boolean = false,
  ) {
    super();
  }

  // ── Public accessors ──────────────────────────────────────────────────────

  getLastPrice(): number { return this.lastPrice; }

  // ── Market state updaters (called by index.ts event wiring) ──────────────

  onTrade(trade: Trade): void {
    this.lastPrice = trade.price;
    this.recentTrades.push(trade);
    if (this.recentTrades.length > 300) this.recentTrades.shift();
    this.mmDetector.analyzeTrade(trade);
  }

  onCVD(state: CVDState): void {
    this.currentCVDState = state;
  }

  onOrderBook(snap: OrderBookSnapshot): void {
    this.mmDetector.analyzeOrderBook(snap, this.recentTrades);
  }

  onPanicSignal(signal: PanicSignal): void {
    this.lastPanicSignal = signal;

    // High/extreme panic → fire immediate signal without waiting for price anomaly
    if (signal.action === 'STOP_LOSS' || signal.action === 'REVERSE_SHORT' || signal.action === 'EMERGENCY_EXIT') {
      log('warn', 'Panic-triggered pipeline run', { action: signal.action, score: signal.score });
      const desc = `PANIC ALERT [${signal.level}]: ${signal.description.split('\n')[0]}`;
      void this.runPipeline(desc, 'short', `panic:${signal.timestamp}`);
    }
  }

  // ── Signal triggers ───────────────────────────────────────────────────────

  async onNewsEvent(event: NewsEvent): Promise<void> {
    const horizons = this.selectHorizons(Math.abs(event.sentiment));
    log('info', 'Processing news event', {
      id: event.id,
      sentiment: event.sentiment,
      horizons,
    });
    for (const horizon of horizons) {
      await this.runPipeline(event.headline, horizon, `news:${event.id}`);
    }
  }

  /** Called by BacktestEngine / MarketDataService with optional trend context */
  async onPriceAnomaly(deviationPct: number, trendContext?: TrendContext): Promise<void> {
    if (trendContext) this.currentTrendContext = trendContext;

    const trendLabel = trendContext
      ? ` [${trendContext.trend.toUpperCase()}, 24h: ${(trendContext.change24h * 100).toFixed(1)}%]`
      : '';
    const desc = `Price ${deviationPct >= 0 ? 'above' : 'below'} 20-EMA by ${Math.abs(deviationPct * 100).toFixed(2)}%${trendLabel} — matches historical mean-reversion patterns`;
    log('info', 'Processing price anomaly', { deviationPct, trend: trendContext?.trend });
    await this.runPipeline(desc, 'mid', `anomaly:${Date.now()}`);
  }

  /** Scale signal: fired when N consecutive candles detected in same direction */
  static readonly STREAK_5M_MIN = 4; // |streak_5m| must reach this to create a signal

  async onStreak(
    streakCount: number,
    streakDir: 'up' | 'down',
    price: number,
    trendContext?: TrendContext,
    timestamp?: number,
    streak5m?: number,
    brokeLiq?: boolean,
  ): Promise<void> {
    // Gate: streak_5m must be >= 4 to have any reversal edge
    if (streak5m !== undefined && Math.abs(streak5m) < SignalPipeline.STREAK_5M_MIN) return;

    if (trendContext) this.currentTrendContext = trendContext;
    this.lastPrice = price;

    const streak1m = streakDir === 'up' ? streakCount : -streakCount;
    const reversalDir = streakDir === 'up' ? 'SELL' : 'BUY';
    const desc = `${streakCount} consecutive ${streakDir.toUpperCase()} candles — reversal scalp signal (${reversalDir} expected)`;
    log('info', 'Processing streak signal', { streakCount, streakDir, streak5m, brokeLiq, reversalDir });
    await this.runPipeline(desc, 'scale', `streak:${Date.now()}`, timestamp, { streak1m, streak5m, brokeLiq });
  }

  // ── Core pipeline ─────────────────────────────────────────────────────────

  private async runPipeline(
    eventDescription: string,
    horizon: Horizon,
    correlationId: string,
    timestamp?: number,
    streaks?: { streak1m?: number; streak5m?: number; brokeLiq?: boolean },
  ): Promise<void> {
    const rootSpan = this.tracer.startSpan('signalPipeline', {
      attributes: {
        'pipeline.horizon': horizon,
        'pipeline.correlation_id': correlationId,
        'pipeline.event': eventDescription.slice(0, 120),
      },
    });

    await context.with(trace.setSpan(context.active(), rootSpan), async () => {
      try {
        // Step 1 — Vector Search (RAG: past signals + macro events + knowledge base)
        const vsSpan = this.tracer.startSpan('step.vectorSearch');

        // Build KB query from current market state
        const kbQuery = buildKBQuery(this.lastPrice, this.currentCVDState?.cvd ?? 0, eventDescription);

        const [similarSignals, similarMacroEvents, kbResults] = await Promise.all([
          this.vectorStore.similaritySearch(eventDescription, 5, { type: 'signal' }),
          this.macroStore?.findSimilar(eventDescription, 5) ?? [],
          this.knowledgeBase?.search(kbQuery, 5) ?? [],
        ]);

        const signalContext = similarSignals.length > 0
          ? '### Past Signal Patterns\n' +
            similarSignals.map((d, i) => `[${i + 1}] (score ${d.score.toFixed(2)}) ${d.text}`).join('\n')
          : '### Past Signal Patterns\nNo similar past signals found.';

        const macroContext = this.lagAnalyzer.summarizeForPrompt(similarMacroEvents);

        const kbContext = kbResults.length > 0
          ? '### Historically Similar Market Conditions\n' +
            kbResults.map((r, i) =>
              `[${i + 1}] (score ${r.score.toFixed(2)}, ${r.direction.toUpperCase()}) ${r.text.split('\n').slice(0, 5).join(' | ')}`
            ).join('\n')
          : '### Historically Similar Market Conditions\nKnowledge base not available.';

        const historicalContext = [signalContext, '', macroContext, '', kbContext].join('\n');
        vsSpan.end();

        // Step 2 — MM Trap Check + Panic state
        const mmSpan = this.tracer.startSpan('step.mmFilter');
        const cvdTrap: MMTrapResult = this.currentCVDState
          ? this.mmDetector.analyzeCVD(this.currentCVDState)
          : { detected: false, type: 'NONE', detail: '' };
        const mmTrapStatus = cvdTrap.detected
          ? `WARNING — ${cvdTrap.type}: ${cvdTrap.detail}`
          : 'No MM trap detected.';

        // Inject real-time panic context
        const panicContext = this.panicDetector
          ? this.panicDetector.currentSummary()
          : '## Market Stress Indicators\nNo panic detector active.';
        mmSpan.end();

        // Step 3 — Reasoning
        // Route:
        //   news: / panic:  → always Claude  (text semantics, k-NN can't help)
        //   anomaly: / streak: → k-NN first, Claude only if k-NN returns null
        const aiSpan = this.tracer.startSpan('step.aiReasoning');

        const reasonInput = {
          asset: 'BTC/USDT',
          horizon,
          price: this.lastPrice,
          cvd: this.currentCVDState?.cvd ?? 0,
          divergence: this.currentCVDState?.divergence ?? 0,
          event: eventDescription,
          historicalContext,
          mmTrapStatus,
          panicContext,
          trendContext: this.currentTrendContext ?? undefined,
          streak1m: streaks?.streak1m,
          streak5m: streaks?.streak5m,
          brokeLiq: streaks?.brokeLiq,
        };

        const isPriceAction = correlationId.startsWith('anomaly:') || correlationId.startsWith('streak:');
        const statOutput = (isPriceAction && this.statisticalAI)
          ? await this.statisticalAI.reason(reasonInput, timestamp)
          : null;

        if (statOutput) {
          log('info', '[k-NN] Signal from historical data (no Claude call)', {
            correlationId,
            direction:  statOutput.direction,
            confidence: statOutput.confidence.toFixed(3),
            rationale:  statOutput.rationale,
          });
        } else if (this.knnOnly) {
          // knn-only mode: no k-NN result → skip entirely, don't call Claude
          log('debug', '[k-NN] No neighbors found, skipping (knn-only mode)', { correlationId });
          return;
        } else {
          log('info', '[Claude] Calling AI API', {
            correlationId,
            reason: !isPriceAction ? 'news/panic event' : 'k-NN confidence too low or KB empty',
          });
        }

        const aiOutput = statOutput ?? await this.ai.reason(reasonInput);

        aiSpan.setAttribute('reasoning.engine', statOutput ? 'statistical' : 'claude');
        aiSpan.end();

        // Step 4 — Build Signal (fill default TP/SL if AI didn't provide them)
        const isBuy = aiOutput.direction === 'BUY';
        const tpRatio = TP_RATIO[horizon] ?? TP_RATIO['mid']!;
        const slRatio = SL_RATIO[horizon] ?? SL_RATIO['mid']!;
        const priceTarget = aiOutput.priceTarget
          ?? (aiOutput.direction !== 'HOLD'
              ? isBuy
                ? this.lastPrice * (1 + tpRatio)
                : this.lastPrice * (1 - tpRatio)
              : undefined);
        const stopLoss = aiOutput.stopLoss
          ?? (aiOutput.direction !== 'HOLD'
              ? isBuy
                ? this.lastPrice * (1 - slRatio)
                : this.lastPrice * (1 + slRatio)
              : undefined);

        const signal: Signal = {
          id: uuidv4(),
          timestamp: Date.now(),
          horizon,
          asset: 'BTC/USDT',
          direction: aiOutput.direction,
          confidence: aiOutput.confidence,
          priceTarget,
          stopLoss,
          rationale: aiOutput.rationale,
          mmTrapFlag: cvdTrap.detected,
          mmTrapType: cvdTrap.type,
          engine: statOutput ? 'statistical' : 'claude',
          status: aiOutput.status ?? 'auto',
        };

        // Step 5 — Persist signal to vector store (future RAG)
        const persistSpan = this.tracer.startSpan('step.vectorStore.persist');
        await this.vectorStore.addDocument({
          id: signal.id,
          text: [
            eventDescription,
            `Direction: ${signal.direction}`,
            `Horizon: ${horizon}`,
            `Confidence: ${signal.confidence}`,
            `Rationale: ${signal.rationale}`,
          ].join(' | '),
          metadata: {
            type: 'signal',
            timestamp: signal.timestamp,
            asset: signal.asset,
            horizon,
            direction: signal.direction,
          },
        });
        persistSpan.end();

        // Step 6 — Telegram Alert
        const alertSpan = this.tracer.startSpan('step.telegramAlert');
        await this.telegram.sendSignal(signal);
        alertSpan.end();

        // Persist to store (production replay / dashboard)
        this.signalStore?.append(signal, this.lastPrice);

        // Metrics
        this.signalCounter.add(1, {
          horizon,
          direction: signal.direction,
        });

        log('info', 'Signal pipeline completed', {
          signal_id: signal.id,
          horizon,
          direction: signal.direction,
          confidence: signal.confidence,
          mm_trap: signal.mmTrapFlag,
        });

        this.emit('signal', signal);
      } catch (err) {
        rootSpan.recordException(err as Error);
        const e = err as Error;
        log('error', 'Signal pipeline error — signal DROPPED', {
          correlationId,
          horizon,
          error: String(err),
          message: e?.message,
          stack: e?.stack?.split('\n').slice(0, 5).join(' | '),
        });
        this.emit('pipelineError', { correlationId, horizon, error: e });
      } finally {
        rootSpan.end();
      }
    });
  }

  private selectHorizons(absSentiment: number): Horizon[] {
    return selectHorizons(absSentiment);
  }
}

// Exported for unit testing
export function selectHorizons(absSentiment: number): Horizon[] {
  if (absSentiment >= THRESHOLD_ALL_HORIZONS) return ['short', 'mid', 'long'];
  if (absSentiment >= THRESHOLD_MID_LONG) return ['mid', 'long'];
  return ['long'];
}

/**
 * Build a query string for the knowledge base that mimics the embeddingText format.
 * Omits outcome fields since we don't know them yet.
 */
function buildKBQuery(price: number, cvd: number, eventDescription: string): string {
  return [
    `Price: $${price.toLocaleString()}`,
    `CVD proxy: ${cvd.toFixed(2)}`,
    `Event: ${eventDescription.slice(0, 200)}`,
  ].join('\n');
}
