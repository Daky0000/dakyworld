import JSZip from "jszip";
import { zipFilesToBase64 } from "./folderZip";

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

/** The largest folder sent, before base64; the server takes 100 MB of JSON. */
export const MAX_DEMO_FOLDER_BYTES = 70 * 1024 * 1024;

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

const TEXT_FILE = /\.(?:css|js|mjs)$/i;

/**
 * The page and every file in the folder it could use: one named anywhere in
 * the page, or in a stylesheet or script it uses. Generous on purpose — a
 * name match is enough here, and the server decides exactly — so a folder of
 * sixteen pages and fifty megabytes of pictures sends only this page's share.
 */
export async function filesForPage(entries: FolderFile[], entryPath: string): Promise<FolderFile[]> {
  const page = entries.find((entry) => entry.path === entryPath);
  if (!page) return [];
  const candidates = entries.filter((entry) => entry !== page && !/\.html?$/i.test(entry.path));
  const chosen = new Set<FolderFile>([page]);
  const texts = [await page.file.text()];
  for (let i = 0; i < texts.length; i++) {
    const text = texts[i]!;
    for (const candidate of candidates) {
      if (chosen.has(candidate)) continue;
      const name = candidate.path.split("/").pop()!;
      if (text.includes(name) || text.includes(encodeURIComponent(name)) || text.includes(name.replace(/ /g, "%20"))) {
        chosen.add(candidate);
        if (TEXT_FILE.test(candidate.path)) texts.push(await candidate.file.text());
      }
    }
  }
  return [...chosen];
}

/** The page and its files, zipped for the import. */
export async function zipPageWithFiles(entries: FolderFile[], entryPath: string, folderName: string) {
  const files = await filesForPage(entries, entryPath);
  const bytes = files.reduce((sum, entry) => sum + entry.file.size, 0);
  if (bytes > MAX_DEMO_FOLDER_BYTES) {
    throw new Error(
      `This page and the files it uses come to ${(bytes / 1024 / 1024).toFixed(0)} MB; the limit is ${MAX_DEMO_FOLDER_BYTES / 1024 / 1024} MB. Make the pictures smaller and choose the folder again.`,
    );
  }
  const zipped = await zipFilesToBase64(files, `${folderName || "demo"}.zip`);
  return { ...zipped, html: await files[0]!.file.text() };
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
