# Backtest — current prod BTC config

_Generated 2026-05-25T10:09:47.742Z_ · source: `/tmp/prod-coin-configs.json (live DB)` (fetched 2026-05-25)

> **WR is the primary signal** (pricing-independent). PnL is directional/relative — flat $0.55 entry, binary settlement (win=$1, lose=$0), **not real PnL**.
>
> `arm_trigger_body3_min` = **100** (live DB value — runtime uses this; it overrides the code PER_COIN_OVERRIDES default).

## Config

| field | value |
|---|---|
| coin | BTC |
| fetched_at | 2026-05-25 |
| source | /tmp/prod-coin-configs.json (live DB) |
| enabled | true |
| strategy | echo |
| mode | signal_and_order |
| size_usdc | 5 |
| limit_price_cents | 69 |
| tp_cents | 95 |
| sl_cents | 10 |
| echo_trigger_streak | 5 |
| echo_window_minutes | 120 |
| echo_signal_min_streak | 3 |
| echo_baseline_streak | 5 |
| echo_require_high_body | false |
| arm_trigger_body3_min | 100 |
| idle_body3_min | 150 |
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

**Total:** 1747 trades · WR **55.5%** · pnl $12.73 · maxDD $517.27

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 211 | 109 | 51.7 | -64.09 | 111.82 |
| idle_dca | 62 | 34 | 54.8 | -1.82 | 120.91 |
| armed_base | 930 | 529 | 56.9 | 159.09 | 77.27 |
| armed_dca | 319 | 164 | 51.4 | -208.18 | 310 |
| edge_base | 161 | 95 | 59 | 58.64 | 55.45 |
| edge_dca | 64 | 39 | 60.9 | 69.09 | 47.27 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 765 | 440 | 57.5 | 175 | 69.55 |
| 4 | 347 | 185 | 53.3 | -96.36 | 255 |
| 5 | 325 | 170 | 52.3 | -76.82 | 161.82 |
| 6 | 169 | 96 | 56.8 | 14.55 | 170.91 |
| 7 | 77 | 48 | 62.3 | 61.36 | 42.73 |
| 8 | 30 | 13 | 43.3 | -39.09 | 75 |
| 9 | 16 | 8 | 50 | -28.18 | 36.82 |
| 10 | 10 | 5 | 50 | -10.45 | 15 |
| 11 | 5 | 3 | 60 | 5.45 | 10 |
| 12 | 2 | 1 | 50 | 3.18 | 5 |
| 13 | 1 | 1 | 100 | 4.09 | 0 |

### 180 days (51840 bars)

**Total:** 3857 trades · WR **55.3%** · pnl $91.82 · maxDD $517.27

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 437 | 237 | 54.2 | -30.45 | 111.82 |
| idle_dca | 139 | 75 | 54 | -26.36 | 120.91 |
| armed_base | 1950 | 1082 | 55.5 | 86.36 | 205.91 |
| armed_dca | 723 | 394 | 54.5 | -66.36 | 310 |
| edge_base | 429 | 243 | 56.6 | 64.09 | 74.09 |
| edge_dca | 179 | 102 | 57 | 64.55 | 114.55 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 1695 | 960 | 56.6 | 252.27 | 153.18 |
| 4 | 812 | 446 | 54.9 | 43.64 | 263.64 |
| 5 | 684 | 366 | 53.5 | -82.73 | 207.73 |
| 6 | 355 | 191 | 53.8 | -65 | 240.91 |
| 7 | 171 | 101 | 59.1 | 46.36 | 80.91 |
| 8 | 71 | 36 | 50.7 | -35.91 | 102.27 |
| 9 | 34 | 15 | 44.1 | -62.27 | 65 |
| 10 | 19 | 10 | 52.6 | -2.73 | 27.73 |
| 11 | 9 | 5 | 55.6 | 2.73 | 10.91 |
| 12 | 3 | 1 | 33.3 | -1.82 | 10 |
| 13 | 2 | 1 | 50 | -5.91 | 10 |
| 14 | 1 | 0 | 0 | -5 | 5 |
| 15 | 1 | 1 | 100 | 8.18 | 0 |

### 365 days (105120 bars)

**Total:** 9408 trades · WR **54.1%** · pnl $-732.73 · maxDD $1301.82

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 1008 | 524 | 52 | -276.36 | 361.82 |
| idle_dca | 331 | 170 | 51.4 | -219.09 | 324.55 |
| armed_base | 4851 | 2609 | 53.8 | -536.82 | 795.91 |
| armed_dca | 1904 | 1055 | 55.4 | 141.82 | 310 |
| edge_base | 925 | 518 | 56 | 84.09 | 92.73 |
| edge_dca | 389 | 218 | 56 | 73.64 | 190 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 4157 | 2259 | 54.3 | -248.64 | 599.55 |
| 4 | 2016 | 1137 | 56.4 | 523.64 | 263.64 |
| 5 | 1619 | 833 | 51.5 | -565.45 | 680.91 |
| 6 | 836 | 448 | 53.6 | -233.64 | 438.18 |
| 7 | 412 | 237 | 57.5 | 107.73 | 122.27 |
| 8 | 182 | 92 | 50.5 | -102.27 | 151.82 |
| 9 | 87 | 42 | 48.3 | -107.27 | 113.64 |
| 10 | 46 | 26 | 56.5 | 10.45 | 27.73 |
| 11 | 20 | 8 | 40 | -35.91 | 48.64 |
| 12 | 11 | 3 | 27.3 | -39.55 | 47.73 |
| 13 | 9 | 4 | 44.4 | -5.45 | 12.73 |
| 14 | 5 | 0 | 0 | -45 | 45 |
| 15 | 5 | 4 | 80 | 15.45 | 5 |
| 16 | 1 | 0 | 0 | -10 | 10 |
| 17 | 1 | 0 | 0 | -5 | 5 |
| 18 | 1 | 1 | 100 | 8.18 | 0 |
