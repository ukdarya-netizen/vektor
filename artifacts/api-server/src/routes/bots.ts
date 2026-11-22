import { Router } from "express";
import express from "express";
import { z } from "zod";
import { one, q } from "../db";
import { keyedHash, randomToken } from "../crypto";
import { planErrors, planSchema } from "../engine/plan";
import { NO_LIMITS, limitsOf } from "../engine/risk";
import { botSettingsSchema, enqueueSignal, processSignal, receive } from "../signals/process";
import { require2fa, requireUser, userOf } from "./auth";

/** Public: TradingView / any server POSTs here. The secret is the token in the URL. */
export const hookRouter = Router();
hookRouter.use(express.text({ type: ["text/*", "application/x-www-form-urlencoded"], limit: "16kb" }));
hookRouter.post("/:token", async (req, res) => {
  const bot = await one("SELECT * FROM vk_bots WHERE token_hash = $1", [keyedHash(`bot:${req.params.token}`)]);
  if (!bot) { res.status(404).json({ error: "unknown_bot" }); return; }
  const raw = typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {});
  bot.settings = botSettingsSchema.parse(bot.settings);
  const r = await receive(bot, raw);
  if (r.duplicate) { res.json({ ok: true, status: "duplicate" }); return; }
  if (!r.parsed) { res.status(400).json({ ok: false, status: "rejected", reason: r.reason }); return; }
  // Answer at once (TradingView waits only ~3 s); the signal is executed right after, in order.
  res.json({ ok: true, status: "accepted", signalId: r.id });
  void enqueueSignal(bot.id, () => processSignal(bot, r.id!, r.parsed!)).catch((e) => console.error("[signal]", e));
});

export const botsRouter = Router();
botsRouter.use(requireUser);

const PUBLIC = "id, account_id, name, token_hint, settings, enabled, created_at";
const CHANNELS = "(SELECT coalesce(json_agg(json_build_object('chatId', c.chat_id, 'title', c.title)), '[]') FROM vk_bot_channels c WHERE c.bot_id = b.id) AS channels";

botsRouter.get("/bots", async (req, res) => {
  const user = userOf(req);
  const bots = await q(`SELECT ${PUBLIC},
      (SELECT count(*)::int FROM vk_signals s WHERE s.bot_id = b.id AND s.received_at > now() - interval '24 hours' AND NOT s.test) AS signals24h,
      ${CHANNELS}
    FROM vk_bots b WHERE user_id = $1 ORDER BY id`, [user.id]);
  res.json({ bots });
});

async function validSettings(userId: number, body: unknown) {
  const b = z.object({ name: z.string().trim().min(1).max(60), accountId: z.number().int(), settings: botSettingsSchema, enabled: z.boolean().optional() }).safeParse(body);
  if (!b.success) return { error: "bad_request" as const, issues: b.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
  const acc = await one("SELECT id, market FROM vk_exchange_accounts WHERE id = $1 AND user_id = $2", [b.data.accountId, userId]);
  if (!acc) return { error: "account_not_found" as const };
  // Plan sanity at a reference entry of 100 (sides and DCA vs stop do not depend on the price).
  const pl = b.data.settings.plan;
  if (pl.stop?.mode !== "price" && pl.takes.every((t) => t.mode === "pct")) {
    for (const side of ["long", "short"] as const) {
      const errs = planErrors(pl, side, 100);
      if (errs.length) return { error: errs[0] };
    }
  }
  return { data: b.data };
}

/** Creating a bot returns the webhook token ONCE; only its hash is stored. */
botsRouter.post("/bots", async (req, res) => {
  const user = userOf(req);
  const v = await validSettings(user.id, req.body);
  if (!("data" in v)) { res.status(400).json(v); return; }
  const token = randomToken(24);
  const row = await one(`INSERT INTO vk_bots (user_id, account_id, name, token_hash, token_hint, settings, enabled) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${PUBLIC}`,
    [user.id, v.data!.accountId, v.data!.name, keyedHash(`bot:${token}`), `${token.slice(0, 4)}…`, JSON.stringify(v.data!.settings), v.data!.enabled ?? true]);
  res.json({ bot: row, token });
});

botsRouter.put("/bots/:id", async (req, res) => {
  const user = userOf(req);
  const v = await validSettings(user.id, req.body);
  if (!("data" in v)) { res.status(400).json(v); return; }
  const row = await one(`UPDATE vk_bots SET name = $3, account_id = $4, settings = $5, enabled = COALESCE($6, enabled) WHERE id = $1 AND user_id = $2 RETURNING ${PUBLIC}`,
    [Number(req.params.id), user.id, v.data!.name, v.data!.accountId, JSON.stringify(v.data!.settings), v.data!.enabled ?? null]);
  if (!row) { res.status(404).json({ error: "not_found" }); return; }
  res.json({ bot: row });
});

botsRouter.patch("/bots/:id", async (req, res) => {
  const user = userOf(req);
  const b = z.object({ enabled: z.boolean() }).safeParse(req.body);
  if (!b.success) { res.status(400).json({ error: "bad_request" }); return; }
  const row = await one(`UPDATE vk_bots SET enabled = $3 WHERE id = $1 AND user_id = $2 RETURNING ${PUBLIC}`, [Number(req.params.id), user.id, b.data.enabled]);
  res.json({ bot: row });
});

/** New webhook URL (the old one stops working at once). */
botsRouter.post("/bots/:id/token", async (req, res) => {
  const user = userOf(req);
  const token = randomToken(24);
  const row = await one(`UPDATE vk_bots SET token_hash = $3, token_hint = $4 WHERE id = $1 AND user_id = $2 RETURNING id`,
    [Number(req.params.id), user.id, keyedHash(`bot:${token}`), `${token.slice(0, 4)}…`]);
  if (!row) { res.status(404).json({ error: "not_found" }); return; }
  res.json({ token });
});

/** Code to post once in a Telegram channel/group where the Vektor bot is added. */
botsRouter.post("/bots/:id/telegram-link", async (req, res) => {
  const user = userOf(req);
  const bot = await one("SELECT id FROM vk_bots WHERE id = $1 AND user_id = $2", [Number(req.params.id), user.id]);
  if (!bot) { res.status(404).json({ error: "not_found" }); return; }
  const code = randomToken(8).replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 6).padEnd(6, "X");
  await q("DELETE FROM vk_channel_link_codes WHERE bot_id = $1 OR expires_at < now()", [bot.id]);
  await q("INSERT INTO vk_channel_link_codes (code, bot_id, expires_at) VALUES ($1, $2, now() + interval '15 minutes')", [code, bot.id]);
  res.json({ code: `vektor-${code}`, bot: process.env.TELEGRAM_BOT_USERNAME?.replace(/^@/, "") ?? null, expiresInMin: 15 });
});

botsRouter.delete("/bots/:id/channels/:chatId", async (req, res) => {
  const user = userOf(req);
  await q("DELETE FROM vk_bot_channels c USING vk_bots b WHERE c.bot_id = b.id AND b.user_id = $1 AND b.id = $2 AND c.chat_id = $3", [user.id, Number(req.params.id), String(req.params.chatId)]);
  res.json({ ok: true });
});

botsRouter.delete("/bots/:id", async (req, res) => {
  const user = userOf(req);
  await q("DELETE FROM vk_bots WHERE id = $1 AND user_id = $2", [Number(req.params.id), user.id]);
  res.json({ ok: true });
});

/** Test: parse and check the signal, explain what would happen — nothing is sent to the exchange. */
botsRouter.post("/bots/:id/test", async (req, res) => {
  const user = userOf(req);
  const bot = await one("SELECT * FROM vk_bots WHERE id = $1 AND user_id = $2", [Number(req.params.id), user.id]);
  if (!bot) { res.status(404).json({ error: "not_found" }); return; }
  bot.settings = botSettingsSchema.parse(bot.settings);
  const raw = String(req.body?.raw ?? "");
  const r = await receive(bot, raw, true);
  if (!r.parsed) { res.json({ status: "rejected", reason: `parse_error:${r.reason}`, parsed: null }); return; }
  const out = await processSignal(bot, r.id!, r.parsed, { dryRun: true });
  res.json({ ...out, parsed: r.parsed });
});

botsRouter.get("/signals", async (req, res) => {
  const user = userOf(req);
  const botId = req.query.botId ? Number(req.query.botId) : null;
  res.json({
    signals: await q(`SELECT s.id, s.bot_id, b.name AS bot_name, s.raw, s.parsed, s.status, s.reason, s.detail, s.position_id, s.test, s.received_at, s.done_at
                      FROM vk_signals s JOIN vk_bots b ON b.id = s.bot_id WHERE s.user_id = $1 AND ($2::bigint IS NULL OR s.bot_id = $2)
                      ORDER BY s.id DESC LIMIT 100`, [user.id, botId]),
  });
});

/* ---------- templates ---------- */
const templateSchema = z.object({
  name: z.string().trim().min(1).max(60),
  sizing: z.object({ amountMode: z.enum(["usdt", "percent"]), amount: z.number().positive(), leverage: z.number().int().min(1).max(250), marginMode: z.enum(["isolated", "cross"]) }),
  plan: planSchema,
});
botsRouter.get("/templates", async (req, res) => {
  res.json({ templates: await q("SELECT id, name, sizing, plan FROM vk_templates WHERE user_id = $1 ORDER BY name", [userOf(req).id]) });
});
botsRouter.post("/templates", async (req, res) => {
  const b = templateSchema.safeParse(req.body);
  if (!b.success) { res.status(400).json({ error: "bad_request" }); return; }
  res.json({ template: await one("INSERT INTO vk_templates (user_id, name, sizing, plan) VALUES ($1, $2, $3, $4) RETURNING id, name, sizing, plan",
    [userOf(req).id, b.data.name, JSON.stringify(b.data.sizing), JSON.stringify(b.data.plan)]) });
});
botsRouter.delete("/templates/:id", async (req, res) => {
  await q("DELETE FROM vk_templates WHERE id = $1 AND user_id = $2", [Number(req.params.id), userOf(req).id]);
  res.json({ ok: true });
});

/* ---------- risk limits ---------- */
botsRouter.get("/risk", async (req, res) => {
  const l = await limitsOf(userOf(req).id);
  res.json({ limits: l === NO_LIMITS ? { ...NO_LIMITS } : l });
});
botsRouter.put("/risk", require2fa, async (req, res) => {
  const n = z.number().positive().nullable();
  const b = z.object({ killSwitch: z.boolean(), maxLeverage: z.number().int().min(1).max(250).nullable(), maxMarginPerTrade: n, maxOpenPositions: z.number().int().min(1).max(500).nullable(), dailyLossLimit: n }).safeParse(req.body);
  if (!b.success) { res.status(400).json({ error: "bad_request" }); return; }
  const l = b.data;
  await q(`INSERT INTO vk_risk (user_id, kill_switch, max_leverage, max_margin_per_trade, max_open_positions, daily_loss_limit) VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (user_id) DO UPDATE SET kill_switch = $2, max_leverage = $3, max_margin_per_trade = $4, max_open_positions = $5, daily_loss_limit = $6, updated_at = now()`,
    [userOf(req).id, l.killSwitch, l.maxLeverage, l.maxMarginPerTrade, l.maxOpenPositions, l.dailyLossLimit]);
  res.json({ ok: true });
});

/* ---------- journal ---------- */
botsRouter.get("/journal", async (req, res) => {
  const user = userOf(req);
  const days = Math.min(365, Math.max(1, Number(req.query.days ?? 30)));
  const rows = await q(`SELECT p.id, p.symbol, p.side, p.source, p.source_label, p.status, p.entry_price, p.exit_price, p.initial_qty, p.leverage,
        p.pnl, p.pnl_pct, p.fees, p.close_reason, p.opened_at, p.closed_at, p.created_at, a.label AS account_label, a.env
      FROM vk_positions p JOIN vk_exchange_accounts a ON a.id = p.account_id
      WHERE p.user_id = $1 AND p.created_at > now() - make_interval(days => $2) ORDER BY p.created_at DESC LIMIT 500`, [user.id, days]);
  const closed = rows.filter((r) => r.status === "closed" && r.pnl !== null && r.close_reason !== "unmanaged" && r.close_reason !== "entry_cancelled");
  const pnl = closed.reduce((s, r) => s + Number(r.pnl), 0);
  const wins = closed.filter((r) => Number(r.pnl) > 0).length;
  res.json({
    days, positions: rows,
    summary: { closed: closed.length, wins, losses: closed.length - wins, pnl, fees: closed.reduce((s, r) => s + Number(r.fees ?? 0), 0),
      best: closed.length ? Math.max(...closed.map((r) => Number(r.pnl))) : null, worst: closed.length ? Math.min(...closed.map((r) => Number(r.pnl))) : null },
  });
});
