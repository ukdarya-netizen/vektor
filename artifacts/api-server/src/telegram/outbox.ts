/**
 * Telegram delivery (from Lucy's Trading Bot executor/telegram.ts): every message is stored
 * first, then one pump sends them oldest first — at most one per TELEGRAM_GAP_MS per chat and
 * GLOBAL_GAP_MS overall, waits Telegram's retry_after on 429, retries network errors.
 * A message is never dropped silently; a final refusal is kept with Telegram's answer.
 */
import { one, q } from "../db";

export const TELEGRAM_GAP_MS = 1_100;
const GLOBAL_GAP_MS = 40;
const MAX_REFUSALS = 5;
export const MAX_LEN = 4096;

const token = () => process.env.TELEGRAM_BOT_TOKEN?.trim() || "";

export type PostResult = { ok: true } | { ok: false; status: number; retryAfterS: number | null; description: string };
export type Post = (chat: string, text: string) => Promise<PostResult>;

export const telegramPost: Post = async (chat, text) => {
  const res = await fetch(`https://api.telegram.org/bot${token()}/sendMessage`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(10_000),
  });
  if (res.ok) return { ok: true };
  const body = (await res.json().catch(() => ({}))) as { description?: string; parameters?: { retry_after?: number } };
  return { ok: false, status: res.status, retryAfterS: body.parameters?.retry_after ?? null, description: String(body.description ?? `HTTP ${res.status}`).slice(0, 300) };
};

let poster: Post = telegramPost;
/** Tests: replace the Telegram call. */
export function setPoster(p: Post): void { poster = p; }

export async function enqueue(userId: number | null, chatId: string, kind: string, text: string): Promise<void> {
  const body = text.length > MAX_LEN ? `${text.slice(0, MAX_LEN - 1)}…` : text;
  await q("INSERT INTO vk_tg_outbox (user_id, chat_id, kind, text) VALUES ($1, $2, $3, $4)", [userId, chatId, kind, body]);
  void pump().catch((e) => console.error("[tg] pump", e));
}

let pumping = false;
let again = false;
let timer: NodeJS.Timeout | null = null;
const lastSentToChat = new Map<string, number>();

export async function pump(post?: Post, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<void> {
  if (!token()) return;
  if (pumping) { again = true; return; }
  pumping = true;
  try {
    do {
      again = false;
      for (;;) {
        // Oldest due message whose chat is not inside its per-chat gap.
        const due = await q<{ id: number; chat_id: string; text: string; attempts: number }>(
          `SELECT id, chat_id, text, attempts FROM vk_tg_outbox
           WHERE sent_at IS NULL AND failed_at IS NULL AND next_at <= now() ORDER BY id LIMIT 50`);
        const nowMs = Date.now();
        // Keep per-chat order: only the first pending message of each chat is eligible.
        const seen = new Set<string>();
        const m = due.find((d) => {
          if (seen.has(d.chat_id)) return false;
          seen.add(d.chat_id);
          return nowMs - (lastSentToChat.get(d.chat_id) ?? 0) >= TELEGRAM_GAP_MS;
        });
        if (!m) {
          if (due.length) { await sleep(200); continue; }
          break;
        }
        let out: PostResult;
        try { out = await (post ?? poster)(m.chat_id, m.text); } catch (e) {
          out = { ok: false, status: 0, retryAfterS: null, description: `network: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300) };
        }
        lastSentToChat.set(m.chat_id, Date.now());
        if (out.ok) {
          await q("UPDATE vk_tg_outbox SET sent_at = now(), attempts = attempts + 1 WHERE id = $1", [m.id]);
        } else if (out.status === 429 || out.status === 0 || out.status >= 500) {
          const waitS = out.retryAfterS !== null ? out.retryAfterS + 1 : Math.min(60, 2 * 2 ** Math.min(m.attempts, 5));
          // The whole chat waits, so later messages of the chat never overtake this one.
          await q(`UPDATE vk_tg_outbox SET attempts = attempts + CASE WHEN id = $1 THEN 1 ELSE 0 END,
                     last_error = CASE WHEN id = $1 THEN $2 ELSE last_error END,
                     next_at = GREATEST(next_at, now() + make_interval(secs => $3))
                   WHERE chat_id = $4 AND sent_at IS NULL AND failed_at IS NULL`, [m.id, out.description, waitS, m.chat_id]);
        } else {
          const final = m.attempts + 1 >= MAX_REFUSALS;
          await q(`UPDATE vk_tg_outbox SET attempts = attempts + 1, last_error = $2, next_at = now() + interval '30 seconds',
                     failed_at = CASE WHEN $3 THEN now() ELSE NULL END WHERE id = $1`, [m.id, out.description, final]);
        }
        await sleep(GLOBAL_GAP_MS);
      }
    } while (again);
  } finally {
    pumping = false;
    const next = await one<{ ms: number | null }>(
      "SELECT GREATEST(0, EXTRACT(EPOCH FROM (min(next_at) - now())) * 1000)::float8 AS ms FROM vk_tg_outbox WHERE sent_at IS NULL AND failed_at IS NULL",
    ).catch(() => null);
    if (timer) clearTimeout(timer);
    timer = next?.ms === null || next?.ms === undefined ? null : setTimeout(() => void pump().catch(() => undefined), Math.max(250, next.ms));
    timer?.unref?.();
  }
}

export function stopPump(): void { if (timer) clearTimeout(timer); timer = null; }

/** For Settings → Notifications: what waits and Telegram's last refusal for this user. */
export async function outboxStatus(userId: number) {
  const r = await one(
    `SELECT count(*) FILTER (WHERE sent_at IS NULL AND failed_at IS NULL)::int AS pending,
            count(*) FILTER (WHERE failed_at > now() - interval '7 days')::int AS failed,
            max(sent_at) AS last_sent_at
     FROM vk_tg_outbox WHERE user_id = $1 AND created_at > now() - interval '7 days'`, [userId]);
  const e = await one("SELECT last_error, created_at, text FROM vk_tg_outbox WHERE user_id = $1 AND failed_at IS NOT NULL ORDER BY id DESC LIMIT 1", [userId]);
  return { pending: r?.pending ?? 0, failed: r?.failed ?? 0, lastSentAt: r?.last_sent_at ?? null, lastFailure: e ? { error: e.last_error, at: e.created_at, text: String(e.text).slice(0, 200) } : null };
}
