import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type Account } from "@/lib/api";
import { useT, type Key } from "@/lib/i18n";
import { num } from "@/lib/format";
import { Alert, Badge, Button, Card, Empty, Input, Modal, Spinner, cx } from "@/components/ui";

type Grid = {
  id: number; account_id: number; account_label: string; name: string; status: "new" | "running" | "stopped" | "error";
  settings: { symbol: string; lower: number; upper: number; levels: number; investUsdt: number; leverage: number };
  state: { rounds: number; realized: number; qty: number } | null; stop_reason: string | null; last_error: string | null;
};

export function GridsSection() {
  const t = useT();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["grids"], queryFn: () => api<{ grids: Grid[] }>("/grids"), refetchInterval: 10_000 });
  const [open, setOpen] = useState(false);
  const stop = async (g: Grid, close: boolean) => {
    if (!confirm(t(close ? "grid.stopCloseConfirm" : "grid.stopConfirm", { name: g.name }))) return;
    await api(`/grids/${g.id}/stop`, { body: { close } }).catch(() => undefined);
    void qc.invalidateQueries({ queryKey: ["grids"] });
  };
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">{t("grid.title")}</h2>
        <Button variant="outline" onClick={() => setOpen(true)}>+ {t("grid.new")}</Button>
      </div>
      {isLoading ? <Spinner /> : !data?.grids.length ? <Card><Empty title={t("grid.title")} text={t("grid.empty")} /></Card> : data.grids.map((g) => (
        <Card key={g.id} className="p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <span className="font-medium">{g.name}</span>
                <Badge tone={g.status === "running" ? "up" : g.status === "error" ? "down" : "muted"}>{t(`grid.${g.status === "new" ? "running" : g.status}` as Key)}</Badge>
              </div>
              <div className="mt-1 text-sm text-muted">{g.settings.symbol.split(":")[0]} · {num(g.settings.lower, t.lang)}–{num(g.settings.upper, t.lang)} · {g.settings.levels} · {g.settings.investUsdt} USDT{g.settings.leverage > 1 ? ` · ${g.settings.leverage}x` : ""} · {g.account_label}</div>
              {g.state && <div className="mt-1 text-sm">{t("grid.rounds", { n: g.state.rounds, p: g.state.realized.toFixed(2) })}</div>}
              {g.last_error && <div className="mt-1 text-xs text-down">{g.last_error}</div>}
            </div>
            {g.status === "running" ? (
              <div className="flex gap-1">
                <Button size="sm" variant="outline" onClick={() => stop(g, false)}>{t("grid.stop")}</Button>
                <Button size="sm" variant="danger" onClick={() => stop(g, true)}>{t("grid.stopClose")}</Button>
              </div>
            ) : <Button size="sm" variant="ghost" onClick={async () => { await api(`/grids/${g.id}`, { method: "DELETE" }); void qc.invalidateQueries({ queryKey: ["grids"] }); }}>{t("common.delete")}</Button>}
          </div>
        </Card>
      ))}
      {open && <GridEditor onClose={() => setOpen(false)} onDone={() => { setOpen(false); void qc.invalidateQueries({ queryKey: ["grids"] }); }} />}
    </div>
  );
}

function GridEditor({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const t = useT();
  const accs = useQuery({ queryKey: ["accounts"], queryFn: () => api<{ accounts: Account[] }>("/accounts") });
  const usable = (accs.data?.accounts ?? []).filter((a) => a.status !== "paused");
  const [accountId, setAccountId] = useState<number>(0);
  useEffect(() => { if (!accountId && usable[0]) setAccountId(usable[0].id); }, [usable.length]);
  const acc = usable.find((a) => a.id === accountId);
  const markets = useQuery({ queryKey: ["markets", accountId], queryFn: () => api<{ markets: Array<{ symbol: string; base: string }> }>(`/markets?accountId=${accountId}`), enabled: Boolean(accountId) });
  const [f, setF] = useState({ name: "", coin: "BTC", lower: "", upper: "", levels: "20", spacing: "arithmetic" as "arithmetic" | "geometric", invest: "100", leverage: "1", stopLower: "", stopUpper: "" });
  const [pv, setPv] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const symbol = markets.data?.markets.find((m) => m.base === f.coin.toUpperCase().trim())?.symbol ?? null;
  const n = (v: string) => (v.trim() === "" ? null : Number(v.replace(",", ".")));
  const settings = { symbol, lower: n(f.lower), upper: n(f.upper), levels: Number(f.levels), spacing: f.spacing, investUsdt: n(f.invest), leverage: acc?.market === "swap" ? Number(f.leverage) : 1, stopLower: n(f.stopLower), stopUpper: n(f.stopUpper) };
  const errText = (code: string) => { const k = `grid.${code}` as Key; return t(k) !== k ? t(k) : code; };

  useEffect(() => {
    setPv(null);
    if (!symbol || !settings.lower || !settings.upper || !settings.investUsdt) return;
    const id = setTimeout(() => api("/grids/preview", { body: { settings } }).then(setPv).catch((e) => setErr(e instanceof ApiError ? errText(e.code) : null)), 300);
    setErr(null);
    return () => clearTimeout(id);
  }, [JSON.stringify(settings)]);

  const start = async () => {
    setBusy(true); setErr(null);
    try { await api("/grids", { body: { name: f.name || `${f.coin} grid`, accountId, settings } }); onDone(); }
    catch (e) {
      if (!(e instanceof ApiError)) { setErr(t("err.generic")); return; }
      const code = String(e.body?.exchangeError?.code ?? e.code);
      const k = `grid.${code}` as Key;
      setErr(t(k) !== k ? t(k) : e.body?.exchangeError?.message ?? code);
    }
    finally { setBusy(false); }
  };
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF((x) => ({ ...x, [k]: e.target.value }));
  return (
    <Modal open onClose={onClose} title={t("grid.new")} wide>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Input label={t("bots.name")} value={f.name} onChange={set("name")} placeholder={`${f.coin} grid`} />
          <label className="block"><span className="mb-1.5 block text-sm text-muted">{t("bots.account")}</span>
            <select className="h-11 w-full rounded-lg border border-line bg-bg px-3" value={accountId} onChange={(e) => setAccountId(Number(e.target.value))}>
              {usable.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
            </select></label>
        </div>
        <Input label={t("grid.coin")} value={f.coin} onChange={set("coin")} list="grid-coins" error={f.coin && markets.data && !symbol ? t("pf.no_symbol") : null} />
        <datalist id="grid-coins">{markets.data?.markets.slice(0, 400).map((m) => <option key={m.symbol} value={m.base} />)}</datalist>
        <div className="grid grid-cols-3 gap-3">
          <Input label={t("grid.lower")} inputMode="decimal" value={f.lower} onChange={set("lower")} />
          <Input label={t("grid.upper")} inputMode="decimal" value={f.upper} onChange={set("upper")} />
          <Input label={t("grid.levels")} inputMode="numeric" value={f.levels} onChange={set("levels")} />
        </div>
        <div className="flex gap-1">
          {(["arithmetic", "geometric"] as const).map((x) => (
            <button key={x} onClick={() => setF((y) => ({ ...y, spacing: x }))} className={cx("rounded-md border px-2.5 py-1.5 text-xs", f.spacing === x ? "border-accent text-text" : "border-line text-muted")}>{t(x === "arithmetic" ? "grid.arith" : "grid.geom")}</button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Input label={t("grid.invest")} inputMode="decimal" value={f.invest} onChange={set("invest")} />
          {acc?.market === "swap" && <Input label={t("tr.leverage")} inputMode="numeric" value={f.leverage} onChange={set("leverage")} />}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Input label={t("grid.stopLower")} inputMode="decimal" value={f.stopLower} onChange={set("stopLower")} />
          <Input label={t("grid.stopUpper")} inputMode="decimal" value={f.stopUpper} onChange={set("stopUpper")} />
        </div>
        {pv && <Alert tone="accent">{t("grid.preview", { n: f.levels, q: num(pv.qty, t.lang), s1: pv.stepPctMin.toFixed(2), s2: pv.stepPctMax.toFixed(2), p: pv.profitPerRound.toFixed(2) })}</Alert>}
        {err && <Alert>{err}</Alert>}
        <Button size="lg" className="w-full" onClick={start} disabled={busy || !pv || !symbol}>{busy ? <Spinner /> : t("grid.start")}</Button>
      </div>
    </Modal>
  );
}
