/**
 * LiquidationSynthesizer
 *
 * Derives liquidation proxy signals from OHLCV + funding rate + OI.
 * Used when real liquidation data is unavailable (historical periods).
 *
 * Detection logic (each adds to confidence):
 *
 * LONG LIQUIDATION signals:
 *   - Sharp down candle (close < open by > 0.5%) with long upper wick
 *   - Volume spike > 2x 20-period avg
 *   - Funding rate was positive (longs over-leveraged) before the move
 *   - OI drops sharply (positions force-closed)
 *
 * SHORT LIQUIDATION signals:
 *   - Sharp up candle with long lower wick
 *   - Volume spike
 *   - Funding rate was negative (shorts over-leveraged)
 *   - OI drops
 *
 * CASCADE detection:
 *   - Multiple consecutive liq windows each scoring > threshold
 *   - Total USD estimate exceeds cascade threshold
 */

import type { OHLCVBar, MarketStructure, LiquidationWindow } from '../types/knowledge.js';

// Tuning constants
const VOLUME_SPIKE_MULTIPLIER  = 2.0;    // vs rolling avg
const VOLUME_AVG_PERIOD        = 20;     // candles
const PRICE_MOVE_THRESHOLD     = 0.005;  // 0.5% per 5m candle
const WICK_RATIO_THRESHOLD     = 1.5;    // wick > 1.5x body
const FUNDING_HIGH_THRESHOLD   = 0.0003; // 0.03% per 8h (annualized ~32%)
const FUNDING_LOW_THRESHOLD    = -0.0001;
const OI_DROP_THRESHOLD        = -0.02;  // -2% OI in 1h
const CASCADE_USD_THRESHOLD    = 50_000_000;  // $50M total in window = cascade
const SYNTHETIC_USD_PER_UNIT   = 10_000_000;  // rough $10M per signal unit

export class LiquidationSynthesizer {
  /**
   * For each 5m candle, compute a LiquidationWindow.
   * Requires the full candle array for volume averaging.
   */
  synthesize(
    candles: OHLCVBar[],
    funding: MarketStructure[],
  ): Map<number, LiquidationWindow> {
    const result = new Map<number, LiquidationWindow>();
    const fundingIndex = buildFundingIndex(funding);

    for (let i = VOLUME_AVG_PERIOD; i < candles.length; i++) {
      const candle  = candles[i]!;
      const window  = computeLiqWindow(candle, candles, i, fundingIndex);
      result.set(candle.timestamp, window);
    }

    // Second pass: mark cascades
    this.markCascades(candles, result);

    return result;
  }

  private markCascades(
    candles: OHLCVBar[],
    result: Map<number, LiquidationWindow>,
  ): void {
    // Rolling 3-candle window (15 min)
    for (let i = 2; i < candles.length; i++) {
      const w0 = result.get(candles[i - 2]!.timestamp);
      const w1 = result.get(candles[i - 1]!.timestamp);
      const w2 = result.get(candles[i]!.timestamp);
      if (!w0 || !w1 || !w2) continue;

      const rolling = w0.totalLiqUsd + w1.totalLiqUsd + w2.totalLiqUsd;

      if (rolling >= CASCADE_USD_THRESHOLD) {
        // Mark all three as cascade
        w0.isCascade = true;
        w1.isCascade = true;
        w2.isCascade = true;
      }
    }
  }
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

function computeLiqWindow(
  candle: OHLCVBar,
  candles: OHLCVBar[],
  idx: number,
  fundingIndex: Map<number, MarketStructure>,
): LiquidationWindow {
  const body      = Math.abs(candle.close - candle.open);
  const upperWick = candle.high - Math.max(candle.open, candle.close);
  const lowerWick = Math.min(candle.open, candle.close) - candle.low;
  const range     = candle.high - candle.low;

  const priceChange = candle.open > 0 ? (candle.close - candle.open) / candle.open : 0;
  const wickRatio   = body > 0 ? Math.max(upperWick, lowerWick) / body : 0;

  // Volume spike
  const recentVols  = candles.slice(idx - VOLUME_AVG_PERIOD, idx).map(c => c.volume);
  const avgVolume   = recentVols.reduce((a, b) => a + b, 0) / recentVols.length;
  const volSpike    = avgVolume > 0 ? candle.volume / avgVolume : 1;

  // Nearest funding record
  const nearestFunding = findNearestFunding(candle.timestamp, fundingIndex);
  const fundingRate    = nearestFunding?.fundingRate ?? 0;
  const oiChange       = nearestFunding?.oiChangePercent1h ?? 0;

  // ── Long liquidation score ──────────────────────────────────────────────
  let longLiqScore = 0;
  if (priceChange < -PRICE_MOVE_THRESHOLD)      longLiqScore += 2.0;  // sharp down move
  if (upperWick > lowerWick && range > 0 &&
      upperWick / range > 0.3)                  longLiqScore += 1.5;  // upper wick dominant
  if (wickRatio > WICK_RATIO_THRESHOLD)         longLiqScore += 1.0;
  if (volSpike > VOLUME_SPIKE_MULTIPLIER)       longLiqScore += 1.5;
  if (fundingRate > FUNDING_HIGH_THRESHOLD)     longLiqScore += 1.5;  // longs over-leveraged
  if (oiChange < OI_DROP_THRESHOLD)            longLiqScore += 1.0;  // OI dropping = forced closes

  // ── Short liquidation score ─────────────────────────────────────────────
  let shortLiqScore = 0;
  if (priceChange > PRICE_MOVE_THRESHOLD)       shortLiqScore += 2.0;  // sharp up move
  if (lowerWick > upperWick && range > 0 &&
      lowerWick / range > 0.3)                  shortLiqScore += 1.5;  // lower wick dominant
  if (wickRatio > WICK_RATIO_THRESHOLD)         shortLiqScore += 1.0;
  if (volSpike > VOLUME_SPIKE_MULTIPLIER)       shortLiqScore += 1.5;
  if (fundingRate < FUNDING_LOW_THRESHOLD)      shortLiqScore += 1.5;  // shorts over-leveraged
  if (oiChange < OI_DROP_THRESHOLD)            shortLiqScore += 1.0;

  // Normalize scores to USD estimates
  // Max score ~8.5 → ~$85M (rough calibration vs Coinglass data)
  const longLiqUsd  = Math.max(0, longLiqScore)  * SYNTHETIC_USD_PER_UNIT;
  const shortLiqUsd = Math.max(0, shortLiqScore) * SYNTHETIC_USD_PER_UNIT;
  const totalLiqUsd = longLiqUsd + shortLiqUsd;

  let dominantSide: 'long' | 'short' | 'neutral' = 'neutral';
  if (longLiqUsd > shortLiqUsd * 1.5)       dominantSide = 'long';
  else if (shortLiqUsd > longLiqUsd * 1.5)  dominantSide = 'short';

  // Confidence: how many independent signals agree
  const indicators = [
    priceChange < -PRICE_MOVE_THRESHOLD || priceChange > PRICE_MOVE_THRESHOLD,
    volSpike > VOLUME_SPIKE_MULTIPLIER,
    wickRatio > WICK_RATIO_THRESHOLD,
    Math.abs(fundingRate) > FUNDING_HIGH_THRESHOLD,
    oiChange < OI_DROP_THRESHOLD,
  ].filter(Boolean).length;
  const confidence = Math.min(indicators / 4, 1.0); // max 1.0 at 4+ indicators

  return {
    timestamp:    candle.timestamp,
    windowMs:     5 * 60_000,
    longLiqUsd,
    shortLiqUsd,
    totalLiqUsd,
    dominantSide,
    isCascade:    false, // set in second pass
    source:       'synthesized',
    exchanges:    [],
    confidence,
  };
}

function buildFundingIndex(funding: MarketStructure[]): Map<number, MarketStructure> {
  const map = new Map<number, MarketStructure>();
  for (const f of funding) map.set(f.timestamp, f);
  return map;
}

function findNearestFunding(
  timestamp: number,
  index: Map<number, MarketStructure>,
): MarketStructure | null {
  // Funding is every 8h — find nearest within 4h window
  const windowMs = 4 * 60 * 60_000;
  let best: MarketStructure | null = null;
  let bestDiff = Infinity;

  for (const [ts, f] of index) {
    const diff = Math.abs(ts - timestamp);
    if (diff < windowMs && diff < bestDiff) {
      bestDiff = diff;
      best = f;
    }
  }

  return best;
}
