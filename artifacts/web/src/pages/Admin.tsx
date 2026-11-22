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
    </div>
  );
}
