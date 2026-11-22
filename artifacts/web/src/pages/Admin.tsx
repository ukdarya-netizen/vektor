import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { time } from "@/lib/format";
import { Button, Card, Input, Spinner } from "@/components/ui";

type U = { id: number; email: string; plan: string; plan_until: string | null; created_at: string; last_login_at: string | null; real_accounts: number; open_positions: number };

/** Platform owner: find a user, give or extend a plan (the user is notified). */
export function AdminPage() {
  const t = useT();
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const { data, isLoading } = useQuery({ queryKey: ["admin-users", q], queryFn: () => api<{ users: U[] }>(`/admin/users?q=${encodeURIComponent(q)}`) });
  const [sel, setSel] = useState<Record<number, { plan: string; days: string }>>({});
  const give = async (u: U) => {
    const s = sel[u.id] ?? { plan: "pro", days: "30" };
    await api(`/admin/users/${u.id}/plan`, { body: { plan: s.plan, days: Number(s.days) || 30 } });
    void qc.invalidateQueries({ queryKey: ["admin-users"] });
  };
  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <h2 className="text-lg font-semibold">{t("adm.title")}</h2>
      <Input placeholder={t("adm.search")} value={q} onChange={(e) => setQ(e.target.value)} />
      <Card>
        {isLoading ? <div className="p-6 text-center"><Spinner /></div> : (
          <div className="divide-y divide-line">
            {data?.users.map((u) => {
              const s = sel[u.id] ?? { plan: "pro", days: "30" };
              return (
                <div key={u.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
                  <div className="min-w-0">
                    <div className="font-medium">{u.email}</div>
                    <div className="text-xs text-muted">{u.plan}{u.plan_until ? ` → ${time(u.plan_until, t.lang)}` : ""} · {u.real_accounts} exch · {u.open_positions} pos · {time(u.last_login_at, t.lang)}</div>
                  </div>
                  <div className="flex items-center gap-1">
                    <select className="h-8 rounded-md border border-line bg-bg px-2 text-xs" value={s.plan} onChange={(e) => setSel((x) => ({ ...x, [u.id]: { ...s, plan: e.target.value } }))}>
                      {["free", "trial", "pro", "team"].map((p) => <option key={p} value={p}>{p}</option>)}
                    </select>
                    <input className="h-8 w-16 rounded-md border border-line bg-bg px-2 text-xs" value={s.days} onChange={(e) => setSel((x) => ({ ...x, [u.id]: { ...s, days: e.target.value.replace(/\D/g, "") } }))} />
                    <span className="text-xs text-muted">{t("adm.days")}</span>
                    <Button size="sm" onClick={() => give(u)}>{t("adm.give")}</Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>
      <Payments />
    </div>
  );
}

type Inc = { tx_hash: string; from_address: string; amount: number; at: string; invoice_id: number | null; status: string };
type Inv = { id: number; email: string; amount: number; status: string; created_at: string; tx_hash: string | null; user_txid: string | null; items: Array<{ product: string; months: number }> };

/** Incoming USDT: unmatched transfers are assigned to an invoice by hand (the user is credited and notified). */
function Payments() {
  const t = useT();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["admin-pay"], queryFn: () => api<{ invoices: Inv[]; incoming: Inc[] }>("/admin/payments"), refetchInterval: 30_000 });
  const [pick, setPick] = useState<Record<string, string>>({});
  if (!data) return null;
  const open = data.invoices.filter((i) => i.status !== "paid");
  const act = async (tx: string, what: "assign" | "ignore") => {
    await api(`/admin/incoming/${tx}/${what}`, { body: { invoiceId: Number(pick[tx]) } });
    void qc.invalidateQueries({ queryKey: ["admin-pay"] });
  };
  return (
    <>
      <h2 className="pt-4 text-lg font-semibold">{t("adm.payments")}</h2>
      <Card>
        <div className="divide-y divide-line">
          {data.incoming.length === 0 && <div className="p-4 text-sm text-muted">{t("adm.noIncoming")}</div>}
          {data.incoming.map((x) => (
            <div key={x.tx_hash} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
              <div className="min-w-0">
                <div><span className="num font-medium">{x.amount} USDT</span> <span className="text-xs text-muted">· {time(x.at, t.lang)} · {x.from_address.slice(0, 8)}…</span></div>
                <a className="font-mono text-xs text-accent hover:underline" href={`https://tronscan.org/#/transaction/${x.tx_hash}`} target="_blank" rel="noreferrer">{x.tx_hash.slice(0, 16)}…</a>
                <span className="ml-2 text-xs text-muted">{t(`adm.st.${x.status}` as any)}{x.invoice_id ? ` #${x.invoice_id}` : ""}</span>
              </div>
              {x.status === "unmatched" && (
                <div className="flex items-center gap-1">
                  <select className="h-8 max-w-[16rem] rounded-md border border-line bg-bg px-2 text-xs" value={pick[x.tx_hash] ?? ""} onChange={(e) => setPick((p) => ({ ...p, [x.tx_hash]: e.target.value }))}>
                    <option value="">{t("adm.chooseInvoice")}</option>
                    {open.map((i) => <option key={i.id} value={i.id}>#{i.id} · {i.email} · {i.amount}{i.user_txid === x.tx_hash ? " · TxID ✓" : ""}</option>)}
                  </select>
                  <Button size="sm" disabled={!pick[x.tx_hash]} onClick={() => act(x.tx_hash, "assign")}>{t("adm.assign")}</Button>
                  <Button size="sm" variant="ghost" onClick={() => act(x.tx_hash, "ignore")}>{t("adm.ignore")}</Button>
                </div>
              )}
            </div>
          ))}
        </div>
      </Card>
    </>
  );
}
