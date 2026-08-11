import PDFDocument from "pdfkit";

type PDFDoc = InstanceType<typeof PDFDocument>;

const INK = "#0B0B0C";
const GOLD = "#C7A24C";
const SLATE = "#6E6A63";

function newDoc(): PDFDoc {
  return new PDFDocument({ size: "A4", margin: 56 });
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
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(20).text("Dakyworld", { continued: false });
  doc.fillColor(SLATE).font("Helvetica").fontSize(9).text(kicker.toUpperCase());
  doc.moveDown(1);
  doc.strokeColor(GOLD).lineWidth(2).moveTo(56, doc.y).lineTo(539, doc.y).stroke();
  doc.moveDown(1);
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(16).text(title);
  doc.moveDown(1);
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

function sectionTitle(doc: PDFDoc, text: string) {
  // A section heading stranded at the foot of a page is the one layout fault
  // that makes a proposal look automatically generated.
  if (doc.y > 690) doc.addPage();
  doc.moveDown(0.9);
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(11).text(text.toUpperCase(), { characterSpacing: 0.8 });
  doc.moveDown(0.35);
}

function paragraph(doc: PDFDoc, text: string, size = 10) {
  doc.fillColor(SLATE).font("Helvetica").fontSize(size).text(text, { align: "left", lineGap: 2 });
}

function money(currency: string, amount: number): string {
  return `${currency} ${amount.toLocaleString("en-GB", { maximumFractionDigits: 0 })}`;
}

export async function renderProposalPdf(data: ProposalPdfData): Promise<Buffer> {
  const doc = newDoc();
  header(doc, "Service Proposal", data.title);

  doc.fillColor(SLATE).font("Helvetica").fontSize(10).text(`Prepared for: ${data.clientName}`);
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
        if (doc.y > 700) doc.addPage();
        doc.fillColor(INK).font("Helvetica-Bold").fontSize(10).text(finding.observed, { lineGap: 1.5 });
        doc.fillColor(SLATE).font("Helvetica").fontSize(9).text(finding.costsThem, { lineGap: 1.5 });
        doc.fillColor(SLATE).font("Helvetica-Oblique").fontSize(8).text(`Checked: ${finding.evidence}`);
        doc.fillColor(INK).font("Helvetica").fontSize(9).text(`What we would do: ${finding.fix}`, { lineGap: 1.5 });
        doc.moveDown(0.7);
      }
    }

    if (body.scope.length) {
      sectionTitle(doc, "What you get");
      for (const phase of body.scope) {
        if (doc.y > 690) doc.addPage();
        doc.fillColor(INK).font("Helvetica-Bold").fontSize(10).text(phase.phase);
        for (const item of phase.deliverables) {
          doc.fillColor(SLATE).font("Helvetica").fontSize(9).text(`·  ${item}`, { indent: 8, lineGap: 1 });
        }
        doc.fillColor(SLATE).font("Helvetica-Oblique").fontSize(9).text(phase.outcome, { lineGap: 1.5 });
        doc.moveDown(0.6);
      }
    }

    sectionTitle(doc, "Investment");
    for (const item of body.investment.lineItems) {
      const y = doc.y;
      doc.fillColor(SLATE).font("Helvetica").fontSize(9.5).text(item.description, 56, y, { width: 340 });
      const price = item.amount > 0
        ? `${money(data.currency, item.amount)}${item.billing === "MONTHLY" ? "/mo" : ""}`
        : "after the call";
      doc.fillColor(item.amount > 0 ? INK : SLATE).font("Helvetica").fontSize(9.5).text(price, 410, y, { width: 129, align: "right" });
      doc.moveDown(0.35);
    }
    doc.moveDown(0.3);
    doc.strokeColor("#E5E2DB").lineWidth(1).moveTo(56, doc.y).lineTo(539, doc.y).stroke();
    doc.moveDown(0.5);

    const totalY = doc.y;
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(11).text("Total", 56, totalY);
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(11).text(money(data.currency, body.investment.total), 410, totalY, {
      width: 129,
      align: "right",
    });
    doc.moveDown(0.4);
    if (body.investment.recurring > 0) {
      const monthlyY = doc.y;
      doc.fillColor(SLATE).font("Helvetica").fontSize(9.5).text("Then, monthly", 56, monthlyY);
      doc.fillColor(SLATE).font("Helvetica").fontSize(9.5).text(`${money(data.currency, body.investment.recurring)}/mo`, 410, monthlyY, {
        width: 129,
        align: "right",
      });
      doc.moveDown(0.4);
    }
    doc.fillColor(SLATE).font("Helvetica-Oblique").fontSize(8.5).text(body.investment.basis, 56, doc.y, { width: 483, lineGap: 1 });

    sectionTitle(doc, "Timeline");
    paragraph(doc, body.timeline);

    sectionTitle(doc, "Why Dakyworld");
    paragraph(doc, body.whyUs);

    if (body.assumptions.length) {
      sectionTitle(doc, "What this assumes");
      for (const assumption of body.assumptions) {
        doc.fillColor(SLATE).font("Helvetica").fontSize(9).text(`·  ${assumption}`, { indent: 8, lineGap: 1 });
      }
    }

    sectionTitle(doc, "Next step");
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(10.5).text(body.nextStep, { lineGap: 2 });
  }

  doc.moveDown(0.8);
  if (data.expiresAt) {
    doc.fillColor(SLATE).font("Helvetica").fontSize(9).text(`This proposal holds until ${data.expiresAt.toDateString()}.`);
  }

  doc.moveDown(1.2);
  doc.fillColor(SLATE).font("Helvetica-Oblique").fontSize(9).text("hello@dakyworld.com  ·  +233 545 950 611  ·  Kumasi, Ghana");

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

export async function renderInvoicePdf(data: InvoicePdfData): Promise<Buffer> {
  const doc = newDoc();
  header(doc, "Invoice", data.invoiceNumber);

  doc.fillColor(SLATE).font("Helvetica").fontSize(10);
  doc.text(`Bill to: ${data.clientName}`);
  doc.text(`Issue date: ${data.issueDate.toDateString()}`);
  doc.text(`Due date: ${data.dueDate.toDateString()}`);
  doc.moveDown(1.2);

  const colX = { desc: 56, qty: 320, price: 390, amount: 470 };
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(9);
  doc.text("Description", colX.desc, doc.y, { continued: false });
  doc.text("Qty", colX.qty, doc.y - 11.5);
  doc.text("Unit Price", colX.price, doc.y - 11.5);
  doc.text("Amount", colX.amount, doc.y - 11.5);
  doc.moveDown(0.3);
  doc.strokeColor("#E5E2DB").lineWidth(1).moveTo(56, doc.y).lineTo(539, doc.y).stroke();
  doc.moveDown(0.5);

  doc.font("Helvetica").fontSize(9).fillColor(SLATE);
  for (const item of data.lineItems) {
    const y = doc.y;
    doc.text(item.description, colX.desc, y, { width: 250 });
    doc.text(item.quantity, colX.qty, y);
    doc.text(`${data.currency} ${item.unitPrice}`, colX.price, y);
    doc.text(`${data.currency} ${item.amount}`, colX.amount, y);
    doc.moveDown(0.6);
  }

  doc.moveDown(0.5);
  doc.strokeColor("#E5E2DB").lineWidth(1).moveTo(56, doc.y).lineTo(539, doc.y).stroke();
  doc.moveDown(0.5);
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(11).text(`Total Due: ${data.currency} ${data.amountTotal}`, { align: "right" });

  doc.moveDown(2);
  doc.fillColor(SLATE).font("Helvetica-Oblique").fontSize(9).text("hello@dakyworld.com  ·  +233 545 950 611  ·  Kumasi, Ghana");

  return collectBuffer(doc);
}
