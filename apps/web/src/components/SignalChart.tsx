import { useEffect, useMemo, useRef } from 'react';
import {
  createChart,
  type IChartApi,
  type ISeriesApi,
  type CandlestickData,
  type Time,
  type SeriesMarker,
} from 'lightweight-charts';
import type { CandleRow, SignalRow } from '../api/client.js';

interface Props {
  /** All 1m candles for the run (the component slices the window it needs). */
  candles1m: CandleRow[];
  signal:    SignalRow;
  /** Number of 5m candles to show before the signal session (default 15). */
  before?:   number;
  /** Number of 5m candles to show after the applied session (default 3). */
  after?:    number;
  height?:   number;
}

/**
 * Session chart — aggregates 1m candles into 5m bars and renders a candlestick
 * chart centred on the signal session, with markers for:
 *   • "Streak" — the 5m bar whose close triggered the signal
 *   • "Entry"  — the applied 5m bar where the trade opens
 *   • "Exit"   — same bar; colour = win/loss from the signal's outcome
 */
export default function SignalChart({
  candles1m,
  signal,
  before = 15,
  after  = 3,
  height = 280,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef     = useRef<IChartApi | null>(null);
  const seriesRef    = useRef<ISeriesApi<'Candlestick'> | null>(null);

  // Signal session boundaries
  const signalSessionStart = Math.floor(signal.ts / 300_000) * 300_000;
  const appliedStart       = signalSessionStart + 300_000;
  const windowStart        = signalSessionStart - before * 300_000;
  const windowEnd          = appliedStart + after * 300_000;   // inclusive of `after` bars beyond applied

  // Aggregate 1m → 5m within the window
  const fiveMin: CandleRow[] = useMemo(() => {
    const groups = new Map<number, CandleRow[]>();
    for (const c of candles1m) {
      if (c.ts < windowStart || c.ts > windowEnd + 300_000) continue;
      const key = Math.floor(c.ts / 300_000) * 300_000;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(c);
    }
    return [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([key, gs]) => {
      const sorted = [...gs].sort((a, b) => a.ts - b.ts);
      return {
        ts:     key,
        open:   sorted[0]!.open,
        high:   Math.max(...sorted.map(c => c.high)),
        low:    Math.min(...sorted.map(c => c.low)),
        close:  sorted[sorted.length - 1]!.close,
        volume: sorted.reduce((s, c) => s + c.volume, 0),
      };
    });
  }, [candles1m, windowStart, windowEnd]);

  // Init chart once
  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      layout:    { background: { color: '#0d1117' }, textColor: '#c9d1d9' },
      grid:      { vertLines: { color: '#21262d' }, horzLines: { color: '#21262d' } },
      timeScale: { timeVisible: true, secondsVisible: false, borderColor: '#30363d' },
      rightPriceScale: { borderColor: '#30363d' },
      height,
      crosshair: { mode: 1 },
    });
    const series = chart.addCandlestickSeries({
      upColor:         '#3fb950',
      downColor:       '#f85149',
      borderUpColor:   '#3fb950',
      borderDownColor: '#f85149',
      wickUpColor:     '#3fb950',
      wickDownColor:   '#f85149',
    });
    chartRef.current  = chart;
    seriesRef.current = series;

    const ro = new ResizeObserver(() => {
      chart.applyOptions({ width: containerRef.current!.clientWidth });
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current  = null;
      seriesRef.current = null;
    };
  }, [height]);

  // Update data + markers whenever inputs change
  useEffect(() => {
    const series = seriesRef.current;
    if (!series || fiveMin.length === 0) return;

    const data: CandlestickData<Time>[] = fiveMin.map(c => ({
      time:  (c.ts / 1000) as Time,
      open:  c.open,
      high:  c.high,
      low:   c.low,
      close: c.close,
    }));
    series.setData(data);

    // Markers
    const markers: SeriesMarker<Time>[] = [];
    const hasSignalBar  = fiveMin.some(c => c.ts === signalSessionStart);
    const hasAppliedBar = fiveMin.some(c => c.ts === appliedStart);
    const dirText = signal.direction === 'BUY' ? '▲ up' : signal.direction === 'SELL' ? '▼ down' : signal.direction;

    if (hasSignalBar) {
      markers.push({
        time:     (signalSessionStart / 1000) as Time,
        position: 'aboveBar',
        color:    '#f0a500',
        shape:    'arrowDown',
        text:     `Streak (${dirText})`,
      });
    }

    if (hasAppliedBar) {
      // Entry = prev 5m close. Marker sits on the applied bar (entry time).
      markers.push({
        time:     (appliedStart / 1000) as Time,
        position: 'belowBar',
        color:    signal.direction === 'BUY' ? '#3fb950' : '#f85149',
        shape:    signal.direction === 'BUY' ? 'arrowUp' : 'arrowDown',
        text:     `Entry ${signal.price_entry?.toFixed(2) ?? ''} (prev close)`,
      });

      // Exit = 4th 1m close of applied session (+3m). Colour = outcome.
      const exitColor = signal.outcome === 'win'  ? '#3fb950'
                      : signal.outcome === 'loss' ? '#f85149'
                      : '#8b949e';
      const pnl = signal.pnl_pct != null ? `${(signal.pnl_pct * 100).toFixed(2)}%` : '—';
      markers.push({
        time:     (appliedStart / 1000) as Time,
        position: 'aboveBar',
        color:    exitColor,
        shape:    'circle',
        text:     `Exit +3m ${signal.exit_price?.toFixed(2) ?? ''} · ${pnl}`,
      });
    }

    series.setMarkers(markers);
    chartRef.current?.timeScale().fitContent();
  }, [fiveMin, signal, signalSessionStart, appliedStart]);

  if (fiveMin.length === 0) {
    return (
      <div style={{ padding: 12, color: '#8b949e', fontSize: 12 }}>
        Candles not available for this signal (run candles may not be cached).
      </div>
    );
  }

  return <div ref={containerRef} style={{ width: '100%', height }} />;
}
