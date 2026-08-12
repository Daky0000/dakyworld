import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  HorizontalPositionAlign,
  HorizontalPositionRelativeFrom,
  ImageRun,
  LineRuleType,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TabStopType,
  TextRun,
  VerticalPositionAlign,
  VerticalPositionRelativeFrom,
  WidthType,
} from "docx";
import { ribbon, RIBBON_PT } from "./png.js";
import type { ProposalPdfData } from "./pdf.js";

/**
 * The same proposal, as a Word document on the same letterhead.
 *
 * The PDF is what gets sent; this exists because clients ask for something
 * they can edit, and because a proposal that has to be retyped into Word to be
 * negotiated is a proposal that arrives at the meeting looking like someone
 * else's document.
 *
 * Word builds a letterhead the way a printer does — the identity lives in the
 * page's header and footer, so it repeats on every page for free, and the
 * corner ribbons are floating images anchored to the page behind the text.
 * Everything positional is stated in points and converted here, so the numbers
 * are the ones in services/letterhead.ts rather than a second set that drifts.
 */

// --- Units ----------------------------------------------------------------

/** Word measures page geometry in twentieths of a point. */
const twip = (pt: number) => Math.round(pt * 20);
/** Font sizes are half-points. */
const half = (pt: number) => Math.round(pt * 2);
/** Image sizes are pixels at 96dpi. */
const px = (pt: number) => Math.round((pt * 96) / 72);
/** Border widths are eighths of a point. */
const eighth = (pt: number) => Math.round(pt * 8);

const OBSIDIAN = "0B0B0C";
const GOLD = "C7A24C";
const BRONZE = "8A6A2F";
const SLATE = "6E6A63";
const DIVIDER = "E5E2DB";

const FONT = "Arial";

const COMPANY = {
  name: "DAKYWORLD",
  tagline: "ONE IT COMPANY. EVERYTHING YOUR BUSINESS NEEDS.",
  footerLine: "ONE PARTNER. ALL YOUR IT.",
  location: "Kumasi, Ghana",
  email: "hello@dakyworld.com",
  phone: "+233 545 950 611",
  web: "dakyworld.com",
};

// A4, and the same content area the PDF leaves itself.
const PAGE = { width: twip(595.28), height: twip(841.89) };
const MARGIN = {
  top: twip(168),
  bottom: twip(96),
  left: twip(56),
  right: twip(56),
  header: twip(34),
  footer: twip(30),
};
const CONTENT_W_PT = 595.28 - 56 * 2;

const NO_BORDER = { style: BorderStyle.NONE, size: 0, color: "auto" } as const;
const CELL_BORDERS = { top: NO_BORDER, bottom: NO_BORDER, left: NO_BORDER, right: NO_BORDER };

// --- Small builders --------------------------------------------------------

function text(
  content: string,
  options: {
    size?: number;
    bold?: boolean;
    italics?: boolean;
    color?: string;
    spacing?: number;
  } = {},
) {
  return new TextRun({
    text: content,
    font: FONT,
    size: half(options.size ?? 10),
    bold: options.bold,
    italics: options.italics,
    color: options.color ?? OBSIDIAN,
    // Word's characterSpacing is in twentieths of a point, like everything else.
    characterSpacing: options.spacing === undefined ? undefined : twip(options.spacing),
  });
}

function para(children: TextRun[] | ImageRun[], options: { before?: number; after?: number; align?: (typeof AlignmentType)[keyof typeof AlignmentType] } = {}) {
  return new Paragraph({
    children: children as TextRun[],
    alignment: options.align,
    spacing: { before: twip(options.before ?? 0), after: twip(options.after ?? 0) },
  });
}

function bullet(content: string) {
  return new Paragraph({
    children: [text(`·  ${content}`, { size: 9, color: SLATE })],
    indent: { left: twip(12) },
    spacing: { after: twip(1.5) },
  });
}

/** A section heading: small, uppercase, tracked — the guide's H4. */
function sectionHeading(label: string) {
  return new Paragraph({
    children: [text(label.toUpperCase(), { size: 10.5, bold: true, spacing: 1.4 })],
    spacing: { before: twip(16), after: twip(5) },
    keepNext: true,
  });
}

// --- The letterhead --------------------------------------------------------

function ribbonImage(corner: "top-right" | "bottom-left") {
  return new ImageRun({
    type: "png",
    data: ribbon(corner),
    transformation: { width: px(RIBBON_PT), height: px(RIBBON_PT) },
    floating: {
      horizontalPosition: {
        relative: HorizontalPositionRelativeFrom.PAGE,
        align: corner === "top-right" ? HorizontalPositionAlign.RIGHT : HorizontalPositionAlign.LEFT,
      },
      verticalPosition: {
        relative: VerticalPositionRelativeFrom.PAGE,
        align: corner === "top-right" ? VerticalPositionAlign.TOP : VerticalPositionAlign.BOTTOM,
      },
      behindDocument: true,
      allowOverlap: true,
    },
    altText: { name: "", description: "", title: "" },
  });
}

function letterheadHeader(): Header {
  return new Header({
    children: [
      // Both ribbons hang off one carrier paragraph. In a header they repeat on
      // every page, which is exactly what a letterhead is. The paragraph itself
      // is collapsed to a hairline: the images are anchored to the page and
      // take no space, but the paragraph holding them would otherwise push the
      // wordmark down by a full line.
      new Paragraph({
        children: [ribbonImage("top-right"), ribbonImage("bottom-left")],
        spacing: { before: 0, after: 0, line: 20, lineRule: LineRuleType.EXACT },
      }),

      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        borders: CELL_BORDERS,
        rows: [
          new TableRow({
            children: [
              new TableCell({
                borders: CELL_BORDERS,
                width: { size: 58, type: WidthType.PERCENTAGE },
                children: [
                  new Paragraph({
                    children: [text(COMPANY.name, { size: 21, bold: true, spacing: 1.4 }), text("®", { size: 7, bold: true })],
                    spacing: { after: twip(2) },
                    // The gold rule under the wordmark stands in for the
                    // swoosh the PDF strokes as a curve; Word cannot draw one.
                    border: { bottom: { style: BorderStyle.SINGLE, size: eighth(1.6), color: GOLD, space: 2 } },
                  }),
                  new Paragraph({
                    children: [text(COMPANY.tagline, { size: 5.6, bold: true, color: BRONZE, spacing: 0.85 })],
                    spacing: { before: twip(3) },
                  }),
                ],
              }),
              new TableCell({
                borders: {
                  ...CELL_BORDERS,
                  left: { style: BorderStyle.SINGLE, size: eighth(0.75), color: DIVIDER, space: 8 },
                },
                width: { size: 42, type: WidthType.PERCENTAGE },
                children: [COMPANY.location, COMPANY.email, COMPANY.phone, COMPANY.web].map(
                  (line) =>
                    new Paragraph({
                      children: [text(line, { size: 8.5, color: SLATE })],
                      spacing: { after: twip(2.5) },
                      indent: { left: twip(10) },
                    }),
                ),
              }),
            ],
          }),
        ],
      }),
    ],
  });
}

function letterheadFooter(): Footer {
  return new Footer({
    children: [
      new Paragraph({
        children: [
          text(COMPANY.footerLine, { size: 7.5, bold: true, spacing: 2.1 }),
          new TextRun({ children: [], font: FONT }),
          text("\t", { size: 7.5 }),
          text(COMPANY.web, { size: 8, color: SLATE }),
          text("     f     X     ig     in", { size: 7.5, bold: true, color: SLATE, spacing: 1.2 }),
        ],
        tabStops: [{ type: TabStopType.RIGHT, position: twip(CONTENT_W_PT) }],
        border: { top: { style: BorderStyle.SINGLE, size: eighth(0.75), color: DIVIDER, space: 8 } },
      }),
    ],
  });
}

// --- The document ----------------------------------------------------------

function body(data: ProposalPdfData): Paragraph[] {
  const out: Paragraph[] = [];
  const currency = data.currency;
  const money = (amount: number) => `${currency} ${amount.toLocaleString("en-GB", { maximumFractionDigits: 0 })}`;

  out.push(
    para([text("SERVICE PROPOSAL", { size: 8, bold: true, color: GOLD, spacing: 1.6 })], { after: 3 }),
    new Paragraph({
      children: [text(data.title, { size: 19, bold: true })],
      spacing: { after: twip(6) },
      border: { bottom: { style: BorderStyle.SINGLE, size: eighth(1.6), color: GOLD, space: 6 } },
    }),
    para([text(`Prepared for: ${data.clientName}`, { size: 10, color: SLATE })], { before: 14, after: 10 }),
  );

  const doc = data.body ?? null;

  if (!doc) {
    // A proposal written by hand, before the writer existed.
    out.push(
      sectionHeading("Service"),
      para([text(data.serviceType, { size: 10, color: SLATE })]),
      sectionHeading("Scope"),
      para([text(data.scopeSummary, { size: 10, color: SLATE })]),
      sectionHeading("Investment"),
      para([text(`${currency} ${data.priceAmount}${data.priceTier ? ` — ${data.priceTier}` : ""}`, { size: 10, color: SLATE })]),
    );
    return out;
  }

  out.push(para([text(doc.headline, { size: 13, bold: true })], { after: 10 }));

  out.push(sectionHeading("Where you are"));
  for (const block of doc.situation.split(/\n{2,}/)) {
    out.push(para([text(block.trim(), { size: 10, color: SLATE })], { after: 6 }));
  }

  if (doc.findings.length) {
    out.push(sectionHeading("What we found"));
    for (const finding of doc.findings) {
      out.push(
        new Paragraph({ children: [text(finding.observed, { size: 10, bold: true })], spacing: { after: twip(3) }, keepNext: true }),
        para([text(finding.costsThem, { size: 9, color: SLATE })], { after: 3 }),
        para([text(`Checked: ${finding.evidence}`, { size: 8, italics: true, color: SLATE })], { after: 3 }),
        para([text(`What we would do: ${finding.fix}`, { size: 9 })], { after: 12 }),
      );
    }
  }

  if (doc.scope.length) {
    out.push(sectionHeading("What you get"));
    for (const phase of doc.scope) {
      out.push(new Paragraph({ children: [text(phase.phase, { size: 10, bold: true })], spacing: { after: twip(2) }, keepNext: true }));
      for (const item of phase.deliverables) out.push(bullet(item));
      out.push(para([text(phase.outcome, { size: 9, italics: true, color: SLATE })], { before: 2, after: 10 }));
    }
  }

  out.push(sectionHeading("Investment"));
  return out;
}

/** The investment figures as a real Word table, so they stay aligned when edited. */
function investmentTable(data: ProposalPdfData): Table | null {
  const doc = data.body;
  if (!doc) return null;
  const currency = data.currency;
  const money = (amount: number) => `${currency} ${amount.toLocaleString("en-GB", { maximumFractionDigits: 0 })}`;

  const row = (label: string, amount: string, options: { bold?: boolean; top?: boolean } = {}) =>
    new TableRow({
      children: [
        new TableCell({
          borders: {
            ...CELL_BORDERS,
            top: options.top ? { style: BorderStyle.SINGLE, size: eighth(0.75), color: DIVIDER, space: 2 } : NO_BORDER,
          },
          width: { size: 68, type: WidthType.PERCENTAGE },
          children: [para([text(label, { size: options.bold ? 11 : 9.5, bold: options.bold, color: options.bold ? OBSIDIAN : SLATE })], { before: 3, after: 3 })],
        }),
        new TableCell({
          borders: {
            ...CELL_BORDERS,
            top: options.top ? { style: BorderStyle.SINGLE, size: eighth(0.75), color: DIVIDER, space: 2 } : NO_BORDER,
          },
          width: { size: 32, type: WidthType.PERCENTAGE },
          children: [
            para([text(amount, { size: options.bold ? 11 : 9.5, bold: options.bold, color: amount === "after the call" ? SLATE : OBSIDIAN })], {
              before: 3,
              after: 3,
              align: AlignmentType.RIGHT,
            }),
          ],
        }),
      ],
    });

  const rows = doc.investment.lineItems.map((item) =>
    row(
      item.description,
      item.amount > 0 ? `${money(item.amount)}${item.billing === "MONTHLY" ? "/mo" : ""}` : "after the call",
    ),
  );
  rows.push(row("Total", money(doc.investment.total), { bold: true, top: true }));
  if (doc.investment.recurring > 0) rows.push(row("Then, monthly", `${money(doc.investment.recurring)}/mo`));

  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, borders: CELL_BORDERS, rows });
}

function tail(data: ProposalPdfData): Paragraph[] {
  const doc = data.body;
  if (!doc) return [];
  const out: Paragraph[] = [para([text(doc.investment.basis, { size: 8.5, italics: true, color: SLATE })], { before: 5, after: 4 })];

  out.push(sectionHeading("Timeline"), para([text(doc.timeline, { size: 10, color: SLATE })]));
  out.push(sectionHeading("Why Dakyworld"), para([text(doc.whyUs, { size: 10, color: SLATE })]));

  if (doc.assumptions.length) {
    out.push(sectionHeading("What this assumes"));
    for (const assumption of doc.assumptions) out.push(bullet(assumption));
  }

  out.push(sectionHeading("Next step"), para([text(doc.nextStep, { size: 10.5, bold: true })]));

  if (data.expiresAt) {
    out.push(para([text(`This proposal holds until ${data.expiresAt.toDateString()}.`, { size: 9, color: SLATE })], { before: 12 }));
  }
  return out;
}

export async function renderProposalDocx(data: ProposalPdfData): Promise<Buffer> {
  const table = investmentTable(data);

  const document = new Document({
    creator: "Dakyworld",
    title: data.title,
    description: `Service proposal for ${data.clientName}`,
    sections: [
      {
        properties: {
          page: { size: PAGE, margin: MARGIN },
        },
        headers: { default: letterheadHeader() },
        footers: { default: letterheadFooter() },
        children: [...body(data), ...(table ? [table] : []), ...tail(data)],
      },
    ],
  });

  return Packer.toBuffer(document);
}
