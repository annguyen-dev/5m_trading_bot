# Backtest — current prod BTC config

_Generated 2026-05-27T07:56:54.065Z_ · source: `/tmp/cfg-armtrig350.json (live DB)` (fetched 2026-05-27)

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

**Total:** 472 trades · WR **61%** · pnl $315 · maxDD $81.82

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 9 | 5 | 55.6 | 0.45 | 10 |
| idle_dca | 4 | 3 | 75 | 14.55 | 10 |
| armed_base | 33 | 20 | 60.6 | 16.82 | 21.36 |
| armed_dca | 13 | 7 | 53.8 | -2.73 | 31.82 |
| edge_base | 305 | 188 | 61.6 | 184.09 | 40.91 |
| edge_dca | 108 | 65 | 60.2 | 101.82 | 81.82 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 208 | 135 | 64.9 | 187.27 | 29.55 |
| 4 | 125 | 69 | 55.2 | 15.91 | 60.91 |
| 5 | 65 | 39 | 60 | 55 | 45 |
| 6 | 31 | 20 | 64.5 | 46.82 | 33.64 |
| 7 | 30 | 20 | 66.7 | 38.18 | 11.82 |
| 8 | 8 | 3 | 37.5 | -24.55 | 35 |
| 9 | 3 | 0 | 0 | -20 | 20 |
| 10 | 2 | 2 | 100 | 16.36 | 0 |

### 180 days (51840 bars)

**Total:** 1415 trades · WR **57%** · pnl $311.36 · maxDD $205.91

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 27 | 18 | 66.7 | 28.64 | 15.91 |
| idle_dca | 9 | 5 | 55.6 | 0.91 | 30 |
| armed_base | 109 | 56 | 51.4 | -35.91 | 80 |
| armed_dca | 52 | 29 | 55.8 | 7.27 | 61.82 |
| edge_base | 869 | 500 | 57.5 | 200.45 | 137.27 |
| edge_dca | 349 | 198 | 56.7 | 110 | 95.45 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 622 | 361 | 58 | 171.82 | 98.18 |
| 4 | 383 | 204 | 53.3 | -70 | 156.82 |
| 5 | 191 | 109 | 57.1 | 80.45 | 70.91 |
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

**Total:** 3441 trades · WR **56.1%** · pnl $523.18 · maxDD $296.82

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 52 | 29 | 55.8 | 3.64 | 48.64 |
| idle_dca | 23 | 12 | 52.2 | -11.82 | 50 |
| armed_base | 320 | 170 | 53.1 | -54.55 | 145 |
| armed_dca | 148 | 91 | 61.5 | 174.55 | 80.91 |
| edge_base | 2051 | 1151 | 56.1 | 208.64 | 151.36 |
| edge_dca | 847 | 477 | 56.3 | 202.73 | 158.18 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 1517 | 847 | 55.8 | 115 | 215.91 |
| 4 | 943 | 539 | 57.2 | 291.36 | 202.73 |
| 5 | 429 | 234 | 54.5 | 24.55 | 123.18 |
| 6 | 206 | 118 | 57.3 | 66.36 | 70 |
| 7 | 192 | 116 | 60.4 | 111.36 | 42.73 |
| 8 | 79 | 39 | 49.4 | -53.64 | 88.64 |
| 9 | 35 | 19 | 54.3 | -7.73 | 52.73 |
| 10 | 15 | 10 | 66.7 | 47.73 | 20 |
| 11 | 7 | 2 | 28.6 | -18.64 | 26.82 |
| 12 | 6 | 1 | 16.7 | -26.82 | 26.82 |
| 13 | 5 | 3 | 60 | -3.64 | 11.82 |
| 14 | 2 | 0 | 0 | -10 | 10 |
| 15 | 2 | 1 | 50 | -1.82 | 10 |
| 16 | 1 | 0 | 0 | -5 | 5 |
| 17 | 1 | 0 | 0 | -10 | 10 |
| 18 | 1 | 1 | 100 | 4.09 | 0 |
