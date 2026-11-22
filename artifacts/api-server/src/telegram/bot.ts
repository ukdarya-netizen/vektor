/**
 * Telegram bot updates: /start <token> links the chat to the account (deep link from
 * Settings → Notifications), /stop unlinks. Long polling runs only where TELEGRAM_POLLING=1
 * (set it in the published deployment only — two pollers on one token steal each other's updates).
 */
import { one, q } from "../db";
import { keyedHash, randomToken } from "../crypto";
import { enqueue } from "./outbox";
import { T } from "./texts";

const token = () => process.env.TELEGRAM_BOT_TOKEN?.trim() || "";
export const botUsername = () => process.env.TELEGRAM_BOT_USERNAME?.trim().replace(/^@/, "") || "";
const LINK_TTL_MIN = 15;

/** One-time link for the «Подключить Telegram» button. */
export async function createLink(userId: number): Promise<{ url: string; expiresInMin: number } | null> {
  if (!token() || !botUsername()) return null;
  const t = randomToken(24);
  await q("DELETE FROM vk_telegram_link_tokens WHERE user_id = $1 OR expires_at < now()", [userId]);
  await q("INSERT INTO vk_telegram_link_tokens (token_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(mins => $3))",
    [keyedHash(`tg:${t}`), userId, LINK_TTL_MIN]);
  return { url: `https://t.me/${botUsername()}?start=${t}`, expiresInMin: LINK_TTL_MIN };
}

type Msg = { text?: string; caption?: string; chat: { id: number; type: string; title?: string }; from?: { username?: string; language_code?: string } };
type Update = { update_id: number; message?: Msg; channel_post?: Msg };

/** A post in a channel/group: a link code, or a signal for every bot linked to this chat. */
async function handleChatPost(m: Msg): Promise<void> {
  const text = (m.text ?? m.caption ?? "").trim();
  if (!text) return;
  const chat = String(m.chat.id);
  const code = text.match(/^vektor-([A-Z0-9]{6})$/i);
  if (code) {
    const row = await one<{ bot_id: number }>("DELETE FROM vk_channel_link_codes WHERE code = $1 AND expires_at > now() RETURNING bot_id", [code[1].toUpperCase()]);
    if (!row) return;
    await q("INSERT INTO vk_bot_channels (chat_id, bot_id, title) VALUES ($1, $2, $3) ON CONFLICT (chat_id, bot_id) DO UPDATE SET title = EXCLUDED.title", [chat, row.bot_id, m.chat.title ?? null]);
    const owner = await one<{ user_id: number; name: string }>("SELECT user_id, name FROM vk_bots WHERE id = $1", [row.bot_id]);
    if (owner) {
      const l = await one<{ chat_id: string; lang: string }>("SELECT l.chat_id, u.lang FROM vk_telegram_links l JOIN vk_users u ON u.id = l.user_id WHERE l.user_id = $1", [owner.user_id]);
      if (l) await enqueue(owner.user_id, l.chat_id, "linked", l.lang === "en" ? `✅ Bot ${owner.name} now reads signals from «${m.chat.title ?? chat}».` : `✅ Бот ${owner.name} теперь читает сигналы из «${m.chat.title ?? chat}».`);
    }
    return;
  }
  const bots = await q("SELECT b.* FROM vk_bots b JOIN vk_bot_channels c ON c.bot_id = b.id WHERE c.chat_id = $1", [chat]);
  if (!bots.length) return;
  const { botSettingsSchema, enqueueSignal, processSignal, receive } = await import("../signals/process");
  for (const bot of bots) {
    bot.settings = botSettingsSchema.parse(bot.settings);
    const r = await receive(bot, text);
    // Posts that are not signals (news, chatter) are recorded as rejected and nothing else happens.
    if (r.duplicate || !r.parsed) continue;
    void enqueueSignal(bot.id, () => processSignal(bot, r.id!, r.parsed!)).catch((e) => console.error("[signal]", e));
  }
}

export async function handleUpdate(u: Update): Promise<void> {
  if (u.channel_post) { await handleChatPost(u.channel_post); return; }
  const m = u.message;
  if (m && m.chat.type !== "private") { await handleChatPost(m); return; }
  if (!m?.text) return;
  const chat = String(m.chat.id);
  const lang = m.from?.language_code?.startsWith("ru") ? "ru" : "en";
  const [cmd, arg] = m.text.trim().split(/\s+/, 2);
  if (cmd === "/start") {
    if (!arg) { await enqueue(null, chat, "bot", T.startNoToken[lang]); return; }
    const row = await one<{ user_id: number }>(
      "DELETE FROM vk_telegram_link_tokens WHERE token_hash = $1 AND expires_at > now() RETURNING user_id", [keyedHash(`tg:${arg}`)]);
    if (!row) { await enqueue(null, chat, "bot", T.linkExpired[lang]); return; }
    // One chat — one account; a chat linked elsewhere moves to this account.
    await q("DELETE FROM vk_telegram_links WHERE chat_id = $1 AND user_id <> $2", [chat, row.user_id]);
    await q(`INSERT INTO vk_telegram_links (user_id, chat_id, username) VALUES ($1, $2, $3)
             ON CONFLICT (user_id) DO UPDATE SET chat_id = EXCLUDED.chat_id, username = EXCLUDED.username, linked_at = now()`,
      [row.user_id, chat, m.from?.username ?? null]);
    const u2 = await one<{ email: string; lang: string }>("SELECT email, lang FROM vk_users WHERE id = $1", [row.user_id]);
    await enqueue(row.user_id, chat, "linked", T.linked(u2?.email ?? "")[u2?.lang === "en" ? "en" : "ru"]);
    return;
  }
  if (cmd === "/stop") {
    const r = await one<{ user_id: number }>("DELETE FROM vk_telegram_links WHERE chat_id = $1 RETURNING user_id", [chat]);
    if (r) await enqueue(null, chat, "bot", T.unlinked[lang]);
  }
}

let running = false;
export async function startPolling(): Promise<void> {
  if (running || !token() || process.env.TELEGRAM_POLLING !== "1") return;
  running = true;
  const offsetRow = await one<{ value: number }>("SELECT value FROM vk_kv WHERE key = 'tg_offset'");
  let offset = Number(offsetRow?.value ?? 0);
  console.log("[tg] polling started");
  for (;;) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token()}/getUpdates?timeout=30&offset=${offset}&allowed_updates=["message","channel_post"]`, {
        signal: AbortSignal.timeout(40_000),
      });
      const body = (await res.json()) as { ok: boolean; result?: Update[]; description?: string };
      if (!body.ok) { console.error("[tg] getUpdates", body.description); await new Promise((r) => setTimeout(r, 5_000)); continue; }
      for (const u of body.result ?? []) {
        await handleUpdate(u).catch((e) => console.error("[tg] update", e));
        offset = u.update_id + 1;
        await q("INSERT INTO vk_kv (key, value) VALUES ('tg_offset', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()", [JSON.stringify(offset)]);
      }
    } catch (e) {
      console.error("[tg] polling", e instanceof Error ? e.message : e);
      await new Promise((r) => setTimeout(r, 3_000));
    }
  }
}
