-- Phase 2.B-4 — TP/SL exit rules for sim orders.
--
-- TP/SL both apply to ALL orders (manual + auto). Values are absolute share
-- prices in cents (1-99). To effectively disable, set TP=99 or SL=1 so the
-- condition rarely fires.
--
-- Close rules checked by OrderResolver on each tick:
--   bestBid(long_side) ≥ TP → exit @ bestBid, close_reason='tp'
--   bestBid(long_side) ≤ SL → exit @ bestBid, close_reason='sl'
--   window_end passed        → exit via resolution, close_reason='resolution'

INSERT INTO settings (key, value, updated_at)
VALUES
  ('auto_order_tp_cents', '75', EXTRACT(EPOCH FROM NOW())::BIGINT * 1000),
  ('auto_order_sl_cents', '25', EXTRACT(EPOCH FROM NOW())::BIGINT * 1000)
ON CONFLICT (key) DO NOTHING;

-- Track the actual exit price + reason on each order.
ALTER TABLE poly_orders ADD COLUMN IF NOT EXISTS exit_price   DOUBLE PRECISION;
ALTER TABLE poly_orders ADD COLUMN IF NOT EXISTS close_reason TEXT;

ALTER TABLE poly_orders DROP CONSTRAINT IF EXISTS poly_orders_close_reason_check;
ALTER TABLE poly_orders ADD CONSTRAINT poly_orders_close_reason_check
  CHECK (close_reason IS NULL OR close_reason IN ('resolution', 'tp', 'sl', 'manual'));
