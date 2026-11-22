import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Account, type Position } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { num, pct, signedUsd, tone } from "@/lib/format";
import { Alert, Badge, Button, Card, Empty, Spinner, cx } from "@/components/ui";
import { Chart, type Candle, type ChartLine } from "@/components/terminal/Chart";
import { OrderTicket, type Mkt } from "@/components/terminal/OrderTicket";
import { useFeed, type Book } from "@/components/terminal/useFeed";
import { ConnectExchange } from "@/components/ConnectExchange";

const TFS = ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "1d", "1w"];
const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};
const decimals = (tick: number | null) => (tick && tick > 0 ? Math.max(0, Math.min(10, Math.ceil(-Math.log10(tick) - 1e-9))) : 4);

type OpenOrder = { id: string; symbol: string; side: "buy" | "sell"; type: string; price: number | null; triggerPrice: number | null; amount: number; filled: number; reduceOnly: boolean };

export function TerminalPage() {
  const t = useT();
  const [connect, setConnect] = useState(false);
  const accs = useQuery({ queryKey: ["accounts"], queryFn: () => api<{ accounts: Account[] }>("/accounts") });
  const usable = (accs.data?.accounts ?? []).filter((a) => a.status !== "paused");
  const [accountId, setAccountId] = useState<number | null>(() => Number(store.get("vk_term_acc")) || null);
  const account = usable.find((a) => a.id === accountId) ?? usable.find((a) => a.market === "swap") ?? usable[0] ?? null;

  if (accs.isLoading) return <div className="py-20 text-center text-muted"><Spinner /></div>;
  if (!account) {
    return (
      <Card>
        <Empty title={t("tr.noAccount")} action={<Button onClick={() => setConnect(true)}>{t("ex.add")}</Button>} />
        <ConnectExchange open={connect} onClose={() => setConnect(false)} />
      </Card>
    );
  }
  return <Workspace key={account.id} account={account} accounts={usable} onAccount={(id) => { setAccountId(id); store.set("vk_term_acc", String(id)); }} />;
}

function Workspace({ account, accounts, onAccount }: { account: Account; accounts: Account[]; onAccount: (id: number) => void }) {
  const t = useT();
  const futures = account.market === "swap";
  const [symbol, setSymbol] = useState<string>(() => store.get(`vk_term_sym_${account.id}`) ?? (futures ? "BTC/USDT:USDT" : "BTC/USDT"));
  const [tf, setTf] = useState(() => store.get("vk_term_tf") ?? "15m");
  const [tab, setTab] = useState<"positions" | "orders">("positions");

  const markets = useQuery({ queryKey: ["markets", account.id], queryFn: () => api<{ markets: Mkt[] }>(`/markets?accountId=${account.id}`), staleTime: 30 * 60_000 });
  const mkt = markets.data?.markets.find((m) => m.symbol === symbol) ?? null;
  useEffect(() => {
    // Saved symbol not on this exchange → first USDT market.
    if (markets.data && !mkt && markets.data.markets.length) setSymbol(markets.data.markets.find((m) => m.base === "BTC")?.symbol ?? markets.data.markets[0].symbol);
  }, [markets.data, mkt]);
  useEffect(() => { store.set(`vk_term_sym_${account.id}`, symbol); }, [symbol, account.id]);
  useEffect(() => { store.set("vk_term_tf", tf); }, [tf]);

  const hist = useQuery({
    queryKey: ["candles", account.id, symbol, tf],
    queryFn: () => api<{ candles: Candle[] }>(`/candles?accountId=${account.id}&symbol=${encodeURIComponent(symbol)}&tf=${tf}`),
    enabled: Boolean(mkt), staleTime: 60_000,
  });
  const feed = useFeed(mkt ? account.id : null, mkt ? symbol : null, tf);

  const positions = useQuery({
    queryKey: ["positions"], refetchInterval: 5_000, enabled: futures,
    queryFn: () => api<{ positions: Position[] }>("/positions"),
  });
  const mine = (positions.data?.positions ?? []).filter((p) => p.accountId === account.id);
  const orders = useQuery({
    queryKey: ["openOrders", account.id, symbol], refetchInterval: 8_000,
    queryFn: () => api<{ orders: OpenOrder[] }>(`/orders/open?accountId=${account.id}&symbol=${encodeURIComponent(symbol)}`),
  });

  const lines: ChartLine[] = useMemo(() => {
    const out: ChartLine[] = [];
    for (const p of mine.filter((p) => p.symbol === symbol)) {
      const side = p.side === "long" ? t("tr.long") : t("tr.short");
      if (p.entryPrice) out.push({ price: p.entryPrice, title: `${t("tr.entryLine")} ${side} ${pct(p.pnlPct)}`, color: p.side === "long" ? "#22c58b" : "#f0525f" });
      if (p.liquidationPrice) out.push({ price: p.liquidationPrice, title: `${t("tr.liqLine")} ${side}`, color: "#f5b84a", dashed: true });
    }
    for (const o of orders.data?.orders ?? []) {
      const px = o.price ?? o.triggerPrice;
      if (px) out.push({ price: px, title: `${o.side === "buy" ? "BUY" : "SELL"} ${o.type}${o.reduceOnly ? ` · ${t("tr.reduceOnly")}` : ""}`, color: "#5b8cff", dashed: true });
    }
    return out;
  }, [JSON.stringify(mine), JSON.stringify(orders.data), symbol, t.lang]);

  const last = feed.tick?.last ?? hist.data?.candles.at(-1)?.[4] ?? null;
  const prec = decimals(mkt?.tick ?? null);

  return (
    <div className="-mx-4 -my-5 flex min-h-full flex-col md:-mx-6">
      {/* Top bar: account · coin · timeframe · price */}
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <select className="h-9 rounded-lg border border-line bg-bg px-2 text-sm" value={account.id} onChange={(e) => onAccount(Number(e.target.value))} aria-label={t("tr.account")}>
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
        </select>
        <SymbolPicker markets={markets.data?.markets ?? []} value={symbol} onChange={setSymbol} />
        <div className="flex overflow-x-auto rounded-lg border border-line bg-bg p-0.5">
          {TFS.map((x) => (
            <button key={x} onClick={() => setTf(x)} className={cx("rounded-md px-2 py-1 text-xs", tf === x ? "bg-panel-2 text-text" : "text-muted hover:text-text")}>{x}</button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="num text-lg font-semibold">{last !== null ? last.toFixed(prec) : "—"}</span>
          {feed.stale ? <Badge tone="down">{t("tr.stale")}</Badge> : feed.mode && <span className="text-xs text-muted">{feed.mode === "ws" ? t("tr.dataWs") : t("tr.dataPoll")}</span>}
          {account.env === "testnet" ? <Badge tone="warn">{t("mode.testnet")}</Badge> : <Badge tone="down">{t("mode.live")}</Badge>}
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[1fr_200px_300px]">
        <div className="relative h-[52vh] min-h-[320px] border-b border-line lg:h-auto lg:border-b-0 lg:border-r">
          {hist.isLoading || markets.isLoading ? <div className="flex h-full items-center justify-center text-muted"><Spinner /></div>
            : hist.error ? <div className="p-4"><Alert>{String((hist.error as any)?.body?.exchangeError?.message ?? hist.error)}</Alert></div>
            : <Chart candles={hist.data?.candles ?? null} live={feed.live} lines={lines} precision={prec} />}
        </div>
        <div className="hidden border-r border-line lg:block"><OrderBook book={feed.book} prec={prec} /></div>
        <div className="border-b border-line p-3 lg:border-b-0"><OrderTicket account={account} mkt={mkt} tick={feed.tick} /></div>
      </div>

      {/* Bottom: positions and orders of this account */}
      <div className="border-t border-line">
        <div className="flex gap-4 px-3 pt-2 text-sm">
          {futures && <TabBtn on={tab === "positions"} onClick={() => setTab("positions")}>{t("tr.positions")} ({mine.length})</TabBtn>}
          <TabBtn on={tab === "orders" || !futures} onClick={() => setTab("orders")}>{t("tr.orders")} ({orders.data?.orders.length ?? 0})</TabBtn>
        </div>
        {tab === "positions" && futures
          ? <PositionsTable account={account} positions={mine} onPick={setSymbol} />
          : <OrdersTable account={account} symbol={symbol} orders={orders.data?.orders ?? []} />}
      </div>
    </div>
  );
}

const TabBtn = ({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) => (
  <button onClick={onClick} className={cx("border-b-2 pb-1.5", on ? "border-accent text-text" : "border-transparent text-muted")}>{children}</button>
);

function SymbolPicker({ markets, value, onChange }: { markets: Mkt[]; value: string; onChange: (s: string) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);
  const list = useMemo(() => {
    const s = q.trim().toUpperCase();
    return (s ? markets.filter((m) => m.base.includes(s)) : markets).slice(0, 200);
  }, [markets, q]);
  const cur = markets.find((m) => m.symbol === value);
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((o) => !o)} className="flex h-9 items-center gap-2 rounded-lg border border-line bg-bg px-3 text-sm font-semibold">
        {cur ? `${cur.base}/${cur.quote}` : value.split(":")[0]} <span className="text-muted">▾</span>
      </button>
      {open && (
        <div className="absolute left-0 top-11 z-30 w-64 rounded-xl border border-line bg-panel p-2 shadow-2xl">
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("tr.searchSymbol")} className="mb-2 h-9 w-full rounded-lg border border-line bg-bg px-3 text-sm outline-none focus:border-accent" />
          <div className="max-h-72 overflow-y-auto">
            {list.map((m) => (
              <button key={m.symbol} onClick={() => { onChange(m.symbol); setOpen(false); setQ(""); }}
                className={cx("flex w-full justify-between rounded-md px-2 py-1.5 text-left text-sm hover:bg-panel-2", m.symbol === value && "text-accent")}>
                <span>{m.base}</span><span className="text-xs text-muted">{m.quote}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function OrderBook({ book, prec }: { book: Book | null; prec: number }) {
  const t = useT();
  if (!book) return <div className="p-3 text-xs text-muted">{t("tr.book")}…</div>;
  const asks = book.asks.slice(0, 12).reverse();
  const bids = book.bids.slice(0, 12);
  const max = Math.max(...[...asks, ...bids].map((r) => r[1]), 1e-12);
  const spread = book.asks[0] && book.bids[0] ? book.asks[0][0] - book.bids[0][0] : null;
  const Row = ({ r, side }: { r: number[]; side: "a" | "b" }) => (
    <div className="relative flex justify-between px-3 py-[2px] text-xs num">
      <span className={cx("absolute inset-y-0 right-0", side === "a" ? "bg-down/10" : "bg-up/10")} style={{ width: `${(r[1] / max) * 100}%` }} />
      <span className={cx("relative", side === "a" ? "text-down" : "text-up")}>{r[0].toFixed(prec)}</span>
      <span className="relative text-muted">{r[1] < 1 ? r[1].toPrecision(3) : r[1].toFixed(r[1] < 100 ? 2 : 0)}</span>
    </div>
  );
  return (
    <div className="py-2">
      <div className="px-3 pb-1 text-xs text-muted">{t("tr.book")}</div>
      {asks.map((r, i) => <Row key={`a${i}`} r={r} side="a" />)}
      <div className="my-1 border-y border-line px-3 py-1 text-xs text-muted">{t("tr.spread")}: <span className="num">{spread !== null ? spread.toFixed(prec) : "—"}</span></div>
      {bids.map((r, i) => <Row key={`b${i}`} r={r} side="b" />)}
    </div>
  );
}

function PositionsTable({ account, positions, onPick }: { account: Account; positions: Position[]; onPick: (s: string) => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const close = async (p: Position, percent: number) => {
    if (!confirm(t("tr.closeConfirm", { pct: percent, coin: p.coin }))) return;
    setBusy(`${p.symbol}${p.side}`); setErr(null);
    try { await api("/positions/close", { body: { accountId: account.id, symbol: p.symbol, side: p.side, percent } }); }
    catch (e: any) { setErr(e?.body?.exchangeError?.message ?? t("err.generic")); }
    finally { setBusy(null); void qc.invalidateQueries({ queryKey: ["positions"] }); }
  };
  if (!positions.length) return <div className="px-3 py-6 text-sm text-muted">{t("positions.empty")}</div>;
  return (
    <div className="overflow-x-auto">
      {err && <div className="px-3 pt-2"><Alert>{err}</Alert></div>}
      <table className="w-full min-w-[760px] text-sm">
        <tbody>
          {positions.map((p) => (
            <tr key={`${p.symbol}${p.side}`} className="border-t border-line/60">
              <td className="px-3 py-2"><button className="font-medium hover:text-accent" onClick={() => onPick(p.symbol)}>{p.coin}</button></td>
              <td className="px-3 py-2"><Badge tone={p.side === "long" ? "up" : "down"}>{p.side === "long" ? t("tr.long") : t("tr.short")} {p.leverage ? `${p.leverage}x` : ""}</Badge></td>
              <td className="num px-3 py-2 text-right">{num(p.size, t.lang)}</td>
              <td className="num px-3 py-2 text-right text-muted">{t("positions.entry")} {num(p.entryPrice, t.lang)}</td>
              <td className={`num px-3 py-2 text-right ${tone(p.unrealizedPnl)}`}>{signedUsd(p.unrealizedPnl, t.lang)} · {pct(p.pnlPct)}</td>
              <td className="num px-3 py-2 text-right text-warn">{t("positions.liq")} {num(p.liquidationPrice, t.lang)}</td>
              <td className="px-3 py-2 text-right">
                <div className="flex justify-end gap-1">
                  {[25, 50].map((x) => <Button key={x} size="sm" variant="outline" disabled={busy !== null} onClick={() => close(p, x)}>{x}%</Button>)}
                  <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => close(p, 100)}>{busy === `${p.symbol}${p.side}` ? <Spinner /> : t("tr.closeAll")}</Button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OrdersTable({ account, symbol, orders }: { account: Account; symbol: string; orders: OpenOrder[] }) {
  const t = useT();
  const qc = useQueryClient();
  const cancel = async (o: OpenOrder) => {
    await api(`/orders/${encodeURIComponent(o.id)}?accountId=${account.id}&symbol=${encodeURIComponent(symbol)}`, { method: "DELETE" }).catch(() => undefined);
    void qc.invalidateQueries({ queryKey: ["openOrders"] });
  };
  if (!orders.length) return <div className="px-3 py-6 text-sm text-muted">{t("tr.noOrders")}</div>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[600px] text-sm">
        <tbody>
          {orders.map((o) => (
            <tr key={o.id} className="border-t border-line/60">
              <td className="px-3 py-2">{o.symbol.split(":")[0]}</td>
              <td className="px-3 py-2"><Badge tone={o.side === "buy" ? "up" : "down"}>{o.side.toUpperCase()}</Badge> <span className="text-muted">{o.type}{o.reduceOnly ? ` · ${t("tr.reduceOnly")}` : ""}</span></td>
              <td className="num px-3 py-2 text-right">{num(o.price ?? o.triggerPrice, t.lang)}{!o.price && o.triggerPrice ? ` (${t("tr.trigger")})` : ""}</td>
              <td className="num px-3 py-2 text-right">{num(o.filled, t.lang)} / {num(o.amount, t.lang)}</td>
              <td className="px-3 py-2 text-right"><Button size="sm" variant="danger" onClick={() => cancel(o)}>{t("tr.cancel")}</Button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
