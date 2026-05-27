# Backtest — current prod BTC config

_Generated 2026-05-27T07:58:18.206Z_ · source: `/tmp/cfg-armtrig300.json (live DB)` (fetched 2026-05-27)

> **WR is the primary signal** (pricing-independent). PnL is directional/relative — flat $0.55 entry, binary settlement (win=$1, lose=$0), **not real PnL**.
>
> `arm_trigger_body3_min` = **300** (live DB value — runtime uses this; it overrides the code PER_COIN_OVERRIDES default).

## Config

| field | value |
|---|---|
| coin | BTC |
| fetched_at | 2026-05-27 |
| source | /tmp/cfg-armtrig300.json (live DB) |
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
| arm_trigger_body3_min | 300 |
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

**Total:** 476 trades · WR **60.9%** · pnl $325.45 · maxDD $73.18

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 6 | 2 | 33.3 | -11.82 | 11.82 |
| idle_dca | 4 | 3 | 75 | 14.55 | 10 |
| armed_base | 39 | 23 | 59 | 14.09 | 28.64 |
| armed_dca | 16 | 10 | 62.5 | 21.82 | 21.82 |
| edge_base | 303 | 187 | 61.7 | 185 | 40.91 |
| edge_dca | 108 | 65 | 60.2 | 101.82 | 81.82 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 206 | 133 | 64.6 | 179.09 | 30.45 |
| 4 | 126 | 71 | 56.3 | 38.18 | 60.91 |
| 5 | 66 | 40 | 60.6 | 59.09 | 40.91 |
| 6 | 34 | 20 | 58.8 | 31.82 | 38.64 |
| 7 | 31 | 21 | 67.7 | 45.45 | 15 |
| 8 | 8 | 3 | 37.5 | -24.55 | 35 |
| 9 | 3 | 0 | 0 | -20 | 20 |
| 10 | 2 | 2 | 100 | 16.36 | 0 |

### 180 days (51840 bars)

**Total:** 1434 trades · WR **57.1%** · pnl $336.82 · maxDD $190

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 28 | 15 | 53.6 | -3.64 | 20.45 |
| idle_dca | 13 | 7 | 53.8 | -2.73 | 41.82 |
| armed_base | 123 | 68 | 55.3 | 3.18 | 45.45 |
| armed_dca | 54 | 31 | 57.4 | 23.64 | 51.82 |
| edge_base | 868 | 501 | 57.7 | 214.55 | 131.82 |
| edge_dca | 348 | 197 | 56.6 | 101.82 | 95.45 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 625 | 362 | 57.9 | 165.91 | 97.27 |
| 4 | 384 | 207 | 53.9 | -39.55 | 148.64 |
| 5 | 194 | 111 | 57.2 | 75.45 | 75.91 |
| 6 | 103 | 63 | 61.2 | 78.64 | 45 |
| 7 | 79 | 54 | 68.4 | 105.91 | 23.64 |
| 8 | 25 | 12 | 48 | -19.09 | 48.18 |
| 9 | 11 | 3 | 27.3 | -43.64 | 43.64 |
| 10 | 7 | 5 | 71.4 | 26.82 | 5 |
| 11 | 2 | 1 | 50 | -1.82 | 10 |
| 12 | 1 | 0 | 0 | -5 | 5 |
| 13 | 1 | 0 | 0 | -10 | 10 |
| 14 | 1 | 0 | 0 | -5 | 5 |
| 15 | 1 | 1 | 100 | 8.18 | 0 |

### 365 days (105120 bars)

**Total:** 3497 trades · WR **56%** · pnl $472.27 · maxDD $344.55

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 54 | 25 | 46.3 | -42.73 | 58.64 |
| idle_dca | 29 | 15 | 51.7 | -17.27 | 56.36 |
| armed_base | 363 | 199 | 54.8 | -5.91 | 92.73 |
| armed_dca | 163 | 96 | 58.9 | 115.45 | 97.27 |
| edge_base | 2046 | 1152 | 56.3 | 242.73 | 146.36 |
| edge_dca | 842 | 473 | 56.2 | 180 | 158.18 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 1529 | 849 | 55.5 | 73.18 | 232.73 |
| 4 | 952 | 544 | 57.1 | 282.27 | 182.27 |
| 5 | 439 | 242 | 55.1 | 39.09 | 104.55 |
| 6 | 225 | 129 | 57.3 | 61.36 | 70.91 |
| 7 | 195 | 118 | 60.5 | 111.82 | 48.64 |
| 8 | 78 | 39 | 50 | -52.73 | 87.73 |
| 9 | 38 | 21 | 55.3 | -8.64 | 48.64 |
| 10 | 15 | 10 | 66.7 | 42.73 | 25 |
| 11 | 8 | 2 | 25 | -27.73 | 35.91 |
| 12 | 6 | 1 | 16.7 | -31.82 | 31.82 |
| 13 | 5 | 3 | 60 | 1.36 | 10 |
| 14 | 3 | 0 | 0 | -20 | 20 |
| 15 | 2 | 1 | 50 | -1.82 | 10 |
| 17 | 1 | 0 | 0 | -5 | 5 |
| 18 | 1 | 1 | 100 | 8.18 | 0 |
