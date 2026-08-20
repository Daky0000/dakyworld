import PDFDocument from "pdfkit";
import {
  ACCENT,
  CONTENT_BOTTOM,
  CONTENT_TOP,
  CONTENT_W,
  INK,
  LINE,
  MARGIN_X,
  MUTED,
  PAGE_H,
  PAGE_W,
  letterheadIdentity,
  pdfText,
  stampLetterhead,
  type LetterheadIdentity,
} from "./letterhead.js";

/**
 * Markdown, on the company's letterhead.
 *
 * The dossier and an agent's memory are Markdown natively — that is the form
 * the agents read, and the cheapest form to put in a prompt. When a person
 * wants to look at one properly, or send it to somebody, the honest thing is to
 * render *that same text* rather than assemble a second version of it from the
 * same data. Two renderers over one set of facts is how the website audit ended
 * up with a Markdown file and a PDF that could disagree.
 *
 * **This is deliberately a small parser, not a Markdown library.** It handles
 * what the dossier actually emits — headings, paragraphs, bullets, numbered
 * lists, rules, blockquotes, fenced code, tables and inline bold/italic/code —
 * and treats anything else as a paragraph. The repository already does this
 * sort of thing by hand (`png.ts` decodes PNGs with `zlib` rather than an image
 * library) for the same reason: a dependency that renders a superset of what is
 * needed still has to be kept, audited and upgraded.
 *
 * Every string goes through `pdfText()`. PDFKit's Helvetica is WinAnsi and has
 * no arrow, and this is the renderer most likely to meet one — the text is
 * written by agents, about a system whose own documentation says
 * "Settings -> AI models" constantly.
 */

type PDFDoc = InstanceType<typeof PDFDocument>;

const CONTENT_LIMIT = PAGE_H - CONTENT_BOTTOM;
const BODY_SIZE = 10;
const LINE_GAP = 2.4;

/** Starts a page when what is coming next would not fit on this one. */
function room(doc: PDFDoc, needed: number) {
  if (doc.y + needed > CONTENT_LIMIT) doc.addPage();
}

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

// --- Inline runs ------------------------------------------------------------

interface Run {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
}

/**
 * Splits a line into styled runs.
 *
 * One pass with one alternation rather than nested passes, so `**bold**` inside
 * a sentence and `` `code` `` next to it cannot re-enter each other and produce
 * stray asterisks — which is what a sequence of `.replace()` calls does to
 * text an agent wrote.
 */
function inlineRuns(line: string): Run[] {
  const runs: Run[] = [];
  const pattern = /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\*[^*\n]+\*|_[^_\n]+_|\[([^\]]+)\]\([^)]*\))/g;
  let last = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(line)) !== null) {
    if (match.index > last) runs.push({ text: line.slice(last, match.index) });
    const token = match[0];
    if (token.startsWith("**") || token.startsWith("__")) runs.push({ text: token.slice(2, -2), bold: true });
    else if (token.startsWith("`")) runs.push({ text: token.slice(1, -1), code: true });
    else if (token.startsWith("[")) runs.push({ text: match[2] ?? token, italic: true });
    else runs.push({ text: token.slice(1, -1), italic: true });
    last = match.index + token.length;
  }
  if (last < line.length) runs.push({ text: line.slice(last) });
  return runs.length > 0 ? runs : [{ text: line }];
}

function fontFor(run: Run): string {
  if (run.code) return "Courier";
  if (run.bold && run.italic) return "Helvetica-BoldOblique";
  if (run.bold) return "Helvetica-Bold";
  if (run.italic) return "Helvetica-Oblique";
  return "Helvetica";
}

/**
 * Draws a line of styled runs, wrapping within `width`.
 *
 * **Only the first run is given a position.** Every run after it passes options
 * alone, because in PDFKit supplying `x`/`y` to a continued segment restarts it
 * on a fresh line — which renders "the certificate is *checkable in one click*.
 * Speed is…" as three lines with the punctuation stranded at the start of one
 * of them. That is what the first rendered dossier did, and it survived a clean
 * typecheck: this is the sort of fault that only shows up in a rasterised page.
 */
function drawRuns(doc: PDFDoc, runs: Run[], x: number, width: number, size = BODY_SIZE, colour = INK) {
  const top = doc.y;
  runs.forEach((run, index) => {
    const options = { width, lineGap: LINE_GAP, continued: index !== runs.length - 1 };
    doc
      .fillColor(run.code ? ACCENT : colour)
      .font(fontFor(run))
      .fontSize(run.code ? size - 0.5 : size);
    if (index === 0) doc.text(pdfText(run.text), x, top, options);
    else doc.text(pdfText(run.text), options);
  });
}

/** How tall a line of runs will be, so a page break can be decided before drawing. */
function runsHeight(doc: PDFDoc, runs: Run[], width: number, size = BODY_SIZE): number {
  const text = runs.map((run) => run.text).join("");
  return doc.font("Helvetica").fontSize(size).heightOfString(pdfText(text), { width, lineGap: LINE_GAP });
}

// --- Block parsing ----------------------------------------------------------

const HEADING_SIZES: Record<number, number> = { 1: 19, 2: 13.5, 3: 11, 4: 10.5, 5: 10, 6: 10 };

/**
 * Renders a Markdown document onto the letterhead.
 *
 * `title` and `kicker` draw the masthead. When the Markdown's own first line is
 * an `# H1` matching the title it is dropped, so the page does not carry the
 * name twice — the dossier always opens with one.
 */
export async function renderMarkdownPdf(markdown: string, options: { title: string; kicker?: string; subtitle?: string }): Promise<Buffer> {
  const doc = newDoc(await letterheadIdentity());

  doc
    .fillColor(ACCENT)
    .font("Helvetica-Bold")
    .fontSize(8)
    .text(pdfText((options.kicker ?? "Dakyworld").toUpperCase()), MARGIN_X, doc.y, { width: CONTENT_W, characterSpacing: 1.6 });
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(19).text(pdfText(options.title), MARGIN_X, doc.y, { width: CONTENT_W, lineGap: 2 });
  if (options.subtitle) {
    doc.fillColor(MUTED).font("Helvetica").fontSize(9).text(pdfText(options.subtitle), MARGIN_X, doc.y, { width: CONTENT_W });
  }
  doc.moveDown(1);

  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let index = 0;
  let droppedTitle = false;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      index += 1;
      continue;
    }

    // Fenced code.
    if (/^```/.test(trimmed)) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !/^```/.test(lines[index].trim())) {
        body.push(lines[index]);
        index += 1;
      }
      index += 1;
      drawCode(doc, body);
      continue;
    }

    // A table: a header row, a separator of dashes, then rows.
    if (trimmed.startsWith("|") && index + 1 < lines.length && /^\|[\s:|-]+\|?$/.test(lines[index + 1].trim())) {
      const rows: string[][] = [splitRow(trimmed)];
      index += 2;
      while (index < lines.length && lines[index].trim().startsWith("|")) {
        rows.push(splitRow(lines[index].trim()));
        index += 1;
      }
      drawTable(doc, rows);
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      const level = heading[1].length;
      const text = heading[2].trim();
      // The masthead already says this. Printing it again wastes the first
      // third of page one on the company's name twice.
      if (level === 1 && !droppedTitle && text.toLowerCase() === options.title.toLowerCase()) {
        droppedTitle = true;
        index += 1;
        continue;
      }
      drawHeading(doc, level, text);
      index += 1;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      room(doc, 16);
      doc.moveDown(0.4);
      doc.strokeColor(LINE).lineWidth(1).moveTo(MARGIN_X, doc.y).lineTo(PAGE_W - MARGIN_X, doc.y).stroke();
      doc.moveDown(0.6);
      index += 1;
      continue;
    }

    if (/^>\s?/.test(trimmed)) {
      const body: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index].trim())) {
        body.push(lines[index].trim().replace(/^>\s?/, ""));
        index += 1;
      }
      drawQuote(doc, body.join(" "));
      continue;
    }

    const bullet = /^[-*+]\s+(.*)$/.exec(trimmed);
    const numbered = /^(\d+)[.)]\s+(.*)$/.exec(trimmed);
    if (bullet || numbered) {
      drawListItem(doc, numbered ? `${numbered[1]}.` : "-", (bullet ? bullet[1] : numbered![2]).trim());
      index += 1;
      continue;
    }

    // A paragraph runs until a blank line or the start of another block.
    const paragraph: string[] = [trimmed];
    index += 1;
    while (index < lines.length) {
      const next = lines[index].trim();
      if (!next || /^(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|```|\|)/.test(next) || /^(-{3,}|\*{3,}|_{3,})$/.test(next)) break;
      paragraph.push(next);
      index += 1;
    }
    drawParagraph(doc, paragraph.join(" "));
  }

  return collectBuffer(doc);
}

function splitRow(line: string): string[] {
  return line
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function drawHeading(doc: PDFDoc, level: number, text: string) {
  const size = HEADING_SIZES[level] ?? 10;
  room(doc, size * 2.6);
  doc.moveDown(level <= 2 ? 0.7 : 0.5);

  if (level <= 2) {
    // A hairline over the section, which is the house rule for a heading that
    // opens a block rather than continues one.
    doc.strokeColor(LINE).lineWidth(1).moveTo(MARGIN_X, doc.y).lineTo(PAGE_W - MARGIN_X, doc.y).stroke();
    doc.moveDown(0.35);
  }

  doc
    .fillColor(level <= 2 ? INK : ACCENT)
    .font("Helvetica-Bold")
    .fontSize(size)
    .text(pdfText(level >= 3 ? text.toUpperCase() : text), MARGIN_X, doc.y, {
      width: CONTENT_W,
      lineGap: 1.5,
      characterSpacing: level >= 3 ? 1.1 : 0,
    });
  doc.moveDown(0.35);
}

function drawParagraph(doc: PDFDoc, text: string) {
  const runs = inlineRuns(text);
  room(doc, Math.min(runsHeight(doc, runs, CONTENT_W) + 6, 140));
  drawRuns(doc, runs, MARGIN_X, CONTENT_W);
  doc.moveDown(0.5);
}

function drawListItem(doc: PDFDoc, marker: string, text: string) {
  const indent = 14;
  const width = CONTENT_W - indent;
  const runs = inlineRuns(text);
  room(doc, Math.min(runsHeight(doc, runs, width) + 4, 140));

  const top = doc.y;
  doc.fillColor(ACCENT).font("Helvetica-Bold").fontSize(BODY_SIZE).text(pdfText(marker), MARGIN_X, top, { width: indent });
  doc.y = top;
  drawRuns(doc, runs, MARGIN_X + indent, width);
  doc.moveDown(0.25);
}

function drawQuote(doc: PDFDoc, text: string) {
  const indent = 12;
  const width = CONTENT_W - indent;
  const runs = inlineRuns(text);
  const height = runsHeight(doc, runs, width);
  room(doc, height + 10);

  const top = doc.y;
  doc.strokeColor(ACCENT).lineWidth(2).moveTo(MARGIN_X, top).lineTo(MARGIN_X, top + height).stroke();
  doc.y = top;
  drawRuns(doc, runs, MARGIN_X + indent, width, BODY_SIZE, MUTED);
  doc.moveDown(0.5);
}

function drawCode(doc: PDFDoc, body: string[]) {
  const text = body.join("\n");
  const height = doc.font("Courier").fontSize(8.5).heightOfString(pdfText(text), { width: CONTENT_W - 16 });
  room(doc, height + 16);

  const top = doc.y;
  doc.rect(MARGIN_X, top, CONTENT_W, height + 12).fill("#F4F6FA");
  doc
    .fillColor(INK)
    .font("Courier")
    .fontSize(8.5)
    .text(pdfText(text), MARGIN_X + 8, top + 6, { width: CONTENT_W - 16 });
  doc.y = top + height + 16;
}

/**
 * A table, sized to its content.
 *
 * Columns share the width evenly rather than by measured content: the dossier's
 * tables are two and three columns of short values, and an even split is both
 * predictable and impossible to get wrong on a page break. A row that would
 * cross the bottom margin starts a page with the header redrawn, because a
 * table whose headings are on the previous page is unreadable.
 */
function drawTable(doc: PDFDoc, rows: string[][]) {
  if (rows.length === 0) return;
  const columns = Math.max(...rows.map((row) => row.length));
  const width = CONTENT_W / columns;
  const padding = 5;

  const drawRow = (cells: string[], header: boolean) => {
    const heights = cells.map((cell) =>
      doc
        .font(header ? "Helvetica-Bold" : "Helvetica")
        .fontSize(9)
        .heightOfString(pdfText(cell), { width: width - padding * 2 }),
    );
    const height = Math.max(...heights, 12) + padding * 2;
    room(doc, height + 4);

    const top = doc.y;
    if (header) doc.rect(MARGIN_X, top, CONTENT_W, height).fill("#F4F6FA");

    cells.forEach((cell, column) => {
      const runs = inlineRuns(cell);
      doc.y = top + padding;
      // Positioned once, then continued — see the note on drawRuns.
      runs.forEach((run, index) => {
        const options = { width: width - padding * 2, continued: index !== runs.length - 1 };
        doc
          .fillColor(header ? INK : run.code ? ACCENT : INK)
          .font(header ? "Helvetica-Bold" : fontFor(run))
          .fontSize(9);
        if (index === 0) doc.text(pdfText(run.text), MARGIN_X + column * width + padding, top + padding, options);
        else doc.text(pdfText(run.text), options);
      });
    });

    doc.y = top + height;
    doc.strokeColor(LINE).lineWidth(0.7).moveTo(MARGIN_X, doc.y).lineTo(PAGE_W - MARGIN_X, doc.y).stroke();
  };

  room(doc, 40);
  doc.moveDown(0.3);
  drawRow(rows[0], true);
  for (const row of rows.slice(1)) drawRow(row, false);
  doc.moveDown(0.6);
}
