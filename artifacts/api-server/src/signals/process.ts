/**
 * One signal, start to end. Every outcome is written to vk_signals with a reason the UI and
 * Telegram can explain. Signals of one bot are handled one at a time, in arrival order.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { one, q } from "../db";
import { clientFor, exchangeError, type AccountRow } from "../exchanges/client";
import { closePosition, marketsCached, openEntry } from "../exchanges/execute";
import { planSchema, type Plan } from "../engine/plan";
import { notify } from "../telegram/notify";
import { NOT_OPENED, T, head } from "../telegram/texts";
import { matchSymbol, parseSignal, type Parsed } from "./parse";

export const botSettingsSchema = z.object({
  amountMode: z.enum(["usdt", "percent"]).default("usdt"),
  amount: z.number().positive(),
  leverage: z.number().int().min(1).max(250).default(10),
  marginMode: z.enum(["isolated", "cross"]).default("isolated"),
  plan: planSchema,
  allowLong: z.boolean().default(true),
  allowShort: z.boolean().default(true),
  /** A signal against an open opposite position: skip it, only close the old one, or close and open (reverse). */
  onOpposite: z.enum(["skip", "close", "reverse"]).default("skip"),
  /** A signal in the same direction as an open position: skip, or add to it. */
  onSame: z.enum(["skip", "add"]).default("skip"),
  /** Older than this (by the signal's own time) → expired, not executed. */
  ttlSec: z.number().int().min(5).max(3600).default(60),
  /** Let the signal set amount / leverage / SL / TP. */
  allowOverrides: z.boolean().default(true),
});
export type BotSettings = z.infer<typeof botSettingsSchema>;

type Bot = { id: number; user_id: number; account_id: number; name: string; settings: BotSettings; enabled: boolean };

const chains = new Map<number, Promise<unknown>>();
/** Serializes signals per bot so two quick signals never race each other. */
export function enqueueSignal(botId: number, fn: () => Promise<unknown>): Promise<unknown> {
  const prev = chains.get(botId) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  chains.set(botId, next.catch(() => undefined));
  return next;
}

export function dedupKey(raw: string, p: Parsed | null, at: number): string {
  if (p?.id) return `id:${p.id}`;
  // No id: the same text within the same minute is one signal (TradingView retries).
  return `h:${createHash("sha256").update(raw).digest("hex").slice(0, 24)}:${Math.floor(at / 60_000)}`;
}

/** Records the signal (or reports a duplicate). Returns the row id to process. */
export async function receive(bot: Bot, raw: string, test = false): Promise<{ id: number | null; duplicate: boolean; parsed: Parsed | null; reason: string | null }> {
  const pr = parseSignal(raw);
  const parsed = pr.ok ? pr.signal : null;
  const row = await one<{ id: number }>(
    `INSERT INTO vk_signals (user_id, bot_id, dedup_key, raw, parsed, status, reason, test)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (bot_id, dedup_key) DO NOTHING RETURNING id`,
    [bot.user_id, bot.id, (test ? "test:" : "") + dedupKey(raw, parsed, Date.now()) + (test ? `:${Date.now()}` : ""), raw.slice(0, 8000),
      parsed ? JSON.stringify(parsed) : null, pr.ok ? "received" : "rejected", pr.ok ? null : `parse_error:${pr.reason}`, test]);
  return { id: row?.id ?? null, duplicate: !row, parsed, reason: pr.ok ? null : pr.reason };
}

async function done(id: number, status: string, reason: string | null, detail: Record<string, unknown> = {}, positionId: number | null = null) {
  await q("UPDATE vk_signals SET status = $2, reason = $3, detail = $4, position_id = COALESCE($5, position_id), done_at = now() WHERE id = $1",
    [id, status, reason, JSON.stringify(detail), positionId]);
}

/**
 * dryRun (the «Отправить тест» button): everything is checked and explained, nothing is sent.
 */
export async function processSignal(bot: Bot, signalId: number, p: Parsed, opts: { dryRun?: boolean } = {}): Promise<{ status: string; reason: string | null; detail?: unknown }> {
  const s = bot.settings;
  const a = await one<AccountRow & { status: string; label: string }>("SELECT * FROM vk_exchange_accounts WHERE id = $1", [bot.account_id]);
  const user = await one<{ id: number; lang: string }>("SELECT id, lang FROM vk_users WHERE id = $1", [bot.user_id]);
  const fin = async (status: string, reason: string | null, detail: Record<string, unknown> = {}, positionId: number | null = null) => {
    await done(signalId, status, reason, detail, positionId);
    if (status === "rejected" && !opts.dryRun && reason && user) {
      const coin = p.symbol.split(":").pop()!.replace(/\.P$/, "");
      const key = reason.split(":")[0];
      await notify(user.id, "not_opened", T.notOpened(head(bot.name, coin, a?.label ?? ""), NOT_OPENED[key] ? key : "rejected", NOT_OPENED[key] ? "" : reason));
    }
    return { status, reason, detail };
  };
  if (!a || !user) return fin("rejected", "account_missing");
  if (!bot.enabled && !opts.dryRun) return fin("rejected", "source_disabled");
  if (p.time !== null && Date.now() - p.time > s.ttlSec * 1000) return fin("rejected", "stale", { ageSec: Math.round((Date.now() - p.time) / 1000) });

  let symbol: string | null;
  try { symbol = matchSymbol(p.symbol, await marketsCached(a)); } catch (e) { return fin("rejected", `exchange_error:${exchangeError(e).message}`.slice(0, 200), { error: exchangeError(e) }); }
  if (!symbol) return fin("rejected", "no_symbol", { raw: p.symbol });
  if (!opts.dryRun) {
    await notify(user.id, "signal_received", T.signalReceived(bot.name, `${p.action}${p.side ? ` ${p.side}` : ""} ${symbol.split("/")[0]}`));
  }

  // What is open on this symbol right now (any origin).
  let open: Array<{ side: "long" | "short" }> = [];
  if (a.market === "swap") {
    try {
      open = (await clientFor(a).fetchPositions([symbol])).filter((x: any) => Math.abs(Number(x.contracts ?? 0)) > 0).map((x: any) => ({ side: x.side }));
    } catch (e) { return fin("rejected", `exchange_error:${exchangeError(e).message}`.slice(0, 200), { error: exchangeError(e) }); }
  }

  if (p.action === "move_stop") {
    // The source moved its stop: the same price goes into the managed position's plan (Lucy's rule — stop exactly where the source's is).
    const sl = p.overrides.sl;
    const pos = await one<{ id: number; plan: any }>("SELECT id, plan FROM vk_positions WHERE account_id = $1 AND symbol = $2 AND side = $3 AND status = 'open'", [a.id, symbol, p.side]);
    if (!pos || !sl) return fin("ignored", "nothing_to_close", { symbol });
    if (opts.dryRun) return fin("tested", null, { would: "move_stop", symbol, stop: sl.value });
    const plan = { ...pos.plan, stop: sl.mode === "price" ? { mode: "price", value: sl.value } : sl };
    await q("UPDATE vk_positions SET plan = $2, resync = true, updated_at = now() WHERE id = $1", [pos.id, JSON.stringify(plan)]);
    return fin("executed", null, { moved: sl.value, symbol }, pos.id);
  }

  if (p.action === "close") {
    const sides = p.side ? [p.side] : open.map((x) => x.side);
    const targets = sides.filter((sd) => open.some((x) => x.side === sd));
    if (!targets.length) return fin("ignored", "nothing_to_close", { symbol });
    if (opts.dryRun) return fin("tested", null, { would: "close", symbol, sides: targets });
    for (const sd of targets) await closePosition(a, symbol, sd, p.overrides.closePercent ?? 100, "signal_close");
    return fin("executed", null, { closed: targets, symbol });
  }

  const side = p.side!;
  if ((side === "long" && !s.allowLong) || (side === "short" && !s.allowShort)) return fin("rejected", "side_disabled");
  const opposite = open.find((x) => x.side !== side);
  const same = open.find((x) => x.side === side);
  if (opposite) {
    if (s.onOpposite === "skip" && p.action !== "reverse") return fin("rejected", "opposite_open");
    if (!opts.dryRun) await closePosition(a, symbol, opposite.side, 100, "signal_close");
    if (s.onOpposite === "close" && p.action !== "reverse") return fin("executed", null, { closed: [opposite.side], symbol });
  }
  if (same && s.onSame === "skip") return fin("rejected", "already_in_position");

  // Plan: the bot's plan; the signal may override SL / TP when allowed.
  let plan: Plan = s.plan;
  if (s.allowOverrides && (p.overrides.sl || p.overrides.tp)) {
    plan = planSchema.parse({
      ...plan,
      stop: p.overrides.sl ?? plan.stop,
      takes: p.overrides.tp ? p.overrides.tp.map((t, i, arr) => ({ ...t, closePct: i === arr.length - 1 ? 100 - Math.floor(100 / arr.length) * (arr.length - 1) : Math.floor(100 / arr.length) })) : plan.takes,
    });
  }
  const ov = s.allowOverrides ? p.overrides : {};
  const input = {
    symbol, side, type: "market" as const,
    amountMode: ov.amountPct ? ("percent" as const) : s.amountMode, amount: ov.amountPct ?? ov.amount ?? s.amount,
    leverage: Math.round(ov.leverage ?? s.leverage), marginMode: s.marginMode,
    plan: a.market === "swap" ? plan : null, clientRequestId: `sig-${signalId}`,
  };
  if (opts.dryRun) {
    const { evaluate } = await import("../exchanges/execute");
    const { pf } = await evaluate(a, input);
    return fin("tested", pf && !pf.ok ? pf.errors[0].code : null, { would: "open", symbol, side, preflight: pf, plan });
  }
  const r = await openEntry(a, user, input, { kind: "signal", label: bot.name, signalId });
  if (r.http === 200) return fin("executed", null, { symbol, side, orderId: r.body.order?.exchange_order_id }, r.body.positionId ?? null);
  const reason = r.body.error === "preflight_failed" ? r.body.preflight.errors[0].code
    : r.body.error === "risk_limit" ? r.body.risk.code
    : r.body.error === "exchange_error" ? `exchange_error:${r.body.exchangeError?.message ?? ""}`.slice(0, 200) : r.body.error;
  return fin("rejected", reason, { symbol, side });
}
