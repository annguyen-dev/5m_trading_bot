export type MMTrapType = 'BULL_TRAP' | 'BEAR_TRAP' | 'MM_BOT' | 'SPOOF' | 'NONE';

export interface MMTrapResult {
  detected: boolean;
  type: MMTrapType;
  detail: string;
}
