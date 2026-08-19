import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireRole } from "../middleware/auth.js";
import { readFile } from "../services/fileStore.js";
import { normaliseSiteUrl } from "../services/siteShot.js";
import { runWebsiteAudit } from "../services/audit/team.js";
import { auditMarkdown } from "../services/audit/markdown.js";
import type { WebsiteAuditReport } from "../services/audit/types.js";

/**
 * Website reviews: running them, reading them, and handing over the two files.
 *
 * The route is deliberately separate from `/leads` even though most reviews are
 * of a lead's site. A review is a document with its own life — it is kept when
 * the lead is re-scanned, a second one three months later is the evidence that
 * the work changed something, and an address can be reviewed with no lead
 * behind it at all, which is what a person does when somebody asks "what do you
 * think of my site".
 *
 * **Running one spends money**, so it is `requireRole("OWNER")` like the other
 * two routes that do — a capture and an import. Reading one does not, so it is
 * not.
 */

export const auditsRouter = Router();

const listQuery = z.object({
  leadId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

/** Never the report or the Markdown: a list of twenty-five would be megabytes. */
const SUMMARY = {
  id: true,
  leadId: true,
  businessName: true,
  website: true,
  ranAt: true,
  overallScore: true,
  verdict: true,
  pdfFileId: true,
  markdownFileId: true,
  screenshots: true,
  costUsd: true,
  createdAt: true,
} as const;

auditsRouter.get("/", async (req, res, next) => {
  try {
    const query = listQuery.parse(req.query);
    const audits = await prisma.websiteAudit.findMany({
      where: query.leadId ? { leadId: query.leadId } : {},
      orderBy: { ranAt: "desc" },
      take: query.limit,
      select: { ...SUMMARY, lead: { select: { id: true, contactName: true, companyName: true } } },
    });
    res.json({ audits });
  } catch (err) {
    next(err);
  }
});

auditsRouter.get("/:id", async (req, res, next) => {
  try {
    const audit = await prisma.websiteAudit.findUnique({
      where: { id: req.params.id },
      include: { lead: { select: { id: true, contactName: true, companyName: true, website: true } } },
    });
    if (!audit) return res.status(404).json({ error: "No such review" });
    res.json(audit);
  } catch (err) {
    next(err);
  }
});

const runInput = z
  .object({
    leadId: z.string().min(1).optional(),
    /** For a site with no lead behind it. */
    website: z.string().min(1).max(300).optional(),
    businessName: z.string().min(1).max(200).optional(),
    trade: z.string().max(120).optional(),
    town: z.string().max(120).optional(),
    /** Skip the pictures, and with them the whole UI/UX section. */
    skipScreenshots: z.boolean().default(false),
  })
  .refine((input) => input.leadId || input.website, { message: "Give a leadId or a website." });

/**
 * Runs the four reviews and files the report.
 *
 * Slow — two screenshots, three model calls and a compile — and it says so
 * rather than pretending otherwise. It is a separate call from preparing a
 * lead so that whoever is watching can see which part is taking the time.
 */
auditsRouter.post("/run", requireRole("OWNER"), async (req, res, next) => {
  try {
    const input = runInput.parse(req.body ?? {});

    let subject: Parameters<typeof runWebsiteAudit>[0];
    if (input.leadId) {
      const lead = await prisma.lead.findUnique({ where: { id: input.leadId }, include: { research: true } });
      if (!lead) return res.status(404).json({ error: "Lead not found" });

      const website = normaliseSiteUrl(input.website ?? lead.website ?? "");
      if (!website) {
        // Refused rather than run empty. For a business with no site at all
        // the absence *is* the argument, and a review of nothing would be four
        // sections saying "there was nothing to check" over a rendered PDF.
        return res.status(409).json({
          error:
            "There is no website on this lead to review. For a business with no site at all, that absence is the whole argument — build them a demo page instead.",
        });
      }

      const look = (lead.research?.look ?? null) as { states?: { trade?: string | null; town?: string | null } } | null;
      subject = {
        leadId: lead.id,
        businessName: lead.companyName ?? lead.contactName,
        website,
        trade: look?.states?.trade ?? lead.category,
        town: look?.states?.town ?? lead.city,
      };
    } else {
      const website = normaliseSiteUrl(input.website!);
      if (!website) return res.status(400).json({ error: `"${input.website}" is not a web address this can open.` });
      subject = {
        leadId: null,
        businessName: input.businessName?.trim() || new URL(website).hostname.replace(/^www\./, ""),
        website,
        trade: input.trade?.trim() || null,
        town: input.town?.trim() || null,
      };
    }

    const run = await runWebsiteAudit(subject, { skipScreenshots: input.skipScreenshots });
    res.status(201).json({
      auditId: run.auditId,
      report: run.report,
      pdfFileId: run.pdfFileId,
      markdownFileId: run.markdownFileId,
      screenshotFiles: run.screenshotFiles,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Deletes a review and the files that belong to it.
 *
 * The files have to go explicitly. Their foreign key is ON DELETE SET NULL —
 * losing a PDF should never take a report's findings with it — which means
 * deleting the report the other way round leaves the PDF, the Markdown and up
 * to four screenshots behind with nothing pointing at them. `orphanedFiles`
 * will not find them either: it deliberately only sweeps email attachments,
 * because a file owned by a record is not an orphan while the record exists.
 * So this is the only thing that ever cleans them up.
 */
auditsRouter.delete("/:id", requireRole("OWNER"), async (req, res, next) => {
  try {
    const audit = await prisma.websiteAudit.findUnique({
      where: { id: req.params.id },
      select: { pdfFileId: true, markdownFileId: true, screenshots: true },
    });
    if (!audit) return res.status(404).json({ error: "No such review" });

    const shots = (audit.screenshots ?? []) as { fileId?: unknown }[];
    const fileIds = [
      audit.pdfFileId,
      audit.markdownFileId,
      ...shots.map((shot) => (typeof shot?.fileId === "string" ? shot.fileId : null)),
    ].filter((id): id is string => Boolean(id));

    // The row first. If the file sweep fails half way, a dangling file is a
    // wasted row; a dangling *report* pointing at deleted files is a broken
    // download somebody clicks.
    await prisma.websiteAudit.delete({ where: { id: req.params.id } });
    if (fileIds.length) await prisma.storedFile.deleteMany({ where: { id: { in: fileIds } } });

    res.json({ deleted: true, filesDeleted: fileIds.length });
  } catch (err) {
    next(err);
  }
});

// --- The two files, and the pictures ----------------------------------------

/**
 * The PDF, inline rather than as a download.
 *
 * `inline` so the browser's own viewer opens it in a tab — the Owner wants to
 * read this, not collect it, and a document that lands in a downloads folder
 * is one nobody looks at.
 */
auditsRouter.get("/:id/pdf", async (req, res, next) => {
  try {
    const audit = await prisma.websiteAudit.findUnique({ where: { id: req.params.id }, select: { pdfFileId: true, businessName: true } });
    if (!audit) return res.status(404).json({ error: "No such review" });
    if (!audit.pdfFileId) return res.status(404).json({ error: "This review has no PDF — it could not be rendered. The findings are all in the Markdown." });

    const file = await readFile(audit.pdfFileId);
    if (!file) return res.status(404).json({ error: "The PDF for this review is no longer stored." });

    res
      .status(200)
      .type("application/pdf")
      .set({ "Content-Disposition": `inline; filename="${file.filename}"`, "Cache-Control": "private, max-age=300" })
      .send(file.data);
  } catch (err) {
    next(err);
  }
});

/**
 * The Markdown.
 *
 * Served from the row rather than from the file, because the row is the copy
 * that is guaranteed to be there: the file is a convenience and the column is
 * the record. `?internal=false` leaves out the email brief, for a copy that
 * might be shown to the business itself.
 */
auditsRouter.get("/:id/markdown", async (req, res, next) => {
  try {
    const audit = await prisma.websiteAudit.findUnique({ where: { id: req.params.id } });
    if (!audit) return res.status(404).json({ error: "No such review" });

    const omitInternal = req.query.internal === "false";
    const markdown = omitInternal
      ? auditMarkdown(audit.report as unknown as WebsiteAuditReport, { omitInternalBrief: true })
      : audit.markdown;

    res
      .status(200)
      .type("text/markdown; charset=utf-8")
      .set({ "Content-Disposition": `inline; filename="${audit.businessName.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-website-review.md"` })
      .send(markdown);
  } catch (err) {
    next(err);
  }
});

/**
 * One of the pictures, by view.
 *
 * `desktop.png`, `desktop-marked.png`, `mobile.png`, `mobile-marked.png` — the
 * same names the Markdown links to, so a Markdown file opened against this API
 * shows its own images.
 */
auditsRouter.get("/:id/screenshot/:name", async (req, res, next) => {
  try {
    const match = /^(desktop|mobile)(-marked)?\.png$/.exec(req.params.name);
    if (!match) return res.status(404).json({ error: "No such picture." });

    const audit = await prisma.websiteAudit.findUnique({ where: { id: req.params.id }, select: { screenshots: true } });
    if (!audit) return res.status(404).json({ error: "No such review" });

    const shots = (audit.screenshots ?? []) as { view: string; annotated: boolean; fileId: string }[];
    const wanted = shots.find((shot) => shot.view === match[1] && shot.annotated === Boolean(match[2]));
    // A marked-up picture only exists when something was drawn on it. Falling
    // back to the plain one is right: the caller asked for that view of the
    // page, and the boxes are a bonus rather than the subject.
    const chosen = wanted ?? shots.find((shot) => shot.view === match[1]);
    if (!chosen) return res.status(404).json({ error: "No such picture." });

    const file = await readFile(chosen.fileId);
    if (!file) return res.status(404).json({ error: "That picture is no longer stored." });

    res
      .status(200)
      .type("image/png")
      .set({ "Content-Disposition": `inline; filename="${file.filename}"`, "Cache-Control": "private, max-age=3600" })
      .send(file.data);
  } catch (err) {
    next(err);
  }
});
