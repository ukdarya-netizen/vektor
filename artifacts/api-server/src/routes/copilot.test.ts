import { test } from "node:test";
import assert from "node:assert/strict";
import { askModel, TOOLS } from "./copilot";

test("copilot: request shape and tool call extraction (fake API)", async () => {
  process.env.ANTHROPIC_API_KEY = "test";
  let sent: any = null;
  const fake = async (_url: string, init: any) => {
    sent = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "ok" }, { type: "tool_use", name: "open_position", input: { accountId: 1, coin: "SOL", side: "long", amountUsdt: 20 } }] }) };
  };
  const r = await askModel("лонг соль на 20", "{}", "ru", fake);
  assert.equal(r.name, "open_position");
  assert.equal(r.input.coin, "SOL");
  assert.deepEqual(sent.tool_choice, { type: "any" });
  assert.equal(sent.tools.length, TOOLS.length);
  assert.match(sent.system, /Never invent a position size/);
  delete process.env.ANTHROPIC_API_KEY;
  await assert.rejects(() => askModel("x", "{}", "ru", fake), /copilot_not_configured/);
});
