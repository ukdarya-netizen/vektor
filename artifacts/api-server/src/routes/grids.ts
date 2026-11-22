import { Router } from "express";
import { z } from "zod";
import { one, q } from "../db";
import { clientFor, exchangeError, type AccountRow } from "../exchanges/client";
import { gridLevels, gridQty, gridSettingsSchema, startGrid, stopGrid } from "../engine/grid";
import { requireUser, userOf } from "./auth";

export const gridsRouter = Router();
gridsRouter.use(requireUser);

gridsRouter.get("/", async (req, res) => {
  res.json({ grids: await q(`SELECT g.id, g.account_id, a.label AS account_label, g.name, g.settings, g.status, g.state, g.stop_reason, g.last_error, g.created_at, g.started_at, g.stopped_at
    FROM vk_grids g JOIN vk_exchange_accounts a ON a.id = g.account_id WHERE g.user_id = $1 ORDER BY g.id DESC`, [userOf(req).id]) });
});

/** Preview without placing anything: levels, quantity per level, profit per round. */
gridsRouter.post("/preview", async (req, res) => {
  const b = gridSettingsSchema.safeParse(req.body?.settings);
  if (!b.success) { res.status(400).json({ error: b.error.issues[0]?.message ?? "bad_request" }); return; }
  const levels = gridLevels(b.data);
  const qty = gridQty(b.data, levels);
  const steps = levels.slice(1).map((l, i) => (l - levels[i]) / levels[i] * 100);
  res.json({ levels, qty, stepPctMin: Math.min(...steps), stepPctMax: Math.max(...steps), profitPerRound: qty * (levels[1] - levels[0]) });
});

gridsRouter.post("/", async (req, res) => {
  const user = userOf(req);
  const b = z.object({ name: z.string().trim().min(1).max(60), accountId: z.number().int(), settings: gridSettingsSchema }).safeParse(req.body);
  if (!b.success) { res.status(400).json({ error: b.error.issues[0]?.message ?? "bad_request" }); return; }
  const a = await one<AccountRow & { label: string; status: string }>("SELECT * FROM vk_exchange_accounts WHERE id = $1 AND user_id = $2", [b.data.accountId, user.id]);
  if (!a) { res.status(404).json({ error: "account_not_found" }); return; }
  if (a.status === "paused") { res.status(409).json({ error: "account_paused" }); return; }
  const clash = await one("SELECT 1 FROM vk_grids WHERE account_id = $1 AND settings->>'symbol' = $2 AND status = 'running'", [a.id, b.data.settings.symbol]);
  const managed = await one("SELECT 1 FROM vk_positions WHERE account_id = $1 AND symbol = $2 AND side = 'long' AND status <> 'closed'", [a.id, b.data.settings.symbol]);
  if (clash || managed) { res.status(409).json({ error: "symbol_busy" }); return; }
  const g = (await one("INSERT INTO vk_grids (user_id, account_id, name, settings) VALUES ($1, $2, $3, $4) RETURNING *", [user.id, a.id, b.data.name, JSON.stringify(b.data.settings)]))!;
  try {
    await startGrid({ ...g, settings: b.data.settings }, a, clientFor(a));
    res.json({ grid: await one("SELECT * FROM vk_grids WHERE id = $1", [g.id]) });
  } catch (e: any) {
    const err = e?.code ? { code: e.code, message: e.message } : exchangeError(e);
    // Whatever was placed before the failure is cancelled.
    await stopGrid({ ...g, settings: b.data.settings, state: null }, a, clientFor(a), false, "start_failed").catch(() => undefined);
    await q("UPDATE vk_grids SET status = 'error', last_error = $2 WHERE id = $1", [g.id, err.message]);
    res.status(400).json({ error: err.code ?? "exchange_error", exchangeError: err });
  }
});

gridsRouter.post("/:id/stop", async (req, res) => {
  const user = userOf(req);
  const g = await one("SELECT * FROM vk_grids WHERE id = $1 AND user_id = $2 AND status = 'running'", [Number(req.params.id), user.id]);
  if (!g) { res.status(404).json({ error: "not_found" }); return; }
  const a = (await one<AccountRow & { label: string }>("SELECT * FROM vk_exchange_accounts WHERE id = $1", [g.account_id]))!;
  const close = req.body?.close === true;
  try { await stopGrid(g, a, clientFor(a), close, close ? "manual_close" : "manual"); res.json({ ok: true }); }
  catch (e) { res.status(502).json({ error: "exchange_error", exchangeError: exchangeError(e) }); }
});

gridsRouter.delete("/:id", async (req, res) => {
  await q("DELETE FROM vk_grids WHERE id = $1 AND user_id = $2 AND status <> 'running'", [Number(req.params.id), userOf(req).id]);
  res.json({ ok: true });
});
