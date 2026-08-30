import type { Agent } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";

/**
 * How often an agent may pick up work, as opposed to how much it may spend.
 *
 * The spending ceilings in `services/budgets.ts` answer "how much money" and
 * say nothing about "how often". Those come apart: an agent doing cheap work —
 * reading records, filing tasks, drafting short things — can run all day well
 * inside its budget and still act far more than anybody meant it to, and the
 * only signal is a timeline nobody is watching. A pace ceiling is the other
 * half, and it is the one somebody sets when they mean "try this, but not
 * fifty times".
 *
 * ## Calendar periods, in UTC
 *
 * Matching `budgets.periodStart` exactly, and for the reason written there: a
 * ceiling that rolls over at a different instant from the one the reports
 * total against is a ceiling the reports cannot explain. A week starts Monday,
 * the same ISO week the escalation digest is keyed on.
 *
 * ## What counts as one
 *
 * A task whose `startedAt` falls inside the period. `startedAt` is rewritten
 * on every claim, including a resume, so a task begun yesterday and continued
 * today counts once, today — never twice, and never against the day it is no
 * longer being worked. That is deliberately kinder than counting pickups: a
 * deploy interrupting a run five times is infrastructure, not the agent doing
 * five things, and a quota that punished it would empty itself on a bad
 * afternoon.
 *
 * ## Where it is enforced
 *
 * In `runDueTasks`, beside the budget check, which is the one place where
 * stopping is free: nothing has started, so nothing is half-done. A task held
 * here stays QUEUED with its place kept and begins on the tick after the
 * period rolls over. Being at a ceiling is the guardrail working — it is not
 * an error and it does not change the task's status.
 */

export type PacePeriod = "DAY" | "WEEK" | "MONTH";

/** Where the period began, in UTC. */
export function paceStart(period: PacePeriod, now = new Date()): Date {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const day = now.getUTCDate();
  if (period === "DAY") return new Date(Date.UTC(year, month, day));
  if (period === "MONTH") return new Date(Date.UTC(year, month, 1));
  // ISO weeks run Monday to Sunday. `getUTCDay()` calls Sunday 0, so it is
  // mapped to 7 before subtracting — otherwise every Sunday would start its
  // own week and the ceiling would reset a day early, once a week, for ever.
  const weekday = now.getUTCDay() || 7;
  return new Date(Date.UTC(year, month, day - (weekday - 1)));
}

export interface PaceState {
  /** True when this agent has reached one of its ceilings. */
  atCeiling: boolean;
  /** Which one, when it has. */
  period: PacePeriod | null;
  started: number;
  limit: number | null;
  /** A sentence for the log and the screen. Null when nothing is capped. */
  note: string | null;
}

const NOTHING: PaceState = { atCeiling: false, period: null, started: 0, limit: null, note: null };

type Ceilings = Pick<Agent, "key" | "name" | "maxTasksPerDay" | "maxTasksPerWeek" | "maxTasksPerMonth">;

function ceilings(agent: Ceilings): [PacePeriod, number][] {
  const set: [PacePeriod, number | null][] = [
    ["DAY", agent.maxTasksPerDay],
    ["WEEK", agent.maxTasksPerWeek],
    ["MONTH", agent.maxTasksPerMonth],
  ];
  // `!== null`, never `> 0`. Zero is a ceiling of none, which is the obvious
  // way to stop an agent taking work without retiring it, and the usual guard
  // would read it as unset and let everything through.
  return set.filter((entry): entry is [PacePeriod, number] => entry[1] !== null && entry[1] !== undefined);
}

/** True when this agent declares any pace ceiling at all. */
export function hasPace(agent: Ceilings): boolean {
  return ceilings(agent).length > 0;
}

/**
 * Whether this agent may begin another task.
 *
 * Checked shortest period first, so the sentence names the ceiling that is
 * actually biting rather than whichever happens to be listed first. An agent
 * with no ceilings costs one function call and no query.
 */
export async function paceFor(agent: Ceilings, now = new Date()): Promise<PaceState> {
  const declared = ceilings(agent);
  if (declared.length === 0) return NOTHING;

  for (const [period, limit] of declared) {
    const started = await prisma.agentTask.count({
      where: { agentKey: agent.key, startedAt: { gte: paceStart(period, now) } },
    });
    if (started < limit) continue;
    const per = period === "DAY" ? "today" : period === "WEEK" ? "this week" : "this month";
    return {
      atCeiling: true,
      period,
      started,
      limit,
      note:
        limit === 0
          ? `${agent.name} is set to take no tasks ${per}.`
          : `${agent.name} has started ${started} task(s) ${per}, which is its ceiling of ${limit}. Nothing new begins until the period rolls over or the ceiling is raised.`,
    };
  }

  return NOTHING;
}

export interface PaceUsage {
  period: PacePeriod;
  started: number;
  limit: number | null;
}

/** What this agent has done in each period, for a screen. Ceilings or not. */
export async function paceUsage(agent: Ceilings, now = new Date()): Promise<PaceUsage[]> {
  const limits: Record<PacePeriod, number | null> = {
    DAY: agent.maxTasksPerDay,
    WEEK: agent.maxTasksPerWeek,
    MONTH: agent.maxTasksPerMonth,
  };
  return Promise.all(
    (["DAY", "WEEK", "MONTH"] as PacePeriod[]).map(async (period) => ({
      period,
      started: await prisma.agentTask.count({
        where: { agentKey: agent.key, startedAt: { gte: paceStart(period, now) } },
      }),
      limit: limits[period],
    })),
  );
}
