// Pure TypeScript types — no runtime dependencies.
// The backend has its own Zod schemas that validate against these types.

export type Horizon = 'scale' | 'short' | 'mid' | 'long';
export type SignalDirection = 'BUY' | 'SELL' | 'HOLD';

export interface Signal {
  id: string;
  timestamp: number;
  horizon: Horizon;
  asset: string;
  direction: SignalDirection;
  confidence: number;
  priceTarget?: number;
  stopLoss?: number;
  rationale: string;
  mmTrapFlag: boolean;
  mmTrapType: 'BULL_TRAP' | 'BEAR_TRAP' | 'MM_BOT' | 'SPOOF' | 'NONE';
  engine: 'statistical' | 'claude';
  metadata?: Record<string, unknown>;
}
