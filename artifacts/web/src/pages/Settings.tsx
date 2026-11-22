import { useState } from "react";
import { Link, useRoute } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Account, type User } from "@/lib/api";
import { useT, type Key } from "@/lib/i18n";
import { time } from "@/lib/format";
import { Alert, Badge, Button, Card, Empty, Input, Spinner, Switch, cx } from "@/components/ui";
import { ConnectExchange } from "@/components/ConnectExchange";
import { TelegramConnect, useNotif } from "@/components/TelegramConnect";

const TABS: Array<{ id: string; key: Key }> = [
  { id: "exchanges", key: "settings.exchanges" },
  { id: "notifications", key: "settings.notifications" },
  { id: "risk", key: "settings.risk" },
  { id: "security", key: "settings.security" },
  { id: "language", key: "settings.language" },
];

export function SettingsPage({ user, onUserChange }: { user: User; onUserChange: () => void }) {
  const t = useT();
  const [, params] = useRoute("/settings/:tab");
  const tab = params?.tab ?? "exchanges";
  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-5 flex gap-1 overflow-x-auto border-b border-line">
        {TABS.map((x) => (
          <Link key={x.id} href={`/settings/${x.id}`}
            className={cx("whitespace-nowrap border-b-2 px-3 py-2.5 text-sm transition", tab === x.id ? "border-accent text-text" : "border-transparent text-muted hover:text-text")}>
            {t(x.key)}
          </Link>
        ))}
      </div>
      {tab === "exchanges" && <Exchanges />}
      {tab === "notifications" && <Notifications />}
      {tab === "risk" && <Risk />}
      {tab === "security" && <Security />}
      {tab === "language" && <Language user={user} onChange={onUserChange} />}
    </div>
  );
}

function Exchanges() {
  const t = useT();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);
  const { data, isLoading } = useQuery({ queryKey: ["accounts"], queryFn: () => api<{ accounts: Account[] }>("/accounts") });
  const refresh = () => Promise.all(["accounts", "portfolio", "positions"].map((k) => qc.invalidateQueries({ queryKey: [k] })));

  const act = async (id: number, fn: () => Promise<unknown>) => { setBusy(id); try { await fn(); await refresh(); } finally { setBusy(null); } };

  return (
    <div className="space-y-4">
      {(data?.accounts.length ?? 0) > 0 && <div className="flex justify-end"><Button onClick={() => setOpen(true)}>+ {t("ex.add")}</Button></div>}
      {isLoading ? <div className="py-10 text-center text-muted"><Spinner /></div> : !data?.accounts.length ? (
        <Card><Empty title={t("ex.none")} action={<Button onClick={() => setOpen(true)}>{t("ex.add")}</Button>} /></Card>
      ) : data.accounts.map((a) => (
        <Card key={a.id} className="p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{a.label}</span>
                <Badge tone={a.status === "ok" ? "up" : a.status === "paused" ? "muted" : "down"}>{t(`ex.status.${a.status}` as Key)}</Badge>
                {a.env === "testnet" && <Badge tone="warn">{t("mode.testnet")}</Badge>}
                {a.env === "paper" && <Badge tone="accent">{t("mode.paper")}</Badge>}
              </div>
              <div className="mt-1 text-sm text-muted">{a.market === "swap" ? t("ex.swap") : t("ex.spot")}{a.env !== "paper" && <> · API {a.key_hint}</>}</div>
              {a.env !== "paper" && <div className="mt-1 text-xs text-muted">{a.withdraw_check === "verified_off" ? t("ex.permVerified") : t("ex.permConfirmed")}</div>}
              {a.status === "error" && a.last_error && (
                <div className="mt-2"><Alert>{a.last_error === "withdraw_enabled" ? t("ex.err.withdraw") : a.last_error}</Alert></div>
              )}
            </div>
            <div className="flex flex-wrap gap-1">
              {a.env === "paper" && (
                <Button size="sm" variant="ghost" disabled={busy === a.id} onClick={() => {
                  const v = prompt(t("paper.start"), "10000");
                  if (v && Number(v) >= 10 && confirm(t("paper.resetConfirm", { label: a.label, v }))) void act(a.id, () => api(`/accounts/${a.id}/paper-reset`, { body: { startUsdt: Number(v) } }));
                }}>{t("paper.reset")}</Button>
              )}
              <Button size="sm" variant="ghost" disabled={busy === a.id} onClick={() => act(a.id, () => api(`/accounts/${a.id}/check`, { method: "POST" }))}>
                {busy === a.id ? <Spinner /> : t("ex.check")}
              </Button>
              <Button size="sm" variant="ghost" disabled={busy === a.id} onClick={() => act(a.id, () => api(`/accounts/${a.id}`, { method: "PATCH", body: { paused: a.status !== "paused" } }))}>
                {a.status === "paused" ? t("ex.resume") : t("ex.pause")}
              </Button>
              <Button size="sm" variant="danger" disabled={busy === a.id}
                onClick={() => confirm(t("ex.deleteConfirm", { label: a.label })) && act(a.id, () => api(`/accounts/${a.id}`, { method: "DELETE" }))}>
                {t("common.delete")}
              </Button>
            </div>
          </div>
        </Card>
      ))}
      <ConnectExchange open={open} onClose={() => setOpen(false)} />
    </div>
  );
}

const GROUP_KEYS = ["trades", "not_opened", "exchange", "reconcile", "signals", "account"] as const;

function Notifications() {
  const t = useT();
  const qc = useQueryClient();
  const { data } = useNotif();
  if (!data) return <div className="py-10 text-center text-muted"><Spinner /></div>;
  const save = async (body: unknown) => {
    await api("/notifications", { method: "PUT", body });
    await qc.invalidateQueries({ queryKey: ["notifications"] });
  };
  const quietOn = data.quietFrom !== null && data.quietTo !== null;
  const hours = Array.from({ length: 24 }, (_, h) => h);
  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="mb-3 font-medium">{t("ntf.telegram")}</div>
        <TelegramConnect />
      </Card>
      <Channels data={data} save={save} />
      <Card className="p-4">
        <div className="mb-3 font-medium">{t("ntf.what")}</div>
        <div className="divide-y divide-line">
          {GROUP_KEYS.map((g) => (
            <label key={g} className="flex items-center justify-between gap-4 py-3 text-sm">
              <span>{t(`ntf.g.${g}` as Key)}</span>
              <Switch checked={Boolean(data.groups[g])} onChange={(v) => save({ groups: { [g]: v } })} />
            </label>
          ))}
        </div>
        <div className="mt-3 text-xs text-muted">{t("ntf.always")}</div>
      </Card>
      <Card className="p-4">
        <div className="flex items-center justify-between gap-4">
          <span className="font-medium">{t("ntf.quiet")}</span>
          <Switch checked={quietOn} onChange={(v) => save(v ? { quietFrom: 23, quietTo: 8 } : { quietFrom: null, quietTo: null })} />
        </div>
        {quietOn && (
          <div className="mt-3 flex items-center gap-2 text-sm">
            {t("ntf.quietFrom")}
            <select className="rounded-md border border-line bg-bg px-2 py-1.5" value={data.quietFrom!} onChange={(e) => save({ quietFrom: Number(e.target.value), quietTo: data.quietTo })}>
              {hours.map((h) => <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>)}
            </select>
            {t("ntf.quietTo")}
            <select className="rounded-md border border-line bg-bg px-2 py-1.5" value={data.quietTo!} onChange={(e) => save({ quietFrom: data.quietFrom, quietTo: Number(e.target.value) })}>
              {hours.map((h) => <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>)}
            </select>
          </div>
        )}
      </Card>
      {(data.delivery.pending > 0 || data.delivery.lastFailure) && (
        <Card className="space-y-2 p-4 text-sm">
          <div className="font-medium">{t("ntf.delivery")}</div>
          {data.delivery.pending > 0 && <div className="text-muted">{t("ntf.pending", { n: data.delivery.pending })}</div>}
          {data.delivery.lastFailure && <Alert>{t("ntf.failed", { err: data.delivery.lastFailure.error })}</Alert>}
        </Card>
      )}
    </div>
  );
}

function TwoFactor() {
  const t = useT();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["2fa"], queryFn: () => api<{ enabled: boolean }>("/auth/2fa") });
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [code, setCode] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const start = async () => {
    const r = await api<{ secret: string; url: string }>("/auth/2fa/setup", { method: "POST" });
    const QR = await import("qrcode");
    setSetup({ secret: r.secret, qr: await QR.toDataURL(r.url, { margin: 1, width: 200 }) });
    setErr(null); setCode("");
  };
  const enable = async () => {
    try { await api("/auth/2fa/enable", { body: { code } }); setSetup(null); void qc.invalidateQueries({ queryKey: ["2fa"] }); }
    catch (e: any) { setErr(t(`err.${e?.code}` as Key) !== `err.${e?.code}` ? t(`err.${e?.code}` as Key) : t("err.generic")); }
  };
  const disable = async () => {
    const c = prompt(t("tfa.disablePrompt"));
    if (!c) return;
    try { await api("/auth/2fa/disable", { body: { code: c } }); void qc.invalidateQueries({ queryKey: ["2fa"] }); }
    catch { alert(t("err.wrong_2fa")); }
  };
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="font-medium">{t("tfa.title")}</div>
        <Badge tone={data?.enabled ? "up" : "muted"}>{data?.enabled ? t("tfa.on") : t("tfa.off")}</Badge>
      </div>
      <div className="mt-1 text-sm text-muted">{t("tfa.text")}</div>
      {data?.enabled ? <Button className="mt-3" size="sm" variant="danger" onClick={disable}>{t("tfa.disable")}</Button>
        : !setup ? <Button className="mt-3" size="sm" onClick={start}>{t("tfa.setup")}</Button>
        : (
          <div className="mt-3 space-y-3">
            <div className="text-sm">{t("tfa.scan")}</div>
            <div className="flex flex-wrap items-center gap-4">
              <img src={setup.qr} alt="QR" className="h-40 w-40 rounded-lg bg-white p-1" />
              <code className="break-all rounded-md bg-bg px-2 py-1 font-mono text-xs">{setup.secret}</code>
            </div>
            <div className="flex items-end gap-2">
              <div className="w-40"><Input label={t("tfa.code")} inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} error={err} /></div>
              <Button onClick={enable} disabled={code.length !== 6}>{t("tfa.confirm")}</Button>
            </div>
          </div>
        )}
    </Card>
  );
}

function Security() {
  const t = useT();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["sessions"], queryFn: () => api<{ sessions: Array<{ id: string; current: boolean; userAgent: string; ip: string; lastSeenAt: string }> }>("/auth/sessions") });
  return (
    <div className="space-y-4">
    <TwoFactor />
    <Card className="p-4">
      <div className="mb-3 font-medium">{t("sec.sessions")}</div>
      <div className="divide-y divide-line">
        {data?.sessions.map((s) => (
          <div key={s.id} className="flex items-center justify-between gap-3 py-3 text-sm">
            <div className="min-w-0">
              <div className="truncate">{s.userAgent || "—"}</div>
              <div className="text-xs text-muted">{s.ip} · {t("sec.lastSeen")}: {time(s.lastSeenAt, t.lang)}</div>
            </div>
            {s.current && <Badge tone="accent">{t("sec.current")}</Badge>}
          </div>
        ))}
      </div>
      {(data?.sessions.length ?? 0) > 1 && (
        <Button className="mt-3" variant="outline" size="sm"
          onClick={async () => { await api("/auth/logout-others", { method: "POST" }); await qc.invalidateQueries({ queryKey: ["sessions"] }); }}>
          {t("sec.logoutOthers")}
        </Button>
      )}
    </Card>
    </div>
  );
}

function Language({ user, onChange }: { user: User; onChange: () => void }) {
  const t = useT();
  const zones = (Intl as any).supportedValuesOf?.("timeZone") as string[] | undefined;
  const save = async (body: unknown) => { await api("/auth/me", { method: "PATCH", body }); onChange(); };
  return (
    <Card className="space-y-4 p-4">
      <div>
        <div className="mb-1.5 text-sm text-muted">{t("lang.language")}</div>
        <div className="flex gap-2">
          {(["ru", "en"] as const).map((l) => (
            <Button key={l} size="sm" variant={user.lang === l ? "primary" : "outline"} onClick={() => save({ lang: l })}>{l === "ru" ? "Русский" : "English"}</Button>
          ))}
        </div>
      </div>
      <div>
        <div className="mb-1.5 text-sm text-muted">{t("lang.tz")}</div>
        <select className="h-10 w-full rounded-lg border border-line bg-bg px-3" value={user.tz} onChange={(e) => save({ tz: e.target.value })}>
          {(zones ?? ["UTC", user.tz]).map((z) => <option key={z} value={z}>{z}</option>)}
        </select>
      </div>
    </Card>
  );
}

type Limits = { killSwitch: boolean; maxLeverage: number | null; maxMarginPerTrade: number | null; maxOpenPositions: number | null; dailyLossLimit: number | null };

function Risk() {
  const t = useT();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["risk"], queryFn: () => api<{ limits: Limits }>("/risk") });
  const [saved, setSaved] = useState(false);
  if (!data) return <div className="py-10 text-center text-muted"><Spinner /></div>;
  const l = data.limits;
  const save = async (patch: Partial<Limits>) => {
    await api("/risk", { method: "PUT", body: { ...l, ...patch } });
    await qc.invalidateQueries({ queryKey: ["risk"] });
    setSaved(true); setTimeout(() => setSaved(false), 1500);
  };
  const Field = ({ k, label, hint, int }: { k: keyof Omit<Limits, "killSwitch">; label: string; hint?: string; int?: boolean }) => (
    <label className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
      <span>{label}{hint && <span className="mt-0.5 block text-xs text-muted">{hint}</span>}</span>
      <input inputMode="decimal" placeholder={t("risk.none")} defaultValue={l[k] ?? ""} key={String(l[k])}
        onBlur={(e) => { const v = e.target.value.trim() === "" ? null : Number(e.target.value.replace(",", ".")); if (v === null || v > 0) void save({ [k]: v === null ? null : int ? Math.round(v) : v } as Partial<Limits>); }}
        className="h-9 w-36 rounded-lg border border-line bg-bg px-3 text-right outline-none focus:border-accent" />
    </label>
  );
  return (
    <div className="space-y-4">
      <Card className={cx("p-4", l.killSwitch && "border-down/50")}>
        <div className="flex items-center justify-between gap-4">
          <div><div className="font-medium">{t("risk.kill")}</div><div className="mt-1 text-sm text-muted">{t("risk.killHint")}</div></div>
          <Switch checked={l.killSwitch} onChange={(v) => save({ killSwitch: v })} />
        </div>
      </Card>
      <Card className="divide-y divide-line px-4">
        <Field k="maxLeverage" label={t("risk.maxLeverage")} int />
        <Field k="maxMarginPerTrade" label={t("risk.maxMargin")} />
        <Field k="maxOpenPositions" label={t("risk.maxPositions")} int />
        <Field k="dailyLossLimit" label={t("risk.dailyLoss")} hint={t("risk.dailyHint")} />
      </Card>
      {saved && <div className="text-sm text-up">{t("risk.saved")}</div>}
    </div>
  );
}

function Channels({ data, save }: { data: import("@/components/TelegramConnect").NotifState; save: (b: unknown) => Promise<void> }) {
  const t = useT();
  const qc = useQueryClient();
  const [err, setErr] = useState<string | null>(null);
  const Modes = ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <div className="flex gap-1">
      {(["off", "critical", "all"] as const).map((m) => (
        <button key={m} onClick={() => onChange(m)} className={cx("rounded-md border px-2 py-1 text-xs", value === m ? "border-accent text-text" : "border-line text-muted")}>{t(`ntf.mode.${m}` as Key)}</button>
      ))}
    </div>
  );
  const b64 = (s: string) => { const p = "=".repeat((4 - (s.length % 4)) % 4); const r = atob((s + p).replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from(r, (c) => c.charCodeAt(0)); };
  const enablePush = async () => {
    setErr(null);
    if (!data.push.publicKey) { setErr(t("ntf.pushNo")); return; }
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) { setErr(t("ntf.pushUnsupported")); return; }
    const perm = await Notification.requestPermission();
    if (perm !== "granted") { setErr(t("ntf.pushDenied")); return; }
    const reg = await navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`);
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(data.push.publicKey) });
    await api("/notifications/push", { body: { subscription: sub.toJSON() } });
    void qc.invalidateQueries({ queryKey: ["notifications"] });
  };
  return (
    <Card className="space-y-3 p-4">
      <div className="font-medium">{t("ntf.channels")}</div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span>{t("ntf.email", { addr: data.email.address })}</span>
        {data.email.configured ? <Modes value={data.email.mode} onChange={(v) => save({ emailMode: v })} /> : <span className="text-xs text-warn">{t("ntf.mailNo")}</span>}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span>{t("ntf.push")}{data.push.devices > 0 && <span className="ml-2 text-xs text-muted">{t("ntf.pushDevices", { n: data.push.devices })}</span>}</span>
        <div className="flex flex-wrap items-center gap-2">
          {data.push.devices > 0 && <Modes value={data.push.mode} onChange={(v) => save({ pushMode: v })} />}
          <Button size="sm" variant="outline" onClick={enablePush}>{t("ntf.pushOn")}</Button>
          {data.push.devices > 0 && <Button size="sm" variant="danger" onClick={async () => { await api("/notifications/push", { method: "DELETE" }); void qc.invalidateQueries({ queryKey: ["notifications"] }); }}>{t("ntf.pushOff")}</Button>}
        </div>
      </div>
      <div className="text-xs text-muted">{t("ntf.channelsHint")}</div>
      {err && <Alert tone="warn">{err}</Alert>}
    </Card>
  );
}
