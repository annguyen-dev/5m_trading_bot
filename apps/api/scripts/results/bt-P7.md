# Backtest — current prod BTC config

_Generated 2026-05-27T07:59:42.474Z_ · source: `/tmp/cfg-armtrig400.json (live DB)` (fetched 2026-05-27)

> **WR is the primary signal** (pricing-independent). PnL is directional/relative — flat $0.55 entry, binary settlement (win=$1, lose=$0), **not real PnL**.
>
> `arm_trigger_body3_min` = **400** (live DB value — runtime uses this; it overrides the code PER_COIN_OVERRIDES default).

## Config

| field | value |
|---|---|
| coin | BTC |
| fetched_at | 2026-05-27 |
| source | /tmp/cfg-armtrig400.json (live DB) |
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
| arm_trigger_body3_min | 400 |
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

**Total:** 448 trades · WR **61.2%** · pnl $319.55 · maxDD $84.09

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 10 | 5 | 50 | -4.55 | 10.91 |
| idle_dca | 5 | 4 | 80 | 22.73 | 10 |
| armed_base | 13 | 9 | 69.2 | 16.82 | 10 |
| armed_dca | 4 | 3 | 75 | 14.55 | 10 |
| edge_base | 306 | 187 | 61.1 | 170 | 45.45 |
| edge_dca | 110 | 66 | 60 | 100 | 81.82 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 196 | 129 | 65.8 | 192.73 | 24.55 |
| 4 | 119 | 66 | 55.5 | 30.45 | 56.36 |
| 5 | 64 | 39 | 60.9 | 64.09 | 35.91 |
| 6 | 25 | 15 | 60 | 27.27 | 33.64 |
| 7 | 30 | 20 | 66.7 | 43.18 | 11.82 |
| 8 | 8 | 3 | 37.5 | -29.55 | 40 |
| 9 | 3 | 0 | 0 | -15 | 15 |
| 10 | 3 | 2 | 66.7 | 6.36 | 10 |

### 180 days (51840 bars)

**Total:** 1344 trades · WR **56.7%** · pnl $274.55 · maxDD $195.91

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 40 | 21 | 52.5 | -9.09 | 30 |
| idle_dca | 19 | 10 | 52.6 | -8.18 | 63.64 |
| armed_base | 38 | 17 | 44.7 | -35.45 | 70.45 |
| armed_dca | 20 | 12 | 60 | 18.18 | 30 |
| edge_base | 874 | 501 | 57.3 | 184.55 | 138.18 |
| edge_dca | 353 | 201 | 56.9 | 124.55 | 95.45 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 589 | 342 | 58.1 | 164.09 | 93.18 |
| 4 | 364 | 191 | 52.5 | -86.82 | 168.64 |
| 5 | 186 | 107 | 57.5 | 91.36 | 79.09 |
| 6 | 81 | 49 | 60.5 | 63.18 | 51.36 |
| 7 | 77 | 52 | 67.5 | 91.36 | 27.73 |
| 8 | 24 | 12 | 50 | -19.09 | 53.18 |
| 9 | 9 | 2 | 22.2 | -32.73 | 32.73 |
| 10 | 8 | 5 | 62.5 | 16.82 | 10 |
| 11 | 2 | 1 | 50 | -1.82 | 10 |
| 12 | 1 | 0 | 0 | -5 | 5 |
| 13 | 1 | 0 | 0 | -10 | 10 |
| 14 | 1 | 0 | 0 | -5 | 5 |
| 15 | 1 | 1 | 100 | 8.18 | 0 |

### 365 days (105120 bars)

**Total:** 3279 trades · WR **55.9%** · pnl $426.82 · maxDD $294.55

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 76 | 37 | 48.7 | -43.64 | 67.73 |
| idle_dca | 39 | 21 | 53.8 | -8.18 | 66.36 |
| armed_base | 163 | 84 | 51.5 | -51.36 | 93.64 |
| armed_dca | 78 | 50 | 64.1 | 129.09 | 53.64 |
| edge_base | 2068 | 1160 | 56.1 | 205.45 | 152.27 |
| edge_dca | 855 | 481 | 56.3 | 195.45 | 160 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 1441 | 805 | 55.9 | 113.18 | 183.18 |
| 4 | 903 | 507 | 56.1 | 165.45 | 218.64 |
| 5 | 422 | 232 | 55 | 44.55 | 109.09 |
| 6 | 178 | 102 | 57.3 | 63.64 | 60.91 |
| 7 | 190 | 114 | 60 | 102.73 | 52.73 |
| 8 | 76 | 38 | 50 | -58.64 | 93.64 |
| 9 | 31 | 17 | 54.8 | 0.91 | 37.73 |
| 10 | 16 | 10 | 62.5 | 37.73 | 20 |
| 11 | 7 | 2 | 28.6 | -18.64 | 26.82 |
| 12 | 5 | 1 | 20 | -21.82 | 21.82 |
| 13 | 4 | 3 | 75 | 6.36 | 10 |
| 14 | 2 | 0 | 0 | -10 | 10 |
| 15 | 2 | 1 | 50 | -1.82 | 10 |
| 17 | 1 | 0 | 0 | -5 | 5 |
| 18 | 1 | 1 | 100 | 8.18 | 0 |
