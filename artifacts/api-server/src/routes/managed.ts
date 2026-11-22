import { Router } from "express";
import { z } from "zod";
import { one, q } from "../db";
import { clientFor, exchangeError, type AccountRow } from "../exchanges/client";
import { planErrors, planSchema } from "../engine/plan";
import { requireUser, userOf } from "./auth";

export const managedRouter = Router();
managedRouter.use(requireUser);

const PUBLIC = `id, account_id, symbol, side, source, source_label, status, plan, entry_price, initial_qty, qty, leverage,
  stop_price, stop_kind, stop_where, takes, be_done, realized_pnl, opened_at, closed_at, close_reason, exit_price, pnl, pnl_pct, fees,
  last_error, last_sync_at, created_at`;

/** Open and recently closed managed positions. */
managedRouter.get("/", async (req, res) => {
  const user = userOf(req);
  const rows = await q(`SELECT ${PUBLIC} FROM vk_positions WHERE user_id = $1 AND (status <> 'closed' OR closed_at > now() - interval '7 days')
                        ORDER BY status = 'closed', created_at DESC LIMIT 200`, [user.id]);
  res.json({ positions: rows });
});

managedRouter.get("/:id/events", async (req, res) => {
  const user = userOf(req);
  res.json({ events: await q("SELECT kind, detail, at FROM vk_position_events WHERE position_id = $1 AND user_id = $2 ORDER BY id", [Number(req.params.id), user.id]) });
});

/** Take a position that is already open on the exchange (opened anywhere) under management. */
managedRouter.post("/", async (req, res) => {
  const user = userOf(req);
  const b = z.object({ accountId: z.number().int(), symbol: z.string(), side: z.enum(["long", "short"]), plan: planSchema }).safeParse(req.body);
  if (!b.success) { res.status(400).json({ error: "bad_request", issues: b.error.issues.map((i) => i.message) }); return; }
  const a = await one<AccountRow>("SELECT * FROM vk_exchange_accounts WHERE id = $1 AND user_id = $2", [b.data.accountId, user.id]);
  if (!a) { res.status(404).json({ error: "account_not_found" }); return; }
  try {
    const live = await clientFor(a).fetchPositions([b.data.symbol]);
    const pos = live.find((x: any) => x.symbol === b.data.symbol && x.side === b.data.side && Math.abs(Number(x.contracts ?? 0)) > 0);
    if (!pos) { res.status(404).json({ error: "position_not_found" }); return; }
    const errs = planErrors(b.data.plan, b.data.side, Number(pos.entryPrice));
    if (errs.length) { res.status(400).json({ error: errs[0] }); return; }
    const row = await one(
      `INSERT INTO vk_positions (user_id, account_id, symbol, side, source, source_label, status, plan, leverage)
       VALUES ($1, $2, $3, $4, 'external', $5, 'pending', $6, $7) ON CONFLICT DO NOTHING RETURNING ${PUBLIC}`,
      [user.id, a.id, b.data.symbol, b.data.side, req.body?.lang === "en" ? "Manual" : "Вручную", JSON.stringify(b.data.plan), pos.leverage ?? null]);
    if (!row) { res.status(409).json({ error: "already_managed" }); return; }
    res.json({ position: row });
  } catch (e) { res.status(502).json({ error: "exchange_error", exchangeError: exchangeError(e) }); }
});

/** Change the plan of an open position; the engine applies it on its next pass. */
managedRouter.patch("/:id", async (req, res) => {
  const user = userOf(req);
  const b = z.object({ plan: planSchema }).safeParse(req.body);
  if (!b.success) { res.status(400).json({ error: "bad_request", issues: b.error.issues.map((i) => i.message) }); return; }
  const cur = await one("SELECT side, entry_price, status FROM vk_positions WHERE id = $1 AND user_id = $2", [Number(req.params.id), user.id]);
  if (!cur || cur.status === "closed") { res.status(404).json({ error: "not_found" }); return; }
  if (cur.entry_price) {
    const errs = planErrors(b.data.plan, cur.side, Number(cur.entry_price));
    if (errs.length) { res.status(400).json({ error: errs[0] }); return; }
  }
  const row = await one(`UPDATE vk_positions SET plan = $3, resync = (status = 'open'), updated_at = now() WHERE id = $1 AND user_id = $2 RETURNING ${PUBLIC}`,
    [Number(req.params.id), user.id, JSON.stringify(b.data.plan)]);
  res.json({ position: row });
});

/** Stop managing: Vektor's take orders are cancelled; the stop stays on the exchange unless asked. */
managedRouter.delete("/:id", async (req, res) => {
  const user = userOf(req);
  const p = await one("SELECT * FROM vk_positions WHERE id = $1 AND user_id = $2 AND status <> 'closed'", [Number(req.params.id), user.id]);
  if (!p) { res.status(404).json({ error: "not_found" }); return; }
  const a = await one<AccountRow>("SELECT * FROM vk_exchange_accounts WHERE id = $1", [p.account_id]);
  const ex = a ? clientFor(a) : null;
  for (const t of p.takes ?? []) if (t.state === "open" && t.orderId) await ex?.cancelOrder(t.orderId, p.symbol).catch(() => undefined);
  if (req.query.cancelStop === "1" && p.stop_order_id) await ex?.cancelOrder(p.stop_order_id, p.symbol).catch(() => undefined);
  await q("UPDATE vk_positions SET status = 'closed', close_reason = 'unmanaged', closed_at = now(), updated_at = now() WHERE id = $1", [p.id]);
  await q("INSERT INTO vk_position_events (position_id, user_id, kind, detail) VALUES ($1, $2, 'unmanaged', $3)", [p.id, user.id, JSON.stringify({ cancelStop: req.query.cancelStop === "1" })]);
  res.json({ ok: true });
});
