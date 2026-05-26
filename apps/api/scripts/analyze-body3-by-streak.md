# Body3 floor by streak — reversal-rate analysis (BTC)

_Generated 2026-05-25T13:41:48.725Z_ · 365d · 105120 bars (365d)

Single-bar fade hit rate: at a closed streak of length L with body3 = sum|body| of
the 3 streak-aligned closing bars, P(next bar closes opposite). No DCA / no arm gating.
Break-even WR at flat $0.55 entry = 55%; real limit entries are lower so true break-even is below that.

## Reversal % by streak × body3 bucket  — `WR% (n)`

| streak \ body3 | 0-100 | 100-200 | 200-300 | 300-400 | 400-500 | 500-700 | 700+ | **all** |
|---|---|---|---|---|---|---|---|---|
| **2** | 49 (5754) | 51 (8876) | 50 (5475) | 51 (3000) | 51 (1512) | 54 (1285) | 54 (799) | **51 (26701)** |
| **3** | 49 (2907) | 52 (4466) | 52 (2735) | 55 (1339) | 53 (675) | 57 (609) | 57 (374) | **52 (13105)** |
| **4** | 50 (1472) | 54 (2132) | 55 (1215) | 55 (643) | 56 (332) | 55 (280) | 55 (185) | **54 (6259)** |
| **5** | 46 (718) | 50 (935) | 48 (571) | 54 (268) | 61 (138) | 59 (148) | 46 (102) | **50 (2880)** |
| **6** | 48 (344) | 55 (462) | 51 (270) | 46 (138) | 57 (75) | 62 (74) | 54 (61) | **52 (1424)** |
| **7** | 50 (155) | 53 (207) | 54 (129) | 63 (71) | 60 (48) | 62 (37) | 52 (33) | **55 (680)** |
| **8** | 56 (71) | 56 (101) | 55 (55) | 53 (17) | 50 (24) | 55 (20) | 37 (19) | **54 (307)** |
| **9** | 45 (29) | 49 (41) | 38 (26) | 54 (13) | 44 (9) | 50 (10) | 62 (13) | **48 (141)** |
| **10+** | 53 (36) | 49 (37) | 50 (24) | 53 (17) | 25 (12) | 37 (19) | 55 (11) | **47 (156)** |

_Cells with n<25 are noise — ignore. Read DOWN a column to see if a fixed body3 band
improves with streak; read ACROSS a row to see body3 dependence at a fixed streak._

## Minimum body3 floor to reach a reversal target (n≥25)

| streak | base WR% (n) | ≥55% needs | ≥58% needs | ≥60% needs |
|---|---|---|---|---|
| **2** | 50.6 (26701) | — | — | — |
| **3** | 52.0 (13105) | ≥$300 → 55% (n=2997) | — | — |
| **4** | 53.7 (6259) | ≥$150 → 55% (n=3620) | — | — |
| **5** | 50.1 (2880) | ≥$300 → 55% (n=656) | — | — |
| **6** | 52.0 (1424) | ≥$350 → 57% (n=270) | ≥$400 → 58% (n=210) | — |
| **7** | 54.7 (680) | ≥$100 → 56% (n=525) | ≥$250 → 58% (n=248) | ≥$300 → 60% (n=189) |
| **8** | 54.1 (307) | — | — | — |
| **9** | 47.5 (141) | — | — | — |
| **10+** | 47.4 (156) | — | — | — |

_"≥$X → Y% (n)" = lowest floor whose body3≥X subset hits the target; "—" = unreachable with n≥25._

