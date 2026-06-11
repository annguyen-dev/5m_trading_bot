# Echo Hunt — Edge Cases & Fade Filters

> Tài liệu institutional memory cho các **edge case** (luật fade) của chiến lược Echo Hunt.
> Mỗi edge = một bộ điều kiện (streak + filter) đã được backtest + OOS-validate để fade có lời.
> Code: `matchEchoEdgeCase` trong [`PriceMonitoringWorker.ts`](apps/workers/src/PriceMonitoringWorker.ts) · Type: `EchoEdgeCase` trong [`CoinConfig.ts`](packages/core/src/CoinConfig.ts).
> Thiết kế chiến lược tổng: [`PLAN_POLYMARKET_SIGNAL.md`](PLAN_POLYMARKET_SIGNAL.md).

---

## TL;DR — config đang LIVE

| Coin | Edges (đang chạy) | Account |
|---|---|---|
| **BTC 5m** | s3 ratio≥1.2 · s6 ratio≥1.0 · s7 ratio≥1.0 · **s3 mom≥0.38%** · **s4 prior≥5/30m** | POLY_1271, chung |
| **BTC 1h** | s3 ratio≥0.8 · s4 ratio≥1.0 · **s2 cum≥0.90%** · **s4 cum≥1.85%** (streak_min=2) | (chung) |

Mọi edge: `baseline=99` (chỉ edge fire), entry cap $0.55, no DCA, kill-switch bật.
Đường fire theo streak-count (`auto_order_min_streak`) + arm mode **tắt** (sentinel 99) — xem [§ Arm mode](#arm-mode).

---

## Edge hoạt động thế nào — các gate

`matchEchoEdgeCase` chạy **vô điều kiện** (universal-edge semantics, từ 2026-05-26). Một edge match khi TẤT CẢ pass:

1. **Streak range**: `streakMin ≤ effectiveStreak ≤ streakMax`
   `effectiveStreak` = streak đã đóng + nến in-progress đang cùng chiều tại T-3s (streak đang bị fade).
2. **Body gate** (1 trong 2):
   - **Ratio gate** (ưu tiên): `body3 / (avgBody × 3) ≥ body3OverAvgMin`. Regime-relative — tự thích nghi volatility. `avgBody` = mean |close-open| 48 bar (4h@5m). **Đây là filter mạnh nhất.**
   - **Dollar gate** (fallback): `body3Min ≤ body3 ≤ body3Max` (USD). Decay theo regime → kém hơn ratio.
3. **Extended conditions** (LIVE, ANDed): **clustering** (≥`priorCountMin` streak-peak cùng chiều ≥`priorStreakMin` trong `priorWindowMin` phút) + **magnitude** (`momentumPctMin` = |%đổi 12 bar|, `cumMovePctMin` = |%move qua streak|, theo chiều fade). Tính từ 48 bars tại T+4 (`SignalT4Event.edgeContext`). Missing context → không fire.

Edge match → fire, **bỏ qua threshold/armed**. Không match → rơi xuống đường streak-count (ở 99 → không fire).

---

## Phương pháp luận (đọc trước khi tin số)

- **Entry $0.55 phẳng** (giả định bảo thủ — fade thật vào rẻ hơn, ~18-50¢). Base $5: WIN +$4.09, LOSS −$5 → **breakeven WR = 55%**.
- **OOS validate**: train 70% / test 30% theo thời gian. Edge chỉ tin khi **CẢ full lẫn OOS ≥ 55%**. TRAIN cao + TEST thấp = overfit (vứt).
- **Multiple-comparison**: scan nhiều combo → vài cái pass OOS do may. Yêu cầu OOS n≥30 + lift≥2pp vs raw + câu chuyện hợp lý (không phải combo ngẫu nhiên).
- **Nguồn data**: backtest dùng Binance klines (close-vs-open). Bot live tính streak Poly-per-bar (Binance fallback). Streak lớn (≥5) Poly≡Binance; streak nhỏ có thể lệch trên nến tiny-move.
- Scripts: `apps/api/scripts/analyze-*.ts`, `backtest-*.ts` (chạy `npx tsx`).

---

## Edge ĐÃ VALIDATE

### 5m ratio (LIVE)
| Edge | ratio≥ | Full WR | OOS | Ghi chú |
|---|---|---|---|---|
| streak=3 | 1.2 | 56% | ✓ | Volume cao nhất |
| streak=6 | 1.0 | ~57% | ✓ | |
| streak=7 | 1.0 | 55% | ✓ | Sweet spot exhaustion |

streak=4,5 trên 5m: **ratio gate RỚT OOS** (TRAIN 57% → TEST 52-53%). Không dùng ratio thường cho s4/s5. → s4 chỉ cứu được bằng clustering (dưới).

### 1h ratio (LIVE)
| Edge | ratio≥ | Ghi chú |
|---|---|---|
| streak=3 | 0.8 | Robust cả 365d + 30d |
| streak=4 | 1.0 | 365d sweet spot (recent 30d yếu — regime-sensitive) |

### Clustering (LIVE 2026-06-11 — `c53be8e`) {#clustering-edges}
Phát hiện: **cùng chiều dồn cục + body lớn = exhaustion**. Streak lớn gần đây "prime" regime → streak nhỏ theo sau fade tốt hơn. Ratio + clustering là 2 filter độc lập → **stack được** (+6-12pp OOS).

| Edge | Điều kiện | Full | OOS | $/ngày |
|---|---|---|---|---|
| s3 clustering | streak3, ratio≥1.0, prior≥5 trong 30m | 60% | 61% | $0.58 |
| s4 clustering | streak4, prior≥5 trong 30m (no ratio) | 58% | 61% | $0.31 |
| s3 double | streak3, prior≥4 trong 60m, **count≥2** | 60% | 76%* | — |

\* OOS n=71 (nhỏ) — bật riêng, theo dõi.

### Magnitude — "đã tăng bao nhiêu" (LIVE 2026-06-11 — `c53be8e`) {#magnitude-edges}
Chiều mới, độc lập với streak-length & ratio: **mức độ căng/quá đà** của move. Đo theo chiều streak (lớn = càng căng theo hướng fade):
- `cumMove` = % move qua các bar của streak (run này đẩy bao xa)
- `mom1h` = % đổi qua 12 bar (1h) gần nhất @5m — momentum gần
- `distSMA` = (close − SMA48)/SMA48 — quá đà so với trung bình
- `mom4h` = % đổi qua 4h

Phát hiện: **momentum/over-extension là filter MẠNH HƠN ratio cho streak=3 trên 5m**, và **cứu được low-streak trên 1h** (nến 1h sạch, ít noise). Script: `analyze-magnitude-edges.ts`.

**5m** (entry $0.55, OOS-validated):
| Edge | Ngưỡng | Full | OOS | $/ngày |
|---|---|---|---|---|
| s3 + **mom1h** ≥0.38% (top20%) | đã tăng ≥0.38%/1h | 58% | **60%** | **$1.88** ← mạnh nhất 5m |
| s3 + mom1h ≥0.61% (top10%) | | 57% | 62% | $0.72 |
| s3 + **distSMA** ≥0.42% | quá đà ≥0.42% vs SMA48 | 57% | 59% | $1.06 |
| s3 + cumMove ≥0.36% | | 55% | 57% | $0.31 |

streak=2 trên **5m**: magnitude KHÔNG cứu (best ~54%, âm $/ngày) — quá noisy.

**1h** (730d, entry $0.55):
| Edge | Ngưỡng | Full | OOS | Ghi chú |
|---|---|---|---|---|
| **s2** + cumMove ≥0.90% (top30%) | run đã đi ≥0.90% | 56% | 56% | ★ low-streak fade dc trên 1h |
| **s4** + cumMove ≥1.85% (top20%) | | 62% | **59%** | mạnh; tăng cường s4 hiện có |
| s4 + cumMove ≥2.59% (top10%) | | 63% | 65% | n nhỏ hơn |
| s3 + cumMove ≥1.36% (top20%) | | 56% | 55% | bổ sung s3≥0.8 |

**Insight:** "đã tăng bao nhiêu" là tín hiệu fade THẬT — nhưng timeframe-specific. 5m: chỉ cứu streak=3 (streak=2 noise). 1h: cứu streak 2/3/4 (bar sạch hơn). Tín hiệu mạnh nhất = recent momentum (mom1h@5m, cumMove@1h). Trực giao với clustering → có thể combine.

---

## Ngõ cụt — ĐÃ LOẠI (đừng test lại)

| Pattern | Kết quả |
|---|---|
| **Raw streak** (không filter) | Mọi streak length 50-55% → thua. Phải có filter. |
| **Fixed dollar body3** | Decay theo regime; ratio luôn ăn đứt |
| **streak=5 fade** | Chết hẳn (50-51%), clustering cũng không cứu, thậm chí âm |
| **Priming NGƯỢC chiều** (prior DOWN → fade UP) | Vô dụng. Xác nhận là exhaustion cùng chiều, không phải whipsaw |
| **Defensive regime theo UTC-hour** | Không cải thiện WR |
| **"Bad hours" + streak cao + body restrict** | Không có edge đáng kể |
| **Follow (thuận xu hướng)** thay vì fade | Chiến lược là fade — follow không test sâu |

---

## Arm mode {#arm-mode}

**Đang TẮT** (echo_trigger_streak/signal_min/baseline = 99). Lý do (backtest): priming chỉ giúp **streak=4**; streak=3/5 vô dụng/hại. Arm generic hạ ngưỡng cho MỌI streak trong cửa sổ → fire cả streak 3/5 (thua) → quá cùn.

- Arm chỉ trigger khi `absStreak ≥ echo_trigger_streak`. Edge fire **KHÔNG** arm bot (cơ chế tách rời).
- Kể cả armed, chỉ đổi `threshold` (đường streak-count) — edge fire bỏ qua threshold → armed vô tác dụng với ratio strategy.
- Clustering edge (đề xuất) là cách "đúng" để bắt cluster mà arm generic làm hỏng.

---

## Config field reference (`EchoEdgeCase`)

| Field | Ý nghĩa |
|---|---|
| `streakMin`/`streakMax` | Khoảng effective streak match (inclusive) |
| `body3Min`/`body3Max` | Dollar gate (USD) — fallback khi không có ratio |
| `body3OverAvgMin` | **Ratio gate** body3/(avgBody×3) ≥ — filter chính |
| `dcaBody3Min` | Ngưỡng body3 cho DCA của edge này |
| `priorStreakMin` | Clustering: streak-peak cùng chiều tối thiểu của run trước |
| `priorWindowMin` | Clustering: cửa sổ nhìn lại (phút) |
| `priorCountMin` | Clustering: số peak thỏa tối thiểu (1, hoặc 2 cho double) |
| `momentumPctMin` | Magnitude: \|%đổi qua 12 bar (1h@5m)\| theo chiều fade ≥ |
| `cumMovePctMin` | Magnitude: \|%move qua các bar của streak\| theo chiều fade ≥ |

Tất cả implemented (c53be8e). Matcher ANDs với streak+body gate. priorWindowMin tính theo phút (/ bin size).

> ⚠️ **LUẬT VÀNG**: thêm field mới vào `EchoEdgeCase` thì PHẢI thêm vào `patchSchema` ([`coin-configs.ts`](apps/api/src/api/coin-configs.ts)) CÙNG commit — nếu không zod **strip âm thầm** field lạ mỗi lần save UI → tắt nguyên chiến lược. (Đã dính bug này: `body3OverAvgMin` bị strip, fix `f02479c`.)

---

## Index backtest scripts

| Script | Tìm gì |
|---|---|
| `analyze-ratio-edges.ts` | Ratio gate per streak, cả 5m + 1h, OOS |
| `analyze-streak-clustering.ts` | Clustering v1 (prior streak → fade) |
| `analyze-clustering-v2.ts` | Clustering + ratio combo, double, opposite-dir |
| `analyze-magnitude-edges.ts` | Magnitude/over-extension (cumMove, mom1h, distSMA) per streak, 5m+1h |
| `backtest-killswitch.ts` | Trend-break kill-switch |
| `backtest-avgbody-norm.ts` / `-window.ts` | Ratio normalization, avgBody window sweep |
| `analyze-fade-vs-follow.ts` | Fade vs follow |
| `analyze-defensive-regimes.ts` / `analyze-bad-hours-deep.ts` | Defensive/hour-range (ngõ cụt) |

---

## Provenance

- Ratio discovery + universal-edge refactor: 2026-05-26 (`PriceMonitoringWorker.ts` matcher)
- 5m ratio config applied: phiên 2026-06 (s3/s6/s7)
- 1h → echo + ratio: 2026-06-11
- Clustering discovery: 2026-06-11 (chưa code)
- Strip bug fix (ratio gate khôi phục): `f02479c`, `4a4a8ed`
