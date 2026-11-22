/**
 * Position plan: stop, take-profits, break-even, trailing. Pure functions — all prices are
 * derived from the REAL average entry, so a slipped fill moves the whole plan with it.
 */
import { z } from "zod";
import type { Side } from "../exchanges/preflight";

const level = z.object({ mode: z.enum(["pct", "price"]), value: z.number().positive() });
export const planSchema = z.object({
  stop: level.nullable().default(null),
  takes: z.array(level.extend({ closePct: z.number().min(1).max(100) })).max(10).default([]),
  breakeven: z.object({ after: z.enum(["off", "tp1", "pct"]), pct: z.number().positive().optional() }).default({ after: "off" }),
  trailing: z.object({ activationPct: z.number().min(0), callbackPct: z.number().positive().max(50) }).nullable().default(null),
  /** Safety orders (averaging): limit adds against the position at growing distances. */
  dca: z.object({
    orders: z.number().int().min(1).max(10),
    stepPct: z.number().positive().max(50),
    stepMult: z.number().min(1).max(3).default(1),
    sizeMult: z.number().min(0.5).max(3).default(1),
  }).nullable().default(null),
}).superRefine((p, ctx) => {
  const sum = p.takes.reduce((s, t) => s + t.closePct, 0);
  if (sum > 100 + 1e-9) ctx.addIssue({ code: "custom", message: "takes_over_100" });
  if (p.breakeven.after === "pct" && !p.breakeven.pct) ctx.addIssue({ code: "custom", message: "breakeven_pct_missing" });
});
export type Plan = z.infer<typeof planSchema>;

const dir = (s: Side) => (s === "long" ? 1 : -1);

/** Price `pct` % away from entry in the profit direction (negative pct = loss direction). */
export const atPct = (side: Side, entry: number, pct: number) => entry * (1 + (dir(side) * pct) / 100);
export const movePct = (side: Side, entry: number, price: number) => ((price - entry) / entry) * 100 * dir(side);

export function stopPrice(plan: Plan, side: Side, entry: number): number | null {
  if (!plan.stop) return null;
  return plan.stop.mode === "price" ? plan.stop.value : atPct(side, entry, -plan.stop.value);
}

export type TakeLevel = { n: number; price: number; closePct: number };
export function takeLevels(plan: Plan, side: Side, entry: number): TakeLevel[] {
  return plan.takes
    .map((t, i) => ({ n: i + 1, price: t.mode === "price" ? t.value : atPct(side, entry, t.value), closePct: t.closePct }))
    .sort((a, b) => dir(side) * (a.price - b.price))
    .map((t, i) => ({ ...t, n: i + 1 }));
}

/**
 * Splits the position into take quantities by %, floored to the lot step.
 * The last take of a 100% plan gets the remainder, so nothing is left dangling.
 */
export function takeQuantities(levels: TakeLevel[], qty: number, step: number | null, floor: (v: number) => number): number[] {
  const total = levels.reduce((s, l) => s + l.closePct, 0);
  const out = levels.map((l) => floor((qty * l.closePct) / 100));
  if (total >= 100 - 1e-9 && out.length) {
    const rest = floor(qty - out.slice(0, -1).reduce((s, v) => s + v, 0));
    out[out.length - 1] = rest;
  }
  void step;
  return out;
}

/** Break-even = the user's own zero: entry plus both fees. Never on the losing side of the entry. */
export const breakevenPrice = (side: Side, entry: number, takerFee: number) => atPct(side, entry, 2 * takerFee * 100);

/** True if `candidate` is a better (tighter, in profit direction) stop than `current`. */
export const isBetterStop = (side: Side, candidate: number, current: number | null) =>
  current === null || dir(side) * (candidate - current) > 0;

/**
 * Trailing: active once price went activationPct in profit; stop trails `callbackPct` behind the best price.
 * Moves only forward, and only by at least minStepPct (no order spam on every tick).
 */
export function trailingStop(o: { side: Side; entry: number; best: number; current: number | null; activationPct: number; callbackPct: number; minStepPct?: number }): number | null {
  if (movePct(o.side, o.entry, o.best) < o.activationPct) return null;
  const cand = o.best * (1 - (dir(o.side) * o.callbackPct) / 100);
  if (!isBetterStop(o.side, cand, o.current)) return null;
  if (o.current !== null && Math.abs(movePct(o.side, o.current, cand)) < (o.minStepPct ?? 0.1)) return null;
  return cand;
}

/** Price crossed the stop (for stops Vektor keeps itself when the exchange has no stop orders). */
export const stopCrossed = (side: Side, stop: number, price: number) => (side === "long" ? price <= stop : price >= stop);

/**
 * Isolated margin needed so that liquidation sits beyond the stop with a buffer.
 * Liq ≈ entry × (1 ∓ (margin/notional − mmr)). Approximation — exchanges add tiers and fees.
 */
export function marginForStop(o: { side: Side; entry: number; stop: number; notional: number; mmr?: number; bufferPct?: number }): number {
  const dist = Math.abs(o.entry - o.stop) / o.entry;
  return o.notional * (dist + (o.mmr ?? 0.005) + (o.bufferPct ?? 0.3) / 100);
}

/** Liquidation is on the near side of the stop (would liquidate before the stop fires). */
export const liqBeforeStop = (side: Side, liq: number | null, stop: number | null) =>
  liq !== null && stop !== null && liq > 0 && (side === "long" ? liq >= stop : liq <= stop);

/** Safety order levels: distance d_i = step × (1 + m + … + m^(i−1)), size = base × sizeMult^i. */
export function dcaLevels(plan: Plan, side: Side, entry: number, baseQty: number): Array<{ n: number; price: number; qty: number; distPct: number }> {
  if (!plan.dca) return [];
  const out = [];
  let dist = 0;
  for (let i = 1; i <= plan.dca.orders; i++) {
    dist += plan.dca.stepPct * Math.pow(plan.dca.stepMult, i - 1);
    out.push({ n: i, price: atPct(side, entry, -dist), qty: baseQty * Math.pow(plan.dca.sizeMult, i), distPct: dist });
  }
  return out;
}

/** Validates a plan against the entry: stop on the loss side, takes on the profit side, stop beyond the last safety order. */
export function planErrors(plan: Plan, side: Side, entry: number): string[] {
  const errs: string[] = [];
  const s = stopPrice(plan, side, entry);
  if (s !== null && movePct(side, entry, s) >= 0) errs.push("stop_wrong_side");
  const lastDca = dcaLevels(plan, side, entry, 1).at(-1);
  if (s !== null && lastDca && movePct(side, entry, s) >= -lastDca.distPct) errs.push("stop_before_dca");
  for (const t of takeLevels(plan, side, entry)) if (movePct(side, entry, t.price) <= 0) { errs.push("take_wrong_side"); break; }
  return errs;
}
