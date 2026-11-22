/**
 * Position manager. Every CYCLE_MS, per account: compares what Vektor manages with what is really
 * on the exchange and fixes the difference — places/moves the stop, places takes, moves the stop to
 * break-even and trails it, notices partial and full closes, books the real result from fills.
 *
 * Rules carried over from Lucy's Trading Bot:
 *  - the stop is always on the exchange when the exchange allows it; if it cannot be placed, the
 *    position is closed at market (protection_failed) — an unprotected position is never left;
 *  - liquidation must be beyond the stop: isolated margin is topped up, otherwise closed;
 *  - break-even = the user's own zero (entry + both fees), never on the losing side of the entry;
 *  - every close is named from what really happened (stop kind + real fill result), never guessed.
 */
import { pool, q } from "../db";
import { exchangeError, type AccountRow } from "../exchanges/client";
import { isHedged, modeParams, orderSide } from "../exchanges/positionMode";
import type { Side } from "../exchanges/preflight";
import { notify, type Kind } from "../telegram/notify";
import { closeLine, head, resultLine, stopCloseKey, stopMoveLine, T, type Msg, type StopKind } from "../telegram/texts";
import {
  breakevenPrice, isBetterStop, liqBeforeStop, marginForStop, movePct, planErrors, planSchema, stopCrossed, stopPrice,
  takeLevels, takeQuantities, trailingStop, type Plan,
} from "./plan";

export const CYCLE_MS = 3_000;
/** Status is changed inside helpers; this read is not narrowed by TypeScript. */
const isClosed = (p: { status: string }) => p.status === "closed";
const TRAIL_NOTIFY_EVERY_MS = 10 * 60_000;
const EPS = 1e-9;

export type PosRow = {
  id: number; user_id: number; account_id: number; symbol: string; side: Side; source: string; source_label: string;
  status: "pending" | "open" | "closed"; plan: Plan; entry_order_id: string | null; entry_price: number | null;
  initial_qty: number | null; qty: number | null; leverage: number | null; stop_price: number | null; stop_kind: StopKind | null;
  stop_order_id: string | null; stop_where: "exchange" | "vektor" | null;
  takes: Array<{ n: number; price: number; qty: number; orderId: string | null; filled: number; state: "open" | "filled" | "cancelled" | "failed" }>;
  best_price: number | null; be_done: boolean; trail_notified_at: Date | null; pending_close_reason: string | null;
  realized_pnl: number; opened_at: Date | null; created_at: Date; resync: boolean;
};

const NUMERIC = ["entry_price", "initial_qty", "qty", "stop_price", "best_price", "realized_pnl"] as const;
function parseRow(r: any): PosRow {
  for (const k of NUMERIC) r[k] = r[k] === null || r[k] === undefined ? null : Number(r[k]);
  r.realized_pnl = r.realized_pnl ?? 0;
  r.plan = planSchema.parse(r.plan);
  return r as PosRow;
}

export type Deps = {
  client: (a: AccountRow) => any;
  notify?: (userId: number, kind: Kind, msg: Msg) => Promise<unknown>;
  now?: () => number;
};

export function createManager(deps: Deps) {
  const now = deps.now ?? Date.now;
  const say = deps.notify ?? notify;

  async function event(p: PosRow, kind: string, detail: Record<string, unknown> = {}) {
    await q("INSERT INTO vk_position_events (position_id, user_id, kind, detail) VALUES ($1, $2, $3, $4)", [p.id, p.user_id, kind, JSON.stringify(detail)]);
  }
  async function update(p: PosRow, patch: Partial<Record<keyof PosRow | "close_reason" | "exit_price" | "pnl" | "pnl_pct" | "fees" | "closed_at" | "last_error" | "last_sync_at", unknown>>) {
    const keys = Object.keys(patch);
    if (!keys.length) return;
    const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
    const vals = keys.map((k) => { const v = (patch as any)[k]; return v !== null && typeof v === "object" && !(v instanceof Date) ? JSON.stringify(v) : v; });
    await q(`UPDATE vk_positions SET ${sets}, updated_at = now() WHERE id = $1`, [p.id, ...vals]);
    Object.assign(p, patch);
  }

  /** One pass over one account. Errors of one position never stop the others. */
  async function cycleAccount(a: AccountRow & { label: string }): Promise<void> {
    const rows = (await q("SELECT * FROM vk_positions WHERE account_id = $1 AND status <> 'closed' ORDER BY id", [a.id])).map(parseRow);
    if (!rows.length) return;
    const ex = deps.client(a);
    await ex.loadMarkets();
    const symbols = [...new Set(rows.map((r) => r.symbol))];
    const live = await ex.fetchPositions(symbols);
    const hedged = await isHedged(a.id, ex);
    for (const p of rows) {
      const pos = (live ?? []).find((x: any) => x.symbol === p.symbol && (x.side ?? (Number(x.contracts) > 0 ? "long" : "short")) === p.side && Math.abs(Number(x.contracts ?? 0)) > EPS) ?? null;
      try {
        const ctx: Ctx = { a, ex, hedged, p, pos, h: head(p.source_label, p.symbol.split("/")[0], a.label) };
        if (p.status === "pending") await pending(ctx);
        else await manage(ctx);
        await update(p, { last_sync_at: new Date(now()), last_error: null });
      } catch (e) {
        const err = exchangeError(e);
        await update(p, { last_error: `${err.code}: ${err.message}`.slice(0, 300) });
      }
    }
  }

  type Ctx = { a: AccountRow & { label: string }; ex: any; hedged: boolean | null; p: PosRow; pos: any | null; h: string };

  const contracts = (pos: any) => Math.abs(Number(pos?.contracts ?? 0));
  const market = (ex: any, symbol: string) => ex.markets?.[symbol] ?? ex.market(symbol);
  const amt = (ex: any, symbol: string, v: number) => Number(ex.amountToPrecision(symbol, v));
  const px = (ex: any, symbol: string, v: number) => Number(ex.priceToPrecision(symbol, v));
  const taker = (ex: any, symbol: string) => Number(market(ex, symbol)?.taker ?? 0.0006);

  /** Waits for the entry to fill; then turns the plan into orders. */
  async function pending(c: Ctx) {
    const { p, pos } = c;
    if (pos && contracts(pos) > EPS) { await activate(c); return; }
    if (p.entry_order_id) {
      const o = await c.ex.fetchOrder(p.entry_order_id, p.symbol).catch(() => null);
      if (o && (o.status === "canceled" || o.status === "cancelled" || o.status === "rejected" || o.status === "expired")) {
        await update(p, { status: "closed", close_reason: "entry_cancelled", closed_at: new Date(now()) });
        await event(p, "entry_cancelled", { status: o.status });
      }
    }
  }

  async function activate(c: Ctx) {
    const { p, pos, ex } = c;
    const entry = Number(pos.entryPrice);
    const qty = contracts(pos);
    const errs = planErrors(p.plan, p.side, entry);
    const sp = errs.includes("stop_wrong_side") ? null : stopPrice(p.plan, p.side, entry);
    await update(p, { status: "open", entry_price: entry, initial_qty: p.initial_qty ?? qty, qty, leverage: pos.leverage ?? p.leverage, opened_at: p.opened_at ?? new Date(now()), best_price: entry });
    await event(p, "opened", { entry, qty, planErrors: errs });

    if (sp !== null) await placeStop(c, px(ex, p.symbol, sp), "initial");
    if (isClosed(p)) return; // protection failed → closed
    await placeTakes(c, entry, qty);
    await guardLiquidation(c);
    if (isClosed(p)) return;

    const delayS = p.source === "signal" ? (now() - p.created_at.getTime()) / 1000 : null;
    await say(p.user_id, "opened", T.opened(c.h, {
      side: p.side, entry, qty: qty * Number(market(ex, p.symbol)?.contractSize ?? 1), leverage: p.leverage, margin: pos.initialMargin ?? pos.collateral ?? null,
      stop: p.stop_price, liq: pos.liquidationPrice ?? null, takes: p.takes.map((t) => ({ price: t.price, closePct: Math.round((t.qty / qty) * 100) })),
      managedBy: p.stop_where === "vektor" ? "Vektor (стоп на сервере Vektor — биржа не поддерживает стоп-ордера)" : null, delayS,
    }));
  }

  /** Cancel-then-place (two live stops could over-close in hedge mode). Failure → close at market. */
  async function placeStop(c: Ctx, price: number, kind: StopKind, why = "") {
    const { p, ex, a } = c;
    const qty = p.qty ?? 0;
    if (p.stop_order_id) {
      await ex.cancelOrder(p.stop_order_id, p.symbol, triggerParams(ex)).catch(() => undefined);
    }
    const canExchange = Boolean(ex.has?.createStopLossOrder || ex.has?.createStopOrder || ex.has?.createTriggerOrder);
    if (!canExchange) {
      await update(p, { stop_price: price, stop_kind: kind, stop_order_id: null, stop_where: "vektor" });
      await event(p, "stop_set", { price, kind, where: "vektor", why });
      return;
    }
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const params = { ...modeParams(a.exchange, c.hedged, p.side, true), stopLossPrice: price };
        const o = await ex.createOrder(p.symbol, "market", orderSide(p.side, true), qty, undefined, params);
        await update(p, { stop_price: price, stop_kind: kind, stop_order_id: String(o.id), stop_where: "exchange" });
        await event(p, "stop_set", { price, kind, where: "exchange", orderId: o.id, why });
        return;
      } catch (e) { lastErr = e; }
    }
    // Price already beyond the new stop → the exchange refuses the trigger: close now.
    const last = await lastPrice(c);
    await event(p, "stop_failed", { price, error: exchangeError(lastErr) });
    await closeMarket(c, last !== null && stopCrossed(p.side, price, last) ? "stop_passed" : "protection_failed");
  }

  async function placeTakes(c: Ctx, entry: number, qty: number) {
    const { p, ex, a } = c;
    const levels = takeLevels(p.plan, p.side, entry);
    if (!levels.length) { await update(p, { takes: [] }); return; }
    const qtys = takeQuantities(levels, qty, null, (v) => amt(ex, p.symbol, Math.max(0, v)));
    const takes: PosRow["takes"] = [];
    for (let i = 0; i < levels.length; i++) {
      const l = levels[i];
      const tq = qtys[i];
      const price = px(ex, p.symbol, l.price);
      if (!(tq > 0)) { takes.push({ n: l.n, price, qty: 0, orderId: null, filled: 0, state: "failed" }); continue; }
      try {
        const o = await ex.createOrder(p.symbol, "limit", orderSide(p.side, true), tq, price, modeParams(a.exchange, c.hedged, p.side, true));
        takes.push({ n: l.n, price, qty: tq, orderId: String(o.id), filled: 0, state: "open" });
      } catch (e) {
        takes.push({ n: l.n, price, qty: tq, orderId: null, filled: 0, state: "failed" });
        await event(p, "take_failed", { n: l.n, price, error: exchangeError(e) });
      }
    }
    await update(p, { takes });
  }

  async function cancelTakes(c: Ctx) {
    for (const t of c.p.takes) if (t.state === "open" && t.orderId) await c.ex.cancelOrder(t.orderId, c.p.symbol).catch(() => undefined);
  }

  /** Isolated position whose liquidation comes before the stop: top up margin, else close. */
  async function guardLiquidation(c: Ctx) {
    const { p, ex } = c;
    const pos = (await ex.fetchPositions([p.symbol])).find((x: any) => x.symbol === p.symbol && x.side === p.side);
    const liq = pos?.liquidationPrice ? Number(pos.liquidationPrice) : null;
    if (!liqBeforeStop(p.side, liq, p.stop_price)) return;
    if (ex.has?.addMargin && pos?.marginMode !== "cross") {
      const need = marginForStop({ side: p.side, entry: p.entry_price!, stop: p.stop_price!, notional: Math.abs(Number(pos.notional ?? 0)) });
      const add = need - Number(pos.initialMargin ?? pos.collateral ?? 0);
      if (add > 0) {
        try {
          await ex.addMargin(p.symbol, Number(add.toFixed(4)), { positionSide: p.side.toUpperCase() });
          await event(p, "margin_added", { add });
          const again = (await ex.fetchPositions([p.symbol])).find((x: any) => x.symbol === p.symbol && x.side === p.side);
          if (!liqBeforeStop(p.side, again?.liquidationPrice ? Number(again.liquidationPrice) : null, p.stop_price)) return;
        } catch (e) { await event(p, "margin_add_failed", { error: exchangeError(e) }); }
      }
    }
    await closeMarket(c, "liquidation_before_stop");
  }

  async function lastPrice(c: Ctx): Promise<number | null> {
    const t = await c.ex.fetchTicker(c.p.symbol).catch(() => null);
    return t?.last ?? null;
  }

  /** Vektor closes the position itself; the reason is kept and used when the close is booked. */
  async function closeMarket(c: Ctx, reason: string) {
    const { p, ex, a } = c;
    await update(p, { pending_close_reason: reason });
    await cancelTakes(c);
    if (p.stop_order_id) await ex.cancelOrder(p.stop_order_id, p.symbol, triggerParams(ex)).catch(() => undefined);
    const qty = p.qty ?? contracts(c.pos);
    try {
      await ex.createOrder(p.symbol, "market", orderSide(p.side, true), qty, undefined, modeParams(a.exchange, c.hedged, p.side, true));
    } catch (e) {
      await event(p, "close_failed", { reason, error: exchangeError(e) });
      throw e;
    }
    if (reason === "protection_failed" || reason === "liquidation_before_stop") {
      await say(p.user_id, "protection_failed", { ru: `${c.h}\n${closeLine(reason).ru}`, en: `${c.h}\n${closeLine(reason).en}` });
    }
    await finalize(c, true);
  }

  /** The managed loop for an open position. */
  async function manage(c: Ctx) {
    const { p, pos, ex } = c;
    if (!pos || contracts(pos) <= EPS) { await finalize(c); return; }
    if (p.resync) { await applyPlanEdit(c); if (isClosed(p)) return; }
    const size = contracts(pos);
    if (p.qty !== null && size < p.qty - EPS) await partial(c, size);
    else if (p.qty !== null && size > p.qty + EPS) {
      // Added to the position (by hand or DCA): new average, re-place protection for the new size.
      await update(p, { qty: size, entry_price: Number(pos.entryPrice) });
      await event(p, "size_increased", { qty: size, entry: p.entry_price });
      await cancelTakes(c);
      if (p.stop_price !== null) await placeStop(c, p.stop_price, p.stop_kind ?? "initial", "size_changed");
      if (!isClosed(p)) await placeTakes(c, p.entry_price!, size);
    }
    if (isClosed(p)) return;

    const last = Number(pos.markPrice ?? 0) || (await lastPrice(c));
    if (!last) return;
    const best = p.best_price === null ? last : p.side === "long" ? Math.max(p.best_price, last) : Math.min(p.best_price, last);
    if (best !== p.best_price) await update(p, { best_price: best });

    // Stop kept by Vektor (exchange without stop orders): close when crossed.
    if (p.stop_where === "vektor" && p.stop_price !== null && stopCrossed(p.side, p.stop_price, last)) {
      await closeMarket(c, stopCloseKey(p.stop_kind ?? "initial", movePct(p.side, p.entry_price!, last)));
      return;
    }
    // Exchange stop disappeared while the position is open (cancelled by hand / lost) → put it back.
    if (p.stop_where === "exchange" && p.stop_order_id && p.stop_price !== null) {
      const open = await openOrderIds(c);
      if (open && !open.has(p.stop_order_id)) {
        await event(p, "stop_missing", { orderId: p.stop_order_id });
        await placeStop(c, p.stop_price, p.stop_kind ?? "initial", "restored");
        if (isClosed(p)) return;
        await say(p.user_id, "reconcile_fixed", T.reconcileFixed(c.h, { ru: `Стоп-ордер пропал с биржи — выставлен заново: ${p.stop_price}`, en: `The stop order disappeared from the exchange — placed again: ${p.stop_price}` }));
      }
    }

    const fee = taker(ex, p.symbol);
    // Break-even by % move.
    if (!p.be_done && p.plan.breakeven.after === "pct" && movePct(p.side, p.entry_price!, best) >= (p.plan.breakeven.pct ?? Infinity)) {
      await moveToBreakeven(c, fee, "pct");
      if (isClosed(p)) return;
    }
    // Trailing.
    if (p.plan.trailing) {
      const cand = trailingStop({ side: p.side, entry: p.entry_price!, best, current: p.stop_price, activationPct: p.plan.trailing.activationPct, callbackPct: p.plan.trailing.callbackPct });
      if (cand !== null) {
        const price = px(ex, p.symbol, cand);
        if (isBetterStop(p.side, price, p.stop_price)) {
          const first = p.stop_kind !== "trailing";
          await placeStop(c, price, "trailing", "trailing");
          if (isClosed(p)) return;
          const due = first || !p.trail_notified_at || now() - new Date(p.trail_notified_at).getTime() > TRAIL_NOTIFY_EVERY_MS;
          if (due) {
            await update(p, { trail_notified_at: new Date(now()) });
            await say(p.user_id, "stop_moved", T.stopMoved(c.h, stopMoveLine("trailing", movePct(p.side, p.entry_price!, price)), price));
          }
        }
      }
    }
  }

  /**
   * The user edited the plan of an open position: new takes for what is left; the stop follows the
   * new plan unless break-even/trailing already put it somewhere better.
   */
  async function applyPlanEdit(c: Ctx) {
    const { p, ex } = c;
    await update(p, { resync: false });
    await cancelTakes(c);
    const planned = stopPrice(p.plan, p.side, p.entry_price!);
    const keep = (p.stop_kind === "breakeven" || p.stop_kind === "trailing") && p.stop_price !== null && (planned === null || isBetterStop(p.side, p.stop_price, planned));
    if (!keep) {
      if (planned !== null) await placeStop(c, px(ex, p.symbol, planned), "manual", "plan_edit");
      else if (p.stop_order_id) {
        await ex.cancelOrder(p.stop_order_id, p.symbol, triggerParams(ex)).catch(() => undefined);
        await update(p, { stop_price: null, stop_order_id: null, stop_kind: null });
      }
    }
    if (isClosed(p)) return;
    // Takes already filled stay filled; the new plan applies to the remaining size.
    const filled = p.takes.filter((t) => t.state === "filled");
    await placeTakes(c, p.entry_price!, p.qty!);
    await update(p, { takes: [...filled, ...p.takes] });
    await event(p, "plan_edited", { stop: p.stop_price, takes: p.takes.length });
  }

  async function moveToBreakeven(c: Ctx, fee: number, why: string) {
    const { p, ex } = c;
    const be = px(ex, c.p.symbol, breakevenPrice(p.side, p.entry_price!, fee));
    await update(p, { be_done: true });
    if (!isBetterStop(p.side, be, p.stop_price)) return; // the stop is already better
    await placeStop(c, be, "breakeven", why);
    if (isClosed(p)) return;
    await say(p.user_id, "stop_moved", T.stopMoved(c.h, stopMoveLine("breakeven", movePct(p.side, p.entry_price!, be)), be));
  }

  async function openOrderIds(c: Ctx): Promise<Set<string> | null> {
    try {
      const a = await c.ex.fetchOpenOrders(c.p.symbol);
      const b = await c.ex.fetchOpenOrders(c.p.symbol, undefined, undefined, { trigger: true }).catch(() => []);
      return new Set([...a, ...b].map((o: any) => String(o.id)));
    } catch { return null; }
  }

  /** Size went down: which take filled (or a manual partial close), then follow-ups. */
  async function partial(c: Ctx, size: number) {
    const { p, ex } = c;
    const before = p.qty!;
    let tookN: number | null = null;
    const takes = p.takes.map((t) => ({ ...t }));
    for (const t of takes) {
      if (t.state !== "open" || !t.orderId) continue;
      const o = await ex.fetchOrder(t.orderId, p.symbol).catch(() => null);
      if (o && Number(o.filled) > t.filled + EPS) {
        t.filled = Number(o.filled);
        if (o.status === "closed" || t.filled >= t.qty - EPS) t.state = "filled";
        tookN = tookN === null ? t.n : Math.max(tookN, t.n);
      } else if (o && (o.status === "canceled" || o.status === "cancelled")) t.state = "cancelled";
    }
    const closed = before - size;
    const last = (await lastPrice(c)) ?? p.entry_price!;
    const pnlPart = (last - p.entry_price!) * closed * (p.side === "long" ? 1 : -1) * Number(market(ex, p.symbol)?.contractSize ?? 1);
    await update(p, { qty: size, takes, realized_pnl: p.realized_pnl + pnlPart });
    const reasonKey = tookN !== null ? "take_partial" : p.pending_close_reason === "terminal_partial" ? "terminal" : "manual";
    await event(p, "partial", { closed, left: size, take: tookN, reason: reasonKey });
    if (p.pending_close_reason === "terminal_partial") await update(p, { pending_close_reason: null });

    // The stop must cover exactly what is left.
    if (p.stop_price !== null) await placeStop(c, p.stop_price, p.stop_kind ?? "initial", "partial");
    if (isClosed(p)) return;
    const reason = tookN !== null ? { ru: `Тейк ${tookN} исполнен — частичная фиксация прибыли`, en: `Take-profit ${tookN} filled — partial profit taken` } : closeLine(reasonKey);
    await say(p.user_id, "partial", T.partial(c.h, {
      reason, closed, initial: p.initial_qty ?? before, atPct: movePct(p.side, p.entry_price!, last), left: size,
      stop: p.stop_price, stopPct: p.stop_price !== null ? movePct(p.side, p.entry_price!, p.stop_price) : null,
    }));
    if (tookN !== null && !p.be_done && p.plan.breakeven.after === "tp1") await moveToBreakeven(c, taker(ex, p.symbol), "tp1");
  }

  /** Position is gone from the exchange: real exit and result from the fills. */
  async function finalize(c: Ctx, byVektor = false) {
    const { p, ex } = c;
    if (!byVektor) {
      // Give the exchange a moment to publish fills; a position that just vanished gets one more pass.
      const pos = (await ex.fetchPositions([p.symbol])).find((x: any) => x.symbol === p.symbol && x.side === p.side && contracts(x) > EPS);
      if (pos) return;
    }
    await cancelTakes(c);
    if (p.stop_order_id) await ex.cancelOrder(p.stop_order_id, p.symbol, triggerParams(ex)).catch(() => undefined);
    const since = (p.opened_at ? new Date(p.opened_at).getTime() : p.created_at.getTime()) - 2_000;
    const trades: any[] = await ex.fetchMyTrades(p.symbol, since).catch(() => []);
    const closeSide = orderSide(p.side, true);
    const closing = trades.filter((t) => t.side === closeSide).sort((a, b) => a.timestamp - b.timestamp);
    const cs = Number(market(ex, p.symbol)?.contractSize ?? 1);
    const qty = closing.reduce((s, t) => s + Number(t.amount), 0);
    const exitAvg = qty > 0 ? closing.reduce((s, t) => s + Number(t.price) * Number(t.amount), 0) / qty : null;
    const entry = p.entry_price ?? exitAvg ?? 0;
    const pnl = exitAvg !== null ? closing.reduce((s, t) => s + (Number(t.price) - entry) * Number(t.amount) * cs * (p.side === "long" ? 1 : -1), 0) : null;
    const fees = trades.reduce((s, t) => s + Number(t.fee?.cost ?? 0), 0);
    const lastTrade = closing[closing.length - 1];
    const lastExit = lastTrade ? Number(lastTrade.price) : exitAvg;
    const lastPct = lastExit !== null && entry ? movePct(p.side, entry, lastExit) : null;

    let reason: string;
    const takeIds = new Set(p.takes.map((t) => t.orderId).filter(Boolean));
    if (p.pending_close_reason && p.pending_close_reason !== "terminal_partial") reason = p.pending_close_reason;
    else if (lastTrade && p.stop_order_id && String(lastTrade.order) === p.stop_order_id) reason = stopCloseKey(p.stop_kind ?? "initial", lastPct);
    else if (lastTrade && takeIds.has(String(lastTrade.order))) reason = "take";
    else if (lastTrade && /liq/i.test(JSON.stringify(lastTrade.info ?? {}))) reason = "liquidation";
    else if (p.stop_price !== null && lastExit !== null && Math.abs(movePct(p.side, p.stop_price, lastExit)) < 0.3) reason = stopCloseKey(p.stop_kind ?? "initial", lastPct);
    else reason = "manual";

    const pnlPct = exitAvg !== null && entry ? movePct(p.side, entry, exitAvg) : null;
    // Money result is net: entry and exit fees taken from the real fills.
    const net = pnl !== null ? pnl - fees : null;
    await update(p, { status: "closed", closed_at: new Date(now()), close_reason: reason, exit_price: exitAvg, pnl: net, pnl_pct: pnlPct, fees, qty: 0 });
    await event(p, "closed", { reason, exitAvg, pnl, fees, fills: closing.length });
    const asset = c.a.env === "testnet" ? "USDT (тестнет)" : "USDT";
    const lastTake = p.takes.filter((t) => t.orderId === String(lastTrade?.order)).map((t) => t.n)[0] ?? null;
    await say(p.user_id, reason === "liquidation" ? "liquidation" : "closed", T.closed(c.h, {
      side: p.side, reason: closeLine(reason, { source: p.source_label, takeN: lastTake }), entry, exit: lastExit, avgExit: exitAvg,
      parts: closing.length, result: resultLine(pnlPct, net, asset, fees), hadPartials: closing.length > 1,
    }));
  }

  return { cycleAccount, finalize, closeMarket };
}

/** Some exchanges keep trigger orders in a separate book; CCXT reads them with { trigger: true }. */
function triggerParams(ex: any): Record<string, unknown> {
  return ["bybit", "okx", "bitget", "gate", "kucoin", "kucoinfutures", "mexc", "htx"].includes(ex.id) ? { trigger: true } : {};
}

/** The loop: one account at a time per process; a DB advisory lock keeps two processes from managing the same account. */
export function startEngine(deps: Deps) {
  const m = createManager(deps);
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const accounts = await q(`SELECT DISTINCT a.* FROM vk_exchange_accounts a JOIN vk_positions p ON p.account_id = a.id
                                WHERE p.status <> 'closed' AND a.status <> 'paused'`);
      for (const a of accounts) {
        // Session-level lock: taken and released on the same connection.
        const conn = await pool.connect();
        try {
          const got = await conn.query<{ ok: boolean }>("SELECT pg_try_advisory_lock(764300, $1::int) AS ok", [a.id]);
          if (!got.rows[0]?.ok) continue;
          try { await m.cycleAccount(a); } catch (e) { console.error("[engine]", a.id, exchangeError(e).message); }
          finally { await conn.query("SELECT pg_advisory_unlock(764300, $1::int)", [a.id]).catch(() => undefined); }
        } finally { conn.release(); }
      }
    } finally { running = false; }
  };
  const id = setInterval(() => void tick(), CYCLE_MS);
  id.unref?.();
  return { stop: () => clearInterval(id), tick };
}
