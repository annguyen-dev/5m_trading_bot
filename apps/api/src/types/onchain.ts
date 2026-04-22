export interface OnChainSnapshot {
  timestamp: number;

  // Exchange flows (positive = inflow to exchanges = sell pressure)
  exchangeInflow24h:   number;   // BTC moving TO exchanges (last 24h estimate)
  exchangeNetFlow:     number;   // positive = net inflow, negative = net outflow

  // Mempool (congestion = panic / high activity)
  mempoolTxCount:      number;
  mempoolFeeRate:      number;   // sat/vbyte — spike = urgency
  blockConfirmTime:    number;   // minutes for next confirmation estimate

  // Whale activity (from trade stream analysis)
  whaleTradeCount1h:   number;   // trades > WHALE_THRESHOLD in last 1h
  whaleBuyVolume1h:    number;   // BTC volume from whale buys
  whaleSellVolume1h:   number;   // BTC volume from whale sells
  whalNetFlow1h:       number;   // positive = whale accumulation

  // Basic BTC network health
  hashRate:            number;   // TH/s — drop = miner capitulation signal
  difficulty:          number;

  // Derived signals
  panicScore:          number;   // 0-10 composite score
}

export type PanicLevel = 'none' | 'low' | 'medium' | 'high' | 'extreme';

export interface PanicSignal {
  timestamp:   number;
  level:       PanicLevel;
  score:       number;           // 0-10
  sources:     PanicSource[];    // what triggered it
  action:      PanicAction;
  description: string;
}

export interface PanicSource {
  type:    'gdelt' | 'onchain' | 'cvd' | 'news' | 'whale';
  weight:  number;               // contribution to total score
  detail:  string;
}

export type PanicAction =
  | 'HOLD'                       // score < 3, no action
  | 'REDUCE_CONFIDENCE'          // score 3-5, lower confidence on new signals
  | 'STOP_LOSS'                  // score 5-7, exit long positions
  | 'REVERSE_SHORT'              // score 7-9, flip to SELL
  | 'EMERGENCY_EXIT';            // score 9-10, exit everything immediately

export interface GDELTEvent {
  timestamp:   number;
  title:       string;
  url:         string;
  tone:        number;           // GDELT AvgTone: negative = bad news
  goldstein:   number;           // GDELT GoldsteinScale: -10 to +10
  eventCode:   string;           // GDELT CAMEO event code
  actors:      string[];
  relevance:   number;           // 0-1 relevance to BTC/crypto
}
