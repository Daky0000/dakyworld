/**
 * Exporting leads.
 *
 * The export is of *what you're looking at*: the same filters the table is
 * showing, through the same column set — including the custom columns an
 * imported sheet brought with it. A spreadsheet that comes back out shaped
 * differently from the one that went in is worse than useless.
 */

import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import type { Lead } from "@prisma/client";
import type { ResolvedField } from "./leadFields.js";

const INK = "#08101F";
const ACCENT = "#3157FF";
const MUTED = "#68738A";
const LINE = "#DFE4EC";

/** One cell's value, whether it's a Lead scalar or a custom column. */
function valueOf(lead: Lead, field: ResolvedField): unknown {
  if (field.builtin) return (lead as unknown as Record<string, unknown>)[field.key];
  const custom = lead.customFields as Record<string, unknown> | null;
  return custom?.[field.key];
}

/** Excel keeps real types where it can; everything else becomes readable text. */
function excelValue(raw: unknown, field: ResolvedField): string | number | Date | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (Array.isArray(raw)) return raw.join(", ");
  if (raw instanceof Date) return raw;
  if (typeof raw === "boolean") return raw ? "Yes" : "No";

  if (field.type === "NUMBER" || field.type === "CURRENCY") {
    const numeric = Number(typeof raw === "object" ? String(raw) : raw);
    if (Number.isFinite(numeric)) return numeric;
  }
  if (field.type === "DATE") {
    const date = new Date(String(raw));
    if (!Number.isNaN(date.getTime())) return date;
  }
  // Prisma Decimals stringify cleanly; objects would otherwise print [object Object].
  return typeof raw === "object" ? String(raw) : String(raw);
}

function textValue(raw: unknown): string {
  if (raw === null || raw === undefined) return "";
  if (Array.isArray(raw)) return raw.join(", ");
  if (raw instanceof Date) return raw.toISOString().slice(0, 10);
  if (typeof raw === "boolean") return raw ? "Yes" : "No";
  return String(raw);
}

export interface ExportGroup {
  name: string;
  fields: ResolvedField[];
  leads: Lead[];
}

// --- Excel -----------------------------------------------------------------

/**
 * One worksheet per group, because that's the point of groups: two batches
 * with different columns can't share a sheet without one of them losing
 * columns. A flat, ungrouped view exports as a single sheet.
 */
export async function renderLeadsXlsx(groups: ExportGroup[], title: string): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Dakyworld OS";
  workbook.created = new Date();

  const used = new Set<string>();
  for (const group of groups) {
    // Excel sheet names: 31 chars, no []:*?/\ — and no duplicates.
    let name = (group.name || "Leads").replace(/[[\]:*?/\\]/g, " ").slice(0, 28).trim() || "Leads";
    let suffix = 2;
    const root = name;
    while (used.has(name.toLowerCase())) name = `${root} ${suffix++}`;
    used.add(name.toLowerCase());

    const sheet = workbook.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
    sheet.columns = group.fields.map((field) => ({
      header: field.label,
      key: field.key,
      width: field.type === "LONG_TEXT" ? 48 : field.type === "EMAIL" || field.type === "URL" ? 30 : 18,
    }));

    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
    headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF08101F" } };
    headerRow.alignment = { vertical: "middle" };
    headerRow.height = 20;

    for (const lead of group.leads) {
      const row: Record<string, string | number | Date | null> = {};
      for (const field of group.fields) row[field.key] = excelValue(valueOf(lead, field), field);
      sheet.addRow(row);
    }

    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: Math.max(1, group.fields.length) } };
  }

  if (!groups.length) workbook.addWorksheet(title.slice(0, 28) || "Leads");

  // ExcelJS returns its own buffer type; it is a Node Buffer underneath.
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

// --- PDF -------------------------------------------------------------------

/**
 * A printable read-out rather than a data file: landscape, the columns that
 * fit, truncated to stay on the page. Anything that needs every character of
 * every cell wants the Excel export.
 */
export async function renderLeadsPdf(groups: ExportGroup[], title: string, subtitle: string): Promise<Buffer> {
  const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 36 });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const usable = right - left;
  const bottom = doc.page.height - doc.page.margins.bottom;

  doc.fillColor(INK).font("Helvetica-Bold").fontSize(18).text("Dakyworld");
  doc.fillColor(MUTED).font("Helvetica").fontSize(8).text(title.toUpperCase());
  doc.moveDown(0.4);
  doc.strokeColor(ACCENT).lineWidth(2).moveTo(left, doc.y).lineTo(right, doc.y).stroke();
  doc.moveDown(0.6);
  doc.fillColor(MUTED).font("Helvetica").fontSize(8).text(subtitle);
  doc.moveDown(0.8);

  for (const group of groups) {
    // A PDF row can only carry so much before it stops being readable.
    const fields = group.fields.slice(0, 8);
    const weights = fields.map((field) => (field.type === "LONG_TEXT" ? 2.2 : field.type === "EMAIL" || field.type === "URL" ? 1.6 : 1));
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0) || 1;
    const widths = weights.map((weight) => (weight / totalWeight) * usable);

    if (doc.y > bottom - 80) doc.addPage();

    doc.fillColor(INK).font("Helvetica-Bold").fontSize(11).text(group.name);
    doc.fillColor(MUTED).font("Helvetica").fontSize(8).text(`${group.leads.length} lead${group.leads.length === 1 ? "" : "s"}`);
    doc.moveDown(0.3);

    const drawHeader = () => {
      const top = doc.y;
      doc.rect(left, top, usable, 16).fill(INK);
      doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(7.5);
      let x = left;
      fields.forEach((field, index) => {
        doc.text(field.label.toUpperCase(), x + 4, top + 5, { width: widths[index] - 8, lineBreak: false, ellipsis: true });
        x += widths[index];
      });
      doc.y = top + 16;
    };

    drawHeader();

    for (const lead of group.leads) {
      if (doc.y > bottom - 18) {
        doc.addPage();
        drawHeader();
      }
      const top = doc.y;
      doc.fillColor(INK).font("Helvetica").fontSize(7.5);
      let x = left;
      fields.forEach((field, index) => {
        doc.text(textValue(valueOf(lead, field)), x + 4, top + 4, { width: widths[index] - 8, lineBreak: false, ellipsis: true });
        x += widths[index];
      });
      doc.y = top + 14;
      doc.strokeColor(LINE).lineWidth(0.5).moveTo(left, doc.y).lineTo(right, doc.y).stroke();
    }

    doc.moveDown(1);
  }

  if (!groups.length) {
    doc.fillColor(MUTED).font("Helvetica").fontSize(10).text("No leads matched these filters.");
  }

  doc.end();
  return done;
}
