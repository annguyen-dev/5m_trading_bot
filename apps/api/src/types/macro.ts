/**
 * Macro event types — historical political/economic events correlated with BTC price reactions.
 *
 * Each event records:
 *   - What happened and when
 *   - How BTC price reacted at multiple time horizons after the event
 *   - The estimated "reflection lag" — how long until the market fully priced in the event
 */

export type MacroEventCategory =
  | 'fed_rate'        // Fed rate decisions, FOMC minutes, Powell speeches
  | 'inflation'       // CPI, PCE, PPI releases
  | 'regulatory'      // ETF approvals/rejections, exchange bans, SEC lawsuits
  | 'adoption'        // Institutional buys, country-level adoption, corporate treasury
  | 'black_swan'      // Sudden systemic shocks (Luna, FTX, COVID, exchange hacks)
  | 'halving'         // BTC halving events
  | 'macro_liquidity' // M2 money supply, QE/QT, DXY strength, risk-on/off regime
  | 'geopolitical';   // Wars, sanctions, banking crises, political instability

/** BTC price % change measured at fixed intervals after the event */
export interface PriceReaction {
  h1:  number;   // 1 hour after
  h4:  number;   // 4 hours after
  h24: number;   // 1 day after
  d3:  number;   // 3 days after
  d7:  number;   // 7 days after
  d30: number;   // 30 days after
}

export interface MacroEvent {
  id:               string;
  date:             string;               // ISO date string e.g. '2024-01-10'
  category:         MacroEventCategory;
  title:            string;
  description:      string;              // detail for embedding
  btcPriceAtEvent:  number;
  reaction:         PriceReaction;
  /**
   * Estimated hours until the event was "fully reflected" in price.
   * Derived from LagAnalyzer or manually annotated.
   * e.g. 72 means price stabilized ~3 days after event.
   */
  lagHours:         number;
  /**
   * Dominant direction of price reaction.
   * Positive = bullish event, Negative = bearish event, Mixed = ambiguous.
   */
  impact:           'positive' | 'negative' | 'mixed';
  source:           string;              // URL or reference
}

/** Aggregated lag statistics per event category */
export interface CategoryLagStats {
  category:          MacroEventCategory;
  sampleSize:        number;
  medianLagHours:    number;
  avgLagHours:       number;
  /** Time horizon with the strongest consistent price reaction */
  strongestHorizon:  keyof PriceReaction;
  /** Average absolute % move at the strongest horizon */
  avgMoveAtPeak:     number;
  /** % of events in this category that were bullish for BTC */
  bullishRate:       number;
  /** Example narratives to feed AI context */
  typicalPattern:    string;
}
