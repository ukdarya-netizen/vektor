import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type ExchangeInfo } from "@/lib/api";
import { useT, type Key } from "@/lib/i18n";
import { Alert, Badge, Button, Input, Modal, Spinner, cx } from "./ui";

/** Two steps: pick the exchange (search; popular first) → key form with that exchange's fields. */
export function ConnectExchange({ open, onClose, onConnected }: { open: boolean; onClose: () => void; onConnected?: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["exchanges"], queryFn: () => api<{ exchanges: ExchangeInfo[] }>("/exchanges"), staleTime: Infinity });
  const [search, setSearch] = useState("");
  const [ex, setEx] = useState<ExchangeInfo | null>(null);
  const [market, setMarket] = useState<"spot" | "swap">("swap");
  const [env, setEnv] = useState<"live" | "testnet">("live");
  const [label, setLabel] = useState("");
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [confirmNeeded, setConfirmNeeded] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [paper, setPaper] = useState(false);
  const [paperSrc, setPaperSrc] = useState("binance");
  const [paperStart, setPaperStart] = useState("10000");

  const list = useMemo(() => (data?.exchanges ?? []).filter((e) => e.tradable), [data]);
  const shown = useMemo(() => {
    const s = search.trim().toLowerCase();
    return s ? list.filter((e) => e.name.toLowerCase().includes(s) || e.id.includes(s)) : list;
  }, [list, search]);

  const reset = () => { setPaper(false); setEx(null); setSearch(""); setCreds({}); setLabel(""); setErr(null); setConfirmNeeded(false); setConfirmed(false); setEnv("live"); };
  const close = () => { reset(); onClose(); };

  const pick = (e: ExchangeInfo) => {
    setEx(e); setErr(null); setCreds({}); setConfirmNeeded(false); setConfirmed(false);
    setMarket(e.swap ? "swap" : "spot"); setEnv("live");
  };

  const submit = async () => {
    if (!ex) return;
    setBusy(true); setErr(null);
    try {
      await api("/accounts", { body: { exchange: ex.id, market, env, label: label.trim() || undefined, credentials: creds, confirmNoWithdraw: confirmed || undefined } });
      await qc.invalidateQueries({ queryKey: ["accounts"] });
      await qc.invalidateQueries({ queryKey: ["portfolio"] });
      await qc.invalidateQueries({ queryKey: ["positions"] });
      onConnected?.();
      close();
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.code === "confirm_no_withdraw") { setConfirmNeeded(true); return; }
        if (e.code === "plan_limit") { setErr(t("err.plan_limit", { key: t(`bill.${e.body?.key}` as Key) })); return; }
        if (e.code === "key_check_failed") {
          const c = e.body?.exchangeError?.code as string;
          const known = t(`ex.err.code.${c}` as Key);
          setErr(t("ex.err.key_check_failed", { msg: known.startsWith("ex.err") ? e.body?.exchangeError?.message ?? "" : known }));
          return;
        }
        if (e.code === "missing_field") { setErr(t("ex.err.missing_field", { field: t(`ex.field.${e.body?.field}` as Key) })); return; }
        const k = `ex.err.${e.code}` as Key;
        setErr(t(k).startsWith("ex.err") ? t("err.generic") : t(k));
      } else setErr(t("err.generic"));
    } finally { setBusy(false); }
  };

  const Row = ({ e }: { e: ExchangeInfo }) => (
    <button onClick={() => pick(e)} className="flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-left hover:bg-panel-2">
      <span className="font-medium">{e.name}</span>
      <span className="flex gap-1.5">
        {e.spot && <Badge>{t("ex.spot")}</Badge>}
        {e.swap && <Badge>{t("ex.futures")}</Badge>}
        {e.verified && <Badge tone="up">{t("ex.verified")}</Badge>}
      </span>
    </button>
  );

  return (
    <Modal open={open} onClose={close} title={ex ? ex.name : t("ex.add")} wide>
      {paper ? (
        <form className="space-y-4" onSubmit={async (e) => {
          e.preventDefault(); setBusy(true); setErr(null);
          try {
            await api("/accounts/paper", { body: { exchange: paperSrc, market, startUsdt: Number(paperStart) || 10000 } });
            await Promise.all(["accounts", "portfolio", "positions"].map((k) => qc.invalidateQueries({ queryKey: [k] })));
            onConnected?.(); close();
          } catch { setErr(t("err.generic")); } finally { setBusy(false); }
        }}>
          <button type="button" className="text-sm text-muted hover:text-text" onClick={() => setPaper(false)}>← {t("common.back")}</button>
          <p className="text-sm text-muted">{t("paper.text")}</p>
          <label className="block">
            <span className="mb-1.5 block text-sm text-muted">{t("paper.source")}</span>
            <select className="h-11 w-full rounded-lg border border-line bg-bg px-3" value={paperSrc} onChange={(e) => setPaperSrc(e.target.value)}>
              {list.filter((x) => x.priority).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
          </label>
          <Seg<"spot" | "swap"> label={t("ex.market")} value={market} onChange={setMarket} options={[{ v: "swap", l: t("ex.swap") }, { v: "spot", l: t("ex.spot") }]} />
          <Input label={t("paper.start")} inputMode="numeric" value={paperStart} onChange={(e) => setPaperStart(e.target.value.replace(/\D/g, ""))} />
          {err && <Alert>{err}</Alert>}
          <Button type="submit" size="lg" className="w-full" disabled={busy}>{busy ? <Spinner /> : t("paper.create")}</Button>
        </form>
      ) : !ex ? (
        <div className="space-y-3">
          <button onClick={() => { setPaper(true); setMarket("swap"); }} className="flex w-full items-center justify-between rounded-lg border border-accent/40 bg-accent/10 px-3 py-3 text-left">
            <span><span className="font-medium">{t("paper.title")}</span><span className="block text-xs text-muted">{t("paper.text")}</span></span>
            <Badge tone="accent">{t("paper.badge")}</Badge>
          </button>
          <div className="text-center text-xs text-muted">{t("paper.or")}</div>
          <Input autoFocus placeholder={t("ex.search")} value={search} onChange={(e) => setSearch(e.target.value)} />
          {!data ? <div className="py-8 text-center text-muted"><Spinner /></div> : (
            <div className="max-h-[55vh] overflow-y-auto">
              {!search && <div className="px-3 pb-1 pt-2 text-xs uppercase tracking-wide text-muted">{t("ex.popular")}</div>}
              {(search ? shown : shown.filter((e) => e.priority)).map((e) => <Row key={e.id} e={e} />)}
              {!search && <div className="px-3 pb-1 pt-4 text-xs uppercase tracking-wide text-muted">{t("ex.all", { n: list.length })}</div>}
              {!search && shown.filter((e) => !e.priority).map((e) => <Row key={e.id} e={e} />)}
            </div>
          )}
        </div>
      ) : (
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={ex.verified ? "up" : "muted"}>{ex.verified ? t("ex.verified") : t("ex.universal")}</Badge>
            <button type="button" className="text-sm text-muted hover:text-text" onClick={() => setEx(null)}>← {t("common.back")}</button>
          </div>

          <Seg<"spot" | "swap"> label={t("ex.market")} value={market} onChange={setMarket}
            options={[ex.swap && { v: "swap" as const, l: t("ex.swap") }, ex.spot && { v: "spot" as const, l: t("ex.spot") }]} />
          {ex.testnet && (
            <Seg<"live" | "testnet"> label={t("ex.env")} value={env} onChange={setEnv}
              options={[{ v: "live" as const, l: t("ex.live") }, { v: "testnet" as const, l: t("ex.testnet") }]} />
          )}

          <Alert tone="accent">
            {t("ex.howto", { name: ex.name })}
            {ex.www && <> <a href={ex.www} target="_blank" rel="noreferrer" className="text-accent underline">{t("ex.openSite")}</a></>}
          </Alert>

          {ex.fields.map((f) => (
            <Input key={f} label={t(`ex.field.${f}` as Key)} autoComplete="off" spellCheck={false}
              type={f === "secret" || f === "password" || f === "privateKey" ? "password" : "text"}
              value={creds[f] ?? ""} onChange={(e) => setCreds((c) => ({ ...c, [f]: e.target.value }))} />
          ))}
          <Input label={t("ex.label")} value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} />

          {confirmNeeded && (
            <Alert tone="warn">
              <div className="font-semibold">{t("ex.confirmTitle")}</div>
              <div className="mt-1 text-text/80">{t("ex.confirmText", { name: ex.name })}</div>
              <label className="mt-2 flex items-center gap-2 text-text">
                <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="h-4 w-4 accent-[var(--color-accent)]" />
                {t("ex.confirmBox")}
              </label>
            </Alert>
          )}
          {err && <Alert>{err}</Alert>}

          <Button type="submit" size="lg" className="w-full" disabled={busy || ex.fields.some((f) => !creds[f]?.trim()) || (confirmNeeded && !confirmed)}>
            {busy ? <><Spinner /> {t("ex.checking")}</> : t("ex.connect")}
          </Button>
        </form>
      )}
    </Modal>
  );
}

function Seg<V extends string>({ label, value, onChange, options }: { label: string; value: V; onChange: (v: V) => void; options: Array<{ v: V; l: string } | false> }) {
  const opts = options.filter(Boolean) as Array<{ v: V; l: string }>;
  return (
    <div>
      <div className="mb-1.5 text-sm text-muted">{label}</div>
      <div className="grid gap-1 rounded-lg border border-line bg-bg p-1" style={{ gridTemplateColumns: `repeat(${opts.length}, minmax(0, 1fr))` }}>
        {opts.map((o) => (
          <button type="button" key={o.v} onClick={() => onChange(o.v)}
            className={cx("rounded-md px-2 py-2 text-sm transition", value === o.v ? "bg-panel-2 text-text" : "text-muted hover:text-text")}>{o.l}</button>
        ))}
      </div>
    </div>
  );
}
