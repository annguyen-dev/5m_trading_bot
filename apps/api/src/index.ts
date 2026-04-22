// ── Bootstrap OpenTelemetry FIRST — before any instrumented imports ──────────
import 'dotenv/config';
import { initTracing, shutdownTracing } from './observability/tracing.js';
import { initMetrics, shutdownMetrics } from './observability/metrics.js';

initTracing();
initMetrics();

// ── Service imports (after OTel is initialised) ──────────────────────────────
import { config } from './config/index.js';
import { log } from './observability/logger.js';
import { MarketDataService } from './services/MarketDataService.js';
import { NewsService } from './services/NewsService.js';
import { VectorStoreService } from './services/VectorStoreService.js';
import { MMDetectorService } from './services/MMDetectorService.js';
import { AIService } from './services/AIService.js';
import { TelegramService } from './services/TelegramService.js';
import { SignalPipeline } from './pipeline/SignalPipeline.js';
import { SignalStore } from './services/SignalStore.js';
import { PositionTracker } from './services/PositionTracker.js';
import { OrderExecutor } from './services/OrderExecutor.js';
import { StatisticalSignalService } from './services/StatisticalSignalService.js';
import { MacroEventStore } from './services/MacroEventStore.js';
import { GDELTService } from './services/GDELTService.js';
import { OnChainService } from './services/OnChainService.js';
import { PanicDetector } from './services/PanicDetector.js';
import { PolymarketService } from './services/PolymarketService.js';
import { FutureTickScanner } from './services/FutureTickScanner.js';
import { KnowledgeBaseEmbedder } from './knowledge/KnowledgeBaseEmbedder.js';
import { CVDState, Trade, OrderBookSnapshot } from './types/market.js';
import { NewsEvent } from './types/news.js';

const VIEW_ONLY = process.argv.includes('--view-only') || process.env['VIEW_ONLY'] === 'true';

async function main(): Promise<void> {
  log('info', 'Trading bot starting', {
    symbol:   config.tradingSymbol,
    exchange: config.exchangeId,
    nodeEnv:  config.nodeEnv,
    viewOnly: VIEW_ONLY,
  });
  if (VIEW_ONLY) {
    log('info', 'Running in VIEW-ONLY mode — no Telegram messages will be sent');
  }

  // ── 1. Instantiate services ───────────────────────────────────────────────
  const vectorStore = new VectorStoreService(config.lancedbPath);
  await vectorStore.init();

  const mmDetector = new MMDetectorService();
  const aiService = new AIService();
  const telegramService = new TelegramService(VIEW_ONLY);
  const marketData = new MarketDataService(config.exchangeId, config.tradingSymbol);
  const newsService = new NewsService();

  const signalStore    = new SignalStore('./data');
  const positionTracker = new PositionTracker('./data');
  const orderExecutor  = new OrderExecutor(
    config.tradingMode,
    config.exchangeId,
    config.tradingSymbol,
    config.tradeSizeUsdt,
    config.tradeLeverage,
    config.exchangeApiKey,
    config.exchangeApiSecret,
  );

  log('info', `Trading mode: ${config.tradingMode.toUpperCase()}`, {
    sizeUsdt:  config.tradeSizeUsdt,
    leverage:  config.tradeLeverage,
  });

  const macroStore     = new MacroEventStore(vectorStore);
  await macroStore.init();

  const panicDetector     = new PanicDetector();
  const gdeltService      = new GDELTService();
  const onChainService    = new OnChainService();
  const polymarketService = new PolymarketService();
  // FutureTickScanner always targets Binance USDT-M futures — use ccxt unified symbol.
  const futureTickScanner = new FutureTickScanner('BTC/USDT:USDT');

  // Knowledge base (optional — requires build:kb to have been run first)
  let knowledgeBase: KnowledgeBaseEmbedder | undefined;
  try {
    knowledgeBase = new KnowledgeBaseEmbedder('./data/lancedb_kb');
    await knowledgeBase.init();
    const kbCount = await knowledgeBase.count();
    if (kbCount === 0) {
      knowledgeBase = undefined; // empty KB — skip to avoid misleading queries
    } else {
      log('info', `Knowledge base loaded: ${kbCount} historical snapshots`);
    }
  } catch {
    log('warn', 'Knowledge base not found — run npm run build:kb to enable historical RAG');
    knowledgeBase = undefined;
  }

  const statisticalAI = new StatisticalSignalService();

  const pipeline = new SignalPipeline(
    aiService, vectorStore, mmDetector, telegramService,
    signalStore, macroStore, panicDetector, knowledgeBase,
    statisticalAI,
  );

  // ── 2. Wire event bus ─────────────────────────────────────────────────────

  // Market data → pipeline + position tracker + on-chain whale detection
  marketData.on('trade', (trade: Trade) => {
    pipeline.onTrade(trade);
    positionTracker.onPrice(trade.price, trade.timestamp);
    onChainService.onTrade(trade);
  });

  marketData.on('cvd', (state: CVDState) => {
    pipeline.onCVD(state);
  });

  marketData.on('orderbook', (snap: OrderBookSnapshot) => {
    pipeline.onOrderBook(snap);
  });

  // Price anomaly → mid-term signal
  marketData.on('anomaly', (deviationPct: number) => {
    void pipeline.onPriceAnomaly(deviationPct);
  });

  // News → pipeline + panic detector
  newsService.on('newsEvent', (event: NewsEvent) => {
    void pipeline.onNewsEvent(event);
    panicDetector.onNewsScore(event.sentiment);
  });

  // GDELT → panic detector
  gdeltService.on('gdeltEvent', evt => {
    panicDetector.onGDELTEvent(evt);
  });

  // On-chain snapshots → panic detector + CVD update
  onChainService.on('snapshot', snap => {
    panicDetector.onOnChainSnapshot(snap);
  });

  // Panic signal → pipeline (stop-loss / reversal triggers)
  panicDetector.on('panicSignal', (signal) => {
    pipeline.onPanicSignal(signal);
  });

  // Signal emitted → open position (paper or live)
  // entryPrice is tracked by the pipeline itself; we read it via a shared ref
  pipeline.on('signal', signal => {
    log('info', 'Signal emitted', { signal_id: signal.id, direction: signal.direction });
    const entryPrice = pipeline.getLastPrice();
    const pos = positionTracker.openPosition(signal, entryPrice);
    if (pos) {
      void orderExecutor.enter(signal, entryPrice);
    }
  });

  // Position closed → notify executor (handles timeout in live mode)
  positionTracker.on('closed', closed => {
    void orderExecutor.onPositionClosed(closed);

    // Log summary stats every time a position closes
    const s = positionTracker.stats();
    log('info', 'Position stats', {
      open:      s.openCount,
      closed:    s.closedCount,
      winRate:   `${(s.winRate * 100).toFixed(1)}%`,
      avgPnl:    `${(s.avgPnlPct * 100).toFixed(3)}%`,
      totalPnl:  `${(s.totalPnlPct * 100).toFixed(2)}%`,
    });
  });

  // ── 3. Start data sources ─────────────────────────────────────────────────
  await marketData.start();
  newsService.start();
  gdeltService.start();
  onChainService.start();
  await polymarketService.start();
  await futureTickScanner.start();

  log('info', 'Trading bot running — waiting for events');

  // ── 4. Graceful shutdown ──────────────────────────────────────────────────
  const shutdown = async (signal: string): Promise<void> => {
    log('info', `Received ${signal} — shutting down`);
    try {
      newsService.stop();
      gdeltService.stop();
      onChainService.stop();
      signalStore.close();
      positionTracker.close();
      await polymarketService.stop();
      await futureTickScanner.stop();
      await marketData.stop();
      await shutdownTracing();
      await shutdownMetrics();
      log('info', 'Graceful shutdown complete');
    } catch (err) {
      log('error', 'Error during shutdown', { error: String(err) });
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch(err => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
