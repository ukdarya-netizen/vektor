import { clientFor, exchangeError, type AccountRow } from "./client";

export const STABLES = new Set(["USDT", "USDC", "FDUSD", "BUSD", "DAI", "TUSD", "USD", "USDE", "PYUSD"]);

export type Balance = { asset: string; total: number; free: number; used: number; usd: number | null };
export type Position = {
  accountId: number;
  symbol: string;
  coin: string;
  side: "long" | "short";
  size: number;
  entryPrice: number | null;
  markPrice: number | null;
  notional: number | null;
  unrealizedPnl: number | null;
  pnlPct: number | null;
  leverage: number | null;
  marginMode: string | null;
  liquidationPrice: number | null;
  margin: number | null;
};
export type Snapshot = {
  accountId: number;
  at: string;
  balances: Balance[];
  /** Sum of balances valued in USD; assets without a USDT price are left out and listed in unpriced. */
  totalUsd: number;
  unpriced: string[];
  unrealizedPnl: number;
  positions: Position[];
  error: { code: string; message: string } | null;
};

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : (v as number);
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};

const TTL_MS = 10_000;
const cache = new Map<number, { at: number; snap: Promise<Snapshot> }>();

export function snapshot(a: AccountRow, fresh = false): Promise<Snapshot> {
  const c = cache.get(a.id);
  if (!fresh && c && Date.now() - c.at < TTL_MS) return c.snap;
  const snap = build(a);
  cache.set(a.id, { at: Date.now(), snap });
  snap.catch(() => cache.delete(a.id));
  return snap;
}

async function build(a: AccountRow): Promise<Snapshot> {
  const out: Snapshot = { accountId: a.id, at: new Date().toISOString(), balances: [], totalUsd: 0, unpriced: [], unrealizedPnl: 0, positions: [], error: null };
  try {
    const ex = clientFor(a);
    const bal = await ex.fetchBalance();
    const rows = Object.entries((bal.total ?? {}) as Record<string, number>)
      .filter(([, v]) => num(v) && Math.abs(Number(v)) > 0)
      .map(([asset, total]) => ({ asset, total: Number(total), free: num(bal.free?.[asset]) ?? 0, used: num(bal.used?.[asset]) ?? 0, usd: null as number | null }));

    const toPrice = rows.filter((r) => !STABLES.has(r.asset));
    for (const r of rows) if (STABLES.has(r.asset)) r.usd = r.total;
    if (toPrice.length) {
      await ex.loadMarkets();
      const symbols = toPrice.map((r) => `${r.asset}/USDT`).filter((s) => ex.markets?.[s]);
      let tickers: Record<string, any> = {};
      if (symbols.length) {
        try {
          tickers = ex.has.fetchTickers ? await ex.fetchTickers(symbols) : {};
        } catch {
          tickers = {};
        }
        for (const s of symbols.slice(0, 30)) {
          if (!tickers[s]) tickers[s] = await ex.fetchTicker(s).catch(() => null);
        }
      }
      for (const r of toPrice) {
        const t = tickers[`${r.asset}/USDT`];
        const px = num(t?.last) ?? num(t?.close);
        if (px !== null) r.usd = r.total * px;
        else out.unpriced.push(r.asset);
      }
    }
    out.balances = rows.sort((x, y) => (y.usd ?? 0) - (x.usd ?? 0));
    out.totalUsd = rows.reduce((s, r) => s + (r.usd ?? 0), 0);

    if (a.market === "swap" && ex.has.fetchPositions) {
      const ps = await ex.fetchPositions();
      for (const p of ps ?? []) {
        const size = Math.abs(num(p.contracts) ?? 0) * (num(p.contractSize) ?? 1);
        if (!size) continue;
        const side = p.side === "short" ? "short" : "long";
        const entry = num(p.entryPrice);
        const mark = num(p.markPrice);
        const upnl = num(p.unrealizedPnl);
        out.positions.push({
          accountId: a.id,
          symbol: p.symbol,
          coin: String(p.symbol).split("/")[0],
          side,
          size,
          entryPrice: entry,
          markPrice: mark,
          notional: num(p.notional) !== null ? Math.abs(num(p.notional)!) : mark !== null ? size * mark : null,
          unrealizedPnl: upnl,
          pnlPct: entry && mark ? ((mark - entry) / entry) * 100 * (side === "long" ? 1 : -1) : null,
          leverage: num(p.leverage),
          marginMode: p.marginMode ?? null,
          liquidationPrice: num(p.liquidationPrice),
          margin: num(p.initialMargin) ?? num(p.collateral),
        });
        out.unrealizedPnl += upnl ?? 0;
      }
    }
  } catch (e) {
    out.error = exchangeError(e);
  }
  return out;
}
