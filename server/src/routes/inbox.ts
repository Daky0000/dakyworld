import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { mailReadingConfigured, readImapConfig } from "../lib/imap.js";
import { MailflareReadError, checkMailflareRead, readMailflareReadConfig } from "../lib/mailflareRead.js";
import { SETTING, getSetting, isEnvManaged, setSetting } from "../lib/settings.js";
import { sendMail } from "../lib/mailer.js";
import { logoSources, signature, toHtml, toText } from "../services/emailRender.js";
import { companyProfile } from "../services/systemProfile.js";
import { restartWatcher, watcherStatus } from "../services/mailbox/watcher.js";
import { handOverMessage, inboxSummary, markHandled } from "../services/mailbox/actions.js";
import { retriage } from "../services/mailbox/ingest.js";
import { NEEDS_NO_REPLY, autoRouteEnabled, destinationFor } from "../services/mailbox/router.js";
import { syncMailbox } from "../services/mailbox/sync.js";
import { triageEnabled } from "../services/mailbox/triage.js";
import { gateBy } from "../middleware/permissionGate.js";

/**
 * The Inbox screen.
 *
 * Deliberately separate from `routes/emails.ts`, which is the outbox. The two
 * are asked opposite questions: the outbox answers "what have we sent and what
 * is queued", and this answers "what is still owed a reply" — and the second
 * is a to-do list, which is why everything here sorts by what is unhandled
 * rather than by what is newest.
 *
 * **Route order matters in this file.** Every literal path is registered
 * before `/:id`, or Express answers `/threads` by looking for a message whose
 * id is "threads".
 */
export const inboxRouter = Router();

inboxRouter.use(
  gateBy({
    view: "inbox.view",
    // Replying is the one send here, and it is gated like the outbox below.
    create: "inbox.assign",
    routes: [{ path: /^\/sync$/, permission: "inbox.sync" }],
  }),
);

// The same three roles as email. What is in the mailbox is at least as
// sensitive as what leaves it — more so, since a stranger wrote it.

const STATUSES = ["NEW", "TRIAGED", "ROUTED", "HANDLED", "IGNORED", "FAILED"] as const;

/**
 * Every field of a message except its IMAP coordinates.
 *
 * `uid` and `uidValidity` are `BigInt`, and `res.json` throws outright on one —
 * "Do not know how to serialize a BigInt" — so a route that returned a whole
 * row would 500 on a message it had stored perfectly. They are the reader's
 * bookkeeping and nothing outside `services/mailbox/` has any use for them.
 */
const MESSAGE_FIELDS = {
  id: true,
  messageId: true,
  folder: true,
  direction: true,
  fromEmail: true,
  fromName: true,
  toEmails: true,
  ccEmails: true,
  subject: true,
  bodyText: true,
  bodyHtml: true,
  snippet: true,
  sentAt: true,
  receivedAt: true,
  attachments: true,
  hasAttachments: true,
  autoSubmitted: true,
  triage: true,
  intent: true,
  summary: true,
  urgency: true,
  needsReply: true,
  confidence: true,
  triagedAt: true,
  triageError: true,
  routedAgentKey: true,
  taskId: true,
  routedAt: true,
  replyToEmailId: true,
  leadId: true,
  clientId: true,
  threadId: true,
  handledAt: true,
  handledById: true,
  handledNote: true,
} as const;

/**
 * What "still owed a reply" means, in one place.
 *
 * Used by the list and by both headline counts, because a screen whose tile
 * and whose table disagree about what is outstanding is worse than either
 * number on its own.
 */
const OPEN_WHERE: Prisma.MailMessageWhereInput = {
  direction: "INBOUND",
  handledAt: null,
  triage: { not: "IGNORED" },
  // `notIn` on its own excludes a message that has not been read yet, because
  // null is not "not in" anything in SQL.
  OR: [{ intent: null }, { intent: { notIn: NEEDS_NO_REPLY } }],
};

/** Where the mail room stands: connected, reading, and what it has been told to do. */
inboxRouter.get("/status", async (_req, res, next) => {
  try {
    const [config, mailflare, connected, triage, autoRoute, cursors, counts] = await Promise.all([
      readImapConfig(),
      readMailflareReadConfig(),
      mailReadingConfigured(),
      triageEnabled(),
      autoRouteEnabled(),
      prisma.mailSyncState.findMany({ orderBy: [{ lastSyncAt: "desc" }, { folder: "asc" }] }),
      prisma.mailMessage.groupBy({ by: ["triage"], _count: { _all: true }, where: { direction: "INBOUND" } }),
    ]);

    // Both counts exclude machine mail, for the reason `NEEDS_NO_REPLY`
    // exists: a headline number that goes up every time a newsletter arrives
    // is a number nobody looks at twice.
    const [open, waiting] = await Promise.all([
      prisma.mailMessage.count({ where: OPEN_WHERE }),
      prisma.mailMessage.count({ where: { ...OPEN_WHERE, triage: "TRIAGED", taskId: null } }),
    ]);

    res.json({
      connected,
      mailbox: mailflare?.address ?? config?.mailbox ?? null,
      host: mailflare ? "Mailflare" : config?.host ?? null,
      source: mailflare ? "MAILFLARE" : config ? "IMAP" : null,
      // Offered on the screen when mail is sent through Mailflare but not yet read from it.
      mailflareReadable: Boolean(mailflare),
      mailflareSending: (await getSetting(SETTING.MAIL_TRANSPORT)) === "MAILFLARE",
      mailflareKeyEnvManaged: isEnvManaged(SETTING.MAILFLARE_READ_KEY),
      triage,
      autoRoute,
      watcher: watcherStatus(),
      // Only the cursors of the mailbox being read now; an old IMAP cursor beside
      // a Mailflare one would show a week-old error as the current state.
      folders: cursors.filter((cursor) => cursor.mailbox === (mailflare ? `mailflare:${mailflare.address}` : config?.mailbox)).map((cursor) => ({
        folder: cursor.folder,
        lastSyncAt: cursor.lastSyncAt,
        lastError: cursor.lastError,
        messagesSeen: cursor.messagesSeen,
      })),
      counts: Object.fromEntries(counts.map((row) => [row.triage, row._count._all])),
      open,
      waiting,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Reads the mailbox now.
 *
 * The button exists because "is it working" is the question somebody asks the
 * moment they paste a password, and waiting up to a minute for the tick to
 * answer it feels like a failure. Awaited rather than fired and forgotten, so
 * what comes back is what actually happened.
 */
inboxRouter.post("/sync", async (_req, res, next) => {
  try {
    if (!(await mailReadingConfigured())) {
      return res.status(503).json({ error: "No mailbox is connected for reading. Settings → Email → Reading the inbox." });
    }
    const result = await syncMailbox();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/** The conversations, newest activity first. The screen's left-hand list. */
inboxRouter.get("/threads", async (req, res, next) => {
  try {
    const input = z
      .object({
        q: z.string().max(120).optional(),
        unreadOnly: z.enum(["true", "false"]).optional(),
        take: z.coerce.number().int().min(1).max(100).default(40),
      })
      .parse(req.query);

    const threads = await prisma.mailThread.findMany({
      where: {
        ...(input.unreadOnly === "true" ? { unreadCount: { gt: 0 } } : {}),
        ...(input.q
          ? {
              OR: [
                { subject: { contains: input.q, mode: "insensitive" } },
                { counterpartEmail: { contains: input.q, mode: "insensitive" } },
                { counterpartName: { contains: input.q, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      orderBy: { lastMessageAt: "desc" },
      take: input.take,
      include: {
        lead: { select: { id: true, contactName: true, companyName: true } },
        client: { select: { id: true, name: true, company: true } },
      },
    });
    res.json(threads);
  } catch (err) {
    next(err);
  }
});

/** One conversation in full, both directions, oldest first. */
inboxRouter.get("/threads/:id", async (req, res, next) => {
  try {
    const thread = await prisma.mailThread.findUnique({
      where: { id: req.params.id },
      include: {
        lead: { select: { id: true, contactName: true, companyName: true, status: true } },
        client: { select: { id: true, name: true, company: true } },
        messages: { orderBy: { sentAt: "asc" }, select: MESSAGE_FIELDS },
      },
    });
    if (!thread) return res.status(404).json({ error: "No such conversation." });
    res.json(thread);
  } catch (err) {
    next(err);
  }
});

/** The list the screen opens on: what is still owed a reply. */
inboxRouter.get("/", async (req, res, next) => {
  try {
    const input = z
      .object({
        status: z.enum(STATUSES).optional(),
        openOnly: z.enum(["true", "false"]).default("true"),
        take: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(req.query);

    const messages = await prisma.mailMessage.findMany({
      where: {
        direction: "INBOUND",
        ...(input.status ? { triage: input.status } : {}),
        ...(input.openOnly === "true" && !input.status ? OPEN_WHERE : {}),
      },
      orderBy: [{ urgency: "asc" }, { receivedAt: "desc" }],
      take: input.take,
      include: {
        lead: { select: { id: true, contactName: true, companyName: true } },
        client: { select: { id: true, name: true, company: true } },
      },
    });

    res.json(
      messages.map((message) => ({
        ...inboxSummary(message),
        lead: message.lead,
        client: message.client,
        // Shown next to an unrouted message so the screen can say who it
        // *would* have gone to, which is the question a person asks first.
        wouldGoTo: message.intent ? destinationFor(message.intent, Boolean(message.clientId)) : null,
      })),
    );
  } catch (err) {
    next(err);
  }
});

/**
 * Connects the mail room to Mailflare for reading: a key with the JMAP
 * permission, checked against Mailflare before it is stored, then one pass so
 * the screen fills straight away. The URL and mailbox come from the sending
 * settings already in place.
 */
inboxRouter.post("/mailflare", async (req, res, next) => {
  try {
    const { key } = z.object({ key: z.string().trim().min(10).max(300) }).parse(req.body);
    if (isEnvManaged(SETTING.MAILFLARE_READ_KEY)) {
      return res.status(409).json({ error: "The reading key is set on the server (MAILFLARE_READ_API_KEY) and cannot be changed here." });
    }
    const [url, mailboxId, address, fromEmail] = await Promise.all([
      getSetting(SETTING.MAILFLARE_URL),
      getSetting(SETTING.MAILFLARE_MAILBOX_ID),
      getSetting(SETTING.MAILFLARE_MAILBOX_ADDRESS),
      getSetting(SETTING.MAIL_FROM_EMAIL),
    ]);
    const mailbox = (address ?? fromEmail)?.trim().toLowerCase();
    if (!url || !mailboxId || !mailbox) {
      return res.status(400).json({ error: "Mailflare sending is not set up yet (its address and mailbox), so there is nothing to read from." });
    }
    try {
      await checkMailflareRead({ url: url.replace(/\/+$/, ""), key, mailboxId, address: mailbox });
    } catch (err) {
      const status = err instanceof MailflareReadError && err.status < 500 ? 400 : 502;
      return res.status(status).json({ error: (err as Error).message });
    }
    await setSetting(SETTING.MAILFLARE_READ_KEY, key, { secret: true });
    await restartWatcher().catch(() => undefined);
    const result = await syncMailbox();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * Answers a message from the Inbox screen.
 *
 * Goes out through the configured transport with the threading headers, so it
 * lands in the sender's conversation, and is marked handled. The copy in
 * Mailflare's Sent folder is read back on the next pass, which is what the
 * mail room already treats as "the Owner answered": the sequence stops.
 */
inboxRouter.post("/:id/reply", async (req, res, next) => {
  try {
    const input = z.object({ body: z.string().trim().min(1).max(20_000) }).parse(req.body);
    const message = await prisma.mailMessage.findUnique({
      where: { id: req.params.id },
      select: { id: true, direction: true, fromEmail: true, fromName: true, subject: true, messageId: true, references: true, handledAt: true },
    });
    if (!message) return res.status(404).json({ error: "No such message." });
    if (message.direction !== "INBOUND") return res.status(400).json({ error: "That is a message we sent; reply to the one that came in." });

    const subject = /^re:/i.test(message.subject.trim()) ? message.subject.trim() : `Re: ${message.subject.trim() || "your message"}`;
    const [sign, profile, shell] = await Promise.all([signature(), companyProfile(), logoSources(false)]);
    const receipt = await sendMail({
      to: message.fromEmail,
      toName: message.fromName,
      subject,
      html: toHtml(input.body, sign, null, { profile, ...shell }),
      text: toText(input.body, sign, null, profile),
      inReplyTo: message.messageId ? `<${message.messageId.replace(/^<|>$/g, "")}>` : null,
      category: "inbox:reply",
    });

    if (!message.handledAt) {
      await markHandled({ messageId: message.id, note: "Replied from the Inbox.", userId: req.dbUser?.id ?? null }).catch((err) =>
        console.warn("[inbox] reply sent but could not mark handled:", (err as Error).message),
      );
    }
    res.status(201).json({ sent: true, messageId: receipt.messageId });
  } catch (err) {
    next(err);
  }
});

inboxRouter.get("/:id", async (req, res, next) => {
  try {
    const message = await prisma.mailMessage.findUnique({
      where: { id: req.params.id },
      select: {
        ...MESSAGE_FIELDS,
        thread: { select: { id: true, subject: true, counterpartEmail: true, messageCount: true } },
        lead: { select: { id: true, contactName: true, companyName: true, status: true } },
        client: { select: { id: true, name: true, company: true } },
        replyToEmail: { select: { id: true, subject: true, sentAt: true, purpose: true } },
        handledBy: { select: { id: true, name: true } },
      },
    });
    if (!message) return res.status(404).json({ error: "No such message." });
    res.json(message);
  } catch (err) {
    next(err);
  }
});

/** Read it again — for the classification that is simply wrong. */
inboxRouter.post("/:id/retriage", async (req, res, next) => {
  try {
    const result = await retriage(req.params.id);
    res.json({ message: inboxSummary(result.message), routedTo: result.routedTo, taskId: result.taskId, notes: result.notes });
  } catch (err) {
    next(err);
  }
});

/** Hand it to somebody, by hand. */
inboxRouter.post("/:id/route", async (req, res, next) => {
  try {
    const input = z.object({ agentKey: z.string().min(1), why: z.string().min(10).max(500) }).parse(req.body);
    const result = await handOverMessage({ messageId: req.params.id, ...input, by: req.dbUser?.name ?? "the Owner" });
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

inboxRouter.post("/:id/handled", async (req, res, next) => {
  try {
    const input = z.object({ note: z.string().min(3).max(500), ignored: z.boolean().default(false) }).parse(req.body);
    const result = await markHandled({ messageId: req.params.id, ...input, userId: req.dbUser?.id ?? null });
    res.json(result);
  } catch (err) {
    next(err);
  }
});
