/**
 * Needs a throwaway database: DATABASE_URL, VEKTOR_SESSION_SECRET. Never run against production.
 * Telegram is faked — nothing is sent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { migrate, one, q, pool } from "../db";
import { closeLine, resultLine, stopCloseKey, T } from "./texts";
import { inQuietHours, notify } from "./notify";
import { pump, setPoster, stopPump, type Post } from "./outbox";
import { createLink, handleUpdate } from "./bot";

process.env.TELEGRAM_BOT_TOKEN ||= "test-token";
process.env.TELEGRAM_BOT_USERNAME ||= "vektor_test_bot";

test("close naming: trailed stop in profit is never a stop-loss", () => {
  assert.equal(stopCloseKey("trailing", 2.5), "stop_trailing_profit");
  assert.equal(stopCloseKey("trailing", -1), "stop_trailing_loss");
  assert.equal(stopCloseKey("initial", -1.2), "stop_loss");
  assert.equal(stopCloseKey("breakeven", 0.1), "stop_breakeven");
  assert.equal(stopCloseKey("breakeven", 0.6), "stop_breakeven_plus");
  assert.match(closeLine("signal_cancel", { source: "TradingView" }).ru, /отменил сигнал/);
  assert.match(resultLine(-1.5, -3.2, "USDT", 0.1).ru, /^Итог в минусе: −1\.50% цены · −3\.20 USDT чистыми \(комиссии 0\.10\)$/);
});

test("quiet hours across midnight", () => {
  const at = (h: number) => new Date(Date.UTC(2026, 0, 1, h, 30));
  assert.equal(inQuietHours(at(23), "UTC", 23, 7), true);
  assert.equal(inQuietHours(at(3), "UTC", 23, 7), true);
  assert.equal(inQuietHours(at(12), "UTC", 23, 7), false);
  assert.equal(inQuietHours(at(12), "UTC", null, null), false);
});

test("link by deep link, notify, deliver in order, respect groups and 429", async () => {
  await migrate();
  const sent: string[] = [];
  let first429 = true;
  let chat = "";
  const fake: Post = async (c, text) => {
    if (c !== chat) return { ok: true };
    if (first429 && text.startsWith("⚠️")) { first429 = false; return { ok: false, status: 429, retryAfterS: 0, description: "Too Many Requests" }; }
    sent.push(text);
    return { ok: true };
  };
  setPoster(fake);
  const u = (await one<{ id: number }>("INSERT INTO vk_users (email) VALUES ($1) RETURNING id", [`t${Date.now()}@x.io`]))!;
  const link = await createLink(u.id);
  assert.ok(link);
  const startArg = link!.url.split("start=")[1];
  chat = String(900000 + (u.id % 1000));

  // Wrong token → no link.
  await handleUpdate({ update_id: 1, message: { text: "/start nope", chat: { id: Number(chat), type: "private" } } });
  assert.equal(await one("SELECT 1 FROM vk_telegram_links WHERE user_id = $1", [u.id]), null);
  // Right token → linked, and the token is single-use.
  await handleUpdate({ update_id: 2, message: { text: `/start ${startArg}`, chat: { id: Number(chat), type: "private" }, from: { username: "tester" } } });
  assert.ok(await one("SELECT 1 FROM vk_telegram_links WHERE user_id = $1 AND chat_id = $2", [u.id, chat]));

  // Group switched off → not queued; critical → queued anyway.
  await q("INSERT INTO vk_notification_settings (user_id, groups) VALUES ($1, '{\"trades\": false}')", [u.id]);
  assert.equal(await notify(u.id, "opened", T.notOpened("X · BTC · Acc", "no_funds")), false);
  assert.equal(await notify(u.id, "exchange_problem", T.exchangeProblem("Bybit Futures", "auth")), true);
  assert.equal(await notify(u.id, "not_opened", T.notOpened("TradingView · SOL · Bybit", "no_funds")), true);

  for (let i = 0; i < 6 && sent.length < 4; i++) {
    await pump();
    await new Promise((r) => setTimeout(r, 1_200));
  }
  stopPump();
  // «link expired» for the bad token, linked confirmation, the exchange warning (after its 429), not-opened — in order.
  assert.equal(sent.length, 4);
  assert.match(sent[0], /link has expired/);
  assert.match(sent[1], /Telegram подключён/);
  assert.match(sent[2], /ключ API не принимается/);
  assert.match(sent[3], /Позиция не открыта\.\nПричина: не хватает свободной маржи/);

  await q("DELETE FROM vk_users WHERE id = $1", [u.id]);
});

test("channel post: link code binds the chat, later posts become signals", async () => {
  const u = (await one<{ id: number }>("INSERT INTO vk_users (email) VALUES ($1) RETURNING id", [`c${Date.now()}@x.io`]))!;
  const a = (await one("INSERT INTO vk_exchange_accounts (user_id, exchange, label, market, env, credentials_enc, key_hint, withdraw_check) VALUES ($1,'bybit','B','swap','paper','x','x','verified_off') RETURNING id", [u.id]))!;
  const bot = (await one("INSERT INTO vk_bots (user_id, account_id, name, token_hash, token_hint, settings) VALUES ($1,$2,'Chan',$3,'x',$4) RETURNING id",
    [u.id, a.id, `h${Date.now()}`, JSON.stringify({ amount: 10, plan: { stop: { mode: "pct", value: 2 } } })]))!;
  await q("INSERT INTO vk_channel_link_codes (code, bot_id, expires_at) VALUES ('ABC123', $1, now() + interval '5 minutes')", [bot.id]);
  const chat = -100777000 - (u.id % 1000);
  await handleUpdate({ update_id: 10, channel_post: { text: "vektor-abc123", chat: { id: chat, type: "channel", title: "Signals VIP" } } } as any);
  assert.ok(await one("SELECT 1 FROM vk_bot_channels WHERE chat_id = $1 AND bot_id = $2", [String(chat), bot.id]));
  await handleUpdate({ update_id: 11, channel_post: { text: "🟢 #BTC LONG\nTP1 70000\nSL 60000", chat: { id: chat, type: "channel" } } } as any);
  await handleUpdate({ update_id: 12, channel_post: { text: "Всем хорошего дня!", chat: { id: chat, type: "channel" } } } as any);
  const sigs = await q("SELECT raw, status, reason FROM vk_signals WHERE bot_id = $1 ORDER BY id", [bot.id]);
  assert.equal(sigs.length, 2);
  assert.match(sigs[0].raw, /#BTC LONG/);
  assert.equal(sigs[1].status, "rejected");
  await q("DELETE FROM vk_users WHERE id = $1", [u.id]);
  await pool.end();
});
