/**
 * The manifest for a real page in a real repository.
 *
 * `manifest.ts` and `pageFields.ts` are given a reader and a file list and know
 * nothing about GitHub, which is what makes every rule in them checkable against
 * an object of fixture strings. This is the other half: the one place that turns
 * a `Site` and a `SitePage` into those two arguments.
 *
 * Two things it is careful about.
 *
 * **Which space the paths are in.** A site may live in a folder of a larger
 * repository (`site.repoPath`), and every path in the manifest is relative to
 * *that folder*, not to the repository root. It has to be: a project's
 * `tsconfig.json` declares `@/*` against its own folder, and resolving an alias
 * in repository space would send `@/components/Hero` to a folder that is not
 * there. The prefix goes back on at the door, in the reader.
 *
 * **How many requests it makes.** A manifest of forty files is forty file reads,
 * and the editor asks for one every time somebody opens a page. So reads are
 * memoised for the life of one request — the manifest crawl and the field
 * discovery that follows it read the same forty files, and without this they
 * would read them twice.
 */
import type { Site, SitePage } from "@prisma/client";
import { listRepoFiles, readFile } from "../lib/github.js";
import { buildSourceManifest, type SourceManifest } from "./website/manifest.js";
import { discoverPageFields, type PageDiscovery } from "./website/pageFields.js";
import { siteRepo, WebsiteError } from "./website/site.js";

/** Only the JSX family gets a manifest. An `.astro` or `.vue` page keeps the
 * single-file path it already had, because the crawl parses JavaScript imports
 * and those files are not JavaScript. */
export function hasSourceManifest(filePath: string): boolean {
  return /\.(jsx|tsx|js|ts|mjs|cjs)$/i.test(filePath);
}

function folderOf(site: Pick<Site, "repoPath">): string {
  return site.repoPath.replace(/^\/+|\/+$/g, "");
}

/** A reader in site-folder space that reads each file at most once. */
export function cachedReader(read: (path: string) => Promise<string | null>): ((path: string) => Promise<string | null>) & { reads: number } {
  const cache = new Map<string, Promise<string | null>>();
  const reader = (path: string) => {
    const existing = cache.get(path);
    if (existing) return existing;
    reader.reads += 1;
    const pending = read(path).catch(() => null);
    cache.set(path, pending);
    return pending;
  };
  reader.reads = 0;
  return reader;
}

export type PageManifest = {
  manifest: SourceManifest;
  discovery: PageDiscovery;
  /** The same memoised reader the manifest was built with, so a later write
   * path sees exactly the bytes the manifest was hashed from. */
  read(path: string): Promise<string | null>;
  /** Turns a site-folder path back into a repository path, for committing. */
  repoPathFor(path: string): string;
};

/**
 * Build a page's manifest and discover every field in it.
 *
 * Throws a `WebsiteError` rather than returning null on the two conditions a
 * person can act on — no repository connected, and a repository too large for
 * GitHub to describe in one call — because both of those are sentences the
 * editor should show rather than an empty page it cannot explain.
 */
export async function pageManifest(site: Site, page: SitePage): Promise<PageManifest> {
  const repo = siteRepo(site);
  if (!repo) throw new WebsiteError(409, "Connect this site's GitHub repository in Website settings to edit its pages.");
  const folder = folderOf(site);
  const repoPathFor = (path: string) => (folder ? `${folder}/${path}` : path);

  const tree = await listRepoFiles(repo, site.repoBranch);
  if (tree.truncated) {
    throw new WebsiteError(
      409,
      "This repository is too large for the editor to describe in one pass, so it cannot say reliably which files a page reaches. Ask a developer to point the site at the folder its pages live in.",
    );
  }
  const prefix = folder ? `${folder}/` : "";
  const files = tree.files
    .filter((file) => !prefix || file.startsWith(prefix))
    .map((file) => file.slice(prefix.length))
    .filter(Boolean);

  const read = cachedReader((path) => readFile(repo, repoPathFor(path), site.repoBranch));
  const tsconfig = (await read("tsconfig.json")) ?? (await read("jsconfig.json"));
  const manifest = await buildSourceManifest({ entry: page.filePath, files, read, tsconfig });
  const discovery = await discoverPageFields({ manifest, read });
  return { manifest, discovery, read, repoPathFor };
}
