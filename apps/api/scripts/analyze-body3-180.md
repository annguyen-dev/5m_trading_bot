# Body3 floor by streak — reversal-rate analysis (BTC)

_Generated 2026-05-25T13:43:56.497Z_ · 180d · 51840 bars (180d)

Single-bar fade hit rate: at a closed streak of length L with body3 = sum|body| of
the 3 streak-aligned closing bars, P(next bar closes opposite). No DCA / no arm gating.
Break-even WR at flat $0.55 entry = 55%; real limit entries are lower so true break-even is below that.

## Reversal % by streak × body3 bucket  — `WR% (n)`

| streak \ body3 | 0-100 | 100-200 | 200-300 | 300-400 | 400-500 | 500-700 | 700+ | **all** |
|---|---|---|---|---|---|---|---|---|
| **2** | 48 (3443) | 51 (4588) | 51 (2405) | 52 (1186) | 49 (622) | 53 (530) | 55 (336) | **50 (13110)** |
| **3** | 50 (1765) | 53 (2261) | 55 (1207) | 58 (531) | 60 (283) | 59 (240) | 55 (178) | **54 (6465)** |
| **4** | 52 (893) | 55 (988) | 55 (504) | 55 (245) | 57 (124) | 50 (117) | 49 (95) | **54 (2966)** |
| **5** | 47 (418) | 51 (435) | 50 (232) | 50 (114) | 67 (49) | 62 (69) | 46 (52) | **51 (1369)** |
| **6** | 47 (202) | 51 (206) | 51 (115) | 49 (57) | 47 (30) | 76 (33) | 55 (31) | **51 (674)** |
| **7** | 52 (94) | 52 (109) | 53 (51) | 76 (25) | 73 (22) | 59 (17) | 62 (13) | **56 (331)** |
| **8** | 62 (45) | 58 (50) | 50 (26) | 67 (3) | 33 (9) | 83 (6) | 20 (5) | **56 (144)** |
| **9** | 60 (15) | 46 (24) | 40 (10) | 67 (6) | 50 (2) | 0 (2) | 25 (4) | **48 (63)** |
| **10+** | 50 (24) | 42 (19) | 56 (9) | 40 (5) | 100 (1) | 25 (4) | 57 (7) | **48 (69)** |

_Cells with n<25 are noise — ignore. Read DOWN a column to see if a fixed body3 band
improves with streak; read ACROSS a row to see body3 dependence at a fixed streak._

## Minimum body3 floor to reach a reversal target (n≥25)

| streak | base WR% (n) | ≥55% needs | ≥58% needs | ≥60% needs |
|---|---|---|---|---|
| **2** | 50.4 (13110) | ≥$800 → 57% (n=217) | — | — |
| **3** | 53.9 (6465) | ≥$100 → 55% (n=4700) | ≥$300 → 58% (n=1232) | — |
| **4** | 53.6 (2966) | — | — | — |
| **5** | 50.5 (1369) | ≥$300 → 55% (n=284) | ≥$400 → 59% (n=170) | — |
| **6** | 50.7 (674) | ≥$300 → 56% (n=151) | ≥$350 → 61% (n=120) | ≥$350 → 61% (n=120) |
| **7** | 56.2 (331) | ≥$0 → 56% (n=331) | ≥$150 → 59% (n=171) | ≥$200 → 63% (n=128) |
| **8** | 56.3 (144) | ≥$0 → 56% (n=144) | — | — |
| **9** | 47.6 (63) | — | — | — |
| **10+** | 47.8 (69) | — | — | — |

_"≥$X → Y% (n)" = lowest floor whose body3≥X subset hits the target; "—" = unreachable with n≥25._

