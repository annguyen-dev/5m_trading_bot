# CLAUDE.md

Project context for Claude Code agents working in this repo. Read this top-to-bottom before touching code.

> Setup, common tasks, and observability live in [`README.md`](./README.md).
> Coding conventions (logging, errors, commits) live in [`CONTRIBUTING.md`](./CONTRIBUTING.md).
> Strategy design rationale lives in [`PLAN_POLYMARKET_SIGNAL.md`](./PLAN_POLYMARKET_SIGNAL.md).

---

## TL;DR

**Trading bot for Polymarket 5-minute binary "up/down" markets.** Every 5 minutes Polymarket lists *"Will BTC go up or down by HH:MM UTC?"*. The bot watches Binance (BTC stream, volume) for context, watches Polymarket for share prices, and bets via an **"Echo Hunt"** mean-reversion strategy that fades extreme streaks.

- **Live host:** `13.235.115.6` (AWS EC2, single VM)
- **Coins:** BTC (primary), ETH, SOL, XRP, DOGE, HYPE, BNB
- **Process model:** 2 Node services (api + workers) under PM2 + Postgres + Redis in Docker
- **Frontend:** React (Vite) at `apps/web` — live dashboard via SSE
- **Settle currency:** USDC, via Polymarket CLOB v2 API

---

## Architecture at a glance

```
┌────────────── apps/workers ──────────────┐    ┌────────── apps/api ──────────┐
│  PriceMonitoringWorker  (decides)        │    │  Express HTTP + SSE          │
│  OrderResolver          (TP/SL on ticks) │    │  LiveTradingEngine           │
│  TelegramService        (notifies)       │    │   ├─ PolymarketService       │
│   ├─ PolymarketService  (WS, REST)       │    │   ├─ FutureTickScanner       │
│   ├─ PolymarketClobExecutor (places)     │    │   └─ BinanceFastTicker       │
│   └─ Binance polling/WS                  │    │  → SSE → web/                │
└──────────────┬───────────────────────────┘    └──────────────┬───────────────┘
               │                                                │
               ├──── Redis SignalBus (pub/sub) ─────────────────┤
               └──── Postgres (state, orders, configs) ─────────┘
```

**Two processes, isolated for safety:**
- **`apps/workers`** owns trading WS subscriptions, places orders, fires Telegram. Single instance enforced via PID lockfile.
- **`apps/api`** owns FE-facing WS subscriptions, serves HTTP, holds in-memory snapshot. Has its OWN Polymarket WS — workers and api never share a WS.

**Why split:** if FE drops the WS or holds a stale snapshot, trading is unaffected. Conversely, a worker restart doesn't blank the dashboard. Loose coupling via SignalBus + Postgres.

---

## Where to look first

| Want to change | Look at |
|---|---|
| Trading decision logic (when to fire signal / place order) | `apps/workers/src/PriceMonitoringWorker.ts` |
| TP/SL trigger logic | `apps/workers/src/OrderResolver.ts` |
| Order placement details | `packages/core/src/orderPlacement.ts` + `PolymarketClobExecutor.ts` |
| Polymarket WS / REST integration | `packages/core/src/PolymarketService.ts` |
| Cross-process events (SignalBus payload shapes) | `packages/core/src/SignalBus.ts` |
| Per-coin config | `packages/core/src/CoinConfig.ts` (DB-backed) |
| FE-facing snapshot / SSE stream | `apps/api/src/services/LiveTradingEngine.ts` + `apps/api/src/api/server.ts` |
| FE Live page | `apps/web/src/pages/LivePage.tsx` |
| Telegram message formatting | `packages/core/src/TelegramService.ts` |
| Database schema | `packages/db/src/migrations/*.sql` (numbered, append-only) |

---

## Key concepts

These show up everywhere — internalize them before reading code.

### 5-minute window + phase timing
Polymarket lists a fresh binary market every 5 min per coin. Two tokens (`tokenUp`, `tokenDown`) — prices sum ≈ 1.0.

The bot ticks through phases relative to window start (T+0):

| Phase | When | What happens |
|---|---|---|
| **T+0** | Window start | Stop trading on previous; new market becomes "current" |
| **T+4** | T+0 + ~4s | **Preview** — emit signal event for FE/Telegram. Threshold gate NOT applied here. Retries every 5s if in-progress icon doesn't match expected direction. |
| **T-3s** | T+5min - 3s | **Decision** — apply threshold + adaptive gates, place buy if all pass. Idempotent. |
| **T-0** | Window close | Resolve outcome, settle position (TP fills or SL fires), record `close_reason`. |

### Streak
Past N consecutive windows with same direction. `+8 UP` means last 8 windows closed up. We look for **extreme streaks** (≥ adaptive threshold, default 8) because they're statistically due for reversal. **Source of truth is Polymarket midpoint at T-0** (Bug 1 fix `c3432e2`); Binance close-vs-open is fallback only for backfill.

### Echo Hunt
When a streak reaches threshold, bet **against** it (`down` if streak UP, `up` if streak DOWN), expecting mean reversion. Limit-buy at a contrarian price (e.g. 18¢ when market thinks 5%) for asymmetric R:R.

Variants:
- **Baseline** — fires whenever streak ≥ static threshold.
- **Armed** — after a recent extreme streak triggered, threshold drops temporarily for 30-90 min.
- **Defensive** — if no extreme streak in last 3+ hours, threshold raises and we stop trading (regime change protection).

### Cycle state (per coin)
```
cycleActive: false ──── extreme streak hit ──→ cycleActive: true
                                                  ├─ boundary BUY at T-3s
                                                  ├─ TP rests at limit price (Path A — placed alongside BUY)
                                                  ├─ SL fires on bid drop (chop filter + sustained 2s dip)
                                                  ├─ optional DCA on loss
                                                  └─ resolved at T-0 → cycleActive: false
```

`CoinState` lives in `PriceMonitoringWorker`. Echo-state heartbeat republishes every 60s (commit `92a0eba`) so API restarts don't blank the FE panel.

### Polymarket WS quirks
- **Server-side silent timeout at ~15 min** — connection stays "open" but no data flows. We **proactively rotate** at 13 min (commit `5cdf624`). Watchdog at 60s idle is a safety net.
- **WS subscribe does NOT replay book events for inactive tokens** — every reconnect we force-REST-seed all subscribed token books.

---

## Known gotchas

These have all bitten us. Don't repeat history.

| Gotcha | Fix |
|---|---|
| Polymarket WS goes silent at ~15 min without `close` event | `5cdf624` — proactive rotate at 13 min |
| Adding a new SignalBus event type without updating TelegramService switch → empty message → 400 | `b70aee4` — early-return for non-trade event types |
| `phaseTMinus3` + `phaseT0 Path E` both placing boundary BUY for same window | `92a0eba` — `boundaryPlacementInFlight` flag set BEFORE any await |
| Market-sell TP recording bid-at-trigger instead of FAK fill price | `6211cad` — switched to resting limit sell, captured FAK response |
| SL fires on a noisy bid dip during chop | `9174d2c` — chop filter (≥2 reversals/1s) + sustained 2s dip |
| Streak direction from Binance kline disagrees with Polymarket resolution | `c3432e2` — use Polymarket midpoint at T-0 as truth |
| `fetchStreakWithVolume` suppressed streak to 0 on ANY Binance/Poly mismatch — disabled arming for real Poly streaks (verified prod 2026-05-07 02:00-02:30: 5-bar DOWN streak per Poly, 1 mismatch at 01:55, bot saw streak=0 → never armed despite extreme streak running) | `1769269` — use Poly outcomes as ground truth per-bar (Binance fallback only when Poly NULL) instead of suppressing on any mismatch |
| `placeMarketBuy` capped FAK at `sharePrice` (top-of-book ask) — when book had thin/zero size at that exact level, all 5 retries killed at the same price (verified prod 2026-05-07 09:19-09:20 BTC: ask=0.29 had no liquidity, FAK exhausted, T-3s skipped order). User's `limit_price_cents` was being ignored as an effective cap. | `4323ad8` + `fb8eab1` — pass `cfg.limit_price_cents/100` as FAK `maxPrice`; `sharePrice` keeps role of recorded entry expectation |
| Worker restart loses runtime-detected `lastEchoTriggerAt` because backfill (Binance close-vs-open) runs and overwrites in-memory state. Real-time T+4 detection uses fetchStreakWithVolume (Polymarket truth, post-`1769269`) which can disagree with backfill on individual bars — leading to recent triggers being downgraded to older Binance-only values on restart. Verified prod 2026-05-07 09:45 UTC: prior PID detected streak=5 at 06:44 UTC, restart's backfill set lastEchoTriggerAt to 04:05:50, arm window ended 2.5h before user expected. | TBD — restore from `echo_state_cache` table on worker startup, take `max(persisted, backfill)` instead of overwriting |
| DCA skipped on a real loss because `fetchStreakWithVolume` trusts Binance for the just-closed window when `poly_clob_markets` cache hasn't synced yet (live `/prices-history` returns 'unknown' for ~30-60s after T-0) | `c571458` — pass T-0 verified `outcome` to `tryPlaceDcaAtBoundary` instead of recomputing via Binance |
| `poly_clob_markets.outcome` permanently NULL — sweep via `/prices-history` doesn't work for our zero-liquidity BTC 5m tokens (API returns empty history) | `08f5e57` — write outcome inline from livePolyOutcome at T-0 (primary). `9d3dd54` + `fbccf85` + `f5788e8` — background sweep as best-effort safety net (DESC order, 1h retry, 24h max age). |
| Config edit doesn't repopulate `lastEchoTriggerAt` for new threshold | `3969bc7` — `ensureBackfillFresh` re-backfill on threshold change |
| API restart blanks Live page echo panel | `92a0eba` — DB persistence (`echo_state_cache`) + 60s heartbeat |

---

## LLM agent guidelines

When working in this repo:

### Think before coding
- State assumptions before implementing. If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back on overengineered plans.

### Simplicity first
Minimum code that solves the problem. No speculative features, no abstractions for single-use code, no error handling for impossible scenarios. If you wrote 200 lines and 50 would do, rewrite.

### Surgical changes
Touch only what you must. Don't "improve" adjacent code, refactor working code, or fix unrelated lint warnings. Match existing style. Mention dead code; don't delete it unless asked.

### Goal-driven execution
Convert tasks to verifiable goals: "fix bug" → "write a test that reproduces it, make it pass". State a brief plan for multi-step work. Strong success criteria let you loop independently.

### Verify before claiming done
- `pnpm typecheck` passes.
- For a bug fix: cite prod log evidence or a DB query proving the regression is gone.
- After deploy: pull live logs, verify new code is running (grep deployed `dist/` for new symbols).

### When you fix a bug class — update docs
- Add a row to **Known gotchas** above with commit hash.
- Add a grep pattern to `.claude/skills/analyze-prod-logs/SKILL.md`.

Institutional memory belongs in the repo, not in heads.
