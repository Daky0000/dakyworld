import type { MailMessage } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { recordCreated } from "../agents/state.js";
import { Prisma } from "@prisma/client";

/**
 * The things a person or an agent does to a message after it has arrived.
 *
 * Kept out of `catalogue.ts` and out of the router on purpose: the Inbox
 * screen and the agent tools do exactly the same two things — hand a message
 * to somebody, and close it — and two implementations of that would drift
 * until the button and the tool disagreed about what "handled" means.
 */

/** One message as anything reading the mailbox wants it: no body, no HTML, no headers. */
export function inboxSummary(message: MailMessage) {
  return {
    id: message.id,
    from: message.fromName ? `${message.fromName} <${message.fromEmail}>` : message.fromEmail,
    fromEmail: message.fromEmail,
    subject: message.subject,
    receivedAt: message.receivedAt,
    direction: message.direction,
    intent: message.intent,
    summary: message.summary,
    urgency: message.urgency,
    needsReply: message.needsReply,
    status: message.triage,
    routedTo: message.routedAgentKey,
    taskId: message.taskId,
    leadId: message.leadId,
    clientId: message.clientId,
    snippet: message.snippet,
    threadId: message.threadId,
  };
}

/**
 * Marks a message dealt with.
 *
 * The unread count is only moved when the message was genuinely open, because
 * closing something twice — a person clicking after an agent already did — must
 * not drive a thread's count below zero and leave a conversation that can never
 * be marked read again.
 */
export async function markHandled(input: {
  messageId: string;
  note: string;
  ignored?: boolean;
  userId?: string | null;
}): Promise<{ id: string; status: string }> {
  const existing = await prisma.mailMessage.findUnique({
    where: { id: input.messageId },
    select: { id: true, threadId: true, triage: true, handledAt: true, direction: true },
  });
  if (!existing) throw new Error("That message is not in the mailbox.");

  const wasOpen = existing.handledAt === null && existing.direction === "INBOUND";
  const message = await prisma.mailMessage.update({
    where: { id: existing.id },
    data: {
      triage: input.ignored ? "IGNORED" : "HANDLED",
      handledAt: new Date(),
      handledNote: input.note,
      handledById: input.userId ?? null,
    },
  });

  if (wasOpen) {
    await prisma.mailThread.updateMany({
      where: { id: existing.threadId, unreadCount: { gt: 0 } },
      data: { unreadCount: { decrement: 1 } },
    });
  }

  return { id: message.id, status: message.triage };
}

/**
 * Hands one message to a named agent.
 *
 * The deliberate half of routing — what an agent calls when the automatic
 * table got it wrong, or when the Mail Room has read something nobody could
 * place. Unlike the automatic path it does not consult the routing table at
 * all: somebody has decided, and the reason they give is what lands on the
 * task.
 */
export async function handOverMessage(input: {
  messageId: string;
  agentKey: string;
  why: string;
  by?: string;
}): Promise<{ taskId: string; agentKey: string; agentName: string }> {
  const message = await prisma.mailMessage.findUnique({
    where: { id: input.messageId },
    include: { thread: { select: { subject: true, messageCount: true } } },
  });
  if (!message) throw new Error("That message is not in the mailbox.");

  const agent = await prisma.agent.findUnique({ where: { key: input.agentKey }, select: { key: true, name: true, status: true } });
  if (!agent) throw new Error(`There is nobody on the roster with the key “${input.agentKey}”. Search it with findAgent first.`);
  if (agent.status === "RETIRED") throw new Error(`${agent.name} is retired and cannot take work.`);

  const who = message.fromName ? `${message.fromName} <${message.fromEmail}>` : message.fromEmail;
  const task = await prisma.agentTask.create({
    data: {
      agentKey: agent.key,
      title: `Reply needed: ${message.subject.slice(0, 90)}`,
      brief: [
        `${who} wrote in, and this was handed to you${input.by ? ` by ${input.by}` : ""}.`,
        "",
        `**Why it is yours:** ${input.why}`,
        message.summary ? `**In one line:** ${message.summary}` : null,
        `**Subject:** ${message.subject}`,
        `**Received:** ${message.sentAt.toUTCString()}`,
        message.leadId ? `**Lead:** ${message.leadId}` : null,
        message.clientId ? `**Client:** ${message.clientId}` : null,
        "",
        "**What they wrote:**",
        "",
        message.bodyText.slice(0, 8_000) || "(no readable text — an attachment or an image only)",
        "",
        "---",
        "",
        "Read the record before you write anything. Draft the reply into the outbox with `email.draft` and stop there — a person sends every reply this system writes.",
      ]
        .filter((line): line is string => line !== null)
        .join("\n"),
      input: {
        mailMessageId: message.id,
        mailThreadId: message.threadId,
        fromEmail: message.fromEmail,
        leadId: message.leadId,
        clientId: message.clientId,
        handedOver: true,
      } as unknown as Prisma.InputJsonValue,
      origin: "EVENT",
      priority: message.urgency ?? 2,
      leadId: message.leadId,
      clientId: message.clientId,
    },
  });

  await recordCreated(task.id, task.traceId, task.status, {
    reason: `Handed to ${agent.name}: ${input.why.slice(0, 200)}`,
    actor: input.by ?? "mailbox",
  });

  await prisma.mailMessage.update({
    where: { id: message.id },
    data: { triage: "ROUTED", routedAgentKey: agent.key, taskId: task.id, routedAt: new Date() },
  });

  return { taskId: task.id, agentKey: agent.key, agentName: agent.name };
}
