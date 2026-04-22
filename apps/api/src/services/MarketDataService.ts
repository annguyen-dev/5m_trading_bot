import { EventEmitter } from 'events';
import { pro, Exchange } from 'ccxt';
import { Trade, Candle, OrderBookSnapshot, CVDState } from '../types/market.js';
import { getTracer } from '../observability/tracing.js';
import { log } from '../observability/logger.js';

const CVD_WINDOW = 200;    // trades to keep for CVD rolling window
const EMA_PERIOD = 20;     // candles for EMA anomaly detection
const ANOMALY_THRESHOLD = 0.02; // 2% deviation from EMA triggers anomaly

export interface MarketDataEvents {
  trade: (trade: Trade) => void;
  orderbook: (snap: OrderBookSnapshot) => void;
  candle: (candle: Candle) => void;
  cvd: (state: CVDState) => void;
  anomaly: (priceChangePct: number) => void;
}

export class MarketDataService extends EventEmitter {
  private exchange: Exchange;
  private symbol: string;
  private tracer = getTracer('MarketDataService');

  // CVD state
  private cvd = 0;
  private cvdWindow: Trade[] = [];

  // Candle / EMA state
  private candles: Candle[] = [];
  private ema = 0;
  private lastPrice = 0;

  private running = false;

  constructor(exchangeId: string, symbol: string) {
    super();
    // ccxt.pro exchanges are keyed by id in the pro namespace object
    const ExchangeClass = (pro as Record<string, new (opts: object) => Exchange>)[exchangeId];
    if (!ExchangeClass) throw new Error(`ccxt.pro does not support exchange: ${exchangeId}`);
    this.exchange = new ExchangeClass({ enableRateLimit: true });
    this.symbol = symbol;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    log('info', 'MarketDataService starting', { symbol: this.symbol });

    // Run three WS loops concurrently — each reconnects automatically on error
    void this.watchTrades();
    void this.watchOrderBook();
    void this.watchOHLCV();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.exchange.close();
    log('info', 'MarketDataService stopped');
  }

  // ── Trades + CVD ──────────────────────────────────────────────────────────

  private async watchTrades(): Promise<void> {
    while (this.running) {
      try {
        const raw = await this.exchange.watchTrades(this.symbol);
        for (const t of raw) {
          const trade: Trade = {
            id: String(t.id ?? `${t.timestamp}-${Math.random()}`),
            timestamp: t.timestamp ?? Date.now(),
            price: t.price ?? 0,
            amount: t.amount ?? 0,
            side: t.side as 'buy' | 'sell',
          };
          this.updateCVD(trade);
          this.lastPrice = trade.price;
          this.emit('trade', trade);
        }
      } catch (err) {
        if (!this.running) break;
        log('warn', 'watchTrades error — reconnecting', { error: String(err) });
        await sleep(2000);
      }
    }
  }

  private updateCVD(trade: Trade): void {
    const delta = trade.side === 'buy' ? trade.amount : -trade.amount;
    this.cvd += delta;

    this.cvdWindow.push(trade);
    if (this.cvdWindow.length > CVD_WINDOW) this.cvdWindow.shift();

    // Compute divergence: normalised difference between price dir and CVD dir
    // over the rolling window
    const divergence = this.computeDivergence();

    const state: CVDState = {
      cvd: this.cvd,
      price: trade.price,
      divergence,
      windowTrades: [...this.cvdWindow],
    };
    this.emit('cvd', state);
  }

  private computeDivergence(): number {
    if (this.cvdWindow.length < 2) return 0;
    const first = this.cvdWindow[0];
    const last = this.cvdWindow[this.cvdWindow.length - 1];

    const priceChange = (last.price - first.price) / first.price;
    // CVD delta direction over window
    const buyVol = this.cvdWindow
      .filter(t => t.side === 'buy')
      .reduce((s, t) => s + t.amount, 0);
    const sellVol = this.cvdWindow
      .filter(t => t.side === 'sell')
      .reduce((s, t) => s + t.amount, 0);
    const totalVol = buyVol + sellVol;
    const cvdDirection = totalVol === 0 ? 0 : (buyVol - sellVol) / totalVol;

    // Divergence: opposite signs = divergence, same sign = confirmation
    return priceChange - cvdDirection; // positive = bullish divergence, negative = bearish
  }

  // ── Order Book ────────────────────────────────────────────────────────────

  private async watchOrderBook(): Promise<void> {
    while (this.running) {
      try {
        const ob = await this.exchange.watchOrderBook(this.symbol, 50);
        const snap: OrderBookSnapshot = {
          timestamp: ob.timestamp ?? Date.now(),
          bids: (ob.bids as [number, number][]).slice(0, 50),
          asks: (ob.asks as [number, number][]).slice(0, 50),
        };
        this.emit('orderbook', snap);
      } catch (err) {
        if (!this.running) break;
        log('warn', 'watchOrderBook error — reconnecting', { error: String(err) });
        await sleep(2000);
      }
    }
  }

  // ── OHLCV + EMA Anomaly ───────────────────────────────────────────────────

  private async watchOHLCV(): Promise<void> {
    while (this.running) {
      try {
        const raw = await this.exchange.watchOHLCV(this.symbol, '1m');
        for (const c of raw) {
          const candle: Candle = {
            timestamp: c[0] ?? Date.now(),
            open: c[1] ?? 0,
            high: c[2] ?? 0,
            low: c[3] ?? 0,
            close: c[4] ?? 0,
            volume: c[5] ?? 0,
          };
          this.emit('candle', candle);
          this.updateEMA(candle);
        }
      } catch (err) {
        if (!this.running) break;
        log('warn', 'watchOHLCV error — reconnecting', { error: String(err) });
        await sleep(2000);
      }
    }
  }

  private updateEMA(candle: Candle): void {
    const k = 2 / (EMA_PERIOD + 1);
    if (this.ema === 0) {
      this.ema = candle.close;
    } else {
      this.ema = candle.close * k + this.ema * (1 - k);
    }

    this.candles.push(candle);
    if (this.candles.length > EMA_PERIOD * 3) this.candles.shift();

    if (this.ema > 0 && this.candles.length >= EMA_PERIOD) {
      const deviation = (candle.close - this.ema) / this.ema;
      if (Math.abs(deviation) >= ANOMALY_THRESHOLD) {
        log('info', 'Price anomaly detected', {
          deviation: deviation.toFixed(4),
          price: candle.close,
          ema: this.ema.toFixed(2),
        });
        this.emit('anomaly', deviation);
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
