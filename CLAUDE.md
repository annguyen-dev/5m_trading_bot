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
| Per-bar Poly override "missing arms" on chart-visible streaks — when Poly resolved tiny-move bars opposite to Binance (e.g., 2026-05-10 13:30 UTC: 6-bar UP per chart, Poly disagreed at 13:10 +0.014%, bot saw streak=3 → no arm). User expectation is arm tracks chart visual. | `b6ff6c2` — revert streak detection to Binance close-vs-open; outcome at T-0 still uses Poly midpoint (Bug 1 preserved); mismatch alerts inform user when chart bet may resolve against Poly truth |
| Same-window arm + fire bypassed `echo_baseline_streak` when `trigger_streak < baseline_streak`. Verified prod 2026-05-13 06:59 UTC: streak=5 at T+4 armed bot → T-3s of same window fired at signal_min=4 despite baseline=8 (user expected baseline to gate). | TBD — set `lastEchoTriggerAt = windowEnd` (not `Date.now()`) so armed mode only takes effect from NEXT window onwards; current window placement still uses baseline gate |
| `placeMarketBuy` capped FAK at `sharePrice` (top-of-book ask) — when book had thin/zero size at that exact level, all 5 retries killed at the same price (verified prod 2026-05-07 09:19-09:20 BTC: ask=0.29 had no liquidity, FAK exhausted, T-3s skipped order). User's `limit_price_cents` was being ignored as an effective cap. | `4323ad8` + `fb8eab1` — pass `cfg.limit_price_cents/100` as FAK `maxPrice`; `sharePrice` keeps role of recorded entry expectation |
| Worker restart loses runtime-detected `lastEchoTriggerAt` because backfill (Binance close-vs-open) runs and overwrites in-memory state. Real-time T+4 detection uses fetchStreakWithVolume (Polymarket truth, post-`1769269`) which can disagree with backfill on individual bars — leading to recent triggers being downgraded to older Binance-only values on restart. Verified prod 2026-05-07 09:45 UTC: prior PID detected streak=5 at 06:44 UTC, restart's backfill set lastEchoTriggerAt to 04:05:50, arm window ended 2.5h before user expected. | `f3bae8b` — restore from `echo_state_cache` table on worker startup, take `max(persisted, backfill)` instead of overwriting |
| Echo strategy compounds losses across cycles when arms cluster in chain regimes (verified 2026-05-07 sáng nay: 6 arm events in 6.5h producing 4 losing cycles, -$39 net). Bot armed continuously, every new ≥5 streak refreshes timer, multiple cycles bleed money during chaotic period. | TBD — chain soft-defensive: detect ≥N arms in lookback window, bump signal/baseline thresholds (don't full skip — preserves Echo edge on STRONG setups). Configurable per-coin via `echo_chain_*` fields. |
| DCA skipped on a real loss because `fetchStreakWithVolume` trusts Binance for the just-closed window when `poly_clob_markets` cache hasn't synced yet (live `/prices-history` returns 'unknown' for ~30-60s after T-0) | `c571458` — pass T-0 verified `outcome` to `tryPlaceDcaAtBoundary` instead of recomputing via Binance |
| `poly_clob_markets.outcome` permanently NULL — sweep via `/prices-history` doesn't work for our zero-liquidity BTC 5m tokens (API returns empty history) | `08f5e57` — write outcome inline from livePolyOutcome at T-0 (primary). `9d3dd54` + `fbccf85` + `f5788e8` — background sweep as best-effort safety net (DESC order, 1h retry, 24h max age). |
| Config edit doesn't repopulate `lastEchoTriggerAt` for new threshold | `3969bc7` — `ensureBackfillFresh` re-backfill on threshold change |
| API restart blanks Live page echo panel | `92a0eba` — DB persistence (`echo_state_cache`) + 60s heartbeat |
| `OrderResolver.resolveAtClose` decided outcome from `future_ticks_5s` (Binance ticker) instead of Polymarket, then hardcoded `exitPrice = won ? 1.0 : 0.0`. For tiny BTC moves Polymarket (Chainlink oracle) and Binance can resolve OPPOSITE. Verified prod 2026-05-14 07:35-07:40: Binance +0.010% UP, Poly UP token mid $0.014 (DOWN won). Bet DOWN recorded as LOSS in DB but wallet's DOWN tokens redeemed ~$0.99 each → DB pnl off by ~$27 per cycle, also tripped DCA on a real win. | `7fb37ea` — read bet token mid from `poly_share_ticks` between T-0 and T-0+30s; `outcome = (betMid > 0.5 ? our_direction : opposite)`; `exit_price = betMid` (not hardcoded); Binance ticker only as fallback when Poly tick missing. Backfill `1e4aa8b` corrected -$132.72 of historical phantom profits. |
| `poly_share_ticks` had no retention; grew to 47GB / 105M rows in ~2 weeks, filled the 58GB root disk on prod 2026-05-15 → PM2 died (no disk for /tmp), bot offline ~hours. The table is high-velocity (every WS top-of-book change × ~10 active tokens). | Out-of-band recovery: CTAS-snapshot last 24h to a temp table, `TRUNCATE poly_share_ticks RESTART IDENTITY` (instant 47GB free), INSERT back, recreate indexes. Long-term: migration `028_poly_share_ticks_retention.sql` adds `prune_poly_share_ticks(hours)` procedure; workers/main.ts calls it hourly (48h retention). |
| `tryPlaceBoundary` body3 live calc summed `|body|` of last 3 bars (incl in-progress) regardless of direction. When current bar OPPOSED the streak (echo accepts this post-`ca82027`), its body got added → inflated body3 → false-positive armed gate. Verified prod 2026-05-18 03:14:57 BTC: streak=3 UP closed + current 10:10 DOWN -$118; live body3 = 115+40+118 = $273 ≥ armed_body3_min $250 → fired DOWN bet that lost. Correct calc = sum of 3 streak-aligned bars (09:55 + 10:00 + 10:05) = 77+115+40 = $232 < $250 → should have skipped. | TBD — only use live fetch when `currentAligns`; otherwise fall back to `t4.body3Sum` (3 closed bars from T+4, all in-streak by construction). Don't blend opposing in-progress body into "streak exhaustion" metric. |
| Streak detection (post-`b6ff6c2`) + cycle closure (Poly outcome) were inconsistent: streak read Binance close-vs-open, cycle closed on Poly mid. When a tiny-move bar resolved opposite per Poly but Binance kept streak going, cycle closed as Poly win → next T-3s fired a FRESH boundary fading the still-going Binance streak → second loss. Verified prod 2026-05-19 ~05:45 UTC BTC: cycle 12:40-12:45 won by Poly (BND DOWN +$2.63), Binance bar continued UP streak; bot opened fresh BND DOWN at 12:45-12:50 → lost (-$2.97); DCA at 12:50-12:55 saved (+$5.64). Net OK on this cluster but the double-fade is systemically wrong: ought to have been DCA continuation, not fresh boundary. | `dc44000` — (a) `fetchStreakWithVolume` re-adopts Poly-per-bar (with Binance fallback when Poly NULL) à la `1769269`. (b) `phaseT0` cycle closure decision tree: if Binance candle dir ≠ Poly outcome (mismatch = "insignificant change") → skip DCA + reset cycle; else if candle continues streak → fire DCA (covers TP-win-with-trend-intact and Poly-phantom-win); else → reset. Both echo and streak strategies. Missing-arms concern from `b6ff6c2` mitigated by mismatch→skip-DCA (we don't ACT on mismatches, but we still SEE them). |
| `tryPlaceBoundary` Gate 1 accepted "current bar opposes streak" as an "ideal fade setup" (legacy comment). Reality: when current bar at T-3s opposes the streak we'd be fading, the streak is actively BREAKING inside this very bar — stored t4.streak (4min stale) is about to invalidate at T-0. Placing a fresh BND for N+1 using that stale direction = fading a regime that no longer exists. Verified prod 2026-05-19 17:39:57 UTC BTC: T+4 of window 17:35 at 17:39:01 stored streak=-3 (DOWN); at T-3s of 17:35 (17:39:57), current bar going UP (Poly mid >0.5, about to close UP and reset streak to +1); bot placed UP fade for window 17:40 with cycleMode=armed despite streak breaking; window 17:40 closed DOWN, BND lost -$3; DCA at 17:45 also lost -$6. Plus identical bug repro 2026-05-19 ~05:45 already documented above — same root cause as the post-`dc44000` "still happens" report. | TBD-2026-05-20 — tryPlaceBoundary rejects when `!currentAligns` AND not doji. Wait for next window's clean T+4 signal instead of fading a stale streak direction. Drops the legacy "opposite = ideal" interpretation. |
| Echo edge cases configured for streak ≥ baseline were **silent dead code**. `tryPlaceBoundary` Gate 2 only ran `matchEchoEdgeCase` inside `if (effectiveStreak < threshold) { … adapt.mode === 'default' … }` (legacy semantics: "below-threshold idle override only"). So `streak7/body3≥100` at baseline=6 never fired — `effectiveStreak=7 < 6` was false, edge loop skipped, bot fell through to `idle_body3_min=500` gate. FE/UI lets users create edges for any streak with no warning. Verified prod 2026-05-26 07:14 UTC BTC: window 07:10-07:15, closed streak=-6, current DOWN bar aligning → effectiveStreak=7, body3≈$228 (≥ edge body3Min 100/120), edge `streak7` SHOULD fire by user intuition but didn't → no order. Same dead-code pattern would have hit `streak6+` edges too. | 2026-05-26 — refactored to **universal-edge semantics** (`PriceMonitoringWorker.ts` ~line 1419): `matchEchoEdgeCase` runs unconditionally; when matched, edge.body3Min replaces idle/armed_body3_min (Gate 2b already skipped on match). Edge cases are now first-class rules (streak range + body3Min → fire). Backtest 365d: with rule retune (streak5/400 new + streak7 100→300), +$139/yr vs prior config B (+$449 vs +$310, WR same 56%). Side-effect: under universal, body3Min must be set to data's profitable zone; previously-too-loose floors (streak7/100) cause drag. |
| `clob-client-v2` 1.0.2 can't place orders on POLY_1271 (new Polymarket deposit-wallet) accounts. createOrder/createMarketOrder hard-coded `order.signer = eoaSignerAddress` (the EOA) and threw `"signer does not match"` if you tried anything else. But for POLY_1271 the API key is owned by the **proxy/smart-wallet** (the funder), so Polymarket rejects with `the order signer address has to be the address of the API KEY`. Balance reads fine (no signer field); only order POST fails. Verified prod 2026-06-10 09:39:58 BTC: edge fired, FAK 400'd, zero orders placed on the new 0xf9858 account since the switch. | `285e117` — upgrade clob-client-v2 1.0.2→1.0.6. 1.0.6 sets `signerForOrder = sigType===POLY_1271 ? maker : eoaSignerAddress` and skips the signer-match check for 1271, so `order.signer = funder`. `^1.0.2` already allowed 1.0.6; only the lockfile pinned the old build. Also renamed `BalanceAllowanceResponse.allowance`→`allowances` (Record). Verified: FAK smoke test at 10¢ returns `"no orders found to match"` (signature accepted, reached matching engine) instead of the signer-400. |
| New per-coin config fields added everywhere (CoinConfig type, worker gate logic, FE) EXCEPT the API `patchSchema` (`apps/api/src/api/coin-configs.ts`) silently break on the next config save. The `echo_edge_cases` inner `z.object` isn't `.strict()`, so zod **strips** any field not in the schema (e.g. `body3OverAvgMin`) — the entire ratio strategy reverts to the dollar gate (`body3Min=0` → fires on ANY body3 = raw streak, which loses) on the next UI PUT. Top-level fields are worse: the outer schema IS `.strict()`, so a missing field (e.g. `echo_killswitch_*`, `echo_chain_*`) makes the whole PUT 400. Verified prod 2026-06-10: live BTC + BTC_1H edges had `body3OverAvgMin` stripped (gate ran as `dollar $X ≥ $0`); the running worker only kept it until its next restart reloaded the stripped DB row. | `f02479c` — add `body3OverAvgMin` to the edge schema; follow-up adds the `echo_killswitch_*`/`echo_chain_*` top-level fields. **Rule: any new CoinConfig field MUST be added to patchSchema in the same change** — grep `coin-configs.ts` for the field name when touching `CoinConfig.ts`. Re-apply stripped values to the live DB after fixing (direct UPDATE; the bot reads the DB, not the API). |
| Streak detection used **Poly-per-bar** (`poly_clob_markets.outcome`) which is the **T-0 midpoint read** — lands on the wrong side of 0.5 for tiny-move bars, disagreeing with both the Binance chart AND Polymarket's own final (Chainlink) resolution. Verified prod 2026-06-11 10:20 UTC BTC: Binance +$7.5 UP, Polymarket UI shows green (up), but stored outcome='down' → bot's UP streak counted from 10:25 not 10:20 → closed=5 (+1 current=6) → fired `s6_ratio` on what the chart shows as a 7-streak. User: edges were backtested on Binance, so direction should follow Binance. | `377b322`-era — `fetchStreakWithVolume` outcomes = Binance close-vs-open (streak-source flip #3: 1769269 Poly → b6ff6c2 Binance → dc44000 Poly → **THIS** Binance). Also `fetchInProgressIcon` → Binance-primary (Poly midpoint fallback) so the +1 current bar matches too. Poly kept for mismatch alerts + T-0 closure (P&L truth); dc44000's phaseT0 closure tree still reconciles Binance-candle vs Poly-outcome → no double-fade regression. |
| `resultGate` (pooled K1) corrupts its consec-loss count if a non-participating coin feeds it. `tryPlaceBoundary` sets `gateSignal` + checks `gateAllows` for EVERY coin reaching placement, so the 1h/15m echo coins would feed the BTC+ETH pooled count → wrong regime signal (the gate ONLY gains pooled across the validated coins; per-coin is worse than always-on). Caught pre-deploy 2026-06-15 while implementing. | Wrap the `gateSignal.set` + `gateAllows` skip in `if (cfg.enabled && cfg.coins.includes(state.symbol))`. Pooled state fed/gated ONLY by `coins`. Both `result_gate` (K1) and per-edge `efficiencyRatioMin` (ER chop-filter) are OFF by default — see EDGE_CASES.md "Result-gate + ER chop-filter". |
| Per-coin config PUT `.toUpperCase()`'d the `:symbol` route param then checked `ALL_COINS.includes` — fine for all-caps coins (BTC, ETH, BTC_1H) but mangles the lowercase timeframe suffix: `BTC_15m` → `BTC_15M` ∉ ALL_COINS → 400 "unknown symbol", so **BTC_15m config could NEVER be saved** via the API/UI (verified prod 2026-06-17). | `coin-configs.ts` — case-insensitive resolve to the canonical CoinSymbol (`ALL_COINS.find(c => c.toLowerCase() === raw.toLowerCase())`), drop `.toUpperCase()`. **Rule: never `.toUpperCase()` a CoinSymbol** — timeframe suffixes are mixed-case (`15m` lower, `1H` upper). (`analyze-streaks.ts` shares the `.toUpperCase()` but is 5m-only / doesn't list 15m-1h coins, so it's unaffected.) |

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
