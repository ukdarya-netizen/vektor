import { Router } from "express";
import { z } from "zod";
import { one, q } from "../db";
import { requireUser, userOf, type AuthedRequest } from "./auth";
import { botUsername, createLink } from "../telegram/bot";
import { DEFAULT_GROUPS, GROUPS, notify, type Group } from "../telegram/notify";
import { outboxStatus } from "../telegram/outbox";
import { T } from "../telegram/texts";
import { pushPublicKey, sendPush } from "../telegram/push";

export const notificationsRouter = Router();
notificationsRouter.use(requireUser);

notificationsRouter.get("/", async (req, res) => {
  const user = userOf(req);
  const link = await one("SELECT chat_id, username, linked_at FROM vk_telegram_links WHERE user_id = $1", [user.id]);
  const s = await one("SELECT groups, quiet_from, quiet_to, email_mode, push_mode FROM vk_notification_settings WHERE user_id = $1", [user.id]);
  const subs = await one<{ n: number }>("SELECT count(*)::int AS n FROM vk_push_subs WHERE user_id = $1", [user.id]);
  res.json({
    telegram: { configured: Boolean(process.env.TELEGRAM_BOT_TOKEN && botUsername()), bot: botUsername() || null, linked: Boolean(link), username: link?.username ?? null, linkedAt: link?.linked_at ?? null },
    groups: { ...DEFAULT_GROUPS, ...(s?.groups ?? {}) },
    quietFrom: s?.quiet_from ?? null,
    quietTo: s?.quiet_to ?? null,
    delivery: await outboxStatus(user.id),
    email: { configured: Boolean(process.env.RESEND_API_KEY && process.env.MAIL_FROM), mode: s?.email_mode ?? "critical", address: user.email },
    push: { publicKey: pushPublicKey(), mode: s?.push_mode ?? "all", devices: subs?.n ?? 0 },
  });
});

notificationsRouter.post("/telegram/link", async (req, res) => {
  const user = userOf(req);
  const link = await createLink(user.id);
  if (!link) { res.status(503).json({ error: "telegram_not_configured" }); return; }
  res.json(link);
});

notificationsRouter.delete("/telegram", async (req, res) => {
  const user = userOf(req);
  await q("DELETE FROM vk_telegram_links WHERE user_id = $1", [user.id]);
  res.json({ ok: true });
});

notificationsRouter.post("/push", async (req, res) => {
  const user = userOf(req);
  const b = z.object({ endpoint: z.string().url().max(1000), keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }) }).safeParse(req.body?.subscription);
  if (!b.success) { res.status(400).json({ error: "bad_request" }); return; }
  await q(`INSERT INTO vk_push_subs (user_id, endpoint, keys, user_agent) VALUES ($1, $2, $3, $4)
           ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, keys = EXCLUDED.keys`,
    [user.id, b.data.endpoint, JSON.stringify(b.data.keys), String(req.headers["user-agent"] ?? "").slice(0, 200)]);
  const sent = await sendPush(user.id, "VECTOR", user.lang === "en" ? "Push notifications are on." : "Push-уведомления включены.");
  res.json({ ok: true, sent });
});

notificationsRouter.delete("/push", async (req, res) => {
  await q("DELETE FROM vk_push_subs WHERE user_id = $1", [userOf(req).id]);
  res.json({ ok: true });
});

notificationsRouter.post("/telegram/test", async (req, res) => {
  const user = userOf(req);
  res.json({ sent: await notify(user.id, "test", T.test) });
});

const groupKeys = Object.keys(GROUPS) as [Group, ...Group[]];
notificationsRouter.put("/", async (req, res) => {
  const user = userOf(req);
  const b = z.object({
    groups: z.record(z.enum(groupKeys), z.boolean()).optional(),
    quietFrom: z.number().int().min(0).max(23).nullable().optional(),
    quietTo: z.number().int().min(0).max(23).nullable().optional(),
    emailMode: z.enum(["off", "critical", "all"]).optional(),
    pushMode: z.enum(["off", "critical", "all"]).optional(),
  }).safeParse(req.body);
  if (!b.success) { res.status(400).json({ error: "bad_request" }); return; }
  await q(`INSERT INTO vk_notification_settings (user_id, groups, quiet_from, quiet_to) VALUES ($1, COALESCE($2::jsonb, '{}'::jsonb), $3, $4)
           ON CONFLICT (user_id) DO UPDATE SET groups = vk_notification_settings.groups || COALESCE($2::jsonb, '{}'::jsonb),
             quiet_from = CASE WHEN $5 THEN $3 ELSE vk_notification_settings.quiet_from END,
             quiet_to = CASE WHEN $5 THEN $4 ELSE vk_notification_settings.quiet_to END`,
    [user.id, b.data.groups ? JSON.stringify(b.data.groups) : null, b.data.quietFrom ?? null, b.data.quietTo ?? null, b.data.quietFrom !== undefined || b.data.quietTo !== undefined]);
  if (b.data.emailMode || b.data.pushMode) {
    await q(`UPDATE vk_notification_settings SET email_mode = COALESCE($2, email_mode), push_mode = COALESCE($3, push_mode) WHERE user_id = $1`, [user.id, b.data.emailMode ?? null, b.data.pushMode ?? null]);
  }
  res.json({ ok: true });
});
