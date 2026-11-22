/**
 * Opening a position — one path for the terminal and for signal bots:
 * idempotency claim → risk limits → preflight → plan check → leverage/margin → order → managed record.
 */
import { one, q } from "../db";
import { clientFor, exchangeError, type AccountRow } from "./client";
import { markets, ticker, type MarketInfo } from "./market";
import { preflight, type OrderInput, type Preflight, type Side } from "./preflight";
import { isHedged, modeParams, orderSide } from "./positionMode";
import { snapshot } from "./snapshot";
import { planErrors, type Plan } from "../engine/plan";
import { checkRisk } from "../engine/risk";

const marketCache = new Map<string, { at: number; list: Promise<MarketInfo[]> }>();
export function marketsCached(a: Pick<AccountRow, "exchange" | "market" | "env">): Promise<MarketInfo[]> {
  const k = `${a.exchange}:${a.market}:${a.env}`;
  const c = marketCache.get(k);
  if (c && Date.now() - c.at < 30 * 60_000) return c.list;
  const list = markets(a.exchange, a.market, a.env);
  marketCache.set(k, { at: Date.now(), list });
  list.catch(() => marketCache.delete(k));
  return list;
}
export async function marketOf(a: AccountRow, symbol: string): Promise<MarketInfo | null> {
  return (await marketsCached(a)).find((m) => m.symbol === symbol) ?? null;
}

export type EntryInput = {
  symbol: string; side: Side; type: "market" | "limit" | "stop_market" | "stop_limit"; price?: number | null;
  /** Stop entries: the order wakes up when the price crosses this. */
  triggerPrice?: number | null; postOnly?: boolean;
  amountMode: "usdt" | "percent" | "qty"; amount: number; leverage?: number | null; marginMode?: "isolated" | "cross";
  plan?: Plan | null; clientRequestId: string;
};

export async function evaluate(a: AccountRow, b: Omit<EntryInput, "clientRequestId" | "plan">): Promise<{ mk: MarketInfo | null; pf: Preflight | null }> {
  const mk = await marketOf(a, b.symbol);
  if (!mk) return { mk: null, pf: null };
  const [t, snap] = await Promise.all([ticker(a.exchange, a.market, a.env, b.symbol), snapshot(a, true)]);
  if (snap.error) throw Object.assign(new Error(snap.error.message), { exchangeCode: snap.error.code });
  const quote = snap.balances.find((x) => x.asset === mk.quote);
  const base = snap.balances.find((x) => x.asset === mk.base);
  // Stop entries are sized at the price they will fill at: the limit price, or the trigger for stop-market.
  const isStop = b.type === "stop_market" || b.type === "stop_limit";
  const sizePrice = b.type === "stop_market" ? b.triggerPrice : b.price;
  const input: OrderInput = { market: a.market, side: b.side, type: b.type === "market" ? "market" : "limit", price: sizePrice ?? null, amountMode: b.amountMode, amount: b.amount, leverage: b.leverage ?? 1, noSideWarnings: isStop };
  if (isStop && !(Number(b.triggerPrice) > 0)) return { mk, pf: { ...preflight(input, mk, { last: null, bid: null, ask: null, freeQuote: 0 }), ok: false, errors: [{ code: "bad_trigger" }] } };
  return { mk, pf: preflight(input, mk, { last: t.last, bid: t.bid, ask: t.ask, freeQuote: quote?.free ?? 0, baseFree: base?.free ?? 0 }) };
}

export type EntryResult = { http: number; body: Record<string, any> };

export async function openEntry(a: AccountRow & { status: string }, user: { id: number; lang: string }, b: EntryInput, source: { kind: "terminal" | "signal"; label: string; signalId?: number }): Promise<EntryResult> {
  if (a.status === "paused") return { http: 409, body: { error: "account_paused" } };
  const claimed = await one<{ id: number }>(
    `INSERT INTO vk_orders (user_id, account_id, client_request_id, source, symbol, side, intent, type, qty, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'open', $7, 0, 'checking') ON CONFLICT (account_id, client_request_id) DO NOTHING RETURNING id`,
    [user.id, a.id, b.clientRequestId, source.kind, b.symbol, b.side, b.type]);  // type: market/limit/stop_market/stop_limit
  if (!claimed) {
    const prev = await one("SELECT * FROM vk_orders WHERE account_id = $1 AND client_request_id = $2", [a.id, b.clientRequestId]);
    return { http: 200, body: { order: prev, repeated: true } };
  }
  const finish = (status: string, extra: Record<string, unknown>) =>
    one(`UPDATE vk_orders SET status = $2, qty = COALESCE($3, qty), price = COALESCE($4, price), leverage = COALESCE($5, leverage),
           exchange_order_id = $6, error_code = $7, error_message = $8, preflight = COALESCE($9::jsonb, preflight), updated_at = now()
         WHERE id = $1 RETURNING *`,
      [claimed.id, status, extra.qty ?? null, extra.price ?? null, extra.leverage ?? null, extra.exchangeOrderId ?? null,
        extra.errorCode ?? null, extra.errorMessage ?? null, extra.preflight ? JSON.stringify(extra.preflight) : null]);

  try {
    const { mk, pf } = await evaluate(a, b);
    if (!mk || !pf) return { http: 400, body: { error: "no_symbol", order: await finish("rejected", { errorCode: "no_symbol" }) } };
    if (!pf.ok) return { http: 400, body: { error: "preflight_failed", preflight: pf, order: await finish("rejected", { errorCode: pf.errors[0].code, preflight: pf }) } };
    if (b.plan && a.market === "swap") {
      const errs = planErrors(b.plan, b.side, pf.price);
      if (errs.length) return { http: 400, body: { error: "plan_invalid", reason: errs[0], order: await finish("rejected", { errorCode: errs[0], preflight: pf }) } };
    }
    const risk = await checkRisk(user.id, { margin: pf.margin, leverage: pf.leverage, opening: true });
    if (risk) return { http: 400, body: { error: "risk_limit", risk, order: await finish("rejected", { errorCode: `risk:${risk.code}`, preflight: pf }) } };

    const ex = clientFor(a);
    let params: Record<string, unknown> = {};
    if (a.market === "swap") {
      if (b.marginMode && ex.has?.setMarginMode) await ex.setMarginMode(b.marginMode, b.symbol).catch(() => undefined); // "already set" is fine
      if (ex.has?.setLeverage) {
        try { await ex.setLeverage(pf.leverage, b.symbol, b.marginMode ? { marginMode: b.marginMode } : {}); }
        catch (e) { return { http: 400, body: { error: "leverage_failed", exchangeError: exchangeError(e), order: await finish("rejected", { errorCode: "leverage_failed", errorMessage: exchangeError(e).message, preflight: pf }) } }; }
      }
      params = modeParams(a.exchange, await isHedged(a.id, ex), b.side, false);
    }
    if (b.type === "stop_market" || b.type === "stop_limit") params = { ...params, triggerPrice: Number(ex.priceToPrecision(b.symbol, b.triggerPrice!)) };
    if (b.postOnly && b.type === "limit") params = { ...params, postOnly: true };
    const ccxtType = b.type === "market" || b.type === "stop_market" ? "market" : "limit";
    const sent = await ex.createOrder(b.symbol, ccxtType, orderSide(b.side, false), pf.qty, ccxtType === "limit" ? pf.price : undefined, params);
    let positionId: number | null = null;
    if (a.market === "swap" && b.plan) {
      // The engine waits for the fill, then places stop/takes/DCA from the REAL entry price.
      // Same symbol+side already managed → picked up there as a size increase.
      const row = await one<{ id: number }>(`INSERT INTO vk_positions (user_id, account_id, symbol, side, source, source_label, status, plan, entry_order_id, leverage)
               VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8, $9) ON CONFLICT DO NOTHING RETURNING id`,
        [user.id, a.id, b.symbol, b.side, source.kind, source.label, JSON.stringify(b.plan), String(sent.id), pf.leverage]);
      positionId = row?.id ?? null;
    }
    const order = await finish(sent.status === "closed" ? "filled" : "open", { qty: pf.qty, price: sent.average ?? sent.price ?? pf.price, leverage: pf.leverage, exchangeOrderId: sent.id, preflight: pf });
    return { http: 200, body: { order, positionId, preflight: pf } };
  } catch (e) {
    const err = exchangeError(e);
    // Unknown outcome (timeout/network): the order may be on the exchange. Mark it, never resend.
    const status = err.code === "network" ? "unknown" : "rejected";
    return { http: 502, body: { error: "exchange_error", exchangeError: err, order: await finish(status, { errorCode: err.code, errorMessage: err.message }) } };
  }
}

/** Reduce-only market close of a share of a position; the engine books and names it. */
export async function closePosition(a: AccountRow, symbol: string, side: Side, percent: number, reason: string): Promise<{ qty: number; orderId: string } | null> {
  const ex = clientFor(a);
  const live = await ex.fetchPositions([symbol]);
  const pos = live.find((x: any) => x.symbol === symbol && x.side === side && Math.abs(Number(x.contracts ?? 0)) > 0);
  if (!pos) return null;
  const contracts = Math.abs(Number(pos.contracts));
  const qty = percent >= 100 ? contracts : Number(ex.amountToPrecision(symbol, (contracts * percent) / 100));
  await q(`UPDATE vk_positions SET pending_close_reason = $4 WHERE account_id = $1 AND symbol = $2 AND side = $3 AND status = 'open'`,
    [a.id, symbol, side, percent >= 100 ? reason : "terminal_partial"]);
  const sent = await ex.createOrder(symbol, "market", orderSide(side, true), qty, undefined, modeParams(a.exchange, await isHedged(a.id, ex), side, true));
  await q(`INSERT INTO vk_orders (user_id, account_id, client_request_id, source, symbol, side, intent, type, qty, status, exchange_order_id)
           VALUES ($1, $2, $3, $4, $5, $6, 'close', 'market', $7, 'sent', $8)`,
    [a.user_id, a.id, `close-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, reason === "signal_close" ? "signal" : "terminal", symbol, side, qty, sent.id]);
  return { qty, orderId: String(sent.id) };
}
