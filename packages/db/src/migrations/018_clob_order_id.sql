-- Phase 2C — live CLOB integration.
--
-- When mode='live', the BUY / TP-SELL / SL-SELL rows are mirrored on
-- Polymarket's CLOB. Store the CLOB order ID returned by the exchange so we
-- can:
--   1. Cancel the OCO sibling via clob_client.cancelOrder({ orderID }).
--   2. Reconcile fills returned by the CLOB ws / REST with our DB rows.
--
-- Nullable — simulate rows never populate it.
ALTER TABLE poly_orders ADD COLUMN IF NOT EXISTS clob_order_id TEXT;
CREATE INDEX IF NOT EXISTS poly_orders_clob_order_id
  ON poly_orders(clob_order_id) WHERE clob_order_id IS NOT NULL;
