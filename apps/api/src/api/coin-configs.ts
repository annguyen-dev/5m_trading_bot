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
  PER_COIN_OVERRIDES,
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
  echo_trigger_streak:    5,
  echo_window_minutes:    30,
  echo_signal_min_streak: 4,
  echo_baseline_streak:   6,
  echo_require_high_body: true,
  echo_edge_cases:        [],
  echo_dca_scale:         [3, 4],
  echo_dca_scale_idle:    [],
  echo_defensive_enabled:           false,
  echo_defensive_streak_threshold:  7,
  echo_defensive_overdue_minutes:   1440,
  echo_defensive_action:            'disable_armed',
  echo_chain_enabled:               false,
  echo_chain_event_arm_count:       2,
  echo_chain_event_window_min:      60,
  echo_chain_overdue_min:           1600,
  echo_chain_signal_bump:           2,
  echo_chain_baseline_bump:         1,
  idle_body3_min:                   0,
  armed_body3_min:                  0,
  arm_trigger_body3_min:            0,
  dca_body3_min_idle:               0,
  dca_body3_min_armed:              0,
};

/** GET /api/coin-configs → array of { symbol, ...config } for all 7 coins. */
export async function listCoinConfigs(_req: Request, res: Response): Promise<void> {
  try {
    const all = await getAllCoinConfigs();
    // Merge over DEFAULT_CONFIG so configs saved BEFORE a field existed (e.g.
    // pre-echo BTC config) still expose defaults for the newer fields. Without
    // this, FE renders empty inputs and validation fails on otherwise-saved coins.
    // Merge: DEFAULT_CONFIG → PER_COIN_OVERRIDES (e.g. BTC body3 tuned values)
    // → stored. So FE sees sensible per-coin defaults for fields the user
    // hasn't explicitly set.
    const rows = ALL_COINS.map(sym => {
      const merged = {
        symbol: sym,
        ...DEFAULT_CONFIG,
        ...(PER_COIN_OVERRIDES[sym] ?? {}),
        ...(all[sym] ?? {}),
      };
      // Migrate: pre-2026-05-15 echo_edge_cases was string[] (enum names);
      // post-migration it's EchoEdgeCase[] (objects). Drop any non-object
      // legacy entries so FE doesn't try to render strings as objects and
      // PUT validation doesn't fail on missing `id`.
      const cases = merged.echo_edge_cases as unknown;
      if (Array.isArray(cases)) {
        merged.echo_edge_cases = cases.filter(c =>
          c != null && typeof c === 'object' && typeof (c as { id?: unknown }).id === 'string'
        ) as typeof merged.echo_edge_cases;
      } else {
        merged.echo_edge_cases = [];
      }
      return merged;
    });
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
  strategy:              z.enum(['streak', 'echo']).optional(),
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
  // Echo Hunt params (only relevant when strategy='echo'). Loose ranges —
  // the FE enforces logical relationships (signal ≤ trigger ≤ disable).
  echo_trigger_streak:    z.number().int().min(1).max(20).optional(),
  echo_window_minutes:    z.number().int().min(1).max(240).optional(),
  echo_signal_min_streak: z.number().int().min(1).max(20).optional(),
  echo_baseline_streak:   z.number().int().min(1).max(20).optional(),
  echo_require_high_body: z.boolean().optional(),
  echo_edge_cases:        z.array(z.object({
    id:          z.string().min(1).max(64),
    label:       z.string().max(60).optional(),
    enabled:     z.boolean(),
    streakMin:   z.number().int().min(2).max(20),
    streakMax:   z.number().int().min(2).max(20),
    body3Min:    z.number().min(0).max(10_000),
    dcaBody3Min: z.number().min(0).max(10_000),
  })).max(16).optional(),
  echo_dca_scale:         z.array(z.number().min(1).max(20)).max(10).optional(),
  echo_dca_scale_idle:    z.array(z.number().min(1).max(20)).max(10).optional(),
  echo_defensive_enabled:          z.boolean().optional(),
  echo_defensive_streak_threshold: z.number().int().min(3).max(20).optional(),
  echo_defensive_overdue_minutes:  z.number().int().min(10).max(43200).optional(),  // 10min..30d
  echo_defensive_action:           z.enum(['disable_armed', 'skip_all']).optional(),
  // Body-3 gates (price USD). 0 = disabled. Wide bound to cover any coin
  // (BTC body3 can hit thousands; ETH/SOL smaller). FE chooses sensible
  // per-coin defaults.
  idle_body3_min:                  z.number().min(0).max(10_000).optional(),
  armed_body3_min:                 z.number().min(0).max(10_000).optional(),
  arm_trigger_body3_min:           z.number().min(0).max(10_000).optional(),
  dca_body3_min_idle:              z.number().min(0).max(10_000).optional(),
  dca_body3_min_armed:             z.number().min(0).max(10_000).optional(),
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
