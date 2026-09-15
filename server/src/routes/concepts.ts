import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { gateBy } from "../middleware/permissionGate.js";
import { demoUrl } from "../services/demoBuilder.js";
import { appUrl } from "../services/emailSender.js";
import { REVIEWER_CHECKS, failureSummary, runPreviewChecks, type PreviewChecks } from "../services/concept/checks.js";
import { approvalFingerprint } from "../services/concept/approval.js";
import { currentSubject } from "../services/concept/send.js";
import { historyOf, moveStage } from "../services/concept/stage.js";
import { autoRedesignEnabled, setAutoRedesign } from "../services/concept/settings.js";
import { pilotMetrics } from "../services/concept/metrics.js";
import { previewGate } from "../services/concept/gate.js";

/**
 * The review queue: every lead that is part-way through the concept workflow,
 * and the two decisions a person makes about it.
 *
 * **The two decisions are deliberately separate.** Approving the *page* is a
 * judgement about a thing that carries somebody else's business name — are
 * these their services, does it claim anything we cannot support, does it hold
 * up on a phone. Approving the *outreach* is a judgement about a letter going
 * to a person. Collapsing them into one button would mean a page could be
 * signed off by somebody who never read the email, or an email sent by
 * somebody who never opened the page, with one click standing for both.
 *
 * The outreach approval is fingerprinted rather than remembered, because
 * everything it covers stays editable afterwards. See concept/approval.ts.
 */

export const conceptsRouter = Router();

conceptsRouter.use(
  gateBy({
    view: "demos.view",
    create: "demos.create",
    // Approving is what puts a page and a letter in front of a stranger.
    edit: "demos.publish",
    remove: "demos.publish",
  }),
);

const listQuery = z.object({
  stage: z.string().optional(),
  /** Everything still in play, which is what the queue is for. */
  open: z.enum(["true", "false"]).optional(),
});

const OPEN_STAGES = ["QUALIFIED", "AUDIT_COMPLETE", "BUILDING", "NEEDS_REVIEW", "PREVIEW_CHECKED", "PROPOSAL_READY", "EMAIL_READY", "APPROVED", "SENDING"] as const;

conceptsRouter.get("/", async (req, res, next) => {
  try {
    const query = listQuery.parse(req.query);
    const concepts = await prisma.leadConcept.findMany({
      where: {
        ...(query.stage ? { stage: query.stage as never } : {}),
        ...(query.open === "true" ? { stage: { in: [...OPEN_STAGES] as never } } : {}),
      },
      orderBy: { updatedAt: "desc" },
      take: 200,
      include: { lead: { select: { id: true, companyName: true, contactName: true, contactEmail: true, website: true, city: true } } },
    });

    const base = await appUrl();
    const demos = await prisma.demo.findMany({
      where: { id: { in: concepts.map((concept) => concept.demoId).filter((id): id is string => Boolean(id)) } },
      select: { id: true, slug: true, version: true, views: true, title: true },
    });
    const bySlug = new Map(demos.map((demo) => [demo.id, demo]));

    res.json({
      concepts: concepts.map((concept) => {
        const demo = concept.demoId ? bySlug.get(concept.demoId) : null;
        const checks = (concept.checks ?? null) as PreviewChecks | null;
        return {
          id: concept.id,
          leadId: concept.leadId,
          lead: concept.lead,
          stage: concept.stage,
          kind: concept.kind,
          reason: concept.reason,
          redesignCall: concept.redesignCall,
          redesignScore: concept.redesignScore,
          // The link is shown in the queue whatever the stage — this screen is
          // where somebody goes to look at a page precisely because it has not
          // been signed off yet.
          previewUrl: demo ? demoUrl(demo.slug, base) : null,
          previewVersion: demo?.version ?? null,
          checkedVersion: concept.demoVersion,
          views: demo?.views ?? 0,
          checksPassed: checks?.passed ?? null,
          checksFailed: checks ? checks.checks.filter((entry) => !entry.ok).length : null,
          reviewedAt: concept.reviewedAt,
          approvedAt: concept.approvedAt,
          proposalId: concept.proposalId,
          emailMessageId: concept.emailMessageId,
          sentAt: concept.sentAt,
          sendUncertain: concept.sendUncertain,
          updatedAt: concept.updatedAt,
        };
      }),
      reviewerChecks: REVIEWER_CHECKS,
      autoRedesign: await autoRedesignEnabled(),
    });
  } catch (err) {
    next(err);
  }
});

/** One lead's whole file: the site, the findings, the page, the checks, the letter. */
conceptsRouter.get("/:leadId", async (req, res, next) => {
  try {
    const concept = await prisma.leadConcept.findUnique({
      where: { leadId: req.params.leadId },
      include: { lead: true },
    });
    if (!concept) return res.status(404).json({ error: "This lead is not in the concept workflow." });

    const [demo, audit, proposal, email, gate] = await Promise.all([
      concept.demoId ? prisma.demo.findUnique({ where: { id: concept.demoId } }) : null,
      concept.auditId ? prisma.websiteAudit.findUnique({ where: { id: concept.auditId }, select: { id: true, overallScore: true, verdict: true, markdown: true, ranAt: true } }) : null,
      concept.proposalId ? prisma.proposal.findUnique({ where: { id: concept.proposalId } }) : null,
      concept.emailMessageId ? prisma.emailMessage.findUnique({ where: { id: concept.emailMessageId } }) : null,
      previewGate(req.params.leadId),
    ]);

    res.json({
      concept: { ...concept, history: historyOf(concept) },
      lead: concept.lead,
      preview: demo ? { id: demo.id, slug: demo.slug, url: demoUrl(demo.slug, await appUrl()), version: demo.version, views: demo.views, title: demo.title, brief: demo.brief } : null,
      audit,
      proposal,
      email: email ? { id: email.id, subject: email.subject, bodyHtml: email.bodyHtml, toEmail: email.toEmail, status: email.status } : null,
      checks: concept.checks,
      reviewerChecks: REVIEWER_CHECKS,
      gate: { ok: gate.ok, reason: gate.reason },
    });
    return;
  } catch (err) {
    next(err);
    return;
  }
});

/**
 * Runs the automated checks again, against the page as it stands now.
 *
 * Needed as its own action because a rebuild invalidates the last run and the
 * gate says so — without this the only way back through the gate would be to
 * rebuild again, which changes the page a prospect may already have opened.
 */
conceptsRouter.post("/:leadId/recheck", async (req, res, next) => {
  try {
    const concept = await prisma.leadConcept.findUnique({ where: { leadId: req.params.leadId }, include: { lead: true } });
    if (!concept?.demoId) return res.status(404).json({ error: "No page has been built for this lead." });
    const demo = await prisma.demo.findUnique({ where: { id: concept.demoId } });
    if (!demo) return res.status(404).json({ error: "That page no longer exists." });

    const checks = runPreviewChecks(demo.html, {
      businessName: concept.lead.companyName ?? concept.lead.contactName,
      phone: concept.lead.contactPhone,
      email: concept.lead.contactEmail,
    });

    // A re-check always lands back at NEEDS_REVIEW, even when it passes: the
    // page has changed since anybody looked at it, and an automated pass is
    // not a person looking.
    await moveStage(req.params.leadId, "NEEDS_REVIEW", {
      by: req.dbUser?.id ?? null,
      reason: checks.passed ? "Checked again and passed. Waiting for somebody to look at it." : `Checked again: ${failureSummary(checks)}`,
      data: {
        checks: checks as never,
        demoVersion: demo.version,
        checkAttempts: { increment: 1 },
        // A later pass is still a later pass — the first-time answer is not
        // rewritten, because it is the number the pilot is actually measuring.
        ...(concept.firstPassOk === null ? { firstPassOk: checks.passed } : {}),
        // Anything signed off before this re-check was signed off against a
        // different page.
        reviewedAt: null,
        reviewedBy: null,
        approvedAt: null,
        approvalFingerprint: null,
        approvalSubject: undefined,
      },
    });

    res.json({ checks });
    return;
  } catch (err) {
    next(err);
    return;
  }
});

const reviewBody = z.object({
  /** Every reviewer check has to be ticked; a partial tick is a rejection. */
  confirmed: z.array(z.string()).default([]),
  notes: z.string().max(4000).optional(),
  decision: z.enum(["pass", "reject"]),
});

/** The first of the two decisions: is this page fit to be seen. */
conceptsRouter.post("/:leadId/review", async (req, res, next) => {
  try {
    const body = reviewBody.parse(req.body);
    const concept = await prisma.leadConcept.findUnique({ where: { leadId: req.params.leadId } });
    if (!concept) return res.status(404).json({ error: "This lead is not in the concept workflow." });

    if (body.decision === "reject") {
      await moveStage(req.params.leadId, "NEEDS_REVIEW", {
        by: req.dbUser?.id ?? null,
        reason: body.notes?.trim() || "Rejected by a reviewer, with no reason given.",
        data: { reviewNotes: body.notes ?? null, reviewedAt: null, reviewedBy: null, approvedAt: null, approvalFingerprint: null },
      });
      return res.json({ ok: true, stage: "NEEDS_REVIEW" });
    }

    const checks = (concept.checks ?? null) as PreviewChecks | null;
    if (!checks?.passed) {
      return res.status(409).json({ error: "The automated checks have not passed, so this page cannot be signed off. Fix it and re-check." });
    }
    const missing = REVIEWER_CHECKS.filter((entry) => !body.confirmed.includes(entry.id));
    if (missing.length) {
      // Refused rather than recorded as a partial pass: a checklist that can be
      // half-ticked and still pass is a checklist that means nothing.
      return res.status(400).json({ error: `Still to confirm: ${missing.map((entry) => entry.label).join(" ")}` });
    }

    await moveStage(req.params.leadId, "PREVIEW_CHECKED", {
      by: req.dbUser?.id ?? null,
      reason: "A reviewer checked the page.",
      data: { reviewedAt: new Date(), reviewedBy: req.dbUser?.id ?? null, reviewNotes: body.notes ?? null },
    });
    return res.json({ ok: true, stage: "PREVIEW_CHECKED" });
  } catch (err) {
    next(err);
    return;
  }
});

const approveBody = z.object({ emailMessageId: z.string(), proposalId: z.string().optional() });

/**
 * The second decision: this exact page, proposal, recipient and letter may go.
 *
 * The fingerprint is computed from what is in the database at this instant and
 * stored with the approval, so the send can prove that nothing moved
 * underneath it.
 */
conceptsRouter.post("/:leadId/approve", async (req, res, next) => {
  try {
    const body = approveBody.parse(req.body);
    const gate = await previewGate(req.params.leadId);
    if (!gate.ok) return res.status(409).json({ error: gate.reason });

    const message = await prisma.emailMessage.findUnique({ where: { id: body.emailMessageId } });
    if (!message) return res.status(404).json({ error: "That letter does not exist." });
    if (message.leadId !== req.params.leadId) return res.status(400).json({ error: "That letter is addressed to a different lead." });

    const subject = await currentSubject({ ...message, proposalId: body.proposalId ?? message.proposalId });
    await moveStage(req.params.leadId, "APPROVED", {
      by: req.dbUser?.id ?? null,
      reason: "Approved for sending.",
      data: {
        emailMessageId: message.id,
        proposalId: body.proposalId ?? message.proposalId ?? null,
        approvedAt: new Date(),
        approvedBy: req.dbUser?.id ?? null,
        approvalFingerprint: approvalFingerprint(subject),
        approvalSubject: subject as never,
      },
    });
    return res.json({ ok: true, stage: "APPROVED" });
  } catch (err) {
    next(err);
    return;
  }
});

const skipBody = z.object({ reason: z.string().min(3).max(1000) });

conceptsRouter.post("/:leadId/skip", async (req, res, next) => {
  try {
    const body = skipBody.parse(req.body);
    await moveStage(req.params.leadId, "SKIPPED", { by: req.dbUser?.id ?? null, reason: body.reason });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

const outcomeBody = z.object({
  repliedAt: z.string().datetime().nullable().optional(),
  meetingAt: z.string().datetime().nullable().optional(),
  proposalAcceptedAt: z.string().datetime().nullable().optional(),
  revenueUsd: z.number().nonnegative().nullable().optional(),
});

/**
 * What came of it, typed in by hand.
 *
 * Replies and proposal acceptances are read from the mailbox and the proposal
 * rows where those are reliable — see concept/metrics.ts — but a meeting booked
 * over WhatsApp and a deal closed on the phone are real outcomes with no row
 * behind them, and a pilot that can only count what happens to be instrumented
 * measures the instrumentation.
 */
conceptsRouter.post("/:leadId/outcome", async (req, res, next) => {
  try {
    const body = outcomeBody.parse(req.body);
    const concept = await prisma.leadConcept.update({
      where: { leadId: req.params.leadId },
      data: {
        ...(body.repliedAt !== undefined ? { repliedAt: body.repliedAt ? new Date(body.repliedAt) : null } : {}),
        ...(body.meetingAt !== undefined ? { meetingAt: body.meetingAt ? new Date(body.meetingAt) : null } : {}),
        ...(body.proposalAcceptedAt !== undefined ? { proposalAcceptedAt: body.proposalAcceptedAt ? new Date(body.proposalAcceptedAt) : null } : {}),
        ...(body.revenueUsd !== undefined ? { revenueUsd: body.revenueUsd } : {}),
      },
    });
    res.json({ ok: true, concept });
  } catch (err) {
    next(err);
  }
});

conceptsRouter.get("/pilot/metrics", async (_req, res, next) => {
  try {
    res.json(await pilotMetrics());
  } catch (err) {
    next(err);
  }
});

const switchBody = z.object({ enabled: z.boolean() });

conceptsRouter.post("/pilot/auto-redesign", async (req, res, next) => {
  try {
    const body = switchBody.parse(req.body);
    await setAutoRedesign(body.enabled);
    res.json({ ok: true, autoRedesign: body.enabled });
  } catch (err) {
    next(err);
  }
});
