import { useT, type Key } from "@/lib/i18n";
import { Switch, cx } from "@/components/ui";

export type Level = { mode: "pct" | "price"; value: number };
export type Plan = {
  stop: Level | null;
  takes: Array<Level & { closePct: number }>;
  breakeven: { after: "off" | "tp1" | "pct"; pct?: number };
  trailing: { activationPct: number; callbackPct: number } | null;
};

export const DEFAULT_PLAN: Plan = {
  stop: { mode: "pct", value: 2 },
  takes: [{ mode: "pct", value: 3, closePct: 100 }],
  breakeven: { after: "off" },
  trailing: null,
};

const dir = (side: "long" | "short") => (side === "long" ? 1 : -1);
const levelPrice = (l: Level, side: "long" | "short", entry: number, loss: boolean) =>
  l.mode === "price" ? l.value : entry * (1 + (dir(side) * (loss ? -l.value : l.value)) / 100);

/** Same rules as the server (engine/plan.ts planErrors) so problems show before sending. */
export function planProblems(plan: Plan, side: "long" | "short", entry: number | null): Key[] {
  const out: Key[] = [];
  if (plan.takes.reduce((s, t) => s + t.closePct, 0) > 100) out.push("plan.takes_over_100");
  if (!entry) return out;
  if (plan.stop && dir(side) * (levelPrice(plan.stop, side, entry, true) - entry) >= 0) out.push("plan.stop_wrong_side");
  if (plan.takes.some((t) => dir(side) * (levelPrice(t, side, entry, false) - entry) <= 0)) out.push("plan.take_wrong_side");
  return out;
}

/** Stop, takes, break-even, trailing — in % from the entry (or exact prices). */
export function PlanEditor({ plan, onChange, side, entry, prec }: { plan: Plan; onChange: (p: Plan) => void; side: "long" | "short"; entry: number | null; prec: number }) {
  const t = useT();
  const set = (patch: Partial<Plan>) => onChange({ ...plan, ...patch });
  const sum = plan.takes.reduce((s, x) => s + x.closePct, 0);
  const fmt = (v: number) => v.toFixed(prec);
  const problems = planProblems(plan, side, entry);

  return (
    <div className="space-y-3 text-sm">
      {/* Stop */}
      <div>
        <div className="mb-1 flex items-center justify-between"><span>{t("plan.stop")}</span>
          <Switch checked={plan.stop !== null} onChange={(v) => set({ stop: v ? { mode: "pct", value: 2 } : null })} /></div>
        {plan.stop ? (
          <LevelInput level={plan.stop} onChange={(l) => set({ stop: l })} hint={entry ? fmt(levelPrice(plan.stop, side, entry, true)) : null} />
        ) : <div className="text-xs text-warn">{t("plan.noStopWarn")}</div>}
      </div>

      {/* Takes */}
      <div>
        <div className="mb-1">{t("plan.takes")}</div>
        <div className="space-y-1.5">
          {plan.takes.map((x, i) => (
            <div key={i} className="rounded-md bg-bg/60 p-1.5">
              <div className="mb-1 flex items-center justify-between text-xs text-muted">
                <span>TP{i + 1}</span>
                <button className="px-1 hover:text-down" onClick={() => set({ takes: plan.takes.filter((_, j) => j !== i) })} aria-label="remove">✕</button>
              </div>
              <LevelInput level={x} onChange={(l) => set({ takes: plan.takes.map((y, j) => (j === i ? { ...y, ...l } : y)) })} hint={entry ? fmt(levelPrice(x, side, entry, false)) : null} />
              <div className="mt-1 flex items-center gap-1.5 text-xs text-muted">
                <NumBox value={x.closePct} suffix="%" w="w-20" onChange={(v) => set({ takes: plan.takes.map((y, j) => (j === i ? { ...y, closePct: v } : y)) })} />
                {t("plan.closePart")}
              </div>
            </div>
          ))}
        </div>
        <div className="mt-1.5 flex items-center justify-between text-xs">
          {plan.takes.length < 5 ? (
            <button className="text-accent" onClick={() => {
              const last = plan.takes.at(-1);
              const rest = Math.max(0, 100 - sum);
              set({ takes: [...plan.takes, { mode: "pct", value: last ? last.value + 2 : 3, closePct: rest || 25 }] });
            }}>{t("plan.addTake")}</button>
          ) : <span />}
          {plan.takes.length > 0 && <span className={sum > 100 ? "text-down" : "text-muted"}>{sum > 100 ? t("plan.sumOver") : t("plan.sum", { v: sum })}</span>}
        </div>
      </div>

      {/* Break-even */}
      <div>
        <div className="mb-1">{t("plan.be")}</div>
        <div className="flex flex-wrap items-center gap-1">
          {(["off", "tp1", "pct"] as const).map((m) => (
            <button key={m} onClick={() => set({ breakeven: { after: m, pct: m === "pct" ? plan.breakeven.pct ?? 1.5 : undefined } })}
              className={cx("rounded-md border px-2 py-1 text-xs", plan.breakeven.after === m ? "border-accent text-text" : "border-line text-muted")}>{t(`plan.be.${m}` as Key)}</button>
          ))}
          {plan.breakeven.after === "pct" && <NumBox value={plan.breakeven.pct ?? 1.5} suffix="%" w="w-20" onChange={(v) => set({ breakeven: { after: "pct", pct: v } })} />}
        </div>
        {plan.breakeven.after !== "off" && <div className="mt-1 text-xs text-muted">{t("plan.beHint")}</div>}
      </div>

      {/* Trailing */}
      <div>
        <div className="mb-1 flex items-center justify-between"><span>{t("plan.trailing")}</span>
          <Switch checked={plan.trailing !== null} onChange={(v) => set({ trailing: v ? { activationPct: 2, callbackPct: 1 } : null })} /></div>
        {plan.trailing && (
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs text-muted">{t("plan.activation")}<NumBox value={plan.trailing.activationPct} suffix="%" onChange={(v) => set({ trailing: { ...plan.trailing!, activationPct: v } })} /></label>
            <label className="text-xs text-muted">{t("plan.callback")}<NumBox value={plan.trailing.callbackPct} suffix="%" onChange={(v) => set({ trailing: { ...plan.trailing!, callbackPct: v } })} /></label>
          </div>
        )}
      </div>
      {problems.map((k) => <div key={k} className="text-xs text-down">{t(k)}</div>)}
    </div>
  );
}

function LevelInput({ level, onChange, hint }: { level: Level; onChange: (l: Level) => void; hint: string | null }) {
  const t = useT();
  return (
    <div className="flex items-center gap-1.5">
      <NumBox value={level.value} suffix={level.mode === "pct" ? "%" : ""} onChange={(v) => onChange({ ...level, value: v })} />
      <button className="shrink-0 rounded-md border border-line px-1.5 py-1 text-[11px] text-muted hover:text-text"
        onClick={() => onChange({ mode: level.mode === "pct" ? "price" : "pct", value: level.mode === "pct" && hint ? Number(hint) : 2 })}>
        {level.mode === "pct" ? t("plan.fromEntry") : t("plan.price")}
      </button>
      {level.mode === "pct" && hint && <span className="num shrink-0 text-[11px] text-muted">≈ {hint}</span>}
    </div>
  );
}

function NumBox({ value, onChange, suffix, w }: { value: number; onChange: (v: number) => void; suffix?: string; w?: string }) {
  return (
    <span className={cx("flex h-8 items-center gap-1 rounded-md border border-line bg-bg px-2 focus-within:border-accent", w ?? "w-full")}>
      <input inputMode="decimal" defaultValue={value} key={value}
        onBlur={(e) => { const v = Number(e.target.value.replace(",", ".")); if (v > 0) onChange(v); else e.target.value = String(value); }}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        className="num w-full min-w-0 bg-transparent text-sm outline-none" />
      {suffix && <span className="text-xs text-muted">{suffix}</span>}
    </span>
  );
}
