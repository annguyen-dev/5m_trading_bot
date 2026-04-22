/**
 * PanicDetector — Real-time composite panic/opportunity scoring.
 *
 * Combines signals from:
 *   - GDELT geopolitical events (tone, relevance)
 *   - On-chain snapshots (mempool congestion, whale flows, hash rate)
 *   - CVD + order flow (existing microstructure)
 *   - News RSS sentiment (existing)
 *
 * Scoring (0-10):
 *   0-2   → Normal market, no action
 *   3-4   → Elevated risk, reduce confidence on new signals
 *   5-6   → Moderate panic, consider stop-loss on longs
 *   7-8   → High panic — exit longs, consider short
 *   9-10  → Extreme panic / black swan — emergency exit
 *
 * Crucially, the detector also fires ACCUMULATION signals when:
 *   - Panic score was high but is now dropping (capitulation bottom)
 *   - Whale NET INFLOW turns positive while panic is still elevated (smart money buying)
 *   - GDELT tone starts recovering after extreme negative period
 */

import { EventEmitter } from 'events';
import type { CVDState } from '../types/market.js';
import type { OnChainSnapshot, GDELTEvent, PanicSignal, PanicSource, PanicAction, PanicLevel } from '../types/onchain.js';
import { log } from '../observability/logger.js';
import { getTracer } from '../observability/tracing.js';

// ── Scoring weights ────────────────────────────────────────────────────────────

const WEIGHTS = {
  gdelt:    2.5,   // max contribution to score
  onchain:  3.0,
  cvd:      2.5,
  news:     2.0,
};

// Thresholds
const MEMPOOL_CONGESTION_THRESHOLD = 100_000; // tx count
const FEE_RATE_PANIC_THRESHOLD     = 80;      // sat/vbyte
const WHALE_SELL_DOMINANCE         = 0.65;    // >65% sell volume = whale dump
const CVD_DIVERGENCE_PANIC         = 0.4;     // strong negative divergence
const GDELT_TONE_PANIC             = -5;      // very negative GDELT tone
const GDELT_TONE_EXTREME           = -8;

// ── PanicDetector ─────────────────────────────────────────────────────────────

export class PanicDetector extends EventEmitter {
  private tracer = getTracer('PanicDetector');

  // Rolling state
  private recentGDELTEvents: GDELTEvent[]     = [];
  private lastOnChain: OnChainSnapshot | null = null;
  private lastCVD:     CVDState | null        = null;
  private newsScore    = 0;     // -1 to +1, from NewsService

  // Panic history for trend detection
  private panicHistory: { ts: number; score: number }[] = [];

  // ── State update methods (called by index.ts wiring) ─────────────────────

  onGDELTEvent(evt: GDELTEvent): void {
    const cutoff = Date.now() - 60 * 60_000; // keep last 1h
    this.recentGDELTEvents = this.recentGDELTEvents
      .filter(e => e.timestamp > cutoff)
      .concat(evt);

    this.evaluate('gdelt');
  }

  onOnChainSnapshot(snap: OnChainSnapshot): void {
    this.lastOnChain = snap;
    this.evaluate('onchain');
  }

  onCVD(state: CVDState): void {
    this.lastCVD = state;
    // Don't re-evaluate every CVD tick — too noisy. Evaluated on anomaly trigger.
  }

  onNewsScore(score: number): void {
    this.newsScore = score;
    if (Math.abs(score) > 0.7) this.evaluate('news');
  }

  /** Manual trigger — call after price anomaly */
  evaluateNow(): PanicSignal {
    return this.evaluate('cvd');
  }

  /** Current state snapshot for AI prompt injection */
  currentSummary(): string {
    const signal = this.evaluate('query');
    return formatPanicSummary(signal, this.lastOnChain);
  }

  // ── Core scoring ──────────────────────────────────────────────────────────

  private evaluate(trigger: string): PanicSignal {
    const span = this.tracer.startSpan('PanicDetector.evaluate');
    const sources: PanicSource[] = [];

    // ── 1. GDELT score ──────────────────────────────────────────────────────
    let gdeltScore = 0;
    if (this.recentGDELTEvents.length > 0) {
      const weightedTone = this.recentGDELTEvents.reduce((sum, e) => {
        return sum + e.tone * e.relevance;
      }, 0) / this.recentGDELTEvents.length;

      if (weightedTone < GDELT_TONE_EXTREME) {
        gdeltScore = WEIGHTS.gdelt;
      } else if (weightedTone < GDELT_TONE_PANIC) {
        gdeltScore = WEIGHTS.gdelt * 0.6;
      } else if (weightedTone < -2) {
        gdeltScore = WEIGHTS.gdelt * 0.3;
      }

      if (gdeltScore > 0) {
        sources.push({
          type:   'gdelt',
          weight: gdeltScore,
          detail: `${this.recentGDELTEvents.length} events, avg tone ${weightedTone.toFixed(1)}`,
        });
      }
    }

    // ── 2. On-chain score ───────────────────────────────────────────────────
    let onchainScore = 0;
    if (this.lastOnChain) {
      const oc = this.lastOnChain;
      let sub = 0;

      // Mempool congestion — panic causes fee spike
      if (oc.mempoolFeeRate > FEE_RATE_PANIC_THRESHOLD) sub += 0.4;
      if (oc.mempoolTxCount > MEMPOOL_CONGESTION_THRESHOLD) sub += 0.3;

      // Whale dump
      const whaleTotal = oc.whaleBuyVolume1h + oc.whaleSellVolume1h;
      if (whaleTotal > 0) {
        const sellRatio = oc.whaleSellVolume1h / whaleTotal;
        if (sellRatio > WHALE_SELL_DOMINANCE) sub += 0.3 * ((sellRatio - WHALE_SELL_DOMINANCE) / (1 - WHALE_SELL_DOMINANCE));
      }

      // Hash rate drop = miner panic / capitulation
      // (heuristic: if hash rate is very low relative to typical ~600 EH/s)
      if (oc.hashRate > 0 && oc.hashRate < 400_000) sub += 0.2; // severe miner capitulation

      onchainScore = Math.min(sub, 1.0) * WEIGHTS.onchain;

      if (onchainScore > 0.5) {
        sources.push({
          type:   'onchain',
          weight: onchainScore,
          detail: `fee ${oc.mempoolFeeRate} sat/vb, mempool ${oc.mempoolTxCount} tx, whale net ${oc.whalNetFlow1h.toFixed(1)} BTC`,
        });
      }
    }

    // ── 3. CVD score ────────────────────────────────────────────────────────
    let cvdScore = 0;
    if (this.lastCVD) {
      const div = this.lastCVD.divergence;
      // Negative divergence = price rising but CVD falling = smart money selling into rally
      if (div < -CVD_DIVERGENCE_PANIC) {
        cvdScore = WEIGHTS.cvd * Math.min(Math.abs(div) / 0.8, 1.0);
        sources.push({
          type:   'cvd',
          weight: cvdScore,
          detail: `divergence ${div.toFixed(3)} — bearish order flow vs price`,
        });
      }
    }

    // ── 4. News score ───────────────────────────────────────────────────────
    let newsScore = 0;
    if (this.newsScore < -0.5) {
      newsScore = WEIGHTS.news * Math.min(Math.abs(this.newsScore + 0.5) / 0.5, 1.0);
      sources.push({
        type:   'news',
        weight: newsScore,
        detail: `RSS sentiment ${this.newsScore.toFixed(2)}`,
      });
    }

    const totalScore = Math.min(gdeltScore + onchainScore + cvdScore + newsScore, 10);

    // Track history for trend analysis
    const now = Date.now();
    this.panicHistory.push({ ts: now, score: totalScore });
    if (this.panicHistory.length > 100) this.panicHistory.shift();

    const level   = scoreToLevel(totalScore);
    const action  = scoreToAction(totalScore, this.panicHistory, this.lastOnChain);
    const description = buildDescription(totalScore, level, action, sources, this.lastOnChain);

    const signal: PanicSignal = {
      timestamp: now,
      level,
      score: totalScore,
      sources,
      action,
      description,
    };

    if (totalScore >= 3 && trigger !== 'query') {
      log('warn', 'PanicDetector signal', {
        score:   totalScore.toFixed(1),
        level,
        action,
        trigger,
      });
      this.emit('panicSignal', signal);
    }

    span.end();
    return signal;
  }
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

function scoreToLevel(score: number): PanicLevel {
  if (score >= 9) return 'extreme';
  if (score >= 7) return 'high';
  if (score >= 5) return 'medium';
  if (score >= 3) return 'low';
  return 'none';
}

function scoreToAction(
  score: number,
  history: { ts: number; score: number }[],
  onchain: OnChainSnapshot | null,
): PanicAction {
  // Check for capitulation bottom: score was high, now dropping + whales buying
  if (history.length >= 5) {
    const prev5 = history.slice(-5);
    const peak  = Math.max(...prev5.map(h => h.score));
    const trend = prev5[prev5.length - 1]!.score - prev5[0]!.score;
    const whaleAccumulating = (onchain?.whalNetFlow1h ?? 0) > 20; // whale net buy > 20 BTC

    if (peak >= 6 && trend < -1.5 && whaleAccumulating) {
      // Panic peaked, now easing, whales buying = potential reversal opportunity
      return 'REVERSE_SHORT'; // actually signals accumulation opportunity (SELL → BUY reversal)
    }
  }

  if (score >= 9) return 'EMERGENCY_EXIT';
  if (score >= 7) return 'REVERSE_SHORT';
  if (score >= 5) return 'STOP_LOSS';
  if (score >= 3) return 'REDUCE_CONFIDENCE';
  return 'HOLD';
}

function buildDescription(
  score: number,
  level: PanicLevel,
  action: PanicAction,
  sources: PanicSource[],
  onchain: OnChainSnapshot | null,
): string {
  const parts: string[] = [`Panic level: ${level.toUpperCase()} (score ${score.toFixed(1)}/10)`];

  if (sources.length > 0) {
    parts.push(`Triggers: ${sources.map(s => `${s.type}(${s.weight.toFixed(1)})`).join(', ')}`);
  }

  const actionDescriptions: Record<PanicAction, string> = {
    HOLD:               'No action required — normal market conditions.',
    REDUCE_CONFIDENCE:  'Elevated risk — reduce confidence on new BUY signals.',
    STOP_LOSS:          'Moderate panic — consider closing long positions.',
    REVERSE_SHORT:      score > 6
      ? 'High panic — exit longs, evidence supports short position.'
      : 'Possible capitulation bottom — smart money accumulating, consider reversing to BUY.',
    EMERGENCY_EXIT:     'EXTREME PANIC — emergency exit all positions immediately.',
  };

  parts.push(`Recommended action: ${actionDescriptions[action]}`);

  if (onchain) {
    parts.push(
      `On-chain: mempool ${onchain.mempoolTxCount} tx @ ${onchain.mempoolFeeRate} sat/vb` +
      ` | whale net ${onchain.whalNetFlow1h.toFixed(1)} BTC/1h`,
    );
  }

  return parts.join('\n');
}

function formatPanicSummary(signal: PanicSignal, onchain: OnChainSnapshot | null): string {
  if (signal.level === 'none') {
    return '## Market Stress Indicators\nNo panic signals detected. Normal market conditions.';
  }

  const lines = [
    `## Market Stress Indicators [${signal.level.toUpperCase()} — score ${signal.score.toFixed(1)}/10]`,
    signal.description,
  ];

  if (onchain) {
    lines.push('');
    lines.push('### On-Chain State');
    lines.push(`- Mempool: ${onchain.mempoolTxCount.toLocaleString()} pending tx @ ${onchain.mempoolFeeRate} sat/vbyte`);
    lines.push(`- Whale activity (1h): bought ${onchain.whaleBuyVolume1h.toFixed(1)} BTC / sold ${onchain.whaleSellVolume1h.toFixed(1)} BTC`);
    lines.push(`- Whale net flow: ${onchain.whalNetFlow1h > 0 ? '+' : ''}${onchain.whalNetFlow1h.toFixed(1)} BTC (${onchain.whalNetFlow1h > 0 ? 'accumulation' : 'distribution'})`);
  }

  return lines.join('\n');
}
