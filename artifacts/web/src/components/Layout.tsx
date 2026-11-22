import type { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Account, type User } from "@/lib/api";
import { useT, type Key } from "@/lib/i18n";
import { Badge, cx } from "./ui";

const NAV: Array<{ href: string; key: Key; icon: string }> = [
  { href: "/terminal", key: "nav.terminal", icon: "M3 17l5-6 4 4 7-9" },
  { href: "/positions", key: "nav.positions", icon: "M4 6h16M4 12h16M4 18h10" },
  { href: "/signals", key: "nav.signals", icon: "M13 2L4 14h7l-1 8 9-12h-7l1-8z" },
  { href: "/portfolio", key: "nav.portfolio", icon: "M4 19V9m6 10V5m6 14v-7m4 7H2" },
  { href: "/journal", key: "nav.journal", icon: "M6 3h10l4 4v14H6zM9 12h8M9 16h8M9 8h4" },
  { href: "/settings", key: "nav.settings", icon: "M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.6 1.6 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.6 1.6 0 00-2.7 1.1V21a2 2 0 11-4 0v-.1a1.6 1.6 0 00-2.7-1.1l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.6 1.6 0 00-1.1-2.7H3a2 2 0 110-4h.1a1.6 1.6 0 001.1-2.7l-.1-.1a2 2 0 112.8-2.8l.1.1a1.6 1.6 0 002.7-1.1V3a2 2 0 114 0v.1a1.6 1.6 0 002.7 1.1l.1-.1a2 2 0 112.8 2.8l-.1.1a1.6 1.6 0 001.1 2.7H21a2 2 0 110 4h-.1a1.6 1.6 0 00-1.5 1z" },
];

const Icon = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" className="h-5 w-5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>
);

/** Which money the user is looking at: any live account → LIVE, only testnet → TESTNET. */
function ModeBadge() {
  const t = useT();
  const { data } = useQuery({ queryKey: ["accounts"], queryFn: () => api<{ accounts: Account[] }>("/accounts") });
  const accs = data?.accounts ?? [];
  if (!accs.length) return null;
  const live = accs.some((a) => a.env === "live");
  const testnet = accs.some((a) => a.env === "testnet");
  return <Badge tone={live ? "down" : testnet ? "warn" : "accent"}>{live ? t("mode.live") : testnet ? t("mode.testnet") : t("mode.paper")}</Badge>;
}

export function Layout({ user, children }: { user: User; children: ReactNode }) {
  const t = useT();
  const [loc] = useLocation();
  const qc = useQueryClient();
  const signOut = async () => {
    await api("/auth/logout", { method: "POST" }).catch(() => undefined);
    qc.clear();
    window.location.href = import.meta.env.BASE_URL;
  };
  return (
    <div className="flex h-full">
      <aside className="hidden w-56 shrink-0 flex-col border-r border-line bg-panel md:flex">
        <div className="flex h-14 items-center gap-2 px-5 text-lg font-bold tracking-[0.2em] text-accent">
          <svg viewBox="0 0 32 32" className="h-6 w-6"><path d="M7 9l9 15 9-15" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          VEKTOR
        </div>
        <nav className="flex flex-1 flex-col gap-1 p-3">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href}
              className={cx("flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition",
                loc.startsWith(n.href) ? "bg-accent/15 text-text" : "text-muted hover:bg-panel-2 hover:text-text")}>
              <Icon d={n.icon} />
              {t(n.key)}
            </Link>
          ))}
        </nav>
        <div className="border-t border-line p-3 text-xs text-muted">
          <div className="truncate px-2 pb-2" title={user.email}>{user.email}</div>
          <button onClick={signOut} className="w-full rounded-md px-2 py-1.5 text-left hover:bg-panel-2 hover:text-text">{t("common.signout")}</button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-line px-4 md:px-6">
          <div className="text-base font-semibold md:hidden text-accent tracking-[0.2em]">VEKTOR</div>
          <div className="hidden text-base font-semibold md:block">{t(NAV.find((n) => loc.startsWith(n.href))?.key ?? "nav.terminal")}</div>
          {/* The terminal shows the mode of the selected account itself. */}
          {!loc.startsWith("/terminal") && <ModeBadge />}
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto px-4 py-5 pb-24 md:px-6 md:pb-6">{children}</main>
        {/* Mobile: bottom tabs */}
        <nav className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-6 border-t border-line bg-panel md:hidden">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href}
              className={cx("flex flex-col items-center gap-1 py-2 text-[10px]", loc.startsWith(n.href) ? "text-accent" : "text-muted")}>
              <Icon d={n.icon} />
              <span className="truncate px-0.5">{t(n.key).split(" ")[0]}</span>
            </Link>
          ))}
        </nav>
      </div>
    </div>
  );
}
