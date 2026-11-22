import { test } from "node:test";
import assert from "node:assert/strict";
import { matchSymbol, parseSignal } from "./parse";
import { evaluateRisk, NO_LIMITS } from "../engine/risk";
import { dcaLevels, planErrors, planSchema } from "../engine/plan";

const mk = [{ symbol: "BTC/USDT:USDT", base: "BTC" }, { symbol: "1000PEPE/USDT:USDT", base: "1000PEPE" }, { symbol: "SOL/USDT:USDT", base: "SOL" }];

test("symbols from TradingView tickers", () => {
  assert.equal(matchSymbol("BINANCE:BTCUSDT.P", mk), "BTC/USDT:USDT");
  assert.equal(matchSymbol("BTCUSDT", mk), "BTC/USDT:USDT");
  assert.equal(matchSymbol("BTC-USDT-SWAP", mk), "BTC/USDT:USDT");
  assert.equal(matchSymbol("PEPEUSDT", mk), "1000PEPE/USDT:USDT");
  assert.equal(matchSymbol("SOL/USDT:USDT", mk), "SOL/USDT:USDT");
  assert.equal(matchSymbol("DOGEUSDT", mk), null);
});

test("JSON signals", () => {
  const r = parseSignal('{"action":"open","side":"buy","symbol":"BYBIT:SOLUSDT.P","id":"x1","sl":"2%","tp":["2%","68000"],"leverage":"20"}');
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.signal.side, "long");
  assert.deepEqual(r.signal.overrides.sl, { mode: "pct", value: 2 });
  assert.deepEqual(r.signal.overrides.tp, [{ mode: "pct", value: 2 }, { mode: "price", value: 68000 }]);
  assert.equal(r.signal.overrides.leverage, 20);
  // TradingView strategy placeholders
  const s = parseSignal('{"ticker":"BTCUSDT","action":"sell","market_position":"flat"}');
  assert.ok(s.ok && s.signal.action === "close" && s.signal.side === "long");
  assert.equal(parseSignal('{"symbol":"BTCUSDT"}').ok, false); // no side for an open → rejected, not guessed
  assert.equal(parseSignal("{bad").ok, false);
});

test("text signals", () => {
  const a = parseSignal("long BINANCE:BTCUSDT.P");
  assert.ok(a.ok && a.signal.side === "long" && a.signal.symbol === "BINANCE:BTCUSDT.P");
  const b = parseSignal("close ETHUSDT");
  assert.ok(b.ok && b.signal.action === "close" && b.signal.side === null);
  assert.equal(parseSignal("hello").ok, false);
});

test("risk limits", () => {
  const base = { margin: 10, leverage: 10, openPositions: 0, lossToday: 0 };
  assert.equal(evaluateRisk(NO_LIMITS, base), null);
  assert.equal(evaluateRisk({ ...NO_LIMITS, killSwitch: true }, base)?.code, "kill_switch");
  assert.equal(evaluateRisk({ ...NO_LIMITS, maxLeverage: 5 }, base)?.code, "max_leverage");
  assert.equal(evaluateRisk({ ...NO_LIMITS, maxMarginPerTrade: 5 }, base)?.code, "max_margin");
  assert.equal(evaluateRisk({ ...NO_LIMITS, maxOpenPositions: 3 }, { ...base, openPositions: 3 })?.code, "max_positions");
  assert.equal(evaluateRisk({ ...NO_LIMITS, dailyLossLimit: 50 }, { ...base, lossToday: 50 })?.code, "daily_loss");
});

test("DCA levels and the stop beyond them", () => {
  const plan = planSchema.parse({ stop: { mode: "pct", value: 5 }, dca: { orders: 3, stepPct: 1, stepMult: 1.5, sizeMult: 2 } });
  const l = dcaLevels(plan, "long", 100, 1);
  assert.deepEqual(l.map((x) => [x.n, Number(x.price.toFixed(2)), x.qty]), [[1, 99, 2], [2, 97.5, 4], [3, 95.25, 8]]);
  assert.deepEqual(planErrors(plan, "long", 100), []); // stop 5% is beyond the last safety order (4.75%)
  assert.deepEqual(planErrors({ ...plan, stop: { mode: "pct", value: 4 } }, "long", 100), ["stop_before_dca"]);
});

test("provider posts from Telegram channels", () => {
  const a = parseSignal("🟢 #BTC LONG\nEntry: 65000-65200\nTP1: 66000\nTP2: 67000\nSL: 64000\nLeverage 10x");
  assert.ok(a.ok);
  if (!a.ok) return;
  assert.equal(a.signal.side, "long");
  assert.equal(a.signal.symbol, "BTCUSDT");
  assert.deepEqual(a.signal.overrides.tp, [{ mode: "price", value: 66000 }, { mode: "price", value: 67000 }]);
  assert.deepEqual(a.signal.overrides.sl, { mode: "price", value: 64000 });
  assert.equal(a.signal.overrides.leverage, 10);
  const b = parseSignal("Шорт $SOLUSDT\nЦели: 140 / 135\nСтоп 155");
  assert.ok(b.ok && b.signal.side === "short");
  if (b.ok) assert.deepEqual(b.signal.overrides.tp?.map((x) => x.value), [140, 135]);
  const c = parseSignal("#ETH closed in profit ✅ +12%");
  assert.ok(c.ok && c.signal.action === "close");
  assert.equal(parseSignal("Доброе утро! Рынок сегодня спокойный.").ok, false);
});
