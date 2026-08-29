import type { AgentTaskStatus, Lead, Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { normaliseSiteUrl } from "../siteShot.js";
import { isBusy, runTask } from "../agents/runner.js";
import { recordCreated } from "../agents/state.js";
import { findScenario } from "./scenarios.js";
export { REHEARSAL_GUARANTEE } from "./policy.js";
import { reportsUnder, restoreWakes, wakeFor } from "./wake.js";

/**
 * Starting, feeding and tearing down a rehearsal.
 *
 * The rehearsal itself is three facts — a website, a scenario, and a scratch
 * lead — and everything after that is the ordinary agent runtime doing what it
 * always does. This file exists to do four things the runtime does not:
 *
 * 1. **Turn a URL into something the workforce can work on.** Most of the
 *    toolkit takes a lead id, so a rehearsal makes a real lead and marks it.
 * 2. **Mark the whole tree.** The root task carries `rehearsal`, and the
 *    runner passes it down through `delegate` and `handOff`, so nothing
 *    anywhere in the run can reach outside the building.
 * 3. **Keep it moving at the speed of somebody watching.** The scheduler picks
 *    queued tasks up once a minute, which is right for standing work and
 *    unbearable for a person who is watching a chain of six agents happen. See
 *    `nudge`.
 * 4. **Let it be thrown away.** A rehearsal that could not be deleted would
 *    make the second one more expensive than the first.
 */

/**
 * How many tasks one rehearsal may start at once.
 *
 * Below the runner's own `MAX_CONCURRENT`, on purpose. A rehearsal is
 * discretionary work and the rest of the business is not: a wide scenario that
 * fans out to nine agents must not be able to fill the floor and leave a real
 * task queued behind it.
 */
const REHEARSAL_CONCURRENCY = 1;

/**
 * The ceiling on a single run.
 *
 * Not a safety limit — nothing here can reach a client — but a spending one.
 * Each task is a model conversation with tools in it, and a scenario that
 * delegates in a circle would otherwise be discovered on the invoice. When it
 * trips, the run is stopped and says so rather than quietly finishing.
 */
const MAX_TASKS = 24;

/**
 * The ceiling in money, which is the one that was missing.
 *
 * `MAX_TASKS` counts conversations, and a conversation is not a fixed price: a
 * run that stayed well inside twenty-four tasks can still spend more than the
 * person watching it meant to, because each task is a dozen turns and each
 * turn re-sends the ones before it. Counting tasks caps the shape of a run and
 * says nothing about its cost.
 *
 * Checked on every drain, so a run stops within one task of crossing it rather
 * than at the end. Deliberately low: a rehearsal is a look at the workforce,
 * not a day's work, and the first thing anybody wants to know afterwards is
 * what it cost — a number that should never be a surprise.
 *
 * Overridable per run through `rehearsal.budgetUsd`, for the deliberate long
 * look.
 */
const DEFAULT_BUDGET_USD = 3;

export interface StartInput {
  website: string;
  scenario: string;
  businessName?: string | null;
  note?: string | null;
  /** What this run may spend before it stops itself. Undefined takes the default; 0 lifts the ceiling. */
  budgetUsd?: number | null;
  userId?: string | null;
  /** Reuse an existing lead ID (and its research) rather than creating a fresh lead. */
  leadId?: string;
}

export class RehearsalRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RehearsalRefused";
  }
}

/** `www.example.com/pricing` → `example.com`. The name until research finds a better one. */
function hostOf(url: string): string {
  return new URL(url).hostname.replace(/^www\./i, "");
}

/**
 * Starts one.
 *
 * The lead is created before the task because the task refers to it, and both
 * are created before anything runs because a run that began before its record
 * existed would be a run nobody could find. The model call itself is
 * deliberately not awaited: it takes minutes, and the page that asked for it
 * should come back now and watch.
 */
export async function startRehearsal(input: StartInput) {
  const scenario = findScenario(input.scenario);
  if (!scenario) throw new RehearsalRefused(`There is no rehearsal called “${input.scenario}”.`);

  const website = normaliseSiteUrl(input.website);
  if (!website) {
    throw new RehearsalRefused(
      "That is not a web address this can open. Give something like dakyworld.com or https://dakyworld.com — a rehearsal needs a real site to look at.",
    );
  }
  const host = hostOf(website);

  const agent = await prisma.agent.findUnique({ where: { key: scenario.startAgent } });
  if (!agent) {
    throw new RehearsalRefused(
      `“${scenario.name}” starts with ${scenario.startAgent}, and there is no agent with that key. The roster has changed since this workflow was written.`,
    );
  }
  // A draft is woken below, once there is a rehearsal row to record it against.
  // Paused and retired are refused, and refused here rather than left to be
  // discovered: a rehearsal that sits still because the agent it starts with
  // was switched off looks exactly like a rehearsal that is broken.
  if (agent.status === "PAUSED" || agent.status === "RETIRED") {
    throw new RehearsalRefused(
      `“${scenario.name}” starts with ${agent.name}, who is ${agent.status.toLowerCase()}. A rehearsal wakes agents that were never switched on; it does not undo a decision you made. Set them to Active on the Agents screen, or choose another workflow.`,
    );
  }

  let lead: Lead | null = null;
  // Set once a reused lead already has research on file, so the tool wrapper
  // below can report that instead of scraping the same site a second time.
  let skipLook = false;

  if (input.leadId) {
    lead = await prisma.lead.findUnique({ where: { id: input.leadId } });
    if (!lead) {
      throw new RehearsalRefused(`There is no lead with id "${input.leadId}".`);
    }
    if (lead.rehearsal) {
      throw new RehearsalRefused(`Lead ${input.leadId} is already marked as a rehearsal lead.`);
    }
    const existingResearch = await prisma.leadResearch.findUnique({ where: { leadId: lead.id } });
    skipLook = existingResearch !== null;
  }

  const businessName = input.businessName?.trim() || lead?.companyName || host;

  if (!lead) {
    // No name and no address on purpose. `contactName` is required, so it
    // carries the site; `contactEmail` and `contactPhone` stay null, which
    // means that even if every other guard in this file were removed there
    // is no address for anything to send to and no number to text.
    lead = await prisma.lead.create({
      data: {
        contactName: businessName,
        companyName: businessName,
        website,
        source: "OTHER",
        captureMethod: "MANUAL",
        status: "NEW",
        rehearsal: true,
        // Nothing dedupes against a rehearsal: two runs on the same site are two
        // separate rehearsals, and a real capture of that business later must
        // not collide with either.
        dedupeKey: null,
        discoveryNotes: `Created for a rehearsal of “${scenario.name}” against ${website}. Not a real prospect — see the Rehearsal screen.`,
      },
    });
  }

  const brief = [scenario.brief({ site: website, name: businessName }), input.note?.trim() ? `\n\nFrom the Owner: ${input.note.trim()}` : ""]
    .join("")
    .trim();

  const task = await prisma.agentTask.create({
    data: {
      agentKey: agent.key,
      title: `${scenario.name} — ${host}`,
      brief,
      origin: "OWNER",
      createdById: input.userId ?? null,
      priority: 2,
      leadId: lead.id,
      rehearsal: true,
      skipLook,
    },
  });
  await recordCreated(task.id, task.traceId, task.status, {
    reason: `A rehearsal of “${scenario.name}” against ${host}. Nothing in it can leave the building.`,
    actor: "owner",
    actorId: input.userId ?? null,
  });

  const rehearsal = await prisma.rehearsal.create({
    data: {
      website,
      host,
      businessName,
      scenario: scenario.key,
      note: input.note?.trim() || null,
      leadId: lead.id,
      rootTaskId: task.id,
      taskCount: 1,
      // Written on the row rather than read from a setting at each drain, so
      // the ceiling a run was started under is the ceiling it keeps — and is
      // still readable afterwards when somebody asks why it stopped where it did.
      budgetUsd: input.budgetUsd === undefined || input.budgetUsd === null ? DEFAULT_BUDGET_USD : input.budgetUsd,
      createdById: input.userId ?? null,
    },
  });

  // Wake everyone this run can hand work down to, before anything starts.
  //
  // The starting agent plus its whole reporting tree, because `delegate` only
  // goes down the chart and that is the set a run reaches without guessing.
  // Sideways hand-offs can reach anybody at all and are woken where they
  // happen — see `wakeOne`. Every one of these is put back when the run ends.
  const woken = await wakeFor(rehearsal.id, await reportsUnder(agent.key));
  if (Object.keys(woken.woke).length > 0) {
    console.log(`[rehearsal] woke ${Object.keys(woken.woke).length} draft agent(s) for ${rehearsal.id}: ${Object.keys(woken.woke).join(", ")}`);
  }

  // Not awaited: the run is minutes long and belongs to the server.
  void runTask(task.id).catch((err) => console.error(`[rehearsal] ${rehearsal.id} root task died:`, (err as Error).message));

  return { rehearsal, woke: woken };
}

/**
 * Every task in a rehearsal, root first.
 *
 * Walked by `parentId` rather than looked up by a column on the task, because
 * `delegate` and `handOff` already set the parent and a second piece of
 * bookkeeping is a second thing to drift. Bounded by `MAX_TASKS`, so a
 * delegation cycle is a stopped run rather than a query that does not return.
 */
export async function tasksIn(rootTaskId: string) {
  const collected: Array<Prisma.AgentTaskGetPayload<{ include: { agent: { select: { key: true; name: true; title: true; tier: true; department: true; managerKey: true; status: true } } } }>> = [];
  let frontier = [rootTaskId];
  const seen = new Set<string>();

  while (frontier.length > 0 && collected.length < MAX_TASKS + 8) {
    const batch = await prisma.agentTask.findMany({
      where: { id: { in: frontier.filter((id) => !seen.has(id)) } },
      include: { agent: { select: { key: true, name: true, title: true, tier: true, department: true, managerKey: true, status: true } } },
      orderBy: { createdAt: "asc" },
    });
    if (batch.length === 0) break;
    for (const task of batch) {
      seen.add(task.id);
      collected.push(task);
    }
    const children = await prisma.agentTask.findMany({
      where: { parentId: { in: batch.map((task) => task.id) } },
      select: { id: true },
      orderBy: { createdAt: "asc" },
    });
    frontier = children.map((child) => child.id).filter((id) => !seen.has(id));
  }

  return collected;
}

/** The end states. A task in one of these will not move again on its own. */
const SETTLED: AgentTaskStatus[] = ["DONE", "NEEDS_APPROVAL", "BLOCKED", "FAILED", "CANCELLED"];

/**
 * One drain of a rehearsal: start what is startable, then work out where it stands.
 *
 * **Why this exists at all.** `runDueTasks` on the minute tick would eventually
 * run every one of these. But a rehearsal is watched — the whole point is
 * seeing the chain happen — and a six-agent chain at one hop a minute is six
 * minutes of a still screen, most of which reads as a hang. So the screen's own
 * poll drains its own run.
 *
 * **Why draining from a poll is safe here.** It starts nothing the scheduler
 * would not have started a minute later, it holds the per-agent lock the
 * runner enforces inside the claim, and it is capped at one task per rehearsal
 * in flight. Two polls arriving together cannot double-start: the claim is a
 * conditional update and only one wins.
 */
export async function nudge(rehearsalId: string): Promise<void> {
  const rehearsal = await prisma.rehearsal.findUnique({ where: { id: rehearsalId } });
  if (!rehearsal?.rootTaskId || rehearsal.status !== "RUNNING") return;

  const tasks = await tasksIn(rehearsal.rootTaskId);
  const running = tasks.filter((task) => task.status === "RUNNING");
  const queued = tasks.filter((task) => task.status === "QUEUED");

  // The spending ceiling. Stopped rather than left to keep queueing, and the
  // stop is recorded on the row so the page can say why it went quiet.
  if (tasks.length > MAX_TASKS) {
    await stopRehearsal(rehearsalId, `This run reached ${tasks.length} tasks, which is past the ceiling of ${MAX_TASKS}. Whatever is queued was left unstarted.`);
    return;
  }

  // The same stop, on the measure that actually runs out. Read off the tasks
  // rather than the rehearsal row because `settle` writes that row afterwards,
  // and a ceiling that only knows last drain's total is a ceiling that is
  // always one task late.
  const budget = rehearsal.budgetUsd === null ? DEFAULT_BUDGET_USD : Number(rehearsal.budgetUsd);
  const spent = tasks.reduce((sum, task) => sum + Number(task.costUsd), 0);
  if (budget > 0 && spent >= budget) {
    await stopRehearsal(
      rehearsalId,
      `This run has spent $${spent.toFixed(2)}, which is at or past its ceiling of $${budget.toFixed(2)}. Whatever was queued was left unstarted. Raise the ceiling on the next run if you want to see further.`,
    );
    return;
  }

  if (running.length < REHEARSAL_CONCURRENCY) {
    for (const task of queued) {
      if (task.agent.status === "RETIRED" || task.agent.status === "PAUSED") continue;
      // The runner enforces one-task-per-agent inside its claim; checking here
      // as well saves a claim that would only ever be refused.
      if (isBusy(task.agentKey)) continue;
      if (task.scheduledFor && task.scheduledFor.getTime() > Date.now()) continue;
      void runTask(task.id).catch((err) => console.error(`[rehearsal] ${rehearsalId} task ${task.id} died:`, (err as Error).message));
      break;
    }
  }

  await settle(rehearsalId, tasks);
}

/**
 * Totals the run and, when nothing can move again, closes it.
 *
 * The totals are written to the row rather than computed on read because
 * teardown deletes the tasks: "what did that cost me" is the one fact about a
 * rehearsal that should outlive it.
 */
export async function settle(rehearsalId: string, known?: Awaited<ReturnType<typeof tasksIn>>) {
  const rehearsal = await prisma.rehearsal.findUnique({ where: { id: rehearsalId } });
  if (!rehearsal?.rootTaskId) return;

  const tasks = known ?? (await tasksIn(rehearsal.rootTaskId));
  const moving = tasks.some((task) => !SETTLED.includes(task.status));

  const totals = tasks.reduce(
    (sum, task) => ({
      costUsd: sum.costUsd + Number(task.costUsd),
      toolCalls: sum.toolCalls + task.toolCalls,
      preparedCalls: sum.preparedCalls + task.dryRunCalls,
    }),
    { costUsd: 0, toolCalls: 0, preparedCalls: 0 },
  );

  // A business name is worth carrying back: research usually finds the real
  // one, and "Kwame's Auto Parts" beats "kwameauto.com" on the list.
  const named = rehearsal.leadId
    ? await prisma.lead.findUnique({ where: { id: rehearsal.leadId }, select: { companyName: true } })
    : null;

  await prisma.rehearsal.update({
    where: { id: rehearsalId },
    data: {
      taskCount: tasks.length,
      costUsd: totals.costUsd,
      toolCalls: totals.toolCalls,
      preparedCalls: totals.preparedCalls,
      businessName: named?.companyName ?? rehearsal.businessName,
      ...(rehearsal.status === "RUNNING" && !moving ? { status: "SETTLED" as const, finishedAt: new Date() } : {}),
    },
  });

  // Nothing left to run, so the floor goes back the way it was found. After the
  // status write rather than before: `restoreWakes` skips agents that another
  // running rehearsal still needs, and this one must no longer count as one.
  if (rehearsal.status === "RUNNING" && !moving) {
    const put = await restoreWakes(rehearsalId);
    if (put.length > 0) console.log(`[rehearsal] put ${put.length} agent(s) back after ${rehearsalId}: ${put.join(", ")}`);
  }
}

/**
 * Stops a rehearsal part-way.
 *
 * Every task in it is asked to stop the way a person asks one to stop — a
 * RUNNING task honours it at its next safe point and keeps its place, and a
 * QUEUED one is cancelled outright. What already ran stays readable, which is
 * usually why somebody stopped it.
 */
export async function stopRehearsal(rehearsalId: string, why = "Stopped by the Owner."): Promise<number> {
  const rehearsal = await prisma.rehearsal.findUnique({ where: { id: rehearsalId } });
  if (!rehearsal?.rootTaskId) return 0;

  const tasks = await tasksIn(rehearsal.rootTaskId);
  let asked = 0;

  for (const task of tasks) {
    if (task.status === "RUNNING") {
      await prisma.agentTask.update({ where: { id: task.id }, data: { interruptRequested: true } });
      asked += 1;
    } else if (task.status === "QUEUED") {
      // Conditional on the status it was read with: a task that started
      // between the read and here is now RUNNING, and writing CANCELLED over a
      // live run would strand it.
      const cancelled = await prisma.agentTask.updateMany({
        where: { id: task.id, status: "QUEUED" },
        data: { status: "CANCELLED", finishedAt: new Date(), error: why },
      });
      asked += cancelled.count;
    }
  }

  await prisma.rehearsal.update({
    where: { id: rehearsalId },
    data: { status: "STOPPED", finishedAt: new Date(), note: rehearsal.note ? `${rehearsal.note}\n\n${why}` : why },
  });
  // Stopping is the commonest way a run ends early. An agent left awake by one
  // that was abandoned is the floor quietly changed by a test.
  await restoreWakes(rehearsalId);
  return asked;
}

/**
 * Throws one away.
 *
 * Deletes the tasks first, then the lead, then the rehearsal. The order
 * matters: `AgentTaskStep`, `AgentTaskCheckpoint` and the delegation children
 * cascade from the task, and `LeadResearch`, `Demo` and `WebsiteAudit` cascade
 * or null from the lead — so removing the lead while a task still points at it
 * would fail on the foreign key rather than tidy anything.
 *
 * `ToolCall` and `LlmCall` are deliberately **not** deleted. They are the
 * money ledger and they carry no client content: what a rehearsal spent stays
 * on the record next to what everything else spent, which is the only way the
 * monthly total means anything.
 */
export async function teardownRehearsal(rehearsalId: string): Promise<{ tasks: number; leadRemoved: boolean }> {
  const rehearsal = await prisma.rehearsal.findUnique({ where: { id: rehearsalId } });
  if (!rehearsal) return { tasks: 0, leadRemoved: false };

  if (rehearsal.status === "RUNNING") {
    throw new RehearsalRefused("This one is still running. Stop it first — deleting a rehearsal mid-run would leave a task writing to a record that no longer exists.");
  }

  // Normally already done by settle or by stop. Repeated here because deleting
  // the row takes the record of what was woken with it, and after that nothing
  // anywhere knows those agents were switched on by a test.
  await restoreWakes(rehearsalId);

  const tasks = rehearsal.rootTaskId ? await tasksIn(rehearsal.rootTaskId) : [];
  // Deepest first, so a parent is never removed while a child still references it.
  for (const task of [...tasks].reverse()) {
    await prisma.agentTask.deleteMany({ where: { id: task.id } });
  }

  let leadRemoved = false;
  if (rehearsal.leadId) {
    // Guarded on the flag as well as the id. A rehearsal that was somehow
    // pointed at a real lead must not be able to delete one.
    const removed = await prisma.lead.deleteMany({ where: { id: rehearsal.leadId, rehearsal: true } });
    leadRemoved = removed.count > 0;
  }

  await prisma.rehearsal.delete({ where: { id: rehearsalId } });
  return { tasks: tasks.length, leadRemoved };
}
