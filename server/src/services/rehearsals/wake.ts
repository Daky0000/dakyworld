import type { AgentStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";

/**
 * Waking the agents a rehearsal needs, and putting them back afterwards.
 *
 * Every specialist and most of the board seed as a **draft**, and a draft picks
 * nothing up. So the first thing anybody met on the Rehearsal screen was five
 * greyed-out workflows and an instruction to go and switch eleven agents on by
 * hand — which is not a test of the workforce, it is an errand standing in
 * front of one. Worse, having done it, they would be left with a floor of
 * agents switched on because of a test, quietly taking real work.
 *
 * So a rehearsal wakes what it needs at the moment it starts, wakes anything
 * else it reaches for as it runs, and puts every one of them back exactly as it
 * found them when the run ends.
 *
 * **A draft is woken. A paused agent is not.** That distinction is the whole
 * safety of this file and it is not arbitrary: a draft has simply never been
 * switched on, while pausing is something a person *did* — it is precisely how
 * the Owner stops an agent's standing work. Overriding a decision because a
 * test wanted to would be the software deciding it knew better. Retired is the
 * same, more so. Both are refused with the reason said out loud.
 *
 * **What was woken is written down before anything is woken**, on the
 * rehearsal's own row as `{ "dev.web": "DRAFT" }`. A process that dies
 * mid-rehearsal would otherwise leave the floor switched on with nothing
 * anywhere recording that it should not be — which is the failure mode where
 * a test quietly changes how the business runs. `restoreOrphanedWakes()` at
 * boot is the other half of that.
 */

/** The only status a rehearsal may change, and what it changes it to. */
const WAKEABLE: AgentStatus = "DRAFT";

export interface WakeResult {
  /** Keys switched to ACTIVE by this call, with the status each had before. */
  woke: Record<string, AgentStatus>;
  /** Agents this wanted and could not have, with the reason. */
  refused: Array<{ key: string; name: string; reason: string }>;
}

/**
 * Everyone the starting agent can hand work *down* to, however many rungs.
 *
 * `delegate` only goes down the chart, so this is the set a run will reach
 * without anybody having to guess. Sideways hand-offs can reach anyone at all,
 * which is why they are handled where they happen — see `wakeOne`.
 *
 * Walked rather than joined because the chart is small and a recursive CTE for
 * fifty rows is a query nobody can read. Bounded, because a `managerKey` cycle
 * would otherwise be an infinite loop at the moment somebody presses start.
 */
export async function reportsUnder(rootKey: string): Promise<string[]> {
  const everyone = await prisma.agent.findMany({ select: { key: true, managerKey: true } });
  const byManager = new Map<string, string[]>();
  for (const agent of everyone) {
    if (!agent.managerKey) continue;
    byManager.set(agent.managerKey, [...(byManager.get(agent.managerKey) ?? []), agent.key]);
  }

  const found = new Set<string>([rootKey]);
  let frontier = [rootKey];
  for (let depth = 0; depth < 8 && frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const key of frontier) {
      for (const child of byManager.get(key) ?? []) {
        if (found.has(child)) continue;
        found.add(child);
        next.push(child);
      }
    }
    frontier = next;
  }
  return [...found];
}

/**
 * Wakes a set of agents for a rehearsal and records what it changed.
 *
 * The record is written **in the same transaction as the status change**, so
 * there is no window in which an agent is awake and nothing knows it was this
 * rehearsal that woke it.
 */
export async function wakeFor(rehearsalId: string, keys: string[]): Promise<WakeResult> {
  const agents = await prisma.agent.findMany({
    where: { key: { in: keys } },
    select: { key: true, name: true, status: true },
  });

  const woke: Record<string, AgentStatus> = {};
  const refused: WakeResult["refused"] = [];

  for (const agent of agents) {
    if (agent.status === "ACTIVE") continue;
    if (agent.status !== WAKEABLE) {
      refused.push({
        key: agent.key,
        name: agent.name,
        reason: `${agent.name} is ${agent.status.toLowerCase()}. A rehearsal wakes agents that were never switched on; it does not undo a decision you made.`,
      });
      continue;
    }
    woke[agent.key] = agent.status;
  }

  if (Object.keys(woke).length > 0) {
    const rehearsal = await prisma.rehearsal.findUnique({ where: { id: rehearsalId }, select: { wokeAgents: true } });
    const already = (rehearsal?.wokeAgents ?? {}) as Record<string, AgentStatus>;
    await prisma.$transaction([
      // Written first. An agent awake with no record of who woke it is an agent
      // that stays awake.
      prisma.rehearsal.update({ where: { id: rehearsalId }, data: { wokeAgents: { ...already, ...woke } } }),
      prisma.agent.updateMany({ where: { key: { in: Object.keys(woke) }, status: WAKEABLE }, data: { status: "ACTIVE" } }),
    ]);
  }

  return { woke, refused };
}

/**
 * Wakes one agent that a running rehearsal has just reached sideways.
 *
 * Called from `delegate` and `handOff` when the task is a rehearsal and the
 * target is a draft. Without it, the most interesting thing a rehearsal can
 * show — an agent deciding that this is somebody else's craft — ends in
 * "the Page Reviewer is a draft and cannot take work", which is a fact about
 * the setup rather than about the workforce.
 *
 * Returns false when the agent is paused or retired, and the caller then
 * refuses exactly as it did before.
 */
export async function wakeOne(taskId: string, agentKey: string): Promise<boolean> {
  const rehearsal = await prisma.rehearsal.findFirst({
    where: { status: "RUNNING", rootTaskId: { not: null } },
    orderBy: { startedAt: "desc" },
    select: { id: true, rootTaskId: true },
  });
  // Which rehearsal this task belongs to is decided by the tree, not by
  // recency — see `rehearsalOf`. The query above is only the cheap path for
  // the common case of one run at a time.
  const owner = await rehearsalOf(taskId, rehearsal);
  if (!owner) return false;

  const result = await wakeFor(owner, [agentKey]);
  return Object.keys(result.woke).length > 0;
}

/**
 * Which rehearsal a task belongs to, by walking up its parents to a root.
 *
 * A task knows it is part of a rehearsal (`AgentTask.rehearsal`) and not which
 * one; the link is `Rehearsal.rootTaskId`, and a delegated task is any number
 * of rungs below it. Walking up is the cheap direction — one parent each — and
 * bounded for the same reason the tree walk down is.
 */
async function rehearsalOf(taskId: string, hint: { id: string; rootTaskId: string | null } | null): Promise<string | null> {
  let cursor: string | null = taskId;
  for (let depth = 0; depth < 10 && cursor; depth += 1) {
    if (hint?.rootTaskId === cursor) return hint.id;
    const found: { id: string } | null = await prisma.rehearsal.findFirst({ where: { rootTaskId: cursor }, select: { id: true } });
    if (found) return found.id;
    const task: { parentId: string | null } | null = await prisma.agentTask.findUnique({
      where: { id: cursor },
      select: { parentId: true },
    });
    cursor = task?.parentId ?? null;
  }
  return null;
}

/**
 * Puts back every agent this rehearsal woke.
 *
 * **Only the ones no other running rehearsal still needs.** Two runs going at
 * once will often wake the same specialist, and the first to finish putting it
 * back to draft would stop the second one dead half way through — with the
 * symptom appearing on the *other* run, which is the kind of bug nobody
 * reproduces.
 *
 * Restores only agents still sitting at ACTIVE. An agent the Owner has since
 * paused, retired, or deliberately switched on for good is theirs; a tidy-up
 * that overwrote that would be this file doing exactly what it refuses to do
 * at the other end.
 */
export async function restoreWakes(rehearsalId: string): Promise<string[]> {
  const rehearsal = await prisma.rehearsal.findUnique({ where: { id: rehearsalId }, select: { wokeAgents: true } });
  const woke = (rehearsal?.wokeAgents ?? {}) as Record<string, AgentStatus>;
  const keys = Object.keys(woke);
  if (keys.length === 0) return [];

  const stillNeeded = new Set<string>();
  const others = await prisma.rehearsal.findMany({
    where: { status: "RUNNING", id: { not: rehearsalId } },
    select: { wokeAgents: true },
  });
  for (const other of others) {
    for (const key of Object.keys((other.wokeAgents ?? {}) as Record<string, AgentStatus>)) stillNeeded.add(key);
  }

  const restored: string[] = [];
  for (const key of keys) {
    if (stillNeeded.has(key)) continue;
    const put = await prisma.agent.updateMany({ where: { key, status: "ACTIVE" }, data: { status: woke[key] } });
    if (put.count > 0) restored.push(key);
  }

  await prisma.rehearsal.update({ where: { id: rehearsalId }, data: { wokeAgents: {} } });
  return restored;
}

/**
 * Puts back agents left awake by a rehearsal that never got to finish.
 *
 * Runs at boot, beside `resumeInterruptedTasks()`. A container killed mid-run
 * leaves the rehearsal RUNNING and its agents ACTIVE, and the next thing to
 * happen is the minute tick handing those agents real work — a test changing
 * how the business runs, days later, with nothing on screen connecting the two.
 *
 * A rehearsal whose run really was interrupted is marked STOPPED rather than
 * left RUNNING for ever, because the tasks under it were requeued by the
 * ordinary resume and will be picked up by the scheduler with the agents put
 * back — which is the honest description of what happened.
 */
export async function restoreOrphanedWakes(): Promise<number> {
  const stale = await prisma.rehearsal.findMany({
    where: { status: "RUNNING", NOT: { wokeAgents: { equals: {} } } },
    select: { id: true, host: true, startedAt: true },
  });
  if (stale.length === 0) return 0;

  let restored = 0;
  for (const rehearsal of stale) {
    const put = await restoreWakes(rehearsal.id);
    restored += put.length;
    await prisma.rehearsal.update({
      where: { id: rehearsal.id },
      data: { status: "STOPPED", finishedAt: new Date() },
    });
    if (put.length > 0) {
      console.log(`[rehearsal] put ${put.length} agent(s) back after an interrupted run against ${rehearsal.host}: ${put.join(", ")}`);
    }
  }
  return restored;
}
