/**
 * src/services/CoinConfig.ts
 *
 * Helpers to read/write the per-coin strategy config stored as a single JSON
 * blob in settings.coin_configs (see migration 021).
 *
 * Uppercase symbols throughout ("BTC", "ETH", ...).
 */
import { getPool } from '@trading-bot/db';

export type CoinSymbol  = 'BTC' | 'ETH' | 'SOL' | 'XRP' | 'DOGE' | 'HYPE' | 'BNB' | 'BTC_1H' | 'ETH_1H' | 'BTC_15m';

/**
 * Per-coin metadata for timeframe / Polymarket integration / phase scheduling.
 * Static (compile-time) because it ties together kline interval, slug pattern,
 * and phase timings that all need to agree.
 *
 * Phase timings (units = ms; in code) are RELATIVE to window boundaries:
 *   preview   = windowStart + previewOffsetMs     (emit T+? signal)
 *   decision  = windowEnd   - decisionOffsetMs    (try place boundary order)
 *   recheck   = windowEnd   - recheckOffsetMs     (final confirm / cancel; null = no recheck)
 *
 * 5m default: T+4s preview, T-3s decision, no recheck (window too short).
 * 1h default: T+40min preview, T-10min decision, T-30s recheck (1h window has
 * room for conditions to shift between place and close).
 */
export interface CoinMeta {
  windowMs:           number;
  binanceInterval:    '5m' | '15m' | '1h';
  previewOffsetMs:    number;
  decisionOffsetMs:   number;
  recheckOffsetMs:    number | null;
  /** Build the Polymarket event slug for the window whose START is unixSec. */
  slugForWindow:      (unixSec: number) => string;
}

const SLUG_PREFIX_5M: Record<string, string> = {
  BTC: 'btc-updown-5m-', ETH: 'eth-updown-5m-', SOL: 'sol-updown-5m-',
  XRP: 'xrp-updown-5m-', DOGE: 'doge-updown-5m-', HYPE: 'hype-updown-5m-',
  BNB: 'bnb-updown-5m-',
};
// 5m preview opens at T+4 MINUTES (= windowEnd - 1min, not T+4 seconds — the
// CLAUDE.md doc was misleading; pre-refactor const T_PLUS_4_MS was 240_000ms
// = 4 minutes from window start). At T+4min the bar has enough data for a
// reliable streak/body3 read; the slot retries every tick until placement
// setTimeout fires at T-3s.
const make5mMeta = (sym: string): CoinMeta => ({
  windowMs: 300_000, binanceInterval: '5m',
  previewOffsetMs: 240_000, decisionOffsetMs: 3_000, recheckOffsetMs: null,
  slugForWindow: (unixSec) => `${SLUG_PREFIX_5M[sym]}${unixSec}`,
});

/** Slug for a 1h Polymarket up/down market. Format observed (gamma-api):
 *  `{name}-up-or-down-{month}-{day}-{year}-{hour}{am|pm}-et`
 *  Examples: `bitcoin-up-or-down-may-27-2026-6am-et`,
 *            `ethereum-up-or-down-june-12-2026-2am-et`.
 *  `name` is the long coin name on Polymarket (bitcoin / ethereum). Date/hour
 *  are in ET (America/New_York, DST-aware). The hour is the START of the 1h
 *  candle (e.g. 6am-et = candle 06:00→07:00 ET). */
function formatCrypto1hSlug(name: string, unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', month: 'long', day: 'numeric',
    year: 'numeric', hour: 'numeric', hour12: true,
  }).formatToParts(d);
  const month = parts.find(p => p.type === 'month')!.value.toLowerCase();
  const day   = parts.find(p => p.type === 'day')!.value;
  const year  = parts.find(p => p.type === 'year')!.value;
  const hour  = parts.find(p => p.type === 'hour')!.value;
  const ampm  = parts.find(p => p.type === 'dayPeriod')!.value.toLowerCase();
  return `${name}-up-or-down-${month}-${day}-${year}-${hour}${ampm}-et`;
}

export const COIN_META: Record<CoinSymbol, CoinMeta> = {
  BTC:  make5mMeta('BTC'),
  ETH:  make5mMeta('ETH'),
  SOL:  make5mMeta('SOL'),
  XRP:  make5mMeta('XRP'),
  DOGE: make5mMeta('DOGE'),
  HYPE: make5mMeta('HYPE'),
  BNB:  make5mMeta('BNB'),
  BTC_1H: {
    windowMs:         3_600_000,    // 1 hour
    binanceInterval:  '1h',
    previewOffsetMs:  40 * 60_000,  // T+40min — emit preview signal + Telegram
    decisionOffsetMs: 10 * 60_000,  // T-10min — place boundary order
    recheckOffsetMs:  30_000,       // T-30s   — recheck + cancel if conditions flipped
    slugForWindow:    (s) => formatCrypto1hSlug('bitcoin', s),
  },
  ETH_1H: {
    windowMs:         3_600_000,
    binanceInterval:  '1h',
    previewOffsetMs:  40 * 60_000,
    decisionOffsetMs: 10 * 60_000,
    recheckOffsetMs:  30_000,
    slugForWindow:    (s) => formatCrypto1hSlug('ethereum', s),
  },
  // BTC_15m — 15-minute timeframe. Slug family matches 5m (btc-updown-{tf}-{unix}),
  // not the 1h date format. Phase dispatch is generic (COIN_META offsets), same as
  // BTC_1H. Edges (s2/s4/s5 ratio) discovered on 365d Binance 15m — see EDGE_CASES.md.
  BTC_15m: {
    windowMs:         900_000,     // 15 min
    binanceInterval:  '15m',
    previewOffsetMs:  720_000,     // T+12min — preview signal + Telegram (~80% in, like 5m's 4/5)
    decisionOffsetMs: 3_000,       // T-3s — place boundary order (same as 5m)
    recheckOffsetMs:  null,        // no recheck (window short like 5m)
    slugForWindow:    (s) => `btc-updown-15m-${s}`,
  },
};
export type CoinMode    = 'signal_only' | 'signal_and_order';
/**
 * Available strategies:
 *   'streak' (= simple) — baseline: trade contrarian whenever |streak| ≥ auto_order_min_streak.
 *                         Existing behavior, fires continuously when threshold is met.
 *   'echo'   — Echo Hunt: only trade in the ~30min window AFTER a streak ≥ trigger_streak
 *              just ended. Empirical edge ≈ 78–96% WR on BTC vs ~52% baseline. Pure echo —
 *              outside the arm window the bot stays dormant.
 */
export type CoinStrategy = 'streak' | 'echo';

/**
 * Echo idle-mode override edge case. User-defined patterns that can FORCE
 * a fire when the normal threshold gate (`echo_baseline_streak`) would
 * reject. Configured per coin via Settings UI — list of objects with their
 * own streak range + body3 thresholds (entry + DCA).
 *
 * Matching logic: when streak < baseline AND streak ∈ [streakMin, streakMax]
 * AND |body3| ≥ body3Min, the FIRST enabled edge case in array order wins.
 * The matching case's `id` is recorded on the cycle state so its
 * `dcaBody3Min` applies for any subsequent DCA placement on that cycle
 * (overrides the global dca_body3_min_idle).
 *
 * Apply ONLY in idle mode (armed mode has its own threshold drop so doesn't
 * need overrides). Empty array = no overrides (baseline-only gating).
 *
 * Per-coin tuning required because body3 is absolute price-USD — BTC ~500,
 * ETH ~30, etc. scale with asset price level. Reference 365d BTC data:
 *   • streak=3 + body3 ≥ 575 → P(rev)=65% / P(trap)=4.5% (n=89)
 *   • streak=4 + body3 ≥ 475 → P(rev)=59% / P(trap)=1.3% (n=76)
 *   • streak=4 + body3 ≥ 175 → P(rev)=58% / P(trap)=10%  (n=455)
 */
export interface EchoEdgeCase {
  /** Stable identifier — used as React key + tag on cycles that fired via
   *  this case (for picking the right DCA threshold). Generated by UI. */
  id:           string;
  /** User-friendly label shown in UI. Optional. */
  label?:       string;
  /** Off = ignored by matcher (kept for editing without losing values). */
  enabled:      boolean;
  /** Inclusive min EFFECTIVE streak for this case to match. Effective streak
   *  = closed streak + the aligning in-progress current bar at T-3s (the streak
   *  actually being faded). Equals backtest streakLen[i]. NB: a "3 closed DOWN
   *  + current DOWN" setup is effectiveStreak=4 → matches streakMin/Max=4. */
  streakMin:    number;
  /** Inclusive max effective streak — typically 3-4 for short-streak overrides. */
  streakMax:    number;
  /** |body3| floor (price USD, last 3 closed bars + in-progress at T-3s)
   *  for entry. Absolute-dollar gate. */
  body3Min:     number;
  /**
   * Optional REGIME-RELATIVE entry gate: body3 / (avgBody × 3) ≥ this, where
   * avgBody = mean |close-open| over the 48-bar baseline. When set (> 0), this
   * REPLACES the dollar `body3Min` gate for this case. Self-adapts across
   * volatility regimes — the same threshold means "move N× the local normal"
   * whether BTC is calm or active.
   *
   * Empirically (BTC 90d, out-of-sample validated) the ratio is a far stronger
   * fade filter than fixed dollars: it separates an "exhaustion spike on a
   * calm backdrop" (good fade) from a "normal-sized move in an active market"
   * (bad fade) — which a fixed dollar threshold conflates. Avg-body window 48
   * (4h) is the stable sweet spot (shorter = noisy, longer = overfits/lags).
   * Recommended: streak=3 → 1.2, streak=6/7 → 1.0.
   *
   * 0 / undefined = use the dollar `body3Min` gate instead (backward compat).
   */
  body3OverAvgMin?: number;
  /** Optional upper bound on body3 for this case to match. Used to skip the
   *  "high-momentum continuation" regime where the streak is still in trend
   *  rather than exhaustion. Empirically (BTC 365d): at streak=5 with body3
   *  >$700, P(reversal)=46.5% (trap); momentum runs ~2 more bars before
   *  exhausting at streak=7 (62-82% reversal). Capping streak5 edge body3
   *  ≤700 makes the bot wait for the streak7 edge instead. Streak3/4 don't
   *  show this trap pattern (body3>700 still ≥55% reversal). */
  body3Max?:    number;
  /** |body3| floor for DCA placement when this case opened the cycle.
   *  Typically lower than body3Min (averaging-down accepts weaker signal). */
  dcaBody3Min:  number;

  // ── Extended conditions (clustering + magnitude). All optional; when set,
  //    ANDed with the streak + body gates above. Computed from the 48-bar
  //    baseline at T+4 (SignalT4Event.edgeContext). Backtest: EDGE_CASES.md.

  /** CLUSTERING: require ≥ `priorCountMin` prior same-direction streak-peaks
   *  ≥ this value, that ended within `priorWindowMin` minutes before the
   *  current run started. "Exhaustion clustering" — e.g. streak4 fades 58%→
   *  OOS 61% when a prior ≥5 ran within 30m. 0/undefined = no clustering gate. */
  priorStreakMin?: number;
  /** CLUSTERING: lookback window in minutes for the prior-peak scan. */
  priorWindowMin?: number;
  /** CLUSTERING: min count of qualifying prior peaks (default 1; 2 = double). */
  priorCountMin?:  number;

  /** MAGNITUDE: require |% move over the last 12 closed bars| (= 1h on 5m), in
   *  the streak direction, ≥ this. "Đã tăng bao nhiêu" — recent momentum. On 5m
   *  streak=3, ≥0.38% → 58% / OOS 60%. 0/undefined = no momentum gate. */
  momentumPctMin?: number;
  /** MAGNITUDE: require |% move over the streak's bars|, in the streak
   *  direction, ≥ this. Over-extension of THIS run. 1h streak=4 ≥1.85% → 62% /
   *  OOS 59%; 1h streak=2 ≥0.90% → 56%. 0/undefined = no cum-move gate. */
  cumMovePctMin?:  number;
  /** REGIME (chop filter): require Kaufman efficiency-ratio over the last 12
   *  closed bars ≥ this. Skips CHOPPY conditions where the fade loses (ER<0.25 →
   *  53% WR < breakeven). ≥0.25 recommended (2yr OOS: pooled Δ+$350, and turns
   *  BTC from −$96 to +$152). 0/undefined = no chop gate. Range 0–1. */
  efficiencyRatioMin?: number;
}

/**
 * One row in `auto_schedule`: overrides `auto_order_min_streak` during the
 * `duration_hours` starting at `start_hour` (UTC). Entries don't have to
 * partition the day — hours not covered fall back to the base value.
 *
 * Hour ranges can wrap midnight (e.g., start_hour=22, duration_hours=4 covers
 * 22,23,0,1 UTC). When multiple entries match the current hour, the FIRST
 * one wins (order matters — put most-specific first).
 */
export interface AutoScheduleEntry {
  start_hour:      number;   // 0-23 UTC
  duration_hours:  number;   // 1-24
  threshold:       number;   // override for auto_order_min_streak
}

export interface CoinConfig {
  enabled:              boolean;
  strategy:             CoinStrategy;
  mode:                 CoinMode;
  /** Emit T+4 signal (notification) when |streak| ≥ this. */
  streak_min:           number;
  /** Place order at T-3s when |streak| ≥ this (AND mode=signal_and_order). */
  auto_order_min_streak: number;
  /**
   * Optional hour-of-day override for auto_order_min_streak. If empty or no
   * entry matches the current UTC hour, `auto_order_min_streak` is used.
   * Example: `[{start_hour: 18, duration_hours: 2, threshold: 3}]` → threshold
   * drops to 3 between 18:00-20:00 UTC, uses base outside that window.
   */
  auto_schedule:        AutoScheduleEntry[];
  size_usdc:            number;
  limit_price_cents:    number;
  tp_cents:             number;
  sl_cents:             number;

  // ── Trend-break kill-switch (echo) ────────────────────────────────────────
  // Fade strategies bleed in sustained trends (streaks keep extending). When
  // the rolling realized fade WR drops below the floor, pause new boundary
  // placements for a cooldown of would-be entries — self-clears when WR
  // recovers. Backtest (BTC 5m 180d): pause at WR<0.45 over last 30 cut maxDD
  // 21% while keeping PnL (the one robust kill-switch — streak-extension and
  // tighter WR floors hurt). The real protection against a regime flip — a
  // long window picks the edge, this caps the tail.
  /** Master toggle. Default false. */
  echo_killswitch_enabled: boolean;
  /** Rolling window of realized fades to measure WR over. Default 30. */
  echo_killswitch_window:  number;
  /** Pause when rolling WR < this (0-1). Default 0.45 (clearly-losing; 0.50
   *  pauses too eagerly and hurt in backtest). */
  echo_killswitch_wr_min:  number;
  /** Would-be boundary placements to skip once engaged. Default 10. */
  echo_killswitch_cooldown: number;
  /** DCA size = previous_loser_size × dca_multiplier. Default 1.5. */
  dca_multiplier:       number;
  /**
   * Whitelist of |parent_streak| values at which DCA is allowed to fire.
   * Empty (default) = DCA fires on every loss cycle (backward compat).
   * Non-empty: DCA only fires when the parent boundary's signal streak abs
   * matches one of these values.
   *
   * Example: BTC `[4, 6, 9, 10]` → DCA only after a streak-4/6/9/10 loss.
   *          SOL `[6, 12]`       → DCA only after a streak-6 or streak-12 loss.
   *
   * Orders placed before this field existed have `streak_5m=0` in DB and will
   * NOT match any non-zero whitelist (DCA skipped — safe-by-default).
   */
  dca_streak_whitelist: number[];

  // ── Echo Hunt strategy params ──────────────────────────────────────────────
  // Only used when `strategy === 'echo'`. Defaults derived from BTC 180d
  // analysis (1276 echo events, 79.3% WR baseline 52.5%). User-tunable per coin.
  /** A streak ≥ this length, when it ENDS, opens a fresh arm window. */
  echo_trigger_streak: number;
  /** How long the arm window stays open after the trigger ends. */
  echo_window_minutes: number;
  /** Inside the arm window, fire signal/order when |streak| ≥ this. Lower than
   *  trigger to capture micro-pullbacks within the echo. */
  echo_signal_min_streak: number;
  /**
   * Idle baseline placement threshold for echo strategy (when NOT armed).
   * Echo always trades — outside the arm window it uses this safe threshold,
   * inside the arm window it drops to `echo_signal_min_streak`. Independent
   * from `auto_order_min_streak` (which streak strategy uses) so the two
   * strategies can be tuned separately without interference.
   */
  echo_baseline_streak: number;
  /**
   * V9 body-composition filter for echo strategy. When true, an order is
   * only placed when at least ONE bar in the streak has body > 1.5× the
   * 48-bar average body. Empirically (BTC 180d): +2.2% reversal-rate edge
   * vs unfiltered, with ~66% of trade frequency. Recommended on by default.
   * Set false to disable filter and trade every streak ≥ threshold.
   */
  echo_require_high_body: boolean;
  /**
   * Idle-mode override edge cases. When the normal threshold gate would skip,
   * these patterns can force a fire. Empty = no overrides (default).
   * See `EchoEdgeCase` for the available list and rationale.
   */
  echo_edge_cases: EchoEdgeCase[];
  /**
   * DCA size multipliers for echo strategy when a cycle was opened in ARMED
   * mode (inside the arm window). Indexed by loss-count: after the Nth
   * consecutive loss, next size = `cfg.size_usdc × echo_dca_scale[N-1]`.
   * Empty = no DCA. Bounded by array length (no infinite compounding).
   *
   * Example: `[3, 4]` → after L1 = base×3, after L2 = base×4, then stop.
   */
  echo_dca_scale: number[];
  /**
   * DCA size multipliers for echo strategy when a cycle was opened in IDLE
   * mode (baseline threshold, no recent trigger). Idle bets have lower edge
   * (~52% WR vs ~78% armed), so users typically want a more conservative
   * scale here. Empty array → fall back to `echo_dca_scale` (no separation).
   */
  echo_dca_scale_idle: number[];

  // ── Defensive regime detection (echo only) ────────────────────────────────
  // Tracks time since last extreme streak (≥ `defensive_streak_threshold`).
  // When the gap exceeds `defensive_overdue_minutes`, the market is in an
  // unusually quiet regime that empirically precedes outsized streaks (vol
  // clustering). Bot enters defensive mode to limit downside on the eventual
  // breakout.
  /** Master toggle for defensive regime detection. */
  echo_defensive_enabled: boolean;
  /** Streak length at/above which an event resets the "last extreme" timer.
   *  Default 7 — matches the analysis: streak ≥ 7 occurs roughly every 12-16h
   *  on BTC, so a longer gap signals abnormality. */
  echo_defensive_streak_threshold: number;
  /** Minutes since last extreme streak before bot enters defensive mode.
   *  Default 1440 (24h). */
  echo_defensive_overdue_minutes: number;
  /**
   * What to do when defensive:
   *   'disable_armed' — bot still trades baseline (idle threshold) but never
   *                     drops to armed threshold. Arm window can refresh but
   *                     doesn't lower the bar.
   *   'skip_all'      — bot suspends all placement until an extreme streak
   *                     resets the timer.
   */
  echo_defensive_action: 'disable_armed' | 'skip_all';

  // ── Chain regime soft-defensive (echo only) ───────────────────────────────
  // PREDICTIVE mode: track time since last "chain event" (cluster of arm
  // events in a short window). When the gap exceeds a data-derived overdue
  // threshold, the next chain is statistically due — enter defensive mode
  // (bump entry threshold so only STRONG setups fire). Auto-clears when the
  // next chain event manifests.
  //
  // Empirical (BTC 60d): chain event = ≥2 arms in 1h. Inter-event gap p75
  // ≈ 27h; samples in 32-64h gap range show 1.25x lift in P(chain in next
  // 6h). Modest predictive signal but consistent with vol-clustering.
  /** Master toggle for chain predictive defensive. */
  echo_chain_enabled: boolean;
  /** A chain event is recorded when ≥ this many arms fire within
   *  `echo_chain_event_window_min` of each other. Default 2. */
  echo_chain_event_arm_count: number;
  /** Minutes window for clustering arm events into a chain event. Default 60. */
  echo_chain_event_window_min: number;
  /** Defensive activates when (now - lastChainEventAt) exceeds this. Use a
   *  data-derived value (e.g., p75 of historical inter-event gaps).
   *  Default 1600 = ~27h (BTC p75). */
  echo_chain_overdue_min: number;
  /** Bump added to echo_signal_min_streak when defensive active (armed mode). */
  echo_chain_signal_bump: number;
  /** Bump added to echo_baseline_streak when defensive active (idle mode). */
  echo_chain_baseline_bump: number;

  // ── Body-3 gate (data-driven entry quality filter) ────────────────────────
  // Sum of |close-open| (absolute, in price USD) for the last 3 CLOSED
  // Binance bars before window start. Lets the bot skip "trend still strong"
  // setups: streak length is the same but body3 distinguishes a fading move
  // (good fade) from a steadily-running trend (bad fade — keeps extending).
  //
  // Empirical 365d BTC (5m bars):
  //   • streak=5 + body3 ≥ $400 → P(reversal)=62.7%, P(trapped to 7+)=13.3%
  //   • streak=5 + body3 < $300 → P(reversal)=46-52%, P(trapped)=23-29% — avoid
  //   • streak=3 (armed) + body3 ≥ $300 → P(reversal)=55.8%, P(trapped)=5.5%
  //
  // Set 0 to disable the gate (preserves prior behavior).
  /** Minimum |body3| for IDLE-mode entry (echo strategy). 0 = disabled. */
  idle_body3_min:  number;
  /** Minimum |body3| for ARMED-mode entry. 0 = disabled. */
  armed_body3_min: number;
  /**
   * Minimum |body3| of the TRIGGERING streak required to OPEN an arm window.
   * Gates the ARM decision itself (not placement) — a streak hitting
   * `echo_trigger_streak` whose body3 is below this won't drop the threshold.
   * Count-only arming was net-dilutive in backtest (worse than not arming on
   * 180d/365d BTC): weak-body3 arms open choppy-regime cycles that bleed via
   * DCA. 0 = disabled (arm on streak count alone — prior behaviour).
   * See apps/api/scripts/analyze-arm-body3.ts. BTC=100: keeps the high-WR
   * $100-200 band (~70%) and drops only the toxic <$100 arms (0-17% WR).
   * (A ~350 floor maxes TOTAL WR + cuts drawdown on trending regimes but
   * throws away that best band — a more defensive, lower-profit choice.)
   */
  arm_trigger_body3_min: number;
  /** Optional max |body3| for arm trigger. Skip arming when body3 > this —
   *  these bars are momentum-continuation (streak still trending, not
   *  exhausted). Empirical (BTC 365d, momentum lifetime analysis): at
   *  streak=5 + body3>$700, P(reversal next bar)=46.5%; reversal lift only
   *  shows up at streak=7 (62-82%). Capping arm body3≤700 makes the bot
   *  wait through the momentum continuation and arm only on the eventual
   *  exhaustion. 0 / undefined = no cap (prior behaviour).
   *  See apps/api/scripts/analyze-momentum-lifetime.ts. */
  arm_trigger_body3_max?: number;
  /** Optional max streak for arm trigger. Skip arming when streak > this —
   *  empirically (BTC 365d) streak ≥9 has P(rev)=47% (over-extension trap,
   *  trend continues). Backtest shows streak_max=8 lift PnL +$29/yr and
   *  cuts DD on top of armT=350. 0 / undefined = no cap. */
  arm_trigger_streak_max?: number;
  /** Minimum |body3| for DCA placement when the CYCLE was opened in IDLE mode
   *  (state.cycleMode === 'idle'). Recomputed at the NEW boundary, after the
   *  loss extended the streak. 0 = disabled. */
  dca_body3_min_idle:  number;
  /** Minimum |body3| for DCA placement when the CYCLE was opened in ARMED
   *  mode. Typically lower than idle (armed cycles already validated regime).
   *  0 = disabled. */
  dca_body3_min_armed: number;
}

export type CoinConfigs = Partial<Record<CoinSymbol, CoinConfig>>;

const DEFAULT_CONFIG: CoinConfig = {
  enabled:               false,
  strategy:              'streak',
  mode:                  'signal_only',
  streak_min:            3,
  auto_order_min_streak: 5,
  auto_schedule:         [],
  size_usdc:             5,
  limit_price_cents:     54,
  tp_cents:              75,
  sl_cents:              25,
  dca_multiplier:        1.5,
  dca_streak_whitelist:  [],
  // Echo defaults from BTC 90d sensitivity analysis: trigger=5 (sweet spot,
  // ~15 events/day), signal=4 (89% WR balanced), window=30m (edge dies after).
  echo_trigger_streak:    5,
  echo_window_minutes:    30,
  echo_signal_min_streak: 4,
  echo_baseline_streak:   6,
  echo_require_high_body: true,
  echo_edge_cases:        [],
  echo_dca_scale:         [3, 4],
  echo_dca_scale_idle:    [],          // empty → fall back to echo_dca_scale
  echo_defensive_enabled:           false,
  echo_defensive_streak_threshold:  7,
  echo_defensive_overdue_minutes:   1440,
  echo_defensive_action:            'disable_armed',
  // Trend-break kill-switch (off by default; opt-in per coin).
  echo_killswitch_enabled:          false,
  echo_killswitch_window:           30,
  echo_killswitch_wr_min:           0.45,
  echo_killswitch_cooldown:         10,
  // Chain predictive defensive defaults (off by default; opt-in per coin).
  // Defaults derived from BTC 60d data:
  //   chain event = ≥2 arms in 60min (gap median 13.8h, p75 26.6h)
  //   overdue threshold = ~p75 = 1600min (≈27h) → top quartile of gaps
  echo_chain_enabled:               false,
  echo_chain_event_arm_count:       2,
  echo_chain_event_window_min:      60,
  echo_chain_overdue_min:           1600,
  echo_chain_signal_bump:           2,
  echo_chain_baseline_bump:         1,
  // Body-3 gate: disabled by default. Users opt-in per coin via Settings
  // (sensible BTC values: idle 400, armed 300, DCA idle 200, DCA armed 150).
  idle_body3_min:                   0,
  armed_body3_min:                  0,
  arm_trigger_body3_min:            0,
  dca_body3_min_idle:               0,
  dca_body3_min_armed:              0,
};

export const ALL_COINS: readonly CoinSymbol[] = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'HYPE', 'BNB', 'BTC_1H', 'ETH_1H', 'BTC_15m'];

/**
 * Per-coin overrides applied on top of DEFAULT_CONFIG. Used for fields where
 * a single global default would be wrong for some coins (e.g. body3 thresholds
 * scale with the coin's typical price). User-saved values still win — these
 * just provide better starting points than 0.
 *
 * BTC body3 defaults derived from 365d BTC 5m analysis (see
 * apps/api/scripts/analyze-armed-fade.ts):
 *   idle  ≥ $400  → streak 5+ reversal 62.7%, trapped 13.3%
 *   armed ≥ $300  → streak 3+ reversal 55.8%, trapped 5.5%
 *   DCA   ≥ $200/$150 — looser to allow recovery on borderline cycles
 *   arm-trigger ≥ $100 — keeps the high-WR $100-200 band (~70% reversal) and
 *     drops only the toxic <$100 arms (0-17% WR). Count-only arming was
 *     net-dilutive (analyze-arm-body3.ts). A ~350 floor maxes TOTAL WR +
 *     cuts drawdown on trending regimes but sacrifices the best band.
 *
 * Other coins need their own analysis before getting non-zero defaults — the
 * absolute USD body sums scale with price (ETH ≈ $30 for similar pct move,
 * SOL ≈ $5 etc). Until analysed they stay disabled.
 */
export const PER_COIN_OVERRIDES: Partial<Record<CoinSymbol, Partial<CoinConfig>>> = {
  BTC: {
    idle_body3_min:              400,
    armed_body3_min:             300,
    arm_trigger_body3_min:       350,
    arm_trigger_body3_max:       700,
    arm_trigger_streak_max:      8,
    dca_body3_min_idle:          200,
    dca_body3_min_armed:         150,
  },
  // BTC_1H — 1h timeframe variant. Phase logic NOT yet implemented in worker
  // (added 2026-05-27, see PriceMonitoringWorker.tick: non-5m coins skip
  // phase dispatch). Body3 thresholds undefined here — 1h bars have a very
  // different USD scale than 5m bars (typical 1h |body| can be $1000+), so
  // values must be recalibrated via fresh 1h backtest before enabling.
  // Until then, leave enabled=false (DEFAULT_CONFIG inherits).
  BTC_1H: {
    strategy:                    'echo',
    size_usdc:                   5,
    limit_price_cents:           69,
    tp_cents:                    95,
    sl_cents:                    10,
    streak_min:                  2,
    echo_trigger_streak:         3,    // 1h streak=3 ≈ 3-hour run (rare); placeholder
    echo_window_minutes:         360,  // 6h arm window — placeholder
    echo_signal_min_streak:      2,
    echo_baseline_streak:        4,
  },
  // BTC_15m — universal-edge echo (s2/s4/s5 ratio). Baseline streak set high so
  // only edge cases fire; size $2 (sane on shared ~$45 balance — base $24 would
  // blow up, see sim). DB-stored config is source of truth; these are defaults.
  BTC_15m: {
    strategy:                    'echo',
    size_usdc:                   2,
    limit_price_cents:           57,
    streak_min:                  2,
    echo_baseline_streak:        99,   // edge-only — baseline never fires
  },
};

export async function getAllCoinConfigs(): Promise<CoinConfigs> {
  const { rows } = await getPool().query<{ value: string }>(
    `SELECT value FROM settings WHERE key = 'coin_configs'`,
  );
  if (!rows[0]) return {};
  try { return JSON.parse(rows[0].value) as CoinConfigs; }
  catch { return {}; }
}

export async function getCoinConfig(symbol: CoinSymbol): Promise<CoinConfig> {
  const all = await getAllCoinConfigs();
  const stored = all[symbol];
  const coinDefaults = { ...DEFAULT_CONFIG, ...(PER_COIN_OVERRIDES[symbol] ?? {}) };
  if (!stored) return coinDefaults;
  // Merge order:
  //   1. DEFAULT_CONFIG (global)
  //   2. PER_COIN_OVERRIDES (per-coin tuned defaults — e.g. BTC body3 values)
  //   3. stored (user-saved DB values — always win)
  // So configs saved before a field existed still get sensible defaults
  // (auto_schedule added in #026, body3 in #2026-05-15 etc).
  const merged = { ...coinDefaults, ...stored };
  // Migrate: drop pre-2026-05-15 string-enum echo_edge_cases entries
  // (replaced by EchoEdgeCase objects). String entries make matchEchoEdgeCase
  // throw at runtime; safer to filter at config load.
  const cases = merged.echo_edge_cases as unknown;
  if (Array.isArray(cases)) {
    merged.echo_edge_cases = cases.filter(c =>
      c != null && typeof c === 'object' && typeof (c as { id?: unknown }).id === 'string'
    ) as CoinConfig['echo_edge_cases'];
  } else {
    merged.echo_edge_cases = [];
  }
  return merged;
}

export async function getEnabledCoins(): Promise<CoinSymbol[]> {
  const all = await getAllCoinConfigs();
  return ALL_COINS.filter(c => all[c]?.enabled === true);
}

export async function updateCoinConfig(
  symbol: CoinSymbol, patch: Partial<CoinConfig>,
): Promise<CoinConfig> {
  const all = await getAllCoinConfigs();
  const next: CoinConfig = { ...DEFAULT_CONFIG, ...(all[symbol] ?? {}), ...patch };
  const merged: CoinConfigs = { ...all, [symbol]: next };
  await getPool().query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = $3`,
    ['coin_configs', JSON.stringify(merged), Date.now()],
  );
  return next;
}
