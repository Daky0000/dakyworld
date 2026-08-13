import PDFDocument from "pdfkit";
import {
  CONTENT_BOTTOM,
  CONTENT_TOP,
  CONTENT_W,
  LINE,
  ACCENT,
  MARGIN_X,
  INK,
  PAGE_H,
  PAGE_W,
  MUTED,
  stampLetterhead,
} from "./letterhead.js";

type PDFDoc = InstanceType<typeof PDFDocument>;

/** The right-hand edge of the text column. */
const RIGHT_EDGE = PAGE_W - MARGIN_X;

/**
 * Every document the app produces goes out on the letterhead — see
 * services/letterhead.ts. The margins are set to the content area it leaves,
 * and `pageAdded` stamps the chrome onto every page after the first, so a
 * three-page proposal is branded all the way through rather than only on top.
 */
function newDoc(): PDFDoc {
  const doc = new PDFDocument({
    size: "A4",
    margins: { top: CONTENT_TOP, bottom: CONTENT_BOTTOM, left: MARGIN_X, right: MARGIN_X },
  });
  doc.on("pageAdded", () => stampLetterhead(doc));
  stampLetterhead(doc);
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

/**
 * The document's own title block, inside the content area. The eyebrow is the
 * guide's H4 — small, uppercase, tracked, gold — and the title is the one
 * large thing on the page.
 */
function header(doc: PDFDoc, kicker: string, title: string) {
  doc.fillColor(ACCENT).font("Helvetica-Bold").fontSize(8).text(kicker.toUpperCase(), { characterSpacing: 1.6 });
  doc.moveDown(0.45);
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(19).text(title, { lineGap: 2 });
  doc.moveDown(0.5);
  doc.strokeColor(ACCENT).lineWidth(1.6).moveTo(MARGIN_X, doc.y).lineTo(MARGIN_X + 46, doc.y).stroke();
  doc.moveDown(1.1);
}

/** The argued document from lib/proposalWriter.ts, when one was generated. */
export interface ProposalBody {
  headline: string;
  situation: string;
  findings: { observed: string; evidence: string; costsThem: string; fix: string; service: string }[];
  scope: { phase: string; deliverables: string[]; outcome: string }[];
  investment: {
    lineItems: { description: string; amount: number; firm: boolean; billing: "ONE_OFF" | "MONTHLY" }[];
    total: number;
    totalIsFirm: boolean;
    recurring: number;
    basis: string;
  };
  timeline: string;
  whyUs: string;
  assumptions: string[];
  nextStep: string;
}

export interface ProposalPdfData {
  title: string;
  clientName: string;
  serviceType: string;
  scopeSummary: string;
  priceAmount: string;
  currency: string;
  priceTier?: string | null;
  expiresAt?: Date | null;
  /** Null for proposals written by hand, which render from scopeSummary alone. */
  body?: ProposalBody | null;
}

/** The last y a block may start at before it should go on the next page. */
const BREAK_AT = 690;
/** The bottom of the content area, above the letterhead's footer rule. */
const CONTENT_LIMIT = PAGE_H - CONTENT_BOTTOM;

/**
 * `needs` is the room the section's first block wants. Checking the heading
 * alone is not enough: the heading fits, then the block under it takes its own
 * page-break decision, and the heading is left stranded at the foot of the
 * page — the one layout fault that makes a document look machine-made.
 */
function sectionTitle(doc: PDFDoc, text: string, needs = 96) {
  if (doc.y + needs > CONTENT_LIMIT) doc.addPage();
  doc.moveDown(1.3);
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(10.5).text(text.toUpperCase(), { characterSpacing: 1.4 });
  doc.moveDown(0.5);
}

function paragraph(doc: PDFDoc, text: string, size = 10) {
  doc.fillColor(MUTED).font("Helvetica").fontSize(size).text(text, { align: "left", lineGap: 2 });
}

function money(currency: string, amount: number): string {
  return `${currency} ${amount.toLocaleString("en-GB", { maximumFractionDigits: 0 })}`;
}

export async function renderProposalPdf(data: ProposalPdfData): Promise<Buffer> {
  const doc = newDoc();
  header(doc, "Service Proposal", data.title);

  doc.fillColor(MUTED).font("Helvetica").fontSize(10).text(`Prepared for: ${data.clientName}`);
  doc.moveDown(1.2);

  const body = data.body ?? null;

  if (!body) {
    // The original shape: a proposal written by hand, before the writer existed.
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(11).text("Service");
    paragraph(doc, data.serviceType);
    doc.moveDown(0.8);
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(11).text("Scope");
    paragraph(doc, data.scopeSummary);
    doc.moveDown(0.8);
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(11).text("Investment");
    paragraph(doc, `${data.currency} ${data.priceAmount}${data.priceTier ? ` — ${data.priceTier}` : ""}`);
  } else {
    // The headline is the whole argument in one line, so it gets the weight.
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(13).text(body.headline, { lineGap: 3 });
    doc.moveDown(0.8);

    sectionTitle(doc, "Where you are");
    paragraph(doc, body.situation);

    if (body.findings.length) {
      sectionTitle(doc, "What we found");
      for (const finding of body.findings) {
        if (doc.y > BREAK_AT) doc.addPage();
        doc.fillColor(INK).font("Helvetica-Bold").fontSize(10).text(finding.observed, { lineGap: 1.5 });
        doc.moveDown(0.2);
        doc.fillColor(MUTED).font("Helvetica").fontSize(9).text(finding.costsThem, { lineGap: 1.5 });
        doc.moveDown(0.15);
        doc.fillColor(MUTED).font("Helvetica-Oblique").fontSize(8).text(`Checked: ${finding.evidence}`);
        doc.moveDown(0.15);
        doc.fillColor(INK).font("Helvetica").fontSize(9).text(`What we would do: ${finding.fix}`, { lineGap: 1.5 });
        doc.moveDown(1.15);
      }
    }

    if (body.scope.length) {
      sectionTitle(doc, "What you get");
      for (const phase of body.scope) {
        if (doc.y > BREAK_AT) doc.addPage();
        doc.fillColor(INK).font("Helvetica-Bold").fontSize(10).text(phase.phase);
        for (const item of phase.deliverables) {
          doc.fillColor(MUTED).font("Helvetica").fontSize(9).text(`·  ${item}`, { indent: 8, lineGap: 1 });
        }
        doc.fillColor(MUTED).font("Helvetica-Oblique").fontSize(9).text(phase.outcome, { lineGap: 1.5 });
        doc.moveDown(0.95);
      }
    }

    sectionTitle(doc, "Investment");
    for (const item of body.investment.lineItems) {
      const y = doc.y;
      doc.fillColor(MUTED).font("Helvetica").fontSize(9.5).text(item.description, MARGIN_X, y, { width: 330 });
      const price = item.amount > 0
        ? `${money(data.currency, item.amount)}${item.billing === "MONTHLY" ? "/mo" : ""}`
        : "after the call";
      doc.fillColor(item.amount > 0 ? INK : MUTED).font("Helvetica").fontSize(9.5).text(price, RIGHT_EDGE - 140, y, { width: 140, align: "right" });
      doc.moveDown(0.35);
    }
    doc.moveDown(0.3);
    doc.strokeColor(LINE).lineWidth(1).moveTo(MARGIN_X, doc.y).lineTo(RIGHT_EDGE, doc.y).stroke();
    doc.moveDown(0.5);

    const totalY = doc.y;
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(11).text("Total", MARGIN_X, totalY);
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(11).text(money(data.currency, body.investment.total), RIGHT_EDGE - 140, totalY, {
      width: 140,
      align: "right",
    });
    doc.moveDown(0.4);
    if (body.investment.recurring > 0) {
      const monthlyY = doc.y;
      doc.fillColor(MUTED).font("Helvetica").fontSize(9.5).text("Then, monthly", MARGIN_X, monthlyY);
      doc.fillColor(MUTED).font("Helvetica").fontSize(9.5).text(`${money(data.currency, body.investment.recurring)}/mo`, RIGHT_EDGE - 140, monthlyY, {
        width: 140,
        align: "right",
      });
      doc.moveDown(0.4);
    }
    doc.fillColor(MUTED).font("Helvetica-Oblique").fontSize(8.5).text(body.investment.basis, MARGIN_X, doc.y, { width: CONTENT_W, lineGap: 1 });

    sectionTitle(doc, "Timeline");
    paragraph(doc, body.timeline);

    sectionTitle(doc, "Why Dakyworld");
    paragraph(doc, body.whyUs);

    if (body.assumptions.length) {
      sectionTitle(doc, "What this assumes");
      for (const assumption of body.assumptions) {
        doc.fillColor(MUTED).font("Helvetica").fontSize(9).text(`·  ${assumption}`, { indent: 8, lineGap: 1 });
      }
    }

    sectionTitle(doc, "Next step");
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(10.5).text(body.nextStep, { lineGap: 2 });
  }

  doc.moveDown(0.8);
  if (data.expiresAt) {
    doc.fillColor(MUTED).font("Helvetica").fontSize(9).text(`This proposal holds until ${data.expiresAt.toDateString()}.`);
  }

  return collectBuffer(doc);
}

export interface InvoicePdfData {
  invoiceNumber: string;
  clientName: string;
  currency: string;
  issueDate: Date;
  dueDate: Date;
  lineItems: { description: string; quantity: string; unitPrice: string; amount: string }[];
  amountTotal: string;
}

/**
 * Money columns are right-aligned to a fixed edge so the decimal points line
 * up down the page, which is the only reason an invoice table is a table.
 */
const INVOICE_COLS = {
  desc: MARGIN_X,
  descWidth: 236,
  qtyRight: MARGIN_X + 300,
  priceRight: MARGIN_X + 396,
  amountRight: PAGE_W - MARGIN_X,
  numWidth: 84,
};

function invoiceRow(
  doc: PDFDoc,
  row: { description: string; quantity: string; unitPrice: string; amount: string },
  currency: string,
) {
  const y = doc.y;
  const c = INVOICE_COLS;
  doc.text(row.description, c.desc, y, { width: c.descWidth });
  const rowEnd = doc.y;

  doc.text(row.quantity, c.qtyRight - c.numWidth, y, { width: c.numWidth, align: "right" });
  doc.text(`${currency} ${row.unitPrice}`, c.priceRight - c.numWidth, y, { width: c.numWidth, align: "right" });
  doc.text(`${currency} ${row.amount}`, c.amountRight - c.numWidth, y, { width: c.numWidth, align: "right" });

  // A wrapped description must push the next row down, not be written over.
  doc.x = MARGIN_X;
  doc.y = Math.max(rowEnd, y + 14);
}

export async function renderInvoicePdf(data: InvoicePdfData): Promise<Buffer> {
  const doc = newDoc();
  header(doc, "Invoice", data.invoiceNumber);

  doc.fillColor(MUTED).font("Helvetica").fontSize(10);
  doc.text(`Bill to: ${data.clientName}`);
  doc.text(`Issue date: ${data.issueDate.toDateString()}`);
  doc.text(`Due date: ${data.dueDate.toDateString()}`);
  doc.moveDown(1.4);

  const c = INVOICE_COLS;
  const headY = doc.y;
  doc.fillColor(MUTED).font("Helvetica-Bold").fontSize(8).text("DESCRIPTION", c.desc, headY, { characterSpacing: 0.9 });
  doc.text("QTY", c.qtyRight - c.numWidth, headY, { width: c.numWidth, align: "right", characterSpacing: 0.9 });
  doc.text("UNIT PRICE", c.priceRight - c.numWidth, headY, { width: c.numWidth, align: "right", characterSpacing: 0.9 });
  doc.text("AMOUNT", c.amountRight - c.numWidth, headY, { width: c.numWidth, align: "right", characterSpacing: 0.9 });
  doc.x = MARGIN_X;
  doc.y = headY + 13;
  doc.strokeColor(LINE).lineWidth(1).moveTo(MARGIN_X, doc.y).lineTo(RIGHT_EDGE, doc.y).stroke();
  doc.moveDown(0.5);

  doc.font("Helvetica").fontSize(9).fillColor(MUTED);
  for (const item of data.lineItems) {
    if (doc.y > BREAK_AT) doc.addPage();
    invoiceRow(doc, item, data.currency);
  }

  doc.moveDown(0.5);
  doc.strokeColor(LINE).lineWidth(1).moveTo(MARGIN_X, doc.y).lineTo(RIGHT_EDGE, doc.y).stroke();
  doc.moveDown(0.7);

  // Written as two positioned cells rather than one right-aligned string:
  // `doc.x` is still at the last column after the table, so a plain
  // `align: "right"` here would wrap the total into a 70pt gutter.
  const totalY = doc.y;
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(10.5).text("TOTAL DUE", MARGIN_X, totalY, { characterSpacing: 1.2 });
  doc
    .fillColor(INK)
    .font("Helvetica-Bold")
    .fontSize(12)
    .text(`${data.currency} ${data.amountTotal}`, c.amountRight - 170, totalY - 1.5, { width: 170, align: "right" });
  doc.x = MARGIN_X;
  doc.y = totalY + 20;

  doc.strokeColor(ACCENT).lineWidth(1.6).moveTo(c.amountRight - 170, doc.y).lineTo(RIGHT_EDGE, doc.y).stroke();

  return collectBuffer(doc);
}
