import type { AgentStatus, Prisma } from "@prisma/client";
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
 * **Waking is three columns, not one.** See `REHEARSAL_AUTONOMY`: a status of
 * ACTIVE on a card that still says autonomy 1 and dry run on is an agent that
 * turns up, is handed the work, and is refused every tool it owns.
 *
 * **Only what it woke.** The same distinction, applied to the same decision at
 * the other end: an agent that was *already* active keeps the autonomy level
 * and dry-run flag the Owner gave it, untouched. A run may therefore still
 * contain an agent that prepared everything and carried out nothing — and that
 * is a true fact about the setup rather than a fault, which is why every
 * prepared call carries `heldBecause` and the screen now says it.
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

/**
 * The autonomy a woken agent runs at for the length of the run.
 *
 * Waking used to mean the status column and nothing else, which made a
 * rehearsal a test of which agents somebody happened to have switched on
 * already. Every agent seeds at `autonomyLevel 1` with `dryRun` on, and
 * `permissionFor` downgrades any spending, outward, write or send call from an
 * agent in that state to a preview — so an agent the rehearsal itself woke
 * could not carry out a single one of its own tools.
 *
 * The run against laluxurys.com is the whole argument. The Website Auditor,
 * woken from draft, prepared `site.look` and `audit.website` and carried out
 * neither; the SEO Specialist — already active at a working level, because
 * somebody had switched it on weeks before — ran both for real against the
 * same site in the same minute. Two agents, one job, opposite platforms, and
 * nothing on the screen said why.
 *
 * Four rather than five, because four is what `invokeTool` requires to spend
 * and spending is what research and a site audit do. The safety of the run
 * does not rest on this number either way: `rehearsals/policy.ts` holds every
 * outward call at a preview through `invokeTool`'s own floor, whatever the
 * agent's card says.
 *
 * Raised only, never lowered — an agent seeded above this keeps what it had.
 */
const REHEARSAL_AUTONOMY = 4;

/**
 * What an agent's card held before a rehearsal touched it.
 *
 * Rows written before this was three columns hold a bare `AgentStatus`, and
 * are read back as a status with two nulls: *this run only ever changed the
 * status, so only put the status back*. Restoring a level a run never lifted
 * would be inventing one.
 */
export interface WokeState {
  status: AgentStatus;
  autonomyLevel: number | null;
  dryRun: boolean | null;
}

export interface WakeResult {
  /** Keys switched to ACTIVE by this call, with the card each had before. */
  woke: Record<string, WokeState>;
  /** Agents this wanted and could not have, with the reason. */
  refused: Array<{ key: string; name: string; reason: string }>;
}

function readWoke(stored: unknown): Record<string, WokeState> {
  const rows = (stored ?? {}) as Record<string, unknown>;
  const read: Record<string, WokeState> = {};
  for (const [key, value] of Object.entries(rows)) {
    if (typeof value === "string") {
      read[key] = { status: value as AgentStatus, autonomyLevel: null, dryRun: null };
      continue;
    }
    const row = value as Partial<WokeState> | null;
    if (!row || typeof row.status !== "string") continue;
    read[key] = {
      status: row.status as AgentStatus,
      autonomyLevel: typeof row.autonomyLevel === "number" ? row.autonomyLevel : null,
      dryRun: typeof row.dryRun === "boolean" ? row.dryRun : null,
    };
  }
  return read;
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
    select: { key: true, name: true, status: true, autonomyLevel: true, dryRun: true },
  });

  const woke: Record<string, WokeState> = {};
  const lift: Array<{ key: string; toLevel: number; toDryRun: boolean }> = [];
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
    woke[agent.key] = { status: agent.status, autonomyLevel: agent.autonomyLevel, dryRun: agent.dryRun };
    lift.push({ key: agent.key, toLevel: Math.max(agent.autonomyLevel, REHEARSAL_AUTONOMY), toDryRun: false });
  }

  if (lift.length > 0) {
    const rehearsal = await prisma.rehearsal.findUnique({ where: { id: rehearsalId }, select: { wokeAgents: true } });
    const already = readWoke(rehearsal?.wokeAgents);
    await prisma.$transaction([
      // Written first. An agent awake with no record of who woke it is an agent
      // that stays awake — and now an agent left at a level nobody chose.
      prisma.rehearsal.update({
        where: { id: rehearsalId },
        data: { wokeAgents: { ...already, ...woke } as unknown as Prisma.InputJsonValue },
      }),
      // One update each rather than one `updateMany`, because the level each
      // agent ends at depends on the level it started at. The status guard is
      // the same conditional write it always was: two processes reaching for
      // the same draft cannot both wake it.
      ...lift.map((agent) =>
        prisma.agent.updateMany({
          where: { key: agent.key, status: WAKEABLE },
          data: { status: "ACTIVE", autonomyLevel: agent.toLevel, dryRun: agent.toDryRun },
        }),
      ),
      // The autonomy history is the answer to "who moved this agent to four",
      // and a rehearsal that moved one without writing it would make that
      // history a list with holes in it — the exact failure the column exists
      // to prevent. `actor` is a string for this reason: a new caller must not
      // need a migration to be able to explain itself.
      prisma.agentAutonomyChange.createMany({
        data: lift.map((agent) => ({
          agentKey: agent.key,
          fromLevel: woke[agent.key].autonomyLevel,
          toLevel: agent.toLevel,
          fromDryRun: woke[agent.key].dryRun,
          toDryRun: agent.toDryRun,
          reason: `Woken for a rehearsal, so it can carry out its own tools. Put back when the run ends.`,
          actor: "rehearsal",
        })),
      }),
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
 *
 * The autonomy and the dry-run flag go back **with** the status, in the same
 * write. Putting one back and not the others would leave a draft sitting at
 * autonomy 4 with dry run off, waiting for the day somebody switches it on —
 * which is the same failure as an agent left awake, arriving later and harder
 * to trace.
 */
export async function restoreWakes(rehearsalId: string): Promise<string[]> {
  const rehearsal = await prisma.rehearsal.findUnique({ where: { id: rehearsalId }, select: { wokeAgents: true } });
  const woke = readWoke(rehearsal?.wokeAgents);
  const keys = Object.keys(woke);
  if (keys.length === 0) return [];

  const stillNeeded = new Set<string>();
  const others = await prisma.rehearsal.findMany({
    where: { status: "RUNNING", id: { not: rehearsalId } },
    select: { wokeAgents: true },
  });
  for (const other of others) {
    for (const key of Object.keys(readWoke(other.wokeAgents))) stillNeeded.add(key);
  }

  const restored: string[] = [];
  for (const key of keys) {
    if (stillNeeded.has(key)) continue;
    const was = woke[key];
    const put = await prisma.agent.updateMany({
      where: { key, status: "ACTIVE" },
      data: {
        status: was.status,
        // Only what this run actually lifted. A row written by an older
        // rehearsal carries nulls here, and writing a level it never took
        // would be this function inventing the agent's history.
        ...(was.autonomyLevel === null ? {} : { autonomyLevel: was.autonomyLevel }),
        ...(was.dryRun === null ? {} : { dryRun: was.dryRun }),
      },
    });
    if (put.count === 0) continue;
    restored.push(key);
    if (was.autonomyLevel !== null || was.dryRun !== null) {
      await prisma.agentAutonomyChange.create({
        data: {
          agentKey: key,
          // What the lift set, recomputed rather than re-read: it is a pure
          // function of the level recorded above, and one fewer query on a
          // path that runs once per woken agent at the end of every run.
          fromLevel: was.autonomyLevel === null ? null : Math.max(was.autonomyLevel, REHEARSAL_AUTONOMY),
          toLevel: was.autonomyLevel,
          fromDryRun: was.dryRun === null ? null : false,
          toDryRun: was.dryRun,
          reason: "Put back after the rehearsal that woke it ended.",
          actor: "rehearsal",
        },
      });
    }
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
