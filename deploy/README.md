# Deploy — Ansible

Single-host deploy: Ubuntu 22.04/24.04 LTS.

Architecture:
- **App**    → native via **PM2** (`trading-bot-api`, `trading-bot-workers`).
               PM2 itself is registered as a systemd unit so apps autostart on boot.
- **Infra**  → Docker containers (`postgres`, `redis`, `nginx`) via `docker compose`.
               Postgres + Redis bound to `127.0.0.1` only. nginx exposes `:80`
               (redirects to `:443`) and `:443` (TLS via self-signed cert).
- **Ingress** → Public traffic enters via nginx → forwarded to the host's PM2
                api on `host.docker.internal:{api_port}`. The api port itself
                is NOT exposed externally (UFW closed).

Rationale: PM2 gives a friendlier ops layer (`pm2 list`, `pm2 logs`,
`pm2 restart <name>`, zero-downtime `pm2 reload`) while still surviving
reboots via the auto-generated systemd boot script. nginx-in-Docker keeps
the TLS layer trivial to swap (e.g., later replace the self-signed cert
with Let's Encrypt by mounting a different `certs/` dir).

## Prerequisites (local)

- Ansible 2.15+ (`pipx install ansible-core` or `brew install ansible`)
- SSH access to the server as root (or a sudo user)

No collections required — bootstrap uses only built-in modules + shell.

## Prerequisites (server)

- Ubuntu 22.04 or 24.04, fresh VPS
- Open port 22 (SSH) + whatever you want for the API (e.g. 3000 or 443 via nginx)

## First-time setup

```bash
cd deploy
cp inventory.example.yml            inventory.yml
cp group_vars/all.example.yml       group_vars/all.yml

# Fill in both files:
#   inventory.yml        → ansible_host, ansible_user, key
#   group_vars/all.yml   → secrets (jwt_secret, telegram, polymarket, pg_password)

# (Optional) encrypt secrets
ansible-vault encrypt group_vars/all.yml

# Install system deps + Docker + bring up Postgres + Redis containers
ansible-playbook bootstrap.yml         # add --ask-vault-pass if encrypted
```

`bootstrap.yml` is idempotent — safe to re-run.

## Deploy code

Run once after bootstrap, then on every release:

```bash
ansible-playbook deploy.yml            # rsync + build + restart

# Iterations:
ansible-playbook deploy.yml --tags source,build      # skip systemd rewrite
ansible-playbook deploy.yml --tags env               # only re-render .env
ansible-playbook deploy.yml --skip-tags env          # keep current .env
```

The deploy waits for `/api/health` to return 200 before completing.

## Create the first admin (dashboard login)

Once deployed, SSH in and run the CLI shipped with the api:

```bash
ssh ubuntu@<host>
sudo -u bot bash -c 'cd /opt/trading-bot && pnpm --filter @trading-bot/api create-admin <username> <password>'
```

## pnpm script shortcuts (recommended)

The root `package.json` exposes wrappers so you don't have to remember the
full ssh / ansible / pm2 invocations. Set `SERVER_HOST` once per shell
(e.g. `export SERVER_HOST=root@1.2.3.4`) and use:

```bash
# Local dev
pnpm dev                       # api + workers + web (turbo)
pnpm dev:workers               # just workers
pnpm typecheck                 # all packages
pnpm clean                     # nuke node_modules + dist

# Deploy — note: `pnpm deploy` is reserved by pnpm, use `release` family instead
pnpm release:bootstrap         # one-time server provision
pnpm release                   # rsync + build + pm2 reload + health check
pnpm release:env               # only re-render .env (no rebuild)
pnpm release:vault             # ansible-vault edit group_vars/all.yml

# Remote ops (needs SERVER_HOST)
pnpm remote:pm2                # see both apps' status
pnpm remote:monit              # full TUI monitor
pnpm remote:reload             # zero-downtime reload of both apps
pnpm remote:restart:api        # restart just api
pnpm remote:restart:workers    # restart just workers
pnpm remote:logs:api           # tail api JSON logs (auto piped to jq)
pnpm remote:logs:workers       # tail workers JSON logs
pnpm remote:errors             # last 200 lines, only level >= warn
pnpm remote:health             # curl /api/health
pnpm remote:psql               # psql into prod Postgres
pnpm remote:redis-cli          # redis-cli into prod Redis
pnpm remote:create-admin       # run create-admin CLI on the server
pnpm remote:ssh                # bare SSH into the box
```

## App management — PM2 cheatsheet

Run as the `bot` user (or `sudo -u bot ...`):

```bash
pm2 list                       # both apps + status, CPU, mem, restarts
pm2 logs                       # tail both apps' stdout/err live
pm2 logs trading-bot-workers   # tail one app
pm2 restart trading-bot-api    # quick restart
pm2 reload all                 # zero-downtime restart of both
pm2 stop trading-bot-workers   # stop one app (does NOT autorestart)
pm2 start trading-bot-workers  # start it back
pm2 monit                      # full TUI monitor
pm2 describe trading-bot-api   # config + recent restarts + log paths
pm2 save                       # persist current state for reboot
```

After reboot, the systemd unit `pm2-bot.service` (created during bootstrap)
restores the saved process list automatically — no manual intervention.

## Logs

Two log streams per service:

| Path | Contents |
|---|---|
| `/opt/trading-bot/logs/api.log`           | App's structured JSON via pino |
| `/opt/trading-bot/logs/workers.log`       | App's structured JSON via pino |
| `/opt/trading-bot/logs/api-pm2-out.log`   | PM2 stdout (mostly startup banner) |
| `/opt/trading-bot/logs/workers-pm2-out.log` | PM2 stdout |
| `/opt/trading-bot/logs/*-pm2-err.log`     | PM2 stderr (uncaught exceptions, crashes) |

Tail with `jq` for readable structured logs:

```bash
ssh ubuntu@<host> 'tail -f /opt/trading-bot/logs/workers.log | jq .'
ssh ubuntu@<host> 'pm2 logs trading-bot-workers'   # PM2's own tail
```

## Infra commands (on the server)

```bash
# See containers
docker compose -f /opt/trading-bot/infra/docker-compose.yml ps

# Tail logs
docker logs -f trading-bot-postgres
docker logs -f trading-bot-nginx          # access + error logs

# psql into the DB
docker exec -it trading-bot-postgres psql -U trading -d trading

# Test nginx config + reload
docker exec trading-bot-nginx nginx -t
docker exec trading-bot-nginx nginx -s reload    # picks up nginx.conf changes

# Bump Postgres / nginx version → edit docker-compose.yml locally, rerun bootstrap.
# (Named volumes persist across restarts; full wipe = `docker compose down -v`)
```

## TLS / cert

Self-signed cert generated during bootstrap:

```
/opt/trading-bot/infra/certs/selfsigned.crt    # 10-year validity
/opt/trading-bot/infra/certs/selfsigned.key
```

Subject = `CN=<your-host>/O=trading-bot`. Browser will warn on first visit —
accept once. To regenerate (e.g. after changing host):

```bash
ssh $SERVER_HOST 'rm /opt/trading-bot/infra/certs/selfsigned.*'
ansible-playbook bootstrap.yml         # recreates + restarts nginx
```

Want a real cert later? Drop a Let's Encrypt cert pair at the same paths
and `pnpm remote:nginx:reload`. nginx config doesn't need to change.

## Things the playbook does NOT do

- Install a reverse proxy (nginx/caddy). API listens directly on `api_port`.
  Add an nginx or caddy role if you want TLS + port 443.
- Set up automated backups. Add a `pg_dump` cron if you care about history.
- Containerize the app. The app runs native via systemd — only Postgres +
  Redis are in Docker.

## File layout

```
deploy/
├── ansible.cfg                      # pipelining on, no host-key check
├── inventory.example.yml            # copy → inventory.yml
├── group_vars/
│   └── all.example.yml              # copy → group_vars/all.yml (secrets here)
├── bootstrap.yml                    # first-time: apt, node, pm2, docker, certs, infra, user
├── deploy.yml                       # every-release: rsync, build, pm2 startOrReload
├── templates/
│   ├── env.j2                       # /opt/trading-bot/.env
│   ├── docker-compose.infra.yml.j2  # Postgres + Redis + nginx containers
│   ├── nginx.conf.j2                # reverse proxy + TLS + SSE handling
│   └── ecosystem.config.cjs.j2      # PM2 process manifest
└── README.md
```
