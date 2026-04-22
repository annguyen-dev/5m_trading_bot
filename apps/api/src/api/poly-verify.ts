/**
 * src/api/poly-verify.ts
 *
 * Admin/debug endpoint: hit Gamma API for the current 5m window of every
 * coin and report whether its slug resolves. Lets us catch wrong slug
 * prefixes (e.g. `ethereum-updown-5m-` vs `eth-updown-5m-`) before
 * PriceMonitoringWorker enables them.
 */
import type { Request, Response } from 'express';
import { ALL_COINS } from '@trading-bot/core/CoinConfig';
import { SLUG_PREFIX } from '@trading-bot/core/PolymarketService';

const GAMMA_BASE  = 'https://gamma-api.polymarket.com';
const WINDOW_SECS = 300;

interface VerifyResult {
  symbol:     string;
  slug:       string;
  found:      boolean;
  status?:    number;
  question?:  string;
  hasTokens?: boolean;
  error?:     string;
}

/** GET /api/poly/verify-slugs */
export async function verifyCoinSlugs(_req: Request, res: Response): Promise<void> {
  const nowSec = Math.floor(Date.now() / 1000);
  const windowStart = Math.floor(nowSec / WINDOW_SECS) * WINDOW_SECS;

  const results: VerifyResult[] = await Promise.all(ALL_COINS.map(async sym => {
    const slug = `${SLUG_PREFIX[sym]}${windowStart}`;
    try {
      const resp = await fetch(`${GAMMA_BASE}/events?slug=${slug}`);
      if (!resp.ok) return { symbol: sym, slug, found: false, status: resp.status };
      const arr = await resp.json() as Array<{
        markets?: Array<{ question?: string; clobTokenIds?: string }>;
      }>;
      if (!arr?.length) return { symbol: sym, slug, found: false };
      const mkt = arr[0]?.markets?.[0];
      return {
        symbol:    sym,
        slug,
        found:     true,
        question:  mkt?.question,
        hasTokens: !!mkt?.clobTokenIds,
      };
    } catch (err) {
      return { symbol: sym, slug, found: false, error: String(err) };
    }
  }));

  res.json({
    windowStart,
    windowStartUtc: new Date(windowStart * 1000).toISOString(),
    results,
  });
}
