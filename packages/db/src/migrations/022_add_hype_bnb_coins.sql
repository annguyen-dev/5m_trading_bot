-- Add HYPE and BNB to coin_configs (disabled, signal_only — matches the
-- default for other non-BTC coins in migration 021).
--
-- Uses jsonb_set on the existing value so we don't clobber operator edits
-- to BTC/ETH/SOL/XRP/DOGE. No-op if the keys already exist.

UPDATE settings
SET value = (
  (value::jsonb)
  || CASE WHEN (value::jsonb) ? 'HYPE' THEN '{}'::jsonb ELSE
       jsonb_build_object('HYPE', jsonb_build_object(
         'enabled', false, 'strategy', 'streak', 'mode', 'signal_only',
         'streak_min', 3, 'size_usdc', 5, 'limit_price_cents', 54,
         'tp_cents', 75, 'sl_cents', 25))
     END
  || CASE WHEN (value::jsonb) ? 'BNB' THEN '{}'::jsonb ELSE
       jsonb_build_object('BNB', jsonb_build_object(
         'enabled', false, 'strategy', 'streak', 'mode', 'signal_only',
         'streak_min', 3, 'size_usdc', 5, 'limit_price_cents', 54,
         'tp_cents', 75, 'sl_cents', 25))
     END
)::text,
updated_at = EXTRACT(EPOCH FROM NOW())::BIGINT * 1000
WHERE key = 'coin_configs';
