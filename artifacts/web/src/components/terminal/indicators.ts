/**
 * Indicators computed in the browser from the same candles the chart shows.
 * Pure functions — values align 1:1 with candles (null until enough history).
 */
import type { Candle } from "./Chart";

export type IndicatorId = "ema" | "sma" | "vwap" | "bb" | "rsi" | "macd" | "stoch" | "atr";
export type IndicatorConf = { id: IndicatorId; key: string; params: number[]; color: string };

export const INDICATORS: Record<IndicatorId, { name: string; overlay: boolean; defaults: number[]; paramNames: string[] }> = {
  ema: { name: "EMA", overlay: true, defaults: [21], paramNames: ["period"] },
  sma: { name: "SMA", overlay: true, defaults: [50], paramNames: ["period"] },
  vwap: { name: "VWAP", overlay: true, defaults: [], paramNames: [] },
  bb: { name: "Bollinger Bands", overlay: true, defaults: [20, 2], paramNames: ["period", "σ"] },
  rsi: { name: "RSI", overlay: false, defaults: [14], paramNames: ["period"] },
  macd: { name: "MACD", overlay: false, defaults: [12, 26, 9], paramNames: ["fast", "slow", "signal"] },
  stoch: { name: "Stochastic", overlay: false, defaults: [14, 3, 3], paramNames: ["%K", "smooth", "%D"] },
  atr: { name: "ATR", overlay: false, defaults: [14], paramNames: ["period"] },
};

type S = Array<number | null>;

export function sma(v: number[], n: number): S {
  const out: S = [];
  let sum = 0;
  for (let i = 0; i < v.length; i++) {
    sum += v[i];
    if (i >= n) sum -= v[i - n];
    out.push(i >= n - 1 ? sum / n : null);
  }
  return out;
}

export function ema(v: Array<number | null>, n: number): S {
  const out: S = [];
  const k = 2 / (n + 1);
  let prev: number | null = null;
  let seed: number[] = [];
  for (const x of v) {
    if (x === null) { out.push(null); continue; }
    if (prev === null) {
      seed.push(x);
      if (seed.length === n) { prev = seed.reduce((a, b) => a + b, 0) / n; out.push(prev); seed = []; } else out.push(null);
    } else { prev = x * k + prev * (1 - k); out.push(prev); }
  }
  return out;
}

/** Wilder's smoothing (RSI, ATR). */
function rma(v: number[], n: number): S {
  const out: S = [];
  let prev: number | null = null;
  for (let i = 0; i < v.length; i++) {
    if (i < n - 1) { out.push(null); continue; }
    if (prev === null) { prev = v.slice(0, n).reduce((a, b) => a + b, 0) / n; out.push(prev); continue; }
    prev = (prev * (n - 1) + v[i]) / n;
    out.push(prev);
  }
  return out;
}

export function rsi(close: number[], n: number): S {
  const g: number[] = [0], l: number[] = [0];
  for (let i = 1; i < close.length; i++) { const d = close[i] - close[i - 1]; g.push(Math.max(d, 0)); l.push(Math.max(-d, 0)); }
  const ag = rma(g.slice(1), n), al = rma(l.slice(1), n);
  return [null, ...ag.map((a, i) => (a === null || al[i] === null ? null : al[i] === 0 ? 100 : 100 - 100 / (1 + a / (al[i] as number))))];
}

export function macd(close: number[], f: number, s: number, sig: number) {
  const ef = ema(close, f), es = ema(close, s);
  const line = close.map((_, i) => (ef[i] === null || es[i] === null ? null : (ef[i] as number) - (es[i] as number)));
  const signal = ema(line, sig);
  return { line, signal, hist: line.map((x, i) => (x === null || signal[i] === null ? null : x - (signal[i] as number))) };
}

export function bollinger(close: number[], n: number, k: number) {
  const mid = sma(close, n);
  const up: S = [], lo: S = [];
  for (let i = 0; i < close.length; i++) {
    if (mid[i] === null) { up.push(null); lo.push(null); continue; }
    const w = close.slice(i - n + 1, i + 1);
    const sd = Math.sqrt(w.reduce((a, x) => a + (x - (mid[i] as number)) ** 2, 0) / n);
    up.push((mid[i] as number) + k * sd); lo.push((mid[i] as number) - k * sd);
  }
  return { mid, up, lo };
}

export function atr(c: Candle[], n: number): S {
  const tr = c.map((x, i) => (i === 0 ? x[2] - x[3] : Math.max(x[2] - x[3], Math.abs(x[2] - c[i - 1][4]), Math.abs(x[3] - c[i - 1][4]))));
  return rma(tr, n);
}

export function stoch(c: Candle[], kn: number, smooth: number, dn: number) {
  const raw: S = c.map((_, i) => {
    if (i < kn - 1) return null;
    const w = c.slice(i - kn + 1, i + 1);
    const hi = Math.max(...w.map((x) => x[2])), lo = Math.min(...w.map((x) => x[3]));
    return hi === lo ? 50 : ((c[i][4] - lo) / (hi - lo)) * 100;
  });
  const smoothArr = (v: S, n: number): S => v.map((_, i) => {
    const w = v.slice(Math.max(0, i - n + 1), i + 1);
    return w.length < n || w.some((x) => x === null) ? null : (w as number[]).reduce((a, b) => a + b, 0) / n;
  });
  const k = smoothArr(raw, smooth);
  return { k, d: smoothArr(k, dn) };
}

/** VWAP that restarts every UTC day (session VWAP). */
export function vwap(c: Candle[]): S {
  let day = -1, pv = 0, vol = 0;
  return c.map((x) => {
    const d = Math.floor(x[0] / 86_400_000);
    if (d !== day) { day = d; pv = 0; vol = 0; }
    const tp = (x[2] + x[3] + x[4]) / 3;
    pv += tp * x[5]; vol += x[5];
    return vol > 0 ? pv / vol : null;
  });
}

/** Lines to draw for one indicator: name → values. */
export function compute(conf: IndicatorConf, c: Candle[]): Array<{ name: string; values: S; color: string; kind?: "line" | "hist"; levels?: number[] }> {
  const close = c.map((x) => x[4]);
  const p = conf.params;
  switch (conf.id) {
    case "ema": return [{ name: `EMA ${p[0]}`, values: ema(close, p[0]), color: conf.color }];
    case "sma": return [{ name: `SMA ${p[0]}`, values: sma(close, p[0]), color: conf.color }];
    case "vwap": return [{ name: "VWAP", values: vwap(c), color: conf.color }];
    case "bb": { const b = bollinger(close, p[0], p[1]); return [{ name: "BB up", values: b.up, color: conf.color }, { name: "BB mid", values: b.mid, color: conf.color }, { name: "BB low", values: b.lo, color: conf.color }]; }
    case "rsi": return [{ name: `RSI ${p[0]}`, values: rsi(close, p[0]), color: conf.color, levels: [70, 30] }];
    case "macd": { const m = macd(close, p[0], p[1], p[2]); return [{ name: "MACD hist", values: m.hist, color: "#6b7a99", kind: "hist" }, { name: "MACD", values: m.line, color: conf.color }, { name: "Signal", values: m.signal, color: "#f5b84a" }]; }
    case "stoch": { const s = stoch(c, p[0], p[1], p[2]); return [{ name: "%K", values: s.k, color: conf.color, levels: [80, 20] }, { name: "%D", values: s.d, color: "#f5b84a" }]; }
    case "atr": return [{ name: `ATR ${p[0]}`, values: atr(c, p[0]), color: conf.color }];
  }
}
