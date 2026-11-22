import { useQuery } from "@tanstack/react-query";
import { api, type Account, type Position } from "@/lib/api";
import { useT, type Key } from "@/lib/i18n";
import { num, pct, signedUsd, tone } from "@/lib/format";
import { Alert, Badge, Card, Empty, Spinner } from "@/components/ui";

export function PositionsPage() {
  const t = useT();
  const accs = useQuery({ queryKey: ["accounts"], queryFn: () => api<{ accounts: Account[] }>("/accounts") });
  const { data, isLoading } = useQuery({
    queryKey: ["positions"], queryFn: () => api<{ positions: Position[]; errors: Array<{ accountId: number; code: string; message: string }> }>("/positions"),
    refetchInterval: 5_000,
  });
  const label = (id: number) => accs.data?.accounts.find((a) => a.id === id)?.label ?? `#${id}`;
  const hasFutures = accs.data?.accounts.some((a) => a.market === "swap");

  if (isLoading || accs.isLoading) return <div className="py-20 text-center text-muted"><Spinner /></div>;
  if (!hasFutures) return <Card><Empty title={t("positions.empty")} text={t("positions.noFutures")} /></Card>;

  return (
    <div className="space-y-4">
      {data?.errors.map((e) => (
        <Alert key={e.accountId}>{label(e.accountId)}: {t(`ex.err.code.${e.code}` as Key).startsWith("ex.err") ? e.message : t(`ex.err.code.${e.code}` as Key)}</Alert>
      ))}
      <Card>
        {!data?.positions.length ? <Empty title={t("positions.empty")} text={t("positions.external")} /> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="text-left text-xs text-muted">
                <tr>
                  {(["positions.coin", "positions.side", "positions.size", "positions.entry", "positions.mark", "positions.pnl", "positions.liq", "positions.lev", "positions.account"] as Key[]).map((k, i) => (
                    <th key={k} className={`px-4 py-2.5 font-normal ${i >= 2 && i <= 7 ? "text-right" : ""}`}>{t(k)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.positions.map((p) => (
                  <tr key={`${p.accountId}-${p.symbol}-${p.side}`} className="border-t border-line/60">
                    <td className="px-4 py-3 font-medium">{p.coin}</td>
                    <td className="px-4 py-3"><Badge tone={p.side === "long" ? "up" : "down"}>{p.side === "long" ? t("positions.long") : t("positions.short")}</Badge></td>
                    <td className="num px-4 py-3 text-right">{num(p.size, t.lang)}</td>
                    <td className="num px-4 py-3 text-right">{num(p.entryPrice, t.lang)}</td>
                    <td className="num px-4 py-3 text-right">{num(p.markPrice, t.lang)}</td>
                    <td className={`num px-4 py-3 text-right ${tone(p.unrealizedPnl)}`}>
                      {signedUsd(p.unrealizedPnl, t.lang)}<div className="text-xs">{pct(p.pnlPct)}</div>
                    </td>
                    <td className="num px-4 py-3 text-right text-warn">{num(p.liquidationPrice, t.lang)}</td>
                    <td className="num px-4 py-3 text-right">{p.leverage ? `${p.leverage}x` : "—"}{p.marginMode && <div className="text-xs text-muted">{p.marginMode}</div>}</td>
                    <td className="px-4 py-3 text-muted">{label(p.accountId)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
