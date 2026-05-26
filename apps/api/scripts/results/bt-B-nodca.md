# Backtest — current prod BTC config

_Generated 2026-05-25T13:52:31.944Z_ · source: `/tmp/cfg-tight-nodca.json (live DB)` (fetched 2026-05-25)

> **WR is the primary signal** (pricing-independent). PnL is directional/relative — flat $0.55 entry, binary settlement (win=$1, lose=$0), **not real PnL**.
>
> `arm_trigger_body3_min` = **100** (live DB value — runtime uses this; it overrides the code PER_COIN_OVERRIDES default).

## Config

| field | value |
|---|---|
| coin | BTC |
| fetched_at | 2026-05-25 |
| source | /tmp/cfg-tight-nodca.json (live DB) |
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
| echo_dca_scale | [] |
| echo_dca_scale_idle | [] |
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

**Total:** 423 trades · WR **61.5%** · pnl $248.64 · maxDD $47.73

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 0 | 0 | — | 0 | 0 |
| idle_dca | 0 | 0 | — | 0 | 0 |
| armed_base | 178 | 119 | 66.9 | 191.82 | 38.18 |
| armed_dca | 0 | 0 | — | 0 | 0 |
| edge_base | 245 | 141 | 57.6 | 56.82 | 56.82 |
| edge_dca | 0 | 0 | — | 0 | 0 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 215 | 138 | 64.2 | 179.55 | 22.73 |
| 4 | 111 | 61 | 55 | -0.45 | 45.45 |
| 5 | 10 | 5 | 50 | -4.55 | 10.91 |
| 6 | 45 | 28 | 62.2 | 29.55 | 29.09 |
| 7 | 30 | 23 | 76.7 | 59.09 | 6.82 |
| 8 | 7 | 3 | 42.9 | -7.73 | 20 |
| 9 | 3 | 0 | 0 | -15 | 15 |
| 10 | 2 | 2 | 100 | 8.18 | 0 |

### 180 days (51840 bars)

**Total:** 1222 trades · WR **57.3%** · pnl $253.64 · maxDD $147.27

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 0 | 0 | — | 0 | 0 |
| idle_dca | 0 | 0 | — | 0 | 0 |
| armed_base | 527 | 310 | 58.8 | 183.18 | 106.82 |
| armed_dca | 0 | 0 | — | 0 | 0 |
| edge_base | 695 | 390 | 56.1 | 70.45 | 70.45 |
| edge_dca | 0 | 0 | — | 0 | 0 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 622 | 365 | 58.7 | 208.18 | 99.55 |
| 4 | 335 | 178 | 53.1 | -56.82 | 79.55 |
| 5 | 35 | 19 | 54.3 | -2.27 | 23.64 |
| 6 | 120 | 73 | 60.8 | 63.64 | 29.09 |
| 7 | 64 | 44 | 68.8 | 80 | 23.64 |
| 8 | 23 | 11 | 47.8 | -15 | 35.45 |
| 9 | 10 | 3 | 30 | -22.73 | 22.73 |
| 10 | 7 | 5 | 71.4 | 10.45 | 5 |
| 11 | 2 | 1 | 50 | -0.91 | 5 |
| 12 | 1 | 0 | 0 | -5 | 5 |
| 13 | 1 | 0 | 0 | -5 | 5 |
| 14 | 1 | 0 | 0 | -5 | 5 |
| 15 | 1 | 1 | 100 | 4.09 | 0 |

### 365 days (105120 bars)

**Total:** 2972 trades · WR **56.2%** · pnl $321.82 · maxDD $244.55

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 1 | 0 | 0 | -5 | 5 |
| idle_dca | 0 | 0 | — | 0 | 0 |
| armed_base | 1381 | 783 | 56.7 | 213.18 | 150.91 |
| armed_dca | 0 | 0 | — | 0 | 0 |
| edge_base | 1590 | 887 | 55.8 | 113.64 | 134.55 |
| edge_dca | 0 | 0 | — | 0 | 0 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 1513 | 853 | 56.4 | 189.55 | 163.18 |
| 4 | 788 | 444 | 56.3 | 96.36 | 99.09 |
| 5 | 87 | 48 | 55.2 | 1.36 | 43.64 |
| 6 | 270 | 155 | 57.4 | 59.09 | 63.64 |
| 7 | 157 | 96 | 61.1 | 87.73 | 35.91 |
| 8 | 73 | 35 | 47.9 | -46.82 | 71.36 |
| 9 | 37 | 20 | 54.1 | -3.18 | 35 |
| 10 | 17 | 11 | 64.7 | 15 | 15.91 |
| 11 | 8 | 2 | 25 | -21.82 | 25.91 |
| 12 | 6 | 0 | 0 | -30 | 30 |
| 13 | 7 | 3 | 42.9 | -7.73 | 11.82 |
| 14 | 3 | 0 | 0 | -15 | 15 |
| 15 | 3 | 2 | 66.7 | 3.18 | 5 |
| 16 | 1 | 0 | 0 | -5 | 5 |
| 17 | 1 | 0 | 0 | -5 | 5 |
| 18 | 1 | 1 | 100 | 4.09 | 0 |
