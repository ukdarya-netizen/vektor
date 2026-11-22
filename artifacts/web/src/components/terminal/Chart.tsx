import { useEffect, useRef } from "react";
import { CandlestickSeries, ColorType, createChart, HistogramSeries, LineStyle, type IChartApi, type IPriceLine, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";

export type Candle = [number, number, number, number, number, number];
export type ChartLine = { price: number; title: string; color: string; dashed?: boolean };

const UP = "#22c58b";
const DOWN = "#f0525f";

/**
 * Candles + volume. History via setData; the forming candle via update().
 * Lines (entry, liquidation, orders) are labelled with text, not only colour.
 */
export function Chart({ candles, live, lines, precision }: { candles: Candle[] | null; live: Candle | null; lines: ChartLine[]; precision: number }) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const cs = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const vs = useRef<ISeriesApi<"Histogram"> | null>(null);
  const priceLines = useRef<IPriceLine[]>([]);

  useEffect(() => {
    if (!box.current) return;
    const c = createChart(box.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: "#8b95a7", fontFamily: "Inter, system-ui, sans-serif" },
      grid: { vertLines: { color: "#1a2130" }, horzLines: { color: "#1a2130" } },
      rightPriceScale: { borderColor: "#232c3d" },
      timeScale: { borderColor: "#232c3d", timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 },
    });
    cs.current = c.addSeries(CandlestickSeries, { upColor: UP, downColor: DOWN, borderVisible: false, wickUpColor: UP, wickDownColor: DOWN });
    vs.current = c.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "vol", lastValueVisible: false, priceLineVisible: false });
    c.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    chart.current = c;
    return () => { c.remove(); chart.current = null; cs.current = null; vs.current = null; priceLines.current = []; };
  }, []);

  useEffect(() => {
    cs.current?.applyOptions({ priceFormat: { type: "price", precision, minMove: Math.pow(10, -precision) } });
  }, [precision]);

  useEffect(() => {
    if (!cs.current || !vs.current) return;
    const rows = candles ?? [];
    cs.current.setData(rows.map((r) => ({ time: (r[0] / 1000) as UTCTimestamp, open: r[1], high: r[2], low: r[3], close: r[4] })));
    vs.current.setData(rows.map((r) => ({ time: (r[0] / 1000) as UTCTimestamp, value: r[5], color: r[4] >= r[1] ? "rgba(34,197,139,0.35)" : "rgba(240,82,95,0.35)" })));
    chart.current?.timeScale().fitContent();
  }, [candles]);

  useEffect(() => {
    if (!live || !cs.current || !vs.current || !candles?.length) return;
    // Never update with an older candle than the last one drawn (lightweight-charts would throw).
    if (live[0] < candles[candles.length - 1][0]) return;
    const time = (live[0] / 1000) as UTCTimestamp;
    try {
      cs.current.update({ time, open: live[1], high: live[2], low: live[3], close: live[4] });
      vs.current.update({ time, value: live[5], color: live[4] >= live[1] ? "rgba(34,197,139,0.35)" : "rgba(240,82,95,0.35)" });
    } catch { /* out-of-order tick */ }
  }, [live, candles]);

  useEffect(() => {
    const s = cs.current;
    if (!s) return;
    for (const l of priceLines.current) s.removePriceLine(l);
    priceLines.current = lines.map((l) => s.createPriceLine({ price: l.price, color: l.color, lineWidth: 1, lineStyle: l.dashed ? LineStyle.Dashed : LineStyle.Solid, axisLabelVisible: true, title: l.title }));
  }, [lines]);

  return <div ref={box} className="h-full w-full" />;
}
