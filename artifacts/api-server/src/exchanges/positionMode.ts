/**
 * Hedge (separate long/short) vs one-way position mode, and the order params each exchange needs.
 * Exchanges name this differently; CCXT does not unify it for every one, so it is mapped here.
 * NOTE: verified against exchange docs, must still pass the testnet checklist per exchange.
 */
import type { Side } from "./preflight";

const modeCache = new Map<number, { at: number; hedged: boolean | null }>();

/** null = the exchange does not report it (then the order is sent without mode params). */
export async function isHedged(accountId: number, client: any): Promise<boolean | null> {
  const c = modeCache.get(accountId);
  if (c && Date.now() - c.at < 60_000) return c.hedged;
  let hedged: boolean | null = null;
  if (client.has?.fetchPositionMode) {
    try { hedged = Boolean((await client.fetchPositionMode())?.hedged); } catch { hedged = null; }
  }
  modeCache.set(accountId, { at: Date.now(), hedged });
  return hedged;
}

/**
 * Params for an order that opens (reduce=false) or closes (reduce=true) a `side` position.
 * order side: open long = buy, open short = sell, close long = sell, close short = buy.
 */
export function modeParams(exchange: string, hedged: boolean | null, side: Side, reduce: boolean): Record<string, unknown> {
  const LS = side === "long" ? "LONG" : "SHORT";
  if (!hedged) return reduce ? { reduceOnly: true } : {};
  switch (exchange) {
    // In hedge mode Binance and BingX identify the position by positionSide and reject reduceOnly.
    case "binance":
    case "binanceusdm":
    case "bingx":
      return { positionSide: LS };
    case "bybit":
      return { positionIdx: side === "long" ? 1 : 2, ...(reduce ? { reduceOnly: true } : {}) };
    case "okx":
      return { posSide: side, ...(reduce ? { reduceOnly: true } : {}) };
    case "bitget":
      return { hedged: true, ...(reduce ? { reduceOnly: true } : {}) };
    default:
      return { hedged: true, ...(reduce ? { reduceOnly: true } : {}) };
  }
}

export const orderSide = (side: Side, reduce: boolean): "buy" | "sell" => ((side === "long") !== reduce ? "buy" : "sell");
