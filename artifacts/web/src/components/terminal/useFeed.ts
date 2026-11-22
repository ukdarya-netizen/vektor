import { useEffect, useState } from "react";
import type { Candle } from "./Chart";

export type Book = { bids: number[][]; asks: number[][]; at: number };
export type Tick = { last: number | null; bid: number | null; ask: number | null; at: number; receivedAt: number };

/** Live candle, ticker and order book over server-sent events. */
export function useFeed(accountId: number | null, symbol: string | null, tf: string) {
  const [live, setLive] = useState<Candle | null>(null);
  const [tick, setTick] = useState<Tick | null>(null);
  const [book, setBook] = useState<Book | null>(null);
  const [mode, setMode] = useState<"ws" | "poll" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    setLive(null); setTick(null); setBook(null); setError(null);
    if (!accountId || !symbol) return;
    const base = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/api`;
    const es = new EventSource(`${base}/stream?accountId=${accountId}&symbol=${encodeURIComponent(symbol)}&tf=${tf}`, { withCredentials: true });
    es.onmessage = (m) => {
      const e = JSON.parse(m.data);
      if (e.type === "candle") setLive(e.candle);
      else if (e.type === "ticker") { setTick({ ...e, receivedAt: Date.now() }); setError(null); }
      else if (e.type === "book") setBook(e);
      else if (e.type === "source") setMode(e.mode);
      else if (e.type === "error") setError(e.message);
    };
    return () => es.close();
  }, [accountId, symbol, tf]);

  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1_000); return () => clearInterval(id); }, []);

  /** No price update for 15 s = the price on screen may be wrong. */
  const stale = tick ? now - tick.receivedAt > 15_000 : false;
  return { live, tick, book, mode, error, stale };
}
