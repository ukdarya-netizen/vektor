/**
 * Subscription plans and their limits. Adjust numbers here; everything else reads them.
 * New users get a 14-day trial with Pro limits. An expired plan falls back to Free:
 * nothing already open is touched (positions stay managed); only NEW things beyond Free are refused.
 */
import { one } from "../db";

export type PlanId = "free" | "trial" | "pro" | "team";
export type Limits = { realAccounts: number; bots: number; grids: number; copilot: boolean; teamMembers: number };

const INF = Number.POSITIVE_INFINITY;
export const PLANS: Record<PlanId, { name: { ru: string; en: string }; limits: Limits }> = {
  free: { name: { ru: "Бесплатный", en: "Free" }, limits: { realAccounts: 1, bots: 1, grids: 0, copilot: false, teamMembers: 0 } },
  trial: { name: { ru: "Пробный", en: "Trial" }, limits: { realAccounts: INF, bots: INF, grids: INF, copilot: true, teamMembers: 2 } },
  pro: { name: { ru: "Pro", en: "Pro" }, limits: { realAccounts: INF, bots: INF, grids: INF, copilot: true, teamMembers: 2 } },
  team: { name: { ru: "Команда", en: "Team" }, limits: { realAccounts: INF, bots: INF, grids: INF, copilot: true, teamMembers: 20 } },
};

export async function effectivePlan(userId: number): Promise<{ plan: PlanId; stored: PlanId; until: Date | null; expired: boolean; limits: Limits }> {
  const r = await one<{ plan: PlanId; plan_until: Date | null }>("SELECT plan, plan_until FROM vk_users WHERE id = $1", [userId]);
  const stored = (r?.plan ?? "free") as PlanId;
  const until = r?.plan_until ? new Date(r.plan_until) : null;
  const expired = stored !== "free" && until !== null && until.getTime() < Date.now();
  const plan: PlanId = expired ? "free" : stored;
  return { plan, stored, until, expired, limits: PLANS[plan].limits };
}

export type LimitKey = "realAccounts" | "bots" | "grids" | "teamMembers";
const COUNT_SQL: Record<LimitKey, string> = {
  realAccounts: "SELECT count(*)::int AS n FROM vk_exchange_accounts WHERE user_id = $1 AND env <> 'paper'",
  bots: "SELECT count(*)::int AS n FROM vk_bots WHERE user_id = $1",
  grids: "SELECT count(*)::int AS n FROM vk_grids WHERE user_id = $1 AND status = 'running'",
  teamMembers: "SELECT count(*)::int AS n FROM vk_team WHERE owner_id = $1",
};

/** null = allowed; otherwise what to tell the user (HTTP 402). */
export async function checkLimit(userId: number, key: LimitKey): Promise<null | { error: "plan_limit"; key: LimitKey; limit: number; plan: PlanId }> {
  const p = await effectivePlan(userId);
  const limit = p.limits[key];
  if (limit === INF) return null;
  const n = (await one<{ n: number }>(COUNT_SQL[key], [userId]))?.n ?? 0;
  return n >= limit ? { error: "plan_limit", key, limit, plan: p.plan } : null;
}

export async function usage(userId: number) {
  const out: Record<string, number> = {};
  for (const k of Object.keys(COUNT_SQL) as LimitKey[]) out[k] = (await one<{ n: number }>(COUNT_SQL[k], [userId]))?.n ?? 0;
  return out;
}
