/**
 * LivePage — real-time view of the current Polymarket BTC 5m up/down market.
 *
 * Layout mirrors polymarket.com's BTC 5min market page:
 *   ┌──────────────────────────┬───────────────────┐
 *   │  Header (Q + countdown)  │   Trade panel     │
 *   │  BTC chart + target line │   Mua / Bán       │
 *   │  Range tabs (5m..3d)     │   Up / Down       │
 *   │  Market slot picker      │   Shares / Total  │
 *   └──────────────────────────┴───────────────────┘
 *   My orders + rules
 *
 * Simulate mode: orders go to poly_orders (mode='sim'), no real CLOB call.
 * Live mode: shown as not-yet-implemented (Phase 3).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api, polyOrderKind, type PolyBtcTick, type PolyOrderRow, type PolyRange,
  type PolyOrderKind, type PolyPastWindow, type SettingsResponse,
} from '../api/client.js';
import { createChart, type IChartApi, type ISeriesApi, type Time } from 'lightweight-charts';
import { useLiveStream, type LiveMarket, type LiveShare,
         type LiveSignal, type LiveStreamStats,
         type CoinSymbol, type CoinEventsEntry,
         type VolumeBucket,
         type LiveStreamState } from '../hooks/useLiveStream.js';

const ALL_COINS: readonly CoinSymbol[] = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'HYPE', 'BNB'];

const RANGES: PolyRange[] = ['5m', '15m', '1h', '1d', '3d'];

// Polls only for non-streamed data (orders list).
// Live ticks (BTC, share prices, current market) arrive via SSE — no polling.
// Chart history is fetched ONCE per range change, no interval.
const POLL_ORDERS_MS = 5_000;

export default function LivePage() {
  // ── Mode/settings ────────────────────────────────────────────────────────
  const [settings, setSettings]   = useState<SettingsResponse | null>(null);
  const [switching, setSwitching] = useState(false);
  useEffect(() => { api.getSettings().then(setSettings).catch(console.error); }, []);

  async function switchMode(mode: 'simulate' | 'live') {
    if (!settings || settings.effectiveTradingMode === mode) return;
    setSwitching(true);
    try {
      const r = await api.updateSetting('trading_mode', mode);
      setSettings({
        ...settings,
        settings:             { ...settings.settings, trading_mode: mode },
        effectiveTradingMode: r.effectiveTradingMode,
      });
    } finally { setSwitching(false); }
  }

  // ── Live stream (single SSE connection, source of truth) ────────────────
  const stream = useLiveStream('/api/poly/stream');
  const { currentMarket, upcoming, btc, shares: liveShares,
          connected: streamConnected, stats: streamStats,
          signals: signalHistory } = stream;

  // Selected market: either the engine's current one, or a slot the user picked.
  const [selectedConditionId, setSelectedConditionId] = useState<string | null>(null);
  const selectedMarket: LiveMarket | null = useMemo(() => {
    if (selectedConditionId) {
      const found = upcoming.find(m => m.conditionId === selectedConditionId);
      if (found) return found;
    }
    return currentMarket;
  }, [selectedConditionId, upcoming, currentMarket]);

  // Auto-clear pinned selection when its window ends — user goes back to
  // following the live (currentMarket) flow.
  useEffect(() => {
    if (!selectedConditionId || !selectedMarket) return;
    if (selectedMarket.windowEnd < Date.now()) {
      setSelectedConditionId(null);
    }
  }, [selectedMarket, selectedConditionId, currentMarket]);

  const btcLive = btc?.price ?? null;

  // ── History (chart backfill, ONE-SHOT per range change) ──────────────────
  // Don't poll — that overwrote the high-frequency live ticks we appended
  // via SSE every 10s and made the chart visibly stutter. SSE 'btc' events
  // keep the chart fresh; this only fills in pre-mount data.
  const [range, setRange] = useState<PolyRange>('5m');
  const [btcHistory, setBtcHistory] = useState<PolyBtcTick[]>([]);

  useEffect(() => {
    let cancelled = false;
    api.getPolyBtcHistory(range)
      .then(btc => { if (!cancelled) setBtcHistory(btc); })
      .catch(e => { if (!cancelled) console.warn('history load failed', e); });
    return () => { cancelled = true; };
  }, [range]);

  // ── Past windows (left-of-slots colored history) ─────────────────────────
  const [pastWindows, setPastWindows] = useState<PolyPastWindow[]>([]);
  const reloadPast = useCallback(async () => {
    try { setPastWindows(await api.getPolyPastWindows(5)); } catch { /* ignore */ }
  }, []);
  useEffect(() => {
    reloadPast();
    // Refresh after each window boundary (every 5min + small delay)
    const id = setInterval(reloadPast, 60_000);
    return () => clearInterval(id);
  }, [reloadPast]);
  // Also refresh when currentMarket changes (window rolled over)
  useEffect(() => { reloadPast(); }, [currentMarket?.conditionId, reloadPast]);

  // ── Settings (for TP/SL display on pending orders) ──────────────────────
  const [settingsForOrders, setSettingsForOrders] = useState<{ tp: number; sl: number }>(
    { tp: 75, sl: 25 },
  );
  useEffect(() => {
    api.getSettings().then(s => setSettingsForOrders({
      tp: Number(s.settings['auto_order_tp_cents'] ?? 75),
      sl: Number(s.settings['auto_order_sl_cents'] ?? 25),
    })).catch(() => {/* ignore */});
  }, [settings?.settings['auto_order_tp_cents'], settings?.settings['auto_order_sl_cents']]);

  // ── Orders ───────────────────────────────────────────────────────────────
  // SSE pushes 'order' on placement; we still poll occasionally to pick up
  // background changes (e.g. resolution PnL once that worker exists).
  const [orders, setOrders] = useState<PolyOrderRow[]>([]);
  const reloadOrders = useCallback(async () => {
    try { setOrders(await api.getPolyOrders(undefined, 50)); } catch { /* ignore */ }
  }, []);
  useEffect(() => {
    reloadOrders();
    const id = setInterval(reloadOrders, POLL_ORDERS_MS);
    return () => clearInterval(id);
  }, [reloadOrders]);
  // When SSE fires a new 'order' event, refresh immediately so the row appears
  // with full join data (slug, question) rather than just the partial broadcast.
  useEffect(() => { if (stream.lastOrder) reloadOrders(); }, [stream.lastOrder, reloadOrders]);

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div style={S.page}>
      <ModeBanner settings={settings} switching={switching} onSwitch={switchMode} />

      <CoinSignalsStrip coinEvents={stream.coinEvents} />

      <div style={S.mainGrid}>
        {/* LEFT: Market header + chart */}
        <div style={S.leftPane}>
          <MarketHeader
            market={selectedMarket}
            liveShares={liveShares}
            btcLive={btcLive}
            btcLiveTs={btc?.ts ?? null}
            isCurrentWindow={selectedMarket?.conditionId === currentMarket?.conditionId}
            streamConnected={streamConnected}
            streamStats={streamStats}
          />

          <PriceChart
            range={range}
            btcHistory={btcHistory}
            btcLive={btcLive}
            market={selectedMarket}
          />

          <RangeTabs range={range} onChange={setRange} />

          <MarketSlots
            current={currentMarket}
            upcoming={upcoming}
            pastWindows={pastWindows}
            selected={selectedMarket?.conditionId ?? null}
            onSelect={setSelectedConditionId}
          />
        </div>

        {/* RIGHT: Trade panel */}
        <div style={S.rightPane}>
          <TradePanel
            market={selectedMarket}
            liveShares={liveShares}
            mode={settings?.effectiveTradingMode ?? 'simulate'}
            onPlaced={reloadOrders}
          />
        </div>
      </div>

      <MyOrders orders={orders} tpCents={settingsForOrders.tp} slCents={settingsForOrders.sl} />

      <SignalHistory signals={signalHistory} pastWindows={pastWindows} />

      <RulesCard market={selectedMarket} />
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Header — title, target price, current price, countdown
// ────────────────────────────────────────────────────────────────────────────

function MarketHeader({
  market, liveShares, btcLive, btcLiveTs, isCurrentWindow, streamConnected, streamStats,
}: {
  market:          LiveMarket | null;
  liveShares:      Record<string, LiveShare>;
  btcLive:         number | null;
  btcLiveTs:       number | null;
  isCurrentWindow: boolean;
  streamConnected: boolean;
  streamStats:     LiveStreamStats;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);

  if (!market) {
    return (
      <div style={S.headerCard}>
        {streamConnected ? 'Đang chờ market mở…' : 'Đang kết nối SSE…'}
      </div>
    );
  }
  const startMs = market.windowStart;
  const endMs   = market.windowEnd;
  const remainingMs = Math.max(0, endMs - now);
  const min = Math.floor(remainingMs / 60000);
  const sec = Math.floor((remainingMs % 60000) / 1000);

  const upTick = liveShares[market.tokenUp];
  const dnTick = liveShares[market.tokenDown];
  const upMid = midPrice(upTick?.bestBid, upTick?.bestAsk);
  const dnMid = midPrice(dnTick?.bestBid, dnTick?.bestAsk);

  const currentPrice = btcLive;
  const openPrice    = null as number | null;   // TODO: snapshot first tick of window
  const delta = openPrice && currentPrice ? currentPrice - openPrice : null;

  return (
    <div style={S.headerCard}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
        <div style={S.btcIcon}>₿</div>
        <div style={{ flex: 1 }}>
          <div style={S.headerTitle}>Bitcoin Up or Down — 5 phút</div>
          <div style={S.headerSubtitle}>
            {fmtWindow(startMs, endMs)}
            {!isCurrentWindow && (
              <span style={S.upcomingPill}> {startMs > now ? 'Sắp mở' : 'Đã đóng'}</span>
            )}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={S.label}>Còn lại</div>
          <div style={S.countdown}>
            <span style={S.countMin}>{String(min).padStart(2, '0')}</span>
            <span style={S.countLabel}>PHÚT</span>
            <span style={S.countMin}>{String(sec).padStart(2, '0')}</span>
            <span style={S.countLabel}>GIÂY</span>
          </div>
          <div style={{ marginTop: 4, fontSize: 10, color: '#8b949e' }}>
            <span style={{ color: streamConnected ? '#3fb950' : '#f85149' }}>
              ● {streamConnected ? 'live' : 'offline'}
            </span>
            {streamConnected && (
              <>
                {' · '}
                <span title="events/sec from SSE (BTC + share + scan)">
                  {streamStats.eventsPerSec}/s
                </span>
                {' · '}
                <span title={`ms since last event (BTC ts age: ${btcLiveTs ? Date.now() - btcLiveTs : '?'}ms)`}>
                  Δ{streamStats.ageMs}ms
                </span>
              </>
            )}
          </div>
        </div>
      </div>

      <div style={S.priceRow}>
        <div>
          <div style={S.label}>Giá hiện tại (BTC)</div>
          <div style={S.bigPrice}>
            {currentPrice ? `$${currentPrice.toLocaleString('en-US', { maximumFractionDigits: 2 })}` : '—'}
            {delta !== null && (
              <span style={{ marginLeft: 8, color: delta >= 0 ? '#3fb950' : '#f85149', fontSize: 14 }}>
                {delta >= 0 ? '▲' : '▼'} ${Math.abs(delta).toFixed(2)}
              </span>
            )}
          </div>
        </div>
        <div>
          <div style={S.label}>UP share</div>
          <div style={{ ...S.midPrice, color: '#3fb950' }}>
            {upMid != null ? `${(upMid * 100).toFixed(0)}¢` : '—'}
          </div>
        </div>
        <div>
          <div style={S.label}>DOWN share</div>
          <div style={{ ...S.midPrice, color: '#f85149' }}>
            {dnMid != null ? `${(dnMid * 100).toFixed(0)}¢` : '—'}
          </div>
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Price chart — lightweight-charts line of BTC over selected range
// ────────────────────────────────────────────────────────────────────────────

function PriceChart({
  range, btcHistory, btcLive, market,
}: {
  range:      PolyRange;
  btcHistory: PolyBtcTick[];
  btcLive:    number | null;
  market:     LiveMarket | null;
}) {
  const ref       = useRef<HTMLDivElement | null>(null);
  const chartRef  = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  // Tracks the last point's time (seconds) so live appends don't insert behind.
  const lastTimeRef = useRef<number>(0);

  // Build chart once per range change (range affects secondsVisible)
  useEffect(() => {
    if (!ref.current) return;
    const chart = createChart(ref.current, {
      width:  ref.current.clientWidth,
      height: 280,
      layout: { background: { color: '#0d1117' }, textColor: '#8b949e' },
      grid:   { vertLines: { color: '#1f2733' }, horzLines: { color: '#1f2733' } },
      timeScale: { timeVisible: true, secondsVisible: range === '5m' },
      rightPriceScale: { borderColor: '#1f2733' },
    });
    const series = chart.addLineSeries({ color: '#f0a500', lineWidth: 2 });
    chartRef.current  = chart;
    seriesRef.current = series;
    lastTimeRef.current = 0;

    const onResize = () => {
      if (ref.current) chart.applyOptions({ width: ref.current.clientWidth });
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      chart.remove();
      chartRef.current  = null;
      seriesRef.current = null;
    };
  }, [range]);

  // Backfill: load history into the series whenever the history array changes
  useEffect(() => {
    if (!seriesRef.current) return;
    if (!btcHistory.length) { seriesRef.current.setData([]); lastTimeRef.current = 0; return; }
    const data = btcHistory.map(t => ({
      time:  Math.floor(Number(t.ts) / 1000) as Time,
      value: t.price,
    }));
    seriesRef.current.setData(data);
    chartRef.current?.timeScale().fitContent();
    lastTimeRef.current = data[data.length - 1]!.time as number;
  }, [btcHistory]);

  // Live append: when btcLive changes, append (or update) a point at "now".
  useEffect(() => {
    if (!seriesRef.current || btcLive == null) return;
    const t = Math.floor(Date.now() / 1000);
    if (t < lastTimeRef.current) return;       // out of order, skip
    seriesRef.current.update({ time: t as Time, value: btcLive });
    lastTimeRef.current = t;
  }, [btcLive]);

  // Window markers — keep simple for now; could add createPriceLine for target/open.

  return (
    <div style={S.chartCard}>
      <div ref={ref} style={{ width: '100%', height: 280 }} />
      {market && (
        <div style={S.chartLegend}>
          Window: {fmtWindow(market.windowStart, market.windowEnd)}
          {btcLive != null && (
            <span style={{ marginLeft: 12, color: '#f0a500' }}>
              ● live: ${btcLive.toLocaleString('en-US', { maximumFractionDigits: 2 })}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Range tabs (5m / 15m / 1h / 1d / 3d)
// ────────────────────────────────────────────────────────────────────────────

function RangeTabs({ range, onChange }: { range: PolyRange; onChange: (r: PolyRange) => void }) {
  return (
    <div style={S.tabsRow}>
      {RANGES.map(r => (
        <button
          key={r}
          onClick={() => onChange(r)}
          style={{ ...S.tab, ...(range === r ? S.tabActive : {}) }}
        >{r}</button>
      ))}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Market slot picker — current + next N windows
// ────────────────────────────────────────────────────────────────────────────

const MarketSlots = React.memo(function MarketSlots({
  current, upcoming, pastWindows, selected, onSelect,
}: {
  current:      LiveMarket | null;
  upcoming:     LiveMarket[];
  pastWindows:  PolyPastWindow[];
  selected:     string | null;
  onSelect:     (id: string | null) => void;
}) {
  const slots = upcoming.length ? upcoming : (current ? [current] : []);
  return (
    <div style={S.slotsRow}>
      {/* Past outcome dots — like Polymarket's "Past ▾" indicator */}
      {pastWindows.length > 0 && (
        <div style={S.pastGroup} title="5 window gần đây (win/lose)">
          <span style={S.pastLabel}>Past</span>
          {/* Show oldest → newest left-to-right */}
          {[...pastWindows].reverse().map(w => (
            <span
              key={w.windowStart}
              style={{
                ...S.pastDot,
                background: w.outcome === 'up'
                  ? '#3fb950'
                  : w.outcome === 'down' ? '#f85149' : '#30363d',
                color: '#0d1117',
              }}
              title={w.outcome
                ? `${fmtTime(w.windowStart)} → ${fmtTime(w.windowEnd)}: ${w.outcome.toUpperCase()} ` +
                  `($${w.btcOpen?.toFixed(2)} → $${w.btcClose?.toFixed(2)})`
                : `${fmtTime(w.windowStart)} → ${fmtTime(w.windowEnd)}: no data`}
            >
              {w.outcome === 'up' ? '▲' : w.outcome === 'down' ? '▼' : '·'}
            </span>
          ))}
          <span style={{ width: 8 }} />
        </div>
      )}
      {slots.map(m => {
        const isCurrent = m.conditionId === current?.conditionId;
        const isSelected = selected === m.conditionId || (!selected && isCurrent);
        return (
          <button
            key={m.conditionId}
            onClick={() => onSelect(isCurrent ? null : m.conditionId)}
            style={{
              ...S.slot,
              ...(isSelected ? S.slotActive : {}),
              ...(isCurrent ? { borderColor: '#f0a500' } : {}),
            }}
            title={m.question}
          >
            {isCurrent && <span style={S.slotDot} />}
            {fmtTime(m.windowEnd)}
          </button>
        );
      })}
    </div>
  );
});

// ────────────────────────────────────────────────────────────────────────────
// Trade panel — Polymarket-like Mua/Bán Up/Down with simulated submit
// ────────────────────────────────────────────────────────────────────────────

function TradePanel({
  market, liveShares, mode, onPlaced,
}: {
  market:     LiveMarket | null;
  liveShares: Record<string, LiveShare>;
  mode:       'simulate' | 'live';
  onPlaced:   () => void;
}) {
  const [side,      setSide]      = useState<'buy' | 'sell'>('buy');
  const [direction, setDirection] = useState<'up' | 'down'>('up');
  const [shareCount, setShareCount] = useState<number>(10);
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const upTick = market ? liveShares[market.tokenUp]   : undefined;
  const dnTick = market ? liveShares[market.tokenDown] : undefined;
  const latestForToken = direction === 'up' ? upTick : dnTick;
  // Buy → ask (you're paying), Sell → bid (you're selling into the bid).
  const tickPrice = side === 'buy' ? latestForToken?.bestAsk : latestForToken?.bestBid;
  const sharePrice = tickPrice ?? null;

  const total  = sharePrice && shareCount > 0 ? sharePrice * shareCount : 0;
  const toWin  = side === 'buy' ? shareCount * 1.0 - total : 0;

  async function placeOrder() {
    if (!market || !sharePrice || side !== 'buy') return;
    setSubmitting(true);
    setFeedback(null);
    try {
      const r = await api.placePolySimulatedOrder({
        conditionId: market.conditionId,
        direction,
        sharePrice,
        sizeUsdc: total,
      });
      setFeedback(`✓ ${r.mode.toUpperCase()} order placed — id=${r.id.slice(0, 8)}… · ${direction.toUpperCase()} @ ${(sharePrice * 100).toFixed(1)}¢ × ${shareCount} shares ($${total.toFixed(2)})`);
      onPlaced();
    } catch (e) {
      // Extract backend's error message from "API /path → 500: {\"error\":\"...\"}"
      let msg = e instanceof Error ? e.message : String(e);
      const m = msg.match(/:\s*(\{.*\})\s*$/);
      if (m) {
        try { msg = (JSON.parse(m[1]!) as { error?: string }).error ?? msg; }
        catch { /* keep original */ }
      }
      setFeedback(`✗ ${msg}`);
    } finally {
      setSubmitting(false);
    }
  }

  const isLive = mode === 'live';
  const modeLabel = isLive ? 'LIVE' : 'SIM';
  const buttonLabel = side === 'buy'
    ? `Mua ${direction === 'up' ? 'Up' : 'Down'} · ${modeLabel}`
    : `Bán (chưa hỗ trợ)`;
  const canSubmit = Boolean(market) && sharePrice != null
    && side === 'buy' && !submitting && shareCount > 0;

  return (
    <div style={S.tradeCard}>
      {/* Buy / Sell tabs */}
      <div style={S.miniTabs}>
        <button onClick={() => setSide('buy')}
                style={{ ...S.miniTab, ...(side === 'buy' ? S.miniTabActive : {}) }}>Mua</button>
        <button onClick={() => setSide('sell')}
                style={{ ...S.miniTab, ...(side === 'sell' ? S.miniTabActive : {}) }}>Bán</button>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: '#8b949e' }}>Giới hạn ▾</span>
      </div>

      {/* Up / Down direction */}
      <div style={S.dirRow}>
        <button onClick={() => setDirection('up')}
                style={{ ...S.dirBtn,
                         background: direction === 'up' ? '#1a4731' : '#161b22',
                         borderColor: direction === 'up' ? '#3fb950' : '#30363d',
                         color: direction === 'up' ? '#3fb950' : '#c9d1d9' }}>
          Up <span style={S.dirPrice}>
            {upTick?.bestAsk != null ? `${Math.round(upTick.bestAsk * 100)}¢` : '—'}
          </span>
        </button>
        <button onClick={() => setDirection('down')}
                style={{ ...S.dirBtn,
                         background: direction === 'down' ? '#4a1a1a' : '#161b22',
                         borderColor: direction === 'down' ? '#f85149' : '#30363d',
                         color: direction === 'down' ? '#f85149' : '#c9d1d9' }}>
          Down <span style={S.dirPrice}>
            {dnTick?.bestAsk != null ? `${Math.round(dnTick.bestAsk * 100)}¢` : '—'}
          </span>
        </button>
      </div>

      <div style={{ height: 14 }} />

      <div style={S.tradeRow}>
        <div style={S.label}>Giá đang dùng</div>
        <div style={{ fontSize: 14, fontWeight: 600 }}>
          {sharePrice != null ? `${(sharePrice * 100).toFixed(1)}¢` : '—'}
        </div>
      </div>

      <div style={S.tradeRow}>
        <div style={S.label}>Cổ phần</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button style={S.qtyBtn} onClick={() => setShareCount(s => Math.max(0, s - 10))}>-10</button>
          <input
            type="number"
            min={0}
            value={shareCount}
            onChange={e => setShareCount(Math.max(0, Number(e.target.value) || 0))}
            style={S.qtyInput}
          />
          <button style={S.qtyBtn} onClick={() => setShareCount(s => s + 10)}>+10</button>
        </div>
      </div>

      <div style={S.tradeRow}>
        <div style={S.label}>Tổng</div>
        <div style={{ fontSize: 14, color: '#79c0ff' }}>${total.toFixed(2)}</div>
      </div>
      <div style={S.tradeRow}>
        <div style={S.label}>Để thắng</div>
        <div style={{ fontSize: 14, color: '#3fb950' }}>${toWin.toFixed(2)}</div>
      </div>

      <button
        disabled={!canSubmit}
        onClick={placeOrder}
        style={{ ...S.placeBtn,
                 background: canSubmit ? '#1f6feb' : '#21262d',
                 color: canSubmit ? '#fff' : '#8b949e',
                 cursor: canSubmit ? 'pointer' : 'not-allowed' }}
      >{buttonLabel}</button>

      {feedback && (
        <div style={{ marginTop: 10, fontSize: 12,
                      color: feedback.startsWith('✓') ? '#3fb950' : '#f85149',
                      wordBreak: 'break-word', whiteSpace: 'pre-wrap',
                      padding: '6px 8px',
                      border: `1px solid ${feedback.startsWith('✓') ? '#238636' : '#5a1414'}`,
                      borderRadius: 4, background: '#0d1117' }}>
          {feedback}
        </div>
      )}

      {isLive && (
        <div style={{ marginTop: 8, fontSize: 11, color: '#f0a500' }}>
          ⚠ LIVE mode — lệnh sẽ đi thẳng lên Polymarket CLOB. Dùng size nhỏ để test.
        </div>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// My orders
// ────────────────────────────────────────────────────────────────────────────

const MyOrders = React.memo(function MyOrders({
  orders,
}: {
  orders:  PolyOrderRow[];
  tpCents: number;     // kept for API compat; per-order values used directly now
  slCents: number;
}) {
  const [filter, setFilter] = useState<'all' | PolyOrderKind>('all');

  // Bucket counts — BUY only (so user sees positions, not 3x rows)
  const counts = useMemo(() => {
    const c = { all: 0, simulate: 0, backtest: 0, live: 0 };
    for (const o of orders) {
      if (o.side !== 'buy') continue;
      c.all++;
      c[polyOrderKind(o)]++;
    }
    return c;
  }, [orders]);

  const filtered = useMemo(() => {
    // Filter at BUY level → include all children of matching BUYs
    if (filter === 'all') return orders;
    const buyIds = new Set<string>();
    for (const o of orders) {
      if (o.side === 'buy' && polyOrderKind(o) === filter) buyIds.add(o.id);
    }
    return orders.filter(o =>
      (o.side === 'buy'  && buyIds.has(o.id)) ||
      (o.side === 'sell' && o.parent_order_id && buyIds.has(o.parent_order_id))
    );
  }, [orders, filter]);

  // Group by market_id, then sort: BUY first, then SELLs by ts_entry.
  const groups = useMemo(() => {
    const byMarket = new Map<string, PolyOrderRow[]>();
    for (const o of filtered) {
      const list = byMarket.get(o.market_id) ?? [];
      list.push(o);
      byMarket.set(o.market_id, list);
    }
    for (const list of byMarket.values()) {
      list.sort((a, b) => {
        if (a.side !== b.side) return a.side === 'buy' ? -1 : 1;
        return Number(a.ts_entry) - Number(b.ts_entry);
      });
    }
    return Array.from(byMarket.entries()).sort(([, a], [, b]) => {
      const aStart = a[0]?.window_start ? Number(a[0].window_start) : Number(a[0]?.ts_entry ?? 0);
      const bStart = b[0]?.window_start ? Number(b[0].window_start) : Number(b[0]?.ts_entry ?? 0);
      return bStart - aStart;
    });
  }, [filtered]);

  const tabs: Array<{ key: 'all' | PolyOrderKind; label: string; color: string }> = [
    { key: 'all',      label: 'Tất cả',   color: '#c9d1d9' },
    { key: 'simulate', label: 'Simulate', color: '#f0a500' },
    { key: 'backtest', label: 'Backtest', color: '#79c0ff' },
    { key: 'live',     label: 'Live',     color: '#3fb950' },
  ];

  // Always render the card so user sees what to expect (3 rows per position).
  if (!orders.length) {
    return (
      <div style={S.ordersCard}>
        <div style={S.ordersTitleRow}>
          <span style={S.ordersTitle}>Lệnh của tôi (theo window)</span>
        </div>
        <div style={{ padding: '20px 8px', fontSize: 12, color: '#8b949e', lineHeight: 1.7 }}>
          Chưa có lệnh nào. Mỗi vị thế tạo <strong>3 rows</strong>:
          <ul style={{ paddingLeft: 20, marginTop: 6 }}>
            <li><strong style={{ color: '#79c0ff' }}>BUY</strong> — market entry (pay ask)</li>
            <li><strong style={{ color: '#bc8cff' }}>SELL</strong> TP — limit ask tại TP price, fill khi bid ≥ TP</li>
            <li><strong style={{ color: '#bc8cff' }}>SELL</strong> SL — limit ask tại SL price, fill khi bid ≤ SL</li>
          </ul>
          Tạo lệnh bằng cách: click <strong>Mua Up/Down</strong> ở Trade panel bên phải,
          hoặc đợi auto signal fire (Path A boundary hoặc Path B DCA-add).
          <br /><br />
          <span style={{ color: '#f0a500' }}>⚠ Nếu Signal log show <code>AUTO ⚠</code>:</span>
          auto đã thử nhưng bị SKIP — thường do giá hiện tại vượt <code>limit_price_cents</code>
          (default 55¢). Nâng limit ở <strong>Settings</strong> hoặc đặt manual để test.
        </div>
      </div>
    );
  }

  return (
    <div style={S.ordersCard}>
      <div style={S.ordersTitleRow}>
        <span style={S.ordersTitle}>Lệnh của tôi (theo window)</span>
        <div style={{ display: 'flex', gap: 6 }}>
          {tabs.map(t => (
            <button key={t.key}
              onClick={() => setFilter(t.key)}
              style={{
                ...S.orderTab,
                ...(filter === t.key
                    ? { borderColor: t.color, color: t.color, background: '#0d1117' }
                    : {}),
              }}>
              {t.label} <span style={{ opacity: 0.6 }}>({counts[t.key]})</span>
            </button>
          ))}
        </div>
      </div>

      {groups.length === 0
        ? <div style={{ padding: '12px 0', fontSize: 12, color: '#8b949e' }}>
            Không có lệnh trong tab "{tabs.find(t => t.key === filter)?.label}"
          </div>
        : groups.map(([marketId, rows]) => (
          <WindowGroup key={marketId} marketId={marketId} rows={rows} />
        ))}
    </div>
  );
});

function WindowGroup({ marketId, rows }: { marketId: string; rows: PolyOrderRow[] }) {
  const buy = rows.find(r => r.side === 'buy');
  const windowStart = buy?.window_start ? Number(buy.window_start) : null;
  const windowEnd   = buy?.window_end   ? Number(buy.window_end)   : null;
  const windowLabel = windowStart && windowEnd
    ? `${fmtTime(windowStart)} → ${fmtTime(windowEnd)}`
    : `market ${marketId.slice(0, 10)}…`;

  // Window-level stats
  const buys = rows.filter(r => r.side === 'buy');
  const pnlSum = buys.reduce((s, r) => s + (r.pnl_usdc ?? 0), 0);
  const allClosed = buys.every(r => r.status === 'closed');
  const pnlColor = !allClosed ? '#8b949e' : pnlSum > 0 ? '#3fb950' : pnlSum < 0 ? '#f85149' : '#8b949e';

  return (
    <div style={S.windowGroup}>
      <div style={S.windowGroupHeader}>
        <span style={{ fontWeight: 600 }}>Window {windowLabel}</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontFamily: 'monospace', color: pnlColor }}>
          {allClosed
            ? `PnL ${pnlSum >= 0 ? '+' : ''}$${pnlSum.toFixed(2)}`
            : 'Open'}
        </span>
      </div>
      <div style={S.ordersTable}>
        <div style={S.ordersHeader}>
          <span>Lệnh</span><span>Side</span><span>Hướng</span>
          <span>Price</span><span>Size</span>
          <span>PnL</span><span>Loại</span><span>Status</span>
        </div>
        {rows.map(o => <OrderRow key={o.id} o={o} />)}
      </div>
    </div>
  );
}

function OrderRow({ o }: { o: PolyOrderRow }) {
  const dir = o.direction.toUpperCase();
  const dirColor = o.direction === 'up' ? '#3fb950' : '#f85149';
  const kind = polyOrderKind(o);
  const kindBadge = KIND_BADGE[kind];
  const isSell = o.side === 'sell';

  // Status labels — BUY and SELL tell different stories.
  //   BUY pending:  HOLDING
  //   BUY closed:   CLOSED · {reason}
  //   SELL pending: "Limit TP/SL @ X¢" — these are the actual resting exit orders
  //   SELL filled:  FILLED · TP/SL
  //   SELL cancel:  CANCELLED
  const statusLabel =
    o.status === 'pending' && isSell
      ? (o.close_reason === 'tp' ? `Limit TP @ ${(o.share_price * 100).toFixed(0)}¢`
       : o.close_reason === 'sl' ? `Limit SL @ ${(o.share_price * 100).toFixed(0)}¢`
       :                           'Pending')
    : o.status === 'pending'                      ? 'HOLDING'
    : isSell && o.close_reason === 'tp'           ? 'FILLED · TP'
    : isSell && o.close_reason === 'sl'           ? 'FILLED · SL'
    : isSell && o.close_reason === 'cancelled'    ? 'CANCELLED'
    : isSell && o.close_reason === 'resolution'   ? 'SETTLED'
    : !isSell && o.close_reason === 'tp'          ? 'CLOSED · TP'
    : !isSell && o.close_reason === 'sl'          ? 'CLOSED · SL'
    : !isSell && o.close_reason === 'resolution'  ? 'EXPIRED'
    :                                               'closed';

  const statusColor =
    o.status === 'pending' && isSell              ? '#79c0ff'  // limit order resting
    : o.status === 'pending'                      ? '#f0a500'
    : o.close_reason === 'tp'                     ? '#3fb950'
    : o.close_reason === 'sl'                     ? '#f85149'
    : o.close_reason === 'cancelled'              ? '#8b949e'
    : o.close_reason === 'resolution'             ? '#8b949e'
    :                                               '#8b949e';

  return (
    <div style={S.ordersRow}>
      <span style={{ fontFamily: 'monospace', fontSize: 11, color: '#8b949e' }}>
        {o.id.slice(0, 8)}…
      </span>
      <span style={{
        padding: '2px 5px', borderRadius: 3,
        fontSize: 10, fontWeight: 700, width: 'fit-content',
        background: isSell ? '#3a1a4a' : '#1a3a4a',
        color:      isSell ? '#bc8cff' : '#79c0ff',
      }}>
        {isSell ? 'SELL' : 'BUY'}
      </span>
      <span style={{ color: dirColor, fontWeight: 600 }}>{dir}</span>
      <span style={{ fontFamily: 'monospace' }}>{(o.share_price * 100).toFixed(1)}¢</span>
      <span>${o.size_usdc.toFixed(2)}</span>
      <span style={{ color: o.pnl_usdc != null
                      ? (o.pnl_usdc >= 0 ? '#3fb950' : '#f85149') : '#8b949e' }}>
        {o.pnl_usdc != null ? `$${o.pnl_usdc.toFixed(2)}` : '—'}
      </span>
      <span style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        <span style={{ ...S.kindBadge,
                        background: kindBadge.bg, color: kindBadge.fg }}
              title={`mode=${o.mode} source=${o.source} path=${o.signal_path ?? 'manual'}`}>
          {kindBadge.label}
        </span>
        {o.signal_path === 'boundary' && (
          <span style={{ ...S.sourceMini, color: '#3fb950' }} title="BOUNDARY — pre-position for next window">BND</span>
        )}
        {o.signal_path === 'dca' && (
          <span style={{ ...S.sourceMini, color: '#79c0ff' }} title="DCA — average down existing BOUNDARY position">DCA</span>
        )}
        {o.signal_path === 'panic' && (
          <span style={{ ...S.sourceMini, color: '#ff9f43' }} title="PANIC — bottom-fishing in current window">PNC</span>
        )}
      </span>
      <span style={{ fontSize: 11, color: statusColor }}>
        {statusLabel}
      </span>
    </div>
  );
}

const KIND_BADGE: Record<PolyOrderKind, { label: string; bg: string; fg: string }> = {
  simulate: { label: 'SIM',  bg: '#3a2c0d', fg: '#f0a500' },
  backtest: { label: 'BT',   bg: '#0d2438', fg: '#79c0ff' },
  live:     { label: 'LIVE', bg: '#0e3a1c', fg: '#3fb950' },
};

// ────────────────────────────────────────────────────────────────────────────
// Signal history — rolling log of emitted signals this session
// ────────────────────────────────────────────────────────────────────────────

const SignalHistory = React.memo(function SignalHistory({
  signals, pastWindows,
}: {
  signals:     LiveSignal[];
  pastWindows: PolyPastWindow[];
}) {
  // 1 row per window — keep only the LATEST emit per windowStart
  const byWindow = useMemo(() => {
    const map = new Map<number, LiveSignal>();
    for (const s of signals) {
      const prev = map.get(s.windowStart);
      if (!prev || s.emittedAt > prev.emittedAt) map.set(s.windowStart, s);
    }
    return Array.from(map.values()).sort((a, b) => b.windowStart - a.windowStart);
  }, [signals]);

  // Window outcome lookup from past-windows endpoint (null if still open)
  const outcomeByWindow = useMemo(() => {
    const map = new Map<number, 'up' | 'down' | null>();
    for (const w of pastWindows) map.set(w.windowStart, w.outcome);
    return map;
  }, [pastWindows]);

  if (!byWindow.length) return null;

  return (
    <div style={S.ordersCard}>
      <div style={S.ordersTitleRow}>
        <span style={S.ordersTitle}>Signal log ({byWindow.length})</span>
        <span style={{ fontSize: 11, color: '#8b949e' }}>
          1 row / window (latest emit) · session-scoped
        </span>
      </div>
      <div style={S.ordersTable}>
        <div style={S.signalHeader}>
          <span>Thời gian</span>
          <span>Window</span>
          <span>Streak</span>
          <span>Hướng</span>
          <span>Giá signal</span>
          <span>Mode</span>
          <span>Outcome</span>
          <span>PnL (hypo.)</span>
        </div>
        {byWindow.map(s => {
          const outcome    = outcomeByWindow.get(s.windowStart) ?? null;
          const isOpen     = Date.now() < s.windowEnd;
          const correct    = outcome != null ? s.direction === outcome : null;
          const priceEmit  = s.signalSharePrice;
          const pnlPct     = correct == null || priceEmit == null
            ? null
            : correct
              ? (1 - priceEmit) / priceEmit   // win: (1 - p) / p return
              : -1;                            // lose: -100%

          // Grayout when auto was attempted but skipped — this signal didn't
          // affect any position (no BUY placed → no TP/SL chain).
          const isSkipped = !!s.auto && !s.auto.placed;
          const rowStyle: React.CSSProperties = isSkipped
            ? { ...S.signalRow, opacity: 0.45, filter: 'grayscale(1)' }
            : S.signalRow;

          return (
            <div key={s.windowStart} style={rowStyle}
                 title={isSkipped ? `SIGNAL SKIPPED — no position taken. ${s.auto?.skipReason ?? ''}` : ''}>
              <span style={{ fontFamily: 'monospace', fontSize: 11 }}
                    title={new Date(s.emittedAt).toISOString()}>
                {new Date(s.emittedAt).toLocaleTimeString()}
              </span>
              <span style={{ fontSize: 12 }}>
                {fmtTime(s.windowStart)}→{fmtTime(s.windowEnd)}
              </span>
              <span style={{ color: s.streak > 0 ? '#3fb950' : '#f85149', fontWeight: 600 }}>
                {s.streak > 0 ? `+${s.streak}` : s.streak}
              </span>
              <span style={{ color: s.direction === 'up' ? '#3fb950' : '#f85149', fontWeight: 600 }}>
                {s.direction.toUpperCase()}
              </span>
              <span style={{ fontSize: 12, fontFamily: 'monospace' }}
                    title={`Limit for auto: ${s.autoLimitPriceCents}¢`}>
                {priceEmit != null
                  ? <>{(priceEmit * 100).toFixed(1)}¢
                      {' '}
                      <span style={{ fontSize: 10,
                             color: priceEmit * 100 <= s.autoLimitPriceCents ? '#3fb950' : '#f85149' }}>
                        {priceEmit * 100 <= s.autoLimitPriceCents ? '✓' : `>${s.autoLimitPriceCents}¢`}
                      </span>
                    </>
                  : '—'}
              </span>
              <span style={{ fontSize: 11, display: 'flex', flexDirection: 'column' }}>
                <span style={{ color: s.isAuto ? '#3fb950' : '#f0a500' }}
                      title={s.auto?.skipReason
                             ?? (s.auto?.placed ? `auto placed ${s.auto.orderId?.slice(0,8)}…` : '')}>
                  {s.isAuto ? 'AUTO' : 'MANUAL'}
                  {s.auto?.placed && ' ✓'}
                  {s.auto && !s.auto.placed && ' ⚠ SKIP'}
                </span>
                {s.auto && !s.auto.placed && s.auto.skipReason && (
                  <span style={{ fontSize: 9, color: '#f85149', fontFamily: 'monospace' }}>
                    {s.auto.skipReason.length > 40
                      ? s.auto.skipReason.slice(0, 38) + '…'
                      : s.auto.skipReason}
                  </span>
                )}
              </span>
              <span style={{ fontSize: 12,
                              color: outcome === 'up'   ? '#3fb950'
                                   : outcome === 'down' ? '#f85149'
                                   : '#8b949e' }}>
                {isOpen ? '… (đang mở)'
                        : outcome ? outcome.toUpperCase()
                                  : '—'}
              </span>
              <span style={{ fontSize: 12, fontFamily: 'monospace', fontWeight: 600,
                             color: pnlPct == null ? '#8b949e'
                                  : pnlPct >= 0   ? '#3fb950' : '#f85149' }}
                    title={priceEmit != null && pnlPct != null
                      ? `Bet $1 @ ${(priceEmit * 100).toFixed(1)}¢ → ${correct ? 'WIN' : 'LOSE'}: $${(1 + pnlPct).toFixed(2)} / $1`
                      : ''}>
                {pnlPct == null ? '—' : `${pnlPct >= 0 ? '+' : ''}${(pnlPct * 100).toFixed(0)}%`}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
});

// ────────────────────────────────────────────────────────────────────────────
// Signal banner — streak-based signals from StreakSignalEngine
// ────────────────────────────────────────────────────────────────────────────

function SignalBanner({
  signal, pastWindows, settings,
}: {
  signal:      LiveSignal | null;
  pastWindows: PolyPastWindow[];
  settings:    SettingsResponse | null;
}) {
  // Compute current streak locally so the idle banner can show WHY it's idle.
  // Same logic as backend StreakSignalEngine.computeStreak.
  const currentStreak = useMemo(() => {
    // pastWindows from API is newest-first; we want newest.
    if (!pastWindows.length) return 0;
    const newest = pastWindows[0]!.outcome;
    if (newest === null) return 0;
    let n = 0;
    for (const w of pastWindows) {
      if (w.outcome !== newest) break;
      n++;
    }
    return newest === 'up' ? n : -n;
  }, [pastWindows]);

  const signalMinStreak = signal?.signalMinStreak
    ?? Number(settings?.settings['signal_min_streak'] ?? 3);
  const autoMinStreak = signal?.autoOrderMinStreak
    ?? Number(settings?.settings['auto_order_min_streak'] ?? 4);
  const limitCents = signal?.autoLimitPriceCents
    ?? Number(settings?.settings['auto_order_limit_price_cents'] ?? 55);
  // Pulse: flash the border when signal.emittedAt changes
  const [pulse, setPulse] = useState(false);
  const lastEmittedRef = useRef<number | null>(null);
  useEffect(() => {
    if (!signal) return;
    if (lastEmittedRef.current !== signal.emittedAt) {
      lastEmittedRef.current = signal.emittedAt;
      setPulse(true);
      const t = setTimeout(() => setPulse(false), 1200);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [signal]);

  // Rerender every second so "Xs ago" stays fresh
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force(n => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  // Signal targets NEXT (unopened) window. Hide signal once target already closed.
  const isStaleByWindow = signal ? Date.now() > signal.windowEnd : false;
  const hasActiveSignal = signal && !isStaleByWindow;

  if (!hasActiveSignal) {
    const hasStreak  = Math.abs(currentStreak) > 0;
    const short      = signalMinStreak - Math.abs(currentStreak);
    const direction  = currentStreak > 0 ? 'UP' : 'DOWN';
    const dirColor   = currentStreak > 0 ? '#3fb950' : '#f85149';
    return (
      <div style={S.signalBannerIdle}>
        <span style={S.signalTagIdle}>NO SIGNAL</span>
        <span style={{ fontSize: 13, color: '#c9d1d9' }}>
          Current streak:{' '}
          {hasStreak ? (
            <>
              <strong style={{ color: dirColor }}>
                {currentStreak > 0 ? `+${currentStreak}` : currentStreak} {direction}
              </strong>
              {short > 0 && (
                <span style={{ color: '#8b949e' }}>
                  {' '}(cần thêm {short} nến nữa để ≥ {signalMinStreak} → emit signal)
                </span>
              )}
              {short <= 0 && (
                <span style={{ color: '#f0a500' }}>
                  {' '}— đã đủ threshold, signal sẽ emit sau boundary kế tiếp
                </span>
              )}
            </>
          ) : (
            <span style={{ color: '#8b949e' }}>0 (chưa có past windows)</span>
          )}
          <span style={{ color: '#6e7681', marginLeft: 8 }}>
            · threshold: ≥{signalMinStreak}=signal, ≥{autoMinStreak}=auto, limit {limitCents}¢
          </span>
        </span>
      </div>
    );
  }

  const dirLabel    = signal.direction.toUpperCase();
  const dirColor    = signal.direction === 'up' ? '#3fb950' : '#f85149';
  const streakLabel = signal.streak > 0 ? `+${signal.streak} UP streak` : `${signal.streak} DOWN streak`;
  const ageSec      = Math.max(0, Math.floor((Date.now() - signal.emittedAt) / 1000));

  const leftStripe = signal.isAuto ? '#3fb950' : '#f0a500';
  const pathLabel  = signal.path === 'panic' ? 'PANIC'
                   : signal.path === 'dca'   ? 'DCA'
                   :                           'BOUNDARY';
  const tagText    = `SIGNAL · ${pathLabel} · ${signal.isAuto ? 'AUTO' : 'MANUAL'}`;
  const tagBg      = signal.path === 'panic' ? '#3a1a0d'
                   : signal.path === 'dca'   ? '#0d2f4d'
                   : signal.isAuto           ? '#0e3a1c' : '#3a2c0d';
  const tagFg      = signal.path === 'panic' ? '#ff9f43'
                   : signal.path === 'dca'   ? '#79c0ff'
                   : signal.isAuto           ? '#3fb950' : '#f0a500';

  const auto = signal.auto;

  return (
    <div style={{
      ...S.signalBanner,
      borderLeftColor: leftStripe,
      boxShadow: pulse ? `0 0 0 2px ${leftStripe}aa` : 'none',
      transition: 'box-shadow 400ms ease-out',
    }}>
      <span style={{ ...S.signalTag, background: tagBg, color: tagFg }}>🚨 {tagText}</span>
      <span style={S.signalMain}>
        Bet <strong style={{ color: dirColor, fontSize: 15 }}>{dirLabel}</strong>
        {' '}cho window <strong>{fmtTime(signal.windowStart)}–{fmtTime(signal.windowEnd)}</strong>
        <span style={{ color: '#8b949e', marginLeft: 8 }}>
          {signal.path === 'boundary' && <>· {streakLabel} (contrarian)</>}
          {signal.path === 'dca'      && <>· averaging down @ {signal.signalSharePrice != null ? `${(signal.signalSharePrice * 100).toFixed(0)}¢` : '?'} (held side dropped ≤ {signal.autoLimitPriceCents}¢)</>}
          {signal.path === 'panic'    && <>· panic @ {signal.signalSharePrice != null ? `${(signal.signalSharePrice * 100).toFixed(0)}¢` : '?'} (momentum), {streakLabel} closed</>}
          {signal.path === 'boundary' && (
            <> · ≥{signal.signalMinStreak}=signal, ≥{signal.autoOrderMinStreak}=auto, limit {signal.autoLimitPriceCents}¢</>
          )}
        </span>
      </span>
      <span style={{ flex: 1 }} />
      <span style={S.signalAge}>{formatAge(ageSec)}</span>
      {auto?.placed && (
        <span style={{ fontSize: 12, color: '#3fb950' }}>
          ✓ Auto placed {auto.sharePrice != null ? `${(auto.sharePrice * 100).toFixed(1)}¢` : '?'} × ${auto.sizeUsdc?.toFixed(2)}
        </span>
      )}
      {auto && !auto.placed && (
        <span style={{ fontSize: 12, color: '#f0a500', maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis' }}
              title={auto.skipReason ?? ''}>
          ⚠ Skip: {auto.skipReason ?? '(no reason)'}
        </span>
      )}
      {!signal.isAuto && !auto && (
        <span style={{ fontSize: 12, color: '#8b949e' }}>
          → Click "Mua {dirLabel}" để confirm manually
        </span>
      )}
    </div>
  );
}

function formatAge(sec: number): string {
  if (sec < 60) return `${sec}s ago`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s}s ago`;
}

// ────────────────────────────────────────────────────────────────────────────
// Rules
// ────────────────────────────────────────────────────────────────────────────

const RulesCard = React.memo(function RulesCard({ market }: { market: LiveMarket | null }) {
  if (!market) return null;
  return (
    <div style={S.rulesCard}>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>Quy tắc</div>
      <div style={{ fontSize: 12, color: '#8b949e', lineHeight: 1.6 }}>
        Market này resolve <strong>"Up"</strong> nếu giá Bitcoin tại cuối window cao hơn hoặc bằng giá đầu window.
        Ngược lại resolve <strong>"Down"</strong>.
        Nguồn settlement: <a href={market.resolutionSrc} target="_blank" rel="noopener noreferrer"
                              style={{ color: '#79c0ff' }}>{market.resolutionSrc}</a>.
      </div>
    </div>
  );
});

// ────────────────────────────────────────────────────────────────────────────
// Mode banner (kept from previous LivePage)
// ────────────────────────────────────────────────────────────────────────────

function ModeBanner({
  settings, switching, onSwitch,
}: {
  settings:  SettingsResponse | null;
  switching: boolean;
  onSwitch:  (mode: 'simulate' | 'live') => void;
}) {
  if (!settings) {
    return <div style={{ color: '#8b949e', fontSize: 12, marginBottom: 16 }}>Loading settings…</div>;
  }
  const { effectiveTradingMode: mode, hasPolymarketKey } = settings;
  const stored = settings.settings['trading_mode'] ?? 'simulate';
  const forced = stored === 'live' && !hasPolymarketKey;
  const isLive = mode === 'live';

  const pill = (active: boolean, color: string): React.CSSProperties => ({
    padding:      '4px 10px',
    borderRadius: 4,
    fontSize:     12,
    fontWeight:   600,
    border:       `1px solid ${active ? color : '#30363d'}`,
    background:   active ? color : 'transparent',
    color:        active ? '#0d1117' : '#8b949e',
    cursor:       switching ? 'wait' : 'pointer',
    opacity:      switching ? 0.6 : 1,
  });

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '10px 14px', marginBottom: 12,
      background: isLive ? '#1a2b1a' : '#21262d',
      border: `1px solid ${isLive ? '#238636' : '#30363d'}`,
      borderRadius: 8,
    }}>
      <span style={{ fontSize: 13, color: '#c9d1d9' }}>
        Mode: <strong style={{ color: isLive ? '#3fb950' : '#f0a500' }}>{mode.toUpperCase()}</strong>
      </span>
      <button style={pill(mode === 'simulate', '#f0a500')}
              onClick={() => onSwitch('simulate')} disabled={switching}>Simulate</button>
      <button style={{ ...pill(mode === 'live', '#3fb950'),
                       cursor: hasPolymarketKey ? (switching ? 'wait' : 'pointer') : 'not-allowed' }}
              onClick={() => hasPolymarketKey && onSwitch('live')}
              disabled={switching || !hasPolymarketKey}
              title={hasPolymarketKey ? 'Enable real Polymarket trading' : 'POLYMARKET_API_KEY not configured'}>
        Live
      </button>
      {!hasPolymarketKey && (
        <span style={{ fontSize: 11, color: '#8b949e' }}>
          ⚠ POLYMARKET_API_KEY missing{forced ? ' — forced to simulate' : ''}
        </span>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// CoinSignalsStrip — per-coin worker events (T+4 / T-30s / T-0)
// ────────────────────────────────────────────────────────────────────────────

function CoinSignalsStrip({ coinEvents }: { coinEvents: LiveStreamState['coinEvents'] }) {
  return (
    <div style={CS.strip}>
      <div style={CS.stripTitle}>Per-coin signals</div>
      <div style={CS.cards}>
        {ALL_COINS.map(coin => (
          <CoinCard key={coin} coin={coin} entry={coinEvents[coin]} />
        ))}
      </div>
    </div>
  );
}

function CoinCard({ coin, entry }: { coin: CoinSymbol; entry?: CoinEventsEntry }) {
  const t0plus = entry?.t0plus;
  const t4     = entry?.t4;
  const t30    = entry?.t30;
  const t0     = entry?.t0;
  const hasAny = !!(t0plus || t4 || t30 || t0);

  return (
    <div style={{ ...CS.card, opacity: hasAny ? 1 : 0.55 }}>
      <div style={CS.coinName}>{coin}</div>

      {t0plus && (
        <div style={CS.section}>
          <div style={CS.phase}>
            T+0 · {fmtClock(t0plus.emittedAt)} · <span style={CS.windowChip}>{fmtWindowChip(t0plus.windowStart, t0plus.windowEnd)}</span>
            {t0plus.order.signalPath === 'dca' && <span style={CS.dcaTag}>🔄 DCA</span>}
          </div>
          <div>
            🎯 <strong>{t0plus.order.direction.toUpperCase()}</strong>
            {' @ '}{(t0plus.order.entryPrice * 100).toFixed(0)}¢
            {' · $'}{t0plus.order.sizeUsdc}
          </div>
        </div>
      )}

      {t4 ? (
        <div style={CS.section}>
          <div style={CS.phase}>T+4 · {fmtClock(t4.emittedAt)} · <span style={CS.windowChip}>{fmtWindowChip(t4.windowStart, t4.windowEnd)}</span></div>
          <div style={CS.icons}>{t4.pastStreakIcons}{t4.currentIcon}</div>
          <VolumeRow buckets={t4.streakVolumeBuckets} />
          <div>
            <span style={{ color: t4.streak > 0 ? '#3fb950' : '#f85149' }}>
              {t4.streak > 0 ? `+${t4.streak} UP` : `${t4.streak} DOWN`}
            </span>
            {' → '}
            <span style={{ color: t4.direction === 'up' ? '#3fb950' : '#f85149', fontWeight: 600 }}>
              {t4.direction === 'up' ? '🟢 UP' : '🔴 DOWN'}
            </span>
          </div>
          <div style={CS.dim}>
            {t4.price != null ? `${(t4.price * 100).toFixed(0)}¢` : '—'}
            {' · '}${t4.sizeUsdc}
            {' · '}
            <span style={{ color: t4.mode === 'signal_and_order' ? '#79c0ff' : '#8b949e' }}>
              {t4.mode === 'signal_and_order' ? 'auto' : 'signal'}
            </span>
          </div>
        </div>
      ) : (
        <div style={CS.emptySection}>T+4  —</div>
      )}

      {t30 && (
        <div style={CS.section}>
          <div style={CS.phase}>
            T-30s · <span style={CS.windowChip}>{fmtWindowChip(t30.windowStart, t30.windowEnd)}</span>
            {t30.signalPath === 'dca' && (
              <span style={CS.dcaTag}>🔄 DCA</span>
            )}
            {t30.lateRetry && (
              <span style={{ ...CS.dcaTag, background: '#3a2d0a', color: '#f0a500' }}>⏰ T-0 retry</span>
            )}
          </div>
          <div>
            {t30.action === 'order_placed'
              ? <>✅ <strong>{(t30.direction ?? '?').toUpperCase()}</strong>
                  {' @ '}{t30.price != null ? `${(t30.price * 100).toFixed(0)}¢` : '?'}
                  {' · $'}{t30.sizeUsdc ?? '?'}</>
              : t30.action === 'order_skipped'
              ? <span style={{ color: '#f0a500' }}>⚠ skip: {t30.reason ?? '—'}</span>
              : <span style={{ color: '#8b949e' }}>ℹ signal-only mode</span>}
          </div>
        </div>
      )}

      {t0 && (
        <div style={CS.section}>
          <div style={CS.phase}>T-0 · <span style={CS.windowChip}>{fmtWindowChip(t0.windowStart, t0.windowEnd)}</span></div>
          <div>
            <span style={{
              color: t0.outcome === 'up'   ? '#3fb950'
                   : t0.outcome === 'down' ? '#f85149'
                   :                         '#8b949e',
              fontWeight: 600,
            }}>
              {t0.outcome === 'up' ? '🟢 UP' : t0.outcome === 'down' ? '🔴 DOWN' : '⚪ ?'}
            </span>
            {t0.order && (
              <span style={{ marginLeft: 6, color: t0.order.pnlUsdc >= 0 ? '#3fb950' : '#f85149' }}>
                {t0.order.pnlUsdc >= 0 ? '+' : ''}${t0.order.pnlUsdc.toFixed(2)}
              </span>
            )}
          </div>
          {t0.dca && (
            <div style={{ marginTop: 2, color: '#79c0ff', fontSize: 10 }}>
              🔄 DCA placed: {t0.dca.direction.toUpperCase()} @ {(t0.dca.entryPrice * 100).toFixed(0)}¢ · ${t0.dca.sizeUsdc}
            </div>
          )}
          {t0.cancelled && (
            <div style={{ marginTop: 2, color: '#f0a500', fontSize: 10 }}>
              🚫 cancelled N+1
              <span style={{ marginLeft: 4, color: t0.cancelled.pnlUsdc >= 0 ? '#3fb950' : '#f85149' }}>
                {t0.cancelled.pnlUsdc >= 0 ? '+' : ''}${t0.cancelled.pnlUsdc.toFixed(2)}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function fmtClock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
}

function fmtWindowChip(start: number, end: number): string {
  const hhmm = (ms: number) => {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  };
  return `${hhmm(start)}-${hhmm(end)}`;
}

const VOL_STYLE: Record<VolumeBucket, { label: string; color: string }> = {
  low:     { label: 'lo',  color: '#6e7681' },
  mid:     { label: 'mid', color: '#8b949e' },
  high:    { label: 'hi',  color: '#f0a500' },
  extreme: { label: 'X',   color: '#f85149' },
  unknown: { label: '·',   color: '#4a5159' },
};

function VolumeRow({ buckets }: { buckets: VolumeBucket[] | undefined }) {
  if (!buckets?.length) return null;
  return (
    <div style={CS.volRow}>
      {buckets.map((b, i) => {
        const st = VOL_STYLE[b];
        return (
          <span key={i} style={{ ...CS.volCell, color: st.color,
                                 fontWeight: b === 'extreme' || b === 'high' ? 700 : 400 }}>
            {st.label}
          </span>
        );
      })}
    </div>
  );
}

const CS: Record<string, React.CSSProperties> = {
  strip:        { marginBottom: 12 },
  stripTitle:   { fontSize: 12, fontWeight: 600, color: '#8b949e', marginBottom: 6, textTransform: 'uppercase' as const, letterSpacing: 0.5 },
  cards:        { display: 'flex', gap: 8, overflowX: 'auto' as const, paddingBottom: 4 },
  card:         { flex: '0 0 190px', background: '#161b22', border: '1px solid #30363d',
                  borderRadius: 6, padding: '8px 10px', fontSize: 11, color: '#c9d1d9', lineHeight: 1.5 },
  coinName:     { fontSize: 14, fontWeight: 700, color: '#c9d1d9', marginBottom: 6,
                  paddingBottom: 4, borderBottom: '1px solid #21262d' },
  section:      { marginTop: 6 },
  phase:        { fontSize: 10, color: '#8b949e', fontWeight: 600, letterSpacing: 0.3 },
  icons:        { fontSize: 14, letterSpacing: 0, marginTop: 2 },
  volRow:       { display: 'flex', gap: 2, fontSize: 9, fontFamily: 'monospace', marginTop: 1, letterSpacing: 0.3 },
  volCell:      { width: 17, textAlign: 'center' as const, textTransform: 'uppercase' as const },
  dcaTag:       { marginLeft: 6, padding: '1px 4px', background: '#1f3a4d', color: '#79c0ff',
                  borderRadius: 3, fontSize: 9, fontWeight: 700 },
  windowChip:   { display: 'inline-block', padding: '0 4px', background: '#21262d',
                  color: '#c9d1d9', borderRadius: 3, fontSize: 9, fontFamily: 'monospace',
                  fontWeight: 600, letterSpacing: 0.3 },
  dim:          { fontSize: 10, color: '#8b949e', marginTop: 2 },
  emptySection: { fontSize: 10, color: '#4a5159', marginTop: 6 },
};

// ────────────────────────────────────────────────────────────────────────────
// Helpers + styles
// ────────────────────────────────────────────────────────────────────────────

function midPrice(bid: number | null | undefined, ask: number | null | undefined): number | null {
  if (bid == null && ask == null) return null;
  if (bid == null) return ask ?? null;
  if (ask == null) return bid;
  return (bid + ask) / 2;
}

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function fmtWindow(startMs: number, endMs: number): string {
  return `${fmtTime(startMs)} → ${fmtTime(endMs)} (${new Date(startMs).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })})`;
}

const S: Record<string, React.CSSProperties> = {
  page:        { padding: '0 4px' },
  errorBar:    { color: '#f85149', padding: '8px 12px', background: '#21262d', borderRadius: 6, marginBottom: 12, fontSize: 13 },

  mainGrid:    { display: 'grid', gridTemplateColumns: '1fr 320px', gap: 16, marginBottom: 16 },
  leftPane:    { display: 'flex', flexDirection: 'column', gap: 12 },
  rightPane:   {},

  headerCard:  { background: '#161b22', border: '1px solid #30363d', borderRadius: 8, padding: 16 },
  btcIcon:     { width: 40, height: 40, borderRadius: 8, background: '#f0a500', color: '#000',
                 display: 'grid', placeItems: 'center', fontSize: 20, fontWeight: 700 },
  headerTitle: { fontSize: 18, fontWeight: 700, color: '#c9d1d9' },
  headerSubtitle: { fontSize: 12, color: '#8b949e', marginTop: 2 },
  upcomingPill:{ marginLeft: 8, padding: '2px 8px', background: '#30363d', borderRadius: 4, fontSize: 10, color: '#8b949e' },
  label:       { fontSize: 11, color: '#8b949e' },
  countdown:   { display: 'flex', gap: 4, alignItems: 'baseline', justifyContent: 'flex-end', marginTop: 2 },
  countMin:    { fontSize: 28, fontWeight: 700, color: '#f85149', fontFamily: 'monospace', lineHeight: 1 },
  countLabel:  { fontSize: 9, color: '#8b949e', letterSpacing: 0.5, marginRight: 6 },

  priceRow:    { display: 'flex', gap: 32, marginTop: 16 },
  bigPrice:    { fontSize: 22, fontWeight: 600, color: '#f0a500', marginTop: 2 },
  midPrice:    { fontSize: 22, fontWeight: 600, marginTop: 2 },

  chartCard:   { background: '#161b22', border: '1px solid #30363d', borderRadius: 8, padding: 12 },
  chartLegend: { fontSize: 11, color: '#8b949e', marginTop: 6 },

  tabsRow:     { display: 'flex', gap: 6 },
  tab:         { padding: '6px 14px', borderRadius: 18, border: '1px solid #30363d',
                 background: '#161b22', color: '#8b949e', fontSize: 12, cursor: 'pointer' },
  tabActive:   { background: '#21262d', color: '#c9d1d9', borderColor: '#444c56' },

  slotsRow:    { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' },
  slot:        { display: 'flex', alignItems: 'center', gap: 4,
                 padding: '6px 12px', borderRadius: 18, border: '1px solid #30363d',
                 background: '#0d1117', color: '#8b949e', fontSize: 12, cursor: 'pointer' },
  slotActive:  { background: '#21262d', color: '#c9d1d9', borderColor: '#444c56' },
  slotDot:     { width: 6, height: 6, background: '#f85149', borderRadius: '50%' },

  pastGroup:   { display: 'flex', alignItems: 'center', gap: 4, paddingRight: 8,
                 borderRight: '1px solid #30363d', marginRight: 4 },
  pastLabel:   { fontSize: 11, color: '#8b949e', marginRight: 4 },
  pastDot:     { width: 18, height: 18, borderRadius: '50%', display: 'inline-grid',
                 placeItems: 'center', fontSize: 10, fontWeight: 700, color: '#0d1117' },

  tradeCard:   { background: '#161b22', border: '1px solid #30363d', borderRadius: 8, padding: 16 },
  miniTabs:    { display: 'flex', gap: 16, alignItems: 'center', borderBottom: '1px solid #21262d', paddingBottom: 8, marginBottom: 12 },
  miniTab:     { background: 'transparent', border: 'none', color: '#8b949e', fontSize: 14, cursor: 'pointer', padding: '4px 0' },
  miniTabActive:{ color: '#c9d1d9', fontWeight: 600, borderBottom: '2px solid #1f6feb' },

  dirRow:      { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 },
  dirBtn:      { padding: '12px 8px', borderRadius: 6, border: '1px solid', cursor: 'pointer',
                 fontSize: 14, fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  dirPrice:    { fontSize: 13, fontWeight: 500, opacity: 0.9 },

  tradeRow:    { display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '8px 0' },
  qtyBtn:      { padding: '4px 8px', background: '#21262d', color: '#c9d1d9', border: '1px solid #30363d',
                 borderRadius: 4, cursor: 'pointer', fontSize: 11 },
  qtyInput:    { width: 70, padding: '4px 8px', background: '#0d1117', border: '1px solid #30363d',
                 color: '#c9d1d9', borderRadius: 4, fontSize: 13, textAlign: 'right' },
  placeBtn:    { width: '100%', padding: '12px', borderRadius: 6, border: 'none',
                 fontSize: 14, fontWeight: 600, marginTop: 12 },

  ordersCard:    { background: '#161b22', border: '1px solid #30363d', borderRadius: 8, padding: 16, marginBottom: 16 },
  ordersTitleRow:{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  ordersTitle:   { fontSize: 14, fontWeight: 600, color: '#c9d1d9' },
  orderTab:      { padding: '4px 10px', borderRadius: 14, border: '1px solid #30363d',
                   background: '#161b22', color: '#8b949e', fontSize: 11, cursor: 'pointer' },
  ordersTable:   { display: 'flex', flexDirection: 'column', gap: 4 },
  ordersHeader:  { display: 'grid',
                   gridTemplateColumns: '90px 50px 55px 55px 60px 65px 90px 1fr',
                   fontSize: 11, color: '#8b949e', padding: '4px 0', borderBottom: '1px solid #21262d' },
  ordersRow:     { display: 'grid',
                   gridTemplateColumns: '90px 50px 55px 55px 60px 65px 90px 1fr',
                   fontSize: 13, color: '#c9d1d9', padding: '6px 0', alignItems: 'center' },

  windowGroup:       { border: '1px solid #21262d', borderRadius: 6, marginBottom: 12,
                       background: '#0d1117', padding: '0 12px 8px' },
  windowGroupHeader: { display: 'flex', alignItems: 'center', gap: 10,
                       padding: '10px 0 6px', borderBottom: '1px solid #21262d',
                       fontSize: 13, color: '#c9d1d9' },
  kindBadge:     { padding: '2px 6px', borderRadius: 3, fontSize: 10, fontWeight: 700, letterSpacing: 0.4 },
  sourceMini:    { padding: '1px 5px', borderRadius: 3, fontSize: 9,
                   background: '#21262d', color: '#8b949e', textTransform: 'uppercase' },

  rulesCard:   { background: '#161b22', border: '1px solid #30363d', borderRadius: 8, padding: 16 },

  signalBanner:{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px',
                 background: '#161b22', border: '1px solid #30363d', borderLeftWidth: 4,
                 borderLeftStyle: 'solid', borderRadius: 6, marginBottom: 12 },
  signalBannerIdle:{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px',
                 background: '#0d1117', border: '1px dashed #30363d', borderRadius: 6,
                 marginBottom: 12 },
  signalTag:   { padding: '2px 8px', borderRadius: 4, fontSize: 10, fontWeight: 700, letterSpacing: 0.5 },
  signalTagIdle:{ padding: '2px 8px', borderRadius: 4, fontSize: 10, fontWeight: 700,
                 letterSpacing: 0.5, background: '#21262d', color: '#8b949e' },
  signalMain:  { fontSize: 13, color: '#c9d1d9' },
  signalAge:   { fontSize: 11, color: '#8b949e', fontFamily: 'monospace' },

  signalHeader:{ display: 'grid',
                 gridTemplateColumns: '90px 150px 60px 60px 80px 80px 90px 90px',
                 fontSize: 11, color: '#8b949e', padding: '4px 0',
                 borderBottom: '1px solid #21262d' },
  signalRow:   { display: 'grid',
                 gridTemplateColumns: '90px 150px 60px 60px 80px 80px 90px 90px',
                 fontSize: 13, color: '#c9d1d9', padding: '6px 0', alignItems: 'center' },
};
