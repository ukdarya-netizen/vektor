import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useT, type Key } from "@/lib/i18n";
import { num, pct, signedUsd, time, tone, usd } from "@/lib/format";
import { Badge, Card, Empty, Spinner, cx } from "@/components/ui";

type Row = {
  id: number; symbol: string; side: "long" | "short"; source: string; source_label: string; status: string;
  entry_price: string | null; exit_price: string | null; initial_qty: string | null; leverage: number | null;
  pnl: string | null; pnl_pct: string | null; fees: string | null; close_reason: string | null;
  opened_at: string | null; closed_at: string | null; created_at: string; account_label: string; env: string;
};
type J = { days: number; positions: Row[]; summary: { closed: number; wins: number; losses: number; pnl: number; fees: number } };

export function JournalPage() {
  const t = useT();
  const [days, setDays] = useState(30);
  const [open, setOpen] = useState<number | null>(null);
  const { data, isLoading } = useQuery({ queryKey: ["journal", days], queryFn: () => api<J>(`/journal?days=${days}`), refetchInterval: 15_000 });
  if (isLoading || !data) return <div className="py-20 text-center text-muted"><Spinner /></div>;
  const s = data.summary;
  const reason = (r: string | null) => (r ? (t(`reason.${r}` as Key) === `reason.${r}` ? r : t(`reason.${r}` as Key)) : "—");

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div className="flex flex-wrap gap-1">
        {[7, 30, 90, 365].map((d) => (
          <button key={d} onClick={() => setDays(d)} className={cx("rounded-md border px-3 py-1.5 text-sm", days === d ? "border-accent text-text" : "border-line text-muted")}>{t("j.period", { d })}</button>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label={t("j.closed")} value={String(s.closed)} />
        <Stat label={t("j.winloss")} value={`${s.wins} / ${s.losses}`} />
        <Stat label={t("j.pnl")} value={signedUsd(s.pnl, t.lang)} cls={tone(s.pnl)} />
        <Stat label={t("j.fees")} value={usd(s.fees, t.lang)} />
      </div>
      <Card>
        {!data.positions.length ? <Empty title={t("j.empty")} /> : (
          <div className="divide-y divide-line">
            {data.positions.map((r) => (
              <div key={r.id}>
                <button onClick={() => setOpen(open === r.id ? null : r.id)} className="grid w-full grid-cols-2 gap-2 px-4 py-3 text-left text-sm hover:bg-panel-2 sm:grid-cols-[1.2fr_1fr_1.3fr_1fr_1.4fr]">
                  <div>
                    <span className="font-medium">{r.symbol.split("/")[0]}</span>{" "}
                    <Badge tone={r.side === "long" ? "up" : "down"}>{r.side === "long" ? t("tr.long") : t("tr.short")}{r.leverage ? ` ${r.leverage}x` : ""}</Badge>
                    <div className="text-xs text-muted">{time(r.opened_at ?? r.created_at, t.lang)}</div>
                  </div>
                  <div className="text-muted">{r.source_label}<div className="text-xs">{r.account_label}</div></div>
                  <div className="num">{num(r.entry_price ? Number(r.entry_price) : null, t.lang)} → {num(r.exit_price ? Number(r.exit_price) : null, t.lang)}</div>
                  <div className={cx("num", tone(r.pnl ? Number(r.pnl) : null))}>
                    {r.status === "closed" ? <>{signedUsd(r.pnl ? Number(r.pnl) : null, t.lang)}<div className="text-xs">{pct(r.pnl_pct ? Number(r.pnl_pct) : null)}</div></>
                      : <span className="text-muted">{r.status === "pending" ? t("j.pending") : t("j.open")}</span>}
                  </div>
                  <div className="text-muted">{r.status === "closed" ? reason(r.close_reason) : ""}</div>
                </button>
                {open === r.id && <Events id={r.id} />}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

const Stat = ({ label, value, cls }: { label: string; value: string; cls?: string }) => (
  <Card className="p-4"><div className="text-xs text-muted">{label}</div><div className={cx("num mt-1 text-xl font-semibold", cls)}>{value}</div></Card>
);

function Events({ id }: { id: number }) {
  const t = useT();
  const { data } = useQuery({ queryKey: ["events", id], queryFn: () => api<{ events: Array<{ kind: string; detail: any; at: string }> }>(`/managed/${id}/events`) });
  if (!data) return <div className="px-4 pb-3 text-muted"><Spinner /></div>;
  const line = (e: { kind: string; detail: any }) => {
    const d = e.detail ?? {};
    const k = `j.ev.${e.kind}` as Key;
    const label = t(k) === k ? e.kind : t(k);
    if (e.kind === "stop_set") return `${label}: ${num(d.price, t.lang)}${d.kind ? ` (${d.kind})` : ""}${d.where === "vektor" ? " · Vektor" : ""}`;
    if (e.kind === "opened") return `${label}: ${num(d.entry, t.lang)} × ${num(d.qty, t.lang)}`;
    if (e.kind === "partial") return `${label}: −${num(d.closed, t.lang)}, ${num(d.left, t.lang)}${d.take ? ` · TP${d.take}` : ""}`;
    if (e.kind === "closed") return `${label}: ${t(`reason.${d.reason}` as Key) === `reason.${d.reason}` ? d.reason : t(`reason.${d.reason}` as Key)}`;
    if (d.error?.message) return `${label}: ${d.error.message}`;
    return label;
  };
  return (
    <div className="space-y-1 bg-bg/50 px-4 py-3 text-xs">
      <div className="mb-1 font-medium text-muted">{t("j.events")}</div>
      {data.events.map((e, i) => (
        <div key={i} className="flex gap-3"><span className="num w-28 shrink-0 text-muted">{time(e.at, t.lang)}</span><span>{line(e)}</span></div>
      ))}
    </div>
  );
}
