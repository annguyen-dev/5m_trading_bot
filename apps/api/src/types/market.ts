export interface Trade {
  id: string;
  timestamp: number;   // Unix ms
  price: number;
  amount: number;      // Base asset (BTC)
  side: 'buy' | 'sell';
}

export interface Candle {
  timestamp: number;   // Unix ms, open time
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// [price, size] tuples sorted best-first
export interface OrderBookSnapshot {
  timestamp: number;
  bids: [number, number][];
  asks: [number, number][];
}

export interface CVDState {
  cvd: number;              // Running cumulative volume delta
  price: number;            // Last trade price
  divergence: number;       // Normalised divergence score (-1 to 1)
  windowTrades: Trade[];    // Trades in the current rolling window
}
