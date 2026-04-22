/**
 * GET /api/settings
 *   → { settings: {...}, hasPolymarketKey, effectiveTradingMode }
 *
 * PUT /api/settings/:key  body: { value: string }
 *
 * Allowed keys + validation:
 *   trading_mode          'simulate' | 'live'   (+ 'live' requires POLY_PRIVATE_KEY)
 *   signal_min_streak     integer 1-10
 *   auto_order_min_streak integer 1-10          (must be ≥ signal_min_streak)
 *
 * Also exposes helpers:
 *   getTradingMode()          → 'simulate' | 'live'
 *   getSignalMinStreak()      → number
 *   getAutoOrderMinStreak()   → number
 *
 * Effective trading mode: if POLY_PRIVATE_KEY is missing, force 'simulate'
 * regardless of the DB setting (defence in depth).
 */
import type { Request, Response } from 'express';
import { getPool } from '@trading-bot/db';
import { migrate } from '@trading-bot/db/migrate';

type StreakKey = 'signal_min_streak' | 'auto_order_min_streak';
type CentsKey  = 'auto_order_limit_price_cents' | 'auto_order_tp_cents' | 'auto_order_sl_cents'
               | 'dca_max_entry_cents'
               | 'panic_entry_cents' | 'panic_tp_cents';
type SecKey    = 'panic_first_window_s';
type UsdcKey   = 'auto_order_base_size_usdc' | 'auto_order_dca_step_usdc';

const TRADING_MODE_KEY = 'trading_mode';
const STREAK_KEYS: readonly StreakKey[] = ['signal_min_streak', 'auto_order_min_streak'] as const;
const CENTS_KEYS: readonly CentsKey[] = [
  'auto_order_limit_price_cents', 'auto_order_tp_cents', 'auto_order_sl_cents',
  'dca_max_entry_cents', 'panic_entry_cents', 'panic_tp_cents',
] as const;
const SEC_KEYS: readonly SecKey[] = ['panic_first_window_s'] as const;
const USDC_KEYS: readonly UsdcKey[] =
  ['auto_order_base_size_usdc', 'auto_order_dca_step_usdc'] as const;

const ALLOWED_KEYS = new Set<string>([
  TRADING_MODE_KEY, ...STREAK_KEYS, ...CENTS_KEYS, ...SEC_KEYS, ...USDC_KEYS,
]);
const ALLOWED_TRADING_MODE = new Set(['simulate', 'live']);

const STREAK_MIN = 1;
const STREAK_MAX = 10;

const CENTS_MIN = 1;
const CENTS_MAX = 99;

// USDC sizes: base ≥ 1, step ≥ 0 (0 = disable DCA), cap 100 to avoid runaway bets
const USDC_MIN: Record<UsdcKey, number> = {
  auto_order_base_size_usdc: 1,
  auto_order_dca_step_usdc:  0,
};
const USDC_MAX = 100;

const DEFAULTS: Record<StreakKey, number> = {
  signal_min_streak:     3,
  auto_order_min_streak: 4,
};
const CENTS_DEFAULTS: Record<CentsKey, number> = {
  auto_order_limit_price_cents: 55,
  auto_order_tp_cents:          75,
  auto_order_sl_cents:          25,
  dca_max_entry_cents:          40,   // DCA-add trigger — ask for held direction ≤ this
  panic_entry_cents:             5,   // Panic bottom-fishing trigger — ask ≤ this
  panic_tp_cents:               20,   // Panic TP — limit SELL fills at this price
};
const SEC_DEFAULTS: Record<SecKey, number> = {
  panic_first_window_s: 180,           // Panic only fires in first 3 minutes of a window
};
const SEC_MIN = 30;
const SEC_MAX = 270;                  // must be < 300 (window size) so there's exit room
const USDC_DEFAULTS: Record<UsdcKey, number> = {
  auto_order_base_size_usdc: 5,
  auto_order_dca_step_usdc:  5,
};

let schemaReady = false;
async function ensureReady(): Promise<void> {
  if (!schemaReady) { await migrate(); schemaReady = true; }
}

function hasPolymarketKey(): boolean {
  // Live CLOB trading requires a signer private key (Phase 2C).
  return Boolean(process.env['POLY_PRIVATE_KEY']);
}

// ── Read helpers ──────────────────────────────────────────────────────────

async function readValue(key: string): Promise<string | undefined> {
  await ensureReady();
  const { rows } = await getPool().query<{ value: string }>(
    `SELECT value FROM settings WHERE key = $1`, [key],
  );
  return rows[0]?.value;
}

async function readStreak(key: StreakKey): Promise<number> {
  const raw = await readValue(key);
  const n = Number(raw);
  return Number.isFinite(n) ? n : DEFAULTS[key];
}

export async function getTradingMode(): Promise<'simulate' | 'live'> {
  const stored = (await readValue(TRADING_MODE_KEY)) ?? 'simulate';
  const mode: 'simulate' | 'live' = stored === 'live' ? 'live' : 'simulate';
  return mode === 'live' && hasPolymarketKey() ? 'live' : 'simulate';
}

export async function getSignalMinStreak():    Promise<number> { return readStreak('signal_min_streak'); }
export async function getAutoOrderMinStreak(): Promise<number> { return readStreak('auto_order_min_streak'); }

async function readCents(key: CentsKey): Promise<number> {
  const raw = await readValue(key);
  const n = Number(raw);
  if (!Number.isInteger(n) || n < CENTS_MIN || n > CENTS_MAX) return CENTS_DEFAULTS[key];
  return n;
}

/** Max cents we'll pay for an auto-placed share (best_ask above this → skip). */
export async function getAutoOrderLimitPriceCents(): Promise<number> { return readCents('auto_order_limit_price_cents'); }
/** Path A take-profit trigger (exit when bestBid of held side ≥ this cents). */
export async function getAutoOrderTpCents():         Promise<number> { return readCents('auto_order_tp_cents'); }
/** Path A stop-loss trigger (exit when bestBid of held side ≤ this cents). */
export async function getAutoOrderSlCents():         Promise<number> { return readCents('auto_order_sl_cents'); }
/** DCA-add entry ceiling — trigger only when ask for held direction ≤ this cents. */
export async function getDcaMaxEntryCents():         Promise<number> { return readCents('dca_max_entry_cents'); }
/** Panic bottom-fishing entry ceiling — ask for streak-matching side ≤ this cents. */
export async function getPanicEntryCents():          Promise<number> { return readCents('panic_entry_cents'); }
/** Panic take-profit — limit SELL fills at this price. */
export async function getPanicTpCents():             Promise<number> { return readCents('panic_tp_cents'); }

async function readSec(key: SecKey): Promise<number> {
  const raw = await readValue(key);
  const n = Number(raw);
  if (!Number.isInteger(n) || n < SEC_MIN || n > SEC_MAX) return SEC_DEFAULTS[key];
  return n;
}
/** Panic only fires within this many seconds from window start (need exit room). */
export async function getPanicFirstWindowS():     Promise<number> { return readSec('panic_first_window_s'); }

async function readUsdc(key: UsdcKey): Promise<number> {
  const raw = await readValue(key);
  const n = Number(raw);
  if (!Number.isInteger(n) || n < USDC_MIN[key] || n > USDC_MAX) return USDC_DEFAULTS[key];
  return n;
}
/** Base USDC size for auto orders (Path A before DCA scaling; DCA & Panic always flat). */
export async function getAutoOrderBaseSizeUsdc(): Promise<number> { return readUsdc('auto_order_base_size_usdc'); }
/** DCA step — add this many USDC per prior consecutive Path A loss (0 = disabled). */
export async function getAutoOrderDcaStepUsdc():  Promise<number> { return readUsdc('auto_order_dca_step_usdc'); }

// ── Boundary signal history (persistent for adaptive autoMin) ────────────
// Stored as JSON array of unsigned |streak| values, newest at the end.
// Survives restarts so the conditional autoMin rules (last=5→3, etc.) stay
// correct across process restarts.
export async function getBoundarySignalHistory(): Promise<number[]> {
  await ensureReady();
  const raw = await readValue('boundary_signal_history');
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.filter((n): n is number => typeof n === 'number' && Number.isFinite(n));
  } catch { return []; }
}
export async function setBoundarySignalHistory(history: number[]): Promise<void> {
  await ensureReady();
  await getPool().query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = $3`,
    ['boundary_signal_history', JSON.stringify(history), Date.now()],
  );
}

// ── Validation ────────────────────────────────────────────────────────────

function parseStreakValue(value: string): number | null {
  const n = Number(value);
  if (!Number.isInteger(n)) return null;
  if (n < STREAK_MIN || n > STREAK_MAX) return null;
  return n;
}

// ── HTTP handlers ─────────────────────────────────────────────────────────

export async function listSettings(_req: Request, res: Response): Promise<void> {
  try {
    await ensureReady();
    const { rows } = await getPool().query<{ key: string; value: string }>(
      `SELECT key, value FROM settings`,
    );
    const map: Record<string, string> = Object.fromEntries(rows.map(r => [r.key, r.value]));
    res.json({
      settings:         map,
      hasPolymarketKey: hasPolymarketKey(),
      effectiveTradingMode: await getTradingMode(),
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
}

export async function updateSetting(req: Request, res: Response): Promise<void> {
  try {
    await ensureReady();
    const key   = String(req.params['key'] ?? '');
    const value = String((req.body as { value?: unknown })?.value ?? '');

    if (!ALLOWED_KEYS.has(key)) {
      res.status(400).json({ error: `Unknown setting: ${key}` });
      return;
    }

    // ── trading_mode ──────────────────────────────────────────────────────
    if (key === TRADING_MODE_KEY) {
      if (!ALLOWED_TRADING_MODE.has(value)) {
        res.status(400).json({ error: `trading_mode must be 'simulate' or 'live'` });
        return;
      }
      if (value === 'live' && !hasPolymarketKey()) {
        res.status(400).json({ error: 'Cannot enable live mode — POLY_PRIVATE_KEY not configured' });
        return;
      }
    }

    // ── cents-valued keys (limit, tp, sl, dca, panic) ─────────────────────
    if (CENTS_KEYS.includes(key as CentsKey)) {
      const n = Number(value);
      if (!Number.isInteger(n) || n < CENTS_MIN || n > CENTS_MAX) {
        res.status(400).json({
          error: `${key} must be an integer in [${CENTS_MIN}, ${CENTS_MAX}]`,
        });
        return;
      }
      // TP > SL invariant
      if (key === 'auto_order_tp_cents') {
        const sl = await readCents('auto_order_sl_cents');
        if (n <= sl) {
          res.status(400).json({ error: `tp (${n}) must be > sl (${sl})` });
          return;
        }
      }
      if (key === 'auto_order_sl_cents') {
        const tp = await readCents('auto_order_tp_cents');
        if (n >= tp) {
          res.status(400).json({ error: `sl (${n}) must be < tp (${tp})` });
          return;
        }
      }
      // Panic invariant: TP > entry (exit must be above entry for profit)
      if (key === 'panic_entry_cents') {
        const tp = await readCents('panic_tp_cents');
        if (n >= tp) {
          res.status(400).json({ error: `panic_entry (${n}) must be < panic_tp (${tp})` });
          return;
        }
      }
      if (key === 'panic_tp_cents') {
        const entry = await readCents('panic_entry_cents');
        if (n <= entry) {
          res.status(400).json({ error: `panic_tp (${n}) must be > panic_entry (${entry})` });
          return;
        }
      }
    }

    // ── seconds-valued keys (panic window) ───────────────────────────────
    if (SEC_KEYS.includes(key as SecKey)) {
      const n = Number(value);
      if (!Number.isInteger(n) || n < SEC_MIN || n > SEC_MAX) {
        res.status(400).json({
          error: `${key} must be an integer seconds in [${SEC_MIN}, ${SEC_MAX}]`,
        });
        return;
      }
    }

    // ── USDC amounts (base size, DCA step) ───────────────────────────────
    if (USDC_KEYS.includes(key as UsdcKey)) {
      const n = Number(value);
      const min = USDC_MIN[key as UsdcKey];
      if (!Number.isInteger(n) || n < min || n > USDC_MAX) {
        res.status(400).json({
          error: `${key} must be an integer in [${min}, ${USDC_MAX}]`,
        });
        return;
      }
    }

    // ── streak thresholds ─────────────────────────────────────────────────
    if (STREAK_KEYS.includes(key as StreakKey)) {
      const n = parseStreakValue(value);
      if (n == null) {
        res.status(400).json({ error: `${key} must be an integer in [${STREAK_MIN}, ${STREAK_MAX}]` });
        return;
      }
      // Invariant: auto_order_min_streak ≥ signal_min_streak
      const otherKey: StreakKey = key === 'signal_min_streak' ? 'auto_order_min_streak' : 'signal_min_streak';
      const otherVal = await readStreak(otherKey);
      if (key === 'signal_min_streak' && n > otherVal) {
        res.status(400).json({
          error: `signal_min_streak (${n}) can't exceed auto_order_min_streak (${otherVal})`,
        });
        return;
      }
      if (key === 'auto_order_min_streak' && n < otherVal) {
        res.status(400).json({
          error: `auto_order_min_streak (${n}) can't be below signal_min_streak (${otherVal})`,
        });
        return;
      }
    }

    await getPool().query(
      `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = $3`,
      [key, value, Date.now()],
    );
    res.json({ ok: true, effectiveTradingMode: await getTradingMode() });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
}
