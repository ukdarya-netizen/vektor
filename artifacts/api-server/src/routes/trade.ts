import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { one, q } from "../db";
import { clientFor, exchangeError, type AccountRow } from "../exchanges/client";
import { candles, markets, orderBook, ticker, TIMEFRAMES, type MarketInfo } from "../exchanges/market";
import { subscribe } from "../exchanges/feed";
import { preflight, type OrderInput } from "../exchanges/preflight";
import { isHedged, modeParams, orderSide } from "../exchanges/positionMode";
import { snapshot, STABLES } from "../exchanges/snapshot";
import { requireUser, userOf } from "./auth";

export const tradeRouter = Router();
tradeRouter.use(requireUser);

async function account(req: Request<any>, res: Response, id: unknown): Promise<(AccountRow & { status: string }) | null> {
  const a = await one<AccountRow & { status: string }>("SELECT * FROM vk_exchange_accounts WHERE id = $1 AND user_id = $2", [Number(id), userOf(req).id]);
  if (!a) res.status(404).json({ error: "account_not_found" });
  return a;
}

const marketCache = new Map<string, { at: number; list: Promise<MarketInfo[]> }>();
function marketsCached(a: AccountRow): Promise<MarketInfo[]> {
  const k = `${a.exchange}:${a.market}:${a.env}`;
  const c = marketCache.get(k);
  if (c && Date.now() - c.at < 30 * 60_000) return c.list;
  const list = markets(a.exchange, a.market, a.env);
  marketCache.set(k, { at: Date.now(), list });
  list.catch(() => marketCache.delete(k));
  return list;
}
async function marketOf(a: AccountRow, symbol: string): Promise<MarketInfo | null> {
  return (await marketsCached(a)).find((m) => m.symbol === symbol) ?? null;
}

const fail = (res: Response, e: unknown) => res.status(502).json({ error: "exchange_error", exchangeError: exchangeError(e) });

tradeRouter.get("/markets", async (req, res) => {
  const a = await account(req, res, req.query.accountId);
  if (!a) return;
  try { res.json({ markets: await marketsCached(a) }); } catch (e) { fail(res, e); }
});

tradeRouter.get("/candles", async (req, res) => {
  const a = await account(req, res, req.query.accountId);
  if (!a) return;
  const tf = String(req.query.tf ?? "15m");
  if (!(TIMEFRAMES as readonly string[]).includes(tf)) { res.status(400).json({ error: "bad_timeframe" }); return; }
  try { res.json({ candles: await candles(a.exchange, a.market, a.env, String(req.query.symbol), tf as any, Number(req.query.limit ?? 500)) }); }
  catch (e) { fail(res, e); }
});

tradeRouter.get("/orderbook", async (req, res) => {
  const a = await account(req, res, req.query.accountId);
  if (!a) return;
  try { res.json(await orderBook(a.exchange, a.market, a.env, String(req.query.symbol))); } catch (e) { fail(res, e); }
});

/** Server-sent events: forming candle, ticker, order book. */
tradeRouter.get("/stream", async (req, res) => {
  const a = await account(req, res, req.query.accountId);
  if (!a) return;
  const tf = String(req.query.tf ?? "15m");
  if (!(TIMEFRAMES as readonly string[]).includes(tf)) { res.status(400).json({ error: "bad_timeframe" }); return; }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
  res.write(": open\n\n");
  let unsub: (() => void) | null = null;
  try {
    unsub = subscribe(a.exchange, a.market, a.env, String(req.query.symbol), tf as any, (e) => res.write(`data: ${JSON.stringify(e)}\n\n`));
  } catch (e) {
    res.write(`data: ${JSON.stringify({ type: "error", message: String((e as any)?.message ?? e) })}\n\n`);
  }
  const ping = setInterval(() => res.write(": ping\n\n"), 20_000);
  req.on("close", () => { clearInterval(ping); unsub?.(); });
});

const orderSchema = z.object({
  accountId: z.number().int(),
  symbol: z.string().min(1).max(64),
  side: z.enum(["long", "short"]),
  type: z.enum(["market", "limit"]),
  price: z.number().positive().nullable().optional(),
  amountMode: z.enum(["usdt", "percent", "qty"]),
  amount: z.number().positive(),
  leverage: z.number().int().min(1).max(250).nullable().optional(),
  marginMode: z.enum(["isolated", "cross"]).optional(),
  clientRequestId: z.string().min(8).max(64),
});

async function evaluate(a: AccountRow, b: z.infer<typeof orderSchema>) {
  const mk = await marketOf(a, b.symbol);
  if (!mk) return { mk: null, pf: null };
  const [t, snap] = await Promise.all([ticker(a.exchange, a.market, a.env, b.symbol), snapshot(a, true)]);
  if (snap.error) throw Object.assign(new Error(snap.error.message), { exchangeCode: snap.error.code });
  const quote = snap.balances.find((x) => x.asset === mk.quote);
  const base = snap.balances.find((x) => x.asset === mk.base);
  const input: OrderInput = { market: a.market, side: b.side, type: b.type, price: b.price ?? null, amountMode: b.amountMode, amount: b.amount, leverage: b.leverage ?? 1 };
  return { mk, pf: preflight(input, mk, { last: t.last, bid: t.bid, ask: t.ask, freeQuote: quote?.free ?? 0, baseFree: base?.free ?? 0 }) };
}

/** Preview: exactly what would be sent and why not, without sending anything. */
tradeRouter.post("/orders/preview", async (req, res) => {
  const b = orderSchema.partial({ clientRequestId: true }).safeParse(req.body);
  if (!b.success) { res.status(400).json({ error: "bad_request" }); return; }
  const a = await account(req, res, b.data.accountId);
  if (!a) return;
  try {
    const { mk, pf } = await evaluate(a, { ...b.data, clientRequestId: "preview-only" });
    if (!mk) { res.status(400).json({ error: "no_symbol" }); return; }
    res.json({ preflight: pf, market: mk });
  } catch (e) { fail(res, e); }
});

/**
 * Send an entry order. Idempotent by clientRequestId: a repeat (double click, network retry)
 * returns the first result and never sends a second order.
 */
tradeRouter.post("/orders", async (req, res) => {
  const user = userOf(req);
  const b = orderSchema.safeParse(req.body);
  if (!b.success) { res.status(400).json({ error: "bad_request" }); return; }
  const a = await account(req, res, b.data.accountId);
  if (!a) return;
  if (a.status === "paused") { res.status(409).json({ error: "account_paused" }); return; }

  const claimed = await one<{ id: number }>(
    `INSERT INTO vk_orders (user_id, account_id, client_request_id, symbol, side, intent, type, qty, status)
     VALUES ($1, $2, $3, $4, $5, 'open', $6, 0, 'checking') ON CONFLICT (account_id, client_request_id) DO NOTHING RETURNING id`,
    [user.id, a.id, b.data.clientRequestId, b.data.symbol, b.data.side, b.data.type]);
  if (!claimed) {
    const prev = await one("SELECT * FROM vk_orders WHERE account_id = $1 AND client_request_id = $2", [a.id, b.data.clientRequestId]);
    res.json({ order: prev, repeated: true });
    return;
  }
  const finish = (status: string, extra: Record<string, unknown>) =>
    one(`UPDATE vk_orders SET status = $2, qty = COALESCE($3, qty), price = COALESCE($4, price), leverage = COALESCE($5, leverage),
           exchange_order_id = $6, error_code = $7, error_message = $8, preflight = COALESCE($9::jsonb, preflight), updated_at = now()
         WHERE id = $1 RETURNING *`,
      [claimed.id, status, extra.qty ?? null, extra.price ?? null, extra.leverage ?? null, extra.exchangeOrderId ?? null,
        extra.errorCode ?? null, extra.errorMessage ?? null, extra.preflight ? JSON.stringify(extra.preflight) : null]);

  try {
    const { mk, pf } = await evaluate(a, b.data);
    if (!mk || !pf) { res.status(400).json({ error: "no_symbol", order: await finish("rejected", { errorCode: "no_symbol" }) }); return; }
    if (!pf.ok) { res.status(400).json({ error: "preflight_failed", preflight: pf, order: await finish("rejected", { errorCode: pf.errors[0].code, preflight: pf }) }); return; }

    const ex = clientFor(a);
    let params: Record<string, unknown> = {};
    if (a.market === "swap") {
      if (b.data.marginMode && ex.has?.setMarginMode) {
        await ex.setMarginMode(b.data.marginMode, b.data.symbol).catch(() => undefined); // "already set" errors are fine
      }
      if (ex.has?.setLeverage) {
        try { await ex.setLeverage(pf.leverage, b.data.symbol, b.data.marginMode ? { marginMode: b.data.marginMode } : {}); }
        catch (e) { res.status(400).json({ error: "leverage_failed", exchangeError: exchangeError(e), order: await finish("rejected", { errorCode: "leverage_failed", errorMessage: exchangeError(e).message, preflight: pf }) }); return; }
      }
      params = modeParams(a.exchange, await isHedged(a.id, ex), b.data.side, false);
    }
    const sent = await ex.createOrder(b.data.symbol, b.data.type, orderSide(b.data.side, false), pf.qty, b.data.type === "limit" ? pf.price : undefined, params);
    res.json({ order: await finish(sent.status === "closed" ? "filled" : "open", { qty: pf.qty, price: sent.average ?? sent.price ?? pf.price, leverage: pf.leverage, exchangeOrderId: sent.id, preflight: pf }) });
  } catch (e) {
    const err = exchangeError(e);
    // Unknown outcome (timeout/network): the order may be on the exchange. Mark it, never resend.
    const status = err.code === "network" ? "unknown" : "rejected";
    res.status(502).json({ error: "exchange_error", exchangeError: err, order: await finish(status, { errorCode: err.code, errorMessage: err.message }) });
  }
});

tradeRouter.get("/orders/open", async (req, res) => {
  const a = await account(req, res, req.query.accountId);
  if (!a) return;
  try {
    const ex = clientFor(a);
    const sym = req.query.symbol ? String(req.query.symbol) : undefined;
    if (!sym && ex.options?.warnOnFetchOpenOrdersWithoutSymbol !== undefined) ex.options.warnOnFetchOpenOrdersWithoutSymbol = false;
    const orders = await ex.fetchOpenOrders(sym);
    res.json({
      orders: orders.map((o: any) => ({
        id: o.id, symbol: o.symbol, side: o.side, type: o.type, price: o.price ?? null, triggerPrice: o.triggerPrice ?? o.stopPrice ?? null,
        amount: o.amount, filled: o.filled, reduceOnly: Boolean(o.reduceOnly), status: o.status, createdAt: o.timestamp,
      })),
    });
  } catch (e) { fail(res, e); }
});

tradeRouter.delete("/orders/:orderId", async (req, res) => {
  const a = await account(req, res, req.query.accountId);
  if (!a) return;
  try { await clientFor(a).cancelOrder(String(req.params.orderId), String(req.query.symbol)); res.json({ ok: true }); }
  catch (e) { fail(res, e); }
});

/** Close a position (all or a percent) at market, reduce-only. */
tradeRouter.post("/positions/close", async (req, res) => {
  const b = z.object({ accountId: z.number().int(), symbol: z.string(), side: z.enum(["long", "short"]), percent: z.number().min(1).max(100).default(100) }).safeParse(req.body);
  if (!b.success) { res.status(400).json({ error: "bad_request" }); return; }
  const a = await account(req, res, b.data.accountId);
  if (!a) return;
  if (a.market !== "swap") { res.status(400).json({ error: "not_futures" }); return; }
  try {
    const snap = await snapshot(a, true);
    const pos = snap.positions.find((p) => p.symbol === b.data.symbol && p.side === b.data.side);
    if (!pos) { res.status(404).json({ error: "position_not_found" }); return; }
    const mk = await marketOf(a, b.data.symbol);
    const ex = clientFor(a);
    const contracts = pos.size / (mk?.contractSize || 1);
    const qty = b.data.percent >= 100 ? contracts : Number(ex.amountToPrecision(b.data.symbol, (contracts * b.data.percent) / 100));
    const sent = await ex.createOrder(b.data.symbol, "market", orderSide(b.data.side, true), qty, undefined, modeParams(a.exchange, await isHedged(a.id, ex), b.data.side, true));
    await q(`INSERT INTO vk_orders (user_id, account_id, client_request_id, symbol, side, intent, type, qty, status, exchange_order_id)
             VALUES ($1, $2, $3, $4, $5, 'close', 'market', $6, 'sent', $7)`, [a.user_id, a.id, `close-${Date.now()}`, b.data.symbol, b.data.side, qty, sent.id]);
    res.json({ ok: true, orderId: sent.id, qty });
  } catch (e) { fail(res, e); }
});

/** Free balance of the quote coin on the account (for the % buttons). */
tradeRouter.get("/balance", async (req, res) => {
  const a = await account(req, res, req.query.accountId);
  if (!a) return;
  const snap = await snapshot(a);
  if (snap.error) { res.status(502).json({ error: "exchange_error", exchangeError: snap.error }); return; }
  const base = req.query.base ? String(req.query.base) : null;
  res.json({
    quoteFree: snap.balances.filter((x) => x.asset === "USDT").reduce((s, x) => s + x.free, 0),
    baseFree: base ? snap.balances.find((x) => x.asset === base)?.free ?? 0 : null,
    stables: snap.balances.filter((x) => STABLES.has(x.asset)).map((x) => ({ asset: x.asset, free: x.free })),
  });
});
