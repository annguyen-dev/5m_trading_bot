/**
 * src/services/resultGate.ts
 *
 * Result-momentum gate — POOLED across the configured coins.
 *
 * The bot's win/loss sequence is positively autocorrelated (regime persistence):
 * after a LOSS the next signal wins ~50%, after a WIN ~60% (lag-1 +10pp on n≈16k
 * BTC+ETH 5m triggers). So we PAUSE real betting after K consecutive losses and
 * RESUME after R paper-wins (keep evaluating outcomes while paused, just don't bet).
 *
 * Backtest (BTC+ETH 5m, 365d, base $1): ROLLING walk-forward (optimise K/R on
 * prior data only, apply out-of-sample, 9 chunks) picks K=1/R=1 in 9/9 chunks
 * and beats always-on in 9/9 (OOS Δ +$551 vs always-on +$322). K=1 ("bet only
 * right after a win") is the purest lag-1 expression: after a win next WR ~60%,
 * after a loss ~50%. A fixed-K2 in-sample grid showed only +$211 — that grid
 * never tested K1. PER-COIN is *worse* than always-on (regime is cross-coin, so
 * the state MUST be pooled). Volume / ratio / streak / co-move-only / window-
 * dedupe filters did NOT help; this pooled consec-loss gate is the only win.
 *
 * Stored in `settings.result_gate` (config) and `settings.result_gate_state`
 * (live state, persisted so a worker restart doesn't lose the pause; paper-signals
 * never reach poly_orders so we can't replay from orders).
 */
import { getPool } from '@trading-bot/db';
import type { CoinSymbol } from './CoinConfig';

export interface ResultGateConfig {
  enabled:     boolean;
  /** Pause real orders after this many consecutive losses (K). */
  pauseLosses: number;
  /** Resume after this many consecutive paper-wins while paused (R). */
  resumeWins:  number;
  /** Pooled across these coins; coins not listed are never gated. */
  coins:       CoinSymbol[];
}

export interface ResultGateState {
  consecLosses:     number;
  paused:           boolean;
  consecPausedWins: number;
}

export const DEFAULT_RESULT_GATE: ResultGateConfig = {
  enabled: false, pauseLosses: 1, resumeWins: 1, coins: [],   // K=1/R=1 = walk-forward winner
};
export const INITIAL_GATE_STATE: ResultGateState = {
  consecLosses: 0, paused: false, consecPausedWins: 0,
};

/**
 * Pure transition for ONE settled signal outcome (real or paper). Returns the
 * next state and whether this outcome flipped the gate (for notifications).
 */
export function applyOutcome(
  s: ResultGateState, win: boolean, cfg: ResultGateConfig,
): { state: ResultGateState; transition: 'paused' | 'resumed' | null } {
  let { consecLosses, paused, consecPausedWins } = s;
  let transition: 'paused' | 'resumed' | null = null;
  if (!paused) {
    if (win) { consecLosses = 0; }
    else {
      consecLosses++;
      if (consecLosses >= cfg.pauseLosses) { paused = true; consecPausedWins = 0; transition = 'paused'; }
    }
  } else {
    if (win) {
      consecPausedWins++;
      if (consecPausedWins >= cfg.resumeWins) { paused = false; consecLosses = 0; consecPausedWins = 0; transition = 'resumed'; }
    } else { consecPausedWins = 0; }
  }
  return { state: { consecLosses, paused, consecPausedWins }, transition };
}

/** Whether a REAL order may be placed for `coin` given the gate state. */
export function gateAllows(coin: CoinSymbol, cfg: ResultGateConfig, s: ResultGateState): boolean {
  if (!cfg.enabled || !cfg.coins.includes(coin)) return true;  // coin not gated → always allowed
  return !s.paused;
}

export async function getResultGateConfig(): Promise<ResultGateConfig> {
  const { rows } = await getPool().query<{ value: string }>(
    `SELECT value FROM settings WHERE key = 'result_gate'`,
  );
  if (!rows[0]) return { ...DEFAULT_RESULT_GATE };
  try { return { ...DEFAULT_RESULT_GATE, ...(JSON.parse(rows[0].value) as Partial<ResultGateConfig>) }; }
  catch { return { ...DEFAULT_RESULT_GATE }; }
}

export async function loadResultGateState(): Promise<ResultGateState> {
  const { rows } = await getPool().query<{ value: string }>(
    `SELECT value FROM settings WHERE key = 'result_gate_state'`,
  );
  if (!rows[0]) return { ...INITIAL_GATE_STATE };
  try { return { ...INITIAL_GATE_STATE, ...(JSON.parse(rows[0].value) as Partial<ResultGateState>) }; }
  catch { return { ...INITIAL_GATE_STATE }; }
}

export async function saveResultGateState(s: ResultGateState): Promise<void> {
  await getPool().query(
    `INSERT INTO settings (key, value, updated_at) VALUES ('result_gate_state', $1, $2)
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = $2`,
    [JSON.stringify(s), Date.now()],
  );
}
