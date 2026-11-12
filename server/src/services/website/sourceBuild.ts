/**
 * sourceBuild.ts — Detection and automated export/compilation of framework source packages.
 *
 * When a user uploads a ZIP containing a Next.js, Astro, or Vite/React source project
 * (with package.json and .tsx/.jsx files, but no pre-rendered .html), this service:
 * 1. Detects the framework and route hierarchy from source files using frameworks.ts.
 * 2. Checks if pre-rendered output (out/, dist/, build/) is already present in the archive.
 * 3. If needed, runs an isolated build runner (e.g. STATIC_EXPORT=1 npm run build) to
 *    produce static HTML and assets, feeding them directly into the site package pipeline.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { detectFramework, type DiscoveredRoute, type SourceKind } from "./frameworks.js";
import { WebsiteError } from "./site.js";

export type SourceProjectDetection = {
  isSourceProject: boolean;
  kind: SourceKind | null;
  label: string | null;
  routes: DiscoveredRoute[];
  hasBuildScript: boolean;
  hasPrebuiltOutput: boolean;
  suggestedExportCommand: string;
  guidance: string;
};

export const OUTPUT_DIR_CANDIDATES = ["out", "dist", ".output/public", "_site", "build"];

/**
 * Checks whether the package entries represent a framework source project.
 */
export function detectSourceProject(filePaths: string[], packageJsonContent?: string): SourceProjectDetection {
  const normPaths = filePaths.map((p) => p.replace(/\\/g, "/").replace(/^\/+/, ""));
  const framework = detectFramework(normPaths);

  const hasPrebuiltOutput = normPaths.some((p) => {
    const first = p.split("/")[0]?.toLowerCase();
    return OUTPUT_DIR_CANDIDATES.includes(first) && /\.(html|htm)$/i.test(p);
  });

  let hasBuildScript = false;
  if (packageJsonContent) {
    try {
      const parsed = JSON.parse(packageJsonContent);
      hasBuildScript = Boolean(parsed.scripts?.build);
    } catch {}
  }

  if (!framework) {
    return {
      isSourceProject: false,
      kind: null,
      label: null,
      routes: [],
      hasBuildScript,
      hasPrebuiltOutput,
      suggestedExportCommand: "npm run build",
      guidance: "Upload a ZIP archive containing HTML pages or run an export build first.",
    };
  }

  const routes = framework.routes(normPaths, new Set());
  const suggestedCommand =
    framework.sourceKind === "next"
      ? "STATIC_EXPORT=1 npm run build"
      : framework.sourceKind === "nuxt"
      ? "npx nuxi generate"
      : "npm run build";

  const routeSummary = routes.length
    ? `${routes.length} route${routes.length === 1 ? "" : "s"} (${routes.slice(0, 4).map((r) => r.path).join(", ")}${routes.length > 4 ? ` and ${routes.length - 4} more` : ""})`
    : "route templates";

  const guidance =
    `This package contains ${framework.label} with ${routeSummary}. ` +
    `To edit its pages in the visual editor, you can auto-build on import, ` +
    `or run '${suggestedCommand}' locally and import the generated '${framework.sourceKind === "next" ? "out" : "dist"}' folder.`;

  return {
    isSourceProject: true,
    kind: framework.sourceKind,
    label: framework.label,
    routes,
    hasBuildScript,
    hasPrebuiltOutput,
    suggestedExportCommand: suggestedCommand,
    guidance,
  };
}

/**
 * Extracts prebuilt files if an output directory (out/, dist/) is already inside the archive entries.
 */
export function extractPrebuiltEntries(
  entries: Array<{ path: string; content: Buffer }>
): Array<{ path: string; content: Buffer }> | null {
  for (const dir of OUTPUT_DIR_CANDIDATES) {
    const matching = entries.filter((e) => {
      const norm = e.path.replace(/\\/g, "/").replace(/^\/+/, "");
      return norm.toLowerCase().startsWith(`${dir}/`);
    });

    const hasHtml = matching.some((e) => /\.(html|htm)$/i.test(e.path));
    if (hasHtml) {
      return matching.map((e) => {
        const norm = e.path.replace(/\\/g, "/").replace(/^\/+/, "");
        return {
          path: norm.slice(dir.length + 1),
          content: e.content,
        };
      });
    }
  }
  return null;
}

/**
 * Checks whether automated local building is viable in this environment.
 */
export function canRunLocalBuild(): boolean {
  if (process.env.DISABLE_SOURCE_BUILD === "1") return false;
  try {
    const res = spawnSync("node", ["-v"], { timeout: 3000 });
    return res.status === 0;
  } catch {
    return false;
  }
}

/**
 * Compiles a framework source project into static HTML and assets.
 * 1. Checks for already pre-rendered folders (out/, dist/).
 * 2. If not pre-rendered, runs an isolated build in a temp workspace.
 * 3. Reads the output folder and returns normalized static entries.
 */
export async function buildSourceProject(
  entries: Array<{ path: string; content: Buffer }>,
  options: { timeoutMs?: number } = {}
): Promise<{
  entries: Array<{ path: string; content: Buffer }>;
  buildKind: string;
  outputDir: string;
}> {
  // 1. Check if output is already in the package
  const prebuilt = extractPrebuiltEntries(entries);
  if (prebuilt && prebuilt.length > 0) {
    return {
      entries: prebuilt,
      buildKind: "prebuilt-archive",
      outputDir: "archive",
    };
  }

  // 2. Verify local runner capability
  if (!canRunLocalBuild()) {
    const paths = entries.map((e) => e.path);
    const detection = detectSourceProject(paths);
    throw new WebsiteError(
      422,
      `Automated building is not available on this server. ${detection.guidance}`
    );
  }

  const paths = entries.map((e) => e.path);
  const pkgEntry = entries.find((e) => e.path.endsWith("package.json"));
  const detection = detectSourceProject(paths, pkgEntry?.content.toString("utf8"));

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `dw-src-build-${randomUUID()}-`));
  const timeoutMs = options.timeoutMs ?? Number(process.env.WEBSITE_BUILD_TIMEOUT_MS ?? 180_000);

  try {
    // Write out files
    for (const entry of entries) {
      const fullPath = path.join(tempDir, entry.path);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, entry.content);
    }

    // Determine output directory name
    const outputDirName = detection.kind === "next" ? "out" : "dist";
    const env = {
      ...process.env,
      STATIC_EXPORT: "1",
      NEXT_TELEMETRY_DISABLED: "1",
      CI: "1",
    };

    // Check if node_modules exists
    const hasNodeModules = fs.existsSync(path.join(tempDir, "node_modules"));
    if (!hasNodeModules && pkgEntry) {
      const installRes = spawnSync(
        process.platform === "win32" ? "npm.cmd" : "npm",
        ["install", "--prefer-offline", "--no-audit", "--no-fund"],
        {
          cwd: tempDir,
          env,
          timeout: 120_000,
          stdio: "pipe",
        }
      );
      if (installRes.status !== 0) {
        const err = installRes.stderr?.toString("utf8") || installRes.stdout?.toString("utf8") || "Unknown error";
        throw new Error(`Dependency installation failed: ${err.slice(-400)}`);
      }
    }

    // Run build command
    const buildRes = spawnSync(
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["run", "build"],
      {
        cwd: tempDir,
        env,
        timeout: timeoutMs,
        stdio: "pipe",
      }
    );

    if (buildRes.status !== 0) {
      const err = buildRes.stderr?.toString("utf8") || buildRes.stdout?.toString("utf8") || "Build command failed";
      throw new Error(`Build failed: ${err.slice(-500)}`);
    }

    const outPath = path.join(tempDir, outputDirName);
    if (!fs.existsSync(outPath)) {
      throw new Error(`Build completed but '${outputDirName}' output directory was not created.`);
    }

    // Read all output files
    const resultEntries: Array<{ path: string; content: Buffer }> = [];
    function collectOutput(dir: string, baseDir = dir) {
      const list = fs.readdirSync(dir);
      for (const item of list) {
        const full = path.join(dir, item);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) {
          collectOutput(full, baseDir);
        } else {
          const rel = path.relative(baseDir, full).split(path.sep).join("/");
          resultEntries.push({ path: rel, content: fs.readFileSync(full) });
        }
      }
    }
    collectOutput(outPath);

    if (!resultEntries.some((e) => /\.(html|htm)$/i.test(e.path))) {
      throw new Error(`Output folder '${outputDirName}' contains no HTML pages.`);
    }

    return {
      entries: resultEntries,
      buildKind: detection.kind ?? "framework",
      outputDir: outputDirName,
    };
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
}
