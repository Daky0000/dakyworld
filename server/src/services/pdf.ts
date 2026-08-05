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

export interface ProposalPdfData {
  title: string;
  clientName: string;
  serviceType: string;
  scopeSummary: string;
  priceAmount: string;
  currency: string;
  priceTier?: string | null;
  expiresAt?: Date | null;
}

export async function renderProposalPdf(data: ProposalPdfData): Promise<Buffer> {
  const doc = newDoc();
  header(doc, "Service Proposal", data.title);

  doc.fillColor(SLATE).font("Helvetica").fontSize(10).text(`Prepared for: ${data.clientName}`);
  doc.moveDown(1.2);

  doc.fillColor(INK).font("Helvetica-Bold").fontSize(11).text("Service");
  doc.fillColor(SLATE).font("Helvetica").fontSize(10).text(data.serviceType);
  doc.moveDown(0.8);

  doc.fillColor(INK).font("Helvetica-Bold").fontSize(11).text("Scope");
  doc.fillColor(SLATE).font("Helvetica").fontSize(10).text(data.scopeSummary, { align: "left" });
  doc.moveDown(0.8);

  doc.fillColor(INK).font("Helvetica-Bold").fontSize(11).text("Investment");
  doc
    .fillColor(SLATE)
    .font("Helvetica")
    .fontSize(10)
    .text(`${data.currency} ${data.priceAmount}${data.priceTier ? ` — ${data.priceTier}` : ""}`);
  doc.moveDown(0.8);

  if (data.expiresAt) {
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(11).text("Valid Until");
    doc.fillColor(SLATE).font("Helvetica").fontSize(10).text(data.expiresAt.toDateString());
  }

  doc.moveDown(2);
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
