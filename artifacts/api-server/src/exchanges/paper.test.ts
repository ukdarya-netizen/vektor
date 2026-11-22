/** Needs a throwaway database (DATABASE_URL). Prices are faked; the paper exchange and the engine are real. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { migrate, one, pool, q } from "../db";
import { PaperExchange, resetPaper } from "./paper";
import { createManager } from "../engine/manager";
import { planSchema } from "../engine/plan";

const SYM = "ETH/USDT:USDT";
class Pub {
  precisionMode = 4;
  price = 2000;
  markets: Record<string, any> = { [SYM]: { contractSize: 1, taker: 0.0005, maker: 0.0002 } };
  async loadMarkets() {}
  market(s: string) { return this.markets[s]; }
  amountToPrecision(_s: string, v: number) { return String(Math.floor(v * 1000 + 1e-9) / 1000); }
  priceToPrecision(_s: string, v: number) { return v.toFixed(2); }
  async fetchTicker() { return { last: this.price, bid: this.price - 0.1, ask: this.price + 0.1 }; }
}

test("paper account + engine: open, TP1, break-even, stop; balance adds up", async () => {
  await migrate();
  const u = (await one<{ id: number }>("INSERT INTO vk_users (email) VALUES ($1) RETURNING id", [`p${Date.now()}@x.io`]))!;
  const a = (await one("INSERT INTO vk_exchange_accounts (user_id, exchange, label, market, env, credentials_enc, key_hint, withdraw_check) VALUES ($1,'binance','Демо','swap','paper','x','x','verified_off') RETURNING *", [u.id]))!;
  await resetPaper(a.id, 1000);
  const pub = new Pub();
  const ex = new PaperExchange(a, pub);
  await ex.setLeverage(10, SYM);
  const entry = await ex.createOrder(SYM, "market", "buy", 1, undefined, { positionSide: "LONG" });
  assert.equal(entry.status, "closed");
  let bal = await ex.fetchBalance();
  assert.ok(Math.abs(bal.free.USDT - (1000 - 200.01 - 2000.1 * 0.0005)) < 1e-6, String(bal.free.USDT));

  await q("INSERT INTO vk_positions (user_id, account_id, symbol, side, source, source_label, status, plan, entry_order_id, leverage) VALUES ($1,$2,$3,'long','terminal','Терминал','pending',$4,$5,10)",
    [u.id, a.id, SYM, JSON.stringify(planSchema.parse({ stop: { mode: "pct", value: 3 }, takes: [{ mode: "pct", value: 2, closePct: 50 }, { mode: "pct", value: 5, closePct: 50 }], breakeven: { after: "tp1" } })), entry.id]);
  const msgs: string[] = [];
  const m = createManager({ client: () => ex, notify: async (_u, _k, msg) => { msgs.push(msg.ru); } });
  const acc = { ...a, label: "Демо Binance" };

  await m.cycleAccount(acc);
  let open = await ex.fetchOpenOrders(SYM);
  assert.equal(open.filter((o: any) => o.triggerPrice).length, 1, "stop on the paper book");
  assert.equal(open.filter((o: any) => o.type === "limit").length, 2, "two takes");

  pub.price = 2045; // TP1 at 2040.20 fills
  await m.cycleAccount(acc);
  let pos = await ex.fetchPositions([SYM]);
  assert.equal(pos[0].contracts, 0.5);
  assert.ok(msgs.some((x) => /Тейк 1 исполнен/.test(x)));
  assert.ok(msgs.some((x) => /безубыток/.test(x)));

  pub.price = 2001; // falls through break-even stop (~2002)
  await m.cycleAccount(acc); // paper fills the stop
  await m.cycleAccount(acc); // engine books the close
  pos = await ex.fetchPositions([SYM]);
  assert.equal(pos.length, 0);
  const row = (await one("SELECT * FROM vk_positions WHERE account_id = $1", [a.id]))!;
  assert.equal(row.status, "closed");
  assert.match(row.close_reason, /^stop_breakeven/);
  bal = await ex.fetchBalance();
  // All money is back in free balance; net = 1000 + realized pnl − fees.
  const fees = (await ex.fetchMyTrades(SYM)).reduce((s: number, t: any) => s + t.fee.cost, 0);
  assert.ok(bal.free.USDT > 1000 - fees && bal.free.USDT < 1050, String(bal.free.USDT));
  assert.equal((await ex.fetchOpenOrders(SYM)).length, 0, "nothing left on the book");

  // Liquidation: 20x long, price collapses.
  await ex.setLeverage(20, SYM);
  pub.price = 2000;
  await ex.createOrder(SYM, "market", "buy", 0.2, undefined, { positionSide: "LONG" });
  const liq = (await ex.fetchPositions([SYM]))[0].liquidationPrice;
  pub.price = (liq as number) - 1;
  assert.equal((await ex.fetchPositions([SYM])).length, 0, "liquidated");
  await q("DELETE FROM vk_users WHERE id = $1", [u.id]);
  await pool.end();
});
