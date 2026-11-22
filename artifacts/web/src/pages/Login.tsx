import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { translate, type Key, type Lang } from "@/lib/i18n";
import { Button, Input } from "@/components/ui";

/** One screen for sign-up and sign-in: email → code → in. */
export function Login({ lang, onLang, onDone }: { lang: Lang; onLang: (l: Lang) => void; onDone: () => void }) {
  const t = (k: Key, v?: Record<string, string | number>) => translate(lang, k, v);
  const [email, setEmail] = useState("");
  const [step, setStep] = useState<"email" | "code" | "totp">("email");
  const [ticket, setTicket] = useState("");
  const [totp, setTotp] = useState("");
  const [code, setCode] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [wait, setWait] = useState(0);
  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (wait <= 0) return;
    const id = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(id);
  }, [wait]);

  const errText = (e: unknown) => {
    if (e instanceof ApiError) {
      const key = `err.${e.code}` as Key;
      return translate(lang, key, { n: e.body?.attemptsLeft ?? 0 }) === key ? t("err.generic") : translate(lang, key, { n: e.body?.attemptsLeft ?? 0 });
    }
    return t("err.generic");
  };

  const requestCode = async () => {
    setErr(null); setBusy(true);
    try {
      const r = await api<{ resendAfter: number }>("/auth/request-code", { body: { email, lang } });
      setStep("code"); setCode(""); setWait(r.resendAfter);
      setTimeout(() => codeRef.current?.focus(), 50);
    } catch (e) {
      if (e instanceof ApiError && e.code === "too_soon") { setStep("code"); setWait(e.body?.retryAfter ?? 60); }
      setErr(errText(e));
    } finally { setBusy(false); }
  };

  const verify = async (c = code) => {
    if (c.length !== 6) return;
    setErr(null); setBusy(true);
    try {
      const r = await api<{ need2fa?: boolean; ticket?: string }>("/auth/verify", { body: { email, code: c, lang } });
      if (r.need2fa && r.ticket) { setTicket(r.ticket); setStep("totp"); setErr(null); return; }
      onDone();
    } catch (e) { setErr(errText(e)); setCode(""); }
    finally { setBusy(false); }
  };

  return (
    <div className="flex min-h-full items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center justify-between">
          <div className="flex items-center gap-2 text-xl font-bold tracking-[0.2em] text-accent">
            <svg viewBox="0 0 32 32" className="h-7 w-7"><path d="M7 9l9 15 9-15" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
            VEKTOR
          </div>
          <div className="flex gap-1 text-sm">
            {(["ru", "en"] as const).map((l) => (
              <button key={l} onClick={() => onLang(l)} className={`rounded-md px-2 py-1 ${l === lang ? "bg-panel-2 text-text" : "text-muted"}`}>{l.toUpperCase()}</button>
            ))}
          </div>
        </div>
        <h1 className="text-2xl font-semibold">{t("login.title")}</h1>

        {step === "totp" ? (
          <form className="mt-6 space-y-4" onSubmit={async (e) => {
            e.preventDefault(); setErr(null); setBusy(true);
            try { await api("/auth/2fa/login", { body: { ticket, code: totp } }); onDone(); }
            catch (er) { setErr(errText(er)); if (er instanceof ApiError && er.code === "ticket_expired") setStep("email"); setTotp(""); }
            finally { setBusy(false); }
          }}>
            <p className="text-sm text-muted">{t("tfa.loginText")}</p>
            <Input label={t("tfa.loginTitle")} autoFocus autoComplete="one-time-code" inputMode="numeric" maxLength={6}
              className="text-center font-mono text-2xl tracking-[0.5em]" value={totp} error={err}
              onChange={(e) => setTotp(e.target.value.replace(/\D/g, "").slice(0, 6))} />
            <Button type="submit" size="lg" className="w-full" disabled={busy || totp.length !== 6}>{t("login.enter")}</Button>
          </form>
        ) : step === "email" ? (
          <form className="mt-6 space-y-4" onSubmit={(e) => { e.preventDefault(); void requestCode(); }}>
            <p className="text-sm text-muted">{t("login.subtitle")}</p>
            <Input label={t("login.email")} type="email" autoComplete="email" inputMode="email" autoFocus required
              value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" error={err} />
            <Button type="submit" size="lg" className="w-full" disabled={busy || !email}>{t("login.getCode")}</Button>
          </form>
        ) : (
          <form className="mt-6 space-y-4" onSubmit={(e) => { e.preventDefault(); void verify(); }}>
            <p className="text-sm text-muted">{t("login.codeSent", { email })}</p>
            <Input ref={codeRef} label={t("login.code")} autoComplete="one-time-code" inputMode="numeric" maxLength={6}
              className="text-center font-mono text-2xl tracking-[0.5em]" value={code} error={err} hint={t("login.ttl")}
              onChange={(e) => {
                const v = e.target.value.replace(/\D/g, "").slice(0, 6);
                setCode(v);
                if (v.length === 6) void verify(v);
              }} />
            <Button type="submit" size="lg" className="w-full" disabled={busy || code.length !== 6}>{t("login.enter")}</Button>
            <div className="flex items-center justify-between text-sm">
              <button type="button" className="text-muted hover:text-text" onClick={() => { setStep("email"); setErr(null); }}>{t("login.changeEmail")}</button>
              {wait > 0
                ? <span className="text-muted">{t("login.resendIn", { s: wait })}</span>
                : <button type="button" className="text-accent hover:underline" onClick={() => void requestCode()}>{t("login.resend")}</button>}
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
