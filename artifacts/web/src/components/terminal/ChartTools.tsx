import { useEffect, useRef, useState } from "react";
import { useT, type Key } from "@/lib/i18n";
import { cx } from "@/components/ui";
import type { Drawing, Tool } from "./Chart";
import { INDICATORS, type IndicatorConf, type IndicatorId } from "./indicators";

const ICONS: Record<Tool, string> = {
  cursor: "M5 3l14 8-6 2-2 6z",
  hline: "M3 12h18",
  vline: "M12 3v18",
  trend: "M4 19L20 5",
  ray: "M4 19L20 5M17 5h3v3",
  rect: "M5 6h14v12H5z",
  fib: "M4 5h16M4 9h16M4 13h16M4 19h16",
  text: "M6 5h12M12 5v14",
  measure: "M4 20L20 4M7 17l2 2M10 14l2 2M13 11l2 2M16 8l2 2",
};

const Svg = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>
);

export function DrawToolbar(p: {
  tool: Tool; setTool: (t: Tool) => void; magnet: boolean; setMagnet: (v: boolean) => void;
  locked: boolean; setLocked: (v: boolean) => void; hidden: boolean; setHidden: (v: boolean) => void;
  canUndo: boolean; onUndo: () => void; onClear: () => void; hotkeys: boolean; setHotkeys: (v: boolean) => void;
}) {
  const t = useT();
  const Btn = ({ on, title, onClick, d, danger }: { on?: boolean; title: string; onClick: () => void; d: string; danger?: boolean }) => (
    <button title={title} aria-label={title} onClick={onClick}
      className={cx("flex h-8 w-8 items-center justify-center rounded-md", on ? "bg-accent/20 text-accent" : danger ? "text-muted hover:text-down" : "text-muted hover:bg-panel-2 hover:text-text")}>
      <Svg d={d} />
    </button>
  );
  return (
    <div className="flex flex-row gap-0.5 overflow-x-auto border-b border-line p-1 lg:flex-col lg:border-b-0 lg:border-r" title={t("draw.hint")}>
      {(Object.keys(ICONS) as Tool[]).map((k) => <Btn key={k} on={p.tool === k} title={t(`draw.${k}` as Key)} onClick={() => p.setTool(k)} d={ICONS[k]} />)}
      <div className="mx-1 my-1 border-l border-line lg:mx-0 lg:border-l-0 lg:border-t" />
      <Btn on={p.magnet} title={t("draw.magnet")} onClick={() => p.setMagnet(!p.magnet)} d="M6 4v8a6 6 0 0012 0V4M6 8h4M14 8h4" />
      <Btn on={p.locked} title={t("draw.lock")} onClick={() => p.setLocked(!p.locked)} d="M6 11h12v9H6zM8 11V8a4 4 0 018 0v3" />
      <Btn on={p.hidden} title={t("draw.hide")} onClick={() => p.setHidden(!p.hidden)} d="M3 3l18 18M10.6 10.6a2 2 0 002.8 2.8M9.9 5.1A9.8 9.8 0 0121 12a17 17 0 01-2.2 3.1M6.6 6.6A17 17 0 003 12c2 4 5.5 7 9 7a9.6 9.6 0 004.4-1.1" />
      <Btn title={t("draw.undo")} onClick={() => p.canUndo && p.onUndo()} d="M9 14L4 9l5-5M4 9h11a5 5 0 010 10h-3" />
      <Btn title={t("draw.clear")} onClick={p.onClear} danger d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
      <div className="mx-1 my-1 border-l border-line lg:mx-0 lg:border-l-0 lg:border-t" />
      <Btn on={p.hotkeys} title={`${t("hk.title")}: ${t("hk.help")}. ${t("hk.warn")}`} onClick={() => p.setHotkeys(!p.hotkeys)} d="M3 7h18v10H3zM7 11h.01M11 11h.01M15 11h.01M7 14h10" />
    </div>
  );
}

const COLORS = ["#f5b84a", "#5b8cff", "#c77dff", "#2ec4b6", "#ff7aa2", "#a3e635"];

export function IndicatorMenu({ value, onChange }: { value: IndicatorConf[]; onChange: (v: IndicatorConf[]) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);
  const add = (id: IndicatorId) => onChange([...value, { id, key: Math.random().toString(36).slice(2, 8), params: [...INDICATORS[id].defaults], color: COLORS[value.length % COLORS.length] }]);
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((o) => !o)} className="flex h-9 items-center gap-1.5 rounded-lg border border-line bg-bg px-3 text-sm">
        <span className="font-serif italic">ƒx</span> {t("ind.title")}{value.length ? ` (${value.length})` : ""}
      </button>
      {open && (
        <div className="absolute left-0 top-11 z-30 w-80 rounded-xl border border-line bg-panel p-3 shadow-2xl">
          {value.length > 0 && (
            <div className="mb-3 space-y-2 border-b border-line pb-3">
              {value.map((c, i) => (
                <div key={c.key} className="flex items-center gap-2 text-sm">
                  <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: c.color }} />
                  <span className="w-20 shrink-0">{INDICATORS[c.id].name.split(" ")[0]}</span>
                  {c.params.map((v, j) => (
                    <input key={j} defaultValue={v} title={INDICATORS[c.id].paramNames[j]} inputMode="decimal"
                      onBlur={(e) => { const n = Number(e.target.value); if (n > 0) onChange(value.map((x, k) => (k === i ? { ...x, params: x.params.map((y, m) => (m === j ? n : y)) } : x))); }}
                      className="h-7 w-12 rounded-md border border-line bg-bg px-1.5 text-center text-xs" />
                  ))}
                  <button className="ml-auto text-xs text-muted hover:text-down" onClick={() => onChange(value.filter((_, k) => k !== i))}>{t("ind.remove")}</button>
                </div>
              ))}
            </div>
          )}
          <div className="grid grid-cols-2 gap-1">
            {(Object.keys(INDICATORS) as IndicatorId[]).map((id) => (
              <button key={id} onClick={() => add(id)} className="rounded-md px-2 py-1.5 text-left text-sm text-muted hover:bg-panel-2 hover:text-text">+ {INDICATORS[id].name}</button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Drawings per coin, kept in the browser, with undo. */
export function useDrawings(key: string) {
  const load = (): Drawing[] => { try { return JSON.parse(localStorage.getItem(key) ?? "[]"); } catch { return []; } };
  const [drawings, setDrawingsRaw] = useState<Drawing[]>(load);
  const [history, setHistory] = useState<Drawing[][]>([]);
  useEffect(() => { setDrawingsRaw(load()); setHistory([]); }, [key]);
  const setDrawings = (d: Drawing[]) => {
    setHistory((h) => [...h.slice(-49), drawings]);
    setDrawingsRaw(d);
    try { localStorage.setItem(key, JSON.stringify(d)); } catch { /* full */ }
  };
  const undo = () => {
    const prev = history[history.length - 1];
    if (!prev) return;
    setHistory((h) => h.slice(0, -1));
    setDrawingsRaw(prev);
    try { localStorage.setItem(key, JSON.stringify(prev)); } catch { /* full */ }
  };
  return { drawings, setDrawings, undo, canUndo: history.length > 0 };
}
