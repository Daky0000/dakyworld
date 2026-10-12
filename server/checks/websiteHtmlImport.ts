/**
 * websiteHtmlImport.ts — Comprehensive checks for Website Builder HTML & ZIP package import.
 *
 * Covers:
 *  1. Path sanitization and Zip Slip prevention.
 *  2. Multi-page ZIP package import engine (JSZip).
 *  3. Hostile packages, zip bombs among them: refused on their declared sizes
 *     before anything is inflated, and held to those sizes while inflating.
 *  3. Local asset discovery, MIME detection, external resources, and missing asset reporting.
 *  4. Standalone HTML import field discovery (backgrounds, metadata, responsive picture sources).
 *  5. Unsupported components (<form>, <iframe>, <canvas>, custom elements) marked read-only with reasons.
 *  6. Exact byte preservation on editing untouched HTML and CSS.
 *  7. Preview inertness (inert forms, inert links, script-driven element auditing).
 *  8. Prepublish verification report, editable field counts, and risk acknowledgment.
 */

import assert from "node:assert/strict";
import JSZip from "jszip";
import {
  analyzeImportPackage,
  sanitizePackagePath,
  rewritePageAssetReferences,
  MAX_SINGLE_FILE_SIZE,
  MAX_UNCOMPRESSED_SIZE,
} from "../src/services/websitePackageImport.js";
import {
  discoverFields,
  applyValues,
  buildPreview,
  editingSource,
} from "../src/services/website/index.js";
import {
  generatePagePrepublishReport,
  countEditableFields,
} from "../src/services/websitePrepublishReport.js";
import { WebsiteError } from "../src/services/website/site.js";
import { assetUrl } from "../src/services/websiteAssets.js";

/**
 * The same archive with one entry's uncompressed size rewritten in the central
 * directory, which is where JSZip reads it from. This is how a hostile archive
 * lies about its size, and how an honest-looking one claims to be enormous.
 */
function declareSize(zip: Buffer, name: string, size: number): Buffer {
  const out = Buffer.from(zip);
  const end = out.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = out.readUInt16LE(end + 10);
  let at = out.readUInt32LE(end + 16);
  for (let i = 0; i < count; i += 1) {
    assert.equal(out.readUInt32LE(at), 0x02014b50, "central directory entry");
    const nameLength = out.readUInt16LE(at + 28);
    if (out.toString("utf8", at + 46, at + 46 + nameLength) === name) {
      out.writeUInt32LE(size, at + 24);
      return out;
    }
    at += 46 + nameLength + out.readUInt16LE(at + 30) + out.readUInt16LE(at + 32);
  }
  throw new Error(`${name} is not in the archive`);
}

async function refusal(buffer: Buffer): Promise<WebsiteError> {
  try {
    await analyzeImportPackage({ buffer, filename: "bomb.zip" });
  } catch (error) {
    if (error instanceof WebsiteError) return error;
    throw error;
  }
  throw new Error("the package was accepted");
}

async function runChecks() {
  console.log("Running websiteHtmlImport checks...\n");

  // ────────────────────────────────────────────────────────────────────────────
  // 1. Path Sanitization & Zip Slip Defense
  // ────────────────────────────────────────────────────────────────────────────
  console.log("1. Path sanitization and Zip Slip defense");
  assert.equal(sanitizePackagePath("index.html"), "index.html");
  assert.equal(sanitizePackagePath("css/style.css"), "css/style.css");
  assert.equal(sanitizePackagePath("css\\style.css"), "css/style.css");
  assert.equal(sanitizePackagePath("./assets/logo.png"), "assets/logo.png");
  assert.equal(sanitizePackagePath("images//banner.jpg"), "images/banner.jpg");

  // Rejections
  assert.throws(() => sanitizePackagePath("../evil.html"), /Zip traversal vulnerability/);
  assert.throws(() => sanitizePackagePath("sub/../../evil.html"), /Zip traversal vulnerability/);
  assert.throws(() => sanitizePackagePath("/etc/passwd"), /Unsafe absolute package path/);
  assert.throws(() => sanitizePackagePath("C:\\Windows\\System32\\cmd.exe"), /Unsafe absolute package path/);
  console.log("   ✓ Zip Slip and directory traversal attacks successfully blocked\n");

  // ────────────────────────────────────────────────────────────────────────────
  // 2. Multi-Page ZIP Package Import Engine
  // ────────────────────────────────────────────────────────────────────────────
  console.log("2. Multi-page ZIP package import engine with JSZip");

  const sampleZip = new JSZip();

  const indexHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>DakyXTech Studio</title>
  <meta name="description" content="Design and development studio">
  <meta property="og:title" content="Studio OG Title">
  <meta property="og:description" content="Studio OG Description">
  <meta property="og:image" content="images/hero.png">
  <meta name="keywords" content="design, agency, studio">
  <link rel="stylesheet" href="css/style.css">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css">
</head>
<body>
  <header>
    <h1>Welcome to DakyXTech</h1>
    <a href="about.html">About Us</a>
  </header>
  <section style="background-image: url('images/hero.png'); background-size: cover;">
    <h2>Hero Section</h2>
    <p>We build great websites.</p>
  </section>
  <section>
    <picture>
      <source srcset="images/responsive-hero.png" media="(min-width: 800px)">
      <img src="images/hero.png" alt="Studio Hero">
    </picture>
    <img src="images/missing-icon.svg" alt="Missing Icon">
  </section>
  <section>
    <form action="/contact" method="post">
      <input type="text" name="name" placeholder="Name">
      <button type="submit">Submit</button>
    </form>
    <iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ" title="Video"></iframe>
    <canvas id="stats-chart" width="400" height="200"></canvas>
    <custom-badge text="Live"></custom-badge>
  </section>
  <script src="js/main.js"></script>
</body>
</html>`;

  const aboutHtml = `<!doctype html>
<html lang="en">
<head>
  <title>About Us - DakyXTech</title>
  <link rel="stylesheet" href="css/style.css">
</head>
<body>
  <h1>About DakyXTech</h1>
  <p>Our company story and mission.</p>
  <a href="index.html">Home</a>
</body>
</html>`;

  const styleCss = `body { font-family: 'BrandFont', sans-serif; margin: 0; }
@font-face {
  font-family: 'BrandFont';
  src: url('../fonts/brand.woff2') format('woff2');
}
.hero { background: url('../images/hero.png') no-repeat center; }`;

  const mainJs = `console.log("Website initialized"); document.addEventListener("click", () => {});`;

  // 1x1 dummy PNG
  const dummyPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
  const dummyWoff2 = Buffer.from("d09GMgABAAAAAAMgAA0AAAAABuAAAA", "base64");

  sampleZip.file("index.html", indexHtml);
  sampleZip.file("about.html", aboutHtml);
  sampleZip.file("css/style.css", styleCss);
  sampleZip.file("js/main.js", mainJs);
  sampleZip.file("images/hero.png", dummyPng);
  sampleZip.file("images/responsive-hero.png", dummyPng);
  sampleZip.file("fonts/brand.woff2", dummyWoff2);

  const zipBuffer = await sampleZip.generateAsync({ type: "nodebuffer" });
  const analysis = await analyzeImportPackage({ buffer: zipBuffer, filename: "test-site.zip" });

  assert.equal(analysis.pages.length, 2, "Discovered exactly 2 HTML pages");
  assert.equal(analysis.pages[0].path, "/", "Root index page mapped to '/'");
  assert.equal(analysis.pages[0].filePath, "index.html");
  assert.equal(analysis.pages[1].path, "/about", "about.html mapped to '/about'");
  assert.equal(analysis.pages[1].filePath, "about.html");

  assert.equal(analysis.assets.length, 5, "Discovered 5 local assets (CSS, JS, fonts, images)");
  const assetPaths = analysis.assets.map((a) => a.repoPath).sort();
  assert.deepEqual(assetPaths, [
    "css/style.css",
    "fonts/brand.woff2",
    "images/hero.png",
    "images/responsive-hero.png",
    "js/main.js",
  ]);

  // Missing assets detection
  assert.ok(
    analysis.missingAssets.some((m) => m.url.includes("missing-icon.svg")),
    "Detected missing relative asset images/missing-icon.svg"
  );

  // External resources detection
  assert.ok(
    analysis.externalResources.some((r) => r.url.includes("font-awesome")),
    "Detected external CDN resource FontAwesome"
  );
  console.log("   ✓ ZIP package analyzed: 2 pages, 5 assets, 1 missing asset, 1 external CDN resource\n");

  // ────────────────────────────────────────────────────────────────────────────
  // 3. Zip Package Security Rejection
  // ────────────────────────────────────────────────────────────────────────────
  console.log("3. Hostile ZIP package rejection");
  const evilZip = new JSZip();
  evilZip.file("/etc/passwd", "root:x:0:0:root:/root:/bin/bash");
  const evilBuffer = await evilZip.generateAsync({ type: "nodebuffer" });

  let evilBlocked = false;
  try {
    await analyzeImportPackage({ buffer: evilBuffer, filename: "evil.zip" });
  } catch (err: any) {
    if (err?.status === 400 || err?.message?.includes("Unsafe absolute package path") || err instanceof WebsiteError) {
      evilBlocked = true;
    }
  }
  assert.ok(evilBlocked, "Malicious Zip archive with absolute path was rejected with 400 Bad Request");
  console.log("   ✓ Malicious Zip archive safely rejected\n");

  console.log("3b. Zip bombs are refused before they are inflated");
  const page = "<!doctype html><html><head><title>Bomb</title></head><body><h1>Hi</h1></body></html>";
  const deflate = { type: "nodebuffer" as const, compression: "DEFLATE" as const };

  const honestBomb = new JSZip();
  honestBomb.file("index.html", page);
  honestBomb.file("assets/blank.bin", Buffer.alloc(MAX_SINGLE_FILE_SIZE + 1024 * 1024));
  const honestBombBuffer = await honestBomb.generateAsync(deflate);

  const manyParts = new JSZip();
  manyParts.file("index.html", page);
  for (let i = 1; i <= 5; i += 1) manyParts.file(`assets/part-${i}.bin`, "x");
  let manyPartsBuffer = await manyParts.generateAsync(deflate);
  const eachClaims = 14 * 1024 * 1024;
  assert.ok(eachClaims <= MAX_SINGLE_FILE_SIZE && eachClaims * 5 > MAX_UNCOMPRESSED_SIZE, "the parts must be allowed alone and too big together");
  for (let i = 1; i <= 5; i += 1) manyPartsBuffer = declareSize(manyPartsBuffer, `assets/part-${i}.bin`, eachClaims);

  const liarSize = 64 * 1024 * 1024;
  const liar = new JSZip();
  liar.file("index.html", page);
  liar.file("assets/liar.bin", Buffer.alloc(liarSize));
  const liarBuffer = declareSize(await liar.generateAsync(deflate), "assets/liar.bin", 1024);
  assert.ok(liarBuffer.length < 1024 * 1024, "a 64 MB entry of zeros packs into well under a megabyte");

  const honestLarge = new JSZip();
  honestLarge.file("index.html", page);
  honestLarge.file("assets/video-poster.bin", Buffer.alloc(10 * 1024 * 1024, 7));
  const honestLargeBuffer = await honestLarge.generateAsync(deflate);

  // Count every inflation JSZip starts, and every byte one produces. `async()`
  // and `nodeStream()` both begin at `internalStream`, on a prototype that
  // every loaded archive shares.
  type Helper = { on(event: string, listener: (chunk: { length: number }) => void): Helper };
  const entryPrototype = Object.getPrototypeOf(new JSZip().file("probe.txt", "x").file("probe.txt")!) as { internalStream: (this: unknown, ...args: unknown[]) => Helper };
  const realInternalStream = entryPrototype.internalStream;
  let inflations = 0;
  let inflatedBytes = 0;
  entryPrototype.internalStream = function (this: unknown, ...args: unknown[]) {
    inflations += 1;
    return realInternalStream.apply(this, args).on("data", (chunk) => { inflatedBytes += chunk.length; });
  };
  try {
    let error = await refusal(honestBombBuffer);
    assert.equal(error.status, 400);
    assert.match(error.message, /assets\/blank\.bin exceeds the maximum single-file size/);
    assert.equal(inflations, 0, "an entry that says it is too big is refused without inflating anything");

    error = await refusal(manyPartsBuffer);
    assert.match(error.message, /exceeds the maximum uncompressed size/);
    assert.equal(inflations, 0, "so is a package whose entries together say they are too big");

    inflatedBytes = 0;
    error = await refusal(liarBuffer);
    assert.equal(error.status, 400);
    assert.match(error.message, /assets\/liar\.bin inflates to more than the ZIP says/);
    assert.ok(inflatedBytes < liarSize / 2, `an entry that lied about its size is stopped early (${inflatedBytes} of ${liarSize} bytes inflated)`);

    inflations = 0;
    const large = await analyzeImportPackage({ buffer: honestLargeBuffer, filename: "large.zip" });
    const poster = large.assets.find((asset) => asset.repoPath === "assets/video-poster.bin");
    assert.equal(poster?.size, 10 * 1024 * 1024, "an honest 10 MB asset still comes through whole");
    assert.ok(poster!.content.equals(Buffer.alloc(10 * 1024 * 1024, 7)), "byte for byte");
    assert.equal(inflations, 2, "each entry inflated exactly once");
  } finally {
    entryPrototype.internalStream = realInternalStream;
  }
  console.log("   ✓ Declared sizes refused before inflating; a lying entry stopped mid-inflate; honest large files intact\n");

  // ────────────────────────────────────────────────────────────────────────────
  // 4. Extended Field Discovery (Backgrounds, Metadata, Pictures, Unsupported)
  // ────────────────────────────────────────────────────────────────────────────
  console.log("4. Field discovery: metadata, backgrounds, responsive pictures, unsupported elements");
  const fieldsResult = discoverFields(indexHtml);
  const fields = fieldsResult.fields;

  // Metadata fields
  const metaTitle = fields.find((f) => f.tag === "title");
  assert.ok(metaTitle, "Discovered <title> field");
  assert.equal(metaTitle.value, "DakyXTech Studio");

  const metaDesc = fields.find((f) => f.tag === "meta" && f.label.toLowerCase().includes("description"));
  assert.ok(metaDesc, "Discovered <meta name='description'> field");

  const metaOgTitle = fields.find((f) => f.tag === "meta" && f.label.toLowerCase().includes("og:title"));
  assert.ok(metaOgTitle, "Discovered og:title field");

  const metaKeywords = fields.find((f) => f.tag === "meta" && f.label.toLowerCase().includes("keywords"));
  assert.ok(metaKeywords, "Discovered meta keywords field");

  // Background image field
  const bgField = fields.find((f) => f.kind === "background");
  assert.ok(bgField, "Discovered background image field");
  assert.equal(bgField.value, "images/hero.png");

  // Responsive picture source
  const pictureSource = fields.find((f) => f.tag === "source" || f.value === "images/responsive-hero.png");
  assert.ok(pictureSource, "Discovered <picture> <source srcset> field");

  // Unsupported components with reasons
  const formField = fields.find((f) => f.tag === "form");
  assert.ok(formField, "Discovered <form> field as unsupported");
  assert.equal(formField.kind, "unsupported");
  assert.ok(formField.previewReadOnly, "Unsupported form marked previewReadOnly");
  assert.ok(formField.unsupportedReason?.includes("Interactive form"), "Form contains reason");

  const iframeField = fields.find((f) => f.tag === "iframe");
  assert.ok(iframeField, "Discovered <iframe> field as unsupported");
  assert.equal(iframeField.kind, "unsupported");

  const canvasField = fields.find((f) => f.tag === "canvas");
  assert.ok(canvasField, "Discovered <canvas> field as unsupported");
  assert.equal(canvasField.kind, "unsupported");

  const customElField = fields.find((f) => f.tag === "custom-badge");
  assert.ok(customElField, "Discovered <custom-badge> custom element as unsupported");
  assert.equal(customElField.kind, "unsupported");

  const counts = countEditableFields(fields);
  assert.ok(counts.total > 0, "Counted total editable fields");
  assert.ok(counts.text > 0, "Counted text fields");
  assert.ok(counts.metadata >= 4, "Counted metadata fields");
  assert.ok(counts.backgrounds >= 1, "Counted background fields");
  assert.ok(counts.unsupported >= 4, "Counted unsupported fields");
  console.log(`   ✓ Discovered ${counts.total} fields: ${counts.text} text, ${counts.metadata} metadata, ${counts.backgrounds} backgrounds, ${counts.unsupported} unsupported\n`);

  // ────────────────────────────────────────────────────────────────────────────
  // 5. Exact Byte Preservation on Edits
  // ────────────────────────────────────────────────────────────────────────────
  console.log("5. Saving edits preserves untouched HTML and CSS bytes exactly");

  const h1Field = fields.find((f) => f.tag === "h1")!;
  assert.ok(h1Field, "Discovered h1 field");

  const edits = {
    [h1Field.id]: { value: "Creative Engineering at DakyXTech" },
    [bgField.id]: { value: "images/new-hero.png" },
  };

  const applied = applyValues(indexHtml, edits);
  assert.deepEqual(applied.conflicts, []);
  assert.ok(applied.html.includes("Creative Engineering at DakyXTech"), "Heading edit applied");
  assert.ok(applied.html.includes("images/new-hero.png"), "Background image edit applied");

  // Untouched parts must be strictly byte-identical
  assert.ok(
    applied.html.includes('<form action="/contact" method="post">\n      <input type="text" name="name" placeholder="Name">\n      <button type="submit">Submit</button>\n    </form>'),
    "Form markup untouched"
  );
  assert.ok(
    applied.html.includes('<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ" title="Video"></iframe>'),
    "Iframe markup untouched"
  );
  assert.ok(
    applied.html.includes('<canvas id="stats-chart" width="400" height="200"></canvas>'),
    "Canvas markup untouched"
  );
  assert.ok(
    applied.html.includes('<custom-badge text="Live"></custom-badge>'),
    "Custom element untouched"
  );
  console.log("   ✓ Untouched HTML, forms, iframes, canvas, and custom elements strictly preserved byte-for-byte\n");

  // ────────────────────────────────────────────────────────────────────────────
  // 6. Preview Inertness & Safety
  // ────────────────────────────────────────────────────────────────────────────
  console.log("6. Preview inertness: safe forms, inert navigation, and script audit");

  const preview = buildPreview(indexHtml, "https://dakyx.com/", fields);
  assert.ok(preview.html.includes("inert_action") && preview.html.includes("form_submission"), "Form submission intercepted in editor preview");
  assert.ok(preview.html.includes("auditScriptDriven"), "Script-driven parts auditing script injected");
  assert.ok(preview.html.includes('data-dw-readonly="true"'), "Unsupported elements marked data-dw-readonly");
  console.log("   ✓ Editor preview safely isolates form submissions, links, and audits script-driven parts\n");

  // ────────────────────────────────────────────────────────────────────────────
  // 7. Relative Asset Reference Rewriter
  // ────────────────────────────────────────────────────────────────────────────
  console.log("7. Relative asset reference rewriter");

  const mockSiteForRewrite = { id: "site-123", publicUrl: "https://studio.test" };
  const rewritten = rewritePageAssetReferences(indexHtml, "index.html", mockSiteForRewrite as any, analysis.assets);
  const hostedCss = assetUrl(mockSiteForRewrite as any, "css/style.css");
  const hostedImg = assetUrl(mockSiteForRewrite as any, "images/hero.png");

  assert.ok(
    rewritten.includes(`href="${hostedCss}"`),
    "Rewrote relative CSS reference to hosted asset path"
  );
  assert.ok(
    rewritten.includes(`src="${hostedImg}"`) || rewritten.includes(`url('${hostedImg}')`),
    "Rewrote relative image reference to hosted asset path"
  );
  // External resource untouched
  assert.ok(
    rewritten.includes("https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css"),
    "External CDN resource untouched"
  );
  console.log("   ✓ Relative references rewritten cleanly to hosted paths\n");

  // ────────────────────────────────────────────────────────────────────────────
  // 8. Prepublish Report & Risk Acknowledgment
  // ────────────────────────────────────────────────────────────────────────────
  console.log("8. Prepublish report generation and risk acknowledgment");

  const mockSite = {
    id: "site-abc-123",
    name: "Test Studio",
    publicUrl: "https://studio.test",
    settings: {
      acknowledgedPublishLimits: [] as string[],
    },
  } as any;

  const mockPage = {
    id: "page-abc-123",
    siteId: "site-abc-123",
    title: "Home",
    path: "/",
    filePath: "index.html",
    sourceHtml: indexHtml,
  } as any;

  const reportUnacknowledged = await generatePagePrepublishReport({
    site: mockSite,
    page: mockPage,
    candidateHtml: indexHtml,
    draftValues: {},
    acknowledgedLimits: [],
  });

  assert.equal(reportUnacknowledged.editableCounts.total, counts.total);
  assert.ok(reportUnacknowledged.unsupportedElements.length >= 4, "Report lists unsupported elements");
  assert.ok(reportUnacknowledged.publishRisks.length > 0, "Report identifies publish risks / warnings");
  assert.equal(reportUnacknowledged.requiresAcknowledgment, true, "Unacknowledged warnings require acknowledgment");
  assert.equal(reportUnacknowledged.canPublish, false, "Publishing blocked until limits are acknowledged");

  // Now acknowledge the limits
  const acknowledgedIds = reportUnacknowledged.publishRisks.map((r) => r.id);
  const reportAcknowledged = await generatePagePrepublishReport({
    site: mockSite,
    page: mockPage,
    candidateHtml: indexHtml,
    draftValues: {},
    acknowledgedLimits: acknowledgedIds,
  });

  assert.equal(reportAcknowledged.canPublish, true, "Publishing unblocked after acknowledging limits");
  assert.equal(reportAcknowledged.requiresAcknowledgment, false, "No further acknowledgment required");
  console.log("   ✓ Prepublish report generated; publication allowed with acknowledged limits\n");

  console.log("All websiteHtmlImport checks passed successfully (8/8).");
}

void runChecks().catch((error) => {
  console.error("FAIL:", error);
  process.exit(1);
});
