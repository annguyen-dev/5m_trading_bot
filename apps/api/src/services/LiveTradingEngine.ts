/**
 * src/services/LiveTradingEngine.ts
 *
 * Single owner of all live data sources for the Polymarket Live page.
 * Holds in-memory snapshot state + emits a unified event stream consumed by
 * the SSE broadcaster.
 *
 * Owns:
 *   - PolymarketService    (CLOB WS for share prices, Gamma REST for markets)
 *   - FutureTickScanner    (Binance 5s polling — vol_spike_z, OB imbalance)
 *   - BinanceFastTicker    (Binance WS, sub-second BTC last-trade)
 *
 * Future scope (Phase 2.B-2 / 2.B-3):
 *   - Auto-compute PolySignal on a throttled cadence
 *   - Auto-place sim orders when signal triggers + EV > threshold
 *
 * Phase 2.B-1 (this file): pure data orchestration + event broadcast.
 *
 * Emits:
 *   'btc'      ({ price, ts }) — every Binance tick
 *   'share'    ({ tokenId, conditionId, bestBid, bestAsk, lastPrice, ts }) — every PM tick
 *   'market'   (PolyClobMarket) — when current market rolls over
 *   'scan5s'   (FutureTick) — every 5s scanner output
 *   'spike'    (FutureTick) — volatility spike
 *   'order'    (orderRow) — when an order is recorded
 */

import { EventEmitter } from 'events';
import { PolymarketService, type PolyClobMarket, type ShareTick } from '@trading-bot/core/PolymarketService';
import { FutureTickScanner, type FutureTick } from './FutureTickScanner.js';
import { BinanceFastTicker, type FastTick } from './BinanceFastTicker.js';
import { log } from '../observability/logger.js';

export interface ShareSnapshot {
  bestBid:   number | null;
  bestAsk:   number | null;
  lastPrice: number | null;
  ts:        number;
}

export interface EngineSnapshot {
  currentMarket:  PolyClobMarket | null;
  upcoming:       PolyClobMarket[];
  shares:         Record<string, ShareSnapshot>;       // keyed by token_id
  btc:            { price: number; ts: number } | null;
  scan:           FutureTick | null;
  /** Most recent streak-based signal (null if none emitted yet this window). */
  lastSignal:     unknown | null;
  connected: {
    polymarket: boolean;
    binanceWs:  boolean;
  };
}

// How often to re-evaluate which market is "current" (window roll-over check).
// Independent of PolymarketService.discoveryLoop (which runs every 60s).
const REFRESH_TICK_MS = 5_000;

export class LiveTradingEngine extends EventEmitter {
  private currentMarket: PolyClobMarket | null = null;
  private upcoming:      PolyClobMarket[]      = [];
  private shares = new Map<string, ShareSnapshot>();
  private btc:  { price: number; ts: number } | null = null;
  private scan: FutureTick | null = null;
  private lastSignal: unknown | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly poly:    PolymarketService,
    private readonly scanner: FutureTickScanner,
    private readonly fast:    BinanceFastTicker,
  ) {
    super();
    this.wire();
  }

  async start(): Promise<void> {
    log('info', 'LiveTradingEngine starting');
    await this.poly.start();
    await this.scanner.start();
    await this.fast.start();
    // Tick every 5s so that when a 5m window ends, FE switches to the new
    // current market within ≤ 5s (without waiting on the 60s discovery loop).
    this.refreshTimer = setInterval(() => this.refreshCurrent(), REFRESH_TICK_MS);
  }

  async stop(): Promise<void> {
    log('info', 'LiveTradingEngine stopping');
    if (this.refreshTimer) { clearInterval(this.refreshTimer); this.refreshTimer = null; }
    await Promise.allSettled([this.poly.stop(), this.scanner.stop(), this.fast.stop()]);
  }

  /** Snapshot for new SSE clients to render before any new ticks arrive. */
  snapshot(): EngineSnapshot {
    return {
      currentMarket: this.currentMarket,
      upcoming:      [...this.upcoming],
      shares:        Object.fromEntries(this.shares),
      btc:           this.btc,
      scan:          this.scan,
      lastSignal:    this.lastSignal,
      connected: {
        polymarket: this.poly.isConnected(),
        binanceWs:  this.fast.isConnected(),
      },
    };
  }

  private wire(): void {
    // ── Polymarket: market + share ticks ───────────────────────────────────
    this.poly.on('market', (m: PolyClobMarket) => {
      // Track upcoming list (engine's view); current = first whose window contains now.
      const exists = this.upcoming.some(x => x.conditionId === m.conditionId);
      if (!exists) this.upcoming = [...this.upcoming, m].sort((a, b) => a.windowStart - b.windowStart);
      this.refreshCurrent();
      this.emit('market', m);
    });

    this.poly.on('share_tick', (t: ShareTick) => {
      const prev = this.shares.get(t.tokenId);
      const updated: ShareSnapshot = {
        bestBid:   t.bestBid   ?? prev?.bestBid   ?? null,
        bestAsk:   t.bestAsk   ?? prev?.bestAsk   ?? null,
        lastPrice: t.lastPrice ?? prev?.lastPrice ?? null,
        ts:        t.ts,
      };
      this.shares.set(t.tokenId, updated);
      this.emit('share', { tokenId: t.tokenId, conditionId: t.conditionId, ...updated });
    });

    // ── Binance fast ticker: per-trade BTC price ───────────────────────────
    this.fast.on('tick', (t: FastTick) => {
      this.btc = { price: t.price, ts: t.ts };
      this.emit('btc', this.btc);
    });

    // ── Binance 5s scanner: aggregated metrics ─────────────────────────────
    this.scanner.on('tick', (t: FutureTick) => {
      this.scan = t;
      this.emit('scan5s', t);
    });
    this.scanner.on('spike', (t: FutureTick) => this.emit('spike', t));
  }

  /**
   * Re-pick the "current" market from the upcoming list. Called when new
   * markets are discovered and on a periodic timer (window roll-over).
   */
  private refreshCurrent(): void {
    const now = Date.now();
    // Drop markets whose window ended > 1min ago
    this.upcoming = this.upcoming.filter(m => m.windowEnd > now - 60_000);
    const cur = this.upcoming.find(m => m.windowStart <= now && m.windowEnd >= now) ?? null;
    if (cur?.conditionId !== this.currentMarket?.conditionId) {
      this.currentMarket = cur;
      // Emit a synthetic 'current' event so subscribers know the active market changed
      this.emit('current', cur);
    }
  }

  /**
   * External hook for the API layer to record a manually-placed order so the
   * UI can broadcast it instantly (instead of waiting for FE to repoll /orders).
   */
  publishOrder(order: unknown): void {
    this.emit('order', order);
  }

  /**
   * Called by StreakSignalEngine before it emits 'signal' so the snapshot
   * includes the latest signal for new SSE subscribers.
   */
  setLastSignal(signal: unknown): void {
    this.lastSignal = signal;
  }
}
