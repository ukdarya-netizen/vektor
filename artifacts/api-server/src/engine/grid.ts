/**
 * Grid bot (long grid). Levels L0 < … < Ln in [lower, upper]. At start: buy limits on levels below
 * the price, and enough coin bought at market to place sell limits on levels above it.
 * A filled buy at Li → sell at Li+1; a filled sell at Li → buy at Li−1. Each buy→sell pair is one
 * round with profit qty × (Li+1 − Li) minus fees. Price beyond the optional stop bounds → all
 * orders cancelled and the coin/position closed at market. Futures: hedge long, sells are reduce-only.
 * Not promised: profit. A grid loses when the price leaves the range downwards.
 */
import { z } from "zod";
import { one, pool, q } from "../db";
import { exchangeError, type AccountRow } from "../exchanges/client";
import { isHedged, modeParams } from "../exchanges/positionMode";
import { notify } from "../telegram/notify";

export const gridSettingsSchema = z.object({
  symbol: z.string().min(1),
  lower: z.number().positive(),
  upper: z.number().positive(),
  levels: z.number().int().min(2).max(100),
  spacing: z.enum(["arithmetic", "geometric"]).default("arithmetic"),
  investUsdt: z.number().positive(),
  leverage: z.number().int().min(1).max(20).default(1),
  stopLower: z.number().positive().nullable().default(null),
  stopUpper: z.number().positive().nullable().default(null),
}).refine((s) => s.upper > s.lower, { message: "upper_below_lower" })
  .refine((s) => s.stopLower === null || s.stopLower < s.lower, { message: "stop_lower_inside" })
  .refine((s) => s.stopUpper === null || s.stopUpper > s.upper, { message: "stop_upper_inside" });
export type GridSettings = z.infer<typeof gridSettingsSchema>;

type GOrder = { id: string; level: number; side: "buy" | "sell"; qty: number; price: number };
export type GridState = { levels: number[]; qty: number; orders: GOrder[]; rounds: number; realized: number; fees: number; startPrice: number };

export function gridLevels(s: Pick<GridSettings, "lower" | "upper" | "levels" | "spacing">): number[] {
  const out: number[] = [];
  for (let i = 0; i <= s.levels; i++) {
    out.push(s.spacing === "geometric" ? s.lower * Math.pow(s.upper / s.lower, i / s.levels) : s.lower + ((s.upper - s.lower) * i) / s.levels);
  }
  return out;
}

/** Quantity per level so that the whole grid uses investUsdt (× leverage for futures). */
export const gridQty = (s: GridSettings, levels: number[]) => (s.investUsdt * s.leverage) / (levels.length - 1) / (levels.reduce((a, b) => a + b, 0) / levels.length);

type Row = { id: number; user_id: number; account_id: number; settings: GridSettings; status: string; state: GridState | null; name: string };

const say = (userId: number, ru: string, en: string) => notify(userId, "partial", { ru, en }).catch(() => undefined);

export async function startGrid(g: Row, a: AccountRow & { label: string }, ex: any): Promise<void> {
  const s = g.settings;
  await ex.loadMarkets();
  const t = await ex.fetchTicker(s.symbol);
  const price = Number(t.last);
  if (!(price > s.lower && price < s.upper)) throw Object.assign(new Error("price_outside_range"), { code: "price_outside_range" });
  const levels = gridLevels(s).map((p) => Number(ex.priceToPrecision(s.symbol, p)));
  const qty = Number(ex.amountToPrecision(s.symbol, gridQty(s, levels)));
  if (!(qty > 0)) throw Object.assign(new Error("qty_too_small"), { code: "qty_too_small" });
  const hedged = a.market === "swap" ? await isHedged(a.id, ex) : null;
  if (a.market === "swap") {
    if (ex.has?.setLeverage) await ex.setLeverage(s.leverage, s.symbol).catch(() => undefined);
  }
  const above = levels.filter((l) => l > price).length;
  if (above > 0) {
    // Inventory for the sell side.
    await ex.createOrder(s.symbol, "market", "buy", Number(ex.amountToPrecision(s.symbol, qty * above)), undefined, a.market === "swap" ? modeParams(a.exchange, hedged, "long", false) : {});
  }
  const orders: GOrder[] = [];
  for (let i = 0; i < levels.length; i++) {
    const L = levels[i];
    if (Math.abs(L - price) / price < 0.0005) continue; // the level at the price stays empty
    const side = L < price ? "buy" : "sell";
    const params = a.market === "swap" ? modeParams(a.exchange, hedged, "long", side === "sell") : {};
    const o = await ex.createOrder(s.symbol, "limit", side, qty, L, params);
    orders.push({ id: String(o.id), level: i, side, qty, price: L });
  }
  const state: GridState = { levels, qty, orders, rounds: 0, realized: 0, fees: 0, startPrice: price };
  await q("UPDATE vk_grids SET status = 'running', state = $2, last_error = NULL, started_at = now() WHERE id = $1", [g.id, JSON.stringify(state)]);
  await say(g.user_id, `🕸 Grid ${g.name} запущен: ${s.symbol.split("/")[0]} ${levels[0]}–${levels[levels.length - 1]}, ${s.levels} уровней по ${qty}. Счёт ${a.label}.`,
    `🕸 Grid ${g.name} started: ${s.symbol.split("/")[0]} ${levels[0]}–${levels[levels.length - 1]}, ${s.levels} levels of ${qty}. Account ${a.label}.`);
}

/** One pass: replace filled orders with their opposite, check the stop bounds. */
export async function tickGrid(g: Row, a: AccountRow & { label: string }, ex: any): Promise<void> {
  const s = g.settings, st = g.state!;
  const hedged = a.market === "swap" ? await isHedged(a.id, ex) : null;
  const t = await ex.fetchTicker(s.symbol);
  const price = Number(t.last);
  if ((s.stopLower !== null && price <= s.stopLower) || (s.stopUpper !== null && price >= s.stopUpper)) {
    await stopGrid(g, a, ex, true, price <= (s.stopLower ?? -Infinity) ? "stop_lower" : "stop_upper");
    return;
  }
  const open = new Set((await ex.fetchOpenOrders(s.symbol)).map((o: any) => String(o.id)));
  let changed = false;
  for (const o of [...st.orders]) {
    if (open.has(o.id)) continue;
    const f = await ex.fetchOrder(o.id, s.symbol).catch(() => null);
    if (!f || f.status !== "closed") {
      // Cancelled outside VECTOR: drop it (not re-placed — the user took it away).
      if (f && (f.status === "canceled" || f.status === "cancelled")) { st.orders = st.orders.filter((x) => x !== o); changed = true; }
      continue;
    }
    changed = true;
    st.orders = st.orders.filter((x) => x !== o);
    const fee = o.qty * o.price * Number(ex.markets?.[s.symbol]?.maker ?? 0.0002);
    st.fees += fee;
    const next = o.side === "buy" ? o.level + 1 : o.level - 1;
    if (next < 0 || next >= st.levels.length) continue;
    if (o.side === "sell") { st.rounds += 1; st.realized += o.qty * (st.levels[o.level] - st.levels[o.level - 1]); }
    const side = o.side === "buy" ? "sell" : "buy";
    const params = a.market === "swap" ? modeParams(a.exchange, hedged, "long", side === "sell") : {};
    try {
      const n = await ex.createOrder(s.symbol, "limit", side, o.qty, st.levels[next], params);
      st.orders.push({ id: String(n.id), level: next, side, qty: o.qty, price: st.levels[next] });
    } catch (e) {
      await q("UPDATE vk_grids SET last_error = $2 WHERE id = $1", [g.id, exchangeError(e).message.slice(0, 300)]);
    }
  }
  if (changed) await q("UPDATE vk_grids SET state = $2 WHERE id = $1", [g.id, JSON.stringify(st)]);
}

export async function stopGrid(g: Row, a: AccountRow & { label: string }, ex: any, closeAll: boolean, reason: string): Promise<void> {
  const s = g.settings, st = g.state;
  for (const o of st?.orders ?? []) await ex.cancelOrder(o.id, s.symbol).catch(() => undefined);
  if (closeAll) {
    if (a.market === "swap") {
      const pos = (await ex.fetchPositions([s.symbol])).find((x: any) => x.side === "long" && Math.abs(Number(x.contracts)) > 0);
      if (pos) await ex.createOrder(s.symbol, "market", "sell", Math.abs(Number(pos.contracts)), undefined, modeParams(a.exchange, await isHedged(a.id, ex), "long", true));
    } else {
      const base = s.symbol.split("/")[0];
      const bal = await ex.fetchBalance();
      const free = Number(ex.amountToPrecision(s.symbol, Number(bal.free?.[base] ?? 0)));
      if (free > 0) await ex.createOrder(s.symbol, "market", "sell", free);
    }
  }
  await q("UPDATE vk_grids SET status = 'stopped', stop_reason = $2, stopped_at = now() WHERE id = $1", [g.id, reason]);
  const why: Record<string, [string, string]> = {
    stop_lower: ["цена ушла ниже нижнего стопа — всё закрыто по рынку", "price fell below the lower stop — everything closed at market"],
    stop_upper: ["цена ушла выше верхнего стопа — всё закрыто по рынку", "price rose above the upper stop — everything closed at market"],
    manual_close: ["остановлен вами, позиция закрыта", "stopped by you, position closed"],
    manual: ["остановлен вами, монета/позиция оставлена", "stopped by you, coin/position kept"],
  };
  const [ru, en] = why[reason] ?? [reason, reason];
  await say(g.user_id, `🕸 Grid ${g.name} остановлен: ${ru}. Кругов: ${st?.rounds ?? 0}, заработано на сетке ≈ ${(st?.realized ?? 0).toFixed(2)} USDT до комиссий.`,
    `🕸 Grid ${g.name} stopped: ${en}. Rounds: ${st?.rounds ?? 0}, grid profit ≈ ${(st?.realized ?? 0).toFixed(2)} USDT before fees.`);
}

export function startGridLoop(client: (a: AccountRow) => any) {
  let running = false;
  const id = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const rows = await q<Row>("SELECT g.*, g.name FROM vk_grids g WHERE g.status = 'running'");
      for (const g of rows) {
        const conn = await pool.connect();
        try {
          const got = await conn.query<{ ok: boolean }>("SELECT pg_try_advisory_lock(764400, $1::int) AS ok", [g.id]);
          if (!got.rows[0]?.ok) continue;
          try {
            const a = await one<AccountRow & { label: string }>("SELECT * FROM vk_exchange_accounts WHERE id = $1", [g.account_id]);
            if (a) await tickGrid(g, a, client(a));
          } catch (e) { await q("UPDATE vk_grids SET last_error = $2 WHERE id = $1", [g.id, exchangeError(e).message.slice(0, 300)]); }
          finally { await conn.query("SELECT pg_advisory_unlock(764400, $1::int)", [g.id]).catch(() => undefined); }
        } finally { conn.release(); }
      }
    } finally { running = false; }
  }, 5_000);
  id.unref?.();
}
