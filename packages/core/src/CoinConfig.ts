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
export type CoinStrategy = 'streak';       // extend later

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
  /** Place order at T-30s when |streak| ≥ this (AND mode=signal_and_order). */
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
