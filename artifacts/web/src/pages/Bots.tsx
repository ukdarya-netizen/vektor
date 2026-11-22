import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type Account } from "@/lib/api";
import { useT, type Key } from "@/lib/i18n";
import { Alert, Badge, Button, Card, Input, Modal, Spinner, cx } from "@/components/ui";
import { TelegramConnect } from "@/components/TelegramConnect";
import { BotEditor, DEFAULT_SETTINGS, type Settings } from "./Signals";

type Months = 1 | 3 | 12;
type Period = { key: "1m" | "6m" | "12m"; from: string; to: string; signals: number; winRatePct: number | null; pnlPct: number | null };
type ShopBot = {
  key: string; name: string; desc: { ru: string; en: string }; telegram: string | null; connected: boolean;
  stats: { periods: Period[]; updatedAt: string } | null;
  access: { until: string | null; where: "vector" | "direct" | null };
  autoUntil: string | null;
  copy: { id: number; account_id: number; settings: Settings; enabled: boolean } | null;
};
export type Catalog = {
  payments: boolean; periods: Months[]; prices: Record<"terminal" | "access" | "auto", Record<Months, number>>;
  terminal: { plan: string; until: string | null; paidUntil: string | null };
  telegramLinked: boolean; bots: ShopBot[];
};
export type Item = { product: string; months: Months };

const date = (d: string | null, lang: string, short = false) => d ? new Date(d).toLocaleDateString(lang === "ru" ? "ru-RU" : "en-GB", short ? { day: "numeric", month: "short", year: "numeric" } : { day: "numeric", month: "long", year: "numeric" }) : "";
export const useCatalog = () => useQuery({ queryKey: ["shop"], queryFn: () => api<Catalog>("/shop/catalog") });

export function BotsPage() {
  const t = useT();
  const { data } = useCatalog();
  const [buy, setBuy] = useState<{ title: string; kinds: Array<{ product: string; kind: "access" | "auto" | "terminal" }> } | null>(null);
  const [auto, setAuto] = useState<ShopBot | null>(null);
  if (!data) return <div className="py-16 text-center text-muted"><Spinner /></div>;
  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <p className="max-w-3xl text-sm text-muted">{t("shop.subtitle")}</p>
      {!data.payments && <Alert tone="warn">{t("shop.notConfigured")}</Alert>}
      {!data.telegramLinked && (
        <Card className="p-4">
          <div className="mb-2 text-sm">{t("shop.needTelegram")}</div>
          <TelegramConnect compact />
        </Card>
      )}
      <div className="grid gap-4 lg:grid-cols-3">
        {data.bots.map((b) => (
          <BotCard key={b.key} bot={b} cat={data}
            onAccess={() => setBuy({ title: b.name, kinds: [{ product: `bot:${b.key}:access`, kind: "access" }] })}
            onAuto={() => b.autoUntil ? setAuto(b) : setBuy({ title: `${b.name} — ${t("shop.auto")}`, kinds: [...(b.access.until ? [] : [{ product: `bot:${b.key}:access`, kind: "access" as const }]), { product: `bot:${b.key}:auto`, kind: "auto" }] })} />
        ))}
      </div>
      <p className="text-xs leading-relaxed text-muted">{t("shop.disclaimer")}</p>
      {buy && <Checkout title={buy.title} kinds={buy.kinds} cat={data} onClose={() => setBuy(null)} />}
      {auto && <AutoSettings bot={auto} onClose={() => setAuto(null)} />}
    </div>
  );
}

function Stats({ bot }: { bot: ShopBot }) {
  const t = useT();
  if (!bot.stats?.periods.length) return <div className="rounded-lg border border-line px-3 py-3 text-xs text-muted">{t("shop.statsSoon")}</div>;
  return (
    <div className="divide-y divide-line rounded-lg border border-line">
      {bot.stats.periods.map((p) => (
        <div key={p.key} className="px-3 py-2.5">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-sm font-medium">{t(`shop.p.${p.key}` as Key)}</span>
            <span className="text-[11px] text-muted">{date(p.from, t.lang, true)} — {date(p.to, t.lang, true)}</span>
          </div>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
            <span><span className="num text-text">{p.signals}</span> {t("shop.signals")}</span>
            {p.winRatePct !== null && <span><span className="num text-text">{p.winRatePct.toFixed(0)}%</span> {t("shop.inProfit")}</span>}
            {p.pnlPct !== null && <span className={cx("num", p.pnlPct >= 0 ? "text-up" : "text-down")}>{p.pnlPct >= 0 ? "+" : ""}{p.pnlPct.toFixed(1)}%</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

function BotCard({ bot, cat, onAccess, onAuto }: { bot: ShopBot; cat: Catalog; onAccess: () => void; onAuto: () => void }) {
  const t = useT();
  const can = cat.payments && cat.telegramLinked;
  return (
    <Card className="flex flex-col p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="font-display text-lg font-semibold">{bot.name}</div>
        {bot.access.until ? <Badge tone="up">{t("shop.active")}</Badge> : <Badge>{t("shop.inactive")}</Badge>}
      </div>
      <p className="mt-2 text-sm text-muted">{bot.desc[t.lang]}</p>
      <div className="mt-4"><Stats bot={bot} /></div>
      <div className="mt-4 space-y-1.5 text-sm">
        <Row label={t("shop.access")} value={bot.access.until ? t(bot.access.where === "direct" ? "shop.untilDirect" : "shop.until", { d: date(bot.access.until, t.lang) }) : `${cat.prices.access[1]} USDT / ${t("shop.mo")}`} />
        <Row label={t("shop.auto")} value={bot.autoUntil ? t("shop.until", { d: date(bot.autoUntil, t.lang) }) : `+${cat.prices.auto[1]} USDT / ${t("shop.mo")}`} />
      </div>
      <div className="mt-auto space-y-2 pt-5">
        <div className="grid grid-cols-2 gap-2">
          <Button variant="outline" onClick={onAccess} disabled={!can}>{bot.access.until && bot.access.where === "vector" ? t("shop.extend") : t("shop.buyAccess")}</Button>
          <Button onClick={onAuto} disabled={!can && !bot.autoUntil}>{bot.autoUntil ? t("shop.autoSettings") : t("shop.buyAuto")}</Button>
        </div>
        <div className="h-4 text-center">{bot.telegram && <a className="text-xs text-accent hover:underline" href={`https://t.me/${bot.telegram}`} target="_blank" rel="noreferrer">{t("shop.openTg")}</a>}</div>
      </div>
    </Card>
  );
}
const Row = ({ label, value }: { label: string; value: string }) => (
  <div className="flex items-center justify-between gap-3"><span className="text-muted">{label}</span><span className="num text-right">{value}</span></div>
);

/** Choose a period → invoice with a unique amount → QR + exact amount → waits for the chain. */
export function Checkout({ title, kinds, cat, onClose }: { title: string; kinds: Array<{ product: string; kind: "access" | "auto" | "terminal" }>; cat: Catalog; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [months, setMonths] = useState<Months>(1);
  const [inv, setInv] = useState<{ id: number; amount: number; address: string; expiresAt: string } | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const total = kinds.reduce((s, k) => s + cat.prices[k.kind][months], 0);
  const full = kinds.reduce((s, k) => s + cat.prices[k.kind][1] * months, 0);

  const status = useQuery({
    queryKey: ["invoice", inv?.id], enabled: Boolean(inv),
    queryFn: () => api<{ status: string; tx_hash: string | null }>(`/shop/invoice/${inv!.id}`),
    refetchInterval: (q) => (q.state.data?.status === "paid" ? false : 5_000),
  });
  const paid = status.data?.status === "paid";
  useEffect(() => { if (paid) { void qc.invalidateQueries({ queryKey: ["shop"] }); void qc.invalidateQueries({ queryKey: ["billing"] }); void qc.invalidateQueries({ queryKey: ["me"] }); } }, [paid, qc]);

  const create = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api<{ id: number; amount: number; address: string; expiresAt: string }>("/shop/invoice", { body: { items: kinds.map((k) => ({ product: k.product, months })) } });
      setInv(r);
      const QR = await import("qrcode");
      setQr(await QR.toDataURL(r.address, { margin: 1, width: 220 }));
    } catch (e) {
      const c = e instanceof ApiError ? e.code : "error";
      const k = `shop.err.${c}` as Key;
      setErr(t(k) !== k ? t(k) : t("err.generic"));
    } finally { setBusy(false); }
  };

  return (
    <Modal open onClose={onClose} title={title} wide>
      {!inv ? (
        <div className="space-y-4">
          {kinds.length > 1 && <Alert tone="accent">{t("shop.bundleNote")}</Alert>}
          <div className="grid grid-cols-3 gap-2">
            {cat.periods.map((m) => (
              <button key={m} onClick={() => setMonths(m)} className={cx("rounded-xl border p-3 text-left", months === m ? "border-accent bg-accent/10" : "border-line hover:border-muted")}>
                <div className="text-sm font-medium">{t(`shop.m${m}` as Key)}</div>
                <div className="num mt-1 text-lg font-semibold">{kinds.reduce((s, k) => s + cat.prices[k.kind][m], 0)} <span className="text-xs font-normal text-muted">USDT</span></div>
                <div className="mt-0.5 h-4 text-[11px] text-up">{m > 1 ? `−${m === 3 ? 10 : 20}%` : ""}</div>
              </button>
            ))}
          </div>
          <div className="flex items-baseline justify-between text-sm">
            <span className="text-muted">{t("shop.total")}</span>
            <span><span className="num text-xl font-semibold">{total} USDT</span>{full !== total && <span className="num ml-2 text-xs text-muted line-through">{full}</span>}</span>
          </div>
          <div className="text-xs text-muted">{t("shop.network")}</div>
          {err && <Alert>{err}</Alert>}
          <Button className="w-full" size="lg" onClick={create} disabled={busy}>{busy ? <Spinner /> : t("shop.pay")}</Button>
          <p className="text-[11px] leading-relaxed text-muted">{t("shop.disclaimer")}</p>
        </div>
      ) : paid ? (
        <div className="space-y-3 py-4 text-center">
          <div className="text-4xl">✓</div>
          <div className="text-lg font-semibold">{t("shop.paid")}</div>
          <div className="text-sm text-muted">{t("shop.paidText")}</div>
          <Button className="w-full" onClick={onClose}>{t("common.close")}</Button>
        </div>
      ) : (
        <Pay inv={inv} qr={qr} onExpired={() => setInv(null)} />
      )}
    </Modal>
  );
}

function Pay({ inv, qr, onExpired }: { inv: { id: number; amount: number; address: string; expiresAt: string }; qr: string | null; onExpired: () => void }) {
  const t = useT();
  const [left, setLeft] = useState(() => new Date(inv.expiresAt).getTime() - Date.now());
  const [copied, setCopied] = useState<string | null>(null);
  const [other, setOther] = useState(false);
  const [txid, setTxid] = useState("");
  const [sent, setSent] = useState(false);
  useEffect(() => { const i = setInterval(() => setLeft(new Date(inv.expiresAt).getTime() - Date.now()), 1000); return () => clearInterval(i); }, [inv.expiresAt]);
  const copy = (v: string, k: string) => { void navigator.clipboard?.writeText(v); setCopied(k); setTimeout(() => setCopied(null), 1500); };
  const amount = inv.amount.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  const mm = Math.max(0, Math.floor(left / 60000)), ss = Math.max(0, Math.floor(left / 1000) % 60);
  const sendTx = async () => { try { await api(`/shop/invoice/${inv.id}/txid`, { body: { txid } }); setSent(true); } catch { alert(t("shop.err.bad_txid")); } };
  if (left <= 0) return (
    <div className="space-y-3 py-2">
      <Alert tone="warn">{t("shop.expired")}</Alert>
      <Button className="w-full" onClick={onExpired}>{t("shop.newInvoice")}</Button>
    </div>
  );
  return (
    <div className="space-y-4">
      <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-start">
        {qr ? <img src={qr} alt="QR" className="h-44 w-44 shrink-0 rounded-lg bg-white p-1.5" /> : <div className="h-44 w-44" />}
        <div className="w-full min-w-0 space-y-3">
          <Field label={t("shop.sendExactly")} value={`${amount} USDT`} big onCopy={() => copy(amount, "a")} copied={copied === "a"} />
          <Field label={t("shop.toAddress")} value={inv.address} onCopy={() => copy(inv.address, "w")} copied={copied === "w"} />
          <div className="flex items-center gap-2 text-sm text-muted"><Spinner /> {t("shop.waiting", { t: `${mm}:${String(ss).padStart(2, "0")}` })}</div>
        </div>
      </div>
      <Alert tone="warn">{t("shop.exactWarn")}</Alert>
      {!other ? <button className="text-xs text-muted underline hover:text-text" onClick={() => setOther(true)}>{t("shop.otherAmount")}</button> : sent ? (
        <Alert tone="up">{t("shop.txSent")}</Alert>
      ) : (
        <div className="space-y-2">
          <div className="text-xs text-muted">{t("shop.txHelp")}</div>
          <div className="flex gap-2">
            <Input placeholder="TxID" value={txid} onChange={(e) => setTxid(e.target.value.trim())} className="font-mono text-xs" />
            <Button onClick={sendTx} disabled={!/^[0-9a-fA-F]{64}$/.test(txid)}>{t("shop.txSend")}</Button>
          </div>
        </div>
      )}
    </div>
  );
}

const Field = ({ label, value, onCopy, copied, big }: { label: string; value: string; onCopy: () => void; copied: boolean; big?: boolean }) => {
  const t = useT();
  return (
    <div>
      <div className="mb-1 text-xs text-muted">{label}</div>
      <button onClick={onCopy} className="flex w-full items-center justify-between gap-2 rounded-lg border border-line bg-bg px-3 py-2 text-left hover:border-accent">
        <span className={cx("num", big ? "whitespace-nowrap text-xl font-semibold" : "break-all text-xs")}>{value}</span>
        <span className="shrink-0 text-xs text-accent">{copied ? "✓" : t("shop.copy")}</span>
      </button>
    </div>
  );
};

function AutoSettings({ bot, onClose }: { bot: ShopBot; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const accs = useQuery({ queryKey: ["accounts"], queryFn: () => api<{ accounts: Account[] }>("/accounts") });
  const futures = (accs.data?.accounts ?? []).filter((a) => a.market === "swap");
  const [enabled, setEnabled] = useState(bot.copy?.enabled ?? true);
  if (!accs.data) return null;
  if (!futures.length) return <Modal open onClose={onClose} title={`${bot.name} — ${t("shop.auto")}`}><Alert tone="warn">{t("shop.futuresOnly")}</Alert></Modal>;
  const seed = { id: bot.copy?.id ?? 0, account_id: bot.copy?.account_id ?? futures[0].id, name: bot.name, token_hint: "", settings: { ...DEFAULT_SETTINGS, ...(bot.copy?.settings ?? {}) }, enabled, signals24h: 0, channels: [] };
  return (
    <BotEditor bot={seed} accounts={futures} title={`${bot.name} — ${t("shop.auto")}`} onClose={onClose} onSaved={() => undefined}
      extra={
        <div className="flex items-center justify-between gap-3 rounded-lg border border-line p-3 text-sm">
          <span>{t("shop.autoOn")}<span className="block text-xs text-muted">{t("shop.until", { d: date(bot.autoUntil, t.lang) })}</span></span>
          <button onClick={() => setEnabled(!enabled)} className={cx("rounded-md border px-3 py-1.5 text-xs", enabled ? "border-up text-up" : "border-line text-muted")}>{enabled ? t("shop.on") : t("shop.off")}</button>
        </div>
      }
      submit={async (accountId, s) => {
        await api(`/shop/autotrade/${bot.key}`, { method: "PUT", body: { accountId, settings: s, enabled } });
        void qc.invalidateQueries({ queryKey: ["shop"] });
        onClose();
      }} />
  );
}
