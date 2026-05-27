# Momentum continuation lifetime (BTC)

_Generated 2026-05-27T09:50:48.933Z_ · 365d · 105120 bars

Event = bar at streak=3 with body3 > $500 (the "momentum continuation" regime we'd skip in arm).
Total momentum events: **982** in 365 days.

## Terminal streak — where does momentum exhaust?

After a momentum event at streak=3, at what streak length does the direction finally flip?

| terminal streak | n | % of events |
|---|---|---|
| 3 | 564 | 57.4% |
| 4 | 231 | 23.5% |
| 5 | 100 | 10.2% |
| 6 | 50 | 5.1% |
| 7 | 18 | 1.8% |
| 8 | 7 | 0.7% |
| 9 | 6 | 0.6% |
| 10 | 3 | 0.3% |
| 11 | 2 | 0.2% |
| 15 | 1 | 0.1% |

## Continuation length distribution (bars after trigger)

How many MORE same-direction bars follow before reversal? (0 = next bar reverses, 1 = +1 more bar, etc.)

| continuation bars after trigger | n | %        | cumulative % |
|---|---|---|---|
| 0 | 564 | 57.4% | 57.4% |
| 1 | 231 | 23.5% | 81.0% |
| 2 | 100 | 10.2% | 91.1% |
| 3 | 50 | 5.1% | 96.2% |
| 4 | 18 | 1.8% | 98.1% |
| 5 | 7 | 0.7% | 98.8% |
| 6 | 6 | 0.6% | 99.4% |
| 7 | 3 | 0.3% | 99.7% |
| 8 | 2 | 0.2% | 99.9% |
| 12 | 1 | 0.1% | 100.0% |

## Conditional reversal rate — given streak is currently at length L (post-momentum)

Standing at streak length L (started from a momentum event at startStreak),
what is P(next bar reverses)? Use to decide "best streak to fade after momentum."

| streak L | n (bars reaching L) | revs at L | **P(rev next) %** | hit rate vs flat $0.55 |
|---|---|---|---|---|
| 3 | 982 | 564 | **57.4%** | ✅ EV $0.024/sh |
| 4 | 418 | 231 | **55.3%** | ✅ EV $0.003/sh |
| 5 | 187 | 100 | **53.5%** | ⚠️ EV $-0.015/sh |
| 6 | 87 | 50 | **57.5%** | ✅ EV $0.025/sh |
| 7 | 37 | 18 | **48.6%** | ⚠️ EV $-0.064/sh |
| 8 | 19 | 7 | **36.8%** | ⚠️ EV $-0.182/sh |
| 9 | 12 | 6 | **50.0%** | ⚠️ EV $-0.050/sh |
| 10 | 6 | 3 | **50.0%** | ⚠️ EV $-0.050/sh |
| 11 | 3 | 2 | **66.7%** | ✅ EV $0.117/sh |
| 12 | 1 | 0 | **0.0%** | ⚠️ EV $-0.550/sh |
| 13 | 1 | 0 | **0.0%** | ⚠️ EV $-0.550/sh |
| 14 | 1 | 0 | **0.0%** | ⚠️ EV $-0.550/sh |
| 15 | 1 | 1 | **100.0%** | ✅ EV $0.450/sh |

