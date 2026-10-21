import type { NextFunction, Request, Response, Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { slackConfigured } from "../lib/slack.js";
import { appUrl } from "./emailSender.js";
import { emailOwner, type OwnerEmail } from "./opsAlert.js";
import { postNotification } from "./slack/notify.js";
import { WebsiteError } from "./website/site.js";
import { assertWebsiteSiteAccess, websiteCapabilities, websitePrincipal, websiteSiteFilter } from "./websiteAccess.js";
import type { WebsiteActor } from "./websiteActor.js";

/**
 * Developer requests: somebody editing a website asking a DakyXTech developer
 * for help.
 *
 * Until 21 Oct 2026 these were filed by keyword ("database", "booking",
 * "send") and by the model, so a customer changing the words on a page was
 * told their request had been "filed to the owner" and nobody was told at all
 * — the record was written, numbered by counting the site's rows, and never
 * announced. Now a request exists only because the person said yes to one,
 * every one is announced to staff by email and Slack, and its number is stored
 * once so the chat, the list and the email all say the same thing.
 */

const handler =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

export type CreateEscalationInput = {
  siteId: string;
  pageId?: string | null;
  pageTitle?: string | null;
  userPrompt: string;
  reason: "OUT_OF_SCOPE" | "UNSUPPORTED_CAPABILITY" | "EXECUTION_FAILURE" | "OWNER_REQUESTED";
  category: "custom_backend" | "third_party_integration" | "crm_or_leads" | "billing_or_account" | "complex_engineering" | "other";
  agentNotes: string;
  userId?: string | null;
  userEmail?: string | null;
  userName?: string | null;
};

/** DakyXTech staff who look after websites: they see every request and settle them. */
export function isWebsiteStaff(req: WebsiteActor): boolean {
  return websiteCapabilities(websitePrincipal(req), null).manage;
}

/**
 * The next number for this year, e.g. `ESC-2026-014`.
 *
 * Taken under a transaction-scoped advisory lock, so two requests filed in the
 * same instant cannot both read the same highest number. The highest is read
 * as an integer: a string comparison would put `ESC-2026-999` after
 * `ESC-2026-1000`. Counting rows is not used either — a deleted site takes its
 * requests with it, and the next count would reissue a number already emailed.
 */
async function nextReportNumber(tx: Pick<typeof prisma, "$queryRaw" | "$executeRaw">, year: number): Promise<string> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('website-escalation-number'))`;
  const prefix = `ESC-${year}-`;
  // No number is passed in: Prisma binds a JS integer as bigint, and
  // Postgres has no substring(text from bigint).
  const rows = await tx.$queryRaw<Array<{ highest: number | null }>>`
    SELECT max(split_part("reportNumber", '-', 3)::int) AS highest
    FROM "WebsiteEscalation"
    WHERE "reportNumber" LIKE ${`${prefix}%`}`;
  return `${prefix}${String((rows[0]?.highest ?? 0) + 1).padStart(3, "0")}`;
}

export async function createWebsiteEscalation(input: CreateEscalationInput) {
  if (input.pageId) {
    const page = await prisma.sitePage.findUnique({ where: { id: input.pageId }, select: { siteId: true, title: true } });
    if (!page || page.siteId !== input.siteId) throw new WebsiteError(400, "That page is not part of this website.");
    input = { ...input, pageTitle: input.pageTitle ?? page.title };
  }

  const record = await prisma.$transaction(async (tx) => {
    const reportNumber = await nextReportNumber(tx, new Date().getFullYear());
    const created = await tx.websiteEscalation.create({
      data: {
        reportNumber,
        siteId: input.siteId,
        pageId: input.pageId ?? null,
        pageTitle: input.pageTitle ?? null,
        userPrompt: input.userPrompt,
        reason: input.reason,
        category: input.category,
        agentNotes: input.agentNotes,
        userId: input.userId ?? null,
        userEmail: input.userEmail ?? null,
        userName: input.userName ?? null,
        status: "OPEN",
      },
      include: {
        site: { select: { id: true, name: true } },
      },
    });
    await tx.siteAuditEvent.create({
      data: {
        siteId: input.siteId,
        kind: "ESCALATION_FILED",
        summary: `Developer help requested (${reportNumber})`,
        actorName: input.userName || "Website editor",
        detail: {
          escalationId: created.id,
          reportNumber,
          category: input.category,
          reason: input.reason,
          prompt: input.userPrompt.slice(0, 150),
        },
      },
    });
    return created;
  });

  await notifyDeveloperRequest(record);
  return record;
}

type FiledRequest = Awaited<ReturnType<typeof createWebsiteEscalation>>;

function oneLine(value: string | null | undefined, max = 200): string | null {
  const text = value?.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : null;
}

/** The email, built from the request alone, so a check can read it without sending anything. */
export function developerRequestEmail(request: FiledRequest, inboxUrl: string): OwnerEmail {
  const who = oneLine(request.userName) ?? oneLine(request.userEmail) ?? "Somebody";
  return {
    subject: `Developer help requested: ${oneLine(request.site.name, 80)} (${request.reportNumber})`,
    paragraphs: [
      `${who} has asked a DakyXTech developer for help with ${request.site.name}.`,
      ...(request.pageTitle ? [`Page: ${oneLine(request.pageTitle, 120)}`] : []),
      ...(request.userEmail ? [`Email: ${oneLine(request.userEmail)}`] : []),
      "What they asked:",
      request.userPrompt.trim().slice(0, 3000),
      ...(request.agentNotes ? [`Notes: ${oneLine(request.agentNotes, 600)}`] : []),
    ],
    action: { label: "Open developer requests", url: inboxUrl },
    footnotes: [request.userEmail ? "Replying to this email writes to them directly." : "They have no email address on file; answer from the request."],
    category: "website:developer-request",
    replyTo: request.userEmail,
  };
}

/**
 * Tells staff, by email and by Slack when Slack is connected. Never throws:
 * the request is filed either way, and a mail fault must not turn the
 * person's "yes" into an error.
 */
async function notifyDeveloperRequest(request: FiledRequest): Promise<void> {
  try {
    const inboxUrl = `${(await appUrl()).replace(/\/+$/, "")}/website/ai`;
    const email = developerRequestEmail(request, inboxUrl);
    await emailOwner(email).catch((error) => console.error(`[developer request] could not email ${request.reportNumber}:`, (error as Error).message));
    if (await slackConfigured().catch(() => false)) {
      await postNotification({
        idempotencyKey: `website-escalation:${request.id}`,
        text: `${email.subject}\n> ${oneLine(request.userPrompt, 300)}\n${inboxUrl}`,
      });
    }
  } catch (error) {
    console.error(`[developer request] could not announce ${request.reportNumber}:`, (error as Error).message);
  }
}

export function registerWebsiteEscalationRoutes(router: Router) {
  /**
   * GET /website/escalations
   * Staff see every request on the sites they can reach; anybody else sees
   * only the requests they made themselves.
   */
  router.get(
    "/escalations",
    handler(async (req, res) => {
      const user = req.dbUser;
      if (!user) throw new WebsiteError(401, "Sign in to view developer requests.");

      const siteId = typeof req.query.siteId === "string" ? req.query.siteId : undefined;
      const status = typeof req.query.status === "string" ? req.query.status.toUpperCase() : undefined;
      if (siteId) await assertWebsiteSiteAccess(req, siteId, "view");

      const staff = isWebsiteStaff(req);
      const scope = {
        ...(siteId ? { siteId } : { site: websiteSiteFilter(req) }),
        ...(staff ? {} : { OR: [{ userId: user.id }, { userId: null, userEmail: user.email }] }),
      };

      const items = await prisma.websiteEscalation.findMany({
        where: { ...scope, ...(status && status !== "ALL" ? { status } : {}) },
        include: {
          site: { select: { id: true, name: true, publicUrl: true } },
        },
        orderBy: [{ createdAt: "desc" }],
        take: 100,
      });
      const openCount = await prisma.websiteEscalation.count({ where: { ...scope, status: "OPEN" } });

      res.json({ openCount, total: items.length, canUpdate: staff, items });
    }),
  );

  /**
   * POST /website/sites/:siteId/escalations
   * The person asks for developer help from the website workspace.
   */
  router.post(
    "/sites/:siteId/escalations",
    handler(async (req, res) => {
      const site = await assertWebsiteSiteAccess(req, req.params.siteId, "edit");
      const input = z
        .object({
          pageId: z.string().optional().nullable(),
          pageTitle: z.string().max(300).optional().nullable(),
          userPrompt: z.string().min(1).max(3000),
          category: z
            .enum([
              "custom_backend",
              "third_party_integration",
              "crm_or_leads",
              "billing_or_account",
              "complex_engineering",
              "other",
            ])
            .default("other"),
          agentNotes: z.string().max(2000).default("Requested from the website workspace."),
        })
        .parse(req.body);

      const created = await createWebsiteEscalation({
        siteId: site.siteId,
        pageId: input.pageId,
        pageTitle: input.pageTitle,
        userPrompt: input.userPrompt,
        reason: "OWNER_REQUESTED",
        category: input.category,
        agentNotes: input.agentNotes,
        userId: req.dbUser?.id ?? null,
        userEmail: req.dbUser?.email ?? null,
        userName: req.dbUser?.name ?? null,
      });

      res.status(201).json(created);
    }),
  );

  /**
   * PATCH /website/escalations/:id
   * Staff move a request along (IN_REVIEW, RESOLVED) and leave notes. A site
   * manager is the customer here, not the person who answers them.
   */
  router.patch(
    "/escalations/:id",
    handler(async (req, res) => {
      const user = req.dbUser;
      if (!user) throw new WebsiteError(401, "Sign in to update developer requests.");
      if (!isWebsiteStaff(req)) throw new WebsiteError(403, "Only DakyXTech staff can update a developer request.");

      const { status, ownerNotes } = z
        .object({
          status: z.enum(["OPEN", "IN_REVIEW", "RESOLVED"]),
          ownerNotes: z.string().trim().max(2000).optional(),
        })
        .parse(req.body);

      const existing = await prisma.websiteEscalation.findUnique({
        where: { id: req.params.id },
      });
      if (!existing) throw new WebsiteError(404, "That developer request does not exist.");
      await assertWebsiteSiteAccess(req, existing.siteId, "view");

      const updated = await prisma.websiteEscalation.update({
        where: { id: existing.id },
        data: {
          status,
          ownerNotes: ownerNotes ?? existing.ownerNotes,
          resolvedAt: status === "RESOLVED" ? new Date() : null,
          resolvedBy: status === "RESOLVED" ? user.name || user.email : null,
        },
      });

      res.json(updated);
    }),
  );
}
