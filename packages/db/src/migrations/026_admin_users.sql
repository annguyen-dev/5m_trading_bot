-- 026_admin_users.sql
--
-- Dashboard authentication: admin users table. Login requires username +
-- password (bcrypt-hashed). Only users present in this table can access
-- the dashboard. Create entries via the CLI command:
--   pnpm --filter @trading-bot/api create-admin <username> <password>
--
-- `password_hash` is a bcrypt string (salt included). `created_at` / `last_login_at`
-- are epoch ms.

CREATE TABLE IF NOT EXISTS admin_users (
  id             BIGSERIAL PRIMARY KEY,
  username       TEXT   NOT NULL UNIQUE,
  password_hash  TEXT   NOT NULL,
  created_at     BIGINT NOT NULL,
  last_login_at  BIGINT
);
