/** Needs a throwaway database (DATABASE_URL). The exchange is a fake in memory. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { migrate, one, pool, q } from "../db";
import { createManager } from "./manager";
import { breakevenPrice, takeLevels, takeQuantities, trailingStop, planSchema } from "./plan";

process.env.VEKTOR_MASTER_KEY ||= Buffer.alloc(32, 7).toString("base64");
const SYM = "BTC/USDT:USDT";

class FakeEx {
  id = "bybit";
  has: Record<string, boolean> = { createStopLossOrder: true, addMargin: false };
  markets: Record<string, any> = { [SYM]: { contractSize: 1, taker: 0.0006 } };
  price = 100;
  pos: { side: "long" | "short"; contracts: number; entryPrice: number } | null = null;
  orders = new Map<string, any>();
  trades: any[] = [];
  seq = 1;
  failStop = false;
  t = 1_000_000;
  async loadMarkets() {}
  market(s: string) { return this.markets[s]; }
  amountToPrecision(_s: string, v: number) { return String(Math.floor(v * 1000 + 1e-9) / 1000); }
  priceToPrecision(_s: string, v: number) { return v.toFixed(2); }
  async fetchPositions() {
    return this.pos && this.pos.contracts > 0 ? [{ symbol: SYM, side: this.pos.side, contracts: this.pos.contracts, entryPrice: this.pos.entryPrice, markPrice: this.price, liquidationPrice: 50, leverage: 10, notional: this.pos.contracts * this.price, initialMargin: 10 }] : [];
  }
  async fetchTicker() { return { last: this.price }; }
  private fill(o: any, price: number) {
    o.status = "closed"; o.filled = o.amount;
    this.trades.push({ order: o.id, side: o.side, amount: o.amount, price, timestamp: ++this.t, fee: { cost: o.amount * price * 0.0006 } });
    if (this.pos) this.pos.contracts = Math.round((this.pos.contracts - o.amount) * 1e9) / 1e9;
  }
  async createOrder(_s: string, type: string, side: string, amount: number, price?: number, params: any = {}) {
    if (params.stopLossPrice && this.failStop) throw Object.assign(new Error("trigger rejected"), {});
    const o = { id: String(this.seq++), type, side, amount, price, status: "open", filled: 0, stop: params.stopLossPrice ?? null, params };
    this.orders.set(o.id, o);
    if (type === "market" && !params.stopLossPrice) this.fill(o, this.price);
    return o;
  }
  async cancelOrder(id: string) { const o = this.orders.get(id); if (o && o.status === "open") o.status = "canceled"; }
  async fetchOpenOrders() { return [...this.orders.values()].filter((o) => o.status === "open"); }
  async fetchOrder(id: string) { return this.orders.get(id); }
  async fetchMyTrades() { return this.trades; }
  // Test helpers
  openStops() { return [...this.orders.values()].filter((o) => o.status === "open" && o.stop); }
  openTakes() { return [...this.orders.values()].filter((o) => o.status === "open" && o.type === "limit"); }
  move(p: number) {
    this.price = p;
    for (const o of this.openTakes()) if (p >= o.price) this.fill(o, o.price);
    for (const o of this.openStops()) if (p <= o.stop) this.fill(o, o.stop);
  }
}

test("plan math", () => {
  const plan = planSchema.parse({ takes: [{ mode: "pct", value: 4, closePct: 50 }, { mode: "pct", value: 2, closePct: 50 }] });
  const lv = takeLevels(plan, "short", 100);
  assert.deepEqual(lv.map((l) => [l.n, l.price]), [[1, 98], [2, 96]]); // nearest first
  assert.deepEqual(takeQuantities(lv, 0.999, null, (v) => Math.floor(v * 1000) / 1000), [0.499, 0.5]);
  assert.ok(breakevenPrice("long", 100, 0.0006) > 100);
  assert.ok(breakevenPrice("short", 100, 0.0006) < 100);
  assert.equal(trailingStop({ side: "long", entry: 100, best: 102, current: 98, activationPct: 3, callbackPct: 1 }), null);
  assert.equal(trailingStop({ side: "long", entry: 100, best: 104, current: 98, activationPct: 3, callbackPct: 1 }), 102.96);
  assert.equal(trailingStop({ side: "long", entry: 100, best: 104, current: 103, activationPct: 3, callbackPct: 1 }), null); // never backwards
});

async function setup(ex: FakeEx, plan: unknown) {
  await migrate();
  const u = (await one<{ id: number }>("INSERT INTO vk_users (email) VALUES ($1) RETURNING id", [`e${Date.now()}${Math.random()}@x.io`]))!;
  const a = (await one("INSERT INTO vk_exchange_accounts (user_id, exchange, label, market, env, credentials_enc, key_hint, withdraw_check) VALUES ($1,'bybit','Bybit Futures','swap','live','x','x','verified_off') RETURNING *", [u.id]))!;
  const p = (await one("INSERT INTO vk_positions (user_id, account_id, symbol, side, source, source_label, status, plan, leverage) VALUES ($1,$2,$3,'long','terminal','Терминал','pending',$4,10) RETURNING id", [u.id, a.id, SYM, JSON.stringify(planSchema.parse(plan))]))!;
  ex.pos = { side: "long", contracts: 1, entryPrice: 100 };
  const msgs: Array<{ kind: string; text: string }> = [];
  const m = createManager({ client: () => ex, notify: async (_u, kind, msg) => { msgs.push({ kind, text: msg.ru }); } });
  const row = async () => (await one("SELECT * FROM vk_positions WHERE id = $1", [p.id]))!;
  return { a: { ...a, label: "Bybit Futures" }, m, msgs, row, cleanup: () => q("DELETE FROM vk_users WHERE id = $1", [u.id]) };
}

test("open → TP1 → break-even → trailing → trailing stop hit, named honestly", async () => {
  const ex = new FakeEx();
  const s = await setup(ex, {
    stop: { mode: "pct", value: 2 },
    takes: [{ mode: "pct", value: 2, closePct: 50 }, { mode: "pct", value: 6, closePct: 50 }],
    breakeven: { after: "tp1" }, trailing: { activationPct: 3, callbackPct: 1 },
  });
  await s.m.cycleAccount(s.a);
  let r = await s.row();
  assert.equal(r.status, "open");
  assert.equal(Number(r.stop_price), 98);
  assert.deepEqual(ex.openTakes().map((o) => [o.price, o.amount]), [[102, 0.5], [106, 0.5]]);
  assert.equal(ex.openStops()[0].amount, 1);
  assert.match(s.msgs[0].text, /Открыт лонг: вход 100/);

  ex.move(102); // TP1 fills
  await s.m.cycleAccount(s.a);
  r = await s.row();
  assert.equal(Number(r.qty), 0.5);
  assert.equal(ex.openStops().length, 1);
  assert.equal(ex.openStops()[0].amount, 0.5);
  assert.equal(Number(r.stop_price), 100.12); // own zero: entry + 2 × 0.06% fees
  assert.equal(r.stop_kind, "breakeven");
  assert.ok(s.msgs.some((m) => /Тейк 1 исполнен/.test(m.text)));
  assert.ok(s.msgs.some((m) => /Стоп перенесён в безубыток/.test(m.text)));

  ex.move(103.5); // trailing activates (3.5% ≥ 3%)
  await s.m.cycleAccount(s.a);
  r = await s.row();
  assert.equal(r.stop_kind, "trailing");
  assert.equal(Number(r.stop_price), 102.47);
  assert.ok(s.msgs.some((m) => /Трейлинг-стоп подтянут/.test(m.text)));

  ex.move(102.0); // falls through the trailed stop
  await s.m.cycleAccount(s.a);
  r = await s.row();
  assert.equal(r.status, "closed");
  assert.equal(r.close_reason, "stop_trailing_profit");
  assert.ok(ex.openTakes().length === 0, "leftover take cancelled");
  const closed = s.msgs.at(-1)!.text;
  assert.match(closed, /Позиция закрыта\. Сработал трейлинг-стоп — прибыль зафиксирована/);
  assert.match(closed, /средний выход по всем частям 102\.235/);
  assert.match(closed, /Итог в плюсе: \+2\.2\d% цены · \+2\.17 USDT чистыми \(комиссии 0\.06\) — с учётом частичных закрытий/);
  await s.cleanup();
});

test("stop cannot be placed → position closed at market, critical message", async () => {
  const ex = new FakeEx();
  ex.failStop = true;
  const s = await setup(ex, { stop: { mode: "pct", value: 2 } });
  await s.m.cycleAccount(s.a);
  const r = await s.row();
  assert.equal(r.status, "closed");
  assert.equal(r.close_reason, "protection_failed");
  assert.equal(ex.pos!.contracts, 0);
  assert.ok(s.msgs.some((m) => m.kind === "protection_failed" && /Стоп не удалось выставить/.test(m.text)));
  await s.cleanup();
});

test("stop cancelled by hand on the exchange → put back", async () => {
  const ex = new FakeEx();
  const s = await setup(ex, { stop: { mode: "pct", value: 2 } });
  await s.m.cycleAccount(s.a);
  const first = ex.openStops()[0];
  await ex.cancelOrder(first.id);
  await s.m.cycleAccount(s.a);
  assert.equal(ex.openStops().length, 1);
  assert.notEqual(ex.openStops()[0].id, first.id);
  assert.ok(s.msgs.some((m) => /Стоп-ордер пропал с биржи/.test(m.text)));
  await s.cleanup();
  await pool.end();
});
