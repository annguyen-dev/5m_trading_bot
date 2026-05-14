# trading-bot

Trading bot for Polymarket 5-minute binary "up/down" markets. Watches Binance for context, watches Polymarket for share prices, and bets via Echo Hunt mean-reversion strategy.

> New to the project? Start with [`CLAUDE.md`](./CLAUDE.md) for architecture + key concepts. This file covers setup + day-to-day operations.

---

## Local dev setup

### Prerequisites
- Node 20+, pnpm 10+
- Docker (for Postgres + Redis)
- A `.env` file at repo root — copy from `.env.example` and fill in
- Optional: real `POLY_PRIVATE_KEY` for live trading. Without it, the order resolver runs in **simulate mode** (no real orders placed).

### Quick start

```bash
pnpm install                          # install workspace deps
docker compose up -d                  # postgres + redis local
pnpm --filter @trading-bot/api migrate  # run DB migrations (auto on boot too)

# Three terminals — turbo runs all at once via `pnpm dev`:
pnpm dev:api       # http://localhost:3000
pnpm dev:workers   # background — places orders, fires Telegram
pnpm dev:web       # http://localhost:5173
```

Sanity check: open `http://localhost:5173/live`, verify BTC price updates (Binance feed) and a current Polymarket market shows.

### Environment variables

Critical keys in `.env`:

| Var | Purpose |
|---|---|
| `NODE_ENV` | `development` (skips real Telegram) or `production` |
| `POLY_PRIVATE_KEY` | Polymarket wallet private key. Empty → simulate mode |
| `POLY_FUNDER_ADDRESS` | Wallet address holding USDC |
| `POLY_SIGNATURE_TYPE` | Usually `2` (proxy wallet) |
| `REDIS_URL` | `redis://localhost:6379` |
| `TELEGRAM_TOKEN` | Bot token from @BotFather (placeholder OK in dev) |
| `LOG_LEVEL` | `info` (prod) / `debug` (dev verbose) |

`.env.example` has all keys with safe defaults. **Never commit `.env`** — it's gitignored.

---

## Common tasks

### Add a new coin
1. Add symbol to `CoinSymbol` union in `packages/core/src/CoinConfig.ts` and to `ALL_COINS`.
2. Add `slugPrefix` mapping in `packages/core/src/PolymarketService.ts`.
3. Add a `BinanceSymbolMap` entry if pair name differs from `<COIN>USDT`.
4. UI auto-picks up — config row created on first DB write via Settings page.
5. Verify by setting `mode=signal_only`, watch logs for clean T+4 events for ~1 hour, then promote to `signal_and_order`.

### Add a DB column / table
1. Create `packages/db/src/migrations/NNN_<name>.sql` (next number, idempotent — `IF NOT EXISTS` / `IF NOT NULL`).
2. Migrations run on every worker + api startup (see `migrate()` call in `apps/workers/src/main.ts`).
3. Restart locally: `pnpm dev:workers` (re-runs migrations).

### Inspect prod state
```bash
SERVER_HOST=13.235.115.6 pnpm remote:psql      # interactive Postgres
SERVER_HOST=13.235.115.6 pnpm remote:redis-cli # Redis
SERVER_HOST=13.235.115.6 pnpm remote:errors    # last 200 worker errors as JSON
SERVER_HOST=13.235.115.6 pnpm remote:logs:workers  # tail -f workers log
```

### Investigate a bug in prod
Use the **`/analyze-prod-logs`** Claude skill — see `.claude/skills/analyze-prod-logs/SKILL.md`. It pulls logs, classifies into Technical / Business buckets, and suggests fix file:line. Add new patterns to its tables when you find a new bug class.

### Deploy

The deploy pipeline is Ansible-based, two playbooks:

| Playbook | When | What it does |
|---|---|---|
| `bootstrap.yml` | **First time only** (new server) | Install Node 22, pnpm, Docker; create `bot` user; spin up Postgres + Redis containers; configure UFW |
| `deploy.yml` | **Every release** | rsync repo, `pnpm install + build`, render PM2 manifest, reload api + workers, run health checks |

#### First-time setup (bootstrap)

Required ONCE per new host. Skip if the host already has the bot stack running.

```bash
# 1. Configure inventory + secrets
cd deploy
cp inventory.example.yml      inventory.yml
cp group_vars/all.example.yml group_vars/all.yml

# Edit inventory.yml:
#   - ansible_host: server IP/DNS
#   - ansible_user: SSH user (root or sudoer)
#   - ansible_ssh_private_key_file: path to your SSH key

# Edit group_vars/all.yml — fill in:
#   - pg_password, jwt_secret      (run: openssl rand -hex 32)
#   - poly_private_key, poly_funder_address
#   - telegram_token, telegram_channel_id
#   - anthropic_api_key, voyage_api_key, grafana_* (optional)

# 2. Bootstrap the host (installs runtime + DB containers)
ansible-playbook -i inventory.yml bootstrap.yml
# or from repo root: pnpm release:bootstrap

# 3. First deploy
ansible-playbook -i inventory.yml deploy.yml
# or: pnpm release
```

After bootstrap completes, `/opt/trading-bot/` exists on the server with Postgres + Redis running. Subsequent releases only need step 3.

⚠ **`group_vars/all.yml` contains plaintext secrets.** Either:
- keep it local only (it's gitignored), OR
- encrypt with `ansible-vault encrypt group_vars/all.yml` and pass `--ask-vault-pass` on every play
  (then use `pnpm release:vault` to edit it inline)

#### Regular release

```bash
git push origin master
pnpm release
# equivalent to:  cd deploy && ansible-playbook -i inventory.yml deploy.yml
```

Health checks run automatically (direct API + via nginx). Both api + workers PM2-restart cleanly via `startOrReload`.

⚠ **Migrations run on startup automatically** — a failing migration crashes the worker. Test locally first via `pnpm --filter @trading-bot/api migrate`.

#### Other ops

```bash
pnpm release:env         # push only env vars (faster than full release)
pnpm release:vault       # edit encrypted group_vars/all.yml inline
pnpm release:fix-perms   # repair file ownership if something got chown'd wrong
```

### Roll back
```bash
git revert <commit>
git push origin master
pnpm release
```
We don't blue-green; PM2 restart is instant enough.

---

## Observability

- **Logs**: pino JSON to `/opt/trading-bot/logs/{api,workers}.log`. Read via `pnpm remote:logs:*` or `/analyze-prod-logs`.
- **Telegram**: T+4 (preview), T-3s (order placed), T-0 (resolved). echo_state events are FE-only.
- **DB**: `poly_orders` is the single source of truth for order state + PnL.
- **PM2**: `pnpm remote:pm2` — spike in `↺` column = crash loop.
- **Health endpoint**: `https://13.235.115.6/api/health` — used by Ansible to verify deploys.

---

## More docs

- [`CLAUDE.md`](./CLAUDE.md) — architecture overview, key concepts, known gotchas
- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — coding conventions (logging, errors, TS, commits)
- [`PLAN_POLYMARKET_SIGNAL.md`](./PLAN_POLYMARKET_SIGNAL.md) — original strategy design doc
- `.claude/skills/analyze-prod-logs/SKILL.md` — log analysis runbook
