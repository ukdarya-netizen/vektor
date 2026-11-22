/**
 * The user's own risk limits. Checked before every new entry (terminal and bots). Never blocks a close.
 * The kill switch stops all new entries at once; open positions keep their stops and takes.
 */
import { one } from "../db";

export type RiskLimits = {
  killSwitch: boolean;
  maxLeverage: number | null;
  maxMarginPerTrade: number | null;
  maxOpenPositions: number | null;
  dailyLossLimit: number | null;
};

export const NO_LIMITS: RiskLimits = { killSwitch: false, maxLeverage: null, maxMarginPerTrade: null, maxOpenPositions: null, dailyLossLimit: null };

export async function limitsOf(userId: number): Promise<RiskLimits> {
  const r = await one("SELECT * FROM vk_risk WHERE user_id = $1", [userId]);
  if (!r) return NO_LIMITS;
  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return { killSwitch: r.kill_switch, maxLeverage: n(r.max_leverage), maxMarginPerTrade: n(r.max_margin_per_trade), maxOpenPositions: n(r.max_open_positions), dailyLossLimit: n(r.daily_loss_limit) };
}

export type RiskBlock = { code: "kill_switch" | "max_leverage" | "max_margin" | "max_positions" | "daily_loss"; limit?: number; value?: number };

/** Pure part — covered by tests. */
export function evaluateRisk(l: RiskLimits, o: { margin: number; leverage: number; openPositions: number; lossToday: number }): RiskBlock | null {
  if (l.killSwitch) return { code: "kill_switch" };
  if (l.maxLeverage !== null && o.leverage > l.maxLeverage) return { code: "max_leverage", limit: l.maxLeverage, value: o.leverage };
  if (l.maxMarginPerTrade !== null && o.margin > l.maxMarginPerTrade + 1e-9) return { code: "max_margin", limit: l.maxMarginPerTrade, value: o.margin };
  if (l.maxOpenPositions !== null && o.openPositions >= l.maxOpenPositions) return { code: "max_positions", limit: l.maxOpenPositions, value: o.openPositions };
  if (l.dailyLossLimit !== null && o.lossToday >= l.dailyLossLimit) return { code: "daily_loss", limit: l.dailyLossLimit, value: o.lossToday };
  return null;
}

export async function checkRisk(userId: number, o: { margin: number; leverage: number; opening: boolean }): Promise<RiskBlock | null> {
  const l = await limitsOf(userId);
  if (l === NO_LIMITS) return null;
  const open = await one<{ n: number }>("SELECT count(*)::int AS n FROM vk_positions WHERE user_id = $1 AND status <> 'closed'", [userId]);
  // Loss "today" in the user's time zone, from closed managed positions (net of fees).
  const loss = await one<{ v: number }>(
    `SELECT COALESCE(-sum(p.pnl) FILTER (WHERE p.pnl < 0), 0)::float8 - COALESCE(sum(p.pnl) FILTER (WHERE p.pnl > 0), 0)::float8 AS v
     FROM vk_positions p JOIN vk_users u ON u.id = p.user_id
     WHERE p.user_id = $1 AND p.status = 'closed' AND p.pnl IS NOT NULL
       AND (p.closed_at AT TIME ZONE u.tz)::date = (now() AT TIME ZONE u.tz)::date`, [userId]);
  return evaluateRisk(l, { margin: o.margin, leverage: o.leverage, openPositions: open?.n ?? 0, lossToday: Math.max(0, loss?.v ?? 0) });
}
