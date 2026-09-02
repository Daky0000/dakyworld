import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { auditCompany, type CompanyAudit } from "../companyAudit.js";
import { appUrl } from "../emailSender.js";
import { readFile, storeFile } from "../fileStore.js";
import { pngSize } from "../png.js";
import { PHONE_VIEWPORT_WIDTH, VIEWPORT_WIDTH, normaliseSiteUrl, type ShotResult } from "../siteShot.js";
import { annotateScreenshot } from "./annotate.js";
import { gatherEvidence, type AuditEvidence, type GatherOptions } from "./evidence.js";
import { auditMarkdown } from "./markdown.js";
import { renderAuditPdf } from "./pdf.js";
import { reviewContent } from "./content.js";
import { reviewSpeedAndSeo } from "./performance.js";
import { reviewSecurity } from "./security.js";
import { reviewUx } from "./ux.js";
import { synthesise } from "./synthesis.js";
import {
  DISCIPLINES,
  DISCIPLINE_NAMES,
  overallScore,
  verdictFor,
  type AuditScreenshot,
  type Discipline,
  type DisciplineReport,
  type ScreenshotView,
  type WebsiteAuditReport,
} from "./types.js";

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
    stepNotes: evidence.stepNotes,
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

// --- Running one section again ----------------------------------------------

/**
 * What each reviewer actually argues from, of the two things that cost money.
 *
 * This table is why running one section again is worth having. The whole team
 * is two Apify screenshots, a rented browser and four model calls; the UI/UX
 * reviewer uses the pictures and nothing else, the SEO reviewer uses the rented
 * browser and nothing else, and content and security use neither. So a section
 * that failed can be re-run for its own share of the bill rather than for all
 * of it — and, more to the point, without re-running the three that worked and
 * getting three slightly different answers to questions nobody asked again.
 *
 * `mailDomain` is free (it is DNS), but it is only asked for when a reviewer
 * reads it, because a lookup nobody uses is still a round trip and still a
 * chance to add a note about a resolver to a document it has no bearing on.
 */
export const SECTION_EVIDENCE: Record<Discipline, { screenshots: boolean; rendered: boolean; mailDomain: boolean }> = {
  UX: { screenshots: true, rendered: false, mailDomain: false },
  SPEED_SEO: { screenshots: false, rendered: true, mailDomain: false },
  CONTENT: { screenshots: false, rendered: false, mailDomain: true },
  SECURITY: { screenshots: false, rendered: false, mailDomain: true },
};

export interface RerunOptions {
  /**
   * Photograph the site again rather than reusing the pictures the first run
   * took. Off by default: the commonest reason to re-run UI/UX is that the
   * pictures were taken and no model could look at them, and paying Apify a
   * second time to produce the same two images is spending money to learn
   * nothing.
   */
  freshScreenshots?: boolean;
}

export interface SectionRerun extends StoredAudit {
  discipline: Discipline;
  /** What the section scored before and after, so the caller can say what changed. */
  before: { score: number | null; scored: boolean };
  after: { score: number | null; scored: boolean };
  /** What this one section cost, on top of what the review had already spent. */
  rerunCostUsd: number;
  /** True when new pictures were taken; false when the earlier run's were reused. */
  rephotographed: boolean;
}

/**
 * Rebuilds a report around one freshly-run section. Pure — no database, no
 * files, no model.
 *
 * Separated from `rerunAuditSection` because the awkward part of a partial
 * re-run is not running the reviewer, it is the bookkeeping around it: which of
 * the old notes are now false, which are still true, and what the score means
 * when three quarters of the document is from a fortnight ago. That is
 * arithmetic and set logic, and it is worth being able to test it without a
 * Postgres, an Apify token and a model key.
 *
 * The note rules, each of which exists because the alternative reads as a lie:
 *
 *  - **The section's own old notes go.** "No screenshot could be taken" beside
 *    a section that has just reviewed two screenshots is the exact defect this
 *    whole feature is for.
 *  - **The free evidence is rebuilt from this run**, because this run fetched
 *    the page again and its notes describe the site as it is now.
 *  - **The notes of a paid step this re-run skipped are carried forward**, from
 *    `stepNotes`. A content re-run does not rent a browser, so "the page could
 *    not be opened in a real browser" is still the reason the speed section
 *    reads the way it does, and dropping it would leave that section's numbers
 *    looking like a complete measurement.
 *  - **The other three sections' notes stay**, because those sections have not
 *    moved.
 *  - **The document says which parts are new.** A reader comparing a UI/UX
 *    section written today against a security section from three weeks ago is
 *    entitled to know that is what they are doing.
 */
export function mergeRerunReport(input: {
  stored: WebsiteAuditReport;
  fresh: DisciplineReport;
  evidence: Pick<AuditEvidence, "notes" | "stepNotes" | "finalUrl">;
  /** Which of the two paid steps this re-run actually performed. */
  ran: { screenshots: boolean; rendered: boolean };
  at: string;
}): WebsiteAuditReport {
  const { stored, evidence, ran } = input;
  const fresh: DisciplineReport = { ...input.fresh, rerunAt: input.at };

  const byDiscipline = new Map(stored.disciplines.map((discipline) => [discipline.discipline, discipline]));
  byDiscipline.set(fresh.discipline, fresh);
  const disciplines = DISCIPLINES.map((discipline) => byDiscipline.get(discipline)).filter((report): report is DisciplineReport => Boolean(report));

  const carried = {
    screenshots: ran.screenshots ? evidence.stepNotes.screenshots : (stored.stepNotes?.screenshots ?? []),
    rendered: ran.rendered ? evidence.stepNotes.rendered : (stored.stepNotes?.rendered ?? []),
  };

  const { score, scored } = overallScore(disciplines);
  const notes = [
    ...evidence.notes,
    ...(ran.screenshots ? [] : carried.screenshots),
    ...(ran.rendered ? [] : carried.rendered),
    ...disciplines.flatMap((discipline) => discipline.notes),
    ...(scored
      ? []
      : [
          disciplines.some((discipline) => discipline.scored)
            ? "Too little of the site could be examined to put one score on it, so the front page carries no number. The sections that did run are scored individually below."
            : "Nothing could be examined, so there is no score at all. What follows is only what could be established without opening the site.",
        ]),
    freshnessNote(disciplines, stored.ranAt),
  ].filter((note): note is string => Boolean(note));

  return {
    ...stored,
    // The address that answered this time. A site that has moved between the
    // two runs should say so rather than keep the old one on the front page.
    website: evidence.finalUrl ?? stored.website,
    overallScore: score,
    scored,
    verdict: scored ? verdictFor(score) : "Not scored",
    disciplines,
    notes: [...new Set(notes)],
    stepNotes: carried,
  };
}

/**
 * The sentence that says which sections of the document are from when.
 *
 * Null when nothing has been re-run, so an ordinary review carries no such
 * line — the whole thing is from one moment and saying so would be noise.
 *
 * A date is printed against a section only when it fell on a different day from
 * the review. Printing it always produced "Content (2 September 2026) … from
 * the review of 2 September 2026", which is a sentence about a difference,
 * naming two identical dates, in a document whose whole job is being checkable.
 */
function freshnessNote(disciplines: DisciplineReport[], originalRanAt: string): string | null {
  const rerun = disciplines.filter((discipline) => discipline.rerunAt);
  if (!rerun.length) return null;

  const day = (value: string | Date) => new Date(value).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  const original = day(originalRanAt);
  const list = (labels: string[]) => (labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`);

  const said = list(
    rerun.map((discipline) => {
      const on = day(discipline.rerunAt!);
      return on === original ? DISCIPLINE_NAMES[discipline.discipline] : `${DISCIPLINE_NAMES[discipline.discipline]} (${on})`;
    }),
  );
  const untouched = disciplines.filter((discipline) => !discipline.rerunAt);

  return untouched.length
    ? `Not every section of this report was run at the same time. ${said} ${rerun.length === 1 ? "was" : "were"} run again on their own; the rest of it — ${list(untouched.map((discipline) => DISCIPLINE_NAMES[discipline.discipline]))} — is from the review of ${original} and has not been re-checked since.`
    : `Every section of this report has been run again since the review of ${original}: ${said}.`;
}

/**
 * Runs one reviewer again over the same site and rebuilds the document around it.
 *
 * **The reason this exists.** A section fails for reasons that have nothing to
 * do with the site: no Apify token when the pictures were due, no vision model
 * connected, a rented browser that would not start. What comes out is a report
 * with a hole in it — and until now the only way to fill the hole was to pay
 * for the whole team again and get three new answers to three questions that
 * were already answered correctly. Worse, the three new answers can differ from
 * the ones the Owner has already read and, in a cold email, already quoted.
 *
 * So: one reviewer, its own evidence, the same row. The report is replaced in
 * place rather than filed as a second review, because two rows for one site an
 * hour apart is not a history of the site — it is the same review twice, and
 * the second one would win every "most recent" query while being three quarters
 * a copy.
 *
 * The compile is always run again. It is the step that weighs the four sections
 * against each other and picks the one thing to do first, and a section that has
 * changed makes the old answer to that question stale — it may even name a
 * finding id that no longer exists.
 */
export async function rerunAuditSection(auditId: string, discipline: Discipline, options: RerunOptions = {}): Promise<SectionRerun> {
  const row = await prisma.websiteAudit.findUnique({ where: { id: auditId } });
  if (!row) throw new Error("No such review.");

  const stored = row.report as unknown as WebsiteAuditReport;
  const website = normaliseSiteUrl(stored.website ?? row.website ?? "");
  if (!website) {
    // Nothing to re-check. A review of a site that never answered is a document
    // about an absence, and re-running a section of it would produce the same
    // absence with a newer date on it.
    throw new Error("There is no address on this review to look at again. Run a new review once the business has a site that answers.");
  }

  const before = stored.disciplines.find((entry) => entry.discipline === discipline) ?? null;
  const subject = await subjectFor(row.leadId, row.businessName, website);
  const business = { name: subject.businessName, trade: subject.trade, town: subject.town };
  const needs = SECTION_EVIDENCE[discipline];

  // The pictures the first run took, bytes and all. Loaded whatever section is
  // being re-run: the PDF is rendered again either way and it cannot be
  // rendered from a report whose base64 was stripped before it was stored.
  const pictures = await storedPictures(row.id, stored, row.screenshots);

  // Photograph again only when this section reads pictures *and* either there
  // are none to reuse or the caller asked for new ones.
  const takeShots = needs.screenshots && (options.freshScreenshots || pictures.length === 0);
  const evidence = await gatherEvidence(website, { skipScreenshots: !takeShots, skipRendered: !needs.rendered });

  let reusedPictures = false;
  if (needs.screenshots && !evidence.shots.length && pictures.length) {
    // Either we deliberately skipped the capture, or we tried and it failed
    // again. Both end here: the reviewer looks at the pictures that exist
    // rather than at nothing, and the document says which day they are from.
    evidence.shots = pictures.map((picture) => ({ view: picture.view, result: asShotResult(picture, website, evidence.finalUrl) }));
    reusedPictures = true;
    const note = `The pictures in this report are the ones taken on ${new Date(pictures[0].takenAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}${takeShots ? ", because a new one could not be captured" : ""} — the design was reviewed again, the photographs were not taken again.`;
    evidence.notes.push(note);
    evidence.stepNotes.screenshots.push(note);
  }

  // Free, but only asked for by the two reviewers that read it.
  let companyAudit: CompanyAudit | null = null;
  if (needs.mailDomain) {
    try {
      companyAudit = await auditCompany({
        companyName: subject.businessName,
        website,
        contactEmail: null,
        rating: null,
        reviewsCount: null,
        socialLinks: null,
        category: subject.trade,
        city: subject.town,
      });
    } catch (err) {
      evidence.notes.push(`Their mail domain could not be checked: ${(err as Error).message}`);
    }
  }
  if (companyAudit?.notes.length) evidence.notes.push(...companyAudit.notes);

  const fresh =
    discipline === "UX"
      ? await reviewUx(evidence, business)
      : discipline === "SPEED_SEO"
        ? await reviewSpeedAndSeo(evidence, business)
        : discipline === "CONTENT"
          ? await reviewContent(evidence, companyAudit, business)
          : reviewSecurity(evidence, companyAudit);

  const report = mergeRerunReport({
    stored,
    fresh,
    evidence,
    ran: { screenshots: takeShots, rendered: needs.rendered },
    at: new Date().toISOString(),
  });

  // --- The boxes, again ----------------------------------------------------
  // Redrawn from whichever pictures are in hand. On a UI/UX re-run the findings
  // have changed and so have the boxes; on any other re-run they have not, and
  // this reproduces the same image for the price of some arithmetic.
  const rephotographed = takeShots && !reusedPictures && evidence.shots.length > 0;
  const source: StoredPicture[] = rephotographed
    ? evidence.shots.map((entry) => ({
        view: entry.view,
        base64: entry.result.base64!,
        width: entry.result.shot!.width,
        height: entry.result.shot!.height,
        imageUrl: entry.result.shot!.imageUrl,
        takenAt: entry.result.shot!.takenAt,
        cropped: entry.result.shot!.cropped,
        fileId: null,
      }))
    : pictures;

  const uxFindings = report.disciplines.find((entry) => entry.discipline === "UX")?.findings ?? [];
  const annotateNotes: string[] = [];
  report.screenshots = source.map((picture) => {
    const marked = annotateScreenshot(picture.base64, picture.view, uxFindings);
    if (marked.note) annotateNotes.push(marked.note);
    return {
      view: picture.view,
      base64: picture.base64,
      width: picture.width,
      height: picture.height,
      annotatedBase64: marked.base64,
      imageUrl: picture.imageUrl,
      takenAt: picture.takenAt,
      cropped: picture.cropped,
    };
  });

  // --- The compile ---------------------------------------------------------
  const compiled = await synthesise(report, evidence, { trade: subject.trade, town: subject.town });
  report.synthesis = compiled.synthesis;
  const rerunCostUsd = evidence.costUsd + fresh.costUsd + compiled.costUsd;
  report.costUsd = (stored.costUsd ?? 0) + rerunCostUsd;
  report.notes = [...new Set([...report.notes, ...annotateNotes, ...compiled.notes])];

  // --- The files -----------------------------------------------------------
  const existing = shotFilesOf(row.screenshots);
  const retired: string[] = [];
  let screenshotFiles: StoredAudit["screenshotFiles"];

  if (rephotographed) {
    // New bytes for every picture, so every old file is now unreferenced.
    screenshotFiles = [];
    retired.push(...existing.map((entry) => entry.fileId));
    for (const shot of report.screenshots) {
      for (const [annotated, base64] of [
        [false, shot.base64],
        [true, shot.annotatedBase64],
      ] as const) {
        if (!base64) continue;
        const filed = await storeAuditFile(report, `${shot.view}${annotated ? "-marked" : ""}.png`, "image/png", base64);
        if (filed) screenshotFiles.push({ view: shot.view, annotated, fileId: filed });
      }
    }
  } else if (discipline === "UX") {
    // The photographs are the same bytes and stay where they are; the boxes on
    // them are not, so only the marked-up copies are rewritten.
    screenshotFiles = existing.filter((entry) => !entry.annotated);
    retired.push(...existing.filter((entry) => entry.annotated).map((entry) => entry.fileId));
    for (const shot of report.screenshots) {
      if (!shot.annotatedBase64) continue;
      const filed = await storeAuditFile(report, `${shot.view}-marked.png`, "image/png", shot.annotatedBase64);
      if (filed) screenshotFiles.push({ view: shot.view, annotated: true, fileId: filed });
    }
  } else {
    // Nothing about the pictures changed. Rewriting them would spend two
    // database round trips to store the bytes that are already there.
    screenshotFiles = existing;
  }

  const images: Parameters<typeof renderAuditPdf>[0]["images"] = report.screenshots.map((shot) => {
    const best = shot.annotatedBase64 ?? shot.base64;
    const data = Buffer.from(best, "base64");
    const size = pngSize(data) ?? { width: shot.width, height: shot.height };
    return { view: shot.view, data, width: size.width, height: size.height, annotated: Boolean(shot.annotatedBase64), cropped: shot.cropped };
  });

  let pdfFileId = row.pdfFileId;
  try {
    const pdf = await renderAuditPdf({ report, images });
    const filed = await storeAuditFile(report, "website-review.pdf", "application/pdf", pdf.toString("base64"));
    if (filed) {
      if (row.pdfFileId) retired.push(row.pdfFileId);
      pdfFileId = filed;
    }
  } catch (err) {
    report.notes.push(`The PDF could not be rendered again: ${(err as Error).message} Everything in it is still in the Markdown and on screen.`);
  }

  const base = screenshotFiles.length ? `${(await appUrl()).replace(/\/$/, "")}/api/audits/${row.id}/screenshot` : null;
  const markdown = auditMarkdown(report, { screenshotBaseUrl: base });

  let markdownFileId = row.markdownFileId;
  const filedMarkdown = await storeAuditFile(report, "website-review.md", "text/markdown", Buffer.from(markdown, "utf8").toString("base64"));
  if (filedMarkdown) {
    if (row.markdownFileId) retired.push(row.markdownFileId);
    markdownFileId = filedMarkdown;
  }

  // The row before the sweep, deliberately. A row still pointing at a file that
  // has just been deleted is a broken download somebody clicks; a file nothing
  // points at is a wasted row nobody ever sees.
  await prisma.websiteAudit.update({
    where: { id: row.id },
    data: {
      website: report.website,
      overallScore: report.overallScore,
      verdict: report.verdict,
      report: withoutImages(report) as unknown as Prisma.InputJsonValue,
      markdown,
      pdfFileId,
      markdownFileId,
      screenshots: screenshotFiles as unknown as Prisma.InputJsonValue,
      costUsd: new Prisma.Decimal(report.costUsd.toFixed(4)),
    },
  });
  if (retired.length) await prisma.storedFile.deleteMany({ where: { id: { in: retired } } });

  return {
    auditId: row.id,
    discipline,
    report,
    markdown,
    pdfFileId,
    markdownFileId,
    screenshotFiles,
    before: { score: before?.scored ? before.score : null, scored: Boolean(before?.scored) },
    after: { score: fresh.scored ? fresh.score : null, scored: fresh.scored },
    rerunCostUsd,
    rephotographed,
  };
}

/** A picture already on file, with its bytes, ready to be reviewed or redrawn. */
interface StoredPicture {
  view: ScreenshotView;
  base64: string;
  width: number;
  height: number;
  imageUrl: string | null;
  takenAt: string;
  cropped: boolean;
  /** The `StoredFile` the bytes came from, or null when they were just captured. */
  fileId: string | null;
}

function shotFilesOf(screenshots: unknown): StoredAudit["screenshotFiles"] {
  const rows = (screenshots ?? []) as { view?: unknown; annotated?: unknown; fileId?: unknown }[];
  return rows
    .filter((row) => (row?.view === "desktop" || row?.view === "mobile") && typeof row?.fileId === "string")
    .map((row) => ({ view: row.view as ScreenshotView, annotated: Boolean(row.annotated), fileId: row.fileId as string }));
}

/**
 * The plain pictures of a stored review, with their bytes read back.
 *
 * The metadata is on the report and the bytes are in the file store, and both
 * halves are needed: the report alone cannot be re-rendered because its base64
 * is stripped before it is written, and the files alone do not say which
 * viewport they were taken at or whether the page was cut.
 */
async function storedPictures(auditId: string, report: WebsiteAuditReport, screenshots: unknown): Promise<StoredPicture[]> {
  const plain = shotFilesOf(screenshots).filter((entry) => !entry.annotated);
  const out: StoredPicture[] = [];

  for (const shot of report.screenshots ?? []) {
    const entry = plain.find((candidate) => candidate.view === shot.view);
    if (!entry) continue;
    const stored = await readFile(entry.fileId);
    if (!stored) continue;
    out.push({
      view: shot.view,
      base64: stored.data.toString("base64"),
      width: shot.width,
      height: shot.height,
      imageUrl: shot.imageUrl,
      takenAt: shot.takenAt,
      cropped: shot.cropped,
      fileId: entry.fileId,
    });
  }

  // Desktop first, then phone — the order the reviewers are told the pictures
  // are in, and the order the document prints them.
  return out.sort((a, b) => (a.view === b.view ? 0 : a.view === "desktop" ? -1 : 1));
}

/** A stored picture dressed as a fresh capture, so a reviewer cannot tell the difference. */
function asShotResult(picture: StoredPicture, requested: string, finalUrl: string | null): ShotResult {
  return {
    base64: picture.base64,
    note: null,
    shot: {
      requested,
      finalUrl,
      takenAt: picture.takenAt,
      viewportWidth: picture.view === "mobile" ? PHONE_VIEWPORT_WIDTH : VIEWPORT_WIDTH,
      width: picture.width,
      height: picture.height,
      cropped: picture.cropped,
      imageUrl: picture.imageUrl ?? "",
      mediaType: "image/png",
      bytes: Buffer.byteLength(picture.base64, "base64"),
      // Reused, so it costs nothing. Adding the original run's price again here
      // would make a re-run look like it had paid Apify twice for one picture.
      costUsd: 0,
    },
  };
}

/** Who the review is of, for a re-run. The lead is the source when there is one. */
async function subjectFor(leadId: string | null, businessName: string, website: string): Promise<AuditSubject> {
  if (!leadId) return { leadId: null, businessName, website, trade: null, town: null };

  const lead = await prisma.lead.findUnique({ where: { id: leadId }, include: { research: true } });
  if (!lead) return { leadId: null, businessName, website, trade: null, town: null };

  const look = (lead.research?.look ?? null) as { states?: { trade?: string | null; town?: string | null } } | null;
  return {
    leadId: lead.id,
    businessName: lead.companyName ?? lead.contactName ?? businessName,
    website,
    trade: look?.states?.trade ?? lead.category,
    town: look?.states?.town ?? lead.city,
  };
}

/** Files one thing, and turns a storage failure into a note rather than a lost re-run. */
async function storeAuditFile(report: WebsiteAuditReport, suffix: string, contentType: string, dataBase64: string): Promise<string | null> {
  try {
    const stored = await storeFile({ filename: `${slug(report.businessName)}-${suffix}`, contentType, dataBase64, purpose: "WEBSITE_AUDIT" });
    return stored.id;
  } catch (err) {
    report.notes.push(`${suffix} could not be filed: ${(err as Error).message}`);
    return null;
  }
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
