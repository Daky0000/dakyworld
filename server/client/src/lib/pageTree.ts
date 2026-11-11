/**
 * A website's pages as a tree, from their addresses.
 *
 * An imported site arrives as dozens of pages (`/projects` and forty project
 * pages under it), and a flat list of them reads as a pile. The address already
 * says where each page belongs: `/projects/doha-festival-city` is a child of
 * `/projects`. Nothing is stored — the tree is read from the paths every time,
 * so a page moved or renamed is in the right place on the next load.
 *
 * - The home page (`/`) is the first top-level entry, not the parent of every
 *   page, so the whole site is not indented one level for nothing.
 * - A page's parent is the nearest address above it that is a page. Where
 *   pages share a folder that has no page of its own (`/blog/a`, `/blog/b`, no
 *   `/blog`), the folder is shown as a group with no page behind it.
 * - Every page except home has a parent link: its nearest ancestor page, or
 *   home when it has none (`pageAncestors`).
 */
export type PageLike = { id: string; title: string; path: string };

export type PageTreeNode<T extends PageLike> = {
  /** The address, which is unique in a site. */
  key: string;
  path: string;
  label: string;
  /** Null for a folder with no page of its own. */
  page: T | null;
  children: PageTreeNode<T>[];
};

export function normalisePagePath(path: string): string {
  const clean = (path || "/").split(/[?#]/)[0]!.replace(/\/+$/, "");
  return clean.startsWith("/") ? clean || "/" : `/${clean}`;
}

function parentPathOf(path: string): string | null {
  if (path === "/") return null;
  const cut = path.lastIndexOf("/");
  return cut <= 0 ? null : path.slice(0, cut);
}

function segmentLabel(path: string): string {
  const segment = path.slice(path.lastIndexOf("/") + 1);
  let text = segment;
  try {
    text = decodeURIComponent(segment);
  } catch {}
  const words = text.replace(/[-_]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : path;
}

export function buildPageTree<T extends PageLike>(pages: readonly T[]): PageTreeNode<T>[] {
  const nodes = new Map<string, PageTreeNode<T>>();
  const roots: PageTreeNode<T>[] = [];
  const ensure = (path: string): PageTreeNode<T> => {
    const existing = nodes.get(path);
    if (existing) return existing;
    const node: PageTreeNode<T> = { key: path, path, label: segmentLabel(path), page: null, children: [] };
    nodes.set(path, node);
    const parent = parentPathOf(path);
    if (parent) ensure(parent).children.push(node);
    else roots.push(node);
    return node;
  };
  for (const page of pages) {
    const node = ensure(normalisePagePath(page.path));
    if (!node.page) {
      node.page = page;
      node.label = page.title?.trim() || (node.path === "/" ? "Home" : node.label);
    }
  }
  const home = roots.findIndex((node) => node.path === "/");
  if (home > 0) roots.unshift(...roots.splice(home, 1));
  return roots;
}

export type PageTreeRow<T extends PageLike> = { node: PageTreeNode<T>; depth: number; collapsed: boolean };

/** The rows to draw, top to bottom, skipping what sits under a collapsed entry. */
export function flattenPageTree<T extends PageLike>(roots: readonly PageTreeNode<T>[], collapsed: ReadonlySet<string>): PageTreeRow<T>[] {
  const rows: PageTreeRow<T>[] = [];
  const visit = (node: PageTreeNode<T>, depth: number) => {
    const shut = node.children.length > 0 && collapsed.has(node.key);
    rows.push({ node, depth, collapsed: shut });
    if (!shut) for (const child of node.children) visit(child, depth + 1);
  };
  for (const root of roots) visit(root, 0);
  return rows;
}

/** Pages under an entry, at any depth. */
export function countPagesUnder<T extends PageLike>(node: PageTreeNode<T>): number {
  return node.children.reduce((sum, child) => sum + (child.page ? 1 : 0) + countPagesUnder(child), 0);
}

/**
 * The pages above this one, top first: home, then each ancestor that is a
 * page. The last is its parent. Empty for the home page itself.
 */
export function pageAncestors<T extends PageLike>(path: string, pages: readonly T[]): T[] {
  const target = normalisePagePath(path);
  if (target === "/") return [];
  const byPath = new Map(pages.map((page) => [normalisePagePath(page.path), page]));
  const out: T[] = [];
  const home = byPath.get("/");
  if (home) out.push(home);
  const segments = target.split("/").filter(Boolean);
  for (let i = 1; i < segments.length; i++) {
    const page = byPath.get(`/${segments.slice(0, i).join("/")}`);
    if (page) out.push(page);
  }
  return out;
}

/** Collapsed by default: any entry with more than this many children. */
export const COLLAPSE_OVER = 8;

export function defaultCollapsed<T extends PageLike>(roots: readonly PageTreeNode<T>[]): Set<string> {
  const keys = new Set<string>();
  const visit = (node: PageTreeNode<T>) => {
    if (node.children.length > COLLAPSE_OVER) keys.add(node.key);
    node.children.forEach(visit);
  };
  roots.forEach(visit);
  return keys;
}

/**
 * The site page a link on the canvas points at, if it is one. `href` is the
 * address the browser resolved (absolute, against the page's `<base>`);
 * `publicUrl` is the site's own, whose path is the site's base.
 */
export function pageForHref<T extends PageLike & { filePath?: string }>(href: string, publicUrl: string, pages: readonly T[]): T | null {
  let url: URL;
  let site: URL;
  try {
    site = new URL(publicUrl);
    url = new URL(href, site);
  } catch {
    return null;
  }
  if (url.host !== site.host) return null;
  const base = site.pathname.replace(/\/+$/, "");
  let path = url.pathname;
  try {
    path = decodeURI(path);
  } catch {}
  if (base && (path === base || path.startsWith(`${base}/`))) path = path.slice(base.length) || "/";
  const route = normalisePagePath(path.replace(/\/index\.html?$/i, "/").replace(/\.html?$/i, ""));
  const file = path.replace(/^\/+/, "");
  return pages.find((page) => normalisePagePath(page.path) === route) ?? pages.find((page) => page.filePath === file || page.filePath === `${file.replace(/\/+$/, "")}/index.html`) ?? null;
}
