/** Platform owner: users and their subscriptions. Admins = VEKTOR_ADMIN_EMAILS (comma-separated). */
import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { one, q } from "../db";
import { effectivePlan, PLANS, usage, type PlanId } from "../engine/plans";
import { notify } from "../telegram/notify";
import { actorOf, requireUser } from "./auth";

const admins = () => (process.env.VEKTOR_ADMIN_EMAILS ?? "").toLowerCase().split(",").map((x) => x.trim()).filter(Boolean);
function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!admins().includes(actorOf(req).email.toLowerCase())) { res.status(403).json({ error: "not_admin" }); return; }
  next();
}

const dateText = (d: Date, lang: string) => d.toLocaleDateString(lang === "en" ? "en-GB" : "ru-RU", { day: "numeric", month: "long", year: "numeric" });

export const billingRouter = Router();
billingRouter.use(requireUser);
billingRouter.get("/", async (req, res) => {
  const me = actorOf(req);
  const p = await effectivePlan(me.id);
  res.json({ ...p, name: PLANS[p.plan].name, usage: await usage(me.id), plans: PLANS, contact: process.env.VEKTOR_BILLING_CONTACT ?? null });
});

export const adminRouter = Router();
adminRouter.use(requireUser, requireAdmin);

adminRouter.get("/users", async (req, res) => {
  const s = String(req.query.q ?? "").trim().toLowerCase();
  res.json({
    users: await q(`SELECT u.id, u.email, u.plan, u.plan_until, u.created_at, u.last_login_at,
        (SELECT count(*)::int FROM vk_exchange_accounts a WHERE a.user_id = u.id AND a.env <> 'paper') AS real_accounts,
        (SELECT count(*)::int FROM vk_positions p WHERE p.user_id = u.id AND p.status <> 'closed') AS open_positions
      FROM vk_users u WHERE ($1 = '' OR lower(u.email) LIKE '%' || $1 || '%') ORDER BY u.id DESC LIMIT 200`, [s]),
  });
});

adminRouter.post("/users/:id/plan", async (req, res) => {
  const b = z.object({ plan: z.enum(["free", "trial", "pro", "team"]), days: z.number().int().min(1).max(3650).optional(), until: z.string().optional() }).safeParse(req.body);
  if (!b.success) { res.status(400).json({ error: "bad_request" }); return; }
  const u = await one<{ id: number; plan_until: Date | null; lang: string }>("SELECT id, plan_until, lang FROM vk_users WHERE id = $1", [Number(req.params.id)]);
  if (!u) { res.status(404).json({ error: "not_found" }); return; }
  let until: Date | null = null;
  if (b.data.plan !== "free") {
    if (b.data.until) until = new Date(b.data.until);
    else {
      // Renewal adds to what is left.
      const from = u.plan_until && new Date(u.plan_until).getTime() > Date.now() ? new Date(u.plan_until) : new Date();
      until = new Date(from.getTime() + (b.data.days ?? 30) * 86_400_000);
    }
  }
  await q("UPDATE vk_users SET plan = $2, plan_until = $3, plan_notified = NULL WHERE id = $1", [u.id, b.data.plan, until]);
  const name = PLANS[b.data.plan as PlanId].name;
  await notify(u.id, "subscription", until
    ? { ru: `🎉 Подписка VECTOR «${name.ru}» активна до ${dateText(until, "ru")}.`, en: `🎉 VECTOR «${name.en}» subscription is active until ${dateText(until, "en")}.` }
    : { ru: "Подписка VECTOR переведена на бесплатный тариф.", en: "Your VECTOR subscription is now Free." });
  res.json({ ok: true, until });
});

/** Hourly: 3 days / 1 day before the end and at the end — one message each. */
export function startPlanReminders() {
  const tick = async () => {
    const rows = await q<{ id: number; plan: PlanId; plan_until: Date; plan_notified: string | null }>(
      "SELECT id, plan, plan_until, plan_notified FROM vk_users WHERE plan <> 'free' AND plan_until IS NOT NULL AND plan_until < now() + interval '3 days 1 hour'");
    for (const u of rows) {
      const left = new Date(u.plan_until).getTime() - Date.now();
      const key = left <= 0 ? "ended" : left <= 86_400_000 ? "1d" : "3d";
      if (u.plan_notified === key) continue;
      await q("UPDATE vk_users SET plan_notified = $2 WHERE id = $1", [u.id, key]);
      const contact = process.env.VEKTOR_BILLING_CONTACT ? ` ${process.env.VEKTOR_BILLING_CONTACT}` : "";
      await notify(u.id, "subscription", key === "ended"
        ? { ru: `⌛ Подписка VECTOR закончилась — действуют лимиты бесплатного тарифа. Открытые позиции продолжают вестись. Продлить:${contact || " Настройки → Подписка"}.`, en: `⌛ Your VECTOR subscription has ended — Free limits apply. Open positions stay managed. Renew:${contact || " Settings → Subscription"}.` }
        : { ru: `⏳ Подписка VECTOR заканчивается ${key === "1d" ? "завтра" : "через 3 дня"}. Продлить:${contact || " Настройки → Подписка"}.`, en: `⏳ Your VECTOR subscription ends ${key === "1d" ? "tomorrow" : "in 3 days"}. Renew:${contact || " Settings → Subscription"}.` });
    }
  };
  setInterval(() => void tick().catch((e) => console.error("[plans]", e)), 3_600_000).unref();
  void tick().catch(() => undefined);
}
