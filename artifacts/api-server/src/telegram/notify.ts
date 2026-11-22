import { one } from "../db";
import { enqueue } from "./outbox";
import type { Msg } from "./texts";

/** Every notification kind belongs to a group the user can switch off — except CRITICAL ones. */
export const GROUPS = {
  trades: ["opened", "partial", "stop_moved", "take", "closed"],
  not_opened: ["not_opened"],
  signals: ["signal_received", "signal_rejected"],
  exchange: ["exchange_problem", "exchange_restored"],
  reconcile: ["reconcile_fixed"],
  account: ["subscription", "security"],
} as const;
export type Group = keyof typeof GROUPS;
export type Kind = (typeof GROUPS)[Group][number] | "liquidation" | "protection_failed" | "test";

/** Always delivered, even in quiet hours and with the group off. */
export const CRITICAL = new Set<Kind>(["liquidation", "protection_failed", "exchange_problem", "test"]);

export const DEFAULT_GROUPS: Record<Group, boolean> = { trades: true, not_opened: true, signals: false, exchange: true, reconcile: true, account: true };

export const groupOf = (k: Kind): Group | null =>
  (Object.keys(GROUPS) as Group[]).find((g) => (GROUPS[g] as readonly string[]).includes(k)) ?? null;

export function inQuietHours(now: Date, tz: string, from: number | null, to: number | null): boolean {
  if (from === null || to === null || from === to) return false;
  let h: number;
  try { h = Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone: tz }).format(now)); } catch { h = now.getUTCHours(); }
  return from < to ? h >= from && h < to : h >= from || h < to;
}

/**
 * Queues a message for the user's Telegram if linked and allowed.
 * Quiet hours drop non-critical messages (they are about the past by morning).
 */
export async function notify(userId: number, kind: Kind, msg: Msg): Promise<boolean> {
  const r = await one<{ chat_id: string | null; lang: string; tz: string; groups: Record<string, boolean> | null; quiet_from: number | null; quiet_to: number | null }>(
    `SELECT l.chat_id, u.lang, u.tz, s.groups, s.quiet_from, s.quiet_to FROM vk_users u
     LEFT JOIN vk_telegram_links l ON l.user_id = u.id LEFT JOIN vk_notification_settings s ON s.user_id = u.id WHERE u.id = $1`, [userId]);
  if (!r?.chat_id) return false;
  if (!CRITICAL.has(kind)) {
    const g = groupOf(kind);
    const on = g ? (r.groups?.[g] ?? DEFAULT_GROUPS[g]) : true;
    if (!on) return false;
    if (inQuietHours(new Date(), r.tz, r.quiet_from, r.quiet_to)) return false;
  }
  await enqueue(userId, r.chat_id, kind, r.lang === "en" ? msg.en : msg.ru);
  return true;
}
