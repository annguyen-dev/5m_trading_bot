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

export interface CoinConfig {
  enabled:              boolean;
  strategy:             CoinStrategy;
  mode:                 CoinMode;
  /** Emit T+4 signal (notification) when |streak| ≥ this. */
  streak_min:           number;
  /** Place order at T-30s when |streak| ≥ this (AND mode=signal_and_order). */
  auto_order_min_streak: number;
  size_usdc:            number;
  limit_price_cents:    number;
  tp_cents:             number;
  sl_cents:             number;
}

export type CoinConfigs = Partial<Record<CoinSymbol, CoinConfig>>;

const DEFAULT_CONFIG: CoinConfig = {
  enabled:               false,
  strategy:              'streak',
  mode:                  'signal_only',
  streak_min:            3,
  auto_order_min_streak: 5,
  size_usdc:             5,
  limit_price_cents:     54,
  tp_cents:              75,
  sl_cents:              25,
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
  return all[symbol] ?? { ...DEFAULT_CONFIG };
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
