import { prisma } from "../../lib/prisma.js";
import { appendNote } from "../context/dossier.js";
import { appendOwnerAnswer } from "./checkpoint.js";
import { subjectOf } from "./memory.js";
import { optionsFor, settleTaskCard } from "./escalationCards.js";
import { runTask } from "./runner.js";
import { transition } from "./state.js";

/**
 * Answering an agent that stopped to ask.
 *
 * This used to live inside `POST /agents/tasks/:id/run`, which was fine while
 * a browser was the only thing that could answer. Slack can now, and two
 * copies of "append the answer, rejoin the conversation, put it back in the
 * queue" is the kind of duplication that drifts: the day one of them stops
 * appending to the conversation, an agent resumes at the moment it asked its
 * question, having never been told the answer, and asks it again.
 *
 * So the rule lives here once and both roads call it.
 *
 * **The answer goes two places, and both are load-bearing.** The brief keeps
 * it on the record — what the agent was originally asked stays readable beside
 * what it was told afterwards. The conversation is what the agent actually
 * reads when it resumes.
 */

export class AnswerRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnswerRefused";
  }
}

export interface AnsweredBy {
  userId?: string | null;
  slackUserId?: string | null;
  /** A name for the card and the history: "Dan", "dan in Slack". */
  who?: string | null;
}

/**
 * The questions waiting on a person, newest first.
 *
 * Rehearsals are left out for the same reason they never post a card: they are
 * a test, and a test's questions are read on the rehearsal screen beside the
 * run that raised them.
 */
export async function blockedTasks(limit = 20) {
  const tasks = await prisma.agentTask.findMany({
    where: { status: "BLOCKED", rehearsal: false },
    orderBy: { finishedAt: "desc" },
    take: limit,
    select: {
      id: true,
      title: true,
      agentKey: true,
      blockedReason: true,
      finishedAt: true,
      agent: { select: { name: true, status: true } },
    },
  });
  return Promise.all(tasks.map(async (task) => ({ ...task, options: await optionsFor(task.id) })));
}

/**
 * Everything that has to be true before an answer is worth writing down.
 *
 * Checked before the answer is appended rather than after, because an answer
 * written onto a task that then refuses to run is an answer the agent will
 * never read and a record that says it was told.
 */
async function readyToResume(taskId: string) {
  const task = await prisma.agentTask.findUnique({
    where: { id: taskId },
    include: { agent: { select: { name: true, status: true } } },
  });
  if (!task) throw new AnswerRefused("No such task.");
  if (task.status === "RUNNING") throw new AnswerRefused("That one is already running.");
  if (task.agent.status !== "ACTIVE") {
    throw new AnswerRefused(`${task.agent.name} is a ${task.agent.status.toLowerCase()} — set it to Active first, then answer this again.`);
  }

  // One agent, one task at a time. Refused here rather than left to the claim,
  // because "answered, and it is running" for something that silently stayed
  // queued behind another job is the reply that wastes somebody's afternoon.
  const busy = await prisma.agentTask.findFirst({
    where: { agentKey: task.agentKey, status: "RUNNING" },
    select: { title: true },
  });
  return { task, busy };
}

/**
 * Writes one answer everywhere it has to go.
 *
 * Four places, and dropping any of them is a distinct bug:
 *
 * - **The brief**, so what the agent was told stays beside what it was asked.
 * - **The conversation**, so the agent that resumes has actually been told.
 *   Without this it carries on from the moment it asked, and asks again.
 * - **The record's history**, when the task is about a lead, a client or a
 *   project, so the *next* agent to open that company is told too. Without it
 *   the Owner's decision lived on one task's brief, and a colleague picking up
 *   the same lead tomorrow asked the same question again.
 * - **The Slack card**, so the channel stops showing a live question under an
 *   answer somebody has already given. That is the half that made deciding in
 *   the app look like nothing happening in Slack.
 *
 * Shared by the browser and by Slack rather than written twice, because the
 * day one copy stops doing the second of those is a day nobody notices.
 */
export async function recordOwnerAnswer(task: { id: string; brief: string; status: string }, text: string, by: AnsweredBy): Promise<void> {
  // Read before the requeue below clears `blockedReason`: the question is half
  // of what the history needs to say.
  const asked = await prisma.agentTask.findUnique({
    where: { id: task.id },
    select: { title: true, blockedReason: true, rehearsal: true, leadId: true, clientId: true, projectId: true, agent: { select: { name: true } } },
  });
  await prisma.agentTask.update({
    where: { id: task.id },
    data: { brief: `${task.brief}\n\n--- Answer from the Owner ---\n${text}`.slice(0, 8000) },
  });
  await appendOwnerAnswer(task.id, text);
  // Before the requeue, so it is on the record by the time anything can claim
  // the task again.
  if (asked) await fileAnswerOnRecord(task.id, asked, text, by);

  // Both stopped states must be queued: a busy agent will not claim a FAILED
  // task through the scheduler, even though a direct run can claim it.
  if (task.status === "BLOCKED" || task.status === "FAILED") {
    await transition(task.id, {
      to: "QUEUED",
      reason: by.who ? `Answered by ${by.who}; requeued with the answer on its brief.` : "Answered; requeued with the answer on its brief.",
      actor: by.slackUserId ? "slack" : "owner",
      actorId: by.userId ?? null,
      expect: [task.status],
      data: { error: null, blockedReason: null, finishedAt: null, startedAt: null, runOwner: null, interruptRequested: false },
    });
  }

  await settleTaskCard(task.id, by.who ?? null, text);
}

/**
 * The Owner's answer, as a decision in the history of the record it was about.
 *
 * A `DECISION` note by `owner` rather than a memory: a memory is an agent's own
 * conclusion and loses to the record, while this is what the company decided,
 * and it belongs where every colleague opening this company reads it. Never
 * the agent's `self` memory, which would keep it from all the others.
 *
 * Never on a rehearsal — a test's answers are not news about a customer — and
 * never at the answer's expense: an answer with a password in it is refused
 * here by the same check as any note, and the answer itself still goes through.
 */
async function fileAnswerOnRecord(
  taskId: string,
  asked: { title: string; blockedReason: string | null; rehearsal: boolean; leadId: string | null; clientId: string | null; projectId: string | null; agent: { name: string } },
  text: string,
  by: AnsweredBy,
): Promise<void> {
  const subject = asked.leadId
    ? subjectOf.lead(asked.leadId)
    : asked.clientId
      ? subjectOf.client(asked.clientId)
      : asked.projectId
        ? subjectOf.project(asked.projectId)
        : null;
  if (!subject || asked.rehearsal) return;

  const answer = text.replace(/\s+/g, " ").trim();
  const question = asked.blockedReason?.replace(/\s+/g, " ").trim();
  try {
    await appendNote({
      subject,
      kind: "DECISION",
      // The answer first: the brief prints this line cut to two hundred
      // characters, and of the two halves the answer is the one that decides.
      summary: question ? `The Owner decided: ${answer} (asked by ${asked.agent.name}: ${question})` : `The Owner decided: ${answer}`,
      body: [
        question ? `${asked.agent.name} asked, while working on "${asked.title}":\n${asked.blockedReason}` : `Said to ${asked.agent.name}, while working on "${asked.title}".`,
        // `owner` is whose authority it carries; the name says who typed it.
        `The Owner answered${by.who ? ` (${by.who})` : ""}:\n${text}`,
      ].join("\n\n"),
      authorKey: "owner",
      sourceTaskId: taskId,
    });
  } catch (err) {
    console.warn(`[agent] ${taskId}: the answer was recorded but not filed on ${subject} — ${(err as Error).message}`);
  }
}

/**
 * Writes the answer where the agent will read it, and starts it again.
 *
 * Returns `started: false` when the agent is mid-task: the answer is on the
 * record and the task is back in the queue, so it is picked up on the next
 * tick. That is a different sentence from "it is running now", and saying the
 * wrong one is how somebody concludes nothing happened.
 */
export async function answerTask(taskId: string, answer: string, by: AnsweredBy): Promise<{ taskId: string; started: boolean; queued: boolean }> {
  const text = answer.trim().slice(0, 2000);
  if (text.length === 0) throw new AnswerRefused("An empty answer is not an answer.");

  const { task, busy } = await readyToResume(taskId);
  if (task.status !== "BLOCKED" && task.status !== "FAILED") {
    throw new AnswerRefused(`That task is ${task.status.toLowerCase()}; it is no longer waiting for an answer.`);
  }
  await recordOwnerAnswer(task, text, by);

  if (busy) return { taskId: task.id, started: false, queued: true };

  // Deliberately not awaited: the work belongs to the server, not to whoever
  // is looking at it or to Slack's three-second window.
  void runTask(task.id).catch((err) => console.error(`[agent] ${task.id} died:`, (err as Error).message));
  return { taskId: task.id, started: true, queued: false };
}

/** Answers with one of the choices the agent itself offered. */
export async function answerWithOption(taskId: string, index: number, by: AnsweredBy) {
  const options = await optionsFor(taskId);
  const chosen = options[index];
  if (!chosen) throw new AnswerRefused("That choice is no longer on the question — answer it in words instead.");
  return answerTask(taskId, chosen, by);
}

/**
 * Leaves a question stopped, on purpose, and says so on the record.
 *
 * Not a decline — there is nothing to decline. It is an acknowledgement, and
 * its whole job is to take the live buttons off a card so the channel stops
 * showing a question somebody has already decided not to answer yet.
 */
export async function leaveBlocked(taskId: string, by: AnsweredBy): Promise<void> {
  const task = await prisma.agentTask.findUnique({ where: { id: taskId }, select: { id: true, status: true } });
  if (!task) throw new AnswerRefused("No such task.");
  await settleTaskCard(task.id, by.who ?? null, "Left for now — the task is still waiting.");
}

/**
 * Puts a failed task back in the queue.
 *
 * Continuing rather than starting again: a FAILED task keeps its checkpoint on
 * purpose, so the next runner rejoins the conversation instead of repaying for
 * the research it had already done.
 */
export async function retryTask(taskId: string, by: AnsweredBy): Promise<{ taskId: string; started: boolean; queued: boolean }> {
  const { task, busy } = await readyToResume(taskId);
  if (task.status !== "FAILED" && task.status !== "BLOCKED") {
    throw new AnswerRefused(`That task is ${task.status.toLowerCase()}, not stopped — there is nothing to run again.`);
  }

  await transition(task.id, {
    to: "QUEUED",
    reason: by.who ? `Run again by ${by.who}.` : "Run again.",
    actor: by.slackUserId ? "slack" : "owner",
    actorId: by.userId ?? null,
    expect: ["FAILED", "BLOCKED"],
    data: { error: null, blockedReason: null, finishedAt: null, startedAt: null, runOwner: null, interruptRequested: false },
  });

  await settleTaskCard(task.id, by.who ?? null, null);

  if (busy) return { taskId: task.id, started: false, queued: true };
  void runTask(task.id).catch((err) => console.error(`[agent] ${task.id} died:`, (err as Error).message));
  return { taskId: task.id, started: true, queued: false };
}
