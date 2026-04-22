import { z } from 'zod';
import { MMTrapType } from './mm.js';

export type Horizon = 'scale' | 'short' | 'mid' | 'long';
export type SignalDirection = 'BUY' | 'SELL' | 'HOLD';

export const SignalSchema = z.object({
  id: z.string().uuid(),
  timestamp: z.number(),
  horizon: z.enum(['scale', 'short', 'mid', 'long']),
  asset: z.string(),
  direction: z.enum(['BUY', 'SELL', 'HOLD']),
  confidence: z.number().min(0).max(1),
  priceTarget: z.number().optional(),
  stopLoss: z.number().optional(),
  rationale: z.string(),
  mmTrapFlag: z.boolean(),
  mmTrapType: z.enum(['BULL_TRAP', 'BEAR_TRAP', 'MM_BOT', 'SPOOF', 'NONE']),
  // Which engine produced this signal
  engine: z.enum(['statistical', 'claude']),
  // Execution mode: 'auto' = confidence met threshold, bot trades automatically.
  //                 'manual' = below threshold, flagged for human review.
  status: z.enum(['auto', 'manual']).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type Signal = z.infer<typeof SignalSchema>;

// The structured output we ask the LLM to return
export const AISignalOutputSchema = z.object({
  direction: z.enum(['BUY', 'SELL', 'HOLD']),
  // scale signals also carry the streak that triggered them
  streakCount: z.number().optional(),
  confidence: z.number().min(0).max(1),
  // 'auto' = confidence met threshold; 'manual' = below threshold, flagged for review.
  status: z.enum(['auto', 'manual']).optional(),
  priceTarget: z.number().optional(),
  stopLoss: z.number().optional(),
  rationale: z.string().max(600),
});
export type AISignalOutput = z.infer<typeof AISignalOutputSchema>;
