# Backtest — current prod BTC config

_Generated 2026-05-26T07:54:01.501Z_ · source: `/tmp/cfg-tight.json (live DB)` (fetched 2026-05-26)

> **WR is the primary signal** (pricing-independent). PnL is directional/relative — flat $0.55 entry, binary settlement (win=$1, lose=$0), **not real PnL**.
>
> `arm_trigger_body3_min` = **100** (live DB value — runtime uses this; it overrides the code PER_COIN_OVERRIDES default).

## Config

| field | value |
|---|---|
| coin | BTC |
| fetched_at | 2026-05-26 |
| source | /tmp/cfg-tight.json (live DB) |
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
| 7 | 7 | 7 | 120 | 100 |

_streak-strategy fields (`auto_*`, `dca_multiplier`, `dca_streak_whitelist`) do NOT apply to echo and are ignored by the sim._

## Results

### 90 days (25920 bars)

**Total:** 555 trades · WR **60.4%** · pnl $328.64 · maxDD $71.82

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 4 | 1 | 25 | -10.91 | 10.91 |
| idle_dca | 3 | 3 | 100 | 24.55 | 0 |
| armed_base | 82 | 52 | 63.4 | 62.73 | 20.45 |
| armed_dca | 30 | 18 | 60 | 27.27 | 40 |
| edge_base | 317 | 192 | 60.6 | 160.45 | 34.55 |
| edge_dca | 119 | 69 | 58 | 64.55 | 95.45 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 212 | 137 | 64.6 | 185.45 | 22.73 |
| 4 | 128 | 73 | 57 | 45.45 | 72.73 |
| 5 | 31 | 19 | 61.3 | 39.09 | 25 |
| 6 | 45 | 28 | 62.2 | 45.91 | 20.91 |
| 7 | 97 | 58 | 59.8 | 66.36 | 35.91 |
| 8 | 37 | 18 | 48.6 | -31.82 | 61.82 |
| 9 | 3 | 0 | 0 | -30 | 30 |
| 10 | 2 | 2 | 100 | 8.18 | 0 |

### 180 days (51840 bars)

**Total:** 1512 trades · WR **56.6%** · pnl $230 · maxDD $267.27

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 16 | 10 | 62.5 | 10.91 | 15.91 |
| idle_dca | 6 | 4 | 66.7 | 12.73 | 20 |
| armed_base | 206 | 124 | 60.2 | 97.27 | 49.55 |
| armed_dca | 82 | 44 | 53.7 | -20 | 69.09 |
| edge_base | 848 | 478 | 56.4 | 105.45 | 149.09 |
| edge_dca | 354 | 196 | 55.4 | 23.64 | 133.64 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 615 | 359 | 58.4 | 188.64 | 99.55 |
| 4 | 382 | 205 | 53.7 | -63.18 | 168.18 |
| 5 | 89 | 53 | 59.6 | 77.27 | 67.27 |
| 6 | 119 | 72 | 60.5 | 58.18 | 30.91 |
| 7 | 203 | 117 | 57.6 | 89.09 | 37.27 |
| 8 | 80 | 40 | 50 | -49.09 | 120.91 |
| 9 | 11 | 3 | 27.3 | -67.73 | 67.73 |
| 10 | 7 | 5 | 71.4 | 10.45 | 5 |
| 11 | 2 | 1 | 50 | -1.82 | 10 |
| 12 | 1 | 0 | 0 | -5 | 5 |
| 13 | 1 | 0 | 0 | -10 | 10 |
| 14 | 1 | 0 | 0 | -5 | 5 |
| 15 | 1 | 1 | 100 | 8.18 | 0 |

### 365 days (105120 bars)

**Total:** 3658 trades · WR **55.7%** · pnl $210.45 · maxDD $403.64

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 26 | 15 | 57.7 | 6.36 | 15.91 |
| idle_dca | 11 | 7 | 63.6 | 17.27 | 23.64 |
| armed_base | 562 | 315 | 56 | 53.64 | 133.18 |
| armed_dca | 246 | 127 | 51.6 | -150.91 | 199.09 |
| edge_base | 1981 | 1110 | 56 | 185.91 | 165 |
| edge_dca | 832 | 463 | 55.6 | 98.18 | 172.73 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 1502 | 844 | 56.2 | 162.73 | 170.45 |
| 4 | 940 | 529 | 56.3 | 152.27 | 212.27 |
| 5 | 190 | 105 | 55.3 | 26.82 | 113.18 |
| 6 | 266 | 151 | 56.8 | 23.18 | 77.73 |
| 7 | 475 | 267 | 56.2 | 80.45 | 117.27 |
| 8 | 194 | 101 | 52.1 | -65 | 123.18 |
| 9 | 41 | 20 | 48.8 | -59.55 | 97.73 |
| 10 | 17 | 11 | 64.7 | 11.36 | 31.82 |
| 11 | 8 | 2 | 25 | -22.73 | 30.91 |
| 12 | 8 | 1 | 12.5 | -46.82 | 46.82 |
| 13 | 7 | 3 | 42.9 | -13.64 | 17.73 |
| 14 | 4 | 0 | 0 | -30 | 30 |
| 15 | 3 | 2 | 66.7 | 2.27 | 10 |
| 16 | 1 | 0 | 0 | -5 | 5 |
| 17 | 1 | 0 | 0 | -10 | 10 |
| 18 | 1 | 1 | 100 | 4.09 | 0 |
