-- Phase 2.B-9 — pending TP/SL SELL children, OCO cancel semantics.
--
-- TP/SL orders are now created upfront (pending) when the BUY is placed,
-- not lazily when the exit triggers. When one fills, the other is cancelled
-- (classic OCO pattern).
--
-- close_reason semantics by row:
--   BUY:       'tp' | 'sl' | 'resolution' (how the BUY position closed)
--   TP SELL:   'tp' (pending = will be TP) | 'cancelled' (SL hit first) | stays 'tp' when filled
--   SL SELL:   'sl' (pending = will be SL) | 'cancelled' (TP hit first) | stays 'sl' when filled

ALTER TABLE poly_orders DROP CONSTRAINT IF EXISTS poly_orders_close_reason_check;
ALTER TABLE poly_orders ADD CONSTRAINT poly_orders_close_reason_check
  CHECK (close_reason IS NULL
      OR close_reason IN ('resolution', 'tp', 'sl', 'manual', 'cancelled'));
