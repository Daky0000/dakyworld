import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { recogniseBuild, freezePage } from "../src/services/website/buildOutput.js";
import { choosePages, bundleSiteFiles, rewritePageLinks, tidyPageTitles } from "../src/services/websiteSitePackage.js";
import { extractPageTitle, routePathForFile } from "../src/services/websitePackageImport.js";
import { detectFramework, nextRoutes } from "../src/services/website/frameworks.js";

function getAllFiles(currentDir: string, baseDir = currentDir): Array<{ relPath: string; fullPath: string; buffer: Buffer }> {
  let results: Array<{ relPath: string; fullPath: string; buffer: Buffer }> = [];
  const list = fs.readdirSync(currentDir);
  for (const file of list) {
    const fullPath = path.join(currentDir, file);
    const stat = fs.statSync(fullPath);
    if (stat && stat.isDirectory()) {
      results = results.concat(getAllFiles(fullPath, baseDir));
    } else {
      const relPath = path.relative(baseDir, fullPath).split(path.sep).join("/");
      results.push({ relPath, fullPath, buffer: fs.readFileSync(fullPath) });
    }
  }
  return results;
}

console.log("=== 1. VERIFYING GULF CONTRACTING STATIC SITE ===");
const staticDir = "C:/Users/ASUS/Downloads/New folder/gulf-contracting-static-site";
if (fs.existsSync(staticDir)) {
  const allStaticFiles = getAllFiles(staticDir);
  console.log(`Found ${allStaticFiles.length} files in static export.`);

  const htmlFiles = allStaticFiles.filter((f) => /\.(html|htm)$/i.test(f.relPath));
  console.log(`Found ${htmlFiles.length} HTML files.`);
  assert.equal(htmlFiles.length, 52, "Static export should contain 52 HTML files");

  const pages = htmlFiles.map((e) => {
    const html = e.buffer.toString("utf8");
    return {
      filePath: e.relPath,
      path: routePathForFile(e.relPath, true),
      title: extractPageTitle(html, e.relPath),
      html,
    };
  });

  const build = recogniseBuild(allStaticFiles.map((f) => f.relPath), pages);
  console.log("Build detected:", build);
  assert.equal(build.kind, "next-app", "Must be recognized as Next.js app-router");
  assert.equal(build.freezes, true, "Must freeze runtime scripts");

  const { kept, dropped } = choosePages(pages);
  console.log(`Kept ${kept.length} pages, dropped ${dropped.length} duplicates.`);
  assert.equal(kept.length, 51, "Should keep all 51 unique routes");
  assert.equal(dropped.length, 1, "Should drop 1 duplicate 404 route");
  assert.equal(dropped[0].path, "/404", "Dropped route should be duplicate 404");

  const frozen = kept.map((p) => ({ page: p, frozen: freezePage(p.html, build) }));
  const totalRestored = frozen.reduce((sum, f) => sum + f.frozen.interactions.restored, 0);
  console.log(`Total interactive controls restored across 52 pages: ${totalRestored}`);
  assert.ok(totalRestored > 0, "Should restore controls");

  console.log("✓ Gulf Contracting static export verification PASSED.\n");
} else {
  console.log("Static dir not found:", staticDir);
}

console.log("=== 2. ANALYZING GULF CONTRACTING SOURCE PROJECT ===");
const sourceDir = "C:/Users/ASUS/Downloads/New folder/gulf-contracting-nextjs-source";
if (fs.existsSync(sourceDir)) {
  const allSourceFiles = getAllFiles(sourceDir);
  console.log(`Found ${allSourceFiles.length} files in source project.`);

  const relativePaths = allSourceFiles.map((f) => f.relPath);
  const detected = detectFramework(relativePaths);
  console.log("Framework detected from source files:", detected ? { kind: detected.sourceKind, label: detected.label } : null);
  assert.ok(detected !== null, "Source project should be detected as framework");
  assert.equal(detected?.sourceKind, "next", "Should be recognized as Next.js");

  const routes = detected!.routes(relativePaths, new Set());
  console.log(`Detected ${routes.length} static and dynamic route templates:`);
  for (const r of routes) {
    console.log(`  - ${r.path} (${r.title}) -> ${r.filePath}`);
  }
  assert.ok(routes.length >= 10, "Should detect at least 10 routes in Next.js source");

  console.log("✓ Gulf Contracting source project detection PASSED.\n");
}
