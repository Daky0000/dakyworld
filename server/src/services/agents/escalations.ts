import { prisma } from "../../lib/prisma.js";
import { appendOwnerAnswer } from "./checkpoint.js";
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
 * Three places, and dropping any of them is a distinct bug:
 *
 * - **The brief**, so what the agent was told stays beside what it was asked.
 * - **The conversation**, so the agent that resumes has actually been told.
 *   Without this it carries on from the moment it asked, and asks again.
 * - **The Slack card**, so the channel stops showing a live question under an
 *   answer somebody has already given. That is the half that made deciding in
 *   the app look like nothing happening in Slack.
 *
 * Shared by the browser and by Slack rather than written twice, because the
 * day one copy stops doing the second of those is a day nobody notices.
 */
export async function recordOwnerAnswer(task: { id: string; brief: string; status: string }, text: string, by: AnsweredBy): Promise<void> {
  await prisma.agentTask.update({
    where: { id: task.id },
    data: { brief: `${task.brief}\n\n--- Answer from the Owner ---\n${text}`.slice(0, 8000) },
  });
  await appendOwnerAnswer(task.id, text);

  // A BLOCKED task is moved back into the queue explicitly. One that is QUEUED
  // or FAILED is left where it is — the claim accepts both — and moving it
  // would write a transition saying nothing happened.
  if (task.status === "BLOCKED") {
    await transition(task.id, {
      to: "QUEUED",
      reason: by.who ? `Answered by ${by.who}; requeued with the answer on its brief.` : "Answered; requeued with the answer on its brief.",
      actor: by.slackUserId ? "slack" : "owner",
      actorId: by.userId ?? null,
      expect: ["BLOCKED"],
      data: { blockedReason: null, finishedAt: null, startedAt: null, runOwner: null, interruptRequested: false },
    });
  }

  await settleTaskCard(task.id, by.who ?? null, text);
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
