/**
 * src/api/poly-stream.ts
 *
 * Server-Sent Events (SSE) handler for the Live page.
 * Pass-through: every engine event → wire. No backend throttle.
 *
 *   GET /api/poly/stream
 *
 * Wire format (named events):
 *   event: snapshot   data: EngineSnapshot     (sent once on connect)
 *   event: btc        data: { price, ts }
 *   event: share      data: { tokenId, conditionId, bestBid, bestAsk, lastPrice, ts }
 *   event: market     data: PolyClobMarket
 *   event: current    data: PolyClobMarket | null
 *   event: scan5s     data: FutureTick
 *   event: spike      data: FutureTick
 *   event: signal     data: SignalEvent       (streak-based decision from StreakSignalEngine)
 *   event: order      data: order row
 *   event: ping       data: { ts }            (every 15s, keep-alive)
 *
 * No throttle here:
 *   - BTC aggTrade ~1-10/s — already low
 *   - share events are deduped to top-of-book changes in PolymarketService
 *     (~10-50/s peak) — manageable
 *   - FE coalesces with requestAnimationFrame
 */

import type { Request, Response } from 'express';
import type { LiveTradingEngine } from '../services/LiveTradingEngine.js';

const HEARTBEAT_MS = 15_000;

export function polyStreamHandler(engine: LiveTradingEngine) {
  return function streamHandler(req: Request, res: Response): void {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');     // disable nginx buffering
    res.flushHeaders?.();

    const send = (event: string, data: unknown): void => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // 1. Initial snapshot
    send('snapshot', engine.snapshot());

    // 2. Pass-through subscribers
    const onBtc     = (tick: unknown): void => send('btc',     tick);
    const onShare   = (s:    unknown): void => send('share',   s);
    const onMarket  = (m:    unknown): void => send('market',  m);
    const onCurrent = (m:    unknown): void => send('current', m);
    const onScan    = (t:    unknown): void => send('scan5s',  t);
    const onSpike   = (t:    unknown): void => send('spike',   t);
    const onSignal  = (s:    unknown): void => send('signal',  s);
    const onOrder   = (o:    unknown): void => send('order',   o);
    // Multi-coin worker events (PriceMonitoringWorker via SignalBus)
    const onCoinT0Plus = (e: unknown): void => send('coin_t0plus', e);
    const onCoinT4     = (e: unknown): void => send('coin_t4',     e);
    const onCoinT3    = (e: unknown): void => send('coin_t3',    e);
    const onCoinT0     = (e: unknown): void => send('coin_t0',     e);
    const onCoinEcho   = (e: unknown): void => send('coin_echo',   e);

    engine.on('btc',     onBtc);
    engine.on('share',   onShare);
    engine.on('market',  onMarket);
    engine.on('current', onCurrent);
    engine.on('scan5s',  onScan);
    engine.on('spike',   onSpike);
    engine.on('signal',  onSignal);
    engine.on('order',   onOrder);
    engine.on('coin_t0plus', onCoinT0Plus);
    engine.on('coin_t4',     onCoinT4);
    engine.on('coin_t3',    onCoinT3);
    engine.on('coin_t0',     onCoinT0);
    engine.on('coin_echo',   onCoinEcho);

    // 3. Heartbeat
    const ping = setInterval(() => send('ping', { ts: Date.now() }), HEARTBEAT_MS);

    // 4. Cleanup on disconnect
    const cleanup = (): void => {
      clearInterval(ping);
      engine.off('btc',     onBtc);
      engine.off('share',   onShare);
      engine.off('market',  onMarket);
      engine.off('current', onCurrent);
      engine.off('scan5s',  onScan);
      engine.off('spike',   onSpike);
      engine.off('signal',  onSignal);
      engine.off('order',   onOrder);
      engine.off('coin_t0plus', onCoinT0Plus);
      engine.off('coin_t4',     onCoinT4);
      engine.off('coin_t3',    onCoinT3);
      engine.off('coin_t0',     onCoinT0);
      engine.off('coin_echo',   onCoinEcho);
    };
    req.on('close', cleanup);
    req.on('error', cleanup);
  };
}
