/**
 * OnChainService — Real-time Bitcoin on-chain signals.
 *
 * Sources (all free, no API key):
 *   blockchain.info/stats   — hash rate, difficulty, basic metrics
 *   mempool.space/api       — mempool congestion, fee rates, block data
 *   Trade stream (internal) — whale detection from ccxt trade feed
 *
 * Emits 'snapshot' every 5 minutes with composite OnChainSnapshot.
 * PanicDetector consumes these snapshots.
 */

import { EventEmitter } from 'events';
import axios from 'axios';
import type { Trade } from '../types/market.js';
import type { OnChainSnapshot } from '../types/onchain.js';
import { log } from '../observability/logger.js';
import { getTracer } from '../observability/tracing.js';
import { getApiLatencyHistogram } from '../observability/metrics.js';

// ── API shapes ────────────────────────────────────────────────────────────────

interface BlockchainInfoStats {
  hash_rate:          number;  // TH/s
  difficulty:         number;
  total_btc_sent:     number;  // satoshis in last 24h
  n_tx:               number;  // tx count in last 24h
  estimated_btc_sent: number;
}

interface MempoolFees {
  fastestFee:   number;  // sat/vbyte
  halfHourFee:  number;
  hourFee:      number;
  minimumFee:   number;
}

interface MempoolInfo {
  count:        number;  // pending tx count
  vsize:        number;  // bytes
  total_fee:    number;  // satoshis
}

// ── Constants ─────────────────────────────────────────────────────────────────

const WHALE_THRESHOLD_BTC = 50;  // trade > 50 BTC = whale
const POLL_INTERVAL_MS    = 5 * 60 * 1_000;  // 5 minutes

// ── Service ───────────────────────────────────────────────────────────────────

export class OnChainService extends EventEmitter {
  private timer: ReturnType<typeof setInterval> | null = null;
  private tracer  = getTracer('OnChainService');
  private latency = getApiLatencyHistogram();

  // Whale detection — built from trade stream
  private whaleTrades1h: Trade[] = [];

  // Last known network stats (persist between polls in case API fails)
  private lastStats: Partial<OnChainSnapshot> = {};

  start(): void {
    log('info', 'OnChainService starting');
    void this.poll();
    this.timer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    log('info', 'OnChainService stopped');
  }

  /** Called by MarketDataService trade events — feeds whale detection */
  onTrade(trade: Trade): void {
    if (trade.amount < WHALE_THRESHOLD_BTC) return;

    const cutoff = Date.now() - 60 * 60_000;
    this.whaleTrades1h = this.whaleTrades1h
      .filter(t => t.timestamp > cutoff)
      .concat(trade);
  }

  private async poll(): Promise<void> {
    const span = this.tracer.startSpan('OnChainService.poll');
    const t0 = Date.now();

    try {
      const [statsResult, feesResult, mempoolResult] = await Promise.allSettled([
        this.fetchBlockchainStats(),
        this.fetchMempoolFees(),
        this.fetchMempoolInfo(),
      ]);

      this.latency.record(Date.now() - t0, { endpoint: 'onchain' });

      const stats   = statsResult.status   === 'fulfilled' ? statsResult.value   : null;
      const fees    = feesResult.status    === 'fulfilled' ? feesResult.value    : null;
      const mempool = mempoolResult.status === 'fulfilled' ? mempoolResult.value : null;

      // Whale stats from trade stream
      const now = Date.now();
      const cutoff1h = now - 60 * 60_000;
      const recent = this.whaleTrades1h.filter(t => t.timestamp > cutoff1h);
      const whaleBuy  = recent.filter(t => t.side === 'buy').reduce((s, t)  => s + t.amount, 0);
      const whaleSell = recent.filter(t => t.side === 'sell').reduce((s, t) => s + t.amount, 0);

      const snapshot: OnChainSnapshot = {
        timestamp:          now,
        hashRate:           stats?.hash_rate   ?? this.lastStats.hashRate   ?? 0,
        difficulty:         stats?.difficulty  ?? this.lastStats.difficulty ?? 0,
        mempoolTxCount:     mempool?.count     ?? this.lastStats.mempoolTxCount ?? 0,
        mempoolFeeRate:     fees?.fastestFee   ?? this.lastStats.mempoolFeeRate ?? 0,
        blockConfirmTime:   estimateConfirmTime(fees?.fastestFee ?? 0),
        whaleTradeCount1h:  recent.length,
        whaleBuyVolume1h:   whaleBuy,
        whaleSellVolume1h:  whaleSell,
        whalNetFlow1h:      whaleBuy - whaleSell,
        // Exchange flow: approximate from blockchain stats
        // positive = more BTC moving (likely exchange inflow under stress)
        exchangeInflow24h:  stats ? estimateExchangeFlow(stats) : (this.lastStats.exchangeInflow24h ?? 0),
        exchangeNetFlow:    0, // requires premium API (Glassnode/CryptoQuant)
        panicScore:         0, // computed by PanicDetector
      };

      // Cache for fallback
      this.lastStats = snapshot;

      log('debug', 'OnChainService snapshot', {
        mempoolTx:  snapshot.mempoolTxCount,
        feeRate:    snapshot.mempoolFeeRate,
        whaleBuy:   snapshot.whaleBuyVolume1h.toFixed(2),
        whaleSell:  snapshot.whaleSellVolume1h.toFixed(2),
      });

      this.emit('snapshot', snapshot);
    } catch (err) {
      log('warn', 'OnChainService poll error', { error: String(err) });
      span.recordException(err as Error);
    } finally {
      span.end();
    }
  }

  // ── API fetchers ────────────────────────────────────────────────────────────

  private async fetchBlockchainStats(): Promise<BlockchainInfoStats> {
    const resp = await axios.get<BlockchainInfoStats>(
      'https://blockchain.info/stats?format=json',
      { timeout: 10_000 },
    );
    return resp.data;
  }

  private async fetchMempoolFees(): Promise<MempoolFees> {
    const resp = await axios.get<MempoolFees>(
      'https://mempool.space/api/v1/fees/recommended',
      { timeout: 10_000 },
    );
    return resp.data;
  }

  private async fetchMempoolInfo(): Promise<MempoolInfo> {
    const resp = await axios.get<MempoolInfo>(
      'https://mempool.space/api/mempool',
      { timeout: 10_000 },
    );
    return resp.data;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Rough confirmation time estimate from fee rate */
function estimateConfirmTime(fastestFeeSatVbyte: number): number {
  if (fastestFeeSatVbyte === 0) return 10;
  if (fastestFeeSatVbyte > 100) return 1;   // very congested
  if (fastestFeeSatVbyte > 50)  return 3;
  if (fastestFeeSatVbyte > 20)  return 6;
  return 10;
}

/**
 * Rough exchange inflow proxy from blockchain.info stats.
 * High on-chain volume relative to recent average = potential exchange inflow.
 * This is a heuristic — exact exchange flow needs Glassnode/CryptoQuant.
 */
function estimateExchangeFlow(stats: BlockchainInfoStats): number {
  // estimated_btc_sent is total on-chain BTC moved in last 24h
  return stats.estimated_btc_sent / 1e8; // convert satoshis to BTC
}
