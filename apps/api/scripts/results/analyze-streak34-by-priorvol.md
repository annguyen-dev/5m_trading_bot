# Streak 3/4 edge-fire reversal % by prior 1h vol (BTC)

_Generated 2026-05-26T14:19:53.357Z_ · 365d · 105120 bars (365d) · entries gated by s3≥$440, s4≥$420

Tests the user observation: "after big surges/drops BTC sideways with lots of streak3/4."
Prior 1h vol = sum |body| of the 12 bars BEFORE the 3-bar streak window (i.e., the regime
before this fade setup forms). Compares fade reversal-rate across vol regimes.

## Universe — % of ALL bars in each prior-1h-vol regime

| regime | bars | % of total |
|---|---|---|
| calm <400 | 13629 | 13.0% |
| mid 400-700 | 30914 | 29.4% |
| high 700-1200 | 36078 | 34.3% |
| very-high 1.2-2k | 18561 | 17.7% |
| extreme ≥2k | 5924 | 5.6% |

## Streak=3 edge fires (body3 ≥ $440)

| prior 1h vol | n | reversal WR | avg prior vol |
|---|---|---|---|
| calm <400 | 3 | — (n<5) | — |
| mid 400-700 | 32 | **65.6%** | $611 |
| high 700-1200 | 246 | **58.9%** | $993 |
| very-high 1.2-2k | 590 | **54.7%** | $1552 |
| extreme ≥2k | 464 | **56.0%** | $2839 |
| **all** | 1335 | **56.3%** | $1871 |

## Streak=4 edge fires (body3 ≥ $420)

| prior 1h vol | n | reversal WR | avg prior vol |
|---|---|---|---|
| calm <400 | 6 | **33.3%** | $347 |
| mid 400-700 | 21 | **52.4%** | $585 |
| high 700-1200 | 150 | **60.0%** | $991 |
| very-high 1.2-2k | 323 | **53.3%** | $1551 |
| extreme ≥2k | 224 | **56.3%** | $2847 |
| **all** | 724 | **55.4%** | $1798 |

