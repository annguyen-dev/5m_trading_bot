-- Phase 2-tier threshold: add `auto_order_min_streak` to each coin config.
--
--   streak_min              → emit T+4 signal (notification only)
--   auto_order_min_streak   → place order at T-30s (if mode=signal_and_order)
--
-- Default for new field = streak_min + 2 (reasonable gap — notify early,
-- trade only on strong streaks). No-op if the field already exists.
-- Idempotent: iterates each coin, only patches missing keys.

UPDATE settings
SET value = (
  SELECT jsonb_object_agg(
    k,
    CASE
      WHEN v ? 'auto_order_min_streak' THEN v
      ELSE v || jsonb_build_object(
        'auto_order_min_streak',
        COALESCE((v->>'streak_min')::int, 3) + 2
      )
    END
  )::text
  FROM jsonb_each(value::jsonb) AS e(k, v)
),
updated_at = EXTRACT(EPOCH FROM NOW())::BIGINT * 1000
WHERE key = 'coin_configs';
