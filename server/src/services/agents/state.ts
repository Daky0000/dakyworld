import type { AgentTaskStatus, EscalationStatus, Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";

/**
 * The only thing that may change a task's status.
 *
 * Before this, status was written by direct update in ten places — the claim,
 * the reaper, the interrupt, the boot resume, the rate-limit requeue, the
 * cancel route, the approve route, the hiring nudge and `finishTask` twice.
 * Each was correct on its own. Together they were a state machine nobody had
 * written down: no declaration of which moves were legal, and no record of the
 * ones that happened. A task that had been QUEUED three times looked exactly
 * like one queued once, and "who cancelled this" had no answer.
 *
 * Two things change here and nothing else does:
 *
 * 1. **A move the table does not declare is refused**, before it touches the row.
 * 2. **Every move that happens is written to `AgentTaskTransition`.**
 *
 * The conditional-update discipline the runner already relied on is kept
 * exactly: `expect` narrows the `where` so two processes cannot both win a
 * claim, and `guard` carries the `runOwner` match that stops a process reaped
 * as dead from writing over the run that took over. That is why this returns
 * whether it moved rather than throwing — losing a race is a normal outcome
 * here, not an error.
 */

/**
 * Which moves are legal, and why the surprising ones are.
 *
 * - Every terminal state can go back to QUEUED. That is "Carry on" on a blocked
 *   task, the reaper handing back a stranded run, and a rate-limited task
 *   waiting five minutes. A finished task is not a closed one in a system where
 *   the answer to an escalation arrives an hour later.
 * - No terminal state may reach another directly. Rewriting an outcome in place
 *   is how a run that never happened comes to read as work that did; going back
 *   through QUEUED means the history shows the re-run.
 * - NEEDS_APPROVAL to DONE is the one exception, because a person accepting
 *   prepared work is a decision about the same run rather than a new one.
 * - RUNNING to RUNNING is absent deliberately: a second claim on a running task
 *   is the bug the per-agent concurrency rule exists to prevent, and it should
 *   fail here rather than quietly bump a heartbeat.
 */
const ALLOWED: Record<AgentTaskStatus, readonly AgentTaskStatus[]> = {
  QUEUED: ["RUNNING", "CANCELLED", "FAILED", "BLOCKED"],
  RUNNING: ["DONE", "NEEDS_APPROVAL", "BLOCKED", "FAILED", "QUEUED", "CANCELLED"],
  NEEDS_APPROVAL: ["DONE", "QUEUED", "CANCELLED", "FAILED"],
  BLOCKED: ["QUEUED", "RUNNING", "CANCELLED", "FAILED"],
  DONE: ["QUEUED"],
  FAILED: ["QUEUED", "RUNNING", "CANCELLED"],
  CANCELLED: ["QUEUED", "RUNNING"],
};

/**
 * What a move means for the question the task raised, if it raised one.
 *
 * Derived here rather than written by the callers, for exactly the reason
 * `transition()` exists at all: escalations are raised by `escalate`, by
 * `needSkill`, and by a task hitting its own spending ceiling, and they are
 * settled by the browser, by two Slack paths and by a retry. Six writers of one
 * flag is the state machine nobody wrote down, one layer up.
 *
 * Returns null when nothing about the escalation changed, so an ordinary
 * QUEUED → RUNNING never touches the column.
 */
function escalationAfter(from: AgentTaskStatus, to: AgentTaskStatus): EscalationStatus | null {
  // Every road into BLOCKED is a task that has stopped and needs a person. The
  // three differ in what they need decided and not in whether somebody has to
  // decide it, which is all this flag claims.
  if (to === "BLOCKED") return "PENDING";
  // And every road out is somebody having acted. Answering requeues, "Carry
  // on" requeues, cancelling closes the task — in all of them the question is
  // no longer sitting on the wall.
  if (from === "BLOCKED") return "ANSWERED";
  return null;
}

export class IllegalTransition extends Error {
  constructor(
    readonly from: AgentTaskStatus,
    readonly to: AgentTaskStatus,
  ) {
    super(`A task cannot go from ${from} to ${to}.`);
    this.name = "IllegalTransition";
  }
}

export function canTransition(from: AgentTaskStatus, to: AgentTaskStatus): boolean {
  return ALLOWED[from]?.includes(to) ?? false;
}

/** Every legal next state, for a screen that offers them. */
export function nextStates(from: AgentTaskStatus): readonly AgentTaskStatus[] {
  return ALLOWED[from] ?? [];
}

export interface TransitionRequest {
  to: AgentTaskStatus;
  /** A sentence a person can read. It goes on the history, so write it for them. */
  reason: string;
  /** What made the move: `runner`, `reaper`, `boot`, `owner`, `approval`, ... */
  actor: string;
  actorId?: string | null;
  /**
   * Only move from one of these. The claim passes the statuses a task may be
   * claimed out of; leaving it unset accepts whatever the row currently says,
   * which is right for a run finishing work it already owns.
   */
  expect?: readonly AgentTaskStatus[];
  /** Extra `where` — the runner's `runOwner` match, the per-agent concurrency filter. */
  guard?: Prisma.AgentTaskWhereInput;
  /** Written in the same statement as the status. */
  data?: Prisma.AgentTaskUpdateManyMutationInput;
}

export interface TransitionResult {
  moved: boolean;
  from: AgentTaskStatus | null;
  /** Where the row actually is, when the move was refused because it had moved on. */
  lostTo?: AgentTaskStatus;
}

/**
 * Moves a task, if the move is legal and the row is still where we left it.
 *
 * Returns `moved: false` rather than throwing when another process got there
 * first — that is a race being handled, and every caller has something sensible
 * to do about it. It *does* throw `IllegalTransition`, because a move the table
 * does not declare is a programming mistake and should not be absorbed into a
 * boolean nobody checks.
 */
export async function transition(taskId: string, request: TransitionRequest): Promise<TransitionResult> {
  const current = await prisma.agentTask.findUnique({
    where: { id: taskId },
    select: { status: true, traceId: true },
  });
  if (!current) return { moved: false, from: null };

  if (request.expect && !request.expect.includes(current.status)) {
    return { moved: false, from: current.status, lostTo: current.status };
  }
  if (!canTransition(current.status, request.to)) {
    throw new IllegalTransition(current.status, request.to);
  }

  // Conditional on the status just read, so the row cannot move underneath us
  // between the read and the write. The same discipline the claim has always
  // used; it is here now so every caller inherits it.
  // Written in the same statement as the status, so a task cannot be BLOCKED
  // with nothing recording that it asked anything — the pair either both land
  // or neither does. A caller that sets `escalationStatus` explicitly wins:
  // the close endpoint is deliberately saying something this cannot derive.
  const escalation = escalationAfter(current.status, request.to);
  const claimed = await prisma.agentTask.updateMany({
    where: {
      id: taskId,
      status: request.expect ? { in: [...request.expect] } : current.status,
      ...(request.guard ?? {}),
    },
    data: {
      ...(escalation ? { escalationStatus: escalation } : {}),
      ...(request.data ?? {}),
      status: request.to,
    },
  });

  if (claimed.count === 0) {
    const now = await prisma.agentTask.findUnique({ where: { id: taskId }, select: { status: true } });
    return { moved: false, from: current.status, lostTo: now?.status ?? current.status };
  }

  await write({
    taskId,
    traceId: current.traceId,
    from: current.status,
    to: request.to,
    reason: request.reason,
    actor: request.actor,
    actorId: request.actorId ?? null,
  });
  return { moved: true, from: current.status };
}

/**
 * The first entry, written when a task is created.
 *
 * `from` is null rather than QUEUED: a task appearing in the queue has no prior
 * state, and recording one would be an invention.
 */
export async function recordCreated(
  taskId: string,
  traceId: string,
  to: AgentTaskStatus,
  detail: { reason: string; actor: string; actorId?: string | null },
): Promise<void> {
  await write({ taskId, traceId, from: null, to, ...detail });
}

/** What a task has been through, oldest first. */
export async function historyOf(taskId: string) {
  return prisma.agentTaskTransition.findMany({ where: { taskId }, orderBy: { at: "asc" } });
}

async function write(entry: {
  taskId: string;
  traceId: string | null;
  from: AgentTaskStatus | null;
  to: AgentTaskStatus;
  reason: string;
  actor: string;
  actorId?: string | null;
}): Promise<void> {
  try {
    await prisma.agentTaskTransition.create({
      data: {
        taskId: entry.taskId,
        traceId: entry.traceId,
        from: entry.from,
        to: entry.to,
        reason: entry.reason.slice(0, 500),
        actor: entry.actor,
        actorId: entry.actorId ?? null,
      },
    });
  } catch (err) {
    // The same rule as the step log and the tool ledger: a task must not fail
    // because its own history did. A gap in the history is worth shouting
    // about, and is not worth undoing work over.
    console.error(`[agent] could not record a transition for ${entry.taskId}:`, (err as Error).message);
  }
}
