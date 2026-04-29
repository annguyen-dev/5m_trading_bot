/**
 * src/api/coin-configs.ts
 *
 * CRUD for the per-coin strategy config (settings.coin_configs JSON blob).
 * FE settings page uses these to toggle coins and tweak streak_min/size/etc.
 */
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  ALL_COINS,
  getAllCoinConfigs,
  updateCoinConfig,
  type CoinSymbol,
  type CoinConfig,
} from '@trading-bot/core/CoinConfig';

// Default shown for coins not yet in the JSON blob (matches DEFAULT_CONFIG
// in CoinConfig.ts — duplicated here intentionally so FE doesn't see empty).
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
};

/** GET /api/coin-configs → array of { symbol, ...config } for all 7 coins. */
export async function listCoinConfigs(_req: Request, res: Response): Promise<void> {
  try {
    const all = await getAllCoinConfigs();
    const rows = ALL_COINS.map(sym => ({
      symbol: sym,
      ...(all[sym] ?? DEFAULT_CONFIG),
    }));
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
}

// ── PUT /api/coin-configs/:symbol ─────────────────────────────────────────

const autoScheduleEntrySchema = z.object({
  start_hour:     z.number().int().min(0).max(23),
  duration_hours: z.number().int().min(1).max(24),
  threshold:      z.number().int().min(1).max(20),
}).strict();

const patchSchema = z.object({
  enabled:               z.boolean().optional(),
  strategy:              z.enum(['streak']).optional(),
  mode:                  z.enum(['signal_only', 'signal_and_order']).optional(),
  streak_min:            z.number().int().min(1).max(20).optional(),
  auto_order_min_streak: z.number().int().min(1).max(20).optional(),
  auto_schedule:         z.array(autoScheduleEntrySchema).max(8).optional(),
  size_usdc:             z.number().positive().max(10_000).optional(),
  limit_price_cents:     z.number().int().min(1).max(99).optional(),
  tp_cents:              z.number().int().min(1).max(99).optional(),
  sl_cents:              z.number().int().min(1).max(99).optional(),
  dca_multiplier:        z.number().min(1.0).max(10.0).optional(),
  dca_streak_whitelist:  z.array(z.number().int().min(2).max(20)).max(20).optional(),
}).strict();

export async function updateCoinConfigHandler(
  req: Request, res: Response,
): Promise<void> {
  const symbolRaw = String(req.params['symbol'] ?? '').toUpperCase();
  if (!ALL_COINS.includes(symbolRaw as CoinSymbol)) {
    res.status(400).json({ error: `unknown symbol: ${symbolRaw}` });
    return;
  }
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid body', details: parsed.error.issues });
    return;
  }
  try {
    const next = await updateCoinConfig(symbolRaw as CoinSymbol, parsed.data);
    res.json({ symbol: symbolRaw, ...next });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
}
