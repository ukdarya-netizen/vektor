import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { cx } from "@/components/ui";

type Tk = { symbol: string; base: string; last: number | null; change24h: number | null; quoteVolume: number | null };

const HUES = [217, 262, 190, 330, 38, 150, 280, 200];
/** Round coin badge: first letters on a colour picked from the ticker (stable per coin). */
export function CoinBadge({ coin, size = 28 }: { coin: string; size?: number }) {
  const h = HUES[[...coin].reduce((a, c) => a + c.charCodeAt(0), 0) % HUES.length];
  const known: Record<string, string> = { BTC: "#f7931a", ETH: "#627eea", SOL: "#9945ff", BNB: "#f0b90b", XRP: "#23292f", DOGE: "#c2a633", TON: "#0098ea", USDT: "#26a17b" };
  const bg = known[coin] ?? `hsl(${h} 70% 45%)`;
  return (
    <span className="inline-flex shrink-0 items-center justify-center rounded-full font-display font-bold text-white"
      style={{ width: size, height: size, background: bg, fontSize: size * (coin.length > 3 ? 0.3 : 0.38) }}>
      {coin.replace(/^1000+/, "").slice(0, 4)}
    </span>
  );
}

const fmtPrice = (v: number | null) => (v === null ? "—" : v >= 1000 ? v.toLocaleString("en-US", { maximumFractionDigits: 2 }) : v >= 1 ? v.toFixed(v >= 100 ? 2 : 4) : v.toPrecision(4));

/** Left panel: all markets by volume, or the watchlist; ★ to add/remove. */
export function MarketList({ accountId, exchange, symbol, onPick }: { accountId: number; exchange: string; symbol: string; onPick: (s: string) => void }) {
  const t = useT();
  const key = `vk_watch_${exchange}`;
  const [tab, setTab] = useState<"all" | "watch">("all");
  const [q, setQ] = useState("");
  const [watch, setWatch] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem(key) ?? "[]"); } catch { return []; } });
  const { data } = useQuery({ queryKey: ["tickers", accountId], queryFn: () => api<{ tickers: Tk[] }>(`/tickers?accountId=${accountId}`), refetchInterval: 15_000 });
  const toggle = (s: string) => {
    const next = watch.includes(s) ? watch.filter((x) => x !== s) : [...watch, s];
    setWatch(next);
    try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* ignore */ }
  };
  const rows = useMemo(() => {
    const all = data?.tickers ?? [];
    const base = tab === "watch" ? all.filter((x) => watch.includes(x.symbol)) : all;
    const s = q.trim().toUpperCase();
    return (s ? base.filter((x) => x.base.includes(s)) : base).slice(0, 300);
  }, [data, tab, q, watch]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="grid grid-cols-2 gap-1 p-2">
        {(["all", "watch"] as const).map((x) => (
          <button key={x} onClick={() => setTab(x)} className={cx("flex items-center justify-center gap-1.5 rounded-lg py-2 text-xs font-medium",
            tab === x ? "bg-gradient-to-b from-accent/25 to-violet/10 text-white shadow-[inset_0_0_0_1px_rgba(99,102,241,0.3)]" : "text-muted hover:text-text")}>
            {x === "watch" ? "★ " : ""}{t(x === "all" ? "mk.markets" : "mk.watchlist")}
          </button>
        ))}
      </div>
      <div className="px-2 pb-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("tr.searchSymbol")}
          className="h-9 w-full rounded-lg border border-line bg-bg/70 px-3 text-xs outline-none focus:border-accent" />
      </div>
      <div className="grid grid-cols-[16px_1fr_auto_52px] gap-2 px-3 pb-1 text-[10px] uppercase tracking-wide text-muted">
        <span /><span>{t("mk.pair")}</span><span className="text-right">{t("mk.price")}</span><span className="text-right">24h</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {!rows.length && <div className="px-3 py-6 text-center text-xs text-muted">{tab === "watch" ? t("mk.watchEmpty") : "…"}</div>}
        {rows.map((r) => (
          <div key={r.symbol} onClick={() => onPick(r.symbol)}
            className={cx("grid cursor-pointer grid-cols-[16px_1fr_auto_52px] items-center gap-2 px-3 py-1.5 text-xs hover:bg-panel-2", r.symbol === symbol && "bg-accent/10")}>
            <button onClick={(e) => { e.stopPropagation(); toggle(r.symbol); }} className={watch.includes(r.symbol) ? "text-warn" : "text-line hover:text-muted"} aria-label="watch">★</button>
            <span className="truncate font-medium">{r.base}<span className="text-muted">/USDT</span></span>
            <span className="num text-right">{fmtPrice(r.last)}</span>
            <span className={cx("num text-right", (r.change24h ?? 0) >= 0 ? "text-up" : "text-down")}>{r.change24h === null ? "—" : `${r.change24h >= 0 ? "+" : ""}${r.change24h.toFixed(2)}%`}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
