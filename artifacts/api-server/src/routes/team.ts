import { Router } from "express";
import { z } from "zod";
import { one, q } from "../db";
import { openEntry } from "../exchanges/execute";
import type { AccountRow } from "../exchanges/client";
import { checkLimit } from "../engine/plans";
import { notify } from "../telegram/notify";
import { actorOf, requireUser, userOf } from "./auth";

export const teamRouter = Router();
teamRouter.use(requireUser);

/** My team (as owner) and the teams I am invited to / member of. */
teamRouter.get("/", async (req, res) => {
  const me = actorOf(req);
  res.json({
    members: await q(`SELECT t.id, t.email, t.role, t.status, t.created_at FROM vk_team t WHERE t.owner_id = $1 ORDER BY t.id`, [me.id]),
    invites: await q(`SELECT t.id, u.email AS owner_email, t.role, t.status FROM vk_team t JOIN vk_users u ON u.id = t.owner_id WHERE lower(t.email) = lower($1) ORDER BY t.id`, [me.email]),
    settings: (await one("SELECT traders_need_approval FROM vk_team_settings WHERE owner_id = $1", [me.id])) ?? { traders_need_approval: false },
    approvals: await q(`SELECT a.id, a.payload, a.status, a.result, a.created_at, u.email AS actor_email FROM vk_approvals a JOIN vk_users u ON u.id = a.actor_id
                        WHERE a.owner_id = $1 ORDER BY a.id DESC LIMIT 50`, [me.id]),
    activity: await q("SELECT actor_email, action, at FROM vk_team_activity WHERE owner_id = $1 ORDER BY id DESC LIMIT 100", [me.id]),
  });
});

teamRouter.post("/members", async (req, res) => {
  const me = actorOf(req);
  const b = z.object({ email: z.string().trim().toLowerCase().email(), role: z.enum(["viewer", "trader", "admin"]) }).safeParse(req.body);
  if (!b.success) { res.status(400).json({ error: "bad_request" }); return; }
  if (b.data.email === me.email.toLowerCase()) { res.status(400).json({ error: "self_invite" }); return; }
  const lim = await checkLimit(me.id, "teamMembers");
  if (lim) { res.status(402).json(lim); return; }
  const row = await one("INSERT INTO vk_team (owner_id, email, role) VALUES ($1, $2, $3) ON CONFLICT (owner_id, email) DO UPDATE SET role = EXCLUDED.role RETURNING id", [me.id, b.data.email, b.data.role]);
  res.json({ id: row?.id });
});

teamRouter.patch("/members/:id", async (req, res) => {
  const b = z.object({ role: z.enum(["viewer", "trader", "admin"]) }).safeParse(req.body);
  if (!b.success) { res.status(400).json({ error: "bad_request" }); return; }
  await q("UPDATE vk_team SET role = $3 WHERE id = $1 AND owner_id = $2", [Number(req.params.id), actorOf(req).id, b.data.role]);
  res.json({ ok: true });
});

teamRouter.delete("/members/:id", async (req, res) => {
  await q("DELETE FROM vk_team WHERE id = $1 AND owner_id = $2", [Number(req.params.id), actorOf(req).id]);
  res.json({ ok: true });
});

/** The invited person accepts (or leaves). */
teamRouter.post("/invites/:id/accept", async (req, res) => {
  const me = actorOf(req);
  const row = await one("UPDATE vk_team SET member_id = $2, status = 'active' WHERE id = $1 AND lower(email) = lower($3) RETURNING owner_id", [Number(req.params.id), me.id, me.email]);
  if (!row) { res.status(404).json({ error: "not_found" }); return; }
  res.json({ ok: true, workspace: row.owner_id });
});
teamRouter.delete("/invites/:id", async (req, res) => {
  const me = actorOf(req);
  await q("DELETE FROM vk_team WHERE id = $1 AND lower(email) = lower($2)", [Number(req.params.id), me.email]);
  res.json({ ok: true });
});

teamRouter.put("/settings", async (req, res) => {
  const b = z.object({ tradersNeedApproval: z.boolean() }).safeParse(req.body);
  if (!b.success) { res.status(400).json({ error: "bad_request" }); return; }
  await q(`INSERT INTO vk_team_settings (owner_id, traders_need_approval) VALUES ($1, $2) ON CONFLICT (owner_id) DO UPDATE SET traders_need_approval = $2`, [actorOf(req).id, b.data.tradersNeedApproval]);
  res.json({ ok: true });
});

/** Owner (or an admin of the workspace acting as owner) decides a trader's order. */
teamRouter.post("/approvals/:id", async (req, res) => {
  const me = actorOf(req);
  const approve = req.body?.approve === true;
  const a = await one("UPDATE vk_approvals SET status = $3, decided_by = $2, decided_at = now() WHERE id = $1 AND owner_id = $2 AND status = 'pending' RETURNING *", [Number(req.params.id), me.id, approve ? "approved" : "rejected"]);
  if (!a) { res.status(404).json({ error: "not_found" }); return; }
  if (!approve) { res.json({ ok: true }); return; }
  const acc = await one<AccountRow & { status: string }>("SELECT * FROM vk_exchange_accounts WHERE id = $1 AND user_id = $2", [a.payload.accountId, me.id]);
  if (!acc) { await q("UPDATE vk_approvals SET status = 'failed', result = $2 WHERE id = $1", [a.id, JSON.stringify({ error: "account_not_found" })]); res.status(404).json({ error: "account_not_found" }); return; }
  const owner = (await one<{ id: number; lang: string }>("SELECT id, lang FROM vk_users WHERE id = $1", [me.id]))!;
  const r = await openEntry(acc, owner, a.payload, { kind: "terminal", label: `${owner.lang === "en" ? "Team" : "Команда"}: ${a.payload.actorEmail ?? ""}`.trim() });
  await q("UPDATE vk_approvals SET status = $2, result = $3 WHERE id = $1", [a.id, r.http === 200 ? "approved" : "failed", JSON.stringify(r.body)]);
  res.status(r.http).json(r.body);
});

/** Used by POST /orders: a trader's order waits for the owner when the workspace requires it. */
export async function needsApproval(req: any): Promise<boolean> {
  const actor = actorOf(req);
  if (actor.role !== "trader") return false;
  const s = await one("SELECT traders_need_approval FROM vk_team_settings WHERE owner_id = $1", [userOf(req).id]);
  return Boolean(s?.traders_need_approval);
}

export async function queueApproval(req: any, payload: Record<string, unknown>): Promise<number> {
  const actor = actorOf(req), owner = userOf(req);
  const row = (await one<{ id: number }>("INSERT INTO vk_approvals (owner_id, actor_id, payload) VALUES ($1, $2, $3) RETURNING id", [owner.id, actor.id, JSON.stringify({ ...payload, actorEmail: actor.email })]))!;
  const sym = String(payload.symbol ?? "").split("/")[0];
  await notify(owner.id, "security", {
    ru: `👥 ${actor.email} просит открыть ${payload.side === "long" ? "лонг" : "шорт"} ${sym} — подтвердите в Настройки → Команда.`,
    en: `👥 ${actor.email} asks to open a ${payload.side} ${sym} — approve in Settings → Team.`,
  });
  return row.id;
}
