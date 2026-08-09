/**
 * The import plan: what a spreadsheet actually contains.
 *
 * A lead sheet in the wild is rarely one clean table. It has a title banner,
 * blank spacer rows, a block of people, then further down a second block of
 * companies with entirely different columns, then a few stray rows someone
 * pasted in. Treating the file as "row 1 is the header, everything below is
 * data" throws most of that away.
 *
 * So the file is described as a *plan* first — a list of tables, each with its
 * own header row, row range, column range and column mapping. Each table
 * becomes its own lead group with its own columns. The plan is produced by the
 * analyst in lib/anthropic.ts, or by the rules below when no API key is set,
 * and either way the Owner sees and can correct it before a single lead is
 * written.
 */

import type { LeadFieldType } from "@prisma/client";
import type { SheetGrid } from "./spreadsheet.js";
import { BUILTIN_FIELDS, builtinField, coerceValue, isBuiltinKey, slugifyKey } from "./leadFields.js";

/** `field: "custom"` stores the value in Lead.customFields; `"ignore"` drops the column. */
export type PlanFieldTarget = string;

export interface PlanColumn {
  /** 0-based column index in the sheet grid. */
  index: number;
  /** The header cell as it reads in the file, for the review screen. */
  header: string;
  /** What the column is called in Dakyworld OS. */
  label: string;
  /** A built-in Lead key, or "custom", or "ignore". */
  field: PlanFieldTarget;
  /** Storage key when `field` is "custom". */
  key?: string;
  type: LeadFieldType;
}

export interface PlanTable {
  id: string;
  sheet: string;
  /** Becomes the lead group's name. */
  title: string;
  /** 0-based; null when the block has no header and columns are positional. */
  headerRow: number | null;
  firstDataRow: number;
  /** Inclusive. */
  lastDataRow: number;
  startColumn: number;
  /** Inclusive. */
  endColumn: number;
  columns: PlanColumn[];
  leadSource: string;
  status: string;
  /** 0-1, the analyst's own confidence that this really is a lead table. */
  confidence: number;
  notes: string;
  /** Unticked tables are left out at commit time. */
  include: boolean;
}

export interface ImportPlan {
  tables: PlanTable[];
  summary: string;
}

// --- Header synonyms -------------------------------------------------------

/**
 * Header text → Lead field. Ordered most specific first, because "alternate
 * phone" must not be read as "phone" — the second number belongs in its own
 * column, not on top of the first.
 */
const HEADER_RULES: { pattern: RegExp; field: string }[] = [
  { pattern: /^(s\/?n|sn|no\.?|#|序|index|serial|row)$/i, field: "ignore" },
  { pattern: /\b(alt|alternate|other|second|secondary|2nd|backup)\b/i, field: "custom" },
  { pattern: /(company|organisation|organization|business\s*name|firm|employer|establishment)/i, field: "companyName" },
  { pattern: /(e-?mail)/i, field: "contactEmail" },
  { pattern: /(phone|tel|telephone|mobile|cell|whats\s*app|contact\s*(no|number))/i, field: "contactPhone" },
  { pattern: /(web\s*site|website|url|domain|web\b)/i, field: "website" },
  { pattern: /(address|street|premises)/i, field: "address" },
  { pattern: /^(city|town|locality)$/i, field: "city" },
  { pattern: /^(region|state|province|county)$/i, field: "region" },
  { pattern: /^(country|nation)$/i, field: "country" },
  { pattern: /(category|industry|sector|business\s*type|niche|trade)/i, field: "category" },
  { pattern: /(lead\s*source|source|channel|referr)/i, field: "source" },
  { pattern: /(status|stage|pipeline|progress)/i, field: "status" },
  { pattern: /(lead\s*score|score|rank)/i, field: "leadScore" },
  { pattern: /(deal|budget|amount|value|price|revenue|contract)/i, field: "estimatedDealSize" },
  { pattern: /(rating|stars)/i, field: "rating" },
  { pattern: /(reviews?)/i, field: "reviewsCount" },
  { pattern: /(tags?|labels?)/i, field: "tags" },
  { pattern: /(notes?|remarks?|comments?|description|details)/i, field: "discoveryNotes" },
  { pattern: /(contact\s*person|contact\s*name|full\s*name|person|client|customer|^name$|^contact$)/i, field: "contactName" },
];

function guessField(header: string): string {
  const text = header.trim();
  if (!text) return "custom";
  for (const rule of HEADER_RULES) {
    if (rule.pattern.test(text)) return rule.field;
  }
  return "custom";
}

const TYPE_RULES: { pattern: RegExp; type: LeadFieldType }[] = [
  { pattern: /(e-?mail)/i, type: "EMAIL" },
  { pattern: /(phone|tel|mobile|cell|whats\s*app|fax)/i, type: "PHONE" },
  { pattern: /(website|url|link|domain|profile)/i, type: "URL" },
  { pattern: /(date|when|day|deadline|follow.?up|last\s*contact)/i, type: "DATE" },
  { pattern: /(amount|price|budget|value|revenue|fee|cost|deal)/i, type: "CURRENCY" },
  { pattern: /(count|number\s*of|qty|quantity|score|rating|years?)/i, type: "NUMBER" },
  { pattern: /(notes?|remarks?|comments?|description|details|summary)/i, type: "LONG_TEXT" },
];

/** A column's type from its header first, then from what the cells look like. */
function guessType(header: string, samples: string[]): LeadFieldType {
  for (const rule of TYPE_RULES) {
    if (rule.pattern.test(header)) return rule.type;
  }
  const values = samples.filter(Boolean);
  if (!values.length) return "TEXT";
  const ratio = (test: (value: string) => boolean) => values.filter(test).length / values.length;

  if (ratio((value) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) > 0.6) return "EMAIL";
  if (ratio((value) => /^https?:\/\/|^www\./i.test(value)) > 0.6) return "URL";
  if (ratio((value) => /^[+()\d][\d\s()\-.]{6,}$/.test(value)) > 0.6) return "PHONE";
  if (ratio((value) => /^-?[\d,. ]+$/.test(value)) > 0.7) return "NUMBER";
  if (ratio((value) => /^(yes|no|true|false|y|n)$/i.test(value)) > 0.7) return "BOOLEAN";
  if (ratio((value) => !Number.isNaN(Date.parse(value)) && /\d{4}|\/|-/.test(value)) > 0.7) return "DATE";
  if (ratio((value) => value.length > 60) > 0.3) return "LONG_TEXT";
  return "TEXT";
}

/**
 * A name for a column whose header cell is empty, read off its contents.
 * Deliberately one rule rather than a taxonomy: a column of free text is the
 * common case — "Switched off", "No answer", "Waiting on us to send proposals"
 * — and "Notes" beats "Column F" by a distance. Anything else keeps the column
 * letter, which at least says where to look in the file.
 */
function labelFromContents(samples: string[]): string | null {
  const values = samples.filter(Boolean);
  if (values.length < 2) return null;
  const averageLength = values.reduce((total, value) => total + value.length, 0) / values.length;
  return averageLength >= 18 ? "Notes" : null;
}

/** Spreadsheet column letters, so an unlabelled column is still nameable. */
export function columnLetter(index: number): string {
  let letters = "";
  let n = index;
  do {
    letters = String.fromCharCode(65 + (n % 26)) + letters;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return letters;
}

// --- Rule-based detection --------------------------------------------------

interface Block {
  start: number;
  end: number;
  /** A one-cell row directly above the block — "Companies/Organizations". */
  banner: string | null;
}

function filledCount(row: string[]): number {
  return row.filter((cell) => cell !== "").length;
}

/** The columns a range of rows actually fills. */
function footprint(grid: SheetGrid, start: number, end: number): Set<number> {
  const used = new Set<number>();
  for (let index = start; index <= end; index += 1) {
    grid.rows[index]?.forEach((cell, column) => {
      if (cell !== "") used.add(column);
    });
  }
  return used;
}

/** How much of `later` sits inside the columns `earlier` already uses. */
function columnOverlap(earlier: Set<number>, later: Set<number>): number {
  if (!later.size) return 0;
  let shared = 0;
  for (const column of later) if (earlier.has(column)) shared += 1;
  return shared / later.size;
}

/** Rows below `start` that are blank — the gap between two blocks. */
const MAX_GAP_ROWS = 2;

/**
 * Splits a sheet into candidate blocks on blank rows, keeping a lone
 * single-cell row above a block as that block's title rather than as data.
 *
 * Blank rows are a weak signal on their own. Real sheets are full of them
 * *inside* a table — a row deleted, a spacer someone left, a numbering gap
 * where S/N jumps from 4 to 6 — and splitting on every one shatters a single
 * table into fragments that then lose the header sitting above the first one.
 * So a block that follows a short gap is folded back into the previous block
 * unless it announces itself as something new: its own banner, or its own
 * header row, or a set of columns the previous block wasn't using.
 */
function findBlocks(grid: SheetGrid): Block[] {
  const raw: Block[] = [];
  let start: number | null = null;
  let banner: string | null = null;
  let pendingBanner: string | null = null;

  for (let index = 0; index < grid.rows.length; index += 1) {
    const filled = filledCount(grid.rows[index]);

    if (filled === 0) {
      if (start !== null) {
        raw.push({ start, end: index - 1, banner });
        start = null;
        banner = null;
      }
      // A heading is usually separated from its table by a blank row, so a
      // pending banner survives the gap.
      continue;
    }

    // A row with one filled cell and nothing started yet is a heading, not a table.
    if (filled === 1 && start === null) {
      pendingBanner = grid.rows[index].find((cell) => cell !== "") ?? null;
      continue;
    }

    if (start === null) {
      start = index;
      banner = pendingBanner;
      pendingBanner = null;
    }
  }

  if (start !== null) raw.push({ start, end: grid.rows.length - 1, banner });

  const merged: Block[] = [];
  for (const block of raw) {
    const previous = merged[merged.length - 1];
    const continuation =
      previous !== undefined &&
      block.banner === null &&
      block.start - previous.end - 1 <= MAX_GAP_ROWS &&
      !looksLikeHeader(grid.rows[block.start]) &&
      columnOverlap(footprint(grid, previous.start, previous.end), footprint(grid, block.start, block.end)) >= 0.8;

    if (continuation) previous.end = block.end;
    else merged.push({ ...block });
  }

  return merged;
}

/** Header rows are short, wordy and non-numeric — data rows usually aren't. */
function looksLikeHeader(row: string[]): boolean {
  const cells = row.filter((cell) => cell !== "");
  if (cells.length < 2) return false;
  const wordy = cells.filter((cell) => cell.length <= 40 && /[a-z]/i.test(cell) && !/^\d[\d\s,.\-/]*$/.test(cell));
  return wordy.length / cells.length >= 0.8;
}

/** The set of columns a row fills, as a string, for comparing row shapes. */
function shapeOf(row: string[]): string {
  return row.map((cell) => (cell === "" ? "0" : "1")).join("");
}

function buildTable(
  grid: SheetGrid,
  block: Block,
  headerRow: number | null,
  firstDataRow: number,
  lastDataRow: number,
  index: number,
): PlanTable | null {
  const dataRows = grid.rows.slice(firstDataRow, lastDataRow + 1);
  if (!dataRows.length) return null;

  // Only columns that actually carry something, header or data.
  const used = new Set<number>();
  for (const row of dataRows) {
    row.forEach((cell, column) => {
      if (cell !== "") used.add(column);
    });
  }
  if (headerRow !== null) {
    grid.rows[headerRow].forEach((cell, column) => {
      if (cell !== "" && used.size) used.add(column);
    });
  }
  if (!used.size) return null;

  const columns = [...used].sort((a, b) => a - b);
  const startColumn = columns[0];
  const endColumn = columns[columns.length - 1];

  const claimed = new Set<string>();
  const planColumns: PlanColumn[] = columns.map((column) => {
    const header = headerRow !== null ? grid.rows[headerRow][column] ?? "" : "";
    const samples = dataRows.slice(0, 40).map((row) => row[column] ?? "");
    let field = guessField(header);

    // One Lead scalar, one column. A second "Phone" is a real column of its
    // own, not an overwrite of the first.
    if (field !== "ignore" && field !== "custom" && claimed.has(field)) field = "custom";
    if (field !== "ignore" && field !== "custom") claimed.add(field);

    const label = header || labelFromContents(samples) || `Column ${columnLetter(column)}`;
    const type = field !== "custom" && field !== "ignore" ? (builtinField(field)?.type ?? "TEXT") : guessType(header, samples);

    return {
      index: column,
      header,
      label: field !== "custom" && field !== "ignore" ? (builtinField(field)?.label ?? label) : label,
      field,
      key: field === "custom" ? slugifyKey(label) : undefined,
      type,
    };
  });

  // Without something to call a lead by, the block isn't a lead table.
  const hasName = planColumns.some((column) => column.field === "contactName" || column.field === "companyName");
  if (!hasName) {
    // Fall back to the first text-ish column so the Owner can still fix it up
    // on the review screen rather than losing the table silently.
    const candidate = planColumns.find((column) => column.field === "custom" && column.type === "TEXT");
    if (candidate) {
      candidate.field = "contactName";
      candidate.label = "Name";
      candidate.type = "TEXT";
      delete candidate.key;
    }
  }

  const title = block.banner?.trim() || (grid.name && grid.name !== "Sheet1" ? grid.name : "Imported leads");

  return {
    id: `${grid.name}:${firstDataRow}-${lastDataRow}:${index}`,
    sheet: grid.name,
    title,
    headerRow,
    firstDataRow,
    lastDataRow,
    startColumn,
    endColumn,
    columns: planColumns,
    leadSource: "DIRECTORY",
    status: "NEW",
    confidence: hasName ? 0.6 : 0.3,
    notes: "Detected by pattern rules — no AI analyst was available.",
    include: true,
  };
}

/**
 * The fallback analyst. Finds blank-row-separated blocks, promotes single-cell
 * rows above them to titles, picks a header row per block, and splits a block
 * again wherever a second header appears inside it. Good enough for a tidy
 * sheet; the AI analyst in lib/anthropic.ts is what handles a messy one.
 */
export function detectTables(grids: SheetGrid[]): PlanTable[] {
  const tables: PlanTable[] = [];

  for (const grid of grids) {
    for (const [blockIndex, block] of findBlocks(grid).entries()) {
      // A header inside the block means a second table starts there.
      const boundaries: number[] = [block.start];
      const firstShape = shapeOf(grid.rows[block.start]);
      for (let row = block.start + 2; row <= block.end; row += 1) {
        if (looksLikeHeader(grid.rows[row]) && shapeOf(grid.rows[row]) !== firstShape && !looksLikeHeader(grid.rows[row - 1])) {
          boundaries.push(row);
        }
      }

      for (const [segmentIndex, segmentStart] of boundaries.entries()) {
        const segmentEnd = segmentIndex + 1 < boundaries.length ? boundaries[segmentIndex + 1] - 1 : block.end;
        const hasHeader = looksLikeHeader(grid.rows[segmentStart]);
        const headerRow = hasHeader ? segmentStart : null;
        const firstDataRow = hasHeader ? segmentStart + 1 : segmentStart;
        const table = buildTable(
          grid,
          { ...block, banner: segmentIndex === 0 ? block.banner : null },
          headerRow,
          firstDataRow,
          segmentEnd,
          tables.length + blockIndex,
        );
        if (table) tables.push(table);
      }
    }
  }

  return tables;
}

// --- Rendering for the analyst ---------------------------------------------

const CELL_PREVIEW_LENGTH = 48;
const HEAD_ROWS = 110;
const TAIL_ROWS = 15;

function renderRow(index: number, row: string[]): string {
  const cells = row.map((cell) => {
    const text = cell.length > CELL_PREVIEW_LENGTH ? `${cell.slice(0, CELL_PREVIEW_LENGTH)}…` : cell;
    return text.replace(/\s+/g, " ");
  });
  return `${String(index).padStart(4, " ")} | ${cells.join(" | ")}`;
}

/**
 * A sheet as text the analyst can read, with 0-based row numbers down the side
 * so the row indices it reports line up with the grid exactly. Long sheets show
 * the top and the bottom — enough to place the last data row without paying for
 * ten thousand rows of middle.
 */
export function renderGrid(grid: SheetGrid): string {
  const header = `### Sheet "${grid.name}" — ${grid.rows.length} rows (0-${Math.max(0, grid.rows.length - 1)}), ${
    grid.rows[0]?.length ?? 0
  } columns (${columnLetter(0)}-${columnLetter(Math.max(0, (grid.rows[0]?.length ?? 1) - 1))})${
    grid.truncated ? `, truncated from ${grid.totalRows} rows` : ""
  }`;

  const lines: string[] = [header];
  const rows = grid.rows;
  if (rows.length <= HEAD_ROWS + TAIL_ROWS) {
    rows.forEach((row, index) => lines.push(renderRow(index, row)));
  } else {
    rows.slice(0, HEAD_ROWS).forEach((row, index) => lines.push(renderRow(index, row)));
    lines.push(`     … ${rows.length - HEAD_ROWS - TAIL_ROWS} more rows in the same shape …`);
    rows.slice(-TAIL_ROWS).forEach((row, offset) => lines.push(renderRow(rows.length - TAIL_ROWS + offset, row)));
  }
  return lines.join("\n");
}

/** The rule-based reading, offered to the analyst as a starting point to correct. */
export function renderHints(tables: PlanTable[]): string {
  if (!tables.length) return "(the pattern rules found no candidate blocks)";
  return tables
    .map(
      (table) =>
        `- sheet "${table.sheet}" rows ${table.firstDataRow}-${table.lastDataRow}, header row ${
          table.headerRow ?? "none"
        }, columns ${columnLetter(table.startColumn)}-${columnLetter(table.endColumn)}, title guess "${table.title}"`,
    )
    .join("\n");
}

// --- Applying a plan -------------------------------------------------------

export interface ExtractedRow {
  /** Built-in Lead scalars, already coerced to the right types. */
  lead: Record<string, unknown>;
  /** Custom columns, keyed by LeadField.key. */
  custom: Record<string, unknown>;
  /** The untouched cells, so a mapping fix can be replayed. */
  raw: Record<string, string>;
  rowIndex: number;
}

/** True when a row is a repeat of the header, a subtotal, or otherwise not a lead. */
function isNoiseRow(row: string[], table: PlanTable, grid: SheetGrid): boolean {
  const cells = row.filter((cell) => cell !== "");
  if (!cells.length) return true;
  if (table.headerRow !== null) {
    const header = grid.rows[table.headerRow];
    const same = row.every((cell, index) => cell.toLowerCase() === (header[index] ?? "").toLowerCase());
    if (same) return true;
  }
  return /^(total|subtotal|grand total|sum)\b/i.test(cells[0] ?? "");
}

/**
 * Runs one table of the plan over the grid. Rows with nothing in the name
 * column are dropped — a lead you can't even label isn't a lead — and reported
 * back as `skipped` so the import summary can say how many and why.
 */
export function extractRows(grid: SheetGrid, table: PlanTable): { rows: ExtractedRow[]; skipped: number } {
  const rows: ExtractedRow[] = [];
  let skipped = 0;

  const lastRow = Math.min(table.lastDataRow, grid.rows.length - 1);
  for (let rowIndex = Math.max(0, table.firstDataRow); rowIndex <= lastRow; rowIndex += 1) {
    const row = grid.rows[rowIndex];
    if (!row) continue;
    if (isNoiseRow(row, table, grid)) {
      if (row.some((cell) => cell !== "")) skipped += 1;
      continue;
    }

    const lead: Record<string, unknown> = {};
    const custom: Record<string, unknown> = {};
    const raw: Record<string, string> = {};

    for (const column of table.columns) {
      const cell = row[column.index] ?? "";
      if (column.field === "ignore") continue;
      raw[column.label] = cell;
      if (cell === "") continue;

      if (column.field === "custom") {
        const key = column.key || slugifyKey(column.label);
        custom[key] = coerceValue(key, column.type, cell) ?? cell;
      } else if (isBuiltinKey(column.field)) {
        const value = coerceValue(column.field, column.type, cell);
        if (value !== null && value !== undefined) lead[column.field] = value;
      }
    }

    const name = (lead.contactName ?? lead.companyName) as string | undefined;
    if (!name || !String(name).trim()) {
      skipped += 1;
      continue;
    }
    lead.contactName = String(name).trim();

    rows.push({ lead, custom, raw, rowIndex });
  }

  return { rows, skipped };
}

// --- Validation ------------------------------------------------------------

const VALID_FIELDS = new Set([...BUILTIN_FIELDS.filter((field) => field.writable).map((field) => field.key), "custom", "ignore"]);

/**
 * Clamps a plan — whether it came from the analyst or from the review screen —
 * to something that can actually be run against the grids: real row and column
 * indices, known field targets, one Lead scalar per table, unique custom keys.
 */
export function normalizePlan(plan: ImportPlan, grids: SheetGrid[]): ImportPlan {
  const byName = new Map(grids.map((grid) => [grid.name, grid]));

  const tables = plan.tables
    .map((table, tableIndex): PlanTable | null => {
      const grid = byName.get(table.sheet) ?? (grids.length === 1 ? grids[0] : undefined);
      if (!grid || !grid.rows.length) return null;

      const lastRowIndex = grid.rows.length - 1;
      const width = grid.rows[0].length;
      const headerRow =
        table.headerRow === null || table.headerRow === undefined || table.headerRow < 0 || table.headerRow > lastRowIndex
          ? null
          : Math.trunc(table.headerRow);
      const firstDataRow = Math.min(Math.max(0, Math.trunc(table.firstDataRow ?? (headerRow ?? -1) + 1)), lastRowIndex);
      const lastDataRow = Math.min(Math.max(firstDataRow, Math.trunc(table.lastDataRow ?? lastRowIndex)), lastRowIndex);

      const claimed = new Set<string>();
      const keys = new Set<string>();
      const columns = (table.columns ?? [])
        .filter((column) => Number.isInteger(column.index) && column.index >= 0 && column.index < width)
        .map((column): PlanColumn => {
          let field = VALID_FIELDS.has(column.field) ? column.field : "custom";
          if (field !== "custom" && field !== "ignore") {
            if (claimed.has(field)) field = "custom";
            else claimed.add(field);
          }

          const label = (column.label || column.header || `Column ${columnLetter(column.index)}`).trim().slice(0, 60);
          let key: string | undefined;
          if (field === "custom") {
            key = slugifyKey(column.key || label);
            // Two "Notes" columns in one table would otherwise overwrite each other.
            let suffix = 2;
            while (keys.has(key)) key = `${slugifyKey(column.key || label)}_${suffix++}`;
            keys.add(key);
          }

          const type =
            field !== "custom" && field !== "ignore"
              ? (builtinField(field)?.type ?? "TEXT")
              : ((["TEXT", "LONG_TEXT", "NUMBER", "CURRENCY", "DATE", "BOOLEAN", "EMAIL", "PHONE", "URL", "SELECT"] as const).includes(
                    column.type,
                  )
                  ? column.type
                  : "TEXT");

          return { index: column.index, header: column.header ?? "", label, field, key, type };
        });

      if (!columns.some((column) => column.field === "contactName")) {
        const company = columns.find((column) => column.field === "companyName");
        // Every lead needs a name; a company sheet's company column is its name.
        if (company) columns.unshift({ ...company, field: "contactName", label: "Name" });
      }
      // Show columns in the sheet's own left-to-right order. The sort is
      // stable, so the name column above stays ahead of the company column it
      // was cloned from.
      columns.sort((a, b) => a.index - b.index);

      return {
        id: table.id || `${grid.name}:${firstDataRow}:${tableIndex}`,
        sheet: grid.name,
        title: (table.title || grid.name || "Imported leads").trim().slice(0, 80),
        headerRow,
        firstDataRow,
        lastDataRow,
        startColumn: columns.length ? Math.min(...columns.map((column) => column.index)) : 0,
        endColumn: columns.length ? Math.max(...columns.map((column) => column.index)) : 0,
        columns,
        leadSource: table.leadSource || "DIRECTORY",
        status: table.status || "NEW",
        confidence: typeof table.confidence === "number" ? Math.max(0, Math.min(1, table.confidence)) : 0.5,
        notes: (table.notes ?? "").slice(0, 500),
        include: table.include !== false,
      };
    })
    .filter((table): table is PlanTable => table !== null && table.columns.length > 0);

  return { tables, summary: (plan.summary ?? "").slice(0, 2000) };
}
