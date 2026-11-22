import { Router } from "express";
import express from "express";
import { z } from "zod";
import { one, q } from "../db";
import { keyedHash, randomToken } from "../crypto";
import { BOT_KEYS, BOTS, MONTHLY, PERIODS, price, type BotKey, type Product } from "../billing/products";
import { botConfigured, botStats, checkAccess, verify } from "../billing/botsApi";
import { createInvoice, fromMicro, hasEntitlement, INVOICE_MIN, markPaid, wallet } from "../billing/payments";
import { botSettingsSchema, enqueueSignal, processSignal, receive } from "../signals/process";
import { effectivePlan } from "../engine/plans";
import { actorOf, requireUser, userOf } from "./auth";

export const shopRouter = Router();
shopRouter.use(requireUser);

const telegramOf = async (userId: number) => (await one<{ chat_id: string }>("SELECT chat_id FROM vk_telegram_links WHERE user_id = $1", [userId]))?.chat_id ?? null;

/** Access to a bot: bought in VECTOR (access or autotrading) or bought directly in the bot (asked by Telegram ID). */
export async function botAccess(userId: number, k: BotKey): Promise<{ until: string | null; where: "vector" | "direct" | null }> {
  const v = await hasEntitlement(userId, `bot:${k}:access`);
  if (v) return { until: v.toISOString(), where: "vector" };
  const tg = await telegramOf(userId);
  if (tg && botConfigured(k)) {
    try { const r = await checkAccess(k, tg); if (r.active) return { until: r.until, where: "direct" }; } catch { /* bot offline → unknown */ }
  }
  return { until: null, where: null };
}

shopRouter.get("/catalog", async (req, res) => {
  const me = actorOf(req);
  const plan = await effectivePlan(me.id);
  const terminal = await hasEntitlement(me.id, "terminal");
  const bots = [];
  for (const k of BOT_KEYS) {
    const autoUntil = await hasEntitlement(me.id, `bot:${k}:auto`);
    const copy = await one("SELECT id, account_id, settings, enabled FROM vk_bots WHERE user_id = $1 AND provider = $2", [me.id, k]);
    bots.push({
      key: k, name: BOTS[k].name, desc: BOTS[k].desc, telegram: BOTS[k].telegram,
      stats: await botStats(k), connected: botConfigured(k),
      access: await botAccess(me.id, k), autoUntil: autoUntil?.toISOString() ?? null, copy,
    });
  }
  const prices: Record<string, Record<number, number>> = {};
  for (const kind of ["terminal", "access", "auto"] as const) {
    prices[kind] = Object.fromEntries(PERIODS.map((m) => [m, price(kind === "terminal" ? "terminal" : (`bot:cab:${kind}` as Product), m)]));
  }
  res.json({
    payments: Boolean(wallet()), monthly: MONTHLY, prices, periods: PERIODS,
    terminal: { plan: plan.plan, until: plan.until, paidUntil: terminal?.toISOString() ?? null },
    telegramLinked: Boolean(await telegramOf(me.id)), bots,
  });
});

const itemsSchema = z.array(z.object({ product: z.string(), months: z.union([z.literal(1), z.literal(3), z.literal(12)]) })).min(1).max(7);

shopRouter.post("/invoice", async (req, res) => {
  const me = actorOf(req);
  const b = itemsSchema.safeParse(req.body?.items);
  if (!b.success) { res.status(400).json({ error: "bad_request" }); return; }
  // Bot products need the Telegram ID — that is how access reaches the person in the bot.
  if (b.data.some((i) => i.product.startsWith("bot:")) && !(await telegramOf(me.id))) { res.status(409).json({ error: "telegram_required" }); return; }
  // Autotrading is sold on top of the bot access (bought here or directly in the bot) — or together with it.
  for (const i of b.data) {
    const m = /^bot:(\w+):auto$/.exec(i.product);
    if (!m) continue;
    const withAccess = b.data.some((x) => x.product === `bot:${m[1]}:access`);
    if (!withAccess && !(await botAccess(me.id, m[1] as BotKey)).until) { res.status(409).json({ error: "access_required" }); return; }
  }
  try { res.json(await createInvoice(me.id, b.data as any)); }
  catch (e: any) { res.status(e?.code === "payments_not_configured" ? 503 : 400).json({ error: e?.code ?? "invoice_failed" }); }
});

shopRouter.get("/invoice/:id", async (req, res) => {
  const r = await one("SELECT id, items, amount_micro, status, created_at, expires_at, paid_at, tx_hash FROM vk_invoices WHERE id = $1 AND user_id = $2", [Number(req.params.id), actorOf(req).id]);
  if (!r) { res.status(404).json({ error: "not_found" }); return; }
  res.json({ ...r, amount: fromMicro(r.amount_micro), address: wallet(), minutes: INVOICE_MIN });
});

/** "I paid a different amount" — the TxID goes to the owner for a manual check; nothing is credited automatically. */
shopRouter.post("/invoice/:id/txid", async (req, res) => {
  const txid = String(req.body?.txid ?? "").trim();
  if (!/^[0-9a-fA-F]{64}$/.test(txid)) { res.status(400).json({ error: "bad_txid" }); return; }
  const r = await one("UPDATE vk_invoices SET user_txid = $3 WHERE id = $1 AND user_id = $2 RETURNING id", [Number(req.params.id), actorOf(req).id, txid]);
  if (!r) { res.status(404).json({ error: "not_found" }); return; }
  res.json({ ok: true });
});

shopRouter.get("/invoices", async (req, res) => {
  res.json({ invoices: (await q("SELECT id, items, amount_micro, status, created_at, paid_at, tx_hash FROM vk_invoices WHERE user_id = $1 ORDER BY id DESC LIMIT 50", [actorOf(req).id])).map((r) => ({ ...r, amount: fromMicro(r.amount_micro) })) });
});

/**
 * Autotrading settings for a bot (size, leverage, account, plan). Stored as a signal bot with provider=<bot>;
 * trades only while autotrading is paid, the terminal is active and the bot access is active.
 */
shopRouter.put("/autotrade/:bot", async (req, res) => {
  const user = userOf(req);
  const k = req.params.bot as BotKey;
  if (!BOT_KEYS.includes(k)) { res.status(404).json({ error: "not_found" }); return; }
  const b = z.object({ accountId: z.number().int(), settings: botSettingsSchema, enabled: z.boolean() }).safeParse(req.body);
  if (!b.success) { res.status(400).json({ error: "bad_request" }); return; }
  const acc = await one("SELECT id, market FROM vk_exchange_accounts WHERE id = $1 AND user_id = $2", [b.data.accountId, user.id]);
  if (!acc || acc.market !== "swap") { res.status(400).json({ error: "futures_account_required" }); return; }
  const row = await one(
    `INSERT INTO vk_bots (user_id, account_id, name, token_hash, token_hint, settings, enabled, provider) VALUES ($1, $2, $3, $4, '—', $5, $6, $7)
     ON CONFLICT (user_id, provider) WHERE provider IS NOT NULL DO UPDATE SET account_id = EXCLUDED.account_id, settings = EXCLUDED.settings, enabled = EXCLUDED.enabled
     RETURNING id, account_id, settings, enabled`,
    [user.id, b.data.accountId, BOTS[k].name, keyedHash(`provider:${randomToken()}`), JSON.stringify(b.data.settings), b.data.enabled, k]);
  res.json({ copy: row });
});

/* ---------- signals from the bots (server to server, signed) ---------- */
export const providerRouter = Router();
providerRouter.use(express.text({ type: "*/*", limit: "32kb" }));
providerRouter.post("/:bot", async (req, res) => {
  const k = req.params.bot as BotKey;
  const raw = typeof req.body === "string" ? req.body : (req as any).rawBody ?? JSON.stringify(req.body ?? {});
  if (!BOT_KEYS.includes(k) || !verify(req.headers["x-vector-timestamp"] as string, req.headers["x-vector-signature"] as string, raw)) {
    res.status(401).json({ error: "bad_signature" }); return;
  }
  const copies = await q("SELECT * FROM vk_bots WHERE provider = $1 AND enabled", [k]);
  let queued = 0;
  for (const bot of copies) {
    const manage = /"action"\s*:\s*"(close|move_stop)"/.test(raw); // closing / moving the stop of an open trade is always delivered
    if (!manage) {
      // New entries: paid autotrading + active terminal + bot access (here or direct).
      if (!(await hasEntitlement(bot.user_id, `bot:${k}:auto`))) continue;
      if ((await effectivePlan(bot.user_id)).plan === "free") continue;
      if (!(await botAccess(bot.user_id, k)).until) continue;
    }
    bot.settings = botSettingsSchema.parse(bot.settings);
    const r = await receive(bot, raw);
    if (r.duplicate || !r.parsed) continue;
    void enqueueSignal(bot.id, () => processSignal(bot, r.id!, r.parsed!)).catch((e) => console.error("[provider]", e));
    queued++;
  }
  res.json({ ok: true, queued });
});

/* ---------- owner: payments ---------- */
export async function adminPayments() {
  return {
    invoices: (await q(`SELECT i.id, u.email, i.items, i.amount_micro, i.status, i.created_at, i.paid_at, i.tx_hash, i.user_txid FROM vk_invoices i JOIN vk_users u ON u.id = i.user_id ORDER BY i.id DESC LIMIT 100`)).map((r) => ({ ...r, amount: fromMicro(r.amount_micro) })),
    incoming: (await q(`SELECT tx_hash, from_address, amount_micro, at, invoice_id, status FROM vk_incoming ORDER BY at DESC LIMIT 100`)).map((r) => ({ ...r, amount: fromMicro(r.amount_micro) })),
  };
}
export async function adminAssign(txHash: string, invoiceId: number) {
  const inc = await one("UPDATE vk_incoming SET status = 'assigned', invoice_id = $2 WHERE tx_hash = $1 AND status = 'unmatched' RETURNING from_address", [txHash, invoiceId]);
  if (!inc) return false;
  await markPaid(invoiceId, txHash, inc.from_address);
  return true;
}
