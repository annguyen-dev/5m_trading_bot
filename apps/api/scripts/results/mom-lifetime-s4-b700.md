# Momentum continuation lifetime (BTC)

_Generated 2026-05-27T09:52:31.473Z_ · 365d · 105120 bars

Event = bar at streak=4 with body3 > $700 (the "momentum continuation" regime we'd skip in arm).
Total momentum events: **184** in 365 days.

## Terminal streak — where does momentum exhaust?

After a momentum event at streak=4, at what streak length does the direction finally flip?

| terminal streak | n | % of events |
|---|---|---|
| 4 | 101 | 54.9% |
| 5 | 44 | 23.9% |
| 6 | 21 | 11.4% |
| 7 | 9 | 4.9% |
| 8 | 3 | 1.6% |
| 9 | 3 | 1.6% |
| 10 | 2 | 1.1% |
| 15 | 1 | 0.5% |

## Continuation length distribution (bars after trigger)

How many MORE same-direction bars follow before reversal? (0 = next bar reverses, 1 = +1 more bar, etc.)

| continuation bars after trigger | n | %        | cumulative % |
|---|---|---|---|
| 0 | 101 | 54.9% | 54.9% |
| 1 | 44 | 23.9% | 78.8% |
| 2 | 21 | 11.4% | 90.2% |
| 3 | 9 | 4.9% | 95.1% |
| 4 | 3 | 1.6% | 96.7% |
| 5 | 3 | 1.6% | 98.4% |
| 6 | 2 | 1.1% | 99.5% |
| 11 | 1 | 0.5% | 100.0% |

## Conditional reversal rate — given streak is currently at length L (post-momentum)

Standing at streak length L (started from a momentum event at startStreak),
what is P(next bar reverses)? Use to decide "best streak to fade after momentum."

| streak L | n (bars reaching L) | revs at L | **P(rev next) %** | hit rate vs flat $0.55 |
|---|---|---|---|---|
| 4 | 184 | 101 | **54.9%** | ⚠️ EV $-0.001/sh |
| 5 | 83 | 44 | **53.0%** | ⚠️ EV $-0.020/sh |
| 6 | 39 | 21 | **53.8%** | ⚠️ EV $-0.012/sh |
| 7 | 18 | 9 | **50.0%** | ⚠️ EV $-0.050/sh |
| 8 | 9 | 3 | **33.3%** | ⚠️ EV $-0.217/sh |
| 9 | 6 | 3 | **50.0%** | ⚠️ EV $-0.050/sh |
| 10 | 3 | 2 | **66.7%** | ✅ EV $0.117/sh |
| 11 | 1 | 0 | **0.0%** | ⚠️ EV $-0.550/sh |
| 12 | 1 | 0 | **0.0%** | ⚠️ EV $-0.550/sh |
| 13 | 1 | 0 | **0.0%** | ⚠️ EV $-0.550/sh |
| 14 | 1 | 0 | **0.0%** | ⚠️ EV $-0.550/sh |
| 15 | 1 | 1 | **100.0%** | ✅ EV $0.450/sh |

