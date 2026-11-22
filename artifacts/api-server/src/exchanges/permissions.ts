/**
 * What the API key is allowed to do. Only some exchanges report it through the API;
 * for the rest "unknown" — the user then confirms that withdrawal is off before connecting.
 * A key that CAN withdraw is never accepted.
 */
export type KeyPermissions = {
  source: "exchange" | "unknown";
  read: boolean | null;
  trade: boolean | null;
  futures: boolean | null;
  withdraw: boolean | null;
  ipRestricted: boolean | null;
  raw?: unknown;
};

const unknown = (): KeyPermissions => ({ source: "unknown", read: null, trade: null, futures: null, withdraw: null, ipRestricted: null });

export async function readPermissions(exchange: string, client: any): Promise<KeyPermissions> {
  try {
    if (exchange === "binance") {
      const r = await client.sapiGetAccountApiRestrictions();
      return {
        source: "exchange", read: Boolean(r.enableReading),
        trade: Boolean(r.enableSpotAndMarginTrading) || Boolean(r.enableFutures),
        futures: Boolean(r.enableFutures), withdraw: Boolean(r.enableWithdrawals), ipRestricted: Boolean(r.ipRestrict),
      };
    }
    if (exchange === "bybit") {
      const r = (await client.privateGetV5UserQueryApi())?.result ?? {};
      const p = r.permissions ?? {};
      const all = Object.values(p).flat().map(String);
      return {
        source: "exchange", read: true, trade: String(r.readOnly) === "0",
        futures: (p.ContractTrade ?? []).length > 0 || (p.Derivatives ?? []).length > 0,
        withdraw: all.some((x) => /withdraw/i.test(x)), ipRestricted: Array.isArray(r.ips) ? !r.ips.includes("*") : null,
      };
    }
    if (exchange === "okx") {
      const r = (await client.privateGetAccountConfig())?.data?.[0] ?? {};
      const perm = String(r.perm ?? "");
      return {
        source: "exchange", read: perm.includes("read_only"), trade: perm.includes("trade"), futures: perm.includes("trade"),
        withdraw: perm.includes("withdraw"), ipRestricted: r.ip ? true : null,
      };
    }
  } catch {
    // Endpoint failed (old key type, regional API) — fall back to asking the user.
  }
  return unknown();
}
