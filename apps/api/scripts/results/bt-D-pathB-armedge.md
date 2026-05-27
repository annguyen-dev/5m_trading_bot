# Backtest — current prod BTC config

_Generated 2026-05-26T14:15:25.431Z_ · source: `/tmp/cfg-dca-a250-i200.json (live DB)` (fetched 2026-05-26)

> **WR is the primary signal** (pricing-independent). PnL is directional/relative — flat $0.55 entry, binary settlement (win=$1, lose=$0), **not real PnL**.
>
> `arm_trigger_body3_min` = **100** (live DB value — runtime uses this; it overrides the code PER_COIN_OVERRIDES default).

## Config

| field | value |
|---|---|
| coin | BTC |
| fetched_at | 2026-05-26 |
| source | /tmp/cfg-dca-a250-i200.json (live DB) |
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
| dca_body3_min_armed | 250 |
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

**Total:** 601 trades · WR **59.7%** · pnl $319.09 · maxDD $104.09

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 1 | 0 | 0 | -5 | 5 |
| idle_dca | 1 | 1 | 100 | 8.18 | 0 |
| armed_base | 154 | 86 | 55.8 | 11.82 | 43.64 |
| armed_dca | 56 | 32 | 57.1 | 21.82 | 68.18 |
| edge_base | 289 | 180 | 62.3 | 191.36 | 35 |
| edge_dca | 100 | 60 | 60 | 90.91 | 75.45 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 277 | 175 | 63.2 | 205.91 | 33.64 |
| 4 | 156 | 88 | 56.4 | 46.82 | 69.09 |
| 5 | 76 | 41 | 53.9 | 3.18 | 80.91 |
| 6 | 47 | 28 | 59.6 | 42.73 | 31.36 |
| 7 | 32 | 22 | 68.8 | 52.73 | 16.82 |
| 8 | 8 | 3 | 37.5 | -19.55 | 30 |
| 9 | 3 | 0 | 0 | -25 | 25 |
| 10 | 2 | 2 | 100 | 12.27 | 0 |

### 180 days (51839 bars)

**Total:** 1716 trades · WR **56.7%** · pnl $375 · maxDD $171.36

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 1 | 0 | 0 | -5 | 5 |
| idle_dca | 1 | 1 | 100 | 8.18 | 0 |
| armed_base | 394 | 214 | 54.3 | -24.55 | 110.91 |
| armed_dca | 155 | 93 | 60 | 140.91 | 83.64 |
| edge_base | 832 | 478 | 57.5 | 185.45 | 156.36 |
| edge_dca | 333 | 187 | 56.2 | 70 | 106.36 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 798 | 464 | 58.1 | 228.18 | 99.55 |
| 4 | 451 | 242 | 53.7 | -41.36 | 127.73 |
| 5 | 217 | 118 | 54.4 | 21.36 | 119.09 |
| 6 | 123 | 74 | 60.2 | 108.18 | 45.91 |
| 7 | 77 | 52 | 67.5 | 112.27 | 28.64 |
| 8 | 26 | 13 | 50 | -14.09 | 39.09 |
| 9 | 11 | 3 | 27.3 | -48.64 | 48.64 |
| 10 | 7 | 5 | 71.4 | 22.73 | 5 |
| 11 | 2 | 1 | 50 | -1.82 | 10 |
| 12 | 1 | 0 | 0 | -5 | 5 |
| 13 | 1 | 0 | 0 | -10 | 10 |
| 14 | 1 | 0 | 0 | -5 | 5 |
| 15 | 1 | 1 | 100 | 8.18 | 0 |

### 365 days (105119 bars)

**Total:** 4241 trades · WR **55.5%** · pnl $244.55 · maxDD $555.91

**By mode:**

| mode | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| idle_base | 1 | 0 | 0 | -5 | 5 |
| idle_dca | 1 | 1 | 100 | 8.18 | 0 |
| armed_base | 1032 | 555 | 53.8 | -114.55 | 194.09 |
| armed_dca | 402 | 224 | 55.7 | 52.73 | 226.36 |
| edge_base | 1987 | 1118 | 56.3 | 228.64 | 168.64 |
| edge_dca | 818 | 454 | 55.5 | 74.55 | 204.55 |

**By entry streak:**

| streak | trades | wins | WR% | pnl$ | maxDD$ |
|---|---|---|---|---|---|
| 3 | 1960 | 1090 | 55.6 | 109.09 | 252.73 |
| 4 | 1130 | 632 | 55.9 | 170.91 | 164.09 |
| 5 | 505 | 274 | 54.3 | 8.18 | 130.91 |
| 6 | 281 | 158 | 56.2 | 19.55 | 140.91 |
| 7 | 192 | 115 | 59.9 | 99.09 | 70.45 |
| 8 | 84 | 42 | 50 | -62.73 | 97.73 |
| 9 | 39 | 21 | 53.8 | -10.45 | 53.64 |
| 10 | 17 | 11 | 64.7 | 32.73 | 30 |
| 11 | 8 | 2 | 25 | -22.73 | 30.91 |
| 12 | 8 | 1 | 12.5 | -46.82 | 46.82 |
| 13 | 7 | 3 | 42.9 | -13.64 | 17.73 |
| 14 | 4 | 0 | 0 | -30 | 30 |
| 15 | 3 | 2 | 66.7 | 2.27 | 10 |
| 16 | 1 | 0 | 0 | -5 | 5 |
| 17 | 1 | 0 | 0 | -10 | 10 |
| 18 | 1 | 1 | 100 | 4.09 | 0 |
