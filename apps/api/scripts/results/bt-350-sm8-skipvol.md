# Backtest — current prod BTC config

_Generated 2026-05-27T07:44:49.852Z_ · source: `/tmp/cfg-armtrig350.json (live DB)` (fetched 2026-05-27)

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

**Total:** 460 trades · WR **61.3%** · pnl $335.45 · maxDD $87.73

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 9 | 5 | 55.6 | 0.45 | 10 |
| idle_dca | 4 | 3 | 75 | 14.55 | 10 |
| armed_base | 24 | 15 | 62.5 | 16.36 | 20 |
| armed_dca | 9 | 6 | 66.7 | 19.09 | 21.82 |
| edge_base | 305 | 187 | 61.3 | 175 | 40.91 |
| edge_dca | 109 | 66 | 60.6 | 110 | 81.82 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 201 | 131 | 65.2 | 185.91 | 32.27 |
| 4 | 122 | 68 | 55.7 | 36.82 | 60.91 |
| 5 | 64 | 39 | 60.9 | 64.09 | 35.91 |
| 6 | 30 | 19 | 63.3 | 38.64 | 33.64 |
| 7 | 30 | 20 | 66.7 | 38.18 | 11.82 |
| 8 | 8 | 3 | 37.5 | -24.55 | 35 |
| 9 | 3 | 0 | 0 | -20 | 20 |
| 10 | 2 | 2 | 100 | 16.36 | 0 |

### 180 days (51840 bars)

**Total:** 1377 trades · WR **57%** · pnl $320 · maxDD $217.27

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 30 | 20 | 66.7 | 31.82 | 11.82 |
| idle_dca | 10 | 5 | 50 | -9.09 | 40 |
| armed_base | 77 | 38 | 49.4 | -39.55 | 72.73 |
| armed_dca | 38 | 22 | 57.9 | 20 | 51.82 |
| edge_base | 871 | 500 | 57.4 | 190.45 | 137.27 |
| edge_dca | 351 | 200 | 57 | 126.36 | 95.45 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 602 | 350 | 58.1 | 171.82 | 86.82 |
| 4 | 375 | 199 | 53.1 | -66.82 | 184.55 |
| 5 | 188 | 110 | 58.5 | 112.73 | 70.91 |
| 6 | 88 | 54 | 61.4 | 69.55 | 44.09 |
| 7 | 77 | 52 | 67.5 | 90.45 | 27.73 |
| 8 | 25 | 12 | 48 | -19.09 | 48.18 |
| 9 | 9 | 1 | 11.1 | -51.82 | 51.82 |
| 10 | 7 | 5 | 71.4 | 26.82 | 5 |
| 11 | 2 | 1 | 50 | -1.82 | 10 |
| 12 | 1 | 0 | 0 | -5 | 5 |
| 13 | 1 | 0 | 0 | -10 | 10 |
| 14 | 1 | 0 | 0 | -5 | 5 |
| 15 | 1 | 1 | 100 | 8.18 | 0 |

### 365 days (105120 bars)

**Total:** 3323 trades · WR **56%** · pnl $465.91 · maxDD $321.82

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 66 | 36 | 54.5 | -2.73 | 42.27 |
| idle_dca | 30 | 18 | 60 | 27.27 | 40 |
| armed_base | 215 | 114 | 53 | -38.64 | 102.27 |
| armed_dca | 99 | 59 | 59.6 | 82.73 | 63.64 |
| edge_base | 2060 | 1155 | 56.1 | 200 | 147.27 |
| edge_dca | 853 | 480 | 56.3 | 197.27 | 160 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 1453 | 814 | 56 | 135 | 195.91 |
| 4 | 911 | 515 | 56.5 | 215.45 | 238.64 |
| 5 | 423 | 233 | 55.1 | 43.64 | 130 |
| 6 | 196 | 113 | 57.7 | 64.55 | 60.91 |
| 7 | 191 | 115 | 60.2 | 113.18 | 44.55 |
| 8 | 78 | 39 | 50 | -49.55 | 84.55 |
| 9 | 31 | 15 | 48.4 | -32.27 | 56.82 |
| 10 | 15 | 10 | 66.7 | 47.73 | 20 |
| 11 | 7 | 2 | 28.6 | -18.64 | 26.82 |
| 12 | 6 | 1 | 16.7 | -26.82 | 26.82 |
| 13 | 5 | 3 | 60 | -3.64 | 11.82 |
| 14 | 2 | 0 | 0 | -10 | 10 |
| 15 | 2 | 1 | 50 | -1.82 | 10 |
| 16 | 1 | 0 | 0 | -5 | 5 |
| 17 | 1 | 0 | 0 | -10 | 10 |
| 18 | 1 | 1 | 100 | 4.09 | 0 |
