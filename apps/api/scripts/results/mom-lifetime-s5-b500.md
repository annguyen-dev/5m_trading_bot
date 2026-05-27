# Momentum continuation lifetime (BTC)

_Generated 2026-05-27T08:11:59.641Z_ · 365d · 105120 bars

Event = bar at streak=5 with body3 > $500 (the "momentum continuation" regime we'd skip in arm).
Total momentum events: **250** in 365 days.

## Terminal streak — where does momentum exhaust?

After a momentum event at streak=5, at what streak length does the direction finally flip?

| terminal streak | n | % of events |
|---|---|---|
| 5 | 134 | 53.6% |
| 6 | 59 | 23.6% |
| 7 | 33 | 13.2% |
| 8 | 11 | 4.4% |
| 9 | 8 | 3.2% |
| 10 | 4 | 1.6% |
| 15 | 1 | 0.4% |

## Continuation length distribution (bars after trigger)

How many MORE same-direction bars follow before reversal? (0 = next bar reverses, 1 = +1 more bar, etc.)

| continuation bars after trigger | n | %        | cumulative % |
|---|---|---|---|
| 0 | 134 | 53.6% | 53.6% |
| 1 | 59 | 23.6% | 77.2% |
| 2 | 33 | 13.2% | 90.4% |
| 3 | 11 | 4.4% | 94.8% |
| 4 | 8 | 3.2% | 98.0% |
| 5 | 4 | 1.6% | 99.6% |
| 10 | 1 | 0.4% | 100.0% |

## Conditional reversal rate — given streak is currently at length L (post-momentum)

Standing at streak length L (started from a momentum event at startStreak),
what is P(next bar reverses)? Use to decide "best streak to fade after momentum."

| streak L | n (bars reaching L) | revs at L | **P(rev next) %** | hit rate vs flat $0.55 |
|---|---|---|---|---|
| 5 | 250 | 134 | **53.6%** | ⚠️ EV $-0.014/sh |
| 6 | 116 | 59 | **50.9%** | ⚠️ EV $-0.041/sh |
| 7 | 57 | 33 | **57.9%** | ✅ EV $0.029/sh |
| 8 | 24 | 11 | **45.8%** | ⚠️ EV $-0.092/sh |
| 9 | 13 | 8 | **61.5%** | ✅ EV $0.065/sh |
| 10 | 5 | 4 | **80.0%** | ✅ EV $0.250/sh |
| 11 | 1 | 0 | **0.0%** | ⚠️ EV $-0.550/sh |
| 12 | 1 | 0 | **0.0%** | ⚠️ EV $-0.550/sh |
| 13 | 1 | 0 | **0.0%** | ⚠️ EV $-0.550/sh |
| 14 | 1 | 0 | **0.0%** | ⚠️ EV $-0.550/sh |
| 15 | 1 | 1 | **100.0%** | ✅ EV $0.450/sh |

