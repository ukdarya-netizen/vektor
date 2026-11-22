import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type Account } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { Button, Card, cx } from "@/components/ui";
import { ConnectExchange } from "@/components/ConnectExchange";
import { TelegramConnect } from "@/components/TelegramConnect";

/** First visit: email (done) → exchange → Telegram. Any step can be skipped. */
export function Onboarding({ onFinish }: { onFinish: () => void }) {
  const t = useT();
  const [step, setStep] = useState<2 | 3>(2);
  const [open, setOpen] = useState(false);
  const accs = useQuery({ queryKey: ["accounts"], queryFn: () => api<{ accounts: Account[] }>("/accounts") });
  const hasExchange = (accs.data?.accounts.length ?? 0) > 0;

  const finish = async () => { await api("/auth/me", { method: "PATCH", body: { onboarded: true } }); onFinish(); };

  return (
    <div className="flex min-h-full items-center justify-center px-4 py-10">
      <div className="w-full max-w-lg">
        <h1 className="text-2xl font-semibold">{t("onb.title")}</h1>
        <ol className="mt-6 grid grid-cols-3 gap-2 text-sm">
          {[t("onb.step1"), t("onb.step2"), t("onb.step3")].map((s, i) => {
            const n = i + 1;
            const done = n === 1 || (n === 2 && hasExchange && step === 3);
            const active = n === step;
            return (
              <li key={s} className={cx("rounded-lg border px-3 py-2", active ? "border-accent text-text" : done ? "border-up/40 text-up" : "border-line text-muted")}>
                <span className="mr-1">{done ? "✓" : `${n}.`}</span>{s}
              </li>
            );
          })}
        </ol>

        <Card className="mt-5 space-y-4 p-5">
          {step === 2 ? (
            <>
              <p className="text-sm text-muted">{t("onb.exchangeText")}</p>
              {hasExchange
                ? <div className="text-sm text-up">✓ {accs.data!.accounts.map((a) => a.label).join(", ")}</div>
                : <Button onClick={() => setOpen(true)}>{t("ex.add")}</Button>}
              <div className="flex justify-between pt-2">
                <Button variant="ghost" onClick={() => setStep(3)}>{hasExchange ? "" : t("common.skip")}</Button>
                <Button variant={hasExchange ? "primary" : "outline"} onClick={() => setStep(3)}>{t("common.next")} →</Button>
              </div>
            </>
          ) : (
            <>
              <p className="text-sm text-muted">{t("onb.telegramText")}</p>
              <TelegramConnect compact />
              <div className="flex justify-between pt-2">
                <Button variant="ghost" onClick={() => setStep(2)}>← {t("common.back")}</Button>
                <Button onClick={finish}>{t("onb.finish")}</Button>
              </div>
            </>
          )}
        </Card>
      </div>
      <ConnectExchange open={open} onClose={() => setOpen(false)} />
    </div>
  );
}
