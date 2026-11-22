import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { Alert, Button, Modal, Spinner } from "@/components/ui";
import type { Plan } from "./PlanEditor";
import type { Managed } from "@/pages/Terminal";

type Draft = { tool: string; input: any };
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

/** Text or voice → one draft action → shown in words → executed only on «Подтвердить». */
export function Copilot({ accountId, symbol, managed, positions }: { accountId: number | null; symbol: string | null; managed: Managed[]; positions: Array<{ accountId: number; symbol: string; side: "long" | "short" }> }) {
  const t = useT();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [msg, setMsg] = useState<{ tone: "up" | "down" | "accent"; text: string } | null>(null);
  const [listening, setListening] = useState(false);
  const rec = useRef<any>(null);

  const parse = async (value = text) => {
    if (!value.trim()) return;
    setBusy(true); setDraft(null); setMsg(null);
    try {
      const r = await api<{ draft: Draft }>("/copilot", { body: { text: value, accountId, symbol } });
      if (r.draft.tool === "answer") setMsg({ tone: "accent", text: r.draft.input.text });
      else setDraft(r.draft);
    } catch (e) {
      setMsg({ tone: "down", text: e instanceof ApiError && e.code === "copilot_not_configured" ? t("ai.notConfigured") : (e as any)?.body?.message ?? t("err.generic") });
    } finally { setBusy(false); }
  };

  const voice = () => {
    const SR = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
    if (!SR) { setMsg({ tone: "down", text: t("ai.noVoice") }); return; }
    if (listening) { rec.current?.stop(); return; }
    const r = new SR();
    r.lang = t.lang === "en" ? "en-US" : "ru-RU";
    r.interimResults = true;
    r.onresult = (e: any) => {
      const s = Array.from(e.results).map((x: any) => x[0].transcript).join(" ");
      setText(s);
      if (e.results[e.results.length - 1].isFinal) void parse(s);
    };
    r.onend = () => setListening(false);
    r.onerror = () => setListening(false);
    rec.current = r;
    setListening(true);
    r.start();
  };

  const lvl = (l: any) => (l?.price ? String(l.price) : l?.pct ? `${l.pct}%` : "");
  const describe = (d: Draft): string[] => {
    const i = d.input;
    const side = i.side === "short" ? t("tr.short") : t("tr.long");
    if (d.tool === "open_position") return [
      t("ai.open", { side, coin: String(i.symbol).split("/")[0], acc: i.accountLabel,
        size: i.amountPct ? t("ai.size.pct", { v: i.amountPct }) : t("ai.size.usdt", { v: i.amountUsdt }),
        lev: i.leverage ? `, ${i.leverage}x` : "", type: i.orderType === "limit" && i.limitPrice ? `, limit ${i.limitPrice}` : "" }),
      ...(i.stop ? [t("ai.stop", { v: lvl(i.stop) })] : [t("plan.noStopWarn")]),
      ...(i.takes?.length ? [t("ai.takes", { v: i.takes.map((x: any) => `${lvl(x)}${x.closePct ? ` (${x.closePct}%)` : ""}`).join(", ") })] : []),
    ];
    if (d.tool === "close_position") return [t("ai.close", { pct: i.percent ?? 100, coin: String(i.symbol).split("/")[0], side: i.side ? ` ${side}` : "", acc: i.accountLabel })];
    if (d.tool === "move_stop") return [t("ai.move", { id: i.positionId, v: i.breakeven ? t("ai.moveBe") : i.price })];
    if (d.tool === "set_kill_switch") return [t("ai.kill", { v: i.on ? "ON" : "OFF" })];
    return [JSON.stringify(i)];
  };

  const execute = async () => {
    if (!draft) return;
    const i = draft.input;
    setBusy(true); setMsg(null);
    try {
      if (draft.tool === "open_position") {
        const plan: Plan | null = i.market === "swap" ? {
          stop: i.stop ? (i.stop.price ? { mode: "price", value: i.stop.price } : { mode: "pct", value: i.stop.pct }) : null,
          takes: (i.takes ?? []).map((x: any, k: number, arr: any[]) => ({ ...(x.price ? { mode: "price", value: x.price } : { mode: "pct", value: x.pct }), closePct: x.closePct ?? Math.round(100 / arr.length) })),
          breakeven: { after: i.breakevenAfterTp1 ? "tp1" : "off" }, trailing: i.trailing?.callbackPct ? { activationPct: i.trailing.activationPct ?? 0, callbackPct: i.trailing.callbackPct } : null, dca: null,
        } : null;
        await api("/orders", { body: {
          accountId: i.accountId, symbol: i.symbol, side: i.side, type: i.orderType === "limit" && i.limitPrice ? "limit" : "market", price: i.limitPrice ?? null,
          amountMode: i.amountPct ? "percent" : "usdt", amount: i.amountPct ?? i.amountUsdt, leverage: i.leverage ?? 10, marginMode: "isolated", clientRequestId: uid(), plan,
        } });
      } else if (draft.tool === "close_position") {
        const sides = i.side ? [i.side] : positions.filter((p) => p.accountId === i.accountId && p.symbol === i.symbol).map((p) => p.side);
        for (const side of sides) await api("/positions/close", { body: { accountId: i.accountId, symbol: i.symbol, side, percent: i.percent ?? 100 } });
      } else if (draft.tool === "move_stop") {
        const m = managed.find((x) => x.id === Number(i.positionId));
        if (!m) throw new Error("not found");
        const entry = Number(m.entry_price);
        const price = i.breakeven ? entry * (1 + (m.side === "long" ? 1 : -1) * 0.0012) : Number(i.price);
        await api(`/managed/${m.id}`, { method: "PATCH", body: { plan: { ...m.plan, stop: { mode: "price", value: Number(price.toPrecision(8)) } } } });
      } else if (draft.tool === "set_kill_switch") {
        const r = await api<{ limits: any }>("/risk");
        await api("/risk", { method: "PUT", body: { ...r.limits, killSwitch: Boolean(i.on) } });
      }
      setMsg({ tone: "up", text: t("ai.done") });
      setDraft(null); setText("");
      for (const k of ["positions", "managed", "openOrders", "risk", "balance"]) void qc.invalidateQueries({ queryKey: [k] });
    } catch (e: any) {
      const code = e?.code === "preflight_failed" ? e.body?.preflight?.errors?.[0]?.code : e?.code;
      const k = `pf.${code}` as any;
      setMsg({ tone: "down", text: t(k) !== k ? t(k) : e?.body?.exchangeError?.message ?? code ?? t("err.generic") });
    } finally { setBusy(false); }
  };

  return (
    <>
      <button onClick={() => setOpen(true)} className="flex h-9 items-center gap-1.5 rounded-lg border border-accent/40 bg-accent/10 px-3 text-sm text-text hover:bg-accent/20" title={t("ai.title")}>
        ✦ AI
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title={t("ai.title")}>
        <div className="space-y-3">
          <div className="text-xs text-muted">{t("ai.hint")}</div>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder={t("ai.placeholder")}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void parse(); } }}
            className="w-full rounded-lg border border-line bg-bg p-3 text-sm outline-none focus:border-accent" />
          <div className="flex gap-2">
            <Button onClick={() => void parse()} disabled={busy || !text.trim()}>{busy && !draft ? <Spinner /> : t("ai.send")}</Button>
            <Button variant="outline" onClick={voice}>{listening ? `● ${t("ai.listening")}` : `🎙 ${t("ai.mic")}`}</Button>
          </div>
          {draft && (
            <div className="space-y-2 rounded-lg border border-accent/40 bg-accent/5 p-3 text-sm">
              {describe(draft).map((l, k) => <div key={k}>{l}</div>)}
              <div className="flex gap-2 pt-1">
                <Button size="sm" onClick={execute} disabled={busy}>{busy ? <Spinner /> : t("ai.confirm")}</Button>
                <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>{t("ai.cancel")}</Button>
              </div>
            </div>
          )}
          {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
        </div>
      </Modal>
    </>
  );
}
