/**
 * packages/core/src/retry.ts
 *
 * Tiny exponential-backoff retry helper for flaky external APIs.
 * Used by CLOB calls (Polymarket) and Binance/Pyth bar fetches.
 *
 * Design:
 *   - Default 3 attempts, base 200ms, exponential backoff with ±100ms jitter.
 *   - Pre-classifies errors: only retry on transient (network, 5xx, timeout).
 *     Terminal errors (signature invalid, insufficient balance, bad request)
 *     throw immediately so we don't pile retries on a sure-fail call.
 *   - Logs warn per retry attempt with the configurable label.
 */
import { log } from './observability/logger.js';

export interface RetryOpts {
  maxAttempts?: number;     // default 3
  baseDelayMs?: number;     // default 200
  jitterMs?:    number;     // default 100
  /** Optional override of the retriable-error classifier. */
  isRetriable?: (err: Error) => boolean;
}

const TRANSIENT_PATTERNS = [
  'fetch failed',
  'ECONNRESET',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'socket hang up',
  'network',
  'timeout',
  '502',
  '503',
  '504',
  'rate limit',
  'too many requests',
  // Polymarket-specific: CTF balance lag after BUY fill (~1-3s). We poll
  // via waitForTokenBalance first, but retry as safety net if still stale.
  'not enough balance',
  'balance is not enough',
];

/** Default classifier — true if the error message looks transient. */
export function defaultIsRetriable(err: Error): boolean {
  const msg = (err.message ?? String(err)).toLowerCase();
  return TRANSIENT_PATTERNS.some(p => msg.includes(p.toLowerCase()));
}

/**
 * Run `fn` with retry. Each failure waits `baseDelayMs * 2^(attempt-1) + jitter`.
 * Throws the last error after all attempts exhausted.
 */
export async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  opts: RetryOpts = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const baseDelay   = opts.baseDelayMs ?? 200;
  const jitter      = opts.jitterMs    ?? 100;
  const isRetriable = opts.isRetriable ?? defaultIsRetriable;

  let lastErr: Error | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      // Don't retry terminal errors (e.g., bad signature) — fail fast.
      if (!isRetriable(lastErr)) {
        throw lastErr;
      }
      if (attempt < maxAttempts) {
        const delay = Math.round(baseDelay * Math.pow(2, attempt - 1) + Math.random() * jitter);
        log('warn', `withRetry: ${label} attempt ${attempt}/${maxAttempts} failed, retry in ${delay}ms`, {
          error: lastErr.message,
        });
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  // Final failure
  log('warn', `withRetry: ${label} exhausted after ${maxAttempts} attempts`, {
    error: lastErr?.message,
  });
  throw lastErr ?? new Error(`${label} failed (no error captured)`);
}
