-- Phase 1 of multi-coin refactor: per-coin strategy config stored as one
-- JSON blob in settings (`coin_configs`). Keys are upper-case symbols.
--
-- Shape:
--   {
--     "BTC": {
--       "enabled":          true,
--       "strategy":         "streak",              // only value for now
--       "mode":             "signal_only" | "signal_and_order",
--       "streak_min":       3,
--       "size_usdc":        5,
--       "limit_price_cents":54,
--       "tp_cents":         75,
--       "sl_cents":         25
--     },
--     "ETH": { ... },
--     ...
--   }
--
-- Seed with BTC enabled (mirrors current setup); ETH/SOL/XRP/DOGE disabled
-- placeholders — operator enables via PUT /api/coin-configs.

INSERT INTO settings (key, value, updated_at) VALUES
  ('coin_configs',
   '{
      "BTC": {"enabled":true,"strategy":"streak","mode":"signal_and_order","streak_min":3,"size_usdc":5,"limit_price_cents":54,"tp_cents":75,"sl_cents":25},
      "ETH": {"enabled":false,"strategy":"streak","mode":"signal_only","streak_min":3,"size_usdc":5,"limit_price_cents":54,"tp_cents":75,"sl_cents":25},
      "SOL": {"enabled":false,"strategy":"streak","mode":"signal_only","streak_min":3,"size_usdc":5,"limit_price_cents":54,"tp_cents":75,"sl_cents":25},
      "XRP": {"enabled":false,"strategy":"streak","mode":"signal_only","streak_min":3,"size_usdc":5,"limit_price_cents":54,"tp_cents":75,"sl_cents":25},
      "DOGE":{"enabled":false,"strategy":"streak","mode":"signal_only","streak_min":3,"size_usdc":5,"limit_price_cents":54,"tp_cents":75,"sl_cents":25}
    }',
   EXTRACT(EPOCH FROM NOW())::BIGINT * 1000)
ON CONFLICT (key) DO NOTHING;
