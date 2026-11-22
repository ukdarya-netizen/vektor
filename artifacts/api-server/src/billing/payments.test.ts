/** Needs a throwaway database. TronGrid is faked. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { migrate, one, pool, q } from "../db";
import { checkPayments, createInvoice, fromMicro, toMicro, USDT_TRC20 } from "./payments";
import { price } from "./products";

process.env.PAY_TRC20_ADDRESS = "TWalletTestAddress000000000000000";

test("prices: 50/mo terminal, 100/mo bots, −10% for 3, −20% for 12", () => {
  assert.equal(price("terminal", 1), 50);
  assert.equal(price("terminal", 3), 135);
  assert.equal(price("terminal", 12), 480);
  assert.equal(price("bot:cab:access", 3), 270);
  assert.equal(price("bot:nihilist:auto", 12), 960);
});

test("exact unique amount pays the invoice once; other amounts stay unmatched", async () => {
  await migrate();
  const u = (await one<{ id: number }>("INSERT INTO vk_users (email) VALUES ($1) RETURNING id", [`pay${Date.now()}@x.io`]))!;
  const inv = await createInvoice(u.id, [{ product: "terminal", months: 3 }]);
  assert.ok(inv.amount > 135 && inv.amount < 136, String(inv.amount));
  const now = Date.now() + 1000;
  const tx = (hash: string, amount: number, from = "TPayer") => ({ transaction_id: hash, from, to: process.env.PAY_TRC20_ADDRESS, value: String(toMicro(amount)), block_timestamp: now, token_info: { address: USDT_TRC20 } });
  const h1 = `a${Date.now()}`.padEnd(64, "0"), h2 = `b${Date.now()}`.padEnd(64, "0");
  const fake: any = async () => ({ ok: true, json: async () => ({ data: [tx(h1, inv.amount - 1), tx(h2, inv.amount)], meta: {} }) });
  const r1 = await checkPayments(fake);
  assert.deepEqual(r1, { matched: 1, unmatched: 1 });
  const paid = await one("SELECT status, tx_hash FROM vk_invoices WHERE id = $1", [inv.id]);
  assert.equal(paid!.status, "paid");
  assert.equal(paid!.tx_hash, h2);
  const user = await one("SELECT plan, plan_until FROM vk_users WHERE id = $1", [u.id]);
  assert.equal(user!.plan, "pro");
  assert.ok(new Date(user!.plan_until).getTime() > Date.now() + 80 * 86_400_000);
  // The same transfers seen again change nothing.
  assert.deepEqual(await checkPayments(fake), { matched: 0, unmatched: 0 });
  const un = await one("SELECT status, amount_micro FROM vk_incoming WHERE tx_hash = $1", [h1]);
  assert.equal(un!.status, "unmatched");
  assert.equal(fromMicro(un!.amount_micro), Number((inv.amount - 1).toFixed(6)));
  await q("DELETE FROM vk_incoming WHERE tx_hash = ANY($1)", [[h1, h2]]);
  await q("DELETE FROM vk_invoices WHERE user_id = $1", [u.id]);
  await q("DELETE FROM vk_users WHERE id = $1", [u.id]);
  await pool.end();
});
