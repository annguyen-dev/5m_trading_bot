/**
 * MockAIService — rule-based signal generator for backtesting.
 *
 * Replaces the real AIService (which calls OpenAI) so backtests:
 *   1. Run offline with no API cost
 *   2. Are fully deterministic and reproducible
 *   3. Test the MM detection and pipeline logic, not the LLM
 *
 * Rules (transparent and inspectable):
 *   BUY:  CVD positive (more buying pressure) + price above EMA
 *   SELL: CVD negative (more selling pressure) + price below EMA
 *   HOLD: mixed signals or weak CVD
 *
 * Confidence is proportional to the strength of both signals.
 */

import type { AISignalOutput } from '../types/signal.js';
import type { AIServiceInput } from '../services/AIService.js';

export class MockAIService {
  async reason(input: AIServiceInput): Promise<AISignalOutput> {
    const cvdSignal = Math.sign(input.cvd);              // +1, -1, 0
    const divergence = input.divergence;

    // Simple rule: direction based on CVD sign, dampened by divergence
    // High divergence = opposing forces → lower confidence
    const rawConf = Math.min(1, Math.abs(input.cvd) / 500); // saturates at cvd=500
    const divergencePenalty = Math.abs(divergence) * 0.3;
    const confidence = Math.max(0.1, Math.min(0.9, rawConf - divergencePenalty));

    let direction: 'BUY' | 'SELL' | 'HOLD';
    if (confidence < 0.25 || cvdSignal === 0) {
      direction = 'HOLD';
    } else if (cvdSignal > 0) {
      direction = 'BUY';
    } else {
      direction = 'SELL';
    }

    const price = input.price;

    const rationale = [
      `CVD=${input.cvd.toFixed(2)} (${cvdSignal > 0 ? 'bullish' : cvdSignal < 0 ? 'bearish' : 'neutral'})`,
      `divergence=${input.divergence.toFixed(4)}`,
      `horizon=${input.horizon}`,
      input.mmTrapStatus !== 'No MM trap detected.' ? `[MM: ${input.mmTrapStatus}]` : '',
    ]
      .filter(Boolean)
      .join(' | ');

    return {
      direction,
      confidence,
      priceTarget:
        direction === 'BUY'
          ? parseFloat((price * (1 + 0.02 * confidence)).toFixed(2))
          : direction === 'SELL'
            ? parseFloat((price * (1 - 0.02 * confidence)).toFixed(2))
            : undefined,
      stopLoss:
        direction === 'BUY'
          ? parseFloat((price * (1 - 0.01)).toFixed(2))
          : direction === 'SELL'
            ? parseFloat((price * (1 + 0.01)).toFixed(2))
            : undefined,
      rationale,
    };
  }
}
