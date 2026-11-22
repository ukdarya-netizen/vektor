import { Router } from "express";
import { z } from "zod";
import { one, q } from "../db";
import { encrypt, keyHint } from "../crypto";
import { catalog, catalogItem } from "../exchanges/catalog";
import { dropClient, exchangeError, makeClient, type AccountRow, type Credentials } from "../exchanges/client";
import { readPermissions, type KeyPermissions } from "../exchanges/permissions";
import { snapshot } from "../exchanges/snapshot";
import { resetPaper } from "../exchanges/paper";
import { requireUser, userOf, type AuthedRequest } from "./auth";
import { notify } from "../telegram/notify";
import { T } from "../telegram/texts";

export const accountsRouter = Router();

accountsRouter.get("/exchanges", (_req, res) => {
  res.json({ exchanges: catalog() });
});

accountsRouter.use(requireUser);

const PUBLIC_COLS = "id, exchange, label, market, env, key_hint, permissions, withdraw_check, status, last_check_at, last_error, created_at";

accountsRouter.get("/accounts", async (req, res) => {
  const user = userOf(req);
  res.json({ accounts: await q(`SELECT ${PUBLIC_COLS} FROM vk_exchange_accounts WHERE user_id = $1 ORDER BY id`, [user.id]) });
});

const credsSchema = z.object({
  apiKey: z.string().trim().max(512).optional(),
  secret: z.string().trim().max(4096).optional(),
  password: z.string().trim().max(512).optional(),
  uid: z.string().trim().max(256).optional(),
  privateKey: z.string().trim().max(4096).optional(),
  walletAddress: z.string().trim().max(256).optional(),
  login: z.string().trim().max(256).optional(),
  twofa: z.string().trim().max(256).optional(),
  token: z.string().trim().max(4096).optional(),
});

/** Paper account: real prices of `exchange`, simulated money. No keys. */
accountsRouter.post("/accounts/paper", async (req, res) => {
  const user = userOf(req);
  const b = z.object({ exchange: z.string(), market: z.enum(["spot", "swap"]), startUsdt: z.number().min(10).max(10_000_000).default(10_000), label: z.string().trim().max(60).optional() }).safeParse(req.body);
  if (!b.success) { res.status(400).json({ error: "bad_request" }); return; }
  const item = catalogItem(b.data.exchange);
  if (!item || (b.data.market === "swap" ? !item.swap : !item.spot)) { res.status(400).json({ error: "market_not_supported" }); return; }
  const label = b.data.label || `${user.lang === "en" ? "Paper" : "Демо"} ${item.name}${b.data.market === "swap" ? " Futures" : " Spot"}`;
  const row = await one(`INSERT INTO vk_exchange_accounts (user_id, exchange, label, market, env, credentials_enc, key_hint, withdraw_check, permissions)
    VALUES ($1, $2, $3, $4, 'paper', $5, '—', 'verified_off', '{"source":"exchange","withdraw":false,"trade":true}') RETURNING ${PUBLIC_COLS}`,
    [user.id, item.id, label, b.data.market, encrypt("{}")]);
  await resetPaper(row!.id, b.data.startUsdt);
  res.json({ account: row });
});

accountsRouter.post("/accounts/:id/paper-reset", async (req, res) => {
  const user = userOf(req);
  const a = await one("SELECT id FROM vk_exchange_accounts WHERE id = $1 AND user_id = $2 AND env = 'paper'", [Number(req.params.id), user.id]);
  if (!a) { res.status(404).json({ error: "not_found" }); return; }
  const usdt = Math.min(10_000_000, Math.max(10, Number(req.body?.startUsdt ?? 10_000)));
  // Managed positions of this account are closed in the books (the simulated money is gone).
  await q("UPDATE vk_positions SET status = 'closed', close_reason = 'paper_reset', closed_at = now() WHERE account_id = $1 AND status <> 'closed'", [a.id]);
  await resetPaper(a.id, usdt);
  res.json({ ok: true });
});

const addSchema = z.object({
  exchange: z.string(),
  label: z.string().trim().min(1).max(60).optional(),
  market: z.enum(["spot", "swap"]),
  env: z.enum(["live", "testnet"]).default("live"),
  credentials: credsSchema,
  /** Required when the exchange does not report key permissions. */
  confirmNoWithdraw: z.boolean().optional(),
});

/**
 * Connect = check, then save. Nothing is stored unless the key works, and a key that can
 * withdraw is refused. Order: balance (key works) → permissions → save.
 */
accountsRouter.post("/accounts", async (req, res) => {
  const user = userOf(req);
  const p = addSchema.safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: "bad_request" }); return; }
  const b = p.data;
  const item = catalogItem(b.exchange);
  if (!item || !item.tradable) { res.status(400).json({ error: "unknown_exchange" }); return; }
  if (b.market === "swap" && !item.swap) { res.status(400).json({ error: "market_not_supported" }); return; }
  if (b.market === "spot" && !item.spot) { res.status(400).json({ error: "market_not_supported" }); return; }
  const creds: Credentials = {};
  for (const f of item.fields) {
    const v = (b.credentials as any)[f];
    if (!v) { res.status(400).json({ error: "missing_field", field: f }); return; }
    (creds as any)[f] = v;
  }

  let client: any;
  try {
    client = makeClient(item.id, b.market, b.env, creds);
    await client.fetchBalance();
  } catch (e) {
    res.status(400).json({ error: "key_check_failed", exchangeError: exchangeError(e) }); return;
  }
  const perms: KeyPermissions = await readPermissions(item.id, client);
  if (perms.withdraw === true) { res.status(400).json({ error: "withdraw_enabled", permissions: perms }); return; }
  if (perms.trade === false) { res.status(400).json({ error: "trade_disabled", permissions: perms }); return; }
  if (perms.source === "unknown" && !b.confirmNoWithdraw) {
    res.status(409).json({ error: "confirm_no_withdraw", permissions: perms }); return;
  }

  const count = await one<{ n: number }>("SELECT count(*)::int AS n FROM vk_exchange_accounts WHERE user_id = $1 AND exchange = $2", [user.id, item.id]);
  const label = b.label ?? `${item.name}${b.market === "swap" ? " Futures" : " Spot"}${b.env === "testnet" ? " Testnet" : ""}${count?.n ? ` ${count.n + 1}` : ""}`;
  const row = await one(
    `INSERT INTO vk_exchange_accounts (user_id, exchange, label, market, env, credentials_enc, key_hint, permissions, withdraw_check, status, last_check_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'ok', now()) RETURNING ${PUBLIC_COLS}`,
    [user.id, item.id, label, b.market, b.env, encrypt(JSON.stringify(creds)), keyHint(creds.apiKey ?? creds.walletAddress ?? creds.privateKey ?? ""),
      JSON.stringify(perms), perms.source === "exchange" ? "verified_off" : "user_confirmed"]);
  res.json({ account: row });
});

accountsRouter.patch("/accounts/:id", async (req, res) => {
  const user = userOf(req);
  const b = z.object({ label: z.string().trim().min(1).max(60).optional(), paused: z.boolean().optional() }).safeParse(req.body);
  if (!b.success) { res.status(400).json({ error: "bad_request" }); return; }
  const row = await one(
    `UPDATE vk_exchange_accounts SET label = COALESCE($3, label),
       status = CASE WHEN $4::boolean IS NULL THEN status WHEN $4 THEN 'paused' ELSE 'ok' END
     WHERE id = $1 AND user_id = $2 RETURNING ${PUBLIC_COLS}`,
    [Number(req.params.id), user.id, b.data.label ?? null, b.data.paused ?? null]);
  if (!row) { res.status(404).json({ error: "not_found" }); return; }
  res.json({ account: row });
});

accountsRouter.delete("/accounts/:id", async (req, res) => {
  const user = userOf(req);
  const row = await one("DELETE FROM vk_exchange_accounts WHERE id = $1 AND user_id = $2 RETURNING id", [Number(req.params.id), user.id]);
  if (!row) { res.status(404).json({ error: "not_found" }); return; }
  dropClient(Number(row.id));
  res.json({ ok: true });
});

/** Re-checks the key now: works? permissions changed? Notifies on a change of state. */
accountsRouter.post("/accounts/:id/check", async (req, res) => {
  const user = userOf(req);
  const a = await one<AccountRow & { status: string; label: string }>("SELECT * FROM vk_exchange_accounts WHERE id = $1 AND user_id = $2", [Number(req.params.id), user.id]);
  if (!a) { res.status(404).json({ error: "not_found" }); return; }
  const result = await checkAccount(a);
  res.json(result);
});

export async function checkAccount(a: AccountRow & { status: string; label: string }) {
  const snap = await snapshot(a, true);
  let perms: KeyPermissions | null = null;
  let status: "ok" | "error" = snap.error ? "error" : "ok";
  let lastError = snap.error?.message ?? null;
  if (!snap.error && a.env !== "paper") {
    const { clientFor } = await import("../exchanges/client");
    perms = await readPermissions(a.exchange, clientFor(a));
    if (perms.withdraw === true) { status = "error"; lastError = "withdraw_enabled"; }
  }
  if (a.status !== "paused") {
    await q(`UPDATE vk_exchange_accounts SET status = $2, last_error = $3, last_check_at = now(),
             permissions = COALESCE($4::jsonb, permissions) WHERE id = $1`,
      [a.id, status, lastError, perms && perms.source === "exchange" ? JSON.stringify(perms) : null]);
    if (a.status !== status) {
      await notify(a.user_id, status === "ok" ? "exchange_restored" : "exchange_problem",
        status === "ok" ? T.exchangeRestored(a.label) : T.exchangeProblem(a.label, lastError === "withdraw_enabled" ? "withdraw" : snap.error?.code ?? "exchange"));
    }
  }
  return { status, error: snap.error, permissions: perms };
}

/** Portfolio: every account's balances, valued in USD, with errors shown per account. */
accountsRouter.get("/portfolio", async (req, res) => {
  const user = userOf(req);
  const accounts = await q<AccountRow & { status: string }>("SELECT * FROM vk_exchange_accounts WHERE user_id = $1 ORDER BY id", [user.id]);
  const snaps = await Promise.all(accounts.map((a) => snapshot(a)));
  res.json({
    at: new Date().toISOString(),
    totalUsd: snaps.reduce((s, x) => s + x.totalUsd, 0),
    unrealizedPnl: snaps.reduce((s, x) => s + x.unrealizedPnl, 0),
    accounts: snaps.map((s, i) => ({ ...s, account: { id: accounts[i].id, label: accounts[i].label, exchange: accounts[i].exchange, market: accounts[i].market, env: accounts[i].env } })),
  });
});

accountsRouter.get("/positions", async (req, res) => {
  const user = userOf(req);
  const accounts = await q<AccountRow>("SELECT * FROM vk_exchange_accounts WHERE user_id = $1 AND market = 'swap' AND status <> 'paused' ORDER BY id", [user.id]);
  const snaps = await Promise.all(accounts.map((a) => snapshot(a)));
  res.json({
    at: new Date().toISOString(),
    positions: snaps.flatMap((s) => s.positions),
    errors: snaps.filter((s) => s.error).map((s) => ({ accountId: s.accountId, ...s.error })),
  });
});
