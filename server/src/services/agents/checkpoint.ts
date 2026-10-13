import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { editableFrom, withoutThinking, type AgentCheckpointState, type AgentTool } from "../../lib/claudeAgent.js";

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
 *    oldest tool *results* lose their content and keep their place — and only
 *    below the last thinking block, never above one.
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
 * The two halves of a request that are not messages: the system prompt and the
 * tool definitions, exactly as a conversation was sent them.
 *
 * Kept on the checkpoint (`counters.prefix`, written with every save, in the
 * same statement as the messages it belongs to) because Claude's newer models
 * bind each thinking block to them as well as to every earlier message. The
 * runner rebuilds both on every claim — a fresh `recall()`, a fresh
 * `workflowAvailability()` — so a memory written in the first run, or a consult
 * spent there, changed the prefix under the reasoning the second run replayed,
 * and every resume of a thinking conversation was a 400.
 */
export interface ConversationPrefix {
  system: string;
  tools: { name: string; description: string; inputSchema: Record<string, unknown> }[];
}

export function prefixOf(system: string, tools: AgentTool[]): ConversationPrefix {
  return { system, tools: tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })) };
}

/**
 * A value as the checkpoint stores it: as JSON *text*, inside the `jsonb`.
 *
 * `jsonb` does not keep an object's keys in the order they were written — it
 * re-sorts them, shortest first — and the parts of a conversation Claude's
 * reasoning is bound to are full of objects whose key order is part of what
 * was sent: every tool's `input_schema`, every `tool_use` input. Stored as
 * objects they came back reordered, so a "kept" prefix was not the one the
 * thinking was signed against, and a resumed thinking run was refused or
 * rescued only by stripping its reasoning. A JSON string is stored exactly, and
 * `JSON.parse` keeps the order it finds. No schema change: the column is still
 * `jsonb`, holding a string.
 */
export function storedJson(value: unknown): Prisma.InputJsonValue {
  return JSON.stringify(value);
}

/**
 * The value back. A checkpoint written before the text form holds the object
 * itself, with its keys as `jsonb` left them; that is still read, and is the
 * best there is for it.
 */
export function fromStoredJson<T>(raw: unknown): T | null {
  if (typeof raw !== "string") return (raw ?? null) as T | null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** A stored prefix, or null when there is none or it is not one. */
export function readPrefix(raw: unknown): ConversationPrefix | null {
  const value = fromStoredJson<{ system?: unknown; tools?: unknown }>(raw);
  if (!value || typeof value.system !== "string" || !Array.isArray(value.tools)) return null;
  const tools = value.tools as { name?: unknown; description?: unknown; inputSchema?: unknown }[];
  const valid = tools.every(
    (tool) => tool && typeof tool.name === "string" && typeof tool.description === "string" && tool.inputSchema !== null && typeof tool.inputSchema === "object",
  );
  return valid ? (value as ConversationPrefix) : null;
}

/**
 * Key order ignored. Used to ask whether two prefixes say the same thing, never
 * to decide what is sent: a prefix written before `storedJson` has been through
 * `jsonb` and lost its order, and one rebuilt by this claim may be equal to the
 * stored one in everything but that.
 */
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, inner) =>
    inner && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(Object.keys(inner as Record<string, unknown>).sort().map((key) => [key, (inner as Record<string, unknown>)[key]]))
      : inner,
  );
}

export function samePrefix(a: ConversationPrefix, b: ConversationPrefix): boolean {
  return a.system === b.system && stable(a.tools) === stable(b.tools);
}

/** The same JSON whatever order its keys are in — see `stable`. */
export function sameJson(a: unknown, b: unknown): boolean {
  return stable(a) === stable(b);
}

/** Is there reasoning in this conversation that a changed prefix would invalidate? */
export function holdsThinking(state: Pick<AgentCheckpointState, "messages" | "pendingAssistant">): boolean {
  const thinking = (block: { type?: string }) => block?.type === "thinking" || block?.type === "redacted_thinking";
  return (
    state.messages.some((message) => Array.isArray(message.content) && message.content.some(thinking)) ||
    (state.pendingAssistant ?? []).some(thinking)
  );
}

/**
 * The same state with every thinking block gone, the half-finished turn
 * included — Anthropic's one-time recovery, applied before the first request
 * rather than after a refusal. See `withoutThinking` in the agent loop.
 */
export function stripThinking<T extends Pick<AgentCheckpointState, "messages" | "pendingAssistant">>(state: T): T {
  const pending = state.pendingAssistant?.filter((block) => block.type !== "thinking" && block.type !== "redacted_thinking") ?? null;
  return { ...state, messages: withoutThinking(state.messages), pendingAssistant: pending && pending.length > 0 ? pending : null };
}

/**
 * Shrinks a conversation that has grown past the ceiling, oldest first.
 *
 * Only `tool_result` content is touched, and only its text: the block, its
 * `tool_use_id` and its position all survive, so the conversation stays valid.
 * Recent turns are trimmed last because they are the ones the model is
 * actually still reasoning from.
 *
 * **Measured before it is copied, and measured once per trim rather than per
 * block.** This runs after every model turn *and* every tool call, so a
 * sixteen-turn task pays for it fifty-odd times — and the first version paid
 * three full serialisations of a conversation that may be three megabytes
 * before it had established there was nothing to do, then re-serialised the
 * whole thing after every single block it trimmed. The size of a JSON document
 * is the size of its parts, so a trim's saving can be subtracted from a running
 * total instead; the deep copy is made only when something is actually going to
 * be changed, because the caller's `messages` must not be mutated — it is the
 * live conversation the loop is still turning.
 *
 * **Never above the last thinking block** (`editableFrom`, the loop's own
 * boundary). Claude signs each block against everything before it, so a result
 * trimmed above one is a stored conversation the next resume cannot send: on a
 * newer account a 400, and before the loop's backstop caught it, a run handed
 * to a paid vendor. A thinking conversation that is past the ceiling is saved
 * over it — it is no larger than what the loop is already sending every turn,
 * and a checkpoint that is valid matters more than one that is small.
 *
 * Exported for `checks/conversationTrim.ts`, which is where the rule this obeys
 * is already written down.
 */
export function trimToFit(messages: AgentCheckpointState["messages"]): AgentCheckpointState["messages"] {
  let size = JSON.stringify(messages).length;
  if (size <= MAX_JSON) return messages;
  // And never the newest user turn, which holds answers the model has not read
  // yet — `TRIMMED` tells it it read them at the time, and it had not. The
  // same guard `releaseOldAnswers` keeps on what is sent.
  const from = editableFrom(messages);
  let unread = messages.length - 1;
  while (unread >= 0 && messages[unread].role !== "user") unread -= 1;
  if (from >= unread) return messages;

  const copy = JSON.parse(JSON.stringify(messages)) as AgentCheckpointState["messages"];
  const replacement = JSON.stringify(TRIMMED).length;

  for (const message of copy.slice(from, unread)) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content as { type?: string; content?: unknown }[]) {
      if (block?.type !== "tool_result") continue;
      if (typeof block.content === "string" && block.content === TRIMMED) continue;
      // What this block costs today, as it is serialised — which is the only
      // measure that matches the number being compared against.
      const was = JSON.stringify(block.content ?? null).length;
      block.content = TRIMMED;
      size -= was - replacement;
      if (size <= MAX_JSON) return copy;
    }
  }
  return copy;
}

/** What a previous run of this task left behind, or null to start from the brief. */
export async function loadCheckpoint(taskId: string): Promise<StoredCheckpoint | null> {
  const row = await prisma.agentTaskCheckpoint.findUnique({ where: { taskId } });
  if (!row) return null;

  const messages = fromStoredJson<AgentCheckpointState["messages"]>(row.messages) ?? [];
  if (!Array.isArray(messages) || messages.length === 0) return null;

  return {
    state: {
      iteration: row.iteration,
      messages,
      narration: (row.narration ?? []) as unknown as string[],
      pendingAssistant: fromStoredJson<AgentCheckpointState["pendingAssistant"]>(row.pendingAssistant),
      pendingResults: fromStoredJson<AgentCheckpointState["pendingResults"]>(row.pendingResults),
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
    // As text, so every `tool_use` input keeps the key order it was sent in.
    // See `storedJson`. Null stays a real null: the runner asks the column
    // whether a turn was left half-way.
    messages: storedJson(messages),
    narration: state.narration as unknown as Prisma.InputJsonValue,
    pendingAssistant: state.pendingAssistant ? storedJson(state.pendingAssistant) : Prisma.JsonNull,
    pendingResults: state.pendingResults ? storedJson(state.pendingResults) : Prisma.JsonNull,
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
 * Says something to a conversation that stopped, so it hears it on resume.
 *
 * Appended to the final user turn rather than pushed as a new one, because two
 * user messages in a row is not a shape the API accepts. Tool results have to
 * come first inside that turn, so the new text goes on the end, which is where
 * a reply belongs anyway.
 *
 * Two things use this and they are different kinds of news: the Owner
 * answering an escalation, and the system telling an agent that the craft it
 * said was missing now exists. Both fail the same way without it — the agent
 * resumes at the moment it stopped, having never been told, and stops again.
 */
export async function appendToConversation(taskId: string, text: string): Promise<boolean> {
  const row = await prisma.agentTaskCheckpoint.findUnique({ where: { taskId }, select: { messages: true } });
  if (!row) return false;

  const messages = fromStoredJson<AgentCheckpointState["messages"]>(row.messages) ?? [];
  if (!Array.isArray(messages) || messages.length === 0) return false;

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
    data: { messages: storedJson(messages) },
  });
  return true;
}

/**
 * Adds the Owner's answer to a conversation that stopped and asked.
 *
 * Without this, answering an escalation would be written into the brief while
 * the agent resumed the conversation it had already had — and it would carry
 * on from the question it asked, never having been told the answer.
 */
export async function appendOwnerAnswer(taskId: string, answer: string): Promise<boolean> {
  return appendToConversation(taskId, `The Owner has answered what you asked:\n\n${answer.trim()}\n\nCarry on from here.`);
}
