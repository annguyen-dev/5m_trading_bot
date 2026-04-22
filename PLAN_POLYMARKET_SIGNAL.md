# Polymarket Signal System — Implementation Plan

> Trạng thái: CHƯA IMPLEMENT  
> Mục tiêu: Thay thế hệ thống tín hiệu Future hiện tại bằng engine giao dịch Polymarket (PM) dựa trên xác suất hội tụ đa tầng.

---

## 1. Sự khác biệt cốt lõi so với hệ thống hiện tại

| Hạng mục | Hiện tại | Polymarket mới |
|---|---|---|
| Sàn giao dịch | Binance Future (BUY/SELL) | Polymarket Prediction Market |
| "Giá" tín hiệu | Price target & Stop Loss | Share Price (= xác suất thị trường, 0–1) |
| Đóng lệnh | TP/SL hit | Hold to Expiry — Oracle PM tự giải quyết |
| Cơ sở ra lệnh | Confidence > threshold | EV > 0: `EV = P_signal − Share_Price` |
| DCA | Cùng nến, tăng size | Sang nến n+1, tính lại P_signal |
| Khung thực thi | 1m streak | 5m candle PM + 5s orderbook radar |
| Hedge | Không | Mua ngược cửa PM khi PM lag Future |

---

## 2. Kiến trúc P_signal Engine

### 2.1 Công thức tổng hợp

```
P_signal(UP) =  W_QUOTA   × p_quota
             +  W_TREND   × p_trend
             +  W_PATTERN × p_pattern
             +  W_LIQ     × p_liq
             (/ W_total — normalize khi thiếu data)

EV = P_signal − Share_Price_PM
Trade: chỉ khi EV > MIN_EV (đề xuất 0.03)
```

### 2.2 Bốn thành phần P_signal

#### A. Daily Quota — `p_quota` (W = 0.30)

**Ý nghĩa:** Mỗi ngày có giới hạn tự nhiên bao nhiêu lần streak-N đảo chiều.  
Nếu hôm nay đã vượt ngưỡng trung bình lịch sử → thị trường đang trending mạnh → giảm xác suất đảo chiều.

**Data source:** `kb_daily_reversal_stats` (materialized view — đã có)  
**Logic:**
```
ratio = today_reversals_at_streak_N / avg_daily_reversals_at_streak_N
p_quota = max(0.20, 1.0 − ratio)
```
**Streak-N ở đây là 5m streak** (không phải 1m như hiện tại).  
→ Cần thêm cột `streak_5m_at_entry` vào bảng tracking.

---

#### B. Higher Timeframe Strength — `p_trend` (W = 0.35)

**Ý nghĩa:** Khung 15m và 1h đang ủng hộ hướng nào → nhân thêm điểm nếu đồng thuận với tín hiệu 5m.

**Data source:** `ohlcv_1m` aggregated to 15m/1h

**Logic:**
```typescript
// 15m trend: EMA(9) slope trên 3 nến 15m gần nhất
// 1h trend: change_1h > threshold

trend15m: 'up' | 'down' | 'neutral'   // EMA slope > 0.1% = up
trend1h:  'up' | 'down' | 'neutral'   // change_1h > 0.3% = up

// Scoring (nếu tín hiệu 5m là UP):
if (trend1h === 'up'  && trend15m === 'up')  → p_trend = 0.75
if (trend1h === 'up'  && trend15m === 'neutral') → p_trend = 0.62
if (trend1h === 'neutral' && trend15m === 'up')  → p_trend = 0.60
if (trend1h === 'down' || trend15m === 'down')   → p_trend = 0.35  // headwind
else → p_trend = 0.50  // neutral
```

**Macro filter (1h/D1 bias):**  
Nếu bias 1h/D1 = DOWNTREND mạnh → bot chỉ được chọn cửa DOWN trên PM.  
Implement as a hard filter BEFORE tính EV, không phải weight.

---

#### C. Pattern Match — `p_pattern` (W = 0.20)

**Ý nghĩa:** k-NN similarity với lịch sử — tình huống này đã xảy ra bao nhiêu lần và kết quả ra sao.

**Data source:** `kb_snapshots` (đã có)  
**Thay đổi cần làm:**
- Hiện tại query dùng `streak_1m` làm feature chính → chuyển sang `streak_5m`
- Thêm feature `change_15m` và `change_1h` vào L1 distance
- K = 30 (tăng từ 20 để có đủ mẫu 5m)

**Query mới:**
```sql
SELECT direction, t5m, t1h
FROM kb_snapshots
WHERE direction IN ('up', 'down')
ORDER BY
    ABS(streak_5m    - $1) / 3.0   -- primary: 5m streak
  + ABS(change_15m   - $2) / 0.005  -- 15m context
  + ABS(change_1h    - $3) / 0.01   -- 1h context
  + ABS(volume_ratio - $4) / 0.5
  + ABS(wick_ratio   - $5) / 0.3
LIMIT 30
```

**p_pattern** = `up_votes / total_decided` (nếu signal là UP)

---

#### D. Liquidity Bias — `p_liq` (W = 0.15)

**Ý nghĩa:** Giá đang gần vùng thanh lý lớn → xu hướng bị hút về vùng đó (hoặc bật lại mạnh sau khi quét xong).

**Data source:** `kb_snapshots.liq_long_usd`, `liq_short_usd`, `liq_cascade`  
**Logic (draft):**
```
liq_ratio = liq_short_usd / (liq_long_usd + liq_short_usd)  // >0.5 = nhiều short liq bên trên
if (liq_cascade >= 2):
  // Cascade đang xảy ra → theo chiều cascade
  p_liq = liq_cascade_direction === signal_dir ? 0.70 : 0.30
else:
  p_liq = 0.50 + (liq_ratio - 0.50) × 0.30  // mild pull toward liq zone
```

---

### 2.3 PM EV Filter (Gate — không phải weight)

```typescript
interface PMSharePrice {
  up:   number;  // giá mua cửa UP (0.0–1.0)
  down: number;  // giá mua cửa DOWN
  spread: number; // bid-ask spread (chi phí giao dịch)
}

// EV tính sau khi đã có P_signal và Share_Price từ PM
ev_up   = P_signal(UP)   - pm.up   - pm.spread
ev_down = P_signal(DOWN) - pm.down - pm.spread

// Chỉ vào lệnh khi:
if (ev_up   > MIN_EV) → BUY "UP" share
if (ev_down > MIN_EV) → BUY "DOWN" share
if (both)            → chọn cái EV cao hơn
if (neither)         → SKIP (không gọi Claude)
```

**MIN_EV = 0.03** (cần ít nhất 3% edge sau spread để vào lệnh)

---

## 3. DB Schema — Thêm mới

### 3.1 `poly_markets`
Lưu thông tin về PM market đang active cho mỗi nến 5m.

```sql
CREATE TABLE poly_markets (
  id           TEXT PRIMARY KEY,          -- PM market id
  ts_open      BIGINT NOT NULL,           -- Unix ms khi nến 5m mở
  ts_close     BIGINT NOT NULL,           -- Unix ms khi nến 5m đóng
  symbol       TEXT NOT NULL DEFAULT 'BTC/USDT',
  share_price_up   DOUBLE PRECISION,      -- giá cửa UP lúc entry
  share_price_down DOUBLE PRECISION,      -- giá cửa DOWN lúc entry
  spread       DOUBLE PRECISION,
  resolved     SMALLINT NOT NULL DEFAULT 0,  -- 0=pending, 1=resolved
  resolution   TEXT                       -- 'up' | 'down'
);
CREATE INDEX poly_markets_ts ON poly_markets(ts_open);
```

### 3.2 `poly_orders`
Lưu lệnh giả lập và thật trên PM.

```sql
CREATE TABLE poly_orders (
  id              TEXT PRIMARY KEY,
  market_id       TEXT REFERENCES poly_markets(id),
  ts_entry        BIGINT NOT NULL,
  direction       TEXT NOT NULL,           -- 'up' | 'down'
  share_price     DOUBLE PRECISION NOT NULL,
  size_usdc       DOUBLE PRECISION NOT NULL,
  p_signal        DOUBLE PRECISION NOT NULL,
  ev              DOUBLE PRECISION NOT NULL,
  -- Context snapshot
  streak_5m       SMALLINT NOT NULL,
  trend_15m       TEXT,
  trend_1h        TEXT,
  p_quota         DOUBLE PRECISION,
  p_trend         DOUBLE PRECISION,
  p_pattern       DOUBLE PRECISION,
  p_liq           DOUBLE PRECISION,
  -- DCA tracking
  dca_round       SMALLINT NOT NULL DEFAULT 0,  -- 0=first, 1=DCA1, 2=DCA2...
  parent_order_id TEXT,                          -- nếu là DCA, ref lệnh gốc
  -- Outcome
  mode            TEXT NOT NULL DEFAULT 'sim',  -- 'sim' | 'live'
  status          TEXT NOT NULL DEFAULT 'pending', -- 'pending'|'win'|'loss'|'hedged'
  pnl_usdc        DOUBLE PRECISION,
  resolved_at     BIGINT
);
CREATE INDEX poly_orders_market  ON poly_orders(market_id);
CREATE INDEX poly_orders_ts      ON poly_orders(ts_entry);
CREATE INDEX poly_orders_status  ON poly_orders(status);
```

### 3.3 `future_ticks_5s`
Lưu dữ liệu 5s để detect PM lag và panic.

```sql
CREATE TABLE future_ticks_5s (
  ts           BIGINT NOT NULL,
  symbol       TEXT NOT NULL DEFAULT 'BTC/USDT',
  price        DOUBLE PRECISION NOT NULL,
  cvd_delta    DOUBLE PRECISION NOT NULL DEFAULT 0,  -- CVD thay đổi trong 5s này
  ob_imbalance DOUBLE PRECISION NOT NULL DEFAULT 0,  -- (bid_vol - ask_vol) / total
  PRIMARY KEY (symbol, ts)
);
-- Chỉ giữ 24h gần nhất (xóa cũ bằng partition hoặc cron)
CREATE INDEX future_ticks_ts ON future_ticks_5s(ts);
```

### 3.4 Thay đổi `kb_snapshots`
Thêm `change_15m` nếu chưa có (hiện tại chỉ có `change_1m`, `change_5m`, `change_15m`, `change_1h`).  
→ **Đã có `change_15m`** — không cần thêm.

Thêm materialized view cho streak_5m stats (đã có `kb_daily_reversal_stats`).

---

## 4. Services mới cần xây

### 4.1 `PolymarketService.ts`
**Nhiệm vụ:** Interface với Polymarket API (REST + WebSocket).

```typescript
interface PMMarket {
  id: string;
  question: string;     // "Will BTC close green in next 5 minutes?"
  endTime: number;      // Unix ms
  outcomes: ['YES', 'NO'];
  prices: { YES: number; NO: number };  // current share prices
  spread: number;
}

class PolymarketService {
  // Lấy market đang active cho nến 5m tiếp theo
  async getCurrentMarket(symbol: string): Promise<PMMarket | null>
  
  // Theo dõi share price real-time (WebSocket)
  subscribeToMarket(marketId: string, cb: (prices) => void): void
  
  // Đặt lệnh (sim mode: lưu DB; live mode: sign + submit Polygon tx)
  async placeOrder(market: PMMarket, direction: 'up'|'down', sizeUsdc: number, mode: 'sim'|'live'): Promise<string>
}
```

**Polymarket API endpoints:**
- `GET https://clob.polymarket.com/markets` — list markets
- `GET https://clob.polymarket.com/order-book/{market_id}` — orderbook
- `WS wss://ws-subscriptions-clob.polymarket.com/ws/market` — real-time prices

### 4.2 `PolySignalService.ts`
**Nhiệm vụ:** Tính P_signal và EV cho mỗi nến 5m.  
**Input:** `timestamp`, `symbol`, `pm_share_price`  
**Output:** `PolySignalResult`

```typescript
interface PolySignalResult {
  timestamp:   number;
  direction:   'up' | 'down' | 'skip';
  p_signal:    number;       // 0–1
  ev:          number;       // p_signal - share_price
  share_price: number;
  components: {
    quota:   { p: number; streak5m: number; todayCount: number; avgCount: number };
    trend:   { p: number; trend15m: string; trend1h: string };
    pattern: { p: number; neighbors: number; upVotes: number };
    liq:     { p: number; liqRatio: number; cascade: number };
  };
  macroBias:   'up' | 'down' | 'neutral';  // hard filter result
  skipReason?: string;  // nếu direction === 'skip'
}
```

### 4.3 `PolyDCAManager.ts`
**Nhiệm vụ:** Quản lý DCA khi nến thua.

```typescript
class PolyDCAManager {
  // Tính size DCA cho nến n+1 sau khi thua
  // Size = (Loss + Target) / (1 - Share_Price)
  calcDCASize(loss: number, target: number, sharePrice: number): number

  // Check safety locks
  isSafe(context: {
    streak5m: number;
    quotaExhausted: boolean;
    dcaRound: number;
    newSize: number;
    bankroll: number;
  }): { safe: boolean; reason?: string }

  // Max DCA rounds = 3 (config)
  // Max size = 5% bankroll
  // Max streak = lấy từ kb_daily_reversal_stats (max streak observed)
}
```

### 4.4 `FutureTickScanner.ts`
**Nhiệm vụ:** Quét dữ liệu 5s Binance Future để:
1. Detect volatility spike (panic/momentum)
2. Tính OB imbalance làm input cho P_signal

```typescript
class FutureTickScanner {
  // Poll mỗi 5s: lấy giá + CVD + orderbook từ MarketDataService
  // Ghi vào future_ticks_5s
  // Emit 'spike' event khi |price_change_5s| > SPIKE_THRESHOLD (0.3%)
  // Emit 'tick' event mỗi 5s với OB imbalance
}
```

### 4.5 `MacroBiasFilter.ts`
**Nhiệm vụ:** Xác định bias dài hạn (1h/D1) để làm hard filter.

```typescript
// Input: last 24h candles + funding rate + macro_events
// Output: 'bullish' | 'bearish' | 'neutral' + strength (0–1)
// Logic:
//   - 1h trend (EMA 20 slope + change_24h)
//   - D1 trend (change_7d)
//   - Macro events tone (avg last 72h)
//   - Funding rate (>0.01% = bullish, <-0.01% = bearish)
// Bias chỉ block lệnh khi strength > 0.7
```

---

## 5. Hedge / Arbitrage Logic (Phase 2)

> **Implement sau** — phức tạp hơn, cần live PM API trước.

**Trigger:** `FutureTickScanner` emit `spike` event  
**Action:**
1. Lấy PM orderbook snapshot ngay lập tức
2. So sánh Future price move vs PM share price move
3. Nếu Future drop -0.5% nhưng PM "UP" share vẫn = 0.50 (chưa cập nhật):
   - Buy "DOWN" share trên PM ở giá 0.50 (thực ra ~0.52+ sau khi cập nhật)
   - Hold to expiry
4. Window cơ hội: ~1-2 giây trước khi PM oracle cập nhật

**Rủi ro:** PM không cho early exit → nếu đoán sai vẫn bị lỗ full

---

## 6. Logic Loop 5s — Main Execution Flow

```
Every 5s:
├── FutureTickScanner.tick()
│   ├── Ghi future_ticks_5s
│   └── Emit 'spike' nếu |Δprice| > 0.3%
│
├── [Nếu đang trong nến 5m mới (giây 0-10)]
│   ├── PolySignalService.compute(timestamp)
│   ├── PolymarketService.getSharePrice(currentMarket)
│   ├── Tính EV
│   └── Nếu EV > MIN_EV → PolyDCAManager.enter() hoặc DCA
│
├── [Nếu có lệnh đang mở + spike detected]
│   └── HedgeArbitrage.evaluate() [Phase 2]
│
└── [Nếu nến 5m vừa kết thúc]
    ├── Đọc resolution từ PM
    ├── Cập nhật poly_orders (win/loss)
    └── Feedback → KB (update pattern reliability)
```

---

## 7. Simulate Tab — Thay đổi

Trang Simulate hiện tại simulate tín hiệu Future. Cần thêm tab **"PM Simulate"**:

- Input: chọn nến 5m lịch sử
- Hiển thị: P_signal từng component, PM share price (mock hoặc thật nếu có lịch sử), EV
- Outcome: Win/Loss dựa trên nến 5m thực tế
- DCA scenario: nếu thua, tính DCA round 1/2/3

---

## 8. Thứ tự Implementation

```
Phase 1 — P_signal Engine (không cần PM API thật)
  1.1  MacroBiasFilter          — đọc ohlcv_1m + macro_events
  1.2  TrendStrengthScorer      — 15m/1h EMA + change
  1.3  PolySignalService        — gộp 4 components + mock share price
  1.4  DB schema                — poly_markets, poly_orders
  1.5  Simulate tab PM          — test backtesting P_signal vs actual 5m outcomes

Phase 2 — PM Integration (cần API key + wallet)
  2.1  PolymarketService        — REST fetch + WebSocket
  2.2  FutureTickScanner        — 5s polling loop
  2.3  PolyDCAManager           — DCA logic + safety locks
  2.4  Sim mode end-to-end      — full loop không tiền thật

Phase 3 — Live Trading
  3.1  Polygon wallet integration
  3.2  Live order execution
  3.3  Hedge/Arbitrage (lag exploit)
  3.4  Bankroll management
```

---

## 9. Files cần tạo mới

```
src/
├── services/
│   ├── PolySignalService.ts       ← Phase 1
│   ├── MacroBiasFilter.ts         ← Phase 1
│   ├── TrendStrengthScorer.ts     ← Phase 1
│   ├── PolymarketService.ts       ← Phase 2
│   ├── FutureTickScanner.ts       ← Phase 2
│   └── PolyDCAManager.ts          ← Phase 2
├── client/api/
│   └── poly-simulate.ts           ← Phase 1 (new simulate API)
└── types/
    └── polymarket.ts              ← Phase 1 (PM types)
```

## Files cần sửa đáng kể

```
src/db/client.ts                   ← Thêm 3 bảng mới
src/services/StatisticalSignalService.ts  ← Chuyển sang 5m focus
public/index.html                  ← Thêm PM Simulate tab
```

---

## 10. Câu hỏi cần xác nhận trước khi implement

1. **PM market nào cụ thể?** "BTC 5m candle green/red" — trên PM thường có dạng "Will BTC-USD be above $X at T+5m?" Cần tìm market ID chính xác hoặc dùng custom market.
2. **Mock share price trong Phase 1?** Để test P_signal, có thể dùng `0.50 + random(-0.05, 0.05)` làm mock, hoặc dùng lịch sử KB để reverse-engineer.
3. **Bankroll?** Cần define `TARGET_PROFIT_PER_CANDLE` và `MAX_BANKROLL_PER_TRADE` để tính DCA size.
4. **MIN_EV threshold?** 0.03 (3%) là đề xuất — cần backtest để xác nhận có đủ lệnh không.
