import express, { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireRole } from "../middleware/auth.js";
import { mailerConfigured } from "../lib/mailer.js";
import { draftEmail } from "../lib/emailDrafter.js";
import { preSendCheck } from "../services/coldEmailChecks.js";
import { chooseScenario, exampleWording, manualScenarios } from "../services/coldEmailScenarios.js";
import { polishEmail } from "../lib/emailPolish.js";
import { caseStrength, isStale, prepareLead, storedPrep } from "../services/leadPrep.js";
import { analystConfigured } from "../lib/anthropic.js";
import { resolveContext } from "../services/emailContext.js";
import { COLD_PURPOSES, composeMessage, isSuppressed, parseAttachments, sendMessage, type StoredAttachment } from "../services/emailSender.js";
import { fillPlaceholders, renderEmail, toHtml, verifyUnsubscribeToken } from "../services/emailRender.js";
import { BUILTIN_TEMPLATES, ensureBuiltinTemplates } from "../services/emailTemplates.js";
import { enrol, nextSendSlot, runDueSequences, stopEnrollment, stopOnReply } from "../services/emailSequences.js";
import { appUrl } from "../services/emailSender.js";
import { companyProfile, type CompanyProfile } from "../services/systemProfile.js";
import { FileStoreError, MAX_UPLOAD_BODY, deleteFile, fileSummary, readFile, storeFile } from "../services/fileStore.js";
import { LOGO_CID, LOGO_DARK_CID, brandDataUrl } from "../lib/brandAssets.js";
import { SETTING, getSetting } from "../lib/settings.js";

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
  "DEMO_READY",
  "CUSTOM",
] as const;

const attachment = z.union([
  z.object({
    kind: z.literal("stored"),
    fileId: z.string().cuid(),
    name: z.string(),
    contentType: z.string().optional(),
    size: z.number().int().nonnegative().optional(),
  }),
  z.object({ kind: z.literal("file").optional(), name: z.string(), url: z.string().url(), contentType: z.string().optional() }),
  z.object({ kind: z.literal("invoice"), invoiceId: z.string().cuid(), name: z.string().optional() }),
  z.object({ kind: z.literal("proposal"), proposalId: z.string().cuid(), name: z.string().optional() }),
]);

// Writing to a client under the company's name is not a junior privilege.
emailsRouter.use(requireRole("OWNER", "OPERATIONS_FINANCE", "PROJECT_MANAGER"));

// An attachment arrives base64-encoded inside the JSON body, so this one path
// parses bodies far larger than the rest of the API allows. Deliberately after
// the role check, and scoped to the one route, so nobody unauthenticated gets
// to hand us 15 MB to decode. See index.ts -> UPLOAD_PATHS.
emailsRouter.use("/attachments", express.json({ limit: MAX_UPLOAD_BODY }));

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
  /**
   * Force one of the playbook's eighteen scenarios instead of letting the
   * findings choose. Required for the nine no automated check can establish —
   * a new branch, a registrar account, an incident in their sector — where the
   * person writing is the one supplying the evidence.
   */
  scenarioKey: z.string().max(40).nullish(),
  /**
   * Whether to go and look at the business before writing to it.
   * "auto" looks when nobody has, or when the last look has gone stale.
   */
  prepare: z.enum(["auto", "always", "never"]).default("auto"),
  /** The plain-English pass. On by default — see lib/emailPolish.ts. */
  polish: z.boolean().default(true),
});

/**
 * Writes a draft. Nothing is stored and nothing is sent.
 *
 * Three stages, in this order, and the order is the point:
 *
 *  1. **Look at them** — research, audit, a picture of their homepage — unless
 *     somebody already has and it is still fresh. An email written from a
 *     record nobody has looked at can only be generic, because generic is all
 *     the record contains.
 *  2. **Draft**, from those facts and no others.
 *  3. **Polish**, which changes how it is said and not what it says, and
 *     reports back on whether the email actually does its job.
 *
 * Every stage is allowed to fail. A missing key at stage one costs specificity
 * and says so; a missing key at stage three returns the draft untouched. What
 * comes back is always something a person can send.
 */
emailsRouter.post("/draft", async (req, res, next) => {
  try {
    const input = draftInput.parse(req.body);

    // --- 1. Look ----------------------------------------------------------
    let prep: Awaited<ReturnType<typeof prepareLead>> | null = null;
    let prepError: string | null = null;
    let lookedNow = false;
    if (input.leadId && input.prepare !== "never") {
      const stored = await storedPrep(input.leadId);
      const needed = input.prepare === "always" || isStale(stored?.ranAt);
      if (needed) {
        try {
          prep = await prepareLead(input.leadId);
          lookedNow = true;
        } catch (err) {
          // Not fatal. The draft is worse without it, and the composer says so.
          prepError = (err as Error).message;
        }
      }
    }

    // Resolved after the prep, so the draft is written from the filled-in
    // record rather than the one that walked in.
    const context = await resolveContext(input);

    // When the prep was read from store rather than re-run, the strength has
    // to come back out of the stored JSON.
    let storedStrength: ReturnType<typeof caseStrength> | null = prep?.strength ?? null;
    if (!storedStrength && input.leadId) {
      const stored = await storedPrep(input.leadId);
      if (stored) storedStrength = caseStrength(stored.audit as never, stored.look as never);
    }

    // --- 2. Draft ---------------------------------------------------------
    const draft = await draftEmail({
      purpose: input.purpose,
      scenarioKey: input.scenarioKey,
      context,
      brief: input.brief,
      existingSubject: input.existingSubject,
      existingBody: input.existingBody,
      extraFacts: input.extraFacts,
    });

    // --- 3. Polish --------------------------------------------------------
    let polished: Awaited<ReturnType<typeof polishEmail>> | null = null;
    let polishError: string | null = null;
    if (input.polish) {
      try {
        polished = await polishEmail({
          subject: draft.subject,
          body: draft.body,
          purpose: input.purpose,
          recipient: context.name,
          facts: context.facts,
        });
      } catch (err) {
        polishError = (err as Error).message;
      }
    }

    // --- 4. The playbook's pre-send checklist ------------------------------
    //
    // Run on what would actually be sent — the polished version when there is
    // one — because the polish rewrites sentences and a check against the
    // pre-polish draft is a check against a draft nobody is sending.
    const finalSubject = polished?.subject ?? draft.subject;
    const finalBody = polished?.body ?? draft.body;
    const scenario = input.purpose === "COLD_OUTREACH" ? chooseScenario(context.findingIds ?? [], input.scenarioKey ?? null) : null;
    const checks = preSendCheck({
      subject: finalSubject,
      body: finalBody,
      firstEmail: input.purpose === "COLD_OUTREACH",
      // The renderer appends it to every cold email, so the drafter is not
      // asked to remember it and the check does not fail on its absence here.
      optOutAppended: input.purpose === "COLD_OUTREACH",
      exampleWording: scenario ? exampleWording(scenario.scenario) : [],
    });

    res.json({
      ...draft,
      // What goes in the box: the polished version when there is one.
      subject: finalSubject,
      body: finalBody,
      /** Which of the eighteen this is, what else fired, and what a person could pick instead. */
      scenario: scenario
        ? {
            key: scenario.scenario.key,
            number: scenario.scenario.number,
            name: scenario.scenario.name,
            contact: scenario.scenario.contact,
            exampleAsk: scenario.scenario.exampleAsk,
            guard: scenario.scenario.guard,
            matched: scenario.matched,
            alsoAvailable: scenario.alsoAvailable,
          }
        : null,
      /** The nine a person supplies the evidence for. */
      pickableScenarios: input.purpose === "COLD_OUTREACH" ? manualScenarios().map((one) => ({ key: one.key, number: one.number, name: one.name })) : [],
      checks,
      variables: context.variables,
      facts: context.facts,
      /** The draft as written, so a person can flip back to it. */
      beforePolish: polished ? { subject: draft.subject, body: draft.body } : null,
      polish: polished
        ? {
            polishedBy: polished.polishedBy,
            changes: polished.changes,
            servesPurpose: polished.servesPurpose,
            concerns: polished.concerns,
            added: polished.added,
          }
        : null,
      polishError,
      prep: prep
        ? {
            ranAt: prep.ranAt,
            ranNow: lookedNow,
            researchedBy: prep.research?.researchedBy ?? null,
            searchedLiveSources: prep.research?.searchedLiveSources ?? false,
            filled: prep.filled,
            proposedContact: prep.proposedContact,
            look: prep.look,
            shot: prep.shot,
            notes: prep.notes,
            strength: prep.strength,
            costUsd: prep.costUsd,
          }
        : null,
      prepError,
      /**
       * Whether there was anything here worth writing about, from this
       * request's own look or from the stored one. Shown to the sender, who is
       * the only one who can decide not to send.
       */
      strength: prep?.strength ?? storedStrength,
      preparedAt: context.preparedAt ?? null,
    });
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

/**
 * What the recipient will actually see, without saving anything.
 *
 * The old version of this rendered the body alone, which answered a different
 * and much less useful question — a letter with no letterhead is not what
 * lands in the inbox. This runs the same `renderEmail` a real send runs, so
 * placeholders are filled from the recipient's own record, the signature is
 * appended, the opt-out appears exactly when it would, and the whole thing is
 * wrapped in the identity currently stored under System settings.
 *
 * One difference, and it is deliberate: `forPreview` swaps the `cid:` logo
 * references for data URLs, because the iframe showing this has no message to
 * resolve a `cid:` against and would otherwise show two broken images.
 */
emailsRouter.post("/preview", async (req, res, next) => {
  try {
    const input = z
      .object({
        subject: z.string().default(""),
        body: z.string().default(""),
        purpose: z.enum(PURPOSES).default("CUSTOM"),
        leadId: z.string().cuid().nullish(),
        clientId: z.string().cuid().nullish(),
        // Deliberately looser than the compose route: a preview is looked at
        // *while* an address is being typed, and refusing to render "ama@" is
        // refusing at exactly the moment somebody wants to see the letter.
        // Anything that isn't a usable address falls through to the recipient
        // on the record, and then to a placeholder.
        toEmail: z
          .string()
          .nullish()
          .transform((value) => (value && /^\S+@\S+\.\S+$/.test(value) ? value : null)),
        toName: z.string().nullish(),
        attachments: z.array(attachment).max(10).optional(),
      })
      .parse(req.body);

    const context = await resolveContext(input);
    // A preview with nobody picked yet still has to render, so the opt-out
    // link has something to sign. Nothing is sent from here.
    const toEmail = input.toEmail ?? context.email ?? "someone@example.com";
    const rendered = await renderEmail({
      subject: input.subject,
      body: input.body,
      variables: context.variables,
      toEmail,
      appUrl: await appUrl(),
      includeUnsubscribe: COLD_PURPOSES.has(input.purpose),
      forPreview: true,
    });

    res.json({
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      toEmail,
      toName: input.toName ?? context.name,
      from: await describeSender(),
      variables: context.variables,
      unresolved: unresolvedPlaceholders([input.subject, input.body].join("\n"), context.variables),
      attachments: await describeAttachments(input.attachments ?? []),
      suppressed: await isSuppressed(toEmail),
      historical: false,
    });
  } catch (err) {
    next(err);
  }
});

/** The same, for a message already in the outbox — a draft, or a record of one sent. */
emailsRouter.get("/:id/preview", async (req, res, next) => {
  try {
    const message = await prisma.emailMessage.findUnique({ where: { id: req.params.id } });
    if (!message) return res.status(404).json({ error: "Email not found" });

    const attachments = await describeAttachments(parseAttachments(message.attachments));
    const from = await describeSender();

    // A sent message is shown exactly as it went out — its stored HTML rather
    // than a re-render, because re-rendering on today's letterhead would
    // misrepresent what the recipient actually received. Only the cid:
    // references are swapped for data URLs so an iframe can display them.
    if (message.status === "SENT") {
      return res.json({
        subject: message.subject,
        html: await inlineCids(message.bodyHtml),
        text: message.bodyText,
        toEmail: message.toEmail,
        toName: message.toName,
        from,
        variables: {},
        unresolved: [],
        attachments,
        suppressed: null,
        historical: true,
      });
    }

    const context = await resolveContext({ leadId: message.leadId, clientId: message.clientId, toEmail: message.toEmail });
    const rendered = await renderEmail({
      subject: message.subject,
      body: message.bodyText,
      variables: context.variables,
      toEmail: message.toEmail,
      appUrl: await appUrl(),
      includeUnsubscribe: COLD_PURPOSES.has(message.purpose),
      forPreview: true,
    });
    res.json({
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      toEmail: message.toEmail,
      toName: message.toName,
      from,
      variables: context.variables,
      unresolved: unresolvedPlaceholders([message.subject, message.bodyText].join("\n"), context.variables),
      attachments,
      suppressed: await isSuppressed(message.toEmail),
      historical: false,
    });
  } catch (err) {
    next(err);
  }
});

/** Who the message will appear to be from, for the preview's header row. */
async function describeSender(): Promise<{ name: string; email: string; replyTo: string | null }> {
  const profile = await companyProfile();
  const [name, email, replyTo] = await Promise.all([
    getSetting(SETTING.MAIL_FROM_NAME),
    getSetting(SETTING.MAIL_FROM_EMAIL),
    getSetting(SETTING.MAIL_REPLY_TO),
  ]);
  return { name: name || profile.displayName, email: email || profile.email, replyTo };
}

/**
 * `{{first_name}}` left in the text with nothing to fill it.
 *
 * This is the one thing a preview is genuinely for. A placeholder nothing
 * fills renders as the literal braces — deliberately, see emailRender — so the
 * result is an email opening "Hi {{frist_name}}". Naming them above the
 * preview is cheaper than reading every line looking for one.
 */
function unresolvedPlaceholders(text: string, variables: Record<string, string>): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi)) {
    if (variables[match[1].toLowerCase()] === undefined) found.add(match[1]);
  }
  return [...found];
}

/** Turns `cid:` references in stored HTML into data URLs an iframe can show. */
async function inlineCids(html: string): Promise<string> {
  let out = html;
  for (const cid of [LOGO_CID, LOGO_DARK_CID]) {
    if (!out.includes(`cid:${cid}`)) continue;
    const dataUrl = await brandDataUrl(cid);
    // Nothing to swap in: strip the tag rather than leave a broken image.
    out = dataUrl ? out.split(`cid:${cid}`).join(dataUrl) : out.replace(new RegExp(`<img[^>]*cid:${cid}[^>]*>`, "g"), "");
  }
  return out;
}

/** Each attachment as a chip: what it is, how big, and whether it still exists. */
async function describeAttachments(entries: StoredAttachment[]) {
  return Promise.all(
    entries.map(async (entry) => {
      if ("kind" in entry && entry.kind === "stored") {
        const file = await fileSummary(entry.fileId);
        return {
          kind: "stored" as const,
          name: entry.name,
          contentType: file?.contentType ?? entry.contentType ?? null,
          size: file?.size ?? entry.size ?? null,
          fileId: entry.fileId,
          url: null as string | null,
          note: null as string | null,
          // The one state worth shouting about: the send skips it silently.
          missing: !file,
        };
      }
      if ("kind" in entry && entry.kind === "invoice") {
        const invoice = await prisma.invoice.findUnique({ where: { id: entry.invoiceId }, select: { invoiceNumber: true } });
        return {
          kind: "invoice" as const,
          name: entry.name ?? (invoice ? `${invoice.invoiceNumber}.pdf` : "Invoice.pdf"),
          contentType: "application/pdf",
          size: null,
          fileId: null,
          url: null,
          note: "Rendered fresh when it sends.",
          missing: !invoice,
        };
      }
      if ("kind" in entry && entry.kind === "proposal") {
        const proposal = await prisma.proposal.findUnique({ where: { id: entry.proposalId }, select: { title: true } });
        return {
          kind: "proposal" as const,
          name: entry.name ?? (proposal ? `${proposal.title}.pdf` : "Proposal.pdf"),
          contentType: "application/pdf",
          size: null,
          fileId: null,
          url: null,
          note: "Rendered fresh when it sends.",
          missing: !proposal,
        };
      }
      const linked = entry as { name: string; url: string; contentType?: string };
      return {
        kind: "file" as const,
        name: linked.name,
        contentType: linked.contentType ?? null,
        size: null,
        fileId: null,
        url: linked.url,
        note: null,
        missing: false,
      };
    }),
  );
}

// --- Attachments -----------------------------------------------------------

/**
 * A real file, uploaded and held until a message refers to it.
 *
 * The upload happens when the file is picked rather than when Send is pressed,
 * so a 6 MB scan is already on the server while the letter is still being
 * written and Send is instant. The bytes and the limits are in
 * services/fileStore.ts; attaching by URL still exists beside this and is
 * still the better answer for anything large.
 */
emailsRouter.post("/attachments", async (req, res, next) => {
  try {
    const input = z
      .object({
        filename: z.string().min(1).max(200),
        contentType: z.string().max(120).nullish(),
        dataBase64: z.string().min(4),
      })
      .parse(req.body);

    const file = await storeFile({
      filename: input.filename,
      contentType: input.contentType,
      dataBase64: input.dataBase64,
      uploadedById: req.dbUser?.id ?? null,
    });
    res.status(201).json(file);
  } catch (err) {
    if (err instanceof FileStoreError) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

/**
 * The file back. Inline rather than as a download, so the preview panel can
 * show a PDF or an image in place; `?download=1` forces the save dialog.
 */
emailsRouter.get("/attachments/:id", async (req, res, next) => {
  try {
    const file = await readFile(req.params.id);
    if (!file) return res.status(404).json({ error: "That file is no longer here." });
    res.setHeader("Content-Type", file.contentType);
    res.setHeader("Content-Disposition", `${req.query.download ? "attachment" : "inline"}; filename="${file.filename.replace(/"/g, "")}"`);
    // Private: it is a client's document, not a public asset.
    res.setHeader("Cache-Control", "private, max-age=300");
    res.send(file.data);
  } catch (err) {
    next(err);
  }
});

emailsRouter.delete("/attachments/:id", async (req, res, next) => {
  try {
    await deleteFile(req.params.id);
    res.status(204).end();
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
    const profile = await companyProfile();
    if (!email) return res.status(400).type("html").send(page(profile, "That link is missing an address.", false));

    const verified = token ? verifyUnsubscribeToken(email, token) : false;
    await prisma.emailSuppression.upsert({
      where: { email },
      update: {},
      create: { email, reason: "Unsubscribed from an email", source: verified ? "UNSUBSCRIBED" : "UNSUBSCRIBED_UNVERIFIED" },
    });
    await stopOnReply({ email });

    res.type("html").send(page(profile, "You have been unsubscribed. We will not email you again.", true));
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

function page(profile: CompanyProfile, message: string, ok: boolean): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${profile.displayName}</title>
<style>body{font-family:"DM Sans",-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#08101F;color:#F4F5F0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px}
.card{border:1px solid rgba(255,255,255,.10);padding:40px;max-width:440px;text-align:center}
h1{font-size:.8rem;letter-spacing:.18em;text-transform:uppercase;margin:0 0 18px;color:#B8FF3D}
p{margin:0;line-height:1.6;font-size:15px;color:${ok ? "#F4F5F0" : "rgba(244,245,240,.7)"}}</style></head>
<body><div class="card"><h1>${profile.displayName}</h1><p>${message}</p></div></body></html>`;
}
