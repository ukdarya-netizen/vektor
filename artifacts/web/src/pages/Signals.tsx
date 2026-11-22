import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type Account } from "@/lib/api";
import { useT, type Key } from "@/lib/i18n";
import { time } from "@/lib/format";
import { Alert, Badge, Button, Card, Empty, Input, Modal, Spinner, Switch, cx } from "@/components/ui";
import { DEFAULT_PLAN, PlanEditor, planProblems, type Plan } from "@/components/terminal/PlanEditor";
import { GridsSection } from "./Grids";

type Settings = {
  amountMode: "usdt" | "percent"; amount: number; leverage: number; marginMode: "isolated" | "cross"; plan: Plan;
  allowLong: boolean; allowShort: boolean; onOpposite: "skip" | "close" | "reverse"; onSame: "skip" | "add"; ttlSec: number; allowOverrides: boolean;
};
type Bot = { id: number; account_id: number; name: string; token_hint: string; settings: Settings; enabled: boolean; signals24h: number };
type Signal = { id: number; bot_id: number; bot_name: string; raw: string; status: string; reason: string | null; detail: any; test: boolean; received_at: string };

const DEFAULT_SETTINGS: Settings = {
  amountMode: "usdt", amount: 10, leverage: 10, marginMode: "isolated", plan: DEFAULT_PLAN,
  allowLong: true, allowShort: true, onOpposite: "skip", onSame: "skip", ttlSec: 60, allowOverrides: true,
};

export const hookUrl = (token: string) => `${window.location.origin}${import.meta.env.BASE_URL.replace(/\/$/, "")}/api/hook/${token}`;

/** Human reason for a signal outcome: risk/preflight/bot reasons share the dictionaries. */
export function useReason() {
  const t = useT();
  return (reason: string | null) => {
    if (!reason) return "";
    const [k, rest] = reason.split(/:(.*)/s);
    for (const key of [`sig.reason.${k}`, `pf.${k}`, `pf.risk.${k}`, `plan.${k}`]) {
      const v = t(key as Key, { limit: "", need: "", have: "", value: "" });
      if (v !== key) return v.replace(/\s*\(\)\s*/g, "") + (k === "exchange_error" && rest ? `: ${rest}` : "");
    }
    const map: Record<string, string> = {
      stale: t.lang === "ru" ? "сигнал устарел" : "signal expired", duplicate: t.lang === "ru" ? "повтор" : "duplicate",
      already_in_position: t.lang === "ru" ? "позиция уже открыта" : "position already open", opposite_open: t.lang === "ru" ? "открыта обратная позиция" : "opposite position open",
      side_disabled: t.lang === "ru" ? "сторона выключена в боте" : "side turned off in the bot", source_disabled: t.lang === "ru" ? "бот выключен" : "bot is off",
      exchange_error: t.lang === "ru" ? "ошибка биржи" : "exchange error", account_paused: t.lang === "ru" ? "счёт на паузе" : "account paused",
    };
    return (map[k] ?? reason) + (k === "exchange_error" && rest ? `: ${rest}` : "");
  };
}

export function SignalsPage() {
  const t = useT();
  const qc = useQueryClient();
  const bots = useQuery({ queryKey: ["bots"], queryFn: () => api<{ bots: Bot[] }>("/bots") });
  const accs = useQuery({ queryKey: ["accounts"], queryFn: () => api<{ accounts: Account[] }>("/accounts") });
  const sigs = useQuery({ queryKey: ["signals"], queryFn: () => api<{ signals: Signal[] }>("/signals"), refetchInterval: 5_000 });
  const [editing, setEditing] = useState<Bot | "new" | null>(null);
  const [shown, setShown] = useState<{ bot: Bot; token: string } | null>(null);
  const reasonText = useReason();

  if (bots.isLoading) return <div className="py-20 text-center text-muted"><Spinner /></div>;
  const accLabel = (id: number) => accs.data?.accounts.find((a) => a.id === id)?.label ?? `#${id}`;

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">{t("bots.title")}</h2>
        {(bots.data?.bots.length ?? 0) > 0 && <Button onClick={() => setEditing("new")}>+ {t("bots.new")}</Button>}
      </div>
      {!bots.data?.bots.length ? (
        <Card><Empty title={t("bots.empty")} text={t("bots.emptyText")} action={<Button onClick={() => setEditing("new")}>{t("bots.new")}</Button>} /></Card>
      ) : bots.data.bots.map((b) => (
        <Card key={b.id} className="p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2"><span className="font-medium">{b.name}</span><Badge tone={b.enabled ? "up" : "muted"}>{b.enabled ? t("bots.on") : t("bots.off")}</Badge></div>
              <div className="mt-1 text-sm text-muted">{accLabel(b.account_id)} · {b.settings.amountMode === "percent" ? `${b.settings.amount}%` : `${b.settings.amount} USDT`} · {b.settings.leverage}x · {t("bots.signals24", { n: b.signals24h })}</div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Switch checked={b.enabled} onChange={async (v) => { await api(`/bots/${b.id}`, { method: "PATCH", body: { enabled: v } }); void qc.invalidateQueries({ queryKey: ["bots"] }); }} />
              <Button size="sm" variant="outline" onClick={() => setEditing(b)}>{t("bots.edit")}</Button>
              <Button size="sm" variant="ghost" onClick={async () => {
                if (!confirm(t("bots.newLinkConfirm"))) return;
                const r = await api<{ token: string }>(`/bots/${b.id}/token`, { method: "POST" });
                setShown({ bot: b, token: r.token });
              }}>{t("bots.newLink")}</Button>
              <Button size="sm" variant="danger" onClick={async () => {
                if (!confirm(t("bots.deleteConfirm", { name: b.name }))) return;
                await api(`/bots/${b.id}`, { method: "DELETE" }); void qc.invalidateQueries({ queryKey: ["bots"] });
              }}>{t("bots.delete")}</Button>
            </div>
          </div>
          <div className="mt-3 text-xs text-muted">{t("bots.hidden", { hint: b.token_hint })}</div>
          <TestBox bot={b} />
        </Card>
      ))}

      <div className="pt-4"><GridsSection /></div>

      <h2 className="pt-2 text-sm font-semibold uppercase tracking-wide text-muted">{t("bots.recent")}</h2>
      <Card>
        {!sigs.data?.signals.length ? <div className="px-4 py-6 text-sm text-muted">{t("bots.noSignals")}</div> : (
          <div className="divide-y divide-line">
            {sigs.data.signals.map((s) => (
              <div key={s.id} className="flex flex-wrap items-start justify-between gap-2 px-4 py-2.5 text-sm">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Badge tone={s.status === "executed" ? "up" : s.status === "rejected" ? "down" : s.status === "tested" ? "accent" : "muted"}>{t(`sig.${s.status}` as Key)}</Badge>
                    <span className="text-muted">{s.bot_name}</span>
                  </div>
                  <div className="mt-1 truncate font-mono text-xs text-muted" title={s.raw}>{s.raw.slice(0, 140)}</div>
                  {s.reason && <div className="mt-0.5 text-xs text-down">{reasonText(s.reason)}</div>}
                </div>
                <div className="text-xs text-muted">{time(s.received_at, t.lang)}</div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {editing && (
        <BotEditor bot={editing === "new" ? null : editing} accounts={(accs.data?.accounts ?? []).filter((a) => a.market === "swap")}
          onClose={() => setEditing(null)}
          onSaved={(bot, token) => { setEditing(null); void qc.invalidateQueries({ queryKey: ["bots"] }); if (token) setShown({ bot, token }); }} />
      )}
      {shown && <TokenModal bot={shown.bot} token={shown.token} onClose={() => setShown(null)} />}
    </div>
  );
}

function TokenModal({ bot, token, onClose }: { bot: Bot; token: string; onClose: () => void }) {
  const t = useT();
  const [copied, setCopied] = useState<string | null>(null);
  const url = hookUrl(token);
  const example = JSON.stringify({ action: "open", side: "{{strategy.order.action}}", symbol: "{{ticker}}", id: "{{timenow}}-{{ticker}}", time: "{{timenow}}" }, null, 0);
  const copy = (k: string, v: string) => { void navigator.clipboard.writeText(v); setCopied(k); setTimeout(() => setCopied(null), 2000); };
  return (
    <Modal open onClose={onClose} title={bot.name} wide>
      <Alert tone="warn">{t("bots.created")}</Alert>
      <div className="mt-4 text-sm text-muted">{t("bots.webhook")}</div>
      <div className="mt-1 flex gap-2">
        <input readOnly value={url} className="h-10 min-w-0 flex-1 rounded-lg border border-line bg-bg px-3 font-mono text-xs" onFocus={(e) => e.target.select()} />
        <Button size="sm" onClick={() => copy("u", url)}>{copied === "u" ? t("bots.copied") : t("bots.copy")}</Button>
      </div>
      <div className="mt-4 text-sm text-muted">{t("bots.example")}</div>
      <div className="mt-1 flex gap-2">
        <code className="block min-w-0 flex-1 overflow-x-auto rounded-lg border border-line bg-bg p-3 text-xs">{example}</code>
        <Button size="sm" variant="outline" onClick={() => copy("e", example)}>{copied === "e" ? t("bots.copied") : t("bots.copy")}</Button>
      </div>
      <div className="mt-2 text-xs text-muted">{t("bots.exampleHint")}</div>
    </Modal>
  );
}

function TestBox({ bot }: { bot: Bot }) {
  const t = useT();
  const reasonText = useReason();
  const [open, setOpen] = useState(false);
  const [raw, setRaw] = useState('{"action":"open","side":"long","symbol":"BINANCE:BTCUSDT.P"}');
  const [res, setRes] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  if (!open) return <button className="mt-2 text-xs text-accent hover:underline" onClick={() => setOpen(true)}>{t("bots.test")}</button>;
  const run = async () => {
    setBusy(true); setRes(null);
    try { setRes(await api(`/bots/${bot.id}/test`, { body: { raw } })); } catch (e) { setRes({ status: "rejected", reason: e instanceof ApiError ? e.code : "error" }); }
    finally { setBusy(false); }
  };
  const d = res?.detail;
  return (
    <div className="mt-3 space-y-2 rounded-lg border border-line p-3">
      <div className="text-xs text-muted">{t("bots.testHint")}</div>
      <textarea value={raw} onChange={(e) => setRaw(e.target.value)} rows={2} className="w-full rounded-md border border-line bg-bg p-2 font-mono text-xs outline-none focus:border-accent" />
      <Button size="sm" onClick={run} disabled={busy}>{busy ? <Spinner /> : t("bots.testRun")}</Button>
      {res && (
        <Alert tone={res.status === "tested" && !res.reason ? "up" : res.status === "tested" ? "warn" : "down"}>
          {d?.would === "open" && t("sig.would.open", { side: d.side === "long" ? t("tr.long") : t("tr.short"), coin: d.symbol?.split("/")[0] })}
          {d?.would === "close" && t("sig.would.close", { coin: d.symbol?.split("/")[0] })}
          {res.reason && <div>{reasonText(res.reason)}</div>}
        </Alert>
      )}
    </div>
  );
}

function BotEditor({ bot, accounts, onClose, onSaved }: { bot: Bot | null; accounts: Account[]; onClose: () => void; onSaved: (b: Bot, token?: string) => void }) {
  const t = useT();
  const [name, setName] = useState(bot?.name ?? "");
  const [accountId, setAccountId] = useState<number>(bot?.account_id ?? accounts[0]?.id ?? 0);
  const [s, setS] = useState<Settings>({ ...DEFAULT_SETTINGS, ...(bot?.settings ?? {}) });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<Settings>) => setS((x) => ({ ...x, ...p }));
  const bad = planProblems(s.plan, "long", 100).length > 0;

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const body = { name, accountId, settings: s };
      if (bot) { const r = await api<{ bot: Bot }>(`/bots/${bot.id}`, { method: "PUT", body }); onSaved(r.bot); }
      else { const r = await api<{ bot: Bot; token: string }>("/bots", { body }); onSaved(r.bot, r.token); }
    } catch (e) {
      const code = e instanceof ApiError ? e.code : "error";
      const k = `plan.${code}` as Key;
      setErr(t(k) !== k ? t(k) : t("err.generic"));
    } finally { setBusy(false); }
  };

  const Seg = <V extends string>({ value, options, onChange }: { value: V; options: Array<[V, string]>; onChange: (v: V) => void }) => (
    <div className="flex flex-wrap gap-1">
      {options.map(([v, l]) => (
        <button key={v} type="button" onClick={() => onChange(v)} className={cx("rounded-md border px-2.5 py-1.5 text-xs", value === v ? "border-accent text-text" : "border-line text-muted")}>{l}</button>
      ))}
    </div>
  );

  return (
    <Modal open onClose={onClose} title={bot ? bot.name : t("bots.new")} wide>
      <div className="space-y-4">
        <Input label={t("bots.name")} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
        <label className="block">
          <span className="mb-1.5 block text-sm text-muted">{t("bots.account")}</span>
          <select className="h-11 w-full rounded-lg border border-line bg-bg px-3" value={accountId} onChange={(e) => setAccountId(Number(e.target.value))}>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
          </select>
        </label>
        <div>
          <div className="mb-1.5 text-sm text-muted">{t("bots.size")}</div>
          <div className="grid grid-cols-3 gap-2">
            <input inputMode="decimal" className="h-10 rounded-lg border border-line bg-bg px-3" value={s.amount} onChange={(e) => set({ amount: Number(e.target.value.replace(",", ".")) || 0 })} />
            <select className="h-10 rounded-lg border border-line bg-bg px-2 text-sm" value={s.amountMode} onChange={(e) => set({ amountMode: e.target.value as any })}>
              <option value="usdt">{t("tr.margin")}</option><option value="percent">{t("bots.pctBalance")}</option>
            </select>
            <select className="h-10 rounded-lg border border-line bg-bg px-2 text-sm" value={s.leverage} onChange={(e) => set({ leverage: Number(e.target.value) })}>
              {[1, 2, 3, 5, 10, 15, 20, 25, 50, 75, 100].map((l) => <option key={l} value={l}>{l}x</option>)}
            </select>
          </div>
        </div>
        <div>
          <div className="mb-1.5 text-sm text-muted">{t("bots.sides")}</div>
          <div className="flex gap-4 text-sm">
            <label className="flex items-center gap-2"><Switch checked={s.allowLong} onChange={(v) => set({ allowLong: v })} />{t("tr.long")}</label>
            <label className="flex items-center gap-2"><Switch checked={s.allowShort} onChange={(v) => set({ allowShort: v })} />{t("tr.short")}</label>
          </div>
        </div>
        <div>
          <div className="mb-1.5 text-sm text-muted">{t("bots.opposite")}</div>
          <Seg value={s.onOpposite} onChange={(v) => set({ onOpposite: v })} options={[["skip", t("bots.opp.skip")], ["close", t("bots.opp.close")], ["reverse", t("bots.opp.reverse")]]} />
        </div>
        <div>
          <div className="mb-1.5 text-sm text-muted">{t("bots.same")}</div>
          <Seg value={s.onSame} onChange={(v) => set({ onSame: v })} options={[["skip", t("bots.same.skip")], ["add", t("bots.same.add")]]} />
        </div>
        <div className="grid grid-cols-2 items-end gap-3">
          <Input label={t("bots.ttl")} inputMode="numeric" value={s.ttlSec} onChange={(e) => set({ ttlSec: Math.max(5, Math.min(3600, Number(e.target.value) || 60)) })} />
          <label className="flex items-center gap-2 pb-2 text-sm"><Switch checked={s.allowOverrides} onChange={(v) => set({ allowOverrides: v })} />{t("bots.overrides")}</label>
        </div>
        <div className="rounded-lg border border-line p-3">
          <div className="mb-3 text-sm font-medium">{t("plan.title")}</div>
          <PlanEditor plan={s.plan} onChange={(plan) => set({ plan })} side="long" entry={null} prec={2} />
        </div>
        {err && <Alert>{err}</Alert>}
        <Button className="w-full" size="lg" onClick={save} disabled={busy || !name.trim() || !accountId || !(s.amount > 0) || bad}>{busy ? <Spinner /> : t("bots.save")}</Button>
      </div>
    </Modal>
  );
}
