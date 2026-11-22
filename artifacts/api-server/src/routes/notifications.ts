import { Router } from "express";
import { z } from "zod";
import { one, q } from "../db";
import { requireUser, userOf, type AuthedRequest } from "./auth";
import { botUsername, createLink } from "../telegram/bot";
import { DEFAULT_GROUPS, GROUPS, notify, type Group } from "../telegram/notify";
import { outboxStatus } from "../telegram/outbox";
import { T } from "../telegram/texts";

export const notificationsRouter = Router();
notificationsRouter.use(requireUser);

notificationsRouter.get("/", async (req, res) => {
  const user = userOf(req);
  const link = await one("SELECT chat_id, username, linked_at FROM vk_telegram_links WHERE user_id = $1", [user.id]);
  const s = await one("SELECT groups, quiet_from, quiet_to FROM vk_notification_settings WHERE user_id = $1", [user.id]);
  res.json({
    telegram: { configured: Boolean(process.env.TELEGRAM_BOT_TOKEN && botUsername()), bot: botUsername() || null, linked: Boolean(link), username: link?.username ?? null, linkedAt: link?.linked_at ?? null },
    groups: { ...DEFAULT_GROUPS, ...(s?.groups ?? {}) },
    quietFrom: s?.quiet_from ?? null,
    quietTo: s?.quiet_to ?? null,
    delivery: await outboxStatus(user.id),
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
  }).safeParse(req.body);
  if (!b.success) { res.status(400).json({ error: "bad_request" }); return; }
  await q(`INSERT INTO vk_notification_settings (user_id, groups, quiet_from, quiet_to) VALUES ($1, COALESCE($2::jsonb, '{}'::jsonb), $3, $4)
           ON CONFLICT (user_id) DO UPDATE SET groups = vk_notification_settings.groups || COALESCE($2::jsonb, '{}'::jsonb),
             quiet_from = CASE WHEN $5 THEN $3 ELSE vk_notification_settings.quiet_from END,
             quiet_to = CASE WHEN $5 THEN $4 ELSE vk_notification_settings.quiet_to END`,
    [user.id, b.data.groups ? JSON.stringify(b.data.groups) : null, b.data.quietFrom ?? null, b.data.quietTo ?? null, b.data.quietFrom !== undefined || b.data.quietTo !== undefined]);
  res.json({ ok: true });
});
