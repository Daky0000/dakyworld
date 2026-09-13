/**
 * Reading the pages a single-page app declares in code.
 *
 * This is the shape customers arrive with from Lovable, Bolt, v0 and Replit: a
 * Vite + React project whose file tree has one page in it — `src/App.tsx` — and
 * whose actual nine pages are a `<Route>` table inside that file. Listing one
 * row for such a site is the difference between the builder being usable on an
 * AI-built website and not.
 *
 * The assertions are about the ways a route table gets read wrongly:
 *
 *  - an address that does not exist — a `*` catch-all listed as a page, a
 *    nested child's path not joined to its parent's, a path built from a
 *    variable guessed at;
 *  - the wrong file behind a right address, which sends somebody to edit a file
 *    that has none of the words they are looking at;
 *  - a file that is not in the repository at all, because an import was
 *    resolved by string arithmetic and never checked against the file list.
 *
 * Pure parsing: no network, no database, nothing executed.
 */
import assert from "node:assert/strict";
import { discoverRouterRoutes, routerCandidates } from "../src/services/website/router.js";

let passed = 0;

// The file Lovable and Bolt actually emit, down to the shadcn `@/` alias and the
// catch-all NotFound at the bottom.
const lovable = `
import { Toaster } from "@/components/ui/toaster";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import Index from "./pages/Index";
import About from "./pages/About";
import Pricing from "@/pages/Pricing";
import NotFound from "./pages/NotFound";

const App = () => (
  <QueryClientProvider client={queryClient}>
    <Toaster />
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Index />} />
        <Route path="/about" element={<About />} />
        <Route path="/pricing" element={<Pricing />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </BrowserRouter>
  </QueryClientProvider>
);

export default App;
`;
const lovableFiles = ["vite.config.ts", "index.html", "src/App.tsx", "src/main.tsx", "src/pages/Index.tsx", "src/pages/About.tsx", "src/pages/Pricing.tsx", "src/pages/NotFound.tsx"];
const routes = discoverRouterRoutes(lovable, "src/App.tsx", lovableFiles);
assert.deepEqual(routes.map((route) => route.path), ["/", "/about", "/pricing"]); passed++;
// Each address points at the file its words are in, not at the router.
assert.deepEqual(routes.map((route) => route.filePath), ["src/pages/Index.tsx", "src/pages/About.tsx", "src/pages/Pricing.tsx"]); passed++;
// `@/pages/Pricing` resolves through the alias every shadcn project ships with.
assert.equal(routes.find((route) => route.path === "/pricing")?.filePath, "src/pages/Pricing.tsx"); passed++;
// `*` is the 404, not a page anybody can be sent to.
assert.ok(!routes.some((route) => route.path.includes("*") || route.filePath.includes("NotFound"))); passed++;
assert.equal(routes.find((route) => route.path === "/about")?.title, "About"); passed++;

// ── Nested routes under a layout ────────────────────────────────────────────
const nested = `
import Layout from "./Layout";
import Dashboard from "./pages/Dashboard";
import Settings from "./pages/Settings";
export default function App() {
  return <Routes>
    <Route path="/app" element={<Layout />}>
      <Route index element={<Dashboard />} />
      <Route path="settings" element={<Settings />} />
      <Route path="/billing" element={<Billing />} />
    </Route>
  </Routes>;
}
`;
const nestedRoutes = discoverRouterRoutes(nested, "src/App.tsx", ["src/App.tsx", "src/Layout.tsx", "src/pages/Dashboard.tsx", "src/pages/Settings.tsx"]);
// A child's path is joined to its parent's; a child whose path starts with "/"
// is absolute and replaces it, which is what react-router does.
assert.deepEqual(nestedRoutes.map((route) => route.path), ["/app", "/app/settings", "/billing"]); passed++;
// `index` is the parent's own address, so it does not invent `/app/index`.
assert.ok(!nestedRoutes.some((route) => route.path.endsWith("/index"))); passed++;
// A component with no import in this file still gets a route — its words are in
// the router file until somebody says otherwise, and that is where we send them.
assert.equal(nestedRoutes.find((route) => route.path === "/billing")?.filePath, "src/App.tsx"); passed++;

// ── Lazy imports, which is how a code-split export names its pages ──────────
const lazy = `
const Careers = lazy(() => import("./pages/Careers"));
const Contact = React.lazy(() => import("@/pages/Contact"));
export default () => <Routes>
  <Route path="/careers" element={<Careers />} />
  <Route path="/contact" element={<Contact />} />
</Routes>;
`;
const lazyRoutes = discoverRouterRoutes(lazy, "src/App.tsx", ["src/App.tsx", "src/pages/Careers.tsx", "src/pages/Contact.tsx"]);
assert.deepEqual(lazyRoutes.map((route) => route.filePath), ["src/pages/Careers.tsx", "src/pages/Contact.tsx"]); passed++;

// ── createBrowserRouter, the other shape in circulation ─────────────────────
const objectRouter = `
import Home from "./routes/Home";
import Post from "./routes/Post";
const router = createBrowserRouter([
  { path: "/", element: <Home />, children: [
    { path: "posts/:id", element: <Post /> },
  ] },
  { path: "*", element: <NotFound /> },
]);
`;
const objectRoutes = discoverRouterRoutes(objectRouter, "src/main.tsx", ["src/main.tsx", "src/routes/Home.tsx", "src/routes/Post.tsx"]);
assert.deepEqual(objectRoutes.map((route) => route.path), ["/", "/posts/:id"]); passed++;
assert.equal(objectRoutes.find((route) => route.path === "/posts/:id")?.filePath, "src/routes/Post.tsx"); passed++;

// ── What it refuses to claim ────────────────────────────────────────────────
const computed = `
export default () => <Routes>
  {links.map(link => <Route key={link.path} path={link.path} element={<Page />} />)}
  <Route path={"/" + slug} element={<Slug />} />
  <Route path="/real" element={<Real />} />
</Routes>;
`;
const computedRoutes = discoverRouterRoutes(computed, "src/App.tsx", ["src/App.tsx", "src/Real.tsx"]);
// A path decided at run time is not an address, and listing a guess at it would
// be a page list that lies.
assert.deepEqual(computedRoutes.map((route) => route.path), ["/real"]); passed++;

// An import that resolves to nothing in the repository keeps the router file
// rather than pointing at a path that does not exist.
const missing = discoverRouterRoutes(`import Gone from "./pages/Gone";\nexport default () => <Route path="/gone" element={<Gone />} />;`, "src/App.tsx", ["src/App.tsx"]);
assert.equal(missing[0]?.filePath, "src/App.tsx"); passed++;
// A package import is never a repository file either.
const external = discoverRouterRoutes(`import Docs from "some-docs-package";\nexport default () => <Route path="/docs" element={<Docs />} />;`, "src/App.tsx", ["src/App.tsx"]);
assert.equal(external[0]?.filePath, "src/App.tsx"); passed++;
// A file that is not a router at all yields nothing, rather than an error.
assert.deepEqual(discoverRouterRoutes("export const add = (a: number, b: number) => a + b;", "src/util.ts", ["src/util.ts"]), []); passed++;
// Broken source is a file with no routes in it, not a crash in the scan.
assert.deepEqual(discoverRouterRoutes("export default () => <Route path=", "src/App.tsx", ["src/App.tsx"]).length, 0); passed++;

// ── Which files are worth reading ───────────────────────────────────────────
const candidates = routerCandidates(["src/App.tsx", "src/main.tsx", "src/router.tsx", "src/components/Hero.tsx", "node_modules/x/App.tsx", "dist/App.js"]);
assert.equal(candidates[0], "src/App.tsx"); passed++;
assert.ok(candidates.length <= 3); passed++;
assert.ok(!candidates.some((file) => file.includes("node_modules") || file.startsWith("dist/"))); passed++;
assert.ok(!candidates.includes("src/components/Hero.tsx")); passed++;

console.log(`websiteRouterTable: ${passed} code-declared route checks passed`);
