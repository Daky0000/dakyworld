/**
 * Does a worksheet arrive as one list, and can you tell where a lead came from?
 *
 * Two complaints, one cause. A tab of leads with section headings down it is
 * three tables to the detector and one list to the person who typed it, so a
 * single worksheet arrived on the Leads page as three lists called "Accra",
 * "Kumasi" and "Takoradi" — scattered among a workbook's other ninety, with
 * nothing on any of them saying they were one thing. And nothing on a lead
 * recorded which sheet it came off, so once a list was renamed or a lead moved
 * the answer was gone.
 *
 * So `plan.grouping` decides what a list is — one per worksheet by default —
 * and every list and every lead carries the worksheet as a tag.
 *
 * The negatives are the half worth reading, and every one of them is a way of
 * making the fix worse than the fault:
 *
 *   - **A merged list must hold every column of every table in it.** Merging
 *     onto the first table's columns is how a section carrying an email
 *     address arrives with none.
 *   - **A list per table must still be available**, because a tab holding
 *     people and organisations forced into one column set loses data.
 *   - **A re-import must not untag a lead.** `Lead.tags` is written by four
 *     things, three of which invent the words; an import that replaced the
 *     array would quietly undo a scrape's tags and a person's on every refresh.
 *   - **A tag is a slug in the array and words in the registry**, or the Tags
 *     screen shows a count of zero beside a lead visibly carrying it.
 *
 * Database only. No API key, no network, no Docker beyond Postgres itself.
 *   npx tsx checks/importGrouping.ts
 */
import ExcelJS from "exceljs";
import { prisma } from "../src/lib/prisma.js";
import { commitPlan } from "../src/services/leadImport.js";
import { detectTables, normalizePlan, planGroups, type ImportPlan } from "../src/services/sheetPlan.js";
import { sourceFromUpload } from "../src/services/sheetSource.js";
import { tagSlug } from "../src/services/leadTags.js";

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

const FILE = "Ghana clinics August.xlsx";
const SHEET = "Greater Accra";
const SHEET_TAG = tagSlug(SHEET)!;
const FILE_TAG = tagSlug("Ghana clinics August")!;

/**
 * One worksheet, three sections, and the third one carries a column the first
 * two do not. That last part is the whole test of the merge: a list built on
 * the first section's columns has nowhere to put an email address.
 */
async function workbook(): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet(SHEET);

  sheet.addRow(["ACCRA"]);
  sheet.addRow(["S/N", "Name", "Phone"]);
  for (let n = 1; n <= 4; n += 1) sheet.addRow([n, `Accra clinic ${n}`, `024400000${n}`]);
  sheet.addRow([]);

  sheet.addRow(["TEMA"]);
  sheet.addRow(["S/N", "Name", "Phone"]);
  for (let n = 1; n <= 3; n += 1) sheet.addRow([n, `Tema clinic ${n}`, `024411000${n}`]);
  sheet.addRow([]);

  sheet.addRow(["MADINA"]);
  sheet.addRow(["S/N", "Name", "Phone", "Email"]);
  for (let n = 1; n <= 3; n += 1) sheet.addRow([n, `Madina clinic ${n}`, `024422000${n}`, `madina${n}@clinic.test`]);

  const second = book.addWorksheet("Ashanti");
  second.addRow(["S/N", "Name", "Phone"]);
  for (let n = 1; n <= 2; n += 1) second.addRow([n, `Kumasi clinic ${n}`, `024433000${n}`]);

  return Buffer.from(await book.xlsx.writeBuffer());
}

const created = { imports: [] as string[], groups: [] as string[] };

/** Rule 3 of checks/README.md: everything this file created, gone. */
async function reset() {
  const groups = await prisma.leadGroup.findMany({ where: { leadImportId: { in: created.imports } }, select: { id: true } });
  const groupIds = [...new Set([...created.groups, ...groups.map((group) => group.id)])];
  if (groupIds.length) {
    await prisma.lead.deleteMany({ where: { groupId: { in: groupIds } } });
    await prisma.leadField.deleteMany({ where: { groupId: { in: groupIds } } });
    await prisma.leadGroup.deleteMany({ where: { id: { in: groupIds } } });
  }
  if (created.imports.length) await prisma.leadImport.deleteMany({ where: { id: { in: created.imports } } });
  await prisma.leadTag.deleteMany({ where: { slug: { in: [SHEET_TAG, FILE_TAG, tagSlug("Ashanti")!] } } });
}

/** A plan the way the analyse route builds one: the rules over every tab. */
async function planFor(buffer: Buffer, grouping: ImportPlan["grouping"]): Promise<ImportPlan> {
  const source = sourceFromUpload(buffer, FILE);
  const tables: ImportPlan["tables"] = [];
  await source.each(await source.names(), (grid) => {
    tables.push(...normalizePlan({ summary: "", tables: detectTables([grid]) }, [grid]).tables);
  });
  source.release();
  return { tables, summary: "", grouping };
}

async function openImport(): Promise<string> {
  const record = await prisma.leadImport.create({
    data: {
      source: "UPLOAD",
      status: "READY",
      fileName: FILE,
      sheetNames: [SHEET, "Ashanti"],
      plan: { tables: [], summary: "" } as never,
    },
  });
  created.imports.push(record.id);
  return record.id;
}

async function main() {
  await reset();
  const buffer = await workbook();

  console.log("\nThe plan the rules read off it");
  const plan = await planFor(buffer, "sheet");
  const accra = plan.tables.filter((table) => table.sheet === SHEET);
  check("three sections are found on the first tab", accra.length === 3, `${accra.length} tables`);
  check("...and one on the second", plan.tables.filter((table) => table.sheet === "Ashanti").length === 1);
  check("the third section's email column is read as an email column", accra[2]?.columns.some((column) => column.field === "contactEmail") === true);

  const groups = planGroups(plan);
  check("they become two lists, one per worksheet", groups.length === 2, `${groups.length} lists`);
  check("...the first named after its tab", groups[0]?.title === SHEET, groups[0]?.title);
  // A tab holding one table keeps that table's own title, which is nearly
  // always more use than the tab name — "Companies/Organizations" over "Sheet1".
  check("...and the second, holding one table, keeps that table's title", groups[1]?.tables.length === 1);

  console.log("\nCommitting it");
  const importId = await openImport();
  const source = sourceFromUpload(buffer, FILE);
  const result = await commitPlan(importId, source, plan);
  source.release();

  check("two lists were created", result.groupsCreated === 2, `${result.groupsCreated}`);
  check("...and reported as two lines, not four", result.groups.length === 2, `${result.groups.length} lines`);
  check("every lead in the file arrived", result.leadsCreated === 12, `${result.leadsCreated} created`);

  const written = await prisma.leadGroup.findMany({
    where: { leadImportId: importId },
    include: { fields: true, _count: { select: { leads: true } } },
  });
  created.groups.push(...written.map((group) => group.id));
  const merged = written.find((group) => group.name === SHEET);
  check("the worksheet's three sections are one list", merged?._count.leads === 10, `${merged?._count.leads} leads`);
  check("...and the list says which sections it holds", (merged?.description ?? "").includes("3 tables"), merged?.description ?? "");
  check(
    "...covering the whole range of the tab",
    (merged?.sourceLabel ?? "").startsWith(`${SHEET}!`),
    merged?.sourceLabel ?? "",
  );

  // The negative that matters: merging onto the first section's columns is how
  // the third section's email addresses would arrive with nowhere to go.
  check(
    "the merged list holds the column only its third section had",
    merged?.fields.some((field) => field.key === "contactEmail") === true,
    JSON.stringify(merged?.fields.map((field) => field.key)),
  );
  check("...and no column is in it twice", new Set(merged?.fields.map((field) => field.key)).size === merged?.fields.length);
  const withEmail = await prisma.lead.count({ where: { groupId: merged?.id, contactEmail: { not: null } } });
  check("...so those three leads really do have an email address", withEmail === 3, `${withEmail}`);

  console.log("\nThe tags");
  check("the list carries its worksheet", merged?.tags.includes(SHEET_TAG) === true, JSON.stringify(merged?.tags));
  check("...and the file it came out of", merged?.tags.includes(FILE_TAG) === true, JSON.stringify(merged?.tags));
  const leads = await prisma.lead.findMany({ where: { groupId: merged?.id }, select: { id: true, tags: true, contactName: true } });
  check("every lead carries them too", leads.every((lead) => lead.tags.includes(SHEET_TAG) && lead.tags.includes(FILE_TAG)));
  check(
    "...as slugs, not as the words",
    leads.every((lead) => lead.tags.every((tag) => tag === tagSlug(tag))),
    JSON.stringify(leads[0]?.tags),
  );
  // A slug in an array with no registry row behind it is a tag the Tags screen
  // cannot show, rename or colour — which is the state every imported tag was
  // in before `registerTags` existed.
  const registered = await prisma.leadTag.findMany({ where: { slug: { in: [SHEET_TAG, FILE_TAG] } } });
  check("both are in the registry", registered.length === 2, `${registered.length}`);
  check("...under the words they were written as", registered.some((tag) => tag.label === SHEET), JSON.stringify(registered.map((tag) => tag.label)));

  const ashanti = written.find((group) => group.name !== SHEET);
  check("the other tab's leads carry that tab's name instead", ashanti?.tags.includes(tagSlug("Ashanti")!) === true, JSON.stringify(ashanti?.tags));

  console.log("\nRe-importing the same file");
  // Somebody tagged a lead by hand. A refresh must not take that off it.
  const byHand = leads[0]!;
  await prisma.lead.update({ where: { id: byHand.id }, data: { tags: [...byHand.tags, "hot"] } });

  const secondId = await openImport();
  const again = sourceFromUpload(buffer, FILE);
  const rerun = await commitPlan(secondId, again, await planFor(buffer, "sheet"));
  again.release();
  const reGroups = await prisma.leadGroup.findMany({ where: { leadImportId: secondId }, select: { id: true } });
  created.groups.push(...reGroups.map((group) => group.id));

  check("nothing is duplicated", rerun.leadsCreated === 0, `${rerun.leadsCreated} created`);
  check("...the same leads are refreshed", rerun.leadsUpdated === 12, `${rerun.leadsUpdated} updated`);
  const after = await prisma.lead.findUnique({ where: { id: byHand.id }, select: { tags: true } });
  check("a tag somebody added by hand survives the refresh", after?.tags.includes("hot") === true, JSON.stringify(after?.tags));
  check("...and the worksheet's tag is still there", after?.tags.includes(SHEET_TAG) === true, JSON.stringify(after?.tags));

  console.log("\nAsking for a list per table instead");
  const thirdId = await openImport();
  await prisma.lead.deleteMany({ where: { groupId: { in: created.groups } } });
  const perTable = sourceFromUpload(buffer, FILE);
  const split = await commitPlan(thirdId, perTable, await planFor(buffer, "table"));
  perTable.release();
  const splitGroups = await prisma.leadGroup.findMany({ where: { leadImportId: thirdId }, select: { id: true, name: true, tags: true } });
  created.groups.push(...splitGroups.map((group) => group.id));

  check("every detected table gets its own list", split.groupsCreated === 4, `${split.groupsCreated} lists`);
  check("...named after its own section", splitGroups.some((group) => group.name === "ACCRA"), JSON.stringify(splitGroups.map((group) => group.name)));
  check("...and still tagged with the worksheet they share", splitGroups.filter((group) => group.tags.includes(SHEET_TAG)).length === 3);

  await reset();
  await prisma.$disconnect();

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log(failures.map((name) => `  - ${name}`).join("\n"));
    process.exit(1);
  }
}

main().catch(async (err) => {
  console.error(err);
  await reset().catch(() => {});
  await prisma.$disconnect();
  process.exit(1);
});
