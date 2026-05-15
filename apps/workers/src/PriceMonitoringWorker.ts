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
  SignalT0Event, SignalEchoStateEvent, VolumeBucket, OrderRef,
  DefensiveGapStats,
} from '@trading-bot/core/SignalBus';
import { PolymarketService, type PolyClobMarket, type ShareTick } from '@trading-bot/core/PolymarketService';
import {
  getEnabledCoins, getCoinConfig,
  type CoinSymbol, type CoinConfig, type EchoEdgeCase,
} from '@trading-bot/core/CoinConfig';
import { recordOrder, hasAutoOrderFor } from '@trading-bot/core/orderPlacement';
import { getClobExecutor } from '@trading-bot/core/PolymarketClobExecutor';
import { withRetry } from '@trading-bot/core/retry';
import { getPool } from '@trading-bot/db';

const TICK_MS    = 5_000;
const WINDOW_MS  = 300_000;
/** Heartbeat for echo_state republish — bounds API-restart recovery latency.
 *  When API restarts its in-memory engine.echoStates Map is empty; the next
 *  echo_state event from worker will repopulate it. With transition-only
 *  publishes that could take hours; a 60s heartbeat caps the gap. */
const ECHO_REPUBLISH_INTERVAL_MS = 60_000;

/** Background sync of poly_clob_markets.outcome — closes the gap that
 *  fetchStreakWithVolume's verify step depends on. Polymarket usually
 *  publishes resolution within 30-60s of T-0; we wait 30s before first
 *  attempt, retry on subsequent ticks if still 'unknown'. Cap per tick
 *  prevents API-rate-limit spam during fresh-start backfills (when many
 *  windows are simultaneously NULL). */
const SYNC_OUTCOMES_BATCH                  = 20;
const SYNC_OUTCOMES_RESOLVE_BUFFER_MS      = 30_000;
const SYNC_OUTCOMES_STALE_WARN_MS          = 30 * 60_000;
/** How long to wait before retrying a row whose live fetch returned 'unknown'.
 *  Without this throttle, the sweep would re-fetch the same NULL rows every
 *  tick — fatal when many old markets are permanently unresolvable (Polymarket
 *  /prices-history has no data for windows >7 days back, verified in prod
 *  2026-05-05: 4088 NULL rows >1d old, all returning 'unknown'). */
const SYNC_OUTCOMES_RETRY_INTERVAL_MS      = 60 * 60_000;   // 1h
/** Skip markets older than this — /prices-history has no trade data for
 *  zero-liquidity BTC 5m tokens beyond a small recent window. The PRIMARY
 *  cache-population mechanism is the T-0 inline write in phaseT0; this sweep
 *  is just a safety net for windows the worker missed during downtime, so
 *  bounding it to "the last day" keeps the bound on log noise tight. */
const SYNC_OUTCOMES_MAX_AGE_MS             = 24 * 60 * 60_000;

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
   * In-flight guard for boundary placement. tryPlaceBoundary can be called
   * concurrently from phaseTMinus3 (primary) AND phaseT0 Path E (retry) when
   * the primary path is still inside `recordOrder` (which awaits CLOB calls
   * and `waitForTokenBalance`, taking up to ~15s). Without this, both paths
   * pass the cycleActive=false gate AND the DB hasAutoOrderFor check (no row
   * inserted yet) → duplicate orders.
   *
   * Set synchronously at the entry of tryPlaceBoundary BEFORE any await so
   * the check+set is atomic on the JS event loop. Cleared in finally.
   */
  boundaryPlacementInFlight: boolean;
  /**
   * Echo: which mode the cycle's boundary order was placed in. Determines
   * which DCA scale (`echo_dca_scale` for armed, `echo_dca_scale_idle` for
   * idle) applies for the cycle's continuation orders. Reset to null on
   * cycle close. Unused for streak strategy.
   */
  cycleMode:          'idle' | 'armed' | null;
  /**
   * Echo defensive layer: ms timestamp of the most recent extreme streak
   * event (run end with |streak| ≥ `echo_defensive_streak_threshold`). When
   * the gap to now exceeds `echo_defensive_overdue_minutes`, bot enters
   * defensive mode. null = no extreme observed yet (treated as overdue).
   */
  lastExtremeStreakAt: number | null;
  /**
   * Inter-event gap stats from the 30-day backfill at startup. Stable for the
   * worker lifetime — used by the echo_state publish to give the FE p10/p50/p90
   * context so the user can calibrate `echo_defensive_overdue_minutes` against
   * actual historical gap distribution. null when backfill saw < 2 events.
   */
  defensiveGapStats: DefensiveGapStats | null;
  /**
   * Threshold values used the LAST time backfill ran. When EITHER threshold
   * changes (or defensive toggles off→on, or echo enabled at all), the tick
   * loop's `ensureBackfillFresh` detects the mismatch and re-runs backfill
   * so `lastExtremeStreakAt` + `defensiveGapStats` + `lastEchoTriggerAt`
   * reflect the live config.
   *
   * Both null when:
   *   - never backfilled (echo disabled at startup), OR
   *   - defensive disabled (no defensive backfill done) — only `trigger` is set
   *
   * Why two: `lastEchoTriggerAt` depends on `echo_trigger_streak`, while
   * `lastExtremeStreakAt` depends on `echo_defensive_streak_threshold`. A user
   * can change either independently — both must trigger a fresh scan.
   */
  backfillTriggerThreshold:   number | null;
  backfillDefensiveThreshold: number | null;
  /** In-flight guard: prevents concurrent backfills if the user changes config
   *  multiple times in quick succession. */
  backfillInFlight: boolean;
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
  /**
   * Echo strategy: ms timestamp of the most recent run end where |streak| ≥
   * `cfg.echo_trigger_streak`. Drives the arm window — bot only signals/places
   * orders while `now − lastEchoTriggerAt ≤ echo_window_minutes × 60_000`.
   * In-memory; bot won't trade for up to ~30min after a restart until a fresh
   * trigger arms (acceptable — restart-paused windows happen rarely).
   * Unused when `cfg.strategy === 'streak'`.
   */
  lastEchoTriggerAt: number | null;
  /**
   * Sliding window of recent arm-event timestamps (each arm = streak hit
   * ≥ echo_trigger_streak). Used to detect "chain events" — when ≥
   * `echo_chain_event_arm_count` arms occur within `echo_chain_event_window_min`,
   * a chain event is recorded (`lastChainEventAt = now`). Pruned to the
   * event window on each append.
   */
  recentArmTimestamps: number[];
  /**
   * Timestamp of the most recent chain event (≥N arms in window). Used by
   * the predictive defensive: when (now - lastChainEventAt) exceeds
   * `echo_chain_overdue_min`, the next chain is statistically due → bump
   * entry thresholds. null = never observed (defensive on by default).
   */
  lastChainEventAt: number | null;
  /**
   * Set of windowStarts (ms) for which Binance/Poly mismatch alert has
   * already been fired. Prevents spam when fetchStreakWithVolume runs
   * repeatedly within the same 5m window (T+4 retry loop). Pruned to bars
   * still within current streak lookback (48 bars × 5min).
   */
  alertedMismatchWindows: Set<number>;
  /**
   * Last published echo arm state (for transition-only emission). When the
   * computed state matches this AND `at` is recent (< ECHO_REPUBLISH_INTERVAL_MS),
   * we skip republish — keeps the bus quiet on the common path while still
   * providing a heartbeat so API restarts (which clear the in-memory snapshot
   * cache) recover within at most `ECHO_REPUBLISH_INTERVAL_MS`.
   * `armEndAt` distinguishes "armed at T1" vs "armed at T2 (refresh)" so
   * arm-refresh events still emit.
   */
  lastEchoStatePublished: {
    armed: boolean;
    armEndAt: number | null;
    defensiveActive: boolean;
    lastExtremeStreakAt: number | null;
    chainActive: boolean;
    at: number;
  } | null;
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

  /** Re-entry guard for the background outcome-sync pass. Prevents overlapping
   *  runs if a sync slow-path (Polymarket API hiccup) bleeds into the next
   *  TICK_MS — old run keeps going, next tick skips. */
  private syncOutcomesInFlight = false;

  constructor(
    private readonly bus: SignalBus,
  ) {}

  /** Latest bestBid for a token from WS (null if no tick received yet). */
  public getBestBid(tokenId: string): number | null {
    return this.shareBids.get(tokenId)?.bestBid ?? null;
  }

  /**
   * Determine window outcome from the LIVE Polymarket UP-token midpoint.
   *
   * Used at T-0 (= 5s before window close) when the Polymarket market has
   * near-perfect info on which way the candle will close. UP token at 0.99
   * ≈ certain UP; at 0.01 ≈ certain DOWN; near 0.5 ≈ uncertain. We use a
   * dead band [0.45, 0.55] → 'unknown' so a doji/whipsaw close doesn't get
   * forced into a wrong direction (caller falls back to Binance + cross-check).
   *
   * Returns 'unknown' when:
   *   - No Polymarket market exists for this window (e.g. Polymarket discovery
   *     hasn't picked it up yet, or coin not on Polymarket)
   *   - WS hasn't streamed any bid/ask for the UP token yet (tracker just
   *     started, or stale-feed)
   *   - Midpoint is in the dead band [0.45, 0.55] (genuine uncertainty)
   *
   * The 0.45/0.55 thresholds match the in-progress-icon dead band — keeps
   * the "what direction is the market thinking" semantics consistent.
   */
  private async livePolyOutcome(
    symbol: CoinSymbol, windowStart: number, windowEnd: number,
  ): Promise<'up' | 'down' | 'unknown'> {
    const { rows } = await getPool().query<{ token_up: string }>(
      `SELECT token_up FROM poly_clob_markets
        WHERE symbol = $1 AND window_start = $2 AND window_end = $3
        LIMIT 1`,
      [symbol, windowStart, windowEnd],
    );
    const tokenUp = rows[0]?.token_up;
    if (!tokenUp) return 'unknown';
    const cache = this.shareBids.get(tokenUp);
    if (!cache || cache.bestBid == null || cache.bestAsk == null) return 'unknown';
    const mid = (cache.bestBid + cache.bestAsk) / 2;
    if (mid > 0.55) return 'up';
    if (mid < 0.45) return 'down';
    return 'unknown';
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
    const state: CoinState = {
      symbol, poly, emitted: new Set(),
      cycleActive:        false,
      lastCycleOrderSize: null,
      dcaFiredCount:      0,
      cycleMode:          null,
      boundaryPlacementInFlight: false,
      lastExtremeStreakAt: null,
      defensiveGapStats:  null,
      backfillTriggerThreshold:   null,
      backfillDefensiveThreshold: null,
      backfillInFlight:   false,
      recentStreakAbs: [],
      lastEchoTriggerAt: null,
      recentArmTimestamps: [],
      lastChainEventAt: null,
      alertedMismatchWindows: new Set(),
      lastEchoStatePublished: null,
    };
    this.coins.set(symbol, state);
    log('info', `PriceMonitoringWorker: tracking ${symbol}`);

    // ── Restore from echo_state_cache (persisted by API on every event) ──
    // This MUST run before backfillEchoState so backfill can compare against
    // the persisted runtime value and keep the more recent of the two.
    //
    // Why: backfill scans 30d of Binance bars (close-vs-open). Real-time
    // T+4 detection uses fetchStreakWithVolume which trusts Polymarket
    // outcomes (commit 1769269) — these can disagree on individual bars,
    // so backfill's `lastTriggerAt` may be OLDER than the runtime-detected
    // value. Without this restore, every restart resets `lastEchoTriggerAt`
    // to the Binance-only result, dropping legitimate triggers seen by the
    // prior worker (verified prod 2026-05-07 09:45 UTC: prior PID detected
    // streak=5 at 06:44 UTC, restart's backfill found 04:05:50, arm window
    // ended 2.5h before user expected).
    await restoreEchoStateFromCache(state);

    // Backfill echo state from historical bars. Combined with the restore
    // above: keeps max(persisted, backfill) for both triggers + extreme.
    void backfillEchoState(state).catch(err => {
      log('warn', 'echo backfill failed', { symbol, error: String(err) });
    });
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

        // Re-backfill `lastExtremeStreakAt` + `defensiveGapStats` if user
        // changed `echo_defensive_streak_threshold` or toggled defensive on
        // since the last backfill. No-op when config matches.
        ensureBackfillFresh(state, cfg);

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

        // Heartbeat publish — every tick checks if echo_state needs to
        // republish (transition or > ECHO_REPUBLISH_INTERVAL_MS since last).
        // Cheap on the common path (just dedupe + clock check). Critical for
        // API restart recovery: without this, snapshot stays empty until the
        // next true state transition, which can be hours.
        void this.maybePublishEchoState(state, cfg);
      } catch (err) {
        log('warn', `PriceMonitoringWorker tick ${state.symbol} failed`, { error: String(err) });
      }
    }

    // Background outcome sync — runs once per tick across all coins. Internal
    // re-entry guard handles slow-API overlap. Fire-and-forget so per-coin
    // phase processing isn't blocked by Polymarket REST latency.
    void this.syncPendingOutcomes().catch(err => {
      log('warn', 'syncPendingOutcomes failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
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
    const streakResult = await fetchStreakWithVolume(state.symbol, windowStart);
    const { streak, volumeBuckets, bodyHasHigh, bodyHasTiny, meanBodyRatio,
            bodyHasVeryExtreme, mismatches, binanceStreak, body3Sum } = streakResult;
    const absStreak    = Math.abs(streak);

    // Surface Binance/Poly disagreements that affected streak interpretation.
    // Bot uses Poly truth (commit 1769269); Telegram alert lets user know
    // the streak count differs from chart visual. Dedupe per window so retries
    // within same 5m don't spam — alert fires ONCE per (coin, window).
    if (mismatches.length > 0) {
      const newMismatches = mismatches.filter(m => !state.alertedMismatchWindows.has(m.windowStart));
      for (const m of newMismatches) {
        state.alertedMismatchWindows.add(m.windowStart);
        log('warn', `Binance/Poly mismatch ${state.symbol}`, {
          windowStart: m.windowStart, windowEnd: m.windowEnd,
          binance: m.binanceDirection, poly: m.polyDirection,
          binanceMovePct: m.binanceMovePct.toFixed(3),
          binanceStreak, effectiveStreak: streak,
        });
        await this.bus.publish({
          type:               'streak_data_mismatch',
          coin:               state.symbol,
          windowStart:        m.windowStart,
          windowEnd:          m.windowEnd,
          binanceDirection:   m.binanceDirection,
          polyDirection:      m.polyDirection,
          binanceMovePct:     m.binanceMovePct,
          binanceStreak,
          effectiveStreak:    streak,
          emittedAt:          Date.now(),
        });
      }
      // Prune dedup set: drop entries older than 6h (well past current
      // streak lookback so we don't re-alert if streak walks back to them).
      const cutoff = Date.now() - 6 * 3600_000;
      for (const ts of state.alertedMismatchWindows) {
        if (ts < cutoff) state.alertedMismatchWindows.delete(ts);
      }
    }
    const expectedIcon = streak > 0 ? '🟢' : '🔴';
    // Fetch the in-progress candle direction up-front so the echo gate can
    // count it as +1 to the closed streak when it aligns. Streak strategy
    // also uses it (later gate) — single fetch keeps the round-trip cost
    // unchanged.
    const currentIcon = await fetchInProgressIcon(state.symbol, windowStart);

    // ── Echo arm bookkeeping ──────────────────────────────────────────────
    // Echo Hunt is a HYBRID: bot always trades using the streak baseline
    // (`auto_order_min_streak`); when a streak ≥ `echo_trigger_streak` ends,
    // the placement threshold drops to `echo_signal_min_streak` for the next
    // `echo_window_minutes`. After arm expires it reverts to the baseline.
    // This block only updates the arm timestamp + publishes state — the
    // actual threshold switch happens in `effectiveAutoMinStreak`.
    if (cfg.strategy === 'echo') {
      if (absStreak >= cfg.echo_trigger_streak) {
        // Set to windowEnd, NOT Date.now(). Armed mode kicks in from the
        // NEXT window onwards — the current bar that just armed the bot
        // is itself the contrarian setup, so user's baseline_streak still
        // gates its placement. Without this, trigger_streak (5) below
        // baseline_streak (8) would create a loophole where same-window
        // arm + fire bypasses baseline (verified prod 2026-05-13 06:59:
        // streak=5 detected at T+4, T-3s of same window fired despite
        // baseline=8). Effective from window close → armed valid for the
        // next echo_window_minutes from that moment.
        state.lastEchoTriggerAt = windowEnd;
        // Chain event detection — when ≥N arms cluster within the event
        // window, record a chain event. The predictive defensive then uses
        // (now - lastChainEventAt) vs overdue threshold. De-dup arm
        // timestamps per 5-min bucket so retries within same window don't
        // inflate the count.
        const now = Date.now();
        const bucketMs = 5 * 60_000;
        const lastArmTs = state.recentArmTimestamps[state.recentArmTimestamps.length - 1];
        if (lastArmTs == null || (now - lastArmTs) >= bucketMs) {
          state.recentArmTimestamps.push(now);
        }
        const eventWindowMs = (cfg.echo_chain_event_window_min ?? 60) * 60_000;
        state.recentArmTimestamps = state.recentArmTimestamps.filter(t => now - t <= eventWindowMs);
        if (state.recentArmTimestamps.length >= (cfg.echo_chain_event_arm_count ?? 2)) {
          state.lastChainEventAt = now;
        }
      }
      // Defensive tracker — record extreme streak observations so the
      // overdue-gap check in tryPlaceBoundary has data.
      if (absStreak >= cfg.echo_defensive_streak_threshold) {
        state.lastExtremeStreakAt = Date.now();
      }
      void this.maybePublishEchoState(state, cfg);
    }

    // Streak gate (notification threshold). For echo we count the in-progress
    // candle when it aligns — matches the +1 used by the placement gate at
    // T-3s, so the displayed signal aligns with what the bot will actually
    // place against. Streak strategy keeps closed-only semantics (legacy).
    const currentAligns = currentIcon === expectedIcon;
    const effectiveStreak = cfg.strategy === 'echo' && currentAligns
      ? absStreak + 1
      : absStreak;
    if (effectiveStreak < cfg.streak_min) {
      return {
        reason: cfg.strategy === 'echo'
          ? `echo: effective ${effectiveStreak} (closed ${absStreak}+${currentAligns ? 1 : 0} current) < streak_min ${cfg.streak_min}`
          : `streak ${streak} < min ${cfg.streak_min}`,
        persistentSkip: cfg.strategy !== 'echo',  // echo: re-eval next tick
      };
    }

    // V9 body filter does NOT block T+4 emit — it only adjusts the placement
    // threshold at T-3s (for idle mode). T+4 still emits notification when
    // streak_min is met regardless of body composition. See tryPlaceBoundary.

    const market = await state.poly.findMarketAt(Math.floor(windowStart / 1000));
    if (!market) {
      return { reason: `no market for ${state.symbol} @ ${windowStart}`, persistentSkip: true };
    }

    const direction: 'up' | 'down' = streak > 0 ? 'down' : 'up';   // contrarian
    const tokenId = direction === 'up' ? market.tokenUp : market.tokenDown;
    const book = await state.poly.getOrderBook(tokenId);
    const price = bestAskFromBook(book);

    // Alignment gate — current candle continues the streak direction.
    //
    // For STREAK strategy: keep the legacy hard reject (premise breaking).
    //
    // For ECHO strategy: only reject when current FLIPS. A current bar
    // moving in the OPPOSITE direction is actually the ideal fade setup —
    // it means the reversal is already starting mid-window, which is
    // exactly what we're betting on for N+1. Body3 (live, including the
    // in-progress bar) is the quality filter that decides whether the
    // reversal magnitude is meaningful enough to bet on.
    //
    // The doji case (currentIcon=⚪) keeps the reject for both — neutral
    // candle gives no signal either way and breaks contrarian premise.
    if (cfg.strategy !== 'echo') {
      if (currentIcon !== expectedIcon) {
        return {
          reason: `current ${currentIcon} ≠ expected ${expectedIcon}`,
          persistentSkip: false,
        };
      }
    } else if (currentIcon === '⚪') {
      return {
        reason: `current ${currentIcon} (doji) — no signal`,
        persistentSkip: false,
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
        bodyHasHigh,
        bodyHasTiny,
        meanBodyRatio,
        bodyHasVeryExtreme,
        body3Sum,
        limitCents:    cfg.limit_price_cents,
        emittedAt:     Date.now(),
      },
      persistentSkip: false,
    };
  }

  /**
   * Echo arm-state publisher. Computes current armed/armEndAt from state +
   * cfg and publishes when EITHER:
   *   (a) something changed since last publish (transition), OR
   *   (b) `ECHO_REPUBLISH_INTERVAL_MS` has elapsed since last publish (heartbeat)
   *
   * The heartbeat ensures API restart recovery: when API restarts its in-memory
   * `engine.echoStates` Map clears, and without a heartbeat the FE would stare
   * at empty echo panels until the next state transition (could be hours).
   * With heartbeat, recovery is bounded by ECHO_REPUBLISH_INTERVAL_MS.
   *
   * On the no-change common path (most ticks) this is a cheap dedupe check.
   */
  /**
   * Background sweep: query rows in `poly_clob_markets` that still have
   * `outcome IS NULL` past their `window_end + buffer`, fetch the resolved
   * outcome via Polymarket `/prices-history`, and write it back. Capped per
   * tick to avoid API rate-limit spam during fresh-instance backfill.
   *
   * Without this sweep, the cache only got populated as a side-effect of
   * `fetchStreakWithVolume` happening to verify a window — which only touches
   * the past `n` windows of the current streak (often 1-3). Older windows
   * stayed NULL forever, defeating the cross-check that depends on this cache
   * (manifested as Bug A — DCA wrongly skipped on a real loss).
   *
   * Fire-and-forget from the tick loop with `void`. Internal re-entry guard
   * (`syncOutcomesInFlight`) prevents pile-up if the API is slow.
   */
  private async syncPendingOutcomes(): Promise<void> {
    if (this.syncOutcomesInFlight) return;
    const exec = getClobExecutor();
    if (!exec) return;                                    // dev mode (no POLY_PRIVATE_KEY)

    this.syncOutcomesInFlight = true;
    try {
      const now             = Date.now();
      const cutoff          = now - SYNC_OUTCOMES_RESOLVE_BUFFER_MS;
      const retryAfter      = now - SYNC_OUTCOMES_RETRY_INTERVAL_MS;
      const minAge          = now - SYNC_OUTCOMES_MAX_AGE_MS;
      // Order DESC so newly-closed windows resolve first — those are the ones
      // the next tick's DCA / streak cross-check actually depends on. Cap by
      // age so the sweep doesn't keep hitting the API for permanently
      // unresolvable old markets — those are zero-liquidity tokens that
      // /prices-history doesn't have any data for.
      const { rows } = await getPool().query<{
        symbol: string; window_start: string; window_end: string; token_up: string;
      }>(
        `SELECT symbol, window_start, window_end, token_up
           FROM poly_clob_markets
          WHERE outcome IS NULL
            AND window_end < $1
            AND window_end > $4
            AND (outcome_fetched_at IS NULL OR outcome_fetched_at < $2)
          ORDER BY window_end DESC
          LIMIT $3`,
        [cutoff, retryAfter, SYNC_OUTCOMES_BATCH, minAge],
      );
      if (rows.length === 0) return;

      let synced = 0;
      let stillUnknown = 0;
      for (const r of rows) {
        const wStart = Number(r.window_start);
        const wEnd   = Number(r.window_end);
        try {
          const outcome = await exec.fetchResolvedOutcome(r.token_up, wEnd);
          if (outcome === 'up' || outcome === 'down') {
            await getPool().query(
              `UPDATE poly_clob_markets
                  SET outcome = $1, outcome_fetched_at = $2
                WHERE symbol = $3 AND window_start = $4`,
              [outcome, Date.now(), r.symbol, wStart],
            );
            synced++;
          } else {
            stillUnknown++;
            // Record the attempt so the retry-after gate skips this row for
            // SYNC_OUTCOMES_RETRY_INTERVAL_MS. Without this, every tick re-tries
            // the same permanently-unresolvable rows and they hog the batch.
            await getPool().query(
              `UPDATE poly_clob_markets
                  SET outcome_fetched_at = $1
                WHERE symbol = $2 AND window_start = $3`,
              [Date.now(), r.symbol, wStart],
            );
            const ageMs = Date.now() - wEnd;
            if (ageMs > SYNC_OUTCOMES_STALE_WARN_MS) {
              log('warn', 'syncPendingOutcomes: market still unresolved', {
                symbol: r.symbol, windowStart: wStart, ageMinutes: Math.round(ageMs / 60_000),
              });
            }
          }
        } catch (err) {
          log('warn', 'syncPendingOutcomes: fetchResolvedOutcome threw', {
            symbol: r.symbol, windowStart: wStart,
            error: err instanceof Error ? err.message : String(err),
          });
          // Continue — one bad row shouldn't block the rest of the batch.
        }
      }

      if (synced > 0 || stillUnknown > 0) {
        log('info', 'syncPendingOutcomes', {
          synced, stillUnknown, totalScanned: rows.length,
        });
      }
    } finally {
      this.syncOutcomesInFlight = false;
    }
  }

  private async maybePublishEchoState(state: CoinState, cfg: CoinConfig): Promise<void> {
    if (cfg.strategy !== 'echo') return;
    const now = Date.now();
    const armEndAt = state.lastEchoTriggerAt
      ? state.lastEchoTriggerAt + cfg.echo_window_minutes * 60_000
      : null;
    // Armed valid in [lastEchoTriggerAt, armEndAt]. lastEchoTriggerAt = end
    // of the triggering window, so armed only kicks in AFTER current window
    // closes — same-window arm + fire bypass of baseline_streak is prevented.
    const armed = state.lastEchoTriggerAt != null
      && armEndAt !== null
      && now >= state.lastEchoTriggerAt
      && now <= armEndAt;

    // Defensive layer state.
    const defensiveActivatesAt = state.lastExtremeStreakAt != null
      ? state.lastExtremeStreakAt + cfg.echo_defensive_overdue_minutes * 60_000
      : null;
    const defensiveActive = cfg.echo_defensive_enabled
      && (defensiveActivatesAt == null || now > defensiveActivatesAt);

    // Compute chain regime state — bump thresholds when active.
    const chain = computeChainState(state, cfg);

    // Re-publish on any state transition: armed, armEndAt, defensive active,
    // chain active, or extreme observation timestamp. The latter matters
    // even when defensive flag doesn't flip — FE needs the fresh timestamp
    // to compute the live countdown to next defensive activation.
    const last = state.lastEchoStatePublished;
    const same = last
      && last.armed === armed
      && last.armEndAt === armEndAt
      && last.defensiveActive === defensiveActive
      && last.lastExtremeStreakAt === state.lastExtremeStreakAt
      && last.chainActive === chain.active;
    const heartbeatDue = !last || (now - last.at) >= ECHO_REPUBLISH_INTERVAL_MS;
    if (same && !heartbeatDue) return;
    state.lastEchoStatePublished = {
      armed, armEndAt, defensiveActive,
      lastExtremeStreakAt: state.lastExtremeStreakAt,
      chainActive: chain.active,
      at: now,
    };
    // Effective threshold reflects defensive AND chain overrides (additive).
    let threshold = armed ? cfg.echo_signal_min_streak : cfg.echo_baseline_streak;
    if (defensiveActive && cfg.echo_defensive_action === 'disable_armed' && armed) {
      threshold = cfg.echo_baseline_streak;
    }
    const sigBump = chain.active ? cfg.echo_chain_signal_bump   : 0;
    const baseBump = chain.active ? cfg.echo_chain_baseline_bump : 0;
    if (chain.active) {
      threshold += armed ? sigBump : baseBump;
    }
    await this.bus.publish<SignalEchoStateEvent>({
      type:                  'echo_state',
      coin:                  state.symbol,
      armed,
      lastTriggerAt:         state.lastEchoTriggerAt,
      armEndAt,
      threshold,
      baselineThreshold:     cfg.echo_baseline_streak,
      armedThreshold:        cfg.echo_signal_min_streak,
      triggerThreshold:      cfg.echo_trigger_streak,
      defensiveEnabled:      cfg.echo_defensive_enabled,
      defensiveActive,
      defensiveAction:       cfg.echo_defensive_action,
      lastExtremeStreakAt:   state.lastExtremeStreakAt,
      defensiveActivatesAt,
      defensiveStreakThreshold: cfg.echo_defensive_streak_threshold,
      defensiveOverdueMinutes:  cfg.echo_defensive_overdue_minutes,
      defensiveGapStats:        state.defensiveGapStats,
      // Chain predictive defensive
      chainEnabled:             cfg.echo_chain_enabled,
      chainActive:              chain.active,
      chainLastEventAt:         state.lastChainEventAt,
      chainGapMinutes:          chain.gapMin,
      chainArmsInWindow:        chain.armsInWindow,
      chainEventArmCount:       cfg.echo_chain_event_arm_count,
      chainEventWindowMinutes:  cfg.echo_chain_event_window_min,
      chainOverdueMinutes:      cfg.echo_chain_overdue_min,
      chainActivatesAt:         chain.activatesAt,
      chainSignalBumpApplied:   sigBump,
      chainBaselineBumpApplied: baseBump,
      emittedAt:             now,
    });
    log('info', `echo state ${state.symbol}`, {
      armed, threshold, defensiveActive, chainActive: chain.active,
      chainGapMin: chain.gapMin,
      lastTriggerAt: state.lastEchoTriggerAt,
      armEndAt, defensiveActivatesAt,
    });
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
    // Echo Hunt — hybrid threshold:
    //   armed (within echo_window_minutes of the last trigger ≥ echo_trigger_streak)
    //     → echo_signal_min_streak (lowered, more aggressive)
    //   idle (no recent trigger or arm expired)
    //     → echo_baseline_streak (echo's own baseline — independent from streak
    //       strategy's auto_order_min_streak so the two strategies don't interfere)
    // No hour-of-day schedule or small-adjust on echo — the arm window IS
    // the adaptive layer here.
    if (cfg.strategy === 'echo') {
      // Armed valid in [lastEchoTriggerAt, armEndAt]. lastEchoTriggerAt =
      // end of the window that triggered arming, so the same-window
      // placement uses baseline (not armed signal_min). Armed mode kicks
      // in from the NEXT window onwards — preserves baseline as the floor
      // for the bar that creates the contrarian setup.
      const now = Date.now();
      const armed = state.lastEchoTriggerAt != null
        && now >= state.lastEchoTriggerAt
        && (now - state.lastEchoTriggerAt) <= cfg.echo_window_minutes * 60_000;
      // Chain predictive defensive — bump thresholds when last chain event
      // is "overdue" (gap > echo_chain_overdue_min). Statistical lift modest
      // (~1.25x at 32-64h gap range) but reduces compound-loss risk on the
      // anticipated next chain.
      const chain = computeChainState(state, cfg);
      const chainNote = chain.active
        ? (chain.gapMin != null
            ? `CHAIN overdue ${chain.gapMin}m > ${cfg.echo_chain_overdue_min}m`
            : `CHAIN — no event observed yet`)
        : null;
      if (armed) {
        const minLeft = Math.max(0, Math.round(
          (state.lastEchoTriggerAt! + cfg.echo_window_minutes * 60_000 - Date.now()) / 60_000,
        ));
        const baseSig = cfg.echo_signal_min_streak;
        const threshold = chain.active ? baseSig + cfg.echo_chain_signal_bump : baseSig;
        const reason = chainNote
          ? `echo armed (${chainNote}, threshold ${baseSig}→${threshold}) — ${minLeft}m left in arm window`
          : `echo armed — ${minLeft}m left in arm window (signal_min=${baseSig})`;
        return { threshold, mode: 'aggressive', reason };
      }
      const baseIdle = cfg.echo_baseline_streak;
      const threshold = chain.active ? baseIdle + cfg.echo_chain_baseline_bump : baseIdle;
      const reason = chainNote
        ? `echo idle (${chainNote}, threshold ${baseIdle}→${threshold})`
        : `echo idle — using baseline echo_baseline_streak=${baseIdle}`;
      return { threshold, mode: chain.active ? 'conservative' : 'default', reason };
    }
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
    // Concurrency guard — phaseTMinus3 (setTimeout) and phaseT0 Path E (tick)
    // can both reach here while the other's prior `recordOrder` is still
    // awaiting CLOB / waitForTokenBalance (~15s). Without this guard both
    // callers see cycleActive=false AND hasAutoOrderFor=false (no DB row yet),
    // both pass gates, both call recordOrder → duplicate orders.
    //
    // Synchronous check + set: safe on the JS event loop since neither
    // operation awaits between them. The flag is cleared in finally.
    if (state.boundaryPlacementInFlight) {
      return {
        placed: false,
        reason: 'boundary placement already in flight (skip duplicate)',
      };
    }
    state.boundaryPlacementInFlight = true;
    try {
    // Compute adaptive threshold up-front so callers always get context —
    // even when a non-threshold gate fails (ask too high, market missing etc).
    // `base` = the unadjusted baseline threshold:
    //   streak: auto_order_min_streak (schedule + small-adjust may bump up).
    //   echo:   echo_baseline_streak  (arm window may DROP to echo_signal_min_streak).
    const base = cfg.strategy === 'echo' ? cfg.echo_baseline_streak : cfg.auto_order_min_streak;
    let adapt = this.effectiveAutoMinStreak(state, cfg);

    // ── Defensive regime check (echo only) ─────────────────────────────────
    // If too long has passed since the last extreme streak, bot is in a
    // quiet regime — empirically followed by outsized moves. Either suspend
    // placement entirely or force idle threshold (don't drop to armed).
    if (cfg.strategy === 'echo' && cfg.echo_defensive_enabled) {
      const overdueMs = cfg.echo_defensive_overdue_minutes * 60_000;
      const gap = state.lastExtremeStreakAt != null
        ? Date.now() - state.lastExtremeStreakAt
        : Infinity;   // never observed → treat as overdue (safe default)
      const isOverdue = gap > overdueMs;
      if (isOverdue) {
        const gapLabel = gap === Infinity ? 'never observed'
          : `${Math.round(gap / 60_000)}m ago, threshold ${cfg.echo_defensive_overdue_minutes}m`;
        if (cfg.echo_defensive_action === 'skip_all') {
          return {
            placed: false,
            reason: `defensive: extreme streak ${gapLabel} — skip_all action`,
            adaptive: { base, ...adapt },
          };
        }
        // 'disable_armed' — keep armed mode from lowering threshold below baseline.
        if (adapt.mode === 'aggressive') {
          adapt = {
            threshold: cfg.echo_baseline_streak,
            mode: 'default',
            reason: `defensive: extreme ${gapLabel} → armed disabled, using baseline ${cfg.echo_baseline_streak}`,
          };
        }
      }
    }
    // V9 body filter — IDLE mode only. When the streak has no high-body bar
    // (>1.5× avg), the run is "grinding" without an impulse leg → contrarian
    // bets there bleed at idle baseline. Bump threshold +2 so the bot waits
    // for a longer streak. Armed mode bypasses — its natural edge is strong.
    const idleNoHighBody = cfg.strategy === 'echo'
      && cfg.echo_require_high_body
      && adapt.mode === 'default'
      && t4.bodyHasHigh === false;
    const threshold = idleNoHighBody ? adapt.threshold + 2 : adapt.threshold;
    const reason    = idleNoHighBody
      ? `echo idle + no high-body bar → bumped threshold to ${threshold} (= ${adapt.threshold}+2)`
      : adapt.reason;
    const adaptive = { base, threshold, mode: adapt.mode, reason };
    if (adapt.mode !== 'default' || idleNoHighBody) {
      log('info', `adaptive threshold ${state.symbol}`, {
        base, threshold, mode: adapt.mode, reason,
        bodyHasHigh: t4.bodyHasHigh,
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

    // Gate 1: alignment of current in-progress bar.
    //
    // STREAK strategy: hard reject if current ≠ streak direction (legacy).
    // ECHO   strategy: only reject on doji (⚪). Current going OPPOSITE to
    //                  streak is the ideal fade setup (reversal mid-window)
    //                  — body3 below decides whether magnitude qualifies.
    const currentIcon = await fetchInProgressIcon(state.symbol, t4.windowStart);
    const expectedIcon = t4.streak > 0 ? '🟢' : '🔴';
    const currentAligns = currentIcon === expectedIcon;
    if (cfg.strategy !== 'echo') {
      if (!currentAligns) {
        return {
          placed: false,
          reason: `current flipped to ${currentIcon} (streak ${expectedIcon})`,
          adaptive,
        };
      }
    } else if (currentIcon === '⚪') {
      return {
        placed: false,
        reason: `current ${currentIcon} (doji) — no signal`,
        adaptive,
      };
    }

    const absStreak = Math.abs(t4.streak);

    // Gate 2: effective streak ≥ threshold, with optional edge-case overrides.
    // When the normal gate fails AND the streak's body composition matches
    // an enabled edge case (idle echo only), fire anyway. See `EchoEdgeCase`
    // for the available patterns and statistical rationale.
    //
    // effectiveStreak = closed streak + 1 IFF current bar continues the
    // streak. If current flipped (echo only, when we accept it), the
    // closed streak has ENDED at the current bar — don't add the +1.
    const effectiveStreak = absStreak + (currentAligns ? 1 : 0);
    if (effectiveStreak < threshold) {
      const overrideName = adapt.mode === 'default' && cfg.strategy === 'echo'
        ? matchEchoEdgeCase(
            cfg.echo_edge_cases ?? [],
            absStreak,
            t4,
            cfg.echo_short_streak_body3_min ?? 0,
          )
        : null;
      if (overrideName) {
        log('info', `echo edge-case override fires ${state.symbol}`, {
          edgeCase: overrideName,
          streak: t4.streak, effectiveStreak, threshold,
          meanBodyRatio: t4.meanBodyRatio,
          bodyHasVeryExtreme: t4.bodyHasVeryExtreme,
          body3Sum: t4.body3Sum,
        });
        // Annotate adaptive so downstream events show why we fired.
        adaptive.reason = `${reason} → override [${overrideName}]`;
      } else {
        return {
          placed: false,
          reason: `effective streak ${effectiveStreak} (closed ${absStreak}+1 current) < auto_min ${threshold} [${reason}]`,
          adaptive,
        };
      }
    }

    // Gate 2b: body-3 minimum (idle vs armed). Quality filter on top of the
    // streak threshold — cuts low-edge fades. Empirical (BTC 365d):
    //   streak=5 + body3 ≥ $400 → P(reversal)=62.7%, P(trapped to 7+)=13%
    //   streak=5 + body3 < $300 → P(reversal)=46-52%, P(trapped)=23-29%
    // Bypasses if cfg.*_body3_min = 0 (default — preserves prior behavior).
    // DCA continuation uses its own gate inside tryPlaceDcaAtBoundary.
    //
    // Refresh body3 from LIVE bars at T-3s (or whatever current call time is):
    //   liveBars = [bar-2 closed, bar-1 closed, current in-progress]
    // The current in-progress bar's body matters most — at T-3s it's ~99%
    // formed and reflects the FRESH momentum the bot is fading. Falling back
    // to t4.body3Sum (3 closed bars at T+4) is fine if the fetch fails.
    const armedMode = adapt.mode === 'aggressive';
    const body3Min  = armedMode ? cfg.armed_body3_min : cfg.idle_body3_min;
    let body3Sum    = t4.body3Sum ?? 0;
    let body3Src: 'live' | 't4_fallback' = 't4_fallback';
    if (body3Min > 0) {
      const liveBars = await fetchBars(
        state.symbol,
        t4.windowStart - 2 * WINDOW_MS,
        Date.now(),
        3,
      );
      if (liveBars.length >= 2) {
        body3Sum = liveBars.reduce((s, b) => s + Math.abs(b.close - b.open), 0);
        body3Src = 'live';
      }
    }
    if (body3Min > 0 && body3Sum < body3Min) {
      return {
        placed: false,
        reason: `body3 $${body3Sum.toFixed(0)} (${body3Src}) < ${armedMode ? 'armed' : 'idle'}_body3_min $${body3Min}`,
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
        // FAK cap = user's limit_price_cents (max acceptable fill price), NOT
        // the observed ask. Lets the order sweep deeper levels when top-of-book
        // is thin instead of FAK-killing at the exact ask price.
        maxPrice:       cfg.limit_price_cents / 100,
        sizeUsdc:       orderSize,
        source:         'auto',
        signalPath,
        tpCents:        cfg.tp_cents,
        slCents:        cfg.sl_cents,
        streakAtSignal: absStreak,
      });

      // Cycle starts. Tag the cycle's mode so DCA continuation picks the
      // right scale (idle vs armed) — echo only.
      state.cycleActive        = true;
      state.cycleDirection     = direction;
      state.lastCycleOrderSize = null;
      state.dcaFiredCount      = 0;
      state.cycleMode          = cfg.strategy === 'echo'
        ? (adapt.mode === 'aggressive' ? 'armed' : 'idle')
        : null;
      log('info', `Boundary placed (cycle start) ${state.symbol}`, {
        streakAbs: absStreak, direction, size: orderSize, cycleMode: state.cycleMode,
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
    } finally {
      state.boundaryPlacementInFlight = false;
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
    /**
     * The just-closed window's verified outcome (per Polymarket midpoint at T-0).
     * Required so the streak-direction sanity gate below trusts livePolyOutcome
     * instead of falling back to Binance close-vs-open via fetchStreakWithVolume,
     * which can disagree when the Binance candle direction differs from the
     * Polymarket resolution AND poly_clob_markets cache hasn't been synced yet
     * (typical window-just-closed scenario; live `/prices-history` returns
     * 'unknown' for ~30-60s after T-0). Without this, DCA was incorrectly
     * skipped on losses where Binance happened to call the candle the other
     * way — verified in prod 2026-05-05 08:04:58 BTC, $5 loss with no DCA.
     */
    justClosedOutcome: 'up' | 'down',
  ): Promise<void> {
    if (!state.cycleActive || state.cycleDirection == null) return;

    const nextWindowStart = justClosedWindowStart + WINDOW_MS;

    // Compute streak as of nextWindowStart — includes the just-closed loss.
    const { streak, body3Sum } = await fetchStreakWithVolume(state.symbol, nextWindowStart);
    const absStreak = Math.abs(streak);
    const direction = state.cycleDirection;

    // Body-3 DCA gate: averaging down only when the trend's 3-bar body sum
    // still signals exhaustion. After a loss the streak has just extended
    // by 1; we recompute body3 on the new bar set. Threshold picked by the
    // ORIGINAL cycle mode (mirrors echo_dca_scale_idle vs echo_dca_scale).
    // Skip DCA if body3 < the relevant min. 0 = disabled.
    const dcaBody3Min = state.cycleMode === 'armed'
      ? cfg.dca_body3_min_armed
      : cfg.dca_body3_min_idle;
    if (dcaBody3Min > 0 && body3Sum < dcaBody3Min) {
      log('info', `DCA skip ${state.symbol}: body3 $${body3Sum.toFixed(0)} < dca_body3_min_${state.cycleMode ?? 'idle'} $${dcaBody3Min}`, {
        nextWindowStart, streak, cycleMode: state.cycleMode,
      });
      return;
    }

    if (cfg.strategy === 'echo') {
      // Defensive: if regime is overdue (long quiet stretch precedes outsized
      // moves), don't double-down on a losing cycle — let the loss cap at the
      // boundary entry size and wait for things to clear. Applies regardless
      // of the configured action ('disable_armed' vs 'skip_all').
      if (cfg.echo_defensive_enabled) {
        const overdueMs = cfg.echo_defensive_overdue_minutes * 60_000;
        const gap = state.lastExtremeStreakAt != null
          ? Date.now() - state.lastExtremeStreakAt
          : Infinity;
        if (gap > overdueMs) {
          const gapLabel = gap === Infinity ? 'never observed'
            : `${Math.round(gap / 60_000)}m ago, threshold ${cfg.echo_defensive_overdue_minutes}m`;
          log('info', `DCA skip ${state.symbol}: defensive (extreme ${gapLabel})`);
          return;
        }
      }
      // Pick scale by cycle's mode at open time:
      //   armed cycle → echo_dca_scale (always).
      //   idle cycle  → echo_dca_scale_idle if non-empty, else fall back.
      // Bounded by array length (no infinite compounding).
      const scale = (state.cycleMode === 'idle' && (cfg.echo_dca_scale_idle ?? []).length > 0)
        ? cfg.echo_dca_scale_idle
        : cfg.echo_dca_scale;
      if ((scale ?? []).length === 0) {
        log('info', `DCA skip ${state.symbol}: echo scale empty (DCA disabled for ${state.cycleMode})`);
        return;
      }
      if (state.dcaFiredCount >= scale.length) {
        log('info', `DCA skip ${state.symbol}: echo ${state.cycleMode} dcaFiredCount ${state.dcaFiredCount} ≥ scale length ${scale.length}`);
        return;
      }
    } else {
      // Streak strategy — whitelist gate (legacy). Empty = always fire on loss.
      const whitelist = cfg.dca_streak_whitelist ?? [];
      if (whitelist.length > 0 && !whitelist.includes(absStreak)) {
        log('info', `DCA skip ${state.symbol}: streak ${absStreak} ∉ whitelist [${whitelist.join(',')}]`, {
          nextWindowStart, direction,
        });
        return;
      }
    }

    // Sanity: the just-closed window's outcome must still oppose our
    // (contrarian) bet. We're in the loss branch, so by construction
    // justClosedOutcome !== direction — but we keep this gate as a runtime
    // assertion in case the caller's branching ever changes.
    //
    // Why use `justClosedOutcome` (T-0 verified) instead of `streak > 0`:
    // fetchStreakWithVolume's verify step can return the wrong direction
    // for the just-closed window when Binance close-vs-open disagrees with
    // Polymarket resolution AND the Poly cache hasn't synced yet (live API
    // returns 'unknown' for ~30-60s after T-0). Trusting the T-0 midpoint
    // we already computed avoids that race entirely.
    if (justClosedOutcome === direction) {
      log('warn', `DCA skip ${state.symbol}: just-closed outcome matches our bet (caller bug — should be loss branch only)`, {
        nextWindowStart, justClosedOutcome, cycleDirection: direction, streak,
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

    // DCA size:
    //   echo: flat scale → cfg.size_usdc × scale[dcaFiredCount]  (no compounding)
    //   streak: legacy compound → lastSize × dca_multiplier
    let orderSize: number;
    if (cfg.strategy === 'echo') {
      const scale = (state.cycleMode === 'idle' && (cfg.echo_dca_scale_idle ?? []).length > 0)
        ? cfg.echo_dca_scale_idle
        : cfg.echo_dca_scale;
      const scaleIdx = state.dcaFiredCount;   // 0-based, validated above
      const mult     = scale[scaleIdx]!;
      orderSize      = cfg.size_usdc * mult;
    } else {
      const baseSize = state.lastCycleOrderSize ?? cfg.size_usdc;
      orderSize      = baseSize * cfg.dca_multiplier;
    }

    try {
      const r = await recordOrder({
        conditionId:    market.conditionId,
        direction,
        sharePrice:     ask,
        maxPrice:       cfg.limit_price_cents / 100,   // FAK cap — see boundary call site
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

    // PRIMARY outcome source: live Polymarket UP-token midpoint at T-0.
    // The 5s before window close, the market has near-perfect info on which
    // way the candle will close. This avoids the Binance/Chainlink discrepancy
    // problem where bot saw outcome=down but Polymarket resolved up (or vice
    // versa). Falls back to the source-vs-poly cross-check (Binance kline +
    // poly_clob_markets.outcome) when WS midpoint isn't available — which is
    // the only path used during backfill / restart since live WS isn't
    // retroactive.
    let outcome = await this.livePolyOutcome(state.symbol, windowStart, windowEnd);
    if (outcome === 'unknown') {
      outcome = await fetchWindowOutcome(state.symbol, windowStart, windowEnd);
    }

    // Persist the just-computed outcome to poly_clob_markets cache. This is
    // the PRIMARY mechanism for populating that cache — the background
    // syncPendingOutcomes sweep using /prices-history is unreliable for
    // BTC 5m up/down tokens (verified empirically 2026-05-05: API returns
    // empty history for our tokens because they have near-zero trading
    // volume, so the resolved-from-trade-price approach can't work).
    //
    // livePolyOutcome reads the WS midpoint at T-0, which is the de-facto
    // resolution signal regardless of whether trades occurred. Writing it
    // here means downstream cross-checks (fetchStreakWithVolume) find a
    // ground-truth value within milliseconds of T-0.
    if (outcome !== 'unknown') {
      void getPool().query(
        `UPDATE poly_clob_markets
            SET outcome = $1, outcome_fetched_at = $2
          WHERE symbol = $3 AND window_start = $4 AND outcome IS NULL`,
        [outcome, Date.now(), state.symbol, windowStart],
      ).catch(err => {
        log('warn', 'phaseT0: outcome cache write failed', {
          symbol: state.symbol, windowStart,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

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
        state.cycleMode          = null;
      } else {
        // Loss → cycle continues. Fire DCA for the next window NOW that we
        // know the loss is real and the streak length includes it. Whitelist
        // gate (e.g. [4]) is checked inside; silent skip on miss.
        // Pass the verified T-0 outcome so DCA's streak-direction gate uses
        // Polymarket truth instead of Binance close-vs-open (which can
        // disagree, causing wrongful DCA skips — see fn comment).
        await this.tryPlaceDcaAtBoundary(state, cfg, windowStart, outcome);
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
        maxPrice:       cfg.limit_price_cents / 100,   // FAK cap — see boundary call site
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

    let exitPrice    = bid;          // simulate-mode fallback
    let actualShares = sharesOwned;
    if (o.mode === 'live') {
      const ex = getClobExecutor();
      if (!ex) {
        log('warn', 'cancel skipped — live mode but no executor', { orderId: o.id });
        return null;
      }
      try {
        const fill = await ex.placeMarketSell(tokenId, sharesOwned);
        if (fill.filledShares <= 0 || !Number.isFinite(fill.avgFillPrice)) {
          log('warn', 'cancel CLOB sell: 0 shares filled, leaving pending', {
            orderId: o.id, requested: sharesOwned, fill,
          });
          return null;
        }
        exitPrice    = fill.avgFillPrice;
        actualShares = fill.filledShares;
      } catch (err) {
        log('warn', 'cancel CLOB sell failed, leaving pending', {
          orderId: o.id, error: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    }

    const pnl = (exitPrice - Number(o.share_price)) * actualShares;
    const now = Date.now();

    await pool.query(
      `UPDATE poly_orders
          SET status='closed', pnl_usdc=$1, exit_price=$2,
              close_reason=$3, resolved_at=$4
        WHERE id=$5 AND status='pending' AND side='buy'`,
      [pnl, exitPrice, closeReason, now, o.id],
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
      entry: o.share_price, bid_at_trigger: bid,
      actual_exit: exitPrice, pnl: pnl.toFixed(2),
    });
    return {
      orderId:    o.id,
      direction:  o.direction,
      entryPrice: Number(o.share_price),
      sizeUsdc:   Number(o.size_usdc),
      signalPath: (o.signal_path === 'dca' ? 'dca' : 'boundary'),
      pnlUsdc:    pnl,
      exitPrice:  exitPrice,
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
  /**
   * True if at least one streak bar has body (|close-open|) > 1.5× the avg
   * body of the 48-bar baseline. A "high body" bar inside the streak is the
   * primary signal that momentum is impulsive (vs grinding) — empirically
   * +2.2% reversal-rate edge on BTC 180d. Used by echo strategy's optional
   * `echo_require_high_body` gate.
   */
  bodyHasHigh: boolean;
  /** True if at least one bar has body < 0.5× avg (informational). */
  bodyHasTiny: boolean;
  /** Mean body ratio across streak bars (= avg(streak body) / avg(48-bar body)).
   *  Drives edge case A1 (strong-mean override). */
  meanBodyRatio: number;
  /** True if any streak bar has body > 4× avg (extreme climax candle).
   *  Drives edge case A3 (mid-streak very-extreme override). */
  bodyHasVeryExtreme: boolean;
  /**
   * Binance/Poly direction disagreements detected within the visible streak
   * window (the bars that would-have-been-streak per Binance). Each entry
   * tells which bar disagreed and how it affected the effective streak.
   *
   * Empty when no disagreement OR when all disagreements were outside the
   * visible streak window. Caller (PMW) dedupes by windowStart to avoid
   * spam on retries within the same 5m window.
   */
  mismatches: Array<{
    windowStart: number;
    windowEnd: number;
    binanceDirection: 'up' | 'down';
    polyDirection: 'up' | 'down';
    /** Binance close - open as % of open. Tiny values (< 0.05%) flag near-flat
     *  bars where Chainlink/Binance routing inherently can disagree. */
    binanceMovePct: number;
  }>;
  /** Streak length per Binance-only (no Poly override). When > |streak|,
   *  Poly disagreement shortened it. Informational for the alert message. */
  binanceStreak: number;
  /**
   * Sum of |close − open| over the last 3 CLOSED bars before windowStart.
   * Units = price USD (BTC ≈ tens to thousands, ETH ≈ ones to hundreds).
   * Drives the body-conditioned entry gate (CoinConfig.idle_body3_min /
   * armed_body3_min / dca_body3_min).
   *
   * Empirical (BTC 365d): at streak=5, body3 ≥ $400 → P(reversal)=62.7% and
   * P(trapped to 7+)=13.3%; body3 < $300 at same streak → P(reversal) only
   * 46-52% and P(trapped) 23-29%. Filter cuts low-quality fades.
   *
   * When fewer than 3 bars are loaded, body3Sum = 0 (gate skipped — same as
   * "filter disabled" behavior).
   */
  body3Sum: number;
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
    return {
      streak: 0, volumeBuckets: [], bodyHasHigh: false, bodyHasTiny: false,
      meanBodyRatio: 0, bodyHasVeryExtreme: false,
      mismatches: [], binanceStreak: 0, body3Sum: 0,
    };
  }

  // Stale data check: most recent bar's open should be ~5min before windowStart.
  const latestBarOpen = startTime + (bars.length - 1) * WINDOW_MS;
  if ((windowStart - latestBarOpen) > 2 * WINDOW_MS) {
    log('warn', 'fetchStreakWithVolume: stale latest bar (data feed lag?)', {
      symbol, windowStart, latestBarOpen,
      lagMs: windowStart - latestBarOpen,
    });
  }

  // ── Streak from Binance close-vs-open (chart-visual semantic) ──────────
  // Bot detects arm windows / streaks based on what user sees on the chart.
  // Polymarket's binary resolution is used SEPARATELY for outcome at T-0
  // (livePolyOutcome / Bug 1 fix path) — that's about payout truth, not
  // chart pattern.
  //
  // Earlier design (commit 1769269) used Poly per-bar to override Binance,
  // which produced "missing arms" when Poly disagreed on tiny-move bars
  // (verified prod 2026-05-10 13:30 UTC: 6-bar UP streak on chart, Poly
  // disagreed on bar 13:10 +0.014%, bot saw effective streak=3 → no arm
  // even though chart visual was clearly 6 UP). User expectation: arm
  // tracks chart visual.
  //
  // Mismatch detection still queries Poly cache to alert user when the
  // bot's chart-based streak diverges from Poly's binary resolution —
  // informational so user knows their bet might resolve differently.
  const binanceOutcomes: ('up' | 'down' | 'doji')[] = bars.map(b =>
    b.close > b.open ? 'up' : b.close < b.open ? 'down' : 'doji',
  );

  const newest = binanceOutcomes[binanceOutcomes.length - 1];
  if (!newest || newest === 'doji') {
    return {
      streak: 0, volumeBuckets: [], bodyHasHigh: false, bodyHasTiny: false,
      meanBodyRatio: 0, bodyHasVeryExtreme: false,
      mismatches: [], binanceStreak: 0, body3Sum: 0,
    };
  }

  let n = 0;
  for (let i = binanceOutcomes.length - 1; i >= 0; i--) {
    if (binanceOutcomes[i] !== newest) break;   // doji breaks
    n++;
  }
  const streak = newest === 'up' ? n : -n;
  const binanceStreak = streak;   // synonymous post-revert; kept in event payload

  // ── Mismatch detection (info-only, doesn't affect streak) ──────────────
  // Query Poly cache for bars in the visible streak window; flag bars where
  // Poly direction disagrees with Binance. PMW publishes 'streak_data_mismatch'
  // events for each (deduped) so user gets Telegram alert when their
  // chart-based bet might resolve against them at T-0.
  const allWindowStarts: number[] = bars.map((_, i) => startTime + i * WINDOW_MS);
  const visibleStart = bars.length - n;
  const visibleWindowStarts = allWindowStarts.slice(visibleStart);
  const { rows: cachedOutcomes } = visibleWindowStarts.length > 0
    ? await getPool().query<{ window_start: string; outcome: string | null }>(
        `SELECT window_start, outcome FROM poly_clob_markets
          WHERE symbol = $1 AND window_start = ANY($2::bigint[])`,
        [symbol, visibleWindowStarts],
      )
    : { rows: [] as Array<{ window_start: string; outcome: string | null }> };
  const polyMap = new Map<number, 'up' | 'down'>();
  for (const r of cachedOutcomes) {
    if (r.outcome === 'up' || r.outcome === 'down') {
      polyMap.set(Number(r.window_start), r.outcome);
    }
  }
  const mismatches: StreakResult['mismatches'] = [];
  for (let i = visibleStart; i < bars.length; i++) {
    const polyOut = polyMap.get(allWindowStarts[i]!);
    const binOut  = binanceOutcomes[i]!;
    if (polyOut && (binOut === 'up' || binOut === 'down') && polyOut !== binOut) {
      const bar = bars[i]!;
      const movePct = bar.open > 0 ? ((bar.close - bar.open) / bar.open) * 100 : 0;
      mismatches.push({
        windowStart: allWindowStarts[i]!,
        windowEnd:   allWindowStarts[i]! + WINDOW_MS,
        binanceDirection: binOut,
        polyDirection:    polyOut,
        binanceMovePct: movePct,
      });
    }
  }

  const avgVol = bars.reduce((a, b) => a + b.volume, 0) / bars.length;
  const streakBars = bars.slice(-n);
  const volumeBuckets = streakBars.map(b => bucketize(b.volume, avgVol));

  // Body composition — body is |close − open|. Compute several metrics over
  // the streak's bars (each compared to the 48-bar avg body), feeding both
  // the V9 high-body gate AND the optional edge-case overrides A1 / A3.
  const avgBody = bars.reduce((a, b) => a + Math.abs(b.close - b.open), 0) / bars.length;
  let bodyHasHigh        = false;
  let bodyHasTiny        = false;
  let bodyHasVeryExtreme = false;
  let sumRatios          = 0;
  if (avgBody > 0) {
    for (const b of streakBars) {
      const ratio = Math.abs(b.close - b.open) / avgBody;
      sumRatios += ratio;
      if (ratio > 1.5) bodyHasHigh = true;
      if (ratio < 0.5) bodyHasTiny = true;
      if (ratio > 4.0) bodyHasVeryExtreme = true;
    }
  }
  const meanBodyRatio = streakBars.length > 0 ? sumRatios / streakBars.length : 0;

  // Body-3 gate input: |close-open| sum over the LAST 3 closed bars before
  // windowStart (regardless of direction — within a streak ≥ 3 these are all
  // same direction by definition; for streak < 3 the sum is informational).
  let body3Sum = 0;
  for (const b of bars.slice(-3)) body3Sum += Math.abs(b.close - b.open);

  return {
    streak, volumeBuckets, bodyHasHigh, bodyHasTiny, meanBodyRatio, bodyHasVeryExtreme,
    mismatches, binanceStreak, body3Sum,
  };
}

/**
 * Backfill in-memory echo state (`lastEchoTriggerAt` AND `lastExtremeStreakAt`)
 * from historical bars so the bot has correct values on startup AND after
 * config changes. Without this, lastEchoTriggerAt stays null until a fresh
 * trigger streak hits — meaning a worker that just restarted (or a user that
 * just lowered echo_trigger_streak) shows armed=false even though a recent
 * past streak would have armed it under the current threshold.
 *
 * Scans the last 30 days (8640 bars, ~9 Binance API calls — completes in a
 * few seconds). On any active coin an extreme ≥ 7 occurs roughly every
 * 12-16h, so 30d gives a deep safety margin.
 *
 * SINGLE pass computes both:
 *   - lastEchoTriggerAt    using cfg.echo_trigger_streak             (always for echo)
 *   - lastExtremeStreakAt  using cfg.echo_defensive_streak_threshold (only when defensive enabled)
 *   - defensiveGapStats    inter-event gaps for defensive            (only when defensive enabled)
 *
 * Tracks both thresholds in `state.backfill{Trigger,Defensive}Threshold` so
 * `ensureBackfillFresh` knows when to re-run (= EITHER threshold changed, OR
 * defensive just got toggled on/off, OR first time after worker start).
 *
 * Sets `state.backfillInFlight` for the duration to prevent concurrent
 * re-entries on rapid config edits (in-flight check in caller too).
 */
/** Pick the more recent of two optional timestamps; null counts as -∞. */
function pickMostRecent(a: number | null, b: number | null): number | null {
  if (a == null) return b;
  if (b == null) return a;
  return Math.max(a, b);
}

/**
 * Chain regime predictive defensive.
 *
 * Tracks time since the last "chain event" (≥N arms clustered in a short
 * window). When the gap exceeds `echo_chain_overdue_min`, the next chain
 * is statistically due — entry thresholds bump up so only STRONG setups
 * fire (echo strategy spirit preserved). Auto-clears when the next chain
 * event manifests (gap resets to 0).
 *
 * Empirical (BTC 60d): inter-event gap p75 ≈ 27h; gaps in 32-64h range
 * show 1.25x lift in P(chain in next 6h). Modest predictive signal.
 *
 * Returns:
 *   active           : defensive currently engaged (gap > overdue or never observed)
 *   gapMin           : minutes since last chain event (null = never)
 *   armsInWindow     : current arm count within event window (live tick)
 *   activatesAt      : when defensive will turn on (null if already on)
 */
function computeChainState(state: CoinState, cfg: CoinConfig): {
  active: boolean;
  gapMin: number | null;
  armsInWindow: number;
  activatesAt: number | null;
} {
  if (!cfg.echo_chain_enabled || cfg.strategy !== 'echo') {
    return { active: false, gapMin: null, armsInWindow: 0, activatesAt: null };
  }
  const now = Date.now();
  const eventWindowMs = cfg.echo_chain_event_window_min * 60_000;
  const overdueMs = cfg.echo_chain_overdue_min * 60_000;
  // Live arm count in current event window (informational for FE).
  const armsInWindow = state.recentArmTimestamps.filter(t => now - t <= eventWindowMs).length;
  if (state.lastChainEventAt == null) {
    // No chain ever observed — defensive permanently on (cautious by default
    // until the first chain event resets it).
    return { active: true, gapMin: null, armsInWindow, activatesAt: null };
  }
  const gap = now - state.lastChainEventAt;
  const active = gap > overdueMs;
  return {
    active,
    gapMin: Math.round(gap / 60_000),
    armsInWindow,
    activatesAt: active ? null : state.lastChainEventAt + overdueMs,
  };
}

/**
 * Restore in-memory `lastEchoTriggerAt` + `lastExtremeStreakAt` from the
 * `echo_state_cache` table at worker startup. The cache is written by API
 * (LiveTradingEngine.recordEchoState) on every echo_state event the worker
 * publishes, so it carries the most recent runtime-detected values across
 * restarts. Without restoring, every restart drops legitimate triggers seen
 * by the prior worker's runtime path (see addCoin call site comment for
 * the prod incident that motivated this).
 *
 * Best-effort: failures (DB unavailable, stale schema, etc.) just leave
 * the in-memory values null and let backfill fully repopulate.
 */
async function restoreEchoStateFromCache(state: CoinState): Promise<void> {
  try {
    const { rows } = await getPool().query<{ state: {
      lastTriggerAt?: number | null;
      lastExtremeStreakAt?: number | null;
      chainLastEventAt?: number | null;
    } }>(
      `SELECT state FROM echo_state_cache WHERE coin = $1 LIMIT 1`,
      [state.symbol],
    );
    const cached = rows[0]?.state;
    if (!cached) return;
    const trigger = typeof cached.lastTriggerAt       === 'number' ? cached.lastTriggerAt       : null;
    const extreme = typeof cached.lastExtremeStreakAt === 'number' ? cached.lastExtremeStreakAt : null;
    const chain   = typeof cached.chainLastEventAt    === 'number' ? cached.chainLastEventAt    : null;
    state.lastEchoTriggerAt    = trigger;
    state.lastExtremeStreakAt  = extreme;
    state.lastChainEventAt     = chain;
    log('info', `echo state restored from cache ${state.symbol}`, {
      lastTriggerAt: trigger,
      lastExtremeStreakAt: extreme,
      chainLastEventAt: chain,
      triggerAgoMin: trigger != null ? Math.round((Date.now() - trigger) / 60_000) : null,
      chainAgoMin: chain != null ? Math.round((Date.now() - chain) / 60_000) : null,
    });
  } catch (err) {
    log('warn', 'echo state restore failed (continuing with backfill only)', {
      symbol: state.symbol, error: err instanceof Error ? err.message : String(err),
    });
  }
}

const BACKFILL_DAYS = 30;
async function backfillEchoState(state: CoinState): Promise<void> {
  if (state.backfillInFlight) return;
  state.backfillInFlight = true;
  try {
  const cfg = await getCoinConfig(state.symbol);
  if (cfg.strategy !== 'echo') {
    // Strategy switched to streak — clear all echo state.
    state.lastExtremeStreakAt          = null;
    state.lastEchoTriggerAt            = null;
    state.defensiveGapStats            = null;
    state.backfillTriggerThreshold     = null;
    state.backfillDefensiveThreshold   = null;
    return;
  }
  const triggerThreshold   = cfg.echo_trigger_streak;
  const defensiveThreshold = cfg.echo_defensive_enabled ? cfg.echo_defensive_streak_threshold : null;
  const now      = Date.now();
  const lookback = BACKFILL_DAYS * 24 * 60 * 60 * 1000;
  const CHUNK_BARS = 1000;
  const CHUNK_MS   = CHUNK_BARS * 5 * 60 * 1000;
  const bars: Bar[] = [];
  for (let cursor = now - lookback; cursor < now; cursor += CHUNK_MS) {
    const chunkEnd = Math.min(cursor + CHUNK_MS, now);
    const chunk = await fetchBars(state.symbol, cursor, chunkEnd, CHUNK_BARS);
    bars.push(...chunk);
    if (chunk.length < 10) break;
  }
  if (bars.length < triggerThreshold) return;

  // Single walk computes lastTriggerAt + lastExtremeAt + lastChainEventAt
  // + defensive gap events. Arm events are recorded at the bar where a NEW
  // run reaches `triggerThreshold` (run start at lower threshold). Chain
  // events are timestamps where ≥ chain_event_arm_count arms occurred
  // within chain_event_window_min (used for predictive defensive on next
  // restart so we don't start cold).
  const extremeEventStarts: number[] = [];
  const armEventTimes: number[] = [];   // for chain backfill
  let runDir = 0, runLen = 0;
  let lastTriggerAt: number | null = null;
  let lastExtremeAt: number | null = null;
  let i = 0;
  for (const b of bars) {
    const dir = b.close > b.open ? 1 : b.close < b.open ? -1 : 0;
    const closeTime = now - lookback + (i + 1) * (5 * 60 * 1000);
    if (dir === 0) { runDir = 0; runLen = 0; i++; continue; }
    const wasBelowExtreme = defensiveThreshold !== null && runLen < defensiveThreshold;
    const wasBelowTrigger = runLen < triggerThreshold;
    if (dir === runDir) runLen++;
    else                { runDir = dir; runLen = 1; }
    if (runLen >= triggerThreshold) {
      lastTriggerAt = closeTime;
      // Arm event at the moment the run FIRST hits trigger (prior bar was below).
      if (wasBelowTrigger) armEventTimes.push(closeTime);
    }
    if (defensiveThreshold !== null && runLen >= defensiveThreshold) {
      lastExtremeAt = closeTime;
      if (wasBelowExtreme) extremeEventStarts.push(closeTime);
    }
    i++;
  }

  // Chain event backfill: walk armEventTimes, find clusters of ≥N arms in
  // the chain event window. Last cluster's center timestamp = lastChainEventAt.
  if (state.recentArmTimestamps.length === 0) {
    // Only seed if not already populated (e.g., from cache restore).
    let lastChainEventAt: number | null = null;
    const winMs = (60 /* min, conservative */) * 60_000;
    const minArms = 2;
    for (let a = 0; a < armEventTimes.length; a++) {
      let count = 1;
      for (let b = a + 1; b < armEventTimes.length; b++) {
        if (armEventTimes[b]! - armEventTimes[a]! <= winMs) count++;
        else break;
      }
      if (count >= minArms) {
        // Record event timestamp at the LAST arm in the cluster.
        const lastInCluster = Math.min(a + count - 1, armEventTimes.length - 1);
        lastChainEventAt = armEventTimes[lastInCluster]!;
      }
    }
    state.lastChainEventAt = pickMostRecent(state.lastChainEventAt, lastChainEventAt);
  }

  // Trigger-side state. Take MAX(backfill, in-memory) so a more recent
  // runtime-detected trigger (e.g., from prior PID's T+4 using Poly truth)
  // isn't downgraded by Binance-only backfill. Pre-restore (addCoin) seeded
  // the in-memory value from echo_state_cache.
  state.lastEchoTriggerAt        = pickMostRecent(state.lastEchoTriggerAt, lastTriggerAt);
  state.backfillTriggerThreshold = triggerThreshold;

  // Defensive-side state (only when enabled). Same max-merge semantic.
  if (defensiveThreshold !== null) {
    const gaps: number[] = [];
    for (let j = 1; j < extremeEventStarts.length; j++) {
      gaps.push(extremeEventStarts[j]! - extremeEventStarts[j - 1]!);
    }
    state.defensiveGapStats            = gaps.length > 0 ? computeGapStats(gaps) : null;
    state.lastExtremeStreakAt          = pickMostRecent(state.lastExtremeStreakAt, lastExtremeAt);
    state.backfillDefensiveThreshold   = defensiveThreshold;
  } else {
    state.defensiveGapStats            = null;
    state.lastExtremeStreakAt          = null;
    state.backfillDefensiveThreshold   = null;
  }

  log('info', `echo backfill ${state.symbol} done`, {
    triggerThreshold,
    defensiveThreshold,
    lastEchoTriggerAt: lastTriggerAt,
    lastExtremeStreakAt: lastExtremeAt,
    triggerAgoMin: lastTriggerAt != null ? Math.round((now - lastTriggerAt) / 60_000) : null,
    extremeAgoMin: lastExtremeAt != null ? Math.round((now - lastExtremeAt) / 60_000) : null,
    extremeEvents: extremeEventStarts.length,
    scannedBars: bars.length,
  });
  } finally {
    state.backfillInFlight = false;
  }
}

/**
 * Detect threshold/strategy/defensive-enabled changes vs the values used in
 * the most recent backfill — re-run backfill so derived state reflects live
 * config. Called from the tick loop after `getCoinConfig`. Cheap on the
 * common path (a couple of int compares).
 *
 * Re-backfill triggers when ANY of:
 *   - Echo strategy enabled but never backfilled (first call after start /
 *     after switching strategy to echo)
 *   - `echo_trigger_streak` changed since last backfill (lastEchoTriggerAt
 *     stale → arm state wrong on UI)
 *   - `echo_defensive_enabled` flipped on (need defensive backfill now)
 *   - `echo_defensive_streak_threshold` changed (lastExtremeStreakAt + gap
 *     stats stale)
 *   - `echo_defensive_enabled` flipped off (clear defensive state to avoid
 *     stale data resurfacing on next enable)
 */
function ensureBackfillFresh(state: CoinState, cfg: CoinConfig): void {
  if (state.backfillInFlight) return;
  if (cfg.strategy !== 'echo') {
    // Switched away from echo — clear so a later switch back triggers fresh backfill.
    if (state.backfillTriggerThreshold !== null || state.backfillDefensiveThreshold !== null) {
      state.lastExtremeStreakAt        = null;
      state.lastEchoTriggerAt          = null;
      state.defensiveGapStats          = null;
      state.backfillTriggerThreshold   = null;
      state.backfillDefensiveThreshold = null;
      log('info', `echo state cleared ${state.symbol} — strategy is ${cfg.strategy}`);
    }
    return;
  }

  const wantTrigger   = cfg.echo_trigger_streak;
  const wantDefensive = cfg.echo_defensive_enabled ? cfg.echo_defensive_streak_threshold : null;
  const triggerStale   = state.backfillTriggerThreshold   !== wantTrigger;
  const defensiveStale = state.backfillDefensiveThreshold !== wantDefensive;
  if (!triggerStale && !defensiveStale) return;

  log('info', `echo backfill ${state.symbol} triggered`, {
    previousTrigger:   state.backfillTriggerThreshold,
    newTrigger:        wantTrigger,
    previousDefensive: state.backfillDefensiveThreshold,
    newDefensive:      wantDefensive,
    reason: state.backfillTriggerThreshold === null ? 'first-backfill'
          : triggerStale && defensiveStale ? 'both-changed'
          : triggerStale ? 'trigger-changed' : 'defensive-changed',
  });
  void backfillEchoState(state).catch(err => {
    log('warn', 'echo backfill failed', { symbol: state.symbol, error: String(err) });
  });
}

/** Percentile + summary stats over inter-event gaps (ms). Returned as ms so
 *  the FE picks its own display unit. */
function computeGapStats(gapsMs: number[]): DefensiveGapStats {
  const sorted = [...gapsMs].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.max(0, Math.min(sorted.length - 1, Math.floor(q * sorted.length)))]!;
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    count: sorted.length,
    p10Ms: at(0.10),
    p50Ms: at(0.50),
    p90Ms: at(0.90),
    maxMs: sorted[sorted.length - 1]!,
    meanMs: Math.round(sum / sorted.length),
  };
}

function bucketize(vol: number, avgVol: number): VolumeBucket {
  if (!(avgVol > 0) || !(vol > 0)) return 'unknown';
  const ratio = vol / avgVol;
  if (ratio < 0.5) return 'low';
  if (ratio < 1.5) return 'mid';
  if (ratio < 3.0) return 'high';
  return 'extreme';
}

/**
 * Echo idle-mode override matcher. Returns the name of the first matching
 * edge case (so caller can log which one fired) or null if none match.
 * Patterns + samples + WR are documented on `EchoEdgeCase` in CoinConfig.ts.
 */
function matchEchoEdgeCase(
  enabled: readonly EchoEdgeCase[],
  absStreak: number,
  ctx: { meanBodyRatio?: number; bodyHasVeryExtreme?: boolean; body3Sum?: number },
  shortStreakBody3Min: number,
): EchoEdgeCase | null {
  // A1: streak 3-4 + mean body > 1.5× avg.
  if (enabled.includes('short_streak_strong_mean')
      && absStreak >= 3 && absStreak <= 4
      && (ctx.meanBodyRatio ?? 0) > 1.5) {
    return 'short_streak_strong_mean';
  }
  // A3: streak 5-7 + ≥1 very-extreme body bar (>4× avg).
  if (enabled.includes('mid_streak_very_extreme')
      && absStreak >= 5 && absStreak <= 7
      && ctx.bodyHasVeryExtreme === true) {
    return 'mid_streak_very_extreme';
  }
  // NEW: streak 3-4 + |body3| ≥ configured absolute threshold (per-coin USD).
  // Captures premium-edge short-streak setups that ratio-based gates miss.
  // shortStreakBody3Min=0 disables even when toggled on (safe default).
  if (enabled.includes('short_streak_big_body3')
      && absStreak >= 3 && absStreak <= 4
      && shortStreakBody3Min > 0
      && (ctx.body3Sum ?? 0) >= shortStreakBody3Min) {
    return 'short_streak_big_body3';
  }
  return null;
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
