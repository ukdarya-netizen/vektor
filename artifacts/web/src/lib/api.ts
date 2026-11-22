export class ApiError extends Error {
  constructor(public status: number, public code: string, public body: any) {
    super(code);
  }
}

const BASE = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/api`;

export async function api<T = any>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers: init.body !== undefined ? { "content-type": "application/json" } : undefined,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    credentials: "include",
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body?.error ?? `http_${res.status}`, body);
  return body as T;
}

export type User = { id: number; email: string; lang: "ru" | "en"; tz: string; onboarded: boolean };

export type ExchangeInfo = {
  id: string; name: string; priority: boolean; verified: boolean; fields: string[];
  spot: boolean; swap: boolean; testnet: boolean; positions: boolean; www: string | null; tradable: boolean;
};

export type Account = {
  id: number; exchange: string; label: string; market: "spot" | "swap"; env: "live" | "testnet" | "paper"; key_hint: string;
  permissions: { source: "exchange" | "unknown"; withdraw: boolean | null; trade: boolean | null; futures: boolean | null; ipRestricted: boolean | null };
  withdraw_check: "verified_off" | "user_confirmed"; status: "ok" | "error" | "paused";
  last_check_at: string | null; last_error: string | null; created_at: string;
};

export type Position = {
  accountId: number; symbol: string; coin: string; side: "long" | "short"; size: number;
  entryPrice: number | null; markPrice: number | null; notional: number | null; unrealizedPnl: number | null; pnlPct: number | null;
  leverage: number | null; marginMode: string | null; liquidationPrice: number | null; margin: number | null;
};

export type Snapshot = {
  accountId: number; at: string; totalUsd: number; unpriced: string[]; unrealizedPnl: number;
  balances: Array<{ asset: string; total: number; free: number; used: number; usd: number | null }>;
  positions: Position[]; error: { code: string; message: string } | null;
  account: { id: number; label: string; exchange: string; market: "spot" | "swap"; env: "live" | "testnet" | "paper" };
};
