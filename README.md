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
```bash
git push origin master
cd deploy && ansible-playbook -i inventory.yml deploy.yml
```
Health checks run automatically. Both api + workers PM2-restart cleanly.

⚠ Migrations run on startup automatically — failing migrations crash the process. Test locally first.

### Roll back
```bash
git revert <commit>
git push origin master
cd deploy && ansible-playbook -i inventory.yml deploy.yml
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
