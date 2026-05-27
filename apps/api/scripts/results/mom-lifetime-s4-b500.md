# Momentum continuation lifetime (BTC)

_Generated 2026-05-27T09:52:07.770Z_ · 365d · 105120 bars

Event = bar at streak=4 with body3 > $500 (the "momentum continuation" regime we'd skip in arm).
Total momentum events: **464** in 365 days.

## Terminal streak — where does momentum exhaust?

After a momentum event at streak=4, at what streak length does the direction finally flip?

| terminal streak | n | % of events |
|---|---|---|
| 4 | 255 | 55.0% |
| 5 | 114 | 24.6% |
| 6 | 53 | 11.4% |
| 7 | 22 | 4.7% |
| 8 | 8 | 1.7% |
| 9 | 6 | 1.3% |
| 10 | 5 | 1.1% |
| 15 | 1 | 0.2% |

## Continuation length distribution (bars after trigger)

How many MORE same-direction bars follow before reversal? (0 = next bar reverses, 1 = +1 more bar, etc.)

| continuation bars after trigger | n | %        | cumulative % |
|---|---|---|---|
| 0 | 255 | 55.0% | 55.0% |
| 1 | 114 | 24.6% | 79.5% |
| 2 | 53 | 11.4% | 90.9% |
| 3 | 22 | 4.7% | 95.7% |
| 4 | 8 | 1.7% | 97.4% |
| 5 | 6 | 1.3% | 98.7% |
| 6 | 5 | 1.1% | 99.8% |
| 11 | 1 | 0.2% | 100.0% |

## Conditional reversal rate — given streak is currently at length L (post-momentum)

Standing at streak length L (started from a momentum event at startStreak),
what is P(next bar reverses)? Use to decide "best streak to fade after momentum."

| streak L | n (bars reaching L) | revs at L | **P(rev next) %** | hit rate vs flat $0.55 |
|---|---|---|---|---|
| 4 | 464 | 255 | **55.0%** | ⚠️ EV $-0.000/sh |
| 5 | 209 | 114 | **54.5%** | ⚠️ EV $-0.005/sh |
| 6 | 95 | 53 | **55.8%** | ✅ EV $0.008/sh |
| 7 | 42 | 22 | **52.4%** | ⚠️ EV $-0.026/sh |
| 8 | 20 | 8 | **40.0%** | ⚠️ EV $-0.150/sh |
| 9 | 12 | 6 | **50.0%** | ⚠️ EV $-0.050/sh |
| 10 | 6 | 5 | **83.3%** | ✅ EV $0.283/sh |
| 11 | 1 | 0 | **0.0%** | ⚠️ EV $-0.550/sh |
| 12 | 1 | 0 | **0.0%** | ⚠️ EV $-0.550/sh |
| 13 | 1 | 0 | **0.0%** | ⚠️ EV $-0.550/sh |
| 14 | 1 | 0 | **0.0%** | ⚠️ EV $-0.550/sh |
| 15 | 1 | 1 | **100.0%** | ✅ EV $0.450/sh |

