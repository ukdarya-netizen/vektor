/**
 * Crypto payments: USDT TRC20 straight to the owner's wallet (PAY_TRC20_ADDRESS). No intermediary.
 *
 * How a payment is tied to the person who asked for it:
 *  - every invoice gets a UNIQUE amount (price + 0.0001…0.9999 USDT); no two waiting invoices share an amount;
 *  - the chain is read every 30 s (TronGrid, confirmed transfers only, to our address, after the invoice was made);
 *  - a transfer with exactly that amount pays that invoice; its tx hash is stored and can never pay twice;
 *  - an invoice lives 60 minutes;
 *  - any other transfer (wrong amount — e.g. an exchange took its fee out of it — or too late) is kept as
 *    «unmatched» for the owner to assign by hand. It is never matched automatically: the chain is public, so
 *    "I paid, here is the TxID" alone would let anyone claim someone else's transfer.
 */
import { one, q } from "../db";
import { notify } from "../telegram/notify";
import { BOTS, botOf, isProduct, price, type Months, type Product } from "./products";
import { grantAccess, botConfigured } from "./botsApi";

export const USDT_TRC20 = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
export const INVOICE_MIN = 60;
export const wallet = () => process.env.PAY_TRC20_ADDRESS?.trim() || "";
export const toMicro = (usdt: number) => Math.round(usdt * 1_000_000);
export const fromMicro = (m: number | string) => Number(m) / 1_000_000;

export type Item = { product: Product; months: Months };

/** Creates an invoice with a unique amount (retries on the rare collision). */
export async function createInvoice(userId: number, items: Item[]): Promise<{ id: number; amount: number; address: string; expiresAt: string }> {
  if (!wallet()) throw Object.assign(new Error("payments_not_configured"), { code: "payments_not_configured" });
  if (!items.length || items.some((i) => !isProduct(i.product))) throw Object.assign(new Error("bad_items"), { code: "bad_items" });
  // One waiting invoice per user: a new one replaces the old.
  await q("UPDATE vk_invoices SET status = 'cancelled' WHERE user_id = $1 AND status = 'pending'", [userId]);
  const base = items.reduce((s, i) => s + price(i.product, i.months), 0);
  for (let attempt = 0; attempt < 20; attempt++) {
    const tail = 1 + Math.floor(Math.random() * 9999); // 0.0001 … 0.9999
    const amountMicro = toMicro(base) + tail * 100;
    try {
      const row = await one<{ id: number; expires_at: Date }>(
        `INSERT INTO vk_invoices (user_id, items, amount_micro, expires_at) VALUES ($1, $2, $3, now() + make_interval(mins => $4)) RETURNING id, expires_at`,
        [userId, JSON.stringify(items), amountMicro, INVOICE_MIN]);
      return { id: row!.id, amount: fromMicro(amountMicro), address: wallet(), expiresAt: new Date(row!.expires_at).toISOString() };
    } catch (e: any) {
      if (e?.code !== "23505") throw e; // unique violation → another tail
    }
  }
  throw new Error("could_not_allocate_amount");
}

type Transfer = { txHash: string; from: string; to: string; amountMicro: number; at: number };

/** Confirmed incoming USDT transfers to the wallet since `since` (ms). */
export async function fetchTransfers(since: number, f: typeof fetch = fetch): Promise<Transfer[]> {
  const out: Transfer[] = [];
  let url = `https://api.trongrid.io/v1/accounts/${wallet()}/transactions/trc20?only_to=true&only_confirmed=true&limit=200&contract_address=${USDT_TRC20}&min_timestamp=${since}`;
  const headers: Record<string, string> = {};
  if (process.env.TRONGRID_API_KEY) headers["TRON-PRO-API-KEY"] = process.env.TRONGRID_API_KEY.trim();
  for (let page = 0; page < 10 && url; page++) {
    const res = await f(url, { headers, signal: AbortSignal.timeout(15_000) } as any);
    if (!res.ok) throw new Error(`TronGrid HTTP ${res.status}`);
    const body: any = await res.json();
    for (const t of body.data ?? []) {
      if (t.token_info?.address !== USDT_TRC20 || t.to !== wallet()) continue;
      out.push({ txHash: t.transaction_id, from: t.from, to: t.to, amountMicro: Number(t.value), at: Number(t.block_timestamp) });
    }
    url = body.meta?.links?.next ?? "";
  }
  return out;
}

/** One pass: expire old invoices, read the chain, match exact amounts, keep the rest as unmatched. */
export async function checkPayments(f: typeof fetch = fetch): Promise<{ matched: number; unmatched: number }> {
  if (!wallet()) return { matched: 0, unmatched: 0 };
  await q("UPDATE vk_invoices SET status = 'expired' WHERE status = 'pending' AND expires_at < now() - interval '10 minutes'");
  const since = await one<{ t: Date | null }>("SELECT min(created_at) AS t FROM vk_invoices WHERE status = 'pending'");
  const last = await one<{ t: Date | null }>("SELECT max(at) AS t FROM vk_incoming");
  // From the oldest waiting invoice, but never re-read more than 2 days back.
  const from = Math.max(Date.now() - 2 * 86_400_000, Math.min(since?.t ? new Date(since.t).getTime() : Date.now(), last?.t ? new Date(last.t).getTime() : Date.now() - 3_600_000) - 60_000);
  const transfers = await fetchTransfers(from, f);
  let matched = 0, unmatched = 0;
  for (const t of transfers) {
    const known = await one("SELECT 1 FROM vk_incoming WHERE tx_hash = $1", [t.txHash]);
    if (known) continue;
    // Exact amount, made before the transfer, transfer within the invoice life (+10 min of chain delay).
    const inv = await one<{ id: number }>(
      `SELECT id FROM vk_invoices WHERE status = 'pending' AND amount_micro = $1
         AND created_at <= to_timestamp($2 / 1000.0) AND expires_at + interval '10 minutes' >= to_timestamp($2 / 1000.0)`, [t.amountMicro, t.at]);
    await q(`INSERT INTO vk_incoming (tx_hash, from_address, amount_micro, at, invoice_id, status) VALUES ($1, $2, $3, to_timestamp($4 / 1000.0), $5, $6)`,
      [t.txHash, t.from, t.amountMicro, t.at, inv?.id ?? null, inv ? "matched" : "unmatched"]);
    if (inv) { await markPaid(inv.id, t.txHash, t.from); matched++; }
    else {
      unmatched++;
      await notifyAdmins(`💰 Неопознанный платёж ${fromMicro(t.amountMicro)} USDT от ${t.from} (tx ${t.txHash.slice(0, 10)}…). Привяжите его к счёту в «Пользователи → Платежи».`,
        `💰 Unmatched payment ${fromMicro(t.amountMicro)} USDT from ${t.from} (tx ${t.txHash.slice(0, 10)}…). Assign it in Users → Payments.`);
    }
  }
  return { matched, unmatched };
}

async function notifyAdmins(ru: string, en: string) {
  const emails = (process.env.VEKTOR_ADMIN_EMAILS ?? "").toLowerCase().split(",").map((x) => x.trim()).filter(Boolean);
  if (!emails.length) return;
  const admins = await q<{ id: number }>("SELECT id FROM vk_users WHERE lower(email) = ANY($1)", [emails]);
  for (const a of admins) await notify(a.id, "security", { ru, en }).catch(() => undefined);
}

/** Paid: extend every bought product from what is left (or from now), then open bot access. */
export async function markPaid(invoiceId: number, txHash: string | null, from: string | null) {
  const inv = await one<{ id: number; user_id: number; items: Array<{ product: Product; months: Months }>; status: string; amount_micro: string }>(
    "UPDATE vk_invoices SET status = 'paid', tx_hash = $2, from_address = $3, paid_at = now() WHERE id = $1 AND status IN ('pending', 'expired', 'cancelled') RETURNING *",
    [invoiceId, txHash, from]);
  if (!inv) return;
  const lines: string[] = [];
  for (const it of inv.items) {
    const row = await one<{ until: Date }>(
      `INSERT INTO vk_entitlements (user_id, product, until) VALUES ($1, $2, now() + make_interval(months => $3))
       ON CONFLICT (user_id, product) DO UPDATE SET until = GREATEST(vk_entitlements.until, now()) + make_interval(months => $3), granted_remote = false, updated_at = now()
       RETURNING until`, [inv.user_id, it.product, it.months]);
    if (it.product === "terminal") {
      await q("UPDATE vk_users SET plan = 'pro', plan_until = $2, plan_notified = NULL WHERE id = $1", [inv.user_id, row!.until]);
    }
    lines.push(`${it.product === "terminal" ? "VECTOR" : `${BOTS[botOf(it.product)!].name}${it.product.endsWith(":auto") ? " — автоторговля" : ""}`} до ${new Date(row!.until).toLocaleDateString("ru-RU")}`);
  }
  await notify(inv.user_id, "subscription", { ru: `✅ Оплата ${fromMicro(inv.amount_micro)} USDT получена.\n${lines.join("\n")}`, en: `✅ Payment of ${fromMicro(inv.amount_micro)} USDT received.\n${lines.join("\n")}` });
  const u = await one<{ email: string }>("SELECT email FROM vk_users WHERE id = $1", [inv.user_id]);
  await notifyAdmins(`💸 ${u?.email}: оплачено ${fromMicro(inv.amount_micro)} USDT — ${lines.join("; ")}`, `💸 ${u?.email}: paid ${fromMicro(inv.amount_micro)} USDT — ${lines.join("; ")}`);
  await pushGrants(inv.user_id);
}

/**
 * Opens bot access (signals) in the bots for what the user bought. Autotrading does not include access:
 * it is sold on top of access bought here or directly in the bot.
 * Needs the user's Telegram ID; retried every pass until the bot confirms.
 */
export async function pushGrants(userId?: number) {
  const rows = await q<{ user_id: number; product: Product; until: Date; chat_id: string | null }>(
    `SELECT e.user_id, e.product, e.until, l.chat_id FROM vk_entitlements e LEFT JOIN vk_telegram_links l ON l.user_id = e.user_id
     WHERE e.product LIKE 'bot:%:access' AND NOT e.granted_remote AND e.until > now() AND ($1::bigint IS NULL OR e.user_id = $1)`, [userId ?? null]);
  for (const r of rows) {
    const bot = botOf(r.product)!;
    if (!r.chat_id || !botConfigured(bot)) continue;
    try {
      await grantAccess(bot, r.chat_id, new Date(r.until), `vector:${r.user_id}:${r.product}`);
      await q("UPDATE vk_entitlements SET granted_remote = true WHERE user_id = $1 AND product = $2", [r.user_id, r.product]);
    } catch (e) { console.error("[grant]", bot, (e as Error).message); }
  }
}

export function startPaymentLoop() {
  const tick = async () => {
    try { await checkPayments(); } catch (e) { console.error("[pay]", (e as Error).message); }
    try { await pushGrants(); } catch (e) { console.error("[grant]", (e as Error).message); }
  };
  setInterval(() => void tick(), 30_000).unref();
}

/** Is the product active for the user (bought in VECTOR)? */
export async function hasEntitlement(userId: number, product: Product): Promise<Date | null> {
  const r = await one<{ until: Date }>("SELECT until FROM vk_entitlements WHERE user_id = $1 AND product = $2 AND until > now()", [userId, product]);
  return r ? new Date(r.until) : null;
}

export { price };
