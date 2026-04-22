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
  SignatureType,
  AssetType,
  type ApiKeyCreds,
} from '@polymarket/clob-client';
import { log } from './observability/logger.js';

const CLOB_HOST = 'https://clob.polymarket.com';

function resolveSignatureType(raw: string | undefined, funderSet: boolean): SignatureType {
  const key = (raw ?? '').trim().toLowerCase();
  if (key === 'eoa')   return SignatureType.EOA;
  if (key === 'proxy') return SignatureType.POLY_PROXY;
  if (key === 'safe')  return SignatureType.POLY_GNOSIS_SAFE;
  // Default: MetaMask-connected Polymarket wallets are Gnosis Safes, so
  // if a funder is set we assume Safe. Bare EOA setups fall back to EOA.
  return funderSet ? SignatureType.POLY_GNOSIS_SAFE : SignatureType.EOA;
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

    // Stage 1: L1-only client (for deriveApiKey).
    const l1 = new ClobClient(CLOB_HOST, Chain.POLYGON, wallet, undefined, sigType, funder);
    const creds: ApiKeyCreds = await l1.createOrDeriveApiKey();

    // Stage 2: re-init with creds for L2 auth (order placement).
    this.client = new ClobClient(CLOB_HOST, Chain.POLYGON, wallet, creds, sigType, funder);

    log('info', 'PolymarketClobExecutor initialized', {
      address: this.address,
      funder,
      sigType: SignatureType[sigType],
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
   * Market BUY — spend `usdcAmount` USDC on `tokenID`. FOK so any unfilled
   * portion is killed (we want all-or-nothing at market). `maxPrice` is the
   * ceiling price in dollars (0..1); if the book can't fill at or below this,
   * the FOK fails and no shares are purchased.
   *
   * Returns the CLOB orderID on success.
   */
  async placeMarketBuy(
    tokenID: string, usdcAmount: number, maxPrice: number,
  ): Promise<string> {
    const client = this.mustClient();
    log('info', 'CLOB market BUY attempt', {
      tokenID, usdcAmount, maxPrice,
      sigType: SignatureType[client.orderBuilder.signatureType],
      signer:  this.address,
    });
    let resp: OrderResponse;
    try {
      resp = await client.createAndPostMarketOrder(
        { tokenID, amount: usdcAmount, side: Side.BUY, price: maxPrice },
        undefined,
        OrderType.FOK,
      );
    } catch (err) {
      log('warn', 'CLOB market BUY threw', {
        tokenID, usdcAmount, maxPrice,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      throw err;
    }
    // Log the FULL raw response every time (success or failure) so we can
    // see exactly what Polymarket sent back.
    log('info', 'CLOB market BUY response', {
      tokenID, usdcAmount, maxPrice, resp,
    });
    if (!resp.success || !resp.orderID) {
      throw new Error(`CLOB market BUY failed: ${respErrorMessage(resp)}`);
    }
    return resp.orderID;
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
      sigType: SignatureType[client.orderBuilder.signatureType],
      signer:  this.address,
    });
    let resp: OrderResponse;
    try {
      resp = await client.createAndPostMarketOrder(
        { tokenID, amount: shares, side: Side.SELL, orderType: OrderType.FAK },
        undefined,
        OrderType.FAK,
      );
    } catch (err) {
      log('warn', 'CLOB market SELL threw', {
        tokenID, shares,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      throw err;
    }
    log('info', 'CLOB market SELL response (FAK)', {
      tokenID, requested_shares: shares,
      makingAmount: resp.makingAmount,    // shares actually sold
      takingAmount: resp.takingAmount,    // USDC actually received
      status: resp.status,
      success: resp.success,
    });
    if (!resp.success || !resp.orderID) {
      throw new Error(`CLOB market SELL failed: ${respErrorMessage(resp)}`);
    }
    return resp.orderID;
  }

  /**
   * Limit SELL — resting GTC order at `price` for `shares` shares.
   * Used for TP and SL children. Returns the CLOB orderID.
   */
  async placeLimitSell(
    tokenID: string, price: number, shares: number,
  ): Promise<string> {
    const client = this.mustClient();
    let resp: OrderResponse;
    try {
      resp = await client.createAndPostOrder(
        { tokenID, price, size: shares, side: Side.SELL },
        undefined,
        OrderType.GTC,
      );
    } catch (err) {
      log('warn', 'CLOB limit SELL threw', {
        tokenID, price, shares,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      throw err;
    }
    log('info', 'CLOB limit SELL response', {
      tokenID, price, shares, resp,
    });
    if (!resp.success || !resp.orderID) {
      throw new Error(`CLOB limit SELL failed: ${respErrorMessage(resp)}`);
    }
    return resp.orderID;
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

  /** Cancel a resting GTC order by its CLOB orderID. Best-effort — logs on fail. */
  async cancelOrder(orderID: string): Promise<void> {
    try {
      await this.mustClient().cancelOrder({ orderID });
      log('info', 'CLOB order cancelled', { orderID });
    } catch (err) {
      log('warn', 'CLOB cancel failed', { orderID, error: String(err) });
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
