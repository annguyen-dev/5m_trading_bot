-- 025_poly_market_outcome.sql
--
-- Cache Polymarket resolution outcome per 5-min market so the streak logic
-- can use Polymarket's actual binary outcome instead of Binance OHLC (which
-- may disagree with Polymarket's reference price and adds spurious dojis).
--
-- `outcome`:
--   'up'      — UP token resolved at ≥ 0.5 (or market resolved UP)
--   'down'    — UP token resolved at < 0.5
--   'invalid' — market never resolved (rare) or price data unusable
--   NULL      — not yet fetched (pending background sync)
--
-- `outcome_fetched_at` (ms) — last time we tried to resolve; lets us rate-limit
-- retries on markets that are slow to settle.

ALTER TABLE poly_clob_markets
  ADD COLUMN IF NOT EXISTS outcome            TEXT,
  ADD COLUMN IF NOT EXISTS outcome_fetched_at BIGINT;

-- Partial index targeting the sync-worker query: `outcome IS NULL AND window_end < now - 30s`.
-- WHERE clause must be IMMUTABLE so we can't reference now(); the worker adds
-- the window_end predicate at query time. Small WHERE just drops already-resolved
-- rows from the index so it stays lean.
CREATE INDEX IF NOT EXISTS idx_poly_markets_outcome_pending
  ON poly_clob_markets (window_end)
  WHERE outcome IS NULL;
