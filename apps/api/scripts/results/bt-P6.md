# Backtest — current prod BTC config

_Generated 2026-05-27T07:59:14.377Z_ · source: `/tmp/cfg-armtrig350.json (live DB)` (fetched 2026-05-27)

> **WR is the primary signal** (pricing-independent). PnL is directional/relative — flat $0.55 entry, binary settlement (win=$1, lose=$0), **not real PnL**.
>
> `arm_trigger_body3_min` = **350** (live DB value — runtime uses this; it overrides the code PER_COIN_OVERRIDES default).

## Config

| field | value |
|---|---|
| coin | BTC |
| fetched_at | 2026-05-27 |
| source | /tmp/cfg-armtrig350.json (live DB) |
| enabled | true |
| strategy | echo |
| mode | signal_and_order |
| size_usdc | 5 |
| limit_price_cents | 69 |
| tp_cents | 95 |
| sl_cents | 10 |
| echo_trigger_streak | 5 |
| echo_window_minutes | 150 |
| echo_signal_min_streak | 3 |
| echo_baseline_streak | 6 |
| echo_require_high_body | false |
| arm_trigger_body3_min | 350 |
| idle_body3_min | 500 |
| armed_body3_min | 350 |
| dca_body3_min_idle | 200 |
| dca_body3_min_armed | 150 |
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
| streak3 | 3 | 3 | 440 | 250 |
| streak4 | 4 | 4 | 420 | 300 |
| streak5 | 5 | 5 | 400 | 350 |
| 7 | 7 | 7 | 300 | 250 |

_streak-strategy fields (`auto_*`, `dca_multiplier`, `dca_streak_whitelist`) do NOT apply to echo and are ignored by the sim._

## Results

### 90 days (25920 bars)

**Total:** 466 trades · WR **60.9%** · pnl $313.64 · maxDD $83.64

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 9 | 5 | 55.6 | 0.45 | 10 |
| idle_dca | 4 | 3 | 75 | 14.55 | 10 |
| armed_base | 28 | 16 | 57.1 | 5.45 | 21.36 |
| armed_dca | 12 | 7 | 58.3 | 7.27 | 21.82 |
| edge_base | 305 | 188 | 61.6 | 184.09 | 40.91 |
| edge_dca | 108 | 65 | 60.2 | 101.82 | 81.82 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 203 | 131 | 64.5 | 175.91 | 29.55 |
| 4 | 124 | 69 | 55.6 | 25.91 | 60.91 |
| 5 | 65 | 39 | 60 | 55 | 45 |
| 6 | 31 | 20 | 64.5 | 46.82 | 33.64 |
| 7 | 30 | 20 | 66.7 | 38.18 | 11.82 |
| 8 | 8 | 3 | 37.5 | -24.55 | 35 |
| 9 | 3 | 0 | 0 | -20 | 20 |
| 10 | 2 | 2 | 100 | 16.36 | 0 |

### 180 days (51840 bars)

**Total:** 1403 trades · WR **56.9%** · pnl $313.64 · maxDD $199.09

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 33 | 19 | 57.6 | 7.73 | 19.55 |
| idle_dca | 14 | 8 | 57.1 | 5.45 | 41.82 |
| armed_base | 93 | 49 | 52.7 | -19.55 | 50.45 |
| armed_dca | 43 | 24 | 55.8 | 6.36 | 51.82 |
| edge_base | 870 | 500 | 57.5 | 195.45 | 142.27 |
| edge_dca | 350 | 199 | 56.9 | 118.18 | 95.45 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 615 | 357 | 58 | 170.45 | 88.18 |
| 4 | 379 | 202 | 53.3 | -62.27 | 164.09 |
| 5 | 190 | 108 | 56.8 | 76.36 | 70.91 |
| 6 | 94 | 59 | 62.8 | 92.27 | 40 |
| 7 | 77 | 52 | 67.5 | 90.45 | 27.73 |
| 8 | 25 | 12 | 48 | -19.09 | 48.18 |
| 9 | 10 | 2 | 20 | -47.73 | 47.73 |
| 10 | 7 | 5 | 71.4 | 26.82 | 5 |
| 11 | 2 | 1 | 50 | -1.82 | 10 |
| 12 | 1 | 0 | 0 | -5 | 5 |
| 13 | 1 | 0 | 0 | -10 | 10 |
| 14 | 1 | 0 | 0 | -5 | 5 |
| 15 | 1 | 1 | 100 | 8.18 | 0 |

### 365 days (105120 bars)

**Total:** 3406 trades · WR **56.1%** · pnl $530 · maxDD $270.91

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 63 | 31 | 49.2 | -33.18 | 63.64 |
| idle_dca | 32 | 17 | 53.1 | -10.91 | 60.91 |
| armed_base | 282 | 153 | 54.3 | -19.09 | 84.09 |
| armed_dca | 128 | 80 | 62.5 | 174.55 | 55.45 |
| edge_base | 2053 | 1152 | 56.1 | 207.73 | 151.36 |
| edge_dca | 848 | 478 | 56.4 | 210.91 | 158.18 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 1498 | 836 | 55.8 | 110 | 205.45 |
| 4 | 934 | 533 | 57.1 | 280.45 | 210 |
| 5 | 428 | 233 | 54.4 | 20.45 | 123.18 |
| 6 | 206 | 118 | 57.3 | 66.36 | 70 |
| 7 | 192 | 116 | 60.4 | 111.36 | 42.73 |
| 8 | 77 | 39 | 50.6 | -43.64 | 78.64 |
| 9 | 34 | 18 | 52.9 | -20 | 52.73 |
| 10 | 15 | 10 | 66.7 | 47.73 | 20 |
| 11 | 7 | 2 | 28.6 | -18.64 | 26.82 |
| 12 | 5 | 1 | 20 | -21.82 | 21.82 |
| 13 | 4 | 3 | 75 | 6.36 | 10 |
| 14 | 2 | 0 | 0 | -10 | 10 |
| 15 | 2 | 1 | 50 | -1.82 | 10 |
| 17 | 1 | 0 | 0 | -5 | 5 |
| 18 | 1 | 1 | 100 | 8.18 | 0 |
