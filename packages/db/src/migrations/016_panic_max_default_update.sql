-- Phase 2.B-8 — Path B redefined from "opportunistic cheap buy" to
-- "DCA-add on existing position when price drops". Reasonable default for
-- panic_max_entry_cents shifts accordingly:
--
--   OLD semantics: buy when contrarian share is very cheap (≤10¢)
--   NEW semantics: add to existing position when price drops (≤40¢ is the
--                  "uh oh" zone — still within ~15¢ of typical 50¢ entry)
--
-- Only migrate users still on the OLD default (10). Anyone who set a custom
-- value keeps it.

UPDATE settings
   SET value = '40',
       updated_at = EXTRACT(EPOCH FROM NOW())::BIGINT * 1000
 WHERE key = 'panic_max_entry_cents' AND value = '10';
