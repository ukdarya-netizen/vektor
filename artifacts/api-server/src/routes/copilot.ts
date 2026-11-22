/**
 * AI copilot: turns a text (or dictated) command into ONE draft action. It never executes anything —
 * the terminal shows the draft in words and the user confirms. Missing size is never invented:
 * the model must ask instead. Uses the Anthropic Messages API (ANTHROPIC_API_KEY).
 */
import { Router } from "express";
import { z } from "zod";
import { one, q } from "../db";
import { marketsCached } from "../exchanges/execute";
import { snapshot } from "../exchanges/snapshot";
import type { AccountRow } from "../exchanges/client";
import { matchSymbol } from "../signals/parse";
import { limitsOf } from "../engine/risk";
import { requireUser, userOf } from "./auth";
import { effectivePlan } from "../engine/plans";

export const copilotRouter = Router();
copilotRouter.use(requireUser);

const level = { type: "object", properties: { pct: { type: "number", description: "% from entry" }, price: { type: "number" } } };
export const TOOLS = [
  {
    name: "open_position",
    description: "Open a position. Only when the user gave the size (USDT margin or % of balance). Coin as written by the user (e.g. SOL, BTC).",
    input_schema: {
      type: "object", required: ["accountId", "coin", "side"],
      properties: {
        accountId: { type: "integer" }, coin: { type: "string" }, side: { type: "string", enum: ["long", "short"] },
        amountUsdt: { type: "number", description: "margin in USDT" }, amountPct: { type: "number", description: "% of free balance" },
        leverage: { type: "integer" }, orderType: { type: "string", enum: ["market", "limit"] }, limitPrice: { type: "number" },
        stop: level, takes: { type: "array", items: { type: "object", properties: { pct: { type: "number" }, price: { type: "number" }, closePct: { type: "number" } } } },
        breakevenAfterTp1: { type: "boolean" }, trailing: { type: "object", properties: { activationPct: { type: "number" }, callbackPct: { type: "number" } } },
      },
    },
  },
  {
    name: "close_position",
    description: "Close an open position (all or a percent).",
    input_schema: { type: "object", required: ["accountId", "coin"], properties: { accountId: { type: "integer" }, coin: { type: "string" }, side: { type: "string", enum: ["long", "short"] }, percent: { type: "number" } } },
  },
  {
    name: "move_stop",
    description: "Move the stop of a managed position to a price, or to break-even.",
    input_schema: { type: "object", required: ["positionId"], properties: { positionId: { type: "integer" }, price: { type: "number" }, breakeven: { type: "boolean" } } },
  },
  {
    name: "set_kill_switch",
    description: "Turn the kill switch (block all new entries) on or off.",
    input_schema: { type: "object", required: ["on"], properties: { on: { type: "boolean" } } },
  },
  {
    name: "answer",
    description: "Answer a question about the user's accounts, positions or the terminal, or ask for what is missing (e.g. the size). Plain text, short.",
    input_schema: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
  },
];

const SYSTEM = (lang: string, ctx: string) => `You are the copilot of the Vektor crypto trading terminal. Turn the user's message into exactly ONE tool call.
Rules:
- Never invent a position size, a coin or an account. If the size is missing, call "answer" and ask for it.
- If several accounts fit and the user did not say which, use the one marked "selected"; if none is selected, ask.
- Percent values stay percents (stop 2% → stop.pct = 2). "Take 4%" without a share → closePct 100.
- You do not give trading advice or predictions; for such questions answer that you only execute and explain.
- Answer in ${lang === "en" ? "English" : "Russian"}.
Current state (JSON):
${ctx}`;

export type Fetcher = (url: string, init: any) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>;

export async function askModel(text: string, ctx: string, lang: string, f: Fetcher = fetch as any): Promise<{ name: string; input: any }> {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) throw Object.assign(new Error("copilot_not_configured"), { code: "copilot_not_configured" });
  const res = await f("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL?.trim() || "claude-haiku-5-5", max_tokens: 700,
      system: SYSTEM(lang, ctx), tools: TOOLS, tool_choice: { type: "any" },
      messages: [{ role: "user", content: text.slice(0, 2000) }],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.json();
  if (!res.ok) throw Object.assign(new Error(body?.error?.message ?? `HTTP ${res.status}`), { code: "copilot_error" });
  const call = (body.content ?? []).find((c: any) => c.type === "tool_use");
  if (!call) throw Object.assign(new Error("no tool call"), { code: "copilot_error" });
  return { name: call.name, input: call.input ?? {} };
}

copilotRouter.post("/", async (req, res) => {
  const user = userOf(req);
  const b = z.object({ text: z.string().trim().min(1).max(2000), accountId: z.number().int().nullable().optional(), symbol: z.string().nullable().optional() }).safeParse(req.body);
  if (!b.success) { res.status(400).json({ error: "bad_request" }); return; }
  if (!(await effectivePlan(user.id)).limits.copilot) { res.status(402).json({ error: "plan_limit", key: "copilot" }); return; }

  // What the model may know: the user's own accounts, positions, managed stops, limits. No keys.
  const accounts = await q<AccountRow & { label: string; status: string }>("SELECT * FROM vk_exchange_accounts WHERE user_id = $1 AND status <> 'paused' ORDER BY id", [user.id]);
  const snaps = await Promise.all(accounts.map((a) => snapshot(a).catch(() => null)));
  const managed = await q("SELECT id, account_id, symbol, side, entry_price, stop_price, stop_kind FROM vk_positions WHERE user_id = $1 AND status = 'open'", [user.id]);
  const ctx = JSON.stringify({
    accounts: accounts.map((a, i) => ({
      id: a.id, label: a.label, market: a.market, env: a.env, selected: a.id === b.data.accountId,
      freeUsdt: snaps[i]?.balances.find((x) => x.asset === "USDT")?.free ?? null,
      positions: snaps[i]?.positions.map((p) => ({ coin: p.coin, side: p.side, size: p.size, entry: p.entryPrice, pnl: p.unrealizedPnl, leverage: p.leverage })) ?? [],
    })),
    managed: managed.map((m) => ({ positionId: m.id, accountId: m.account_id, coin: String(m.symbol).split("/")[0], side: m.side, entry: Number(m.entry_price), stop: m.stop_price ? Number(m.stop_price) : null, stopKind: m.stop_kind })),
    selectedCoin: b.data.symbol ? b.data.symbol.split("/")[0] : null,
    riskLimits: await limitsOf(user.id),
  });

  let call: { name: string; input: any };
  try { call = await askModel(b.data.text, ctx, user.lang); }
  catch (e: any) { res.status(e?.code === "copilot_not_configured" ? 503 : 502).json({ error: e?.code ?? "copilot_error", message: e?.message }); return; }

  // Check the draft against reality: the account is the user's, the coin exists there.
  const draft: any = { tool: call.name, input: call.input };
  if (call.name === "open_position" || call.name === "close_position") {
    const a = accounts.find((x) => x.id === Number(call.input.accountId));
    if (!a) { res.json({ draft: { tool: "answer", input: { text: user.lang === "en" ? "Which account?" : "На каком счёте?" } } }); return; }
    const symbol = matchSymbol(String(call.input.coin ?? ""), await marketsCached(a).catch(() => []));
    if (!symbol) { res.json({ draft: { tool: "answer", input: { text: user.lang === "en" ? `No ${call.input.coin} on ${a.label}.` : `Монеты ${call.input.coin} нет на ${a.label}.` } } }); return; }
    draft.input = { ...call.input, symbol, accountLabel: a.label, market: a.market };
    if (call.name === "open_position" && !(call.input.amountUsdt > 0) && !(call.input.amountPct > 0)) {
      res.json({ draft: { tool: "answer", input: { text: user.lang === "en" ? "What size? (USDT margin or % of balance)" : "На какую сумму? (маржа в USDT или % баланса)" } } }); return;
    }
  }
  if (call.name === "move_stop" && !(await one("SELECT 1 FROM vk_positions WHERE id = $1 AND user_id = $2 AND status = 'open'", [Number(call.input.positionId), user.id]))) {
    res.json({ draft: { tool: "answer", input: { text: user.lang === "en" ? "No such managed position." : "Такой позиции под ведением нет." } } }); return;
  }
  res.json({ draft });
});
