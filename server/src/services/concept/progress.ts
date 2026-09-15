import { prisma } from "../../lib/prisma.js";
import { moveStage } from "./stage.js";

/**
 * The three places the rest of the app has to tell the workflow that something
 * happened: an audit finished, a proposal was written, a letter was drafted.
 *
 * Each of these is a one-line call from code that has other work to do, so
 * every one of them is **silent when the lead is not in the workflow** and
 * **never throws**. A proposal that failed to save because a stage could not be
 * written would be a workflow that breaks the things it is meant to track, and
 * the rule everywhere else in this pipeline already is that a failure degrades
 * to a note.
 *
 * They also never move a lead *backwards* past a decision. A second draft
 * written after an approval does not quietly revoke it — the approval is
 * fingerprinted, so the send is what catches that, and it catches it with the
 * change named.
 */

async function stageOf(leadId: string | null | undefined): Promise<string | null> {
  if (!leadId) return null;
  try {
    const concept = await prisma.leadConcept.findUnique({ where: { leadId }, select: { stage: true } });
    return concept?.stage ?? null;
  } catch {
    return null;
  }
}

/** The website review has run: record which one, and its verdict on the look. */
export async function noteAudit(
  leadId: string | null | undefined,
  audit: { auditId: string; redesignCall: string | null; redesignScore: number | null },
): Promise<void> {
  const stage = await stageOf(leadId);
  if (!leadId || !stage) return;
  try {
    // Only from the two stages where an audit is the next thing that happens.
    // Later on it is a re-run, which is evidence the file should carry without
    // dragging the lead back to the beginning of the queue.
    const data = { auditId: audit.auditId, redesignCall: audit.redesignCall, redesignScore: audit.redesignScore };
    if (stage === "QUALIFIED" || stage === "AUDIT_COMPLETE") {
      await moveStage(leadId, "AUDIT_COMPLETE", { reason: "The website review has run.", data });
    } else {
      await prisma.leadConcept.update({ where: { leadId }, data });
    }
  } catch {
    // Recording is not the job the caller was doing.
  }
}

export async function noteProposal(leadId: string | null | undefined, proposalId: string): Promise<void> {
  const stage = await stageOf(leadId);
  if (!leadId || !stage) return;
  if (stage !== "PREVIEW_CHECKED") {
    // Before the preview is checked a proposal is premature, and after
    // EMAIL_READY it is a revision. Both are worth attaching; neither is a
    // stage change.
    try {
      await prisma.leadConcept.update({ where: { leadId }, data: { proposalId } });
    } catch {
      /* not the caller's job */
    }
    return;
  }
  try {
    await moveStage(leadId, "PROPOSAL_READY", { reason: "A proposal has been written.", data: { proposalId } });
  } catch {
    /* not the caller's job */
  }
}

export async function noteEmailDraft(leadId: string | null | undefined, emailMessageId: string, purpose: string): Promise<void> {
  const stage = await stageOf(leadId);
  if (!leadId || !stage) return;
  // Only the first approach belongs to this workflow. A follow-up, a thank-you
  // or an invoice is a different letter with a different decision behind it.
  if (!["COLD_OUTREACH", "DEMO_READY"].includes(purpose)) return;
  if (stage !== "PREVIEW_CHECKED" && stage !== "PROPOSAL_READY") return;
  try {
    await moveStage(leadId, "EMAIL_READY", { reason: "A first letter has been drafted.", data: { emailMessageId } });
  } catch {
    /* not the caller's job */
  }
}
