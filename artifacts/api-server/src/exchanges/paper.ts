/**
 * Paper exchange: a simulated account on REAL prices of a real exchange. It speaks the same subset
 * of the CCXT API the rest of Vektor uses, so the terminal, the position manager and bots work on it
 * unchanged. Always hedge mode (long and short of one coin are separate positions).
 *
 * Fills: market at the current bid/ask; limit when the last price touches it (maker fee);
 * stop (stopLossPrice / triggerPrice) when the last price crosses it, filled at market (taker fee).
 * Isolated liquidation when the mark price crosses the liquidation price. Not simulated: order book
 * depth (no slippage beyond the spread), funding payments.
 */
import { one, q } from "../db";
import type { AccountRow } from "./client";
import { publicClient } from "./market";

type Side = "long" | "short";
type Pos = { symbol: string; side: Side; contracts: number; entryPrice: number; leverage: number; margin: number; marginMode: "isolated" | "cross" };
type Order = {
  id: string; symbol: string; type: "market" | "limit"; side: "buy" | "sell"; amount: number; price: number | null;
  trigger: number | null; reduce: boolean; posSide: Side; status: "open" | "closed" | "canceled"; filled: number; average: number | null; timestamp: number;
};
type Trade = { id: string; order: string; symbol: string; side: "buy" | "sell"; amount: number; price: number; timestamp: number; fee: { cost: number; currency: string }; takerOrMaker: "taker" | "maker"; info: Record<string, unknown> };
type State = { balance: Record<string, number>; positions: Pos[]; orders: Order[]; trades: Trade[]; seq: number; leverage: Record<string, number>; marginMode: Record<string, "isolated" | "cross"> };

export const PAPER_START_USDT = 10_000;
const MMR = 0.005;

const states = new Map<number, State>();
/** One lock per paper account, shared by every PaperExchange instance of that account. */
const locks = new Map<number, Promise<unknown>>();

async function loadState(accountId: number): Promise<State> {
  const cached = states.get(accountId);
  if (cached) return cached;
  const r = await one<{ state: State }>("SELECT state FROM vk_paper WHERE account_id = $1", [accountId]);
  const s: State = r?.state ?? { balance: { USDT: PAPER_START_USDT }, positions: [], orders: [], trades: [], seq: 1, leverage: {}, marginMode: {} };
  states.set(accountId, s);
  return s;
}
async function save(accountId: number, s: State) {
  // Keep the last 2000 trades and 500 finished orders.
  s.trades = s.trades.slice(-2000);
  const open = s.orders.filter((o) => o.status === "open");
  s.orders = [...s.orders.filter((o) => o.status !== "open").slice(-500), ...open];
  await q(`INSERT INTO vk_paper (account_id, state) VALUES ($1, $2) ON CONFLICT (account_id) DO UPDATE SET state = EXCLUDED.state, updated_at = now()`, [accountId, JSON.stringify(s)]);
}
export async function resetPaper(accountId: number, startUsdt: number) {
  const s: State = { balance: { USDT: startUsdt }, positions: [], orders: [], trades: [], seq: 1, leverage: {}, marginMode: {} };
  states.set(accountId, s);
  await save(accountId, s);
}

const dir = (s: Side) => (s === "long" ? 1 : -1);

export class PaperExchange {
  readonly id: string;
  readonly has: Record<string, boolean>;
  readonly precisionMode: number;
  private pub: any;

  constructor(private a: Pick<AccountRow, "id" | "exchange" | "market">, pub?: any) {
    this.id = `paper-${a.exchange}`;
    this.pub = pub ?? publicClient(a.exchange, a.market, "live");
    this.precisionMode = this.pub.precisionMode;
    this.has = {
      fetchPositions: a.market === "swap", fetchTickers: true, createOrder: true, setLeverage: true, setMarginMode: true,
      fetchPositionMode: true, createStopLossOrder: true, addMargin: true, fetchMyTrades: true, swap: a.market === "swap", spot: a.market === "spot",
    };
  }

  get markets() { return this.pub.markets; }
  get options() { return {}; }
  market(s: string) { return this.pub.market(s); }
  loadMarkets() { return this.pub.loadMarkets(); }
  amountToPrecision(s: string, v: number) { return this.pub.amountToPrecision(s, v); }
  priceToPrecision(s: string, v: number) { return this.pub.priceToPrecision(s, v); }
  fetchTicker(s: string) { return this.pub.fetchTicker(s); }
  fetchTickers(s?: string[]) { return this.pub.fetchTickers(s); }
  fetchOHLCV(...args: any[]) { return this.pub.fetchOHLCV(...args); }
  fetchOrderBook(...args: any[]) { return this.pub.fetchOrderBook(...args); }
  async fetchPositionMode() { return { hedged: true }; }

  /** Every call runs one at a time per account (state is in memory, saved after each change). */
  private run<T>(fn: (s: State) => Promise<T>): Promise<T> {
    const prev = locks.get(this.a.id) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(async () => {
      const s = await loadState(this.a.id);
      const out = await fn(s);
      await save(this.a.id, s);
      return out;
    });
    locks.set(this.a.id, next.catch(() => undefined));
    return next;
  }

  private fee(symbol: string, kind: "taker" | "maker") {
    const m = this.pub.markets?.[symbol];
    return Number(kind === "taker" ? m?.taker ?? 0.0005 : m?.maker ?? 0.0002);
  }
  private cs(symbol: string) { return Number(this.pub.markets?.[symbol]?.contractSize ?? 1); }

  /** Matches open orders and liquidations of the given symbols against current prices. */
  private async match(s: State, symbols: string[]) {
    for (const symbol of [...new Set(symbols)]) {
      const hasWork = s.orders.some((o) => o.status === "open" && o.symbol === symbol) || s.positions.some((p) => p.symbol === symbol);
      if (!hasWork) continue;
      const t = await this.pub.fetchTicker(symbol);
      const last = Number(t.last ?? t.close);
      if (!last) continue;
      // Liquidations first.
      for (const p of [...s.positions.filter((x) => x.symbol === symbol)]) {
        const liq = this.liqPrice(p);
        if (liq !== null && (p.side === "long" ? last <= liq : last >= liq)) {
          this.close(s, p, p.contracts, liq, "taker", `liq-${s.seq++}`, { liquidation: true });
        }
      }
      for (const o of s.orders.filter((x) => x.status === "open" && x.symbol === symbol)) {
        if (o.trigger !== null) {
          const up = o.side === "buy"; // a buy stop fires on rise, a sell stop on fall
          if (up ? last >= o.trigger : last <= o.trigger) this.fill(s, o, last, "taker");
        } else if (o.type === "limit" && o.price !== null) {
          if (o.side === "buy" ? last <= o.price : last >= o.price) this.fill(s, o, o.price, "maker");
        }
      }
    }
  }

  private liqPrice(p: Pos): number | null {
    if (this.a.market !== "swap" || p.marginMode === "cross") return null;
    const notional = p.contracts * this.cs(p.symbol) * p.entryPrice;
    return p.entryPrice * (1 - dir(p.side) * (p.margin / notional - MMR));
  }

  private trade(s: State, o: { id: string; symbol: string; side: "buy" | "sell" }, amount: number, price: number, kind: "taker" | "maker", info: Record<string, unknown> = {}) {
    const fee = amount * this.cs(o.symbol) * price * this.fee(o.symbol, kind);
    s.balance.USDT = (s.balance.USDT ?? 0) - fee;
    s.trades.push({ id: String(s.seq++), order: o.id, symbol: o.symbol, side: o.side, amount, price, timestamp: Date.now(), fee: { cost: fee, currency: "USDT" }, takerOrMaker: kind, info });
  }

  private close(s: State, p: Pos, amount: number, price: number, kind: "taker" | "maker", orderId: string, info: Record<string, unknown> = {}) {
    const qty = Math.min(amount, p.contracts);
    const pnl = (price - p.entryPrice) * qty * this.cs(p.symbol) * dir(p.side);
    const marginBack = p.margin * (qty / p.contracts);
    s.balance.USDT = (s.balance.USDT ?? 0) + marginBack + pnl;
    p.margin -= marginBack;
    p.contracts = Number((p.contracts - qty).toFixed(12));
    this.trade(s, { id: orderId, symbol: p.symbol, side: p.side === "long" ? "sell" : "buy" }, qty, price, kind, info);
    if (p.contracts <= 1e-12) s.positions = s.positions.filter((x) => x !== p);
    // Reduce-only orders larger than what is left are trimmed / cancelled.
    for (const o of s.orders.filter((x) => x.status === "open" && x.reduce && x.symbol === p.symbol && x.posSide === p.side)) {
      const left = s.positions.find((x) => x.symbol === p.symbol && x.side === p.side)?.contracts ?? 0;
      if (left <= 1e-12) o.status = "canceled";
      else if (o.amount - o.filled > left) o.amount = o.filled + left;
    }
  }

  private fill(s: State, o: Order, price: number, kind: "taker" | "maker") {
    const amount = o.amount - o.filled;
    if (this.a.market === "spot") {
      const [base] = o.symbol.split("/");
      const cost = amount * price;
      if (o.side === "buy") {
        if ((s.balance.USDT ?? 0) < cost) { o.status = "canceled"; return; }
        s.balance.USDT -= cost; s.balance[base] = (s.balance[base] ?? 0) + amount;
      } else {
        if ((s.balance[base] ?? 0) < amount - 1e-12) { o.status = "canceled"; return; }
        s.balance[base] -= amount; s.balance.USDT = (s.balance.USDT ?? 0) + cost;
      }
      this.trade(s, o, amount, price, kind);
    } else if (o.reduce) {
      const p = s.positions.find((x) => x.symbol === o.symbol && x.side === o.posSide);
      if (!p) { o.status = "canceled"; return; }
      this.close(s, p, amount, price, kind, o.id);
    } else {
      const lev = s.leverage[o.symbol] ?? 10;
      const mode = s.marginMode[o.symbol] ?? "isolated";
      const margin = (amount * this.cs(o.symbol) * price) / lev;
      if ((s.balance.USDT ?? 0) < margin) { o.status = "canceled"; return; }
      s.balance.USDT -= margin;
      const p = s.positions.find((x) => x.symbol === o.symbol && x.side === o.posSide);
      if (p) {
        p.entryPrice = (p.entryPrice * p.contracts + price * amount) / (p.contracts + amount);
        p.contracts += amount; p.margin += margin;
      } else s.positions.push({ symbol: o.symbol, side: o.posSide, contracts: amount, entryPrice: price, leverage: lev, margin, marginMode: mode });
      this.trade(s, o, amount, price, kind);
    }
    o.filled = o.amount; o.status = "closed"; o.average = price;
  }

  /** Which position an order belongs to, from any exchange's hedge-mode params. */
  private resolve(side: "buy" | "sell", params: any): { posSide: Side; reduce: boolean } {
    const ps = String(params.positionSide ?? params.posSide ?? "").toLowerCase();
    let posSide: Side | null = ps === "long" || ps === "short" ? (ps as Side) : null;
    if (!posSide && params.positionIdx) posSide = Number(params.positionIdx) === 1 ? "long" : "short";
    const reduce = Boolean(params.reduceOnly) || Boolean(params.stopLossPrice) || (posSide !== null && ((posSide === "long") !== (side === "buy")));
    if (!posSide) posSide = reduce ? (side === "buy" ? "short" : "long") : side === "buy" ? "long" : "short";
    return { posSide, reduce };
  }

  createOrder(symbol: string, type: "market" | "limit", side: "buy" | "sell", amount: number, price?: number, params: any = {}) {
    return this.run(async (s) => {
      await this.pub.loadMarkets();
      const { posSide, reduce } = this.resolve(side, params);
      const trigger = params.stopLossPrice ?? params.triggerPrice ?? params.stopPrice ?? null;
      const o: Order = { id: String(s.seq++), symbol, type, side, amount: Number(amount), price: price ?? null, trigger: trigger !== null ? Number(trigger) : null, reduce: this.a.market === "swap" && reduce, posSide, status: "open", filled: 0, average: null, timestamp: Date.now() };
      if (o.reduce && !s.positions.some((p) => p.symbol === symbol && p.side === posSide)) {
        throw Object.assign(new Error("paper: no position to reduce"), { name: "InvalidOrder" });
      }
      s.orders.push(o);
      if (type === "market" && trigger === null) {
        const t = await this.pub.fetchTicker(symbol);
        const px = Number(side === "buy" ? t.ask ?? t.last : t.bid ?? t.last);
        this.fill(s, o, px, "taker");
        if (o.status === "canceled") throw Object.assign(new Error("paper: insufficient balance"), { name: "InsufficientFunds" });
      } else await this.match(s, [symbol]);
      return this.view(o);
    });
  }

  private view(o: Order) {
    return { id: o.id, symbol: o.symbol, type: o.type, side: o.side, amount: o.amount, price: o.price, triggerPrice: o.trigger, stopPrice: o.trigger, reduceOnly: o.reduce, status: o.status, filled: o.filled, average: o.average, timestamp: o.timestamp };
  }

  cancelOrder(id: string) {
    return this.run(async (s) => {
      const o = s.orders.find((x) => x.id === id);
      if (!o || o.status !== "open") throw Object.assign(new Error("paper: order not open"), { name: "OrderNotFound" });
      o.status = "canceled";
      return this.view(o);
    });
  }
  fetchOrder(id: string) { return this.run(async (s) => { const o = s.orders.find((x) => x.id === id); return o ? this.view(o) : null; }); }
  fetchOpenOrders(symbol?: string) {
    return this.run(async (s) => {
      await this.match(s, symbol ? [symbol] : s.orders.filter((o) => o.status === "open").map((o) => o.symbol));
      return s.orders.filter((o) => o.status === "open" && (!symbol || o.symbol === symbol)).map((o) => this.view(o));
    });
  }
  fetchMyTrades(symbol?: string, since?: number) {
    return this.run(async (s) => s.trades.filter((t) => (!symbol || t.symbol === symbol) && (!since || t.timestamp >= since)));
  }
  setLeverage(lev: number, symbol: string) { return this.run(async (s) => { s.leverage[symbol] = lev; return {}; }); }
  setMarginMode(mode: "isolated" | "cross", symbol: string) { return this.run(async (s) => { s.marginMode[symbol] = mode; return {}; }); }
  addMargin(symbol: string, amount: number, params: any = {}) {
    return this.run(async (s) => {
      const side = String(params.positionSide ?? "long").toLowerCase() as Side;
      const p = s.positions.find((x) => x.symbol === symbol && x.side === side);
      if (!p || (s.balance.USDT ?? 0) < amount) throw Object.assign(new Error("paper: cannot add margin"), { name: "InsufficientFunds" });
      s.balance.USDT -= amount; p.margin += amount;
      return {};
    });
  }

  fetchPositions(symbols?: string[]) {
    return this.run(async (s) => {
      await this.match(s, symbols ?? s.positions.map((p) => p.symbol));
      const out = [];
      for (const p of s.positions.filter((x) => !symbols || symbols.includes(x.symbol))) {
        const t = await this.pub.fetchTicker(p.symbol);
        const mark = Number(t.last ?? t.close);
        const cs = this.cs(p.symbol);
        out.push({
          symbol: p.symbol, side: p.side, contracts: p.contracts, contractSize: cs, entryPrice: p.entryPrice, markPrice: mark,
          notional: p.contracts * cs * mark, unrealizedPnl: (mark - p.entryPrice) * p.contracts * cs * dir(p.side),
          leverage: p.leverage, marginMode: p.marginMode, liquidationPrice: this.liqPrice(p), initialMargin: p.margin, collateral: p.margin,
        });
      }
      return out;
    });
  }

  fetchBalance() {
    return this.run(async (s) => {
      const used: Record<string, number> = { USDT: s.positions.reduce((a, p) => a + p.margin, 0) };
      const total: Record<string, number> = {};
      const free: Record<string, number> = {};
      for (const [k, v] of Object.entries(s.balance)) { free[k] = v; total[k] = v + (used[k] ?? 0); }
      if (!total.USDT) { total.USDT = used.USDT; free.USDT = 0; }
      return { total, free, used };
    });
  }
}

/** Matches orders of every paper account that has open orders or positions (stops fire without anyone looking). */
export async function paperTick(load: (id: number) => Promise<AccountRow | null>) {
  const rows = await q<{ account_id: number }>(`SELECT account_id FROM vk_paper WHERE jsonb_array_length(state->'positions') > 0
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(state->'orders') o WHERE o->>'status' = 'open')`);
  for (const r of rows) {
    const a = await load(r.account_id);
    if (a) await new PaperExchange(a).fetchOpenOrders().catch(() => undefined);
  }
}
