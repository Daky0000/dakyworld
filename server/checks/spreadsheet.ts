/**
 * Does a big lead sheet still read the same way it did when we loaded it whole?
 *
 * Importing a sheet with real data in it used to take the service down. Every
 * xlsx went through `workbook.xlsx.load()`, which builds the entire file as an
 * object model — every cell its own JS object, read or not — and a 4.5 MB
 * workbook peaked at ~600 MB resident and never gave it back. The wizard pays
 * for that twice, once to list the tabs and again to analyse, so the second
 * request is the one that died; and a process killed mid-request answers the
 * browser with a gateway error carrying no JSON, which the client rendered as a
 * red bar with nothing written in it. Press Analyse, get a blank.
 *
 * The reader streams now. That is a change to how every cell in every import is
 * read, so what this check is really for is the *sameness*: the streaming
 * reader and the whole-file one must produce byte-identical grids, because
 * everything downstream — the table detector, the analyst's row indices, the
 * importer — is arithmetic on those exact positions.
 *
 * Four things here would each be silent if they broke:
 *
 *   - **Blank rows keep their place.** The streaming reader does not emit them
 *     at all, and blank rows are exactly what the detector reads to find where
 *     one table ends and the next begins. A row placed by arrival order rather
 *     than by its own row number shifts every index below it, and the plan the
 *     analyst returns then describes rows nobody chose.
 *   - **Dates stay dates.** A date in xlsx is a number plus a number format,
 *     and the format lives in the styles part. Reading with `styles: "ignore"`
 *     is faster and turns every date column into 46023.
 *   - **A truncated sheet says so.** The cap trimmed 20,000 rows to 5,000 and
 *     then reported `truncated: false`, because the count was taken after the
 *     trim. 15,000 leads, gone with nothing said about it.
 *   - **A file that will not stream is still read.** ExcelJS's streaming reader
 *     has a race on workbooks small enough for every zip entry to land in one
 *     tick — an 8 KB file with hyperlinks in it failed 14 times in 20 — so the
 *     reader retries and then falls back to loading the workbook whole. The
 *     fallback is the floor: a file must never be refused because of the race.
 *
 * Fixtures are built here rather than committed, so this needs no database, no
 * key, no network and no binary in the repository.
 *   npx tsx checks/spreadsheet.ts
 */
import ExcelJS from "exceljs";
import {
  MAX_COLUMNS,
  MAX_ROWS_PER_SHEET,
  isSpreadsheetName,
  listWorkbookSheets,
  parseCsvCapped,
  parseWorkbook,
  toGrid,
  type SheetGrid,
} from "../src/services/spreadsheet.js";
import { assertSpreadsheetBytes } from "../src/lib/fileType.js";

/**
 * A zip whose local file header declares `uncompressed` bytes of contents.
 *
 * Built rather than committed, for the same reason as every other fixture
 * here. It only has to be well-formed as far as `assertSafeZip` reads — the
 * signature, the two sizes and the two lengths — because the whole point is
 * that the declared size is refused before any reader unpacks it.
 */
function declaredZip(uncompressed: number): Buffer {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt32LE(64, 18); // compressed size
  header.writeUInt32LE(uncompressed, 22);
  header.writeUInt16LE(0, 26); // name length
  header.writeUInt16LE(0, 28); // extra length
  return Buffer.concat([header, Buffer.alloc(64, 0x41)]);
}

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

/** The reader this replaced, kept here as the thing the new one must agree with. */
async function loadWholeWorkbook(buffer: Buffer): Promise<SheetGrid[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const grids: SheetGrid[] = [];
  workbook.eachSheet((worksheet) => {
    const rows: string[][] = [];
    const lastRow = Math.min(worksheet.rowCount, MAX_ROWS_PER_SHEET);
    const lastColumn = Math.min(worksheet.columnCount || 0, MAX_COLUMNS);
    for (let rowNumber = 1; rowNumber <= lastRow; rowNumber += 1) {
      const row = worksheet.getRow(rowNumber);
      const cells: string[] = [];
      for (let column = 1; column <= lastColumn; column += 1) {
        const value = row.getCell(column).value;
        cells.push(text(value));
      }
      rows.push(cells);
    }
    const grid = toGrid(worksheet.name, rows, worksheet.rowCount);
    if (grid.rows.length) grids.push(grid);
  });
  return grids;
}

function text(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    const cell = value as unknown as Record<string, unknown>;
    if ("text" in cell && typeof cell.text === "string") return cell.text.trim();
    if ("richText" in cell && Array.isArray(cell.richText)) {
      return (cell.richText as { text?: string }[]).map((run) => run.text ?? "").join("").trim();
    }
    if ("result" in cell) return text(cell.result as ExcelJS.CellValue);
    if ("hyperlink" in cell && typeof cell.hyperlink === "string") return cell.hyperlink.trim();
    return "";
  }
  return String(value).trim();
}

async function toBuffer(workbook: ExcelJS.Workbook): Promise<Buffer> {
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/**
 * A file shaped like the ones this actually goes wrong on: a banner row, a gap,
 * a header, blank rows inside the table, dates, formulas, hyperlinks and rich
 * text, and a second tab that is not a table of leads at all.
 */
async function messyWorkbook(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Accra Leads");
  sheet.addRow(["ACCRA LEADS — MASTER LIST"]);
  sheet.addRow([]);
  sheet.addRow(["S/N", "Business", "Contact", "Phone", "Email", "Website", "Added", "Notes"]);
  for (let index = 1; index <= 40; index += 1) {
    // Deleted rows and numbering gaps are normal inside a real list.
    if (index % 12 === 0) {
      sheet.addRow([]);
      continue;
    }
    const row = sheet.addRow([
      index,
      { richText: [{ text: "Biz " }, { text: String(index) }] },
      `Person ${index}`,
      `+23324${String(1000000 + index).slice(0, 7)}`,
      { text: `a${index}@biz${index}.com`, hyperlink: `mailto:a${index}@biz${index}.com` },
      { text: `biz${index}.com`, hyperlink: `https://biz${index}.com` },
      new Date(2026, 0, 1 + (index % 28)),
      { formula: `A${excelRow(index)}*2`, result: index * 2 },
    ]);
    row.getCell(7).numFmt = "dd/mm/yyyy";
  }
  const legend = workbook.addWorksheet("Notes & Legend");
  legend.addRow(["Legend"]);
  legend.addRow(["New", "not contacted"]);
  return toBuffer(workbook);

  /** The 1-based spreadsheet row a loop index lands on, for the formula text. */
  function excelRow(n: number) {
    return n + 3;
  }
}

/** Longer than the cap, so the count and the trim can disagree. */
async function longWorkbook(rows: number): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Leads");
  sheet.addRow(["S/N", "Business", "Contact", "Phone", "Email"]);
  for (let index = 1; index <= rows; index += 1) {
    sheet.addRow([index, `Biz ${index}`, `Person ${index}`, `+2332400000${index % 10}`, `a${index}@biz.com`]);
  }
  return toBuffer(workbook);
}

async function main() {
  console.log("\nReading a messy workbook");
  const messy = await messyWorkbook();

  const streamed = await parseWorkbook(messy, "messy.xlsx");
  const loaded = await loadWholeWorkbook(messy);
  check(
    "the streaming reader and the whole-file reader produce identical grids",
    JSON.stringify(streamed.map((grid) => grid.rows)) === JSON.stringify(loaded.map((grid) => grid.rows)),
    firstDifference(streamed, loaded),
  );

  const accra = streamed.find((grid) => grid.name === "Accra Leads");
  check("both tabs are read, by their own names", streamed.map((g) => g.name).join(",") === "Accra Leads,Notes & Legend", streamed.map((g) => g.name).join(","));
  check("the banner row is row 0, exactly where it sits in the file", accra?.rows[0]?.[0] === "ACCRA LEADS — MASTER LIST");
  check("the gap under the banner is kept as a blank row", accra?.rows[1]?.every((cell) => !cell) === true);
  check("the header row is row 2", accra?.rows[2]?.[0] === "S/N" && accra?.rows[2]?.[1] === "Business");
  check(
    "a blank row inside the table keeps its place",
    // Row 12 of the loop was skipped, so grid row 3 + 12 - 1 = 14 is blank and 15 carries lead 13.
    accra?.rows[14]?.every((cell) => !cell) === true && accra?.rows[15]?.[0] === "13",
    JSON.stringify(accra?.rows.slice(13, 16)),
  );
  check("a date is a date, not a serial number", accra?.rows[3]?.[6] === "2026-01-02", accra?.rows[3]?.[6]);
  check("rich text reads as one value", accra?.rows[3]?.[1] === "Biz 1", accra?.rows[3]?.[1]);
  check("a hyperlink reads as its display text", accra?.rows[3]?.[5] === "biz1.com", accra?.rows[3]?.[5]);
  check("a formula reads as its cached result", accra?.rows[3]?.[7] === "2", accra?.rows[3]?.[7]);

  check("tab names are listed without reading the sheets", (await listWorkbookSheets(messy, "messy.xlsx")).join(",") === "Accra Leads,Notes & Legend");

  const oneTab = await parseWorkbook(messy, "messy.xlsx", ["Notes & Legend"]);
  check("asking for one tab reads one tab", oneTab.length === 1 && oneTab[0].name === "Notes & Legend", oneTab.map((g) => g.name).join(","));

  console.log("\nA sheet longer than the cap");
  const long = await parseWorkbook(await longWorkbook(MAX_ROWS_PER_SHEET + 2500), "long.xlsx");
  check("the grid is capped", long[0]?.rows.length === MAX_ROWS_PER_SHEET, String(long[0]?.rows.length));
  check("the true row count survives the cap", long[0]?.totalRows === MAX_ROWS_PER_SHEET + 2501, String(long[0]?.totalRows));
  check("and it is reported as truncated", long[0]?.truncated === true);

  const short = await parseWorkbook(await longWorkbook(50), "short.xlsx");
  check("a sheet inside the cap is not reported as truncated", short[0]?.truncated === false && short[0]?.totalRows === 51, `${short[0]?.totalRows}`);

  console.log("\nA CSV longer than the cap");
  const lines = ["Name,Email"];
  for (let index = 1; index <= MAX_ROWS_PER_SHEET + 1200; index += 1) lines.push(`Person ${index},a${index}@biz.com`);
  const csv = parseCsvCapped(lines.join("\n"));
  check("the CSV parser stops building rows at the cap", csv.rows.length === MAX_ROWS_PER_SHEET, String(csv.rows.length));
  check("and still counts to the end of the file", csv.sourceRows === MAX_ROWS_PER_SHEET + 1201, String(csv.sourceRows));
  check("quoted fields still survive the capped parse", parseCsvCapped('a,"b,c"\n"d""e",f').rows[0].join("|") === 'a|b,c');

  console.log("\nThe race, and the floor under it");
  // The failure is timing, so it is not reproducible on demand — what can be
  // pinned is that a file which triggers it is read anyway, every time, with
  // the same answer. Twelve runs of the tiny hyperlinked shape that failed
  // 14 times in 20 against the bare streaming reader.
  const tiny = new ExcelJS.Workbook();
  const tinySheet = tiny.addWorksheet("Mixed");
  tinySheet.addRow(["Name", "Site"]);
  tinySheet.addRow(["Kofi", { text: "kofi.com", hyperlink: "https://kofi.com" }]);
  const tinyBuffer = await toBuffer(tiny);

  let stable = true;
  let shape: string | null = null;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      const grids = await parseWorkbook(tinyBuffer, "tiny.xlsx");
      const names = await listWorkbookSheets(tinyBuffer, "tiny.xlsx");
      const rendered = `${names.join(",")}|${JSON.stringify(grids.map((g) => g.rows))}`;
      shape ??= rendered;
      if (rendered !== shape) stable = false;
    } catch {
      stable = false;
    }
  }
  check("a workbook small enough to trip the reader's race is read anyway, identically, 12 times running", stable, shape ?? "(threw)");
  check("and the sheet keeps its real name rather than a positional one", shape?.startsWith("Mixed|") === true, shape?.slice(0, 40));

  console.log("\nA file that is not a spreadsheet");
  let refused = "";
  try {
    await parseWorkbook(Buffer.from("this is not a workbook"), "junk.xlsx");
  } catch (err) {
    refused = (err as Error).message;
  }
  check("a corrupt file is refused with a sentence rather than read as empty", refused.startsWith("That file couldn't be read as a spreadsheet"), refused);

  let refusedOld = "";
  try {
    await parseWorkbook(Buffer.from("old"), "leads.xls");
  } catch (err) {
    refusedOld = (err as Error).message;
  }
  check("an .xls is still turned away with the instruction to re-save it", refusedOld.includes("save it as .xlsx"), refusedOld);

  // --- A quote in the middle of a field ------------------------------------
  //
  // The worst defect this file has held, and it was silent in the direction
  // that loses the most: a quote opened a quoted field wherever it appeared,
  // so `6" pipe,Accra` swallowed its delimiter, then its newline, then every
  // remaining row of the file into one field — because the closing quote it
  // was waiting for never came. A 46,000-row sheet imported as one lead and
  // reported success. Inch marks, unquoted nicknames and sizes are ordinary
  // content in a list of Ghanaian trade businesses.
  const cascade = parseCsvCapped('name,city\n6" pipe,Accra\nAda,Kumasi\nKofi,Tema').rows;
  check("a quote mid-field does not swallow the rest of the file", cascade.length === 4, JSON.stringify(cascade));
  check("...and the row it sits on keeps both of its columns", JSON.stringify(cascade[1]) === '["6\\" pipe","Accra"]', JSON.stringify(cascade[1]));
  check("...and the quote survives as a character", cascade[1]?.[0] === '6" pipe', cascade[1]?.[0]);
  check("...and the rows below it are still their own rows", cascade[3]?.[0] === "Kofi", JSON.stringify(cascade[3]));

  // The negatives. A quote at the *start* of a field is the one that must go
  // on delimiting, or fixing the above breaks every properly-quoted export.
  check("a quoted field still holds its delimiter", JSON.stringify(parseCsvCapped('a,b\n"x,y",z').rows[1]) === '["x,y","z"]');
  check('a doubled "" is still one quote', parseCsvCapped('a,b\n"say ""hi""",z').rows[1]?.[0] === 'say "hi"');
  check("a quoted field still holds its newline", parseCsvCapped('a,b\n"line1\nline2",z').rows[1]?.[0] === "line1\nline2");
  check("an empty quoted field is still empty", JSON.stringify(parseCsvCapped('a,b,c\n1,"",3').rows[1]) === '["1","","3"]');
  // Some exporters leave a space after the delimiter. That quote is still an
  // opening one, which is why the guard tests the trimmed field rather than an
  // empty one — every push here trims, so the space was being discarded anyway.
  check("a quote after a space still opens a quoted field", JSON.stringify(parseCsvCapped('a,b\nx, "Accra, GH"').rows[1]) === '["x","Accra, GH"]');

  // --- Which character is the delimiter ------------------------------------
  //
  // The sniffer counted every candidate across the sample without regard for
  // quoting, so one quoted address holding four commas outvoted the semicolons
  // actually separating the fields — and a semicolon-delimited export, which
  // is what Excel produces by default across much of Europe, arrived with
  // every row as a single column.
  const semi = parseCsvCapped('a;b\n"x,y,z,w";2').rows;
  check("a semicolon file is not read as comma-delimited by its quoted commas", JSON.stringify(semi[1]) === '["x,y,z,w","2"]', JSON.stringify(semi));
  check("a tab file is still read as tab-delimited", JSON.stringify(parseCsvCapped('a\tb\n"x,y"\t2').rows[1]) === '["x,y","2"]');
  check("an ordinary comma file is still read as comma-delimited", JSON.stringify(parseCsvCapped("name,city\nAda,Accra").rows[1]) === '["Ada","Accra"]');

  // --- The bytes are judged, not the name ---------------------------------
  //
  // `assertSpreadsheetBytes` was written for exactly this, documented in
  // SECURITY.md as the rule ("uploads are judged on their bytes, never on the
  // filename"), and wired to nothing — so `.xlsx` reached a zip reader on the
  // strength of four characters of a string the client chose.
  const bomb = declaredZip(900 * 1024 * 1024);
  let bombRefusal = "";
  try {
    assertSpreadsheetBytes(bomb, "leads.xlsx");
  } catch (err) {
    bombRefusal = (err as Error).message;
  }
  check("a zip declaring gigabytes of expansion is refused unopened", bombRefusal.includes("has not been opened"), bombRefusal || "accepted");

  let wrongBytes = "";
  try {
    assertSpreadsheetBytes(Buffer.from("id,name\n1,Ada"), "leads.xlsx");
  } catch (err) {
    wrongBytes = (err as Error).message;
  }
  check("a CSV renamed .xlsx is refused before the zip reader sees it", wrongBytes.includes("is not a spreadsheet"), wrongBytes || "accepted");

  let binaryCsv = "";
  try {
    assertSpreadsheetBytes(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]), "leads.csv");
  } catch (err) {
    binaryCsv = (err as Error).message;
  }
  check("a zip renamed .csv is refused before the text reader sees it", binaryCsv.includes("is not text"), binaryCsv || "accepted");

  // The extension lists have to stay level with `isSpreadsheetName` and
  // `isCsvName`, which are what the routes accept. They were not: this
  // refused `.xlsm` and `.txt` while the routes took both, so wiring it in as
  // it stood would have started turning away two formats that imported fine.
  for (const name of ["leads.csv", "leads.tsv", "leads.txt"]) {
    let refusal = "";
    try {
      assertSpreadsheetBytes(Buffer.from("id,name\n1,Ada"), name);
    } catch (err) {
      refusal = (err as Error).message;
    }
    check(`a text ${name.slice(name.lastIndexOf("."))} the routes accept is accepted here too`, refusal === "", refusal);
    check(`...and ${name} is a name the routes accept`, isSpreadsheetName(name));
  }
  for (const name of ["leads.xlsx", "leads.xlsm"]) {
    let refusal = "";
    try {
      assertSpreadsheetBytes(declaredZip(1024), name);
    } catch (err) {
      refusal = (err as Error).message;
    }
    check(`a real zip named ${name.slice(name.lastIndexOf("."))} is accepted`, refusal === "", refusal);
    check(`...and ${name} is a name the routes accept`, isSpreadsheetName(name));
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const name of failures) console.log(`  - ${name}`);
    process.exit(1);
  }
}

function firstDifference(a: SheetGrid[], b: SheetGrid[]): string {
  for (let sheet = 0; sheet < Math.max(a.length, b.length); sheet += 1) {
    const left = a[sheet]?.rows ?? [];
    const right = b[sheet]?.rows ?? [];
    for (let row = 0; row < Math.max(left.length, right.length); row += 1) {
      if (JSON.stringify(left[row]) !== JSON.stringify(right[row])) {
        return `sheet ${sheet} row ${row}: streamed ${JSON.stringify(left[row])} vs loaded ${JSON.stringify(right[row])}`;
      }
    }
  }
  return "";
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
