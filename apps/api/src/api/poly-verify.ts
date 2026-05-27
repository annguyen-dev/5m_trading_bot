/**
 * src/api/poly-verify.ts
 *
 * Admin/debug endpoint: hit Gamma API for the current 5m window of every
 * coin and report whether its slug resolves. Lets us catch wrong slug
 * prefixes (e.g. `ethereum-updown-5m-` vs `eth-updown-5m-`) before
 * PriceMonitoringWorker enables them.
 */
import type { Request, Response } from 'express';
import { ALL_COINS, COIN_META } from '@trading-bot/core/CoinConfig';

const GAMMA_BASE  = 'https://gamma-api.polymarket.com';

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

  const results: VerifyResult[] = await Promise.all(ALL_COINS.map(async sym => {
    const meta = COIN_META[sym];
    const windowSecs = meta.windowMs / 1000;
    const windowStart = Math.floor(nowSec / windowSecs) * windowSecs;
    const slug = meta.slugForWindow(windowStart);
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

  // windowStart now varies per-coin (5m: 300s boundary; 1h: 3600s); report the 5m one for backward-compat.
  const fiveMinStart = Math.floor(nowSec / 300) * 300;
  res.json({
    windowStart:    fiveMinStart,
    windowStartUtc: new Date(fiveMinStart * 1000).toISOString(),
    results,
  });
}
