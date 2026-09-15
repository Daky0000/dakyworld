import { prisma } from "../../lib/prisma.js";
import { failureSummary, runPreviewChecks, type PreviewChecks } from "./checks.js";
import { ensureConcept, moveStage } from "./stage.js";

/**
 * What happens to a lead the moment a page is built for it, wherever the build
 * was started from.
 *
 * Three doors lead to `buildDemo`: the Demos screen, the `demo.build` tool an
 * agent calls, and the automatic pass in `leadDemo.ts`. If only the automatic
 * one recorded a stage and ran the checks, then a page built by hand would sit
 * outside the workflow entirely — unchecked, ungated, and still linkable from a
 * letter, because the gate would see a lead with no concept row and a demo that
 * nobody had ever examined. A rule enforced at one door is not a rule.
 *
 * So every door calls this. It runs the checks against the page as stored and
 * leaves the lead at NEEDS_REVIEW — passing or failing, because passing the
 * automated checks means only that nothing observable is wrong, and whether
 * these are really their services is a question no regular expression answers.
 */
export async function recordBuild(
  leadId: string,
  built: { demoId: string; costUsd: number },
  options: { by?: string | null; startedAt?: number; rebuild?: boolean } = {},
): Promise<PreviewChecks | null> {
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    select: { companyName: true, contactName: true, contactPhone: true, contactEmail: true, website: true },
  });
  if (!lead) return null;

  const demo = await prisma.demo.findUnique({ where: { id: built.demoId }, select: { html: true, version: true } });
  if (!demo) return null;

  const checks = runPreviewChecks(demo.html, {
    businessName: lead.companyName ?? lead.contactName,
    phone: lead.contactPhone,
    email: lead.contactEmail,
  });

  const existing = await ensureConcept(leadId, { kind: lead.website?.trim() ? "REDESIGN" : "NEW_SITE" });

  await moveStage(leadId, "NEEDS_REVIEW", {
    by: options.by ?? null,
    reason: checks.passed
      ? "Built and passed every automated check. Waiting for somebody to look at it."
      : `Built, but the automated checks found: ${failureSummary(checks)}`,
    data: {
      demoId: built.demoId,
      demoVersion: demo.version,
      checks: checks as never,
      checkAttempts: { increment: 1 },
      // The first-time answer is never rewritten: it is the number the pilot is
      // measuring, and a rebuild that passes does not make the first build good.
      ...(existing.firstPassOk === null ? { firstPassOk: checks.passed } : {}),
      ...(options.rebuild ? { rebuilds: { increment: 1 } } : {}),
      ...(options.startedAt ? { buildMs: Date.now() - options.startedAt } : {}),
      buildCostUsd: built.costUsd,
      // Whatever was signed off before, it was signed off against a different
      // page. Silence here would leave an approval standing over content the
      // approver never saw.
      reviewedAt: null,
      reviewedBy: null,
      approvedAt: null,
      approvalFingerprint: null,
    },
  });

  return checks;
}
