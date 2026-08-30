// KERNEL FILE. The sun: how much energy the overseers may burn this month.
// The human sets MONTHLY_BUDGET_USD as a repository variable; the overseers can see it but not change it.
import type { Eon } from './canon';
export type State = {
  iteration: number;
  month: string;          // "2026-08"
  monthSpend: number;     // USD spent this month, summed from OpenRouter usage reports
  monthlyBudget: number;
  failStreak: number;
  models: Record<string, string>;
  baseline: Record<string, number> | null;
  lastRun: string | null;
  keyUsage?: { usage: number; limit: number | null };
  genesis: string | null;   // real-world time of tick 0; set once by the first heartbeat
  eons: Eon[];
  canonTick: number;
  heartbeatAt: string | null;
};

export const monthKey = (d = new Date()) => d.toISOString().slice(0, 7);

export function rollMonth(s: State): State {
  const m = monthKey();
  return m === s.month ? s : { ...s, month: m, monthSpend: 0 };
}

export function budgetLeft(s: State): number {
  return Math.max(0, s.monthlyBudget - s.monthSpend);
}

// Lifetime usage on the key, for the README. Non-fatal if unavailable.
export async function keyUsage(): Promise<State['keyUsage'] | undefined> {
  try {
    const r = await fetch('https://openrouter.ai/api/v1/auth/key', { headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` } });
    const { data } = await r.json() as { data: { usage: number; limit: number | null } };
    return { usage: data.usage, limit: data.limit };
  } catch { return undefined; }
}
