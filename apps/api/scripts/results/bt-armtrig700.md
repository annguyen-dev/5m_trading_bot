# Backtest — current prod BTC config

_Generated 2026-05-27T04:07:33.870Z_ · source: `/tmp/cfg-armtrig700.json (live DB)` (fetched 2026-05-27)

> **WR is the primary signal** (pricing-independent). PnL is directional/relative — flat $0.55 entry, binary settlement (win=$1, lose=$0), **not real PnL**.
>
> `arm_trigger_body3_min` = **700** (live DB value — runtime uses this; it overrides the code PER_COIN_OVERRIDES default).

## Config

| field | value |
|---|---|
| coin | BTC |
| fetched_at | 2026-05-27 |
| source | /tmp/cfg-armtrig700.json (live DB) |
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
| arm_trigger_body3_min | 700 |
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

**Total:** 444 trades · WR **60.8%** · pnl $290 · maxDD $100.45

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 12 | 6 | 50 | -5.45 | 15.91 |
| idle_dca | 6 | 5 | 83.3 | 30.91 | 10 |
| armed_base | 8 | 6 | 75 | 14.55 | 5 |
| armed_dca | 2 | 0 | 0 | -20 | 20 |
| edge_base | 306 | 187 | 61.1 | 170 | 45.45 |
| edge_dca | 110 | 66 | 60 | 100 | 81.82 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 196 | 128 | 65.3 | 183.64 | 23.18 |
| 4 | 120 | 65 | 54.2 | 2.27 | 72.73 |
| 5 | 63 | 38 | 60.3 | 60 | 35.91 |
| 6 | 25 | 15 | 60 | 27.27 | 33.64 |
| 7 | 30 | 20 | 66.7 | 43.18 | 11.82 |
| 8 | 8 | 3 | 37.5 | -29.55 | 40 |
| 9 | 1 | 0 | 0 | -5 | 5 |
| 10 | 1 | 1 | 100 | 8.18 | 0 |

### 180 days (51840 bars)

**Total:** 1320 trades · WR **57.1%** · pnl $300 · maxDD $190

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 35 | 23 | 65.7 | 34.09 | 17.73 |
| idle_dca | 12 | 7 | 58.3 | 7.27 | 40 |
| armed_base | 29 | 13 | 44.8 | -26.82 | 49.55 |
| armed_dca | 16 | 7 | 43.8 | -32.73 | 35.45 |
| edge_base | 876 | 504 | 57.5 | 201.82 | 125 |
| edge_dca | 352 | 200 | 56.8 | 116.36 | 95.45 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 580 | 338 | 58.3 | 172.73 | 91.82 |
| 4 | 364 | 191 | 52.5 | -103.18 | 157.73 |
| 5 | 182 | 107 | 58.8 | 111.36 | 79.09 |
| 6 | 77 | 48 | 62.3 | 75.91 | 45.45 |
| 7 | 77 | 52 | 67.5 | 87.27 | 27.73 |
| 8 | 23 | 12 | 52.2 | -14.09 | 48.18 |
| 9 | 6 | 1 | 16.7 | -30.91 | 30.91 |
| 10 | 5 | 3 | 60 | 14.55 | 5 |
| 11 | 2 | 1 | 50 | -1.82 | 10 |
| 12 | 1 | 0 | 0 | -5 | 5 |
| 13 | 1 | 0 | 0 | -10 | 10 |
| 14 | 1 | 0 | 0 | -5 | 5 |
| 15 | 1 | 1 | 100 | 8.18 | 0 |

### 365 days (105120 bars)

**Total:** 3156 trades · WR **56.1%** · pnl $416.36 · maxDD $305

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 79 | 44 | 55.7 | 5 | 58.18 |
| idle_dca | 35 | 22 | 62.9 | 50 | 40 |
| armed_base | 75 | 37 | 49.3 | -38.64 | 100.45 |
| armed_dca | 37 | 20 | 54.1 | -6.36 | 42.73 |
| edge_base | 2074 | 1165 | 56.2 | 220.91 | 152.27 |
| edge_dca | 856 | 481 | 56.2 | 185.45 | 160 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 1378 | 777 | 56.4 | 173.64 | 164.55 |
| 4 | 865 | 482 | 55.7 | 103.18 | 220 |
| 5 | 414 | 230 | 55.6 | 62.27 | 121.36 |
| 6 | 172 | 99 | 57.6 | 73.18 | 60.91 |
| 7 | 190 | 114 | 60 | 102.73 | 52.73 |
| 8 | 76 | 38 | 50 | -58.64 | 93.64 |
| 9 | 25 | 15 | 60 | 12.73 | 35.91 |
| 10 | 12 | 7 | 58.3 | 32.27 | 15 |
| 11 | 7 | 2 | 28.6 | -23.64 | 31.82 |
| 12 | 5 | 0 | 0 | -35 | 35 |
| 13 | 5 | 3 | 60 | -3.64 | 11.82 |
| 14 | 2 | 0 | 0 | -10 | 10 |
| 15 | 2 | 1 | 50 | -1.82 | 10 |
| 16 | 1 | 0 | 0 | -5 | 5 |
| 17 | 1 | 0 | 0 | -10 | 10 |
| 18 | 1 | 1 | 100 | 4.09 | 0 |
