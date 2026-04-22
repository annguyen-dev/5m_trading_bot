-- Phase 2.B-7 — separate BUY vs SELL order rows.
--
-- When a sim position closes (TP/SL/resolution), the OrderResolver now
-- inserts a matching SELL row linked via parent_order_id. This gives users
-- an explicit transaction trail:
--   BUY  row: entry event (status flips to 'closed' at exit)
--   SELL row: exit event (price, reason, shares)
--
-- For PnL totals (Portfolio page) we sum ONLY rows with side='buy' so PnL is
-- counted once per position (SELL rows have pnl_usdc = null).
--
-- Existing orders are all BUYs (no SELL rows were created before this), so
-- default 'buy' for backfill.

ALTER TABLE poly_orders ADD COLUMN IF NOT EXISTS side TEXT NOT NULL DEFAULT 'buy';
ALTER TABLE poly_orders DROP CONSTRAINT IF EXISTS poly_orders_side_check;
ALTER TABLE poly_orders ADD CONSTRAINT poly_orders_side_check
  CHECK (side IN ('buy', 'sell'));

CREATE INDEX IF NOT EXISTS poly_orders_parent    ON poly_orders(parent_order_id);
CREATE INDEX IF NOT EXISTS poly_orders_side_mode ON poly_orders(side, mode);
