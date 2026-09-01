/**
 * The sheet analyst.
 *
 * Reading a lead sheet is a judgement job, not a parsing job. The file that
 * arrives has a banner across row 4, a header on row 6, a second table of
 * organisations starting on row 90 with different columns, one column whose
 * header is blank but whose cells all read "Switched off", and a phone number
 * that Excel helpfully turned into 2.56742E+11. A person can see all of that in
 * two seconds; a fixed parser can't see any of it.
 *
 * So the grid goes to whoever serves the `spreadsheet` job — NVIDIA by
 * default — and what comes back is a plan: every table it found, where each
 * one starts and stops, and what each column means. The plan is data, not an
 * action; it goes to the Owner for review before a lead is written.
 *
 * **The plan is checked against the grid before anybody sees it.** Reading a
 * sheet became a routed job in Aug 2026, and the honest position on a routed
 * job is that the next model to serve it is one nobody here has tried — so
 * `repairPlan` in services/sheetPlan.ts undoes the two structural mistakes
 * this prompt warns about loudest, and says in the summary what it changed.
 *
 * With no model connected the caller falls back to the pattern rules in
 * services/sheetPlan.ts, which handle a tidy sheet fine — and, on a sheet with
 * a blank row in the middle of a table, better than a plan nobody checked.
 */

import { callModel } from "./models/call.js";
import { BUILTIN_FIELDS, LEAD_SOURCES, LEAD_STATUSES } from "../services/leadFields.js";
import { LEAD_FIELD_TYPES } from "../services/leadFields.js";
import type { ImportPlan } from "../services/sheetPlan.js";
import type { SheetGrid } from "../services/spreadsheet.js";
import { renderGrid, renderHints } from "../services/sheetPlan.js";
import type { PlanTable } from "../services/sheetPlan.js";

// The client, the error type and the key live in lib/claude.ts now that three
// features share them. Re-exported because five call sites import them from
// here and the paths aren't worth churning.
export { AnalystError, analystKey, analystConfigured, verifyKey } from "./claude.js";

// --- The output contract ---------------------------------------------------

const FIELD_TARGETS = [...BUILTIN_FIELDS.filter((field) => field.writable).map((field) => field.key), "custom", "ignore"];

/**
 * Structured outputs, so the plan comes back as data rather than as prose with
 * JSON somewhere inside it. Every object is closed (`additionalProperties:
 * false`) and fully `required` — the API's schema support needs both.
 */
const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "tables"],
  properties: {
    summary: {
      type: "string",
      description:
        "Two or three sentences for the person reviewing this: what the file contains, how many separate tables you found, and anything you were unsure about.",
    },
    tables: {
      type: "array",
      description: "One entry per distinct table of leads. A file with a people table and a companies table has two entries.",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "sheet",
          "title",
          "headerRow",
          "firstDataRow",
          "lastDataRow",
          "leadSource",
          "status",
          "confidence",
          "notes",
          "columns",
        ],
        properties: {
          sheet: { type: "string", description: "The sheet name this table is on, exactly as given." },
          title: {
            type: "string",
            description:
              "What to call this group of leads. Prefer a banner or heading that sits above the table in the file ('Companies/Organizations'); otherwise describe it ('Accra clinics').",
          },
          headerRow: {
            // An integer rather than a nullable one: union types are the kind
            // of schema the structured-outputs compiler is fussiest about, and
            // a sentinel costs nothing (normalizePlan reads < 0 as "none").
            type: "integer",
            description: "0-based index of the row holding this table's column headers. Use -1 when the table has no header row.",
          },
          firstDataRow: { type: "integer", description: "0-based index of the first row of actual data." },
          lastDataRow: { type: "integer", description: "0-based index of the last row of actual data, inclusive." },
          leadSource: { type: "string", enum: [...LEAD_SOURCES] },
          status: { type: "string", enum: [...LEAD_STATUSES] },
          confidence: { type: "number", description: "0 to 1 — how sure you are this block is a table of leads." },
          notes: {
            type: "string",
            description: "Anything the reviewer should check: guessed boundaries, mixed data, rows you deliberately excluded.",
          },
          columns: {
            type: "array",
            description: "Every column this table uses. Include all of them — nothing in the sheet should be silently dropped.",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["index", "header", "label", "field", "type"],
              properties: {
                index: { type: "integer", description: "0-based column index in the grid." },
                header: { type: "string", description: "The header cell exactly as it reads, or an empty string." },
                label: {
                  type: "string",
                  description:
                    "What to call this column in Dakyworld OS. For an unlabelled column, name it from what its cells contain.",
                },
                field: {
                  type: "string",
                  enum: FIELD_TARGETS,
                  description:
                    "Which lead field this column fills. Use 'custom' to keep it as its own new column, 'ignore' only for row numbers and blank filler.",
                },
                type: { type: "string", enum: [...LEAD_FIELD_TYPES] },
              },
            },
          },
        },
      },
    },
  },
} as const;

// --- Prompt ----------------------------------------------------------------

const SYSTEM_PROMPT = `You map spreadsheets of sales leads into a CRM.

You are given the raw cells of one or more sheets, with 0-based row numbers down the left. Return a plan describing every table of leads in the file. You do not import anything; a person reviews your plan first, so flag what you are unsure about rather than guessing silently.

What matters:

1. **One file often holds several tables.** What starts a new one is a heading spanning a row on its own ("Companies/Organizations"), or a fresh set of headers part-way down — not a blank row by itself. Tables in the same file routinely have different columns from each other. Report each as its own entry — never merge them, and never force a later table's columns onto the first table's headers.
2. **Blank rows inside a table are normal and do not end it.** A deleted row, a spacer, a numbering gap where S/N jumps from 4 to 6 or 23 to 25 — none of these are boundaries. Run the table on to the last row that still fits its columns. Splitting one table at a blank row is the most damaging mistake available to you here: the fragments lose the header above the first one, and every column in them becomes unnamed.
3. **A long sheet is shown to you with its uniform stretches folded up.** A line reading "… 412 more rows in the same shape …" stands for 412 rows that carry on exactly as the rows around it do. It is **not** a boundary and a table must never be ended at one — the row numbers on either side of it are real, so a table running across one runs from the number above it to the number below. Everything that could actually be a boundary — a blank row, a heading on a row of its own, a second set of headers, a totals line — is printed in full wherever it sits, so a table's real end is always visible.
4. **Boundaries are what you are really being asked for.** headerRow, firstDataRow and lastDataRow must be exact 0-based indices into the grid you were shown (headerRow is -1 when the table has none). Do not include the header row in the data range. Do not include banner rows, totals rows or notes-to-self rows. **A title is not a header row**: a row holding one or two cells of prose over a wider row of short column names is the table's title, so headerRow is the wider row below it and the title belongs in the title field. Reading the title as the header names every column after a cell of it and imports the real header row as a lead.
5. **Keep every column.** Map to a built-in field where one genuinely fits; otherwise set field to "custom" and give it a clear label — that keeps the column instead of losing it. Only two things earn "ignore": row-number columns (S/N, #, No.) and columns that are entirely empty.
6. **One built-in field per table.** If a table has two phone columns, the first is contactPhone and the second is custom (label it "Alternate phone"). The same goes for a second email or a second address.
7. **Unlabelled columns still mean something.** A column with no header whose cells read "Switched off", "No answer", "Wrong number" is a call-outcome column: label it from its contents and mark it custom.
8. **Every table needs exactly one contactName column, and this is not advisory.** A row that cannot be named is dropped on import, so a table with no contactName in it imports as an empty group — every lead in it lost, silently. For a table of companies the company-name column is both: map it to contactName, and add a second column entry with the same index mapped to companyName where the table also carries a contact person.
9. **No two tables may claim the same row.** Ranges never overlap, and a row belongs to exactly one table. Reporting one table twice, or reporting a whole table and then part of it again, writes the same business into two groups — it is scored twice and written to twice.
10. If a block is clearly not leads — a legend, a summary, a pivot of counts — leave it out and say so in the summary.`;

function userPrompt(grids: SheetGrid[], hints: PlanTable[]): string {
  const sheets = grids.map(renderGrid).join("\n\n");
  return `Here is the file.

${sheets}

A simple pattern-matcher read it as follows. It is often wrong about where tables start and stop, and it cannot read banners or unlabelled columns — correct it where it is wrong, and use it only as a starting point:

${renderHints(hints)}

Return the plan.`;
}

// --- Call ------------------------------------------------------------------

export interface AnalysisResult {
  plan: ImportPlan;
  /** Who answered, in their own words — "z-ai/glm-5.3-flash", "claude-opus-5". */
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Set when somebody other than the first choice read the sheet, and why. */
  note: string | null;
}

/**
 * Sends the grids to whoever serves the `spreadsheet` job — NVIDIA by
 * default, Claude standing in behind it — and returns the plan produced.
 * Throws AnalystError on anything the caller should show the Owner — no model
 * connected, a refusal, a response that didn't parse — so the import route can
 * fall back to the pattern rules with an explanation rather than failing
 * outright.
 */
export async function analyzeGrids(grids: SheetGrid[], hints: PlanTable[]): Promise<AnalysisResult> {
  const result = await callModel<ImportPlan>({
    purpose: "sheet.analyse",
    job: "spreadsheet",
    system: SYSTEM_PROMPT,
    prompt: () => userPrompt(grids, hints),
    schema: PLAN_SCHEMA as unknown as Record<string, unknown>,
    // A sheet is read once, not per row, and a wrong table boundary costs an
    // afternoon of cleanup — this is not the place to save thinking.
    effort: "high",
    maxTokens: 16000,
    messages: {
      noKey: "No model is connected for reading sheets. Add an NVIDIA, Claude or Gemini key under Settings → AI models.",
      rate: "The model provider is rate-limiting this key. Try the import again in a minute.",
      refusal: "The analyst declined to read this file. Check the review screen and map the columns by hand.",
      empty: "The analyst returned nothing. Try again, or map the columns by hand.",
      truncated: "This file is too large for the analyst to plan in one pass. Import fewer sheets at a time, or map the columns by hand.",
      parse: "The analyst's plan could not be read. Try again, or map the columns by hand.",
    },
  });

  return {
    plan: result.data,
    model: result.model,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    note: result.fallbackNote,
  };
}
