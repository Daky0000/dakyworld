import assert from "node:assert/strict";
import { detectSourceProject, extractPrebuiltEntries } from "../src/services/website/sourceBuild.js";
import { analyzeImportPackage } from "../src/services/websitePackageImport.js";
import JSZip from "jszip";

let checks = 0;
const equal = (name: string, actual: unknown, expected: unknown) => { assert.deepEqual(actual, expected, name); checks++; };
const ok = (name: string, value: unknown) => { assert.ok(value, name); checks++; };

console.log("Running websiteSourceBuild checks...");

// 1. Detection of Next.js source project
const nextFiles = [
  "package.json",
  "next.config.ts",
  "app/layout.tsx",
  "app/page.tsx",
  "app/about/page.tsx",
  "app/projects/page.tsx",
  "app/projects/[slug]/page.tsx",
  "data/projects.ts",
];
const pkgJson = JSON.stringify({
  name: "demo-next",
  scripts: { build: "next build" },
  dependencies: { next: "^15.0.0", react: "^19.0.0" },
});

const nextDetection = detectSourceProject(nextFiles, pkgJson);
equal("Next.js source project is detected", nextDetection.isSourceProject, true);
equal("Kind is next", nextDetection.kind, "next");
equal("Routes discovered include / and dynamic slug", nextDetection.routes.map((r) => r.path), [
  "/",
  "/about",
  "/projects",
  "/projects/[slug]",
]);
equal("Has build script", nextDetection.hasBuildScript, true);
equal("Suggested command is STATIC_EXPORT=1 npm run build", nextDetection.suggestedExportCommand, "STATIC_EXPORT=1 npm run build");
ok("Guidance mentions Next.js and export command", nextDetection.guidance.includes("STATIC_EXPORT=1 npm run build"));

// 2. Detection of Astro source project
const astroFiles = [
  "package.json",
  "astro.config.mjs",
  "src/pages/index.astro",
  "src/pages/about.astro",
];
const astroDetection = detectSourceProject(astroFiles, JSON.stringify({ scripts: { build: "astro build" } }));
equal("Astro source project is detected", astroDetection.isSourceProject, true);
equal("Kind is astro", astroDetection.kind, "astro");
equal("Routes count is 2", astroDetection.routes.length, 2);

// 3. Prebuilt extraction: when out/ or dist/ is inside the archive
const archiveWithOut = [
  { path: "out/index.html", content: Buffer.from("<html><title>Home</title><body><h1>Home</h1></body></html>") },
  { path: "out/about/index.html", content: Buffer.from("<html><title>About</title><body><h1>About</h1></body></html>") },
  { path: "out/_next/static/css/site.css", content: Buffer.from("body{color:red;}") },
  { path: "package.json", content: Buffer.from(pkgJson) },
  { path: "app/page.tsx", content: Buffer.from("export default function Page() {}") },
];
const extracted = extractPrebuiltEntries(archiveWithOut);
ok("Prebuilt entries extracted from out/", extracted !== null);
equal("Extracted paths have out/ stripped", extracted!.map((e) => e.path), [
  "index.html",
  "about/index.html",
  "_next/static/css/site.css",
]);

// 4. Test analyzeImportPackage with ZIP containing out/ folder
const zip = new JSZip();
for (const e of archiveWithOut) {
  zip.file(e.path, e.content);
}
const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });
const analysis = await analyzeImportPackage({ buffer: zipBuffer, filename: "project-with-out.zip" });
equal("Analysis found 2 pages", analysis.pages.length, 2);
equal("Page routes are / and /about", analysis.pages.map((p) => p.path), ["/", "/about"]);

// 5. Test analyzeImportPackage with source ZIP and autoBuild=false gives actionable guidance
const srcZip = new JSZip();
for (const p of nextFiles) {
  srcZip.file(p, p === "package.json" ? pkgJson : "// file content");
}
const srcBuffer = await srcZip.generateAsync({ type: "nodebuffer" });
let caughtError: Error | null = null;
try {
  await analyzeImportPackage({ buffer: srcBuffer, filename: "source-only.zip", autoBuild: false });
} catch (err) {
  caughtError = err as Error;
}
ok("Threw error explaining source project when autoBuild is false", caughtError !== null);
ok("Error message includes guidance", caughtError!.message.includes("Next.js") && caughtError!.message.includes("STATIC_EXPORT=1 npm run build"));

console.log(`websiteSourceBuild: ${checks} checks passed.`);
