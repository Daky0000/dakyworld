import type { AgentStepKind, AgentTaskStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { listAllTools } from "../tools/catalogue.js";
import { scenarioName } from "./scenarios.js";
import { tasksIn } from "./run.js";

/**
 * One rehearsal, assembled into the two things a person actually wants to see.
 *
 * **The merged timeline.** Every step from every task in the run, in the order
 * they happened, each labelled with the agent that wrote it. This is the whole
 * reason the screen exists: a task drawer shows one agent's timeline, and a
 * chain of six agents read six at a time is six tabs and no sense of order.
 * Interleaved, you can see the Sales Director hand the site to somebody, watch
 * that somebody read the audit, and see which finding came back — which is the
 * *flow*, and it is invisible anywhere else in this app.
 *
 * **The chart.** Who worked, who they handed to, who they asked. Built from
 * the steps rather than from a separate record, because the steps are what
 * actually happened: an edge on this chart exists because an agent wrote
 * DELEGATED, HANDED_OFF or CONSULTED in its own timeline.
 *
 * Everything here is read-only and derived. Nothing in this file changes
 * anything, which is what makes it safe to call on a two-second poll.
 */

/** What the run is doing right now, in one word. Derived, never stored. */
function movement(statuses: AgentTaskStatus[]): string {
  if (statuses.includes("RUNNING")) return "working";
  if (statuses.includes("QUEUED")) return "about to pick something up";
  if (statuses.includes("BLOCKED")) return "stopped and asking";
  if (statuses.includes("NEEDS_APPROVAL")) return "finished — work prepared and waiting";
  if (statuses.includes("FAILED")) return "finished, with a failure in it";
  return "finished";
}

/** The three step kinds that are one agent reaching another. */
const EDGE_KINDS: AgentStepKind[] = ["DELEGATED", "HANDED_OFF", "CONSULTED"];

export interface RehearsalView {
  id: string;
  website: string;
  host: string;
  businessName: string | null;
  scenario: string;
  scenarioName: string;
  note: string | null;
  status: string;
  movement: string;
  startedAt: Date;
  finishedAt: Date | null;
  lead: { id: string; companyName: string | null; website: string | null; leadScore: number; status: string; tags: string[] } | null;
  /**
   * Agents this run switched on and will put back when it ends.
   *
   * Shown rather than done quietly. Waking a draft is the one thing a
   * rehearsal changes outside its own tree, and a person who cannot see it
   * happen has no way to tell a rehearsal that tidied up after itself from one
   * that did not.
   */
  woke: string[];
  /** What it may spend before it stops itself. Null is the shipped default; 0 is no ceiling. */
  budgetUsd: number | null;
  spend: {
    costUsd: number;
    toolCalls: number;
    preparedCalls: number;
    refusedCalls: number;
    modelCalls: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
  agents: Array<{
    key: string;
    name: string;
    title: string;
    /** Every task this agent holds in this run. Usually one. */
    tasks: Array<{ id: string; title: string; status: AgentTaskStatus; summary: string | null; blockedReason: string | null; error: string | null }>;
    status: AgentTaskStatus;
    costUsd: number;
    toolCalls: number;
    preparedCalls: number;
    steps: number;
  }>;
  edges: Array<{ from: string; to: string; kind: AgentStepKind; label: string; at: Date }>;
  timeline: Array<{
    id: string;
    at: Date;
    agentKey: string;
    agentName: string;
    taskId: string;
    taskTitle: string;
    kind: AgentStepKind;
    message: string;
    tool: string | null;
    ok: boolean | null;
    dryRun: boolean | null;
    data: unknown;
  }>;
  /**
   * What was prepared and never carried out.
   *
   * Not all one thing, which is what the screen used to assume. `outward` is
   * the difference: true is a call the rehearsal held because it would have
   * reached a stranger, which is the guarantee working; false is a call the
   * agent was not permitted to make in the first place — its autonomy level, a
   * spending ceiling, its own dry-run flag — which is a fact about that agent's
   * card and not about the run at all. Read off the catalogue rather than
   * inferred from the sentence in `heldBecause`, so re-wording that sentence
   * cannot silently reclassify half the list.
   */
  prepared: Array<{ id: string; agentKey: string; tool: string; outward: boolean; wouldDo: string; heldBecause: string | null; status: string; why: string; gain: string; risk: string; input: unknown; createdAt: Date; costUsd: number }>;
  /** What the run actually produced and left behind, so "did it work" has an answer. */
  produced: {
    audits: Array<{ id: string; ranAt: Date; overallScore: number; verdict: string; pdfFileId: string | null; markdownFileId: string | null }>;
    demos: Array<{ id: string; slug: string; title: string; status: string; version: number }>;
    proposals: Array<{ id: string; title: string; status: string; price: string; currency: string }>;
    emails: Array<{ id: string; subject: string; status: string; purpose: string; toEmail: string }>;
    research: { ranAt: Date; costUsd: string } | null;
    notes: number;
    memories: number;
  };
}

export async function readRehearsal(id: string): Promise<RehearsalView | null> {
  const rehearsal = await prisma.rehearsal.findUnique({
    where: { id },
    include: { lead: { select: { id: true, companyName: true, website: true, leadScore: true, status: true, tags: true } } },
  });
  if (!rehearsal) return null;

  const tasks = rehearsal.rootTaskId ? await tasksIn(rehearsal.rootTaskId) : [];
  const taskIds = tasks.map((task) => task.id);
  const byTask = new Map(tasks.map((task) => [task.id, task]));

  // One query for every step in the run rather than one per task. The ordering
  // is by time and then by the task's own sequence: two steps written in the
  // same millisecond by two agents have no true order, and falling back to
  // `seq` at least keeps each agent's own account of itself in order.
  const steps = taskIds.length
    ? await prisma.agentTaskStep.findMany({
        where: { taskId: { in: taskIds } },
        orderBy: [{ createdAt: "asc" }, { seq: "asc" }],
      })
    : [];

  const traceIds = tasks.map((task) => task.traceId);
  const [models, toolCalls, prepared] = await Promise.all([
    traceIds.length
      ? prisma.llmCall.aggregate({
          where: { OR: [{ taskId: { in: taskIds } }, { traceId: { in: traceIds } }] },
          _sum: { inputTokens: true, outputTokens: true, cacheReadTokens: true, cacheCreationTokens: true },
          _count: true,
        })
      : null,
    taskIds.length ? prisma.toolCall.findMany({ where: { taskId: { in: taskIds } }, select: { dryRun: true, refusedReason: true } }) : [],
    taskIds.length
      ? prisma.actionRequest.findMany({
          where: { taskId: { in: taskIds } },
          orderBy: { createdAt: "asc" },
          // `why`, `gain` and `risk` are the case the agent made for acting.
          // They are the whole difference between a preview somebody can
          // decide on and one they can only stare at.
          select: { id: true, agentKey: true, tool: true, wouldDo: true, heldBecause: true, status: true, why: true, gain: true, risk: true, input: true, createdAt: true, costUsd: true },
        })
      : [],
  ]);

  // Which of the prepared calls would actually have reached outside. One pass
  // over the catalogue rather than a lookup each, and only when there is
  // something to classify.
  const outwardByTool = new Map<string, boolean>();
  if (prepared.length > 0) {
    for (const tool of await listAllTools()) outwardByTool.set(tool.key, tool.outward);
  }

  // --- Who did what --------------------------------------------------------
  const stepsByTask = new Map<string, number>();
  for (const step of steps) stepsByTask.set(step.taskId, (stepsByTask.get(step.taskId) ?? 0) + 1);

  const agents = new Map<string, RehearsalView["agents"][number]>();
  for (const task of tasks) {
    const existing = agents.get(task.agentKey) ?? {
      key: task.agentKey,
      name: task.agent.name,
      title: task.agent.title,
      tasks: [],
      status: task.status,
      costUsd: 0,
      toolCalls: 0,
      preparedCalls: 0,
      steps: 0,
    };
    existing.tasks.push({
      id: task.id,
      title: task.title,
      status: task.status,
      summary: task.summary,
      blockedReason: task.blockedReason,
      error: task.error,
    });
    // An agent holding two tasks in one run shows the one that is still moving:
    // "working" outranks "done", because it is the one worth watching.
    if (task.status === "RUNNING" || (existing.status !== "RUNNING" && task.status === "QUEUED")) existing.status = task.status;
    existing.costUsd += Number(task.costUsd);
    existing.toolCalls += task.toolCalls;
    existing.preparedCalls += task.dryRunCalls;
    existing.steps += stepsByTask.get(task.id) ?? 0;
    agents.set(task.agentKey, existing);
  }

  // --- Who reached whom ----------------------------------------------------
  const edges: RehearsalView["edges"] = [];
  for (const step of steps) {
    if (!EDGE_KINDS.includes(step.kind)) continue;
    const target = (step.data as { agentKey?: string } | null)?.agentKey;
    const from = byTask.get(step.taskId)?.agentKey;
    if (!target || !from) continue;
    edges.push({ from, to: target, kind: step.kind, label: step.message.slice(0, 160), at: step.createdAt });
  }

  const produced = await producedBy(rehearsal.leadId, taskIds, tasks.map((task) => task.agentKey));

  return {
    id: rehearsal.id,
    website: rehearsal.website,
    host: rehearsal.host,
    businessName: rehearsal.businessName,
    scenario: rehearsal.scenario,
    scenarioName: scenarioName(rehearsal.scenario),
    note: rehearsal.note,
    status: rehearsal.status,
    movement: rehearsal.status === "RUNNING" ? movement(tasks.map((task) => task.status)) : rehearsal.status === "STOPPED" ? "stopped" : "finished",
    startedAt: rehearsal.startedAt,
    finishedAt: rehearsal.finishedAt,
    /** What this run may spend before it stops itself. 0 is no ceiling. */
    budgetUsd: rehearsal.budgetUsd === null ? null : Number(rehearsal.budgetUsd),
    lead: rehearsal.lead,
    woke: Object.keys((rehearsal.wokeAgents ?? {}) as Record<string, string>),
    spend: {
      costUsd: tasks.reduce((total, task) => total + Number(task.costUsd), 0),
      toolCalls: tasks.reduce((total, task) => total + task.toolCalls, 0),
      preparedCalls: tasks.reduce((total, task) => total + task.dryRunCalls, 0),
      refusedCalls: toolCalls.filter((call) => !call.dryRun && call.refusedReason).length,
      modelCalls: models?._count ?? 0,
      inputTokens: models?._sum.inputTokens ?? 0,
      outputTokens: models?._sum.outputTokens ?? 0,
      // What the prompt cache took off the bill. A run that re-sends the same
      // instruction twelve times should be able to show that it only paid for
      // it once, and until this was on the screen nobody could tell whether
      // caching was working at all.
      cacheReadTokens: models?._sum.cacheReadTokens ?? 0,
      cacheWriteTokens: models?._sum.cacheCreationTokens ?? 0,
    },
    agents: [...agents.values()],
    edges,
    timeline: steps.map((step) => {
      const task = byTask.get(step.taskId);
      return {
        id: step.id,
        at: step.createdAt,
        agentKey: task?.agentKey ?? "unknown",
        agentName: task?.agent.name ?? "Somebody",
        taskId: step.taskId,
        taskTitle: task?.title ?? "",
        kind: step.kind,
        message: step.message,
        tool: step.tool,
        ok: step.ok,
        dryRun: step.dryRun,
        data: step.data,
      };
    }),
    prepared: prepared.map((request) => ({
      ...request,
      // Unknown tool reads as outward. A key the catalogue no longer has is
      // one nobody can check, and the safe way to be wrong about a prepared
      // action is to over-report what would have left the building.
      outward: outwardByTool.get(request.tool) ?? true,
      costUsd: Number(request.costUsd),
    })),
    produced,
  };
}

/**
 * What the run left behind.
 *
 * Read off the scratch lead rather than off the timeline, because a step
 * saying "the audit team ran" and a `WebsiteAudit` row are different claims and
 * only the second one is evidence. This is the section that answers the
 * question a timeline cannot: not *did it say it did the work*, but *is the
 * work here*.
 */
async function producedBy(leadId: string | null, taskIds: string[], agentKeys: string[]) {
  if (!leadId) {
    return { audits: [], demos: [], proposals: [], emails: [], research: null, notes: 0, memories: 0 };
  }

  const [audits, demos, proposals, emails, research, notes, memories] = await Promise.all([
    prisma.websiteAudit.findMany({
      where: { leadId },
      orderBy: { ranAt: "asc" },
      select: { id: true, ranAt: true, overallScore: true, verdict: true, pdfFileId: true, markdownFileId: true },
    }),
    prisma.demo.findMany({ where: { leadId }, orderBy: { createdAt: "asc" }, select: { id: true, slug: true, title: true, status: true, version: true } }),
    prisma.proposal.findMany({
      where: { leadId },
      orderBy: { createdAt: "asc" },
      select: { id: true, title: true, status: true, priceAmount: true, currency: true },
    }),
    // Drafts, necessarily: a rehearsal cannot send. Shown anyway — the letter
    // is usually the thing the whole run was for.
    prisma.emailMessage.findMany({
      where: { leadId },
      orderBy: { createdAt: "asc" },
      select: { id: true, subject: true, status: true, purpose: true, toEmail: true },
    }),
    prisma.leadResearch.findUnique({ where: { leadId }, select: { ranAt: true, costUsd: true } }),
    prisma.contextNote.count({ where: { subject: `lead:${leadId}` } }),
    // Only what this run's agents wrote about this lead. An agent's older
    // memories about other subjects are not this rehearsal's output.
    prisma.agentMemory.count({ where: { subject: `lead:${leadId}`, agentKey: { in: agentKeys } } }),
  ]);

  void taskIds;
  return {
    audits,
    demos,
    proposals: proposals.map(({ priceAmount, ...proposal }) => ({ ...proposal, price: String(priceAmount) })),
    emails,
    research: research ? { ranAt: research.ranAt, costUsd: String(research.costUsd) } : null,
    notes,
    memories,
  };
}

/** The list. Deliberately thin — the detail is one request away and is large. */
export async function listRehearsals(limit = 30) {
  const rows = await prisma.rehearsal.findMany({
    orderBy: { startedAt: "desc" },
    take: limit,
    select: {
      id: true,
      website: true,
      host: true,
      businessName: true,
      scenario: true,
      status: true,
      startedAt: true,
      finishedAt: true,
      costUsd: true,
      taskCount: true,
      toolCalls: true,
      preparedCalls: true,
    },
  });
  return rows.map((row) => ({ ...row, costUsd: Number(row.costUsd), scenarioName: scenarioName(row.scenario) }));
}
