import type { MailIntent, MailMessage } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { callModel } from "../../lib/models/call.js";
import { getSetting, SETTING } from "../../lib/settings.js";
import { writerSystem } from "../writers/brief.js";

/**
 * Reading one message and saying what it is.
 *
 * The only model call in the mail room, and it is deliberately the *smallest*
 * decision in it. It does not decide who gets the work — a table in
 * `router.ts` does that, in code somebody can read — and it does not write a
 * word that reaches a customer. It answers four questions about a letter:
 * what kind of letter is this, in one sentence what does it say, how quickly
 * does it need an answer, and how sure are you.
 *
 * **Why the classification and the routing are separated.** A model that
 * chooses the agent is a model that can hand a complaint from a paying client
 * to the cold outreach writer, and no amount of prompt wording makes that
 * reliably impossible. A model that chooses between sixteen named intents can
 * be wrong in sixteen ways, all of which are visible on the screen and every
 * one of which maps to a routing decision a person approved once, in advance.
 *
 * **The confidence floor does real work.** Below it the message is labelled
 * and given to nobody, which is the honest outcome for mail this system does
 * not understand. An unrouted message sits on the Inbox screen; a confidently
 * misrouted one starts an agent writing to somebody about the wrong thing.
 */

/** Under this, the message goes to a person rather than to an agent. */
export const CONFIDENCE_FLOOR = 0.6;

const INTENTS: MailIntent[] = [
  "INTERESTED",
  "NOT_INTERESTED",
  "QUESTION",
  "MEETING_REQUEST",
  "PROPOSAL_FEEDBACK",
  "SUPPORT_ISSUE",
  "INVOICE_QUERY",
  "PAYMENT_NOTICE",
  "NEW_ENQUIRY",
  "SUPPLIER",
  "UNSUBSCRIBE",
  "AUTO_REPLY",
  "BOUNCE",
  "SPAM",
  "PERSONAL",
  "OTHER",
];

export interface Triage {
  intent: MailIntent;
  summary: string;
  urgency: number;
  needsReply: boolean;
  confidence: number;
  costUsd: number;
}

/**
 * The doctrine, and the default until the Mail Room agent's own wording
 * replaces it — see services/writers/. Everything here is judgement; the
 * shape of the answer is in CONTRACT below and no edit can reach it.
 */
export const SHIPPED_DOCTRINE = [
  "You read the post for a small web studio in Accra and say what each letter is. You are not answering it and you are not writing to anybody. Somebody downstream will do that, and they will act on what you say this letter is, so being right matters more than being decisive.",
  "",
  "How to read one:",
  "",
  "- **What did the person actually ask for.** Not what the letter is about — what they want to happen next. A long message about their business that ends in “can you send me a price” is a question about price.",
  "- **A polite no is a no.** “We're all set for now, but thank you” is NOT_INTERESTED, not a question. Reading it as anything else means somebody gets written to again.",
  "- **A machine did not write to you.** An out-of-office, a delivery receipt, a newsletter, a “do not reply to this message” — those are AUTO_REPLY, whatever they appear to say. Treating one as a reply is the single most costly mistake available here.",
  "- **A stranger asking about work is worth more than anything else in the mailbox.** NEW_ENQUIRY is somebody nobody has written to, asking about what we do.",
  "- **Say when you do not know.** OTHER with a low confidence is a real answer and a person will look at it. A confident wrong answer starts work on the wrong thing.",
  "",
  "Urgency is about what happens if it waits until tomorrow, not about how the letter is written. Somebody's site being down is urgent. Somebody being annoyed is not, by itself.",
].join("\n");

const CONTRACT = [
  "Answer as JSON with exactly these fields:",
  "",
  `- **intent** — one of: ${INTENTS.join(", ")}.`,
  "- **summary** — one sentence, under 200 characters, in plain English, saying what this person wants. Write it so somebody who has not read the email can act on it. No preamble, no “the sender says”.",
  "- **urgency** — 1 if it needs an answer today, 2 if this week, 3 if whenever.",
  "- **needsReply** — true only if a person or an agent has to write back. A receipt, a newsletter and a “thanks!” do not need a reply.",
  "- **confidence** — 0 to 1, how sure you are of the intent. Be honest: below 0.6 the message is given to a person instead, which is the right outcome when the letter is genuinely unclear.",
].join("\n");

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["intent", "summary", "urgency", "needsReply", "confidence"],
  properties: {
    intent: { type: "string", enum: INTENTS, description: "What this letter is." },
    summary: { type: "string", description: "One sentence under 200 characters saying what this person wants." },
    urgency: { type: "integer", enum: [1, 2, 3], description: "1 today, 2 this week, 3 whenever." },
    needsReply: { type: "boolean", description: "True only if somebody has to write back." },
    confidence: { type: "number", description: "0 to 1. Below 0.6 the message goes to a person instead of an agent." },
  },
} as const;

/** Whether a model may read the post at all. */
export async function triageEnabled(): Promise<boolean> {
  return (await getSetting(SETTING.MAIL_TRIAGE)) !== "false";
}

/**
 * What the model is shown.
 *
 * Assembled here rather than from the raw message for two reasons. The first
 * is cost — a quoted reply chain is ten times the size of the reply. The
 * second is accuracy: told nothing about the relationship, a model reads a
 * one-line "yes, go ahead" as spam. Whether this address is a stranger, a
 * lead we wrote to on Tuesday or a client of two years is the context that
 * decides what the sentence means.
 */
async function contextFor(message: MailMessage): Promise<string[]> {
  const lines: string[] = [];

  if (message.clientId) {
    const client = await prisma.client.findUnique({
      where: { id: message.clientId },
      select: { name: true, company: true, projects: { where: { status: { in: ["PLANNING", "IN_PROGRESS"] } }, select: { name: true } } },
    });
    if (client) {
      lines.push(`They are an existing client: ${client.company ?? client.name}.`);
      if (client.projects.length > 0) lines.push(`Live work for them: ${client.projects.map((project) => project.name).join(", ")}.`);
    }
  } else if (message.leadId) {
    const lead = await prisma.lead.findUnique({
      where: { id: message.leadId },
      select: { companyName: true, contactName: true, status: true, category: true },
    });
    if (lead) {
      lines.push(
        `They are a lead, not yet a client: ${lead.companyName ?? lead.contactName}${lead.category ? `, a ${lead.category}` : ""} — currently ${lead.status.toLowerCase()}.`,
      );
    }
  } else {
    lines.push("Nobody in this system has this address. As far as the records go, they have never been written to.");
  }

  if (message.replyToEmailId) {
    const sent = await prisma.emailMessage.findUnique({
      where: { id: message.replyToEmailId },
      select: { subject: true, purpose: true, sentAt: true },
    });
    if (sent) {
      lines.push(
        `This answers an email we sent${sent.sentAt ? ` on ${sent.sentAt.toDateString()}` : ""}: “${sent.subject}” (${sent.purpose.toLowerCase().replace(/_/g, " ")}).`,
      );
    }
  }

  if (message.autoSubmitted) {
    lines.push("The headers on this message say a machine sent it. Weigh that heavily.");
  }
  if (message.hasAttachments) {
    const names = (message.attachments as { filename?: string }[]).map((file) => file.filename).filter(Boolean);
    if (names.length > 0) lines.push(`Attached: ${names.join(", ")}.`);
  }

  return lines;
}

/**
 * Reads one message.
 *
 * Throws when no model can serve it, which is a state the caller records on
 * the row as a failure rather than swallowing — mail that was never read must
 * not be indistinguishable from mail that was read and found uninteresting.
 */
export async function triageMessage(message: MailMessage): Promise<Triage> {
  const context = await contextFor(message);

  const result = await callModel<Omit<Triage, "costUsd">>({
    purpose: "mailbox.triage",
    job: "triage",
    system: await writerSystem("mail.triage", SHIPPED_DOCTRINE, { contract: CONTRACT }),
    prompt: () =>
      [
        `From: ${message.fromName ? `${message.fromName} <${message.fromEmail}>` : message.fromEmail}`,
        `Subject: ${message.subject}`,
        "",
        ...(context.length > 0 ? ["What is already known about them:", ...context.map((line) => `- ${line}`), ""] : []),
        "The message:",
        "---",
        // Already trimmed of its quoted history by parse.ts, and capped again
        // here because one pasted contract should not become the most
        // expensive call this app makes today.
        message.bodyText.slice(0, 6_000) || "(the message has no readable text — it may be an image or an attachment only)",
        "---",
      ].join("\n"),
    schema: SCHEMA as unknown as Record<string, unknown>,
    effort: "low",
    maxTokens: 1_000,
    messages: {
      noKey:
        "No model is connected that can read incoming mail, so this message was filed but not sorted. Add a Claude, Gemini or ChatGPT key under Settings → AI models — any of them can do it.",
      refusal: "The model would not classify this message.",
      empty: "Nothing came back from reading this message.",
    },
  });

  const raw = result.data;
  return {
    intent: INTENTS.includes(raw.intent) ? raw.intent : "OTHER",
    summary: (raw.summary ?? "").trim().slice(0, 300) || "(no summary)",
    // Clamped rather than trusted: `minimum`/`maximum` are stripped out of the
    // schema before it reaches any vendor, so the limits in the description
    // are guidance and this is the enforcement.
    urgency: Math.min(3, Math.max(1, Math.round(Number(raw.urgency) || 2))),
    needsReply: Boolean(raw.needsReply),
    confidence: Math.min(1, Math.max(0, Number(raw.confidence) || 0)),
    costUsd: result.costUsd,
  };
}
