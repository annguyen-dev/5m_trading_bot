# Backtest — current prod BTC config

_Generated 2026-05-26T07:56:43.498Z_ · source: `/tmp/cfg-B-s5_400-s7_300.json (live DB)` (fetched 2026-05-26)

> **WR is the primary signal** (pricing-independent). PnL is directional/relative — flat $0.55 entry, binary settlement (win=$1, lose=$0), **not real PnL**.
>
> `arm_trigger_body3_min` = **100** (live DB value — runtime uses this; it overrides the code PER_COIN_OVERRIDES default).

## Config

| field | value |
|---|---|
| coin | BTC |
| fetched_at | 2026-05-26 |
| source | /tmp/cfg-B-s5_400-s7_300.json (live DB) |
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

**Total:** 495 trades · WR **61.8%** · pnl $401.36 · maxDD $61.82

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 4 | 1 | 25 | -10.91 | 10.91 |
| idle_dca | 3 | 3 | 100 | 24.55 | 0 |
| armed_base | 65 | 40 | 61.5 | 38.64 | 17.73 |
| armed_dca | 25 | 17 | 68 | 59.09 | 30 |
| edge_base | 294 | 182 | 61.9 | 184.55 | 40.91 |
| edge_dca | 104 | 63 | 60.6 | 105.45 | 81.82 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 212 | 137 | 64.6 | 185.45 | 22.73 |
| 4 | 129 | 74 | 57.4 | 49.55 | 72.73 |
| 5 | 64 | 38 | 59.4 | 46.82 | 45.91 |
| 6 | 45 | 28 | 62.2 | 58.64 | 30 |
| 7 | 33 | 24 | 72.7 | 79.09 | 15 |
| 8 | 7 | 3 | 42.9 | -14.55 | 35 |
| 9 | 3 | 0 | 0 | -20 | 20 |
| 10 | 2 | 2 | 100 | 16.36 | 0 |

### 180 days (51840 bars)

**Total:** 1428 trades · WR **57.6%** · pnl $440.45 · maxDD $169.55

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 16 | 10 | 62.5 | 10.91 | 15.91 |
| idle_dca | 6 | 4 | 66.7 | 12.73 | 20 |
| armed_base | 148 | 85 | 57.4 | 32.73 | 69.55 |
| armed_dca | 63 | 40 | 63.5 | 97.27 | 55.45 |
| edge_base | 851 | 488 | 57.3 | 181.36 | 160 |
| edge_dca | 344 | 195 | 56.7 | 105.45 | 103.64 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 615 | 359 | 58.4 | 188.64 | 99.55 |
| 4 | 383 | 206 | 53.8 | -59.09 | 168.18 |
| 5 | 185 | 108 | 58.4 | 97.27 | 75.91 |
| 6 | 118 | 72 | 61 | 106.36 | 35.91 |
| 7 | 78 | 54 | 69.2 | 146.82 | 28.64 |
| 8 | 25 | 13 | 52 | -9.09 | 44.09 |
| 9 | 11 | 3 | 27.3 | -43.64 | 43.64 |
| 10 | 7 | 5 | 71.4 | 26.82 | 5 |
| 11 | 2 | 1 | 50 | -1.82 | 10 |
| 12 | 1 | 0 | 0 | -5 | 5 |
| 13 | 1 | 0 | 0 | -10 | 10 |
| 14 | 1 | 0 | 0 | -5 | 5 |
| 15 | 1 | 1 | 100 | 8.18 | 0 |

### 365 days (105120 bars)

**Total:** 3501 trades · WR **56.1%** · pnl $449.09 · maxDD $439.55

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 26 | 15 | 57.7 | 6.36 | 15.91 |
| idle_dca | 11 | 7 | 63.6 | 17.27 | 23.64 |
| armed_base | 412 | 230 | 55.8 | 30.91 | 81.82 |
| armed_dca | 182 | 102 | 56 | 34.55 | 170 |
| edge_base | 2032 | 1143 | 56.3 | 230.91 | 160 |
| edge_dca | 838 | 468 | 55.8 | 129.09 | 174.55 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 1501 | 844 | 56.2 | 167.73 | 165.45 |
| 4 | 941 | 530 | 56.3 | 156.36 | 212.27 |
| 5 | 428 | 238 | 55.6 | 45.91 | 115.91 |
| 6 | 262 | 151 | 57.6 | 99.09 | 95.91 |
| 7 | 196 | 119 | 60.7 | 142.27 | 67.73 |
| 8 | 82 | 42 | 51.2 | -51.82 | 96.82 |
| 9 | 40 | 21 | 52.5 | -15.45 | 48.64 |
| 10 | 17 | 11 | 64.7 | 36.82 | 30 |
| 11 | 9 | 2 | 22.2 | -32.73 | 40.91 |
| 12 | 8 | 1 | 12.5 | -46.82 | 46.82 |
| 13 | 7 | 3 | 42.9 | -13.64 | 17.73 |
| 14 | 4 | 0 | 0 | -30 | 30 |
| 15 | 3 | 2 | 66.7 | 2.27 | 10 |
| 16 | 1 | 0 | 0 | -5 | 5 |
| 17 | 1 | 0 | 0 | -10 | 10 |
| 18 | 1 | 1 | 100 | 4.09 | 0 |
