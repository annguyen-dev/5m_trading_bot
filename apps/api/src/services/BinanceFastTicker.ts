/**
 * src/services/BinanceFastTicker.ts
 *
 * Lightweight WebSocket client for Binance SPOT BTC/USDT, exposing sub-second
 * last-trade prices via the public `aggTrade` stream.
 *
 * Used by LiveTradingEngine for the live BTC price displayed on the Live page.
 * SPOT is used (not perpetual futures) because Polymarket's BTC 5m markets
 * settle from Chainlink BTC/USD which aggregates spot exchanges — perp basis
 * (typically 0.05-0.15% off spot due to funding) makes the displayed price
 * visibly diverge from polymarket.com.
 *
 * Note: FutureTickScanner stays on PERP — it captures funding-sensitive
 * metrics (vol_spike_z, OB imbalance) used as signal inputs, where perp data
 * is the right source.
 *
 * Endpoint: wss://stream.binance.com:9443/ws/btcusdt@aggTrade
 *
 * Emits:
 *   'tick' ({ price: number, ts: number }) — every aggregated trade (~1-10/s)
 */

import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { log } from '../observability/logger.js';

const WS_URL = 'wss://stream.binance.com:9443/ws/btcusdt@aggTrade';
const RECONNECT_MS = 2000;

export interface FastTick {
  price: number;
  ts:    number;
}

interface AggTrade {
  e: 'aggTrade';
  p: string;
  T: number;
}

export class BinanceFastTicker extends EventEmitter {
  private ws: WebSocket | null = null;
  private running = false;

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    log('info', 'BinanceFastTicker starting');
    void this.loop();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    log('info', 'BinanceFastTicker stopped');
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        await this.runOnce();
      } catch (err) {
        log('warn', 'BinanceFastTicker WS threw', { error: String(err) });
      }
      if (this.running) await sleep(RECONNECT_MS);
    }
  }

  private runOnce(): Promise<void> {
    return new Promise((resolve) => {
      const ws = new WebSocket(WS_URL);
      this.ws = ws;

      ws.on('open',    () => log('info', 'Binance spot WS open'));
      ws.on('message', (data) => {
        try {
          const m = JSON.parse(data.toString()) as AggTrade;
          if (m.e !== 'aggTrade') return;
          this.emit('tick', { price: Number(m.p), ts: Number(m.T) } satisfies FastTick);
        } catch { /* ignore */ }
      });
      ws.on('close',   () => { log('warn', 'Binance WS closed'); this.ws = null; resolve(); });
      ws.on('error',   (err: Error) => log('warn', 'Binance WS error', { error: err.message }));
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
