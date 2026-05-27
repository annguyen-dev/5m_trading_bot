# Backtest — current prod BTC config

_Generated 2026-05-27T13:43:58.536Z_ · source: `/tmp/cfg-1h-v9.json (live DB)` (fetched 2026-05-27)

> **WR is the primary signal** (pricing-independent). PnL is directional/relative — flat $0.55 entry, binary settlement (win=$1, lose=$0), **not real PnL**.
>
> `arm_trigger_body3_min` = **800** (live DB value — runtime uses this; it overrides the code PER_COIN_OVERRIDES default).

## Config

| field | value |
|---|---|
| coin | BTC |
| fetched_at | 2026-05-27 |
| source | /tmp/cfg-1h-v9.json (live DB) |
| enabled | true |
| strategy | echo |
| mode | signal_and_order |
| size_usdc | 5 |
| limit_price_cents | 69 |
| tp_cents | 95 |
| sl_cents | 10 |
| echo_trigger_streak | 99 |
| echo_window_minutes | 360 |
| echo_signal_min_streak | 99 |
| echo_baseline_streak | 99 |
| echo_require_high_body | false |
| arm_trigger_body3_min | 800 |
| idle_body3_min | 1500 |
| armed_body3_min | 1000 |
| dca_body3_min_idle | 1200 |
| dca_body3_min_armed | 800 |
| echo_dca_scale | [] |
| echo_dca_scale_idle | [] |
| echo_defensive_enabled | false |
| echo_chain_enabled | false |
| streak_min | 2 |
| auto_order_min_streak | 7 |
| dca_multiplier | 1.8 |
| dca_streak_whitelist | [4, 5, 9, 10] |
| entry_model_flat | 0.55 |

**Edge cases:**

| label | streakMin | streakMax | body3Min | dcaBody3Min |
|---|---|---|---|---|
| s2 | 2 | 2 | 1500 | 1200 |
| s3 | 3 | 3 | 1000 | 800 |
| s4 | 4 | 4 | 1000 | 800 |

_streak-strategy fields (`auto_*`, `dca_multiplier`, `dca_streak_whitelist`) do NOT apply to echo and are ignored by the sim._

## Results

### 90 days (2160 bars)

**Total:** 71 trades · WR **64.8%** · pnl $63.18 · maxDD $17.73

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 0 | 0 | — | 0 | 0 |
| idle_dca | 0 | 0 | — | 0 | 0 |
| armed_base | 0 | 0 | — | 0 | 0 |
| armed_dca | 0 | 0 | — | 0 | 0 |
| edge_base | 71 | 46 | 64.8 | 63.18 | 17.73 |
| edge_dca | 0 | 0 | — | 0 | 0 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 2 | 27 | 16 | 59.3 | 10.45 | 13.64 |
| 3 | 26 | 16 | 61.5 | 15.45 | 15.91 |
| 4 | 18 | 14 | 77.8 | 37.27 | 10.91 |

### 180 days (4320 bars)

**Total:** 194 trades · WR **60.3%** · pnl $93.64 · maxDD $58.18

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 0 | 0 | — | 0 | 0 |
| idle_dca | 0 | 0 | — | 0 | 0 |
| armed_base | 0 | 0 | — | 0 | 0 |
| armed_dca | 0 | 0 | — | 0 | 0 |
| edge_base | 194 | 117 | 60.3 | 93.64 | 58.18 |
| edge_dca | 0 | 0 | — | 0 | 0 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 2 | 82 | 45 | 54.9 | -0.91 | 33.18 |
| 3 | 71 | 46 | 64.8 | 63.18 | 15.91 |
| 4 | 41 | 26 | 63.4 | 31.36 | 22.73 |

### 365 days (8760 bars)

**Total:** 455 trades · WR **57.1%** · pnl $88.64 · maxDD $100

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 0 | 0 | — | 0 | 0 |
| idle_dca | 0 | 0 | — | 0 | 0 |
| armed_base | 0 | 0 | — | 0 | 0 |
| armed_dca | 0 | 0 | — | 0 | 0 |
| edge_base | 455 | 260 | 57.1 | 88.64 | 100 |
| edge_dca | 0 | 0 | — | 0 | 0 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 2 | 194 | 105 | 54.1 | -15.45 | 78.64 |
| 3 | 173 | 101 | 58.4 | 53.18 | 44.55 |
| 4 | 88 | 54 | 61.4 | 50.91 | 24.55 |
