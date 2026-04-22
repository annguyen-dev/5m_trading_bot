/**
 * LagAnalyzer
 *
 * Given a set of macro events (from MacroEventStore), computes per-category:
 *   - Median/avg hours until price fully reflected the event
 *   - Which time horizon (h1/h4/h24/d3/d7/d30) shows the strongest reaction
 *   - Bullish rate (% of events bullish for BTC)
 *   - A human-readable pattern summary for AI context injection
 *
 * This lets the AI reason: "Current event is 'regulatory' category.
 * Historically, regulatory events take ~48h to fully price in.
 * The signal I'm generating is SHORT horizon — the event may not yet be reflected."
 */

import type { MacroEvent, MacroEventCategory, CategoryLagStats, PriceReaction } from '../types/macro.js';

const REACTION_KEYS: (keyof PriceReaction)[] = ['h1', 'h4', 'h24', 'd3', 'd7', 'd30'];

const REACTION_LABELS: Record<keyof PriceReaction, string> = {
  h1:  '1 hour',
  h4:  '4 hours',
  h24: '1 day',
  d3:  '3 days',
  d7:  '7 days',
  d30: '30 days',
};

export class LagAnalyzer {
  /**
   * Compute lag statistics for all categories present in the provided events.
   */
  computeStats(events: MacroEvent[]): Map<MacroEventCategory, CategoryLagStats> {
    const byCategory = groupBy(events, e => e.category);
    const stats = new Map<MacroEventCategory, CategoryLagStats>();

    for (const [category, evts] of byCategory) {
      stats.set(category, this.computeCategoryStats(category, evts));
    }

    return stats;
  }

  /**
   * Given similar historical events found via RAG, produce a concise
   * natural-language summary suitable for injecting into the AI prompt.
   */
  summarizeForPrompt(events: MacroEvent[]): string {
    if (events.length === 0) return 'No similar macro events found in historical database.';

    const stats = this.computeStats(events);
    const lines: string[] = [];

    lines.push(`## Historical Macro Context (${events.length} similar events found)`);
    lines.push('');

    // Individual events
    for (const evt of events.slice(0, 3)) {
      const r = evt.reaction;
      lines.push(
        `• [${evt.date}] ${evt.title}` +
        `  →  1d: ${sign(r.h24)}%  7d: ${sign(r.d7)}%  30d: ${sign(r.d30)}%` +
        `  |  lag: ${evt.lagHours}h  |  impact: ${evt.impact}`,
      );
    }

    lines.push('');
    lines.push('## Pattern Analysis by Category');
    lines.push('');

    for (const [, s] of stats) {
      lines.push(
        `**${s.category}** (n=${s.sampleSize}): ` +
        `median lag ${s.medianLagHours}h to fully price in. ` +
        `Strongest reaction at ${REACTION_LABELS[s.strongestHorizon]} ` +
        `(avg ${sign(s.avgMoveAtPeak)}%). ` +
        `Bullish for BTC ${(s.bullishRate * 100).toFixed(0)}% of the time.`,
      );
      lines.push(`  Pattern: ${s.typicalPattern}`);
    }

    return lines.join('\n');
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private computeCategoryStats(
    category: MacroEventCategory,
    events: MacroEvent[],
  ): CategoryLagStats {
    const lagValues = events.map(e => e.lagHours).sort((a, b) => a - b);
    const medianLag = median(lagValues);
    const avgLag    = avg(lagValues);

    // Find horizon with highest avg absolute % move
    let strongestHorizon: keyof PriceReaction = 'h24';
    let maxAvgMove = 0;
    for (const key of REACTION_KEYS) {
      const moves = events.map(e => Math.abs(e.reaction[key]));
      const avgMove = avg(moves);
      if (avgMove > maxAvgMove) {
        maxAvgMove = avgMove;
        strongestHorizon = key;
      }
    }

    const bullishRate = events.filter(e => e.impact === 'positive').length / events.length;

    return {
      category,
      sampleSize:       events.length,
      medianLagHours:   medianLag,
      avgLagHours:      avgLag,
      strongestHorizon,
      avgMoveAtPeak:    maxAvgMove,
      bullishRate,
      typicalPattern:   buildTypicalPattern(category, medianLag, bullishRate, strongestHorizon, maxAvgMove),
    };
  }
}

// ── Pattern narrative builder ─────────────────────────────────────────────────

function buildTypicalPattern(
  category: MacroEventCategory,
  medianLag: number,
  bullishRate: number,
  horizon: keyof PriceReaction,
  avgMove: number,
): string {
  const sentiment = bullishRate >= 0.6 ? 'usually bullish' :
                    bullishRate <= 0.4 ? 'usually bearish' :
                    'mixed (context-dependent)';

  const lagDesc = medianLag <= 4   ? 'immediate (within hours)' :
                  medianLag <= 48  ? 'short-term (1-2 days)' :
                  medianLag <= 168 ? 'medium-term (3-7 days)' :
                  medianLag <= 720 ? 'long-term (weeks)' :
                  'very long-term (months)';

  const templates: Record<MacroEventCategory, string> = {
    fed_rate:
      `Fed rate decisions are ${sentiment} for BTC. Price reflection is ${lagDesc}. ` +
      `Watch for risk-on/off regime shift. Rate cuts → liquidity expansion → bullish. ` +
      `Rate hikes → liquidity contraction → bearish. Strongest signal at ${REACTION_LABELS[horizon]}.`,

    inflation:
      `Inflation prints are ${sentiment}. Market reaction is ${lagDesc}. ` +
      `Hot CPI → more hikes expected → bearish. Cool CPI → pivot hopes → bullish. ` +
      `Initial spike often reverses as market recalibrates rate expectations.`,

    regulatory:
      `Regulatory events are ${sentiment} for BTC. Reflection is ${lagDesc}. ` +
      `Approvals (ETF) → institutional inflows → bullish but often "sell the news". ` +
      `Bans/enforcement → short-term panic, often recovers. DYOR on jurisdiction scope.`,

    adoption:
      `Adoption events are ${sentiment}. Price reflection is ${lagDesc}. ` +
      `Corporate treasury buys signal conviction. Country adoption = bullish long-term. ` +
      `Short-term reaction can be "sell the news" after initial pump.`,

    black_swan:
      `Black swan events are ${sentiment}. Initial reaction is ${lagDesc}. ` +
      `CRITICAL: Black swans cause immediate sharp drops (h1-h4) then diverge based on nature. ` +
      `Systemic crypto failures (FTX, Luna) → prolonged bear. ` +
      `External macro shocks (COVID, banking) → short dump then BTC as safe haven.`,

    halving:
      `Bitcoin halvings are ${sentiment} long-term. Immediate price reaction is minimal. ` +
      `Full reflection takes months (${lagDesc}). ` +
      `Supply shock thesis plays out 6-12 months post-halving. ` +
      `Short-term signals around halving are noise; long-term trend is structural bull.`,

    macro_liquidity:
      `Macro liquidity events are ${sentiment}. BTC is highly correlated with global M2. ` +
      `QE/rate cuts → risk-on, dollar weak → BTC bullish. ` +
      `QT/liquidity drain → risk-off, dollar strong (DXY ↑) → BTC bearish. ` +
      `Reflection is ${lagDesc}. Global M2 leads BTC by ~12 weeks historically.`,

    geopolitical:
      `Geopolitical events are ${sentiment}. Initial reaction is ${lagDesc}. ` +
      `Initial risk-off panic is common. Then BTC often recovers as censorship-resistant ` +
      `store of value narrative emerges. Strongest move at ${REACTION_LABELS[horizon]} (avg ${sign(avgMove)}%).`,
  };

  return templates[category] ??
    `${category} events: ${sentiment}, reflection ${lagDesc}, avg move ${sign(avgMove)}% at ${REACTION_LABELS[horizon]}.`;
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

function groupBy<T, K extends string>(arr: T[], key: (t: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of arr) {
    const k = key(item);
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(item);
  }
  return map;
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1]! + sorted[mid]!) / 2)
    : sorted[mid]!;
}

function avg(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function sign(n: number): string {
  return n >= 0 ? `+${n.toFixed(1)}` : n.toFixed(1);
}
