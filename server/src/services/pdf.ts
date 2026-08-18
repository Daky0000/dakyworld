import PDFDocument from "pdfkit";
import {
  CONTENT_BOTTOM,
  CONTENT_TOP,
  CONTENT_W,
  LINE,
  ACCENT,
  ACCENT_DEEP,
  CREAM,
  MARK,
  MARGIN_X,
  INK,
  PAGE_H,
  PAGE_W,
  MUTED,
  stampLetterhead,
  letterheadIdentity,
  type LetterheadIdentity,
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
  const doc = newDoc(await letterheadIdentity());
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

// ===========================================================================
// The invoice
// ===========================================================================

/**
 * An invoice has one job: make it obvious what is owed, by when, and how to
 * pay it. Everything below is arranged around that — the balance sits in a
 * solid band near the top, above the table, because a client who opens this on
 * a phone should not have to scroll to find the number.
 *
 * Every field beyond the original six is optional. An invoice raised from a
 * record that carries no tax, no deposit and no bank details still renders;
 * the blocks that have nothing to say simply are not drawn.
 */
export interface InvoicePdfData {
  invoiceNumber: string;
  clientName: string;
  /** The trading entity, when the named contact isn't the bill payer. */
  clientCompany?: string | null;
  clientAddressLines?: string[];
  clientEmail?: string | null;
  clientPhone?: string | null;
  /** The client's own PO or cost-centre reference, printed as they gave it. */
  clientReference?: string | null;

  currency: string;
  issueDate: Date;
  dueDate: Date;
  /** When it was actually settled. Printed on a paid invoice, which is a receipt. */
  paidDate?: Date | null;
  status?: InvoiceStamp | null;
  /** What the invoice is for — a project or care-plan name. */
  reference?: string | null;
  /** "Net 14", "Due on receipt", "50% deposit". */
  paymentTerms?: string | null;

  lineItems: InvoiceLine[];

  /** Line items before any adjustment. Computed from the lines when absent. */
  subtotal?: string | null;
  discount?: InvoiceAdjustment | null;
  tax?: InvoiceAdjustment | null;
  amountTotal: string;
  /** A deposit already settled, or a part payment. */
  amountPaid?: string | null;
  /** What is actually owed today. Falls back to the total when nothing is paid. */
  balanceDue?: string | null;

  payment?: InvoicePayment | null;
  /** A sentence to this client on this invoice — thanks, or what happens next. */
  notes?: string | null;
  /** The standing terms line: what happens if it is paid late. */
  termsNote?: string | null;
}

export interface InvoiceLine {
  description: string;
  /** A second line under the description — the period covered, the milestone. */
  detail?: string | null;
  quantity: string;
  unitPrice: string;
  amount: string;
}

export interface InvoiceAdjustment {
  /** "VAT + levies (21.9%)", "Retainer discount", "Early settlement". */
  label: string;
  amount: string;
}

/** Where the money goes. Any line left empty is not printed. */
export interface InvoicePayment {
  bankName?: string | null;
  accountName?: string | null;
  accountNumber?: string | null;
  branch?: string | null;
  swift?: string | null;
  /** Mobile money, which is how most Ghanaian invoices actually get settled. */
  momoName?: string | null;
  momoNumber?: string | null;
  momoNetwork?: string | null;
  /** The Stripe Checkout link, when one has been created. */
  payLink?: string | null;
}

export type InvoiceStamp = "DRAFT" | "SENT" | "PAID" | "PARTIALLY PAID" | "OVERDUE" | "VOID";

// --- Formatting ------------------------------------------------------------

/**
 * Amounts arrive as Prisma `Decimal.toString()`, which gives "1500" and
 * "1500.5" — neither of which belongs on an invoice. Anything that isn't a
 * number is printed exactly as it was handed over, because a caller who wrote
 * "TBC" meant it.
 */
function amountText(currency: string, value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "";
  const n = Number(value);
  if (!Number.isFinite(n)) return `${currency} ${value}`;
  return `${currency} ${n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Quantities read better without forced decimals: "1", "2.5", "12". */
function quantityText(value: string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return n.toLocaleString("en-GB", { maximumFractionDigits: 2 });
}

function numberOf(value: string | null | undefined): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** "18 August 2026" — unambiguous everywhere, which "08/09/26" is not. */
function longDate(date: Date): string {
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

function wholeDaysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / 86_400_000);
}

// --- Small drawing primitives ----------------------------------------------

/**
 * A label above a value, which is most of what an invoice is. Returns the y it
 * finished at so a caller stacking several can keep its own rhythm.
 */
function labelledValue(
  doc: PDFDoc,
  label: string,
  value: string,
  x: number,
  y: number,
  width: number,
  align: "left" | "right" = "left",
): number {
  doc.fillColor(MUTED).font("Helvetica-Bold").fontSize(6.8).text(label.toUpperCase(), x, y, {
    width,
    align,
    characterSpacing: 1.1,
  });
  doc.fillColor(INK).font("Helvetica").fontSize(9.5).text(value, x, y + 8.5, { width, align, lineGap: 1 });
  return doc.y;
}

/**
 * The status stamp, top right of the header row.
 *
 * Paid is the one state worth colour: a lime chip is readable across a room,
 * which is the point of the word on a document somebody is filing. Overdue is
 * solid ink rather than red — the brand has no red, and an ink chip beside a
 * cream page is quite loud enough.
 */
function statusPill(doc: PDFDoc, status: InvoiceStamp, y: number) {
  const paid = status === "PAID";
  const heavy = paid || status === "OVERDUE" || status === "PARTIALLY PAID";
  const padding = 9;

  // save()/restore() covers the graphics state and nothing else — positioned
  // text still leaves the cursor where the last glyph landed. The pill is
  // drawn back up beside the title, so without this the block after it starts
  // at the top of the header and prints straight over it.
  const cursor = { x: doc.x, y: doc.y };

  doc.save();
  doc.font("Helvetica-Bold").fontSize(7.5);
  const textWidth = doc.widthOfString(status, { characterSpacing: 1.3 });
  const width = textWidth + padding * 2;
  const height = 17;
  const x = RIGHT_EDGE - width;

  if (paid) {
    doc.fillColor(MARK).roundedRect(x, y, width, height, 8.5).fill();
  } else if (heavy) {
    doc.fillColor(INK).roundedRect(x, y, width, height, 8.5).fill();
  } else {
    doc.strokeColor(LINE).lineWidth(1).roundedRect(x, y, width, height, 8.5).stroke();
  }

  doc
    .fillColor(heavy ? (paid ? INK : CREAM) : MUTED)
    .font("Helvetica-Bold")
    .fontSize(7.5)
    .text(status, x + padding, y + 5.2, { characterSpacing: 1.3, lineBreak: false });
  doc.restore();

  doc.x = cursor.x;
  doc.y = cursor.y;
}

/**
 * The balance, in an ink band with a lime edge.
 *
 * This is the only place lime type appears in the app's documents — on ink it
 * is legible and it is the brand's own accent, which is exactly the rule the
 * design system sets out.
 */
function balanceBand(doc: PDFDoc, data: InvoicePdfData, balance: string) {
  const height = 56;
  const y = doc.y;
  const settled = data.status === "PAID";

  doc.save();
  doc.fillColor(INK).roundedRect(MARGIN_X, y, CONTENT_W, height, 5).fill();
  doc.fillColor(MARK).rect(MARGIN_X, y + 5, 3.5, height - 10).fill();

  // On a settled invoice the balance is nil, and a band reading "AMOUNT PAID —
  // GHS 0.00" says the opposite of what happened. What the client wants to see
  // on a receipt is the sum that left their account.
  const figure = settled ? amountText(data.currency, data.amountPaid ?? data.amountTotal) : balance;

  const padLeft = MARGIN_X + 20;
  doc
    .fillOpacity(0.62)
    .fillColor(CREAM)
    .font("Helvetica-Bold")
    .fontSize(7)
    .text(settled ? "AMOUNT PAID" : "BALANCE DUE", padLeft, y + 14, {
      characterSpacing: 1.6,
      lineBreak: false,
    });
  doc.fillOpacity(1).fillColor(CREAM).font("Helvetica-Bold").fontSize(20).text(figure, padLeft, y + 26, {
    lineBreak: false,
  });

  // Right of the band: the date it turns into a problem — or, once it is paid,
  // the date it stopped being one. A settled invoice with no recorded payment
  // date shows nothing here rather than the due date, which would read as a
  // deadline on a document that is already closed.
  const overdueBy = wholeDaysBetween(data.dueDate, new Date());
  const chase = !settled && overdueBy > 0;
  const rightDate = settled ? data.paidDate : data.dueDate;
  const rightWidth = 190;
  const rightX = RIGHT_EDGE - 20 - rightWidth;

  if (!rightDate) {
    doc.restore();
    doc.x = MARGIN_X;
    doc.y = y + height + 16;
    return;
  }

  doc
    .fillOpacity(0.62)
    .fillColor(CREAM)
    .font("Helvetica-Bold")
    .fontSize(7)
    .text(settled ? "SETTLED" : "PAYABLE BY", rightX, y + 14, {
      width: rightWidth,
      align: "right",
      characterSpacing: 1.6,
    });
  doc
    .fillOpacity(1)
    .fillColor(chase ? MARK : CREAM)
    .font("Helvetica-Bold")
    .fontSize(11)
    .text(longDate(rightDate), rightX, y + 28, { width: rightWidth, align: "right" });
  if (chase) {
    doc
      .fillOpacity(0.75)
      .fillColor(MARK)
      .font("Helvetica")
      .fontSize(7.5)
      .text(`${overdueBy} day${overdueBy === 1 ? "" : "s"} overdue`, rightX, y + 42, {
        width: rightWidth,
        align: "right",
      });
  }
  doc.restore();

  doc.x = MARGIN_X;
  doc.y = y + height + 16;
}

/** The gap between one fact and the next in the right-hand column. */
const FACT_GAP = 4;

/**
 * What the totals stack needs, so it is never orphaned from the table it adds
 * up: four quiet rows at 15, two rules at 9 and 10, two promoted rows at 18,
 * and the 4 of lead-in — 118, rounded up. A total on its own page is the one
 * break on an invoice that looks like a mistake, so this is measured rather
 * than guessed; a round number that is 0.1pt too big pushes the very page it
 * was meant to prevent.
 */
const TOTALS_HEIGHT = 120;

// --- The line-item table ---------------------------------------------------

/**
 * Money columns are right-aligned to a fixed edge so the decimal points line
 * up down the page, which is the only reason an invoice table is a table.
 */
const INVOICE_COLS = {
  desc: MARGIN_X,
  descWidth: 246,
  qtyRight: MARGIN_X + 310,
  priceRight: MARGIN_X + 400,
  amountRight: PAGE_W - MARGIN_X,
  numWidth: 88,
};

function invoiceTableHead(doc: PDFDoc) {
  const c = INVOICE_COLS;
  const y = doc.y;
  doc.fillColor(MUTED).font("Helvetica-Bold").fontSize(6.8);
  doc.text("DESCRIPTION", c.desc, y, { characterSpacing: 1.1 });
  doc.text("QTY", c.qtyRight - c.numWidth, y, { width: c.numWidth, align: "right", characterSpacing: 1.1 });
  doc.text("UNIT PRICE", c.priceRight - c.numWidth, y, { width: c.numWidth, align: "right", characterSpacing: 1.1 });
  doc.text("AMOUNT", c.amountRight - c.numWidth, y, { width: c.numWidth, align: "right", characterSpacing: 1.1 });
  doc.x = MARGIN_X;
  doc.y = y + 12;
  doc.strokeColor(INK).lineWidth(1).moveTo(MARGIN_X, doc.y).lineTo(RIGHT_EDGE, doc.y).stroke();
  doc.y += 9;
}

function invoiceRow(doc: PDFDoc, row: InvoiceLine, currency: string) {
  const y = doc.y;
  const c = INVOICE_COLS;

  doc.fillColor(INK).font("Helvetica").fontSize(9.5).text(row.description, c.desc, y, { width: c.descWidth, lineGap: 1 });
  if (row.detail) {
    doc
      .fillColor(MUTED)
      .font("Helvetica")
      .fontSize(8)
      .text(row.detail, c.desc, doc.y + 1.5, { width: c.descWidth, lineGap: 1 });
  }
  const rowEnd = doc.y;

  doc.fillColor(MUTED).font("Helvetica").fontSize(9.5);
  doc.text(quantityText(row.quantity), c.qtyRight - c.numWidth, y, { width: c.numWidth, align: "right" });
  doc.text(amountText(currency, row.unitPrice), c.priceRight - c.numWidth, y, { width: c.numWidth, align: "right" });
  doc.fillColor(INK).text(amountText(currency, row.amount), c.amountRight - c.numWidth, y, {
    width: c.numWidth,
    align: "right",
  });

  // A wrapped description must push the next row down, not be written over.
  doc.x = MARGIN_X;
  doc.y = Math.max(rowEnd, y + 13) + 5;
  doc.strokeColor(LINE).lineWidth(0.6).moveTo(MARGIN_X, doc.y).lineTo(RIGHT_EDGE, doc.y).stroke();
  doc.y += 6;
}

/** One right-hand totals line. `loud` promotes it to the payable figure. */
function totalsRow(doc: PDFDoc, label: string, value: string, weight: "quiet" | "normal" | "loud" = "normal") {
  const blockX = RIGHT_EDGE - 260;
  const labelWidth = 150;
  const valueWidth = 110;
  const y = doc.y;
  const font = weight === "normal" ? "Helvetica" : "Helvetica-Bold";
  const colour = weight === "quiet" ? MUTED : INK;

  doc.fillColor(colour).font(font).fontSize(9.5).text(label, blockX, y, { width: labelWidth, align: "right" });
  doc
    .fillColor(colour)
    .font(font)
    .fontSize(weight === "loud" ? 11 : 9.5)
    .text(value, RIGHT_EDGE - valueWidth, y - (weight === "loud" ? 1.5 : 0), { width: valueWidth, align: "right" });

  doc.x = MARGIN_X;
  doc.y = y + (weight === "loud" ? 18 : 15);
}

// --- How to pay ------------------------------------------------------------

/**
 * How tall `payColumn` will be, without drawing it.
 *
 * Measured with `heightOfString` rather than by laying the column out below
 * the page and rewinding: PDFKit paginates on `text()`, so a "measure" pass
 * that draws anything past the bottom margin silently adds pages until it
 * reaches the y it was given. The two routines share the same arithmetic and
 * have to keep sharing it.
 */
function payColumnHeight(doc: PDFDoc, rows: [string, string][], width: number): number {
  let cursor = 13;
  for (const [, value] of rows) {
    doc.font("Helvetica-Bold").fontSize(8.5);
    const height = doc.heightOfString(value, { width: width - 78, lineGap: 1 });
    cursor += Math.max(height, 11) + 2.5;
  }
  return cursor;
}

/** Label/value pairs down a column, at the size a bank detail has to be read at. */
function payColumn(doc: PDFDoc, title: string, rows: [string, string][], x: number, y: number, width: number): number {
  doc.fillColor(ACCENT_DEEP).font("Helvetica-Bold").fontSize(6.8).text(title.toUpperCase(), x, y, {
    width,
    characterSpacing: 1.2,
  });
  let cursor = y + 13;
  for (const [label, value] of rows) {
    doc.fillColor(MUTED).font("Helvetica").fontSize(8.5).text(label, x, cursor, { width: 74, lineBreak: false });
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(8.5).text(value, x + 78, cursor, { width: width - 78, lineGap: 1 });
    cursor = Math.max(doc.y, cursor + 11) + 2.5;
  }
  return cursor;
}

/**
 * The payment block, in a cream panel so it reads as an instruction rather
 * than more of the invoice. Laid out twice — once off-page to measure, once
 * for real — because the panel has to be filled before the text that sits on
 * it, and its height isn't known until the text has been laid out.
 */
function paymentPanel(doc: PDFDoc, payment: InvoicePayment) {
  const bank: [string, string][] = [];
  if (payment.bankName) bank.push(["Bank", payment.bankName]);
  if (payment.accountName) bank.push(["Account", payment.accountName]);
  if (payment.accountNumber) bank.push(["Number", payment.accountNumber]);
  if (payment.branch) bank.push(["Branch", payment.branch]);
  if (payment.swift) bank.push(["SWIFT", payment.swift]);

  const momo: [string, string][] = [];
  if (payment.momoNetwork) momo.push(["Network", payment.momoNetwork]);
  if (payment.momoNumber) momo.push(["Number", payment.momoNumber]);
  if (payment.momoName) momo.push(["Name", payment.momoName]);
  if (payment.payLink) momo.push(["Card", payment.payLink]);

  if (!bank.length && !momo.length) return;

  const colWidth = (CONTENT_W - 40 - 28) / 2;
  const leftX = MARGIN_X + 20;
  const rightX = leftX + colWidth + 28;

  const height = Math.max(payColumnHeight(doc, bank, colWidth), payColumnHeight(doc, momo, colWidth)) + 26;
  // The panel knows how tall it is, so it decides its own break rather than
  // being guessed at by the caller — a reserve that is too generous pushes a
  // block onto a second page that had room for it all along.
  if (doc.y + height > CONTENT_LIMIT) doc.addPage();
  const startY = doc.y;

  doc.save();
  doc.fillColor(CREAM).roundedRect(MARGIN_X, startY, CONTENT_W, height, 5).fill();
  doc.fillColor(MARK).rect(MARGIN_X, startY + 5, 3.5, height - 10).fill();
  doc.restore();

  if (bank.length) payColumn(doc, "Bank transfer", bank, leftX, startY + 15, colWidth);
  if (momo.length) payColumn(doc, "Mobile money and card", momo, rightX, startY + 15, colWidth);

  doc.x = MARGIN_X;
  doc.y = startY + height + 16;
}

// --- The document ----------------------------------------------------------

export async function renderInvoicePdf(data: InvoicePdfData): Promise<Buffer> {
  const doc = newDoc(await letterheadIdentity());
  const currency = data.currency;

  const headerY = doc.y;
  header(doc, "Invoice", data.invoiceNumber);
  statusPill(doc, data.status ?? "SENT", headerY + 2);

  // --- Who it is for, and the facts about it ------------------------------
  const factsX = MARGIN_X + 300;
  const factsWidth = CONTENT_W - 300;
  const blockTop = doc.y;

  const billedTo = [
    data.clientCompany && data.clientCompany !== data.clientName ? data.clientCompany : null,
    ...(data.clientAddressLines ?? []),
    data.clientEmail,
    data.clientPhone,
  ].filter((line): line is string => Boolean(line));

  doc.fillColor(MUTED).font("Helvetica-Bold").fontSize(6.8).text("BILLED TO", MARGIN_X, blockTop, {
    characterSpacing: 1.1,
  });
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(11.5).text(data.clientName, MARGIN_X, blockTop + 11, { width: 260 });
  if (billedTo.length) {
    doc.fillColor(MUTED).font("Helvetica").fontSize(9).text(billedTo.join("\n"), MARGIN_X, doc.y + 2, {
      width: 260,
      lineGap: 2,
    });
  }
  const leftEnd = doc.y;

  let factY = blockTop;
  factY = labelledValue(doc, "Issued", longDate(data.issueDate), factsX, factY, factsWidth, "right") + FACT_GAP;
  factY = labelledValue(doc, "Due", longDate(data.dueDate), factsX, factY, factsWidth, "right") + FACT_GAP;
  if (data.paymentTerms) {
    factY = labelledValue(doc, "Terms", data.paymentTerms, factsX, factY, factsWidth, "right") + FACT_GAP;
  }
  if (data.reference) {
    factY = labelledValue(doc, "For", data.reference, factsX, factY, factsWidth, "right") + FACT_GAP;
  }
  if (data.clientReference) {
    factY = labelledValue(doc, "Your reference", data.clientReference, factsX, factY, factsWidth, "right") + FACT_GAP;
  }

  doc.x = MARGIN_X;
  doc.y = Math.max(leftEnd, factY) + 12;

  // --- The number, before the detail --------------------------------------
  const balance = data.balanceDue ?? data.amountTotal;
  balanceBand(doc, data, amountText(currency, balance));

  // --- The lines ----------------------------------------------------------
  invoiceTableHead(doc);
  for (const item of data.lineItems) {
    if (doc.y > BREAK_AT) {
      doc.addPage();
      invoiceTableHead(doc);
    }
    invoiceRow(doc, item, currency);
  }

  // --- What it adds up to -------------------------------------------------
  const subtotal = data.subtotal ?? data.lineItems.reduce((sum, item) => sum + numberOf(item.amount), 0).toFixed(2);

  if (doc.y + TOTALS_HEIGHT > CONTENT_LIMIT) doc.addPage();
  doc.y += 4;

  if (data.discount || data.tax || data.amountPaid) {
    totalsRow(doc, "Subtotal", amountText(currency, subtotal), "quiet");
  }
  if (data.discount) totalsRow(doc, data.discount.label, `- ${amountText(currency, data.discount.amount)}`, "quiet");
  if (data.tax) totalsRow(doc, data.tax.label, amountText(currency, data.tax.amount), "quiet");

  doc.strokeColor(LINE).lineWidth(1).moveTo(RIGHT_EDGE - 260, doc.y).lineTo(RIGHT_EDGE, doc.y).stroke();
  doc.y += 9;

  totalsRow(doc, "Invoice total", amountText(currency, data.amountTotal), "loud");
  if (data.amountPaid && numberOf(data.amountPaid) > 0) {
    totalsRow(doc, "Already paid", `- ${amountText(currency, data.amountPaid)}`, "quiet");
  }

  doc.strokeColor(ACCENT).lineWidth(1.6).moveTo(RIGHT_EDGE - 260, doc.y).lineTo(RIGHT_EDGE, doc.y).stroke();
  doc.y += 10;
  totalsRow(doc, "Balance due", amountText(currency, balance), "loud");

  // --- How to pay it ------------------------------------------------------
  doc.y += 12;
  if (data.payment) paymentPanel(doc, data.payment);

  if (data.notes) {
    if (doc.y + 60 > CONTENT_LIMIT) doc.addPage();
    doc.fillColor(MUTED).font("Helvetica-Bold").fontSize(6.8).text("NOTES", MARGIN_X, doc.y, { characterSpacing: 1.1 });
    doc.moveDown(0.4);
    doc.fillColor(MUTED).font("Helvetica").fontSize(9).text(data.notes, MARGIN_X, doc.y, {
      width: CONTENT_W,
      lineGap: 2,
    });
    doc.moveDown(0.9);
  }

  if (data.termsNote) {
    if (doc.y + 40 > CONTENT_LIMIT) doc.addPage();
    doc.fillColor(MUTED).font("Helvetica-Oblique").fontSize(8).text(data.termsNote, MARGIN_X, doc.y, {
      width: CONTENT_W,
      lineGap: 1.5,
    });
  }

  return collectBuffer(doc);
}
