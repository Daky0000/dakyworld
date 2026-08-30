import type { ActionRequest } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { invokeTool } from "./tools/invoke.js";
import { resolveTool } from "./tools/catalogue.js";
import { appendNote } from "./context/dossier.js";
import { taskSubjects } from "./agents/context.js";
import { step } from "./agents/runner.js";

/**
 * An agent proposing something, and a person deciding.
 *
 * The gate in `tools/invoke.ts` has always downgraded an outward or spending
 * call to a preview rather than refusing it — the right behaviour, because a
 * prepared action somebody can approve is worth more than an error. What was
 * missing was the other half. `POST /agents/tasks/:id/approve` marked the task
 * `DONE` and the previewed letter was never sent, so approving meant "I have
 * read this" and the work still had to be done again by hand.
 *
 * This is the half that was missing. An approval re-invokes the tool with the
 * input the schema validated at proposal time, so what happens is what was
 * shown — not a second model call that might produce something else.
 *
 * **Approving is not a bypass.** Execution goes back through `invokeTool`,
 * which still checks that the integration is configured and that the agent is
 * still granted the tool. `approvedRequestId` lifts the dry-run downgrade and
 * nothing else, so a request approved after the grant is revoked is refused.
 *
 * **Everything here is idempotent about an already-settled request.** Slack
 * retries anything it does not hear from inside three seconds, and a retried
 * Approve that sent a second letter would be the worst possible bug in this
 * file — the prospect gets the same email twice and the record shows one send.
 * The status transition is a conditional update for that reason, exactly as
 * the task claim in the runner is.
 */

export class ApprovalRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalRefused";
  }
}

export interface DecisionBy {
  /** A signed-in user. */
  userId?: string | null;
  /** A Slack user id, when it was decided from a card. */
  slackUserId?: string | null;
  note?: string | null;
}

// --- Reading ----------------------------------------------------------------

/**
 * What the queue shows, newest first.
 *
 * **Rehearsals are excluded everywhere in this file.** A rehearsal holds every
 * outward call at a preview and files each one, because the rehearsal screen
 * reads them back — they are the letters and proposals somebody opens
 * afterwards to judge the workforce. They are specimens, and the target of a
 * rehearsal is a real business: a live Approve button on a rehearsed email
 * would send it, which is the one thing the rehearsal guarantee promises
 * cannot happen. They are filed, marked, and kept out of here.
 */
export async function listRequests(status: ActionRequest["status"] | "ALL" = "PENDING", limit = 100) {
  const requests = await prisma.actionRequest.findMany({
    where: { rehearsal: false, ...(status === "ALL" ? {} : { status }) },
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  // The agent's name, and what the task was about — both wanted on every card
  // and neither on the row. Gathered in two queries rather than n.
  const agentKeys = [...new Set(requests.map((request) => request.agentKey))];
  const taskIds = requests.map((request) => request.taskId).filter((id): id is string => Boolean(id));

  const [agents, tasks, tools] = await Promise.all([
    prisma.agent.findMany({ where: { key: { in: agentKeys } }, select: { key: true, name: true, title: true, avatar: true } }),
    taskIds.length > 0
      ? prisma.agentTask.findMany({
          where: { id: { in: taskIds } },
          select: {
            id: true, title: true,
            lead: { select: { id: true, contactName: true, companyName: true } },
            client: { select: { id: true, name: true, company: true } },
          },
        })
      : [],
    Promise.all([...new Set(requests.map((request) => request.tool))].map(async (key) => [key, await resolveTool(key)] as const)),
  ]);

  const agentBy = new Map(agents.map((agent) => [agent.key, agent]));
  const taskBy = new Map(tasks.map((task) => [task.id, task]));
  const toolBy = new Map(tools);

  return requests.map((request) => {
    const task = request.taskId ? taskBy.get(request.taskId) : null;
    const tool = toolBy.get(request.tool);
    const about = task?.lead
      ? { kind: "lead" as const, id: task.lead.id, name: task.lead.companyName || task.lead.contactName }
      : task?.client
        ? { kind: "client" as const, id: task.client.id, name: task.client.company || task.client.name }
        : null;

    return {
      ...request,
      agent: agentBy.get(request.agentKey) ?? { key: request.agentKey, name: request.agentKey, title: "", avatar: null },
      taskTitle: task?.title ?? null,
      about,
      toolName: tool?.name ?? request.tool,
      /** Whether money is involved, which is the thing to read first on a card. */
      spends: tool?.spends ?? false,
      outward: tool?.outward ?? false,
      expired: request.status === "PENDING" && request.expiresAt < new Date(),
    };
  });
}

/**
 * What "waiting on a person" means, in one place.
 *
 * A rehearsal's prepared actions are specimens rather than proposals, and an
 * expired one is a re-ask nobody has made. Three readers of this had to agree
 * — the badge, the Slack card and now the autonomy guard — and the way they
 * agree is by not each writing it out.
 */
export function pendingWhere(agentKey?: string) {
  return { rehearsal: false, status: "PENDING" as const, expiresAt: { gt: new Date() }, ...(agentKey ? { agentKey } : {}) };
}

export async function countPending(): Promise<number> {
  return prisma.actionRequest.count({ where: pendingWhere() });
}

/**
 * The prepared actions one agent is holding, oldest first.
 *
 * Read before its autonomy is raised. An agent at level 1 with dry run on has
 * been *preparing* work all along — that is what dry run is for — and every one
 * of those is a decision somebody has not made yet. Raising the level does not
 * carry them out, but it does mean the next one like them happens without being
 * asked, and deciding that while a queue of the same thing sits unread is the
 * shape of the mistake this guards against.
 */
export async function pendingFor(agentKey: string, limit = 50) {
  const requests = await prisma.actionRequest.findMany({
    where: pendingWhere(agentKey),
    orderBy: { createdAt: "asc" },
    take: limit,
    select: { id: true, tool: true, wouldDo: true, why: true, createdAt: true, expiresAt: true },
  });
  const now = Date.now();
  return requests.map((request) => ({
    ...request,
    /** Whole hours it has been waiting. The staleness sweep reads the same number. */
    waitingHours: Math.floor((now - request.createdAt.getTime()) / 3_600_000),
  }));
}

/** Prepared actions nobody has looked at for two days, by agent. */
export async function staleByAgent(olderThanHours = 48) {
  const cutoff = new Date(Date.now() - olderThanHours * 3_600_000);
  return prisma.actionRequest.groupBy({
    by: ["agentKey"],
    where: { ...pendingWhere(), createdAt: { lt: cutoff } },
    _count: true,
  });
}

/**
 * What this would do, worked out again now rather than when it was proposed.
 *
 * A card can sit for a day. In that time the invoice gets paid, the lead goes
 * cold, the sequence it would enrol somebody into gets deleted. Re-running the
 * tool's own `preview()` at decision time is the cheapest way to notice, and
 * where it now says something different that is the single most useful thing on
 * the screen.
 */
export async function freshPreview(request: ActionRequest): Promise<{ wouldDo: string; changed: boolean } | null> {
  const tool = await resolveTool(request.tool);
  if (!tool?.preview) return null;
  try {
    const parsed = tool.input.safeParse(request.input);
    if (!parsed.success) return { wouldDo: "This can no longer be carried out — the tool no longer accepts what was prepared.", changed: true };
    const wouldDo = await tool.preview(parsed.data, { agentKey: request.agentKey, userId: null, dryRun: true });
    return { wouldDo, changed: wouldDo.trim() !== request.wouldDo.trim() };
  } catch {
    // A preview that throws is not a reason to refuse the decision — the tool's
    // own handler is still the last guard — but it is worth showing.
    return { wouldDo: "Could not work out what this would do now.", changed: true };
  }
}

// --- Deciding ---------------------------------------------------------------

/**
 * Carries out an action a person approved.
 *
 * The conditional update is the whole of the retry story: only a row still
 * `PENDING` moves to `APPROVED`, so a second click — or Slack re-delivering the
 * first one — finds nothing to claim and returns what already happened instead
 * of sending a second letter.
 */
export async function approve(id: string, by: DecisionBy) {
  const existing = await prisma.actionRequest.findUnique({ where: { id } });
  if (!existing) throw new ApprovalRefused("There is no such request.");

  // The last guard rather than the only one — these are already kept out of
  // the queue and out of Slack, so nothing should reach here with an id for
  // one. It is here because the cost of being wrong is a real email to a real
  // company that was only ever a rehearsal's target, and a filter is a weaker
  // promise than a refusal.
  if (existing.rehearsal) {
    throw new ApprovalRefused(
      "That was prepared inside a rehearsal, so it cannot be carried out. A rehearsal holds every outward call at a preview on purpose — if the work is right, give the agent the job for real.",
    );
  }

  if (existing.status !== "PENDING") {
    // Not an error. Somebody clicked twice, or Slack retried, and the honest
    // answer is what became of it.
    return { request: existing, alreadySettled: true };
  }
  if (existing.expiresAt < new Date()) {
    await prisma.actionRequest.update({ where: { id }, data: { status: "EXPIRED" } });
    throw new ApprovalRefused(
      "That was prepared more than a week ago, so it has expired rather than being carried out. Ask the agent to look again — what it proposed then may not be right now.",
    );
  }

  const claimed = await prisma.actionRequest.updateMany({
    where: { id, status: "PENDING" },
    data: {
      status: "APPROVED",
      decidedById: by.userId ?? null,
      decidedBySlackUser: by.slackUserId ?? null,
      decidedAt: new Date(),
      decisionNote: by.note ?? null,
    },
  });
  if (claimed.count === 0) {
    const current = await prisma.actionRequest.findUnique({ where: { id } });
    return { request: current!, alreadySettled: true };
  }

  const result = await invokeTool(existing.tool, existing.input, {
    agentKey: existing.agentKey,
    userId: by.userId ?? null,
    dryRun: false,
    taskId: existing.taskId,
    approvedRequestId: existing.id,
  });

  const ok = result.ok && !result.dryRun;
  const request = await prisma.actionRequest.update({
    where: { id },
    data: {
      status: ok ? "EXECUTED" : "FAILED",
      result: (result.output ?? null) as never,
      error: ok ? null : (result.error ?? result.refusedReason ?? "The tool did not carry it out."),
      costUsd: result.costUsd,
    },
  });

  await recordOnTask(existing, ok ? "carried out" : `not carried out — ${request.error}`);
  return { request, alreadySettled: false, result };
}

export async function decline(id: string, by: DecisionBy) {
  const existing = await prisma.actionRequest.findUnique({ where: { id } });
  if (!existing) throw new ApprovalRefused("There is no such request.");
  if (existing.status !== "PENDING") return { request: existing, alreadySettled: true };

  const claimed = await prisma.actionRequest.updateMany({
    where: { id, status: "PENDING" },
    data: {
      status: "DECLINED",
      decidedById: by.userId ?? null,
      decidedBySlackUser: by.slackUserId ?? null,
      decidedAt: new Date(),
      decisionNote: by.note ?? null,
    },
  });
  if (claimed.count === 0) {
    const current = await prisma.actionRequest.findUnique({ where: { id } });
    return { request: current!, alreadySettled: true };
  }

  const request = await prisma.actionRequest.findUnique({ where: { id } });
  await recordOnTask(existing, by.note ? `declined — ${by.note}` : "declined");
  return { request: request!, alreadySettled: false };
}

/**
 * Writes the decision back where the work lives.
 *
 * Two places, because they answer different questions. The task timeline is
 * "what happened during this run", and without the decision on it a task ends
 * at `NEEDS_APPROVAL` for ever with no sign of what came next. The company's
 * history is "what have we done to these people", and an email that actually
 * went out belongs there whoever pressed the button.
 *
 * Neither failing is worth failing the action over — it has already happened by
 * this point, and refusing to record it would make things worse, not better.
 */
async function recordOnTask(request: ActionRequest, outcome: string) {
  if (!request.taskId) return;
  try {
    await step(request.taskId, outcome.startsWith("declined") ? "REFUSED" : "TOOL_CALL", `${request.tool} — ${outcome}`, {
      tool: request.tool,
      ok: !outcome.startsWith("declined") && !outcome.startsWith("not carried out"),
      data: { actionRequestId: request.id },
    });

    const task = await prisma.agentTask.findUnique({
      where: { id: request.taskId },
      select: { leadId: true, clientId: true, projectId: true, proposalId: true, invoiceId: true },
    });
    const [subject] = task ? taskSubjects(task) : [];
    if (subject) {
      await appendNote({
        subject,
        kind: "DECISION",
        summary: `${request.wouldDo.slice(0, 200)} — ${outcome}`,
        body: [`Proposed by ${request.agentKey}.`, `Why: ${request.why}`, `Risk stated: ${request.risk}`].join("\n\n"),
        authorKey: "owner",
        sourceTaskId: request.taskId,
      });
    }
  } catch (err) {
    console.error(`[approvals] could not record the decision on ${request.id}:`, (err as Error).message);
  }
}

/**
 * Sweeps requests nobody answered.
 *
 * Run from the daily housekeeping tick. A card that has sat for a week is a
 * re-ask rather than a refusal, and leaving it `PENDING` for ever makes the
 * queue a list of things that are not actually going to happen.
 */
export async function expireStaleRequests(): Promise<number> {
  const { count } = await prisma.actionRequest.updateMany({
    where: { status: "PENDING", expiresAt: { lt: new Date() } },
    data: { status: "EXPIRED" },
  });
  if (count > 0) console.log(`[approvals] expired ${count} request(s) nobody answered`);
  return count;
}
