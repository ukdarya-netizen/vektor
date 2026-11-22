/**
 * Login-code email. Provider: Resend (RESEND_API_KEY + MAIL_FROM, e.g. "VECTOR <login@yourdomain.com>").
 * Without a key in development the code is printed to the server log; in production sending fails
 * closed (the user sees "не удалось отправить письмо").
 */
type Lang = "ru" | "en";

const TEXT = {
  ru: {
    subject: (code: string) => `${code} — код входа в VECTOR`,
    body: (code: string) =>
      `Ваш код входа в VECTOR:\n\n${code}\n\nКод действует 10 минут.\nЕсли вы не запрашивали вход — просто проигнорируйте это письмо.`,
  },
  en: {
    subject: (code: string) => `${code} — your VECTOR sign-in code`,
    body: (code: string) =>
      `Your VECTOR sign-in code:\n\n${code}\n\nThe code is valid for 10 minutes.\nIf you didn't request it, just ignore this email.`,
  },
};

function html(code: string, lang: Lang): string {
  const lines = TEXT[lang].body(code).split("\n\n");
  return `<!doctype html><html><body style="margin:0;padding:32px;background:#0b0e14;font-family:Arial,sans-serif;color:#e6e9ef">
<div style="max-width:420px;margin:0 auto;background:#131823;border-radius:12px;padding:32px">
<div style="font-size:18px;font-weight:bold;letter-spacing:2px;color:#7aa2ff">VEKTOR</div>
<p style="font-size:15px">${lines[0]}</p>
<div style="font-size:36px;font-weight:bold;letter-spacing:8px;margin:16px 0;color:#fff">${code}</div>
<p style="font-size:13px;color:#9aa3b2">${(lines[2] ?? "").replace("\n", "<br>")}</p>
</div></body></html>`;
}

export async function sendLoginCode(email: string, code: string, lang: Lang): Promise<void> {
  const key = process.env.RESEND_API_KEY?.trim();
  const from = process.env.MAIL_FROM?.trim();
  if (!key || !from) {
    if (process.env.NODE_ENV !== "production") {
      console.log(`[mail:dev] login code for ${email}: ${code}`);
      return;
    }
    throw new Error("mail is not configured (RESEND_API_KEY, MAIL_FROM)");
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ from, to: [email], subject: TEXT[lang].subject(code), text: TEXT[lang].body(code), html: html(code, lang) }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`mail provider HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

/** Plain notification email (no HTML from user data). Silently skipped when mail is not configured. */
export async function sendMail(to: string, subject: string, text: string): Promise<boolean> {
  const key = process.env.RESEND_API_KEY?.trim();
  const from = process.env.MAIL_FROM?.trim();
  if (!key || !from) return false;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ from, to: [to], subject: subject.slice(0, 150), text }),
    signal: AbortSignal.timeout(10_000),
  });
  return res.ok;
}
