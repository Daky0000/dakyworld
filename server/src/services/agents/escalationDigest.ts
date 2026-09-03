import { prisma } from "../../lib/prisma.js";
import { SETTING, getSetting } from "../../lib/settings.js";
import { sendSlackBlocks, slackConfigured } from "../../lib/slack.js";

/**
 * The questions nobody has answered yet, gathered once a week.
 *
 * An escalation is posted to Slack the moment it happens, and that card is the
 * right thing for the first hour and the wrong thing for the second week: it
 * scrolls away, and a question nobody ever answered is indistinguishable from
 * one that was, because nothing anywhere counts them. The Agents screen shows
 * BLOCKED tasks, but only if somebody thinks to look — and the whole reason
 * `escalate` exists is that stopping to ask is the most important thing an
 * agent ever does.
 *
 * **Slack rather than email**, which is where every other decision in this
 * system already goes: hire cards, approval cards and the escalations
 * themselves. A digest arriving somewhere else is a second inbox to remember.
 *
 * **And Slack is never the only road.** `GET /api/agents/escalations` returns
 * the same rows for the Agents screen — the standing rule in `routes/slack.ts`,
 * because a workspace nobody connected must not mean questions nobody can see.
 */

/** A question this old has stopped being a question and become a problem. */
const STALE_AFTER_DAYS = 7;

/**
 * A task that is waiting on a person, in the two spellings a database can hold.
 *
 * `escalationStatus` is written inside `transition()`, so every task that has
 * stopped to ask since the column shipped carries PENDING. What it cannot
 * carry is a question raised *before* it shipped: the migration added the
 * column without a backfill, and a task already sitting in BLOCKED does not
 * transition again until somebody answers it — at which point it is written as
 * ANSWERED. So a question that had been waiting the longest was the one thing
 * the digest could never see, while the Agents screen listed it, because
 * `blockedTasks()` reads `status` instead. Two readings of "waiting on
 * somebody", disagreeing about exactly the oldest rows.
 *
 * A backfill fixes the rows that exist; this fixes the reading, so the two
 * roads agree whatever order a database was migrated in. `null` is only ever
 * taken as pending **with** BLOCKED — a CLOSED question stays closed, and a
 * task that never asked anything has no null to interpret.
 */
const WAITING_ON_A_PERSON = {
  OR: [{ escalationStatus: "PENDING" as const }, { escalationStatus: null, status: "BLOCKED" as const }],
};

export interface OpenEscalation {
  id: string;
  title: string;
  agentKey: string;
  agentName: string;
  blockedReason: string | null;
  askedAt: Date | null;
  /** Whole days since it stopped. Null when it has no finish time to measure from. */
  ageDays: number | null;
}

/**
 * Every question still waiting on a person, oldest first.
 *
 * Rehearsals are excluded for the same reason they never post a card: they are
 * a test, and a test's questions are read on the rehearsal screen beside the
 * run that raised them.
 */
export async function openEscalations(limit = 50): Promise<OpenEscalation[]> {
  const tasks = await prisma.agentTask.findMany({
    where: { ...WAITING_ON_A_PERSON, rehearsal: false },
    orderBy: [{ finishedAt: "asc" }],
    take: limit,
    select: {
      id: true,
      title: true,
      agentKey: true,
      blockedReason: true,
      finishedAt: true,
      agent: { select: { name: true } },
    },
  });

  const now = Date.now();
  return tasks.map((task) => ({
    id: task.id,
    title: task.title,
    agentKey: task.agentKey,
    agentName: task.agent.name,
    blockedReason: task.blockedReason,
    askedAt: task.finishedAt,
    ageDays: task.finishedAt ? Math.floor((now - task.finishedAt.getTime()) / 86_400_000) : null,
  }));
}

/**
 * Marks one question as read and deliberately left.
 *
 * Not an answer — there is nothing to answer with — and deliberately **not** a
 * change of task status. The task stays BLOCKED because it is still stopped;
 * what changes is that nobody needs reminding about it every week. That
 * separation is the whole reason `escalationStatus` is its own column rather
 * than a reading of `status`.
 *
 * **The note is the one thing here nothing else can derive.** Answering a
 * question leaves the answer on the brief and in the conversation, so there is
 * always something to read afterwards. Closing one leaves nothing at all — and
 * "why did nobody act on this" six weeks later is exactly the question the
 * column exists to answer. `escalationResolvedAt` is stamped in the same write
 * as the status for the same reason `transition()` stamps it: a timestamp
 * written separately is a timestamp that can be missing.
 */
export async function closeEscalation(
  taskId: string,
  by: { userId?: string | null; who?: string | null },
  note?: string | null,
): Promise<boolean> {
  const text = note?.trim().slice(0, 1000) || null;
  const done = await prisma.agentTask.updateMany({
    where: { id: taskId, ...WAITING_ON_A_PERSON },
    data: { escalationStatus: "CLOSED", escalationResolvedAt: new Date(), escalationNote: text },
  });
  if (done.count === 0) return false;

  // The history is the task's own, so the acknowledgement belongs on it — a
  // question that quietly stopped appearing with no record of who decided that
  // is the thing this feature exists to end.
  const closed = by.who ? `Escalation closed by ${by.who} — read and left as it is.` : "Escalation closed — read and left as it is.";
  await prisma.agentTaskTransition.create({
    data: {
      taskId,
      from: "BLOCKED",
      to: "BLOCKED",
      reason: text ? `${closed} ${text}` : closed,
      actor: "owner",
      actorId: by.userId ?? null,
    },
  }).catch((err: Error) => console.error(`[agent] could not record the escalation close on ${taskId}:`, err.message));

  return true;
}

/**
 * Posts the week's open questions, and says nothing when there are none.
 *
 * A digest that arrives every week saying "nothing to report" is a digest
 * people stop opening, and the one week it matters is the week it is ignored.
 */
export async function postEscalationDigest(): Promise<{ posted: boolean; count: number }> {
  if ((await getSetting(SETTING.WEEKLY_DIGEST)) === "false") return { posted: false, count: 0 };

  const open = await openEscalations();
  if (open.length === 0) return { posted: false, count: 0 };
  if (!(await slackConfigured())) return { posted: false, count: open.length };

  const stale = open.filter((entry) => (entry.ageDays ?? 0) >= STALE_AFTER_DAYS);
  const lines = open.slice(0, 20).map((entry) => {
    const age = entry.ageDays === null ? "just now" : entry.ageDays === 0 ? "today" : `${entry.ageDays}d`;
    const why = entry.blockedReason?.replace(/\s+/g, " ").slice(0, 160) ?? "No reason recorded.";
    return `• *${entry.agentName}* — ${entry.title} _(${age})_\n   ${why}\n   \`/dakyworld answer ${entry.id} …\``;
  });

  const text = `${open.length} agent question(s) waiting on you`;
  await sendSlackBlocks({
    text,
    blocks: [
      { type: "header", text: { type: "plain_text", text, emoji: false } },
      ...(stale.length > 0
        ? [
            {
              type: "context",
              elements: [
                {
                  type: "mrkdwn",
                  text: `${stale.length} of them have been waiting ${STALE_AFTER_DAYS} days or more. An agent that stopped to ask is an agent doing nothing until it is told.`,
                },
              ],
            },
          ]
        : []),
      { type: "section", text: { type: "mrkdwn", text: lines.join("\n") } },
      ...(open.length > 20
        ? [{ type: "context", elements: [{ type: "mrkdwn", text: `…and ${open.length - 20} more on the Agents screen.` }] }]
        : []),
    ],
  });

  return { posted: true, count: open.length };
}
