/**
 * OrderExecutor — places entry + TP/SL orders on exchange.
 *
 * Modes:
 *   paper — logs what would be executed, no real orders
 *   live  — places actual orders via ccxt (Binance USDT-M Futures)
 *
 * To enable live trading, set in .env:
 *   TRADING_MODE=live
 *   EXCHANGE_API_KEY=...
 *   EXCHANGE_API_SECRET=...
 *   TRADE_SIZE_USDT=100      (default $100 per position)
 *   TRADE_LEVERAGE=1         (default 1× = no leverage)
 */
import type { Signal } from '../types/signal.js';
import type { ClosedPosition } from './PositionTracker.js';
import { log } from '../observability/logger.js';

export type TradingMode = 'paper' | 'live';

export class OrderExecutor {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private exchange: any = null;

  constructor(
    private readonly mode:       TradingMode,
    private readonly exchangeId: string,
    private readonly symbol:     string,
    private readonly sizUsdt:    number,
    private readonly leverage:   number,
    apiKey?:    string,
    apiSecret?: string,
  ) {
    if (mode === 'live') {
      if (!apiKey || !apiSecret) {
        throw new Error('EXCHANGE_API_KEY + EXCHANGE_API_SECRET required for live trading');
      }
      this.initExchange(apiKey, apiSecret);
    }
  }

  private initExchange(apiKey: string, apiSecret: string): void {
    // Lazy-require ccxt to avoid import errors in paper mode
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ccxt = require('ccxt') as Record<string, new (opts: unknown) => unknown>;
    const ExchangeClass = ccxt[this.exchangeId];
    if (!ExchangeClass) throw new Error(`ccxt: unknown exchange "${this.exchangeId}"`);

    this.exchange = new ExchangeClass({
      apiKey,
      secret: apiSecret,
      enableRateLimit: true,
      options: { defaultType: 'future' },  // USDT-M perpetuals
    });

    log('info', `OrderExecutor: live mode on ${this.exchangeId} futures`);
  }

  // ── Enter position ──────────────────────────────────────────────────────────

  async enter(signal: Signal, currentPrice: number): Promise<void> {
    if (signal.direction === 'HOLD') return;

    const isBuy  = signal.direction === 'BUY';
    const side   = isBuy ? 'buy' : 'sell';
    const amount = (this.sizUsdt * this.leverage) / currentPrice;
    const tp     = signal.priceTarget;
    const sl     = signal.stopLoss;

    if (this.mode === 'paper') {
      const tpStr = tp ? `$${tp.toFixed(2)}` : 'default';
      const slStr = sl ? `$${sl.toFixed(2)}` : 'default';
      log('info',
        `[PAPER] ${side.toUpperCase()} ${amount.toFixed(6)} BTC @ $${currentPrice.toFixed(2)} | TP ${tpStr} | SL ${slStr}`,
        { signalId: signal.id, horizon: signal.horizon },
      );
      return;
    }

    // ── Live ─────────────────────────────────────────────────────────────────
    try {
      // 1. Set leverage
      await this.exchange.setLeverage(this.leverage, this.symbol);

      // 2. Market entry
      await this.exchange.createMarketOrder(this.symbol, side, amount);
      log('info', `[LIVE] Market ${side} ${amount.toFixed(6)} BTC placed`, { signalId: signal.id });

      // 3. TP order (TAKE_PROFIT_MARKET, reduce-only)
      if (tp) {
        await this.exchange.createOrder(
          this.symbol,
          'TAKE_PROFIT_MARKET',
          isBuy ? 'sell' : 'buy',
          amount,
          undefined,
          { stopPrice: tp, reduceOnly: true },
        );
        log('info', `[LIVE] TP order @ $${tp.toFixed(2)}`, { signalId: signal.id });
      }

      // 4. SL order (STOP_MARKET, reduce-only)
      if (sl) {
        await this.exchange.createOrder(
          this.symbol,
          'STOP_MARKET',
          isBuy ? 'sell' : 'buy',
          amount,
          undefined,
          { stopPrice: sl, reduceOnly: true },
        );
        log('info', `[LIVE] SL order @ $${sl.toFixed(2)}`, { signalId: signal.id });
      }
    } catch (err) {
      log('error', `[LIVE] Order entry failed`, { error: String(err), signalId: signal.id });
    }
  }

  // ── Exit notification ───────────────────────────────────────────────────────

  /**
   * Called when PositionTracker closes a position.
   * In live mode, exchange's own TP/SL orders handle exit automatically.
   * We only need to act on 'timeout' (neither TP nor SL hit in eval window).
   */
  async onPositionClosed(closed: ClosedPosition): Promise<void> {
    const pnlStr = `${closed.pnlPct >= 0 ? '+' : ''}${(closed.pnlPct * 100).toFixed(3)}%`;

    if (this.mode === 'paper') {
      log('info',
        `[PAPER] ${closed.signal.direction} closed via ${closed.exitReason.toUpperCase()} | PnL: ${pnlStr}`,
        { signalId: closed.signalId, exitPrice: closed.exitPrice.toFixed(2) },
      );
      return;
    }

    if (closed.exitReason === 'timeout') {
      log('warn',
        `[LIVE] Eval window expired — please manually review open orders`,
        { signalId: closed.signalId },
      );
    }
    // tp/sl: already handled by exchange orders — nothing to do
  }
}
