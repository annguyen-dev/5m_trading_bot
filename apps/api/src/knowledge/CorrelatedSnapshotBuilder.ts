/**
 * CorrelatedSnapshotBuilder
 *
 * Joins OHLCV + liquidations + macro events by timestamp into
 * CorrelatedSnapshot objects — the core knowledge base unit.
 *
 * For each 5m candle:
 *   1. Attach synthesized liquidation window
 *   2. Find active macro events within 72h window
 *   3. Compute rolling metrics (CVD proxy, volume ratio, wick ratio)
 *   4. Compute outcome labels using FUTURE candles (look-forward only here,
 *      not at signal time — this is for knowledge base building only)
 *   5. Build embedding text from all fields
 */

import { v4 as uuidv4 } from 'uuid';
import type { OHLCVBar, LiquidationWindow, MarketStructure, CorrelatedSnapshot, ActiveMacroContext } from '../types/knowledge.js';
import type { HistoricalMacroEvent } from './GDELTHistoricalFetcher.js';
import { GDELTHistoricalFetcher } from './GDELTHistoricalFetcher.js';

// Rolling window sizes
const CVD_WINDOW   = 12;  // 12 × 5m = 1h CVD proxy
const VOL_AVG_WIN  = 20;  // 20 × 5m volume average

// Outcome horizons
const OUTCOME_5M   = 1;   // candles ahead
const OUTCOME_15M  = 3;
const OUTCOME_1H   = 12;
const OUTCOME_4H   = 48;
const OUTCOME_1D   = 288;

// Cascade / spike thresholds for embedding text
const CASCADE_USD  = 50_000_000;
const SPIKE_USD    = 20_000_000;

export class CorrelatedSnapshotBuilder {
  build(
    exchange: string,
    symbol: string,
    candles: OHLCVBar[],
    liqMap: Map<number, LiquidationWindow>,
    macroEvents: HistoricalMacroEvent[],
  ): CorrelatedSnapshot[] {
    const snapshots: CorrelatedSnapshot[] = [];
    const avgVolumes = buildRollingAvgVolumes(candles, VOL_AVG_WIN);
    const cvdProxies = buildCVDProxies(candles, CVD_WINDOW);

    // Need at least OUTCOME_1D future candles for outcome labeling
    const limit = candles.length - OUTCOME_1D;

    for (let i = VOL_AVG_WIN; i < limit; i++) {
      const candle  = candles[i]!;
      const liq     = liqMap.get(candle.timestamp) ?? buildEmptyLiq(candle.timestamp);
      const avgVol  = avgVolumes[i] ?? candle.volume;
      const cvdProxy = cvdProxies[i] ?? 0;

      // Macro context
      const activeEvents = GDELTHistoricalFetcher.getActiveEvents(candle.timestamp, macroEvents);
      const aggregateTone = activeEvents.length > 0
        ? activeEvents.reduce((s, e) => s + e.tone, 0) / activeEvents.length
        : 0;
      const dominantCat = activeEvents.length > 0
        ? mostFrequent(activeEvents.map(e => e.category))
        : null;

      // Price metrics
      const priceChange5m  = candle.open > 0 ? (candle.close - candle.open) / candle.open : 0;
      const priceChange1h  = computePriceChange(candles, i, -OUTCOME_1H);
      const priceChange4h  = computePriceChange(candles, i, -OUTCOME_4H);
      const body      = Math.abs(candle.close - candle.open);
      const upperWick = candle.high - Math.max(candle.open, candle.close);
      const lowerWick = Math.min(candle.open, candle.close) - candle.low;
      const wickRatio = body > 0 ? Math.max(upperWick, lowerWick) / body : 0;

      // Outcome labels (look-forward — only valid for knowledge base, not live)
      const outcome = computeOutcome(candles, i);

      // Market structure from liq (nearest funding already embedded in liq window)
      const structure = buildStructureFromLiq(candle, liq);

      const snapshot: CorrelatedSnapshot = {
        id:        `${exchange}_${symbol}_${candle.timestamp}`,
        timestamp: candle.timestamp,
        symbol,
        exchange,

        price:          candle.close,
        priceChange5m,
        priceChange1h,
        priceChange4h,
        volume5m:       candle.volume,
        volumeRatio:    avgVol > 0 ? candle.volume / avgVol : 1,
        wickRatio,
        cvdProxy,

        liquidations:         liq,
        structure,
        macroEvents:          activeEvents,
        dominantMacroCategory: dominantCat,
        aggregateMacroTone:   aggregateTone,
        outcome,

        embeddingText: buildEmbeddingText(
          candle, priceChange5m, priceChange1h, liq,
          activeEvents, aggregateTone, cvdProxy, outcome,
        ),
      };

      snapshots.push(snapshot);
    }

    return snapshots;
  }
}

// ── Outcome computation (look-forward) ───────────────────────────────────────

function computeOutcome(
  candles: OHLCVBar[],
  idx: number,
): CorrelatedSnapshot['outcome'] {
  const base = candles[idx]!.close;

  const pct = (offset: number) => {
    const c = candles[idx + offset];
    return c ? (c.close - base) / base : 0;
  };

  const slice1h = candles.slice(idx, idx + OUTCOME_1H);
  const maxUp1h   = slice1h.length > 0 ? Math.max(...slice1h.map(c => (c.high  - base) / base)) : 0;
  const maxDown1h = slice1h.length > 0 ? Math.max(...slice1h.map(c => (base  - c.low)  / base)) : 0;

  const change1h = pct(OUTCOME_1H);
  const direction: 'up' | 'down' | 'flat' =
    change1h >  0.005 ? 'up'   :
    change1h < -0.005 ? 'down' :
    'flat';

  return {
    priceChange5m:  pct(OUTCOME_5M),
    priceChange15m: pct(OUTCOME_15M),
    priceChange1h:  change1h,
    priceChange4h:  pct(OUTCOME_4H),
    priceChange1d:  pct(OUTCOME_1D),
    direction,
    maxDrawdown1h:  maxDown1h,
    maxUpside1h:    maxUp1h,
  };
}

// ── Embedding text builder ────────────────────────────────────────────────────

function buildEmbeddingText(
  candle: OHLCVBar,
  priceChange5m: number,
  priceChange1h: number,
  liq: LiquidationWindow,
  macroEvents: ActiveMacroContext[],
  macroTone: number,
  cvdProxy: number,
  outcome: CorrelatedSnapshot['outcome'],
): string {
  const date = new Date(candle.timestamp).toISOString().split('T')[0];
  const liqDesc = liq.totalLiqUsd > SPIKE_USD
    ? `${liq.dominantSide === 'long' ? 'LONG' : 'SHORT'} liquidation ${liq.isCascade ? 'CASCADE' : 'spike'} $${(liq.totalLiqUsd / 1e6).toFixed(0)}M`
    : 'no significant liquidations';

  const macroDesc = macroEvents.length > 0
    ? macroEvents.map(e => `${e.category}(${e.hoursAgo.toFixed(0)}h ago, tone ${e.tone.toFixed(1)})`).join(', ')
    : 'no active macro events';

  const parts = [
    `Date: ${date}  Price: $${candle.close.toLocaleString()}`,
    `5m move: ${pctStr(priceChange5m)}  1h move: ${pctStr(priceChange1h)}`,
    `CVD proxy: ${cvdProxy.toFixed(2)}`,
    `Liquidations: ${liqDesc}`,
    `Macro context: ${macroDesc}  tone: ${macroTone.toFixed(1)}`,
    `Outcome: 5m ${pctStr(outcome.priceChange5m)}  1h ${pctStr(outcome.priceChange1h)}  4h ${pctStr(outcome.priceChange4h)}  direction: ${outcome.direction}`,
    `Max upside 1h: ${pctStr(outcome.maxUpside1h)}  max drawdown 1h: ${pctStr(-outcome.maxDrawdown1h)}`,
  ];

  return parts.join('\n');
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

function buildRollingAvgVolumes(candles: OHLCVBar[], window: number): number[] {
  return candles.map((_, i) => {
    if (i < window) return candles[i]!.volume;
    const slice = candles.slice(i - window, i);
    return slice.reduce((s, c) => s + c.volume, 0) / window;
  });
}

function buildCVDProxies(candles: OHLCVBar[], window: number): number[] {
  // CVD proxy: running sum of (close > open ? +volume : -volume) over window
  const proxies: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    let cvd = 0;
    const start = Math.max(0, i - window);
    for (let j = start; j <= i; j++) {
      const c = candles[j]!;
      cvd += c.close >= c.open ? c.volume : -c.volume;
    }
    proxies.push(cvd);
  }
  return proxies;
}

function computePriceChange(candles: OHLCVBar[], idx: number, offset: number): number {
  const start = idx + offset;
  if (start < 0 || start >= candles.length) return 0;
  const base = candles[start]!.close;
  return base > 0 ? (candles[idx]!.close - base) / base : 0;
}

function buildEmptyLiq(timestamp: number): LiquidationWindow {
  return {
    timestamp, windowMs: 300_000,
    longLiqUsd: 0, shortLiqUsd: 0, totalLiqUsd: 0,
    dominantSide: 'neutral', isCascade: false,
    source: 'synthesized', exchanges: [], confidence: 0,
  };
}

function buildStructureFromLiq(candle: OHLCVBar, _liq: LiquidationWindow): MarketStructure {
  return {
    timestamp:         candle.timestamp,
    fundingRate:       0,  // populated if funding data available
    fundingAnnualized: 0,
    openInterestUsd:   0,
    oiChangePercent1h: 0,
    leverageRatio:     0,
  };
}

function mostFrequent<T>(arr: T[]): T | null {
  if (arr.length === 0) return null;
  const freq = new Map<T, number>();
  for (const v of arr) freq.set(v, (freq.get(v) ?? 0) + 1);
  return [...freq.entries()].sort((a, b) => b[1] - a[1])[0]![0];
}

function pctStr(n: number): string {
  return `${n >= 0 ? '+' : ''}${(n * 100).toFixed(2)}%`;
}
