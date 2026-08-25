/**
 * Can a workbook with a lot of tabs in it actually be imported?
 *
 * A real one is 39 tabs of leads. Reading it used to be a single request that
 * read every tab, held all of them, and put all of them in one prompt of about
 * 100,000 tokens — and it came back "The server didn't answer (502)", with no
 * way to tell whether any of the work had been done. So a workbook is read a
 * tab at a time now, one request each, and this is what holds that shape.
 *
 * Four things here, and every one of them is a bug that has already happened:
 *
 *   - **Reading one tab must not cost the whole workbook.** The point of the
 *     split is that nothing but the tab being read is ever in memory. A source
 *     that quietly parsed everything and handed back one sheet would pass every
 *     other assertion in this file.
 *   - **Reading one tab must not leak a file descriptor.** ExcelJS buffers each
 *     worksheet to a temp file and opens a read stream per sheet on the way
 *     back; skipping one leaves that stream open. Thirty-nine tabs across an
 *     analyse, a preview and a commit is enough to exhaust the process, and it
 *     surfaces as `EMFILE: too many open files` naming a file in node_modules —
 *     which is as far from the cause as an error can get. Draining every sheet,
 *     wanted or not, is what closes them.
 *   - **A tab read twice must not appear twice.** The screen retries a tab that
 *     failed; a retry that appended a second copy of its tables would double
 *     that one group and nothing else, silently.
 *   - **A plan spanning many tabs must survive the round trip** — normalised,
 *     previewed and counted the same whether the sheets arrive together or one
 *     at a time.
 *
 * Postgres only. No key, no network, no committed fixture — the workbook is
 * built here.
 *   npx tsx checks/bulkImport.ts
 */
import ExcelJS from "exceljs";
import { detectTables, normalizePlan, repairPlan, type ImportPlan, type PlanTable } from "../src/services/sheetPlan.js";
import { buildPreviews, buildPreviewsFrom, normalizePlanFrom } from "../src/services/leadImport.js";
import { sourceFromUpload } from "../src/services/sheetSource.js";
import { parseWorkbook } from "../src/services/spreadsheet.js";

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

const TABS = 24;

/** A workbook shaped like the one this went wrong on: many tabs, a banner and a gap on each. */
async function bigWorkbook(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  for (let tab = 0; tab < TABS; tab += 1) {
    const sheet = workbook.addWorksheet(`Leads ${tab + 1}`);
    sheet.addRow([`LEADS ${tab + 1} — MASTER LIST`]);
    sheet.addRow([]);
    sheet.addRow(["S/N", "Business", "Contact", "Phone", "Email"]);
    for (let row = 1; row <= 40 + tab * 5; row += 1) {
      // A blank row inside the table, which is a gap and not a boundary.
      if (row % 17 === 0) {
        sheet.addRow([]);
        continue;
      }
      sheet.addRow([row, `Biz ${tab}-${row}`, `Person ${tab}-${row}`, `+23324${String(1000000 + row).slice(0, 7)}`, `p${tab}x${row}@biz.com`]);
    }
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/** What a tab-by-tab analysis does per tab, as the route does it. */
function readOneTab(grid: Parameters<typeof detectTables>[0][number]): PlanTable[] {
  const hints = detectTables([grid]);
  return repairPlan({ tables: hints, summary: "" }, [grid], hints).plan.tables;
}

async function main() {
  const buffer = await bigWorkbook();
  console.log(`\nA ${TABS}-tab workbook, ${Math.round(buffer.length / 1024)} KB`);

  const source = sourceFromUpload(buffer, "bulk.xlsx");
  const names = await source.names();
  check(`all ${TABS} tabs are named before anything is read`, names.length === TABS, `${names.length}`);

  console.log("\nOne tab at a time");
  // The descriptor leak is only visible over many reads, which is exactly the
  // shape of a bulk import: a read per tab to analyse, then again to preview,
  // then again to commit. Under the old code this ran out of descriptors.
  const plan: ImportPlan = { tables: [], summary: "" };
  let readError = "";
  const started = Date.now();
  try {
    for (const name of names) {
      const grid = await source.get(name);
      if (!grid) throw new Error(`no grid for ${name}`);
      plan.tables.push(...readOneTab(grid));
    }
  } catch (err) {
    readError = (err as Error).message;
  }
  check("every tab reads on its own, with no descriptor left open", readError === "", readError);
  check(`one table per tab, ${TABS} in all`, plan.tables.length === TABS, `${plan.tables.length}`);
  console.log(`        (${TABS} single-tab reads in ${Date.now() - started}ms)`);

  const perTabRows = plan.tables.map((table) => table.lastDataRow - table.firstDataRow + 1);
  check("no tab came back empty", perTabRows.every((rows) => rows > 30), JSON.stringify(perTabRows.slice(0, 5)));
  check(
    "a blank row inside a tab did not split it in two",
    plan.tables.filter((table) => table.sheet === "Leads 1").length === 1,
    `${plan.tables.filter((table) => table.sheet === "Leads 1").length} tables on the first tab`,
  );

  console.log("\nThe same answer, one tab at a time or all at once");
  const allAtOnce = await parseWorkbook(buffer, "bulk.xlsx");
  const together: ImportPlan = { tables: [], summary: "" };
  for (const grid of allAtOnce) together.tables.push(...readOneTab(grid));
  check(
    "reading the tabs one at a time produces the plan reading them together does",
    JSON.stringify(plan.tables) === JSON.stringify(together.tables),
    firstTableDifference(plan.tables, together.tables),
  );

  console.log("\nA whole plan, off a source that holds one sheet");
  const normalised = await normalizePlanFrom(source, plan);
  check("every table survives the round trip", normalised.tables.length === TABS, `${normalised.tables.length}`);
  check(
    "and they come back in the order the plan had them",
    normalised.tables.map((table) => table.sheet).join(",") === plan.tables.map((table) => table.sheet).join(","),
  );

  const previews = await buildPreviewsFrom(source, normalised);
  const rows = previews.reduce((total, preview) => total + preview.rowCount, 0);
  check(`previews are built for all ${TABS} tables`, previews.length === TABS, `${previews.length}`);
  check("and they carry rows", rows > TABS * 30, `${rows} rows`);
  check(
    "every preview has a name column, so no group imports empty",
    previews.every((preview) => preview.columns.some((column) => column.field === "contactName")),
    previews.filter((preview) => !preview.columns.some((column) => column.field === "contactName")).map((p) => p.tableId).join(", "),
  );

  const gridsForAll = await parseWorkbook(buffer, "bulk.xlsx");
  const togetherPreviews = buildPreviews(gridsForAll, normalizePlan(plan, gridsForAll));
  check(
    "the one-at-a-time previews match the all-at-once ones",
    JSON.stringify(previews.map((p) => [p.rowCount, p.reachable, p.columns.length])) ===
      JSON.stringify(togetherPreviews.map((p) => [p.rowCount, p.reachable, p.columns.length])),
  );

  console.log("\nOne pass, many tabs");
  const seen: string[] = [];
  await source.each(names, (grid) => {
    seen.push(grid.name);
  });
  check(`one pass hands over all ${TABS} tabs`, seen.length === TABS, `${seen.length}`);
  check("in the file's own order", seen.join(",") === names.join(","), seen.slice(0, 3).join(","));

  console.log("\nA tab read twice");
  // The screen retries a tab that failed. The route replaces that tab's tables
  // rather than appending them, so this is the assertion that a retry costs
  // nothing — appending would double one group and leave the rest alone.
  const grid = await source.get(names[0]);
  const again = readOneTab(grid!);
  const merged = [...plan.tables.filter((table) => table.sheet !== names[0]), ...again];
  check("re-reading a tab replaces its tables rather than adding a second copy", merged.length === TABS, `${merged.length}`);
  check(
    "and the tab that was re-read is unchanged",
    JSON.stringify(merged.filter((t) => t.sheet === names[0])) === JSON.stringify(plan.tables.filter((t) => t.sheet === names[0])),
  );

  source.release();

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const name of failures) console.log(`  - ${name}`);
    process.exit(1);
  }
}

function firstTableDifference(a: PlanTable[], b: PlanTable[]): string {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if (JSON.stringify(a[index]) !== JSON.stringify(b[index])) {
      return `table ${index}: ${JSON.stringify(a[index])?.slice(0, 160)} vs ${JSON.stringify(b[index])?.slice(0, 160)}`;
    }
  }
  return "";
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
