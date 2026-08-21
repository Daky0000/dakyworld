import { Prisma, type MailIntent, type MailMessage, type MailThread } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { getSetting, SETTING } from "../../lib/settings.js";
import { recordCreated } from "../agents/state.js";
import { CONFIDENCE_FLOOR } from "./triage.js";

/**
 * Who a message belongs to.
 *
 * This is the half of the mail room that is **code rather than judgement**,
 * and that is the whole design. The model in `triage.ts` says what a letter
 * is; this table says what happens to each kind of letter, and it is a table
 * so that the answer to "why did the invoice chaser get this?" is a line
 * somebody can read rather than a prompt somebody has to trust.
 *
 * Three rules hold it:
 *
 *  1. **The relationship changes the destination, not the intent.** The same
 *     question from a stranger and from a client of two years is the same
 *     question and two different jobs — one is a sale, the other is support.
 *  2. **A retired or paused agent is not a destination.** The fallback chain
 *     ends at the Mail Room itself, and then at nobody, which puts the message
 *     on the Inbox screen for a person. Silently handing work to an agent
 *     nobody has switched on is the same as losing it.
 *  3. **Some letters route to nobody on purpose.** A bounce, an out-of-office
 *     and a clear no have already had everything done about them that should
 *     be done — see `consequences.ts`. Raising a task for each would spend a
 *     model call to conclude that there is nothing to do.
 */

/** The agent that owns the mailbox, and the last stop before a person. */
export const MAIL_ROOM_KEY = "mail.room";

interface Destination {
  /** Null routes to nobody deliberately — the reason is shown on the screen. */
  agentKey: string | null;
  /** Why, in the words that go on the task and on the Inbox screen. */
  because: string;
}

/**
 * Where each kind of letter goes.
 *
 * `known` is the destination when the sender is a client we already work with;
 * `stranger` is everything else — a lead, or somebody nobody has a record of.
 * Where the two are the same the relationship genuinely does not change the
 * job.
 */
const ROUTES: Record<MailIntent, { known: Destination; stranger: Destination }> = {
  INTERESTED: {
    known: { agentKey: "cco", because: "A client wants to go ahead with something." },
    stranger: { agentKey: "outreach.followup", because: "They answered our approach and want to carry on — this is the reply that matters most." },
  },
  NOT_INTERESTED: {
    known: { agentKey: "cco", because: "A client has declined something. Worth a person knowing, not worth a chase." },
    stranger: { agentKey: null, because: "They said no. The sequences they were in have stopped and nothing else should happen automatically." },
  },
  QUESTION: {
    known: { agentKey: "support.desk", because: "A client asked a question about work we are doing." },
    stranger: { agentKey: "outreach.followup", because: "A prospect asked something before deciding." },
  },
  MEETING_REQUEST: {
    known: { agentKey: "cco", because: "A client wants to talk." },
    stranger: { agentKey: "outreach.followup", because: "They want to talk — the hardest yes to get and the easiest to lose by being slow." },
  },
  PROPOSAL_FEEDBACK: {
    known: { agentKey: "proposal.writer", because: "A response to a proposal that was sent." },
    stranger: { agentKey: "proposal.writer", because: "A response to a proposal that was sent." },
  },
  SUPPORT_ISSUE: {
    known: { agentKey: "support.desk", because: "Something is wrong with work we delivered." },
    stranger: { agentKey: "support.desk", because: "Somebody is reporting a problem, though there is no client record for them." },
  },
  INVOICE_QUERY: {
    known: { agentKey: "billing.invoicer", because: "A query about an invoice — the document, the amount or the dates." },
    stranger: { agentKey: "billing.invoicer", because: "A query about an invoice." },
  },
  PAYMENT_NOTICE: {
    known: { agentKey: "billing.collector", because: "They say they have paid. It needs matching against what actually arrived." },
    stranger: { agentKey: "billing.collector", because: "A payment notice." },
  },
  // The roster has no inbound-enquiry writer, and this is the closest craft
  // that exists: first-line response, judged against what the records
  // actually say. If this turns out to be the busiest route in the mailbox,
  // that is the evidence for hiring one — which is what `AgentGap` is for.
  NEW_ENQUIRY: {
    known: { agentKey: "support.desk", because: "An enquiry from an address we already know." },
    stranger: { agentKey: "support.desk", because: "Somebody nobody has written to is asking about work. This is worth more than any scraped row on the list." },
  },
  SUPPLIER: {
    known: { agentKey: null, because: "A supplier, a host or a bank writing to the company. Filed for a person." },
    stranger: { agentKey: null, because: "A supplier, a host or a bank writing to the company. Filed for a person." },
  },
  UNSUBSCRIBE: {
    known: { agentKey: null, because: "They asked to be removed. That has been done — the address is suppressed and every sequence stopped." },
    stranger: { agentKey: null, because: "They asked to be removed. That has been done — the address is suppressed and every sequence stopped." },
  },
  AUTO_REPLY: {
    known: { agentKey: null, because: "A machine sent this. Nothing was stopped and nobody was told." },
    stranger: { agentKey: null, because: "A machine sent this. Nothing was stopped and nobody was told." },
  },
  BOUNCE: {
    known: { agentKey: null, because: "A delivery failure. The address has been suppressed." },
    stranger: { agentKey: null, because: "A delivery failure. The address has been suppressed." },
  },
  SPAM: {
    known: { agentKey: null, because: "Junk." },
    stranger: { agentKey: null, because: "Junk." },
  },
  PERSONAL: {
    known: { agentKey: null, because: "Not business. Filed and left alone." },
    stranger: { agentKey: null, because: "Not business. Filed and left alone." },
  },
  OTHER: {
    known: { agentKey: MAIL_ROOM_KEY, because: "Nothing in the list fits it, so the Mail Room decides where it belongs." },
    stranger: { agentKey: MAIL_ROOM_KEY, because: "Nothing in the list fits it, so the Mail Room decides where it belongs." },
  },
};

/**
 * The kinds of message that are never owed an answer.
 *
 * Not a cosmetic filter. The Inbox screen is a to-do list — "what is still
 * owed a reply" — and the first render of it put a bounce and an out-of-office
 * at the top of that list, above a stranger asking for a quote. A list that
 * fills with machine mail is a list somebody stops reading, and then the
 * enquiry is lost for exactly the reason this module was built to prevent.
 *
 * Everything here is still filed, still counted and still on the Everything
 * tab. It simply is not work.
 */
export const NEEDS_NO_REPLY: MailIntent[] = ["AUTO_REPLY", "BOUNCE", "SPAM", "PERSONAL", "SUPPLIER"];

export interface RoutingDecision {
  agentKey: string | null;
  because: string;
  taskId: string | null;
  /** Said out loud on the screen when the message was deliberately given to nobody. */
  note: string | null;
}

/** Whether triage may hand work to agents, or only label it for a person. */
export async function autoRouteEnabled(): Promise<boolean> {
  return (await getSetting(SETTING.MAIL_AUTOROUTE)) !== "false";
}

export function destinationFor(intent: MailIntent, isClient: boolean): Destination {
  const route = ROUTES[intent] ?? ROUTES.OTHER;
  return isClient ? route.known : route.stranger;
}

/**
 * The first agent in the chain that can actually take work.
 *
 * A destination naming an agent that is DRAFT, PAUSED or RETIRED is not a
 * destination. Falls back to the Mail Room, and then to nobody.
 */
async function liveAgent(preferred: string | null): Promise<{ key: string | null; note: string | null }> {
  if (!preferred) return { key: null, note: null };

  const agent = await prisma.agent.findUnique({ where: { key: preferred }, select: { key: true, status: true, name: true } });
  if (agent?.status === "ACTIVE") return { key: agent.key, note: null };

  const room = await prisma.agent.findUnique({ where: { key: MAIL_ROOM_KEY }, select: { key: true, status: true } });
  const why = agent ? `${agent.name} is ${agent.status.toLowerCase()}` : `there is no “${preferred}” on this roster`;
  if (room?.status === "ACTIVE") return { key: room.key, note: `Meant for ${preferred}, but ${why} — the Mail Room has it instead.` };
  return { key: null, note: `Meant for ${preferred}, but ${why}, and the Mail Room is not active either. Nobody has this.` };
}

/**
 * Hands one classified message to whoever owns it.
 *
 * Idempotent on `message.taskId`: a message that has already been routed is
 * never routed twice, which matters because a folder can be re-read and a
 * triage can be re-run by hand from the Inbox screen.
 */
export async function routeMessage(message: MailMessage, thread: MailThread): Promise<RoutingDecision> {
  if (message.taskId) {
    return { agentKey: message.routedAgentKey, because: "Already routed.", taskId: message.taskId, note: null };
  }
  if (!message.intent) {
    return { agentKey: null, because: "Not read yet, so there is nobody to give it to.", taskId: null, note: null };
  }

  const destination = destinationFor(message.intent, Boolean(message.clientId));

  if (destination.agentKey === null) {
    return { agentKey: null, because: destination.because, taskId: null, note: null };
  }

  // A model that is not sure is a model that should not be starting work. The
  // message keeps its intent and its summary and waits on the Inbox screen.
  if ((message.confidence ?? 0) < CONFIDENCE_FLOOR) {
    return {
      agentKey: null,
      because: destination.because,
      taskId: null,
      note: `Read as ${message.intent.toLowerCase().replace(/_/g, " ")}, but not confidently enough to hand to ${destination.agentKey}. Left for you.`,
    };
  }

  if (!(await autoRouteEnabled())) {
    return {
      agentKey: null,
      because: destination.because,
      taskId: null,
      note: `Would have gone to ${destination.agentKey}. Handing mail to agents is switched off under Settings → Email.`,
    };
  }

  const { key, note } = await liveAgent(destination.agentKey);
  if (!key) return { agentKey: null, because: destination.because, taskId: null, note };

  const task = await prisma.agentTask.create({
    data: {
      agentKey: key,
      title: `Reply needed: ${message.subject.slice(0, 90)}`,
      brief: briefFor(message, thread, destination.because),
      input: {
        mailMessageId: message.id,
        mailThreadId: thread.id,
        fromEmail: message.fromEmail,
        leadId: message.leadId,
        clientId: message.clientId,
        replyToEmailId: message.replyToEmailId,
        intent: message.intent,
      } as unknown as Prisma.InputJsonValue,
      origin: "EVENT",
      priority: message.urgency ?? 2,
      leadId: message.leadId,
      clientId: message.clientId,
    },
  });

  await recordCreated(task.id, task.traceId, task.status, {
    reason: `${message.fromEmail} wrote in — read as ${message.intent.toLowerCase().replace(/_/g, " ")}.`,
    actor: "mailbox",
  });

  await prisma.mailMessage.update({
    where: { id: message.id },
    data: { triage: "ROUTED", routedAgentKey: key, taskId: task.id, routedAt: new Date() },
  });

  return { agentKey: key, because: destination.because, taskId: task.id, note };
}

/**
 * What the agent is actually told.
 *
 * The message is quoted in full rather than summarised, because the summary is
 * one model's reading of it and the agent about to write a reply should work
 * from the words the person used. The closing paragraph is the standing rule
 * and it is repeated on every one of these deliberately: an agent that drafts
 * a reply and sends it without anybody reading it is the failure this whole
 * module has to not become.
 */
function briefFor(message: MailMessage, thread: MailThread, because: string): string {
  const who = message.fromName ? `${message.fromName} <${message.fromEmail}>` : message.fromEmail;
  // Conditional lines are dropped as nulls rather than as empty strings, so
  // the blank lines that are actually paragraph breaks survive the filter.
  const facts = [
    message.summary ? `**In one line:** ${message.summary}` : null,
    `**Subject:** ${message.subject}`,
    `**Received:** ${message.sentAt.toUTCString()}`,
    message.leadId ? `**Lead:** ${message.leadId}` : null,
    message.clientId ? `**Client:** ${message.clientId}` : null,
    message.replyToEmailId ? `**This answers an email we sent** (outbox id ${message.replyToEmailId}).` : null,
    thread.messageCount > 1 ? `**Conversation so far:** ${thread.messageCount} messages, starting “${thread.subject}”.` : null,
  ].filter((line): line is string => line !== null);

  return [
    `${who} wrote in. ${because}`,
    "",
    facts.join("\n"),
    "",
    "**What they wrote:**",
    "",
    message.bodyText.slice(0, 8_000) || "(no readable text — an attachment or an image only)",
    "",
    "---",
    "",
    "Read the record before you write anything: what has already been sent to this person, what was promised, and what is actually true about their account. Then draft the reply.",
    "",
    "**Draft it into the outbox with `email.draft` and stop there.** Do not send. A person reads every reply this system writes before it leaves the building, and a draft they have to send is the point — not an obstacle to route around. If answering needs something you do not have, escalate and say what it is.",
  ].join("\n");
}
