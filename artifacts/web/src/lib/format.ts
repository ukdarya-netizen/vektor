/** Money and prices use one format everywhere (1,234.56) — the same as on the chart axis. */
export const usd = (v: number | null | undefined, _lang?: string) =>
  v === null || v === undefined || !Number.isFinite(v)
    ? "—"
    : `$${new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v)}`;

export const signedUsd = (v: number | null | undefined, lang: string) =>
  v === null || v === undefined || !Number.isFinite(v) ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${usd(Math.abs(v), lang)}`;

export const num = (v: number | null | undefined, _lang?: string, max = 8) =>
  v === null || v === undefined || !Number.isFinite(v)
    ? "—"
    : new Intl.NumberFormat("en-US", { maximumSignificantDigits: Math.min(max, 10) }).format(v);

export const pct = (v: number | null | undefined) =>
  v === null || v === undefined || !Number.isFinite(v) ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(2)}%`;

export const time = (iso: string | null | undefined, lang: string, tz?: string) =>
  iso ? new Date(iso).toLocaleString(lang === "ru" ? "ru-RU" : "en-GB", { dateStyle: "short", timeStyle: "short", timeZone: tz }) : "—";

export const tone = (v: number | null | undefined) => (v === null || v === undefined || v === 0 ? "text-muted" : v > 0 ? "text-up" : "text-down");
