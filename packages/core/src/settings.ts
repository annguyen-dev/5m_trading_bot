/**
 * packages/core/src/settings.ts
 *
 * Lightweight DB-read helpers used by core services + workers. The full
 * Express handlers + write logic live in apps/api/src/handlers/settings.ts.
 *
 * Single source of truth — apps/api re-exports these helpers for its own
 * routes so reads always come from one place.
 */
import { getPool } from '@trading-bot/db';

const DEFAULT_TP_CENTS = 75;
const DEFAULT_SL_CENTS = 25;
const CENTS_MIN = 1;
const CENTS_MAX = 99;

async function readValue(key: string): Promise<string | null> {
  const { rows } = await getPool().query<{ value: string }>(
    'SELECT value FROM settings WHERE key = $1',
    [key],
  );
  return rows[0]?.value ?? null;
}

async function readCents(key: string, fallback: number): Promise<number> {
  const raw = await readValue(key);
  const n = Number(raw);
  if (!Number.isInteger(n) || n < CENTS_MIN || n > CENTS_MAX) return fallback;
  return n;
}

/** Effective trading mode — 'live' requires POLYMARKET_API_KEY env. */
export async function getTradingMode(): Promise<'simulate' | 'live'> {
  const stored = (await readValue('trading_mode')) ?? 'simulate';
  const requested: 'simulate' | 'live' = stored === 'live' ? 'live' : 'simulate';
  const hasKey = !!(process.env['POLYMARKET_API_KEY'] && process.env['POLY_PRIVATE_KEY']);
  return requested === 'live' && hasKey ? 'live' : 'simulate';
}

/** Take-profit cents — fallback 75. */
export async function getAutoOrderTpCents(): Promise<number> {
  return readCents('auto_order_tp_cents', DEFAULT_TP_CENTS);
}

/** Stop-loss cents — fallback 25. */
export async function getAutoOrderSlCents(): Promise<number> {
  return readCents('auto_order_sl_cents', DEFAULT_SL_CENTS);
}
