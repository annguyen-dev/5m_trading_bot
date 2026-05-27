# Backtest — current prod BTC config

_Generated 2026-05-27T07:58:46.683Z_ · source: `/tmp/cfg-armtrig100.json (live DB)` (fetched 2026-05-27)

> **WR is the primary signal** (pricing-independent). PnL is directional/relative — flat $0.55 entry, binary settlement (win=$1, lose=$0), **not real PnL**.
>
> `arm_trigger_body3_min` = **100** (live DB value — runtime uses this; it overrides the code PER_COIN_OVERRIDES default).

## Config

| field | value |
|---|---|
| coin | BTC |
| fetched_at | 2026-05-27 |
| source | /tmp/cfg-armtrig100.json (live DB) |
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
| arm_trigger_body3_min | 100 |
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

**Total:** 550 trades · WR **60.4%** · pnl $332.27 · maxDD $78.64

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 2 | 0 | 0 | -10 | 10 |
| idle_dca | 2 | 2 | 100 | 16.36 | 0 |
| armed_base | 104 | 60 | 57.7 | 25.45 | 36.82 |
| armed_dca | 44 | 24 | 54.5 | -3.64 | 55.45 |
| edge_base | 295 | 183 | 62 | 188.64 | 30.91 |
| edge_dca | 103 | 63 | 61.2 | 115.45 | 75.45 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 237 | 151 | 63.7 | 187.73 | 27.73 |
| 4 | 151 | 84 | 55.6 | 11.82 | 77.27 |
| 5 | 72 | 43 | 59.7 | 63.64 | 47.73 |
| 6 | 46 | 28 | 60.9 | 48.64 | 31.36 |
| 7 | 31 | 21 | 67.7 | 52.73 | 16.82 |
| 8 | 8 | 3 | 37.5 | -19.55 | 30 |
| 9 | 3 | 0 | 0 | -25 | 25 |
| 10 | 2 | 2 | 100 | 12.27 | 0 |

### 180 days (51840 bars)

**Total:** 1579 trades · WR **57.3%** · pnl $415 · maxDD $160

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 15 | 8 | 53.3 | -2.27 | 15 |
| idle_dca | 7 | 5 | 71.4 | 20.91 | 20 |
| armed_base | 255 | 143 | 56.1 | 25 | 64.55 |
| armed_dca | 111 | 65 | 58.6 | 71.82 | 55.45 |
| edge_base | 851 | 491 | 57.7 | 208.64 | 143.18 |
| edge_dca | 340 | 192 | 56.5 | 90.91 | 108.18 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 698 | 406 | 58.2 | 200.91 | 104.09 |
| 4 | 424 | 230 | 54.2 | -30 | 131.36 |
| 5 | 204 | 116 | 56.9 | 78.18 | 85 |
| 6 | 124 | 75 | 60.5 | 95 | 45.91 |
| 7 | 79 | 54 | 68.4 | 124.55 | 28.64 |
| 8 | 26 | 13 | 50 | -14.09 | 39.09 |
| 9 | 11 | 3 | 27.3 | -48.64 | 48.64 |
| 10 | 7 | 5 | 71.4 | 22.73 | 5 |
| 11 | 2 | 1 | 50 | -1.82 | 10 |
| 12 | 1 | 0 | 0 | -5 | 5 |
| 13 | 1 | 0 | 0 | -10 | 10 |
| 14 | 1 | 0 | 0 | -5 | 5 |
| 15 | 1 | 1 | 100 | 8.18 | 0 |

### 365 days (105120 bars)

**Total:** 3934 trades · WR **55.7%** · pnl $343.64 · maxDD $627.27

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 25 | 12 | 48 | -15.91 | 32.73 |
| idle_dca | 13 | 9 | 69.2 | 33.64 | 21.82 |
| armed_base | 730 | 397 | 54.4 | -40.91 | 153.64 |
| armed_dca | 330 | 181 | 54.8 | -9.09 | 299.09 |
| edge_base | 2009 | 1132 | 56.3 | 245.91 | 148.18 |
| edge_dca | 827 | 462 | 55.9 | 130 | 175.45 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 1747 | 969 | 55.5 | 74.09 | 252.73 |
| 4 | 1076 | 611 | 56.8 | 264.09 | 171.36 |
| 5 | 465 | 254 | 54.6 | 11.82 | 150.91 |
| 6 | 275 | 157 | 57.1 | 67.27 | 106.36 |
| 7 | 198 | 119 | 60.1 | 101.82 | 73.18 |
| 8 | 82 | 42 | 51.2 | -51.82 | 91.82 |
| 9 | 40 | 21 | 52.5 | -24.55 | 54.55 |
| 10 | 17 | 11 | 64.7 | 32.73 | 30 |
| 11 | 9 | 2 | 22.2 | -32.73 | 40.91 |
| 12 | 8 | 1 | 12.5 | -46.82 | 46.82 |
| 13 | 7 | 3 | 42.9 | -13.64 | 17.73 |
| 14 | 4 | 0 | 0 | -30 | 30 |
| 15 | 3 | 2 | 66.7 | 2.27 | 10 |
| 16 | 1 | 0 | 0 | -5 | 5 |
| 17 | 1 | 0 | 0 | -10 | 10 |
| 18 | 1 | 1 | 100 | 4.09 | 0 |
