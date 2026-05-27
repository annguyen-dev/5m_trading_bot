# Momentum continuation lifetime (BTC)

_Generated 2026-05-27T09:51:44.810Z_ · 365d · 105120 bars

Event = bar at streak=3 with body3 > $900 (the "momentum continuation" regime we'd skip in arm).
Total momentum events: **175** in 365 days.

## Terminal streak — where does momentum exhaust?

After a momentum event at streak=3, at what streak length does the direction finally flip?

| terminal streak | n | % of events |
|---|---|---|
| 3 | 96 | 54.9% |
| 4 | 42 | 24.0% |
| 5 | 24 | 13.7% |
| 6 | 9 | 5.1% |
| 7 | 2 | 1.1% |
| 9 | 1 | 0.6% |
| 10 | 1 | 0.6% |

## Continuation length distribution (bars after trigger)

How many MORE same-direction bars follow before reversal? (0 = next bar reverses, 1 = +1 more bar, etc.)

| continuation bars after trigger | n | %        | cumulative % |
|---|---|---|---|
| 0 | 96 | 54.9% | 54.9% |
| 1 | 42 | 24.0% | 78.9% |
| 2 | 24 | 13.7% | 92.6% |
| 3 | 9 | 5.1% | 97.7% |
| 4 | 2 | 1.1% | 98.9% |
| 6 | 1 | 0.6% | 99.4% |
| 7 | 1 | 0.6% | 100.0% |

## Conditional reversal rate — given streak is currently at length L (post-momentum)

Standing at streak length L (started from a momentum event at startStreak),
what is P(next bar reverses)? Use to decide "best streak to fade after momentum."

| streak L | n (bars reaching L) | revs at L | **P(rev next) %** | hit rate vs flat $0.55 |
|---|---|---|---|---|
| 3 | 175 | 96 | **54.9%** | ⚠️ EV $-0.001/sh |
| 4 | 79 | 42 | **53.2%** | ⚠️ EV $-0.018/sh |
| 5 | 37 | 24 | **64.9%** | ✅ EV $0.099/sh |
| 6 | 13 | 9 | **69.2%** | ✅ EV $0.142/sh |
| 7 | 4 | 2 | **50.0%** | ⚠️ EV $-0.050/sh |
| 8 | 2 | 0 | **0.0%** | ⚠️ EV $-0.550/sh |
| 9 | 2 | 1 | **50.0%** | ⚠️ EV $-0.050/sh |
| 10 | 1 | 1 | **100.0%** | ✅ EV $0.450/sh |

