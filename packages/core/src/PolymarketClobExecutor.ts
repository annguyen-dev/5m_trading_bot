/**
 * src/services/PolymarketClobExecutor.ts
 *
 * Thin wrapper around @polymarket/clob-client for live order placement.
 *
 * Responsibilities:
 *   - init()          → derive L2 ApiKeyCreds from the signer's private key
 *   - placeMarketBuy  → FOK market BUY on a YES/NO token (USDC → shares)
 *   - placeLimitSell  → GTC limit SELL for TP/SL children
 *   - cancelOrder     → cancel a resting GTC order by its CLOB orderID
 *
 * All prices are in dollars (0 < p < 1). All USDC amounts are dollars.
 *
 * Env:
 *   POLY_PRIVATE_KEY     hex string starting with 0x (EOA signing key)
 *   POLY_FUNDER_ADDRESS  optional — proxy/safe address that holds USDC.
 *                        Required for anything other than raw-EOA setups.
 *   POLY_SIGNATURE_TYPE  optional — 'eoa' | 'proxy' | 'safe' (default: 'safe'
 *                        when POLY_FUNDER_ADDRESS is set, 'eoa' otherwise).
 *                        Use 'safe' for MetaMask-connected Polymarket wallets
 *                        (Gnosis Safe proxy). Use 'proxy' for email/magic-link
 *                        accounts. 'eoa' only if USDC is on the EOA directly.
 *
 * Chain: Polygon mainnet (137) only. Polymarket CLOB is not on testnet.
 */
import { Wallet } from 'ethers';
import {
  ClobClient,
  Chain,
  Side,
  OrderType,
  SignatureTypeV2,
  AssetType,
  type ApiKeyCreds,
} from '@polymarket/clob-client-v2';
import { log } from './observability/logger.js';
import { withRetry } from './retry.js';

const CLOB_HOST = 'https://clob.polymarket.com';

// SignatureTypeV2 is the post-CLOB-V2 enum (April 2026 cutover). Same values
// as the old SignatureType (EOA=0, POLY_PROXY=1, POLY_GNOSIS_SAFE=2) — only
// the import name changed.
function resolveSignatureType(raw: string | undefined, funderSet: boolean): SignatureTypeV2 {
  const key = (raw ?? '').trim().toLowerCase();
  if (key === 'eoa')   return SignatureTypeV2.EOA;
  if (key === 'proxy') return SignatureTypeV2.POLY_PROXY;
  if (key === 'safe')  return SignatureTypeV2.POLY_GNOSIS_SAFE;
  // Default: MetaMask-connected Polymarket wallets are Gnosis Safes, so
  // if a funder is set we assume Safe. Bare EOA setups fall back to EOA.
  return funderSet ? SignatureTypeV2.POLY_GNOSIS_SAFE : SignatureTypeV2.EOA;
}

interface OrderResponse {
  success?: boolean;
  /** Polymarket returns 'error' (not 'errorMsg' as the SDK type claims) on failures. */
  error?:    string;
  errorMsg?: string;
  orderID?:  string;
  status?:   string | number;
  takingAmount?: string;
  makingAmount?: string;
  /** Allow pass-through of any other fields so we can log them. */
  [k: string]: unknown;
}

function respErrorMessage(resp: OrderResponse): string {
  return resp.error
      || resp.errorMsg
      || (resp.status != null ? `status=${resp.status}` : '')
      || 'no error message';
}

export class PolymarketClobExecutor {
  private client: ClobClient | null = null;
  private address = '';

  /** Load private key, derive L2 creds, build fully-authed ClobClient. */
  async init(): Promise<void> {
    const pk = process.env['POLY_PRIVATE_KEY'];
    if (!pk || !pk.startsWith('0x')) {
      throw new Error('POLY_PRIVATE_KEY missing or not 0x-prefixed');
    }
    const wallet = new Wallet(pk);
    this.address = await wallet.getAddress();

    const funderEnv = process.env['POLY_FUNDER_ADDRESS'];
    const funder    = funderEnv ?? this.address;
    const sigType   = resolveSignatureType(
      process.env['POLY_SIGNATURE_TYPE'], Boolean(funderEnv),
    );

    // V2 SDK: constructor takes an options object (was positional in V1).
    // `chain` replaced `chainId`. signer/funder semantics unchanged.

    // Stage 1: L1-only client (for deriveApiKey).
    const l1 = new ClobClient({
      host: CLOB_HOST, chain: Chain.POLYGON,
      signer: wallet, signatureType: sigType, funderAddress: funder,
    });
    const creds: ApiKeyCreds = await l1.createOrDeriveApiKey();

    // Stage 2: re-init with creds for L2 auth (order placement).
    this.client = new ClobClient({
      host: CLOB_HOST, chain: Chain.POLYGON,
      signer: wallet, creds, signatureType: sigType, funderAddress: funder,
    });

    log('info', 'PolymarketClobExecutor initialized', {
      address: this.address,
      funder,
      sigType: SignatureTypeV2[sigType],
    });

    // Preflight: dump collateral balance + allowance so the user can see
    // immediately if either is 0 (common cause of silent order rejections).
    // Fire-and-forget — we don't want a slow Polymarket API call to block
    // the whole server bootstrap.
    this.client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL })
      .then(ba => {
        log('info', 'CLOB USDC balance/allowance', {
          balance: ba.balance, allowance: ba.allowance,
        });
      })
      .catch(err => {
        log('warn', 'CLOB preflight getBalanceAllowance failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  /** Throws if init() wasn't called (or failed). */
  private mustClient(): ClobClient {
    if (!this.client) throw new Error('PolymarketClobExecutor not initialized');
    return this.client;
  }

  /**
   * Market BUY — spend up to `usdcAmount` USDC on `tokenID`. FAK so partial
   * fills are accepted and any unfilled remainder is killed. Polymarket 5m
   * books are often thin at top-of-book; FOK fails frequently when bids
   * can't absorb the full size at `maxPrice`. With FAK we take whatever's
   * available, and the caller records the ACTUAL filled USDC/shares in DB.
   *
   * Returns: orderID + actual filled USDC + actual filled shares.
   * Throws if 0 shares were filled (full FAK kill).
   */
  async placeMarketBuy(
    tokenID: string, usdcAmount: number, maxPrice: number,
  ): Promise<{ orderID: string; filledUsdc: number; filledShares: number }> {
    const client = this.mustClient();
    log('info', 'CLOB market BUY attempt', {
      tokenID, usdcAmount, maxPrice,
      sigType: SignatureTypeV2[client.orderBuilder.signatureType],
      signer:  this.address,
    });
    // CRITICAL: throw on resp.success=false INSIDE the retry callback so
    // withRetry can classify the message and retry on transient failures
    // (FAK no-match, balance lag, etc.). If we instead returned the bad
    // resp and threw outside, the retry layer never sees the failure.
    //
    // 5 attempts × 300ms base → up to ~4.5s. FAK no-match typically resolves
    // in 200-500ms as new asks land; this gives the book a few chances.
    const resp: OrderResponse = await withRetry('CLOB market BUY', async () => {
      const r: OrderResponse = await client.createAndPostMarketOrder(
        { tokenID, amount: usdcAmount, side: Side.BUY, price: maxPrice },
        undefined,
        OrderType.FAK,
      );
      if (!r.success || !r.orderID) {
        throw new Error(respErrorMessage(r));
      }
      return r;
    }, { maxAttempts: 5, baseDelayMs: 300 });
    // FAK response: makingAmount = USDC we spent, takingAmount = shares acquired.
    const filledUsdc   = Number(resp.makingAmount ?? 0);
    const filledShares = Number(resp.takingAmount ?? 0);
    log('info', 'CLOB market BUY response (FAK)', {
      tokenID, requested_usdc: usdcAmount,
      filledUsdc, filledShares,
      avg_price: filledShares > 0 ? filledUsdc / filledShares : null,
      status: resp.status, success: resp.success,
    });
    if (filledShares === 0) {
      throw new Error('CLOB market BUY filled 0 shares (FAK kill — book empty at limit)');
    }
    return { orderID: resp.orderID!, filledUsdc, filledShares };
  }

  /**
   * Market SELL — sell `shares` shares of `tokenID` at current bid (FAK).
   *
   * FAK (Fill-And-Kill): partial fills accepted, unfilled portion killed. We
   * use FAK instead of FOK because Polymarket's BTC 5m markets often have
   * thin top-of-book liquidity — an FOK for 15-30 shares would frequently
   * fail outright when bids only cover 5-10 shares at the trigger level.
   * With FAK we take whatever's available, log the actual filled amount,
   * and the caller can re-attempt for residual shares if any remain.
   *
   * Returns the CLOB orderID. Caller should inspect resp.makingAmount to
   * compare requested vs actually-sold shares (logged at info level here).
   */
  async placeMarketSell(
    tokenID: string, shares: number,
  ): Promise<string> {
    const client = this.mustClient();
    log('info', 'CLOB market SELL attempt', {
      tokenID, shares,
      sigType: SignatureTypeV2[client.orderBuilder.signatureType],
      signer:  this.address,
    });
    // Throw on resp.success=false INSIDE retry callback (same reasoning as
    // placeMarketBuy) so withRetry can classify + retry transient failures.
    const resp: OrderResponse = await withRetry('CLOB market SELL', async () => {
      const r: OrderResponse = await client.createAndPostMarketOrder(
        { tokenID, amount: shares, side: Side.SELL, orderType: OrderType.FAK },
        undefined,
        OrderType.FAK,
      );
      if (!r.success || !r.orderID) {
        throw new Error(respErrorMessage(r));
      }
      return r;
    }, { maxAttempts: 5, baseDelayMs: 300 });
    log('info', 'CLOB market SELL response (FAK)', {
      tokenID, requested_shares: shares,
      makingAmount: resp.makingAmount,    // shares actually sold
      takingAmount: resp.takingAmount,    // USDC actually received
      status: resp.status,
      success: resp.success,
    });
    return resp.orderID!;
  }

  /**
   * Limit SELL — resting GTC order at `price` for `shares` shares.
   * Used for TP and SL children. Returns the CLOB orderID.
   */
  async placeLimitSell(
    tokenID: string, price: number, shares: number,
  ): Promise<string> {
    const client = this.mustClient();
    const resp: OrderResponse = await withRetry('CLOB limit SELL', async () => {
      const r: OrderResponse = await client.createAndPostOrder(
        { tokenID, price, size: shares, side: Side.SELL },
        undefined,
        OrderType.GTC,
      );
      if (!r.success || !r.orderID) {
        throw new Error(respErrorMessage(r));
      }
      return r;
    });
    log('info', 'CLOB limit SELL response', { tokenID, price, shares, resp });
    if (!resp.success || !resp.orderID) {
      throw new Error(`CLOB limit SELL failed: ${respErrorMessage(resp)}`);
    }
    return resp.orderID;
  }

  /**
   * Poll CLOB until our balance for `tokenID` reaches `minShares` (or timeout).
   * Used after placeMarketBuy to wait for shares to be credited before placing
   * a resting limit SELL — otherwise SELL rejects with
   *   "not enough balance / allowance: balance 0, order amount N"
   * (Polymarket has ~1-3s lag between BUY fill and CTF balance settlement.)
   *
   * Returns the ACTUAL balance in shares (floored to 2 decimal places), or 0
   * on timeout. Caller should size the SELL from the returned value rather
   * than computed shares — it always matches CLOB accounting and handles FAK
   * partial fills self-correctingly.
   *
   * Balances are 1e6-scaled integers; we use BigInt so huge positions don't
   * overflow Number.
   */
  async waitForTokenBalance(
    tokenID: string, minShares: number, timeoutMs = 10_000,
  ): Promise<number> {
    const client = this.mustClient();
    const minAtomic = BigInt(Math.floor(minShares * 1e6));
    const start = Date.now();
    let lastBal = '0';
    while (Date.now() - start < timeoutMs) {
      try {
        const ba = await client.getBalanceAllowance({
          asset_type: AssetType.CONDITIONAL,
          token_id: tokenID,
        });
        lastBal = ba.balance;
        if (BigInt(ba.balance) >= minAtomic) {
          // Convert atomic → shares with 2-decimal floor (safe for CLOB tick).
          const sharesFloat = Number(BigInt(ba.balance)) / 1e6;
          const sharesFloored = Math.floor(sharesFloat * 100) / 100;
          log('info', 'waitForTokenBalance ready', {
            tokenID, minShares, actualShares: sharesFloored, balance: ba.balance,
            elapsedMs: Date.now() - start,
          });
          return sharesFloored;
        }
      } catch (err) {
        log('warn', 'waitForTokenBalance poll error', {
          tokenID, error: err instanceof Error ? err.message : String(err),
        });
      }
      await new Promise(r => setTimeout(r, 250));
    }
    log('warn', 'waitForTokenBalance TIMEOUT', {
      tokenID, minShares, lastBal, timeoutMs,
    });
    return 0;
  }

  /**
   * Read the user's USDC collateral balance + allowance from the CLOB.
   * Both values are returned as USDC (with 6-decimal scaling unwrapped).
   * Throws on failure so callers can surface the underlying CLOB error
   * (instead of swallowing it as "unavailable").
   */
  async getCollateralBalance(): Promise<{ balance: number; allowance: number; address: string }> {
    const ba = await this.mustClient().getBalanceAllowance({
      asset_type: AssetType.COLLATERAL,
    });
    // V2 SDK type claims { balance, allowance } but actual response shape may
    // differ — log the raw payload once so we can see what's actually there.
    log('debug', 'getBalanceAllowance raw response', { ba });
    // Tolerant parse: accept either string or number, missing → 0.
    const parseAtomic = (v: unknown): number => {
      if (v == null) return 0;
      try { return Number(BigInt(String(v))) / 1e6; }
      catch { return Number(v) || 0; }
    };
    const raw = ba as unknown as Record<string, unknown>;
    return {
      balance:   parseAtomic(raw['balance']),
      allowance: parseAtomic(raw['allowance']),
      address:   this.address,
    };
  }

  /**
   * One-shot read of the actual on-chain CTF balance for a token. Returns
   * shares floored to 2 decimals (so the value is safe to pass straight back
   * to placeMarketSell — Polymarket rejects high-precision sizes).
   *
   * Source of truth for "how many shares do I own" — use this instead of
   * recomputing from `size_usdc / share_price`, which drifts on float math.
   *
   * Returns 0 on any error (no executor / API down / no allowance set).
   */
  async getTokenBalance(tokenID: string): Promise<number> {
    try {
      const ba = await this.mustClient().getBalanceAllowance({
        asset_type: AssetType.CONDITIONAL,
        token_id:   tokenID,
      });
      const sharesFloat = Number(BigInt(ba.balance)) / 1e6;
      return Math.floor(sharesFloat * 100) / 100;
    } catch (err) {
      log('warn', 'getTokenBalance failed', {
        tokenID, error: err instanceof Error ? err.message : String(err),
      });
      return 0;
    }
  }

  /**
   * REST fallback for top-of-book when the WS hasn't pushed an event yet for a
   * just-subscribed token. Used by StreakSignalEngine before firing if
   * snap.shares[tokenID].bestAsk is null. Returns null on any failure.
   */
  async fetchBestAsk(tokenID: string): Promise<number | null> {
    try {
      const book = await this.mustClient().getOrderBook(tokenID);
      if (!book?.asks?.length) return null;
      // Polymarket orderbook asks are sorted; use min for safety (handles
      // either ascending or descending).
      const ask = Math.min(...book.asks.map(a => Number(a.price)));
      return Number.isFinite(ask) && ask > 0 && ask < 1 ? ask : null;
    } catch (err) {
      log('warn', 'fetchBestAsk REST fallback failed', {
        tokenID, error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Fetch the resolved outcome of a 5-min market by inspecting the UP token's
   * final share price around the window close. The CLOB prices-history endpoint
   * stores all historical share prices for a token (both pre- and post-resolve).
   * At / after resolution, the winning token settles at 1.0 and the losing
   * token at 0.0 — so the UP token's final price alone determines direction.
   *
   * Returns:
   *   'up'      — UP token final price ≥ 0.5
   *   'down'    — UP token final price < 0.5
   *   'unknown' — no price data in the window (market not yet resolved, or
   *               transient API error); caller should retry later.
   *
   * Pulls a small ±1 minute band around windowEndMs to tolerate timing jitter.
   * Uses unauth'd `/prices-history` — doesn't require the L2 client, but we
   * route through the same ClobClient for consistency & retry.
   */
  async fetchResolvedOutcome(
    tokenUp: string, windowEndMs: number,
  ): Promise<'up' | 'down' | 'unknown'> {
    const client = this.mustClient();
    const endSec = Math.floor(windowEndMs / 1000);
    try {
      const prices = await withRetry('CLOB prices-history', () =>
        client.getPricesHistory({
          market:  tokenUp,
          startTs: endSec - 60,        // 1 min before window close
          endTs:   endSec + 300,       // 5 min after (resolve lag tolerance)
          fidelity: 1,                 // 1-minute points
        }),
      );
      if (!prices.length) return 'unknown';
      // Use the LAST price in the range — that's closest to resolution.
      const last = prices[prices.length - 1]!;
      const p = Number(last.p);
      if (!Number.isFinite(p)) return 'unknown';
      return p >= 0.5 ? 'up' : 'down';
    } catch (err) {
      log('warn', 'fetchResolvedOutcome failed', {
        tokenUp: tokenUp.slice(0, 20) + '…', windowEndMs,
        error: err instanceof Error ? err.message : String(err),
      });
      return 'unknown';
    }
  }

  /** Cancel a resting GTC order by its CLOB orderID. Best-effort — logs on fail. */
  async cancelOrder(orderID: string): Promise<void> {
    try {
      await withRetry('CLOB cancel', () => this.mustClient().cancelOrder({ orderID }));
      log('info', 'CLOB order cancelled', { orderID });
    } catch (err) {
      log('warn', 'CLOB cancel failed (exhausted)', { orderID, error: String(err) });
    }
  }
}

// Singleton — one instance per process.
let instance: PolymarketClobExecutor | null = null;

export function getClobExecutor(): PolymarketClobExecutor | null {
  return instance;
}

export async function initClobExecutor(): Promise<PolymarketClobExecutor | null> {
  if (instance) return instance;
  if (!process.env['POLY_PRIVATE_KEY']) {
    log('info', 'POLY_PRIVATE_KEY not set — live CLOB executor disabled');
    return null;
  }
  try {
    const ex = new PolymarketClobExecutor();
    // Cap init at 15s so a slow/unreachable Polymarket API doesn't hang
    // server bootstrap (no HTTP listen until this returns).
    await Promise.race([
      ex.init(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('init timeout (15s)')), 15_000)),
    ]);
    instance = ex;
    return instance;
  } catch (err) {
    log('error', 'PolymarketClobExecutor init failed — live trading disabled', {
      error: String(err),
    });
    return null;
  }
}
