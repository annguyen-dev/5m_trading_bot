/**
 * src/services/CoinConfig.ts
 *
 * Helpers to read/write the per-coin strategy config stored as a single JSON
 * blob in settings.coin_configs (see migration 021).
 *
 * Uppercase symbols throughout ("BTC", "ETH", ...).
 */
import { getPool } from '@trading-bot/db';

export type CoinSymbol  = 'BTC' | 'ETH' | 'SOL' | 'XRP' | 'DOGE' | 'HYPE' | 'BNB';
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
 * Echo idle-mode override edge cases. When the normal threshold gate would
 * skip an order, these patterns can FORCE a fire if the streak's body
 * composition matches a confirmed "early fire" signature.
 *
 * Implemented (BTC 180d data):
 *   - 'short_streak_strong_mean': streak 3-4 + mean body > 1.5× avg. Sample
 *     1384, WR 58.1%, Δ +4.5% over baseline. (A1)
 *   - 'mid_streak_very_extreme':  streak 5-7 + ≥1 bar body > 4× avg. Sample
 *     217, WR 58.5%, Δ +6.2%. (A3)
 *
 * Documented for future evaluation (need cross-coin / longer-window confirm):
 *   - 'short_streak_three_high':       streak 3-4 + ≥3 high-body bars       (A2: WR 58.3%, n=271, Δ+4.7%)
 *   - 'short_streak_all_above_avg':    streak 3-4 + min ratio > 1.0×        (A5: WR 59.2%, n=500, Δ+5.6%)
 *   - 'mid_streak_three_consec_high':  streak 5-7 + ≥3 consec high          (A4: WR 57.5%, n=120, Δ+5.2%)
 *   - 'short_streak_four_consec_high': streak 3-4 + 4 consec high           (B1: WR 69.6%, n=23,  Δ+16.0% — sample tiny)
 *
 * Apply ONLY in idle mode (armed mode bypasses — its natural edge is strong
 * enough). Multiple overrides can be enabled — any match fires.
 */
export type EchoEdgeCase =
  | 'short_streak_strong_mean'
  | 'mid_streak_very_extreme';

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
};

export const ALL_COINS: readonly CoinSymbol[] = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'HYPE', 'BNB'];

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
  if (!stored) return { ...DEFAULT_CONFIG };
  // Merge over defaults so configs saved before a field existed still get
  // sensible defaults for the new field (e.g., auto_schedule added in #026).
  return { ...DEFAULT_CONFIG, ...stored };
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
