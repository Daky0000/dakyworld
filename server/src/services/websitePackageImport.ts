/**
 * websitePackageImport.ts — Comprehensive HTML and ZIP package import pipeline.
 *
 * Implements full launch plan support for:
 * 1. Standalone .html and .htm files.
 * 2. Multi-page ZIP packages preserving directory hierarchy, CSS, fonts, images, and scripts.
 * 3. Security guards against Zip Slip, absolute paths, null bytes, and zip bombs.
 * 4. Local asset storage in SiteAsset and relative reference resolution.
 * 5. Visible reporting of captured assets, missing files, and external resources (no silent skips).
 * 6. Initial version snapshot creation for 1-click restore/recovery.
 */

import { randomUUID } from "node:crypto";
import path from "node:path";
import JSZip from "jszip";
import type { Prisma, Site } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { WebsiteError } from "./website/site.js";
import { parseHtml, walk, attr, type ElementNode } from "./website/parse.js";
import { discoverFields } from "./website/index.js";
import { assetUrl } from "./websiteAssets.js";
import {
  assertImportAllowance,
  assertMediaStorageAllowance,
  recordImportUsed,
  recordMediaStorageAdded,
} from "./websiteTierPlans.js";
import type { WebsiteActor } from "./websiteActor.js";

export const MAX_PACKAGE_SIZE = 25 * 1024 * 1024; // 25 MB compressed limit
export const MAX_UNCOMPRESSED_SIZE = 60 * 1024 * 1024; // 60 MB uncompressed limit (zip bomb defense)
export const MAX_FILE_COUNT = 500; // max entries in zip
export const MAX_SINGLE_FILE_SIZE = 15 * 1024 * 1024; // 15 MB per single asset

export type DiscoveredPage = {
  filePath: string;
  path: string;
  title: string;
  html: string;
  editableCount: number;
  originalHtml: string;
};

export type DiscoveredAsset = {
  repoPath: string;
  filename: string;
  contentType: string;
  content: Buffer;
  size: number;
  isImage: boolean;
  isCss: boolean;
  isFont: boolean;
  isScript: boolean;
};

export type MissingAssetReference = {
  url: string;
  sourceFile: string;
  element: string;
  attribute: string;
  resolvedPath: string;
};

export type ExternalResourceReference = {
  url: string;
  sourceFile: string;
  element: string;
  host: string;
  kind: "stylesheet" | "script" | "image" | "font" | "other";
};

export type PackageAnalysis = {
  isZip: boolean;
  pages: DiscoveredPage[];
  assets: DiscoveredAsset[];
  missingAssets: MissingAssetReference[];
  externalResources: ExternalResourceReference[];
  totalBytes: number;
  warnings: string[];
};

export type ImportPackageResult = {
  siteId: string;
  siteName: string;
  pagesCount: number;
  pages: Array<{ id: string; title: string; path: string; filePath: string; fields: number }>;
  assetsCount: number;
  assets: Array<{ id: string; repoPath: string; filename: string; contentType: string; size: number }>;
  missingAssets: MissingAssetReference[];
  externalResources: ExternalResourceReference[];
  warnings: string[];
  totalBytesAdded: number;
};

/**
 * Sniffs common MIME types by extension.
 */
export function mimeTypeFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".html":
    case ".htm":
      return "text/html";
    case ".css":
      return "text/css";
    case ".js":
    case ".mjs":
      return "application/javascript";
    case ".json":
      return "application/json";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".svg":
      return "image/svg+xml";
    case ".ico":
      return "image/x-icon";
    case ".woff2":
      return "font/woff2";
    case ".woff":
      return "font/woff";
    case ".ttf":
      return "font/ttf";
    case ".otf":
      return "font/otf";
    case ".eot":
      return "application/vnd.ms-fontobject";
    case ".mp4":
      return "video/mp4";
    case ".webm":
      return "video/webm";
    case ".mp3":
      return "audio/mpeg";
    default:
      return "application/octet-stream";
  }
}

/**
 * Normalizes a relative POSIX path safely and rejects path traversal.
 */
export function sanitizePackagePath(rawPath: string): string {
  if (!rawPath || typeof rawPath !== "string") {
    throw new WebsiteError(400, "Package entry has an invalid or empty path.");
  }
  if (rawPath.includes("\0")) {
    throw new WebsiteError(400, "Package entry contains null byte characters.");
  }
  // Standardize slashes
  const normalized = rawPath.replace(/\\/g, "/");

  // Reject windows drive letters (e.g. C:)
  if (/^[a-zA-Z]:/.test(normalized)) {
    throw new WebsiteError(400, `Unsafe absolute package path detected: ${rawPath}`);
  }
  // Reject leading slashes
  if (normalized.startsWith("/")) {
    throw new WebsiteError(400, `Unsafe absolute package path detected: ${rawPath}`);
  }

  // Parse segments and check for directory traversal (Zip Slip)
  const segments = normalized.split("/").filter(Boolean);
  const resolved: string[] = [];
  for (const seg of segments) {
    if (seg === ".") continue;
    if (seg === "..") {
      throw new WebsiteError(400, `Zip traversal vulnerability detected in path: ${rawPath}`);
    }
    resolved.push(seg);
  }

  if (resolved.length === 0) {
    throw new WebsiteError(400, "Package entry resolves to an empty path.");
  }

  return resolved.join("/");
}

/**
 * Determines whether a file path inside a package should be ignored.
 */
export function isIgnoredPackageEntry(normalizedPath: string): boolean {
  if (
    normalizedPath.startsWith("__MACOSX/") ||
    normalizedPath.endsWith(".DS_Store") ||
    normalizedPath.endsWith("Thumbs.db") ||
    normalizedPath.startsWith(".git/") ||
    normalizedPath === ".gitignore" ||
    normalizedPath.startsWith("node_modules/")
  ) {
    return true;
  }
  return false;
}

/**
 * Derives a clean route path for an HTML file.
 */
export function routePathForFile(filePath: string): string {
  const norm = filePath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (norm.toLowerCase() === "index.html" || norm.toLowerCase() === "index.htm") {
    return "/";
  }
  if (/^index\.html?$/i.test(path.basename(norm))) {
    const dir = path.dirname(norm);
    return `/${dir}`.replace(/\/+/g, "/");
  }
  const clean = norm.replace(/\.html?$/i, "");
  return `/${clean}`.replace(/\/+/g, "/");
}

/**
 * Derives a human-readable title from HTML or filename.
 */
export function extractPageTitle(html: string, fallbackFilename: string): string {
  const root = parseHtml(html);
  for (const el of walk(root)) {
    if (el.tag === "title" && el.innerEnd > el.innerStart) {
      const title = html.slice(el.innerStart, el.innerEnd).trim();
      if (title) return title;
    }
  }
  for (const el of walk(root)) {
    if (el.tag === "h1" && el.innerEnd > el.innerStart) {
      const h1 = html.slice(el.innerStart, el.innerEnd).replace(/<[^>]*>/g, "").trim();
      if (h1) return h1;
    }
  }
  const base = path.basename(fallbackFilename).replace(/\.html?$/i, "");
  return base.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) || "Page";
}

/**
 * Resolves a relative URL reference from a source file into a normalized package asset path.
 */
export function resolvePackagePath(relativeUrl: string, sourceFilePath: string): string | null {
  const cleanUrl = relativeUrl.split(/[?#]/)[0].trim();
  if (!cleanUrl) return null;
  if (/^(?:https?:|\/\/|data:|mailto:|tel:|javascript:)/i.test(cleanUrl)) return null;

  const sourceDir = path.dirname(sourceFilePath);
  const combined = sourceDir === "." || sourceDir === "" ? cleanUrl : path.posix.join(sourceDir, cleanUrl);
  try {
    return sanitizePackagePath(combined);
  } catch {
    return null;
  }
}

/**
 * Unpacks and analyzes an incoming HTML file or ZIP package without persisting yet.
 */
export async function analyzeImportPackage(input: {
  buffer: Buffer;
  filename?: string;
}): Promise<PackageAnalysis> {
  const { buffer, filename = "import.html" } = input;
  if (!buffer || buffer.length === 0) {
    throw new WebsiteError(400, "Choose a non-empty file or ZIP package to import.");
  }
  if (buffer.length > MAX_PACKAGE_SIZE) {
    throw new WebsiteError(413, `The package exceeds the maximum import size limit of ${Math.round(MAX_PACKAGE_SIZE / (1024 * 1024))} MB.`);
  }

  const isZip =
    buffer.length >= 4 &&
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    (buffer[2] === 0x03 || buffer[2] === 0x05 || buffer[2] === 0x07);

  const rawEntries: Array<{ path: string; content: Buffer }> = [];

  if (!isZip) {
    // Standalone HTML or HTM file
    const safePath = sanitizePackagePath(filename.toLowerCase().endsWith(".htm") ? filename : `${filename.replace(/\.html?$/i, "")}.html`);
    rawEntries.push({ path: safePath, content: buffer });
  } else {
    // Process ZIP package
    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(buffer);
    } catch {
      throw new WebsiteError(400, "The ZIP file is corrupted or not a valid archive.");
    }

    const zipFiles = Object.values(zip.files);
    if (zipFiles.length === 0) {
      throw new WebsiteError(400, "The ZIP archive is empty.");
    }
    if (zipFiles.length > MAX_FILE_COUNT) {
      throw new WebsiteError(400, `The package contains too many files (${zipFiles.length}). The maximum is ${MAX_FILE_COUNT}.`);
    }

    let uncompressedTotal = 0;
    for (const entry of zipFiles) {
      if (entry.dir) continue;
      const sanitized = sanitizePackagePath(entry.name);
      if (isIgnoredPackageEntry(sanitized)) continue;

      const content = await entry.async("nodebuffer");
      uncompressedTotal += content.length;
      if (uncompressedTotal > MAX_UNCOMPRESSED_SIZE) {
        throw new WebsiteError(400, `The package exceeds the maximum uncompressed size of ${Math.round(MAX_UNCOMPRESSED_SIZE / (1024 * 1024))} MB.`);
      }
      if (content.length > MAX_SINGLE_FILE_SIZE) {
        throw new WebsiteError(400, `The file ${sanitized} exceeds the maximum single-file size of ${Math.round(MAX_SINGLE_FILE_SIZE / (1024 * 1024))} MB.`);
      }

      rawEntries.push({ path: sanitized, content });
    }
  }

  // Separate HTML pages and Assets
  const pages: DiscoveredPage[] = [];
  const assets: DiscoveredAsset[] = [];
  let totalBytes = 0;

  for (const entry of rawEntries) {
    totalBytes += entry.content.length;
    const isHtml = /\.(html|htm)$/i.test(entry.path);
    if (isHtml) {
      const htmlText = entry.content.toString("utf8");
      const title = extractPageTitle(htmlText, entry.path);
      const routePath = routePathForFile(entry.path);
      const fields = discoverFields(htmlText).fields;
      const editableCount = fields.filter((f) => f.kind !== "container" && f.tag !== "title" && f.tag !== "meta").length;

      pages.push({
        filePath: entry.path,
        path: routePath,
        title,
        html: htmlText,
        editableCount,
        originalHtml: htmlText,
      });
    } else {
      const contentType = mimeTypeFromPath(entry.path);
      assets.push({
        repoPath: entry.path,
        filename: path.basename(entry.path),
        contentType,
        content: entry.content,
        size: entry.content.length,
        isImage: contentType.startsWith("image/"),
        isCss: contentType === "text/css",
        isFont: contentType.startsWith("font/") || contentType.includes("fontobject"),
        isScript: contentType.includes("javascript"),
      });
    }
  }

  if (pages.length === 0) {
    throw new WebsiteError(400, "No HTML pages were found in the imported package. Provide at least one .html or .htm file.");
  }

  // Ensure root / index page exists or designate first page as root if only 1 page
  const hasRoot = pages.some((p) => p.path === "/");
  if (!hasRoot && pages.length === 1) {
    pages[0].path = "/";
  }

  // Create lookup for local assets
  const assetPaths = new Set(assets.map((a) => a.repoPath));
  const missingAssets: MissingAssetReference[] = [];
  const externalResources: ExternalResourceReference[] = [];
  const warnings: string[] = [];

  // Scan pages for asset references and report missing or external
  for (const page of pages) {
    const root = parseHtml(page.html);
    for (const node of walk(root)) {
      // Check href attributes on link elements
      if (node.tag === "link") {
        const href = attr(node, "href");
        const rel = attr(node, "rel")?.toLowerCase() || "";
        if (href) {
          if (/^(?:https?:|\/\/)/i.test(href)) {
            try {
              const u = new URL(href.startsWith("//") ? `https:${href}` : href);
              externalResources.push({
                url: href,
                sourceFile: page.filePath,
                element: "link",
                host: u.hostname,
                kind: rel.includes("stylesheet") ? "stylesheet" : rel.includes("font") ? "font" : "other",
              });
            } catch {}
          } else if (!href.startsWith("data:") && !href.startsWith("#") && !href.startsWith("mailto:")) {
            const resolved = resolvePackagePath(href, page.filePath);
            if (resolved && !assetPaths.has(resolved) && !pages.some((p) => p.filePath === resolved)) {
              missingAssets.push({
                url: href,
                sourceFile: page.filePath,
                element: `<link rel="${rel}">`,
                attribute: "href",
                resolvedPath: resolved,
              });
            }
          }
        }
      }

      // Check src on scripts
      if (node.tag === "script") {
        const src = attr(node, "src");
        if (src) {
          if (/^(?:https?:|\/\/)/i.test(src)) {
            try {
              const u = new URL(src.startsWith("//") ? `https:${src}` : src);
              externalResources.push({
                url: src,
                sourceFile: page.filePath,
                element: "script",
                host: u.hostname,
                kind: "script",
              });
            } catch {}
          } else if (!src.startsWith("data:")) {
            const resolved = resolvePackagePath(src, page.filePath);
            if (resolved && !assetPaths.has(resolved)) {
              missingAssets.push({
                url: src,
                sourceFile: page.filePath,
                element: "<script>",
                attribute: "src",
                resolvedPath: resolved,
              });
            }
          }
        }
      }

      // Check src and srcset on images
      if (node.tag === "img" || node.tag === "source") {
        const src = attr(node, "src");
        if (src) {
          if (/^(?:https?:|\/\/)/i.test(src)) {
            try {
              const u = new URL(src.startsWith("//") ? `https:${src}` : src);
              externalResources.push({
                url: src,
                sourceFile: page.filePath,
                element: `<${node.tag}>`,
                host: u.hostname,
                kind: "image",
              });
            } catch {}
          } else if (!src.startsWith("data:")) {
            const resolved = resolvePackagePath(src, page.filePath);
            if (resolved && !assetPaths.has(resolved)) {
              missingAssets.push({
                url: src,
                sourceFile: page.filePath,
                element: `<${node.tag}>`,
                attribute: "src",
                resolvedPath: resolved,
              });
            }
          }
        }

        const srcset = attr(node, "srcset");
        if (srcset) {
          const candidates = srcset.split(",").map((c) => c.trim().split(/\s+/)[0]).filter(Boolean);
          for (const cand of candidates) {
            if (/^(?:https?:|\/\/)/i.test(cand)) {
              try {
                const u = new URL(cand.startsWith("//") ? `https:${cand}` : cand);
                externalResources.push({
                  url: cand,
                  sourceFile: page.filePath,
                  element: `<${node.tag} srcset>`,
                  host: u.hostname,
                  kind: "image",
                });
              } catch {}
            } else if (!cand.startsWith("data:")) {
              const resolved = resolvePackagePath(cand, page.filePath);
              if (resolved && !assetPaths.has(resolved)) {
                missingAssets.push({
                  url: cand,
                  sourceFile: page.filePath,
                  element: `<${node.tag} srcset>`,
                  attribute: "srcset",
                  resolvedPath: resolved,
                });
              }
            }
          }
        }
      }

      // Check inline styles for background images
      const style = attr(node, "style");
      if (style && /url\s*\(/i.test(style)) {
        const urlMatches = style.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi);
        for (const match of urlMatches) {
          const bgUrl = match[1]?.trim();
          if (!bgUrl) continue;
          if (/^(?:https?:|\/\/)/i.test(bgUrl)) {
            try {
              const u = new URL(bgUrl.startsWith("//") ? `https:${bgUrl}` : bgUrl);
              externalResources.push({
                url: bgUrl,
                sourceFile: page.filePath,
                element: `<${node.tag} style>`,
                host: u.hostname,
                kind: "image",
              });
            } catch {}
          } else if (!bgUrl.startsWith("data:")) {
            const resolved = resolvePackagePath(bgUrl, page.filePath);
            if (resolved && !assetPaths.has(resolved)) {
              missingAssets.push({
                url: bgUrl,
                sourceFile: page.filePath,
                element: `<${node.tag} style="background: url(...)">`,
                attribute: "style",
                resolvedPath: resolved,
              });
            }
          }
        }
      }
    }
  }

  // Scan CSS files for font and image references
  for (const asset of assets) {
    if (!asset.isCss) continue;
    const cssText = asset.content.toString("utf8");
    const urlMatches = cssText.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi);
    for (const match of urlMatches) {
      const targetUrl = match[1]?.trim();
      if (!targetUrl || targetUrl.startsWith("data:")) continue;
      if (/^(?:https?:|\/\/)/i.test(targetUrl)) {
        try {
          const u = new URL(targetUrl.startsWith("//") ? `https:${targetUrl}` : targetUrl);
          externalResources.push({
            url: targetUrl,
            sourceFile: asset.repoPath,
            element: "@import or url()",
            host: u.hostname,
            kind: "other",
          });
        } catch {}
      } else {
        const resolved = resolvePackagePath(targetUrl, asset.repoPath);
        if (resolved && !assetPaths.has(resolved)) {
          missingAssets.push({
            url: targetUrl,
            sourceFile: asset.repoPath,
            element: "css url()",
            attribute: "url",
            resolvedPath: resolved,
          });
        }
      }
    }
  }

  if (missingAssets.length > 0) {
    warnings.push(`${missingAssets.length} linked asset${missingAssets.length === 1 ? " is" : "s are"} missing from the package.`);
  }

  return {
    isZip,
    pages,
    assets,
    missingAssets,
    externalResources,
    totalBytes,
    warnings,
  };
}

/**
 * Rewrites relative references in HTML to hosted asset URLs when needed.
 */
export function rewritePageAssetReferences(
  html: string,
  pageFilePath: string,
  site: Pick<Site, "publicUrl">,
  knownAssets: DiscoveredAsset[],
): string {
  let updated = html;
  const assetMap = new Map(knownAssets.map((a) => [a.repoPath, a]));

  for (const asset of knownAssets) {
    const hosted = assetUrl(site, asset.repoPath);

    // Matches relative references to this asset
    const exactPath = asset.repoPath;
    const relativeVariants = [
      `"${exactPath}"`,
      `'${exactPath}'`,
      `"./${exactPath}"`,
      `'./${exactPath}'`,
      `"/${exactPath}"`,
      `'/${exactPath}'`,
    ];

    // Relative from page directory
    const pageDir = path.dirname(pageFilePath);
    if (pageDir !== "." && pageDir !== "") {
      const relFromPage = path.posix.relative(pageDir, exactPath);
      relativeVariants.push(`"${relFromPage}"`, `'${relFromPage}'`);
    }

    for (const variant of relativeVariants) {
      if (updated.includes(variant)) {
        const quote = variant[0];
        updated = updated.split(variant).join(`${quote}${hosted}${quote}`);
      }
    }
  }

  return updated;
}

/**
 * Commits an unpacked package (pages and assets) transactionally into a Site.
 */
export async function commitPackageToSite(input: {
  req: WebsiteActor;
  siteId: string;
  analysis: PackageAnalysis;
}): Promise<ImportPackageResult> {
  const { req, siteId, analysis } = input;
  const site = await prisma.site.findUniqueOrThrow({
    where: { id: siteId },
    select: { id: true, name: true, publicUrl: true },
  });

  // Verify quotas and allowances
  await assertImportAllowance(req, siteId);
  const totalAssetBytes = analysis.assets.reduce((sum, a) => sum + a.size, 0);
  if (totalAssetBytes > 0) {
    await assertMediaStorageAllowance(req, totalAssetBytes, siteId);
  }

  // Pre-rewrite HTML references for each page
  const preparedPages = analysis.pages.map((page) => {
    const rewrittenHtml = rewritePageAssetReferences(page.html, page.filePath, site, analysis.assets);
    return {
      ...page,
      rewrittenHtml,
    };
  });

  // Database transaction: persist pages and assets
  const { createdPages, createdAssets } = await prisma.$transaction(async (tx) => {
    const createdAssetsList: Array<{ id: string; repoPath: string; filename: string; contentType: string; size: number }> = [];

    // 1. Insert or update assets
    for (const asset of analysis.assets) {
      const record = await tx.siteAsset.upsert({
        where: { siteId_repoPath: { siteId, repoPath: asset.repoPath } },
        create: {
          siteId,
          repoPath: asset.repoPath,
          filename: asset.filename,
          contentType: asset.contentType,
          content: asset.content,
          size: asset.size,
          alt: "",
        },
        update: {
          filename: asset.filename,
          contentType: asset.contentType,
          content: asset.content,
          size: asset.size,
        },
        select: { id: true, repoPath: true, filename: true, contentType: true, size: true },
      });
      createdAssetsList.push(record);
    }

    // 2. Insert or update pages and their initial version snapshot
    const createdPagesList: Array<{ id: string; title: string; path: string; filePath: string; fields: number }> = [];

    for (const page of preparedPages) {
      // Find existing or create new
      let pageRecord = await tx.sitePage.findFirst({
        where: { siteId, OR: [{ filePath: page.filePath }, { path: page.path }] },
        select: { id: true },
      });

      if (pageRecord) {
        pageRecord = await tx.sitePage.update({
          where: { id: pageRecord.id },
          data: {
            title: page.title,
            filePath: page.filePath,
            path: page.path,
            sourceHtml: page.rewrittenHtml,
          },
          select: { id: true },
        });
      } else {
        pageRecord = await tx.sitePage.create({
          data: {
            siteId,
            title: page.title,
            filePath: page.filePath,
            path: page.path,
            sourceHtml: page.rewrittenHtml,
          },
          select: { id: true },
        });
      }

      // 3. Create version 1 (snapshot of original imported source for recovery)
      const nextVersionNumber = ((await tx.sitePageVersion.count({ where: { pageId: pageRecord.id } })) || 0) + 1;
      await tx.sitePageVersion.create({
        data: {
          pageId: pageRecord.id,
          number: nextVersionNumber,
          html: page.rewrittenHtml,
          values: { initialImport: true, filePath: page.filePath, fields: page.editableCount },
          publishedById: req.dbUser?.id ?? null,
        },
      });

      createdPagesList.push({
        id: pageRecord.id,
        title: page.title,
        path: page.path,
        filePath: page.filePath,
        fields: page.editableCount,
      });
    }

    // 4. Record audit event with visible results (no silent skips)
    await tx.siteAuditEvent.create({
      data: {
        siteId,
        kind: "PACKAGE_IMPORTED",
        summary: `Imported ${analysis.isZip ? "ZIP package" : "HTML page"} with ${createdPagesList.length} page${createdPagesList.length === 1 ? "" : "s"} and ${createdAssetsList.length} asset${createdAssetsList.length === 1 ? "" : "s"}`,
        actorName: req.dbUser?.name ?? "Website editor",
        actorId: req.dbUser?.id,
        detail: {
          pagesCount: createdPagesList.length,
          assetsCount: createdAssetsList.length,
          totalBytesAdded: totalAssetBytes,
          missingAssetsCount: analysis.missingAssets.length,
          missingAssets: analysis.missingAssets,
          externalResourcesCount: analysis.externalResources.length,
        },
      },
    });

    return { createdPages: createdPagesList, createdAssets: createdAssetsList };
  });

  // Track quotas used
  if (totalAssetBytes > 0) {
    recordMediaStorageAdded(req, totalAssetBytes);
  }
  await recordImportUsed(req);

  return {
    siteId: site.id,
    siteName: site.name,
    pagesCount: createdPages.length,
    pages: createdPages,
    assetsCount: createdAssets.length,
    assets: createdAssets,
    missingAssets: analysis.missingAssets,
    externalResources: analysis.externalResources,
    warnings: analysis.warnings,
    totalBytesAdded: totalAssetBytes,
  };
}
