import React, { useEffect, useRef, useCallback } from 'react';
import {
  createChart,
  type IChartApi,
  type ISeriesApi,
  type CandlestickData,
  type Time,
  type MouseEventParams,
} from 'lightweight-charts';
import type { CandleRow } from '../api/client.js';

interface Props {
  candles: CandleRow[];
  /** Called with the candle's ts (ms) when user clicks a bar */
  onSelect?: (ts: number) => void;
  /** Highlighted timestamp (ms) — shown as a marker */
  selectedTs?: number | null;
  height?: number;
}

function toChartData(c: CandleRow): CandlestickData<Time> {
  return {
    time: (c.ts / 1000) as Time,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
  };
}

export default function CandleChart({ candles, onSelect, selectedTs, height = 360 }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef     = useRef<IChartApi | null>(null);
  const seriesRef    = useRef<ISeriesApi<'Candlestick'> | null>(null);

  // Init chart once
  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      layout: { background: { color: '#0d1117' }, textColor: '#c9d1d9' },
      grid:   { vertLines: { color: '#21262d' }, horzLines: { color: '#21262d' } },
      timeScale: { timeVisible: true, secondsVisible: false },
      height,
    });
    const series = chart.addCandlestickSeries({
      upColor:   '#3fb950',
      downColor: '#f85149',
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
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Update data
  useEffect(() => {
    if (!seriesRef.current || candles.length === 0) return;
    seriesRef.current.setData(candles.map(toChartData));
    chartRef.current?.timeScale().fitContent();
  }, [candles]);

  // Click handler
  const handleClick = useCallback((params: MouseEventParams<Time>) => {
    if (!params.time || !onSelect) return;
    const tsMs = (params.time as number) * 1000;
    onSelect(tsMs);
  }, [onSelect]);

  useEffect(() => {
    chartRef.current?.subscribeClick(handleClick);
    return () => { chartRef.current?.unsubscribeClick(handleClick); };
  }, [handleClick]);

  // Marker for selected candle
  useEffect(() => {
    if (!seriesRef.current) return;
    if (!selectedTs) { seriesRef.current.setMarkers([]); return; }
    seriesRef.current.setMarkers([{
      time: (selectedTs / 1000) as Time,
      position: 'aboveBar',
      color: '#f0a500',
      shape: 'arrowDown',
      text: 'Signal',
    }]);
  }, [selectedTs]);

  return <div ref={containerRef} style={{ width: '100%', height }} />;
}
