/**
 * Telegram channel routing config — stored as JSON in `settings.telegram_channels`.
 *
 * Each channel has:
 *   - channel_id: the Telegram chat/channel ID the bot posts to
 *   - coins: symbols to subscribe to (empty = ALL enabled coins)
 *   - info_types: which event categories to forward:
 *       'signal' → T+4 (streak emission)
 *       'order'  → T+0 (active), T-3s (placement), T-0 (close/DCA/cancel)
 *     (empty = ALL)
 *   - enabled: toggle without losing config
 *
 * Storage key: `telegram_channels`. Single JSON array.
 */
import { getPool } from '@trading-bot/db';
import type { CoinSymbol } from './CoinConfig.js';

export type TelegramInfoType = 'signal' | 'order';

export interface TelegramChannel {
  id:         string;               // client-generated UUID (stable for edits)
  name:       string;               // user-friendly label
  channel_id: string;               // Telegram chat ID (e.g. "-1001234567890")
  enabled:    boolean;
  coins:      CoinSymbol[];         // empty array = subscribe to all coins
  info_types: TelegramInfoType[];   // empty array = subscribe to all types
}

const SETTINGS_KEY = 'telegram_channels';

export async function getTelegramChannels(): Promise<TelegramChannel[]> {
  const { rows } = await getPool().query<{ value: string }>(
    `SELECT value FROM settings WHERE key = $1`,
    [SETTINGS_KEY],
  );
  if (!rows[0]) return [];
  try {
    const parsed = JSON.parse(rows[0].value) as unknown;
    return Array.isArray(parsed) ? (parsed as TelegramChannel[]) : [];
  } catch { return []; }
}

export async function saveTelegramChannels(channels: TelegramChannel[]): Promise<void> {
  await getPool().query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = $3`,
    [SETTINGS_KEY, JSON.stringify(channels), Date.now()],
  );
}

/** True if the channel should receive an event for (coin, info_type). */
export function channelMatches(
  ch: TelegramChannel, coin: CoinSymbol, info: TelegramInfoType,
): boolean {
  if (!ch.enabled) return false;
  if (ch.coins.length      > 0 && !ch.coins.includes(coin))     return false;
  if (ch.info_types.length > 0 && !ch.info_types.includes(info)) return false;
  return true;
}
