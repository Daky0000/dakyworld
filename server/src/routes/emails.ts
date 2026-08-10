import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireRole } from "../middleware/auth.js";
import { mailerConfigured } from "../lib/mailer.js";
import { draftEmail } from "../lib/emailDrafter.js";
import { analystConfigured } from "../lib/anthropic.js";
import { resolveContext } from "../services/emailContext.js";
import { composeMessage, isSuppressed, sendMessage } from "../services/emailSender.js";
import { fillPlaceholders, renderEmail, toHtml, verifyUnsubscribeToken } from "../services/emailRender.js";
import { BUILTIN_TEMPLATES, ensureBuiltinTemplates } from "../services/emailTemplates.js";
import { enrol, nextSendSlot, runDueSequences, stopEnrollment, stopOnReply } from "../services/emailSequences.js";
import { appUrl } from "../services/emailSender.js";

/**
 * Everything to do with outbound email.
 *
 * The unsubscribe route is the exception to the auth rule and is mounted
 * separately in index.ts, before the session gate — a one-click opt-out that
 * needs a login is not an opt-out, and every cold email this app sends carries
 * that link in its headers.
 */
export const emailsRouter = Router();

const PURPOSES = [
  "COLD_OUTREACH",
  "FOLLOW_UP",
  "MEETING_REQUEST",
  "PROPOSAL_COVER",
  "DELIVERABLE_HANDOVER",
  "PROJECT_UPDATE",
  "INVOICE_DELIVERY",
  "INVOICE_REMINDER",
  "CARE_PLAN_REVIEW",
  "ONBOARDING",
  "REACTIVATION",
  "THANK_YOU",
  "ANNOUNCEMENT",
  "CUSTOM",
] as const;

const attachment = z.union([
  z.object({ kind: z.literal("file").optional(), name: z.string(), url: z.string().url(), contentType: z.string().optional() }),
  z.object({ kind: z.literal("invoice"), invoiceId: z.string().cuid(), name: z.string().optional() }),
  z.object({ kind: z.literal("proposal"), proposalId: z.string().cuid(), name: z.string().optional() }),
]);

// Writing to a client under the company's name is not a junior privilege.
emailsRouter.use(requireRole("OWNER", "OPERATIONS_FINANCE", "PROJECT_MANAGER"));

// --- Status ----------------------------------------------------------------

emailsRouter.get("/status", async (_req, res, next) => {
  try {
    const [connected, drafterReady, counts] = await Promise.all([
      mailerConfigured(),
      analystConfigured(),
      prisma.emailMessage.groupBy({ by: ["status"], _count: true }),
    ]);
    const byStatus = Object.fromEntries(counts.map((row) => [row.status, row._count]));
    const [sequences, activeEnrollments, suppressed] = await Promise.all([
      prisma.emailSequence.count({ where: { active: true } }),
      prisma.emailEnrollment.count({ where: { status: "ACTIVE" } }),
      prisma.emailSuppression.count(),
    ]);
    res.json({
      connected,
      drafterReady,
      drafts: byStatus.DRAFT ?? 0,
      scheduled: byStatus.SCHEDULED ?? 0,
      sent: byStatus.SENT ?? 0,
      failed: byStatus.FAILED ?? 0,
      activeSequences: sequences,
      activeEnrollments,
      suppressed,
    });
  } catch (err) {
    next(err);
  }
});

// --- Messages --------------------------------------------------------------

emailsRouter.get("/", async (req, res, next) => {
  try {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const leadId = typeof req.query.leadId === "string" ? req.query.leadId : undefined;
    const clientId = typeof req.query.clientId === "string" ? req.query.clientId : undefined;
    const search = typeof req.query.q === "string" ? req.query.q.trim() : "";

    const messages = await prisma.emailMessage.findMany({
      where: {
        status: status ? (status as never) : undefined,
        leadId,
        clientId,
        ...(search
          ? {
              OR: [
                { subject: { contains: search, mode: "insensitive" as const } },
                { toEmail: { contains: search, mode: "insensitive" as const } },
                { toName: { contains: search, mode: "insensitive" as const } },
              ],
            }
          : {}),
      },
      orderBy: [{ sentAt: "desc" }, { createdAt: "desc" }],
      take: 200,
      include: {
        lead: { select: { id: true, contactName: true, companyName: true } },
        client: { select: { id: true, name: true } },
        template: { select: { id: true, name: true } },
        step: { select: { position: true, sequence: { select: { id: true, name: true } } } },
      },
    });
    res.json(messages);
  } catch (err) {
    next(err);
  }
});

emailsRouter.get("/:id", async (req, res, next) => {
  try {
    const message = await prisma.emailMessage.findUnique({
      where: { id: req.params.id },
      include: {
        lead: { select: { id: true, contactName: true, companyName: true } },
        client: { select: { id: true, name: true } },
        invoice: { select: { id: true, invoiceNumber: true } },
        proposal: { select: { id: true, title: true } },
      },
    });
    if (!message) return res.status(404).json({ error: "Email not found" });
    res.json(message);
  } catch (err) {
    next(err);
  }
});

/**
 * Everything known about a recipient, and the placeholders their record fills.
 * The composer asks for this the moment a recipient is picked, so the person
 * writing can see what the drafter would see.
 */
emailsRouter.get("/context/lookup", async (req, res, next) => {
  try {
    const context = await resolveContext({
      leadId: typeof req.query.leadId === "string" ? req.query.leadId : null,
      clientId: typeof req.query.clientId === "string" ? req.query.clientId : null,
      toEmail: typeof req.query.email === "string" ? req.query.email : null,
      toName: typeof req.query.name === "string" ? req.query.name : null,
    });
    const suppressed = context.email ? await isSuppressed(context.email) : null;
    res.json({ ...context, suppressed });
  } catch (err) {
    next(err);
  }
});

const draftInput = z.object({
  purpose: z.enum(PURPOSES).default("CUSTOM"),
  leadId: z.string().cuid().nullish(),
  clientId: z.string().cuid().nullish(),
  toEmail: z.string().email().nullish(),
  toName: z.string().nullish(),
  brief: z.string().max(2000).nullish(),
  existingSubject: z.string().nullish(),
  existingBody: z.string().nullish(),
  extraFacts: z.array(z.string().max(500)).max(20).optional(),
});

/** Writes a draft. Returns it — nothing is stored, and nothing is sent. */
emailsRouter.post("/draft", async (req, res, next) => {
  try {
    const input = draftInput.parse(req.body);
    const context = await resolveContext(input);
    const draft = await draftEmail({
      purpose: input.purpose,
      context,
      brief: input.brief,
      existingSubject: input.existingSubject,
      existingBody: input.existingBody,
      extraFacts: input.extraFacts,
    });
    res.json({ ...draft, variables: context.variables, facts: context.facts });
  } catch (err) {
    next(err);
  }
});

const composeInput = z.object({
  subject: z.string().min(1).max(300),
  body: z.string().min(1),
  purpose: z.enum(PURPOSES).default("CUSTOM"),
  kind: z.enum(["MANUAL", "TEMPLATE", "AI_DRAFT", "AUTOMATION"]).default("MANUAL"),
  toEmail: z.string().email().nullish(),
  toName: z.string().nullish(),
  cc: z.array(z.string().email()).max(10).optional(),
  bcc: z.array(z.string().email()).max(10).optional(),
  replyTo: z.string().email().nullish(),
  leadId: z.string().cuid().nullish(),
  clientId: z.string().cuid().nullish(),
  projectId: z.string().cuid().nullish(),
  proposalId: z.string().cuid().nullish(),
  invoiceId: z.string().cuid().nullish(),
  carePlanId: z.string().cuid().nullish(),
  templateId: z.string().cuid().nullish(),
  attachments: z.array(attachment).max(10).optional(),
  /** ISO instant. Absent sends now (or saves a draft, if `send` is false). */
  scheduledFor: z.coerce.date().nullish(),
  send: z.boolean().default(false),
});

emailsRouter.post("/", async (req, res, next) => {
  try {
    const input = composeInput.parse(req.body);
    const message = await composeMessage({
      ...input,
      attachments: input.attachments,
      createdById: req.dbUser?.id,
      scheduledFor: input.scheduledFor ?? null,
      status: input.scheduledFor ? "SCHEDULED" : "DRAFT",
    });

    if (input.templateId) {
      await prisma.emailTemplate.update({ where: { id: input.templateId }, data: { usageCount: { increment: 1 } } });
    }

    // Send immediately only when asked, and only when not scheduled — the two
    // together would mean "send it now and also later".
    if (input.send && !input.scheduledFor) {
      const result = await sendMessage(message.id);
      const saved = await prisma.emailMessage.findUnique({ where: { id: message.id } });
      return res.status(201).json({ message: saved, result });
    }
    res.status(201).json({ message, result: { sent: false, reason: input.scheduledFor ? "scheduled" : "draft" } });
  } catch (err) {
    next(err);
  }
});

/** Edits a draft. A sent email is a record of what went out and cannot be rewritten. */
emailsRouter.patch("/:id", async (req, res, next) => {
  try {
    const existing = await prisma.emailMessage.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: "Email not found" });
    if (existing.status === "SENT" || existing.status === "SENDING") {
      return res.status(409).json({ error: "That email has already gone out — it can't be edited." });
    }

    const input = z
      .object({
        subject: z.string().min(1).max(300).optional(),
        body: z.string().min(1).optional(),
        toEmail: z.string().email().optional(),
        scheduledFor: z.coerce.date().nullish(),
        attachments: z.array(attachment).max(10).optional(),
      })
      .parse(req.body);

    // Re-render whenever the words or the recipient change: the stored HTML is
    // the message, and editing one half of it would send the other half.
    const context = await resolveContext({ leadId: existing.leadId, clientId: existing.clientId, toEmail: input.toEmail ?? existing.toEmail });
    const rendered =
      input.subject !== undefined || input.body !== undefined || input.toEmail !== undefined
        ? await renderEmail({
            subject: input.subject ?? existing.subject,
            body: input.body ?? existing.bodyText,
            variables: context.variables,
            toEmail: input.toEmail ?? existing.toEmail,
            appUrl: await appUrl(),
            includeUnsubscribe: existing.purpose === "COLD_OUTREACH" || existing.purpose === "FOLLOW_UP",
          })
        : null;

    const message = await prisma.emailMessage.update({
      where: { id: existing.id },
      data: {
        subject: rendered?.subject,
        bodyHtml: rendered?.html,
        bodyText: rendered?.bodyText,
        toEmail: input.toEmail,
        attachments: input.attachments === undefined ? undefined : (input.attachments as never),
        scheduledFor: input.scheduledFor === undefined ? undefined : input.scheduledFor,
        status: input.scheduledFor ? "SCHEDULED" : input.scheduledFor === null ? "DRAFT" : undefined,
        error: null,
      },
    });
    res.json(message);
  } catch (err) {
    next(err);
  }
});

emailsRouter.post("/:id/send", async (req, res, next) => {
  try {
    const result = await sendMessage(req.params.id);
    const message = await prisma.emailMessage.findUnique({ where: { id: req.params.id } });
    res.json({ message, result });
  } catch (err) {
    next(err);
  }
});

emailsRouter.post("/:id/cancel", async (req, res, next) => {
  try {
    const message = await prisma.emailMessage.update({
      where: { id: req.params.id },
      data: { status: "CANCELLED", scheduledFor: null },
    });
    res.json(message);
  } catch (err) {
    next(err);
  }
});

emailsRouter.delete("/:id", async (req, res, next) => {
  try {
    const existing = await prisma.emailMessage.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: "Email not found" });
    if (existing.status === "SENT") {
      return res.status(409).json({ error: "A sent email is the record that it was sent. Nothing deletes it." });
    }
    await prisma.emailMessage.delete({ where: { id: existing.id } });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/** Preview without saving — what the recipient will actually see. */
emailsRouter.post("/preview", async (req, res, next) => {
  try {
    const input = z
      .object({
        subject: z.string().default(""),
        body: z.string().default(""),
        leadId: z.string().cuid().nullish(),
        clientId: z.string().cuid().nullish(),
        toEmail: z.string().email().nullish(),
        toName: z.string().nullish(),
      })
      .parse(req.body);
    const context = await resolveContext(input);
    res.json({
      subject: fillPlaceholders(input.subject, context.variables),
      html: toHtml(fillPlaceholders(input.body, context.variables), null, null),
      variables: context.variables,
    });
  } catch (err) {
    next(err);
  }
});

// --- Templates -------------------------------------------------------------

emailsRouter.get("/templates/all", async (_req, res, next) => {
  try {
    await ensureBuiltinTemplates();
    const templates = await prisma.emailTemplate.findMany({ orderBy: [{ purpose: "asc" }, { name: "asc" }] });
    res.json({ templates, shipped: BUILTIN_TEMPLATES.length });
  } catch (err) {
    next(err);
  }
});

const templateInput = z.object({
  name: z.string().min(1).max(120),
  purpose: z.enum(PURPOSES).default("CUSTOM"),
  description: z.string().max(400).nullish(),
  subject: z.string().min(1).max(300),
  bodyHtml: z.string().min(1),
  aiBrief: z.string().max(1000).nullish(),
  active: z.boolean().default(true),
});

emailsRouter.post("/templates", async (req, res, next) => {
  try {
    const input = templateInput.parse(req.body);
    const slug = `${input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-${Date.now().toString(36).slice(-4)}`;
    const template = await prisma.emailTemplate.create({ data: { ...input, slug, builtin: false } });
    res.status(201).json(template);
  } catch (err) {
    next(err);
  }
});

emailsRouter.patch("/templates/:id", async (req, res, next) => {
  try {
    const input = templateInput.partial().parse(req.body);
    const template = await prisma.emailTemplate.update({ where: { id: req.params.id }, data: input });
    res.json(template);
  } catch (err) {
    next(err);
  }
});

emailsRouter.delete("/templates/:id", async (req, res, next) => {
  try {
    await prisma.emailTemplate.delete({ where: { id: req.params.id } });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// --- Sequences -------------------------------------------------------------

const sequenceInclude = {
  steps: { orderBy: { position: "asc" as const }, include: { template: { select: { id: true, name: true } } } },
  _count: { select: { enrollments: true } },
};

emailsRouter.get("/sequences/all", async (_req, res, next) => {
  try {
    const sequences = await prisma.emailSequence.findMany({ orderBy: { createdAt: "desc" }, include: sequenceInclude });
    const active = await prisma.emailEnrollment.groupBy({ by: ["sequenceId"], where: { status: "ACTIVE" }, _count: true });
    const activeBySequence = Object.fromEntries(active.map((row) => [row.sequenceId, row._count]));
    res.json(sequences.map((sequence) => ({ ...sequence, activeEnrollments: activeBySequence[sequence.id] ?? 0 })));
  } catch (err) {
    next(err);
  }
});

const stepInput = z.object({
  position: z.number().int().min(0),
  delayDays: z.number().int().min(0).max(365).default(3),
  templateId: z.string().cuid().nullish(),
  subject: z.string().max(300).nullish(),
  bodyHtml: z.string().nullish(),
  useAi: z.boolean().default(false),
  aiBrief: z.string().max(1000).nullish(),
  purpose: z.enum(PURPOSES).default("FOLLOW_UP"),
});

const sequenceInput = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).nullish(),
  trigger: z.enum(["MANUAL", "LEAD_CREATED", "LEAD_STATUS_CHANGED", "PROPOSAL_SENT", "PROJECT_COMPLETED", "INVOICE_OVERDUE", "CARE_PLAN_REVIEW_DUE"]).default("MANUAL"),
  triggerFilter: z.record(z.unknown()).nullish(),
  active: z.boolean().default(false),
  stopOnReply: z.boolean().default(true),
  requireApproval: z.boolean().default(false),
  sendWindowStart: z.number().int().min(0).max(23).default(8),
  sendWindowEnd: z.number().int().min(1).max(23).default(18),
  weekdaysOnly: z.boolean().default(true),
  timezone: z.string().default("Africa/Accra"),
  steps: z.array(stepInput).max(12).default([]),
});

emailsRouter.post("/sequences", async (req, res, next) => {
  try {
    const { steps, ...input } = sequenceInput.parse(req.body);
    const sequence = await prisma.emailSequence.create({
      data: {
        ...input,
        triggerFilter: (input.triggerFilter ?? undefined) as never,
        steps: { create: steps.map((step, index) => ({ ...step, position: index })) },
      },
      include: sequenceInclude,
    });
    res.status(201).json(sequence);
  } catch (err) {
    next(err);
  }
});

/** Steps are replaced wholesale — reordering them one at a time through a unique (sequence, position) index is a losing game. */
emailsRouter.patch("/sequences/:id", async (req, res, next) => {
  try {
    const { steps, ...input } = sequenceInput.partial().parse(req.body);
    await prisma.$transaction(async (tx) => {
      await tx.emailSequence.update({
        where: { id: req.params.id },
        data: { ...input, triggerFilter: input.triggerFilter === undefined ? undefined : ((input.triggerFilter ?? null) as never) },
      });
      if (steps) {
        await tx.emailSequenceStep.deleteMany({ where: { sequenceId: req.params.id } });
        for (const [index, step] of steps.entries()) {
          await tx.emailSequenceStep.create({ data: { ...step, position: index, sequenceId: req.params.id } });
        }
      }
    });
    res.json(await prisma.emailSequence.findUnique({ where: { id: req.params.id }, include: sequenceInclude }));
  } catch (err) {
    next(err);
  }
});

emailsRouter.delete("/sequences/:id", async (req, res, next) => {
  try {
    await prisma.emailSequence.delete({ where: { id: req.params.id } });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

emailsRouter.get("/sequences/:id/enrollments", async (req, res, next) => {
  try {
    const enrollments = await prisma.emailEnrollment.findMany({
      where: { sequenceId: req.params.id },
      orderBy: [{ status: "asc" }, { nextSendAt: "asc" }],
      take: 300,
      include: {
        lead: { select: { id: true, contactName: true, companyName: true } },
        client: { select: { id: true, name: true } },
        _count: { select: { messages: true } },
      },
    });
    res.json(enrollments);
  } catch (err) {
    next(err);
  }
});

/** Enrols one or many. Reports per person rather than failing the batch. */
emailsRouter.post("/sequences/:id/enrol", async (req, res, next) => {
  try {
    const input = z
      .object({ leadIds: z.array(z.string().cuid()).max(500).optional(), clientIds: z.array(z.string().cuid()).max(200).optional() })
      .parse(req.body);

    const results: { id: string; enrolled: boolean; reason?: string }[] = [];
    for (const leadId of input.leadIds ?? []) {
      const result = await enrol({ sequenceId: req.params.id, leadId });
      results.push({ id: leadId, enrolled: result.enrolled, reason: result.reason });
    }
    for (const clientId of input.clientIds ?? []) {
      const result = await enrol({ sequenceId: req.params.id, clientId });
      results.push({ id: clientId, enrolled: result.enrolled, reason: result.reason });
    }
    res.json({ enrolled: results.filter((row) => row.enrolled).length, skipped: results.filter((row) => !row.enrolled), results });
  } catch (err) {
    next(err);
  }
});

emailsRouter.post("/enrollments/:id/stop", async (req, res, next) => {
  try {
    const { reason } = z.object({ reason: z.string().max(200).default("Stopped by hand") }).parse(req.body ?? {});
    await stopEnrollment(req.params.id, reason);
    res.json(await prisma.emailEnrollment.findUnique({ where: { id: req.params.id } }));
  } catch (err) {
    next(err);
  }
});

/** "They replied" — stops every sequence this person is in, not just one. */
emailsRouter.post("/replied", async (req, res, next) => {
  try {
    const input = z
      .object({ leadId: z.string().cuid().optional(), clientId: z.string().cuid().optional(), email: z.string().email().optional() })
      .parse(req.body);
    const stopped = await stopOnReply(input);
    res.json({ stopped });
  } catch (err) {
    next(err);
  }
});

/** Runs whatever is due right now instead of waiting for the tick. */
emailsRouter.post("/sequences/run-now", async (_req, res, next) => {
  try {
    res.json({ sent: await runDueSequences(new Date(), 25) });
  } catch (err) {
    next(err);
  }
});

/** What time a step would actually go out, for the sequence editor. */
emailsRouter.post("/sequences/preview-slot", async (req, res, next) => {
  try {
    const input = z
      .object({
        sendWindowStart: z.number().int().min(0).max(23).default(8),
        sendWindowEnd: z.number().int().min(1).max(23).default(18),
        weekdaysOnly: z.boolean().default(true),
        timezone: z.string().default("Africa/Accra"),
        delayDays: z.number().int().min(0).max(365).default(3),
      })
      .parse(req.body);
    const after = new Date(Date.now() + input.delayDays * 86_400_000);
    res.json({ at: nextSendSlot(input, after) });
  } catch (err) {
    next(err);
  }
});

// --- Suppression -----------------------------------------------------------

emailsRouter.get("/suppression/all", async (_req, res, next) => {
  try {
    res.json(await prisma.emailSuppression.findMany({ orderBy: { createdAt: "desc" }, take: 500 }));
  } catch (err) {
    next(err);
  }
});

emailsRouter.post("/suppression", async (req, res, next) => {
  try {
    const input = z.object({ email: z.string().email(), reason: z.string().max(200).default("Added by hand") }).parse(req.body);
    const row = await prisma.emailSuppression.upsert({
      where: { email: input.email.toLowerCase() },
      update: { reason: input.reason, source: "MANUAL" },
      create: { email: input.email.toLowerCase(), reason: input.reason, source: "MANUAL" },
    });
    await stopOnReply({ email: input.email.toLowerCase() });
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
});

emailsRouter.delete("/suppression/:id", async (req, res, next) => {
  try {
    await prisma.emailSuppression.delete({ where: { id: req.params.id } });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// --- Unsubscribe (public — mounted before the auth gate) --------------------

export const unsubscribeRouter = Router();

/**
 * One click, no login, no confirmation step. A signed token proves the link
 * came from us; without one the endpoint still honours the request, because
 * refusing an unsubscribe over a signature mismatch is indefensible — the
 * worst case is somebody opting out an address that wanted our email, and they
 * can be removed from the list again.
 */
unsubscribeRouter.get("/unsubscribe", async (req, res, next) => {
  try {
    const email = typeof req.query.email === "string" ? req.query.email.toLowerCase().trim() : "";
    const token = typeof req.query.token === "string" ? req.query.token : "";
    if (!email) return res.status(400).type("html").send(page("That link is missing an address.", false));

    const verified = token ? verifyUnsubscribeToken(email, token) : false;
    await prisma.emailSuppression.upsert({
      where: { email },
      update: {},
      create: { email, reason: "Unsubscribed from an email", source: verified ? "UNSUBSCRIBED" : "UNSUBSCRIBED_UNVERIFIED" },
    });
    await stopOnReply({ email });

    res.type("html").send(page("You have been unsubscribed. We will not email you again.", true));
  } catch (err) {
    next(err);
  }
});

/** Gmail and Outlook POST to List-Unsubscribe rather than following the link. */
unsubscribeRouter.post("/unsubscribe", async (req, res, next) => {
  try {
    const email = (typeof req.query.email === "string" ? req.query.email : "").toLowerCase().trim();
    if (!email) return res.status(400).json({ error: "No address" });
    await prisma.emailSuppression.upsert({
      where: { email },
      update: {},
      create: { email, reason: "One-click unsubscribe", source: "UNSUBSCRIBED" },
    });
    await stopOnReply({ email });
    res.status(200).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

function page(message: string, ok: boolean): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Dakyworld</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0B0B0C;color:#F7F4EE;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px}
.card{border:1px solid rgba(247,244,238,.15);padding:40px;max-width:440px;text-align:center}
h1{font-size:.8rem;letter-spacing:.18em;text-transform:uppercase;margin:0 0 18px;color:#C7A24C}
p{margin:0;line-height:1.6;font-size:15px;color:${ok ? "#F7F4EE" : "rgba(247,244,238,.7)"}}</style></head>
<body><div class="card"><h1>Dakyworld</h1><p>${message}</p></div></body></html>`;
}
