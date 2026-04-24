/**
 * HTTP CRUD for Telegram channel routing config.
 *
 *   GET /api/telegram-channels          → array
 *   PUT /api/telegram-channels          → replace whole array (simplest)
 *
 * Single-document model matches `coin_configs`: the FE always sends the full
 * channel list; server validates and saves atomically.
 */
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  getTelegramChannels, saveTelegramChannels,
  type TelegramChannel,
} from '@trading-bot/core/telegramChannels';
import { ALL_COINS } from '@trading-bot/core/CoinConfig';

const COIN_ENUM = z.enum(ALL_COINS as unknown as [string, ...string[]]);

const channelSchema = z.object({
  id:         z.string().min(1).max(64),
  name:       z.string().max(100),
  channel_id: z.string().min(1).max(64),
  enabled:    z.boolean(),
  coins:      z.array(COIN_ENUM).max(20),
  info_types: z.array(z.enum(['signal', 'order'])).max(2),
}).strict();

const bodySchema = z.object({
  channels: z.array(channelSchema).max(32),
}).strict();

export async function listTelegramChannels(_req: Request, res: Response): Promise<void> {
  try {
    const channels = await getTelegramChannels();
    res.json({ channels });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
}

export async function replaceTelegramChannels(req: Request, res: Response): Promise<void> {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid body', details: parsed.error.issues });
    return;
  }
  try {
    // Ensure IDs are unique within the array (simple O(n) check).
    const ids = new Set<string>();
    for (const ch of parsed.data.channels) {
      if (ids.has(ch.id)) {
        res.status(400).json({ error: `duplicate channel id: ${ch.id}` });
        return;
      }
      ids.add(ch.id);
    }
    await saveTelegramChannels(parsed.data.channels as TelegramChannel[]);
    res.json({ channels: parsed.data.channels });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
}
