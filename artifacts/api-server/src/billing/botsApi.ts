/**
 * VECTOR ↔ signal bots. Every request is signed both ways with HMAC-SHA256 over "<timestamp>.<body>"
 * using VECTOR_BOTS_SECRET (the same secret is set in each bot). Requests older than 5 minutes are refused.
 * Bot base URLs: BOT_CAB_URL, BOT_NIHILIST_URL, BOT_BMM_URL. Contract: docs/bots-integration.md.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { BOTS, type BotKey } from "./products";

const secret = () => process.env.VECTOR_BOTS_SECRET?.trim() || "";
export const botUrl = (k: BotKey) => process.env[`BOT_${BOTS[k].env}_URL`]?.trim().replace(/\/$/, "") || "";
export const botConfigured = (k: BotKey) => Boolean(secret() && botUrl(k));

export const sign = (ts: string, body: string) => createHmac("sha256", secret()).update(`${ts}.${body}`).digest("hex");

/** For requests coming FROM a bot (signals). */
export function verify(ts: string | undefined, sig: string | undefined, body: string): boolean {
  if (!secret() || !ts || !sig || Math.abs(Date.now() - Number(ts)) > 5 * 60_000) return false;
  const exp = Buffer.from(sign(ts, body), "hex");
  const got = Buffer.from(sig, "hex");
  return exp.length === got.length && timingSafeEqual(exp, got);
}

async function call<T>(k: BotKey, method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  if (!botConfigured(k)) throw new Error("bot_not_configured");
  const ts = String(Date.now());
  const raw = body === undefined ? "" : JSON.stringify(body);
  const res = await fetch(`${botUrl(k)}${path}`, {
    method, body: method === "POST" ? raw : undefined,
    headers: { "content-type": "application/json", "x-vector-timestamp": ts, "x-vector-signature": sign(ts, method === "POST" ? raw : path) },
    signal: AbortSignal.timeout(15_000),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`bot ${k} HTTP ${res.status}: ${JSON.stringify(out).slice(0, 200)}`);
  return out as T;
}

/** Open access in the bot for this Telegram user until the date (same as the owner's «Одобрить»). */
export const grantAccess = (k: BotKey, telegramId: string, until: Date, ref: string) =>
  call<{ ok: boolean }>(k, "POST", "/api/vector/grant", { telegramId, until: until.toISOString(), ref });

/** Does this Telegram user already have a subscription in the bot (bought directly)? */
const accessCache = new Map<string, { at: number; v: { active: boolean; until: string | null } }>();
export async function checkAccess(k: BotKey, telegramId: string): Promise<{ active: boolean; until: string | null }> {
  const key = `${k}:${telegramId}`;
  const c = accessCache.get(key);
  if (c && Date.now() - c.at < 10 * 60_000) return c.v;
  const v = await call<{ active: boolean; until: string | null }>(k, "GET", `/api/vector/access?telegramId=${encodeURIComponent(telegramId)}`);
  accessCache.set(key, { at: Date.now(), v });
  return v;
}

export type BotStats = { periods: Array<{ key: "1m" | "6m" | "12m"; from: string; to: string; signals: number; winRatePct: number | null; pnlPct: number | null }>; updatedAt: string };
const statsCache = new Map<BotKey, { at: number; data: BotStats | null }>();
/** Short public stats (closed trades only). Cached for an hour; null when the bot is not connected yet. */
export async function botStats(k: BotKey): Promise<BotStats | null> {
  const c = statsCache.get(k);
  if (c && Date.now() - c.at < 3_600_000) return c.data;
  let data: BotStats | null = null;
  try { data = await call<BotStats>(k, "GET", "/api/vector/stats"); } catch { data = c?.data ?? null; }
  statsCache.set(k, { at: Date.now(), data });
  return data;
}
