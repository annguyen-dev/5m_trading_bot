/**
 * src/services/PriceMonitoringWorker.ts
 *
 * Single background worker supervising N PolymarketService instances (one
 * per enabled coin). Runs a 5-second tick; on each tick it decides, per coin,
 * which phase event to emit for the current window:
 *
 *   T+4m   — signal only (streak + direction + price) via Redis
 *   T-3s   — order placement (if config.mode = 'signal_and_order')
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
  SignalBus, SignalT0PlusEvent, SignalT4Event, SignalTMinus3Event,
  SignalT0Event, VolumeBucket, OrderRef,
} from '@trading-bot/core/SignalBus';
import { PolymarketService, type PolyClobMarket, type ShareTick } from '@trading-bot/core/PolymarketService';
import {
  getEnabledCoins, getCoinConfig,
  type CoinSymbol, type CoinConfig,
} from '@trading-bot/core/CoinConfig';
import { recordOrder, hasAutoOrderFor } from '@trading-bot/core/orderPlacement';
import { getClobExecutor } from '@trading-bot/core/PolymarketClobExecutor';
import { withRetry } from '@trading-bot/core/retry';
import { getPool } from '@trading-bot/db';

const TICK_MS    = 5_000;
const WINDOW_MS  = 300_000;

// Phase slots. Tick-driven phases must be ≥ TICK_MS wide. T-3s placement is
// NOT tick-driven — it's scheduled precisely via setTimeout from phaseT4 so
// the order fires exactly 3s before window close (was 30s; users observed
// the current candle flipping in the 27s leading up to close).
//
//   T+0     → window-start: notify if there's an active order targeting N
//   T+4     → emit signal (bet will be placed for window N+1 at T-3s)
//   T-3s    → scheduled via setTimeout in phaseT4 success path —
//             places the auto order for window N+1 (contrarian)
//   T-0     → window N close: if active order, report PnL & maybe DCA;
//             if no active order + current reversed, cancel N+1 outgoing.
const T_PLUS_0_END_MS = 5_000;   // T+0 phase = first tick of window
const T_PLUS_4_MS     = 240_000; // T+4m — start of T+4 retry slot
const T_MINUS_0_MS    = 295_000; // T+4:55 — wide enough that a 5s tick always lands inside

/** Milliseconds before window close to fire the scheduled placement. */
const PLACEMENT_LEAD_MS = 3_000;

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
  /** Cached signal from T+4 for use at T-3s placement. */
  lastT4?: SignalT4Event;
  /**
   * Cycle state — a "cycle" begins when the bot enters a new contrarian bet
   * (cycleActive=false → T-3s places a boundary order at base size → cycleActive=true).
   * It ends on the next strategy WIN (window outcome matches our bet direction).
   *
   * Placement model (split by phase):
   *   T-3s of N — INITIAL ENTRY only. Fires when cycleActive=false AND
   *               effective streak (closed + current candle) ≥ adaptive
   *               threshold. Skips entirely if a cycle is already running.
   *   T+0  of N — CONTINUATION (DCA). Fires when cycleActive=true AND just-
   *               closed window N was a LOSS. Computes the streak length AS
   *               OF window N+1's start (= includes N's loss) and gates on
   *               `cfg.dca_streak_whitelist`:
   *                 - streak ∈ whitelist → place DCA, size = lastCycleOrderSize ×
   *                   dca_multiplier (first DCA: cfg.size_usdc × dca_multiplier)
   *                 - empty whitelist    → fire on every loss
   *                 - streak ∉ whitelist → silent skip
   *
   * Why DCA at T+0 and not T-3s: at T-3s the just-completing candle isn't in
   * `t4.streak` yet. Whitelist=[4] with current order at streak=3 about to
   * lose would see `absStreak=3` and silently skip. T+0 sees the real post-
   * loss streak.
   *
   * Example (size_usdc=$2, dca_multiplier=2, whitelist=[4,6,8]):
   *   streak=3 boundary → cycle starts, $2 order on N+1
   *   N+1 loses → at T+0 of N+1, streak=4 ✓ → DCA $4 on N+2 (lastSize → $4)
   *   N+2 loses → at T+0 of N+2, streak=5 ✗ → skip; cycle continues
   *   N+3 loses → at T+0 of N+3, streak=6 ✓ → DCA $8 on N+4 (lastSize → $8)
   *   ... win → cycle reset; next T-3s eligible to start a fresh cycle at $2.
   *
   * In-memory; workers restart loses cycle state (acceptable for MVP).
   */
  cycleActive:        boolean;
  cycleDirection?:    'up' | 'down';   // bot's bet side for this cycle
  lastCycleOrderSize: number | null;
  dcaFiredCount:      number;
  /**
   * Recent |streak| values from emitted T+4 signals (last up to 5 entries).
   * Feeds the small-adjust inside a schedule window: if the last 2 entries
   * both equal the schedule's base threshold, bump the effective threshold
   * by +1 so the bot waits for a stronger signal next round. In-memory only.
   */
  recentStreakAbs: number[];
  /**
   * One-shot timer scheduled by phaseT4 to fire phaseTMinus3 at exactly
   * windowEnd - PLACEMENT_LEAD_MS. Cleared on worker stop and on each new
   * T+4 emission (only the latest cached signal fires).
   */
  pendingPlacementTimer?: ReturnType<typeof setTimeout>;
}

export class PriceMonitoringWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private coins = new Map<CoinSymbol, CoinState>();

  /**
   * Live top-of-book from Polymarket WS, keyed by tokenId. Updated on every
   * share_tick event. OrderResolver reads this instead of polling the DB
   * (no flush lag, no query cost). Tokens with no recent tick → not in map.
   */
  private shareBids = new Map<string, { bestBid: number | null; bestAsk: number | null; ts: number }>();

  /** Event-driven SL subscribers — called on every share_tick with bestBid set. */
  private shareTickHandlers = new Set<(tick: ShareTick) => void>();

  constructor(
    private readonly bus: SignalBus,
  ) {}

  /** Latest bestBid for a token from WS (null if no tick received yet). */
  public getBestBid(tokenId: string): number | null {
    return this.shareBids.get(tokenId)?.bestBid ?? null;
  }

  /** Register a handler called on every share_tick from any subscribed token.
   *  Returns an unsubscribe function. */
  public onShareTick(handler: (tick: ShareTick) => void): () => void {
    this.shareTickHandlers.add(handler);
    return () => this.shareTickHandlers.delete(handler);
  }

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
      if (st.pendingPlacementTimer) {
        clearTimeout(st.pendingPlacementTimer);
        delete st.pendingPlacementTimer;
      }
      try { await st.poly.stop(); } catch { /* ignore */ }
    }
    this.coins.clear();
    log('info', 'PriceMonitoringWorker stopped');
  }

  private async addCoin(symbol: CoinSymbol): Promise<void> {
    const poly = new PolymarketService(symbol);
    // Maintain live top-of-book from WS ticks. OrderResolver reads from
    // shareBids instead of DB — zero query cost + zero flush lag.
    poly.on('share_tick', (tick: ShareTick) => {
      if (tick.bestBid != null || tick.bestAsk != null) {
        const prev = this.shareBids.get(tick.tokenId);
        this.shareBids.set(tick.tokenId, {
          bestBid: tick.bestBid ?? prev?.bestBid ?? null,
          bestAsk: tick.bestAsk ?? prev?.bestAsk ?? null,
          ts:      tick.ts,
        });
      }
      // Fan out to event-driven SL listeners.
      for (const h of this.shareTickHandlers) {
        try { h(tick); } catch (err) {
          log('warn', 'PMW shareTick handler threw', { error: String(err) });
        }
      }
    });
    await poly.start();
    this.coins.set(symbol, {
      symbol, poly, emitted: new Set(),
      cycleActive:        false,
      lastCycleOrderSize: null,
      dcaFiredCount:      0,
      recentStreakAbs: [],
    });
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
        } else if (msFromStart >= T_PLUS_4_MS && msFromStart < T_MINUS_0_MS) {
          // T+4 retry slot extends right up to T-0. Successful T+4 schedules
          // a one-shot setTimeout for phaseTMinus3 at windowEnd - 3s.
          await this.phaseT4(state, cfg, windowStart, windowEnd);
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

  /**
   * Evaluate all T+4 gates without side effects. Returns a SignalT4Event when
   * gates pass, or a reason + persistentSkip flag when they don't.
   *
   * `persistentSkip=true` → result won't change for this window (low streak,
   * no market). Caller should dedup so we don't re-check.
   * `persistentSkip=false` → transient (in-progress candle flipped against
   * streak). Caller should NOT dedup — re-evaluate next tick in case the
   * candle flips back into a tradeable state.
   */
  private async evaluateT4Gates(
    state: CoinState, cfg: CoinConfig, windowStart: number, windowEnd: number,
  ): Promise<{ event?: SignalT4Event; reason?: string; persistentSkip: boolean }> {
    const { streak, volumeBuckets } = await fetchStreakWithVolume(state.symbol, windowStart);
    if (Math.abs(streak) < cfg.streak_min) {
      return { reason: `streak ${streak} < min ${cfg.streak_min}`, persistentSkip: true };
    }

    const market = await state.poly.findMarketAt(Math.floor(windowStart / 1000));
    if (!market) {
      return { reason: `no market for ${state.symbol} @ ${windowStart}`, persistentSkip: true };
    }

    const direction: 'up' | 'down' = streak > 0 ? 'down' : 'up';   // contrarian
    const tokenId = direction === 'up' ? market.tokenUp : market.tokenDown;
    const [book, currentIcon] = await Promise.all([
      state.poly.getOrderBook(tokenId),
      fetchInProgressIcon(state.symbol, windowStart),
    ]);
    const price = bestAskFromBook(book);

    const expectedIcon = streak > 0 ? '🟢' : '🔴';
    if (currentIcon !== expectedIcon) {
      return {
        reason: `current ${currentIcon} ≠ expected ${expectedIcon}`,
        persistentSkip: false,   // candle may flip back — retry on next tick
      };
    }

    return {
      event: {
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
      },
      persistentSkip: false,
    };
  }

  /** Max size of the streak-history buffer. 2 is the minimum required by the
   *  small-adjust rule; keeping a small buffer for potential future rules. */
  private static readonly STREAK_HISTORY_MAX = 5;

  /** Append the emitted |streak| to the recent-streak buffer (cap N). */
  private recordStreakAbs(state: CoinState, streak: number): void {
    state.recentStreakAbs.push(Math.abs(streak));
    if (state.recentStreakAbs.length > PriceMonitoringWorker.STREAK_HISTORY_MAX) {
      state.recentStreakAbs.shift();
    }
  }

  /**
   * Adaptive `auto_order_min_streak` — config-driven hour-of-day schedule
   * with a small self-correcting adjust INSIDE the schedule window.
   *
   * Core rule: for the current UTC hour, return the first matching schedule
   * entry's threshold; otherwise return the base `auto_order_min_streak`.
   * Hour ranges wrap midnight (start=22, duration=4 covers 22,23,0,1).
   *
   * Small-adjust inside schedule (applied AFTER resolving the base threshold):
   *   - If last 2 emitted streaks both equal the schedule base → bump +1.
   *     Intuition: seeing exactly-base streaks repeatedly means the market
   *     is noisy at this level; wait for a stronger move.
   *   - If last 2 emitted streaks both equal base+1 → stay at base.
   *     Intuition: base+1 is common enough — revert so we don't miss entries.
   *   - Otherwise → keep the schedule's base value.
   *
   * Outside a schedule window, the rule is not applied (we just use `base`).
   *
   * Example:
   *   schedule {threshold:3}; recent emitted |streaks| = [..., 3, 3] → 4
   *   schedule {threshold:3}; recent emitted |streaks| = [..., 4, 4] → 3
   *   schedule {threshold:3}; recent emitted |streaks| = [..., 3, 5] → 3
   */
  private effectiveAutoMinStreak(state: CoinState, cfg: CoinConfig): {
    threshold: number;
    mode: 'aggressive' | 'conservative' | 'default';
    reason: string;
  } {
    const base = cfg.auto_order_min_streak;
    const hour = new Date().getUTCHours();

    for (const entry of cfg.auto_schedule ?? []) {
      const start = Math.floor(entry.start_hour) % 24;
      const dur   = Math.max(1, Math.min(24, Math.floor(entry.duration_hours)));
      const endExclusive = (start + dur) % 24;
      const inWindow = start < endExclusive
        ? (hour >= start && hour < endExclusive)
        : (hour >= start || hour < endExclusive);   // wraps midnight
      if (!inWindow) continue;

      // Schedule matched. Apply small-adjust on top of the schedule's base.
      const schedBase = entry.threshold;
      const last2 = state.recentStreakAbs.slice(-2);
      let threshold = schedBase;
      let adjustNote = '';

      if (last2.length === 2) {
        if (last2[0] === schedBase && last2[1] === schedBase) {
          threshold = schedBase + 1;
          adjustNote = ` +1 (last 2 streaks=${schedBase})`;
        } else if (last2[0] === schedBase + 1 && last2[1] === schedBase + 1) {
          threshold = schedBase;   // explicit reset back to base
          adjustNote = ` reset (last 2 streaks=${schedBase + 1} → back to base)`;
        }
      }

      const mode = threshold < base ? 'aggressive'
                 : threshold > base ? 'conservative'
                 : 'default';
      return {
        threshold,
        mode,
        reason: `${state.symbol} schedule ${start}h-${endExclusive}h UTC → ${schedBase}${adjustNote}`,
      };
    }

    return {
      threshold: base,
      mode: 'default',
      reason: `base ${base} (no schedule match at ${hour}h UTC)`,
    };
  }

  /**
   * Schedule the precise T-3s placement firing. Idempotent — clears any
   * previous timer for this coin so only the latest T+4 emission's timer
   * is live (re-emitting via late-eval paths replaces the schedule).
   *
   * If T+4 fired so late that T-3s is already past, fires immediately —
   * `phaseTMinus3` itself dedups via `state.emitted`.
   */
  private schedulePlacement(
    state: CoinState, cfg: CoinConfig, windowStart: number, windowEnd: number,
  ): void {
    if (state.pendingPlacementTimer) clearTimeout(state.pendingPlacementTimer);
    const fireAt = windowEnd - PLACEMENT_LEAD_MS;
    const delay  = fireAt - Date.now();
    if (delay <= 0) {
      // Already past T-3s — fire immediately (still has time before window close).
      void this.phaseTMinus3(state, cfg, windowStart, windowEnd);
      return;
    }
    const timer = setTimeout(() => {
      delete state.pendingPlacementTimer;
      void this.phaseTMinus3(state, cfg, windowStart, windowEnd);
    }, delay);
    timer.unref();    // don't keep the event loop alive on shutdown
    state.pendingPlacementTimer = timer;
  }

  private async phaseT4(
    state: CoinState, cfg: CoinConfig, windowStart: number, windowEnd: number,
  ): Promise<void> {
    const key = `${windowStart}:T+4`;
    if (state.emitted.has(key)) return;

    const result = await this.evaluateT4Gates(state, cfg, windowStart, windowEnd);
    if (result.event) {
      await this.bus.publish(result.event);
      state.lastT4 = result.event;
      state.emitted.add(key);
      this.recordStreakAbs(state, result.event.streak);
      this.schedulePlacement(state, cfg, windowStart, windowEnd);
      log('info', `PriceMonitoringWorker T+4 ${state.symbol}`, {
        streak: result.event.streak, direction: result.event.direction,
        price: result.event.price, mode: cfg.mode,
      });
    } else if (result.persistentSkip) {
      state.emitted.add(key);   // permanent — don't retry, no T-3s needed
      log('info', `PriceMonitoringWorker T+4 skip ${state.symbol} (permanent)`, {
        reason: result.reason,
      });
    } else {
      // Transient skip (current candle flipped against streak). Don't add
      // emitted → retry next tick. ALSO schedule the T-3s timer right here
      // (idempotent — schedulePlacement no-ops if a timer is already live)
      // so T-3s STILL fires even if T+4 never produces a signal across all
      // its retries. phaseTMinus3 will then re-evaluate the gates with fresh
      // data and place an order if conditions allow — independently of
      // whether T+4 ever emitted. (User-requested: T+4 = preview, T-3s/T+0
      // are the actual decision points.)
      if (!state.pendingPlacementTimer) {
        this.schedulePlacement(state, cfg, windowStart, windowEnd);
      }
      log('info', `PriceMonitoringWorker T+4 transient skip ${state.symbol} (will retry; T-3s armed)`, {
        reason: result.reason,
      });
    }
  }

  /**
   * T-3s placement — invoked precisely 3s before window close by a setTimeout
   * scheduled in `phaseT4`. Also called inline by `phaseT0` Path E as a
   * last-chance retry when T+4 never produced a signal.
   *
   * Idempotent via the `T-3s` emitted key (so timer + Path E + late T+4 races
   * collapse to one placement).
   */
  private async phaseTMinus3(
    state: CoinState, cfg: CoinConfig, windowStart: number, windowEnd: number,
  ): Promise<void> {
    const key = `${windowStart}:T-3s`;
    if (state.emitted.has(key)) return;
    state.emitted.add(key);

    // If T+4 phase never published a signal (e.g. candle was flipped during
    // the entire T+4 retry slot and never recovered), do one last-chance
    // evaluation here so a late-emerging streak still gets placed.
    let t4 = state.lastT4;
    if (!t4 || t4.windowStart !== windowStart) {
      const result = await this.evaluateT4Gates(state, cfg, windowStart, windowEnd);
      if (result.event) {
        await this.bus.publish(result.event);
        state.lastT4 = result.event;
        t4 = result.event;
        this.recordStreakAbs(state, result.event.streak);
        log('info', `phaseTMinus3 late T+4 eval ok ${state.symbol}`, {
          streak: result.event.streak, direction: result.event.direction,
        });
      } else {
        log('info', `phaseTMinus3 late T+4 eval skip ${state.symbol}`, {
          reason: result.reason,
        });
        return;
      }
    }

    if (cfg.mode === 'signal_only') {
      await this.bus.publish<SignalTMinus3Event>({
        type: 'T-3s', coin: state.symbol,
        windowStart, windowEnd,
        action: 'signal_only_mode', emittedAt: Date.now(),
      });
      return;
    }

    const result = await this.tryPlaceBoundary(state, cfg, t4);
    if (result.placed && result.orderId) {
      await this.bus.publish<SignalTMinus3Event>({
        type: 'T-3s', coin: state.symbol,
        windowStart, windowEnd,
        action: 'order_placed',
        orderId:   result.orderId,
        direction: t4.direction,
        ...(result.price    != null ? { price:    result.price }    : {}),
        ...(result.sizeUsdc != null ? { sizeUsdc: result.sizeUsdc } : {}),
        signalPath: 'boundary',
        ...(result.adaptive ? { adaptive: result.adaptive } : {}),
        emittedAt: Date.now(),
      });
    } else {
      await this.bus.publish<SignalTMinus3Event>({
        type: 'T-3s', coin: state.symbol,
        windowStart, windowEnd,
        action: 'order_skipped',
        reason: result.reason ?? '(unknown)',
        signalPath: 'boundary',
        ...(result.adaptive ? { adaptive: result.adaptive } : {}),
        emittedAt: Date.now(),
      });
    }
  }

  /**
   * T-3s INITIAL ENTRY only — opens a fresh cycle by placing a boundary order
   * for window N+1 when no cycle is active.
   *
   * In-cycle DCA is no longer placed here. Reason: at T-3s the just-closed
   * candle isn't in `t4.streak` yet, so checking `|t4.streak|` against the
   * DCA whitelist mis-fires by one — e.g., whitelist=[4], current order at
   * streak=3 about to lose, T-3s sees absStreak=3 (∉ [4]) and silently skips
   * the DCA. By moving DCA to T+0 (`tryPlaceDcaAtBoundary`) we evaluate after
   * window N closes, so the streak we check INCLUDES the loss.
   *
   * Gates here (cycle inactive):
   *   1. Current candle direction still matches streak (no flip)
   *   2. Effective streak (|t4.streak| + 1) ≥ adaptive threshold
   *   3. N+1 market exists
   *   4. No duplicate auto order already on N+1
   *   5. Best ask ≤ cfg.limit_price_cents
   *
   * If cycle IS active when we get here, return early with reason — Path A is
   * skipped because Path B (DCA) owns continuation, and it fires at T+0.
   *
   * Called from phaseTMinus3 (primary) and phaseT0 Path E (last-chance retry).
   */
  private async tryPlaceBoundary(
    state: CoinState, cfg: CoinConfig, t4: SignalT4Event,
  ): Promise<{
    placed:    boolean;
    reason?:   string;
    orderId?:  string;
    price?:    number;
    sizeUsdc?: number;
    signalPath?: 'boundary' | 'dca';
    adaptive?: {
      base:      number;
      threshold: number;
      mode:      'aggressive' | 'conservative' | 'default';
      reason:    string;
    };
  }> {
    // Compute adaptive threshold up-front so callers always get context —
    // even when a non-threshold gate fails (ask too high, market missing etc).
    const base = cfg.auto_order_min_streak;
    const adapt = this.effectiveAutoMinStreak(state, cfg);
    const adaptive = { base, ...adapt };
    if (adapt.mode !== 'default') {
      log('info', `adaptive threshold ${state.symbol}`, {
        base, threshold: adapt.threshold, mode: adapt.mode, reason: adapt.reason,
        hourUtc: new Date().getUTCHours(),
      });
    }

    // If a cycle is already running, T-3s does NOT place. DCA continuation
    // fires at T+0 of the next window where we know the actual loss outcome.
    if (state.cycleActive && state.cycleDirection != null) {
      return {
        placed: false,
        reason: 'cycle active — DCA fires at T+0 of next window, not here',
        adaptive,
      };
    }

    // Gate 1: current candle direction must still match streak
    const currentIcon = await fetchInProgressIcon(state.symbol, t4.windowStart);
    const expectedIcon = t4.streak > 0 ? '🟢' : '🔴';
    if (currentIcon !== expectedIcon) {
      return {
        placed: false,
        reason: `current flipped to ${currentIcon} (streak ${expectedIcon})`,
        adaptive,
      };
    }

    const absStreak = Math.abs(t4.streak);

    // Gate 2: effective streak (closed + current candle counted) ≥ threshold
    const effectiveStreak = absStreak + 1;
    if (effectiveStreak < adapt.threshold) {
      return {
        placed: false,
        reason: `effective streak ${effectiveStreak} (closed ${absStreak}+1 current) < auto_min ${adapt.threshold} [${adapt.reason}]`,
        adaptive,
      };
    }

    // Gate 3: N+1 market exists
    const nextWindowStartMs = t4.windowStart + WINDOW_MS;
    const market = await state.poly.findMarketAt(Math.floor(nextWindowStartMs / 1000));
    if (!market) return { placed: false, reason: 'no N+1 market', adaptive };

    // Gate 4: not already placed (dedup) — any auto order on N+1.
    if (await hasAutoOrderFor(market.conditionId)) {
      return { placed: false, reason: 'auto order already exists for N+1', adaptive };
    }

    // Gate 5: ask ≤ limit
    const direction = t4.direction;
    const tokenId = direction === 'up' ? market.tokenUp : market.tokenDown;
    const book = await state.poly.getOrderBook(tokenId);
    const ask = bestAskFromBook(book);
    if (ask == null) return { placed: false, reason: 'no valid ask', adaptive };
    if (ask * 100 > cfg.limit_price_cents) {
      return { placed: false,
        reason: `ask ${(ask * 100).toFixed(1)}¢ > limit ${cfg.limit_price_cents}¢`,
        adaptive };
    }

    // Place — initial entry, base size only.
    const orderSize  = cfg.size_usdc;
    const signalPath: 'boundary' = 'boundary';

    try {
      const r = await recordOrder({
        conditionId:    market.conditionId,
        direction,
        sharePrice:     ask,
        sizeUsdc:       orderSize,
        source:         'auto',
        signalPath,
        tpCents:        cfg.tp_cents,
        slCents:        cfg.sl_cents,
        streakAtSignal: absStreak,
      });

      // Cycle starts.
      state.cycleActive        = true;
      state.cycleDirection     = direction;
      state.lastCycleOrderSize = null;
      state.dcaFiredCount      = 0;
      log('info', `Boundary placed (cycle start) ${state.symbol}`, {
        streakAbs: absStreak, direction, size: orderSize,
      });

      return {
        placed:    true,
        orderId:   r.id,
        price:     ask,
        sizeUsdc:  orderSize,
        signalPath,
        adaptive,
      };
    } catch (err) {
      return {
        placed: false,
        reason: err instanceof Error ? err.message : String(err),
        adaptive,
      };
    }
  }

  /**
   * Place a DCA continuation order at the window boundary, after the previous
   * window's loss has been confirmed.
   *
   * Called from `phaseT0` once we know window N's outcome was a LOSS for the
   * cycle direction. Targets window N+1 (the one that just opened).
   *
   * The streak we check against `dca_streak_whitelist` is computed via
   * `fetchStreakWithVolume(symbol, nextWindowStart)` — which walks closed
   * bars BEFORE `nextWindowStart`, i.e. INCLUDES window N. So whitelist=[4]
   * fires when N's loss made the streak length exactly 4.
   *
   * Returns silently on any skip (whitelist mismatch, no market, no ask, etc).
   */
  private async tryPlaceDcaAtBoundary(
    state: CoinState, cfg: CoinConfig,
    justClosedWindowStart: number,
  ): Promise<void> {
    if (!state.cycleActive || state.cycleDirection == null) return;

    const nextWindowStart = justClosedWindowStart + WINDOW_MS;

    // Compute streak as of nextWindowStart — includes the just-closed loss.
    const { streak } = await fetchStreakWithVolume(state.symbol, nextWindowStart);
    const absStreak = Math.abs(streak);
    const direction = state.cycleDirection;

    // Whitelist gate. Empty whitelist = always fire on loss (legacy default).
    const whitelist = cfg.dca_streak_whitelist ?? [];
    if (whitelist.length > 0 && !whitelist.includes(absStreak)) {
      log('info', `DCA skip ${state.symbol}: streak ${absStreak} ∉ whitelist [${whitelist.join(',')}]`, {
        nextWindowStart, direction,
      });
      return;
    }

    // Sanity: streak direction must still oppose our (contrarian) bet.
    // If somehow it flipped (data anomaly, etc), skip — Path A will reopen
    // a fresh cycle if conditions justify.
    const streakDirection = streak > 0 ? 'up' : 'down';
    if (streakDirection === direction) {
      log('warn', `DCA skip ${state.symbol}: streak direction matches our bet (no longer contrarian)`, {
        nextWindowStart, streak, cycleDirection: direction,
      });
      return;
    }

    const market = await state.poly.findMarketAt(Math.floor(nextWindowStart / 1000));
    if (!market) { log('info', `DCA skip ${state.symbol}: no N+1 market`, { nextWindowStart }); return; }

    if (await hasAutoOrderFor(market.conditionId)) {
      log('info', `DCA skip ${state.symbol}: auto order already exists for N+1`, {
        conditionId: market.conditionId,
      });
      return;
    }

    const tokenId = direction === 'up' ? market.tokenUp : market.tokenDown;
    const book = await state.poly.getOrderBook(tokenId);
    const ask = bestAskFromBook(book);
    if (ask == null) { log('info', `DCA skip ${state.symbol}: no valid ask`, { tokenId }); return; }
    if (ask * 100 > cfg.limit_price_cents) {
      log('info', `DCA skip ${state.symbol}: ask ${(ask * 100).toFixed(1)}¢ > limit ${cfg.limit_price_cents}¢`);
      return;
    }

    const baseSize  = state.lastCycleOrderSize ?? cfg.size_usdc;
    const orderSize = baseSize * cfg.dca_multiplier;

    try {
      const r = await recordOrder({
        conditionId:    market.conditionId,
        direction,
        sharePrice:     ask,
        sizeUsdc:       orderSize,
        source:         'auto',
        signalPath:     'dca',
        tpCents:        cfg.tp_cents,
        slCents:        cfg.sl_cents,
        streakAtSignal: absStreak,
      });

      state.lastCycleOrderSize = orderSize;
      state.dcaFiredCount     += 1;
      log('info', `DCA placed at boundary ${state.symbol}`, {
        orderId: r.id, streakAbs: absStreak, direction, ask,
        size: orderSize, multiplier: cfg.dca_multiplier,
        dcaCountInCycle: state.dcaFiredCount,
      });

      // Surface to bus so UI/Telegram see the placement under the new window.
      const nextWindowEnd = nextWindowStart + WINDOW_MS;
      await this.bus.publish<SignalTMinus3Event>({
        type: 'T-3s', coin: state.symbol,
        windowStart: nextWindowStart, windowEnd: nextWindowEnd,
        action:     'order_placed',
        orderId:    r.id,
        direction,
        price:      ask,
        sizeUsdc:   orderSize,
        signalPath: 'dca',
        emittedAt:  Date.now(),
      });
    } catch (err) {
      log('warn', `DCA place failed ${state.symbol}`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * T+0 — start of window N. Notifies (Telegram + UI) when there's an active
   * (pending) auto order targeting N (placed at T-3s of N-1). Skips silently
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
   * T-0 — end of window N. Branches (mutually exclusive — at most one auto
   * order placed per call):
   *
   *   (A) Incoming order (placed at N-1's T-3s, resolving at N) LOST AND
   *       !dcaFiredInCycle → place ONE DCA for N+1 (size = loser ×
   *       cfg.dca_multiplier), set dcaFiredInCycle=true. Telegram includes
   *       "DCA recovery" line.
   *   (B) Incoming LOST AND dcaFiredInCycle already true → publish T-0 event,
   *       no new DCA (single shot per loss cycle).
   *   (C) Incoming WON → reset cycle (dcaFiredInCycle=false). Streak
   *       necessarily broke → also cancel outgoing N+1 if exists.
   *   (D) No incoming + streak BROKE at N → cancel outgoing N+1 (Path B
   *       legacy logic, kept per user requirement).
   *   (E) No incoming + streak INTACT + signal_and_order → T-0 boundary
   *       retry. Re-runs T-3s gates (current candle, ask). Lets us catch
   *       signals where T-3s gates were temporarily volatile but flipped
   *       back into a tradeable state in the last 30s.
   */
  private async phaseT0(
    state: CoinState, cfg: CoinConfig, windowStart: number, windowEnd: number,
  ): Promise<void> {
    const key = `${windowStart}:T-0`;
    if (state.emitted.has(key)) return;
    state.emitted.add(key);

    const outcome = await fetchWindowOutcome(state.symbol, windowStart, windowEnd);
    const t4 = state.lastT4;

    // Streak break detection: this window's outcome opposes T+4 streak direction.
    let streakBroken = false;
    if (t4 && t4.windowStart === windowStart && outcome !== 'unknown') {
      const streakSign  = Math.sign(t4.streak);
      const outcomeSign = outcome === 'up' ? 1 : -1;
      if (streakSign !== 0 && outcomeSign !== streakSign) streakBroken = true;
    }

    // ── Cycle state update (applies whether or not we have an incoming order;
    //    in particular: if we SKIPPED placement at last T-3s due to whitelist,
    //    there is no incoming but the cycle should still progress based on the
    //    underlying outcome).
    if (state.cycleActive && state.cycleDirection != null && outcome !== 'unknown') {
      if (outcome === state.cycleDirection) {
        log('info', `cycle reset (strategy win, no-incoming-aware) ${state.symbol}`, {
          previouslyFiredCount: state.dcaFiredCount,
          previouslyLastSize:   state.lastCycleOrderSize,
        });
        state.cycleActive        = false;
        delete state.cycleDirection;
        state.lastCycleOrderSize = null;
        state.dcaFiredCount      = 0;
      } else {
        // Loss → cycle continues. Fire DCA for the next window NOW that we
        // know the loss is real and the streak length includes it. Whitelist
        // gate (e.g. [4]) is checked inside; silent skip on miss.
        await this.tryPlaceDcaAtBoundary(state, cfg, windowStart);
      }
    }

    const incomingMarket = await state.poly.findMarketAt(Math.floor(windowStart / 1000));
    const incoming = incomingMarket
      ? await fetchAutoOrderRef(incomingMarket.conditionId)
      : null;

    // ── Branch with incoming order ───────────────────────────────────────
    if (incoming) {
      const pnl = computeOrderPnl(incoming, outcome);

      // STRATEGY outcome at window close — based on the actual underlying
      // direction at resolution, NOT the order's executed PnL. SL during the
      // window can lock in a monetary loss even when the candle whipsaws back
      // and the window resolves in our favor. Firing DCA on those whipsaw
      // losses doubles down on a *strategy* that was actually correct, which
      // is exactly the dangerous DCA case we want to avoid.
      const strategyOutcome: 'win' | 'loss' | 'unknown' =
        outcome === 'unknown'                ? 'unknown'
        : outcome === incoming.direction      ? 'win'
        :                                       'loss';

      // (Cycle state already updated at the top of phaseT0 — applies whether
      // or not there's an incoming order. Here we just surface SL-whipsaw
      // for the auditing log.)
      if (pnl && pnl.pnlUsdc < 0 && strategyOutcome === 'win') {
        log('warn', `SL whipsaw: window resolved favorably — cycle reset ${state.symbol}`, {
          direction: incoming.direction, outcome, slPnl: pnl.pnlUsdc,
        });
      }

      // Cancel outgoing N+1 if streak broke (legacy Path C/D — usually not
      // needed in the new model since the next T-3s won't place if cycle is
      // inactive AND streak doesn't meet threshold; but kept for safety).
      let cancelled: (OrderRef & { pnlUsdc: number; exitPrice: number }) | undefined;
      if (streakBroken) {
        const nextMarket = await state.poly.findMarketAt(
          Math.floor((windowStart + WINDOW_MS) / 1000),
        );
        if (nextMarket) {
          cancelled = (await this.cancelPendingAutoOrderForMarket(
            state, nextMarket.conditionId, 'cancelled_reversal',
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
        ...(cancelled ? { cancelled: cancelled } : {}),
        emittedAt: Date.now(),
      });
      log('info', `PriceMonitoringWorker T-0 (incoming) ${state.symbol}`, {
        outcome, pnl: pnl?.pnlUsdc, cancelled: !!cancelled,
      });
      return;
    }

    // ── No incoming ──────────────────────────────────────────────────────
    if (streakBroken) {
      // Path D: cancel outgoing N+1 if exists
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
    } else if (!streakBroken && cfg.mode === 'signal_and_order') {
      // Path E: T-0 boundary retry (streak intact OR unknown, no incoming).
      // If we have no cached T+4 (T+4 + T-3s both missed), do an inline
      // last-chance eval here — this is our final shot before window close.
      let pathT4 = t4 && t4.windowStart === windowStart ? t4 : undefined;
      if (!pathT4) {
        const r = await this.evaluateT4Gates(state, cfg, windowStart, windowEnd);
        if (r.event) {
          await this.bus.publish(r.event);
          state.lastT4 = r.event;
          pathT4 = r.event;
          this.recordStreakAbs(state, r.event.streak);
          log('info', `phaseT0 late T+4 eval ok ${state.symbol}`, {
            streak: r.event.streak, direction: r.event.direction,
          });
        } else {
          log('info', `phaseT0 late T+4 eval skip ${state.symbol}`, { reason: r.reason });
        }
      }
      if (pathT4) {
        const result = await this.tryPlaceBoundary(state, cfg, pathT4);
        if (result.placed && result.orderId) {
          await this.bus.publish<SignalTMinus3Event>({
            type: 'T-3s', coin: state.symbol,
            windowStart, windowEnd,
            action: 'order_placed',
            orderId:   result.orderId,
            direction: pathT4.direction,
            ...(result.price    != null ? { price:    result.price }    : {}),
            ...(result.sizeUsdc != null ? { sizeUsdc: result.sizeUsdc } : {}),
            signalPath: 'boundary',
            lateRetry:  true,
            ...(result.adaptive ? { adaptive: result.adaptive } : {}),
            emittedAt:  Date.now(),
          });
          log('info', `T-0 retry placement ${state.symbol}`, {
            orderId: result.orderId, price: result.price,
          });
          return;
        }
        // Result not placed → silent (T-3s already emitted skip event,
        // or we never had one — either way, log is enough)
      }
    }

    // Nothing actionable — silent
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
    parentStreak: number,
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
        conditionId:    market.conditionId,
        direction,
        sharePrice:     ask,
        sizeUsdc,
        source:         'auto',
        signalPath:     'dca',
        tpCents:        cfg.tp_cents,
        slCents:        cfg.sl_cents,
        // Inherit parent's streak so subsequent reasoning (analytics, future
        // chained logic) can trace the trigger context.
        streakAtSignal: Math.abs(parentStreak),
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
  /** |streak| at the moment this order was placed (from poly_orders.streak_5m).
   *  0 = legacy/unknown — won't match a non-empty dca_streak_whitelist. */
  streakAbs: number;
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
    streak_5m:   number | null;
  }>(
    `SELECT id, direction, share_price, size_usdc, signal_path, status,
            pnl_usdc, exit_price, streak_5m
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
    streakAbs:  o.streak_5m != null ? Math.abs(Number(o.streak_5m)) : 0,
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

/**
 * Streak + volume for a coin at `windowStart`.
 *
 * Uses Binance 5m klines (or Pyth for HYPE). Direction per bar:
 *   close > open  → 'up'
 *   close < open  → 'down'
 *   close == open → 'doji' (breaks the streak — indecision, not continuation)
 *
 * The doji-breaks-streak behavior was added after we observed SOL at 01:25
 * and 01:30 UTC both closing exactly at their open, which used to be counted
 * as two extra greens and inflated the streak.
 */
async function fetchStreakWithVolume(
  symbol: CoinSymbol, windowStart: number,
): Promise<StreakResult> {
  const BASELINE_BARS = 48;
  const endTime = windowStart - 1;
  const startTime = windowStart - BASELINE_BARS * WINDOW_MS;
  const bars = await fetchBars(symbol, startTime, endTime, BASELINE_BARS + 2);
  if (!bars.length) {
    log('warn', 'fetchStreakWithVolume: no bars (signal may be missed)', {
      symbol, windowStart,
      source: PYTH_SYMBOL[symbol] ? 'pyth' : 'binance',
    });
    return { streak: 0, volumeBuckets: [] };
  }

  // Stale data check: most recent bar's open should be ~5min before windowStart.
  const latestBarOpen = startTime + (bars.length - 1) * WINDOW_MS;
  if ((windowStart - latestBarOpen) > 2 * WINDOW_MS) {
    log('warn', 'fetchStreakWithVolume: stale latest bar (data feed lag?)', {
      symbol, windowStart, latestBarOpen,
      lagMs: windowStart - latestBarOpen,
    });
  }

  const outcomes: ('up' | 'down' | 'doji')[] = bars.map(b =>
    b.close > b.open ? 'up' :
    b.close < b.open ? 'down' :
    'doji',
  );
  const newest = outcomes[outcomes.length - 1];
  if (!newest || newest === 'doji') {
    return { streak: 0, volumeBuckets: [] };
  }

  let n = 0;
  for (let i = outcomes.length - 1; i >= 0; i--) {
    if (outcomes[i] !== newest) break;   // doji !== up/down → breaks
    n++;
  }
  const streak = newest === 'up' ? n : -n;

  // ── Poly cross-check ──────────────────────────────────────────────────────
  // Per-coin policy: every window in the streak must agree with Polymarket's
  // resolved outcome. If ANY window in the streak shows a Binance/Poly diff,
  // the data is unreliable → return streak=0 → no T+4 signal → no T-3s order
  // for the next window (the user-facing "cancel" effect).
  //
  // Batch-query the cached outcomes in one DB roundtrip; live-fetch only the
  // windows that haven't been resolved yet.
  const verifyStarts: number[] = [];
  for (let i = 0; i < n; i++) verifyStarts.push(windowStart - (i + 1) * WINDOW_MS);

  const { rows: cached } = await getPool().query<{
    window_start: string; outcome: string | null; token_up: string;
  }>(
    `SELECT window_start, outcome, token_up FROM poly_clob_markets
      WHERE symbol = $1 AND window_start = ANY($2::bigint[])`,
    [symbol, verifyStarts],
  );
  const cacheMap = new Map(cached.map(r => [Number(r.window_start), r]));
  const exec = getClobExecutor();

  for (const wStart of verifyStarts) {
    const row = cacheMap.get(wStart);
    if (!row) continue;                          // no Poly market at this window — can't verify, skip
    let polyOutcome: 'up' | 'down' | 'unknown' =
      row.outcome === 'up' || row.outcome === 'down' ? row.outcome : 'unknown';

    if (polyOutcome === 'unknown' && exec) {
      polyOutcome = await exec.fetchResolvedOutcome(row.token_up, wStart + WINDOW_MS);
      if (polyOutcome === 'up' || polyOutcome === 'down') {
        await getPool().query(
          `UPDATE poly_clob_markets
             SET outcome = $1, outcome_fetched_at = $2
           WHERE symbol = $3 AND window_start = $4`,
          [polyOutcome, Date.now(), symbol, wStart],
        );
      }
    }

    if (polyOutcome !== 'unknown' && polyOutcome !== newest) {
      log('warn', 'fetchStreakWithVolume: Binance/Poly mismatch in streak — suppress', {
        symbol, windowStart, mismatchAt: wStart,
        binance: newest, poly: polyOutcome,
      });
      return { streak: 0, volumeBuckets: [] };
    }
  }

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
    return await withRetry(`Binance klines ${binanceSym}`, async () => {
      const url = `https://api.binance.com/api/v3/klines`
        + `?symbol=${binanceSym}&interval=5m`
        + `&startTime=${startTimeMs}&endTime=${endTimeMs}&limit=${limit}`;
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`Binance ${resp.status} ${resp.statusText}`);
      const ks = await resp.json() as Array<Array<string | number>>;
      // Binance kline: [openTime, open, high, low, close, volume, closeTime, ...]
      return ks.map(k => ({
        open:   Number(k[1]),
        close:  Number(k[4]),
        volume: Number(k[5]),
      }));
    }, { baseDelayMs: 300 });
  } catch (err) {
    log('warn', 'fetchBinanceBars exhausted', {
      binanceSym, error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

async function fetchPythBars(
  pythSym: string, startTimeMs: number, endTimeMs: number,
): Promise<Bar[]> {
  try {
    return await withRetry(`Pyth bars ${pythSym}`, async () => {
      const fromSec = Math.floor(startTimeMs / 1000);
      const toSec   = Math.floor(endTimeMs   / 1000);
      const url = `https://benchmarks.pyth.network/v1/shims/tradingview/history`
        + `?symbol=${encodeURIComponent(pythSym)}&resolution=5`
        + `&from=${fromSec}&to=${toSec}`;
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`Pyth ${resp.status} ${resp.statusText}`);
      const j = await resp.json() as { s?: string; o?: number[]; c?: number[]; v?: number[] };
      if (j.s !== 'ok' || !j.o || !j.c || j.o.length !== j.c.length) return [];
      // Pyth TradingView: v is always 0 → volume not available, pass through.
      return j.o.map((o, i) => ({
        open:   o,
        close:  j.c![i]!,
        volume: j.v?.[i] ?? 0,
      }));
    }, { baseDelayMs: 300 });
  } catch (err) {
    log('warn', 'fetchPythBars exhausted', {
      pythSym, error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * Window outcome — Polymarket-primary, Binance/Chainlink as cross-check.
 *
 * Returns:
 *   'up' | 'down' — both sources agree, OR only one source is available.
 *   'unknown'    — both sources known AND disagree → suppress all downstream
 *                  decisions (streak break detect, DCA, signals). Cancels any
 *                  pending action for the next window.
 *
 * Why prefer Poly: we BET on Poly's binary resolution, not on the underlying
 * candle. When Polymarket's reference price source ticks differently from
 * Binance (timing, exchange, or computed-mid vs single-feed), the ONLY
 * outcome that matters for PnL is Poly's. Binance is the sanity rail —
 * disagreement = data uncertainty, refuse to act.
 */
async function fetchWindowOutcome(
  symbol: CoinSymbol, windowStart: number, windowEnd: number,
): Promise<'up' | 'down' | 'unknown'> {
  const [source, poly] = await Promise.all([
    fetchSourceOutcome(symbol, windowStart, windowEnd),
    fetchPolyWindowOutcome(symbol, windowStart, windowEnd),
  ]);

  if (source !== 'unknown' && poly !== 'unknown' && source !== poly) {
    log('warn', 'fetchWindowOutcome: source/Poly mismatch — return unknown', {
      symbol, windowStart, source, poly,
    });
    return 'unknown';
  }
  return poly !== 'unknown' ? poly : source;
}

/** Underlying-source outcome (Binance kline / Pyth bars / Chainlink-aligned ticks for BTC). */
async function fetchSourceOutcome(
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

/**
 * Polymarket's resolved outcome for a window.
 * - Reads cached `outcome` from poly_clob_markets (free; no API call).
 * - On cache miss, falls back to live `/prices-history` via the CLOB executor
 *   and writes the answer back to the cache.
 * - Returns 'unknown' if no Poly market exists for the window OR Poly hasn't
 *   resolved it yet (transient — caller should retry on the next tick).
 */
async function fetchPolyWindowOutcome(
  symbol: CoinSymbol, windowStart: number, windowEnd: number,
): Promise<'up' | 'down' | 'unknown'> {
  const { rows } = await getPool().query<{ outcome: string | null; token_up: string }>(
    `SELECT outcome, token_up FROM poly_clob_markets
      WHERE symbol = $1 AND window_start = $2 AND window_end = $3
      LIMIT 1`,
    [symbol, windowStart, windowEnd],
  );
  const row = rows[0];
  if (!row) return 'unknown';                                // no Poly market for this window
  if (row.outcome === 'up' || row.outcome === 'down') return row.outcome;

  // Cache miss → live fetch + cache. Skips silently if executor not available
  // (dev without POLY_PRIVATE_KEY) — falls through to source-only outcome.
  const exec = getClobExecutor();
  if (!exec) return 'unknown';
  const live = await exec.fetchResolvedOutcome(row.token_up, windowEnd);
  if (live === 'up' || live === 'down') {
    await getPool().query(
      `UPDATE poly_clob_markets
         SET outcome = $1, outcome_fetched_at = $2
       WHERE symbol = $3 AND window_start = $4`,
      [live, Date.now(), symbol, windowStart],
    );
  }
  return live;
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
 * Close > open → 🟢, close < open → 🔴, equal/no-data → ⚪.
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
