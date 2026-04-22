import React, { useEffect, useRef } from 'react';
import {
  createChart,
  type IChartApi,
  type Time,
} from 'lightweight-charts';
import type { EquityPoint } from '../api/client.js';

interface Props {
  data: EquityPoint[];
  height?: number;
}

export default function EquityChart({ data, height = 240 }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef     = useRef<IChartApi | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      layout: { background: { color: '#0d1117' }, textColor: '#c9d1d9' },
      grid:   { vertLines: { color: '#21262d' }, horzLines: { color: '#21262d' } },
      timeScale: { timeVisible: true },
      height,
    });
    const series = chart.addLineSeries({ color: '#1f6feb', lineWidth: 2 });
    chartRef.current = chart;

    const ro = new ResizeObserver(() => {
      chart.applyOptions({ width: containerRef.current!.clientWidth });
    });
    ro.observe(containerRef.current);

    if (data.length > 0) {
      series.setData(data.map(d => ({ time: (d.ts / 1000) as Time, value: d.equity })));
      chart.timeScale().fitContent();
    }

    return () => { ro.disconnect(); chart.remove(); };
  }, [data, height]);

  return <div ref={containerRef} style={{ width: '100%', height }} />;
}
