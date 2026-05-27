# Backtest — current prod BTC config

_Generated 2026-05-27T13:40:03.718Z_ · source: `/tmp/cfg-1h-v7.json (live DB)` (fetched 2026-05-27)

> **WR is the primary signal** (pricing-independent). PnL is directional/relative — flat $0.55 entry, binary settlement (win=$1, lose=$0), **not real PnL**.
>
> `arm_trigger_body3_min` = **800** (live DB value — runtime uses this; it overrides the code PER_COIN_OVERRIDES default).

## Config

| field | value |
|---|---|
| coin | BTC |
| fetched_at | 2026-05-27 |
| source | /tmp/cfg-1h-v7.json (live DB) |
| enabled | true |
| strategy | echo |
| mode | signal_and_order |
| size_usdc | 5 |
| limit_price_cents | 69 |
| tp_cents | 95 |
| sl_cents | 10 |
| echo_trigger_streak | 6 |
| echo_window_minutes | 360 |
| echo_signal_min_streak | 4 |
| echo_baseline_streak | 6 |
| echo_require_high_body | false |
| arm_trigger_body3_min | 800 |
| idle_body3_min | 2000 |
| armed_body3_min | 1500 |
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
| s4 | 4 | 4 | 1000 | 800 |
| s6 | 6 | 6 | 400 | 400 |

_streak-strategy fields (`auto_*`, `dca_multiplier`, `dca_streak_whitelist`) do NOT apply to echo and are ignored by the sim._

## Results

### 90 days (2160 bars)

**Total:** 33 trades · WR **66.7%** · pnl $35 · maxDD $16.82

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 0 | 0 | — | 0 | 0 |
| idle_dca | 0 | 0 | — | 0 | 0 |
| armed_base | 1 | 1 | 100 | 4.09 | 0 |
| armed_dca | 0 | 0 | — | 0 | 0 |
| edge_base | 32 | 21 | 65.6 | 30.91 | 16.82 |
| edge_dca | 0 | 0 | — | 0 | 0 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 4 | 18 | 14 | 77.8 | 37.27 | 10.91 |
| 6 | 14 | 7 | 50 | -6.36 | 18.64 |
| 7 | 1 | 1 | 100 | 4.09 | 0 |

### 180 days (4320 bars)

**Total:** 78 trades · WR **64.1%** · pnl $64.55 · maxDD $24.55

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 0 | 0 | — | 0 | 0 |
| idle_dca | 0 | 0 | — | 0 | 0 |
| armed_base | 6 | 3 | 50 | -2.73 | 10.91 |
| armed_dca | 0 | 0 | — | 0 | 0 |
| edge_base | 72 | 47 | 65.3 | 67.27 | 18.64 |
| edge_dca | 0 | 0 | — | 0 | 0 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 4 | 38 | 26 | 68.4 | 46.36 | 11.82 |
| 6 | 34 | 21 | 61.8 | 20.91 | 18.64 |
| 7 | 4 | 1 | 25 | -10.91 | 15 |
| 8 | 2 | 2 | 100 | 8.18 | 0 |

### 365 days (8760 bars)

**Total:** 185 trades · WR **61.6%** · pnl $111.36 · maxDD $38.64

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 2 | 1 | 50 | -0.91 | 5 |
| idle_dca | 0 | 0 | — | 0 | 0 |
| armed_base | 17 | 8 | 47.1 | -12.27 | 20.45 |
| armed_dca | 0 | 0 | — | 0 | 0 |
| edge_base | 166 | 105 | 63.3 | 124.55 | 26.82 |
| edge_dca | 0 | 0 | — | 0 | 0 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 4 | 82 | 52 | 63.4 | 62.73 | 26.82 |
| 6 | 84 | 53 | 63.1 | 61.82 | 22.73 |
| 7 | 10 | 4 | 40 | -13.64 | 17.73 |
| 8 | 5 | 3 | 60 | 2.27 | 10 |
| 9 | 2 | 1 | 50 | -0.91 | 5 |
| 10 | 1 | 1 | 100 | 4.09 | 0 |
| 11 | 1 | 0 | 0 | -5 | 5 |
