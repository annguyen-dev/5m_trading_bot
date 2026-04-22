import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { AISignalOutputSchema, AISignalOutput, Horizon } from '../types/signal.js';
import { config } from '../config/index.js';
import { getTracer } from '../observability/tracing.js';
import { getApiLatencyHistogram } from '../observability/metrics.js';
import { log } from '../observability/logger.js';

const SYSTEM_PROMPT = `You are a professional quantitative crypto trading analyst specialising in BTC/USDT.

Your edge comes from combining three analytical layers:
1. **Market microstructure** — CVD, order flow, MM trap detection
2. **Past signal patterns** — similar situations from your signal history (RAG)
3. **Macro & geopolitical context** — how historical political/economic events caused BTC to react, including the typical LAG before price fully reflected those events

Key reasoning principles:
- Events have a LAG before price fully reflects them. A Fed rate decision may take 3 days to fully price in.
  If the lag is longer than your signal horizon, lower your confidence — the market may not have reacted yet.
- "Sell the news" pattern: bullish events (ETF approval, adoption) often cause an immediate pump then reversal.
  Check the d3/d7 reaction data — if it contradicts h1/h4, flag this divergence.
- Black swans have IMMEDIATE reflection (h1-h4). Macro/liquidity events take weeks to months.
- If MM trap is detected, heavily discount directional confidence regardless of macro context.
- Never be overconfident. Calibrate confidence to genuine uncertainty.

Respond ONLY with valid JSON. No prose outside the JSON.`;

function buildHumanPrompt(input: AIServiceInput): string {
  return `## Current Market State
- Asset:      ${input.asset}
- Horizon:    ${input.horizon}
- Price:      $${input.price.toLocaleString()}
- CVD:        ${input.cvd.toFixed(4)}
- Divergence: ${input.divergence.toFixed(4)}  (price vs order flow direction gap)

## Trend Context ← CRITICAL: read this before deciding direction
${input.trendContext
  ? `- Trend:     ${input.trendContext.trend.toUpperCase()} (24h: ${(input.trendContext.change24h * 100).toFixed(1)}%, 7d: ${(input.trendContext.change7d * 100).toFixed(1)}%)
- 20-EMA:    $${input.trendContext.ema20.toLocaleString()}
- Deviation: ${(input.trendContext.deviationFromEma * 100).toFixed(2)}% from EMA

TREND BIAS RULE:
  • UPTREND   → price dips below EMA = BUY opportunity (buy the dip), not a SELL signal
  • DOWNTREND → price bounces above EMA = SELL opportunity (sell the rip), not a BUY signal
  • SIDEWAYS  → mean-reversion logic applies in both directions`
  : '- Trend data not available'}

## Triggering Event
${input.event}

## Market Maker Trap Status
${input.mmTrapStatus}

${input.panicContext ? input.panicContext + '\n' : ''}
## Historical Context (RAG)
${input.historicalContext || 'No historical context available.'}

## Signal Generation Task
Generate a **${input.horizon}-term** trading signal for ${input.asset}.

Horizon guidelines:
- scale (5 min):     Streak reversal scalp. Bet against the streak direction. High frequency, tiny moves.
- short (10-30 min): Momentum, immediate sentiment, scalp entries.
- mid  (1-2 weeks):  Mean reversion or trend continuation swing.
- long (months):     Macro thesis, accumulation.

Consider:
- **Trend bias is the most important factor.** Do NOT SELL in a confirmed UPTREND unless there is an exceptional reason.
- Does the macro lag analysis suggest this event is already priced in?
- Is there a "sell the news" or "buy the rumour" pattern from past similar events?

Respond with JSON only:
{
  "direction": "BUY" | "SELL" | "HOLD",
  "confidence": <0.0-1.0>,
  "priceTarget": <number or null>,
  "stopLoss": <number or null>,
  "rationale": "<one sentence — must mention trend direction and key reason>"
}`;
}

export interface TrendContext {
  trend:           'uptrend' | 'downtrend' | 'sideways';
  change24h:       number;   // fraction, e.g. 0.05 = +5%
  change7d:        number;
  ema20:           number;
  deviationFromEma: number;  // (price - ema) / ema
}

export interface AIServiceInput {
  asset: string;
  horizon: Horizon;
  price: number;
  cvd: number;
  divergence: number;
  event: string;
  historicalContext: string;
  mmTrapStatus: string;
  trendContext?: TrendContext;
  panicContext?: string;
  // Optional candle shape features (used by StatisticalSignalService for richer k-NN)
  volumeRatio?: number;  // current vol / 20-period avg vol
  wickRatio?: number;    // upper+lower wick / total range (0–1)
  streak1m?: number;     // signed: +N = N consecutive up 1m candles, -N = N consecutive down
  streak5m?: number;     // signed: same for 5m candles
  brokeLiq?: boolean;    // true if current candle wick pierced a major liquidity level
}

export class AIService {
  private client: Anthropic;
  private tracer = getTracer('AIService');
  private latency = getApiLatencyHistogram();

  constructor(private readonly model = 'claude-sonnet-4-6') {
    this.client = new Anthropic({ apiKey: config.anthropicApiKey });
  }

  async reason(input: AIServiceInput): Promise<AISignalOutput> {
    const span = this.tracer.startSpan('AIService.reason');
    span.setAttributes({
      'ai.model':   this.model,
      'ai.asset':   input.asset,
      'ai.horizon': input.horizon,
      'ai.price':   input.price,
    });

    const t0 = Date.now();
    try {
      const message = await this.client.messages.create({
        model: this.model,
        max_tokens: 512,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildHumanPrompt(input) }],
      });

      const elapsed = Date.now() - t0;
      this.latency.record(elapsed, { endpoint: 'anthropic_chat' });

      const text = message.content
        .filter(b => b.type === 'text')
        .map(b => (b as Anthropic.TextBlock).text)
        .join('');

      // Extract JSON from response (may be wrapped in ```json ... ```)
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error(`No JSON in Claude response: ${text}`);

      const parsed = AISignalOutputSchema.parse(JSON.parse(jsonMatch[0]));

      log('debug', 'AIService.reason completed', {
        model: this.model,
        horizon: input.horizon,
        direction: parsed.direction,
        confidence: parsed.confidence,
        latencyMs: elapsed,
      });

      return parsed;
    } catch (err) {
      span.recordException(err as Error);
      log('error', 'AIService.reason failed', { error: String(err) });
      throw err;
    } finally {
      span.end();
    }
  }
}
