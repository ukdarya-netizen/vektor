import ccxt from "ccxt";
import { decrypt } from "../crypto";
import { PaperExchange } from "./paper";

export type Market = "spot" | "swap";
export type Env = "live" | "testnet" | "paper";
export type Credentials = Partial<Record<"apiKey" | "secret" | "password" | "uid" | "privateKey" | "walletAddress" | "login" | "twofa" | "token", string>>;

export type AccountRow = {
  id: number;
  user_id: number;
  exchange: string;
  label: string;
  market: Market;
  env: Env;
  credentials_enc: string;
};

/** A CCXT client for one account. defaultType decides spot vs USDT-perpetual endpoints. */
export function makeClient(exchange: string, market: Market, env: Env, creds: Credentials): any {
  const Ex = (ccxt as any)[exchange];
  if (!Ex) throw new Error(`unknown exchange ${exchange}`);
  const e = new Ex({
    ...creds,
    enableRateLimit: true,
    timeout: 15_000,
    options: { defaultType: market, adjustForTimeDifference: true },
  });
  if (env === "testnet") {
    if (!e.urls?.test) throw new Error("testnet_not_supported");
    e.setSandboxMode(true);
  }
  return e;
}

const clients = new Map<number, { enc: string; client: any }>();

/** One client per account (keeps rate limiter and loaded markets); rebuilt if the key changed. */
export function clientFor(a: AccountRow): any {
  if (a.env === "paper") {
    const c = clients.get(a.id);
    if (c) return c.client;
    const client = new PaperExchange(a);
    clients.set(a.id, { enc: a.credentials_enc, client });
    return client;
  }
  const c = clients.get(a.id);
  if (c && c.enc === a.credentials_enc) return c.client;
  const client = makeClient(a.exchange, a.market, a.env, JSON.parse(decrypt(a.credentials_enc)));
  clients.set(a.id, { enc: a.credentials_enc, client });
  return client;
}

export const dropClient = (id: number) => clients.delete(id);

/** Human, short error text from a CCXT error (no secrets: CCXT messages carry no keys). */
export function exchangeError(e: unknown): { code: string; message: string } {
  const name = (e as any)?.constructor?.name ?? "Error";
  const msg = String((e as any)?.message ?? e).slice(0, 300);
  const code =
    name === "AuthenticationError" ? "auth" :
    name === "PermissionDenied" ? "permission" :
    name === "AccountSuspended" ? "suspended" :
    name === "InsufficientFunds" ? "funds" :
    name === "InvalidOrder" ? "invalid_order" :
    name === "RateLimitExceeded" || name === "DDoSProtection" ? "rate_limit" :
    name === "RequestTimeout" || name === "NetworkError" || name === "ExchangeNotAvailable" ? "network" :
    name === "OnMaintenance" ? "maintenance" :
    msg === "testnet_not_supported" ? "testnet_not_supported" :
    "exchange";
  return { code, message: msg };
}
