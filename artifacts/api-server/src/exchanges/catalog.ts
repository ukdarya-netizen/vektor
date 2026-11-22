import ccxt from "ccxt";

/**
 * Every exchange CCXT supports, with the fields its API key form needs.
 * PRIORITY exchanges get native extensions (permission check now; WS orders, native trailing later)
 * and are shown first. "verified" stays false until the exchange passes the full test list
 * (ТЗ Мануса §14.1) — the UI then shows «Проверена».
 */
export const PRIORITY = ["bingx", "binance", "bybit", "okx", "bitget", "gate", "mexc", "kucoin", "htx"] as const;
export const VERIFIED = new Set<string>([]);

export type CredField = "apiKey" | "secret" | "password" | "uid" | "privateKey" | "walletAddress" | "login" | "twofa" | "token";

export type CatalogItem = {
  id: string;
  name: string;
  priority: boolean;
  verified: boolean;
  fields: CredField[];
  spot: boolean;
  swap: boolean;
  testnet: boolean;
  positions: boolean;
  www: string | null;
  /** Exchange marked the market as having no private trading API in CCXT. */
  tradable: boolean;
};

let cache: CatalogItem[] | null = null;

export function catalog(): CatalogItem[] {
  if (cache) return cache;
  const items: CatalogItem[] = [];
  for (const id of ccxt.exchanges) {
    try {
      const Ex = (ccxt as any)[id];
      const e = new Ex();
      const req = e.requiredCredentials ?? {};
      const fields = (Object.keys(req) as CredField[]).filter((k) => req[k]);
      const has = e.has ?? {};
      const www = Array.isArray(e.urls?.www) ? e.urls.www[0] : e.urls?.www ?? null;
      items.push({
        id,
        name: e.name ?? id,
        priority: (PRIORITY as readonly string[]).includes(id),
        verified: VERIFIED.has(id),
        fields,
        spot: Boolean(has.spot),
        swap: Boolean(has.swap),
        testnet: Boolean(e.urls?.test),
        positions: Boolean(has.fetchPositions),
        www: typeof www === "string" ? www : null,
        tradable: Boolean(has.createOrder) && fields.length > 0,
      });
    } catch {
      // An exchange class that cannot be constructed is not offered.
    }
  }
  items.sort((a, b) => {
    const pa = a.priority ? PRIORITY.indexOf(a.id as any) : 999;
    const pb = b.priority ? PRIORITY.indexOf(b.id as any) : 999;
    return pa - pb || a.name.localeCompare(b.name);
  });
  cache = items;
  return items;
}

export const catalogItem = (id: string) => catalog().find((c) => c.id === id) ?? null;
