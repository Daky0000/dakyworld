/**
 * Does a lead sheet actually get read properly on the model serving it?
 *
 * Reading an imported spreadsheet was the one judgement job in this app still
 * hard-wired to Claude through its own private call path. Making it a routed
 * job like every other was right, and it moved the work onto a model nobody
 * here had read a sheet with — which is fine, and is exactly why the two
 * halves below both need pinning.
 *
 * **The wire.** `models/call.ts` sent no `reasoning_effort` at all, so every
 * routed job rode at the model's own default of max — triage included, which
 * asks for `low` in so many words and runs once per *arriving* message. And
 * `max_tokens` caps reasoning *plus* reply on an OpenAI-shaped wire, so the
 * analyst's 16,000 could be spent thinking before a character of the plan was
 * written; what came back was an empty message with `finish_reason: "length"`,
 * which this layer reads — correctly — as "produced nothing usable" and hands
 * to somebody else. The Owner paid for the reasoning, waited for it, and got
 * Claude's answer or the pattern rules. Asserted on the request body, because
 * a perfectly correct `reasoningEffortFor()` that nothing calls is precisely
 * the defect being fixed.
 *
 * **The plan.** `normalizePlan` clamps a plan to something that *can* be run
 * and says nothing about whether it makes sense, and it was the only thing
 * between the analyst and the pipeline. The failure that reaches a person is
 * quiet: a table split at a blank row loses the header above it, so every
 * column in the fragment is unnamed, so nothing in it is a name, so
 * `extractRows` drops every row — an empty group beside a full one that stops
 * halfway down their file. `repairPlan` undoes that, and the negatives here
 * matter more than the positives:
 *
 *   - **Two real tables must not be merged.** A rule that joins anything
 *     adjacent would turn a people table and a companies table into one group
 *     with the wrong columns, which is worse than the split it was fixing.
 *   - **A plan from the review screen is never repaired.** A person who splits
 *     a table by hand has decided to split it.
 *   - **A row must never be imported twice**, however the boundaries arrive.
 *
 * A database, a fake OpenRouter and a fake Anthropic on localhost. No API key
 * and no network.
 *   npx tsx checks/sheetAnalyst.ts
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PROVIDERS } from "../src/lib/models/registry.js";

/**
 * Whatever the OpenRouter default is today, read rather than typed.
 *
 * This check used to name `stealth/ox-alpha` in seven places. OpenRouter
 * retired that stealth listing without notice on 26 Aug 2026 and the check
 * failed on the swap itself — not on anything being wrong — which teaches
 * whoever sees it to edit the assertion rather than read it.
 *
 * What is under test here is the *code path*, not the model: the stub
 * catalogue below declares this id with `response_format` and without
 * `structured_outputs`, and the question is what this app then puts on the
 * wire. What the real model declares is read from OpenRouter's live catalogue
 * at run time and is none of this file's business.
 */
const SHIPPED = PROVIDERS.openrouter.defaultModel;

const failures: string[] = [];
let passed = 0;

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed += 1;
    console.log(`  ok    ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function httpServer(
  handle: (body: any, send: (status: number, payload: unknown) => void, path: string) => void,
): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        let parsed: any = {};
        try {
          parsed = JSON.parse(raw || "{}");
        } catch {
          parsed = {};
        }
        handle(parsed, (status, payload) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(payload));
        }, req.url ?? "");
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

/**
 * The sheet the analyst prompt describes, in miniature: a banner, a header, a
 * blank spacer *inside* the people table with a numbering gap across it, then
 * a second table of companies with entirely different columns.
 */
const ROWS: string[][] = [
  ["Accra clinics — Q3", "", "", ""],
  ["", "", "", ""],
  ["S/N", "Name", "Phone", ""],
  ["1", "Kofi Mensah", "0244000001", "Switched off"],
  ["2", "Ama Boateng", "0244000002", "No answer"],
  ["", "", "", ""],
  ["4", "Yaw Owusu", "0244000004", "Wrong number"],
  ["5", "Esi Darko", "0244000005", ""],
  ["", "", "", ""],
  ["Companies/Organizations", "", "", ""],
  ["Organisation", "Website", "Contact person", "Email"],
  ["Bluebird Ltd", "bluebird.com", "Nii Armah", "nii@bluebird.com"],
  ["Cedar Foods", "cedarfoods.gh", "Adjoa Sey", "adjoa@cedarfoods.gh"],
];
const GRID = { name: "Sheet1", rows: ROWS, totalRows: ROWS.length, truncated: false };

/** The people table, correctly read: header on 2, data 3-7 inclusive. */
const PEOPLE = {
  sheet: "Sheet1",
  title: "Accra clinics — Q3",
  headerRow: 2,
  firstDataRow: 3,
  lastDataRow: 7,
  leadSource: "DIRECTORY",
  status: "NEW",
  confidence: 0.9,
  notes: "",
  columns: [
    { index: 0, header: "S/N", label: "S/N", field: "ignore", type: "TEXT" },
    { index: 1, header: "Name", label: "Name", field: "contactName", type: "TEXT" },
    { index: 2, header: "Phone", label: "Phone", field: "contactPhone", type: "PHONE" },
    { index: 3, header: "", label: "Call outcome", field: "custom", type: "TEXT" },
  ],
};

/** The companies table — a genuinely different table, and it must survive as one. */
const COMPANIES = {
  sheet: "Sheet1",
  title: "Companies/Organizations",
  headerRow: 10,
  firstDataRow: 11,
  lastDataRow: 12,
  leadSource: "DIRECTORY",
  status: "NEW",
  confidence: 0.9,
  notes: "",
  columns: [
    { index: 0, header: "Organisation", label: "Organisation", field: "companyName", type: "TEXT" },
    { index: 1, header: "Website", label: "Website", field: "website", type: "URL" },
    { index: 2, header: "Contact person", label: "Contact person", field: "contactName", type: "TEXT" },
    { index: 3, header: "Email", label: "Email", field: "contactEmail", type: "EMAIL" },
  ],
};

/** The people table cut in half at the blank row, the fragment losing its header. */
const FRAGMENT_HEAD = { ...PEOPLE, lastDataRow: 4 };
const FRAGMENT_TAIL = {
  ...PEOPLE,
  title: "Accra clinics — Q3 (continued)",
  headerRow: -1,
  firstDataRow: 6,
  lastDataRow: 7,
  confidence: 0.5,
  columns: PEOPLE.columns.map((column, index) => ({
    ...column,
    header: "",
    label: `Column ${"ABCD"[index]}`,
    field: "custom",
    type: "TEXT",
  })),
};

/**
 * A long sheet with a boundary buried in the middle of it.
 *
 * 400 rows of clinics, a blank row and a banner at row 300, then a table of
 * suppliers with different columns. Nothing about the top or the bottom of
 * this file says the second table exists — which is the whole point, because
 * the top and the bottom used to be all the analyst was shown.
 */
function longSheet() {
  const rows: string[][] = [["Accra clinics — the long list", "", "", ""], ["", "", "", ""], ["S/N", "Name", "Phone", "Email"]];
  for (let n = 1; n <= 297; n += 1) rows.push([String(n), `Clinic ${n}`, `024400${String(1000 + n).slice(-4)}`, `c${n}@clinic.test`]);
  rows.push(["", "", "", ""]);
  rows.push(["Suppliers", "", "", ""]);
  rows.push(["Supplier", "Website", "Contact person", "Email"]);
  for (let n = 1; n <= 40; n += 1) rows.push([`Supplier ${n}`, `s${n}.example.com`, `Person ${n}`, `s${n}@example.com`]);
  return { name: "Long", rows, totalRows: rows.length, truncated: false };
}

/**
 * A worksheet whose real header row has a title sitting on top of it.
 *
 * Two filled cells, so `findBlocks` does not lift it out as a banner — and
 * two is enough to be read as the header row, which labels every column off a
 * title cell and imports the real header as a lead called "Name".
 */
const TITLED_ROWS: string[][] = [
  ["ACCRA CLINICS", "August 2026", "", ""],
  ["S/N", "Name", "Phone", "Email"],
  ["1", "Kofi Mensah", "0244000001", "kofi@clinic.test"],
  ["2", "Ama Boateng", "0244000002", "ama@clinic.test"],
  ["3", "Yaw Owusu", "0244000003", "yaw@clinic.test"],
];
const TITLED = { name: "Titled", rows: TITLED_ROWS, totalRows: TITLED_ROWS.length, truncated: false };

async function main() {
  // --- Two fake vendors, before anything imports ---------------------------
  //
  // `BASE.openrouter` in models/call.ts and the Anthropic SDK both read their
  // root at construction, so a value assigned after the imports is one nothing
  // sees.
  const orBodies: any[] = [];
  /** When set, the OpenRouter stub answers as a run that hit the token cap. */
  let orTruncates = false;
  /** When set, it answers with a sentence of preamble around the JSON. */
  let orAddsPreamble = false;
  /** When set, it answers with the parts array rather than a plain string. */
  let orAnswersInParts = false;

  const or = await httpServer((body, send, path) => {
    // OpenRouter's own catalogue, which is where "does this model compile a
    // JSON schema" is answered. `response_format` and `structured_outputs` are
    // two different declarations and the difference is the whole point. The
    // shipped id is stubbed as declaring the first and not the second — which
    // is what `stealth/ox-alpha` really did, and what this half of the code
    // exists to handle whichever model is in the seat.
    if (path.includes("/models")) {
      return send(200, {
        data: [
          { id: SHIPPED, supported_parameters: ["max_tokens", "reasoning_effort", "response_format", "tools"] },
          { id: "vendor/strict-one", supported_parameters: ["max_tokens", "response_format", "structured_outputs"] },
        ],
      });
    }
    orBodies.push(body);
    send(200, {
      id: "chatcmpl_check_sheet",
      object: "chat.completion",
      model: SHIPPED,
      choices: [
        {
          index: 0,
          finish_reason: orTruncates ? "length" : "stop",
          message: {
            role: "assistant",
            content: orTruncates
              ? ""
              : orAddsPreamble
                ? `Here is the plan you asked for.

${JSON.stringify({ summary: "wrapped in prose", tables: [PEOPLE] })}

Let me know if you would like it changed.`
                : orAnswersInParts
                ? [{ type: "text", text: JSON.stringify({ summary: "answered in parts", tables: [PEOPLE, COMPANIES] }) }]
                : JSON.stringify({ summary: "one table of people, one of companies", tables: [PEOPLE, COMPANIES] }),
          },
        },
      ],
      usage: { prompt_tokens: 900, completion_tokens: 120 },
    });
  });

  const anthropicBodies: any[] = [];
  const anthropic = await httpServer((body, send) => {
    anthropicBodies.push(body);
    send(200, {
      id: "msg_check_sheet",
      type: "message",
      role: "assistant",
      model: String(body.model ?? "claude-sonnet-5"),
      content: [{ type: "text", text: JSON.stringify({ summary: "read by the stand-in", tables: [PEOPLE] }) }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 900, output_tokens: 120, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });
  });

  process.env.OPENROUTER_BASE_URL = or.url;
  process.env.OPENROUTER_API_KEY = "sk-or-check-not-a-real-key";
  process.env.ANTHROPIC_BASE_URL = anthropic.url;
  process.env.ANTHROPIC_API_KEY = "sk-ant-check-not-a-real-key";
  // The other three must stay unconnected or the chain reaches one of them and
  // this check is asserting on the wrong wire.
  delete process.env.OPENAI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.PERPLEXITY_API_KEY;

  const { prisma } = await import("../src/lib/prisma.js");
  const { SETTING, clearSettingsCache, setSetting } = await import("../src/lib/settings.js");
  const { analyzeGrids } = await import("../src/lib/anthropic.js");
  const { callModel } = await import("../src/lib/models/call.js");
  const { reasoningEffortFor, tokensWithReasoning } = await import("../src/lib/models/registry.js");
  const { detectTables, normalizePlan, planGroups, renderGrid, repairPlan } = await import("../src/services/sheetPlan.js");
  const { buildPreviews } = await import("../src/services/leadImport.js");

  // Rule one of this directory: a database and nothing else. `getSetting`
  // prefers the environment but falls back to the AppSetting rows, and a dev
  // database holds whatever keys were pasted while testing — a stored key here
  // would send a real request to a real vendor. Snapshotted and restored at the
  // end; nothing this check does outlives the process.
  const VENDOR_SETTINGS = [
    SETTING.ANTHROPIC_KEY,
    SETTING.ANTHROPIC_MODEL,
    SETTING.OPENROUTER_KEY,
    SETTING.OPENROUTER_MODEL,
    SETTING.OPENROUTER_FREE_MODELS,
    SETTING.MODEL_ROUTES,
    SETTING.MODEL_JOB_MODELS,
  ];
  const savedSettings = await prisma.appSetting.findMany({ where: { key: { in: VENDOR_SETTINGS } } });
  await prisma.appSetting.deleteMany({ where: { key: { in: VENDOR_SETTINGS } } });
  // **Free models off for this file**, the same separation of subjects
  // `checks/agentLoopOpenRouter.ts` makes and for the same reason. Everything
  // below asserts about the *wire* — the effort that reaches it, the token
  // budget, whether a `json_schema` survives, and what happens when the answer
  // is truncated, arrives in parts, or comes wrapped in a sentence. With the
  // shipped ladder on, each of those would be three calls against three ids
  // this file's fake catalogue does not describe, and every assertion would be
  // about which rung answered instead. The ladder has its own file
  // (`checks/freeModels.ts`), which drives all three rungs and the paid floor
  // under them. An empty list is the deliberate "off" state; deleting the row
  // means "use the shipped ladder", which is the opposite.
  await setSetting(SETTING.OPENROUTER_FREE_MODELS, "[]");
  clearSettingsCache();

  // "sheet.analyse" is a real production purpose, so only the rows this run
  // adds may be deleted — a blanket delete would erase genuine history from a
  // database that has any.
  const knownLedgerRows = new Set(
    (await prisma.llmCall.findMany({ where: { purpose: "sheet.analyse" }, select: { id: true } })).map((row) => row.id),
  );

  // --- The mapping ---------------------------------------------------------
  //
  // The shipped OpenRouter model offers low/high/max and its own default is max, so our `low` must
  // not become max by omission and our `high` must not fall through to low.
  console.log("\nHow hard it is asked to think");
  check("low stays low", reasoningEffortFor("low") === "low");
  check("medium steps up to high, not the model's max default", reasoningEffortFor("medium") === "high");
  check("high rides at max", reasoningEffortFor("high") === "max");
  check("the answer budget is what the caller asked for, plus room to think", tokensWithReasoning(16_000, "high") > 16_000);
  check("a cheap job gets a small allowance", tokensWithReasoning(2_000, "low") < tokensWithReasoning(2_000, "high"));
  check("the total is capped rather than unbounded", tokensWithReasoning(1_000_000, "max") <= 32_000);

  // --- The wire ------------------------------------------------------------

  console.log("\nWhat the sheet analyst actually puts on the wire");
  const hints = detectTables([GRID as any]);
  const analysis = await analyzeGrids([GRID as any], hints);
  const sent = orBodies.at(-1);

  check("OpenRouter served it, under its shipped slug", sent?.model === SHIPPED, String(sent?.model));
  check("it was not quietly handed to the stand-in", analysis.note === null, String(analysis.note));
  check("the effort reaches the wire at all", typeof sent?.reasoning_effort === "string", JSON.stringify(sent?.reasoning_effort));
  check("reading a sheet is asked for at max, not left to the default", sent?.reasoning_effort === "max", String(sent?.reasoning_effort));
  check(
    "the budget has room for the thinking on top of the plan",
    typeof sent?.max_tokens === "number" && sent.max_tokens > 16_000,
    String(sent?.max_tokens),
  );
  // The defect that made the analyst look like it had simply got worse.
  // The shipped OpenRouter model declares `response_format` and NOT `structured_outputs`, so
  // OpenRouter drops a `json_schema` sent to it — and every caller in this app
  // describes its answer entirely in the schema. The sheet analyst's system
  // prompt says "return a plan" and never says what a plan looks like, so the
  // model was being asked for one with no description of it in the request.
  const systemSent = sent?.messages?.[0]?.content ?? "";
  check("a model that cannot compile a schema is asked for plain JSON", sent?.response_format?.type === "json_object", String(sent?.response_format?.type));
  check("...and the shape is written into the prompt instead", systemSent.includes("The shape of your answer"));
  check("...naming the fields the plan is made of", systemSent.includes("firstDataRow") && systemSent.includes("lastDataRow"));
  check("...and the field targets it may map a column to", systemSent.includes("contactName"));
  check(
    "the schema still carries no keyword structured outputs refuse",
    !systemSent.includes("maxItems") && !JSON.stringify(sent?.response_format?.json_schema?.schema ?? {}).includes("maxItems"),
  );

  // The negative: a model that *does* declare structured outputs keeps the
  // strict schema and is not made to read a copy of it in its prompt. A fix
  // that taxed every model for one model's limitation would be a regression
  // wearing a repair's clothes.
  console.log("");
  console.log("A model that does compile schemas");
  await setSetting(SETTING.OPENROUTER_MODEL, "vendor/strict-one");
  await analyzeGrids([GRID as any], hints);
  const strictSent = orBodies.at(-1);
  check("keeps the strict JSON schema", strictSent?.response_format?.json_schema?.strict === true, String(strictSent?.response_format?.type));
  check("...and is not sent the shape a second time in its prompt", !String(strictSent?.messages?.[0]?.content ?? "").includes("The shape of your answer"));
  await setSetting(SETTING.OPENROUTER_MODEL, SHIPPED);

  // The negative that pays for the whole mapping: an economy job must not ride
  // at the headline model's reasoning depth just because nobody said otherwise.
  const SCHEMA = { type: "object", additionalProperties: false, required: ["answer"], properties: { answer: { type: "string" } } };
  await callModel<{ answer: string }>({
    purpose: "check.sheetAnalyst.triage",
    job: "triage",
    system: "s",
    prompt: () => "p",
    schema: SCHEMA,
    effort: "low",
  }).catch(() => undefined);
  check("a job that asks for low effort gets low on the wire", orBodies.at(-1)?.reasoning_effort === "low", String(orBodies.at(-1)?.reasoning_effort));

  // --- Losing the answer to the thinking -----------------------------------
  //
  // A run that spends its whole budget reasoning comes back empty with
  // `finish_reason: "length"`. That must not lose the import: it is exactly the
  // case another vendor handles, and the Owner must be told a stand-in did it.
  console.log("\nWhen the OpenRouter model runs out of room");
  orTruncates = true;
  const covered = await analyzeGrids([GRID as any], hints);
  orTruncates = false;
  check("the sheet is still read", covered.plan.tables.length > 0);
  check("...by the stand-in, over the Anthropic wire", anthropicBodies.length === 1, `${anthropicBodies.length} calls`);
  check("...and the handover is said out loud", covered.note !== null && covered.note.includes(PROVIDERS.openrouter.name), String(covered.note));

  // OpenRouter fronts arbitrary models and not all of them answer with a
  // plain string. This used to reach `.trim()` as an array and throw an
  // uncaught TypeError, which skipped every failover path and surfaced as
  // "Something went wrong" about a spreadsheet the Owner was looking at.
  console.log("");
  console.log("When the answer comes back as parts rather than a string");
  orAnswersInParts = true;
  const inParts = await analyzeGrids([GRID as any], hints);
  orAnswersInParts = false;
  check("the plan is still read", inParts.plan.tables.length === 2, `${inParts.plan.tables.length} tables`);
  check("...on OpenRouter, without falling through to the stand-in", inParts.note === null, String(inParts.note));

  // A model told to return JSON rather than held to it answers with a sentence
  // of preamble often enough to matter. Rejecting that costs a second vendor
  // the whole job and puts "the analyst's plan could not be read" in front of
  // the Owner.
  console.log("");
  console.log("When the JSON arrives wrapped in a sentence");
  orAddsPreamble = true;
  const wrapped = await analyzeGrids([GRID as any], hints);
  orAddsPreamble = false;
  check("the plan is still read", wrapped.plan.tables.length === 1, `${wrapped.plan.tables.length} tables`);
  check("...on OpenRouter, without paying a second vendor to redo it", wrapped.note === null, String(wrapped.note));

  // --- The plan ------------------------------------------------------------

  console.log("\nA table split at a blank row");
  const split = repairPlan({ summary: "", tables: [FRAGMENT_HEAD, FRAGMENT_TAIL, COMPANIES] as any }, [GRID as any], hints);
  check("the fragments are joined back into one table", split.plan.tables.length === 2, `${split.plan.tables.length} tables`);
  const people = split.plan.tables.find((table) => table.firstDataRow === 3);
  check("...running to the end of the real table", people?.lastDataRow === 7, String(people?.lastDataRow));
  check("...keeping the header that sat above the first fragment", people?.headerRow === 2, String(people?.headerRow));

  const repairedRows = buildPreviews([GRID as any], split.plan);
  check("every lead in it survives", repairedRows[0]?.rowCount === 4, `${repairedRows[0]?.rowCount} rows`);
  check("with their real column names", repairedRows[0]?.columns.some((column) => column.label === "Phone") === true);
  check("the repair is reported rather than done silently", split.repairs.length === 1, JSON.stringify(split.repairs));
  check("...and lands in the summary the review screen prints", split.plan.summary.includes("split at a blank row"));

  // Left alone, this is what the Owner would have got: one table arriving as
  // two groups, the second of them with no column names at all, because the
  // header the whole table shares sits above the first fragment only.
  const unrepaired = buildPreviews([GRID as any], normalizePlan({ summary: "", tables: [FRAGMENT_HEAD, FRAGMENT_TAIL] as any }, [GRID as any]));
  check("(without the repair the same table arrives as two groups)", unrepaired.length === 2, `${unrepaired.length} groups`);
  check(
    "(...the second of which has lost every column name)",
    unrepaired[1]?.columns.every((column) => column.label === "Name" || column.label.startsWith("Column ")) === true,
    JSON.stringify(unrepaired[1]?.columns.map((column) => column.label)),
  );

  console.log("\nThe negatives");
  const twoTables = repairPlan({ summary: "", tables: [PEOPLE, COMPANIES] as any }, [GRID as any], hints);
  check("two genuinely different tables are not merged", twoTables.plan.tables.length === 2, `${twoTables.plan.tables.length} tables`);
  check("...and nothing is reported as repaired", twoTables.repairs.length === 0, JSON.stringify(twoTables.repairs));
  check(
    "the companies table keeps its own columns",
    twoTables.plan.tables[1]?.columns.some((column) => column.field === "companyName") === true,
  );

  // A person who split a table on the review screen meant to split it.
  const byHand = normalizePlan({ summary: "", tables: [FRAGMENT_HEAD, FRAGMENT_TAIL] as any }, [GRID as any]);
  check("a plan from the review screen is left exactly as the Owner set it", byHand.tables.length === 2, `${byHand.tables.length} tables`);

  console.log("\nA row is never imported twice");
  const overlapping = repairPlan(
    { summary: "", tables: [PEOPLE, { ...FRAGMENT_TAIL, firstDataRow: 4, lastDataRow: 7 }] as any },
    [GRID as any],
    hints,
  );
  const importedRows = buildPreviews([GRID as any], overlapping.plan).reduce((total, preview) => total + preview.rowCount, 0);
  check("four leads in the file means four leads imported", importedRows === 4, `${importedRows} rows`);
  check("...and the Owner is told why", overlapping.repairs.length > 0, JSON.stringify(overlapping.repairs));

  console.log("\nA table with nothing named as the lead");
  const nameless = normalizePlan(
    {
      summary: "",
      tables: [{ ...PEOPLE, columns: PEOPLE.columns.map((column) => ({ ...column, field: column.field === "ignore" ? "ignore" : "custom" })) }] as any,
    },
    [GRID as any],
  );
  const rescued = buildPreviews([GRID as any], nameless);
  check("the rows are not silently thrown away", rescued[0]?.rowCount === 4, `${rescued[0]?.rowCount} rows`);
  check("...something is promoted to the lead's name", nameless.tables[0]?.columns.some((column) => column.field === "contactName") === true);
  // The rescue is only worth having if it picks a name. The leftmost column of
  // a lead sheet is very often S/N, and four leads called "1", "2", "4" and
  // "5" are saved in the same sense that a shredded document is filed.
  check(
    "...and it is a name, not the row number",
    rescued[0]?.sample[0]?.Name === "Kofi Mensah",
    JSON.stringify(rescued[0]?.sample[0]),
  );

  console.log("\nA header row counted as data");
  const offByOne = repairPlan({ summary: "", tables: [{ ...PEOPLE, firstDataRow: 2 }] as any }, [GRID as any], hints);
  check("the data starts below the header again", offByOne.plan.tables[0]?.firstDataRow === 3, String(offByOne.plan.tables[0]?.firstDataRow));
  check("...and it is reported", offByOne.repairs.some((line) => line.includes("header row")));

  // --- What the analyst is actually shown ----------------------------------
  //
  // The boundary the analyst is asked for can sit anywhere in the file, and
  // the render used to be the first 110 rows and the last 15. A second table
  // starting at row 300 was invisible, so no plan could ever contain it, and
  // the tables the analyst *did* report ran to wherever it could see.
  console.log("\nA boundary in the middle of a long sheet");
  const long = longSheet();
  const rendered = renderGrid(long as any);
  check("the sheet is not rendered whole", rendered.includes("more rows in the same shape"), "nothing was elided");
  check("the banner 300 rows down is shown", rendered.includes("| Suppliers |"), "the banner was elided");
  check("...and so is the header row under it", rendered.includes("Supplier | Website | Contact person | Email"));
  check(
    "...with its real row number, so a boundary reported off it lines up",
    new RegExp(`^\\s*${long.rows.findIndex((row) => row[0] === "Suppliers")} \\| Suppliers`, "m").test(rendered),
  );
  check("the last row is still shown", rendered.includes("Supplier 40"));
  check("and it is still bounded", rendered.split("\n").length < 400, `${rendered.split("\n").length} lines`);

  // The rules read the same file without a model, and must find both tables —
  // this is the independent evidence `repairPlan` uses.
  const longHints = detectTables([long as any]);
  check("the pattern rules find both tables in it", longHints.length === 2, `${longHints.length} tables`);

  console.log("\nA table reported as stopping halfway down");
  const truncated = repairPlan(
    { summary: "", tables: [{ ...longHints[0], lastDataRow: 120 }] as any },
    [long as any],
    longHints,
  );
  check("it is run on to where its own rows stop", truncated.plan.tables[0]?.lastDataRow === 299, String(truncated.plan.tables[0]?.lastDataRow));
  check("...and never past the banner into the next table", truncated.plan.tables[0]?.lastDataRow! < 301);
  check("...and it is reported rather than done quietly", truncated.repairs.some((line) => line.includes("carry on")), JSON.stringify(truncated.repairs));
  const kept = buildPreviews([long as any], truncated.plan)[0];
  check("every lead below the reported end survives", kept?.rowCount === 297, `${kept?.rowCount} rows`);

  console.log("\nThe negatives for running a table on");
  const bothReported = repairPlan({ summary: "", tables: longHints as any }, [long as any], longHints);
  check("a table with another below it is left where it ends", bothReported.plan.tables.length === 2, `${bothReported.plan.tables.length} tables`);
  check("...and nothing is reported as repaired", bothReported.repairs.length === 0, JSON.stringify(bothReported.repairs));
  const untouched = repairPlan({ summary: "", tables: [PEOPLE, COMPANIES] as any }, [GRID as any], hints);
  check(
    "the people table does not run on into the companies table",
    untouched.plan.tables[0]?.lastDataRow === 7,
    String(untouched.plan.tables[0]?.lastDataRow),
  );

  console.log("\nA title row read as the column headers");
  const titledHints = detectTables([TITLED as any]);
  check("the rules read the row below the title as the header", titledHints[0]?.headerRow === 1, String(titledHints[0]?.headerRow));
  check("...and the title becomes the list's name", titledHints[0]?.title === "ACCRA CLINICS", titledHints[0]?.title);

  const misread = repairPlan(
    {
      summary: "",
      tables: [
        {
          ...PEOPLE,
          sheet: "Titled",
          headerRow: 0,
          firstDataRow: 1,
          lastDataRow: 4,
          columns: [
            { index: 0, header: "ACCRA CLINICS", label: "ACCRA CLINICS", field: "custom", key: "accra_clinics", type: "TEXT" },
            { index: 1, header: "August 2026", label: "August 2026", field: "custom", key: "august_2026", type: "TEXT" },
            { index: 2, header: "", label: "Column C", field: "custom", key: "column_c", type: "TEXT" },
            { index: 3, header: "", label: "Column D", field: "custom", key: "column_d", type: "TEXT" },
          ],
        },
      ] as any,
    },
    [TITLED as any],
    titledHints,
  );
  const fixed = misread.plan.tables[0];
  check("the header moves to the row that names the columns", fixed?.headerRow === 1, String(fixed?.headerRow));
  check("...the data starts below it", fixed?.firstDataRow === 2, String(fixed?.firstDataRow));
  // Moving the row alone would leave every column still named after a title
  // cell, which is the half of this repair that is actually worth having.
  check("...and the columns are renamed off it", fixed?.columns.some((column) => column.field === "contactEmail") === true, JSON.stringify(fixed?.columns.map((c) => c.field)));
  check("...so the leads have an email address", buildPreviews([TITLED as any], misread.plan)[0]?.reachable === 3, `${buildPreviews([TITLED as any], misread.plan)[0]?.reachable}`);
  check("...and the header row is no longer imported as a lead", buildPreviews([TITLED as any], misread.plan)[0]?.rowCount === 3);
  check("...and it is reported", misread.repairs.some((line) => line.includes("title")), JSON.stringify(misread.repairs));

  // The negative: a table whose header really is on the row it named must not
  // be shunted down one, which would throw away its first lead.
  const rightAlready = repairPlan({ summary: "", tables: [PEOPLE] as any }, [GRID as any], hints);
  check("a correctly-read header row is left alone", rightAlready.plan.tables[0]?.headerRow === 2, String(rightAlready.plan.tables[0]?.headerRow));

  // --- Grouping ------------------------------------------------------------
  //
  // A worksheet's sections are one list to the person who typed them. The
  // negative is the one that matters: a plan asking for a list per table must
  // still get one, because a tab holding people and organisations forced into
  // one column set is what loses the data.
  console.log("\nOne list per worksheet");
  const twoOnOneSheet = normalizePlan({ summary: "", tables: [PEOPLE, COMPANIES] as any }, [GRID as any]);
  const perSheet = planGroups(twoOnOneSheet);
  check("two tables on one tab become one list", perSheet.length === 1, `${perSheet.length} lists`);
  check("...named after the worksheet", perSheet[0]?.title === "Sheet1", perSheet[0]?.title);
  check("...holding both of them", perSheet[0]?.tables.length === 2, `${perSheet[0]?.tables.length} tables`);

  const perTable = planGroups({ ...twoOnOneSheet, grouping: "table" });
  check("asking for a list per table gives two", perTable.length === 2, `${perTable.length} lists`);
  check("...each keeping its own name", perTable[1]?.title === "Companies/Organizations", perTable[1]?.title);

  const single = planGroups(normalizePlan({ summary: "", tables: [COMPANIES] as any }, [GRID as any]));
  check("a tab with one table on it keeps that table's own title", single[0]?.title === "Companies/Organizations", single[0]?.title);

  // --- Rule 3: everything this check created, gone -------------------------
  await prisma.llmCall.deleteMany({ where: { purpose: { startsWith: "check.sheetAnalyst" } } });
  await prisma.llmCall.deleteMany({ where: { purpose: "sheet.analyse", id: { notIn: [...knownLedgerRows] } } });
  await prisma.appSetting.deleteMany({ where: { key: { in: VENDOR_SETTINGS } } });
  for (const row of savedSettings) {
    await prisma.appSetting.create({ data: { key: row.key, value: row.value } });
  }
  clearSettingsCache();
  await prisma.$disconnect();
  or.server.close();
  anthropic.server.close();

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const name of failures) console.log(`  - ${name}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
