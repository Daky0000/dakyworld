/**
 * A demo imported with the files beside it.
 *
 * An HTML file brings nothing with it. A page exported from a builder or
 * written by hand names its pictures by where they sit next to it
 * (`./images/hero/plant.jpg`), so a demo imported as one file showed every
 * one of them as a broken picture: on the editor canvas, in the editor's
 * preview and on the public link, because `/demos/<slug>/images/...` is not a
 * file anybody ever gave the server. The only way out was selecting each
 * picture and uploading it again, one at a time.
 *
 * So a demo can now arrive as a ZIP (a folder is zipped in the browser). The
 * page is read out of it, every file the page points at that the archive
 * holds is stored as a site asset of the demo's site, and each reference is
 * rewritten to the address the demo already serves editor uploads from —
 * `/demos/<slug>/assets/dw/<file>`. The editor's own Replace writes the same
 * shape, so a picture brought in this way and one uploaded later are the same
 * kind of thing to every other part of the system.
 *
 * Only the files the page uses are stored. A stylesheet is followed, since it
 * names its fonts and backgrounds relative to itself; a script is followed
 * relative to the page, because that is what the browser resolves its strings
 * against.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import { prisma } from "../lib/prisma.js";
import { optimizeImageBuffer } from "../lib/imageOptimization.js";
import { analyzeImportPackage, mimeTypeFromPath, resolvePackagePath } from "./websitePackageImport.js";
import { WebsiteError } from "./website/site.js";

export type DemoPackage = {
  /** The page used, as a path inside the archive. */
  entryPath: string;
  html: string;
  /** Every other file in the archive, by its path inside the archive. */
  files: Map<string, Buffer>;
  /** The other pages in the archive, which a one-page demo does not use. */
  otherPages: string[];
};

export type PendingDemoAsset = {
  /** The archive path it came from, for the import's notes. */
  source: string;
  repoPath: string;
  filename: string;
  contentType: string;
  content: Buffer;
};

export class DemoPackageError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** The bytes of a base64 upload when they are a ZIP archive, otherwise null. */
export function zipUploadBytes(dataBase64: string | null | undefined): Buffer | null {
  if (!dataBase64 || !dataBase64.trim()) return null;
  const raw = dataBase64.trim();
  const comma = raw.indexOf(",");
  const base64 = raw.startsWith("data:") && comma >= 0 ? raw.slice(comma + 1) : raw;
  // Four bytes decide it; the whole upload is only decoded once it is a ZIP.
  const head = Buffer.from(base64.slice(0, 8), "base64");
  if (head.length < 4 || head[0] !== 0x50 || head[1] !== 0x4b || ![0x03, 0x05, 0x07].includes(head[2]!)) return null;
  return Buffer.from(base64, "base64");
}

/**
 * Reads the page and its neighbours out of an archive. `entry` names the page
 * when the archive holds several; otherwise `index.html` nearest the top wins,
 * then the only page, then the first.
 */
export async function readDemoPackage(buffer: Buffer, filename: string | null | undefined, entry?: string | null): Promise<DemoPackage> {
  let analysis;
  try {
    analysis = await analyzeImportPackage({ buffer, filename: filename || "demo.zip" });
  } catch (err) {
    if (err instanceof WebsiteError) throw new DemoPackageError(err.status, err.message);
    throw err;
  }
  const pages = analysis.pages;
  const wanted = entry?.trim().replace(/\\/g, "/").replace(/^\.?\/+/, "");
  const depth = (p: string) => p.split("/").length;
  const page =
    (wanted ? pages.find((p) => p.filePath === wanted) ?? pages.find((p) => path.posix.basename(p.filePath) === path.posix.basename(wanted)) : undefined) ??
    [...pages].filter((p) => /^index\.html?$/i.test(path.posix.basename(p.filePath))).sort((a, b) => depth(a.filePath) - depth(b.filePath))[0] ??
    pages[0];
  if (!page) throw new DemoPackageError(400, "No HTML page was found in that ZIP. Include the page's .html file.");
  return {
    entryPath: page.filePath,
    html: page.originalHtml,
    files: new Map(analysis.assets.map((asset) => [asset.repoPath, asset.content])),
    otherPages: pages.filter((p) => p !== page).map((p) => p.filePath),
  };
}

/**
 * A local file reference: a path ending in a known extension, standing alone
 * between quotes, parentheses, `=`, commas or whitespace — an attribute value,
 * a `srcset` candidate, a CSS `url()`, or a string in a script. Anything with a
 * scheme or `//` is somewhere else and is left alone.
 */
const EXTENSIONS = "png|jpe?g|gif|webp|avif|svg|ico|bmp|mp4|webm|ogv|ogg|mov|m4v|mp3|wav|m4a|aac|woff2?|ttf|otf|eot|css|js|mjs|json|vtt|pdf";
const REFERENCE = new RegExp(
  `(^|[\\s"'(,=])((?![a-z][a-z0-9+.-]*:|//)[^\\s"'()<>,]*?\\.(?:${EXTENSIONS}))((?:[?#][^\\s"'()<>,]*)?)(?=$|[\\s"'),])`,
  "gi",
);

/**
 * What may be stored and served from an archive. A PDF is here because a
 * site's pages link their brochures and terms; the demo page and the site
 * import (websiteSitePackage.ts) share this list and the helpers below.
 */
export const STORABLE = /^(?:image\/|video\/|audio\/|font\/|text\/css$|application\/javascript$|application\/json$|application\/vnd\.ms-fontobject$|text\/vtt$|application\/pdf$)/;

export function contentTypeFor(filePath: string): string {
  const ext = path.posix.extname(filePath).toLowerCase();
  const extra: Record<string, string> = {
    ".avif": "image/avif",
    ".bmp": "image/bmp",
    ".ogv": "video/ogg",
    ".ogg": "audio/ogg",
    ".mov": "video/quicktime",
    ".m4v": "video/mp4",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".vtt": "text/vtt",
  };
  return extra[ext] ?? mimeTypeFromPath(filePath);
}

/** The archive file a reference names, if the archive holds it. */
function resolveIn(known: Set<string>, reference: string, sourcePath: string): string | null {
  const attempts = [reference];
  try {
    const decoded = decodeURIComponent(reference);
    if (decoded !== reference) attempts.push(decoded);
  } catch {}
  for (const attempt of attempts) {
    const resolved = resolvePackagePath(attempt.replace(/&amp;/g, "&"), sourcePath, known);
    if (resolved && known.has(resolved)) return resolved;
  }
  return null;
}

export function referencesIn(text: string, sourcePath: string, known: Set<string>): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(REFERENCE)) {
    const resolved = resolveIn(known, match[2]!, sourcePath);
    if (resolved) found.push(resolved);
  }
  return found;
}

export function rewriteReferences(text: string, sourcePath: string, known: Set<string>, hosted: Map<string, string>): string {
  return text.replace(REFERENCE, (whole, before: string, reference: string, suffix: string) => {
    const resolved = resolveIn(known, reference, sourcePath);
    const url = resolved ? hosted.get(resolved) : undefined;
    if (!url) return whole;
    // A cache-busting query means nothing on a file with its own name; a
    // fragment can (an SVG sprite's `#icon`), so it is kept.
    return `${before}${url}${suffix.startsWith("#") ? suffix : ""}`;
  });
}

export const isTextAsset = (contentType: string) => contentType === "text/css" || contentType === "application/javascript" || contentType === "application/json";

/**
 * Rewrites the page so every file it names from the archive points at the
 * demo's own asset address, and returns the files to store. `hostedBase` is
 * `/demos/<slug>/assets/dw`. Pictures go through the same optimiser as an
 * upload in the editor; an animated GIF is kept as it is, because the
 * optimiser keeps only its first frame.
 */
export async function bundleDemoFiles(
  html: string,
  pkg: Pick<DemoPackage, "entryPath" | "files">,
  hostedBase: string,
): Promise<{ html: string; assets: PendingDemoAsset[]; skipped: string[] }> {
  const { files, entryPath } = pkg;
  const known = new Set(files.keys());

  // 1. What the page uses, following stylesheets (relative to themselves) and
  //    scripts (relative to the page) for the files they name in turn.
  const needed = new Set<string>();
  const queue = referencesIn(html, entryPath, known);
  while (queue.length) {
    const next = queue.shift()!;
    if (needed.has(next)) continue;
    needed.add(next);
    const type = contentTypeFor(next);
    if (type === "text/css") queue.push(...referencesIn(files.get(next)!.toString("utf8"), next, known));
    else if (type === "application/javascript") queue.push(...referencesIn(files.get(next)!.toString("utf8"), entryPath, known));
  }

  // 2. Each binary file prepared, so its final name (an optimised picture
  //    becomes .webp) is known before anything is rewritten to point at it.
  const prepared = new Map<string, { content: Buffer; contentType: string; extension: string }>();
  const skipped: string[] = [];
  for (const source of needed) {
    const contentType = contentTypeFor(source);
    if (!STORABLE.test(contentType)) {
      skipped.push(source);
      continue;
    }
    const raw = files.get(source)!;
    const extension = path.posix.extname(source).slice(1).toLowerCase() || "bin";
    if (/^image\/(?:png|jpeg|webp|svg\+xml)$/.test(contentType)) {
      try {
        const optimised = await optimizeImageBuffer(raw);
        prepared.set(source, { content: optimised.content, contentType: optimised.contentType, extension: optimised.extension });
      } catch {
        // Not the picture its name says (or an SVG the sanitiser refuses): it
        // stays unresolved and the import's note names it.
        skipped.push(source);
      }
      continue;
    }
    prepared.set(source, { content: raw, contentType, extension });
  }

  const hosted = new Map<string, string>();
  const repoPaths = new Map<string, string>();
  for (const [source, file] of prepared) {
    const repoPath = `assets/dw/${randomUUID()}.${file.extension}`;
    repoPaths.set(source, repoPath);
    hosted.set(source, `${hostedBase.replace(/\/+$/, "")}/${path.posix.basename(repoPath)}`);
  }

  // 3. Stylesheets and scripts rewritten in turn, then the page.
  const assets: PendingDemoAsset[] = [];
  for (const [source, file] of prepared) {
    let content = file.content;
    if (isTextAsset(file.contentType)) {
      const base = file.contentType === "text/css" ? source : entryPath;
      content = Buffer.from(rewriteReferences(content.toString("utf8"), base, known, hosted), "utf8");
    }
    assets.push({
      source,
      repoPath: repoPaths.get(source)!,
      filename: path.posix.basename(source).slice(0, 200),
      contentType: file.contentType,
      content,
    });
  }

  return { html: rewriteReferences(html, entryPath, known, hosted), assets, skipped };
}

/** Stores the files a bundled demo points at, on the demo's site. */
export async function storeDemoAssets(siteId: string, assets: PendingDemoAsset[]): Promise<void> {
  if (!assets.length) return;
  await prisma.siteAsset.createMany({
    data: assets.map((asset) => ({
      siteId,
      repoPath: asset.repoPath,
      filename: asset.filename,
      contentType: asset.contentType,
      content: asset.content,
      size: asset.content.length,
      alt: "",
    })),
  });
}

/** One line for the import's notes, naming what came with the page. */
export function bundledFilesNote(pkg: DemoPackage, stored: number, skipped: string[]): string[] {
  const notes: string[] = [];
  if (stored) notes.push(`${stored} file${stored === 1 ? "" : "s"} the page uses ${stored === 1 ? "was" : "were"} uploaded with it from ${pkg.entryPath}'s folder.`);
  if (skipped.length) {
    const listed = skipped.slice(0, 4).join(", ") + (skipped.length > 4 ? ` and ${skipped.length - 4} more` : "");
    notes.push(`${skipped.length === 1 ? "One file" : `${skipped.length} files`} the page names could not be stored (not a picture, video, font, stylesheet or script it can serve, or not readable as one): ${listed}.`);
  }
  if (pkg.otherPages.length) {
    notes.push(`The demo is ${pkg.entryPath}. ${pkg.otherPages.length} other page${pkg.otherPages.length === 1 ? " was" : "s were"} in the folder and ${pkg.otherPages.length === 1 ? "is" : "are"} not part of it; links to ${pkg.otherPages.length === 1 ? "it" : "them"} will not open.`);
  }
  return notes;
}
