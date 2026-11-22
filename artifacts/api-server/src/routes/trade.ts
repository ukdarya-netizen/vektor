import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { one } from "../db";
import { clientFor, exchangeError, type AccountRow } from "../exchanges/client";
import { candles, orderBook, TIMEFRAMES } from "../exchanges/market";
import { closePosition, evaluate, marketsCached, openEntry } from "../exchanges/execute";
import { subscribe } from "../exchanges/feed";
import { snapshot, STABLES } from "../exchanges/snapshot";
import { requireUser, userOf } from "./auth";
import { planSchema } from "../engine/plan";

export const tradeRouter = Router();
tradeRouter.use(requireUser);

async function account(req: Request<any>, res: Response, id: unknown): Promise<(AccountRow & { status: string }) | null> {
  const a = await one<AccountRow & { status: string }>("SELECT * FROM vk_exchange_accounts WHERE id = $1 AND user_id = $2", [Number(id), userOf(req).id]);
  if (!a) res.status(404).json({ error: "account_not_found" });
  return a;
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
  /** Futures only: take-profits, stop, break-even, trailing — the engine manages the position after the fill. */
  plan: planSchema.nullable().optional(),
});

/** Preview: exactly what would be sent and why not, without sending anything. */
tradeRouter.post("/orders/preview", async (req, res) => {
  const b = orderSchema.partial({ clientRequestId: true }).safeParse(req.body);
  if (!b.success) { res.status(400).json({ error: "bad_request" }); return; }
  const a = await account(req, res, b.data.accountId);
  if (!a) return;
  try {
    const { mk, pf } = await evaluate(a, b.data);
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
  const r = await openEntry(a, user, b.data, { kind: "terminal", label: user.lang === "en" ? "Terminal" : "Терминал" });
  res.status(r.http).json(r.body);
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
    const r = await closePosition(a, b.data.symbol, b.data.side, b.data.percent, "terminal");
    if (!r) { res.status(404).json({ error: "position_not_found" }); return; }
    res.json({ ok: true, ...r });
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
