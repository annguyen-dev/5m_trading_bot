/**
 * src/api/poly-trades.ts
 *
 * Pulls user's trades for a specific Polymarket market straight from the
 * Polymarket data API. Used by the Live page to cross-check the bot's local
 * order ledger against on-chain reality — e.g. when a SELL fills outside the
 * bot's flow, or when a manual trade was placed via the Polymarket UI.
 *
 *   GET /api/poly/trades?conditionId=0x...
 *
 * Returns: { trades: PolyTradeRow[], fromCache: boolean }
 *
 * Design:
 *   - Funder/proxy address lives in env (POLY_FUNDER_ADDRESS).
 *   - 30s in-memory cache per conditionId — Polymarket data-api isn't
 *     rate-limited harshly but we don't need real-time freshness here.
 *   - On any HTTP / parse error: fall through to a 502 with the raw message
 *     so the FE can display the cause.
 */
import type { Request, Response } from 'express';
import { log } from '../observability/logger.js';

const DATA_API_BASE = 'https://data-api.polymarket.com';
const CACHE_TTL_MS  = 30_000;

export interface PolyTradeRow {
  /** On-chain transaction hash (clickable in FE). */
  transactionHash: string;
  /** Unix seconds — Polymarket returns seconds, we keep that to avoid lossy ms cast. */
  timestamp:       number;
  side:            'BUY' | 'SELL';
  /** Per-share price in dollars (0–1). */
  price:           number;
  /** Number of shares. */
  size:            number;
  /** ERC-1155 token id (asset). Maps to UP or DOWN within the market. */
  asset:           string;
  /** Outcome label as Polymarket reports it: "Up" / "Down" / coin-specific. */
  outcome:         string;
  /** Proxy wallet that executed (= our funder for bot trades). */
  proxyWallet:     string | null;
}

interface CacheEntry {
  ts:     number;
  trades: PolyTradeRow[];
}
const cache = new Map<string, CacheEntry>();

/**
 * Map raw Polymarket trade payload (untyped) → our normalized shape. Tolerant
 * of missing fields because the data-api format has shifted historically;
 * better to return a partial row than to drop trades on a schema mismatch.
 */
function normalize(raw: unknown): PolyTradeRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const tx = String(r['transactionHash'] ?? r['transaction_hash'] ?? '');
  if (!tx) return null;
  const sideRaw = String(r['side'] ?? '').toUpperCase();
  const side: 'BUY' | 'SELL' = sideRaw === 'SELL' ? 'SELL' : 'BUY';
  return {
    transactionHash: tx,
    timestamp:       Number(r['timestamp'] ?? 0),
    side,
    price:           Number(r['price'] ?? 0),
    size:            Number(r['size'] ?? 0),
    asset:           String(r['asset'] ?? r['asset_id'] ?? ''),
    outcome:         String(r['outcome'] ?? ''),
    proxyWallet:     r['proxyWallet']   ? String(r['proxyWallet'])
                   : r['proxy_wallet']  ? String(r['proxy_wallet'])
                   : null,
  };
}

export async function getPolyTrades(req: Request, res: Response): Promise<void> {
  const conditionId = String(req.query['conditionId'] ?? '').trim();
  if (!conditionId) {
    res.status(400).json({ error: 'conditionId required' });
    return;
  }
  const funder = (process.env['POLY_FUNDER_ADDRESS'] ?? '').toLowerCase();
  if (!funder) {
    res.status(500).json({ error: 'POLY_FUNDER_ADDRESS not configured' });
    return;
  }

  // Cache hit (30s TTL) — trades are append-only in practice, so a slightly
  // stale list is fine for human-eyeball comparison.
  const cached = cache.get(conditionId);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    res.json({ trades: cached.trades, fromCache: true });
    return;
  }

  const url = `${DATA_API_BASE}/trades`
    + `?user=${encodeURIComponent(funder)}`
    + `&market=${encodeURIComponent(conditionId)}`
    + `&limit=200`;

  try {
    const r = await fetch(url, { headers: { 'accept': 'application/json' } });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      log('warn', 'Polymarket data-api /trades non-200', {
        status: r.status, body: body.slice(0, 300),
      });
      res.status(502).json({ error: `data-api ${r.status}`, body: body.slice(0, 300) });
      return;
    }
    const raw = await r.json() as unknown;
    const list = Array.isArray(raw) ? raw : Array.isArray((raw as { data?: unknown[] })?.data)
                                            ? (raw as { data: unknown[] }).data : [];
    const trades = list
      .map(normalize)
      .filter((t): t is PolyTradeRow => t !== null)
      .sort((a, b) => b.timestamp - a.timestamp);   // newest first

    cache.set(conditionId, { ts: Date.now(), trades });
    res.json({ trades, fromCache: false });
  } catch (err) {
    log('warn', 'Polymarket data-api fetch failed', { error: String(err) });
    res.status(502).json({ error: String(err) });
  }
}
