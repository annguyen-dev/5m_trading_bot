-- Phase 2.B — distinguish who/what placed each order + normalise mode values.
--
-- Two orthogonal axes:
--   mode   = which money pool: 'simulate' (fake) | 'live' (real)
--   source = who triggered    : 'manual' (UI click) | 'auto' (engine) | 'backtest' (replay)
--
-- Combinations the UI exposes as filter tabs:
--   Simulate = mode='simulate' AND source != 'backtest'
--   Backtest = source='backtest'                           (live data doesn't apply)
--   Live     = mode='live'

-- 1. New column (default 'manual' so existing rows keep their semantics).
ALTER TABLE poly_orders ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual';

-- 2. Normalise legacy mode values: 'sim'|'paper' → 'simulate'.
UPDATE poly_orders SET mode = 'simulate' WHERE mode IN ('sim', 'paper');

-- 3. Enforce the enums at the DB level (drop first to stay idempotent).
ALTER TABLE poly_orders DROP CONSTRAINT IF EXISTS poly_orders_mode_check;
ALTER TABLE poly_orders DROP CONSTRAINT IF EXISTS poly_orders_source_check;
ALTER TABLE poly_orders ADD CONSTRAINT poly_orders_mode_check
  CHECK (mode   IN ('simulate', 'live'));
ALTER TABLE poly_orders ADD CONSTRAINT poly_orders_source_check
  CHECK (source IN ('manual', 'auto', 'backtest'));

-- 4. Filter-friendly indices.
CREATE INDEX IF NOT EXISTS poly_orders_mode_source
  ON poly_orders(mode, source);
