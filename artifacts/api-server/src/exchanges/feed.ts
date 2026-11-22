import type { Env, Market } from "./client";
import { candles, orderBook, proClient, publicClient, ticker, type Candle, type Timeframe } from "./market";

/**
 * One live feed per (exchange, market, env, symbol, timeframe), shared by every viewer.
 * Emits: candle (the forming candle), ticker, book. Stops when the last viewer leaves.
 * WebSocket (CCXT Pro) when the exchange supports it, else REST polling every POLL_MS.
 */
export type FeedEvent =
  | { type: "candle"; candle: Candle }
  | { type: "ticker"; last: number | null; bid: number | null; ask: number | null; at: number }
  | { type: "book"; bids: number[][]; asks: number[][]; at: number }
  | { type: "source"; mode: "ws" | "poll" }
  | { type: "error"; message: string };

type Listener = (e: FeedEvent) => void;
const POLL_MS = 2_000;

class Feed {
  listeners = new Set<Listener>();
  stopped = false;
  mode: "ws" | "poll" = "poll";
  constructor(readonly ex: string, readonly m: Market, readonly env: Env, readonly symbol: string, readonly tf: Timeframe) {}

  emit(e: FeedEvent) { for (const l of this.listeners) l(e); }

  start() {
    const pro = proClient(this.ex, this.m, this.env);
    const ws = pro && pro.has?.watchTicker && pro.has?.watchOHLCV;
    this.mode = ws ? "ws" : "poll";
    if (ws) {
      void this.loop(async () => {
        const rows = await pro.watchOHLCV(this.symbol, this.tf);
        const last = rows[rows.length - 1];
        if (last) this.emit({ type: "candle", candle: last });
      });
      void this.loop(async () => {
        const t = await pro.watchTicker(this.symbol);
        this.emit({ type: "ticker", last: t.last ?? null, bid: t.bid ?? null, ask: t.ask ?? null, at: t.timestamp ?? Date.now() });
      });
      if (pro.has?.watchOrderBook) {
        let lastBook = 0;
        void this.loop(async () => {
          const ob = await pro.watchOrderBook(this.symbol);
          // Throttle the book to 4 updates a second.
          if (Date.now() - lastBook < 250) return;
          lastBook = Date.now();
          this.emit({ type: "book", bids: ob.bids.slice(0, 15), asks: ob.asks.slice(0, 15), at: ob.timestamp ?? Date.now() });
        });
      } else this.pollBook();
    } else {
      void this.loop(async () => {
        const [rows, t] = await Promise.all([candles(this.ex, this.m, this.env, this.symbol, this.tf, 2), ticker(this.ex, this.m, this.env, this.symbol)]);
        const last = rows[rows.length - 1];
        if (last) this.emit({ type: "candle", candle: last });
        this.emit({ type: "ticker", last: t.last, bid: t.bid, ask: t.ask, at: t.at });
        await sleep(POLL_MS);
      });
      this.pollBook();
    }
  }

  pollBook() {
    void this.loop(async () => {
      const ob = await orderBook(this.ex, this.m, this.env, this.symbol);
      this.emit({ type: "book", ...ob });
      await sleep(POLL_MS);
    });
  }

  async loop(step: () => Promise<void>) {
    let errors = 0;
    while (!this.stopped) {
      try { await step(); errors = 0; } catch (e) {
        errors++;
        this.emit({ type: "error", message: String((e as any)?.message ?? e).slice(0, 200) });
        await sleep(Math.min(30_000, 1_000 * 2 ** Math.min(errors, 5)));
      }
    }
  }

  stop() { this.stopped = true; }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const feeds = new Map<string, Feed>();

export function subscribe(ex: string, m: Market, env: Env, symbol: string, tf: Timeframe, l: Listener): () => void {
  publicClient(ex, m, env); // throws for an unknown exchange before anything starts
  const k = `${ex}:${m}:${env}:${symbol}:${tf}`;
  let f = feeds.get(k);
  if (!f) { f = new Feed(ex, m, env, symbol, tf); feeds.set(k, f); f.start(); }
  f.listeners.add(l);
  l({ type: "source", mode: f.mode });
  return () => {
    f!.listeners.delete(l);
    if (!f!.listeners.size) { f!.stop(); feeds.delete(k); }
  };
}
