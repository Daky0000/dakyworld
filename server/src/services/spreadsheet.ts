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

import { Readable } from "node:stream";
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
  return parseCsvCapped(text, delimiter, Infinity).rows;
}

/**
 * The same parse, stopping at `cap` rows but counting to the end.
 *
 * A 20 MB CSV is several million rows, and building every one of them as its
 * own array only to throw all but the first 5,000 away is the cheapest way
 * there is to run a server out of memory. The count keeps going so the Owner
 * can still be told what was left behind.
 */
export function parseCsvCapped(
  text: string,
  delimiter = sniffDelimiter(text),
  cap = MAX_ROWS_PER_SHEET,
): { rows: string[][]; sourceRows: number } {
  const rows: string[][] = [];
  let sourceRows = 0;
  let row: string[] = [];
  let field = "";
  let quoted = false;

  const finishRow = () => {
    row.push(field.trim());
    field = "";
    sourceRows += 1;
    if (rows.length < cap) rows.push(row);
    row = [];
  };

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
      finishRow();
    } else {
      field += char;
    }
  }

  if (field || row.length) finishRow();
  return { rows, sourceRows };
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

/**
 * Pads rows to a common width and applies the row/column caps.
 *
 * `sourceRows` is how many rows the sheet really had, for the callers that
 * stopped keeping them at the cap. Without it a 20,000-row sheet arrives here
 * already trimmed to 5,000 and reports `truncated: false` — which is how
 * 15,000 leads used to disappear out of an import with nothing said about it.
 */
export function toGrid(name: string, rows: string[][], sourceRows = rows.length): SheetGrid {
  const totalRows = Math.max(sourceRows, rows.length);
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
 * How the workbook is read, and why every one of these matters.
 *
 * `workbook.xlsx.load()` builds the whole file as an object model first —
 * every cell its own JS object, read or not. A 4.5 MB workbook peaked at
 * ~600 MB resident that way and never gave it back, and the wizard pays for it
 * twice: once to list the tabs, again to analyse. That is how a large sheet
 * took the service down mid-request and left the browser holding a gateway
 * error with no body in it — "Analyse", then an empty red bar. Streaming reads
 * one row at a time and holds only the rows we keep: the same file peaks at
 * ~300 MB, and listing the tabs costs nothing at all.
 *
 * `styles: "cache"` is not optional. A date in xlsx is a number plus a number
 * format, and the format lives in the styles part — ignore it and every date
 * column comes back as 46023 instead of 2026-01-01.
 */
const READER_OPTIONS = {
  worksheets: "emit",
  sharedStrings: "cache",
  styles: "cache",
  hyperlinks: "ignore",
  entries: "ignore",
} as const;

/** The reader hands back sheets typed without their name; it is there at runtime. */
function sheetName(worksheet: unknown, index: number): string {
  const named = worksheet as { name?: unknown };
  return typeof named.name === "string" && named.name ? named.name : `Sheet ${index + 1}`;
}

/**
 * Reading the sheets a caller asked for, one row at a time.
 *
 * Everything about the shape of this is dictated by what the table detector
 * downstream reads, so none of it is rearrangeable for tidiness.
 */
async function streamGrids(buffer: Buffer, wanted: Set<string> | null): Promise<SheetGrid[]> {
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(Readable.from(buffer), READER_OPTIONS);
  const grids: SheetGrid[] = [];
  let index = 0;

  for await (const worksheet of reader) {
    const name = sheetName(worksheet, index);
    index += 1;
    // Leaving a sheet un-iterated is how it gets skipped: the workbook
    // iterator drains what we didn't read on its way to the next one.
    if (wanted && !wanted.has(name)) continue;

    const rows: string[][] = [];
    let sourceRows = 0;

    for await (const row of worksheet) {
      sourceRows = row.number;
      // Past the cap we keep counting and stop keeping. The count is what
      // tells the Owner rows were left behind; the rows themselves are what
      // would put the file back in memory whole.
      if (row.number > MAX_ROWS_PER_SHEET) continue;

      // A blank row is never emitted, and blank rows are exactly what the
      // table detector reads to find where one table ends and the next
      // begins. So a row goes at its own number and the gaps stay gaps —
      // every index the analyst reports still lines up with the file.
      while (rows.length < row.number - 1) rows.push([]);

      const width = Math.min(row.cellCount, MAX_COLUMNS);
      const cells: string[] = [];
      for (let column = 1; column <= width; column += 1) cells.push(cellToString(row.getCell(column).value));
      rows.push(cells);
    }

    const grid = toGrid(name, rows, sourceRows);
    if (grid.rows.length) grids.push(grid);
  }

  return grids;
}

/** The whole workbook in memory — correct at any price, and the price is the reason it is second. */
async function loadGrids(buffer: Buffer, wanted: Set<string> | null): Promise<SheetGrid[]> {
  const workbook = new ExcelJS.Workbook();
  // ExcelJS types this as its own vendored Buffer shape; a Node Buffer is what it actually reads.
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);

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

    const grid = toGrid(worksheet.name, rows, worksheet.rowCount);
    if (grid.rows.length) grids.push(grid);
  });

  return grids;
}

/**
 * How many times the streaming read is attempted before paying for the whole
 * workbook, and why it is attempted more than once.
 *
 * ExcelJS's streaming reader has a race in it: `xl/workbook.xml` — the part
 * carrying the sheet *names* — is the last entry in a workbook ExcelJS itself
 * wrote, and when every zip entry lands in the same tick the reader can reach
 * the sheets with that part unparsed and throw on its own missing model. It is
 * a timing bug, so it is a small-file bug: an 8 KB workbook with hyperlinks in
 * it failed 14 times in 20, and a 560 KB one with sixteen thousand hyperlinks
 * failed none in 20. Which is the happy way round — a retry is nearly free on
 * a file that small, and the large files this exists for do not trigger it.
 *
 * The full load underneath is the floor. It is what this code replaced and it
 * is not wrong, only expensive, so a file that will not stream is read the old
 * way rather than refused.
 */
const STREAM_ATTEMPTS = 3;

async function readWorkbook(buffer: Buffer, wanted: Set<string> | null): Promise<SheetGrid[]> {
  for (let attempt = 1; attempt <= STREAM_ATTEMPTS; attempt += 1) {
    try {
      return await streamGrids(buffer, wanted);
    } catch (err) {
      if (attempt < STREAM_ATTEMPTS) continue;
      console.warn(`[spreadsheet] streaming read failed ${STREAM_ATTEMPTS}x, loading the workbook whole: ${(err as Error).message}`);
    }
  }

  try {
    return await loadGrids(buffer, wanted);
  } catch (err) {
    // Both readers refused it, so this really is the file rather than the race.
    throw new SpreadsheetError(`That file couldn't be read as a spreadsheet: ${(err as Error).message}`);
  }
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
    const { rows, sourceRows } = parseCsvCapped(buffer.toString("utf8"));
    const grid = toGrid(filename.replace(/\.[^.]+$/, ""), rows, sourceRows);
    return grid.rows.length ? [grid] : [];
  }

  return readWorkbook(buffer, sheetNames?.length ? new Set(sheetNames) : null);
}

/**
 * Tab names only — what the import wizard shows before anything is read in
 * full. Nothing inside the sheets is read: the names live in the workbook
 * part, so this is a few kilobytes of work whatever the workbook weighs, where
 * loading it whole to ask for a list of names used to cost as much as the
 * import itself and was paid immediately before paying it again.
 */
export async function listWorkbookSheets(buffer: Buffer, filename: string): Promise<string[]> {
  if (isCsvName(filename)) return [filename.replace(/\.[^.]+$/, "")];

  for (let attempt = 1; attempt <= STREAM_ATTEMPTS; attempt += 1) {
    try {
      const reader = new ExcelJS.stream.xlsx.WorkbookReader(Readable.from(buffer), { ...READER_OPTIONS, sharedStrings: "ignore" });
      const names: string[] = [];
      for await (const worksheet of reader) names.push(sheetName(worksheet, names.length));
      return names;
    } catch {
      if (attempt < STREAM_ATTEMPTS) continue;
    }
  }

  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
    return workbook.worksheets.map((worksheet) => worksheet.name);
  } catch (err) {
    throw new SpreadsheetError(`That file couldn't be read as a spreadsheet: ${(err as Error).message}`);
  }
}
