import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireRole } from "../middleware/auth.js";
import { defaultCallingCode, displayPhone, smsCost, toE164, toGsm7, waLink } from "../lib/phone.js";
import { hubtelSmsConfigured } from "../lib/hubtel.js";
import { describeNumber, whatsappConfigured, whatsappTemplatesConfigured } from "../lib/whatsapp.js";
import { draftMessage } from "../lib/messageDrafter.js";
import { analystConfigured } from "../lib/anthropic.js";
import { preSendCheck } from "../services/coldEmailChecks.js";
import { chooseScenario, exampleWording, manualScenarios } from "../services/coldEmailScenarios.js";
import { caseStrength, isStale, prepareLead, storedPrep } from "../services/leadPrep.js";
import { resolveContext } from "../services/emailContext.js";
import {
  MessagingError,
  composeMessage,
  dispatchDueMessages,
  isPhoneSuppressed,
  leadReachability,
  markSentByHand,
  reachabilityOf,
  sendPhoneMessage,
  suppressPhone,
  windowOpen,
  windowRemainingMinutes,
} from "../services/messageSender.js";
import { STARTER_TEMPLATES, checkTemplate, removeTemplate, submitTemplate, syncTemplates, templateNameFrom } from "../services/whatsappTemplates.js";

/**
 * WhatsApp and SMS — the outbox, the conversations, and the templates.
 *
 * Sits beside `routes/emails.ts` rather than inside it. The two share a
 * doctrine and share almost no mechanics: there is no subject here, no
 * attachments, no cc, no HTML, and there *is* a 24-hour window that decides
 * whether a written message can be sent at all.
 *
 * **Route order matters in this file.** Every literal path is registered
 * before `/:id`, or Express answers `/threads` by looking for a message whose
 * id is "threads".
 */
export const messagesRouter = Router();

// Writing to a stranger's personal phone under the company's name is not a
// junior privilege — the same three roles as email, for the same reason.
messagesRouter.use(requireRole("OWNER", "OPERATIONS_FINANCE", "PROJECT_MANAGER"));

const CHANNELS = ["WHATSAPP", "SMS"] as const;

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

/** Turns a MessagingError into its own status rather than a 500. */
function fail(err: unknown, next: (err?: unknown) => void) {
  next(err);
}

// --- Status ----------------------------------------------------------------

messagesRouter.get("/status", async (_req, res, next) => {
  try {
    const [whatsapp, templates, sms, drafterReady, counts, threads, unread, suppressed] = await Promise.all([
      whatsappConfigured(),
      whatsappTemplatesConfigured(),
      hubtelSmsConfigured(),
      analystConfigured(),
      prisma.message.groupBy({ by: ["status"], where: { direction: "OUTBOUND" }, _count: true }),
      prisma.messageThread.count(),
      prisma.messageThread.count({ where: { unreadCount: { gt: 0 } } }),
      prisma.messageSuppression.count(),
    ]);

    const byStatus = Object.fromEntries(counts.map((row) => [row.status, row._count]));

    // Meta's read on how recipients are reacting to us. Fetched rather than
    // stored because it changes on its own, and it is the single most
    // consequential number in cold outreach on this channel: a number that
    // reaches RED loses the ability to start conversations at all.
    let quality: Awaited<ReturnType<typeof describeNumber>> | null = null;
    let qualityError: string | null = null;
    if (whatsapp) {
      try {
        quality = await describeNumber();
      } catch (err) {
        qualityError = (err as Error).message;
      }
    }

    res.json({
      whatsapp,
      whatsappTemplates: templates,
      sms,
      drafterReady,
      drafts: byStatus.DRAFT ?? 0,
      scheduled: byStatus.SCHEDULED ?? 0,
      ready: byStatus.READY ?? 0,
      sent: (byStatus.SENT ?? 0) + (byStatus.DELIVERED ?? 0) + (byStatus.READ ?? 0),
      failed: byStatus.FAILED ?? 0,
      threads,
      unread,
      suppressed,
      quality,
      qualityError,
      defaultCallingCode: await defaultCallingCode(),
    });
  } catch (err) {
    next(err);
  }
});

// --- Who can be reached, and how -------------------------------------------

/**
 * The screen this whole module was built for: leads with a number and no email.
 *
 * Until now this was the largest single group in the database and the only one
 * nothing could act on — a Maps scrape returns a phone number nearly every
 * time and an email address rarely, so capturing them and then being unable to
 * write to them made the capture pointless.
 */
messagesRouter.get("/phone-only", async (req, res, next) => {
  try {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const groupId = typeof req.query.groupId === "string" ? req.query.groupId : undefined;
    const take = Math.min(Number(req.query.limit) || 100, 500);

    const leads = await prisma.lead.findMany({
      where: {
        OR: [{ contactEmail: null }, { contactEmail: "" }],
        NOT: [{ contactPhone: null }, { contactPhone: "" }],
        // A rehearsal lead starts with no number at all, and then `leadPrep`
        // reads one off the business's own homepage — which is exactly how it
        // would arrive on this list and be texted.
        rehearsal: false,
        status: status ? (status as never) : undefined,
        groupId,
      },
      orderBy: [{ leadScore: "desc" }, { createdAt: "desc" }],
      take,
      select: {
        id: true,
        contactName: true,
        companyName: true,
        contactPhone: true,
        city: true,
        category: true,
        website: true,
        leadScore: true,
        status: true,
        tags: true,
        createdAt: true,
      },
    });

    const code = await defaultCallingCode();
    const suppressedNumbers = new Set((await prisma.messageSuppression.findMany({ select: { phone: true } })).map((row) => row.phone));

    // Threads already open with any of them, so the list can say who has been
    // written to and who has answered.
    const threads = await prisma.messageThread.findMany({
      where: { leadId: { in: leads.map((lead) => lead.id) } },
      select: { leadId: true, channel: true, lastInboundAt: true, lastOutboundAt: true, unreadCount: true },
    });

    res.json(
      leads.map((lead) => {
        const parsed = toE164(lead.contactPhone, code);
        const mine = threads.filter((thread) => thread.leadId === lead.id);
        return {
          ...lead,
          phone: parsed ? { e164: parsed.e164, display: parsed.display, mobile: parsed.mobile, country: parsed.country } : null,
          // Named rather than left as a false: "we could not read that number"
          // and "that is a landline" are different problems with different fixes.
          unreachable: !parsed
            ? `"${lead.contactPhone}" could not be read as a phone number.`
            : !parsed.mobile
              ? "That looks like a landline — neither a text nor a WhatsApp would arrive."
              : suppressedNumbers.has(parsed.e164)
                ? "They have asked not to be contacted."
                : null,
          contacted: mine.some((thread) => thread.lastOutboundAt),
          replied: mine.some((thread) => thread.lastInboundAt),
          unread: mine.reduce((total, thread) => total + thread.unreadCount, 0),
        };
      }),
    );
  } catch (err) {
    next(err);
  }
});

messagesRouter.get("/reachability", async (req, res, next) => {
  try {
    if (typeof req.query.leadId === "string") return res.json(await leadReachability(req.query.leadId));
    const email = typeof req.query.email === "string" ? req.query.email : null;
    const phone = typeof req.query.phone === "string" ? req.query.phone : null;
    res.json(await reachabilityOf({ email, phone }));
  } catch (err) {
    fail(err, next);
  }
});

/** What a text will actually be billed as, for the composer's live counter. */
messagesRouter.post("/cost", async (req, res, next) => {
  try {
    const body = z.object({ body: z.string().max(4000) }).parse(req.body);
    const cost = smsCost(body.body);
    res.json({
      ...cost,
      // Offered, never applied silently — nobody would choose to pay triple for
      // the curl on an apostrophe, but it is still their message.
      gsm7: cost.encoding === "UCS-2" ? { body: toGsm7(body.body), ...smsCost(toGsm7(body.body)) } : null,
    });
  } catch (err) {
    next(err);
  }
});

// --- Conversations ---------------------------------------------------------

messagesRouter.get("/threads", async (req, res, next) => {
  try {
    const unreadOnly = req.query.unread === "true";
    const threads = await prisma.messageThread.findMany({
      where: unreadOnly ? { unreadCount: { gt: 0 } } : undefined,
      orderBy: [{ lastInboundAt: { sort: "desc", nulls: "last" } }, { updatedAt: "desc" }],
      take: 200,
      include: {
        lead: { select: { id: true, contactName: true, companyName: true, status: true } },
        client: { select: { id: true, name: true } },
        _count: { select: { messages: true } },
      },
    });

    const now = new Date();
    res.json(
      threads.map((thread) => ({
        ...thread,
        display: displayPhone(thread.phone),
        windowOpen: windowOpen(thread, now),
        windowMinutesLeft: windowRemainingMinutes(thread, now),
      })),
    );
  } catch (err) {
    next(err);
  }
});

messagesRouter.get("/threads/:id", async (req, res, next) => {
  try {
    const thread = await prisma.messageThread.findUnique({
      where: { id: req.params.id },
      include: {
        lead: { select: { id: true, contactName: true, companyName: true, status: true, website: true, city: true } },
        client: { select: { id: true, name: true } },
        messages: { orderBy: { createdAt: "asc" }, take: 300 },
      },
    });
    if (!thread) return res.status(404).json({ error: "Conversation not found" });

    const now = new Date();
    res.json({
      ...thread,
      display: displayPhone(thread.phone),
      windowOpen: windowOpen(thread, now),
      windowMinutesLeft: windowRemainingMinutes(thread, now),
      suppressed: await isPhoneSuppressed(thread.phone),
    });
  } catch (err) {
    next(err);
  }
});

messagesRouter.post("/threads/:id/read", async (req, res, next) => {
  try {
    await prisma.messageThread.update({ where: { id: req.params.id }, data: { unreadCount: 0 } });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// --- Templates -------------------------------------------------------------

messagesRouter.get("/templates", async (_req, res, next) => {
  try {
    const templates = await prisma.whatsAppTemplate.findMany({ orderBy: [{ status: "asc" }, { name: "asc" }] });
    res.json({
      templates,
      // Not seeded into the table on purpose: a row here that Meta has never
      // seen would appear in the composer as something sendable, and it isn't.
      starters: STARTER_TEMPLATES,
      configured: await whatsappTemplatesConfigured(),
    });
  } catch (err) {
    next(err);
  }
});

messagesRouter.post("/templates/sync", async (_req, res, next) => {
  try {
    res.json(await syncTemplates());
  } catch (err) {
    fail(err, next);
  }
});

const templateInput = z.object({
  name: z.string().min(1).max(120),
  language: z.string().min(2).max(10).default("en"),
  category: z.enum(["MARKETING", "UTILITY"]).default("MARKETING"),
  body: z.string().min(10).max(1024),
  header: z.string().max(60).nullish(),
  footer: z.string().max(60).nullish(),
  examples: z.array(z.string().max(200)).max(10).optional(),
});

/** Checks a template against Meta's rules without submitting it. */
messagesRouter.post("/templates/check", async (req, res, next) => {
  try {
    const input = templateInput.parse(req.body);
    const name = templateNameFrom(input.name);
    res.json({ name, problems: checkTemplate({ ...input, name }) });
  } catch (err) {
    next(err);
  }
});

messagesRouter.post("/templates", async (req, res, next) => {
  try {
    const input = templateInput.parse(req.body);
    res.status(201).json(await submitTemplate(input));
  } catch (err) {
    fail(err, next);
  }
});

messagesRouter.delete("/templates/:id", async (req, res, next) => {
  try {
    await removeTemplate(req.params.id);
    res.status(204).end();
  } catch (err) {
    fail(err, next);
  }
});

// --- Opt-outs --------------------------------------------------------------

messagesRouter.get("/suppression", async (_req, res, next) => {
  try {
    const rows = await prisma.messageSuppression.findMany({ orderBy: { createdAt: "desc" }, take: 500 });
    res.json(rows.map((row) => ({ ...row, display: displayPhone(row.phone) })));
  } catch (err) {
    next(err);
  }
});

messagesRouter.post("/suppression", async (req, res, next) => {
  try {
    const input = z.object({ phone: z.string().min(6).max(24), reason: z.string().min(1).max(200) }).parse(req.body);
    const parsed = toE164(input.phone, await defaultCallingCode());
    if (!parsed) return res.status(400).json({ error: `"${input.phone}" is not a number this can read.` });
    await suppressPhone(parsed.e164, input.reason, "MANUAL");
    res.status(201).json({ phone: parsed.e164, display: parsed.display });
  } catch (err) {
    next(err);
  }
});

messagesRouter.delete("/suppression/:id", async (req, res, next) => {
  try {
    await prisma.messageSuppression.delete({ where: { id: req.params.id } });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// --- Drafting --------------------------------------------------------------

const draftInput = z.object({
  channel: z.enum(CHANNELS),
  purpose: z.enum(PURPOSES).default("COLD_OUTREACH"),
  leadId: z.string().cuid().nullish(),
  clientId: z.string().cuid().nullish(),
  toPhone: z.string().max(24).nullish(),
  toName: z.string().max(120).nullish(),
  brief: z.string().max(2000).nullish(),
  existingBody: z.string().max(4000).nullish(),
  extraFacts: z.array(z.string().max(400)).max(20).optional(),
  scenarioKey: z.string().max(60).nullish(),
  /** Whether to go and look at the business first. Same three settings as email. */
  prepare: z.enum(["auto", "always", "never"]).default("auto"),
});

/**
 * Draft one message.
 *
 * The same three steps as the email drafter, minus the polish: look at the
 * business, write from what was found, run the checklist over what would
 * actually be sent. The polish stage is skipped deliberately — it is tuned to
 * rewrite a 120-word letter into plainer English, and run over forty words it
 * reliably lengthens them, which on this channel is the one thing that must
 * not happen.
 */
messagesRouter.post("/draft", async (req, res, next) => {
  try {
    const input = draftInput.parse(req.body);

    // 1. Look. Nothing writes to a lead until somebody has, and a WhatsApp
    //    written from a bare scrape is the same generic message an email would
    //    be, in a place where generic is far less welcome.
    let prepError: string | null = null;
    let lookedNow = false;
    let strength: ReturnType<typeof caseStrength> | null = null;
    if (input.leadId && input.prepare !== "never") {
      const stored = await storedPrep(input.leadId);
      if (input.prepare === "always" || isStale(stored?.ranAt)) {
        try {
          const prep = await prepareLead(input.leadId);
          strength = prep.strength;
          lookedNow = true;
        } catch (err) {
          prepError = (err as Error).message;
        }
      }
    }

    const context = await resolveContext(input);
    if (!strength && input.leadId) {
      const stored = await storedPrep(input.leadId);
      if (stored) strength = caseStrength(stored.audit as never, stored.look as never);
    }

    // 2. Write.
    const draft = await draftMessage({
      channel: input.channel,
      purpose: input.purpose,
      context,
      brief: input.brief,
      existingBody: input.existingBody,
      extraFacts: input.extraFacts,
      scenarioKey: input.scenarioKey,
    });

    // 3. Check what would actually be sent.
    const scenario = input.purpose === "COLD_OUTREACH" ? chooseScenario(context.findingIds ?? [], input.scenarioKey ?? null) : null;
    const cold = ["COLD_OUTREACH", "FOLLOW_UP", "MEETING_REQUEST", "REACTIVATION", "ANNOUNCEMENT"].includes(input.purpose);
    const checks = preSendCheck({
      subject: "",
      channel: input.channel,
      body: draft.body,
      firstEmail: input.purpose === "COLD_OUTREACH",
      // Appended by composeMessage at send, so the drafter is not asked to
      // remember it and the check does not fail on its absence here.
      optOutAppended: cold,
      exampleWording: scenario ? exampleWording(scenario.scenario) : [],
    });

    res.json({
      ...draft,
      channel: input.channel,
      checks,
      facts: context.facts,
      variables: context.variables,
      recipient: { name: context.name, phone: context.phone, email: context.email },
      caseStrength: strength,
      lookedNow,
      prepError,
      scenario: scenario
        ? {
            key: scenario.scenario.key,
            number: scenario.scenario.number,
            name: scenario.scenario.name,
            exampleAsk: scenario.scenario.exampleAsk,
            guard: scenario.scenario.guard,
            matched: scenario.matched,
            alsoAvailable: scenario.alsoAvailable,
          }
        : null,
      pickableScenarios:
        input.purpose === "COLD_OUTREACH" ? manualScenarios().map((one) => ({ key: one.key, number: one.number, name: one.name })) : [],
    });
  } catch (err) {
    fail(err, next);
  }
});

// --- The outbox ------------------------------------------------------------

messagesRouter.get("/", async (req, res, next) => {
  try {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const channel = typeof req.query.channel === "string" ? req.query.channel : undefined;
    const leadId = typeof req.query.leadId === "string" ? req.query.leadId : undefined;
    const search = typeof req.query.q === "string" ? req.query.q.trim() : "";

    const messages = await prisma.message.findMany({
      where: {
        status: status ? (status as never) : undefined,
        channel: channel ? (channel as never) : undefined,
        leadId,
        ...(search ? { OR: [{ body: { contains: search, mode: "insensitive" } }, { toPhone: { contains: search.replace(/\D/g, "") } }] } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 200,
      include: {
        lead: { select: { id: true, contactName: true, companyName: true } },
        client: { select: { id: true, name: true } },
      },
    });

    res.json(messages.map((message) => ({ ...message, display: displayPhone(message.toPhone) })));
  } catch (err) {
    next(err);
  }
});

const composeInput = z.object({
  channel: z.enum(CHANNELS),
  purpose: z.enum(PURPOSES).default("CUSTOM"),
  kind: z.enum(["MANUAL", "TEMPLATE", "AI_DRAFT", "SEQUENCE", "AUTOMATION"]).default("MANUAL"),
  route: z.enum(["API", "LINK"]).default("API"),
  body: z.string().max(4000).nullish(),
  templateName: z.string().max(120).nullish(),
  templateLanguage: z.string().max(10).nullish(),
  templateVariables: z.array(z.string().max(500)).max(12).optional(),
  toPhone: z.string().max(24).nullish(),
  toName: z.string().max(120).nullish(),
  leadId: z.string().cuid().nullish(),
  clientId: z.string().cuid().nullish(),
  projectId: z.string().cuid().nullish(),
  proposalId: z.string().cuid().nullish(),
  invoiceId: z.string().cuid().nullish(),
  carePlanId: z.string().cuid().nullish(),
  scheduledFor: z.coerce.date().nullish(),
  /** Send it straight away rather than leaving a draft. */
  send: z.boolean().default(false),
});

messagesRouter.post("/", async (req, res, next) => {
  try {
    const input = composeInput.parse(req.body);
    const message = await composeMessage({
      ...input,
      createdById: req.dbUser?.id ?? null,
      status: input.send && !input.scheduledFor ? "DRAFT" : undefined,
    });

    if (input.send && !input.scheduledFor) {
      const result = await sendPhoneMessage(message.id);
      const after = await prisma.message.findUnique({ where: { id: message.id } });
      return res.status(201).json({ ...after, display: displayPhone(message.toPhone), result });
    }

    res.status(201).json({ ...message, display: displayPhone(message.toPhone) });
  } catch (err) {
    fail(err, next);
  }
});

messagesRouter.get("/:id", async (req, res, next) => {
  try {
    const message = await prisma.message.findUnique({
      where: { id: req.params.id },
      include: {
        thread: true,
        lead: { select: { id: true, contactName: true, companyName: true } },
        client: { select: { id: true, name: true } },
      },
    });
    if (!message) return res.status(404).json({ error: "Message not found" });

    res.json({
      ...message,
      display: displayPhone(message.toPhone),
      cost: message.channel === "SMS" ? smsCost(message.body) : null,
      // Always offered, whatever the route: a message the API refused can
      // still be sent by hand, and that is usually the right next step.
      link: waLink(message.toPhone, message.body),
      windowOpen: windowOpen(message.thread),
    });
  } catch (err) {
    next(err);
  }
});

messagesRouter.patch("/:id", async (req, res, next) => {
  try {
    const input = z
      .object({ body: z.string().max(4000).optional(), scheduledFor: z.coerce.date().nullish(), toName: z.string().max(120).nullish() })
      .parse(req.body);

    const existing = await prisma.message.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: "Message not found" });
    if (["SENT", "DELIVERED", "READ", "SENDING"].includes(existing.status)) {
      return res.status(409).json({ error: "That message has already gone. A message on somebody's phone cannot be edited or recalled." });
    }

    const message = await prisma.message.update({
      where: { id: req.params.id },
      data: {
        body: input.body ?? undefined,
        toName: input.toName ?? undefined,
        scheduledFor: input.scheduledFor ?? undefined,
        status: input.scheduledFor ? "SCHEDULED" : undefined,
        segments: input.body && existing.channel === "SMS" ? smsCost(input.body).segments : undefined,
      },
    });
    res.json({ ...message, display: displayPhone(message.toPhone) });
  } catch (err) {
    next(err);
  }
});

messagesRouter.post("/:id/send", async (req, res, next) => {
  try {
    res.json(await sendPhoneMessage(req.params.id));
  } catch (err) {
    fail(err, next);
  }
});

/** A wa.me message a person sent from their own WhatsApp. See markSentByHand. */
messagesRouter.post("/:id/mark-sent", async (req, res, next) => {
  try {
    res.json(await markSentByHand(req.params.id, req.dbUser?.id ?? null));
  } catch (err) {
    fail(err, next);
  }
});

messagesRouter.post("/:id/cancel", async (req, res, next) => {
  try {
    const message = await prisma.message.update({ where: { id: req.params.id }, data: { status: "CANCELLED" } });
    res.json(message);
  } catch (err) {
    next(err);
  }
});

messagesRouter.delete("/:id", async (req, res, next) => {
  try {
    const message = await prisma.message.findUnique({ where: { id: req.params.id } });
    if (!message) return res.status(404).json({ error: "Message not found" });
    if (message.status === "SENT" || message.direction === "INBOUND") {
      return res.status(409).json({ error: "A message that was actually sent or received is part of the record and stays." });
    }
    await prisma.message.delete({ where: { id: req.params.id } });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/** For a manual run while testing the scheduler. */
messagesRouter.post("/dispatch/run-now", async (_req, res, next) => {
  try {
    res.json({ sent: await dispatchDueMessages() });
  } catch (err) {
    next(err);
  }
});

export { MessagingError };
