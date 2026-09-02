import PDFDocument from "pdfkit";
import {
  ACCENT,
  CONTENT_BOTTOM,
  CONTENT_TOP,
  CONTENT_W,
  CREAM,
  INK,
  LINE,
  MARGIN_X,
  MARK,
  MUTED,
  PAGE_H,
  PAGE_W,
  letterheadIdentity,
  pdfText,
  stampLetterhead,
  type LetterheadIdentity,
} from "../letterhead.js";
import { AREA_NAMES, callLabel, type RedesignVerdict } from "./redesign.js";
import { DISCIPLINE_AGENTS, DISCIPLINE_NAMES, reportScored, type AuditFindingDetail, type AuditSeverity, type DisciplineReport, type WebsiteAuditReport } from "./types.js";

/**
 * The review as a document.
 *
 * This is the artefact the whole team exists to produce: one thing a person
 * can open, read in order, and either act on or hand to whoever built the
 * site. It goes out on the house letterhead like every other document the app
 * makes — see services/letterhead.ts — so it is unmistakably from Dakyworld
 * rather than a generic scan report with a name typed at the top.
 *
 * The two decisions worth knowing:
 *
 *  - **The pictures carry the argument.** A section of prose about a homepage
 *    is an opinion; the same prose beside the homepage with numbered boxes on
 *    it is a conversation. So the screenshots are full-width and early, and
 *    every UI/UX finding that has a box says which number it is.
 *  - **Nothing here is red.** The brand has no red, so severity is carried by
 *    weight and by chip rather than by colour temperature: a critical finding
 *    is a solid ink chip, a good one is lime. This is the same rule the
 *    invoice's status stamp follows, and it is why an ink chip beside cream
 *    reads as loudly as red would.
 */

type PDFDoc = InstanceType<typeof PDFDocument>;

const RIGHT_EDGE = PAGE_W - MARGIN_X;
const CONTENT_LIMIT = PAGE_H - CONTENT_BOTTOM;

function newDoc(identity: LetterheadIdentity): PDFDoc {
  const doc = new PDFDocument({
    size: "A4",
    margins: { top: CONTENT_TOP, bottom: CONTENT_BOTTOM, left: MARGIN_X, right: MARGIN_X },
  });
  doc.on("pageAdded", () => stampLetterhead(doc, identity));
  stampLetterhead(doc, identity);
  return doc;
}

function collectBuffer(doc: PDFDoc): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.end();
  });
}

function header(doc: PDFDoc, kicker: string, title: string) {
  doc.fillColor(ACCENT).font("Helvetica-Bold").fontSize(8).text(pdfText(kicker.toUpperCase()), MARGIN_X, doc.y, { width: CONTENT_W, characterSpacing: 1.6 });
  doc.moveDown(0.45);
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(19).text(pdfText(title), MARGIN_X, doc.y, { width: CONTENT_W, lineGap: 2 });
  doc.moveDown(0.5);
  doc.strokeColor(ACCENT).lineWidth(1.6).moveTo(MARGIN_X, doc.y).lineTo(MARGIN_X + 46, doc.y).stroke();
  doc.moveDown(1.1);
}

/**
 * `needs` is the room the block under the heading wants, not the heading's own
 * height. Checking the heading alone strands it at the foot of a page with its
 * content overleaf, which is the one break that makes a document look
 * machine-made.
 */
function sectionTitle(doc: PDFDoc, text: string, needs = 96) {
  if (doc.y + needs > CONTENT_LIMIT) doc.addPage();
  doc.moveDown(1.2);
  // Pinned to the left margin rather than left to the cursor. PDFKit remembers
  // the x of the last `text` call, so a heading that follows a two-column row
  // or a labelled value starts wherever that block ended — which reads as a
  // centred heading and is the sort of fault only a render shows.
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(10.5).text(pdfText(text.toUpperCase()), MARGIN_X, doc.y, { width: CONTENT_W, characterSpacing: 1.4 });
  doc.moveDown(0.5);
}

function paragraph(doc: PDFDoc, text: string, size = 9.6) {
  doc.fillColor(MUTED).font("Helvetica").fontSize(size).text(pdfText(text), MARGIN_X, doc.y, { width: CONTENT_W, align: "left", lineGap: 2.2 });
}

function room(doc: PDFDoc, needs: number) {
  if (doc.y + needs > CONTENT_LIMIT) doc.addPage();
}

// --- The score --------------------------------------------------------------

/**
 * Which colour a score is drawn in.
 *
 * Lime is positive status and nothing else, so it appears only above 70. Blue
 * is structure and emphasis, which is what a middling score is. Below 40 the
 * bar is solid ink: the loudest thing the palette has, and the same choice the
 * invoice makes for an overdue balance.
 */
function scoreColour(score: number): string {
  if (score >= 70) return MARK;
  if (score >= 40) return ACCENT;
  return INK;
}

/**
 * A section that could not run gets an empty track and a dash, never a number.
 *
 * The first version of this drew a full lime bar over "Content 100/100 —
 * nobody read the writing on the page", because no findings scores a hundred.
 * A reader takes the bar, not the sentence.
 */
function scoreBar(doc: PDFDoc, x: number, y: number, width: number, score: number, scored = true) {
  const height = 7;
  doc.roundedRect(x, y, width, height, height / 2).fill(LINE);
  if (!scored) return;
  const filled = Math.max(height, (width * Math.max(0, Math.min(100, score))) / 100);
  doc.roundedRect(x, y, filled, height, height / 2).fill(scoreColour(score));
}

/**
 * The headline number, in an ink band across the content width.
 *
 * One number, large, with the verdict beside it, because the first question
 * anybody opening this asks is "how bad is it" and making them read three
 * paragraphs to find out is the fastest way to have the document closed.
 */
function scoreBand(doc: PDFDoc, report: WebsiteAuditReport) {
  const height = 84;
  const y = doc.y;
  doc.rect(MARGIN_X, y, CONTENT_W, height).fill(INK);
  doc.rect(MARGIN_X, y, 3.5, height).fill(MARK);

  const scored = reportScored(report);
  const headline = scored ? String(report.overallScore) : "—";
  doc
    .fillColor(CREAM)
    .font("Helvetica-Bold")
    .fontSize(40)
    .text(headline, MARGIN_X + 22, y + 20, { lineBreak: false });
  const numberWidth = doc.widthOfString(headline);
  // No denominator over a dash: "— /100" reads as a score that came out empty
  // rather than as a review that could not reach one.
  if (scored) {
    doc
      .fillColor(MUTED)
      .font("Helvetica")
      .fontSize(12)
      .text("/100", MARGIN_X + 24 + numberWidth, y + 42, { lineBreak: false });
  }

  const textLeft = MARGIN_X + 22 + numberWidth + 46;
  doc
    .fillColor(MARK)
    .font("Helvetica-Bold")
    .fontSize(8)
    .text("OVERALL", textLeft, y + 22, { characterSpacing: 1.6, lineBreak: false });
  doc
    .fillColor(CREAM)
    .font("Helvetica-Bold")
    .fontSize(15)
    .text(report.verdict, textLeft, y + 36, { width: RIGHT_EDGE - textLeft - 16, lineGap: 0 });
  doc
    .fillColor(MUTED)
    .font("Helvetica")
    .fontSize(7.6)
    .text(
      scored
        ? "Points are deducted per fault by severity, weighted across the sections that ran. It is arithmetic, not an opinion."
        : "Too little of the site could be examined to score it — see what this review did not check, at the end.",
      textLeft,
      y + 58,
      { width: RIGHT_EDGE - textLeft - 16 },
    );

  doc.y = y + height + 18;
}

/** The four sections and their scores, as one row of bars. */
function scoreRow(doc: PDFDoc, disciplines: DisciplineReport[]) {
  const gap = 12;
  const columnWidth = (CONTENT_W - gap * (disciplines.length - 1)) / disciplines.length;
  const y = doc.y;

  disciplines.forEach((discipline, index) => {
    const x = MARGIN_X + index * (columnWidth + gap);
    doc
      .fillColor(INK)
      .font("Helvetica-Bold")
      .fontSize(8)
      .text(DISCIPLINE_NAMES[discipline.discipline].toUpperCase(), x, y, { width: columnWidth, characterSpacing: 0.8, lineBreak: false });
    doc
      .fillColor(MUTED)
      .font("Helvetica")
      .fontSize(14)
      .text(discipline.scored ? `${discipline.score}` : "—", x, y + 13, { width: columnWidth, lineBreak: false });
    scoreBar(doc, x, y + 33, columnWidth, discipline.score, discipline.scored);
    doc
      .fillColor(MUTED)
      .font("Helvetica")
      .fontSize(7)
      .text(discipline.reviewer, x, y + 45, { width: columnWidth, lineBreak: false });
  });

  doc.y = y + 62;
}

// --- Findings ---------------------------------------------------------------

const SEVERITY_LABEL: Record<AuditSeverity, string> = {
  CRITICAL: "CRITICAL",
  HIGH: "HIGH",
  MEDIUM: "MEDIUM",
  LOW: "MINOR",
  GOOD: "GOOD",
};

/**
 * The severity chip.
 *
 * Solid ink for the two that matter, an outline for the two that do not, lime
 * for what is right. Weight rather than hue, because the palette has no red and
 * because a document read on a monochrome office printer has to keep the
 * hierarchy it had on screen.
 */
function severityChip(doc: PDFDoc, severity: AuditSeverity, x: number, y: number): number {
  const label = SEVERITY_LABEL[severity];
  doc.font("Helvetica-Bold").fontSize(6.6);
  const width = doc.widthOfString(label, { characterSpacing: 1 }) + 12;
  const height = 13;

  if (severity === "CRITICAL" || severity === "HIGH") {
    doc.roundedRect(x, y, width, height, 3).fill(INK);
    doc.fillColor(CREAM);
  } else if (severity === "GOOD") {
    doc.roundedRect(x, y, width, height, 3).fill(MARK);
    doc.fillColor(INK);
  } else {
    doc.roundedRect(x, y, width, height, 3).lineWidth(0.8).stroke(LINE);
    doc.fillColor(MUTED);
  }

  doc.font("Helvetica-Bold").fontSize(6.6).text(label, x + 6, y + 3.6, { characterSpacing: 1, lineBreak: false });
  return width;
}

function findingBlock(doc: PDFDoc, finding: AuditFindingDetail) {
  room(doc, 96);
  const top = doc.y;

  const chipWidth = severityChip(doc, finding.severity, MARGIN_X, top);
  const titleLeft = MARGIN_X + chipWidth + 9;
  doc
    .fillColor(INK)
    .font("Helvetica-Bold")
    .fontSize(10.5)
    .text(pdfText(finding.marker ? `${finding.title}  (box ${finding.marker})` : finding.title), titleLeft, top - 0.5, { width: RIGHT_EDGE - titleLeft, lineGap: 1 });

  doc.y = Math.max(doc.y, top + 15) + 4;
  paragraph(doc, finding.observed, 9.6);

  doc.moveDown(0.35);
  labelled(doc, "What it costs them", finding.impact);
  if (finding.recommendation) labelled(doc, "The fix", finding.recommendation);
  labelled(doc, "Evidence", finding.evidence, true);

  doc.moveDown(0.7);
  doc.strokeColor(LINE).lineWidth(0.5).moveTo(MARGIN_X, doc.y).lineTo(RIGHT_EDGE, doc.y).stroke();
  doc.moveDown(0.7);
}

/** A small tracked label with its value beside it, wrapping under itself. */
function labelled(doc: PDFDoc, label: string, value: string, quiet = false) {
  const labelWidth = 96;
  const top = doc.y;
  doc
    .fillColor(quiet ? MUTED : ACCENT)
    .font("Helvetica-Bold")
    .fontSize(6.8)
    .text(pdfText(label.toUpperCase()), MARGIN_X, top + 1.6, { width: labelWidth - 8, characterSpacing: 1 });
  const afterLabel = doc.y;
  doc
    .fillColor(MUTED)
    .font("Helvetica")
    .fontSize(quiet ? 7.6 : 9)
    .text(pdfText(value), MARGIN_X + labelWidth, top, { width: RIGHT_EDGE - MARGIN_X - labelWidth, lineGap: 1.6 });
  doc.y = Math.max(doc.y, afterLabel) + 3;
}

// --- Pictures ---------------------------------------------------------------

/**
 * A screenshot at full content width, with its caption underneath.
 *
 * A tall phone screenshot is capped rather than scaled to fit the page: a 390
 * by 3,000 picture squeezed onto one A4 page is a strip four centimetres wide
 * that shows nothing. Cutting it at a readable height and saying so is more
 * use than a complete picture nobody can see.
 */
function screenshotBlock(doc: PDFDoc, image: Buffer, size: { width: number; height: number }, caption: string, sub: string | null) {
  const maxHeight = 420;
  const drawWidth = Math.min(CONTENT_W, (size.width / size.height) * maxHeight);
  const drawHeight = Math.min(maxHeight, (size.height / size.width) * drawWidth);

  room(doc, drawHeight + 46);
  const y = doc.y;
  const x = MARGIN_X + (CONTENT_W - drawWidth) / 2;

  doc.image(image, x, y, { fit: [drawWidth, drawHeight] });
  doc
    .strokeColor(LINE)
    .lineWidth(0.7)
    .rect(x, y, drawWidth, drawHeight)
    .stroke();

  doc.y = y + drawHeight + 8;
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(8).text(pdfText(caption.toUpperCase()), MARGIN_X, doc.y, { width: CONTENT_W, characterSpacing: 1.1 });
  if (sub) {
    doc.moveDown(0.25);
    doc.fillColor(MUTED).font("Helvetica").fontSize(7.6).text(pdfText(sub), MARGIN_X, doc.y, { width: CONTENT_W });
  }
  doc.moveDown(1);
}

// --- The redesign call ------------------------------------------------------

/**
 * The decision, on its own page.
 *
 * Its own page rather than a block under the pictures, and that is a judgement
 * about how the document is read rather than about layout: this is the page
 * somebody prints, or turns their screen round to show a partner. A verdict
 * that begins two thirds of the way down a page of screenshots is a verdict
 * nobody quotes.
 *
 * The sources are not printed here. They are pages about how sites in a trade
 * look now, not evidence about this business, and a list of links under a
 * verdict reads as though the verdict came off them. They are in the Markdown,
 * labelled for what they are.
 */
function redesignSection(doc: PDFDoc, call: RedesignVerdict) {
  doc.addPage();
  header(doc, "Does this page need a redesign?", callLabel(call.call));

  doc.fillColor(INK).font("Helvetica-Bold").fontSize(11).text(pdfText(call.headline), MARGIN_X, doc.y, { width: CONTENT_W, lineGap: 2 });
  doc.moveDown(0.6);
  paragraph(doc, call.assessment, 10);

  if (call.issues.length) {
    sectionTitle(doc, "What is wrong with it", 100);
    for (const issue of call.issues) {
      room(doc, 40);
      const y = doc.y;
      doc
        .fillColor(ACCENT)
        .font("Helvetica-Bold")
        .fontSize(7)
        .text(pdfText(`${AREA_NAMES[issue.area].toUpperCase()} · ${issue.view === "mobile" ? "PHONE" : "DESKTOP"}`), MARGIN_X, y, {
          width: CONTENT_W,
          characterSpacing: 1,
        });
      doc.moveDown(0.25);
      doc.fillColor(INK).font("Helvetica").fontSize(9.4).text(pdfText(issue.observed), MARGIN_X, doc.y, { width: CONTENT_W, lineGap: 1.8 });
      doc.fillColor(MUTED).font("Helvetica-Oblique").fontSize(8.6).text(pdfText(issue.costsThem), MARGIN_X, doc.y + 1.5, { width: CONTENT_W, lineGap: 1.6 });
      doc.moveDown(0.7);
    }
  }

  sectionTitle(doc, "What it does to the business", 120);
  labelled(doc, "Trust", call.impact.trust);
  labelled(doc, "Finding things", call.impact.usability);
  labelled(doc, "Enquiries", call.impact.conversion);
  labelled(doc, "Landing on it", call.impact.howItFeels);

  if (call.direction.length) {
    sectionTitle(doc, "What a redesign should change", 90);
    call.direction.forEach((step, index) => {
      room(doc, 42);
      const y = doc.y;
      doc.roundedRect(MARGIN_X, y, 18, 18, 4).fill(INK);
      doc
        .fillColor(CREAM)
        .font("Helvetica-Bold")
        .fontSize(9)
        .text(String(index + 1), MARGIN_X, y + 5, { width: 18, align: "center", lineBreak: false });
      doc
        .fillColor(INK)
        .font("Helvetica-Bold")
        .fontSize(9.6)
        .text(pdfText(step.change), MARGIN_X + 27, y + 1, { width: RIGHT_EDGE - MARGIN_X - 27, lineGap: 1 });
      doc
        .fillColor(MUTED)
        .font("Helvetica")
        .fontSize(8.4)
        .text(pdfText(step.why), MARGIN_X + 27, doc.y + 1, { width: RIGHT_EDGE - MARGIN_X - 27, lineGap: 1.4 });
      doc.y = Math.max(doc.y, y + 22) + 7;
    });
  }

  sectionTitle(doc, "In one paragraph", 130);
  // Set apart, because it is the part meant to be read aloud or pasted into a
  // proposal, and the rule down its left edge is what tells a reader that.
  room(doc, 90);
  const top = doc.y;
  doc.fillColor(INK).font("Helvetica").fontSize(10).text(pdfText(call.summary), MARGIN_X + 14, top, { width: CONTENT_W - 14, lineGap: 3 });
  doc.strokeColor(ACCENT).lineWidth(2).moveTo(MARGIN_X + 2, top + 1).lineTo(MARGIN_X + 2, doc.y - 2).stroke();
  doc.moveDown(0.9);

  doc
    .fillColor(MUTED)
    .font("Helvetica")
    .fontSize(7.6)
    .text(pdfText(`The ${call.reviewer} made this call from the pictures on the previous page and from nothing else. ${call.decidedBy}.`), MARGIN_X, doc.y, {
      width: CONTENT_W,
    });
}

// --- The document -----------------------------------------------------------

export interface AuditPdfData {
  report: WebsiteAuditReport;
  /** Decoded from the report's base64, so this file never touches base64. */
  images: { view: "desktop" | "mobile"; data: Buffer; width: number; height: number; annotated: boolean; cropped: boolean }[];
}

export async function renderAuditPdf(data: AuditPdfData): Promise<Buffer> {
  const { report } = data;
  const doc = newDoc(await letterheadIdentity());

  header(doc, "Website review", report.businessName);

  doc
    .fillColor(MUTED)
    .font("Helvetica")
    .fontSize(9)
    .text(
      `${report.website ?? "No website answered"}   ·   reviewed ${new Date(report.ranAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}`,
      MARGIN_X,
      doc.y,
      { width: CONTENT_W },
    );
  doc.moveDown(1.1);

  scoreBand(doc, report);
  scoreRow(doc, report.disciplines);

  // --- The front page -------------------------------------------------------
  if (report.synthesis) {
    const synthesis = report.synthesis;

    sectionTitle(doc, "In short", 120);
    paragraph(doc, synthesis.executiveSummary, 10.5);

    sectionTitle(doc, "The one thing to do first", 90);
    paragraph(doc, synthesis.theOneThing, 10);

    sectionTitle(doc, "Why it is worth fixing", 120);
    labelled(doc, "The problem", synthesis.worthFixing.problem);
    labelled(doc, "What it costs", synthesis.worthFixing.costsThem);
    labelled(doc, "Why pay for it", synthesis.worthFixing.whyWorthPaying);

    if (synthesis.whatIsWorking.length) {
      sectionTitle(doc, "What is already working", 80);
      for (const entry of synthesis.whatIsWorking) {
        room(doc, 24);
        const y = doc.y;
        doc.roundedRect(MARGIN_X, y + 3.5, 5, 5, 2.5).fill(MARK);
        doc.fillColor(MUTED).font("Helvetica").fontSize(9.6).text(pdfText(entry), MARGIN_X + 14, y, { width: RIGHT_EDGE - MARGIN_X - 14, lineGap: 2 });
        doc.moveDown(0.4);
      }
    }

    if (synthesis.priority.length) {
      const byId = new Map(report.disciplines.flatMap((discipline) => discipline.findings).map((finding) => [finding.id, finding]));
      sectionTitle(doc, "Fix them in this order", 76);
      synthesis.priority.forEach((entry, index) => {
        const finding = byId.get(entry.findingId);
        if (!finding) return;
        room(doc, 42);
        const y = doc.y;
        doc.roundedRect(MARGIN_X, y, 18, 18, 4).fill(INK);
        doc
          .fillColor(CREAM)
          .font("Helvetica-Bold")
          .fontSize(9)
          .text(String(index + 1), MARGIN_X, y + 5, { width: 18, align: "center", lineBreak: false });
        doc
          .fillColor(INK)
          .font("Helvetica-Bold")
          .fontSize(9.6)
          .text(pdfText(finding.title), MARGIN_X + 27, y + 1, { width: RIGHT_EDGE - MARGIN_X - 27, lineGap: 1 });
        doc
          .fillColor(MUTED)
          .font("Helvetica")
          .fontSize(8.4)
          .text(pdfText(`${DISCIPLINE_NAMES[finding.discipline]} — ${entry.why}`), MARGIN_X + 27, doc.y + 1, { width: RIGHT_EDGE - MARGIN_X - 27, lineGap: 1.4 });
        doc.y = Math.max(doc.y, y + 22) + 7;
      });
    }
  } else {
    sectionTitle(doc, "In short", 90);
    paragraph(doc, "The four sections below were not compiled into a single summary — the note at the end of this document says why. Nothing the reviewers found has been changed.", 10);
  }

  // --- The pictures ---------------------------------------------------------
  if (data.images.length) {
    // `room` rather than `addPage`: a summary that ends two thirds down the
    // page should not be followed by a third of a page of white space and then
    // a heading. Only start a new one when there is genuinely no room for a
    // picture under it.
    room(doc, 520);
    sectionTitle(doc, "What a visitor sees", 460);

    const uxFindings = report.disciplines.find((discipline) => discipline.discipline === "UX")?.findings ?? [];
    const boxed = uxFindings.filter((finding) => finding.marker);

    for (const image of data.images) {
      screenshotBlock(
        doc,
        image.data,
        { width: image.width, height: image.height },
        image.view === "mobile" ? "On a phone, 390px wide" : "On a desktop browser, 1280px wide",
        [
          image.annotated ? "The numbered boxes mark roughly where each point applies — the area, not the pixel." : null,
          image.cropped ? "Their page is longer than this; what is shown is the top of it, which is what a visitor sees first." : null,
        ]
          .filter(Boolean)
          .join(" ") || null,
      );
    }

    if (boxed.length) {
      sectionTitle(doc, "What the boxes mark", 90);
      for (const finding of boxed) {
        room(doc, 30);
        const y = doc.y;
        doc.roundedRect(MARGIN_X, y, 16, 16, 4).fill(finding.severity === "GOOD" ? MARK : ACCENT);
        doc
          .fillColor(finding.severity === "GOOD" ? INK : CREAM)
          .font("Helvetica-Bold")
          .fontSize(8.4)
          .text(String(finding.marker), MARGIN_X, y + 4.4, { width: 16, align: "center", lineBreak: false });
        doc
          .fillColor(MUTED)
          .font("Helvetica")
          .fontSize(9)
          .text(pdfText(finding.plainly), MARGIN_X + 24, y + 1, { width: RIGHT_EDGE - MARGIN_X - 24, lineGap: 1.6 });
        doc.y = Math.max(doc.y, y + 18) + 5;
      }
    }
  }

  // --- The call -------------------------------------------------------------
  // After the pictures it was made from and before the four sections it is the
  // conclusion of, which is the order the questions arrive in.
  if (report.redesign) redesignSection(doc, report.redesign);

  // --- The four sections ----------------------------------------------------
  for (const discipline of report.disciplines) {
    doc.addPage();
    header(doc, discipline.scored ? `${DISCIPLINE_NAMES[discipline.discipline]} — ${discipline.score}/100` : `${DISCIPLINE_NAMES[discipline.discipline]} — not scored`, discipline.headline);

    doc
      .fillColor(MUTED)
      .font("Helvetica")
      .fontSize(8)
      .text(
        // The date is on the section rather than only on the front page,
        // because a section run again on its own is newer than the document
        // around it and a reader comparing the two has to be told which.
        `Reviewed by the ${discipline.reviewer} · ${DISCIPLINE_AGENTS[discipline.discipline].role} · ${discipline.reviewedBy}${
          discipline.rerunAt
            ? ` · this section reviewed again on ${new Date(discipline.rerunAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}`
            : ""
        }`,
        MARGIN_X,
        doc.y,
        { width: CONTENT_W },
      );
    doc.moveDown(0.6);
    scoreBar(doc, MARGIN_X, doc.y, CONTENT_W, discipline.score, discipline.scored);
    doc.y += 20;
    if (!discipline.scored) {
      // Said in the document rather than left as an empty bar. A reader who is
      // not told why a section has no number assumes the section is a formality.
      doc
        .fillColor(ACCENT)
        .font("Helvetica-Bold")
        .fontSize(8)
        .text("THIS SECTION DID NOT RUN, SO IT HAS NO SCORE AND IS LEFT OUT OF THE OVERALL", MARGIN_X, doc.y, { width: CONTENT_W, characterSpacing: 0.8 });
      doc.moveDown(0.8);
    }

    paragraph(doc, discipline.summary, 10);
    doc.moveDown(0.9);

    const problems = discipline.findings.filter((finding) => finding.severity !== "GOOD");
    const good = discipline.findings.filter((finding) => finding.severity === "GOOD");

    if (problems.length) {
      sectionTitle(doc, "What was found", 110);
      for (const finding of problems) findingBlock(doc, finding);
    } else if (discipline.checked.length) {
      sectionTitle(doc, "What was found", 60);
      paragraph(doc, "Nothing was found wrong in this section.", 10);
    }

    if (good.length) {
      sectionTitle(doc, "What is right here", 80);
      for (const finding of good) {
        room(doc, 30);
        const y = doc.y;
        doc.roundedRect(MARGIN_X, y + 3.5, 5, 5, 2.5).fill(MARK);
        doc.fillColor(INK).font("Helvetica-Bold").fontSize(9.4).text(pdfText(finding.title), MARGIN_X + 14, y, { width: RIGHT_EDGE - MARGIN_X - 14 });
        doc.fillColor(MUTED).font("Helvetica").fontSize(9).text(pdfText(finding.observed), MARGIN_X + 14, doc.y + 1, { width: RIGHT_EDGE - MARGIN_X - 14, lineGap: 1.6 });
        doc.moveDown(0.5);
      }
    }

    if (discipline.checked.length) {
      sectionTitle(doc, "What was examined", 70);
      doc.fillColor(MUTED).font("Helvetica").fontSize(8.4);
      for (const entry of discipline.checked) {
        room(doc, 16);
        doc.text(pdfText(`·  ${entry}`), MARGIN_X, doc.y, { width: CONTENT_W, lineGap: 1.4 });
      }
      doc.moveDown(0.4);
      doc
        .fillColor(MUTED)
        .font("Helvetica")
        .fontSize(7.6)
        .text("Anything not on this list was not examined, which is not the same as it being sound.", MARGIN_X, doc.y, { width: CONTENT_W });
    }

    if (discipline.notes.length) {
      sectionTitle(doc, "What could not be checked", 60);
      doc.fillColor(MUTED).font("Helvetica").fontSize(8.4);
      for (const note of discipline.notes) {
        room(doc, 22);
        doc.text(pdfText(`·  ${note}`), MARGIN_X, doc.y, { width: CONTENT_W, lineGap: 1.4 });
      }
    }
  }

  // --- The limits of the whole thing ---------------------------------------
  if (report.notes.length) {
    sectionTitle(doc, "What this review did not check", 100);
    paragraph(
      doc,
      "None of the following is a fault. A check that did not run is not a finding, and nothing below should be read — or repeated — as one.",
      9.4,
    );
    doc.moveDown(0.5);
    doc.fillColor(MUTED).font("Helvetica").fontSize(8.4);
    for (const note of report.notes) {
      room(doc, 24);
      doc.text(pdfText(`·  ${note}`), MARGIN_X, doc.y, { width: CONTENT_W, lineGap: 1.4 });
      doc.moveDown(0.2);
    }
  }

  return collectBuffer(doc);
}
