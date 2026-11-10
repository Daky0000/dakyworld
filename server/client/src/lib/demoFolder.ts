import JSZip from "jszip";
import { zipFilesToBase64 } from "./folderZip.js";

/**
 * Importing a demo with the folder beside it.
 *
 * An HTML file brings nothing with it, so a page that names its pictures as
 * `./images/...` showed every one broken in the editor and on the demo link.
 * Choosing the folder instead zips the page with the files it uses and sends
 * that; the server reads the page out, stores the files and points the page
 * at them (server/src/services/demoPackage.ts).
 */

export type FolderFile = { file: File; path: string };

/** The largest folder sent, before base64; the server takes 3 GB of JSON. */
export const MAX_DEMO_FOLDER_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

const SKIP = /(^|\/)(?:node_modules|\.git|__MACOSX)\/|(^|\/)(?:\.DS_Store|Thumbs\.db)$/;

/** Paths relative to the chosen folder, with the folder's own name taken off. */
export function relativeToFolder(entries: FolderFile[]): FolderFile[] {
  const kept = entries
    .map((entry) => ({ file: entry.file, path: entry.path.replace(/\\/g, "/").replace(/^\/+/, "") }))
    .filter((entry) => entry.path && !SKIP.test(entry.path));
  const first = kept[0]?.path.split("/")[0];
  if (first && kept.length && kept.every((entry) => entry.path.startsWith(`${first}/`))) {
    return kept.map((entry) => ({ file: entry.file, path: entry.path.slice(first.length + 1) }));
  }
  return kept;
}

/** The pages in a folder, `index.html` nearest the top first. */
export function htmlPagesIn(entries: Array<{ path: string }>): string[] {
  const depth = (p: string) => p.split("/").length;
  const isIndex = (p: string) => /(^|\/)index\.html?$/i.test(p);
  return entries
    .map((entry) => entry.path)
    .filter((p) => /\.html?$/i.test(p))
    .sort((a, b) => Number(isIndex(b)) - Number(isIndex(a)) || depth(a) - depth(b) || a.localeCompare(b));
}

/**
 * Files a page names beside it, which a lone HTML file cannot have brought —
 * the same rule as the server's `localFilesNamed`, so the warning here and the
 * note after an import name the same files.
 */
export function localFilesNamedInBrowser(html: string): string[] {
  const names = new Set<string>();
  for (const tag of html.matchAll(/<(?:img|video|audio|source|track)\b[^>]*>/gi)) {
    for (const attribute of tag[0].matchAll(/\s(src|poster)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi)) {
      const value = (attribute[2] ?? attribute[3] ?? attribute[4] ?? "").replace(/&amp;/g, "&").trim();
      if (!value || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(value) || value.includes("assets/dw/")) continue;
      names.add(value.replace(/[?#].*$/, ""));
    }
  }
  return [...names];
}

// The same reference rule as the server (services/demoPackage.ts): a path with
// a known extension, standing alone in an attribute, a srcset, a CSS url() or a
// script string. Anything with a scheme or `//` is somewhere else.
const EXTENSIONS = "png|jpe?g|gif|webp|avif|svg|ico|bmp|mp4|webm|ogv|ogg|mov|m4v|mp3|wav|m4a|aac|woff2?|ttf|otf|eot|css|js|mjs|json|vtt";
const REFERENCE = new RegExp(
  `(?:^|[\\s"'(,=])((?![a-z][a-z0-9+.-]*:|//)[^\\s"'()<>,]*?\\.(?:${EXTENSIONS}))(?:[?#][^\\s"'()<>,]*)?(?=$|[\\s"'),])`,
  "gi",
);

const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

function normalise(p: string): string | null {
  const out: string[] = [];
  for (const segment of p.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (!out.length) return null;
      out.pop();
    } else out.push(segment);
  }
  return out.join("/");
}

/** The file in the folder a reference names, resolved the way the browser would. */
function resolveReference(reference: string, sourcePath: string, siteRoot: string, byPath: Map<string, FolderFile>): FolderFile | null {
  const attempts = [reference];
  try {
    const decoded = decodeURIComponent(reference);
    if (decoded !== reference) attempts.push(decoded);
  } catch {}
  for (const attempt of attempts) {
    const clean = attempt.replace(/&amp;/g, "&");
    const bare = clean.replace(/^\/+/, "");
    const join = (dir: string) => (dir ? `${dir}/${bare}` : bare);
    // `/images/a.jpg` is from the site's root: the page's own folder, or a
    // framework's public/ or static/. Anything else is from the file naming it.
    const candidates = clean.startsWith("/")
      ? [join(siteRoot), bare, `public/${bare}`, `static/${bare}`]
      : [join(dirOf(sourcePath)), join(siteRoot ? `${siteRoot}/public` : "public")];
    for (const candidate of candidates) {
      const resolved = normalise(candidate);
      const hit = resolved === null ? undefined : byPath.get(resolved);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * The page and exactly the files in the folder it points at: from the page,
 * and from the stylesheets (resolved against themselves) and scripts (against
 * the page) it uses. Resolved by path, not by name, so choosing a big folder —
 * Downloads, with three other copies of the same site in it — still sends only
 * this page's own pictures.
 */
export async function filesForPage(entries: FolderFile[], entryPath: string): Promise<FolderFile[]> {
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const page = byPath.get(entryPath);
  if (!page) return [];
  const siteRoot = dirOf(entryPath);
  const chosen = new Set<FolderFile>([page]);
  const queue: Array<{ text: string; base: string }> = [{ text: await page.file.text(), base: entryPath }];
  while (queue.length) {
    const { text, base } = queue.shift()!;
    for (const match of text.matchAll(REFERENCE)) {
      const hit = resolveReference(match[1]!, base, siteRoot, byPath);
      if (!hit || chosen.has(hit) || /\.html?$/i.test(hit.path)) continue;
      chosen.add(hit);
      if (/\.css$/i.test(hit.path)) queue.push({ text: await hit.file.text(), base: hit.path });
      else if (/\.m?js$/i.test(hit.path)) queue.push({ text: await hit.file.text(), base: entryPath });
    }
  }
  return [...chosen];
}

/**
 * The page and its files, zipped for the import. When every file sits in the
 * page's own folder, that folder becomes the archive's top, so the page is at
 * its root and named by its own file name.
 */
export async function zipPageWithFiles(entries: FolderFile[], entryPath: string, folderName: string) {
  const files = await filesForPage(entries, entryPath);
  const bytes = files.reduce((sum, entry) => sum + entry.file.size, 0);
  if (bytes > MAX_DEMO_FOLDER_BYTES) {
    throw new Error(
      `This page and the files it uses come to ${(bytes / 1024 / 1024).toFixed(0)} MB; the limit is 2 GB. Make the pictures smaller and choose the folder again.`,
    );
  }
  const root = dirOf(entryPath);
  const rebased = root && files.every((entry) => entry.path.startsWith(`${root}/`))
    ? files.map((entry) => ({ file: entry.file, path: entry.path.slice(root.length + 1) }))
    : files;
  const entry = root && rebased !== files ? entryPath.slice(root.length + 1) : entryPath;
  const zipped = await zipFilesToBase64(rebased, `${folderName || "demo"}.zip`);
  return { ...zipped, entry, html: await files[0]!.file.text() };
}

/** The page inside an uploaded ZIP the server will choose, read for its title. */
export async function pageInZip(file: File): Promise<{ path: string; html: string; pages: number } | null> {
  const zip = await JSZip.loadAsync(file);
  // The server's rule: skipped entries out, then one folder every entry sits in.
  const names = Object.values(zip.files)
    .filter((entry) => !entry.dir && !SKIP.test(entry.name))
    .map((entry) => entry.name);
  const first = names[0]?.split("/")[0];
  const strip = first && names.every((name) => name.startsWith(`${first}/`)) ? first.length + 1 : 0;
  const byRelative = new Map(names.map((name) => [name.slice(strip), name]));
  const pages = htmlPagesIn([...byRelative.keys()].map((path) => ({ path })));
  if (!pages.length) return null;
  const html = await zip.files[byRelative.get(pages[0]!)!]!.async("string");
  return { path: pages[0]!, html, pages: pages.length };
}
