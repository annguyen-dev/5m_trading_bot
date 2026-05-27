# Backtest — current prod BTC config

_Generated 2026-05-27T04:06:08.220Z_ · source: `/tmp/cfg-armtrig400.json (live DB)` (fetched 2026-05-27)

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

**Total:** 461 trades · WR **60.7%** · pnl $298.18 · maxDD $93.18

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 9 | 5 | 55.6 | 0.45 | 10 |
| idle_dca | 4 | 3 | 75 | 14.55 | 10 |
| armed_base | 23 | 14 | 60.9 | 12.27 | 16.82 |
| armed_dca | 9 | 5 | 55.6 | 0.91 | 21.82 |
| edge_base | 306 | 187 | 61.1 | 170 | 45.45 |
| edge_dca | 110 | 66 | 60 | 100 | 81.82 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 204 | 134 | 65.7 | 198.18 | 24.55 |
| 4 | 122 | 66 | 54.1 | 0.45 | 64.55 |
| 5 | 65 | 39 | 60 | 59.09 | 40.91 |
| 6 | 26 | 16 | 61.5 | 35.45 | 33.64 |
| 7 | 30 | 20 | 66.7 | 43.18 | 11.82 |
| 8 | 8 | 3 | 37.5 | -29.55 | 40 |
| 9 | 3 | 0 | 0 | -15 | 15 |
| 10 | 3 | 2 | 66.7 | 6.36 | 10 |

### 180 days (51840 bars)

**Total:** 1378 trades · WR **56.7%** · pnl $272.73 · maxDD $192.73

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 30 | 20 | 66.7 | 31.82 | 11.82 |
| idle_dca | 10 | 5 | 50 | -9.09 | 40 |
| armed_base | 74 | 33 | 44.6 | -70 | 95.91 |
| armed_dca | 40 | 23 | 57.5 | 18.18 | 41.82 |
| edge_base | 872 | 500 | 57.3 | 185.45 | 133.18 |
| edge_dca | 352 | 200 | 56.8 | 116.36 | 95.45 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 608 | 353 | 58.1 | 169.09 | 97.73 |
| 4 | 374 | 197 | 52.7 | -85.91 | 140.91 |
| 5 | 188 | 108 | 57.4 | 90.45 | 79.09 |
| 6 | 82 | 50 | 61 | 71.36 | 51.36 |
| 7 | 77 | 52 | 67.5 | 91.36 | 27.73 |
| 8 | 25 | 12 | 48 | -24.09 | 53.18 |
| 9 | 10 | 2 | 20 | -42.73 | 42.73 |
| 10 | 8 | 5 | 62.5 | 16.82 | 10 |
| 11 | 2 | 1 | 50 | -1.82 | 10 |
| 12 | 1 | 0 | 0 | -5 | 5 |
| 13 | 1 | 0 | 0 | -10 | 10 |
| 14 | 1 | 0 | 0 | -5 | 5 |
| 15 | 1 | 1 | 100 | 8.18 | 0 |

### 365 days (105120 bars)

**Total:** 3368 trades · WR **55.8%** · pnl $423.64 · maxDD $320.91

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 57 | 32 | 56.1 | 5.91 | 45.45 |
| idle_dca | 25 | 13 | 52 | -13.64 | 51.82 |
| armed_base | 249 | 126 | 50.6 | -99.55 | 162.73 |
| armed_dca | 121 | 75 | 62 | 153.64 | 90.91 |
| edge_base | 2062 | 1155 | 56 | 190 | 152.27 |
| edge_dca | 854 | 480 | 56.2 | 187.27 | 160 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 1486 | 831 | 55.9 | 124.55 | 192.73 |
| 4 | 923 | 521 | 56.4 | 211.82 | 190.91 |
| 5 | 425 | 233 | 54.8 | 38.64 | 114.09 |
| 6 | 181 | 105 | 58 | 84.09 | 60.91 |
| 7 | 190 | 114 | 60 | 102.73 | 52.73 |
| 8 | 79 | 38 | 48.1 | -73.64 | 108.64 |
| 9 | 33 | 18 | 54.5 | 3.18 | 47.73 |
| 10 | 18 | 11 | 61.1 | 36.82 | 20.91 |
| 11 | 8 | 2 | 25 | -28.64 | 36.82 |
| 12 | 7 | 1 | 14.3 | -31.82 | 31.82 |
| 13 | 7 | 3 | 42.9 | -18.64 | 22.73 |
| 14 | 4 | 0 | 0 | -25 | 25 |
| 15 | 4 | 3 | 75 | 10.45 | 10 |
| 16 | 1 | 0 | 0 | -5 | 5 |
| 17 | 1 | 0 | 0 | -10 | 10 |
| 18 | 1 | 1 | 100 | 4.09 | 0 |
