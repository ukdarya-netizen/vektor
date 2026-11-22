import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, workspace, type Account, type User, type Workspace } from "@/lib/api";
import { useT, type Key } from "@/lib/i18n";
import { Badge, cx } from "./ui";
import { Logo, Wordmark } from "./Brand";

const NAV: Array<{ href: string; key: Key; icon: string }> = [
  { href: "/terminal", key: "nav.terminal", icon: "M3 17l5-6 4 4 7-9" },
  { href: "/positions", key: "nav.positions", icon: "M4 6h16M4 12h16M4 18h10" },
  { href: "/bots", key: "nav.bots", icon: "M9 3h6M12 3v3M5 8h14v11H5zM9 13h.01M15 13h.01M9 16h6" },
  { href: "/signals", key: "nav.signals", icon: "M13 2L4 14h7l-1 8 9-12h-7l1-8z" },
  { href: "/portfolio", key: "nav.portfolio", icon: "M4 19V9m6 10V5m6 14v-7m4 7H2" },
  { href: "/journal", key: "nav.journal", icon: "M6 3h10l4 4v14H6zM9 12h8M9 16h8M9 8h4" },
];
const GEAR = "M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.6 1.6 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.6 1.6 0 00-2.7 1.1V21a2 2 0 11-4 0v-.1a1.6 1.6 0 00-2.7-1.1l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.6 1.6 0 00-1.1-2.7H3a2 2 0 110-4h.1a1.6 1.6 0 001.1-2.7l-.1-.1a2 2 0 112.8-2.8l.1.1a1.6 1.6 0 002.7-1.1V3a2 2 0 114 0v.1a1.6 1.6 0 002.7 1.1l.1-.1a2 2 0 112.8 2.8l-.1.1a1.6 1.6 0 001.1 2.7H21a2 2 0 110 4h-.1a1.6 1.6 0 00-1.5 1z";
const BELL = "M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 01-3.4 0";

const Icon = ({ d, className }: { d: string; className?: string }) => (
  <svg viewBox="0 0 24 24" className={cx("h-5 w-5 shrink-0", className)} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>
);

/** Which money the user is looking at: any live account → LIVE, else TESTNET, else DEMO. */
function ModeBadge() {
  const t = useT();
  const { data } = useQuery({ queryKey: ["accounts"], queryFn: () => api<{ accounts: Account[] }>("/accounts") });
  const accs = data?.accounts ?? [];
  if (!accs.length) return null;
  const live = accs.some((a) => a.env === "live");
  const testnet = accs.some((a) => a.env === "testnet");
  return <Badge tone={live ? "down" : testnet ? "warn" : "accent"}>{live ? t("mode.live") : testnet ? t("mode.testnet") : t("mode.paper")}</Badge>;
}

function useOutside(ref: React.RefObject<HTMLElement | null>, close: () => void) {
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) close(); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);
}

export function Layout({ user, workspaces = [], children }: { user: User; workspaces?: Workspace[]; children: ReactNode }) {
  const t = useT();
  const [loc] = useLocation();
  const qc = useQueryClient();
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useOutside(menuRef, () => setMenu(false));
  const ws = workspace.get();
  const acting = workspaces.find((w) => w.id === ws) ?? null;
  const switchTo = (id: number | null) => { workspace.set(id); qc.clear(); window.location.reload(); };
  const signOut = async () => {
    workspace.set(null);
    await api("/auth/logout", { method: "POST" }).catch(() => undefined);
    qc.clear();
    window.location.href = import.meta.env.BASE_URL;
  };
  const isTerminal = loc.startsWith("/terminal");
  const initial = (user.email[0] ?? "?").toUpperCase();

  return (
    <div className="flex h-full flex-col">
      <header className="glass relative z-30 flex h-16 shrink-0 items-center gap-6 border-b border-line px-4 md:px-6">
        <Link href="/terminal" className="shrink-0"><span className="hidden sm:block"><Wordmark size="sm" /></span><span className="sm:hidden"><Logo className="h-8 w-8" /></span></Link>
        <nav className="hidden h-full items-center gap-1 md:flex">
          {NAV.map((n) => {
            const on = loc.startsWith(n.href);
            return (
              <Link key={n.href} href={n.href}
                className={cx("relative flex h-10 items-center rounded-xl px-4 text-sm font-medium transition",
                  on ? "bg-gradient-to-b from-accent/25 to-violet/10 text-white shadow-[inset_0_0_0_1px_rgba(99,102,241,0.35)]" : "text-muted hover:text-text")}>
                {t(n.key)}
              </Link>
            );
          })}
          {user.admin && (
            <Link href="/admin" className={cx("flex h-10 items-center rounded-xl px-4 text-sm font-medium transition", loc.startsWith("/admin") ? "bg-accent/15 text-white" : "text-muted hover:text-text")}>{t("adm.title")}</Link>
          )}
        </nav>
        <div className="ml-auto flex items-center gap-1.5">
          {!isTerminal && <ModeBadge />}
          <Link href="/settings/notifications" title={t("settings.notifications")} className="flex h-10 w-10 items-center justify-center rounded-xl text-muted hover:bg-panel-2 hover:text-text"><Icon d={BELL} /></Link>
          <Link href="/settings" title={t("nav.settings")} className={cx("flex h-10 w-10 items-center justify-center rounded-xl hover:bg-panel-2 hover:text-text", loc.startsWith("/settings") ? "text-text" : "text-muted")}><Icon d={GEAR} /></Link>
          <div ref={menuRef} className="relative">
            <button onClick={() => setMenu((m) => !m)} className="brand-gradient ml-1 flex h-10 w-10 items-center justify-center rounded-full p-[2px]" aria-label="account">
              <span className="flex h-full w-full items-center justify-center rounded-full bg-panel font-display text-sm font-semibold">{initial}</span>
            </button>
            {menu && (
              <div className="absolute right-0 top-12 w-72 rounded-2xl border border-line bg-panel p-2 shadow-2xl">
                <div className="truncate px-3 py-2 text-sm">{user.email}</div>
                {workspaces.length > 0 && (
                  <div className="border-t border-line px-1 py-2">
                    <button onClick={() => switchTo(null)} className={cx("w-full rounded-lg px-2 py-1.5 text-left text-sm hover:bg-panel-2", !acting && "text-accent")}>{t("ws.mine")}</button>
                    {workspaces.map((w) => (
                      <button key={w.id} onClick={() => switchTo(w.id)} className={cx("w-full truncate rounded-lg px-2 py-1.5 text-left text-sm hover:bg-panel-2", acting?.id === w.id && "text-accent")}>
                        {w.email} · <span className="text-muted">{t(`role.${w.role}` as Key)}</span>
                      </button>
                    ))}
                  </div>
                )}
                <div className="border-t border-line px-1 pt-2">
                  <Link href="/settings/billing" onClick={() => setMenu(false)} className="block rounded-lg px-2 py-1.5 text-sm hover:bg-panel-2">{t("settings.billing")}</Link>
                  <Link href="/settings/security" onClick={() => setMenu(false)} className="block rounded-lg px-2 py-1.5 text-sm hover:bg-panel-2">{t("settings.security")}</Link>
                  <button onClick={signOut} className="w-full rounded-lg px-2 py-1.5 text-left text-sm text-down hover:bg-panel-2">{t("common.signout")}</button>
                </div>
              </div>
            )}
          </div>
        </div>
      </header>

      {acting && (
        <div className="flex items-center justify-between gap-2 border-b border-warn/30 bg-warn/10 px-4 py-1.5 text-xs text-warn md:px-6">
          <span>{t("ws.acting", { email: acting.email, role: t(`role.${acting.role}` as Key) })}</span>
          <button className="underline" onClick={() => switchTo(null)}>{t("ws.mine")}</button>
        </div>
      )}

      <main className={cx("min-h-0 flex-1 overflow-y-auto pb-24 md:pb-0", isTerminal ? "" : "px-4 py-6 md:px-8")}>
        {!isTerminal && (() => {
          const k = NAV.find((n) => loc.startsWith(n.href))?.key ?? (loc.startsWith("/settings") ? "nav.settings" : loc.startsWith("/admin") ? "adm.title" : null);
          return k ? <h1 className="mx-auto mb-6 max-w-5xl font-display text-2xl font-semibold tracking-tight md:text-3xl">{t(k as Key)}</h1> : null;
        })()}
        {children}
      </main>

      {/* Mobile: bottom tabs */}
      <nav className="glass fixed inset-x-0 bottom-0 z-40 grid grid-cols-7 border-t border-line md:hidden">
        {[...NAV, { href: "/settings", key: "nav.settings" as Key, icon: GEAR }].map((n) => (
          <Link key={n.href} href={n.href}
            className={cx("flex flex-col items-center gap-1 py-2 text-[10px]", loc.startsWith(n.href) ? "text-accent" : "text-muted")}>
            <Icon d={n.icon} />
            <span className="truncate px-0.5">{t(n.key).split(" ")[0]}</span>
          </Link>
        ))}
      </nav>
    </div>
  );
}
