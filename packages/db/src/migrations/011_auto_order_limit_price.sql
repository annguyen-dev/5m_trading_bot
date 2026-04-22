-- Phase 2.B-3 — entry price discipline for auto orders.
--
-- auto_order_limit_price_cents: integer 1-99 (cents). When StreakSignalEngine
--   decides to auto-place an order, it compares current best_ask to this
--   limit:
--     best_ask ≤ limit → place at best_ask (effectively a fillable limit
--                         bid, same or better than the limit)
--     best_ask > limit → SKIP (signal already emitted, but market price too
--                         high — don't buy at bad EV)
--
-- Default 55 = 55¢. Typical for a contrarian bet: if ask is below 55¢, the
-- market still has favourable reversal odds; if ask is above 55¢, the market
-- has already priced in the reversal.

INSERT INTO settings (key, value, updated_at)
VALUES ('auto_order_limit_price_cents', '55', EXTRACT(EPOCH FROM NOW())::BIGINT * 1000)
ON CONFLICT (key) DO NOTHING;
