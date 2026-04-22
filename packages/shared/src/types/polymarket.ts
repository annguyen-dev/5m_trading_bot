/**
 * src/types/polymarket.ts
 * Types for the Polymarket signal engine.
 */

export interface MacroBias {
  bias:      'bullish' | 'bearish' | 'neutral';
  strength:  number;   // 0–1
  change24h: number;
  change7d:  number;
  ema1h:     number;
}

export interface TrendStrength {
  trend15m: 'up' | 'down' | 'neutral';
  trend1h:  'up' | 'down' | 'neutral';
  score:    number;   // 0–1: how strongly both agree
}

export interface PatternMatch {
  upVotes:    number;
  downVotes:  number;
  total:      number;
  pUp:        number;   // upVotes / total
}

export interface QuotaCheck {
  streak5m:    number;   // signed 5m streak at this timestamp
  todayCount:  number;   // streak-N reversals today
  avgCount:    number;   // historical avg per day for streak-N
  sampleDays:  number;
  ratio:       number;   // todayCount / avgCount
  pReversal:   number;   // max(0.2, 1 - ratio)
}

export interface LiqBias {
  liqLong:  number;   // synthesized liq_long_usd (avg recent)
  liqShort: number;   // synthesized liq_short_usd (avg recent)
  cascade:  number;   // avg liq_cascade (0–3+)
  pUp:      number;   // 0–1 probability toward UP direction
}

export interface PolySignalComponents {
  quota:   { p: number } & QuotaCheck;
  trend:   { p: number } & TrendStrength;
  pattern: { p: number } & PatternMatch;
  liq:     { p: number } & LiqBias;
}

export interface PolySignalResult {
  timestamp:   number;
  price:       number;
  direction:   'up' | 'down' | 'skip';
  p_signal:    number;   // P(next 5m = direction)
  ev:          number;   // p_signal - share_price (- spread)
  share_price: number;   // mock or real PM share price
  spread:      number;
  components:  PolySignalComponents;
  macroBias:   MacroBias;
  skipReason?: string;
  // Outcome look-ahead (filled in simulate mode)
  outcome?: {
    actual:        'up' | 'down';
    correct:       boolean;
    pnlPct:        number;   // (1 - share_price) if win, -share_price if loss
  };
}
