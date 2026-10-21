/**
 * Which framework a connected repository is, and where its pages live.
 *
 * The page list used to have one question — "which folder holds the `.html`?" —
 * and one answer for every repository that has none: an empty table and a 422.
 * That is correct for a static site and useless for every Next, Astro, Svelte,
 * Nuxt or Vite project a customer might connect, which is most of them.
 *
 * So framework knowledge lives here, as a small registry, and it is deliberately
 * split in two:
 *
 *  - a **route adapter** answers "is this your project, and which of these files
 *    is a page?" — pure string work over a repository's file list;
 *  - a **syntax adapter** answers "how do I read and write the fields in this
 *    file?" — `jsx.ts` for the JSX family, `template.ts` for the HTML-shaped
 *    ones.
 *
 * They are separate because they do not line up one to one. Next and Vite share
 * the JSX adapter and have nothing else in common; Nuxt and a plain Vue SPA
 * share the template adapter and disagree about routing. Adding a framework is
 * then one detector, one route function and, only if its files are a new
 * language, one syntax adapter.
 *
 * Nothing here reads a file's contents, runs a build, or asks the network. It is
 * given a list of paths and returns a list of routes, which is what makes every
 * line of it testable with an array of strings — see `checks/websiteFrameworks.ts`.
 */
import { isTemplatePath, TEMPLATE_EXTENSIONS } from "./template.js";
import { isMarkdownPath, MARKDOWN_EXTENSIONS } from "./markdown.js";

/** What a scan found: one repository file that is a page, and its address. */
export type DiscoveredRoute = { filePath: string; path: string; title: string; listed: boolean };

/** Stored on the site, so every later screen knows what it is looking at without
 * listing the repository again. `null` means the HTML editor, as before. */
export type SourceKind =
  | "next" | "astro" | "sveltekit" | "nuxt" | "vue" | "vite-react" | "remix" | "gatsby" | "docusaurus" | "eleventy" | "hugo" | "jekyll"
  | "angular" | "solidstart" | "tanstack" | "qwik" | "svelte" | "vitepress" | "mkdocs" | "hexo";

export type FrameworkAdapter = {
  sourceKind: SourceKind;
  /** For a person: "an Astro project", in a sentence about what was found. */
  label: string;
  /** The file extensions this framework's pages are written in. */
  extensions: readonly string[];
  isProject(files: readonly string[]): boolean;
  routes(files: readonly string[], listed: Set<string>): DiscoveredRoute[];
  /**
   * Whether this framework's pages can be declared in code rather than in
   * folders, so the scan should also read the route table. True for the
   * single-page apps every AI builder emits, where `App.tsx` holds the whole
   * list and the file tree holds one shell. See `router.ts`.
   */
  readsRouteTable?: boolean;
};

const IGNORED = /(^|\/)(node_modules|\.git|\.github|\.next|\.nuxt|\.svelte-kit|\.astro|\.cache|dist|build|out|coverage|storybook-static)(\/|$)/i;

function config(files: readonly string[], name: string): boolean {
  const pattern = new RegExp(`(^|/)${name}\\.(js|cjs|mjs|ts|mts|cts)$`, "i");
  return files.some((file) => !IGNORED.test(file) && pattern.test(file));
}

/** The folder a framework's routes sit under, which may be nested in a monorepo
 * package: `apps/web/src/pages` is as much `src/pages` as the root one is. */
function under(files: readonly string[], folder: string): string[] {
  const pattern = new RegExp(`(^|/)${folder}/`, "i");
  return files.filter((file) => !IGNORED.test(file) && pattern.test(file));
}

function titleFor(route: string): string {
  if (route === "/") return "Home";
  const last = route.split("/").filter(Boolean).at(-1) ?? route;
  return last
    .replace(/^\[+\.*/, "")
    .replace(/\]+$/, "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase()) || route;
}

function tidy(route: string): string {
  const cleaned = `/${route.split("/").filter(Boolean).join("/")}`;
  return cleaned === "/" ? "/" : cleaned.replace(/\/+$/, "");
}

function routeList(entries: Array<{ filePath: string; path: string }>, listed: Set<string>): DiscoveredRoute[] {
  const seen = new Set<string>();
  return entries
    .filter((entry) => (seen.has(entry.filePath) ? false : (seen.add(entry.filePath), true)))
    .map((entry) => ({ filePath: entry.filePath, path: entry.path, title: titleFor(entry.path), listed: listed.has(entry.path) }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Next.js — both routers, because a real project often has one of each.
 *
 * App router: a route is a `page.*` file, its folder is the address, and
 * `(marketing)` groups are organisation rather than address, so they come out.
 * Everything else the router treats specially — `layout`, `loading`, `error`,
 * `template`, `default`, `not-found`, `route` (an API handler, not a page) — is
 * not a page and is excluded by name rather than by guess.
 *
 * Pages router: the file itself is the address, `index` is the folder, `_app`
 * and `_document` are not pages, and `pages/api/**` is an API.
 */
export function nextRoutes(files: readonly string[], listed: Set<string> = new Set()): DiscoveredRoute[] {
  const entries: Array<{ filePath: string; path: string }> = [];
  const special = /^(layout|template|loading|error|global-error|not-found|default|route|middleware|instrumentation)$/i;
  for (const file of files) {
    if (IGNORED.test(file)) continue;
    const app = /(^|\/)app\/(.*)$/i.exec(file);
    if (app) {
      const inside = app[2]!;
      if (!/(^|\/)page\.(jsx|tsx|js|ts)$/i.test(inside)) continue;
      const folder = inside.replace(/(^|\/)page\.(jsx|tsx|js|ts)$/i, "");
      const segments = folder.split("/").filter((segment) => segment && !/^\(.*\)$/.test(segment) && !segment.startsWith("@"));
      entries.push({ filePath: file, path: tidy(segments.join("/")) });
      continue;
    }
    const pages = /(^|\/)pages\/(.*)\.(jsx|tsx|js|ts)$/i.exec(file);
    if (pages) {
      const inside = pages[2]!;
      if (inside.startsWith("api/") || inside === "api" || special.test(inside.split("/").at(-1)!) || /(^|\/)_/.test(inside)) continue;
      const segments = inside.split("/");
      if (segments.at(-1)!.toLowerCase() === "index") segments.pop();
      entries.push({ filePath: file, path: tidy(segments.join("/")) });
    }
  }
  return routeList(entries, listed);
}

/** Astro — `src/pages`, with Markdown and MDX pages counting as routes because
 * Astro serves them as pages. `src/content/` is a collection, not a route. */
export function astroRoutes(files: readonly string[], listed: Set<string> = new Set()): DiscoveredRoute[] {
  const entries: Array<{ filePath: string; path: string }> = [];
  for (const file of files) {
    if (IGNORED.test(file)) continue;
    const match = /(^|\/)pages\/(.*)\.(astro|md|mdx|html)$/i.exec(file);
    if (!match || /(^|\/)content\//i.test(file)) continue;
    const segments = match[2]!.split("/");
    if (segments.at(-1)!.toLowerCase() === "index") segments.pop();
    entries.push({ filePath: file, path: tidy(segments.join("/")) });
  }
  return routeList(entries, listed);
}

/** SvelteKit — `src/routes`, where the page is always `+page.svelte` and every
 * other `+file` is a layout, an error page, or a server endpoint. */
export function svelteRoutes(files: readonly string[], listed: Set<string> = new Set()): DiscoveredRoute[] {
  const entries: Array<{ filePath: string; path: string }> = [];
  for (const file of files) {
    if (IGNORED.test(file)) continue;
    const match = /(^|\/)routes\/(.*)$/i.exec(file);
    if (!match) continue;
    const inside = match[2]!;
    if (!/(^|^.*\/)\+page\.svelte$/i.test(inside)) continue;
    const folder = inside.replace(/(^|\/)\+page\.svelte$/i, "");
    // `(app)` is a SvelteKit group, and `[[lang]]`/`[...rest]` are parameters
    // that stay in the address because they are the address.
    const segments = folder.split("/").filter((segment) => segment && !/^\(.*\)$/.test(segment));
    entries.push({ filePath: file, path: tidy(segments.join("/")) });
  }
  return routeList(entries, listed);
}

/** Nuxt and file-routed Vue — `pages/**.vue`. `app.vue` is the shell. */
export function vueRoutes(files: readonly string[], listed: Set<string> = new Set()): DiscoveredRoute[] {
  const entries: Array<{ filePath: string; path: string }> = [];
  for (const file of files) {
    if (IGNORED.test(file)) continue;
    const match = /(^|\/)pages\/(.*)\.vue$/i.exec(file);
    if (!match) continue;
    const segments = match[2]!.split("/");
    if (segments.at(-1)!.toLowerCase() === "index") segments.pop();
    entries.push({ filePath: file, path: tidy(segments.join("/")) });
  }
  return routeList(entries, listed);
}

/**
 * Vite + React with no routing convention at all.
 *
 * A SPA's routes are written in its code, not in its folders, so this claims
 * only what it can see: the files under `src/pages` when there are any, and
 * otherwise the one app shell. Listing the shell is honest — the file really is
 * where that site's text lives — and it is the difference between a customer
 * being able to edit their homepage and being told to build the project first.
 */
export function viteReactRoutes(files: readonly string[], listed: Set<string> = new Set()): DiscoveredRoute[] {
  const pages = files.filter((file) => !IGNORED.test(file) && /(^|\/)src\/pages\/[^/]*\.(jsx|tsx)$/i.test(file));
  if (pages.length) {
    return routeList(pages.map((file) => {
      const name = file.split("/").at(-1)!.replace(/\.(jsx|tsx)$/i, "");
      return { filePath: file, path: /^(index|home|app)$/i.test(name) ? "/" : tidy(name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase()) };
    }), listed);
  }
  const shell = files.find((file) => !IGNORED.test(file) && /(^|\/)src\/App\.(jsx|tsx)$/i.test(file));
  return shell ? routeList([{ filePath: shell, path: "/" }], listed) : [];
}

/**
 * A Vue single-page app — Vite or the Vue CLI with Vue Router.
 *
 * File-routed Vue (`pages/**.vue`, unplugin-vue-router) is what `vueRoutes`
 * reads. Without that folder the routes are a table in `src/router`, which
 * `router.ts` reads, and the file tree honestly has one page: the app shell.
 */
export function vueSpaRoutes(files: readonly string[], listed: Set<string> = new Set()): DiscoveredRoute[] {
  const pages = vueRoutes(files, listed);
  if (pages.length) return pages;
  const shell = files.find((file) => !IGNORED.test(file) && /(^|\/)src\/App\.vue$/i.test(file));
  return shell ? routeList([{ filePath: shell, path: "/" }], listed) : [];
}

/** A Svelte app built with Vite and no SvelteKit: one shell, whose routes (if any) are a library's map. */
export function svelteSpaRoutes(files: readonly string[], listed: Set<string> = new Set()): DiscoveredRoute[] {
  const shell = files.find((file) => !IGNORED.test(file) && /(^|\/)src\/App\.svelte$/i.test(file));
  return shell ? routeList([{ filePath: shell, path: "/" }], listed) : [];
}

/**
 * Angular — every route is declared in code (`app.routes.ts`, or a routing
 * module), never in folders, so the file tree offers only the root
 * component's template and `router.ts` reads the table, mapping each
 * component to the `.html` template beside it. Angular 20 names that template
 * `app.html` where earlier versions said `app.component.html`; both are read.
 */
export function angularRoutes(files: readonly string[], listed: Set<string> = new Set()): DiscoveredRoute[] {
  const root = files.find((file) => !IGNORED.test(file) && /(^|\/)src\/app\/app(?:\.component)?\.html$/i.test(file));
  return root ? routeList([{ filePath: root, path: "/" }], listed) : [];
}

/**
 * SolidStart — `src/routes`, where the file is the address: `index` is the
 * folder's own, `(group)` folders are organisation, and a `[...404]` catch-all
 * is not a page anybody is sent to.
 */
export function solidStartRoutes(files: readonly string[], listed: Set<string> = new Set()): DiscoveredRoute[] {
  const entries: Array<{ filePath: string; path: string }> = [];
  for (const file of files) {
    if (IGNORED.test(file)) continue;
    const match = /(^|\/)src\/routes\/(.*)\.(tsx|jsx|mdx|md)$/i.exec(file);
    if (!match) continue;
    const segments = match[2]!.split("/").filter((segment) => segment && !/^\(.*\)$/.test(segment));
    if (segments.some((segment) => segment.includes("...") || segment.startsWith("_"))) continue;
    if (segments.at(-1)!.toLowerCase() === "index") segments.pop();
    entries.push({ filePath: file, path: tidy(segments.join("/")) });
  }
  return routeList(entries, listed);
}

/**
 * TanStack Start and TanStack Router's file routes — `src/routes` (or
 * `app/routes`) with a `__root` layout. A dot is a slash, as in Remix;
 * `$param` stays in the address; `_pathless` and `(group)` segments are not
 * part of it; a `-` prefixed file is excluded by the router itself; and
 * `route.tsx` is the folder-route spelling of the folder's own file.
 */
export function tanstackRoutes(files: readonly string[], listed: Set<string> = new Set()): DiscoveredRoute[] {
  const entries: Array<{ filePath: string; path: string }> = [];
  for (const file of files) {
    if (IGNORED.test(file)) continue;
    const match = /(^|\/)(?:src|app)\/routes\/(.*)\.(tsx|jsx)$/i.exec(file);
    if (!match) continue;
    let inside = match[2]!.replace(/\/route$/i, "");
    if (/(^|\/)(__root|-)/.test(inside)) continue;
    // `_layout.tsx` itself is a layout around other routes, not a page.
    if (/(^|[./])_[^./]*$/.test(inside)) continue;
    inside = inside.replace(/(^|[./])index$/i, "");
    const segments = inside.split(/[./]/).filter((segment) => segment && !segment.startsWith("_") && !/^\(.*\)$/.test(segment));
    entries.push({ filePath: file, path: tidy(segments.join("/")) });
  }
  return routeList(entries, listed);
}

/**
 * Qwik City — `src/routes`, where a folder is an address and its page is the
 * `index` file inside it; `layout` and `plugin` files are not pages, and
 * `(group)` folders are organisation.
 */
export function qwikRoutes(files: readonly string[], listed: Set<string> = new Set()): DiscoveredRoute[] {
  const entries: Array<{ filePath: string; path: string }> = [];
  for (const file of files) {
    if (IGNORED.test(file)) continue;
    const match = /(^|\/)src\/routes\/((?:.*\/)?)index\.(tsx|jsx|mdx|md)$/i.exec(file);
    if (!match) continue;
    const segments = match[2]!.split("/").filter((segment) => segment && !/^\(.*\)$/.test(segment));
    entries.push({ filePath: file, path: tidy(segments.join("/")) });
  }
  return routeList(entries, listed);
}

/** Remix and React Router 7 — `app/routes`, where a route is the file and a dot
 * is a slash: `routes/blog.$slug.tsx` is `/blog/$slug`. `_index` is the folder's
 * own address and a leading `_` elsewhere is a pathless layout. */
export function remixRoutes(files: readonly string[], listed: Set<string> = new Set()): DiscoveredRoute[] {
  const entries: Array<{ filePath: string; path: string }> = [];
  for (const file of files) {
    if (IGNORED.test(file)) continue;
    const match = /(^|\/)app\/routes\/(.*)\.(jsx|tsx|js|ts|mdx)$/i.exec(file);
    if (!match) continue;
    let inside = match[2]!;
    // `blog/route.tsx` is the folder-route spelling of `blog.tsx`.
    inside = inside.replace(/\/route$/i, "");
    if (/(^|\.)_index$/i.test(inside)) inside = inside.replace(/(^|\.)_index$/i, "");
    const segments = inside.split(".").filter((segment) => segment && !segment.startsWith("_"));
    entries.push({ filePath: file, path: tidy(segments.join("/")) });
  }
  return routeList(entries, listed);
}

/** Gatsby — `src/pages`, the same shape as Next's pages router. */
export function gatsbyRoutes(files: readonly string[], listed: Set<string> = new Set()): DiscoveredRoute[] {
  const entries: Array<{ filePath: string; path: string }> = [];
  for (const file of files) {
    if (IGNORED.test(file)) continue;
    const match = /(^|\/)src\/pages\/(.*)\.(jsx|tsx|js|ts|md|mdx)$/i.exec(file);
    if (!match || /(^|\/)404/.test(match[2]!)) continue;
    const segments = match[2]!.split("/");
    if (segments.at(-1)!.toLowerCase() === "index") segments.pop();
    entries.push({ filePath: file, path: tidy(segments.join("/")) });
  }
  return routeList(entries, listed);
}

/**
 * The Markdown site generators: Docusaurus, Eleventy, Hugo and Jekyll.
 *
 * All four put their pages in a content folder as Markdown, and all four are
 * edited the same way — the words are the file. The folder is what tells them
 * apart, so one function takes it as an argument rather than four near-copies.
 */
function markdownRoutes(address: RegExp, files: readonly string[], listed: Set<string>): DiscoveredRoute[] {
  const entries: Array<{ filePath: string; path: string }> = [];
  for (const file of files) {
    // A theme file, a partial and a repository's own paperwork are not pages.
    if (IGNORED.test(file) || /(^|\/)(README|LICENSE|CHANGELOG|CONTRIBUTING)\./i.test(file)) continue;
    if (/(^|\/)(_layouts|_includes|_site|_data|layouts|themes|partials|node_modules)(\/|$)/i.test(file)) continue;
    const match = address.exec(file);
    if (!match) continue;
    const inside = match[1]!.replace(/\.(md|mdx|markdown|html)$/i, "");
    const segments = inside.split("/").filter(Boolean);
    // `index` and Hugo's `_index` are the folder's own address, not a page
    // called "index" sitting inside it.
    if (/^_?index$/i.test(segments.at(-1) ?? "")) segments.pop();
    entries.push({ filePath: file, path: tidy(segments.join("/")) });
  }
  return routeList(entries, listed);
}

/** Regular-expression text for a literal folder path. */
const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * VitePress — every Markdown file under the folder that holds `.vitepress/`
 * is a page at its own path, which is usually `docs/` and sometimes the
 * repository root. `public/` beside it is static files, not pages.
 */
export function vitepressRoutes(files: readonly string[], listed: Set<string> = new Set()): DiscoveredRoute[] {
  const config = files.find((file) => !IGNORED.test(file) && /(^|\/)\.vitepress\/config\.(js|cjs|mjs|ts|mts|cts)$/i.test(file));
  if (!config) return [];
  const root = config.replace(/\.vitepress\/config\.[a-z]+$/i, "");
  const inRoot = files.filter((file) => file.startsWith(root) && !/(^|\/)(\.vitepress|public)\//.test(file.slice(root.length)));
  return markdownRoutes(new RegExp(`^${literal(root)}(.*\\.(?:md|markdown))$`, "i"), inRoot, listed);
}

// Each of these captures exactly one group: the part of the path that is the
// address. Docusaurus keeps its folder — its docs really are served under
// `/docs` — and the others do not.
export const docusaurusRoutes = (files: readonly string[], listed: Set<string> = new Set()) => markdownRoutes(/(?:^|\/)((?:docs|blog)\/.*\.(?:md|mdx|markdown))$/i, files, listed);
export const eleventyRoutes = (files: readonly string[], listed: Set<string> = new Set()) => markdownRoutes(/(?:^|\/)(?:src|content|pages)\/(.*\.(?:md|markdown|html))$/i, files, listed);
export const hugoRoutes = (files: readonly string[], listed: Set<string> = new Set()) => markdownRoutes(/(?:^|\/)content\/(.*\.(?:md|markdown|html))$/i, files, listed);
export const jekyllRoutes = (files: readonly string[], listed: Set<string> = new Set()) => markdownRoutes(/^(?:_posts\/|_pages\/|pages\/)?(.*\.(?:md|markdown|html))$/i, files, listed);
/** MkDocs — `docs/`, served with directory addresses (`docs/about.md` is `/about/`). */
export const mkdocsRoutes = (files: readonly string[], listed: Set<string> = new Set()) => markdownRoutes(/(?:^|\/)docs\/(.*\.(?:md|markdown))$/i, files, listed);
/**
 * Hexo — the pages under `source/`. Its posts are left out on purpose: a
 * post's address comes from its date and the site's permalink setting, which
 * are in the file and the config rather than in its name, and a page list is a
 * promise that each address is real. They open from the source file browser.
 */
export const hexoRoutes = (files: readonly string[], listed: Set<string> = new Set()) =>
  markdownRoutes(/^source\/(?!_)(.*\.(?:md|markdown|html))$/i, files.filter((file) => !/^source\/_/i.test(file)), listed);

export const frameworkAdapters: readonly FrameworkAdapter[] = [
  {
    sourceKind: "next",
    label: "a Next.js project",
    extensions: [".tsx", ".jsx"],
    isProject: (files) => config(files, "next.config") && nextRoutes(files).length > 0,
    routes: nextRoutes,
  },
  {
    sourceKind: "astro",
    label: "an Astro project",
    extensions: [".astro"],
    isProject: (files) => config(files, "astro.config") || under(files, "src/pages").some((file) => /\.astro$/i.test(file)),
    routes: astroRoutes,
  },
  {
    sourceKind: "sveltekit",
    label: "a SvelteKit project",
    extensions: [".svelte"],
    isProject: (files) => svelteRoutes(files).length > 0,
    routes: svelteRoutes,
  },
  {
    sourceKind: "angular",
    label: "an Angular project",
    extensions: [".html"],
    readsRouteTable: true,
    isProject: (files) => files.some((file) => !IGNORED.test(file) && /(^|\/)angular\.json$/i.test(file)) && angularRoutes(files).length > 0,
    routes: angularRoutes,
  },
  {
    sourceKind: "qwik",
    label: "a Qwik City project",
    extensions: [".tsx", ".jsx", ".mdx"],
    isProject: (files) => files.some((file) => /(^|\/)src\/entry\.ssr\.(tsx|jsx|ts|js)$/i.test(file)) && qwikRoutes(files).length > 0,
    routes: qwikRoutes,
  },
  {
    sourceKind: "tanstack",
    label: "a TanStack Start project",
    extensions: [".tsx", ".jsx"],
    isProject: (files) => files.some((file) => !IGNORED.test(file) && /(^|\/)(?:src|app)\/routes\/__root\.(tsx|jsx)$/i.test(file)) && tanstackRoutes(files).length > 0,
    routes: tanstackRoutes,
  },
  {
    sourceKind: "solidstart",
    label: "a SolidStart project",
    extensions: [".tsx", ".jsx", ".mdx"],
    isProject: (files) => files.some((file) => /(^|\/)src\/entry-server\.(tsx|jsx)$/i.test(file)) && solidStartRoutes(files).length > 0,
    routes: solidStartRoutes,
  },
  {
    sourceKind: "nuxt",
    label: "a Nuxt project",
    extensions: [".vue"],
    isProject: (files) => config(files, "nuxt.config") && vueRoutes(files).length > 0,
    routes: vueRoutes,
  },
  {
    sourceKind: "vue",
    label: "a Vue project",
    extensions: [".vue"],
    // A Vue Router table in `src/router`, when there is no `pages/` folder.
    readsRouteTable: true,
    isProject: (files) => vueRoutes(files).length > 0 || ((config(files, "vite.config") || config(files, "vue.config")) && vueSpaRoutes(files).length > 0),
    routes: vueSpaRoutes,
  },
  {
    sourceKind: "svelte",
    label: "a Svelte app",
    extensions: [".svelte"],
    isProject: (files) => config(files, "vite.config") && svelteSpaRoutes(files).length > 0,
    routes: svelteSpaRoutes,
  },
  {
    sourceKind: "remix",
    label: "a Remix or React Router project",
    extensions: [".tsx", ".jsx"],
    isProject: (files) => remixRoutes(files).length > 0 && (config(files, "remix.config") || config(files, "react-router.config") || config(files, "vite.config")),
    routes: remixRoutes,
  },
  {
    sourceKind: "gatsby",
    label: "a Gatsby project",
    extensions: [".tsx", ".jsx"],
    isProject: (files) => config(files, "gatsby-config") && gatsbyRoutes(files).length > 0,
    routes: gatsbyRoutes,
  },
  {
    sourceKind: "vitepress",
    label: "a VitePress site",
    extensions: [".md"],
    isProject: (files) => vitepressRoutes(files).length > 0,
    routes: vitepressRoutes,
  },
  {
    sourceKind: "mkdocs",
    label: "an MkDocs site",
    extensions: [".md"],
    isProject: (files) => files.some((file) => /^mkdocs\.ya?ml$/i.test(file)) && mkdocsRoutes(files).length > 0,
    routes: mkdocsRoutes,
  },
  {
    sourceKind: "docusaurus",
    label: "a Docusaurus site",
    extensions: [".md", ".mdx"],
    isProject: (files) => config(files, "docusaurus.config"),
    routes: docusaurusRoutes,
  },
  {
    sourceKind: "eleventy",
    label: "an Eleventy site",
    extensions: [".md"],
    isProject: (files) => config(files, "eleventy.config") || files.some((file) => /(^|\/)\.eleventy\.(js|cjs|mjs)$/i.test(file)),
    routes: eleventyRoutes,
  },
  {
    sourceKind: "hugo",
    label: "a Hugo site",
    extensions: [".md"],
    isProject: (files) => files.some((file) => /(^|\/)(hugo|config)\.(toml|yaml|yml)$/i.test(file)) && under(files, "content").length > 0,
    routes: hugoRoutes,
  },
  {
    // Before Jekyll: a Hexo site has a `_config.yml` too, and read as Jekyll
    // its pages were listed at `/source/...`, an address that does not exist.
    sourceKind: "hexo",
    label: "a Hexo site",
    extensions: [".md"],
    isProject: (files) => files.some((file) => /^_config\.ya?ml$/i.test(file)) && files.some((file) => /^(scaffolds|source\/_posts)\//i.test(file)),
    routes: hexoRoutes,
  },
  {
    sourceKind: "jekyll",
    label: "a Jekyll site",
    extensions: [".md"],
    isProject: (files) => files.some((file) => /(^|\/)_config\.(yml|yaml)$/i.test(file)),
    routes: jekyllRoutes,
  },
  {
    sourceKind: "vite-react",
    label: "a Vite React project",
    readsRouteTable: true,
    // Last, and only when nothing above claimed the repository: its detection is
    // the weakest of the six, so it must never take a project off one of them.
    extensions: [".tsx", ".jsx"],
    isProject: (files) => config(files, "vite.config") && viteReactRoutes(files).length > 0,
    routes: viteReactRoutes,
  },
];

/**
 * The folder a framework serves static files from.
 *
 * An uploaded image has to land where the build will find it, and every
 * framework has its own answer: `public/` for most, `static/` for SvelteKit and
 * Hugo, the repository root for Jekyll and Eleventy, which copy what they are
 * given. Putting a photograph in the wrong one produces a page with a broken
 * image and a commit that looks perfectly fine, so this is one table rather
 * than a guess at each call site.
 */
export function publicFolder(sourceKind: string | null | undefined, filePath?: string): string {
  switch (sourceKind) {
    case "sveltekit":
    case "hugo":
    case "docusaurus":
      return "static";
    case "jekyll":
    case "eleventy":
      return "";
    // MkDocs copies everything under `docs/` to the site, pictures included;
    // Hexo copies `source/`. Neither has a separate static folder.
    case "mkdocs":
      return "docs";
    case "hexo":
      return "source";
    // VitePress serves `<root>/public`, and the root — the folder holding
    // `.vitepress/` — is `docs/` in nearly every project and the repository
    // root in most of the rest. Which one is read off the page being published.
    // A project rooted in any other folder would get its picture in `public/`,
    // which it does not serve; that layout is rare enough to be named in the
    // compatibility notes rather than guessed at here.
    case "vitepress":
      return /^docs\//i.test(filePath ?? "") ? "docs/public" : "public";
    case null:
    case undefined:
      return "";
    default:
      return "public";
  }
}

/** The framework whose project this is, in registry order, or null. */
export function detectFramework(files: readonly string[]): FrameworkAdapter | null {
  return frameworkAdapters.find((adapter) => adapter.isProject(files)) ?? null;
}

export function frameworkFor(sourceKind: string | null | undefined): FrameworkAdapter | null {
  return frameworkAdapters.find((adapter) => adapter.sourceKind === sourceKind) ?? null;
}

/** Every extension any registered framework can edit, for the file browser and
 * for the one sentence that has to list them to a person. */
export const EDITABLE_SOURCE_EXTENSIONS: readonly string[] = [...new Set([".jsx", ".tsx", ".ts", ".js", ...TEMPLATE_EXTENSIONS, ...MARKDOWN_EXTENSIONS])];

export function isEditableSourcePath(filePath: string): boolean {
  const lower = filePath.replace(/\\/g, "/").toLowerCase();
  // `.ts` and `.js` are here for content files — a `src/data/site.ts` holding a
  // nav and a tagline, which is where half of these projects keep their words.
  // Opening one that turns out to be ordinary code is not a hazard: it has no
  // content-named strings in it, and the editor says so rather than guessing.
  return /\.(jsx|tsx|ts|js|mjs|cjs)$/.test(lower) || isTemplatePath(lower) || isMarkdownPath(lower);
}
