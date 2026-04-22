/**
 * src/services/FutureTickScanner.ts
 *
 * Polls Binance USDT-M Futures BTC/USDT every 5s and records:
 *   - price (last trade price)
 *   - volume over last 5s
 *   - price change over last 5s (pct)
 *   - top-20 bid/ask depth (USD notional)
 *   - OB imbalance ∈ [-1, 1]
 *   - volume z-score vs rolling 5min (60 samples) — "vol_spike_z"
 *
 * Phase 2.A scope: data capture + spike event. No decision logic.
 *
 * Events:
 *   'tick'  (t: FutureTick)  — every 5s poll
 *   'spike' (t: FutureTick)  — when |price_change_5s| >= SPIKE_THRESHOLD
 */

import { EventEmitter } from 'events';
import * as ccxt from 'ccxt';
import type { Exchange, Trade as CcxtTrade, OrderBook } from 'ccxt';
import { getPool } from '@trading-bot/db';
import { log } from '../observability/logger.js';

const POLL_INTERVAL_MS = 5_000;
const VOL_WINDOW_SIZE  = 60;       // 60 × 5s = 5min rolling window
const SPIKE_THRESHOLD  = 0.003;    // 0.3% move in 5s triggers 'spike'
const OB_DEPTH_LEVELS  = 20;
const TRADES_FETCH_LIMIT = 500;

export interface FutureTick {
  ts:             number;   // unix ms, 5s-aligned
  price:          number;
  volume5s:       number;   // base asset (BTC)
  priceChange5s:  number;   // fraction, e.g. 0.0015 = +0.15%
  bidDepthUsd:    number;
  askDepthUsd:    number;
  obImbalance:    number;   // (bid - ask) / (bid + ask)
  volSpikeZ:      number;   // z-score vs last 5min
}

export class FutureTickScanner extends EventEmitter {
  private exchange: Exchange;
  private pool = getPool();
  private symbol: string;
  private running = false;

  private lastPrice = 0;
  private volWindow: number[] = [];

  // Default = Binance USDT-M perpetual futures (ccxt unified format "QUOTE/BASE:SETTLE")
  constructor(symbol = 'BTC/USDT:USDT') {
    super();
    // Plain REST ccxt (not pro) — separate from MarketDataService's WS conn.
    const ExchangeClass = (ccxt as unknown as Record<string, new (opts: object) => Exchange>)['binanceusdm'];
    if (!ExchangeClass) throw new Error('ccxt: binanceusdm not available');
    this.exchange = new ExchangeClass({ enableRateLimit: true });
    this.symbol = symbol;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    log('info', 'FutureTickScanner starting', { symbol: this.symbol });
    void this.loop();
  }

  async stop(): Promise<void> {
    this.running = false;
    try { await this.exchange.close(); } catch { /* ignore */ }
    log('info', 'FutureTickScanner stopped');
  }

  private async loop(): Promise<void> {
    while (this.running) {
      const t0 = Date.now();
      try {
        await this.pollOnce();
      } catch (err) {
        log('warn', 'FutureTickScanner poll error', { error: String(err) });
      }
      const dur  = Date.now() - t0;
      const wait = Math.max(100, POLL_INTERVAL_MS - dur);
      await sleep(wait);
    }
  }

  private async pollOnce(): Promise<void> {
    const now = Date.now();

    // Fetch in parallel. fetchTrades(since) returns trades at or after `since`.
    const [ob, trades] = await Promise.all([
      this.exchange.fetchOrderBook(this.symbol, OB_DEPTH_LEVELS) as Promise<OrderBook>,
      this.exchange.fetchTrades(this.symbol, now - POLL_INTERVAL_MS - 500, TRADES_FETCH_LIMIT) as Promise<CcxtTrade[]>,
    ]);

    // Last trade price (fallback to top-of-book mid if no trades)
    const price = trades.length
      ? (trades[trades.length - 1]?.price ?? 0)
      : midFromBook(ob);

    // Volume over strictly last POLL_INTERVAL_MS
    const cutoff = now - POLL_INTERVAL_MS;
    const volume5s = trades
      .filter(t => (t.timestamp ?? 0) >= cutoff)
      .reduce((s, t) => s + (t.amount ?? 0), 0);

    const priceChange5s = this.lastPrice > 0 ? (price - this.lastPrice) / this.lastPrice : 0;
    this.lastPrice = price;

    // OB depth (USD notional, top N)
    const bidDepth = depthUsd(ob.bids as Array<[number, number]>);
    const askDepth = depthUsd(ob.asks as Array<[number, number]>);
    const totalDepth = bidDepth + askDepth;
    const obImbalance = totalDepth > 0 ? (bidDepth - askDepth) / totalDepth : 0;

    // Rolling z-score BEFORE pushing current value (measure against prior 5min)
    const volSpikeZ = zScore(volume5s, this.volWindow);
    this.volWindow.push(volume5s);
    if (this.volWindow.length > VOL_WINDOW_SIZE) this.volWindow.shift();

    const ts = Math.floor(now / POLL_INTERVAL_MS) * POLL_INTERVAL_MS;
    const tick: FutureTick = {
      ts, price, volume5s, priceChange5s,
      bidDepthUsd: bidDepth,
      askDepthUsd: askDepth,
      obImbalance,
      volSpikeZ,
    };

    this.emit('tick', tick);
    if (Math.abs(priceChange5s) >= SPIKE_THRESHOLD) {
      this.emit('spike', tick);
      log('info', 'FutureTickScanner spike', {
        priceChange: `${(priceChange5s * 100).toFixed(3)}%`,
        volSpikeZ:   volSpikeZ.toFixed(2),
      });
    }

    try {
      await this.pool.query(
        `INSERT INTO future_ticks_5s
           (ts, price, volume_5s, price_change_5s,
            bid_depth_usd, ask_depth_usd, ob_imbalance, vol_spike_z)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (ts) DO NOTHING`,
        [ts, price, volume5s, priceChange5s,
         bidDepth, askDepth, obImbalance, volSpikeZ],
      );
    } catch (err) {
      log('warn', 'future_ticks_5s insert failed', { error: String(err) });
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function midFromBook(ob: OrderBook): number {
  const bestBid = (ob.bids as Array<[number, number]>)[0]?.[0] ?? 0;
  const bestAsk = (ob.asks as Array<[number, number]>)[0]?.[0] ?? 0;
  return bestBid > 0 && bestAsk > 0 ? (bestBid + bestAsk) / 2 : (bestBid || bestAsk);
}

function depthUsd(levels: Array<[number, number]>): number {
  return levels
    .slice(0, OB_DEPTH_LEVELS)
    .reduce((s, [p, sz]) => s + p * sz, 0);
}

function zScore(x: number, window: number[]): number {
  if (window.length < 3) return 0;
  const mean = window.reduce((s, v) => s + v, 0) / window.length;
  const variance = window.reduce((s, v) => s + (v - mean) ** 2, 0) / window.length;
  const std = Math.sqrt(variance);
  return std > 0 ? (x - mean) / std : 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
