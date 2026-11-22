import { useEffect, useRef } from "react";
import {
  CandlestickSeries, ColorType, createChart, HistogramSeries, LineSeries, LineStyle,
  type IChartApi, type IPriceLine, type ISeriesApi, type UTCTimestamp,
} from "lightweight-charts";
import { compute, INDICATORS, type IndicatorConf } from "./indicators";

export type Candle = [number, number, number, number, number, number];
/** dragId: the line can be moved with the mouse (stop / take of a managed position). */
export type ChartLine = { price: number; title: string; color: string; dashed?: boolean; dragId?: string };

export type Pt = { time: number; price: number };
export type Drawing =
  | { id: string; type: "hline"; a: Pt }
  | { id: string; type: "vline"; a: Pt }
  | { id: string; type: "trend" | "ray" | "rect" | "fib" | "measure"; a: Pt; b: Pt }
  | { id: string; type: "text"; a: Pt; text: string };
export type Tool = "cursor" | "hline" | "vline" | "trend" | "ray" | "rect" | "fib" | "text" | "measure";

// Brand candles: blue up, violet down (as in the VECTOR design).
const UP = "#3b82f6";
const DOWN = "#8b5cf6";
const VOL_UP = "rgba(59,130,246,0.38)";
const VOL_DOWN = "rgba(139,92,246,0.38)";
const FIB = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
const uid = () => Math.random().toString(36).slice(2, 10);

type Props = {
  candles: Candle[] | null; live: Candle | null; lines: ChartLine[]; precision: number;
  indicators: IndicatorConf[];
  drawings: Drawing[]; onDrawings: (d: Drawing[]) => void;
  tool: Tool; onToolDone: () => void; magnet: boolean; locked: boolean; hidden: boolean;
  onLineDrag: (dragId: string, price: number) => void;
  askText: () => string | null;
};

/**
 * Candles, volume and indicators (lightweight-charts), plus a canvas on top for drawings and
 * for dragging stop/take lines. The canvas takes the mouse only when a tool is active or the
 * pointer is on a drawing/draggable line; otherwise the chart pans and zooms as usual.
 */
export function Chart(p: Props) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const cs = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const vs = useRef<ISeriesApi<"Histogram"> | null>(null);
  const priceLines = useRef<IPriceLine[]>([]);
  const indSeries = useRef<Array<ISeriesApi<any>>>([]);
  const st = useRef({ p, draft: null as Drawing | null, selected: null as string | null, drag: null as null | { kind: "line"; id: string; price: number } | { kind: "pt"; id: string; which: "a" | "b"; } | { kind: "move"; id: string; from: Pt } });
  st.current.p = p;

  /* ---------- chart ---------- */
  useEffect(() => {
    if (!box.current) return;
    const c = createChart(box.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: "#8a94a8", fontFamily: "'JetBrains Mono Variable', ui-monospace, monospace", fontSize: 11, panes: { separatorColor: "#1e293b" }, attributionLogo: false },
      grid: { vertLines: { color: "rgba(30,41,59,0.55)" }, horzLines: { color: "rgba(30,41,59,0.55)" } },
      rightPriceScale: { borderColor: "#1e293b" },
      timeScale: { borderColor: "#1e293b", timeVisible: true, secondsVisible: false, rightOffset: 8 },
      crosshair: { mode: 0, vertLine: { color: "#475569", labelBackgroundColor: "#1e293b" }, horzLine: { color: "#475569", labelBackgroundColor: "#1e293b" } },
    });
    cs.current = c.addSeries(CandlestickSeries, { upColor: UP, downColor: DOWN, borderVisible: false, wickUpColor: UP, wickDownColor: DOWN, priceLineColor: "#8b5cf6" });
    vs.current = c.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "vol", lastValueVisible: false, priceLineVisible: false });
    c.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    chart.current = c;
    return () => { c.remove(); chart.current = null; cs.current = null; vs.current = null; priceLines.current = []; indSeries.current = []; };
  }, []);

  useEffect(() => { cs.current?.applyOptions({ priceFormat: { type: "price", precision: p.precision, minMove: Math.pow(10, -p.precision) } }); }, [p.precision]);

  useEffect(() => {
    if (!cs.current || !vs.current) return;
    const rows = p.candles ?? [];
    cs.current.setData(rows.map((r) => ({ time: (r[0] / 1000) as UTCTimestamp, open: r[1], high: r[2], low: r[3], close: r[4] })));
    vs.current.setData(rows.map((r) => ({ time: (r[0] / 1000) as UTCTimestamp, value: r[5], color: r[4] >= r[1] ? VOL_UP : VOL_DOWN })));
    chart.current?.timeScale().fitContent();
  }, [p.candles]);

  useEffect(() => {
    const live = p.live, rows = p.candles;
    if (!live || !cs.current || !vs.current || !rows?.length || live[0] < rows[rows.length - 1][0]) return;
    const time = (live[0] / 1000) as UTCTimestamp;
    try {
      cs.current.update({ time, open: live[1], high: live[2], low: live[3], close: live[4] });
      vs.current.update({ time, value: live[5], color: live[4] >= live[1] ? VOL_UP : VOL_DOWN });
    } catch { /* out-of-order tick */ }
  }, [p.live, p.candles]);

  useEffect(() => {
    const s = cs.current;
    if (!s) return;
    for (const l of priceLines.current) s.removePriceLine(l);
    priceLines.current = p.lines.map((l) => s.createPriceLine({ price: l.price, color: l.color, lineWidth: l.dragId ? 2 : 1, lineStyle: l.dashed ? LineStyle.Dashed : LineStyle.Solid, axisLabelVisible: true, title: l.dragId ? `${l.title} ⇕` : l.title }));
  }, [p.lines]);

  /* ---------- indicators: overlays on the price pane, oscillators in their own panes ---------- */
  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    for (const s of indSeries.current) c.removeSeries(s);
    indSeries.current = [];
    const rows = p.candles ?? [];
    if (!rows.length) return;
    let pane = 0;
    for (const conf of p.indicators) {
      const meta = INDICATORS[conf.id];
      const paneIndex = meta.overlay ? 0 : ++pane;
      for (const line of compute(conf, rows)) {
        const data = rows.map((r, i) => (line.values[i] === null ? { time: (r[0] / 1000) as UTCTimestamp } : { time: (r[0] / 1000) as UTCTimestamp, value: line.values[i] as number }));
        const s = line.kind === "hist"
          ? c.addSeries(HistogramSeries, { color: line.color, priceLineVisible: false, lastValueVisible: false }, paneIndex)
          : c.addSeries(LineSeries, { color: line.color, lineWidth: 1, priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false, title: line.name }, paneIndex);
        s.setData(data as any);
        for (const lv of line.levels ?? []) s.createPriceLine({ price: lv, color: "#3a4559", lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: false, title: "" });
        indSeries.current.push(s);
      }
    }
    const panes = c.panes();
    for (let i = 1; i < panes.length; i++) panes[i].setHeight(110);
  }, [p.indicators, p.candles]);

  /* ---------- coordinates ---------- */
  const barMs = () => {
    const r = st.current.p.candles;
    return r && r.length > 1 ? r[r.length - 1][0] - r[r.length - 2][0] : 60_000;
  };
  const timeToX = (time: number): number | null => {
    const r = st.current.p.candles, c = chart.current;
    if (!r?.length || !c) return null;
    let lo = 0, hi = r.length - 1;
    if (time >= r[hi][0]) return c.timeScale().logicalToCoordinate((hi + (time - r[hi][0]) / barMs()) as any);
    if (time <= r[0][0]) return c.timeScale().logicalToCoordinate(((time - r[0][0]) / barMs()) as any);
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (r[m][0] <= time) lo = m; else hi = m; }
    return c.timeScale().logicalToCoordinate((lo + (time - r[lo][0]) / (r[hi][0] - r[lo][0])) as any);
  };
  const xToTime = (x: number): number | null => {
    const r = st.current.p.candles, c = chart.current;
    if (!r?.length || !c) return null;
    const lg = c.timeScale().coordinateToLogical(x);
    if (lg === null) return null;
    const i = Math.round(lg);
    if (i >= 0 && i < r.length) return r[i][0];
    return i < 0 ? r[0][0] + i * barMs() : r[r.length - 1][0] + (i - r.length + 1) * barMs();
  };
  const yToPrice = (y: number): number | null => cs.current?.coordinateToPrice(y as any) ?? null;
  const priceToY = (price: number): number | null => cs.current?.priceToCoordinate(price) ?? null;

  /** Magnet: snap to the nearest OHLC of the bar under the cursor (within 12 px). */
  const snap = (x: number, y: number): Pt | null => {
    const time = xToTime(x), price = yToPrice(y);
    if (time === null || price === null) return null;
    if (!st.current.p.magnet) return { time, price };
    const bar = st.current.p.candles?.find((r) => r[0] === time);
    if (!bar) return { time, price };
    let best = price, dist = 12;
    for (const v of [bar[1], bar[2], bar[3], bar[4]]) { const yy = priceToY(v); if (yy !== null && Math.abs(yy - y) < dist) { dist = Math.abs(yy - y); best = v; } }
    return { time, price: best };
  };

  /* ---------- drawing ---------- */
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const cv = canvas.current, el = box.current, c = chart.current;
      if (!cv || !el || !c) return;
      const dpr = window.devicePixelRatio || 1;
      const w = el.clientWidth, h = el.clientHeight;
      if (cv.width !== w * dpr || cv.height !== h * dpr) { cv.width = w * dpr; cv.height = h * dpr; cv.style.width = `${w}px`; cv.style.height = `${h}px`; }
      const g = cv.getContext("2d")!;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      const plotW = w - (c.priceScale("right").width() || 60);
      const paneH = c.panes()[0]?.getHeight() ?? h;
      g.save();
      g.beginPath(); g.rect(0, 0, plotW, paneH); g.clip();
      const S = st.current;
      const all = [...(S.p.hidden ? [] : S.p.drawings), ...(S.draft ? [S.draft] : [])];
      for (const d of all) paint(g, d, d.id === S.selected, plotW, paneH);
      // Ghost of a line being dragged.
      if (S.drag?.kind === "line") {
        const y = priceToY(S.drag.price);
        if (y !== null) {
          g.strokeStyle = "#ffffff"; g.setLineDash([6, 4]); g.lineWidth = 1.5;
          g.beginPath(); g.moveTo(0, y); g.lineTo(plotW, y); g.stroke(); g.setLineDash([]);
          g.fillStyle = "#ffffff"; g.font = "12px Inter, sans-serif";
          g.fillText(S.drag.price.toFixed(S.p.precision), 8, y - 6);
        }
      }
      g.restore();
    };
    const paint = (g: CanvasRenderingContext2D, d: Drawing, sel: boolean, plotW: number, paneH: number) => {
      const P = st.current.p;
      const ax = timeToX(d.a.time), ay = priceToY(d.a.price);
      if (ay === null) return;
      g.strokeStyle = sel ? "#ffffff" : "#5b8cff"; g.fillStyle = sel ? "#ffffff" : "#5b8cff"; g.lineWidth = sel ? 2 : 1.5;
      g.font = "12px Inter, sans-serif";
      const handle = (x: number, y: number) => { if (sel) { g.beginPath(); g.arc(x, y, 4, 0, Math.PI * 2); g.fill(); } };
      if (d.type === "hline") { g.beginPath(); g.moveTo(0, ay); g.lineTo(plotW, ay); g.stroke(); g.fillText(d.a.price.toFixed(P.precision), 6, ay - 4); return; }
      if (ax === null) return;
      if (d.type === "vline") { g.beginPath(); g.moveTo(ax, 0); g.lineTo(ax, paneH); g.stroke(); return; }
      if (d.type === "text") { g.fillText(d.text, ax, ay); handle(ax, ay); return; }
      const bx = timeToX(d.b.time), by = priceToY(d.b.price);
      if (bx === null || by === null) return;
      if (d.type === "trend" || d.type === "ray") {
        let ex = bx, ey = by;
        if (d.type === "ray" && bx !== ax) { const k = (by - ay) / (bx - ax); ex = bx > ax ? plotW : 0; ey = ay + k * (ex - ax); }
        g.beginPath(); g.moveTo(ax, ay); g.lineTo(ex, ey); g.stroke(); handle(ax, ay); handle(bx, by);
      } else if (d.type === "rect") {
        g.globalAlpha = 0.12; g.fillRect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay)); g.globalAlpha = 1;
        g.strokeRect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay)); handle(ax, ay); handle(bx, by);
      } else if (d.type === "fib") {
        for (const f of FIB) {
          const price = d.b.price + (d.a.price - d.b.price) * f;
          const y = priceToY(price); if (y === null) continue;
          g.globalAlpha = f === 0 || f === 1 ? 1 : 0.7;
          g.beginPath(); g.moveTo(Math.min(ax, bx), y); g.lineTo(Math.max(ax, bx), y); g.stroke();
          g.fillText(`${f} (${price.toFixed(P.precision)})`, Math.max(ax, bx) + 4, y + 4);
        }
        g.globalAlpha = 1; handle(ax, ay); handle(bx, by);
      } else if (d.type === "measure") {
        const pct = ((d.b.price - d.a.price) / d.a.price) * 100;
        const bars = Math.round((d.b.time - d.a.time) / barMs());
        g.globalAlpha = 0.15; g.fillStyle = pct >= 0 ? UP : DOWN; g.fillRect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay)); g.globalAlpha = 1;
        g.fillStyle = "#e6e9ef";
        g.fillText(`${pct >= 0 ? "+" : ""}${pct.toFixed(2)}% · ${(d.b.price - d.a.price).toFixed(P.precision)} · ${bars} bars`, Math.min(ax, bx) + 4, Math.min(ay, by) - 6);
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  /* ---------- hit testing ---------- */
  const distSeg = (px: number, py: number, x1: number, y1: number, x2: number, y2: number) => {
    const dx = x2 - x1, dy = y2 - y1, l = dx * dx + dy * dy;
    const t = l ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / l)) : 0;
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  };
  const hit = (x: number, y: number): null | { kind: "line"; id: string; price: number } | { kind: "pt"; id: string; which: "a" | "b" } | { kind: "body"; id: string } => {
    const P = st.current.p;
    // Stop/take lines first: they matter more than drawings.
    for (const l of P.lines) {
      if (!l.dragId) continue;
      const ly = priceToY(l.price);
      if (ly !== null && Math.abs(y - ly) < 6) return { kind: "line", id: l.dragId, price: l.price };
    }
    if (!P.hidden && !P.locked) {
      for (const d of [...P.drawings].reverse()) {
        const ax = timeToX(d.a.time), ay = priceToY(d.a.price);
        if (ay === null) continue;
        if ("b" in d) {
          const bx = timeToX(d.b.time), by = priceToY(d.b.price);
          if (ax !== null && Math.hypot(x - ax, y - ay) < 7) return { kind: "pt", id: d.id, which: "a" };
          if (bx !== null && by !== null && Math.hypot(x - bx, y - by) < 7) return { kind: "pt", id: d.id, which: "b" };
          if (ax !== null && bx !== null && by !== null) {
            const inBox = x >= Math.min(ax, bx) && x <= Math.max(ax, bx) && y >= Math.min(ay, by) && y <= Math.max(ay, by);
            if ((d.type === "rect" || d.type === "fib" || d.type === "measure") ? inBox : distSeg(x, y, ax, ay, bx, by) < 6) return { kind: "body", id: d.id };
          }
        } else if (d.type === "hline" && Math.abs(y - ay) < 6) return { kind: "body", id: d.id };
        else if (d.type === "vline" && ax !== null && Math.abs(x - ax) < 6) return { kind: "body", id: d.id };
        else if (d.type === "text" && ax !== null && x >= ax - 4 && x <= ax + 120 && y >= ay - 14 && y <= ay + 4) return { kind: "body", id: d.id };
      }
    }
    return null;
  };

  const local = (e: React.PointerEvent) => {
    const r = box.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onDown = (e: React.PointerEvent) => {
    const P = st.current.p, S = st.current;
    const { x, y } = local(e);
    if (P.tool !== "cursor") {
      const pt = snap(x, y);
      if (!pt) return;
      e.stopPropagation(); e.preventDefault();
      if (P.tool === "hline" || P.tool === "vline") { P.onDrawings([...P.drawings, { id: uid(), type: P.tool, a: pt }]); P.onToolDone(); return; }
      if (P.tool === "text") { const text = P.askText(); if (text) P.onDrawings([...P.drawings, { id: uid(), type: "text", a: pt, text }]); P.onToolDone(); return; }
      S.draft = { id: uid(), type: P.tool, a: pt, b: pt } as Drawing;
      (e.target as Element).setPointerCapture?.(e.pointerId);
      return;
    }
    const h = hit(x, y);
    if (!h) { S.selected = null; return; }
    e.stopPropagation(); e.preventDefault();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    if (h.kind === "line") { S.drag = { kind: "line", id: h.id, price: h.price }; return; }
    S.selected = h.id;
    if (h.kind === "pt") S.drag = { kind: "pt", id: h.id, which: h.which };
    else { const pt = snap(x, y); if (pt) S.drag = { kind: "move", id: h.id, from: pt }; }
  };

  const onMove = (e: React.PointerEvent) => {
    const P = st.current.p, S = st.current;
    const { x, y } = local(e);
    if (S.draft && "b" in S.draft) { const pt = snap(x, y); if (pt) S.draft = { ...S.draft, b: pt }; e.stopPropagation(); return; }
    if (S.drag) {
      e.stopPropagation();
      if (S.drag.kind === "line") { const pr = yToPrice(y); if (pr !== null) S.drag.price = pr; return; }
      const pt = snap(x, y); if (!pt) return;
      const id = S.drag.id;
      if (S.drag.kind === "pt") { const which = S.drag.which; P.onDrawings(P.drawings.map((d) => (d.id === id ? { ...d, [which]: pt } as Drawing : d))); }
      else {
        const dt = pt.time - S.drag.from.time, dp = pt.price - S.drag.from.price;
        S.drag.from = pt;
        P.onDrawings(P.drawings.map((d) => (d.id !== id ? d : ({ ...d, a: { time: d.a.time + dt, price: d.a.price + dp }, ...("b" in d ? { b: { time: d.b.time + dt, price: d.b.price + dp } } : {}) } as Drawing))));
      }
      return;
    }
    // Cursor hint: what is under the pointer.
    const h = P.tool === "cursor" ? hit(x, y) : null;
    box.current!.style.cursor = P.tool !== "cursor" ? "crosshair" : h?.kind === "line" ? "ns-resize" : h ? "move" : "";
  };

  const onUp = () => {
    const P = st.current.p, S = st.current;
    if (S.draft) {
      const d = S.draft; S.draft = null;
      if ("b" in d && (d.a.time !== d.b.time || d.a.price !== d.b.price)) P.onDrawings([...P.drawings, d]);
      P.onToolDone();
    }
    if (S.drag?.kind === "line") P.onLineDrag(S.drag.id, S.drag.price);
    S.drag = null;
  };

  // Delete the selected drawing with Delete/Backspace.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const S = st.current;
      if ((e.key === "Delete" || e.key === "Backspace") && S.selected && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
        S.p.onDrawings(S.p.drawings.filter((d) => d.id !== S.selected)); S.selected = null;
      }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);

  return (
    <div ref={box} className="relative h-full w-full select-none" onPointerDownCapture={onDown} onPointerMoveCapture={onMove} onPointerUpCapture={onUp}>
      <canvas ref={canvas} className="pointer-events-none absolute inset-0 z-10" />
    </div>
  );
}
