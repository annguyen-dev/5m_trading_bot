# Backtest — current prod BTC config

_Generated 2026-05-25T14:00:56.755Z_ · source: `/tmp/cfg-armed150.json (live DB)` (fetched 2026-05-25)

> **WR is the primary signal** (pricing-independent). PnL is directional/relative — flat $0.55 entry, binary settlement (win=$1, lose=$0), **not real PnL**.
>
> `arm_trigger_body3_min` = **100** (live DB value — runtime uses this; it overrides the code PER_COIN_OVERRIDES default).

## Config

| field | value |
|---|---|
| coin | BTC |
| fetched_at | 2026-05-25 |
| source | /tmp/cfg-armed150.json (live DB) |
| enabled | true |
| strategy | echo |
| mode | signal_and_order |
| size_usdc | 5 |
| limit_price_cents | 69 |
| tp_cents | 95 |
| sl_cents | 10 |
| echo_trigger_streak | 5 |
| echo_window_minutes | 60 |
| echo_signal_min_streak | 3 |
| echo_baseline_streak | 6 |
| echo_require_high_body | false |
| arm_trigger_body3_min | 100 |
| idle_body3_min | 500 |
| armed_body3_min | 150 |
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
| 7 | 7 | 7 | 120 | 100 |

_streak-strategy fields (`auto_*`, `dca_multiplier`, `dca_streak_whitelist`) do NOT apply to echo and are ignored by the sim._

## Results

### 90 days (25920 bars)

**Total:** 1050 trades · WR **57%** · pnl $162.73 · maxDD $170.91

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 4 | 1 | 25 | -10.91 | 10.91 |
| idle_dca | 3 | 3 | 100 | 24.55 | 0 |
| armed_base | 567 | 328 | 57.8 | 146.82 | 89.55 |
| armed_dca | 188 | 93 | 49.5 | -189.09 | 231.82 |
| edge_base | 207 | 122 | 58.9 | 74.09 | 58.18 |
| edge_dca | 81 | 51 | 63 | 117.27 | 61.82 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 471 | 278 | 59 | 172.27 | 50 |
| 4 | 223 | 116 | 52 | -110 | 131.36 |
| 5 | 69 | 41 | 59.4 | 38.18 | 40 |
| 6 | 151 | 86 | 57 | 19.55 | 109.55 |
| 7 | 73 | 46 | 63 | 109.09 | 50 |
| 8 | 30 | 13 | 43.3 | -53.64 | 65 |
| 9 | 16 | 8 | 50 | -29.09 | 36.82 |
| 10 | 9 | 5 | 55.6 | -0.45 | 10 |
| 11 | 5 | 3 | 60 | 14.55 | 5 |
| 12 | 2 | 1 | 50 | -1.82 | 10 |
| 13 | 1 | 1 | 100 | 4.09 | 0 |

### 180 days (51840 bars)

**Total:** 2425 trades · WR **55.8%** · pnl $89.55 · maxDD $295

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 16 | 10 | 62.5 | 10.91 | 15.91 |
| idle_dca | 6 | 4 | 66.7 | 12.73 | 20 |
| armed_base | 1176 | 663 | 56.4 | 147.27 | 90.45 |
| armed_dca | 429 | 220 | 51.3 | -290 | 324.55 |
| edge_base | 565 | 322 | 57 | 102.27 | 86.82 |
| edge_dca | 233 | 134 | 57.5 | 106.36 | 133.64 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 1088 | 633 | 58.2 | 314.55 | 90.45 |
| 4 | 552 | 292 | 52.9 | -169.09 | 173.18 |
| 5 | 157 | 88 | 56.1 | 38.64 | 108.64 |
| 6 | 327 | 177 | 54.1 | -57.27 | 175.45 |
| 7 | 163 | 95 | 58.3 | 106.82 | 68.64 |
| 8 | 70 | 35 | 50 | -67.27 | 95.45 |
| 9 | 34 | 15 | 44.1 | -74.09 | 74.09 |
| 10 | 18 | 10 | 55.6 | -5 | 20.91 |
| 11 | 9 | 5 | 55.6 | 11.82 | 10 |
| 12 | 3 | 1 | 33.3 | -6.82 | 15 |
| 13 | 2 | 1 | 50 | -5.91 | 10 |
| 14 | 1 | 0 | 0 | -5 | 5 |
| 15 | 1 | 1 | 100 | 8.18 | 0 |

### 365 days (105120 bars)

**Total:** 5969 trades · WR **54.5%** · pnl $-313.64 · maxDD $813.18

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 26 | 15 | 57.7 | 6.36 | 15.91 |
| idle_dca | 11 | 7 | 63.6 | 17.27 | 23.64 |
| armed_base | 2957 | 1593 | 53.9 | -303.18 | 539.55 |
| armed_dca | 1176 | 632 | 53.7 | -269.09 | 443.64 |
| edge_base | 1265 | 705 | 55.7 | 84.09 | 119.55 |
| edge_dca | 534 | 302 | 56.6 | 150.91 | 270.91 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 2661 | 1454 | 54.6 | -86.82 | 453.18 |
| 4 | 1406 | 793 | 56.4 | 284.09 | 225 |
| 5 | 367 | 190 | 51.8 | -155.91 | 284.55 |
| 6 | 772 | 411 | 53.2 | -160 | 301.36 |
| 7 | 399 | 228 | 57.1 | 133.18 | 95.91 |
| 8 | 179 | 90 | 50.3 | -115 | 127.73 |
| 9 | 87 | 42 | 48.3 | -124.09 | 136.36 |
| 10 | 45 | 26 | 57.8 | 7.73 | 23.64 |
| 11 | 20 | 8 | 40 | -37.73 | 59.55 |
| 12 | 11 | 3 | 27.3 | -29.55 | 37.73 |
| 13 | 9 | 4 | 44.4 | -11.36 | 20 |
| 14 | 5 | 0 | 0 | -35 | 35 |
| 15 | 5 | 4 | 80 | 23.64 | 5 |
| 16 | 1 | 0 | 0 | -10 | 10 |
| 17 | 1 | 0 | 0 | -5 | 5 |
| 18 | 1 | 1 | 100 | 8.18 | 0 |
