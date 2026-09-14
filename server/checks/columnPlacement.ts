/**
 * Is a column read for what it holds, or for what it is headed?
 *
 * Real lead sheets put the names in the wrong column all the time: people's
 * names under "Company", the email under "Contact", or a header row one cell
 * out so the names land in a column nothing maps. Read on the header alone,
 * those rows import with no name at all — and a lead with no name is dropped
 * by `extractRows` — or with a business where the person should be, which is
 * the word the first cold email then greets them by.
 *
 * So `repairPlan` now reads the cells and, where they are unmistakable, moves
 * the mapping to them and says so. The negatives are the half worth reading,
 * because each is a way of making the repair worse than the fault:
 *
 *   - **A correct sheet must come through untouched.** A repair that fires on
 *     a clean file is a bug that reorders somebody's columns for nothing.
 *   - **The displaced column must keep its data**, in the field its own cells
 *     belong to where that is free, and as a custom column otherwise.
 *   - **A column of cities, categories or statuses is not a name**, however
 *     name-shaped the words are — "Accra" repeated forty times is a category.
 *   - **A business name is not a person's name**, or a swap "corrects" a
 *     company sheet into greeting Mensah Foods Ltd by first name.
 *
 * No database, no API key, no network.
 *   npx tsx checks/columnPlacement.ts
 */
import { detectTables, repairPlan, type ImportPlan } from "../src/services/sheetPlan.js";
import type { SheetGrid } from "../src/services/spreadsheet.js";

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

function grid(rows: string[][]): SheetGrid {
  const width = Math.max(...rows.map((row) => row.length));
  const padded = rows.map((row) => [...row, ...Array(width - row.length).fill("")]);
  return { name: "Leads", rows: padded, totalRows: padded.length, truncated: false };
}

/** The plan as the rules read the file, then repaired — the analyst's path. */
function planFor(sheet: SheetGrid): { plan: ImportPlan; repairs: string[] } {
  const tables = detectTables([sheet]);
  return repairPlan({ tables, summary: "" }, [sheet], tables);
}

function fieldOf(plan: ImportPlan, header: string): string | undefined {
  for (const table of plan.tables) {
    const column = table.columns.find((entry) => entry.header.trim().toLowerCase() === header.toLowerCase());
    if (column) return column.field;
  }
  return undefined;
}

// --- The sheet that started this -------------------------------------------
//
// Whoever typed it put the people under "Company" and the businesses under
// "Name". Every header is a real header; every one of them is wrong.

const swapped = grid([
  ["Company", "Name", "Contact"],
  ["Kofi Mensah", "Mensah Foods Ltd", "kofi@mensahfoods.com"],
  ["Ama Owusu", "Owusu Dental Clinic", "ama@owusudental.com"],
  ["Yaw Boateng", "Boateng Motors Ltd", "yaw@boatengmotors.com"],
  ["Adwoa Tetteh", "Tetteh Hotel", "adwoa@tettehhotel.com"],
  ["Kwame Asare", "Asare Engineering Ltd", "kwame@asare.com"],
  ["Efua Darko", "Darko Pharmacy", "efua@darkopharmacy.com"],
]);

{
  const { plan, repairs } = planFor(swapped);
  check("names under \"Company\" are read as the name", fieldOf(plan, "Company") === "contactName", fieldOf(plan, "Company"));
  check("businesses under \"Name\" are read as the company", fieldOf(plan, "Name") === "companyName", fieldOf(plan, "Name"));
  check("the email column is left where it already was", fieldOf(plan, "Contact") === "contactEmail", fieldOf(plan, "Contact"));
  check("the swap is reported to the Owner", repairs.some((line) => /people's names/.test(line)), repairs.join(" | "));
}

// --- A clean sheet must not be touched --------------------------------------

const clean = grid([
  ["Name", "Company", "Email", "City", "Status"],
  ["Kofi Mensah", "Mensah Foods Ltd", "kofi@mensahfoods.com", "Accra", "New"],
  ["Ama Owusu", "Owusu Dental Clinic", "ama@owusudental.com", "Accra", "New"],
  ["Yaw Boateng", "Boateng Motors Ltd", "yaw@boatengmotors.com", "Kumasi", "Contacted"],
  ["Adwoa Tetteh", "Tetteh Hotel", "adwoa@tettehhotel.com", "Accra", "New"],
  ["Kwame Asare", "Asare Engineering Ltd", "kwame@asare.com", "Takoradi", "New"],
]);

{
  const { plan, repairs } = planFor(clean);
  check("a correct sheet keeps its name column", fieldOf(plan, "Name") === "contactName", fieldOf(plan, "Name"));
  check("a correct sheet keeps its company column", fieldOf(plan, "Company") === "companyName", fieldOf(plan, "Company"));
  check("a city column is not mistaken for a name", fieldOf(plan, "City") !== "contactName", fieldOf(plan, "City"));
  check("a correct sheet is repaired at all", repairs.length === 0, repairs.join(" | "));
}

// --- A name column nothing mapped -------------------------------------------
//
// The header says "Ref", so no rule claims it; the cells are plainly people.
// Without the repair this table has no name column and every row is dropped.

const mislabelled = grid([
  ["Ref", "Email", "Phone"],
  ["Kofi Mensah", "kofi@mensahfoods.com", "0244 987 654"],
  ["Ama Owusu", "ama@owusudental.com", "0201 445 221"],
  ["Yaw Boateng", "yaw@boatengmotors.com", "0271 003 918"],
  ["Adwoa Tetteh", "adwoa@tettehhotel.com", "0558 220 114"],
  ["Kwame Asare", "kwame@asare.com", "0246 771 200"],
]);

{
  const { plan } = planFor(mislabelled);
  check("a name column under an unrelated header is found", fieldOf(plan, "Ref") === "contactName", fieldOf(plan, "Ref"));
  check("the phone column is unaffected", fieldOf(plan, "Phone") === "contactPhone", fieldOf(plan, "Phone"));
}

// --- The displaced column keeps its data ------------------------------------
//
// "Name" holds statuses here — nothing else can hold them, so it must land in
// a custom column rather than be thrown away with the mapping it lost.

const displaced = grid([
  ["Name", "Owner", "Email"],
  ["Waiting on quote", "Kofi Mensah", "kofi@mensahfoods.com"],
  ["Sent proposal", "Ama Owusu", "ama@owusudental.com"],
  ["No answer yet", "Yaw Boateng", "yaw@boatengmotors.com"],
  ["Waiting on us", "Adwoa Tetteh", "adwoa@tettehhotel.com"],
  ["Sent proposal twice", "Kwame Asare", "kwame@asare.com"],
]);

{
  const { plan } = planFor(displaced);
  check("the real names take the name field", fieldOf(plan, "Owner") === "contactName", fieldOf(plan, "Owner"));
  check("the column they took it from is kept", fieldOf(plan, "Name") === "custom", fieldOf(plan, "Name"));
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
