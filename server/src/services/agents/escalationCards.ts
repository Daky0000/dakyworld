import { prisma } from "../../lib/prisma.js";
import { sendSlackBlocks, slackConfigured, updateSlack } from "../../lib/slack.js";
import { appUrl } from "../emailSender.js";

/**
 * A task that stopped to ask a person, as a message in Slack.
 *
 * Approvals and hires have had cards since they were built. Escalations — the
 * single most important thing an agent ever says — had none: `escalate` wrote
 * `BLOCKED` to a row, and the only way to find out was to open the Agents
 * screen and notice. An agent that stops and asks a question nobody hears has
 * not escalated; it has stopped.
 *
 * The same shape as the other two cards on purpose. One builder for every
 * state, so an answered question rewrites its own message rather than leaving
 * a live "Yes, go ahead" button under something already settled, and the
 * builder is the only thing that knows what a card looks like.
 *
 * **Slack is never the only road**, exactly as with approvals: every button
 * here has an authenticated route behind it, and a workspace nobody connected
 * changes nothing except how quickly the Owner hears about it.
 *
 * **A rehearsal is silent.** A rehearsal points the whole workforce at one
 * company; nine agents stopping to ask about a test would be nine questions
 * about work that is not real, which is how a channel stops being read.
 */

export const TASK_ACTIONS = {
  /** Answer with one of the choices the agent itself offered. Value: `taskId::index`. */
  option: "dky_task_option",
  /** Type an answer. Opens a dialog where there is a bot token; says how to otherwise. */
  answer: "dky_task_answer",
  /** Acknowledge and leave it stopped. */
  leave: "dky_task_leave",
  /** Put a failed task back in the queue, continuing rather than starting again. */
  retry: "dky_task_retry",
} as const;

/** The dialog's own identifiers, for `view_submission`. */
export const ANSWER_VIEW = { callbackId: "dky_task_answer_view", blockId: "answer", actionId: "text" } as const;

/**
 * Stands in for a channel on a webhook-only Slack, which reports neither.
 *
 * Not a channel name and never sent to Slack — it is only ever read back here,
 * as the record that this question did reach a wall somewhere.
 */
const POSTED_BY_WEBHOOK = "webhook";

interface CardTask {
  id: string;
  agentKey: string;
  title: string;
  status: string;
  blockedReason: string | null;
  error: string | null;
  attempts: number;
  slackChannel: string | null;
  slackTs: string | null;
}

function button(text: string, actionId: string, value: string, style?: "primary" | "danger") {
  return { type: "button", text: { type: "plain_text", text: text.slice(0, 75), emoji: true }, action_id: actionId, value, ...(style ? { style } : {}) };
}

/**
 * The choices the agent offered, as it offered them.
 *
 * `escalate` puts them on the `BLOCKED` step rather than on the task, because
 * they belong to the moment it asked. Read back here so the commonest answer —
 * "the second one" — is one tap rather than a sentence typed on a phone.
 */
export async function optionsFor(taskId: string): Promise<string[]> {
  const asked = await prisma.agentTaskStep.findFirst({
    where: { taskId, kind: "BLOCKED" },
    orderBy: { seq: "desc" },
    select: { data: true },
  });
  const raw = (asked?.data as { options?: unknown } | null)?.options;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((option): option is string => typeof option === "string" && option.trim().length > 0)
    .map((option) => option.trim())
    // Slack renders at most five elements in an actions block comfortably, and
    // `escalate` caps the list at four. Held to four here as well so a widened
    // schema cannot silently produce a card Slack refuses to render.
    .slice(0, 4);
}

async function taskBlocks(
  task: CardTask,
  options: string[],
  settled: { by: string | null; answer: string | null } | null,
): Promise<{ text: string; blocks: unknown[] }> {
  const [base, agent] = await Promise.all([appUrl(), prisma.agent.findUnique({ where: { key: task.agentKey }, select: { name: true } })]);
  const who = agent?.name ?? task.agentKey;
  const failed = task.status === "FAILED";

  const headline = settled
    ? failed
      ? `Put back in the queue — ${task.title}`
      : `Answered — ${task.title}`
    : failed
      ? `${who} could not finish "${task.title}"`
      : `${who} stopped and asked`;

  const question = failed ? (task.error ?? "The run failed and said nothing about why.") : (task.blockedReason ?? "It stopped without saying why.");

  const blocks: unknown[] = [
    { type: "header", text: { type: "plain_text", text: headline.slice(0, 150), emoji: true } },
    { type: "section", text: { type: "mrkdwn", text: (failed ? `*What went wrong:* ${question}` : `*${question}*`).slice(0, 3000) } },
  ];

  if (!failed) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `\`${task.agentKey}\` · ${task.title}`.slice(0, 300) }],
    });
  }

  if (!settled) {
    if (failed) {
      blocks.push({ type: "actions", elements: [button("Run it again", TASK_ACTIONS.retry, task.id, "primary")] });
    } else {
      const elements: unknown[] = options.map((option, index) =>
        button(option, TASK_ACTIONS.option, `${task.id}::${index}`, index === 0 ? "primary" : undefined),
      );
      elements.push(button(options.length > 0 ? "Something else…" : "Answer…", TASK_ACTIONS.answer, task.id, options.length > 0 ? undefined : "primary"));
      elements.push(button("Leave it", TASK_ACTIONS.leave, task.id));
      blocks.push({ type: "actions", elements });
    }
  }

  // The slash command is spelled out with the id already in it, because it is
  // the only way to answer at all on a webhook-only Slack, and because copying
  // a task id out of a URL on a phone is how a question goes unanswered.
  const footer = settled
    ? `${settled.by ? `Answered by ${settled.by}` : "Answered"}${settled.answer ? ` — ${settled.answer.slice(0, 200)}` : ""} · <${base}/agents/tasks/${task.id}|Open the task>`
    : failed
      ? `Attempt ${task.attempts} · <${base}/agents/tasks/${task.id}|Open the task>`
      : `\`/dakyworld answer ${task.id} your answer\` · <${base}/agents/tasks/${task.id}|Open the task>`;

  blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: footer.slice(0, 300) }] });

  return { text: `${headline} — ${question}`.slice(0, 300), blocks };
}

/** True when this task must never produce a message. */
async function silent(taskId: string): Promise<boolean> {
  const task = await prisma.agentTask.findUnique({ where: { id: taskId }, select: { rehearsal: true } });
  return task?.rehearsal !== false;
}

/**
 * How many failure cards may be posted in ten minutes before the rest are held.
 *
 * A question is always worth interrupting somebody for; a failure often is not,
 * because failures arrive in weather. A model vendor going down, a key expiring
 * or a database blinking fails every task running at that moment, and twenty
 * near-identical cards is how a channel stops being read — including by the
 * person who would otherwise have seen the one question that mattered.
 *
 * So the *first* few go out, in full, with their Run again button, and the rest
 * are left to the Agents screen and to `/dakyworld status`, which count them
 * whether or not anything was posted. A cap rather than a summary message on
 * purpose: a summary is a new thing to build, get wrong and maintain, and it
 * would say nothing the first card has not already said.
 *
 * Escalations are never held. A question with nobody to hear it is the failure
 * this whole file exists to end.
 */
const FAILURE_CARDS_PER_WINDOW = 4;
const FAILURE_WINDOW_MS = 10 * 60_000;

async function tooManyFailuresJustNow(taskId: string): Promise<boolean> {
  // Counted on the tasks themselves rather than on cards actually posted.
  // `slackTs` is the obvious filter and it is wrong twice: a webhook-only Slack
  // never stores one, so the cap would never engage there at all, and settling
  // a card clears it, so answering one failure would quietly re-open the gate.
  // The storm being guarded against is a run of failures, and that is what this
  // counts. This task has already been written FAILED by the time the card is
  // posted, so it is excluded rather than counting itself.
  const others = await prisma.agentTask.count({
    where: {
      id: { not: taskId },
      status: "FAILED",
      rehearsal: false,
      finishedAt: { gt: new Date(Date.now() - FAILURE_WINDOW_MS) },
    },
  });
  return others >= FAILURE_CARDS_PER_WINDOW;
}

/**
 * Posts the question, and remembers where, so answering it can rewrite it.
 *
 * Best-effort throughout: the task is stopped and recorded either way, and
 * Slack being down is not a reason to turn a question into a failure.
 */
export async function postTaskCard(taskId: string): Promise<boolean> {
  try {
    if (await silent(taskId)) return false;
    if (!(await slackConfigured())) return false;

    const task = await prisma.agentTask.findUnique({
      where: { id: taskId },
      select: { id: true, agentKey: true, title: true, status: true, blockedReason: true, error: true, attempts: true, slackChannel: true, slackTs: true },
    });
    if (!task || (task.status !== "BLOCKED" && task.status !== "FAILED")) return false;
    if (task.status === "FAILED" && (await tooManyFailuresJustNow(taskId))) {
      console.warn(`[agent] holding the failure card for ${taskId} — several have already gone out in the last ten minutes.`);
      return false;
    }

    const options = task.status === "BLOCKED" ? await optionsFor(taskId) : [];
    const { text, blocks } = await taskBlocks(task, options, null);
    const result = await sendSlackBlocks({ text, blocks });
    if (result.delivered) {
      // Recorded even when Slack gave us nothing to edit. A webhook returns no
      // channel and no message id, and storing nothing would mean `settleTaskCard`
      // could not tell "this question was never posted" — where saying anything
      // would be announcing an answer to a channel that never saw the question —
      // from "this question is on the wall with live buttons under it", where
      // saying nothing leaves somebody able to answer it a second time.
      await prisma.agentTask.update({
        where: { id: taskId },
        data: { slackChannel: result.channel ?? POSTED_BY_WEBHOOK, slackTs: result.ts ?? null },
      });
    }
    return result.delivered;
  } catch (err) {
    console.error("[agent] could not post the escalation card:", (err as Error).message);
    return false;
  }
}

/**
 * Rewrites a question that has been answered.
 *
 * On a webhook-only Slack there is nothing to rewrite, so the outcome is
 * posted as a fresh message — the same fallback the other two cards use, and
 * for the same reason: a stale button is worse than a second message.
 *
 * The card reference is cleared either way, so a task that stops a second time
 * posts a new question rather than editing the answer to the first one.
 */
export async function settleTaskCard(taskId: string, by: string | null, answer: string | null): Promise<void> {
  const task = await prisma.agentTask.findUnique({
    where: { id: taskId },
    select: { id: true, agentKey: true, title: true, status: true, blockedReason: true, error: true, attempts: true, slackChannel: true, slackTs: true },
  });
  // Nothing was ever posted, so there is nothing to tidy — and no reason to
  // announce an answer to a question the channel never saw.
  if (!task || (!task.slackChannel && !task.slackTs)) return;

  try {
    if (!(await slackConfigured())) return;
    const { text, blocks } = await taskBlocks(task, [], { by, answer });
    if (!(task.slackChannel && task.slackTs && (await updateSlack(task.slackChannel, task.slackTs, { text, blocks })))) {
      await sendSlackBlocks({ text, blocks });
    }
  } catch (err) {
    console.error("[agent] could not update the escalation card:", (err as Error).message);
  } finally {
    await prisma.agentTask.update({ where: { id: taskId }, data: { slackChannel: null, slackTs: null } }).catch(() => undefined);
  }
}
