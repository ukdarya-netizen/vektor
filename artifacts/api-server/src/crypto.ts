import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

/**
 * Exchange keys are encrypted with AES-256-GCM. VEKTOR_MASTER_KEY = 32 random bytes, base64
 * (generate: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))").
 * Losing it makes every stored key unreadable — users would have to reconnect exchanges.
 */
function masterKey(): Buffer {
  const raw = process.env.VEKTOR_MASTER_KEY?.trim();
  if (!raw) throw new Error("VEKTOR_MASTER_KEY is not set");
  const k = Buffer.from(raw, "base64");
  if (k.length !== 32) throw new Error("VEKTOR_MASTER_KEY must be 32 bytes in base64");
  return k;
}

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", masterKey(), iv);
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), body.toString("base64")].join(".");
}

export function decrypt(blob: string): string {
  const [v, iv, tag, body] = blob.split(".");
  if (v !== "v1" || !iv || !tag || !body) throw new Error("bad ciphertext");
  const d = createDecipheriv("aes-256-gcm", masterKey(), Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(body, "base64")), d.final()]).toString("utf8");
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** HMAC with the server secret — for codes and tokens stored in the DB. */
export function keyedHash(s: string): string {
  const secret = process.env.VEKTOR_SESSION_SECRET?.trim();
  if (!secret) throw new Error("VEKTOR_SESSION_SECRET is not set");
  return createHmac("sha256", secret).update(s).digest("hex");
}

export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

/** 6 digits, uniform, leading zeros kept. */
export const sixDigitCode = () => String(randomInt(0, 1_000_000)).padStart(6, "0");

export function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && timingSafeEqual(x, y);
}

/** "abcd…wxyz" for showing a key without revealing it. */
export const keyHint = (key: string) => (key.length <= 8 ? "••••" : `${key.slice(0, 4)}…${key.slice(-4)}`);
