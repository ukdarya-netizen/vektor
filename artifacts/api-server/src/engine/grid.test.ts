/** Needs a throwaway database. Grid on a paper account with faked prices. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { migrate, one, pool, q } from "../db";
import { PaperExchange, resetPaper } from "../exchanges/paper";
import { gridLevels, gridSettingsSchema, startGrid, stopGrid, tickGrid } from "./grid";

const SYM = "SOL/USDT";
class Pub {
  precisionMode = 4; price = 100;
  markets: Record<string, any> = { [SYM]: { contractSize: 1, taker: 0.001, maker: 0.001 } };
  async loadMarkets() {}
  market(s: string) { return this.markets[s]; }
  amountToPrecision(_s: string, v: number) { return String(Math.floor(v * 100 + 1e-9) / 100); }
  priceToPrecision(_s: string, v: number) { return v.toFixed(2); }
  async fetchTicker() { return { last: this.price, bid: this.price, ask: this.price }; }
}

test("grid levels", () => {
  assert.deepEqual(gridLevels({ lower: 90, upper: 110, levels: 4, spacing: "arithmetic" }), [90, 95, 100, 105, 110]);
  const g = gridLevels({ lower: 100, upper: 400, levels: 2, spacing: "geometric" });
  assert.ok(Math.abs(g[1] - 200) < 1e-9);
});

test("spot grid on a paper account: a buy then a sell is one round", async () => {
  await migrate();
  const u = (await one<{ id: number }>("INSERT INTO vk_users (email) VALUES ($1) RETURNING id", [`g${Date.now()}@x.io`]))!;
  const a = (await one("INSERT INTO vk_exchange_accounts (user_id, exchange, label, market, env, credentials_enc, key_hint, withdraw_check) VALUES ($1,'binance','Демо спот','spot','paper','x','x','verified_off') RETURNING *", [u.id]))!;
  await resetPaper(a.id, 1000);
  const pub = new Pub();
  const ex = new PaperExchange(a, pub);
  const settings = gridSettingsSchema.parse({ symbol: SYM, lower: 90, upper: 110, levels: 4, investUsdt: 500, stopLower: 80 });
  const g = (await one("INSERT INTO vk_grids (user_id, account_id, name, settings) VALUES ($1,$2,'test',$3) RETURNING *", [u.id, a.id, JSON.stringify(settings)]))!;
  pub.price = 101;
  await startGrid({ ...g, settings }, { ...a, label: "Демо" }, ex);
  let row = (await one("SELECT * FROM vk_grids WHERE id = $1", [g.id]))!;
  const st = row.state;
  assert.deepEqual(st.orders.map((o: any) => [o.side, o.price]).sort(), [["buy", 100], ["buy", 90], ["buy", 95], ["sell", 105], ["sell", 110]].sort());
  pub.price = 99.5; // buy at 100 fills
  await tickGrid({ ...row, settings }, { ...a, label: "Демо" }, ex);
  row = (await one("SELECT * FROM vk_grids WHERE id = $1", [g.id]))!;
  assert.ok(row.state.orders.some((o: any) => o.side === "sell" && o.price === 105 && o.level === 3), "sell placed one level up");
  pub.price = 105.5; // both sells at 105 fill
  await tickGrid({ ...row, settings }, { ...a, label: "Демо" }, ex);
  row = (await one("SELECT * FROM vk_grids WHERE id = $1", [g.id]))!;
  assert.ok(row.state.rounds >= 1);
  assert.ok(row.state.realized > 0);
  pub.price = 79; // below the stop
  await tickGrid({ ...row, settings }, { ...a, label: "Демо" }, ex);
  row = (await one("SELECT * FROM vk_grids WHERE id = $1", [g.id]))!;
  assert.equal(row.status, "stopped");
  assert.equal(row.stop_reason, "stop_lower");
  assert.equal((await ex.fetchOpenOrders(SYM)).length, 0);
  const bal = await ex.fetchBalance();
  assert.ok(!bal.total.SOL || bal.total.SOL < 0.01, "coin sold on stop");
  void stopGrid;
  await q("DELETE FROM vk_users WHERE id = $1", [u.id]);
  await pool.end();
});
