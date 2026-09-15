import type { EmailMessage } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { approvalFingerprint, whatChanged, type ApprovalSubject } from "./approval.js";
import { moveStage } from "./stage.js";

/**
 * The two things that must be true before a concept's letter leaves, and the
 * one claim that makes sure it leaves once.
 *
 * **Approval is about content, not about a moment.** Everything a person
 * approved stays editable afterwards, and every one of those edits is
 * legitimate — a price corrected, a sentence rewritten, a page rebuilt. What is
 * not legitimate is the send that follows still calling itself approved. So the
 * fingerprint is recomputed here, against the same four things, and a
 * difference sends the lead back for review with the change named rather than
 * quietly going out.
 *
 * **Duplicate protection is at the lead, not at the message.** The row-level
 * check — "is this message already SENT" — is necessary and was never
 * sufficient: two drafts for the same lead are two different rows, both DRAFT,
 * both sendable, and the prospect gets two first letters from a company they
 * have never heard of. That is the version of this failure that actually
 * happens, because a rebuild or a redraft is exactly what produces the second
 * row. `LeadConcept.initialSendClaimedAt` is the lead-level claim, and a
 * conditional update is what makes it atomic: two concurrent senders both try,
 * the database lets one through, and the loser is told who won.
 */

export interface SendClaim {
  ok: boolean;
  /** Why not. Shown to a person, so it names the lead's state rather than a code. */
  reason: string | null;
  /** The message that holds the claim, when somebody else holds it. */
  heldBy: string | null;
}

/** The purposes that count as a first approach. A follow-up is a separate decision. */
export const INITIAL_PURPOSES = ["COLD_OUTREACH", "DEMO_READY"];

/**
 * Rebuilds the fingerprint from what is in the database right now.
 *
 * Deliberately re-reads the page rather than trusting the stored version
 * number: a rebuild that leaves the version alone still changes what the
 * prospect opens, and the version is the thing a bug is most likely to forget
 * to bump.
 */
export async function currentSubject(message: EmailMessage): Promise<ApprovalSubject> {
  const concept = message.leadId ? await prisma.leadConcept.findUnique({ where: { leadId: message.leadId } }) : null;
  const demo = concept?.demoId ? await prisma.demo.findUnique({ where: { id: concept.demoId } }) : null;
  const proposal = message.proposalId ? await prisma.proposal.findUnique({ where: { id: message.proposalId } }) : null;

  return {
    demoHtml: demo?.html ?? null,
    demoSlug: demo?.slug ?? null,
    proposalId: proposal?.id ?? null,
    proposalUpdatedAt: proposal?.updatedAt ?? null,
    toEmail: message.toEmail,
    emailSubject: message.subject,
    emailBodyHtml: message.bodyHtml,
    emailBodyText: message.bodyText,
  };
}

/**
 * Claims the one initial send for this lead, and checks that what is about to
 * go is what was approved.
 *
 * Returns `ok` only when both hold. Nothing here sends anything; the caller
 * does that and then calls `settleSend`.
 *
 * A lead with no concept row is not part of this workflow at all — an invoice
 * to a client, a reply in a thread — and passes straight through. This is the
 * one place where doing nothing is the correct answer, and it is written out
 * rather than left implicit because the opposite reading would put every email
 * this company sends behind a review queue.
 */
export async function claimSend(message: EmailMessage, options: { by?: string | null } = {}): Promise<SendClaim> {
  if (!message.leadId) return { ok: true, reason: null, heldBy: null };
  const concept = await prisma.leadConcept.findUnique({ where: { leadId: message.leadId } });
  if (!concept) return { ok: true, reason: null, heldBy: null };

  const initial = INITIAL_PURPOSES.includes(message.purpose);

  // An approval covers this message only when it was this message that was
  // approved. A second draft for the same lead inherits nothing.
  if (concept.emailMessageId === message.id) {
    if (!concept.approvalFingerprint || !concept.approvedAt) {
      return { ok: false, reason: "This letter has not been approved yet.", heldBy: null };
    }
    const now = await currentSubject(message);
    if (approvalFingerprint(now) !== concept.approvalFingerprint) {
      // Named rather than merely detected. "Something changed" sends somebody
      // hunting through a page, a proposal and two email bodies.
      const approved = (concept.approvalSubject ?? null) as ApprovalSubject | null;
      const changed = approved ? whatChanged(approved, now) : [];
      await moveStage(message.leadId, "NEEDS_REVIEW", {
        by: options.by ?? null,
        reason: `Something changed after this was approved${changed.length ? ` (${changed.join(", ")})` : ""}, so the approval no longer covers what would be sent.`,
      });
      return {
        ok: false,
        reason: "The preview, proposal, recipient or letter has changed since this was approved. It has to be approved again.",
        heldBy: null,
      };
    }
  } else if (initial) {
    return {
      ok: false,
      reason: "This lead's approved first letter is a different message. Approve this one, or send the approved one.",
      heldBy: concept.emailMessageId,
    };
  }

  if (!initial) return { ok: true, reason: null, heldBy: null };

  // The atomic half. One conditional update; the database picks the winner.
  const claimed = await prisma.leadConcept.updateMany({
    where: { leadId: message.leadId, initialSendClaimedAt: null },
    data: { initialSendClaimedAt: new Date(), emailMessageId: message.id, stage: "SENDING" },
  });
  if (claimed.count === 1) return { ok: true, reason: null, heldBy: null };

  const holder = await prisma.leadConcept.findUnique({ where: { leadId: message.leadId } });
  // Re-entry by the same message is not a duplicate: a retry of a send that
  // crashed between the claim and the socket has to be able to proceed.
  if (holder?.emailMessageId === message.id) return { ok: true, reason: null, heldBy: message.id };
  return {
    ok: false,
    reason: "A first letter to this lead has already been claimed for sending. Only one goes out.",
    heldBy: holder?.emailMessageId ?? null,
  };
}

/**
 * What happened to the send, recorded against the lead.
 *
 * Three outcomes, and the third is the one worth the code. A send that threw
 * without the server ever refusing it — a socket closed mid-DATA, a timeout —
 * may have arrived. Marking it failed invites a retry that is a second letter;
 * marking it sent hides a lead that never heard from us. So it is held, said
 * to be uncertain, and a person reconciles it against the mailbox.
 */
export async function settleSend(
  leadId: string | null,
  outcome: { sent: boolean; uncertain?: boolean; reason?: string | null },
  options: { by?: string | null } = {},
): Promise<void> {
  if (!leadId) return;
  const concept = await prisma.leadConcept.findUnique({ where: { leadId } });
  if (!concept) return;

  if (outcome.sent) {
    await moveStage(leadId, "SENT", { by: options.by ?? null, data: { sentAt: new Date(), sendUncertain: false } });
    return;
  }

  if (outcome.uncertain) {
    // Stays SENDING on purpose: the claim is not released, so nothing can send
    // a second one while a person works out whether the first arrived.
    await moveStage(leadId, "SENDING", {
      by: options.by ?? null,
      reason: `The send neither succeeded nor provably failed: ${outcome.reason ?? "no detail"} Check the mailbox before anything else is sent to them.`,
      data: { sendUncertain: true },
    });
    return;
  }

  // A provable refusal — the server said no. The claim is released, because
  // nothing was delivered and the next attempt is the first attempt.
  await moveStage(leadId, "APPROVED", {
    by: options.by ?? null,
    reason: `The send was refused: ${outcome.reason ?? "no detail"}`,
    data: { initialSendClaimedAt: null, sendUncertain: false },
  });
}
