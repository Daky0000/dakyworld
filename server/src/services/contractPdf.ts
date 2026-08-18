import PDFDocument from "pdfkit";
import {
  ACCENT,
  ACCENT_DEEP,
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
  stampLetterhead,
  type LetterheadIdentity,
} from "./letterhead.js";
import { companyProfile, type CompanyProfile } from "./systemProfile.js";

type PDFDoc = InstanceType<typeof PDFDocument>;

const RIGHT_EDGE = PAGE_W - MARGIN_X;
const CONTENT_LIMIT = PAGE_H - CONTENT_BOTTOM;

/**
 * The service agreement — the document a client signs before any work starts.
 *
 * Two things shape it. First, the page a busy buyer actually reads is the key
 * terms panel on page one: what is being bought, for how much, over how long,
 * and how either side gets out. The clauses exist for the day something goes
 * wrong; the panel exists for the day it is signed, and burying the commercial
 * terms in clause 4 is how agreements get signed without being understood.
 *
 * Second, the wording is data, not layout. `DEFAULT_CLAUSES` below is the
 * whole legal body in one editable list, so the terms can be changed — or
 * swapped for a client's own redline — without touching a drawing routine.
 *
 * This is a template, not legal advice. It is written for a Ghanaian services
 * company and should be read by a lawyer before it is used in anger.
 */

// ---------------------------------------------------------------------------
// The data a signed agreement is made of
// ---------------------------------------------------------------------------

export interface ContractParty {
  /** The registered entity, exactly as it is on the certificate. */
  legalName: string;
  /** "the Provider", "the Client" — how the party is referred to throughout. */
  shortName: string;
  registrationNumber?: string | null;
  addressLines?: string[];
  email?: string | null;
  phone?: string | null;
  /** Who actually signs, and in what capacity. */
  signatory?: { name: string; title: string } | null;
}

export interface ContractFeeLine {
  description: string;
  detail?: string | null;
  amount: string;
  /** ONE_OFF prints as a figure; MONTHLY prints with "/month" after it. */
  billing: "ONE_OFF" | "MONTHLY";
}

export interface ContractMilestone {
  /** "On signature", "Design sign-off", "Go-live". */
  trigger: string;
  /** "40%", "GHS 14,000" — whichever way the deal was actually struck. */
  share: string;
  amount?: string | null;
}

export interface ContractClause {
  heading: string;
  /** Each entry is a paragraph. Placeholders below are substituted at render. */
  paragraphs: string[];
  /** Bullets under the paragraphs, for obligations and exclusions. */
  bullets?: string[];
}

export interface ContractPdfData {
  /** "Website build and care plan" — what this agreement is about, in the title. */
  title: string;
  /** The agreement's own reference, e.g. "DW-MSA-2026-014". */
  reference: string;
  agreementDate: Date;
  /** When work starts, if that isn't the signature date. */
  startDate?: Date | null;
  /** The initial term in plain words: "12 months", "until go-live". */
  term: string;
  /** How much notice either side gives. Printed in the key terms panel. */
  noticePeriod: string;

  provider?: ContractParty | null;
  client: ContractParty;

  currency: string;
  /** What is being bought, one line per deliverable, for Schedule 1. */
  deliverables: string[];
  /** What is explicitly not included — the clause that prevents most disputes. */
  exclusions?: string[];
  fees: ContractFeeLine[];
  paymentSchedule?: ContractMilestone[];
  /** "Net 14 days from invoice." Printed under the fee table. */
  paymentTerms?: string | null;

  /** Replaces DEFAULT_CLAUSES wholesale when a client's own terms are used. */
  clauses?: ContractClause[];
  /** Anything agreed that isn't in the standard terms. Printed as clause 16. */
  specialConditions?: string[];
  governingLaw?: string | null;
}

// ---------------------------------------------------------------------------
// The terms themselves
// ---------------------------------------------------------------------------

/**
 * `{{provider}}`, `{{client}}`, `{{law}}` and `{{notice}}` are filled in from
 * the data at render time, so the same wording serves every client without
 * anyone editing prose per deal — which is exactly how a wrong client name
 * ends up in clause 9 of a signed contract.
 */
export const DEFAULT_CLAUSES: ContractClause[] = [
  {
    heading: "What we will do",
    paragraphs: [
      "{{provider}} will provide the services described in Schedule 1, with reasonable skill and care, and to the standard a competent provider of the same services would meet.",
      "Anything not listed in Schedule 1 is outside this agreement. Where {{client}} asks for work outside it, clause 5 applies.",
    ],
  },
  {
    heading: "When we will do it",
    paragraphs: [
      "Work begins on the start date shown overleaf, once the deposit in Schedule 2 has been received and {{client}} has provided the access and materials described in clause 4.",
      "Dates given for delivery are worked to in good faith. Where a date slips because material, access or an approval was not provided when asked for, the timeline moves by the same period and no fee is refundable on that account.",
    ],
  },
  {
    heading: "Fees and payment",
    paragraphs: [
      "{{client}} will pay the fees set out in Schedule 2. Fees are exclusive of any tax, levy or bank charge, which {{client}} pays in addition where it applies.",
      "Invoices are payable within the period stated on the invoice. Recurring fees are invoiced in advance of the period they cover.",
      "Where an invoice is more than fourteen days late, {{provider}} may suspend the services on seven days' written notice, and may charge interest at 2% per month on the overdue amount. Services resume once the account is settled.",
      "Third-party costs paid on {{client}}'s behalf — hosting, domains, licences, paid tools — are recharged at cost and are payable whether or not the rest of the agreement continues.",
    ],
  },
  {
    heading: "What we need from you",
    paragraphs: [
      "{{client}} will give {{provider}} what the work needs, when it is asked for. In particular:",
    ],
    bullets: [
      "A single named contact with authority to approve work and sign off milestones.",
      "Access to the systems, accounts, domains and hosting the work touches, and the authority to use them.",
      "Content, copy, images, logins and any other material the work depends on.",
      "Decisions and approvals within five working days of being asked, unless another period is agreed in writing.",
      "Accurate information. {{provider}} is not responsible for a result that is wrong because the information it was given was wrong.",
    ],
  },
  {
    heading: "Changes to the work",
    paragraphs: [
      "Either side may ask for a change to what is being delivered. A change is only agreed once it has been recorded in writing — email is enough — together with what it does to the fee and the timeline.",
      "{{provider}} will not begin chargeable work outside Schedule 1 until that record exists, and {{client}} is not liable for work outside Schedule 1 that it did not agree to.",
    ],
  },
  {
    heading: "Term and ending this agreement",
    paragraphs: [
      "This agreement runs for the initial term shown overleaf. Where it covers a recurring service, it continues after that term until either side ends it by giving the other written notice of {{notice}}.",
      "Either side may end this agreement immediately, in writing, if the other commits a material breach that it has not put right within thirty days of being asked to, or becomes insolvent.",
      "On ending, {{client}} pays for all work done and all committed third-party costs up to the end date. {{provider}} will hand over the work completed to that point, in the formats reasonably available, once those amounts are settled.",
    ],
  },
  {
    heading: "Who owns the work",
    paragraphs: [
      "Once {{client}} has paid in full, {{client}} owns the deliverables made specifically for it under this agreement — the designs, the written content, the configuration and the custom code.",
      "{{provider}} keeps ownership of everything it brought to the work or built for general use: its tooling, libraries, templates, internal processes and know-how. {{client}} gets a perpetual, non-exclusive licence to use those things as part of the deliverables.",
      "Third-party components — themes, plugins, fonts, stock imagery, hosted services — stay with their owners and are used under their own licences, which {{client}} is responsible for maintaining after handover.",
      "{{provider}} may describe the work and show it in its portfolio and case studies, unless {{client}} asks in writing that it does not.",
    ],
  },
  {
    heading: "Confidentiality",
    paragraphs: [
      "Each side will keep the other's confidential information to itself, use it only for this agreement, and protect it as carefully as it protects its own. This survives the agreement ending by three years.",
      "It does not apply to information that is already public, was already known, is developed independently, or has to be disclosed by law.",
    ],
  },
  {
    heading: "Data protection and security",
    paragraphs: [
      "Where {{provider}} handles personal data on {{client}}'s behalf, it does so on {{client}}'s documented instructions and in line with the Data Protection Act, 2012 (Act 843).",
      "{{provider}} will keep appropriate technical and organisational measures in place, restrict access to staff who need it, and tell {{client}} without undue delay — and in any case within seventy-two hours — of any breach affecting {{client}}'s data.",
      "{{client}} remains responsible for the lawfulness of the data it asks {{provider}} to process, and for the notices and consents that sit behind it.",
    ],
  },
  {
    heading: "Warranty and putting things right",
    paragraphs: [
      "{{provider}} warrants that the deliverables will work materially as described in Schedule 1. For thirty days after each deliverable is accepted, {{provider}} will fix defects in that deliverable at no charge.",
      "That warranty does not cover faults caused by changes made by anyone else, by third-party services failing, by hosting {{provider}} does not manage, or by {{client}} using the deliverable in a way it was not built for.",
      "Beyond this, and to the extent the law allows, no other warranty is given.",
    ],
  },
  {
    heading: "Limits on liability",
    paragraphs: [
      "Neither side limits its liability for death or personal injury caused by negligence, for fraud, or for anything else the law does not allow to be limited.",
      "Otherwise, neither side is liable for loss of profit, loss of business, loss of anticipated savings, or any indirect or consequential loss.",
      "Each side's total liability under this agreement is capped at the fees paid, or payable, in the twelve months before the claim arose.",
      "{{provider}} is not liable for a failure in a third-party service it does not control, though it will use reasonable efforts to work around one.",
    ],
  },
  {
    heading: "Staff and independence",
    paragraphs: [
      "{{provider}} works as an independent contractor. Nothing here creates employment, partnership or agency between the parties, and {{provider}} decides how the work is done and who does it.",
      "{{provider}} may use subcontractors, and remains responsible for their work as if it were its own.",
      "Neither side will directly employ or engage the other's staff who worked on this agreement, during it and for six months after, without written consent.",
    ],
  },
  {
    heading: "Things outside anyone's control",
    paragraphs: [
      "Neither side is in breach because of something genuinely outside its control — power or network failure at national scale, natural disaster, civil unrest, government action. The affected side will say so promptly and do what it reasonably can to limit the effect.",
      "Where such an event continues for more than sixty days, either side may end this agreement in writing without further liability, save for amounts already due.",
    ],
  },
  {
    heading: "Notices",
    paragraphs: [
      "Formal notices under this agreement are given in writing to the email addresses shown overleaf, and are treated as received on the next working day. A change of address takes effect once the other side has been told.",
    ],
  },
  {
    heading: "Governing law",
    paragraphs: [
      "This agreement is governed by {{law}}, and the parties submit to the exclusive jurisdiction of its courts.",
      "Before either side starts proceedings, both will spend thirty days genuinely trying to settle the matter between them, starting with a meeting of the people named overleaf.",
    ],
  },
  {
    heading: "The whole agreement",
    paragraphs: [
      "This agreement, with its schedules, is the whole of what has been agreed, and replaces anything said or written beforehand — including any proposal, save where a proposal is expressly incorporated into Schedule 1.",
      "A change to this agreement is only effective once both sides have agreed it in writing. A right not enforced is not a right given up. If any clause is held unenforceable, the rest stands.",
    ],
  },
];

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

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

function longDate(date: Date): string {
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

function amountText(currency: string, value: string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return `${currency} ${value}`;
  return `${currency} ${n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** The document's own title block, matching the proposal and the invoice. */
function header(doc: PDFDoc, kicker: string, title: string) {
  doc.fillColor(ACCENT).font("Helvetica-Bold").fontSize(8).text(kicker.toUpperCase(), { characterSpacing: 1.6 });
  doc.moveDown(0.45);
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(19).text(title, { lineGap: 2 });
  doc.moveDown(0.5);
  doc.strokeColor(ACCENT).lineWidth(1.6).moveTo(MARGIN_X, doc.y).lineTo(MARGIN_X + 46, doc.y).stroke();
  doc.moveDown(1.1);
}

/**
 * A numbered clause heading. `needs` is the room the first paragraph under it
 * wants: check the heading alone and it fits, then the paragraph takes its own
 * break and the heading is stranded at the foot of the page.
 */
function clauseHeading(doc: PDFDoc, number: number, text: string, needs = 74) {
  if (doc.y + needs > CONTENT_LIMIT) doc.addPage();
  doc.moveDown(0.9);
  const y = doc.y;
  doc.fillColor(ACCENT).font("Helvetica-Bold").fontSize(9.5).text(`${number}.`, MARGIN_X, y, { width: 20 });
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(9.5).text(text.toUpperCase(), MARGIN_X + 20, y, {
    width: CONTENT_W - 20,
    characterSpacing: 1.1,
  });
  doc.x = MARGIN_X;
  doc.moveDown(0.5);
}

/** Clause body text, indented to sit under the heading rather than the number. */
function clauseText(doc: PDFDoc, text: string) {
  if (doc.y + 30 > CONTENT_LIMIT) doc.addPage();
  doc.fillColor(MUTED).font("Helvetica").fontSize(9).text(text, MARGIN_X + 20, doc.y, {
    width: CONTENT_W - 20,
    align: "left",
    lineGap: 2.2,
  });
  doc.x = MARGIN_X;
  doc.moveDown(0.45);
}

function bulletLine(doc: PDFDoc, text: string, indent = 20) {
  if (doc.y + 26 > CONTENT_LIMIT) doc.addPage();
  const y = doc.y;
  doc.fillColor(ACCENT).font("Helvetica-Bold").fontSize(9).text("·", MARGIN_X + indent, y, { width: 10 });
  doc.fillColor(MUTED).font("Helvetica").fontSize(9).text(text, MARGIN_X + indent + 12, y, {
    width: CONTENT_W - indent - 12,
    lineGap: 2,
  });
  doc.x = MARGIN_X;
  doc.moveDown(0.3);
}

/** A schedule heading: bigger than a clause, with the accent rule under it. */
function scheduleHeading(doc: PDFDoc, label: string, title: string) {
  if (doc.y + 130 > CONTENT_LIMIT) doc.addPage();
  doc.moveDown(1.2);
  doc.fillColor(ACCENT).font("Helvetica-Bold").fontSize(7.5).text(label.toUpperCase(), MARGIN_X, doc.y, {
    characterSpacing: 1.6,
  });
  doc.moveDown(0.3);
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(13).text(title, MARGIN_X, doc.y);
  doc.moveDown(0.4);
  doc.strokeColor(ACCENT).lineWidth(1.4).moveTo(MARGIN_X, doc.y).lineTo(MARGIN_X + 46, doc.y).stroke();
  doc.moveDown(0.9);
}

// ---------------------------------------------------------------------------
// The blocks that make the agreement readable
// ---------------------------------------------------------------------------

/**
 * The key terms panel: the commercial deal on one page, before the clauses.
 *
 * A row is a label on the left and the term on the right, on a cream ground
 * with the lime edge the invoice's payment panel uses — the two documents are
 * from the same company, and a client sees both.
 */
function keyTerms(doc: PDFDoc, rows: [string, string][]) {
  const labelX = MARGIN_X + 20;
  const labelWidth = 118;
  const valueX = labelX + labelWidth + 14;
  const valueWidth = CONTENT_W - 40 - labelWidth - 14;

  // Measure off-page first: the panel has to be painted under the text.
  const startY = doc.y;
  const measureY = PAGE_H * 4;
  let cursor = measureY;
  for (const [, value] of rows) {
    doc.font("Helvetica-Bold").fontSize(9);
    const h = doc.heightOfString(value, { width: valueWidth, lineGap: 1.5 });
    cursor += Math.max(h, 11) + 8;
  }
  const height = cursor - measureY + 24;

  if (startY + height > CONTENT_LIMIT) doc.addPage();
  const top = doc.y;

  doc.save();
  doc.fillColor(CREAM).roundedRect(MARGIN_X, top, CONTENT_W, height, 5).fill();
  doc.fillColor(MARK).rect(MARGIN_X, top + 5, 3.5, height - 10).fill();
  doc.restore();

  let y = top + 14;
  rows.forEach(([label, value], index) => {
    if (index > 0) {
      doc.save();
      doc.strokeColor(LINE).lineWidth(0.6).moveTo(labelX, y - 5).lineTo(RIGHT_EDGE - 20, y - 5).stroke();
      doc.restore();
    }
    doc.fillColor(MUTED).font("Helvetica-Bold").fontSize(6.8).text(label.toUpperCase(), labelX, y + 1.5, {
      width: labelWidth,
      characterSpacing: 1.1,
    });
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(9).text(value, valueX, y, { width: valueWidth, lineGap: 1.5 });
    y = Math.max(doc.y, y + 11) + 8;
  });

  doc.x = MARGIN_X;
  doc.y = top + height + 18;
}

/** One party's block, for the two-column "between" section. */
function partyBlock(doc: PDFDoc, party: ContractParty, x: number, y: number, width: number): number {
  doc.fillColor(ACCENT_DEEP).font("Helvetica-Bold").fontSize(6.8).text(party.shortName.toUpperCase(), x, y, {
    width,
    characterSpacing: 1.2,
  });
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(10.5).text(party.legalName, x, y + 11, { width, lineGap: 1 });

  const lines = [
    party.registrationNumber ? `Reg. ${party.registrationNumber}` : null,
    ...(party.addressLines ?? []),
    party.email,
    party.phone,
  ].filter((line): line is string => Boolean(line));

  if (lines.length) {
    doc.fillColor(MUTED).font("Helvetica").fontSize(8.5).text(lines.join("\n"), x, doc.y + 3, { width, lineGap: 2 });
  }
  return doc.y;
}

/** The fee table in Schedule 2 — same column discipline as the invoice. */
function feeTable(doc: PDFDoc, fees: ContractFeeLine[], currency: string) {
  const amountWidth = 130;
  const amountX = RIGHT_EDGE - amountWidth;
  const descWidth = CONTENT_W - amountWidth - 20;

  const headY = doc.y;
  doc.fillColor(MUTED).font("Helvetica-Bold").fontSize(6.8);
  doc.text("ITEM", MARGIN_X, headY, { characterSpacing: 1.1 });
  doc.text("FEE", amountX, headY, { width: amountWidth, align: "right", characterSpacing: 1.1 });
  doc.x = MARGIN_X;
  doc.y = headY + 12;
  doc.strokeColor(INK).lineWidth(1).moveTo(MARGIN_X, doc.y).lineTo(RIGHT_EDGE, doc.y).stroke();
  doc.y += 9;

  let oneOff = 0;
  let monthly = 0;

  for (const fee of fees) {
    if (doc.y + 44 > CONTENT_LIMIT) doc.addPage();
    const y = doc.y;
    doc.fillColor(INK).font("Helvetica").fontSize(9.5).text(fee.description, MARGIN_X, y, {
      width: descWidth,
      lineGap: 1,
    });
    if (fee.detail) {
      doc.fillColor(MUTED).font("Helvetica").fontSize(8).text(fee.detail, MARGIN_X, doc.y + 1.5, {
        width: descWidth,
        lineGap: 1,
      });
    }
    const rowEnd = doc.y;

    const suffix = fee.billing === "MONTHLY" ? " / month" : "";
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(9.5).text(`${amountText(currency, fee.amount)}${suffix}`, amountX, y, {
      width: amountWidth,
      align: "right",
    });

    const n = Number(fee.amount);
    if (Number.isFinite(n)) {
      if (fee.billing === "MONTHLY") monthly += n;
      else oneOff += n;
    }

    doc.x = MARGIN_X;
    doc.y = Math.max(rowEnd, y + 13) + 7;
    doc.strokeColor(LINE).lineWidth(0.6).moveTo(MARGIN_X, doc.y).lineTo(RIGHT_EDGE, doc.y).stroke();
    doc.y += 8;
  }

  // The summary is the number the whole schedule exists to state. Reserved as
  // one block: drawn line by line it can land its label on one page and its
  // amount past the bottom of it, where PDFKit writes it nowhere at all.
  const summaryHeight = (oneOff > 0 ? 17 : 0) + (monthly > 0 ? 17 : 0) + 16;
  if (doc.y + summaryHeight > CONTENT_LIMIT) doc.addPage();

  doc.y += 2;
  if (oneOff > 0) {
    const y = doc.y;
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(10).text("Total, one-off", MARGIN_X, y);
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(11).text(amountText(currency, oneOff.toFixed(2)), amountX, y - 1, {
      width: amountWidth,
      align: "right",
    });
    doc.x = MARGIN_X;
    doc.y = y + 17;
  }
  if (monthly > 0) {
    const y = doc.y;
    doc.fillColor(MUTED).font("Helvetica").fontSize(10).text("Then, each month", MARGIN_X, y);
    doc
      .fillColor(INK)
      .font("Helvetica-Bold")
      .fontSize(11)
      .text(`${amountText(currency, monthly.toFixed(2))} / month`, amountX, y - 1, {
        width: amountWidth,
        align: "right",
      });
    doc.x = MARGIN_X;
    doc.y = y + 17;
  }

  doc.strokeColor(ACCENT).lineWidth(1.6).moveTo(amountX, doc.y).lineTo(RIGHT_EDGE, doc.y).stroke();
  doc.y += 14;
}

function scheduleTable(doc: PDFDoc, milestones: ContractMilestone[], currency: string) {
  const shareX = RIGHT_EDGE - 200;
  const amountX = RIGHT_EDGE - 130;

  // A column head alone at the foot of a page labels nothing.
  if (doc.y + 55 > CONTENT_LIMIT) doc.addPage();
  const headY = doc.y;
  doc.fillColor(MUTED).font("Helvetica-Bold").fontSize(6.8);
  doc.text("PAYABLE ON", MARGIN_X, headY, { characterSpacing: 1.1 });
  doc.text("SHARE", shareX, headY, { width: 62, align: "right", characterSpacing: 1.1 });
  doc.text("AMOUNT", amountX, headY, { width: 130, align: "right", characterSpacing: 1.1 });
  doc.x = MARGIN_X;
  doc.y = headY + 12;
  doc.strokeColor(INK).lineWidth(1).moveTo(MARGIN_X, doc.y).lineTo(RIGHT_EDGE, doc.y).stroke();
  doc.y += 9;

  for (const step of milestones) {
    if (doc.y + 34 > CONTENT_LIMIT) doc.addPage();
    const y = doc.y;
    doc.fillColor(INK).font("Helvetica").fontSize(9.5).text(step.trigger, MARGIN_X, y, { width: 280, lineGap: 1 });
    const rowEnd = doc.y;
    doc.fillColor(MUTED).font("Helvetica").fontSize(9.5).text(step.share, shareX, y, { width: 62, align: "right" });
    if (step.amount) {
      doc.fillColor(INK).font("Helvetica-Bold").fontSize(9.5).text(amountText(currency, step.amount), amountX, y, {
        width: 130,
        align: "right",
      });
    }
    doc.x = MARGIN_X;
    doc.y = Math.max(rowEnd, y + 13) + 7;
    doc.strokeColor(LINE).lineWidth(0.6).moveTo(MARGIN_X, doc.y).lineTo(RIGHT_EDGE, doc.y).stroke();
    doc.y += 8;
  }
}

/**
 * The signature blocks.
 *
 * Kept whole: a signature panel split across a page break is the one layout
 * fault on a contract that actually causes a problem, because it produces a
 * page with a line to sign and no idea what is being signed. If both blocks
 * plus their heading will not fit, they go on a fresh page together.
 */
/**
 * The four fields, and the room each needs.
 *
 * They are not the same height: a signature and a hand-written date need space
 * to write in, a pre-printed name and title need only their own line. A block
 * of four equal rows gives the signature 17pt, which is not enough to sign in
 * and is the sort of thing nobody notices until a client tries.
 */
const SIGNATURE_FIELDS: { label: string; height: number }[] = [
  { label: "Signature", height: 50 },
  { label: "Name", height: 32 },
  { label: "Title", height: 32 },
  { label: "Date", height: 40 },
];
const SIGNATURE_STACK = SIGNATURE_FIELDS.reduce((sum, field) => sum + field.height, 0);

function signatureBlocks(doc: PDFDoc, provider: ContractParty, client: ContractParty, agreementDate: Date) {
  const blockHeight = 34 + SIGNATURE_STACK;
  if (doc.y + blockHeight + 70 > CONTENT_LIMIT) doc.addPage();

  doc.moveDown(1.2);
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(9.5).text("AGREED AND SIGNED", MARGIN_X, doc.y, {
    characterSpacing: 1.1,
  });
  doc.moveDown(0.4);
  doc.fillColor(MUTED).font("Helvetica").fontSize(8.5).text(
    `Signed by the persons named below, each confirming they are authorised to bind their party, on or about ${longDate(agreementDate)}.`,
    MARGIN_X,
    doc.y,
    { width: CONTENT_W, lineGap: 1.5 },
  );
  doc.moveDown(1.1);

  const top = doc.y;
  const colWidth = (CONTENT_W - 34) / 2;
  const columns: [ContractParty, number][] = [
    [provider, MARGIN_X],
    [client, MARGIN_X + colWidth + 34],
  ];

  for (const [party, x] of columns) {
    doc.fillColor(ACCENT_DEEP).font("Helvetica-Bold").fontSize(6.8).text(`FOR ${party.shortName.toUpperCase()}`, x, top, {
      width: colWidth,
      characterSpacing: 1.2,
    });
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(9.5).text(party.legalName, x, top + 12, { width: colWidth });

    // Each field is a label, the value where there is one, and the rule that
    // closes it — in that order, so a pre-printed name reads as belonging to
    // the line under it rather than to the field above.
    let fieldY = top + 34;
    const values: Record<string, string> = {
      Name: party.signatory?.name ?? "",
      Title: party.signatory?.title ?? "",
    };

    for (const { label, height } of SIGNATURE_FIELDS) {
      doc.fillColor(MUTED).font("Helvetica-Bold").fontSize(6.8).text(label.toUpperCase(), x, fieldY, {
        width: colWidth,
        characterSpacing: 1.1,
      });
      const value = values[label];
      if (value) {
        doc.fillColor(INK).font("Helvetica").fontSize(9.5).text(value, x, fieldY + 12, { width: colWidth });
      }
      const ruleY = fieldY + height - 8;
      doc.strokeColor(LINE).lineWidth(0.8).moveTo(x, ruleY).lineTo(x + colWidth, ruleY).stroke();
      fieldY += height;
    }
  }

  doc.x = MARGIN_X;
  doc.y = top + 34 + SIGNATURE_STACK;
}

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

/** The provider, when the caller didn't name one: the company's own profile. */
function providerFromProfile(profile: CompanyProfile): ContractParty {
  return {
    legalName: profile.legalName || profile.displayName,
    shortName: "The Provider",
    registrationNumber: profile.registrationNumber || null,
    addressLines: profile.addressLines?.length ? profile.addressLines : [profile.location],
    email: profile.email,
    phone: profile.phone,
    signatory: { name: "Dan Kwame Ayipah", title: "Founder" },
  };
}

function fill(text: string, tokens: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (whole, key: string) => tokens[key] ?? whole);
}

export async function renderContractPdf(data: ContractPdfData): Promise<Buffer> {
  const identity = await letterheadIdentity();
  const profile = await companyProfile();
  const doc = newDoc(identity);

  const provider = data.provider ?? providerFromProfile(profile);
  const client = data.client;
  const law = data.governingLaw ?? "the laws of the Republic of Ghana";
  const tokens = {
    provider: provider.legalName,
    client: client.legalName,
    law,
    notice: data.noticePeriod,
    currency: data.currency,
  };

  header(doc, "Service Agreement", data.title);

  doc.fillColor(MUTED).font("Helvetica").fontSize(9).text(
    `Reference ${data.reference}  ·  Dated ${longDate(data.agreementDate)}`,
    MARGIN_X,
    doc.y,
    { width: CONTENT_W },
  );
  doc.moveDown(1.2);

  // --- Between whom -------------------------------------------------------
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(9.5).text("BETWEEN", MARGIN_X, doc.y, { characterSpacing: 1.1 });
  doc.moveDown(0.6);

  const partiesTop = doc.y;
  const colWidth = (CONTENT_W - 34) / 2;
  const providerEnd = partyBlock(doc, provider, MARGIN_X, partiesTop, colWidth);
  const clientEnd = partyBlock(doc, client, MARGIN_X + colWidth + 34, partiesTop, colWidth);
  doc.x = MARGIN_X;
  doc.y = Math.max(providerEnd, clientEnd) + 18;

  // --- The deal, before the terms -----------------------------------------
  const oneOff = data.fees.filter((f) => f.billing === "ONE_OFF").reduce((sum, f) => sum + (Number(f.amount) || 0), 0);
  const monthly = data.fees.filter((f) => f.billing === "MONTHLY").reduce((sum, f) => sum + (Number(f.amount) || 0), 0);
  const feeSummary = [
    oneOff > 0 ? amountText(data.currency, oneOff.toFixed(2)) : null,
    monthly > 0 ? `${amountText(data.currency, monthly.toFixed(2))} per month` : null,
  ]
    .filter(Boolean)
    .join(", then ");

  const rows: [string, string][] = [
    ["Services", data.title],
    ["Start date", data.startDate ? longDate(data.startDate) : "On signature and receipt of the deposit"],
    ["Initial term", data.term],
    ["Fees", feeSummary || "As set out in Schedule 2"],
  ];
  if (data.paymentTerms) rows.push(["Payment", data.paymentTerms]);
  rows.push(["Notice to end", data.noticePeriod]);
  rows.push(["Governing law", law.charAt(0).toUpperCase() + law.slice(1)]);

  keyTerms(doc, rows);

  doc.fillColor(MUTED).font("Helvetica-Oblique").fontSize(8).text(
    "The panel above is a summary for convenience. Where it and the clauses differ, the clauses and schedules govern.",
    MARGIN_X,
    doc.y,
    { width: CONTENT_W, lineGap: 1.5 },
  );
  doc.moveDown(0.9);

  // --- The terms ----------------------------------------------------------
  const clauses = data.clauses ?? DEFAULT_CLAUSES;
  clauses.forEach((clause, index) => {
    clauseHeading(doc, index + 1, clause.heading);
    for (const paragraph of clause.paragraphs) clauseText(doc, fill(paragraph, tokens));
    for (const bullet of clause.bullets ?? []) bulletLine(doc, fill(bullet, tokens));
  });

  if (data.specialConditions?.length) {
    clauseHeading(doc, clauses.length + 1, "Special conditions");
    clauseText(doc, "The following are agreed for this engagement, and take precedence over the clauses above where they conflict.");
    for (const condition of data.specialConditions) bulletLine(doc, fill(condition, tokens));
  }

  // --- Signatures ---------------------------------------------------------
  signatureBlocks(doc, provider, client, data.agreementDate);

  // --- Schedule 1: what is being bought -----------------------------------
  doc.addPage();
  scheduleHeading(doc, "Schedule 1", "Scope of work");
  doc.fillColor(MUTED).font("Helvetica").fontSize(9).text(
    `${provider.legalName} will deliver the following to ${client.legalName}.`,
    MARGIN_X,
    doc.y,
    { width: CONTENT_W, lineGap: 2 },
  );
  doc.moveDown(0.7);
  for (const item of data.deliverables) bulletLine(doc, item, 0);

  if (data.exclusions?.length) {
    doc.moveDown(1);
    if (doc.y + 90 > CONTENT_LIMIT) doc.addPage();
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(9.5).text("NOT INCLUDED", MARGIN_X, doc.y, {
      characterSpacing: 1.1,
    });
    doc.moveDown(0.4);
    doc.fillColor(MUTED).font("Helvetica").fontSize(9).text(
      "These are outside this agreement. Any of them can be added under clause 5.",
      MARGIN_X,
      doc.y,
      { width: CONTENT_W, lineGap: 2 },
    );
    doc.moveDown(0.6);
    for (const item of data.exclusions) bulletLine(doc, item, 0);
  }

  // --- Schedule 2: what it costs ------------------------------------------
  scheduleHeading(doc, "Schedule 2", "Fees and payment");
  feeTable(doc, data.fees, data.currency);

  if (data.paymentSchedule?.length) {
    doc.moveDown(0.6);
    if (doc.y + 120 > CONTENT_LIMIT) doc.addPage();
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(9.5).text("WHEN IT IS PAYABLE", MARGIN_X, doc.y, {
      characterSpacing: 1.1,
    });
    doc.moveDown(0.6);
    scheduleTable(doc, data.paymentSchedule, data.currency);
  }

  if (data.paymentTerms) {
    doc.moveDown(0.5);
    doc.fillColor(MUTED).font("Helvetica").fontSize(9).text(data.paymentTerms, MARGIN_X, doc.y, {
      width: CONTENT_W,
      lineGap: 2,
    });
  }

  doc.moveDown(0.8);
  doc.fillColor(MUTED).font("Helvetica-Oblique").fontSize(8).text(
    `Invoices are issued by ${provider.legalName} and are payable to the account shown on each invoice. Recurring fees may be reviewed once in any twelve-month period, on written notice of ${data.noticePeriod}.`,
    MARGIN_X,
    doc.y,
    { width: CONTENT_W, lineGap: 1.5 },
  );

  return collectBuffer(doc);
}
