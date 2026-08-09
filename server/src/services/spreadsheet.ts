/**
 * Reads a workbook into plain grids.
 *
 * Everything downstream — the table detector, the analyst, the importer —
 * works on `string[][]` and nothing else, so a `.xlsx` from Excel, a `.csv`
 * exported from anywhere, and a tab read straight out of the Google Sheets API
 * all arrive in the same shape and take the same code path.
 *
 * Nothing is interpreted here on purpose. Blank rows, merged-cell gaps, title
 * banners and stacked tables are all preserved exactly as they sit in the file,
 * because those are the very clues the detector reads to find where one table
 * ends and the next begins.
 */

import ExcelJS from "exceljs";

/** Guard rails: a runaway sheet must not become a runaway import. */
export const MAX_ROWS_PER_SHEET = 5000;
export const MAX_COLUMNS = 60;

export interface SheetGrid {
  name: string;
  /** Row-major, ragged rows padded to the widest row. Cell text is trimmed. */
  rows: string[][];
  /** Rows in the source, before the cap above. */
  totalRows: number;
  truncated: boolean;
}

export class SpreadsheetError extends Error {
  status = 400;
}

// --- CSV -------------------------------------------------------------------

/** Comma, semicolon or tab — whichever appears most in the first few lines. */
function sniffDelimiter(text: string): string {
  const sample = text.split(/\r?\n/).slice(0, 10).join("\n");
  const counts = [",", ";", "\t"].map((delimiter) => ({
    delimiter,
    count: sample.split(delimiter).length - 1,
  }));
  counts.sort((a, b) => b.count - a.count);
  return counts[0].count > 0 ? counts[0].delimiter : ",";
}

/** RFC 4180: quoted fields may contain the delimiter, newlines, and `""` escapes. */
export function parseCsv(text: string, delimiter = sniffDelimiter(text)): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  // A BOM survives most exports and would otherwise become part of the first header.
  const input = text.replace(/^﻿/, "");

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];

    if (quoted) {
      if (char === '"') {
        if (input[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      row.push(field.trim());
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && input[index + 1] === "\n") index += 1;
      row.push(field.trim());
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  if (field || row.length) {
    row.push(field.trim());
    rows.push(row);
  }
  return rows;
}

// --- Cells -----------------------------------------------------------------

/**
 * One ExcelJS cell as text. Formulas yield their cached result, hyperlinks
 * their display text, rich text its concatenation — a header styled one word at
 * a time still reads as one header.
 */
function cellToString(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    const cell = value as unknown as Record<string, unknown>;
    if ("text" in cell && typeof cell.text === "string") return cell.text.trim();
    if ("richText" in cell && Array.isArray(cell.richText)) {
      return cell.richText.map((run: { text?: string }) => run.text ?? "").join("").trim();
    }
    if ("result" in cell) return cellToString(cell.result as ExcelJS.CellValue);
    if ("hyperlink" in cell && typeof cell.hyperlink === "string") return cell.hyperlink.trim();
    if ("error" in cell) return "";
    return "";
  }
  return String(value).trim();
}

// --- Normalising -----------------------------------------------------------

/** Pads rows to a common width and applies the row/column caps. */
export function toGrid(name: string, rows: string[][]): SheetGrid {
  const totalRows = rows.length;
  const capped = rows.slice(0, MAX_ROWS_PER_SHEET);
  const width = Math.min(
    MAX_COLUMNS,
    capped.reduce((widest, row) => {
      // Trailing empties are formatting, not data — don't let them set the width.
      let last = row.length;
      while (last > 0 && !row[last - 1]) last -= 1;
      return Math.max(widest, last);
    }, 0),
  );

  const padded = capped.map((row) => {
    const cells = row.slice(0, width).map((cell) => (cell ?? "").toString().trim());
    while (cells.length < width) cells.push("");
    return cells;
  });

  // Drop trailing blank rows so "how many rows does this sheet have" is honest.
  while (padded.length && padded[padded.length - 1].every((cell) => !cell)) padded.pop();

  return { name, rows: padded, totalRows, truncated: totalRows > MAX_ROWS_PER_SHEET };
}

// --- Workbooks -------------------------------------------------------------

export function isCsvName(filename: string): boolean {
  return /\.(csv|tsv|txt)$/i.test(filename);
}

export function isSpreadsheetName(filename: string): boolean {
  return /\.(xlsx|xlsm|csv|tsv|txt)$/i.test(filename);
}

/**
 * Every sheet in an uploaded file. `.xls` (the pre-2007 binary format) is not
 * readable here — saying so is more useful than a parser error.
 */
export async function parseWorkbook(buffer: Buffer, filename: string, sheetNames?: string[]): Promise<SheetGrid[]> {
  if (/\.xls$/i.test(filename)) {
    throw new SpreadsheetError("Old .xls files can't be read. Open it in Excel or Sheets and save it as .xlsx or .csv.");
  }

  if (isCsvName(filename)) {
    const grid = toGrid(filename.replace(/\.[^.]+$/, ""), parseCsv(buffer.toString("utf8")));
    return grid.rows.length ? [grid] : [];
  }

  const workbook = new ExcelJS.Workbook();
  try {
    // ExcelJS types this as its own vendored Buffer shape; a Node Buffer is what it actually reads.
    await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  } catch (err) {
    throw new SpreadsheetError(`That file couldn't be read as a spreadsheet: ${(err as Error).message}`);
  }

  const wanted = sheetNames?.length ? new Set(sheetNames) : null;
  const grids: SheetGrid[] = [];

  workbook.eachSheet((worksheet) => {
    if (wanted && !wanted.has(worksheet.name)) return;
    const rows: string[][] = [];
    const lastRow = Math.min(worksheet.rowCount, MAX_ROWS_PER_SHEET);
    const lastColumn = Math.min(worksheet.columnCount || 0, MAX_COLUMNS);

    for (let rowNumber = 1; rowNumber <= lastRow; rowNumber += 1) {
      const row = worksheet.getRow(rowNumber);
      const cells: string[] = [];
      for (let column = 1; column <= lastColumn; column += 1) {
        cells.push(cellToString(row.getCell(column).value));
      }
      rows.push(cells);
    }

    const grid = toGrid(worksheet.name, rows);
    if (grid.rows.length) grids.push(grid);
  });

  return grids;
}

/** Tab names only — what the import wizard shows before anything is read in full. */
export async function listWorkbookSheets(buffer: Buffer, filename: string): Promise<string[]> {
  if (isCsvName(filename)) return [filename.replace(/\.[^.]+$/, "")];
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  return workbook.worksheets.map((worksheet) => worksheet.name);
}
