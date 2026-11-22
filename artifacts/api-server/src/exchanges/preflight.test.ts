import { test } from "node:test";
import assert from "node:assert/strict";
import { floorToStep, preflight, roundToTick } from "./preflight";
import { modeParams, orderSide } from "./positionMode";
import type { MarketInfo } from "./market";

const mk: MarketInfo = { symbol: "SOL/USDT:USDT", base: "SOL", quote: "USDT", tick: 0.01, step: 0.1, minAmount: 0.1, minCost: 5, contractSize: 1, maxLeverage: 50, taker: 0.0005, maker: 0.0002 };
const ctx = { last: 100, bid: 99.99, ask: 100.01, freeQuote: 50 };

test("steps never round up", () => {
  assert.equal(floorToStep(1.29999, 0.1), 1.2);
  assert.equal(floorToStep(0.3, 0.1), 0.3);
  assert.equal(roundToTick(100.006, 0.01), 100.01);
});

test("futures: margin × leverage, fee room, min notional", () => {
  const p = preflight({ market: "swap", side: "long", type: "market", amountMode: "usdt", amount: 10, leverage: 10 }, mk, ctx);
  assert.equal(p.ok, true);
  assert.equal(p.qty, 0.9); // 10×10/(1+0.005)/100.01 = 0.994… → 0.9
  assert.ok(p.margin <= 10);
  const small = preflight({ market: "swap", side: "long", type: "market", amountMode: "usdt", amount: 0.4, leverage: 10 }, mk, ctx);
  assert.equal(small.ok, false);
  assert.equal(small.errors[0].code, "below_min_quantity");
});

test("100% of balance never fails on the fee", () => {
  const p = preflight({ market: "swap", side: "short", type: "market", amountMode: "percent", amount: 100, leverage: 5 }, mk, ctx);
  assert.equal(p.ok, true, JSON.stringify(p.errors));
  assert.ok(p.margin + p.fee <= ctx.freeQuote);
});

test("too much margin and too high leverage are explained", () => {
  const p = preflight({ market: "swap", side: "long", type: "limit", price: 95, amountMode: "usdt", amount: 80, leverage: 75 }, mk, ctx);
  const codes = p.errors.map((e) => e.code);
  assert.ok(codes.includes("leverage_too_high"));
  assert.ok(codes.includes("no_funds"));
});

test("limit above market for a long is warned", () => {
  const p = preflight({ market: "swap", side: "long", type: "limit", price: 101, amountMode: "usdt", amount: 10, leverage: 2 }, mk, ctx);
  assert.equal(p.warnings[0]?.code, "limit_above_market");
});

test("spot sell uses the coin you hold", () => {
  const p = preflight({ market: "spot", side: "short", type: "market", amountMode: "percent", amount: 50, leverage: 1 }, { ...mk, symbol: "SOL/USDT" }, { ...ctx, baseFree: 3 });
  assert.equal(p.qty, 1.5);
  const tooMuch = preflight({ market: "spot", side: "short", type: "market", amountMode: "qty", amount: 5 }, { ...mk, symbol: "SOL/USDT" }, { ...ctx, baseFree: 3 });
  assert.equal(tooMuch.errors[0].code, "no_base_funds");
});

test("hedge mode params per exchange", () => {
  assert.deepEqual(modeParams("bingx", true, "long", true), { positionSide: "LONG" });
  assert.deepEqual(modeParams("bybit", true, "short", false), { positionIdx: 2 });
  assert.deepEqual(modeParams("okx", true, "long", true), { posSide: "long", reduceOnly: true });
  assert.deepEqual(modeParams("binance", false, "long", true), { reduceOnly: true });
  assert.equal(orderSide("long", false), "buy");
  assert.equal(orderSide("long", true), "sell");
  assert.equal(orderSide("short", true), "buy");
});
