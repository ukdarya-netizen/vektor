import ccxt from "ccxt";
import type { Env, Market } from "./client";

/**
 * Public market data (no keys): one client per exchange+market+env, shared by all users.
 * Live updates use CCXT Pro WebSockets where the exchange has them, otherwise REST polling.
 */
const publicClients = new Map<string, any>();
const proClients = new Map<string, any>();

const key = (ex: string, m: Market, env: Env) => `${ex}:${m}:${env}`;

function build(lib: any, ex: string, m: Market, env: Env): any {
  const Ex = lib[ex];
  if (!Ex) return null;
  const c = new Ex({ enableRateLimit: true, timeout: 15_000, options: { defaultType: m } });
  if (env === "testnet") {
    if (!c.urls?.test) return null;
    c.setSandboxMode(true);
  }
  return c;
}

export function publicClient(ex: string, m: Market, env: Env): any {
  const k = key(ex, m, env);
  if (!publicClients.has(k)) {
    const c = build(ccxt, ex, m, env);
    if (!c) throw new Error(`unknown exchange ${ex}`);
    publicClients.set(k, c);
  }
  return publicClients.get(k);
}

export function proClient(ex: string, m: Market, env: Env): any | null {
  const k = key(ex, m, env);
  if (!proClients.has(k)) proClients.set(k, (ccxt as any).pro?.[ex] ? build((ccxt as any).pro, ex, m, env) : null);
  return proClients.get(k);
}

export type MarketInfo = {
  symbol: string; base: string; quote: string;
  tick: number | null; step: number | null; minAmount: number | null; minCost: number | null;
  contractSize: number; maxLeverage: number | null; taker: number | null; maker: number | null;
};

/** Precision in CCXT is either decimal places or tick size depending on the exchange (precisionMode). */
function toStep(c: any, p: number | undefined): number | null {
  if (p === undefined || p === null) return null;
  return c.precisionMode === ccxt.TICK_SIZE ? p : Math.pow(10, -p);
}

export async function markets(ex: string, m: Market, env: Env): Promise<MarketInfo[]> {
  const c = publicClient(ex, m, env);
  await c.loadMarkets();
  const out: MarketInfo[] = [];
  for (const mk of Object.values<any>(c.markets)) {
    if (mk.active === false) continue;
    if (m === "swap" ? !(mk.swap && mk.linear && mk.settle === "USDT") : !(mk.spot && mk.quote === "USDT")) continue;
    out.push({
      symbol: mk.symbol, base: mk.base, quote: mk.quote,
      tick: toStep(c, mk.precision?.price), step: toStep(c, mk.precision?.amount),
      minAmount: mk.limits?.amount?.min ?? null, minCost: mk.limits?.cost?.min ?? null,
      contractSize: mk.contractSize ?? 1, maxLeverage: mk.limits?.leverage?.max ?? null,
      taker: mk.taker ?? null, maker: mk.maker ?? null,
    });
  }
  return out.sort((a, b) => a.base.localeCompare(b.base));
}

export const TIMEFRAMES = ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "1d", "1w"] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

export type Candle = [number, number, number, number, number, number];

export async function candles(ex: string, m: Market, env: Env, symbol: string, tf: Timeframe, limit = 500): Promise<Candle[]> {
  const c = publicClient(ex, m, env);
  await c.loadMarkets();
  const rows: Candle[] = await c.fetchOHLCV(symbol, tf, undefined, Math.min(limit, 1000));
  // Dedupe and sort: some exchanges return overlapping pages or unsorted rows.
  const byTs = new Map<number, Candle>();
  for (const r of rows) byTs.set(r[0], r);
  return [...byTs.values()].sort((a, b) => a[0] - b[0]);
}

export async function orderBook(ex: string, m: Market, env: Env, symbol: string, depth = 15) {
  const c = publicClient(ex, m, env);
  const ob = await c.fetchOrderBook(symbol, depth > 20 ? 50 : 20);
  return { bids: ob.bids.slice(0, depth), asks: ob.asks.slice(0, depth), at: ob.timestamp ?? Date.now() };
}

export async function ticker(ex: string, m: Market, env: Env, symbol: string) {
  const t = await publicClient(ex, m, env).fetchTicker(symbol);
  return { last: t.last ?? t.close ?? null, bid: t.bid ?? null, ask: t.ask ?? null, change24h: t.percentage ?? null, at: t.timestamp ?? Date.now() };
}
