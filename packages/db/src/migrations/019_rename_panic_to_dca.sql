-- Phase 2C cleanup — rename legacy 'panic' → 'dca' everywhere.
--
-- Path B was originally conceived as a "panic buy" (cheap entry after a big
-- drop on the losing side). It was later redefined as DCA-add: average down
-- on an existing auto Path A position. "panic" is misleading → rename.
--
-- Scope:
--   1. poly_orders.signal_path   'panic' → 'dca'         (+ relax CHECK)
--   2. settings.panic_max_entry_cents → dca_max_entry_cents
--   3. settings.panic_tp_cents   → drop (legacy, Path B now inherits global TP)

-- 1. poly_orders.signal_path ---------------------------------------------
ALTER TABLE poly_orders DROP CONSTRAINT IF EXISTS poly_orders_signal_path_check;

UPDATE poly_orders SET signal_path = 'dca' WHERE signal_path = 'panic';

ALTER TABLE poly_orders ADD CONSTRAINT poly_orders_signal_path_check
  CHECK (signal_path IS NULL OR signal_path IN ('boundary', 'dca'));

-- 2. settings key rename -------------------------------------------------
UPDATE settings SET key = 'dca_max_entry_cents'
  WHERE key = 'panic_max_entry_cents';

-- 3. drop legacy key -----------------------------------------------------
DELETE FROM settings WHERE key = 'panic_tp_cents';
