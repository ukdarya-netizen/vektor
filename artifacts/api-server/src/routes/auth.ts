import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { one, q } from "../db";
import { decrypt, encrypt, keyedHash, randomToken, safeEqualHex, sixDigitCode } from "../crypto";
import { newSecret, otpauthUrl, verifyTotp } from "../totp";
import { sendLoginCode } from "../mail";

/**
 * Sign-up and sign-in are one flow: email → 6-digit code → in.
 * A new email gets an account on its first successful code. No passwords.
 */
export const CODE_TTL_MIN = 10;
export const CODE_MAX_ATTEMPTS = 5;
export const RESEND_AFTER_S = 60;
const PER_EMAIL_PER_HOUR = 6;
const PER_IP_PER_HOUR = 30;
export const SESSION_DAYS = 30;
export const COOKIE = "vk_sid";

export type AuthedRequest = Request<any> & { user: { id: number; email: string; lang: string; tz: string; onboarded: boolean }; sessionHash: string };

const ip = (req: Request) => (req.headers["x-forwarded-for"]?.toString().split(",")[0] ?? req.ip ?? "").trim();
const normEmail = (e: string) => e.trim().toLowerCase();
const emailSchema = z.string().trim().toLowerCase().email().max(254);
const codeHash = (email: string, code: string) => keyedHash(`code:${email}:${code}`);

/** The signed-in user of a request that passed requireUser. */
export const userOf = (req: Request<any>) => (req as unknown as AuthedRequest).user;

export async function requireUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = req.cookies?.[COOKIE];
  if (!token) { res.status(401).json({ error: "not_signed_in" }); return; }
  const h = keyedHash(`sess:${token}`);
  const row = await one(
    `SELECT u.id, u.email, u.lang, u.tz, u.onboarded FROM vk_sessions s JOIN vk_users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`, [h]);
  if (!row) { res.clearCookie(COOKIE, { path: "/" }); res.status(401).json({ error: "not_signed_in" }); return; }
  // Sliding session: touch at most once a minute.
  void q("UPDATE vk_sessions SET last_seen_at = now() WHERE token_hash = $1 AND last_seen_at < now() - interval '1 minute'", [h]).catch(() => undefined);
  (req as AuthedRequest).user = { id: Number(row.id), email: row.email, lang: row.lang, tz: row.tz, onboarded: row.onboarded };
  (req as AuthedRequest).sessionHash = h;
  next();
}

export const authRouter = Router();

authRouter.post("/request-code", async (req, res) => {
  const parsed = emailSchema.safeParse(req.body?.email);
  if (!parsed.success) { res.status(400).json({ error: "bad_email" }); return; }
  const email = parsed.data;
  const lang = req.body?.lang === "en" ? "en" : "ru";
  const last = await one<{ age: number; n: number }>(
    `SELECT EXTRACT(EPOCH FROM now() - max(created_at))::float8 AS age, count(*)::int AS n
     FROM vk_email_codes WHERE email = $1 AND created_at > now() - interval '1 hour'`, [email]);
  if (last && last.age !== null && last.age < RESEND_AFTER_S) {
    res.status(429).json({ error: "too_soon", retryAfter: Math.ceil(RESEND_AFTER_S - last.age) }); return;
  }
  if ((last?.n ?? 0) >= PER_EMAIL_PER_HOUR) { res.status(429).json({ error: "too_many_codes" }); return; }
  const byIp = await one<{ n: number }>("SELECT count(*)::int AS n FROM vk_email_codes WHERE ip = $1 AND created_at > now() - interval '1 hour'", [ip(req)]);
  if ((byIp?.n ?? 0) >= PER_IP_PER_HOUR) { res.status(429).json({ error: "too_many_codes" }); return; }

  const code = sixDigitCode();
  // A new code replaces the previous ones for this email.
  await q("UPDATE vk_email_codes SET used_at = now() WHERE email = $1 AND used_at IS NULL", [email]);
  await q(`INSERT INTO vk_email_codes (email, code_hash, ip, expires_at) VALUES ($1, $2, $3, now() + make_interval(mins => $4))`,
    [email, codeHash(email, code), ip(req), CODE_TTL_MIN]);
  try {
    await sendLoginCode(email, code, lang);
  } catch (e) {
    console.error("[auth] mail failed", e);
    res.status(502).json({ error: "mail_failed" }); return;
  }
  res.json({ ok: true, resendAfter: RESEND_AFTER_S, ttlMinutes: CODE_TTL_MIN });
});

authRouter.post("/verify", async (req, res) => {
  const e = emailSchema.safeParse(req.body?.email);
  const c = z.string().regex(/^\d{6}$/).safeParse(String(req.body?.code ?? "").replace(/\s/g, ""));
  if (!e.success || !c.success) { res.status(400).json({ error: "bad_code" }); return; }
  const email = e.data;
  const row = await one<{ id: number; code_hash: string; attempts: number; expired: boolean }>(
    `SELECT id, code_hash, attempts, expires_at < now() AS expired FROM vk_email_codes
     WHERE email = $1 AND used_at IS NULL ORDER BY id DESC LIMIT 1`, [email]);
  if (!row) { res.status(400).json({ error: "no_code" }); return; }
  if (row.expired) { res.status(400).json({ error: "code_expired" }); return; }
  if (row.attempts >= CODE_MAX_ATTEMPTS) { res.status(400).json({ error: "too_many_attempts" }); return; }
  if (!safeEqualHex(row.code_hash, codeHash(email, c.data))) {
    await q("UPDATE vk_email_codes SET attempts = attempts + 1 WHERE id = $1", [row.id]);
    res.status(400).json({ error: "wrong_code", attemptsLeft: Math.max(0, CODE_MAX_ATTEMPTS - row.attempts - 1) }); return;
  }
  await q("UPDATE vk_email_codes SET used_at = now() WHERE id = $1", [row.id]);
  const lang = req.body?.lang === "en" ? "en" : "ru";
  const user = await one<{ id: number; created: boolean }>(
    `INSERT INTO vk_users (email, lang, last_login_at) VALUES ($1, $2, now())
     ON CONFLICT (email) DO UPDATE SET last_login_at = now()
     RETURNING id, (xmax = 0) AS created`, [normEmail(email), lang]);
  const u2 = await one<{ totp_enabled: boolean }>("SELECT totp_enabled FROM vk_users WHERE id = $1", [user!.id]);
  if (u2?.totp_enabled) {
    // Second step: a short-lived signed ticket, exchanged for a session with a valid 2FA code.
    const exp = Date.now() + 5 * 60_000;
    res.json({ ok: true, need2fa: true, ticket: `${user!.id}.${exp}.${keyedHash(`2fa:${user!.id}:${exp}`)}` });
    return;
  }
  await startSession(req, res, user!.id);
  res.json({ ok: true, created: user!.created });
});

async function startSession(req: Request, res: Response, userId: number) {
  const token = randomToken();
  await q(`INSERT INTO vk_sessions (token_hash, user_id, user_agent, ip, expires_at)
           VALUES ($1, $2, $3, $4, now() + make_interval(days => $5))`,
    [keyedHash(`sess:${token}`), userId, String(req.headers["user-agent"] ?? "").slice(0, 300), ip(req), SESSION_DAYS]);
  res.cookie(COOKIE, token, {
    httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: SESSION_DAYS * 86_400_000,
  });
}

/* ---------- two-factor ---------- */
const attempts = new Map<number, { n: number; until: number }>();
/** 5 wrong codes → 5 minutes pause. A used step cannot be reused (replay). */
async function checkCode(userId: number, code: string): Promise<"ok" | "wrong" | "locked" | "off"> {
  const a = attempts.get(userId);
  if (a && a.n >= 5 && a.until > Date.now()) return "locked";
  const u = await one<{ totp_secret_enc: string | null; totp_enabled: boolean; totp_last_step: string | null }>("SELECT totp_secret_enc, totp_enabled, totp_last_step FROM vk_users WHERE id = $1", [userId]);
  if (!u?.totp_secret_enc) return "off";
  const step = verifyTotp(decrypt(u.totp_secret_enc), code);
  if (step === null || (u.totp_last_step !== null && step <= Number(u.totp_last_step))) {
    attempts.set(userId, { n: (a && a.until > Date.now() ? a.n : 0) + 1, until: Date.now() + 5 * 60_000 });
    return "wrong";
  }
  attempts.delete(userId);
  await q("UPDATE vk_users SET totp_last_step = $2 WHERE id = $1", [userId, step]);
  return "ok";
}

authRouter.post("/2fa/login", async (req, res) => {
  const [uid, exp, sig] = String(req.body?.ticket ?? "").split(".");
  const userId = Number(uid);
  if (!userId || !exp || Number(exp) < Date.now() || !sig || !safeEqualHex(sig, keyedHash(`2fa:${userId}:${exp}`))) { res.status(400).json({ error: "ticket_expired" }); return; }
  const r = await checkCode(userId, String(req.body?.code ?? ""));
  if (r !== "ok") { res.status(400).json({ error: r === "locked" ? "too_many_attempts" : "wrong_2fa" }); return; }
  await startSession(req, res, userId);
  res.json({ ok: true });
});

/**
 * Sensitive actions (risk limits, connecting/removing a real exchange) need a fresh code when 2FA is on.
 * The code comes in the X-2FA-Code header; without it → 403 need_2fa_code, the UI asks and repeats.
 */
export async function require2fa(req: Request, res: Response, next: NextFunction): Promise<void> {
  const user = userOf(req);
  const u = await one<{ totp_enabled: boolean }>("SELECT totp_enabled FROM vk_users WHERE id = $1", [user.id]);
  if (!u?.totp_enabled) { next(); return; }
  const code = String(req.headers["x-2fa-code"] ?? "");
  if (!code) { res.status(403).json({ error: "need_2fa_code" }); return; }
  const r = await checkCode(user.id, code);
  if (r !== "ok") { res.status(403).json({ error: r === "locked" ? "too_many_attempts" : "wrong_2fa" }); return; }
  next();
}

authRouter.get("/2fa", requireUser, async (req, res) => {
  const u = await one<{ totp_enabled: boolean }>("SELECT totp_enabled FROM vk_users WHERE id = $1", [userOf(req).id]);
  res.json({ enabled: Boolean(u?.totp_enabled) });
});

/** New secret (not active until confirmed with a code). */
authRouter.post("/2fa/setup", requireUser, async (req, res) => {
  const user = userOf(req);
  const u = await one<{ totp_enabled: boolean }>("SELECT totp_enabled FROM vk_users WHERE id = $1", [user.id]);
  if (u?.totp_enabled) { res.status(409).json({ error: "already_enabled" }); return; }
  const secret = newSecret();
  await q("UPDATE vk_users SET totp_secret_enc = $2, totp_last_step = NULL WHERE id = $1", [user.id, encrypt(secret)]);
  res.json({ secret, url: otpauthUrl(secret, user.email) });
});

authRouter.post("/2fa/enable", requireUser, async (req, res) => {
  const user = userOf(req);
  const r = await checkCode(user.id, String(req.body?.code ?? ""));
  if (r !== "ok") { res.status(400).json({ error: r === "locked" ? "too_many_attempts" : r === "off" ? "setup_first" : "wrong_2fa" }); return; }
  await q("UPDATE vk_users SET totp_enabled = true WHERE id = $1", [user.id]);
  res.json({ ok: true });
});

authRouter.post("/2fa/disable", requireUser, async (req, res) => {
  const user = userOf(req);
  const r = await checkCode(user.id, String(req.body?.code ?? ""));
  if (r !== "ok") { res.status(400).json({ error: r === "locked" ? "too_many_attempts" : "wrong_2fa" }); return; }
  await q("UPDATE vk_users SET totp_enabled = false, totp_secret_enc = NULL, totp_last_step = NULL WHERE id = $1", [user.id]);
  res.json({ ok: true });
});

authRouter.get("/me", requireUser, async (req, res) => {
  const user = userOf(req);
  res.json({ user });
});

authRouter.patch("/me", requireUser, async (req, res) => {
  const user = userOf(req);
  const body = z.object({
    lang: z.enum(["ru", "en"]).optional(),
    tz: z.string().max(64).refine((tz) => { try { new Intl.DateTimeFormat("en", { timeZone: tz }); return true; } catch { return false; } }).optional(),
    onboarded: z.boolean().optional(),
  }).safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: "bad_request" }); return; }
  const b = body.data;
  await q(`UPDATE vk_users SET lang = COALESCE($2, lang), tz = COALESCE($3, tz), onboarded = COALESCE($4, onboarded) WHERE id = $1`,
    [user.id, b.lang ?? null, b.tz ?? null, b.onboarded ?? null]);
  res.json({ ok: true });
});

authRouter.post("/logout", requireUser, async (req, res) => {
  await q("DELETE FROM vk_sessions WHERE token_hash = $1", [(req as AuthedRequest).sessionHash]);
  res.clearCookie(COOKIE, { path: "/" });
  res.json({ ok: true });
});

authRouter.get("/sessions", requireUser, async (req, res) => {
  const r = req as AuthedRequest;
  const rows = await q(`SELECT token_hash, user_agent, ip, created_at, last_seen_at FROM vk_sessions
                        WHERE user_id = $1 AND expires_at > now() ORDER BY last_seen_at DESC`, [r.user.id]);
  res.json({
    sessions: rows.map((s) => ({
      id: String(s.token_hash).slice(0, 12), current: s.token_hash === r.sessionHash,
      userAgent: s.user_agent, ip: s.ip, createdAt: s.created_at, lastSeenAt: s.last_seen_at,
    })),
  });
});

authRouter.post("/logout-others", requireUser, async (req, res) => {
  const r = req as AuthedRequest;
  await q("DELETE FROM vk_sessions WHERE user_id = $1 AND token_hash <> $2", [r.user.id, r.sessionHash]);
  res.json({ ok: true });
});
