import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { auditCompany, type CompanyAudit } from "../companyAudit.js";
import { appUrl } from "../emailSender.js";
import { storeFile } from "../fileStore.js";
import { pngSize } from "../png.js";
import { annotateScreenshot } from "./annotate.js";
import { gatherEvidence, type AuditEvidence, type GatherOptions } from "./evidence.js";
import { auditMarkdown } from "./markdown.js";
import { renderAuditPdf } from "./pdf.js";
import { reviewContent } from "./content.js";
import { reviewSpeedAndSeo } from "./performance.js";
import { reviewSecurity } from "./security.js";
import { reviewUx } from "./ux.js";
import { synthesise } from "./synthesis.js";
import { DISCIPLINES, overallScore, verdictFor, type AuditScreenshot, type DisciplineReport, type WebsiteAuditReport } from "./types.js";

/**
 * The website audit team.
 *
 * One site, four reviewers, one document. The sequence is the design:
 *
 *   1. **Gather once.** `evidence.ts` fetches the page, measures it, and takes
 *      the two pictures. Four reviewers fetching separately would produce four
 *      sets of timings that disagree and four chances to describe a different
 *      version of the site than the others — in a document that goes to a
 *      stranger about their own business.
 *   2. **Four reviews, in parallel.** They do not talk to each other and they
 *      must not: a reviewer that has read another's conclusions agrees with it,
 *      and four agreeing reviewers are one reviewer with a bigger bill.
 *   3. **Draw the boxes.** The UI/UX findings that came back with a region get
 *      numbered and drawn onto the screenshot.
 *   4. **Compile.** Claude weighs the four against each other and answers the
 *      two questions a business owner has — what is this costing me, what do I
 *      do first — plus the one Dakyworld has, which is what to say in a letter.
 *   5. **Render both.** A branded PDF for a person to read, and Markdown for
 *      the cold lead writer to argue from.
 *
 * **Nothing here throws for a missing key or a site that will not answer.**
 * Each stage degrades to a note. No Apify token means no pictures and a UI/UX
 * section that says nobody has seen the page; no model key means the mechanical
 * sections stand on their own and the summary says it was assembled rather than
 * written. What comes out is always a document, and it always says what it
 * could not do — which is the only thing that makes the parts it did do
 * believable.
 */

export interface AuditSubject {
  leadId: string | null;
  businessName: string;
  website: string;
  trade: string | null;
  town: string | null;
}

export interface StoredAudit {
  auditId: string;
  report: WebsiteAuditReport;
  markdown: string;
  pdfFileId: string | null;
  markdownFileId: string | null;
  /** `{ view, annotated, fileId }` for every picture kept. */
  screenshotFiles: { view: "desktop" | "mobile"; annotated: boolean; fileId: string }[];
}

export interface RunOptions extends GatherOptions {
  /** Reuse a scan's audit rather than re-asking DNS. */
  companyAudit?: CompanyAudit | null;
  /** Skip storing the PDF and Markdown — for a preview that is thrown away. */
  skipFiles?: boolean;
}

/**
 * Runs the four reviews and returns the report. Stores nothing.
 *
 * Split out from `runWebsiteAudit` so the tool layer can offer an agent a
 * review without a row and a pair of files landing in the database for work
 * that was a dry run.
 */
export async function reviewWebsite(subject: AuditSubject, options: RunOptions = {}): Promise<{ report: WebsiteAuditReport; evidence: AuditEvidence }> {
  const notes: string[] = [];
  const business = { name: subject.businessName, trade: subject.trade, town: subject.town };

  const evidence = await gatherEvidence(subject.website, options);
  notes.push(...evidence.notes);

  // The DNS half. Reused from the scan when there is one — it asked the same
  // questions of the same domain minutes ago, and asking again costs a round
  // trip to learn nothing.
  let companyAudit = options.companyAudit ?? null;
  if (!companyAudit) {
    try {
      companyAudit = await auditCompany({
        companyName: subject.businessName,
        website: subject.website,
        contactEmail: null,
        rating: null,
        reviewsCount: null,
        socialLinks: null,
        category: subject.trade,
        city: subject.town,
      });
    } catch (err) {
      notes.push(`Their mail domain could not be checked: ${(err as Error).message}`);
    }
  }

  // What the DNS half could not check, carried through. Without this the
  // report says "SPF and DMARC were not checked" and never says why, which
  // reads as an omission rather than as a resolver that would not answer.
  if (companyAudit?.notes.length) notes.push(...companyAudit.notes);

  // The three that call a model go together. `allSettled` rather than `all`:
  // one reviewer failing must not take the other three's work with it, which
  // is exactly what `Promise.all` would do after the money had been spent.
  const [ux, speed, content] = await Promise.allSettled([
    reviewUx(evidence, business),
    reviewSpeedAndSeo(evidence, business),
    reviewContent(evidence, companyAudit, business),
  ]);

  const security = reviewSecurity(evidence, companyAudit);

  const byDiscipline = new Map<string, DisciplineReport>();
  for (const [discipline, settled] of [
    ["UX", ux],
    ["SPEED_SEO", speed],
    ["CONTENT", content],
  ] as const) {
    if (settled.status === "fulfilled") {
      byDiscipline.set(discipline, settled.value);
    } else {
      notes.push(`The ${discipline === "SPEED_SEO" ? "speed and findability" : discipline.toLowerCase()} review did not finish: ${settled.reason?.message ?? settled.reason}`);
    }
  }
  byDiscipline.set("SECURITY", security);

  // Kept in the declared order rather than in whichever order they finished.
  const disciplines = DISCIPLINES.map((discipline) => byDiscipline.get(discipline)).filter((report): report is DisciplineReport => Boolean(report));
  for (const discipline of disciplines) notes.push(...discipline.notes.filter((note) => !notes.includes(note)));

  // --- The boxes -----------------------------------------------------------
  const uxFindings = byDiscipline.get("UX")?.findings ?? [];
  const screenshots: AuditScreenshot[] = evidence.shots.map((entry) => {
    const shot = entry.result.shot!;
    const marked = annotateScreenshot(entry.result.base64!, entry.view, uxFindings);
    if (marked.note) notes.push(marked.note);
    return {
      view: entry.view,
      base64: entry.result.base64!,
      width: shot.width,
      height: shot.height,
      annotatedBase64: marked.base64,
      imageUrl: shot.imageUrl,
      takenAt: shot.takenAt,
      cropped: shot.cropped,
    };
  });

  const { score, scored } = overallScore(disciplines);
  if (!scored) {
    notes.push(
      disciplines.some((discipline) => discipline.scored)
        ? "Too little of the site could be examined to put one score on it, so the front page carries no number. The sections that did run are scored individually below."
        : "Nothing could be examined, so there is no score at all. What follows is only what could be established without opening the site.",
    );
  }
  const draft: WebsiteAuditReport = {
    leadId: subject.leadId,
    businessName: subject.businessName,
    website: evidence.finalUrl ?? subject.website,
    ranAt: new Date().toISOString(),
    overallScore: score,
    scored,
    verdict: scored ? verdictFor(score) : "Not scored",
    disciplines,
    synthesis: null,
    screenshots,
    notes: [...new Set(notes)],
    costUsd: evidence.costUsd + disciplines.reduce((total, discipline) => total + discipline.costUsd, 0),
  };

  // --- The compile ---------------------------------------------------------
  const compiled = await synthesise(draft, evidence, { trade: subject.trade, town: subject.town });
  draft.synthesis = compiled.synthesis;
  draft.costUsd += compiled.costUsd;
  draft.notes = [...new Set([...draft.notes, ...compiled.notes])];

  return { report: draft, evidence };
}

/**
 * The whole thing: review, render, store.
 *
 * The pictures, the PDF and the Markdown go into `StoredFile` rather than into
 * the audit row. A report with four screenshots in it as base64 is a megabyte
 * of JSON that every list query would have to read past, and the same picture
 * is wanted by three different renderers — the PDF, the drawer and the
 * Markdown — none of which should be decoding a column to get it.
 */
export async function runWebsiteAudit(subject: AuditSubject, options: RunOptions = {}): Promise<StoredAudit> {
  const { report } = await reviewWebsite(subject, options);

  const screenshotFiles: StoredAudit["screenshotFiles"] = [];
  const images: Parameters<typeof renderAuditPdf>[0]["images"] = [];

  for (const shot of report.screenshots) {
    // The annotated copy is the one that goes in the document; the plain one is
    // kept as well, because a reader who disagrees with a box has to be able to
    // see the page without it.
    const best = shot.annotatedBase64 ?? shot.base64;
    const data = Buffer.from(best, "base64");
    const size = pngSize(data) ?? { width: shot.width, height: shot.height };
    images.push({ view: shot.view, data, width: size.width, height: size.height, annotated: Boolean(shot.annotatedBase64), cropped: shot.cropped });

    if (options.skipFiles) continue;

    for (const [annotated, base64] of [
      [false, shot.base64],
      [true, shot.annotatedBase64],
    ] as const) {
      if (!base64) continue;
      try {
        const file = await storeFile({
          filename: `${slug(report.businessName)}-${shot.view}${annotated ? "-marked" : ""}.png`,
          contentType: "image/png",
          dataBase64: base64,
          purpose: "WEBSITE_AUDIT",
        });
        screenshotFiles.push({ view: shot.view, annotated, fileId: file.id });
      } catch (err) {
        report.notes.push(`A screenshot could not be filed: ${(err as Error).message}`);
      }
    }
  }

  let pdfFileId: string | null = null;
  if (!options.skipFiles) {
    try {
      const pdf = await renderAuditPdf({ report, images });
      const file = await storeFile({
        filename: `${slug(report.businessName)}-website-review.pdf`,
        contentType: "application/pdf",
        dataBase64: pdf.toString("base64"),
        purpose: "WEBSITE_AUDIT",
      });
      pdfFileId = file.id;
    } catch (err) {
      // The report is the finding list, not the typesetting. A layout failure
      // must not lose a review that has already been paid for.
      report.notes.push(`The PDF could not be rendered: ${(err as Error).message} Everything in it is still in the Markdown and on screen.`);
    }
  }

  // The row is written before the Markdown is finished because the Markdown
  // links its own pictures, and those links contain the id this row is about
  // to be given. The first pass is a complete document that describes the
  // pictures instead of linking them, so the intermediate state is valid
  // rather than empty — and then it is replaced with the linked version.
  const stored = await prisma.websiteAudit.create({
    data: {
      leadId: subject.leadId,
      businessName: report.businessName,
      website: report.website,
      ranAt: new Date(report.ranAt),
      overallScore: report.overallScore,
      verdict: report.verdict,
      report: withoutImages(report) as unknown as Prisma.InputJsonValue,
      markdown: auditMarkdown(report),
      pdfFileId,
      screenshots: screenshotFiles as unknown as Prisma.InputJsonValue,
      costUsd: new Prisma.Decimal(report.costUsd.toFixed(4)),
    },
    select: { id: true },
  });

  const base = screenshotFiles.length ? `${(await appUrl()).replace(/\/$/, "")}/api/audits/${stored.id}/screenshot` : null;
  const markdown = auditMarkdown(report, { screenshotBaseUrl: base });

  let markdownFileId: string | null = null;
  if (!options.skipFiles) {
    try {
      const file = await storeFile({
        filename: `${slug(report.businessName)}-website-review.md`,
        contentType: "text/markdown",
        dataBase64: Buffer.from(markdown, "utf8").toString("base64"),
        purpose: "WEBSITE_AUDIT",
      });
      markdownFileId = file.id;
    } catch (err) {
      report.notes.push(`The Markdown could not be filed: ${(err as Error).message}`);
    }
  }

  await prisma.websiteAudit.update({ where: { id: stored.id }, data: { markdown, markdownFileId } });

  return { auditId: stored.id, report, markdown, pdfFileId, markdownFileId, screenshotFiles };
}

/**
 * The report with the picture bytes taken out, for the database column.
 *
 * Two megabytes of base64 in a JSON column is a row every list query reads
 * past and every backup carries. The pictures are files; the column keeps
 * their dimensions and their provenance so the report still describes what was
 * taken even if a file is later deleted.
 */
function withoutImages(report: WebsiteAuditReport): WebsiteAuditReport {
  return {
    ...report,
    screenshots: report.screenshots.map((shot) => ({ ...shot, base64: "", annotatedBase64: shot.annotatedBase64 ? "" : null })),
  };
}

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "business"
  );
}

/** The most recent review of a lead, with the report rehydrated. */
export async function latestAuditForLead(leadId: string) {
  return prisma.websiteAudit.findFirst({ where: { leadId }, orderBy: { ranAt: "desc" } });
}
