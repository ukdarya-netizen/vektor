import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type Account } from "@/lib/api";
import { useT, type Key } from "@/lib/i18n";
import { num, usd } from "@/lib/format";
import { Alert, Button, Spinner, cx } from "@/components/ui";
import type { Tick } from "./useFeed";
import { DEFAULT_PLAN, PlanEditor, planProblems, type Plan } from "./PlanEditor";

export type Mkt = { symbol: string; base: string; quote: string; tick: number | null; step: number | null; minAmount: number | null; minCost: number | null; contractSize: number; maxLeverage: number | null };
type Pf = { ok: boolean; errors: Array<{ code: string; need?: number; have?: number }>; warnings: Array<{ code: string; value?: number }>; price: number; qty: number; notional: number; margin: number; fee: number; leverage: number };

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
const LEVS = [1, 2, 3, 5, 10, 20, 25, 50, 75, 100, 125];

/**
 * Simple by default: side, market/limit, amount with % buttons, leverage — and a live
 * preview of exactly what will be sent, with every problem in words before the button.
 */
export function OrderTicket({ account, mkt, tick }: { account: Account; mkt: Mkt | null; tick: Tick | null }) {
  const t = useT();
  const qc = useQueryClient();
  const futures = account.market === "swap";
  const [side, setSide] = useState<"long" | "short">("long");
  const [type, setType] = useState<"market" | "limit">("market");
  const [price, setPrice] = useState("");
  const [amount, setAmount] = useState("");
  const [mode, setMode] = useState<"usdt" | "percent">("usdt");
  const [lev, setLev] = useState(() => Number(localStorage.getItem(`vk_lev_${account.id}`) ?? 10));
  const [marginMode, setMarginMode] = useState<"isolated" | "cross">("isolated");
  const [pf, setPf] = useState<Pf | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: "up" | "down" | "warn"; text: string } | null>(null);
  const [requestId, setRequestId] = useState(uid);
  const [planOn, setPlanOn] = useState(() => localStorage.getItem(`vk_planon_${account.id}`) !== "0");
  const [plan, setPlan] = useState<Plan>(() => { try { return JSON.parse(localStorage.getItem(`vk_plan_${account.id}`) ?? "") as Plan; } catch { return DEFAULT_PLAN; } });
  useEffect(() => { try { localStorage.setItem(`vk_plan_${account.id}`, JSON.stringify(plan)); localStorage.setItem(`vk_planon_${account.id}`, planOn ? "1" : "0"); } catch { /* ignore */ } }, [plan, planOn, account.id]);

  const tpls = useQuery({ queryKey: ["templates"], queryFn: () => api<{ templates: Array<{ id: number; name: string; sizing: { amountMode: "usdt" | "percent"; amount: number; leverage: number; marginMode: "isolated" | "cross" }; plan: Plan }> }>("/templates"), enabled: futures });
  const applyTemplate = (id: number) => {
    const x = tpls.data?.templates.find((y) => y.id === id);
    if (!x) return;
    setMode(x.sizing.amountMode); setAmount(String(x.sizing.amount)); setLev(x.sizing.leverage); setMarginMode(x.sizing.marginMode);
    setPlan(x.plan); setPlanOn(true);
  };
  const saveTemplate = async () => {
    const name = prompt(t("tpl.name"));
    if (!name?.trim()) return;
    await api("/templates", { body: { name: name.trim(), sizing: { amountMode: mode, amount: Number(amount) || 10, leverage: lev, marginMode }, plan } });
    void qc.invalidateQueries({ queryKey: ["templates"] });
  };
  const bal = useQuery({
    queryKey: ["balance", account.id, mkt?.base],
    queryFn: () => api<{ quoteFree: number; baseFree: number | null }>(`/balance?accountId=${account.id}${mkt ? `&base=${mkt.base}` : ""}`),
    refetchInterval: 10_000, enabled: Boolean(mkt),
  });
  const maxLev = mkt?.maxLeverage ?? 125;
  const levs = useMemo(() => LEVS.filter((l) => l <= maxLev), [maxLev]);

  useEffect(() => { try { localStorage.setItem(`vk_lev_${account.id}`, String(lev)); } catch { /* ignore */ } }, [lev, account.id]);
  useEffect(() => { setPrice(""); setPf(null); setResult(null); }, [mkt?.symbol]);
  useEffect(() => { if (type === "limit" && !price && tick?.last) setPrice(String(tick.last)); }, [type, tick?.last]);

  const body = mkt && Number(amount) > 0 ? {
    accountId: account.id, symbol: mkt.symbol, side, type, price: type === "limit" ? Number(price) : null,
    amountMode: mode, amount: Number(amount), leverage: futures ? lev : 1, marginMode: futures ? marginMode : undefined,
  } : null;

  // Debounced preview.
  useEffect(() => {
    if (!body) { setPf(null); return; }
    const id = setTimeout(() => {
      api<{ preflight: Pf }>("/orders/preview", { body }).then((r) => setPf(r.preflight)).catch(() => setPf(null));
    }, 350);
    return () => clearTimeout(id);
  }, [JSON.stringify(body), Math.round((tick?.last ?? 0) * 1e6)]);

  const pfText = (e: { code: string; need?: number; have?: number; value?: number }) => {
    const k = `pf.${e.code}` as Key;
    const txt = t(k, { need: e.need !== undefined ? num(e.need, t.lang) : "", have: e.have !== undefined ? num(e.have, t.lang) : "", value: e.value !== undefined ? e.value.toFixed(e.code === "high_leverage" ? 0 : 2) : "" });
    return txt === k ? e.code : txt;
  };

  const submit = async () => {
    if (!body) return;
    setBusy(true); setResult(null);
    try {
      const r = await api<{ order: { status: string } }>("/orders", { body: { ...body, clientRequestId: requestId, plan: futures && planOn ? plan : null } });
      setResult({ tone: "up", text: r.order.status === "filled" ? t("tr.filled") : t("tr.sent") });
      setAmount("");
      setRequestId(uid()); // new order = new id; a retry of the same click keeps the old one
      void qc.invalidateQueries({ queryKey: ["positions"] });
      void qc.invalidateQueries({ queryKey: ["openOrders"] });
      void qc.invalidateQueries({ queryKey: ["balance"] });
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.body?.order?.status === "unknown") setResult({ tone: "warn", text: t("tr.unknown") });
        else if (e.code === "preflight_failed") setPf(e.body.preflight);
        else if (e.code === "leverage_failed") setResult({ tone: "down", text: t("pf.leverage_failed", { msg: e.body?.exchangeError?.message ?? "" }) });
        else if (e.code === "account_paused") setResult({ tone: "down", text: t("pf.account_paused") });
        else if (e.code === "plan_invalid") setResult({ tone: "down", text: t(`plan.${e.body?.reason}` as Key) });
        else if (e.code === "risk_limit") setResult({ tone: "down", text: t(`pf.risk.${e.body?.risk?.code}` as Key, { limit: e.body?.risk?.limit ?? "" }) });
        else setResult({ tone: "down", text: e.body?.exchangeError?.message ?? t("err.generic") });
        if (e.body?.order?.status !== "unknown") setRequestId(uid());
      } else setResult({ tone: "down", text: t("err.generic") });
    } finally { setBusy(false); }
  };

  const coin = mkt?.base ?? "";
  const estEntry = type === "limit" ? Number(price) || null : tick?.last ?? null;
  const prec = mkt?.tick ? Math.max(0, Math.min(10, Math.ceil(-Math.log10(mkt.tick) - 1e-9))) : 4;
  const planBad = futures && planOn && planProblems(plan, side, estEntry).length > 0;
  const avail = side === "short" && !futures ? `${num(bal.data?.baseFree ?? 0, t.lang)} ${coin}` : `${num(bal.data?.quoteFree ?? 0, t.lang)} USDT`;
  const long = side === "long";

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-1 rounded-lg bg-bg p-1">
        {(["long", "short"] as const).map((s) => (
          <button key={s} onClick={() => setSide(s)}
            className={cx("rounded-md py-2 text-sm font-semibold transition", side === s ? (s === "long" ? "bg-up text-white" : "bg-down text-white") : "text-muted hover:text-text")}>
            {futures ? t(s === "long" ? "tr.long" : "tr.short") : t(s === "long" ? "tr.buy" : "tr.sell")}
          </button>
        ))}
      </div>

      {futures && (
        <div className="flex items-center gap-2">
          <select className="h-8 min-w-0 flex-1 rounded-md border border-line bg-bg px-2 text-xs" value="" aria-label={t("tpl.title")}
            onChange={(e) => e.target.value && applyTemplate(Number(e.target.value))}>
            <option value="">{t("tpl.title")}: {t("tpl.none")}</option>
            {tpls.data?.templates.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
          <button className="shrink-0 text-xs text-accent hover:underline" onClick={saveTemplate}>{t("tpl.save")}</button>
        </div>
      )}

      <div className="flex gap-4 text-sm">
        {(["market", "limit"] as const).map((x) => (
          <button key={x} onClick={() => setType(x)} className={cx("border-b-2 pb-1", type === x ? "border-accent text-text" : "border-transparent text-muted")}>{t(x === "market" ? "tr.market" : "tr.limit")}</button>
        ))}
      </div>

      {type === "limit" && (
        <Field label={t("tr.price")} suffix="USDT">
          <input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value.replace(",", "."))} className="w-full bg-transparent outline-none num" />
        </Field>
      )}

      <Field label={mode === "percent" ? "%" : futures ? t("tr.margin") : t("tr.amountUsdt")} suffix={mode === "percent" ? "%" : "USDT"}>
        <input inputMode="decimal" value={amount} placeholder="0" onChange={(e) => setAmount(e.target.value.replace(",", "."))} className="w-full bg-transparent outline-none num" />
      </Field>
      <div className="grid grid-cols-4 gap-1">
        {[10, 25, 50, 100].map((p) => (
          <button key={p} onClick={() => { setMode("percent"); setAmount(String(p)); }}
            className={cx("rounded-md border py-1.5 text-xs", mode === "percent" && Number(amount) === p ? "border-accent text-text" : "border-line text-muted hover:text-text")}>{p}%</button>
        ))}
      </div>
      <div className="flex items-center justify-between text-xs text-muted">
        <span>{t("tr.available", { v: avail })}</span>
        {mode === "percent" && <button className="text-accent" onClick={() => { setMode("usdt"); setAmount(""); }}>USDT</button>}
      </div>

      {futures && (
        <>
          <div>
            <div className="mb-1.5 flex items-center justify-between text-sm"><span className="text-muted">{t("tr.leverage")}</span><span className="num font-semibold">{lev}x</span></div>
            <div className="flex flex-wrap gap-1">
              {levs.map((l) => (
                <button key={l} onClick={() => setLev(l)} className={cx("rounded-md border px-2 py-1 text-xs num", lev === l ? "border-accent text-text" : "border-line text-muted hover:text-text")}>{l}x</button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-1 rounded-lg bg-bg p-1 text-xs">
            {(["isolated", "cross"] as const).map((m) => (
              <button key={m} onClick={() => setMarginMode(m)} className={cx("rounded-md py-1.5", marginMode === m ? "bg-panel-2 text-text" : "text-muted")}>{t(m === "isolated" ? "tr.isolated" : "tr.cross")}</button>
            ))}
          </div>
        </>
      )}

      {futures && (
        <div className="rounded-lg border border-line p-3">
          <div className="flex items-center justify-between text-sm font-medium">
            <span>{t("plan.title")}</span>
            <button onClick={() => setPlanOn((v) => !v)} className={cx("h-6 w-11 rounded-full transition relative", planOn ? "bg-accent" : "bg-line")} role="switch" aria-checked={planOn}>
              <span className={cx("absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all", planOn ? "left-[22px]" : "left-0.5")} />
            </button>
          </div>
          {planOn && <div className="mt-3"><PlanEditor plan={plan} onChange={setPlan} side={side} entry={estEntry} prec={prec} /></div>}
        </div>
      )}

      {pf && (
        <div className="space-y-1 rounded-lg border border-line bg-bg p-3 text-xs">
          <Row k={t("tr.qty")} v={`${num(pf.qty * (mkt?.contractSize ?? 1), t.lang)} ${coin}`} />
          {futures && <Row k={t("tr.positionSize")} v={usd(pf.notional, t.lang)} />}
          {futures && <Row k={t("tr.margin")} v={usd(pf.margin, t.lang)} />}
          <Row k={t("tr.fee")} v={usd(pf.fee, t.lang)} />
          {pf.errors.map((e) => <div key={e.code} className="pt-1 text-down">{pfText(e)}</div>)}
          {pf.warnings.map((w) => <div key={w.code} className="pt-1 text-warn">{pfText(w)}</div>)}
        </div>
      )}

      <Button size="lg" onClick={submit} disabled={busy || !body || (pf ? !pf.ok : true) || planBad}
        className={cx("w-full", long ? "!bg-up hover:!bg-up/90" : "!bg-down hover:!bg-down/90")}>
        {busy ? <><Spinner /> {t("tr.sending")}</> : futures ? t(long ? "tr.openLong" : "tr.openShort") : t(long ? "tr.buyBtn" : "tr.sellBtn", { coin })}
      </Button>
      {result && <Alert tone={result.tone}>{result.text}</Alert>}
    </div>
  );
}

const Row = ({ k, v }: { k: string; v: string }) => (
  <div className="flex justify-between gap-2"><span className="text-muted">{k}</span><span className="num text-text">{v}</span></div>
);

function Field({ label, suffix, children }: { label: string; suffix: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-muted">{label}</span>
      <span className="flex h-10 items-center gap-2 rounded-lg border border-line bg-bg px-3 focus-within:border-accent">
        {children}
        <span className="text-xs text-muted">{suffix}</span>
      </span>
    </label>
  );
}
