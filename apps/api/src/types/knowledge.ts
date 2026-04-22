/**
 * Types for the unified historical knowledge base.
 *
 * A CorrelatedSnapshot is one 5-minute window that combines:
 *   - Price action (OHLCV)
 *   - Liquidation activity (real or synthesized)
 *   - Market structure (funding rate, open interest)
 *   - Macro/news context at that moment
 *   - Outcome labels (what happened after)
 *
 * These snapshots are embedded into LanceDB and queried at signal time
 * to find historically similar situations.
 */

export type TimeframeLabel = '5m' | '15m' | '1h';

export interface OHLCVBar {
  timestamp:  number;
  open:       number;
  high:       number;
  low:        number;
  close:      number;
  volume:     number;   // quote volume (USDT)
}

/** Liquidation data — real from exchange or synthesized from OHLCV+OI+funding */
export interface LiquidationWindow {
  timestamp:        number;   // window start
  windowMs:         number;   // window size in ms (e.g. 5min = 300_000)

  longLiqUsd:       number;   // USD value of long liquidations
  shortLiqUsd:      number;   // USD value of short liquidations
  totalLiqUsd:      number;
  dominantSide:     'long' | 'short' | 'neutral';
  isCascade:        boolean;  // true if totalLiqUsd > cascade threshold

  // Source metadata
  source:           'real' | 'synthesized';
  exchanges:        string[]; // which exchanges contributed
  confidence:       number;   // 0-1, lower for synthesized
}

/** Funding rate + OI snapshot */
export interface MarketStructure {
  timestamp:          number;
  fundingRate:        number;   // e.g. 0.001 = 0.1% per 8h
  fundingAnnualized:  number;   // annualized %
  openInterestUsd:    number;   // total OI in USD
  oiChangePercent1h:  number;   // % change in OI last 1h
  leverageRatio:      number;   // OI / market cap proxy (higher = more leveraged)
}

/** Active macro/news event at a point in time */
export interface ActiveMacroContext {
  eventId:      string;
  category:     string;
  title:        string;
  hoursAgo:     number;   // how many hours since event occurred
  tone:         number;   // GDELT tone or sentiment score
  lagRemaining: number;   // estimated hours until fully priced in
}

/**
 * One correlated snapshot — the core knowledge base unit.
 * Represents conditions at a given 5-minute window.
 */
export interface CorrelatedSnapshot {
  id:         string;   // `${exchange}_${symbol}_${timestamp}`
  timestamp:  number;
  symbol:     string;
  exchange:   string;

  // Price action
  price:          number;
  priceChange5m:  number;   // % change this candle
  priceChange1h:  number;   // % change over last 1h
  priceChange4h:  number;   // % change over last 4h
  volume5m:       number;
  volumeRatio:    number;   // vs 20-period avg volume
  wickRatio:      number;   // wick vs body size (spike detection)

  // CVD proxy from OHLCV
  cvdProxy:       number;   // cumulative buy-sell pressure estimate

  // Liquidations
  liquidations:   LiquidationWindow;

  // Market structure
  structure:      MarketStructure;

  // Macro context (events active within last 72h)
  macroEvents:    ActiveMacroContext[];
  dominantMacroCategory: string | null;
  aggregateMacroTone:    number;   // -1 to +1

  // Outcome labels (what happened AFTER this snapshot)
  outcome: {
    priceChange5m:  number;
    priceChange15m: number;
    priceChange1h:  number;
    priceChange4h:  number;
    priceChange1d:  number;
    direction:      'up' | 'down' | 'flat';   // dominant direction in next 1h
    maxDrawdown1h:  number;   // max % drop in next 1h
    maxUpside1h:    number;   // max % gain in next 1h
  };

  // Embedding text — built from all fields for vector search
  embeddingText:  string;
}

/** Summary stats for a knowledge base build run */
export interface KnowledgeBaseBuildResult {
  symbol:         string;
  exchanges:      string[];
  fromDate:       string;
  toDate:         string;
  totalSnapshots: number;
  syntheticLiqs:  number;   // how many used synthesized liquidations
  realLiqs:       number;
  macroEvents:    number;
  buildDurationMs: number;
  outputPath:     string;
}
