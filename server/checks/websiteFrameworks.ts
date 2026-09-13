/**
 * Which files of a repository are pages, for each framework we claim to list.
 *
 * The defect this was written against is the one every framework project hit:
 * the page list asked "where are the `.html` files?", a Next or Astro project
 * has none until it is built, and the answer was an empty table with a sentence
 * telling the customer to build their site first. Their pages were `app/page.tsx`
 * and `src/pages/index.astro` the whole time.
 *
 * So the assertions are about the three ways a route list goes wrong quietly:
 *
 *  - it lists something that is not a page — an API handler, a layout, a
 *    loading state, `_app`, `app.vue`, a content collection — and somebody edits
 *    a file the router never renders;
 *  - it gets the address wrong, by leaving a `(marketing)` group in it or
 *    dropping a `[slug]` out of it;
 *  - it claims a repository that belongs to another framework, because the
 *    detectors overlap (every SvelteKit project has a `vite.config.ts`).
 *
 * Pure string work: no network, no database, no GitHub.
 */
import assert from "node:assert/strict";
import { astroRoutes, detectFramework, nextRoutes, svelteRoutes, viteReactRoutes, vueRoutes } from "../src/services/website/frameworks.js";

let passed = 0;
const paths = (routes: { path: string }[]) => routes.map((route) => route.path);
const fileFor = (routes: { path: string; filePath: string }[], path: string) => routes.find((route) => route.path === path)?.filePath;

// ── Next, app router ────────────────────────────────────────────────────────
const nextApp = [
  "next.config.mjs",
  "package.json",
  "app/page.tsx",
  "app/layout.tsx",
  "app/loading.tsx",
  "app/not-found.tsx",
  "app/(marketing)/pricing/page.tsx",
  "app/(marketing)/layout.tsx",
  "app/blog/[slug]/page.tsx",
  "app/docs/[...path]/page.tsx",
  "app/api/lead/route.ts",
  "app/@modal/photo/page.tsx",
  "components/Hero.tsx",
  "node_modules/next/app/page.tsx",
];
const appRoutes = nextRoutes(nextApp);
assert.deepEqual(paths(appRoutes), ["/", "/blog/[slug]", "/docs/[...path]", "/photo", "/pricing"]); passed++;
assert.equal(fileFor(appRoutes, "/pricing"), "app/(marketing)/pricing/page.tsx"); passed++;
// The file kept is the route file itself, addressed from the repository root:
// a publish writes to `filePath`, and `pricing/page.tsx` would land nowhere.
assert.ok(appRoutes.every((route) => route.filePath.startsWith("app/"))); passed++;
assert.ok(!appRoutes.some((route) => route.filePath.includes("route.ts") || route.filePath.includes("layout") || route.filePath.includes("loading") || route.filePath.includes("not-found"))); passed++;
assert.ok(!appRoutes.some((route) => route.filePath.startsWith("node_modules"))); passed++;
assert.equal(detectFramework(nextApp)?.sourceKind, "next"); passed++;

// ── Next, pages router ──────────────────────────────────────────────────────
const nextPages = ["next.config.js", "pages/index.tsx", "pages/about.tsx", "pages/blog/[slug].tsx", "pages/api/hook.ts", "pages/_app.tsx", "pages/_document.tsx"];
assert.deepEqual(paths(nextRoutes(nextPages)), ["/", "/about", "/blog/[slug]"]); passed++;
assert.equal(detectFramework(nextPages)?.sourceKind, "next"); passed++;

// ── Astro ───────────────────────────────────────────────────────────────────
const astro = ["astro.config.mjs", "src/pages/index.astro", "src/pages/about.astro", "src/pages/blog/[slug].astro", "src/pages/blog/[...page].astro", "src/pages/notes/first.md", "src/content/posts/hello.md", "src/components/Card.astro"];
const astroList = astroRoutes(astro);
assert.deepEqual(paths(astroList), ["/", "/about", "/blog/[...page]", "/blog/[slug]", "/notes/first"]); passed++;
// A content collection is data the developer renders, not a page of its own.
assert.ok(!astroList.some((route) => route.filePath.includes("src/content/"))); passed++;
assert.ok(!astroList.some((route) => route.filePath.includes("components/"))); passed++;
assert.equal(detectFramework(astro)?.sourceKind, "astro"); passed++;

// ── SvelteKit ───────────────────────────────────────────────────────────────
const svelte = ["svelte.config.js", "vite.config.ts", "src/routes/+page.svelte", "src/routes/+layout.svelte", "src/routes/about/+page.svelte", "src/routes/about/+page.ts", "src/routes/(app)/dash/+page.svelte", "src/routes/blog/[slug]/+page.svelte", "src/routes/api/ping/+server.ts", "src/routes/+error.svelte"];
const svelteList = svelteRoutes(svelte);
assert.deepEqual(paths(svelteList), ["/", "/about", "/blog/[slug]", "/dash"]); passed++;
assert.equal(fileFor(svelteList, "/dash"), "src/routes/(app)/dash/+page.svelte"); passed++;
assert.ok(!svelteList.some((route) => /\+(layout|error|server|page\.ts)/.test(route.filePath))); passed++;
// A SvelteKit project has a Vite config too. The registry's order is what keeps
// it from being listed as a React SPA.
assert.equal(detectFramework(svelte)?.sourceKind, "sveltekit"); passed++;

// ── Nuxt and Vue ────────────────────────────────────────────────────────────
const nuxt = ["nuxt.config.ts", "app.vue", "pages/index.vue", "pages/about.vue", "pages/blog/[slug].vue", "components/Hero.vue"];
const nuxtList = vueRoutes(nuxt);
assert.deepEqual(paths(nuxtList), ["/", "/about", "/blog/[slug]"]); passed++;
assert.ok(!nuxtList.some((route) => route.filePath === "app.vue" || route.filePath.startsWith("components/"))); passed++;
assert.equal(detectFramework(nuxt)?.sourceKind, "nuxt"); passed++;
assert.equal(detectFramework(["vite.config.ts", "src/pages/Home.vue", "package.json"])?.sourceKind, "vue"); passed++;

// ── Vite + React ────────────────────────────────────────────────────────────
const spa = ["vite.config.ts", "index.html", "src/App.tsx", "src/main.tsx"];
// The SPA's routing is code, so it claims one thing only: the shell its text
// lives in. Listing that is what lets somebody edit their homepage at all.
assert.deepEqual(paths(viteReactRoutes(spa)), ["/"]); passed++;
assert.equal(fileFor(viteReactRoutes(spa), "/"), "src/App.tsx"); passed++;
assert.deepEqual(paths(viteReactRoutes(["vite.config.ts", "src/App.tsx", "src/pages/About.tsx", "src/pages/PricingPlans.tsx"])), ["/about", "/pricing-plans"]); passed++;
// `index.html` is present, and a Vite project's `index.html` is a shell, not a
// page — the detector still has to claim this as React rather than leave it to
// the HTML editor, which would offer somebody a file with one empty `<div>`.
assert.equal(detectFramework(spa)?.sourceKind, "vite-react"); passed++;

// ── A plain static site is nobody's framework ───────────────────────────────
assert.equal(detectFramework(["index.html", "about.html", "css/site.css"]), null); passed++;
assert.equal(detectFramework(["public/index.html", "README.md"]), null); passed++;
// A build output is not a project: `.next/` and `dist/` are ignored everywhere.
assert.equal(detectFramework([".next/server/app/page.tsx", "dist/assets/index.js"]), null); passed++;

// ── The listed flag comes from the site's own sitemap ────────────────────────
const listed = nextRoutes(nextApp, new Set(["/", "/pricing"]));
assert.deepEqual(listed.filter((route) => route.listed).map((route) => route.path), ["/", "/pricing"]); passed++;

console.log(`websiteFrameworks: ${passed} route mapping and detection checks passed`);
