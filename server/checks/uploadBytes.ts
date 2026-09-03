/**
 * Are uploads judged on their bytes — both paths, one rule?
 *
 * SECURITY.md states the rule plainly — *"uploads are judged on their bytes
 * (`lib/fileType.ts`), never on the filename or the `data:` prefix, both of
 * which the caller writes"* — and for the spreadsheet half it was not true.
 * `assertSpreadsheetBytes` was written for exactly this, is documented in its
 * own file as the fix for exactly this, has a ceiling on zip expansion behind
 * it, and **was called by nothing**. The import routes checked
 * `isSpreadsheetName(fileName)` and handed the bytes straight to a zip reader,
 * so `.xlsx` reached ExcelJS on the strength of four characters at the end of a
 * string the client chose — and reached it again on each of the reader's three
 * retries.
 *
 * That is the defect class this codebase keeps producing: a guard that is
 * written, tested, documented and wired to nothing. `checks/spreadsheet.ts`
 * asserts the function; **this file asserts that a route calls it**, which is
 * the half that was missing and the only half that was ever broken.
 *
 * So it goes over real HTTP against the router mounted the way `index.ts`
 * mounts it, for the same reason `tmp/accessOverHttp.ts` does: a guard sitting
 * in a function nothing reaches compiles, typechecks, and passes a unit test of
 * itself while letting everything through.
 *
 * The negatives are the half worth keeping. A real CSV and a real workbook must
 * still import — a validator that refuses good files is a worse defect than the
 * one it fixed, and the extension lists behind this one were genuinely out of
 * step with the routes' own (`.xlsm` and `.txt`) before it was wired in.
 *
 * The image half is here too, because it is the same rule and the same file
 * enforcing it — and because the SVG guard is the one part of `fileType.ts`
 * whose strength depends on something outside it. An uploaded logo is rendered
 * through `<img src="data:…">` in the OS UI, through `<img>` in email, and
 * through PDFKit (which takes PNG and JPEG only) on documents. SVG loaded via
 * `<img>` is in the browser's secure static mode: no script runs and no
 * external reference is fetched, so none of the markup this refuses is
 * currently executable. It is refused anyway, and asserted here, because that
 * inertness is a property of the render path rather than of the file — an
 * inline `<svg>` or an `<object>` added to a screen later would make every one
 * of these live, and the guard is what makes that change safe rather than
 * urgent.
 *
 * Needs Postgres and nothing else. No key, no network, no committed fixture.
 *   npx tsx checks/uploadBytes.ts
 */
import express from "express";
import ExcelJS from "exceljs";
import { importsRouter } from "../src/routes/imports.js";
import { assertImageBytes } from "../src/lib/fileType.js";
import { prisma } from "../src/lib/prisma.js";

const PORT = 4611;

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

/**
 * A zip whose own local file header declares `uncompressed` bytes of contents.
 *
 * This is the shape that matters: a decompression bomb is a small, perfectly
 * valid archive that unpacks to gigabytes, and the way it takes a service down
 * is by being handed to a parser that expands it before anybody looks at the
 * size. Declaring the size honestly is the common case, which is why reading
 * the header is worth doing at all.
 */
function declaredZip(uncompressed: number): Buffer {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt32LE(64, 18);
  header.writeUInt32LE(uncompressed, 22);
  header.writeUInt16LE(0, 26);
  header.writeUInt16LE(0, 28);
  return Buffer.concat([header, Buffer.alloc(64, 0x41)]);
}

/** A real workbook, built here rather than committed. */
async function realWorkbook(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Leads");
  sheet.addRow(["Business", "Email", "Town"]);
  sheet.addRow(["Adom Plumbing", "hello@adom.test", "Accra"]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function main() {
  const app = express();
  // Mounted as index.ts mounts it: the router carries its own larger JSON
  // parser *inside* itself, after the role check, because an upload rides in
  // the body as base64. A harness adding one out here would be testing a
  // different stack from the one that runs.
  app.use("/api/imports", importsRouter);
  const server = app.listen(PORT, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));

  const sheets = async (fileName: string, bytes: Buffer) => {
    const response = await fetch(`http://127.0.0.1:${PORT}/api/imports/sheets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fileName, dataBase64: bytes.toString("base64") }),
    });
    const body = (await response.json().catch(() => ({}))) as { error?: string; sheets?: unknown[] };
    return { status: response.status, error: body.error ?? "", sheets: body.sheets };
  };

  console.log("\nA zip that declares gigabytes of expansion");
  {
    // 900 MB declared against 94 bytes on the wire. Both guards would catch
    // this — the absolute ceiling and the compression ratio — and either
    // sentence is the right answer.
    const result = await sheets("leads.xlsx", declaredZip(900 * 1024 * 1024));
    check("it is refused rather than opened", result.status === 400, `${result.status} ${result.error}`);
    check("...and the refusal says the file was not opened", result.error.includes("has not been opened"), result.error);
    check("...and no tab list comes back", result.sheets === undefined, JSON.stringify(result.sheets));
  }

  console.log("\nBytes that are not what the name says");
  {
    const result = await sheets("leads.xlsx", Buffer.from("Business,Email\nAdom,hello@adom.test\n"));
    check("a CSV renamed .xlsx is refused before the zip reader sees it", result.status === 400, `${result.status} ${result.error}`);
    check("...and the sentence names what is wrong with it", result.error.includes("is not a spreadsheet"), result.error);
  }
  {
    const result = await sheets("leads.csv", declaredZip(1024));
    check("a zip renamed .csv is refused before the text reader sees it", result.status === 400, `${result.status} ${result.error}`);
    check("...and the sentence names what is wrong with it", result.error.includes("is not text"), result.error);
  }
  {
    // The old binary format, renamed. It has its own sentence because the
    // remedy is different: re-save it, rather than send something else.
    const ole = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(64)]);
    const result = await sheets("leads.xlsx", ole);
    check("an .xls renamed .xlsx is told to re-save rather than told it is not a spreadsheet", result.error.includes("save it as .xlsx"), result.error);
  }

  console.log("\nAnd the files that must still import");
  {
    const result = await sheets("leads.csv", Buffer.from("Business,Email,Town\nAdom Plumbing,hello@adom.test,Accra\n"));
    check("an ordinary CSV is still read", result.status === 200, `${result.status} ${result.error}`);
    check("...and its tab is named after the file", Array.isArray(result.sheets) && result.sheets.length === 1, JSON.stringify(result.sheets));
  }
  {
    const result = await sheets("leads.xlsx", await realWorkbook());
    check("a real workbook is still read", result.status === 200, `${result.status} ${result.error}`);
    check("...and its tab comes back by name", JSON.stringify(result.sheets) === '["Leads"]', JSON.stringify(result.sheets));
  }
  {
    // `isSpreadsheetName` accepts these two and `assertSpreadsheetBytes` did
    // not, so wiring the check in without levelling the lists would have
    // started refusing formats that had been importing fine. Asserted through
    // the route because that is where the disagreement would show.
    const result = await sheets("leads.txt", Buffer.from("Business\tEmail\nAdom\thello@adom.test\n"));
    check("a .txt the routes accept is still read", result.status === 200, `${result.status} ${result.error}`);
  }
  {
    const workbook = await realWorkbook();
    const result = await sheets("leads.xlsm", workbook);
    check("an .xlsm the routes accept is still read", result.status === 200, `${result.status} ${result.error}`);
  }

  console.log("\nThe name is still checked as well as the bytes");
  {
    const result = await sheets("leads.pdf", Buffer.from("%PDF-1.4\n"));
    check("a format the app does not import is refused on its name", result.status === 400, `${result.status} ${result.error}`);
  }

  server.close();

  // --- The image half ------------------------------------------------------

  const svgRefused = (name: string, svg: string) => {
    let refused = false;
    try {
      assertImageBytes(Buffer.from(svg), "image/svg+xml");
    } catch {
      refused = true;
    }
    check(name, refused, "accepted");
  };
  const svgAccepted = (name: string, svg: string) => {
    let message = "";
    try {
      assertImageBytes(Buffer.from(svg), "image/svg+xml");
    } catch (err) {
      message = (err as Error).message;
    }
    check(name, message === "", message);
  };

  console.log("\nAn SVG logo that carries something executable");
  svgRefused("a script element", "<svg><script>alert(1)</script></svg>");
  svgRefused("an event handler attribute", '<svg onload="alert(1)"></svg>');
  svgRefused("a javascript: destination", '<svg><a href="javascript:alert(1)">x</a></svg>');
  svgRefused("the same destination through xlink", '<svg><a xlink:href="javascript:alert(1)">x</a></svg>');
  svgRefused("a foreignObject", "<svg><foreignObject><body/></foreignObject></svg>");
  svgRefused("a use pulling from another origin", '<svg><use href="http://evil.test/x.svg#a"/></svg>');
  // These two evade the rules above by spelling rather than by meaning, which
  // is why the test decodes character references and looks at what an
  // attribute is *named* rather than only at `on…=`.
  svgRefused("a handler element", '<svg><handler type="text/javascript">alert(1)</handler></svg>');
  svgRefused("an event handler set indirectly", '<svg><set attributeName="onload" to="alert(1)"/></svg>');
  svgRefused("a javascript: destination written as a character reference", '<svg><a href="&#106;avascript:alert(1)">x</a></svg>');

  console.log("\nAnd the logos that must still upload");
  // The negatives matter more than the positives here: a guard that refuses a
  // real logo is a worse defect than the one it was tightened for, and the
  // obvious over-broad spellings of the two rules above (`<set`, `<animate`)
  // would refuse every one of these.
  svgAccepted("a plain mark", '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>');
  svgAccepted(
    "a wordmark with a gradient and a style block",
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 60"><defs><linearGradient id="g"><stop stop-color="#3157FF"/><stop offset="1" stop-color="#B8FF3D"/></linearGradient><style>.w{fill:url(#g)}</style></defs><text class="w" y="40">Dakyworld</text></svg>',
  );
  svgAccepted("an animation of a real property", '<svg xmlns="http://www.w3.org/2000/svg"><circle r="10"><animate attributeName="opacity" values="0;1" dur="1s"/></circle></svg>');
  svgAccepted("a set of a real property", '<svg xmlns="http://www.w3.org/2000/svg"><rect><set attributeName="fill" to="#B8FF3D"/></rect></svg>');
  svgAccepted("a use pointing at a symbol in the same file", '<svg xmlns="http://www.w3.org/2000/svg"><symbol id="m"><path d="M0 0h10v10H0z"/></symbol><use href="#m"/></svg>');
  svgAccepted("an apostrophe written as a character reference", "<svg xmlns=\"http://www.w3.org/2000/svg\"><title>Daky&apos;s mark</title><rect/></svg>");
  svgAccepted("an ampersand in the wordmark", "<svg xmlns=\"http://www.w3.org/2000/svg\"><text>Bolts &amp; Pipes</text></svg>");

  console.log("\nAnd an image is still what it says it is");
  {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
    let message = "";
    try {
      assertImageBytes(png, "image/png");
    } catch (err) {
      message = (err as Error).message;
    }
    check("a real PNG is accepted", message === "", message);
  }
  {
    // The declared type is a string the caller wrote. SVG is text, so it
    // matches no signature — which is what makes "declared PNG, actually
    // markup" refusable rather than a guess.
    let refused = false;
    try {
      assertImageBytes(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), "image/png");
    } catch {
      refused = true;
    }
    check("SVG bytes declared as PNG are refused", refused, "accepted");
  }
  {
    let refused = false;
    try {
      assertImageBytes(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(8)]), "image/png");
    } catch {
      refused = true;
    }
    check("a JPEG declared as PNG is refused", refused, "accepted");
  }
  {
    // A webp is "RIFF", a length, then "WEBP". Recognising it by the offset-8
    // marker alone meant any file with those four bytes in the ninth position
    // sniffed as a webp — and since the only image rule is "what was sniffed
    // must equal what was declared", declaring `image/webp` was a way to store
    // arbitrary bytes as company artwork.
    const riff = (tag: string) => Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from(tag), Buffer.alloc(16)]);
    let realWebp = "";
    try {
      assertImageBytes(riff("WEBP"), "image/webp");
    } catch (err) {
      realWebp = (err as Error).message;
    }
    check("a real webp is accepted", realWebp === "", realWebp);

    let junkRefused = false;
    try {
      assertImageBytes(Buffer.concat([Buffer.alloc(8, 0x41), Buffer.from("WEBP"), Buffer.alloc(8)]), "image/webp");
    } catch {
      junkRefused = true;
    }
    check("bytes carrying only the offset-8 marker are not a webp", junkRefused, "accepted");

    let waveRefused = false;
    try {
      assertImageBytes(riff("WAVE"), "image/webp");
    } catch {
      waveRefused = true;
    }
    check("another RIFF container is not a webp", waveRefused, "accepted");
  }

  await prisma.$disconnect();

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const name of failures) console.log(`  - ${name}`);
    process.exit(1);
  }
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
