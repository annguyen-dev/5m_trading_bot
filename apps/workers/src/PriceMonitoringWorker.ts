/**
 * src/services/PriceMonitoringWorker.ts
 *
 * Single background worker supervising N PolymarketService instances (one
 * per enabled coin). Runs a 5-second tick; on each tick it decides, per coin,
 * which phase event to emit for the current window:
 *
 *   T+4m   — signal only (streak + direction + price) via Redis
 *   T-30s  — order placement (if config.mode = 'signal_and_order')
 *   T-0    — window close confirmation with outcome + PnL
 *
 * The worker DOES NOT talk to FE or Telegram directly. It publishes events on
 * SignalBus (Redis pub/sub); the API server subscribes and fans out.
 *
 * Simplest "streak" strategy for now. Uses Binance spot klines (hit the same
 * REST endpoint as StreakSignalEngine did) — we don't need per-coin Binance
 * connections because streak computation only needs closed candles.
 */

import { log } from '@trading-bot/core/logger';
import type {
  SignalBus, SignalT0PlusEvent, SignalT4Event, SignalTMinus30Event,
  SignalT0Event, VolumeBucket, OrderRef,
} from '@trading-bot/core/SignalBus';
import { PolymarketService, type PolyClobMarket } from '@trading-bot/core/PolymarketService';
import {
  getEnabledCoins, getCoinConfig,
  type CoinSymbol, type CoinConfig,
} from '@trading-bot/core/CoinConfig';
import { recordOrder, hasAutoOrderFor } from '@trading-bot/core/orderPlacement';
import { getClobExecutor } from '@trading-bot/core/PolymarketClobExecutor';
import { getPool } from '@trading-bot/db';

const TICK_MS    = 5_000;
const WINDOW_MS  = 300_000;

// Phase slots. Each must be ≥ TICK_MS wide so ticks are guaranteed to land
// in them. Dedup keys ensure each phase fires at most once per window.
//
//   T+0      → window-start: notify if there's an active order targeting N
//   T+4      → emit signal (bet will be placed for window N+1 at T-30s)
//   T-30s    → place auto order for window N+1 (contrarian to streak)
//   T-0      → window N close: if active order, report PnL & maybe DCA;
//              if no active order + current reversed, cancel N+1 outgoing.
const T_PLUS_0_END_MS = 5_000;   // T+0 phase = first tick of window
const T_PLUS_4_MS     = 240_000; // T+4m
const T_MINUS_30_MS   = 270_000; // T+4:30 = T_close - 30s
const T_MINUS_0_MS    = 295_000; // T+4:55 — wide enough that a 5s tick always lands inside

/** Binance kline symbol per coin. HYPE is absent here on purpose — it's not
 *  reliably listed on Binance spot, so we route it to Pyth below. */
const BINANCE_SYMBOL: Partial<Record<CoinSymbol, string>> = {
  BTC:  'BTCUSDT',
  ETH:  'ETHUSDT',
  SOL:  'SOLUSDT',
  XRP:  'XRPUSDT',
  DOGE: 'DOGEUSDT',
  BNB:  'BNBUSDT',
};

/** Pyth TradingView ticker per coin (fallback for coins not on Binance). */
const PYTH_SYMBOL: Partial<Record<CoinSymbol, string>> = {
  HYPE: 'Crypto.HYPE/USD',
};

interface CoinState {
  symbol:  CoinSymbol;
  poly:    PolymarketService;
  /** Window-bucketed dedup set for phases already emitted. Key = `${windowStart}:${phase}`. */
  emitted: Set<string>;
  /** Cached signal from T+4 for use at T-30s. */
  lastT4?: SignalT4Event;
}

export class PriceMonitoringWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private coins = new Map<CoinSymbol, CoinState>();

  constructor(
    private readonly bus: SignalBus,
  ) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    log('info', 'PriceMonitoringWorker starting');

    await this.syncCoins();
    if (this.coins.size === 0) {
      log('warn', 'PriceMonitoringWorker: no enabled coins — idle (will pick up when enabled via /coins)');
    }

    this.timer = setInterval(() => void this.tick(), TICK_MS);
    void this.tick();
  }

  /**
   * Reconcile tracked coins against current enabled list. Called every tick
   * so enabling/disabling a coin via /api/coin-configs takes effect within
   * one TICK_MS without a backend restart.
   */
  private async syncCoins(): Promise<void> {
    try {
      const enabled = new Set(await getEnabledCoins());
      for (const sym of enabled) {
        if (!this.coins.has(sym)) await this.addCoin(sym);
      }
      for (const [sym, st] of this.coins.entries()) {
        if (!enabled.has(sym)) {
          try { await st.poly.stop(); } catch { /* ignore */ }
          this.coins.delete(sym);
          log('info', `PriceMonitoringWorker: dropped ${sym} (disabled)`);
        }
      }
    } catch (err) {
      log('warn', 'PriceMonitoringWorker syncCoins failed', { error: String(err) });
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    for (const st of this.coins.values()) {
      try { await st.poly.stop(); } catch { /* ignore */ }
    }
    this.coins.clear();
    log('info', 'PriceMonitoringWorker stopped');
  }

  private async addCoin(symbol: CoinSymbol): Promise<void> {
    const poly = new PolymarketService(symbol);
    // For BTC we share the LiveTradingEngine's PolymarketService (which is
    // already feeding share-tick events to the shared snapshot). To keep
    // things simple for now, each coin gets its own instance, but BTC's
    // snapshot stays in sync with LiveTradingEngine through the shared DB.
    // ETH/SOL/XRP/DOGE: standalone subscription, results stored in poly
    // instance's own in-memory cache via its emit events.
    // TODO: unify orderbook state across worker + live engine when we add
    // multi-coin snapshot support to LiveTradingEngine.
    await poly.start();
    this.coins.set(symbol, { symbol, poly, emitted: new Set() });
    log('info', `PriceMonitoringWorker: tracking ${symbol}`);
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    await this.syncCoins();
    const now = Date.now();
    const windowStart = Math.floor(now / WINDOW_MS) * WINDOW_MS;
    const windowEnd   = windowStart + WINDOW_MS;
    const msFromStart = now - windowStart;

    for (const state of this.coins.values()) {
      try {
        const cfg = await getCoinConfig(state.symbol);
        if (!cfg.enabled) continue;

        // Clean old dedup keys (window bucket changed)
        this.pruneEmitted(state, windowStart);

        if (msFromStart < T_PLUS_0_END_MS) {
          await this.phaseT0Plus(state, cfg, windowStart, windowEnd);
        } else if (msFromStart >= T_PLUS_4_MS && msFromStart < T_MINUS_30_MS) {
          await this.phaseT4(state, cfg, windowStart, windowEnd);
        } else if (msFromStart >= T_MINUS_30_MS && msFromStart < T_MINUS_0_MS) {
          await this.phaseTMinus30(state, cfg, windowStart, windowEnd);
        } else if (msFromStart >= T_MINUS_0_MS) {
          await this.phaseT0(state, cfg, windowStart, windowEnd);
        }
      } catch (err) {
        log('warn', `PriceMonitoringWorker tick ${state.symbol} failed`, { error: String(err) });
      }
    }
  }

  private pruneEmitted(state: CoinState, windowStart: number): void {
    // Drop any keys from prior windows — they can't collide with current.
    const keep = Array.from(state.emitted).filter(k => k.startsWith(`${windowStart}:`));
    state.emitted = new Set(keep);
  }

  // ── Phase handlers ────────────────────────────────────────────────────────

  private async phaseT4(
    state: CoinState, cfg: CoinConfig, windowStart: number, windowEnd: number,
  ): Promise<void> {
    const key = `${windowStart}:T+4`;
    if (state.emitted.has(key)) return;

    // Compute streak + per-candle volume buckets
    const { streak, volumeBuckets } = await fetchStreakWithVolume(state.symbol, windowStart);
    if (Math.abs(streak) < cfg.streak_min) {
      state.emitted.add(key);   // ensure we don't re-check this window
      return;
    }

    // Target the CURRENT window (Polymarket market that's now live)
    const market = await state.poly.findMarketAt(Math.floor(windowStart / 1000));
    if (!market) {
      log('warn', `PriceMonitoringWorker T+4: no market for ${state.symbol} @ ${windowStart}`);
      state.emitted.add(key);
      return;
    }

    const direction: 'up' | 'down' = streak > 0 ? 'down' : 'up';      // contrarian
    const tokenId = direction === 'up' ? market.tokenUp : market.tokenDown;
    const [book, currentIcon] = await Promise.all([
      state.poly.getOrderBook(tokenId),
      fetchInProgressIcon(state.symbol, windowStart),
    ]);
    const price = bestAskFromBook(book);

    // Gate: in-progress candle must match streak direction (momentum
    // confirmation). If current is flipped or unknown (⚪), skip emission —
    // we don't want to signal against an in-progress reversal.
    const expectedIcon = streak > 0 ? '🟢' : '🔴';
    if (currentIcon !== expectedIcon) {
      state.emitted.add(key);
      log('info', `PriceMonitoringWorker T+4 skip ${state.symbol}`, {
        streak, currentIcon, expectedIcon, reason: 'current_not_matching_streak',
      });
      return;
    }

    const ev: SignalT4Event = {
      type:          'T+4',
      coin:          state.symbol,
      windowStart, windowEnd,
      streak, direction, price,
      sizeUsdc:      cfg.size_usdc,
      mode:          cfg.mode,
      pastStreakIcons: iconsFromStreak(streak),
      currentIcon,
      streakVolumeBuckets: volumeBuckets,
      limitCents:    cfg.limit_price_cents,
      emittedAt:     Date.now(),
    };

    await this.bus.publish(ev);
    state.lastT4 = ev;
    state.emitted.add(key);
    log('info', `PriceMonitoringWorker T+4 ${state.symbol}`, {
      streak, direction, price, mode: cfg.mode,
    });
  }

  private async phaseTMinus30(
    state: CoinState, cfg: CoinConfig, windowStart: number, windowEnd: number,
  ): Promise<void> {
    const key = `${windowStart}:T-30s`;
    if (state.emitted.has(key)) return;

    const t4 = state.lastT4;
    if (!t4 || t4.windowStart !== windowStart) {
      // No signal emitted at T+4 for this window → nothing to do
      state.emitted.add(key);
      return;
    }

    // signal_only mode — just emit the event, no order
    if (cfg.mode === 'signal_only') {
      await this.bus.publish<SignalTMinus30Event>({
        type: 'T-30s', coin: state.symbol,
        windowStart, windowEnd,
        action: 'signal_only_mode', emittedAt: Date.now(),
      });
      state.emitted.add(key);
      return;
    }

    // Re-check current candle at decision time (30s elapsed since T+4 —
    // candle may have flipped). Same gate as T+4.
    const currentIcon = await fetchInProgressIcon(state.symbol, windowStart);
    const expectedIcon = t4.streak > 0 ? '🟢' : '🔴';
    if (currentIcon !== expectedIcon) {
      await this.bus.publish<SignalTMinus30Event>({
        type: 'T-30s', coin: state.symbol,
        windowStart, windowEnd,
        action: 'order_skipped',
        reason: `current flipped to ${currentIcon} (streak ${expectedIcon})`,
        emittedAt: Date.now(),
      });
      state.emitted.add(key);
      return;
    }

    const absStreak = Math.abs(t4.streak);
    // Effective streak = closed streak + 1 (in-progress candle counted
    // because it's confirmed same direction at this moment). This is what
    // auto_order_min_streak compares against.
    const effectiveStreak = absStreak + 1;
    const sizeUsdc: number = cfg.size_usdc;
    const signalPath: 'boundary' | 'dca' = 'boundary';

    // ── 2-tier threshold gate ───────────────────────────────────────────────
    // Uses effectiveStreak = closed + 1 (current same-dir candle).
    if (effectiveStreak < cfg.auto_order_min_streak) {
      await this.bus.publish<SignalTMinus30Event>({
        type: 'T-30s', coin: state.symbol,
        windowStart, windowEnd,
        action: 'order_skipped',
        reason: `effective streak ${effectiveStreak} (closed ${absStreak}+1 current) < auto_min ${cfg.auto_order_min_streak}`,
        emittedAt: Date.now(),
      });
      state.emitted.add(key);
      return;
    }

    // Order targets the NEXT window (N+1) — we pre-position at boundary,
    // betting contrarian on the streak. Window N is still playing out.
    const nextWindowStartMs = windowStart + WINDOW_MS;
    const market = await state.poly.findMarketAt(Math.floor(nextWindowStartMs / 1000));
    if (!market) {
      state.emitted.add(key);
      return;
    }
    if (await hasAutoOrderFor(market.conditionId, signalPath)) {
      state.emitted.add(key);
      return;
    }
    const tokenId = t4.direction === 'up' ? market.tokenUp : market.tokenDown;
    const book = await state.poly.getOrderBook(tokenId);
    const ask = bestAskFromBook(book);
    if (ask == null || ask * 100 > cfg.limit_price_cents) {
      await this.bus.publish<SignalTMinus30Event>({
        type: 'T-30s', coin: state.symbol,
        windowStart, windowEnd,
        action: 'order_skipped',
        reason: ask == null ? 'no valid ask' : `ask ${(ask * 100).toFixed(1)}¢ > limit ${cfg.limit_price_cents}¢`,
        signalPath,
        emittedAt: Date.now(),
      });
      state.emitted.add(key);
      return;
    }

    try {
      const r = await recordOrder({
        conditionId: market.conditionId,
        direction:   t4.direction,
        sharePrice:  ask,
        sizeUsdc,
        source:      'auto',
        signalPath,
        tpCents:     cfg.tp_cents,
        slCents:     cfg.sl_cents,
      });
      await this.bus.publish<SignalTMinus30Event>({
        type: 'T-30s', coin: state.symbol,
        windowStart, windowEnd,
        action: 'order_placed',
        orderId:   r.id,
        direction: t4.direction,
        price:     ask,
        sizeUsdc,
        signalPath,
        emittedAt: Date.now(),
      });
      // (T-0 of N+1 will look up this order via DB query — no in-memory
      // context needed. T+0 of N+1 will announce it as "active".)
    } catch (err) {
      await this.bus.publish<SignalTMinus30Event>({
        type: 'T-30s', coin: state.symbol,
        windowStart, windowEnd,
        action: 'order_skipped',
        reason: err instanceof Error ? err.message : String(err),
        signalPath,
        emittedAt: Date.now(),
      });
    }
    state.emitted.add(key);
  }

  /**
   * T+0 — start of window N. Notifies (Telegram + UI) when there's an active
   * (pending) auto order targeting N (placed at T-30s of N-1). Skips silently
   * when no such order exists.
   */
  private async phaseT0Plus(
    state: CoinState, _cfg: CoinConfig, windowStart: number, windowEnd: number,
  ): Promise<void> {
    const key = `${windowStart}:T+0`;
    if (state.emitted.has(key)) return;
    state.emitted.add(key);

    const market = await state.poly.findMarketAt(Math.floor(windowStart / 1000));
    if (!market) return;
    const order = await fetchAutoOrderRef(market.conditionId, 'pending');
    if (!order) return;   // no active order → silent

    await this.bus.publish<SignalT0PlusEvent>({
      type: 'T+0', coin: state.symbol,
      windowStart, windowEnd,
      order,
      emittedAt: Date.now(),
    });
    log('info', `PriceMonitoringWorker T+0 ${state.symbol}`, {
      orderId: order.orderId, direction: order.direction,
      entryPrice: order.entryPrice, sizeUsdc: order.sizeUsdc,
    });
  }

  /**
   * T-0 — end of window N. Two paths, both conditional (no spam):
   *   (A) Active order resolves at N → emit PnL; if lost, place DCA for N+1
   *       with 1.5× the loser's size (different signal_path so it coexists
   *       with any boundary order placed at this window's T-30s).
   *   (B) No active order BUT current candle reversed (N's outcome opposes
   *       streak from this window's T+4) → cancel the N+1 outgoing order
   *       placed at T-30s of N (its premise is invalidated).
   * Otherwise: nothing happens, no message sent.
   */
  private async phaseT0(
    state: CoinState, cfg: CoinConfig, windowStart: number, windowEnd: number,
  ): Promise<void> {
    const key = `${windowStart}:T-0`;
    if (state.emitted.has(key)) return;
    state.emitted.add(key);

    const outcome = await fetchWindowOutcome(state.symbol, windowStart, windowEnd);

    // Find incoming order — placed at N-1's T-30s, market_id = N's conditionId.
    const incomingMarket = await state.poly.findMarketAt(Math.floor(windowStart / 1000));
    const incoming = incomingMarket
      ? await fetchAutoOrderRef(incomingMarket.conditionId)
      : null;

    // ── Path A — active order resolves at N ───────────────────────────────
    if (incoming) {
      const pnl = computeOrderPnl(incoming, outcome);
      let dcaRef: OrderRef | undefined;
      if (pnl && pnl.pnlUsdc < 0) {
        // Loss → place DCA for N+1 with 1.5× the loser's size.
        const nextMarket = await state.poly.findMarketAt(
          Math.floor((windowStart + WINDOW_MS) / 1000),
        );
        if (nextMarket) {
          const dcaSize = incoming.sizeUsdc * 1.5;
          dcaRef = (await this.placeDcaForNextWindow(
            state, cfg, nextMarket, incoming.direction, dcaSize,
          )) ?? undefined;
        }
      }

      await this.bus.publish<SignalT0Event>({
        type: 'T-0', coin: state.symbol,
        windowStart, windowEnd,
        outcome,
        order: {
          ...incoming,
          pnlUsdc:   pnl?.pnlUsdc   ?? 0,
          exitPrice: pnl?.exitPrice ?? 0,
        },
        ...(dcaRef ? { dca: dcaRef } : {}),
        emittedAt: Date.now(),
      });
      log('info', `PriceMonitoringWorker T-0 (active) ${state.symbol}`, {
        outcome, pnl: pnl?.pnlUsdc, dcaPlaced: !!dcaRef,
      });
      return;
    }

    // ── Path B — no incoming, current candle reversed → cancel N+1 ────────
    const t4 = state.lastT4;
    if (t4 && t4.windowStart === windowStart && outcome !== 'unknown') {
      const streakSign  = Math.sign(t4.streak);
      const outcomeSign = outcome === 'up' ? 1 : -1;
      if (streakSign !== 0 && outcomeSign !== streakSign) {
        const nextMarket = await state.poly.findMarketAt(
          Math.floor((windowStart + WINDOW_MS) / 1000),
        );
        if (nextMarket) {
          const cancelled = await this.cancelPendingAutoOrderForMarket(
            state, nextMarket.conditionId, 'cancelled_reversal',
          );
          if (cancelled) {
            await this.bus.publish<SignalT0Event>({
              type: 'T-0', coin: state.symbol,
              windowStart, windowEnd,
              outcome,
              cancelled,
              emittedAt: Date.now(),
            });
            log('info', `PriceMonitoringWorker T-0 (cancel) ${state.symbol}`, {
              orderId: cancelled.orderId, pnl: cancelled.pnlUsdc,
            });
            return;
          }
        }
      }
    }

    // Nothing actionable — silent (avoid notification spam)
    log('info', `PriceMonitoringWorker T-0 silent ${state.symbol}`, { outcome });
  }

  /**
   * Place a DCA order for the given market. Caller decides direction + size
   * (typically same direction as the loser, 1.5× its size). Skips if a DCA
   * already exists or if ask exceeds the coin's limit_price_cents.
   */
  private async placeDcaForNextWindow(
    state: CoinState, cfg: CoinConfig, market: PolyClobMarket,
    direction: 'up' | 'down', sizeUsdc: number,
  ): Promise<OrderRef | null> {
    if (await hasAutoOrderFor(market.conditionId, 'dca')) return null;
    const tokenId = direction === 'up' ? market.tokenUp : market.tokenDown;
    const book = await state.poly.getOrderBook(tokenId);
    const ask = bestAskFromBook(book);
    if (ask == null) {
      log('info', `DCA skipped — no ask`, { symbol: state.symbol });
      return null;
    }
    if (ask * 100 > cfg.limit_price_cents) {
      log('info', `DCA skipped — ask above limit`, {
        symbol: state.symbol,
        ask: (ask * 100).toFixed(1), limit: cfg.limit_price_cents,
      });
      return null;
    }
    try {
      const r = await recordOrder({
        conditionId: market.conditionId,
        direction,
        sharePrice:  ask,
        sizeUsdc,
        source:      'auto',
        signalPath:  'dca',
        tpCents:     cfg.tp_cents,
        slCents:     cfg.sl_cents,
      });
      log('info', `DCA placed ${state.symbol}`, {
        orderId: r.id, direction, sizeUsdc, ask: (ask * 100).toFixed(1),
      });
      return {
        orderId:    r.id,
        direction,
        entryPrice: ask,
        sizeUsdc,
        signalPath: 'dca',
      };
    } catch (err) {
      log('warn', 'DCA placement failed', {
        symbol: state.symbol,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Close the pending auto BUY order for the given market — used for the
   * "current candle reversed" cancel at T-0 of N. Mirrors OrderResolver's
   * close pattern (live = CLOB market sell, simulate = DB only). Returns
   * realized PnL (negative if cancelling at a worse bid than entry).
   */
  private async cancelPendingAutoOrderForMarket(
    state: CoinState, conditionId: string, closeReason: string,
  ): Promise<(OrderRef & { pnlUsdc: number; exitPrice: number }) | null> {
    const pool = getPool();
    const { rows } = await pool.query<{
      id:          string;
      direction:   'up' | 'down';
      share_price: number;
      size_usdc:   number;
      mode:        'simulate' | 'live';
      source:      'manual' | 'auto' | 'backtest';
      signal_path: 'boundary' | 'dca' | null;
      token_up:    string;
      token_down:  string;
    }>(
      `SELECT o.id, o.direction, o.share_price, o.size_usdc, o.mode, o.source,
              o.signal_path, m.token_up, m.token_down
         FROM poly_orders o
         JOIN poly_clob_markets m ON m.condition_id = o.market_id
        WHERE o.market_id = $1 AND o.source = 'auto'
          AND o.side = 'buy'   AND o.status = 'pending'
        LIMIT 1`,
      [conditionId],
    );
    const o = rows[0];
    if (!o) return null;

    const tokenId = o.direction === 'up' ? o.token_up : o.token_down;
    const book = await state.poly.getOrderBook(tokenId);
    const bid  = bestBidFromBook(book);
    if (bid == null) {
      log('warn', `cancel skipped — no valid bid`, {
        symbol: state.symbol, orderId: o.id,
      });
      return null;
    }

    const sharesOwned = Number(o.size_usdc) / Number(o.share_price);

    if (o.mode === 'live') {
      const ex = getClobExecutor();
      if (!ex) {
        log('warn', 'cancel skipped — live mode but no executor', { orderId: o.id });
        return null;
      }
      try {
        await ex.placeMarketSell(tokenId, sharesOwned);
      } catch (err) {
        log('warn', 'cancel CLOB sell failed, leaving pending', {
          orderId: o.id, error: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    }

    const pnl = (bid - Number(o.share_price)) * sharesOwned;
    const now = Date.now();

    await pool.query(
      `UPDATE poly_orders
          SET status='closed', pnl_usdc=$1, exit_price=$2,
              close_reason=$3, resolved_at=$4
        WHERE id=$5 AND status='pending' AND side='buy'`,
      [pnl, bid, closeReason, now, o.id],
    );
    await pool.query(
      `UPDATE poly_orders
          SET status='closed', close_reason='cancelled', resolved_at=$1
        WHERE parent_order_id=$2 AND side='sell' AND status='pending'`,
      [now, o.id],
    );

    // FE will pick up the closed order via its 5s poll of /api/poly/orders.
    // (Workers no longer have a direct broadcast path to FE; the T-0 SignalBus
    // event already carries the cancel info — see SignalT0Event.cancelled.)
    log('info', `cancel order ${state.symbol}`, {
      orderId: o.id, reason: closeReason,
      entry: o.share_price, bid, pnl: pnl.toFixed(2),
    });
    return {
      orderId:    o.id,
      direction:  o.direction,
      entryPrice: Number(o.share_price),
      sizeUsdc:   Number(o.size_usdc),
      signalPath: (o.signal_path === 'dca' ? 'dca' : 'boundary'),
      pnlUsdc:    pnl,
      exitPrice:  bid,
    };
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Find the auto BUY order on a given market (if any). Used by phaseT0Plus
 * (filter requireStatus='pending' so closed orders don't trigger T+0
 * announcements) and phaseT0 (no filter — pick up the order whether it's
 * still pending or already TP/SL'd mid-window).
 */
type AutoOrderRow = OrderRef & {
  status:    'pending' | 'closed';
  pnlUsdc:   number | null;
  exitPrice: number | null;
};
async function fetchAutoOrderRef(
  conditionId: string, requireStatus?: 'pending' | 'closed',
): Promise<AutoOrderRow | null> {
  const params: (string | undefined)[] = [conditionId];
  let statusClause = '';
  if (requireStatus) {
    statusClause = `AND status = $2`;
    params.push(requireStatus);
  }
  const { rows } = await getPool().query<{
    id:          string;
    direction:   'up' | 'down';
    share_price: number;
    size_usdc:   number;
    signal_path: string | null;
    status:      'pending' | 'closed';
    pnl_usdc:    number | null;
    exit_price:  number | null;
  }>(
    `SELECT id, direction, share_price, size_usdc, signal_path, status,
            pnl_usdc, exit_price
       FROM poly_orders
      WHERE market_id = $1 AND source = 'auto' AND side = 'buy' ${statusClause}
      ORDER BY ts_entry ASC
      LIMIT 1`,
    params,
  );
  const o = rows[0];
  if (!o) return null;
  return {
    orderId:    o.id,
    direction:  o.direction,
    entryPrice: Number(o.share_price),
    sizeUsdc:   Number(o.size_usdc),
    signalPath: o.signal_path === 'dca' ? 'dca' : 'boundary',
    status:     o.status,
    pnlUsdc:    o.pnl_usdc   != null ? Number(o.pnl_usdc)   : null,
    exitPrice:  o.exit_price != null ? Number(o.exit_price) : null,
  };
}

/**
 * Compute realized/preview PnL for an order at window close. If the order
 * is already closed (TP/SL fired mid-window), use the persisted values.
 * Otherwise derive binary outcome PnL from `outcome`.
 */
function computeOrderPnl(
  order: AutoOrderRow, outcome: 'up' | 'down' | 'unknown',
): { pnlUsdc: number; exitPrice: number } | null {
  if (order.pnlUsdc != null && order.exitPrice != null) {
    return { pnlUsdc: order.pnlUsdc, exitPrice: order.exitPrice };
  }
  if (outcome === 'unknown') return null;
  const shares = order.sizeUsdc / order.entryPrice;
  const won = outcome === order.direction;
  return {
    pnlUsdc:   won ? shares - order.sizeUsdc : -order.sizeUsdc,
    exitPrice: won ? 1.0 : 0.0,
  };
}

interface StreakResult {
  streak: number;
  /** Volume buckets for each streak candle, oldest → newest, length = |streak|. */
  volumeBuckets: VolumeBucket[];
}

async function fetchStreakWithVolume(
  symbol: CoinSymbol, windowStart: number,
): Promise<StreakResult> {
  // Fetch 48 closed 5m candles (~4 hours) — streak uses the tail, avg-volume
  // baseline uses the full span. Excludes in-progress current window.
  const BASELINE_BARS = 48;
  const endTime = windowStart - 1;
  const startTime = windowStart - BASELINE_BARS * WINDOW_MS;
  const bars = await fetchBars(symbol, startTime, endTime, BASELINE_BARS + 2);
  if (!bars.length) return { streak: 0, volumeBuckets: [] };

  const outcomes = bars.map(b => b.close >= b.open ? 'up' : 'down');
  const newest = outcomes[outcomes.length - 1];
  if (!newest) return { streak: 0, volumeBuckets: [] };

  let n = 0;
  for (let i = outcomes.length - 1; i >= 0; i--) {
    if (outcomes[i] !== newest) break;
    n++;
  }
  const streak = newest === 'up' ? n : -n;

  // Avg volume across all fetched bars. Volume = 0 for Pyth (HYPE) → bucket
  // collapses to 'unknown' via bucketize().
  const avgVol = bars.reduce((a, b) => a + b.volume, 0) / bars.length;
  const streakBars = bars.slice(-n);
  const volumeBuckets = streakBars.map(b => bucketize(b.volume, avgVol));

  return { streak, volumeBuckets };
}

function bucketize(vol: number, avgVol: number): VolumeBucket {
  if (!(avgVol > 0) || !(vol > 0)) return 'unknown';
  const ratio = vol / avgVol;
  if (ratio < 0.5) return 'low';
  if (ratio < 1.5) return 'mid';
  if (ratio < 3.0) return 'high';
  return 'extreme';
}

interface Bar { open: number; close: number; volume: number }

/** Unified bar fetch — routes by coin to Binance or Pyth. */
async function fetchBars(
  symbol: CoinSymbol, startTimeMs: number, endTimeMs: number, limit: number,
): Promise<Bar[]> {
  const pythSym = PYTH_SYMBOL[symbol];
  if (pythSym) return fetchPythBars(pythSym, startTimeMs, endTimeMs);
  const binanceSym = BINANCE_SYMBOL[symbol];
  if (binanceSym) return fetchBinanceBars(binanceSym, startTimeMs, endTimeMs, limit);
  return [];
}

async function fetchBinanceBars(
  binanceSym: string, startTimeMs: number, endTimeMs: number, limit: number,
): Promise<Bar[]> {
  try {
    const url = `https://api.binance.com/api/v3/klines`
      + `?symbol=${binanceSym}&interval=5m`
      + `&startTime=${startTimeMs}&endTime=${endTimeMs}&limit=${limit}`;
    const resp = await fetch(url);
    if (!resp.ok) return [];
    const ks = await resp.json() as Array<Array<string | number>>;
    // Binance kline: [openTime, open, high, low, close, volume, closeTime, ...]
    return ks.map(k => ({
      open:   Number(k[1]),
      close:  Number(k[4]),
      volume: Number(k[5]),
    }));
  } catch { return []; }
}

async function fetchPythBars(
  pythSym: string, startTimeMs: number, endTimeMs: number,
): Promise<Bar[]> {
  try {
    const fromSec = Math.floor(startTimeMs / 1000);
    const toSec   = Math.floor(endTimeMs   / 1000);
    const url = `https://benchmarks.pyth.network/v1/shims/tradingview/history`
      + `?symbol=${encodeURIComponent(pythSym)}&resolution=5`
      + `&from=${fromSec}&to=${toSec}`;
    const resp = await fetch(url);
    if (!resp.ok) return [];
    const j = await resp.json() as { s?: string; o?: number[]; c?: number[]; v?: number[] };
    if (j.s !== 'ok' || !j.o || !j.c || j.o.length !== j.c.length) return [];
    // Pyth TradingView: v is always 0 → volume not available, pass through.
    return j.o.map((o, i) => ({
      open:   o,
      close:  j.c![i]!,
      volume: j.v?.[i] ?? 0,
    }));
  } catch { return []; }
}

async function fetchWindowOutcome(
  symbol: CoinSymbol, windowStart: number, windowEnd: number,
): Promise<'up' | 'down' | 'unknown'> {
  // BTC uses our captured future_ticks_5s (matches Chainlink closely).
  if (symbol === 'BTC') {
    const { rows } = await getPool().query<{ o: number | null; c: number | null }>(
      `SELECT
         (SELECT price FROM future_ticks_5s
            WHERE ts >= $1 AND ts < $2 ORDER BY ts ASC  LIMIT 1) AS o,
         (SELECT price FROM future_ticks_5s
            WHERE ts >= $1 AND ts < $2 ORDER BY ts DESC LIMIT 1) AS c`,
      [windowStart, windowEnd],
    );
    const o = rows[0]?.o ?? null;
    const c = rows[0]?.c ?? null;
    if (o == null || c == null) return 'unknown';
    return c >= o ? 'up' : 'down';
  }
  // Other coins: route via fetchBars (Binance for most, Pyth for HYPE).
  const bars = await fetchBars(symbol, windowStart, windowEnd - 1, 1);
  const b = bars[0];
  if (!b) return 'unknown';
  return b.close >= b.open ? 'up' : 'down';
}

function bestAskFromBook(
  book: { asks?: Array<{ price: number; size: number }> } | null,
): number | null {
  if (!book?.asks?.length) return null;
  const p = Math.min(...book.asks.map(a => Number(a.price)));
  return Number.isFinite(p) && p > 0 && p < 1 ? p : null;
}

function bestBidFromBook(
  book: { bids?: Array<{ price: number; size: number }> } | null,
): number | null {
  if (!book?.bids?.length) return null;
  const p = Math.max(...book.bids.map(b => Number(b.price)));
  return Number.isFinite(p) && p > 0 && p < 1 ? p : null;
}

function iconsFromStreak(streak: number): string {
  const n = Math.min(Math.abs(streak), 7);
  const icon = streak > 0 ? '🟢' : '🔴';
  return icon.repeat(n);
}

/**
 * Icon for the in-progress 5m candle at T+4. Fetches the partial bar:
 *   - Binance REST klines returns the unclosed bar when startTime = windowStart
 *   - Pyth TradingView typically returns closed bars only → fallback to ⚪
 * Close ≥ open → 🟢, close < open → 🔴, no data → ⚪.
 */
async function fetchInProgressIcon(
  symbol: CoinSymbol, windowStart: number,
): Promise<string> {
  const bars = await fetchBars(symbol, windowStart, Date.now(), 1);
  const b = bars[0];
  if (!b) return '⚪';
  if (b.close > b.open) return '🟢';
  if (b.close < b.open) return '🔴';
  return '⚪';
}
