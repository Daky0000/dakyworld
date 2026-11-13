import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  detectSourceProject,
  ensureNextStaticExportConfig,
  extractPrebuiltEntries,
} from "../src/services/website/sourceBuild.js";
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

// 6. Test ensureNextStaticExportConfig variants
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dw-next-cfg-test-"));
const requireFromHere = createRequire(import.meta.url);
try {
  // 6a. Missing config -> creates next.config.mjs
  const missingDir = path.join(tmpRoot, "missing");
  fs.mkdirSync(missingDir, { recursive: true });
  const missingRes = ensureNextStaticExportConfig(missingDir);
  equal("Creates next.config.mjs when missing", missingRes, {
    updated: true,
    configFile: "next.config.mjs",
    reason: "created",
  });
  const missingMod = await import(pathToFileURL(path.join(missingDir, "next.config.mjs")).href);
  equal("Created next.config.mjs resolves static export", missingMod.default, {
    output: "export",
    trailingSlash: true,
    images: { unoptimized: true },
  });

  // 6b. TypeScript config without output -> wraps via extensionless import + dw-orig.ts
  const tsDir = path.join(tmpRoot, "ts-app");
  fs.mkdirSync(tsDir, { recursive: true });
  const tsOrig = `const nextConfig = { images: { unoptimized: true }, reactStrictMode: true };\nexport default nextConfig;\n`;
  fs.writeFileSync(path.join(tsDir, "next.config.ts"), tsOrig, "utf8");
  const tsRes = ensureNextStaticExportConfig(tsDir);
  equal("Wraps next.config.ts when output is missing", tsRes, {
    updated: true,
    configFile: "next.config.ts",
    reason: "wrapped",
  });
  equal("Preserves original ts config in next.config.dw-orig.ts", fs.readFileSync(path.join(tsDir, "next.config.dw-orig.ts"), "utf8"), tsOrig);
  const tsWrapper = fs.readFileSync(path.join(tsDir, "next.config.ts"), "utf8");
  ok("TS wrapper uses extensionless dw-orig import", tsWrapper.includes('from "./next.config.dw-orig"') && !tsWrapper.includes("dw-orig.ts"));
  ok("TS wrapper forces output: export", tsWrapper.includes('output: "export"'));

  // 6c. ESM .mjs function config -> wraps and executes cleanly preserving async options
  const mjsDir = path.join(tmpRoot, "mjs-fn");
  fs.mkdirSync(mjsDir, { recursive: true });
  fs.writeFileSync(
    path.join(mjsDir, "next.config.mjs"),
    `export default async () => ({ images: { remotePatterns: [{ hostname: "cdn.example" }] }, trailingSlash: false });\n`,
    "utf8"
  );
  const mjsRes = ensureNextStaticExportConfig(mjsDir);
  equal("Wraps next.config.mjs", mjsRes, { updated: true, configFile: "next.config.mjs", reason: "wrapped" });
  const mjsMod = await import(pathToFileURL(path.join(mjsDir, "next.config.mjs")).href);
  equal("Function ESM wrapper returns function", typeof mjsMod.default, "function");
  const resolvedMjs = await mjsMod.default("phase-production-build", { defaultConfig: {} });
  equal("Wrapped ESM function config resolves static export while preserving trailingSlash & images", resolvedMjs, {
    images: { remotePatterns: [{ hostname: "cdn.example" }], unoptimized: true },
    trailingSlash: false,
    output: "export",
  });

  // 6d. CJS next.config.js -> wraps cleanly and runs via require()
  const cjsDir = path.join(tmpRoot, "cjs-app");
  fs.mkdirSync(cjsDir, { recursive: true });
  fs.writeFileSync(
    path.join(cjsDir, "next.config.js"),
    `module.exports = { images: { domains: ["example.com"] } };\n`,
    "utf8"
  );
  const cjsRes = ensureNextStaticExportConfig(cjsDir);
  equal("Wraps CJS next.config.js", cjsRes, { updated: true, configFile: "next.config.js", reason: "wrapped" });
  const resolvedCjs = requireFromHere(path.join(cjsDir, "next.config.js"));
  equal("Wrapped CJS config resolves static export with preserved domains", resolvedCjs, {
    images: { domains: ["example.com"], unoptimized: true },
    output: "export",
    trailingSlash: true,
  });

  // 6e. Already-configured output: "export" left untouched
  const configuredDir = path.join(tmpRoot, "configured");
  fs.mkdirSync(configuredDir, { recursive: true });
  const configuredSrc = `export default { output: "export", trailingSlash: false };\n`;
  fs.writeFileSync(path.join(configuredDir, "next.config.mjs"), configuredSrc, "utf8");
  const configuredRes = ensureNextStaticExportConfig(configuredDir);
  equal("Leaves already-configured output: 'export' untouched", configuredRes, {
    updated: false,
    configFile: "next.config.mjs",
    reason: "already-configured",
  });
  equal("Original configured file unchanged", fs.readFileSync(path.join(configuredDir, "next.config.mjs"), "utf8"), configuredSrc);
  ok("No dw-orig file created when already configured", !fs.existsSync(path.join(configuredDir, "next.config.dw-orig.mjs")));
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

console.log(`websiteSourceBuild: ${checks} checks passed.`);
