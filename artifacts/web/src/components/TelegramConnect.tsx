import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { Alert, Badge, Button } from "./ui";

export type NotifState = {
  telegram: { configured: boolean; bot: string | null; linked: boolean; username: string | null; linkedAt: string | null };
  groups: Record<string, boolean>;
  quietFrom: number | null;
  quietTo: number | null;
  delivery: { pending: number; failed: number; lastSentAt: string | null; lastFailure: { error: string; at: string; text: string } | null };
  email: { configured: boolean; mode: "off" | "critical" | "all"; address: string };
  push: { publicKey: string | null; mode: "off" | "critical" | "all"; devices: number };
};

export const useNotif = (poll = false) =>
  useQuery({ queryKey: ["notifications"], queryFn: () => api<NotifState>("/notifications"), refetchInterval: poll ? 3_000 : false });

/** Button → one-time t.me link → user presses Start → this card turns green by itself. */
export function TelegramConnect({ compact }: { compact?: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const [waiting, setWaiting] = useState(false);
  const [sent, setSent] = useState(false);
  const { data } = useNotif(waiting);
  const tg = data?.telegram;

  useEffect(() => { if (tg?.linked) setWaiting(false); }, [tg?.linked]);

  if (!tg) return null;
  if (!tg.configured) return <Alert tone="warn">{t("ntf.notConfigured")}</Alert>;

  const connect = async () => {
    const r = await api<{ url: string }>("/notifications/telegram/link", { method: "POST" });
    setWaiting(true);
    window.open(r.url, "_blank", "noopener");
  };
  const disconnect = async () => {
    await api("/notifications/telegram", { method: "DELETE" });
    await qc.invalidateQueries({ queryKey: ["notifications"] });
  };
  const test = async () => {
    await api("/notifications/telegram/test", { method: "POST" });
    setSent(true);
    setTimeout(() => setSent(false), 4_000);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        {tg.linked
          ? <Badge tone="up">{t("ntf.connected", { user: tg.username ? ` · @${tg.username}` : "" })}</Badge>
          : <Badge>{t("ntf.notConnected")}</Badge>}
        {tg.linked ? (
          <>
            <Button size="sm" variant="outline" onClick={test}>{sent ? t("ntf.testSent") : t("ntf.test")}</Button>
            {!compact && <Button size="sm" variant="danger" onClick={disconnect}>{t("ntf.disconnect")}</Button>}
          </>
        ) : (
          <Button size="sm" onClick={connect}>{t("ntf.connect")}</Button>
        )}
      </div>
      {!tg.linked && <div className="text-sm text-muted">{waiting ? t("ntf.waiting") : t("ntf.connectHint")}</div>}
    </div>
  );
}
