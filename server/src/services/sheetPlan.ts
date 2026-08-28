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
 * own header row, row range, column range and column mapping. The plan is
 * produced by the analyst in lib/anthropic.ts, or by the rules below when no
 * API key is set, and either way the Owner sees and can correct it before a
 * single lead is written.
 *
 * **What a table is and what a lead list is are two different questions.**
 * `plan.grouping` answers the second: one list per worksheet by default, so a
 * tab with three section headings down it arrives as one findable thing rather
 * than three; one list per table when the Owner asks for that on the review
 * screen. See `planGroups`.
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

/**
 * How the tables in a plan become lead lists.
 *
 * `"sheet"` — everything found on one worksheet lands in **one** list. This is
 * the default, and it is the default because of what a real file looks like: a
 * tab of leads with three section headings in it is three tables to a detector
 * and one list to the person who typed it, and three lists called "Accra",
 * "Kumasi" and "Takoradi" scattered among a workbook's other ninety are not
 * findable as a thing. The columns of a merged list are the union of its
 * tables', so a section with a column the others lack keeps it.
 *
 * `"table"` — one list per detected table, which is what a workbook of
 * genuinely different tables wants: a table of people and a table of
 * organisations forced into one column set is the shape that loses data.
 */
export type PlanGrouping = "sheet" | "table";

export interface ImportPlan {
  tables: PlanTable[];
  summary: string;
  /** Absent means "sheet" — see `groupingOf`. */
  grouping?: PlanGrouping;
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
 * A name for a column nothing named, read off what is actually in it.
 *
 * "Column F" is not a name. It is what the file calls the position, and it
 * tells the Owner nothing about the column they are being asked to approve —
 * so an unnamed column of email addresses arrived on the review screen as
 * "Column F", was mapped to a custom column because a blank header matches no
 * rule, and the leads it created had no `contactEmail` at all. Reachable
 * businesses, filed as unreachable, because a header cell was empty.
 *
 * So the cells are read instead, and they answer both questions at once: what
 * to call the column, and — where the contents are unmistakable — which Lead
 * field it belongs in.
 *
 * Ordered by how certain the reading is. Only the first three suggest a
 * `field`: an address with an @ in it is an email address whatever the column
 * is called, and the same is true of a phone number and a URL. Everything
 * below is a *name* only, because a column of dates could be a follow-up date
 * or a date added and nothing in the cells says which.
 *
 * Returns null when the column says nothing about itself — too few values, or
 * a mix with no shape — and the column letter stands, which at least says
 * where to look in the file.
 */
export interface ColumnReading {
  label: string;
  /** A Lead scalar, when the contents can only be that. */
  field?: string;
  type: LeadFieldType;
}

/** Values that carry no information: placeholders people type for "nothing". */
const BLANKS = /^(n\/?a|none|nil|-+|—|\?+|tbd|unknown|null)$/i;

/** `2026-01-04`, `04/01/2026`, `4-1-26` — the written dates that read as phone numbers. */
const DATE_SHAPE = /^(\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4})$/;

/** Social profile links are not a website. `website` is where the business lives. */
const SOCIAL_HOSTS: { pattern: RegExp; label: string }[] = [
  { pattern: /(^|\.)facebook\.com$|(^|\.)fb\.com$/i, label: "Facebook" },
  { pattern: /(^|\.)instagram\.com$/i, label: "Instagram" },
  { pattern: /(^|\.)linkedin\.com$/i, label: "LinkedIn" },
  { pattern: /(^|\.)(twitter|x)\.com$/i, label: "Twitter" },
  { pattern: /(^|\.)tiktok\.com$/i, label: "TikTok" },
  { pattern: /(^|\.)youtube\.com$|(^|\.)youtu\.be$/i, label: "YouTube" },
  { pattern: /(^|\.)wa\.me$|(^|\.)whatsapp\.com$/i, label: "WhatsApp" },
  { pattern: /(^|\.)maps\.google\.|(^|\.)goo\.gl$/i, label: "Maps link" },
];

function hostOf(value: string): string | null {
  try {
    return new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return null;
  }
}

/** Title case for a label built out of the cells themselves. */
function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

export function readColumn(samples: string[]): ColumnReading | null {
  const values = samples.map((value) => value.trim()).filter((value) => value !== "" && !BLANKS.test(value));
  // One value is an anecdote. Two of the same shape is a column.
  if (values.length < 2) return null;
  const ratio = (test: (value: string) => boolean) => values.filter(test).length / values.length;

  // --- Unmistakable: the contents are the field ----------------------------

  if (ratio((value) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) > 0.6) {
    return { label: "Email", field: "contactEmail", type: "EMAIL" };
  }

  if (ratio((value) => /^(https?:\/\/|www\.)/i.test(value)) > 0.6) {
    // A column of Facebook pages is a Facebook column, not a website column —
    // and mapping it to `website` would tell the audit to go and read a login
    // page. Named after the host it actually points at.
    const hosts = values.map(hostOf).filter((host): host is string => host !== null);
    for (const social of SOCIAL_HOSTS) {
      if (hosts.filter((host) => social.pattern.test(host)).length / Math.max(1, hosts.length) > 0.6) {
        return { label: social.label, type: "URL" };
      }
    }
    return { label: "Website", field: "website", type: "URL" };
  }

  // Digits, spacing and the punctuation people put in phone numbers — and
  // enough digits that a price can't pass for one. A date is excluded by
  // shape rather than by digit count: "2026-01-04" is ten characters of digits
  // and separators, which is also a perfectly good description of 0244 987
  // 654, and a column of follow-up dates read as phone numbers would have been
  // mapped straight onto `contactPhone`.
  if (
    ratio(
      (value) =>
        /^[+(]?[\d][\d\s()\-.]{7,}$/.test(value) && value.replace(/\D/g, "").length >= 8 && !DATE_SHAPE.test(value),
    ) > 0.6
  ) {
    return { label: "Phone", field: "contactPhone", type: "PHONE" };
  }

  // --- A name only: the shape is clear, the meaning isn't ------------------

  if (ratio((value) => /^(yes|no|y|n|true|false|done|not done)$/i.test(value)) > 0.7) {
    return { label: "Yes / no", type: "BOOLEAN" };
  }

  if (ratio((value) => /^(gh₵|₵|\$|€|£|ngn|usd|ghs|eur|gbp)\s?[\d,.]+$|^[\d,.]+\s?(ghs|usd|ngn|eur|gbp|cedis?)$/i.test(value)) > 0.6) {
    return { label: "Amount", type: "CURRENCY" };
  }

  if (ratio((value) => !Number.isNaN(Date.parse(value)) && /\d{4}|\/|-/.test(value) && !/^-?[\d,. ]+$/.test(value)) > 0.7) {
    return { label: "Date", type: "DATE" };
  }

  if (ratio((value) => /^-?[\d,. ]+$/.test(value)) > 0.7) {
    return { label: "Number", type: "NUMBER" };
  }

  const averageLength = values.reduce((total, value) => total + value.length, 0) / values.length;
  // Free text: "Switched off", "No answer", "Waiting on us to send proposals".
  // The commonest unnamed column there is, and "Notes" beats "Column F" by a
  // distance.
  if (averageLength >= 18) return { label: "Notes", type: "LONG_TEXT" };

  // A handful of short values repeating is somebody's own vocabulary — a
  // stage, a channel, a yes/no with more than two answers. Nothing here knows
  // what to *call* that, so the column is named after what is in it and the
  // Owner corrects it on the review screen if it reads oddly. Still far better
  // than a column letter: "Sent / Pending" says what the column is for.
  const distinct = [...new Set(values.map((value) => value.toLowerCase()))];
  if (values.length >= 4 && distinct.length <= 3 && distinct.every((value) => value.length <= 14)) {
    return { label: distinct.map(titleCase).join(" / ").slice(0, 60), type: "SELECT" };
  }

  return null;
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
  let pendingBannerRow = -1;

  for (let index = 0; index < grid.rows.length; index += 1) {
    const filled = filledCount(grid.rows[index]);

    if (filled === 0) {
      if (start !== null) {
        raw.push({ start, end: index - 1, banner });
        start = null;
        banner = null;
      }
      // A heading is usually separated from its table by a blank row, so a
      // pending banner survives the gap — but only the gap. A title with six
      // empty rows under it is a title for the sheet, or a leftover; carrying
      // it down to whatever appears next names the wrong table after it.
      if (pendingBanner !== null && index - pendingBannerRow > MAX_GAP_ROWS + 1) pendingBanner = null;
      continue;
    }

    // A row with one filled cell and nothing started yet is a heading, not a table.
    if (filled === 1 && start === null) {
      pendingBanner = grid.rows[index].find((cell) => cell !== "") ?? null;
      pendingBannerRow = index;
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

/** How many cells in a row read as the *name* of a lead field rather than a value. */
function headerWordCount(row: string[]): number {
  return row.filter((cell) => cell !== "" && guessField(cell) !== "custom").length;
}

/**
 * What a cell is, roughly. Used only to tell a header row from the rows under
 * it: a header names an email column, it does not contain an email address.
 */
function cellKind(value: string): string {
  if (value === "") return "";
  if (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) return "email";
  if (/^(https?:\/\/|www\.)/i.test(value)) return "url";
  if (/^[+(]?\d[\d\s()\-.]{7,}$/.test(value) && !DATE_SHAPE.test(value)) return "phone";
  if (/^-?[\d,. ]+$/.test(value)) return "number";
  return "text";
}

/**
 * A row that is a table's headers rather than one of its leads.
 *
 * `looksLikeHeader` alone is a shape test — short, wordy, non-numeric — and a
 * row of short text values passes it, which is most rows of a lead sheet. Two
 * further things have to hold before a row is promoted to a header or read as
 * a boundary, because both of those decisions move a real lead:
 *
 *  - it **names** at least two lead fields ("Name", "Phone", "Email"), and
 *  - it **contains** none of them: no address with an @ in it, no URL, no run
 *    of digits long enough to be a telephone number.
 *
 * A row reading `Kofi Mensah | Accra | website design | referral` passes the
 * shape test and fails this one, which is the whole point — promoting it would
 * throw away a lead and rename every column after it.
 */
function namesColumns(row: string[]): boolean {
  const cells = row.filter((cell) => cell !== "");
  if (cells.length < 2 || !looksLikeHeader(row)) return false;
  if (cells.some((cell) => cellKind(cell) !== "text")) return false;
  return headerWordCount(row) >= 2;
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
    // Nothing named this column, so read what is in it — see `readColumn`.
    const reading = header ? null : readColumn(samples);
    let field = guessField(header);
    // A blank header matches no rule and lands in `custom`, which is how a
    // column of email addresses used to become a custom column on a lead with
    // no email address. The cells decide when the header says nothing.
    if (!header && reading?.field) field = reading.field;

    // One Lead scalar, one column. A second "Phone" is a real column of its
    // own, not an overwrite of the first.
    if (field !== "ignore" && field !== "custom" && claimed.has(field)) field = "custom";
    if (field !== "ignore" && field !== "custom") claimed.add(field);

    const label = header || reading?.label || `Column ${columnLetter(column)}`;
    const type =
      field !== "custom" && field !== "ignore"
        ? (builtinField(field)?.type ?? "TEXT")
        : (reading?.type ?? guessType(header, samples));

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
 * Where a segment's headers are, and what sits above them.
 *
 * The first row of a block is not automatically the header row, and treating
 * it as one is a boundary error that costs the whole table rather than a row
 * of it: a title spanning two or three cells — "ACCRA CLINICS", "Updated 3 Aug
 * 2026" — becomes the header, so every column is labelled from a title cell or
 * from nothing, and the *real* header row below it is imported as a lead
 * called "Name". `findBlocks` already lifts a title out when it fills exactly
 * one cell and stands above a blank row; this is the same idea for the titles
 * that do neither.
 *
 * A row is a title when it is narrow against the body of the table and the row
 * under it genuinely names columns. Up to two of them, because a heading and a
 * date underneath it is the commonest pair.
 */
function pickHeader(grid: SheetGrid, start: number, end: number): { headerRow: number | null; firstDataRow: number; banner: string | null } {
  const body = modalWidth(grid.rows.slice(start, Math.min(end, start + 12) + 1));
  let banner: string | null = null;
  let cursor = start;

  for (let step = 0; step < 2 && cursor < end; step += 1) {
    const filled = filledCount(grid.rows[cursor] ?? []);
    const below = grid.rows[cursor + 1] ?? [];
    const narrow = filled > 0 && filled * 2 <= body;
    if (!narrow || !namesColumns(below) || filledCount(below) * 2 < body) break;
    banner ??= grid.rows[cursor].find((cell) => cell !== "") ?? null;
    cursor += 1;
  }

  if (cursor <= end && looksLikeHeader(grid.rows[cursor] ?? [])) {
    return { headerRow: cursor, firstDataRow: cursor + 1, banner };
  }
  return { headerRow: null, firstDataRow: cursor, banner };
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
      // A header inside the block means a second table starts there — measured
      // against the block's *header* row rather than its first row. A block
      // opening on a two-cell title has a shape unlike anything under it, so
      // every header-ish row below it differed from it and the block shattered
      // into a table per section heading.
      const opening = pickHeader(grid, block.start, block.end);
      const anchor = opening.headerRow ?? opening.firstDataRow;
      const boundaries: number[] = [block.start];
      const firstShape = shapeOf(grid.rows[anchor] ?? []);
      for (let row = anchor + 2; row <= block.end; row += 1) {
        if (looksLikeHeader(grid.rows[row]) && shapeOf(grid.rows[row]) !== firstShape && !looksLikeHeader(grid.rows[row - 1])) {
          boundaries.push(row);
        }
      }

      for (const [segmentIndex, segmentStart] of boundaries.entries()) {
        const segmentEnd = segmentIndex + 1 < boundaries.length ? boundaries[segmentIndex + 1] - 1 : block.end;
        const picked = segmentIndex === 0 ? opening : pickHeader(grid, segmentStart, segmentEnd);
        const table = buildTable(
          grid,
          { ...block, banner: (segmentIndex === 0 ? block.banner : null) ?? picked.banner },
          picked.headerRow,
          picked.firstDataRow,
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
/** The top of a sheet, always shown whole — banners, headers and the first rows live there. */
const HEAD_ROWS = 60;
/** And the bottom, so the last data row can be placed exactly. */
const TAIL_ROWS = 15;
/** Rows either side of a landmark, so what it separates is visible too. */
const LANDMARK_CONTEXT = 2;
/** The most rows one sheet renders as. Past it, landmarks are thinned evenly. */
const MAX_RENDERED_ROWS = 340;

function renderRow(index: number, row: string[]): string {
  const cells = row.map((cell) => {
    const text = cell.length > CELL_PREVIEW_LENGTH ? `${cell.slice(0, CELL_PREVIEW_LENGTH)}…` : cell;
    return text.replace(/\s+/g, " ");
  });
  return `${String(index).padStart(4, " ")} | ${cells.join(" | ")}`;
}

/** The commonest filled-cell count in a range — what a row of this table looks like. */
function modalWidth(rows: string[][]): number {
  const counts = new Map<number, number>();
  for (const row of rows) {
    const filled = filledCount(row);
    if (filled) counts.set(filled, (counts.get(filled) ?? 0) + 1);
  }
  let width = 0;
  let seen = 0;
  for (const [candidate, count] of counts) {
    if (count > seen || (count === seen && candidate > width)) {
      width = candidate;
      seen = count;
    }
  }
  return width;
}

/**
 * A row that might be a boundary: the blank, the banner, the second set of
 * headers, the totals line. Everything a table could start or stop at.
 *
 * `body` is the sheet's own modal row width, and it is what keeps a
 * single-column list of names from reading as several hundred banners.
 */
function isLandmark(rows: string[][], index: number, body: number): boolean {
  const row = rows[index] ?? [];
  const filled = filledCount(row);
  if (filled === 0) return true;
  if (filled === 1 && body >= 3) return true;
  if (looksLikeHeader(row)) return true;
  return /^(total|subtotal|grand total|sum)\b/i.test(row.find((cell) => cell !== "") ?? "");
}

/** `count` of `values`, spread evenly across it, first and last always kept. */
function thin<T>(values: T[], count: number): T[] {
  if (count <= 0) return [];
  if (values.length <= count) return values;
  const step = (values.length - 1) / (count - 1 || 1);
  const kept: T[] = [];
  for (let index = 0; index < count; index += 1) kept.push(values[Math.round(index * step)]);
  return [...new Set(kept)];
}

/**
 * A sheet as text the analyst can read, with 0-based row numbers down the side
 * so the row indices it reports line up with the grid exactly.
 *
 * **The middle of a long sheet is not simply thrown away**, and that was the
 * single most expensive thing about this function. It used to render the first
 * 110 rows and the last 15: a second table starting at row 400 was invisible,
 * a table that ended at row 380 was invisible, and the analyst — asked for
 * exact boundaries — could only answer about the two ends of the file it had
 * been shown. So it reported one table running from the top to somewhere it
 * could see, and everything between was lost or merged. That is what "it
 * doesn't group them properly" looks like from the inside.
 *
 * So the rows that could *be* a boundary are kept wherever they sit: a blank
 * run, a banner across a row on its own, a second set of headers, a totals
 * line — each with a couple of rows either side so the analyst can see what it
 * separates. Only long runs of identical-looking data rows are elided, and the
 * count of what was elided is printed where it was.
 *
 * Costs more tokens than the two ends did, deliberately. A sheet is read once
 * per import and a wrong boundary costs an afternoon of cleanup.
 */
export function renderGrid(grid: SheetGrid): string {
  const rows = grid.rows;
  const lines: string[] = [
    `### Sheet "${grid.name}" — ${rows.length} rows (0-${Math.max(0, rows.length - 1)}), ${
      rows[0]?.length ?? 0
    } columns (${columnLetter(0)}-${columnLetter(Math.max(0, (rows[0]?.length ?? 1) - 1))})${
      grid.truncated ? `, truncated from ${grid.totalRows} rows` : ""
    }`,
  ];

  const keep = new Set<number>();
  for (let index = 0; index < Math.min(HEAD_ROWS, rows.length); index += 1) keep.add(index);
  for (let index = Math.max(0, rows.length - TAIL_ROWS); index < rows.length; index += 1) keep.add(index);

  const body = modalWidth(rows);
  const landmarks: number[] = [];
  for (let index = HEAD_ROWS; index < rows.length - TAIL_ROWS; index += 1) {
    if (isLandmark(rows, index, body)) landmarks.push(index);
  }

  const budget = Math.max(0, MAX_RENDERED_ROWS - keep.size);
  for (const index of thin(landmarks, Math.floor(budget / (1 + LANDMARK_CONTEXT * 2)))) {
    for (let near = index - LANDMARK_CONTEXT; near <= index + LANDMARK_CONTEXT; near += 1) {
      if (near >= 0 && near < rows.length) keep.add(near);
    }
  }

  let elided = 0;
  const flush = () => {
    if (elided) lines.push(`     … ${elided} more rows in the same shape …`);
    elided = 0;
  };
  for (let index = 0; index < rows.length; index += 1) {
    if (keep.has(index)) {
      flush();
      lines.push(renderRow(index, rows[index]));
    } else {
      elided += 1;
    }
  }
  flush();

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

// --- Grouping --------------------------------------------------------------

/** The plan's grouping, defaulting to one list per worksheet. */
export function groupingOf(plan: Pick<ImportPlan, "grouping">): PlanGrouping {
  return plan.grouping === "table" ? "table" : "sheet";
}

export interface PlanGroup {
  /** Stable across a resumed commit: the worksheet, or the table's own id. */
  key: string;
  /** Becomes the lead list's name. */
  title: string;
  /** The worksheet these came off. Every group is from exactly one. */
  sheet: string;
  tables: PlanTable[];
}

/**
 * The lead lists a plan will produce, in the plan's own order.
 *
 * Order is the plan's rather than the sheet's, so the review screen and the
 * commit agree about which list is which — and a plan whose tables run in
 * sheet order still reads each tab exactly once, which is what keeps a 39-tab
 * workbook affordable (see services/sheetSource.ts).
 *
 * A worksheet holding exactly one table keeps that table's own title, because
 * a banner the analyst read off the file ("Companies/Organizations") says more
 * than the tab name does. Two or more, and the tab name is what tells the
 * Owner where the list came from — which is the whole reason for merging them.
 */
export function planGroups(plan: ImportPlan, tables: PlanTable[] = plan.tables): PlanGroup[] {
  const grouping = groupingOf(plan);
  const groups: PlanGroup[] = [];
  const byKey = new Map<string, PlanGroup>();

  for (const table of tables) {
    const key = grouping === "sheet" ? `sheet:${table.sheet}` : `table:${table.id}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.tables.push(table);
      continue;
    }
    const group: PlanGroup = { key, title: table.title, sheet: table.sheet, tables: [table] };
    byKey.set(key, group);
    groups.push(group);
  }

  for (const group of groups) {
    if (group.tables.length > 1) group.title = group.sheet || group.title;
  }
  return groups;
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

/**
 * How much a column reads like a column of names.
 *
 * Only ever used to rescue a table nothing named — see `normalizePlan`. It is
 * a preference between bad options, not a classifier: a number, an address, a
 * date or a one-word status is not a name, and anything left over is better
 * than dropping every row in the table.
 */
function nameishness(samples: string[]): number {
  const values = samples.filter(Boolean);
  if (!values.length) return 0;
  const nameish = values.filter(
    (value) =>
      /[a-z]/i.test(value) &&
      !/^-?[\d,. ]+$/.test(value) &&
      !/^[^\s@]+@[^\s@]+$/.test(value) &&
      !/^https?:\/\/|^www\./i.test(value) &&
      !/^[+()\d][\d\s()\-.]{6,}$/.test(value) &&
      value.length <= 80,
  );
  return nameish.length / values.length;
}

/** The least-bad column to call a lead by, when the plan named none. */
function bestNameColumn(columns: PlanColumn[], grid: SheetGrid, firstDataRow: number, lastDataRow: number): PlanColumn | undefined {
  const candidates = columns.filter((column) => column.field === "custom");
  if (!candidates.length) return undefined;

  const rows = grid.rows.slice(firstDataRow, Math.min(lastDataRow, grid.rows.length - 1) + 1).slice(0, 40);
  let best: { column: PlanColumn; score: number } | null = null;
  for (const column of candidates) {
    const score = nameishness(rows.map((row) => row[column.index] ?? ""));
    // Strictly greater, so a tie keeps the leftmost — which is where a name
    // usually is once the row numbers have been excluded.
    if (!best || score > best.score) best = { column, score };
  }
  return best && best.score > 0 ? best.column : candidates[0];
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
      // The rows this table covers, for columns nobody named. Every plan comes
      // through here — the analyst's, the rules', and the one the review
      // screen sends back — and only this one had no way to look at the cells.
      const sampleRows = grid.rows.slice(firstDataRow, lastDataRow + 1).slice(0, 40);
      const columns = (table.columns ?? [])
        .filter((column) => Number.isInteger(column.index) && column.index >= 0 && column.index < width)
        .map((column): PlanColumn => {
          const header = (column.header ?? "").trim();
          const named = (column.label ?? "").trim();
          // Only when *nothing* has named it. A label the analyst wrote or the
          // Owner typed is a decision, and reading the cells over the top of
          // one would undo work somebody just did by hand.
          const reading = header || named ? null : readColumn(sampleRows.map((row) => row[column.index] ?? ""));

          let field = VALID_FIELDS.has(column.field) ? column.field : "custom";
          if (field === "custom" && reading?.field && VALID_FIELDS.has(reading.field)) field = reading.field;
          if (field !== "custom" && field !== "ignore") {
            if (claimed.has(field)) field = "custom";
            else claimed.add(field);
          }

          const label = (named || header || reading?.label || `Column ${columnLetter(column.index)}`).trim().slice(0, 60);
          let key: string | undefined;
          if (field === "custom") {
            key = slugifyKey(column.key || label);
            // Two "Notes" columns in one table would otherwise overwrite each other.
            let suffix = 2;
            while (keys.has(key)) key = `${slugifyKey(column.key || label)}_${suffix++}`;
            keys.add(key);
          }

          const chosen = (["TEXT", "LONG_TEXT", "NUMBER", "CURRENCY", "DATE", "BOOLEAN", "EMAIL", "PHONE", "URL", "SELECT"] as const).includes(
            column.type,
          )
            ? column.type
            : "TEXT";
          const type =
            field !== "custom" && field !== "ignore"
              ? (builtinField(field)?.type ?? "TEXT")
              // TEXT on an unnamed column is the default nobody chose, so the
              // reading wins over it; any other type was somebody's decision.
              : reading && chosen === "TEXT"
                ? reading.type
                : chosen;

          return { index: column.index, header: column.header ?? "", label, field, key, type };
        });

      if (!columns.some((column) => column.field === "contactName")) {
        const company = columns.find((column) => column.field === "companyName");
        // Every lead needs a name; a company sheet's company column is its name.
        if (company) columns.unshift({ ...company, field: "contactName", label: "Name" });
        else {
          // Nothing here is a name, so `extractRows` would drop **every row in
          // this table** and the Owner would see a group with nothing in it and
          // no reason given. `buildTable` has always rescued this case; the
          // analyst's own plans went through here instead and did not, so a
          // table the model mapped entirely to custom columns — the exact shape
          // a fragment left behind when it lost the header above it — arrived
          // as an empty group beside two full ones.
          //
          // Chosen by looking at the cells, not by taking the first column
          // going. The leftmost column of a lead sheet is very often S/N, and
          // a rescue that grabs it names four leads "1", "2", "4" and "5" —
          // technically saved, and useless to the person who then has to work
          // out who they are. `nameishness` reads the rows the table actually
          // covers and prefers the one that looks like names.
          const candidate = bestNameColumn(columns, grid, firstDataRow, lastDataRow);
          if (candidate) {
            candidate.field = "contactName";
            candidate.label = "Name";
            candidate.type = "TEXT";
            delete candidate.key;
          }
        }
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

  return { tables, summary: (plan.summary ?? "").slice(0, 2000), grouping: groupingOf(plan) };
}

// --- Repairing an analyst's plan -------------------------------------------

/**
 * The ways a model gets a plan structurally wrong, undone in code.
 *
 * `normalizePlan` clamps a plan to something that *can* be run — real indices,
 * known field targets, unique keys. It says nothing about whether the plan
 * makes sense, and it was the only thing standing between the analyst and the
 * pipeline. That was survivable while one model read every sheet and read them
 * well. It stopped being survivable the moment reading sheets became a routed
 * job like any other, because the honest position on a routed job is that the
 * next model to serve it is one nobody here has tried.
 *
 * So the boundaries the prompt asks for are checked against the grid rather
 * than trusted, and the mistakes it warns about loudest are repaired:
 *
 * - **A table split at a blank row.** The prompt calls this "the most damaging
 *   mistake available to you" and it is not overstating it. The fragment sits
 *   below the header, so it has no header, so every column in it is unnamed,
 *   so nothing in it is a name — and `extractRows` drops a row it cannot name.
 *   The Owner gets an empty group with no reason given, beside a full group
 *   that stops halfway down their file. Two of five leads, gone quietly. That
 *   is the shape of "it doesn't group them properly".
 * - **A table that stops halfway down the sheet.** The other half of the same
 *   complaint, and until Aug 2026 nothing fixed it: a table the analyst simply
 *   truncated has no second fragment to be joined to, so `uncoveredRows`
 *   noticed the loss and only ever said so. `extendedEnd` runs it on while the
 *   rows below still look like its own, and stops dead at the first sign of
 *   anything new.
 * - **A title read as the header row.** Costs every column in the table rather
 *   than a row of it: the columns are named after cells of the title, and the
 *   real header row is imported as a lead called "Name". Repaired *and*
 *   relabelled — moving the row alone would fix the count and leave the names.
 * - **Two tables claiming the same rows.** The opposite failure and the worse
 *   one, because it does not look like a failure: the same business is written
 *   into two groups, scored twice, and written to twice.
 *
 * Every repair is **reported**, never silent. A plan quietly corrected is a
 * plan nobody checks, and the review screen exists precisely so that somebody
 * looks before anything is written.
 *
 * Deliberately not run on a plan that came back *from* the review screen. A
 * person who splits a table there has decided to split it, and an "obvious"
 * correction that undoes what somebody just did by hand is the worst thing
 * this function could do.
 */
export interface PlanRepair {
  plan: ImportPlan;
  /** One sentence per repair, for the summary the Owner reads. */
  repairs: string[];
}

/** Blank rows only — a gap with anything in it belongs to somebody. */
function gapIsBlank(grid: SheetGrid, from: number, to: number): boolean {
  for (let index = from; index <= to; index += 1) {
    if (filledCount(grid.rows[index] ?? [])) return false;
  }
  return true;
}

/**
 * The signature of one table cut in half, as opposed to two real tables.
 *
 * A genuine second table announces itself — its own header row, or a banner
 * the analyst read as a different title. A fragment has neither: it sits a
 * blank row or two below the first, has no header of its own, and fills the
 * same columns. All three have to hold, because merging two real tables is as
 * damaging as splitting one.
 */
function isContinuationOf(grid: SheetGrid, earlier: PlanTable, later: PlanTable): boolean {
  if (later.headerRow !== null) return false;
  const gap = later.firstDataRow - earlier.lastDataRow - 1;
  if (gap < 0 || gap > MAX_GAP_ROWS) return false;
  if (gap > 0 && !gapIsBlank(grid, earlier.lastDataRow + 1, later.firstDataRow - 1)) return false;
  const earlierColumns = footprint(grid, earlier.firstDataRow, earlier.lastDataRow);
  const laterColumns = footprint(grid, later.firstDataRow, later.lastDataRow);
  return columnOverlap(earlierColumns, laterColumns) >= 0.8;
}

/** How many non-blank rows in a range no table covers. */
function uncoveredRows(grid: SheetGrid, range: { firstDataRow: number; lastDataRow: number }, covered: PlanTable[]): number {
  let count = 0;
  for (let row = Math.max(0, range.firstDataRow); row <= Math.min(range.lastDataRow, grid.rows.length - 1); row += 1) {
    if (!filledCount(grid.rows[row] ?? [])) continue;
    if (covered.some((table) => row >= table.firstDataRow && row <= table.lastDataRow)) continue;
    count += 1;
  }
  return count;
}

/** Below this, an uncovered row is a totals line or a note to self, not a lost lead. */
const UNCOVERED_ROWS_WORTH_SAYING = 3;

/**
 * The row a table's headers are really on, when the one it named is a title.
 *
 * The same mistake `pickHeader` guards the rules against, arriving from the
 * other direction: the analyst reads "ACCRA CLINICS — AUGUST" in row 4 as the
 * header, so every column is labelled off a title cell, the real header in row
 * 5 is imported as a lead called "Name", and the whole table lands with the
 * wrong column mapping. Cheap to detect and worth the whole table.
 *
 * Returns null unless the named header is narrow against the body *and* the
 * row under it genuinely names columns — see `namesColumns`.
 */
function headerBelow(grid: SheetGrid, table: PlanTable): number | null {
  if (table.headerRow === null) return null;
  const named = grid.rows[table.headerRow] ?? [];
  const below = grid.rows[table.headerRow + 1];
  if (!below) return null;
  const body = modalWidth(grid.rows.slice(table.firstDataRow, Math.min(table.lastDataRow, table.firstDataRow + 12) + 1));
  const filled = filledCount(named);
  if (!filled || filled * 2 > body) return null;
  if (!namesColumns(below) || filledCount(below) * 2 < body) return null;
  return table.headerRow + 1;
}

/**
 * How far a table really runs, when it was reported as stopping short.
 *
 * The commonest complaint about an import is that a list came in and stopped
 * halfway down the file, and until now nothing fixed it: `isContinuationOf`
 * joins two *reported* tables back together, and a table the analyst simply
 * truncated has no second half to join to. `uncoveredRows` noticed the loss and
 * only ever said so, which is a sentence in a summary about several thousand
 * leads that are not there.
 *
 * So the rows below a table are walked, and it runs on while they still look
 * like its own. It stops — deliberately, at the first one — on anything that
 * announces something new: a row claimed by another table, a banner on a row of
 * its own, a row that names columns, a totals line, a run of blanks longer than
 * a gap, or a row filling different columns. Merging two real tables is as
 * damaging as splitting one, so every one of those is a hard stop rather than a
 * score to weigh up.
 */
function extendedEnd(grid: SheetGrid, table: PlanTable, claimed: (row: number) => boolean): number {
  const own = footprint(grid, table.firstDataRow, table.lastDataRow);
  if (!own.size) return table.lastDataRow;
  const kinds = columnKinds(grid, table);

  let end = table.lastDataRow;
  let gap = 0;
  for (let row = table.lastDataRow + 1; row < grid.rows.length; row += 1) {
    if (claimed(row)) break;
    const cells = grid.rows[row] ?? [];
    const filled = filledCount(cells);
    if (filled === 0) {
      gap += 1;
      if (gap > MAX_GAP_ROWS) break;
      continue;
    }
    if (filled === 1) break;
    if (namesColumns(cells)) break;
    if (/^(total|subtotal|grand total|sum)\b/i.test(cells.find((cell) => cell !== "") ?? "")) break;
    if (columnOverlap(own, footprint(grid, row, row)) < 0.8) break;
    if (conflictsWithKinds(kinds, cells)) break;
    gap = 0;
    end = row;
  }
  return end;
}

/**
 * What each of a table's columns holds, where the answer is unambiguous.
 *
 * Only email, URL, phone and number are recorded — those are the four a header
 * cell can never be mistaken for. A column of ordinary text tells you nothing
 * about the row below, so it is left out rather than guessed at.
 */
function columnKinds(grid: SheetGrid, table: PlanTable): Map<number, string> {
  const kinds = new Map<number, string>();
  const rows = grid.rows.slice(table.firstDataRow, Math.min(table.lastDataRow, table.firstDataRow + 20) + 1);
  for (const column of table.columns) {
    const values = rows.map((row) => row[column.index] ?? "").filter((value) => value !== "");
    if (values.length < 3) continue;
    const first = cellKind(values[0]);
    if (first === "text" || first === "") continue;
    if (values.filter((value) => cellKind(value) === first).length / values.length > 0.8) kinds.set(column.index, first);
  }
  return kinds;
}

/**
 * True when a row cannot belong to a table with these columns.
 *
 * This is what tells a second table's header row from another lead: the word
 * "Email" sitting in a column that has held nothing but email addresses for
 * two hundred rows is a header, whatever else it looks like. Used only to stop
 * `extendedEnd` running one table into the next.
 */
function conflictsWithKinds(kinds: Map<number, string>, row: string[]): boolean {
  if (!kinds.size) return false;
  for (const [index, kind] of kinds) {
    const value = row[index] ?? "";
    if (value !== "" && cellKind(value) !== kind) return true;
  }
  return false;
}

/**
 * Re-reads a table's column names off the row that really holds them.
 *
 * `normalizePlan` labels a column from the `header` and `label` already on the
 * plan, never from the grid — so moving `headerRow` alone would correct where
 * the data starts and leave every column still named after a cell of the
 * table's title. The whole point of finding the right header row is the names
 * on it.
 */
function relabelFromHeader(grid: SheetGrid, table: PlanTable, headerRow: number): void {
  const cells = grid.rows[headerRow] ?? [];
  const rows = grid.rows.slice(headerRow + 1, Math.min(table.lastDataRow, headerRow + 40) + 1);

  table.columns = table.columns.map((column) => {
    const header = (cells[column.index] ?? "").trim();
    if (!header) return { ...column, header: "" };
    const field = guessField(header);
    const builtin = field !== "custom" && field !== "ignore" ? builtinField(field) : undefined;
    return {
      index: column.index,
      header,
      label: builtin?.label ?? header,
      field,
      key: field === "custom" ? slugifyKey(header) : undefined,
      type: builtin?.type ?? guessType(header, rows.map((row) => row[column.index] ?? "")),
    };
  });
}

/**
 * Runs the repairs over an analyst's plan and says what it changed.
 *
 * Normalised on the way in so the repairs can trust the indices, and again on
 * the way out so a merged table's columns are re-deduped and its column range
 * recomputed against what it now covers.
 *
 * `hints` is the pattern rules' own reading of the same file. It is not a
 * second opinion to average with — it is the only independent evidence there
 * is about where the data actually sits, and it is used for exactly one thing:
 * noticing rows the analyst left out of every table.
 */
export function repairPlan(plan: ImportPlan, grids: SheetGrid[], hints: PlanTable[] = []): PlanRepair {
  const byName = new Map(grids.map((grid) => [grid.name, grid]));
  const repairs: string[] = [];
  const kept: PlanTable[] = [];

  const normalized = normalizePlan(plan, grids);

  // Per sheet, in the order the rows appear — every rule below is about a
  // table and the one above it, which is meaningless in any other order.
  const sheets = new Map<string, PlanTable[]>();
  for (const table of normalized.tables) {
    const list = sheets.get(table.sheet) ?? [];
    list.push(table);
    sheets.set(table.sheet, list);
  }

  for (const [sheet, tables] of sheets) {
    const grid = byName.get(sheet);
    if (!grid) {
      kept.push(...tables);
      continue;
    }

    tables.sort((a, b) => a.firstDataRow - b.firstDataRow || a.lastDataRow - b.lastDataRow);
    const merged: PlanTable[] = [];

    for (const [index, table] of tables.entries()) {
      const previous = merged[merged.length - 1];

      // A header row counted as data is an off-by-one that costs a row:
      // `isNoiseRow` catches the repeated header and reports it as skipped,
      // which reads to the Owner as a lead that was thrown away.
      if (table.headerRow !== null && table.headerRow >= table.firstDataRow && table.headerRow <= table.lastDataRow) {
        repairs.push(`"${table.title}" counted its own header row as data — started it at row ${table.headerRow + 1} instead.`);
        table.firstDataRow = table.headerRow + 1;
      }

      // A title read as the header row. Costs every column in the table, so it
      // is checked before anything that depends on where the data starts.
      const realHeader = headerBelow(grid, table);
      if (realHeader !== null) {
        repairs.push(
          `"${table.title}" read row ${table.headerRow! + 1} as its column headers, but that row is the table's title — row ${realHeader + 1} names the columns, so the data starts at row ${realHeader + 2}.`,
        );
        table.headerRow = realHeader;
        table.firstDataRow = Math.max(table.firstDataRow, realHeader + 1);
        relabelFromHeader(grid, table, realHeader);
      }

      if (previous && isContinuationOf(grid, previous, table)) {
        repairs.push(
          `"${table.title}" was "${previous.title}" split at a blank row — joined back together as rows ${previous.firstDataRow}-${table.lastDataRow}.`,
        );
        previous.lastDataRow = Math.max(previous.lastDataRow, table.lastDataRow);
        continue;
      }

      if (previous && table.firstDataRow <= previous.lastDataRow) {
        const from = previous.lastDataRow + 1;
        if (from > table.lastDataRow) {
          repairs.push(`"${table.title}" covered rows "${previous.title}" already had — dropped rather than import the same leads twice.`);
          continue;
        }
        repairs.push(`"${table.title}" overlapped "${previous.title}" — started it at row ${from} so no lead is imported twice.`);
        table.firstDataRow = from;
      }

      if (table.firstDataRow > table.lastDataRow) {
        repairs.push(`"${table.title}" had no rows left in it and was dropped.`);
        continue;
      }

      // A table reported as stopping short of where its own rows stop. Checked
      // against every table *below* it in the plan, so running on can never
      // reach a row somebody else already has.
      const later = tables.slice(index + 1);
      const runsOnTo = extendedEnd(grid, table, (row) =>
        later.some((other) => row >= other.firstDataRow && row <= other.lastDataRow),
      );
      if (runsOnTo > table.lastDataRow) {
        let gained = 0;
        for (let row = table.lastDataRow + 1; row <= runsOnTo; row += 1) if (filledCount(grid.rows[row] ?? [])) gained += 1;
        repairs.push(
          `"${table.title}" stopped at row ${table.lastDataRow + 1}, but the same columns carry on to row ${runsOnTo + 1} — ran it on so those ${gained} row${gained === 1 ? "" : "s"} aren't left behind.`,
        );
        table.lastDataRow = runsOnTo;
      }

      merged.push(table);
    }

    // What the rules read as leads and the analyst put in no table at all.
    // Said, never acted on: the rules are wrong about a messy file often
    // enough that silently re-adding their rows would be the analyst's job
    // undone by the thing it was brought in to beat.
    for (const hint of hints.filter((entry) => entry.sheet === sheet)) {
      const missed = uncoveredRows(grid, hint, merged);
      if (missed >= UNCOVERED_ROWS_WORTH_SAYING) {
        repairs.push(
          `${missed} rows between ${hint.firstDataRow} and ${hint.lastDataRow} on "${sheet}" are in no table — check the boundaries before importing.`,
        );
      }
    }

    kept.push(...merged);
  }

  const summary = repairs.length
    ? `${normalized.summary}\n\nCorrected before review: ${repairs.join(" ")}`.trim()
    : normalized.summary;
  return { plan: normalizePlan({ tables: kept, summary, grouping: normalized.grouping }, grids), repairs };
}
