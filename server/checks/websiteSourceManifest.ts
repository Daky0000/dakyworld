/**
 * The manifest: every file a page's words actually live in.
 *
 * Checked against a plain object of fixture files rather than a repository,
 * because `buildSourceManifest` is given its reader — that is the whole reason
 * it takes one. What is pinned here is the behaviour a wrong answer would show
 * up as on screen:
 *
 *  - a route file that renders three imported components reaches all three, so
 *    the customer sees their headline instead of an empty field list;
 *  - a layout is found even though nothing imports it, because the header and
 *    footer are the parts of a page people click on first;
 *  - a package import is a boundary and never a file, so no crawl wanders into
 *    `node_modules`;
 *  - `..` cannot climb out of the repository;
 *  - the ceilings hold, and say so rather than truncating silently.
 */
import assert from "node:assert/strict";
import {
  buildSourceManifest,
  containsMarkup,
  importSpecifiers,
  isClientBoundary,
  layoutsFor,
  normalizeRepoPath,
  readAliases,
  resolveSpecifier,
  MANIFEST_VERSION,
} from "../src/services/website/manifest.js";

let passed = 0;

// ── A small but realistic Next App Router project ───────────────────────────
const project: Record<string, string> = {
  "tsconfig.json": '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["src/*"]}}}',
  "src/app/layout.tsx": [
    'import { Header } from "@/components/Header";',
    'import "./globals.css";',
    "export default function RootLayout({ children }: { children: React.ReactNode }) {",
    "  return (<html><body><Header /># {children}</body></html>);",
    "}",
  ].join("\n"),
  "src/app/(marketing)/pricing/page.tsx": [
    'import { Hero } from "@/components/Hero";',
    'import { Plans } from "../../../components/Plans";',
    'import { plans } from "@/data/plans";',
    'import clsx from "clsx";',
    "export default function Pricing() {",
    '  return (<main className={clsx("wrap")}><Hero title="Plans that fit" /><Plans items={plans} /></main>);',
    "}",
  ].join("\n"),
  "src/components/Header.tsx": 'export function Header() { return <header><a href="/">Home</a></header>; }',
  "src/components/Hero.tsx": [
    '"use client";',
    'import { Button } from "./Button";',
    "export function Hero({ title }: { title: string }) {",
    "  return (<section><h1>{title}</h1><Button label=\"Start\" /></section>);",
    "}",
  ].join("\n"),
  "src/components/Plans.tsx": "export function Plans({ items }: { items: unknown[] }) { return <ul>{items.length}</ul>; }",
  "src/components/Button.tsx": 'export function Button({ label }: { label: string }) { return <button>{label}</button>; }',
  "src/data/plans.ts": 'export const plans = [{ title: "Starter", description: "For one site" }];',
  "src/app/globals.css": "body { margin: 0 }",
};

const files = Object.keys(project);
const read = async (path: string) => project[path] ?? null;
const entry = "src/app/(marketing)/pricing/page.tsx";

const manifest = await buildSourceManifest({ entry, files, read, tsconfig: project["tsconfig.json"]! });
const paths = manifest.files.map((file) => file.path);

assert.equal(manifest.version, MANIFEST_VERSION, "the manifest names its own version"); passed++;
assert.equal(manifest.entry, entry, "the route file is the entry"); passed++;
assert.ok(paths.includes("src/components/Hero.tsx"), "an aliased component import is followed"); passed++;
assert.ok(paths.includes("src/components/Plans.tsx"), "a relative component import is followed"); passed++;
assert.ok(paths.includes("src/data/plans.ts"), "a local data file is followed"); passed++;
assert.ok(paths.includes("src/components/Button.tsx"), "a component imported by a component is followed"); passed++;
assert.ok(paths.includes("src/app/layout.tsx"), "the layout is found although nothing imports it"); passed++;
assert.ok(paths.includes("src/components/Header.tsx"), "a component the layout imports is followed"); passed++;
assert.ok(!paths.some((path) => path.includes("clsx")), "a package import is never a file"); passed++;
assert.ok(!paths.includes("src/app/globals.css"), "a stylesheet is not a source file"); passed++;

// ── Roles decide what may be done to a file ─────────────────────────────────
const roleOf = (path: string) => manifest.files.find((file) => file.path === path)?.role;
assert.equal(roleOf(entry), "route", "the entry is the route"); passed++;
assert.equal(roleOf("src/app/layout.tsx"), "layout", "layout.tsx is a layout"); passed++;
assert.equal(roleOf("src/components/Hero.tsx"), "component", "a file with markup is a component"); passed++;
assert.equal(roleOf("src/data/plans.ts"), "content", "a file with no markup is content"); passed++;

// ── Server/client boundaries are recorded, not crossed ──────────────────────
const hero = manifest.files.find((file) => file.path === "src/components/Hero.tsx")!;
assert.equal(hero.clientBoundary, true, 'a "use client" file is marked as one'); passed++;
assert.equal(manifest.files.find((file) => file.path === entry)!.clientBoundary, false, "a server component is not marked as a client one"); passed++;

// ── Identity ────────────────────────────────────────────────────────────────
assert.match(manifest.manifestHash, /^[0-9a-f]{64}$/, "the manifest hashes itself"); passed++;
const again = await buildSourceManifest({ entry, files, read, tsconfig: project["tsconfig.json"]! });
assert.equal(again.manifestHash, manifest.manifestHash, "the same files hash the same twice"); passed++;
const edited: Record<string, string> = { ...project, "src/components/Hero.tsx": project["src/components/Hero.tsx"]!.replace("Start", "Begin") };
const afterEdit = await buildSourceManifest({ entry, files, read: async (path) => edited[path] ?? null, tsconfig: project["tsconfig.json"]! });
assert.notEqual(afterEdit.manifestHash, manifest.manifestHash, "an edit to any file changes the manifest hash"); passed++;
assert.ok(manifest.files.every((file) => /^[0-9a-f]{64}$/.test(file.sourceHash)), "every file carries its own hash"); passed++;
assert.deepEqual(paths, [...paths].sort(), "files come back in a stable order"); passed++;

// ── Boundaries are named, with a reason ─────────────────────────────────────
const missing = await buildSourceManifest({
  entry: "app/page.tsx",
  files: ["app/page.tsx"],
  read: async (path) => (path === "app/page.tsx" ? 'import { Gone } from "./Gone";\nexport default function Page() { return <Gone />; }' : null),
});
const unresolved = missing.boundaries.find((boundary) => boundary.specifier === "./Gone");
assert.ok(unresolved, "an import that resolves to nothing is reported"); passed++;
assert.equal(unresolved!.reason, "unresolved", "and says why"); passed++;
assert.ok(unresolved!.message.includes("./Gone"), "and names the specifier the author wrote"); passed++;

// ── `..` cannot climb out of the repository ─────────────────────────────────
assert.equal(normalizeRepoPath("a/../../b"), null, "a path that climbs above the root is refused"); passed++;
assert.equal(normalizeRepoPath("a/./b/../c"), "a/c", "a path that stays inside is collapsed"); passed++;
const escape = resolveSpecifier("../../../secrets", "app/page.tsx", () => true, []);
assert.ok("reason" in escape && escape.reason === "outside-repository", "an import that climbs out of the repository is a boundary"); passed++;

// ── Resolution rules ────────────────────────────────────────────────────────
const exists = (path: string) => files.includes(path);
const aliases = readAliases(project["tsconfig.json"]!);
assert.deepEqual(aliases, [{ prefix: "@", target: "src" }], "tsconfig paths are read rather than assumed"); passed++;
const aliased = resolveSpecifier("@/components/Hero", entry, exists, aliases);
assert.deepEqual(aliased, { path: "src/components/Hero.tsx" }, "an extensionless alias resolves to its .tsx file"); passed++;
const pkg = resolveSpecifier("react", entry, exists, aliases);
assert.ok("reason" in pkg && pkg.reason === "package", "a bare specifier is a dependency"); passed++;
const indexed = resolveSpecifier("./ui", "src/components/Hero.tsx", (path) => path === "src/components/ui/index.tsx", aliases);
assert.deepEqual(indexed, { path: "src/components/ui/index.tsx" }, "a folder import resolves to its index file"); passed++;
const nodeModules = resolveSpecifier("./node_modules/thing", "app/page.tsx", () => true, []);
assert.ok("reason" in nodeModules && nodeModules.reason === "package", "a relative path into node_modules is still a dependency"); passed++;
assert.deepEqual(readAliases(null), [{ prefix: "@", target: "src" }, { prefix: "~", target: "src" }], "a project with no tsconfig gets the conventional aliases"); passed++;
assert.deepEqual(readAliases("{ not json"), [{ prefix: "@", target: "src" }, { prefix: "~", target: "src" }], "an unreadable tsconfig falls back rather than throwing"); passed++;

// ── Ceilings hold, and say so ───────────────────────────────────────────────
const chain: Record<string, string> = { "app/page.tsx": 'import { A } from "./c0";\nexport default function P() { return <A />; }' };
for (let index = 0; index < 12; index += 1) chain[`app/c${index}.tsx`] = `import { A } from "./c${index + 1}";\nexport function A() { return <A />; }`;
chain["app/c12.tsx"] = "export function A() { return <b>end</b>; }";
const deep = await buildSourceManifest({ entry: "app/page.tsx", files: Object.keys(chain), read: async (path) => chain[path] ?? null, maxDepth: 3 });
assert.ok(deep.truncated, "a graph deeper than the ceiling is reported as truncated"); passed++;
assert.ok(deep.files.every((file) => file.depth <= 3), "and nothing past the ceiling is in the list"); passed++;
assert.ok(deep.boundaries.some((boundary) => boundary.reason === "limit"), "and the boundary says it was a limit"); passed++;
const narrow = await buildSourceManifest({ entry: "app/page.tsx", files: Object.keys(chain), read: async (path) => chain[path] ?? null, maxFiles: 4 });
assert.equal(narrow.files.length, 4, "the file ceiling holds exactly"); passed++;
assert.ok(narrow.truncated, "and is reported"); passed++;

// ── A cycle terminates ──────────────────────────────────────────────────────
const cycle: Record<string, string> = {
  "app/page.tsx": 'import { A } from "./a";\nexport default function P() { return <A />; }',
  "app/a.tsx": 'import { B } from "./b";\nexport function A() { return <B />; }',
  "app/b.tsx": 'import { A } from "./a";\nexport function B() { return <A />; }',
};
const cycled = await buildSourceManifest({ entry: "app/page.tsx", files: Object.keys(cycle), read: async (path) => cycle[path] ?? null });
assert.equal(cycled.files.length, 3, "a circular import graph is walked once and terminates"); passed++;

// ── The parsing helpers, on their own ───────────────────────────────────────
assert.deepEqual(importSpecifiers('import a from "x";\nexport * from "y";', "a.tsx"), ["x", "y"], "imports and re-exports both count"); passed++;
assert.deepEqual(importSpecifiers('const m = await import("z");', "a.tsx"), ["z"], "a literal dynamic import counts"); passed++;
assert.deepEqual(importSpecifiers("const m = await import(name);", "a.tsx"), [], "a computed dynamic import is not a path"); passed++;
assert.equal(containsMarkup("export const a = [{ title: 'x' }];", "a.ts"), false, "a data module has no markup"); passed++;
assert.equal(containsMarkup("export const A = () => <b>x</b>;", "a.tsx"), true, "a component does"); passed++;
assert.equal(containsMarkup("export const A = () => <></>;", "a.tsx"), true, "a fragment is markup too"); passed++;
assert.equal(isClientBoundary('"use client";\nexport const a = 1;', "a.tsx"), true, "the directive is read at the top of the file"); passed++;
assert.equal(isClientBoundary('export const a = 1;\n"use client";', "a.tsx"), false, "and not after code, where the compiler ignores it too"); passed++;
assert.equal(isClientBoundary('"use strict";\n"use client";\nexport const a = 1;', "a.tsx"), true, "a second directive still counts"); passed++;

// ── Layout discovery, on its own ────────────────────────────────────────────
const appFiles = ["src/app/layout.tsx", "src/app/blog/layout.tsx", "src/app/blog/post/page.tsx"];
assert.deepEqual(
  layoutsFor("src/app/blog/post/page.tsx", (path) => appFiles.includes(path)),
  ["src/app/blog/layout.tsx", "src/app/layout.tsx"],
  "every layout from the route up to the app root is found, nearest first",
); passed++;
const pagesFiles = ["pages/_app.tsx", "pages/pricing.tsx"];
assert.deepEqual(layoutsFor("pages/pricing.tsx", (path) => pagesFiles.includes(path)), ["pages/_app.tsx"], "the Pages router wrapper is found too"); passed++;
assert.deepEqual(layoutsFor("app/page.tsx", () => false), [], "a project with no layout gets an empty list rather than a guess"); passed++;

console.log(`websiteSourceManifest: ${passed} source manifest checks passed`);
