/**
 * src/services/StreakSignalEngine.ts
 *
 * Three independent strategy paths:
 *
 *   BOUNDARY (Path A) — market BUY, pre-position for NEXT window
 *     Fires in the LAST ~20s of the current window.
 *     Contrarian after streak (streak +N UP → bet DOWN on next; and vice versa).
 *     Conditions: |streak_with_inprogress| ≥ auto_min AND ask ≤ limit (54¢).
 *     Exit: global TP (75¢) / SL (25¢) — placed as resting CLOB limit SELLs.
 *
 *   DCA — market BUY, average-down on an existing Path A BUY
 *     Fires any time while > 1:30 remains AND a pending auto boundary BUY
 *     exists for this market AND the ask of the held direction drops to ≤
 *     dca_max_entry_cents (40¢).
 *     Size: flat auto_order_base_size_usdc.
 *     Exit: inherits parent's TP target (global). No SL.
 *     Idempotent: at most once per market.
 *
 *   PANIC — market BUY, momentum bottom-fishing in CURRENT window
 *     Fires only when streak is in the gap [signal_min, auto_min) — i.e. a
 *     signal exists but boundary will NOT auto-fire for the next window.
 *     In the first `panic_first_window_s` seconds (default 3 min), if the
 *     ask of the STREAK-MATCHING side drops to ≤ panic_entry_cents (5¢),
 *     buy that side. Bet is that BTC continues the trend and the dip was
 *     noise — exit at panic_tp_cents (20¢).
 *     Uses streak computed from CLOSED windows only (in-progress excluded)
 *     — the gap-gating has to be stable, not flicker with mid-window ticks.
 *     Size: flat auto_order_base_size_usdc. No SL. Once per market.
 *
 * Order types:
 *   BUY  = market FOK — take current ask (live CLOB submits FOK order)
 *   SELL = limit GTC — TP/SL rest at configured threshold for predictable exits
 *
 * Streak computation:
 *   - `streak` (with in-progress) used by BOUNDARY + DCA — catches last-second
 *     flips in the final 10s, important for boundary direction.
 *   - `streakClosed` (closed-only) used by PANIC gap gate — stable threshold
 *     check, doesn't flicker as mid-window ticks flip the in-progress close.
 */

import { log } from '../observability/logger.js';
import { getPool } from '@trading-bot/db';
import type { LiveTradingEngine } from './LiveTradingEngine.js';
import type { PolyClobMarket } from './PolymarketService.js';
import {
  getSignalMinStreak, getAutoOrderMinStreak, getAutoOrderLimitPriceCents,
  getDcaMaxEntryCents, getPanicEntryCents, getPanicTpCents, getPanicFirstWindowS,
  getAutoOrderTpCents, getAutoOrderSlCents,
  getAutoOrderBaseSizeUsdc, getAutoOrderDcaStepUsdc,
  getBoundarySignalHistory, setBoundarySignalHistory,
} from '../api/settings.js';
import {
  recordOrder, hasAutoOrderFor, findPendingPathABuyFor,
} from './orderPlacement.js';
import { getClobExecutor } from './PolymarketClobExecutor.js';

const TICK_MS                = 5_000;          // tight loop for DCA/Panic responsiveness
const WINDOW_MS              = 300_000;
const PATH_A_LEAD_MS         = 20_000;         // fire BOUNDARY in last 20s of current window
const BOUNDARY_RETRY_FIRST_MS = 60_000;        // retry BOUNDARY in first 60s of new window if pre-fire skipped
const DCA_MIN_REMAINING_MS   = 90_000;         // (legacy avg-down DCA) ≥ 1:30 left
const PAST_WINDOWS_TO_FETCH  = 12;
/** Max USDC a single DCA-scaled order can reach, to stop runaway exposure. */
const DCA_MAX_SIZE_USDC      = 100;

export type SignalPath = 'boundary' | 'dca' | 'panic';

export interface SignalEvent {
  emittedAt:           number;
  /** Which strategy path triggered this signal. */
  path:                SignalPath;
  /** Target window (BOUNDARY: next; DCA + PANIC: current). */
  windowStart:         number;
  windowEnd:           number;
  marketConditionId:   string;
  marketSlug:          string;
  streak:              number;       // signed
  direction:           'up' | 'down';
  signalMinStreak:     number;
  autoOrderMinStreak:  number;
  autoLimitPriceCents: number;
  signalSharePrice:    number | null;
  /** TP/SL applied to the order (cents); null = no SL. */
  orderTpCents:        number;
  orderSlCents:        number | null;
  isAuto:              boolean;
  /** DCA-size breakdown for BOUNDARY orders (null for DCA + PANIC — flat size). */
  dca?: {
    baseUsdc:      number;
    stepUsdc:      number;
    priorLosses:   number;       // consecutive losses before this order
    computedSize:  number;       // baseUsdc + stepUsdc × priorLosses (capped)
  } | null;
  auto?: {
    placed:      boolean;
    orderId?:    string;
    sharePrice?: number;
    sizeUsdc?:   number;
    skipReason?: string;
  };
}

export class StreakSignalEngine {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastEmitFingerprintBoundary: string | null = null;
  private lastEmitFingerprintDca:      string | null = null;
  private lastEmitFingerprintPanic:    string | null = null;

  // ── Adaptive autoMin from BOUNDARY signal history ──────────────────────
  // Stores |streak| (unsigned) of every emitted boundary signal (placed or
  // skipped). effectiveAutoMin() reads recent entries and applies these
  // rules in priority order:
  //
  //   1. Last 2 signals are exactly [3, 4] (prev=3, curr=4) → autoMin = 6
  //   2. Last signal |streak| = 5                            → autoMin = 3
  //   3. Last signal |streak| = 3                            → autoMin = 4
  //   4. Otherwise (no history, last=4/6/7+, etc.)           → autoMin = 5
  //
  // Persisted to `settings.boundary_signal_history` (JSON) so the last-N-
  // signals rules survive backend restarts. Engine loads on start(), saves
  // after each record.
  private boundarySignalHistory: number[] = [];
  private historyLoaded = false;

  constructor(private readonly engine: LiveTradingEngine) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    log('info', 'StreakSignalEngine starting');
    // Load persistent boundary signal history (non-blocking; tick() tolerates
    // empty history until loaded).
    void this.loadHistoryOnce();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    void this.tick();
  }

  private async loadHistoryOnce(): Promise<void> {
    if (this.historyLoaded) return;
    try {
      this.boundarySignalHistory = await getBoundarySignalHistory();
      this.historyLoaded = true;
      log('info', 'Adaptive autoMin: history loaded', {
        length: this.boundarySignalHistory.length,
        tail: this.boundarySignalHistory.slice(-10),
      });
    } catch (err) {
      log('warn', 'Adaptive autoMin: history load failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  stop(): void {
    this.running = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    log('info', 'StreakSignalEngine stopped');
  }

  /**
   * Adaptive autoMin from recent boundary signal history. Settings autoMin
   * is currently ignored (override). See field doc for the priority rules.
   */
  private effectiveAutoMin(_settingsAutoMin: number, _streak: number): number {
    const hist = this.boundarySignalHistory;
    const last = hist.length >= 1 ? hist[hist.length - 1]! : null;
    const prev = hist.length >= 2 ? hist[hist.length - 2]! : null;

    // Priority 1: last 2 signals were exactly [3, 4] in order
    if (prev === 3 && last === 4) return 6;

    // Priority 2: last signal was |streak| = 5
    if (last === 5) return 3;

    // Priority 3: last signal was |streak| = 3
    if (last === 3) return 4;

    // Default
    return 5;
  }

  /**
   * Append the just-emitted boundary signal's |streak| to history and
   * persist. Fire-and-forget DB write — the in-memory copy is the source
   * of truth between writes.
   */
  private recordBoundarySignal(streak: number): void {
    this.boundarySignalHistory.push(Math.abs(streak));
    if (this.boundarySignalHistory.length > 20) {
      this.boundarySignalHistory.shift();   // memory cap
    }
    log('info', 'Adaptive autoMin: boundary signal recorded', {
      streakAbs: Math.abs(streak),
      historyTail: this.boundarySignalHistory.slice(-5),
      newAutoMin: this.effectiveAutoMin(0, 0),
    });
    // Persist (fire-and-forget — don't block tick on DB)
    void setBoundarySignalHistory(this.boundarySignalHistory).catch(err =>
      log('warn', 'Adaptive autoMin: history save failed', {
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  private async tick(): Promise<void> {
    try {
      const now = Date.now();
      const windowStart = Math.floor(now / WINDOW_MS) * WINDOW_MS;
      const windowEnd   = windowStart + WINDOW_MS;
      const msToEnd     = windowEnd - now;
      const msFromStart = now - windowStart;

      // Read runtime settings once per tick.
      const [signalMin, autoMin, limitCents, dcaMax,
             panicEntry, panicTp, panicFirstWinS] = await Promise.all([
        getSignalMinStreak(),
        getAutoOrderMinStreak(),
        getAutoOrderLimitPriceCents(),
        getDcaMaxEntryCents(),
        getPanicEntryCents(),
        getPanicTpCents(),
        getPanicFirstWindowS(),
      ]);

      // Fetch two streak views via a single Binance klines call:
      //   - with in-progress: used by BOUNDARY (+ DCA, which doesn't gate on it)
      //   - closed-only:      used by PANIC to get a stable gap [signalMin, autoMin) check
      const klines = await this.fetchKlines(
        windowStart - PAST_WINDOWS_TO_FETCH * WINDOW_MS,
        windowEnd - 1,      // include the in-progress current window
      );
      const streak = computeStreak(klines);
      // Closed-only: drop the last kline if it covers the in-progress window.
      const closedKlines = klines.filter(k => Number(k[0]) < windowStart);
      const streakClosed = computeStreak(closedKlines);

      const snap = this.engine.snapshot();

      // BOUNDARY: fire in the last 20s of the current window.
      // DCA escalation is now BAKED INTO boundary's size (predictive +
      // closed-loss count). No separate DCA retry order — the boundary order
      // itself grows when the pending boundary on current window is losing.
      if (msToEnd > 0 && msToEnd <= PATH_A_LEAD_MS) {
        await this.tryBoundary({
          snap, streak, signalMin, autoMin, limitCents, now,
        });
      }

      // BOUNDARY RETRY: if pre-fire skipped (e.g. ask 62¢ > 55¢ limit because
      // the next market just listed with thin liquidity), monitor the first
      // 60s of the new window — if price drops to ≤ limit while the streak
      // still warrants an auto order, fire boundary for the CURRENT window.
      if (msFromStart <= BOUNDARY_RETRY_FIRST_MS) {
        await this.tryBoundaryRetry({
          snap, streakClosed, signalMin, autoMin, limitCents,
        });
      }

      // DCA same-window avg-down + DCA-retry separate orders — both DISABLED.
      // Kept methods in file for re-enable. Predictive loss now folds into
      // boundary's size escalation so we get one bigger order, not two.
      // await this.tryDca({ snap, streak, dcaMax, msToEnd });
      // await this.tryDcaRetry({ snap, streak, limitCents, now });
      void dcaMax;

      // PANIC: every tick while inside the first `panicFirstWinS` seconds.
      if (msFromStart <= panicFirstWinS * 1000) {
        await this.tryPanic({
          snap, streakClosed, signalMin, autoMin,
          panicEntry, panicTp, msFromStart, panicFirstWinS,
        });
      }
    } catch (err) {
      log('warn', 'StreakSignalEngine tick failed', { error: String(err) });
    }
  }

  // ── BOUNDARY (Path A) ──────────────────────────────────────────────────

  private async tryBoundary(ctx: {
    snap: ReturnType<LiveTradingEngine['snapshot']>;
    streak: number; signalMin: number; autoMin: number; limitCents: number; now: number;
  }): Promise<void> {
    const { snap, streak, signalMin, autoMin, limitCents } = ctx;
    const effectiveAuto = this.effectiveAutoMin(autoMin, streak);

    const nextMarket = snap.upcoming.filter(m => m.windowStart > ctx.now)
      .sort((a, b) => a.windowStart - b.windowStart)[0] ?? null;
    if (!nextMarket) return;   // no next market tracked yet

    if (Math.abs(streak) < signalMin) {
      const fpIdle = `BND|${nextMarket.conditionId}|${streak}|${signalMin}|${effectiveAuto}|${limitCents}|idle`;
      if (this.lastEmitFingerprintBoundary === fpIdle) return;
      this.lastEmitFingerprintBoundary = fpIdle;
      return;
    }

    const direction: 'up' | 'down' = streak > 0 ? 'down' : 'up';
    const tokenId = direction === 'up' ? nextMarket.tokenUp : nextMarket.tokenDown;
    // WS may not have pushed a book event yet for this just-subscribed next
    // market → fall back to REST orderbook fetch.
    const signalSharePrice = await resolveAsk(snap, tokenId);

    const priceFlag = signalSharePrice != null ? 'hasprice' : 'noprice';
    const fingerprint = `BND|${nextMarket.conditionId}|${streak}|${signalMin}|${effectiveAuto}|${limitCents}|${priceFlag}`;
    if (this.lastEmitFingerprintBoundary === fingerprint) return;

    const isAuto = Math.abs(streak) >= effectiveAuto;

    // Path A uses GLOBAL tp/sl (resolver falls back to global when order's tp_cents/sl_cents null).
    const signal: SignalEvent = {
      emittedAt:           Date.now(),
      path:                'boundary',
      windowStart:         nextMarket.windowStart,
      windowEnd:           nextMarket.windowEnd,
      marketConditionId:   nextMarket.conditionId,
      marketSlug:          nextMarket.slug,
      streak,
      direction,
      signalMinStreak:     signalMin,
      autoOrderMinStreak:  effectiveAuto,    // adaptive — may be 3 (hot) or 5 (cold)
      autoLimitPriceCents: limitCents,
      signalSharePrice,
      orderTpCents:        0,      // 0 = use global (FE reads live setting for display)
      orderSlCents:        0,
      isAuto,
    };

    // Compute DCA-scaled size for BOUNDARY:
    //   - prior CLOSED boundary losses (consecutive)
    //   - + PREDICTIVE: +1 loss if pending boundary on current window is
    //     predicted to lose (newest kline dir opposes its bet)
    // → folded into a single, larger boundary order. No separate DCA order.
    const dca = await this.computeDcaForBoundary(streak);
    signal.dca = dca;

    if (isAuto) {
      signal.auto = await this.tryAutoOrderBoundary(
        signal, nextMarket, signalSharePrice, limitCents, dca.computedSize,
      );
    }

    this.broadcast(signal);
    this.lastEmitFingerprintBoundary = fingerprint;
  }

  // ── BOUNDARY RETRY (in-window late entry) ──────────────────────────────

  /**
   * Runs in the first BOUNDARY_RETRY_FIRST_MS of a freshly-opened window. If
   * no boundary BUY exists yet for this market (pre-fire was skipped, e.g.
   * because next-market ask was 62¢ > 55¢ limit), and the streak still
   * warrants an auto order, monitor live ask. As soon as it drops to ≤ limit,
   * fire boundary on the CURRENT window with size escalation.
   *
   * Uses streakClosed (excludes in-progress) so the bet is grounded in
   * already-resolved windows, not a flickering live close.
   * Idempotent via hasAutoOrderFor(market, 'boundary').
   */
  private async tryBoundaryRetry(ctx: {
    snap: ReturnType<LiveTradingEngine['snapshot']>;
    streakClosed: number; signalMin: number; autoMin: number; limitCents: number;
  }): Promise<void> {
    const { snap, streakClosed, signalMin, autoMin, limitCents } = ctx;
    const effectiveAuto = this.effectiveAutoMin(autoMin, streakClosed);
    const market = snap.currentMarket;
    if (!market) return;

    // Gate 1: streak still meets auto threshold (closed-only, stable basis)
    if (Math.abs(streakClosed) < effectiveAuto) return;

    // Gate 2: no boundary already placed for this market
    if (await hasAutoOrderFor(market.conditionId, 'boundary')) return;

    // Gate 3: ask of contrarian direction ≤ limit
    const direction: 'up' | 'down' = streakClosed > 0 ? 'down' : 'up';
    const tokenId = direction === 'up' ? market.tokenUp : market.tokenDown;
    const bestAsk = await resolveAsk(snap, tokenId);
    if (bestAsk == null) return;
    if (bestAsk * 100 > limitCents) return;     // still too high, wait next tick

    // Size escalation — closed losses count, no predictive (we ARE the late
    // entry; predictive only makes sense for the next pre-fire).
    const dca = await this.computeDcaForBoundary(0);

    const signal: SignalEvent = {
      emittedAt:           Date.now(),
      path:                'boundary',
      windowStart:         market.windowStart,
      windowEnd:           market.windowEnd,
      marketConditionId:   market.conditionId,
      marketSlug:          market.slug,
      streak:              streakClosed,
      direction,
      signalMinStreak:     signalMin,
      autoOrderMinStreak:  effectiveAuto,
      autoLimitPriceCents: limitCents,
      signalSharePrice:    bestAsk,
      orderTpCents:        0,
      orderSlCents:        0,
      isAuto:              true,
      dca,
    };

    signal.auto = await this.tryAutoOrderBoundary(
      signal, market, bestAsk, limitCents, dca.computedSize,
    );

    log('info', 'StreakSignalEngine BOUNDARY RETRY (in-window)', {
      market: market.conditionId,
      streakClosed, direction, ask: bestAsk,
      size: dca.computedSize,
      placed: signal.auto.placed, skipReason: signal.auto.skipReason,
    });

    // Reuse boundary fingerprint so we don't spam re-broadcasts on subsequent
    // ticks. Once placed, hasAutoOrderFor blocks further attempts anyway.
    const fingerprint = `BND-RTY|${market.conditionId}|${streakClosed}|${signal.auto.placed ? 'ok' : 'skip'}`;
    if (this.lastEmitFingerprintBoundary === fingerprint) return;
    this.broadcast(signal);
    this.lastEmitFingerprintBoundary = fingerprint;
  }

  private async tryAutoOrderBoundary(
    signal: SignalEvent,
    market: PolyClobMarket,
    resolvedAsk: number | null,
    limitCents: number,
    sizeUsdc: number,
  ): Promise<NonNullable<SignalEvent['auto']>> {
    // Only one BOUNDARY BUY per market (doesn't block DCA's later average-down).
    if (await hasAutoOrderFor(market.conditionId, 'boundary')) {
      return { placed: false, skipReason: 'BOUNDARY order already exists for this market' };
    }
    void signal;        // signature carried through for log context
    const price = resolvedAsk;
    if (!price || !(price > 0 && price < 1)) {
      return { placed: false, skipReason: `no valid best_ask (WS + REST both empty)` };
    }
    if (price * 100 > limitCents) {
      return { placed: false, skipReason: `ask ${(price * 100).toFixed(1)}¢ > limit ${limitCents}¢` };
    }
    try {
      const r = await recordOrder({
        conditionId: market.conditionId,
        direction:   signal.direction,
        sharePrice:  price,
        sizeUsdc,
        source:      'auto',
        signalPath:  'boundary',
        // tpCents/slCents = null → resolver uses global settings
      });
      return { placed: true, orderId: r.id, sharePrice: price, sizeUsdc };
    } catch (err) {
      return { placed: false, skipReason: String(err instanceof Error ? err.message : err) };
    }
  }

  /**
   * DCA size escalation for BOUNDARY orders:
   *   size = base + step × (closed_losses + predictive_loss)
   *
   *   - closed_losses = consecutive prior boundary auto orders that closed
   *     with pnl < 0 (counted from newest going back, broken by first non-loss)
   *   - predictive_loss = +1 if a pending boundary BUY exists for the CURRENT
   *     window AND the newest kline direction (incl. in-progress) opposes its
   *     bet (so it's likely to lose at window-end)
   *
   * Only auto boundary rows count. Ignores manual, dca, panic.
   * Capped at DCA_MAX_SIZE_USDC.
   */
  private async computeDcaForBoundary(streak: number): Promise<NonNullable<SignalEvent['dca']>> {
    const [baseUsdc, stepUsdc] = await Promise.all([
      getAutoOrderBaseSizeUsdc(),
      getAutoOrderDcaStepUsdc(),
    ]);

    if (stepUsdc <= 0) {
      return { baseUsdc, stepUsdc: 0, priorLosses: 0, computedSize: baseUsdc };
    }

    // 1. Closed-loss streak from the boundary order history
    const { rows } = await getPool().query<{ pnl_usdc: number | null }>(
      `SELECT pnl_usdc
         FROM poly_orders
        WHERE source = 'auto'
          AND signal_path = 'boundary'
          AND status = 'closed'
        ORDER BY ts_entry DESC
        LIMIT 20`,
    );

    let closedLosses = 0;
    for (const o of rows) {
      if (o.pnl_usdc == null) continue;
      if (o.pnl_usdc < 0) closedLosses++;
      else break;
    }

    // 2. Predictive loss on the CURRENT window's pending boundary
    let predictiveLoss = 0;
    const snap = this.engine.snapshot();
    const curMarket = snap.currentMarket;
    if (curMarket && streak !== 0) {
      const pending = await findPendingPathABuyFor(curMarket.conditionId);
      if (pending) {
        const newestDir: 'up' | 'down' = streak > 0 ? 'up' : 'down';
        if (newestDir !== pending.direction) predictiveLoss = 1;
      }
    }

    const totalLosses = closedLosses + predictiveLoss;
    const raw = baseUsdc + stepUsdc * totalLosses;
    const computedSize = Math.min(raw, DCA_MAX_SIZE_USDC);
    return { baseUsdc, stepUsdc, priorLosses: totalLosses, computedSize };
  }

  // ── DCA (average-down existing BOUNDARY) ──────────────────────────────

  /**
   * Fires when we already hold a pending auto BOUNDARY BUY on the current
   * market and the ask for the held direction has dropped into the DCA zone
   * (≤ dca_max_entry_cents, default 40¢). Buys more at current ask (flat
   * base size) to average down. TP inherits global; no SL.
   * Idempotent per market.
   */
  private async tryDca(ctx: {
    snap: ReturnType<LiveTradingEngine['snapshot']>;
    streak: number; dcaMax: number; msToEnd: number;
  }): Promise<void> {
    const { snap, streak, dcaMax, msToEnd } = ctx;
    const market = snap.currentMarket;
    if (!market) return;

    // Gate 1: enough time left for a recovery.
    if (msToEnd <= DCA_MIN_REMAINING_MS) return;

    // Gate 2: a pending auto BOUNDARY BUY must exist for this market.
    const parent = await findPendingPathABuyFor(market.conditionId);
    if (!parent) return;

    // Gate 3: ask for the held direction has dropped into the DCA zone.
    const tokenId = parent.direction === 'up' ? market.tokenUp : market.tokenDown;
    const bestAsk = snap.shares[tokenId]?.bestAsk;
    if (bestAsk == null) return;
    const askCents = bestAsk * 100;
    if (askCents > dcaMax) return;

    // Gate 4: haven't already DCA'd on this market.
    if (await hasAutoOrderFor(market.conditionId, 'dca')) return;

    const fingerprint = `DCA|${market.conditionId}|add`;
    if (this.lastEmitFingerprintDca === fingerprint) return;

    const [baseUsdc, globalTp] = await Promise.all([
      getAutoOrderBaseSizeUsdc(),
      getAutoOrderTpCents(),
    ]);

    const signal: SignalEvent = {
      emittedAt:           Date.now(),
      path:                'dca',
      windowStart:         market.windowStart,
      windowEnd:           market.windowEnd,
      marketConditionId:   market.conditionId,
      marketSlug:          market.slug,
      streak,
      direction:           parent.direction,   // same as parent (averaging down)
      signalMinStreak:     0,                  // N/A for DCA
      autoOrderMinStreak:  0,
      autoLimitPriceCents: dcaMax,
      signalSharePrice:    bestAsk,
      orderTpCents:        globalTp,           // inherit parent's TP target
      orderSlCents:        null,               // no SL
      isAuto:              true,
      dca:                 null,               // flat base_size (no scaling)
    };

    signal.auto = await this.tryAutoOrderDca({
      market, parent, bestAsk, tpCents: globalTp, sizeUsdc: baseUsdc,
    });

    this.broadcast(signal);
    this.lastEmitFingerprintDca = fingerprint;
  }

  private async tryAutoOrderDca(p: {
    market:  PolyClobMarket;
    parent:  { id: string; direction: 'up' | 'down'; share_price: number };
    bestAsk: number;
    tpCents: number;
    sizeUsdc: number;
  }): Promise<NonNullable<SignalEvent['auto']>> {
    try {
      const r = await recordOrder({
        conditionId: p.market.conditionId,
        direction:   p.parent.direction,
        sharePrice:  p.bestAsk,
        sizeUsdc:    p.sizeUsdc,
        source:      'auto',
        signalPath:  'dca',
        tpCents:     p.tpCents,     // inherit parent's TP (e.g. 75¢)
        slCents:     null,          // no SL — we're averaging down, not cutting
      });
      log('info', 'StreakSignalEngine DCA-add', {
        parent: p.parent.id, parent_entry: p.parent.share_price,
        dca_entry: p.bestAsk, size: p.sizeUsdc,
      });
      return { placed: true, orderId: r.id, sharePrice: p.bestAsk, sizeUsdc: p.sizeUsdc };
    } catch (err) {
      return { placed: false, skipReason: String(err instanceof Error ? err.message : err) };
    }
  }

  // ── DCA RETRY (predictive in last 10s, target next window) ─────────────

  /**
   * Fires in the last 10s of the current window — SAME slot as BOUNDARY fire.
   * If we have a pending auto boundary BUY on the CURRENT window and it looks
   * like it's LOSING (in-progress kline direction opposes the boundary's bet),
   * place a same-direction BUY with escalated size on the NEXT window.
   *
   * Eligibility chain (all must hold):
   *   - Pending auto boundary BUY exists for current window's market
   *   - streak sign (includes in-progress) ≠ boundary.direction  (predicted loss)
   *   - A "next" market is tracked
   *   - Ask for DCA direction on next market ≤ auto_order_limit_price_cents
   *
   * Size: base + step × consecutive_boundary_losses (capped).
   * Direction: same as the losing boundary (continue same side, mean-reversion bet).
   * Exit: global TP + SL (same as boundary — resolver handles).
   * Idempotent via hasAutoOrderFor(nextMarket, 'dca').
   */
  private async tryDcaRetry(ctx: {
    snap: ReturnType<LiveTradingEngine['snapshot']>;
    streak: number;
    limitCents: number;
    now: number;
  }): Promise<void> {
    const { snap, streak, limitCents, now } = ctx;
    const curMarket = snap.currentMarket;
    if (!curMarket) return;

    // Gate 1: pending auto boundary BUY on current window
    const boundary = await findPendingPathABuyFor(curMarket.conditionId);
    if (!boundary) return;

    // Gate 2: predict — boundary is losing if newest kline dir opposes it.
    // streak sign reflects newest kline direction (includes in-progress).
    if (streak === 0) return;
    const newestDir: 'up' | 'down' = streak > 0 ? 'up' : 'down';
    if (newestDir === boundary.direction) return;   // boundary winning, don't retry

    // Gate 3: next market exists and we haven't retried on it yet
    const nextMarket = snap.upcoming.filter(m => m.windowStart > now)
      .sort((a, b) => a.windowStart - b.windowStart)[0];
    if (!nextMarket) return;
    if (await hasAutoOrderFor(nextMarket.conditionId, 'dca')) return;

    // Gate 4: ask for DCA direction (= boundary direction) ≤ limit
    const direction = boundary.direction;
    const tokenId = direction === 'up' ? nextMarket.tokenUp : nextMarket.tokenDown;
    // Same WS-race fallback as BOUNDARY — REST fetch if WS has nothing yet.
    const bestAsk = await resolveAsk(snap, tokenId);
    if (bestAsk == null) return;

    // Fingerprint — dedup the signal emit during the 10s firing window
    const fingerprint = `DCA-R|${nextMarket.conditionId}|${boundary.id}`;
    if (this.lastEmitFingerprintDca === fingerprint) return;

    // Size escalation — same formula as BOUNDARY (caller is disabled but
    // kept compilable; pass streak=0 so the predictive-loss check no-ops)
    const dca = await this.computeDcaForBoundary(0);

    const signal: SignalEvent = {
      emittedAt:           Date.now(),
      path:                'dca',
      windowStart:         nextMarket.windowStart,
      windowEnd:           nextMarket.windowEnd,
      marketConditionId:   nextMarket.conditionId,
      marketSlug:          nextMarket.slug,
      streak,                                    // useful for UI (shows current streak)
      direction,
      signalMinStreak:     0,
      autoOrderMinStreak:  0,
      autoLimitPriceCents: limitCents,
      signalSharePrice:    bestAsk,
      orderTpCents:        0,                    // 0 = resolver uses global TP
      orderSlCents:        0,                    // 0 = resolver uses global SL
      isAuto:              true,
      dca,                                       // size escalation in UI
    };

    if (bestAsk * 100 > limitCents) {
      signal.auto = {
        placed: false,
        skipReason: `ask ${(bestAsk * 100).toFixed(1)}¢ > limit ${limitCents}¢`,
      };
    } else {
      signal.auto = await this.tryAutoOrderDcaRetry({
        market:    nextMarket,
        direction,
        bestAsk,
        sizeUsdc:  dca.computedSize,
      });
    }

    log('info', 'StreakSignalEngine DCA RETRY (predictive)', {
      losing_boundary: boundary.id,
      boundary_dir: boundary.direction, newest_dir: newestDir,
      next_market: nextMarket.conditionId,
      direction, entry: bestAsk,
      size: dca.computedSize, priorLosses: dca.priorLosses,
      placed: signal.auto.placed, skipReason: signal.auto.skipReason,
    });

    this.broadcast(signal);
    this.lastEmitFingerprintDca = fingerprint;
  }

  private async tryAutoOrderDcaRetry(p: {
    market:    PolyClobMarket;
    direction: 'up' | 'down';
    bestAsk:   number;
    sizeUsdc:  number;
  }): Promise<NonNullable<SignalEvent['auto']>> {
    try {
      const r = await recordOrder({
        conditionId: p.market.conditionId,
        direction:   p.direction,
        sharePrice:  p.bestAsk,
        sizeUsdc:    p.sizeUsdc,
        source:      'auto',
        signalPath:  'dca',
        // tp/sl null → resolver falls back to global
      });
      return { placed: true, orderId: r.id, sharePrice: p.bestAsk, sizeUsdc: p.sizeUsdc };
    } catch (err) {
      return { placed: false, skipReason: String(err instanceof Error ? err.message : err) };
    }
  }

  // ── PANIC (bottom-fishing in current window) ──────────────────────────

  /**
   * Fires only when streak sits in the gap [signal_min, auto_min) — signal
   * exists but BOUNDARY won't auto-fire for next window. In the first
   * `panicFirstWinS` seconds, if the ask for the STREAK-MATCHING side has
   * crashed to ≤ panic_entry_cents (5¢), buy that side. Bet is that BTC
   * continues the streak direction and the mid-window dip is noise.
   * Size: flat base. Exit: limit SELL at panic_tp_cents. No SL.
   * Idempotent per market.
   *
   * Uses closed-only streak so the gap-gate is stable (doesn't flicker when
   * the in-progress close crosses open mid-window).
   */
  private async tryPanic(ctx: {
    snap: ReturnType<LiveTradingEngine['snapshot']>;
    streakClosed: number; signalMin: number; autoMin: number;
    panicEntry: number; panicTp: number;
    msFromStart: number; panicFirstWinS: number;
  }): Promise<void> {
    const {
      snap, streakClosed, signalMin, autoMin,
      panicEntry, panicTp, msFromStart, panicFirstWinS,
    } = ctx;
    const market = snap.currentMarket;
    if (!market) return;

    // Gate 1: streak sits in the gap [signalMin, autoMin)
    const absStreak = Math.abs(streakClosed);
    if (absStreak < signalMin || absStreak >= autoMin) return;

    // Gate 2: first N seconds of window (enough room for a recovery)
    if (msFromStart > panicFirstWinS * 1000) return;

    // Gate 3: bet direction = streak direction (momentum on reversal of mid-window dip)
    const direction: 'up' | 'down' = streakClosed > 0 ? 'up' : 'down';
    const tokenId = direction === 'up' ? market.tokenUp : market.tokenDown;
    const bestAsk = snap.shares[tokenId]?.bestAsk;
    if (bestAsk == null) return;

    // Gate 4: ask has crashed to the bottom-fishing zone
    const askCents = bestAsk * 100;
    if (askCents > panicEntry) return;

    // Gate 5: haven't already panic'd on this market
    if (await hasAutoOrderFor(market.conditionId, 'panic')) return;

    const fingerprint = `PNC|${market.conditionId}|${streakClosed}|${panicEntry}`;
    if (this.lastEmitFingerprintPanic === fingerprint) return;

    const baseUsdc = await getAutoOrderBaseSizeUsdc();

    const signal: SignalEvent = {
      emittedAt:           Date.now(),
      path:                'panic',
      windowStart:         market.windowStart,
      windowEnd:           market.windowEnd,
      marketConditionId:   market.conditionId,
      marketSlug:          market.slug,
      streak:              streakClosed,
      direction,
      signalMinStreak:     signalMin,
      autoOrderMinStreak:  autoMin,
      autoLimitPriceCents: panicEntry,
      signalSharePrice:    bestAsk,
      orderTpCents:        panicTp,
      orderSlCents:        null,                  // no SL — cheap deep-dip bet
      isAuto:              true,
      dca:                 null,
    };

    signal.auto = await this.tryAutoOrderPanic({
      market, direction, bestAsk, tpCents: panicTp, sizeUsdc: baseUsdc,
    });

    this.broadcast(signal);
    this.lastEmitFingerprintPanic = fingerprint;
  }

  private async tryAutoOrderPanic(p: {
    market:   PolyClobMarket;
    direction:'up' | 'down';
    bestAsk:  number;
    tpCents:  number;
    sizeUsdc: number;
  }): Promise<NonNullable<SignalEvent['auto']>> {
    try {
      const r = await recordOrder({
        conditionId: p.market.conditionId,
        direction:   p.direction,
        sharePrice:  p.bestAsk,
        sizeUsdc:    p.sizeUsdc,
        source:      'auto',
        signalPath:  'panic',
        tpCents:     p.tpCents,        // panic's own TP (typically ~20¢)
        slCents:     null,             // no SL — the bet is "bottom fished, just wait"
      });
      log('info', 'StreakSignalEngine PANIC bottom-fish', {
        direction: p.direction, entry: p.bestAsk,
        tp: p.tpCents, size: p.sizeUsdc,
      });
      return { placed: true, orderId: r.id, sharePrice: p.bestAsk, sizeUsdc: p.sizeUsdc };
    } catch (err) {
      return { placed: false, skipReason: String(err instanceof Error ? err.message : err) };
    }
  }

  // ── Shared ─────────────────────────────────────────────────────────────

  private broadcast(signal: SignalEvent): void {
    this.engine.setLastSignal(signal);
    this.engine.emit('signal', signal);
    if (signal.auto?.placed && signal.auto.orderId) {
      this.engine.publishOrder({
        id:          signal.auto.orderId,
        market_id:   signal.marketConditionId,
        ts_entry:    signal.emittedAt,
        direction:   signal.direction,
        share_price: signal.auto.sharePrice,
        size_usdc:   signal.auto.sizeUsdc,
        mode:        'simulate',
        source:      'auto',
        signal_path: signal.path,
        status:      'pending',
        tp_cents:    signal.orderTpCents > 0 ? signal.orderTpCents : null,
        sl_cents:    signal.orderSlCents,
      });
    }
    log('info', 'StreakSignalEngine emit', {
      path: signal.path, streak: signal.streak, direction: signal.direction,
      window: new Date(signal.windowStart).toISOString(),
      price: signal.signalSharePrice,
      placed: signal.auto?.placed ?? false,
      skipReason: signal.auto?.skipReason,
    });
    // Adaptive autoMin tracks BOUNDARY signal |streak| only (placed or
    // skipped — both count). DCA / PANIC paths use their own thresholds.
    if (signal.path === 'boundary') {
      this.recordBoundarySignal(signal.streak);
    }
  }

  /** Binance spot 5m klines covering the given range (open-time filter). */
  private async fetchKlines(startTime: number, endTime: number): Promise<Array<Array<string | number>>> {
    const url = `https://api.binance.com/api/v3/klines`
      + `?symbol=BTCUSDT&interval=5m`
      + `&startTime=${startTime}&endTime=${endTime}&limit=${PAST_WINDOWS_TO_FETCH + 2}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`binance klines ${resp.status}`);
    return resp.json() as Promise<Array<Array<string | number>>>;
  }
}

/**
 * Resolve best ask for a token, preferring the WS snapshot but falling back
 * to a one-shot REST orderbook fetch when WS hasn't pushed an event yet for
 * a just-subscribed token (common race for the next-window market when fire
 * timing aligns close to subscription time).
 */
async function resolveAsk(
  snap: ReturnType<LiveTradingEngine['snapshot']>,
  tokenId: string,
): Promise<number | null> {
  const fromWs = snap.shares[tokenId]?.bestAsk ?? null;
  if (fromWs != null) return fromWs;
  const ex = getClobExecutor();
  if (!ex) return null;
  const rest = await ex.fetchBestAsk(tokenId);
  if (rest != null) {
    log('info', 'resolveAsk: WS empty, REST fallback hit', { tokenId, ask: rest });
  }
  return rest;
}

/**
 * Compute signed streak from klines (oldest → newest).
 *   +N = last N windows all UP (close >= open)
 *   −N = last N windows all DOWN
 *    0 = no klines / ambiguous
 *
 * The final kline may be in-progress (close is live-updating). At T-5s its
 * close is close-to-final; we count it the same as a closed kline.
 */
function computeStreak(klines: Array<Array<string | number>>): number {
  if (!klines.length) return 0;
  // Each kline: [openTime, open, high, low, close, ...]
  const outcomes = klines.map(k => Number(k[4]) >= Number(k[1]) ? 'up' : 'down');
  const newest = outcomes[outcomes.length - 1];
  if (!newest) return 0;
  let n = 0;
  for (let i = outcomes.length - 1; i >= 0; i--) {
    if (outcomes[i] !== newest) break;
    n++;
  }
  return newest === 'up' ? n : -n;
}
