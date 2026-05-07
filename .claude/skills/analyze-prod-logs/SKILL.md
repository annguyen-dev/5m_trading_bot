# /analyze-prod-logs

Pull production logs from the trading-bot prod host and surface:
- **Technical** errors (infra: WS, DB, network, crashes, OOM)
- **Business** errors (trading logic: orders, signals, P&L, cycle state, config)

For each finding, propose root-cause hypothesis + concrete fix direction (file/line when possible).

## Usage

```
/analyze-prod-logs              # default: last 1 hour
/analyze-prod-logs 30m          # last 30 minutes
/analyze-prod-logs 6h           # last 6 hours
/analyze-prod-logs 1d           # last 24 hours
/analyze-prod-logs since=<ISO>  # since explicit UTC time, e.g., 2026-05-05T00:00
```

## Prod environment (HARDCODED — edit if it changes)

| Item | Value |
|---|---|
| Host | `ubuntu@13.235.115.6` |
| SSH key | `~/.ssh/keys/trading-bot-key.pem` |
| Logs (read as `bot` via sudo) | `/opt/trading-bot/logs/api.log`, `/opt/trading-bot/logs/workers.log` |
| Format | pino JSON, one event per line |
| Schema | `{ level, time, service, env, pid, msg, ...context }` |
| Levels | 30=info, 40=warn, 50=error |

## Procedure

### Step 1 — Pull logs (server-side filter, then transfer)

Compute `SINCE` from the duration arg (`date -u -d '<arg> ago'`).

Default approach: filter to **warn/error** + key **info** patterns server-side, slice by timestamp, transfer only the matches:

```bash
SINCE="$(date -u -v-1H +%Y-%m-%dT%H:%M)"   # macOS; use -d on linux
ssh -i ~/.ssh/keys/trading-bot-key.pem ubuntu@13.235.115.6 "
  sudo -u bot bash -c '
    for f in api workers; do
      awk -v s=\"$SINCE\" -v src=\$f \"
        match(\\\$0, /\\\"time\\\":\\\"[^\\\"]+\\\"/) {
          ts = substr(\\\$0, RSTART+8, 16);
          if (ts >= s) print src\\\":\\\"\\\$0;
        }
      \" /opt/trading-bot/logs/\${f}.log;
    done
  '
" > /tmp/prod-logs-$(date +%s).jsonl
```

If volume is too high (>50k lines), narrow further with grep before awk:
- `grep -E '\"level\":(40|50)|order|signal|cycle|echo|WS|DB'`

For **focused investigations** (e.g., specific coin/time/order_id), use targeted greps instead of full tail.

### Step 2 — Categorize & count

Run each pattern, count occurrences, sample 1 example. Group findings by category.

#### Technical errors

| Pattern (regex) | Hint |
|---|---|
| `Polymarket WS (closed\|stale\|error)` (level 40) | EXPECTED ~4/h with proactive rotate. >>4/h or `WS stale` post-rotate = real issue. |
| `Polymarket WS proactive rotate` (level 30) | EXPECTED every ~13 min per service. Confirms rotation healthy. |
| `Binance.*WS.*(close\|error\|reconnect)` | Fast ticker connection issues. |
| `(connection refused\|ECONNREFUSED\|ETIMEDOUT\|ENOTFOUND)` | DNS/network or service down. |
| `database\|pg pool\|client.*not.*released` | DB connection leak / pool exhausted. |
| `(uncaught\|unhandled).*Error` | Unhandled rejection — needs stack trace. Grep ±20 lines. |
| `migrate.*(failed\|error)` (only on startup) | Schema drift — check `packages/db/src/migrations/` for pending. |
| PM2 restart count rising | OOM or crash loop — check `pm2 list` `↺` column delta. |

#### Business errors

| Pattern (regex) | Hint |
|---|---|
| `(placeMarket(Buy\|Sell)\|placeLimitSell) failed` | Order rejection. Read context for reason: stale price / balance / asset_id mismatch. |
| `invalid price\|insufficient.*balance\|INVALID_ORDER` | Polymarket-side rejection. If repeats on same coin/window → cycle stuck. |
| Same `(coin, window_start)` boundary BUY appears 2+ times within 30s | Duplicate-order race condition (we fixed `phaseT-3s` vs `phaseT0` Path E with `boundaryPlacementInFlight`). Regression check. |
| `close_reason` aggregated by type over window | Compare distribution to baseline. Spikes in `sl` with high avg loss = filter regression or regime shift. |
| `polymarket.*disagree\|outcome.*unknown\|livePolyOutcome.*fallback` | Bug 1 fallback firing — WS staleness, missing token_up, or pre-warmup state. |
| `fetchStreakWithVolume: Binance/Poly mismatch in streak — suppress` | Pre-fix only; should NEVER fire post-fix. Was disabling arming on real Poly streaks. |
| `withRetry: CLOB market BUY exhausted after 5 attempts.*no orders found to match with FAK` | Book has thin liquidity at ask. Post-fix the FAK uses `limit_price_cents` as cap, sweeping deeper levels. If still firing post-fix: book is genuinely empty up to limit, or book API returned stale ask. |
| `DCA skip.*streak direction matches\|just-closed outcome matches our bet` | Pre-fix: Binance/Poly disagree at T-0 → wrong streak → DCA wrongly skipped on a real loss. Post-fix: this should NEVER fire (caller is loss branch only); if it does, caller invariant is broken. |
| `syncPendingOutcomes` count over 30min window | Healthy: synced=N, stillUnknown=0-1 each run. If `stillUnknown` keeps growing or `market still unresolved >30min` warns appear: Polymarket API hiccup or wrong token_up cached. |
| `lastEchoTriggerAt\|backfill.*threshold` mismatch with current config | Config staleness — `ensureBackfillFresh` should retrigger. If not: state leak. |
| `cycleActive:true` with no state transition >2h | Cycle stuck — never reset on close. Check OrderResolver eviction. |
| Worker logs `T+4` event with `streak:0` repeatedly when chart shows clear streak | Outcome data source broken (DB row missing or `outcome IS NULL`). Check `poly_clob_markets` outcome column. |
| `chop_filtered` count vs `sl` count | If `chop_filtered` >> `sl`: filter is doing its job. If both spike: market regime change worth noting. |
| `INVALID_ARGUMENT.*price` on TP limit sell | Stale share_tick price → `createExitOrders` computed wrong limit. Check `shareBids` cache freshness. |

### Step 3 — Output format

Deliver this structure (markdown). Keep raw log lines OUT of report; aggregate counts + 1 representative example per category.

```markdown
## Log Analysis: [duration arg]

**Source:** api.log + workers.log
**Window:** [SINCE] → [now]  ([N] minutes)
**Total events:** [count]   |  **Warn:** [count]  |  **Error:** [count]

### 🔴 Critical (deploy hotfix today)
- **[Short title]** — N occurrences
  - **Root cause:** [hypothesis based on pattern + context]
  - **Fix:** [file:line + concrete action] OR [investigate X first]
  - **Example:** `<one log line>`

### 🟡 Important (this week)
- ...

### ⚪ Noise (raise log level / suppress / batch)
- [Pattern] — N/min
  - Recommendation: bump to debug, batch into daily summary, or filter

### 🟢 Healthy signals (confirming things work)
- Polymarket WS proactive rotate: N (expected ~4N for an N-hour window per service)
- Successful orders placed: N | TP'd: N | SL'd: N | Chop-filtered: N
- Cycle transitions: N
```

If user gave a focused query (specific coin / order_id / window), produce a **timeline narrative** instead of categorized counts:

```markdown
## Timeline: [BTC 2026-05-05 01:00-01:05 window]
- 00:55:50 — Market tracked: btc-updown-5m-...
- 01:00:01 — phaseT0 Path A: streak=3 UP, EV=+3.2c → BUY queued
- 01:00:03 — Order filled @ 0.58 ($30 size) | TP limit sell @ 0.85 placed
- 01:01:47 — Bid drop to 0.42 → SL trigger? No: chop filter 3 reversals/1s → SUPPRESSED ✓
- 01:04:58 — Window closed, outcome=down → SL fired, exit @ 0.06
- 01:05:00 — close_reason=sl, pnl=-$28.40
**Verdict:** [your reading]
```

## Notes / gotchas

- Pino timestamps are ISO with `Z`. Lex compare works for sorting.
- macOS `date -v-1H` vs Linux `date -d '1 hour ago'` — script must handle both or hardcode the local one.
- Don't paste full filtered log file into context — too noisy. Save to `/tmp/`, use grep/awk to extract just what's needed for the report.
- After producing the report, OFFER (don't auto-execute) to deep-dive any single finding with a follow-up grep.
- If the user asks "why did X happen?" — trace by `pid` (per-process consistency) and `tokenId/conditionId/orderId` (per-trade) to follow the full life cycle.

## Maintenance

When new bug categories are discovered + fixed, **add a row** to the Business or Technical tables above with the grep pattern that would have caught it. This keeps the skill current. The skill IS the runbook.
