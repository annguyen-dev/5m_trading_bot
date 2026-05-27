# Backtest — current prod BTC config

_Generated 2026-05-27T13:38:46.020Z_ · source: `/tmp/cfg-1h-v2.json (live DB)` (fetched 2026-05-27)

> **WR is the primary signal** (pricing-independent). PnL is directional/relative — flat $0.55 entry, binary settlement (win=$1, lose=$0), **not real PnL**.
>
> `arm_trigger_body3_min` = **800** (live DB value — runtime uses this; it overrides the code PER_COIN_OVERRIDES default).

## Config

| field | value |
|---|---|
| coin | BTC |
| fetched_at | 2026-05-27 |
| source | /tmp/cfg-1h-v2.json (live DB) |
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
| idle_body3_min | 1500 |
| armed_body3_min | 1000 |
| dca_body3_min_idle | 1200 |
| dca_body3_min_armed | 800 |
| echo_dca_scale | [2] |
| echo_dca_scale_idle | [2] |
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

**Total:** 42 trades · WR **69%** · pnl $76.36 · maxDD $15

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 0 | 0 | — | 0 | 0 |
| idle_dca | 0 | 0 | — | 0 | 0 |
| armed_base | 0 | 0 | — | 0 | 0 |
| armed_dca | 0 | 0 | — | 0 | 0 |
| edge_base | 32 | 21 | 65.6 | 30.91 | 16.82 |
| edge_dca | 10 | 8 | 80 | 45.45 | 10 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 4 | 18 | 14 | 77.8 | 37.27 | 10.91 |
| 5 | 4 | 2 | 50 | -3.64 | 10 |
| 6 | 14 | 7 | 50 | -6.36 | 18.64 |
| 7 | 6 | 6 | 100 | 49.09 | 0 |

### 180 days (4320 bars)

**Total:** 97 trades · WR **63.9%** · pnl $81.82 · maxDD $52.73

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 0 | 0 | — | 0 | 0 |
| idle_dca | 0 | 0 | — | 0 | 0 |
| armed_base | 2 | 2 | 100 | 8.18 | 0 |
| armed_dca | 0 | 0 | — | 0 | 0 |
| edge_base | 72 | 47 | 65.3 | 67.27 | 18.64 |
| edge_dca | 23 | 13 | 56.5 | 6.36 | 65.45 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 4 | 38 | 26 | 68.4 | 46.36 | 11.82 |
| 5 | 11 | 5 | 45.5 | -19.09 | 33.64 |
| 6 | 34 | 21 | 61.8 | 20.91 | 18.64 |
| 7 | 12 | 8 | 66.7 | 25.45 | 31.82 |
| 8 | 2 | 2 | 100 | 8.18 | 0 |

### 365 days (8760 bars)

**Total:** 237 trades · WR **59.1%** · pnl $47.27 · maxDD $98.18

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 1 | 0 | 0 | -5 | 5 |
| idle_dca | 1 | 0 | 0 | -10 | 10 |
| armed_base | 11 | 7 | 63.6 | 8.64 | 10 |
| armed_dca | 4 | 1 | 25 | -21.82 | 21.82 |
| edge_base | 166 | 105 | 63.3 | 124.55 | 26.82 |
| edge_dca | 54 | 27 | 50 | -49.09 | 119.09 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 4 | 82 | 52 | 63.4 | 62.73 | 26.82 |
| 5 | 27 | 13 | 48.1 | -33.64 | 59.09 |
| 6 | 84 | 53 | 63.1 | 61.82 | 22.73 |
| 7 | 28 | 14 | 50 | -20.45 | 85.91 |
| 8 | 7 | 4 | 57.1 | -3.64 | 15 |
| 9 | 3 | 1 | 33.3 | -15.91 | 15.91 |
| 10 | 2 | 1 | 50 | -0.91 | 5 |
| 11 | 1 | 0 | 0 | -10 | 10 |
| 12 | 2 | 1 | 50 | -0.91 | 5 |
| 13 | 1 | 1 | 100 | 8.18 | 0 |
