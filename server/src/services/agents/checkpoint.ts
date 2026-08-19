import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import type { AgentCheckpointState } from "../../lib/claudeAgent.js";

/**
 * Where a run got to, kept so the next one continues instead of starting again.
 *
 * The runner owns *when* a checkpoint is written; this owns what a checkpoint
 * is and what may be done to one. Three rules live here and nowhere else:
 *
 * 1. **A write proves ownership.** Every save is a conditional update matched
 *    on `runOwner`. A process that was reaped as dead and then comes back —
 *    the container that was slow rather than gone, the one whose network
 *    stalled for six minutes — finds its token replaced and is told so, rather
 *    than writing its stale conversation over the top of the run that took
 *    over. That is the only race here that could corrupt work rather than
 *    merely waste it.
 * 2. **A checkpoint has a ceiling.** A conversation of sixteen turns with tool
 *    results in it is large, and the cure has to be trimming rather than
 *    dropping: deleting a message would separate a `tool_use` from its
 *    `tool_result` and the next request would be rejected outright. So the
 *    oldest tool *results* lose their content and keep their place.
 * 3. **A checkpoint dies with the run it belongs to.** Everything that is not
 *    going to be continued clears it.
 */

/**
 * Roughly 3MB of JSON. Postgres will hold far more; the reason for a limit is
 * that a checkpoint is written after every tool call, so its size is paid over
 * and over rather than once.
 */
const MAX_JSON = 3_000_000;
/** What a trimmed result says instead of what it said. */
const TRIMMED = "[This result was trimmed to keep the run's checkpoint small. It was read at the time and acted on.]";

export interface StoredCheckpoint {
  state: AgentCheckpointState;
  /** The runner's own tallies — see `Counters` in runner.ts. */
  counters: Record<string, unknown>;
}

/**
 * Shrinks a conversation that has grown past the ceiling, oldest first.
 *
 * Only `tool_result` content is touched, and only its text: the block, its
 * `tool_use_id` and its position all survive, so the conversation stays valid.
 * Recent turns are trimmed last because they are the ones the model is
 * actually still reasoning from.
 */
function trimToFit(messages: AgentCheckpointState["messages"]): AgentCheckpointState["messages"] {
  const copy = JSON.parse(JSON.stringify(messages)) as AgentCheckpointState["messages"];
  if (JSON.stringify(copy).length <= MAX_JSON) return copy;

  for (const message of copy) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content as { type?: string; content?: unknown }[]) {
      if (block?.type !== "tool_result") continue;
      if (typeof block.content === "string" && block.content === TRIMMED) continue;
      block.content = TRIMMED;
      if (JSON.stringify(copy).length <= MAX_JSON) return copy;
    }
  }
  return copy;
}

/** What a previous run of this task left behind, or null to start from the brief. */
export async function loadCheckpoint(taskId: string): Promise<StoredCheckpoint | null> {
  const row = await prisma.agentTaskCheckpoint.findUnique({ where: { taskId } });
  if (!row) return null;

  const messages = (row.messages ?? []) as unknown as AgentCheckpointState["messages"];
  if (!Array.isArray(messages) || messages.length === 0) return null;

  return {
    state: {
      iteration: row.iteration,
      messages,
      narration: (row.narration ?? []) as unknown as string[],
      pendingAssistant: (row.pendingAssistant ?? null) as unknown as AgentCheckpointState["pendingAssistant"],
      pendingResults: (row.pendingResults ?? null) as unknown as AgentCheckpointState["pendingResults"],
      pendingStop: Boolean((row.counters as Record<string, unknown> | null)?.pendingStop),
      toolCalls: 0,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      costUsd: Number(row.costUsd),
      model: row.model,
    },
    counters: (row.counters ?? {}) as Record<string, unknown>,
  };
}

/**
 * Writes the state and touches the heartbeat, in one statement.
 *
 * Returns false when this run no longer owns the task — the caller's cue to
 * stop rather than to retry. The heartbeat rides along here rather than on its
 * own timer because the two answer the same question: a run that cannot write
 * a checkpoint is a run nothing should be waiting for.
 */
export async function saveCheckpoint(
  taskId: string,
  runOwner: string,
  state: AgentCheckpointState,
  counters: Record<string, unknown>,
): Promise<boolean> {
  const still = await prisma.agentTask.updateMany({
    where: { id: taskId, runOwner },
    data: { heartbeatAt: new Date() },
  });
  if (still.count === 0) return false;

  const messages = trimToFit(state.messages);
  const data = {
    iteration: state.iteration,
    messages: messages as unknown as Prisma.InputJsonValue,
    narration: state.narration as unknown as Prisma.InputJsonValue,
    pendingAssistant: (state.pendingAssistant ?? Prisma.JsonNull) as unknown as Prisma.InputJsonValue,
    pendingResults: (state.pendingResults ?? Prisma.JsonNull) as unknown as Prisma.InputJsonValue,
    counters: { ...counters, pendingStop: state.pendingStop } as unknown as Prisma.InputJsonValue,
    costUsd: state.costUsd.toFixed(6),
    inputTokens: state.inputTokens,
    outputTokens: state.outputTokens,
    model: state.model,
  };

  await prisma.agentTaskCheckpoint.upsert({ where: { taskId }, create: { taskId, ...data }, update: data });
  return true;
}

/**
 * Drops checkpoints nobody is going to continue.
 *
 * A BLOCKED or FAILED task keeps its conversation so that answering it or
 * pressing Run carries on rather than repeats — but "keeps it" cannot mean
 * "for ever". After a month the brief has usually moved on, the records it was
 * reasoning about have changed, and continuing a stale conversation is worse
 * than starting a fresh one. Swept on the housekeeping tick.
 */
export async function pruneCheckpoints(olderThanDays = 30): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60_000);
  const dropped = await prisma.agentTaskCheckpoint.deleteMany({
    where: { updatedAt: { lt: cutoff }, task: { status: { notIn: ["QUEUED", "RUNNING"] } } },
  });
  return dropped.count;
}

/** Nothing will rejoin this conversation. */
export async function clearCheckpoint(taskId: string): Promise<void> {
  await prisma.agentTaskCheckpoint.deleteMany({ where: { taskId } });
}

/**
 * Adds the Owner's answer to a conversation that stopped and asked.
 *
 * Without this, answering an escalation would be answered into the brief while
 * the agent resumed the conversation it had already had — and it would carry
 * on from the question it asked, never having been told the answer.
 *
 * Appended to the final user turn rather than pushed as a new one, because two
 * user messages in a row is not a shape the API accepts. Tool results have to
 * come first inside that turn, so the answer goes on the end, which is where a
 * reply belongs anyway.
 */
export async function appendOwnerAnswer(taskId: string, answer: string): Promise<boolean> {
  const row = await prisma.agentTaskCheckpoint.findUnique({ where: { taskId }, select: { messages: true } });
  if (!row) return false;

  const messages = (row.messages ?? []) as unknown as AgentCheckpointState["messages"];
  if (!Array.isArray(messages) || messages.length === 0) return false;

  const text = `The Owner has answered what you asked:\n\n${answer.trim()}\n\nCarry on from here.`;
  const last = messages[messages.length - 1];

  if (last.role === "user" && Array.isArray(last.content)) {
    (last.content as unknown[]).push({ type: "text", text });
  } else if (last.role === "user" && typeof last.content === "string") {
    last.content = `${last.content}\n\n${text}`;
  } else {
    messages.push({ role: "user", content: text });
  }

  await prisma.agentTaskCheckpoint.update({
    where: { taskId },
    data: { messages: messages as unknown as Prisma.InputJsonValue },
  });
  return true;
}
