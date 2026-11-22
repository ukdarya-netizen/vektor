import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { Redirect, Route, Router, Switch } from "wouter";
import { api, ApiError, setTwoFactorPrompt, workspace, type User, type Workspace } from "@/lib/api";
import { AdminPage } from "@/pages/Admin";
import { translate } from "@/lib/i18n";
import { browserLang, LangProvider, useT, type Lang } from "@/lib/i18n";
import { Layout } from "@/components/Layout";
import { Spinner } from "@/components/ui";
import { Login } from "@/pages/Login";
import { Onboarding } from "@/pages/Onboarding";
import { PortfolioPage } from "@/pages/Portfolio";
import { PositionsPage } from "@/pages/Positions";
import { SettingsPage } from "@/pages/Settings";
import { TerminalPage } from "@/pages/Terminal";
import { SignalsPage } from "@/pages/Signals";
import { BotsPage } from "./pages/Bots";
import { JournalPage } from "@/pages/Journal";
import "./index.css";

const qc = new QueryClient({
  defaultOptions: { queries: { retry: (n, e) => !(e instanceof ApiError && e.status === 401) && n < 2, refetchOnWindowFocus: true } },
});

function App() {
  const client = useQueryClient();
  const me = useQuery({ queryKey: ["me"], queryFn: () => api<{ user: User; workspaces: Workspace[] }>("/auth/me") });
  const [guestLang, setGuestLang] = useState<Lang>(() => (localStorage.getItem("vk_lang") as Lang) || browserLang());
  const user = me.data?.user;
  const workspaces = me.data?.workspaces ?? [];
  // A workspace the user is no longer in → back to their own account.
  useEffect(() => { const ws = workspace.get(); if (me.data && ws && !workspaces.some((w) => w.id === ws)) { workspace.set(null); window.location.reload(); } }, [me.data]);
  const lang: Lang = user?.lang ?? guestLang;

  useEffect(() => { document.documentElement.lang = lang; setTwoFactorPrompt(() => prompt(translate(lang, "tfa.prompt"))); }, [lang]);
  // First sign-in: remember the browser time zone.
  useEffect(() => {
    if (user && user.tz === "UTC") {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (tz && tz !== "UTC") void api("/auth/me", { method: "PATCH", body: { tz } }).then(() => me.refetch());
    }
  }, [user?.id]);

  const reloadMe = () => void client.invalidateQueries({ queryKey: ["me"] });

  if (me.isLoading) return <div className="flex h-full items-center justify-center text-muted"><Spinner /></div>;
  if (!user) {
    return (
      <Login lang={guestLang}
        onLang={(l) => { setGuestLang(l); try { localStorage.setItem("vk_lang", l); } catch { /* private mode */ } }}
        onDone={() => void client.resetQueries()} />
    );
  }
  return (
    <LangProvider lang={lang}>
      {!user.onboarded ? <Onboarding onFinish={reloadMe} /> : (
        <Layout user={user} workspaces={workspaces}>
          <Switch>
            <Route path="/terminal"><TerminalPage /></Route>
            <Route path="/positions"><PositionsPage /></Route>
            <Route path="/signals"><SignalsPage /></Route>
            <Route path="/bots"><BotsPage /></Route>
            <Route path="/portfolio"><PortfolioPage /></Route>
            <Route path="/journal"><JournalPage /></Route>
            <Route path="/settings/:tab?"><SettingsPage user={user} onUserChange={reloadMe} /></Route>
            {user.admin && <Route path="/admin"><AdminPage /></Route>}
            <Route><Redirect to="/terminal" /></Route>
          </Switch>
        </Layout>
      )}
    </LangProvider>
  );
}


createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <Router base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
        <App />
      </Router>
    </QueryClientProvider>
  </StrictMode>,
);
