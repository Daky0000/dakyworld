import type { EmailSequence, EmailSequenceStep, Lead } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { safeZone, zonedDateParts, zonedTimeToUtc } from "../lib/timezone.js";
import { AnalystError } from "../lib/anthropic.js";
import { draftEmail } from "../lib/emailDrafter.js";
import { resolveContext } from "./emailContext.js";
import { composeMessage, isSuppressed, sendMessage } from "./emailSender.js";

/**
 * Sequences — the follow-up nobody remembers to send by hand, which is where
 * most of a cold pipeline is actually lost.
 *
 * An enrolment is one person moving through one sequence. It carries the only
 * two pieces of state that matter: which step is next, and when. Both are
 * advanced *before* the email is built, on the same reasoning as the billing
 * scheduler — a step that fails must not be retried in a loop, and a restart
 * must not resend the step that was in flight.
 *
 * **Three ways a sequence stops**, and all of them are checked at send time
 * rather than at enrolment: the address is suppressed, the lead has moved out
 * of the pipeline (converted, disqualified, lost), or someone replied.
 *
 * `stopOnReply` is called by three things now: the mail room, when a reply is
 * read out of the mailbox (`services/mailbox/consequences.ts`); the phone side,
 * on an inbound WhatsApp or SMS; and a person logging a reply by hand, which is
 * still how a phone call gets recorded. It was only the third of those until
 * August 2026, which is why a sequence could go on writing to somebody who had
 * already answered.
 */

type SequenceWithSteps = EmailSequence & { steps: EmailSequenceStep[] };

/** Statuses that mean the pipeline has moved on and a follow-up would be wrong. */
const DEAD_LEAD_STATUSES = new Set(["CONVERTED", "DISQUALIFIED", "LOST"]);

// --- Scheduling ------------------------------------------------------------

/**
 * The next moment inside the sequence's own sending window. Business email
 * that lands at 3am on Sunday reads as automation, which is exactly what it
 * must not read as.
 */
export function nextSendSlot(sequence: Pick<EmailSequence, "sendWindowStart" | "sendWindowEnd" | "weekdaysOnly" | "timezone">, after: Date): Date {
  const zone = safeZone(sequence.timezone);
  const start = Math.min(23, Math.max(0, sequence.sendWindowStart));
  const end = Math.min(23, Math.max(start + 1, sequence.sendWindowEnd));

  for (let dayOffset = 0; dayOffset < 14; dayOffset += 1) {
    const [year, month, day] = zonedDateParts(after, zone);
    const windowOpen = zonedTimeToUtc(year, month, day + dayOffset, start, 0, zone);
    const windowClose = zonedTimeToUtc(year, month, day + dayOffset, end, 0, zone);

    if (sequence.weekdaysOnly) {
      // The weekday of the *local* date this window belongs to. Reading
      // getUTCDay off the instant would be a day out near midnight in a
      // shifted zone, which is how a sequence ends up sending on a Sunday.
      const [localYear, localMonth, localDay] = zonedDateParts(windowOpen, zone);
      const weekday = new Date(Date.UTC(localYear, localMonth - 1, localDay)).getUTCDay();
      if (weekday === 0 || weekday === 6) continue;
    }

    const candidate = after.getTime() > windowOpen.getTime() ? after : windowOpen;
    if (candidate.getTime() < windowClose.getTime()) return candidate;
  }
  // A window that can never open (nonsense configuration) still has to return
  // something rather than hanging the enrolment forever.
  return after;
}

function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * 86_400_000);
}

// --- Enrolment -------------------------------------------------------------

export interface EnrolResult {
  enrolled: boolean;
  reason?: string;
  enrollmentId?: string;
}

/**
 * Puts one lead or client into a sequence. Refuses politely rather than
 * throwing: enrolling 200 leads at once, half of which have no address, is the
 * normal case and should report rather than fail.
 */
export async function enrol(args: { sequenceId: string; leadId?: string; clientId?: string }): Promise<EnrolResult> {
  const sequence = await prisma.emailSequence.findUnique({ where: { id: args.sequenceId }, include: { steps: true } });
  if (!sequence) return { enrolled: false, reason: "No such sequence" };
  if (sequence.steps.length === 0) return { enrolled: false, reason: "That sequence has no steps yet" };

  // A rehearsal's scratch lead is a real row against a real business, and
  // `leadPrep` fills its contact fields from that business's own homepage. So
  // by the time a rehearsal has been running ten minutes there is a genuine
  // address on it, and the one thing that must never happen is a sequence
  // starting against it. Refused here rather than at each caller: this is the
  // only door into a sequence, for the tool, the trigger and a person alike.
  if (args.leadId) {
    const lead = await prisma.lead.findUnique({ where: { id: args.leadId }, select: { rehearsal: true } });
    if (lead?.rehearsal) {
      return { enrolled: false, reason: "That lead belongs to a rehearsal. Nothing in a rehearsal is ever written to." };
    }
  }

  const context = await resolveContext({ leadId: args.leadId, clientId: args.clientId });
  if (!context.email) return { enrolled: false, reason: `${context.name ?? "This contact"} has no email address` };
  if (await isSuppressed(context.email)) return { enrolled: false, reason: `${context.email} has unsubscribed` };

  const existing = await prisma.emailEnrollment.findFirst({
    where: { sequenceId: sequence.id, leadId: args.leadId ?? undefined, clientId: args.clientId ?? undefined },
  });
  if (existing) {
    return existing.status === "ACTIVE"
      ? { enrolled: false, reason: "Already in this sequence", enrollmentId: existing.id }
      : { enrolled: false, reason: `Already went through this sequence (${existing.status.toLowerCase()})`, enrollmentId: existing.id };
  }

  const first = sequence.steps.sort((a, b) => a.position - b.position)[0];
  const enrollment = await prisma.emailEnrollment.create({
    data: {
      sequenceId: sequence.id,
      leadId: args.leadId ?? null,
      clientId: args.clientId ?? null,
      toEmail: context.email,
      nextPosition: first.position,
      nextSendAt: nextSendSlot(sequence, addDays(new Date(), first.delayDays)),
    },
  });
  return { enrolled: true, enrollmentId: enrollment.id };
}

export async function stopEnrollment(id: string, reason: string) {
  await prisma.emailEnrollment.update({
    where: { id },
    data: { status: "STOPPED", stopReason: reason, nextSendAt: null, completedAt: new Date() },
  });
  // Anything already queued for them is pulled back too — stopping a sequence
  // that still has a scheduled email in it has stopped nothing.
  await prisma.emailMessage.updateMany({
    where: { enrollmentId: id, status: { in: ["DRAFT", "SCHEDULED"] } },
    data: { status: "CANCELLED", error: `Sequence stopped: ${reason}` },
  });
}

/** Someone replied. Every sequence that person is in stops, not just the one they replied to. */
export async function stopOnReply(args: { leadId?: string; clientId?: string; email?: string }) {
  const enrollments = await prisma.emailEnrollment.findMany({
    where: {
      status: "ACTIVE",
      OR: [
        args.leadId ? { leadId: args.leadId } : {},
        args.clientId ? { clientId: args.clientId } : {},
        args.email ? { toEmail: args.email } : {},
      ].filter((clause) => Object.keys(clause).length > 0),
      sequence: { stopOnReply: true },
    },
    select: { id: true },
  });
  for (const enrollment of enrollments) await stopEnrollment(enrollment.id, "They replied");
  return enrollments.length;
}

// --- Running ---------------------------------------------------------------

/** Whether this enrolment should still be running at all. */
async function stopCheck(enrollment: { id: string; leadId: string | null; toEmail: string }): Promise<string | null> {
  const suppressed = await isSuppressed(enrollment.toEmail);
  if (suppressed) return `${enrollment.toEmail} unsubscribed`;

  if (enrollment.leadId) {
    const lead = await prisma.lead.findUnique({ where: { id: enrollment.leadId }, select: { status: true } });
    if (!lead) return "The lead was deleted";
    if (DEAD_LEAD_STATUSES.has(lead.status)) return `The lead is now ${lead.status.toLowerCase()}`;
  }
  return null;
}

/** Builds the message for one step — from its template, its inline body, or the drafter. */
async function buildStepMessage(
  sequence: SequenceWithSteps,
  step: EmailSequenceStep,
  enrollment: { id: string; leadId: string | null; clientId: string | null; toEmail: string },
) {
  let subject = step.subject ?? "";
  let body = step.bodyHtml ?? "";

  if (step.templateId) {
    const template = await prisma.emailTemplate.findUnique({ where: { id: step.templateId } });
    if (template) {
      subject = subject || template.subject;
      body = body || template.bodyHtml;
    }
  }

  if (step.useAi) {
    const context = await resolveContext({ leadId: enrollment.leadId, clientId: enrollment.clientId, toEmail: enrollment.toEmail });
    // A step that fails to draft falls back to whatever was written by hand;
    // only a step with nothing else to send is a real failure.
    try {
      const draft = await draftEmail({
        purpose: step.purpose,
        context,
        brief: step.aiBrief,
        existingSubject: subject || null,
        existingBody: body || null,
      });
      subject = draft.subject;
      body = draft.body;
    } catch (err) {
      if (!subject || !body) throw err instanceof AnalystError ? err : new Error(`Could not draft step ${step.position + 1}: ${(err as Error).message}`);
      console.warn(`[email] step ${step.position + 1} of "${sequence.name}" fell back to its written copy: ${(err as Error).message}`);
    }
  }

  if (!subject || !body) throw new Error(`Step ${step.position + 1} of "${sequence.name}" has no content`);

  // A follow-up threads under the first email of the sequence rather than
  // arriving as an unrelated new conversation.
  const firstSent = await prisma.emailMessage.findFirst({
    where: { enrollmentId: enrollment.id, status: "SENT", messageId: { not: null } },
    orderBy: { sentAt: "asc" },
    select: { messageId: true },
  });

  const message = await composeMessage({
    subject,
    body,
    purpose: step.purpose,
    kind: "SEQUENCE",
    toEmail: enrollment.toEmail,
    leadId: enrollment.leadId,
    clientId: enrollment.clientId,
    templateId: step.templateId,
    stepId: step.id,
    enrollmentId: enrollment.id,
    status: sequence.requireApproval ? "DRAFT" : "SCHEDULED",
    scheduledFor: sequence.requireApproval ? null : new Date(),
  });

  if (firstSent?.messageId) {
    await prisma.emailMessage.update({ where: { id: message.id }, data: { inReplyTo: firstSent.messageId } });
  }
  return message;
}

/** Moves an enrolment to its next step, or completes it. */
async function advance(sequence: SequenceWithSteps, enrollmentId: string, currentPosition: number) {
  const next = sequence.steps.filter((step) => step.position > currentPosition).sort((a, b) => a.position - b.position)[0];
  if (!next) {
    await prisma.emailEnrollment.update({
      where: { id: enrollmentId },
      data: { status: "COMPLETED", nextSendAt: null, completedAt: new Date() },
    });
    return;
  }
  await prisma.emailEnrollment.update({
    where: { id: enrollmentId },
    data: { nextPosition: next.position, nextSendAt: nextSendSlot(sequence, addDays(new Date(), next.delayDays)) },
  });
}

/**
 * The scheduler's half. Every due enrolment gets one step built and sent, then
 * is moved on. Deliberately capped per tick: a hundred enrolments coming due
 * at 08:00 should trickle out over a few minutes rather than arrive as one
 * burst that a mail server treats as a spam run.
 */
export async function runDueSequences(now = new Date(), limit = 10): Promise<number> {
  const due = await prisma.emailEnrollment.findMany({
    where: { status: "ACTIVE", nextSendAt: { lte: now }, sequence: { active: true } },
    orderBy: { nextSendAt: "asc" },
    take: limit,
    include: { sequence: { include: { steps: true } } },
  });
  if (due.length === 0) return 0;

  let sent = 0;
  for (const enrollment of due) {
    const sequence = enrollment.sequence;
    const step = sequence.steps.find((candidate) => candidate.position === enrollment.nextPosition);

    if (!step) {
      // The step was deleted out from under a live enrolment.
      await advance(sequence, enrollment.id, enrollment.nextPosition);
      continue;
    }

    const stop = await stopCheck(enrollment);
    if (stop) {
      await stopEnrollment(enrollment.id, stop);
      continue;
    }

    // Advance first: this slot is spent whatever happens next.
    await advance(sequence, enrollment.id, step.position);

    try {
      const message = await buildStepMessage(sequence, step, enrollment);
      if (sequence.requireApproval) {
        console.log(`[email] "${sequence.name}" step ${step.position + 1} drafted for ${enrollment.toEmail} — waiting for approval`);
      } else {
        const result = await sendMessage(message.id);
        if (result.sent) sent += 1;
      }
    } catch (err) {
      console.error(`[email] "${sequence.name}" step ${step.position + 1} failed for ${enrollment.toEmail}:`, (err as Error).message);
    }
  }
  return sent;
}

// --- Automatic enrolment ---------------------------------------------------

interface LeadFilter {
  status?: string;
  minScore?: number;
  source?: string;
  city?: string;
  /** Only leads with no website — the segment the whole pitch is built around. */
  noWebsiteOnly?: boolean;
}

function leadMatches(lead: Lead, filter: LeadFilter | null): boolean {
  if (!filter) return true;
  if (filter.status && lead.status !== filter.status) return false;
  if (filter.minScore !== undefined && lead.leadScore < filter.minScore) return false;
  if (filter.source && lead.source !== filter.source) return false;
  if (filter.city && (lead.city ?? "").toLowerCase() !== filter.city.toLowerCase()) return false;
  if (filter.noWebsiteOnly && lead.website) return false;
  return true;
}

/**
 * Called when leads arrive — from a scrape, an import, or by hand. Any active
 * LEAD_CREATED sequence whose filter they match picks them up.
 *
 * Never throws into its caller: a lead capture run must not fail because a
 * sequence is misconfigured.
 */
export async function enrolNewLeads(leadIds: string[]): Promise<number> {
  if (leadIds.length === 0) return 0;
  try {
    const sequences = await prisma.emailSequence.findMany({
      where: { active: true, trigger: "LEAD_CREATED" },
      include: { steps: true },
    });
    if (sequences.length === 0) return 0;

    const leads = await prisma.lead.findMany({ where: { id: { in: leadIds }, contactEmail: { not: null } } });
    let enrolled = 0;

    for (const sequence of sequences) {
      if (sequence.steps.length === 0) continue;
      const filter = (sequence.triggerFilter ?? null) as LeadFilter | null;
      for (const lead of leads) {
        if (!leadMatches(lead, filter)) continue;
        const result = await enrol({ sequenceId: sequence.id, leadId: lead.id });
        if (result.enrolled) enrolled += 1;
      }
    }
    if (enrolled > 0) console.log(`[email] auto-enrolled ${enrolled} new lead(s)`);
    return enrolled;
  } catch (err) {
    console.error("[email] auto-enrolment failed:", (err as Error).message);
    return 0;
  }
}
