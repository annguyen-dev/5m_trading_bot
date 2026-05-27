# Backtest — current prod BTC config

_Generated 2026-05-27T08:00:13.482Z_ · source: `/tmp/cfg-armtrig400.json (live DB)` (fetched 2026-05-27)

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

### 90 days (25919 bars)

**Total:** 446 trades · WR **61%** · pnl $311.36 · maxDD $92.27

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 11 | 5 | 45.5 | -9.55 | 15.91 |
| idle_dca | 6 | 5 | 83.3 | 30.91 | 10 |
| armed_base | 10 | 7 | 70 | 13.64 | 6.82 |
| armed_dca | 3 | 2 | 66.7 | 6.36 | 10 |
| edge_base | 306 | 187 | 61.1 | 170 | 45.45 |
| edge_dca | 110 | 66 | 60 | 100 | 81.82 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 194 | 127 | 65.5 | 184.55 | 28.64 |
| 4 | 119 | 66 | 55.5 | 30.45 | 56.36 |
| 5 | 64 | 39 | 60.9 | 64.09 | 35.91 |
| 6 | 25 | 15 | 60 | 27.27 | 33.64 |
| 7 | 30 | 20 | 66.7 | 43.18 | 11.82 |
| 8 | 8 | 3 | 37.5 | -29.55 | 40 |
| 9 | 3 | 0 | 0 | -15 | 15 |
| 10 | 3 | 2 | 66.7 | 6.36 | 10 |

### 180 days (51839 bars)

**Total:** 1330 trades · WR **56.9%** · pnl $305.91 · maxDD $162.27

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 42 | 22 | 52.4 | -10 | 30 |
| idle_dca | 20 | 11 | 55 | 0 | 63.64 |
| armed_base | 25 | 12 | 48 | -15.91 | 42.73 |
| armed_dca | 13 | 9 | 69.2 | 33.64 | 21.82 |
| edge_base | 876 | 502 | 57.3 | 183.64 | 139.09 |
| edge_dca | 354 | 201 | 56.8 | 114.55 | 95.45 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 581 | 338 | 58.2 | 167.73 | 89.55 |
| 4 | 362 | 191 | 52.8 | -61.82 | 143.64 |
| 5 | 186 | 107 | 57.5 | 86.36 | 79.09 |
| 6 | 79 | 49 | 62 | 78.18 | 51.36 |
| 7 | 77 | 52 | 67.5 | 87.27 | 27.73 |
| 8 | 23 | 12 | 52.2 | -14.09 | 48.18 |
| 9 | 9 | 2 | 22.2 | -36.82 | 36.82 |
| 10 | 7 | 4 | 57.1 | 12.73 | 10 |
| 11 | 2 | 1 | 50 | -1.82 | 10 |
| 12 | 1 | 0 | 0 | -5 | 5 |
| 13 | 1 | 0 | 0 | -10 | 10 |
| 14 | 1 | 0 | 0 | -5 | 5 |
| 15 | 1 | 1 | 100 | 8.18 | 0 |

### 365 days (105119 bars)

**Total:** 3238 trades · WR **55.9%** · pnl $424.09 · maxDD $318.64

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 84 | 42 | 50 | -38.18 | 62.73 |
| idle_dca | 42 | 24 | 57.1 | 16.36 | 63.64 |
| armed_base | 125 | 64 | 51.2 | -43.18 | 71.82 |
| armed_dca | 61 | 39 | 63.9 | 99.09 | 55.45 |
| edge_base | 2070 | 1161 | 56.1 | 204.55 | 152.27 |
| edge_dca | 856 | 481 | 56.2 | 185.45 | 160 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 1417 | 792 | 55.9 | 115 | 172.73 |
| 4 | 892 | 500 | 56.1 | 161.36 | 183.64 |
| 5 | 421 | 232 | 55.1 | 44.55 | 104.09 |
| 6 | 176 | 102 | 58 | 74.55 | 60.91 |
| 7 | 190 | 114 | 60 | 98.64 | 52.73 |
| 8 | 75 | 38 | 50.7 | -53.64 | 88.64 |
| 9 | 30 | 16 | 53.3 | -7.27 | 41.82 |
| 10 | 15 | 9 | 60 | 33.64 | 20 |
| 11 | 7 | 2 | 28.6 | -18.64 | 26.82 |
| 12 | 5 | 1 | 20 | -21.82 | 21.82 |
| 13 | 4 | 3 | 75 | 6.36 | 10 |
| 14 | 2 | 0 | 0 | -10 | 10 |
| 15 | 2 | 1 | 50 | -1.82 | 10 |
| 17 | 1 | 0 | 0 | -5 | 5 |
| 18 | 1 | 1 | 100 | 8.18 | 0 |
