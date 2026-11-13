import type { AgentTask, AgentTaskStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";

/**
 * Work that waits for other work.
 *
 * Until Nov 2026 a sub-task was raised and forgotten. `delegate` queued a
 * child and told its parent "you are not waiting on it", which was true in the
 * worst way: every child started as soon as its skill was free, in no order,
 * and the parent wrote its summary before any of them had begun. So a task
 * that was really *audit the site, then write the letter from the audit, then
 * tell me what was sent* became three strangers working at once — the letter
 * written with no audit under it, and a summary that said "delegated to 2
 * agents" about work nobody had read.
 *
 * One column carries both halves of the fix: `AgentTask.waitsFor`, the ids of
 * the tasks this one may not start (or carry on) before.
 *
 * - **A sub-task raised with `after`** waits for the earlier sub-tasks it
 *   names, and starts with their results in its brief. That is *one at a
 *   time*: use it when a piece needs what another piece produces.
 * - **A sub-task raised without it** starts as soon as its skill is free,
 *   beside everything else. That is *in parallel*: use it when the pieces do
 *   not need each other.
 * - **A parent that calls `awaitSubtasks`** is put back in the queue with its
 *   place kept, waiting for its own open sub-tasks, and resumes with their
 *   results on the end of its conversation — so it can check them, join them
 *   up and say what actually happened.
 *
 * **Waiting is not a status.** A waiting task is QUEUED with a non-empty
 * `waitsFor`, exactly as a paused one is QUEUED with a future `scheduledFor`:
 * the tick simply does not pick it up yet. Nothing has to wake it, so nothing
 * can forget to — a restart, a deploy or a second process all read the same
 * column and reach the same answer.
 *
 * **What counts as ended** is anything that will not move again without a
 * person deciding it should: DONE, NEEDS_APPROVAL (the work is prepared; what
 * is left is an approval, not more work), FAILED and CANCELLED. A BLOCKED task
 * has asked a question and its answer *is* the work, so what waits for it goes
 * on waiting. A task that can never start — its skill is a draft, paused or
 * retired — is counted as ended and said to be so, because the alternative is
 * a parent that waits for ever with nothing on any screen to say why.
 */

const ENDED: ReadonlySet<AgentTaskStatus> = new Set<AgentTaskStatus>(["DONE", "NEEDS_APPROVAL", "FAILED", "CANCELLED"]);

/** How many times one task may put itself down to wait. A fourth is a brief that should have been an escalation. */
export const MAX_WAITS = 3;

/** How many earlier sub-tasks one sub-task may wait for. */
export const MAX_AFTER = 4;

interface Waited {
  id: string;
  title: string;
  status: AgentTaskStatus;
  summary: string | null;
  blockedReason: string | null;
  error: string | null;
  input: unknown;
  createdAt: Date;
  agent: { name: string; status: string };
}

const WAITED = {
  id: true,
  title: true,
  status: true,
  summary: true,
  blockedReason: true,
  error: true,
  input: true,
  createdAt: true,
  agent: { select: { name: true, status: true } },
} as const;

/** Whether this task will move again on its own, and if not, why it counts as over. */
export function endedAs(task: Pick<Waited, "status" | "agent">): { ended: boolean; neverStarted: boolean } {
  if (ENDED.has(task.status)) return { ended: true, neverStarted: false };
  // Queued under a skill that takes no work. Only QUEUED: a RUNNING task whose
  // skill was paused mid-run finishes its run.
  if (task.status === "QUEUED" && task.agent.status !== "ACTIVE") return { ended: true, neverStarted: true };
  return { ended: false, neverStarted: false };
}

/** The sub-tasks one task has raised, oldest first: `s1`, `s2`, … in the order it raised them. */
async function childrenOf(parentId: string): Promise<Waited[]> {
  return prisma.agentTask.findMany({ where: { parentId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: WAITED });
}

/** The short name a parent uses for one of its sub-tasks. */
export async function subtaskRef(parentId: string, childId: string): Promise<string> {
  const children = await childrenOf(parentId);
  const at = children.findIndex((child) => child.id === childId);
  return `s${at < 0 ? children.length : at + 1}`;
}

/**
 * The earlier sub-tasks named in `after`, as ids.
 *
 * By reference (`s2`) or by exact title, and only ever a sub-task this same
 * parent has already raised — which is what makes a cycle impossible: a task
 * can only wait for something that existed before it did.
 */
export async function resolveAfter(parentId: string, raw: unknown): Promise<{ ids: string[]; names: string[] } | { refused: string }> {
  const wanted = (Array.isArray(raw) ? raw : [])
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => entry.trim())
    .slice(0, MAX_AFTER);
  if (wanted.length === 0) return { ids: [], names: [] };

  const children = await childrenOf(parentId);
  const ids: string[] = [];
  const names: string[] = [];
  for (const entry of wanted) {
    const byRef = /^s(\d{1,3})$/i.exec(entry);
    const child = byRef ? children[Number(byRef[1]) - 1] : children.find((candidate) => candidate.title.toLowerCase() === entry.toLowerCase());
    if (!child) {
      const known = children.map((candidate, index) => `s${index + 1} "${candidate.title}"`).join(", ");
      return {
        refused: `There is no earlier sub-task ${JSON.stringify(entry)} on this task. ${
          known ? `The ones you have raised: ${known}.` : "You have not raised any yet — raise the work this depends on first, then name it here."
        }`,
      };
    }
    if (!ids.includes(child.id)) {
      ids.push(child.id);
      names.push(child.title);
    }
  }
  return { ids, names };
}

/** The sub-tasks of this task that have not ended, for `awaitSubtasks`. */
export async function openSubtasks(parentId: string): Promise<{ open: Waited[]; all: Waited[] }> {
  const all = await childrenOf(parentId);
  return { open: all.filter((child) => !endedAs(child).ended), all };
}

/**
 * The waiting tasks whose wait is over.
 *
 * Read on every tick, before work is picked up. Two small queries whatever
 * the size of the queue: the waiting tasks, and the tasks they wait for. A
 * task that no longer exists is not waited for.
 */
export async function readyToCarryOn(): Promise<string[]> {
  const waiting = await prisma.agentTask.findMany({
    where: { status: "QUEUED", waitsFor: { isEmpty: false } },
    select: { id: true, waitsFor: true },
    take: 200,
  });
  if (waiting.length === 0) return [];

  const wanted = [...new Set(waiting.flatMap((task) => task.waitsFor))];
  const found = await prisma.agentTask.findMany({ where: { id: { in: wanted } }, select: { id: true, status: true, agent: { select: { name: true, status: true } } } });
  const over = new Set(found.filter((task) => endedAs(task).ended).map((task) => task.id));
  const exists = new Set(found.map((task) => task.id));

  return waiting.filter((task) => task.waitsFor.every((id) => over.has(id) || !exists.has(id))).map((task) => task.id);
}

function gist(text: string | null | undefined, max: number): string {
  return (text ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function acceptanceOf(input: unknown): string[] {
  const list = input && typeof input === "object" && !Array.isArray(input) ? (input as { acceptance?: unknown }).acceptance : null;
  return Array.isArray(list) ? list.filter((line): line is string => typeof line === "string").slice(0, 4) : [];
}

/** One ended task, as the task that waited for it reads it. */
function line(task: Waited, ref: string | null): string {
  const state = endedAs(task);
  const said = task.status === "FAILED" ? task.error : task.status === "BLOCKED" ? task.blockedReason : task.summary;
  const outcome = state.neverStarted
    ? `NOT STARTED — ${task.agent.name} is ${task.agent.status.toLowerCase()} and takes no work`
    : task.status === "NEEDS_APPROVAL"
      ? `PREPARED, waiting for a person's approval — ${gist(said, 700) || "no summary"}`
      : `${task.status}${gist(said, 700) ? ` — ${gist(said, 700)}` : ""}`;
  const checks = acceptanceOf(task.input);
  return [
    `- ${ref ? `${ref} ` : ""}"${task.title}" (${task.agent.name}): ${outcome}`,
    ...(checks.length > 0 ? [`  The checks set for it: ${checks.join("; ")}`] : []),
  ].join("\n");
}

/**
 * What a task is told when the work it waited for has ended.
 *
 * Two readers and two wordings. A **parent** asked for the work and is
 * responsible for it, so it is told to check each result against what it asked
 * for before relying on it. A **dependent** sub-task was only ever going to
 * build on the work, so it is handed the results as its starting material and
 * told what to do when a piece it needs is missing.
 *
 * Summaries only, never timelines: this is paid for on every turn after it.
 */
export async function waitedResults(task: Pick<AgentTask, "id" | "parentId">, ids: string[], reader: "parent" | "dependent"): Promise<string> {
  const rows = await prisma.agentTask.findMany({ where: { id: { in: ids } }, select: WAITED });
  const byId = new Map(rows.map((row) => [row.id, row]));
  // References are the parent's names for its sub-tasks, so they are worked out
  // over whichever task raised these: this one, or the one this shares a parent with.
  const raisedBy = reader === "parent" ? task.id : task.parentId;
  const siblings = raisedBy ? await childrenOf(raisedBy) : [];
  const refOf = (id: string) => {
    const at = siblings.findIndex((child) => child.id === id);
    return at < 0 ? null : `s${at + 1}`;
  };

  const lines = ids.map((id) => {
    const row = byId.get(id);
    return row ? line(row, refOf(id)) : "- A sub-task that no longer exists.";
  });
  const unfinished = rows.some((row) => row.status !== "DONE" && row.status !== "NEEDS_APPROVAL");

  if (reader === "parent") {
    return [
      "The sub-tasks you were waiting for have ended:",
      "",
      ...lines,
      "",
      "Check each result against what you asked for before you rely on it — a summary is what the work says about itself.",
      unfinished
        ? "At least one did not finish. That is yours to decide: do it another way, raise it again with a clearer brief, or escalate. Do not report it as done."
        : "Carry on from here and finish your own part.",
    ].join("\n");
  }
  return [
    "EARLIER WORK THIS TASK WAITED FOR — it has ended, and this is what came of it:",
    "",
    ...lines,
    "",
    unfinished
      ? "At least one piece did not finish. If your work cannot be done properly without it, escalate and say which piece is missing rather than working around the hole."
      : "Build on it. Where you need more than the summary says, read the record or its history.",
  ].join("\n");
}
