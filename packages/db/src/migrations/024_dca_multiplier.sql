-- Add `dca_multiplier` field to each coin's config in settings.coin_configs.
-- Default 1.5 — DCA placed at T-0 after a boundary loss has size =
-- previous_loser_size × dca_multiplier (single-shot per loss cycle).
-- Idempotent — only inserts the key when missing.

UPDATE settings
SET value = (
  SELECT jsonb_object_agg(
    k,
    CASE
      WHEN v ? 'dca_multiplier' THEN v
      ELSE v || jsonb_build_object('dca_multiplier', 1.5)
    END
  )::text
  FROM jsonb_each(value::jsonb) AS e(k, v)
),
updated_at = EXTRACT(EPOCH FROM NOW())::BIGINT * 1000
WHERE key = 'coin_configs';
