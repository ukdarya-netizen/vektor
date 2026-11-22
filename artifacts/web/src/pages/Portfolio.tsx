import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type Snapshot } from "@/lib/api";
import { useT, type Key } from "@/lib/i18n";
import { num, signedUsd, time, tone, usd } from "@/lib/format";
import { Alert, Badge, Button, Card, Empty, Spinner } from "@/components/ui";
import { ConnectExchange } from "@/components/ConnectExchange";

type Portfolio = { at: string; totalUsd: number; unrealizedPnl: number; accounts: Snapshot[] };

export function PortfolioPage() {
  const t = useT();
  const [connect, setConnect] = useState(false);
  const { data, isLoading } = useQuery({ queryKey: ["portfolio"], queryFn: () => api<Portfolio>("/portfolio"), refetchInterval: 15_000 });

  if (isLoading) return <div className="py-20 text-center text-muted"><Spinner /></div>;
  if (!data?.accounts.length) {
    return (
      <Card>
        <Empty title={t("portfolio.empty")} action={<Button onClick={() => setConnect(true)}>{t("portfolio.connect")}</Button>} />
        <ConnectExchange open={connect} onClose={() => setConnect(false)} />
      </Card>
    );
  }
  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <Card className="p-5">
          <div className="text-sm text-muted">{t("portfolio.total")}</div>
          <div className="num mt-1 text-3xl font-semibold">{usd(data.totalUsd, t.lang)}</div>
          <div className="mt-1 text-xs text-muted">{t("common.updated")}: {time(data.at, t.lang)}</div>
        </Card>
        <Card className="p-5">
          <div className="text-sm text-muted">{t("portfolio.upnl")}</div>
          <div className={`num mt-1 text-3xl font-semibold ${tone(data.unrealizedPnl)}`}>{signedUsd(data.unrealizedPnl, t.lang)}</div>
        </Card>
      </div>

      <h2 className="pt-2 text-sm font-semibold uppercase tracking-wide text-muted">{t("portfolio.byAccount")}</h2>
      {data.accounts.map((s) => (
        <Card key={s.accountId}>
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
            <div className="flex items-center gap-2">
              <span className="font-medium">{s.account.label}</span>
              {s.account.env === "testnet" && <Badge tone="warn">{t("mode.testnet")}</Badge>}
            </div>
            <span className="num font-semibold">{usd(s.totalUsd, t.lang)}</span>
          </div>
          {s.error ? (
            <div className="p-4"><Alert>{t(`ex.err.code.${s.error.code}` as Key).startsWith("ex.err") ? s.error.message : t(`ex.err.code.${s.error.code}` as Key)}</Alert></div>
          ) : !s.balances.length ? (
            <div className="px-4 py-6 text-sm text-muted">{t("portfolio.noBalances")}</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted">
                  <tr>
                    <th className="px-4 py-2 font-normal">{t("portfolio.asset")}</th>
                    <th className="px-4 py-2 text-right font-normal">{t("portfolio.amount")}</th>
                    <th className="hidden px-4 py-2 text-right font-normal sm:table-cell">{t("portfolio.free")}</th>
                    <th className="hidden px-4 py-2 text-right font-normal sm:table-cell">{t("portfolio.inOrders")}</th>
                    <th className="px-4 py-2 text-right font-normal">{t("portfolio.value")}</th>
                  </tr>
                </thead>
                <tbody>
                  {s.balances.map((b) => (
                    <tr key={b.asset} className="border-t border-line/60">
                      <td className="px-4 py-2 font-medium">{b.asset}</td>
                      <td className="num px-4 py-2 text-right">{num(b.total, t.lang)}</td>
                      <td className="num hidden px-4 py-2 text-right text-muted sm:table-cell">{num(b.free, t.lang)}</td>
                      <td className="num hidden px-4 py-2 text-right text-muted sm:table-cell">{num(b.used, t.lang)}</td>
                      <td className="num px-4 py-2 text-right">{usd(b.usd, t.lang)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {s.unpriced.length > 0 && <div className="px-4 pb-3 pt-1 text-xs text-muted">{t("portfolio.unpriced", { list: s.unpriced.join(", ") })}</div>}
            </div>
          )}
        </Card>
      ))}
    </div>
  );
}
