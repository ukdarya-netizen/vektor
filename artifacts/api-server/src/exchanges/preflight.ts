/**
 * Order check before sending (ТЗ Мануса §6.2): pure function, no exchange calls — covered by tests.
 * Futures: the user enters MARGIN (USDT); position size = margin × leverage. Spot: the USDT amount.
 * Every problem comes back as a reason code + numbers, so the UI can explain it in words.
 */
import type { MarketInfo } from "./market";

export type Side = "long" | "short";
export type OrderInput = {
  market: "spot" | "swap";
  side: Side;
  type: "market" | "limit";
  price?: number | null;
  amountMode: "usdt" | "percent" | "qty";
  amount: number;
  leverage?: number | null;
};
export type Preflight = {
  ok: boolean;
  errors: Array<{ code: string; need?: number; have?: number }>;
  warnings: Array<{ code: string; value?: number }>;
  price: number;
  qty: number;
  notional: number;
  margin: number;
  fee: number;
  leverage: number;
};

/** Floors to the step (never rounds up: rounding up could exceed the balance). */
export function floorToStep(v: number, step: number | null): number {
  if (!step || step <= 0) return v;
  const n = Math.floor(v / step + 1e-9) * step;
  const dec = Math.max(0, Math.ceil(-Math.log10(step) - 1e-9));
  return Number(n.toFixed(Math.min(dec, 12)));
}
export const roundToTick = (v: number, tick: number | null) => {
  if (!tick || tick <= 0) return v;
  const dec = Math.max(0, Math.ceil(-Math.log10(tick) - 1e-9));
  return Number((Math.round(v / tick) * tick).toFixed(Math.min(dec, 12)));
};

export function preflight(input: OrderInput, mk: MarketInfo, ctx: { last: number | null; bid: number | null; ask: number | null; freeQuote: number; baseFree?: number }): Preflight {
  const errors: Preflight["errors"] = [];
  const warnings: Preflight["warnings"] = [];
  const lev = input.market === "swap" ? Math.max(1, Math.round(input.leverage ?? 1)) : 1;
  if (input.market === "swap" && mk.maxLeverage && lev > mk.maxLeverage) errors.push({ code: "leverage_too_high", need: mk.maxLeverage, have: lev });

  const marketPx = input.side === "long" ? ctx.ask ?? ctx.last : ctx.bid ?? ctx.last;
  let price = input.type === "limit" ? Number(input.price) : Number(marketPx);
  if (!Number.isFinite(price) || price <= 0) {
    errors.push({ code: input.type === "limit" ? "bad_price" : "no_price" });
    price = 0;
  } else if (input.type === "limit") {
    price = roundToTick(price, mk.tick);
    // A limit far on the wrong side fills at once as a taker — say so.
    const ref = ctx.last ?? price;
    if (input.side === "long" && price > ref * 1.002) warnings.push({ code: "limit_above_market", value: ((price - ref) / ref) * 100 });
    if (input.side === "short" && price < ref * 0.998) warnings.push({ code: "limit_below_market", value: ((ref - price) / ref) * 100 });
  }

  const cs = mk.contractSize || 1;
  let rawQty = 0;
  if (!(input.amount > 0)) errors.push({ code: "bad_amount" });
  else if (price > 0) {
    if (input.amountMode === "qty") rawQty = input.amount;
    else if (input.market === "spot" && input.side === "short") {
      // Spot sell: percent = share of the coin you hold; usdt = how much to sell for.
      rawQty = input.amountMode === "percent" ? ((ctx.baseFree ?? 0) * Math.min(input.amount, 100)) / 100 : input.amount / price;
    } else {
      const usdt = input.amountMode === "percent" ? (ctx.freeQuote * Math.min(input.amount, 100)) / 100 : input.amount;
      // Keep room for the taker fee so 100% never fails on the fee.
      const feeRoom = 1 + (mk.taker ?? 0.001) * lev;
      rawQty = (usdt * lev) / feeRoom / price / cs;
    }
  }
  const qty = floorToStep(rawQty, mk.step);
  const notional = qty * cs * price;
  const margin = notional / lev;
  const fee = notional * (input.type === "market" ? mk.taker ?? 0.001 : mk.maker ?? mk.taker ?? 0.001);

  // Rounded down to zero = below the exchange lot: one clear reason, not two.
  if (rawQty > 0 && qty <= 0) errors.push({ code: "below_min_quantity", need: Math.max(mk.minAmount ?? 0, mk.step ?? 0) || undefined, have: rawQty });
  else if (mk.minAmount && qty > 0 && qty < mk.minAmount) errors.push({ code: "below_min_quantity", need: mk.minAmount, have: qty });
  if (mk.minCost && notional > 0 && notional < mk.minCost) errors.push({ code: "below_min_notional", need: mk.minCost, have: notional });

  if (input.market === "swap" || input.side === "long") {
    if (margin + fee > ctx.freeQuote + 1e-9) errors.push({ code: "no_funds", need: margin + fee, have: ctx.freeQuote });
  } else if (input.market === "spot" && input.side === "short") {
    // Spot "short" = sell what you hold.
    if (qty > (ctx.baseFree ?? 0) + 1e-12) errors.push({ code: "no_base_funds", need: qty, have: ctx.baseFree ?? 0 });
  }
  if (input.market === "swap" && lev >= 50) warnings.push({ code: "high_leverage", value: lev });

  return { ok: errors.length === 0, errors, warnings, price, qty, notional, margin, fee, leverage: lev };
}
