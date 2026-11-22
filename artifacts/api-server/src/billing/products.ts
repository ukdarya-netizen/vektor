/**
 * What can be bought, and the prices. Monthly price × months, minus 10% for 3 months and 20% for 12.
 * Products: the terminal, and for each signal bot — access (Telegram + dashboard) and autotrading in VECTOR.
 */
export type BotKey = "cab" | "nihilist" | "bmm";
export type Product = "terminal" | `bot:${BotKey}:access` | `bot:${BotKey}:auto`;
export const PERIODS = [1, 3, 12] as const;
export type Months = (typeof PERIODS)[number];
const DISCOUNT: Record<Months, number> = { 1: 0, 3: 0.1, 12: 0.2 };

export const MONTHLY: Record<"terminal" | "access" | "auto", number> = { terminal: 50, access: 100, auto: 100 };

export const BOTS: Record<BotKey, { name: string; env: string; telegram: string | null; desc: { ru: string; en: string } }> = {
  cab: {
    name: "Crypto Alt Bullet", env: "CAB",
    telegram: process.env.BOT_CAB_TELEGRAM?.replace(/^@/, "") || null,
    desc: { ru: "Альткоины BingX: отскоки от уровней, пробои, импульсы и каскады ликвидаций — по объёму. Работает 24/7.", en: "BingX altcoins: level bounces, breakouts, impulses and liquidation cascades — confirmed by volume. Runs 24/7." },
  },
  nihilist: {
    name: "Crypto Nihilist", env: "NIHILIST",
    telegram: process.env.BOT_NIHILIST_TELEGRAM?.replace(/^@/, "") || "NihilystCryptoBot",
    desc: { ru: "Smart Money: ордер-блоки старших таймфреймов и слом структуры на младших. Лонги и шорты.", en: "Smart Money: higher-timeframe order blocks and lower-timeframe structure breaks. Longs and shorts." },
  },
  bmm: {
    name: "Bitcoin Margin Master", env: "BMM",
    telegram: process.env.BOT_BMM_TELEGRAM?.replace(/^@/, "") || null,
    desc: { ru: "Только биткоин: пробои и ложные выходы из диапазонов, уровни и каскады на дневке. Лонги и шорты.", en: "Bitcoin only: range breakouts and deviations, levels and cascades on the daily. Longs and shorts." },
  },
};
export const BOT_KEYS = Object.keys(BOTS) as BotKey[];

export const isProduct = (p: string): p is Product =>
  p === "terminal" || BOT_KEYS.some((k) => p === `bot:${k}:access` || p === `bot:${k}:auto`);

export function price(product: Product, months: Months): number {
  const base = product === "terminal" ? MONTHLY.terminal : product.endsWith(":auto") ? MONTHLY.auto : MONTHLY.access;
  return Math.round(base * months * (1 - DISCOUNT[months]) * 100) / 100;
}

export const botOf = (p: Product): BotKey | null => (p.startsWith("bot:") ? (p.split(":")[1] as BotKey) : null);
