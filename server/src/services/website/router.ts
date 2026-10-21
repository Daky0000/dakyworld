/**
 * Pages that are declared in code rather than in folders.
 *
 * Every framework in `frameworks.ts` answers "which files are pages?" by
 * looking at paths. The sites people arrive with from Lovable, Bolt, v0 and
 * Replit do not work that way: they are Vite + React single-page apps whose
 * routes are a table inside `App.tsx`.
 *
 *     <Route path="/pricing" element={<Pricing />} />
 *
 * Reading only the file list, such a site has exactly one page — the app shell —
 * and a customer connecting the site an AI built them sees one row where their
 * website has nine. So this reads that one file and takes the table out of it.
 *
 * It parses; it never executes, imports or bundles anything. What it cannot see
 * statically it does not guess at: a path built from a variable, a route array
 * assembled at run time, a component behind an alias nothing in the repository
 * resolves to. Those are left out rather than listed at an address that may not
 * exist, because a page list is a promise that the address is real.
 *
 * The shapes in circulation are read:
 *
 *  - `<Routes>` / `<Route>` elements (react-router v6 and v7, and the same JSX
 *    shape used by most AI builders);
 *  - `createBrowserRouter([{ path, element, children }])` objects;
 *  - Vue Router's `createRouter({ routes: [{ path, component }] })`, with the
 *    table inline or in a `const routes` beside it;
 *  - Angular's `Routes` — `export const routes: Routes = [...]`,
 *    `RouterModule.forRoot([...])`, `provideRouter(routes)` — where a page's
 *    words live in the `.html` template beside its component, which is the
 *    file the route is given.
 *
 * A component loaded lazily (`lazy`, `loadComponent`, `() => import(…)`) is
 * followed to the file it imports. A redirect is not a page.
 */
import ts from "typescript";
import type { DiscoveredRoute } from "./frameworks.js";

const MAX_ROUTES = 500;
const EXTENSIONS = [".tsx", ".ts", ".jsx", ".js"] as const;

/** The files worth reading to find a route table, most likely first. */
export function routerCandidates(files: readonly string[]): string[] {
  // `app.routes.ts` and `app-routing.module.ts` are Angular's; a `router/` or
  // `routes/` folder's index is where Vue Router's table usually sits.
  const wanted = /(^|\/)(src\/)?(App|app|main|index|router|routes|Router|Routes)\.(tsx|jsx|ts|js)$|(^|\/)app(?:\.routes|-routing\.module|\.routing)\.(ts|js)$|(^|\/)(?:router|routes)\/index\.(ts|js)$/;
  return files
    .filter((file) => wanted.test(file) && !/(^|\/)(node_modules|dist|build|\.next)(\/|$)/i.test(file))
    // `App.tsx` before `main.tsx` before the rest: the table is in the first of
    // those far more often than not, and reading three files is a budget.
    .sort((a, b) => score(b) - score(a) || a.length - b.length)
    .slice(0, 3);
}

function score(file: string): number {
  const name = file.split("/").at(-1)!.toLowerCase();
  if (/^app(?:\.routes|-routing\.module|\.routing)\./.test(name)) return 5;
  if (/(^|\/)(?:router|routes)\/index\.[jt]s$/i.test(file)) return 3;
  if (name.startsWith("app.")) return 4;
  if (name.startsWith("router.") || name.startsWith("routes.")) return 3;
  if (name.startsWith("main.")) return 2;
  return 1;
}

/**
 * Resolves an import specifier to a file that is actually in the repository.
 *
 * Relative specifiers are resolved against the importing file; `@/…` is the
 * alias every shadcn-based project ships with, and it means `src/`. A specifier
 * that resolves to nothing — a package, an alias we do not know — resolves to
 * null, and its route keeps the router file as its own file instead. That is
 * the honest answer: the route exists, and the file holding its words is not
 * something we can name.
 */
function resolveImport(specifier: string, fromFile: string, files: ReadonlySet<string>): string | null {
  const directory = fromFile.split("/").slice(0, -1).join("/");
  let base: string;
  if (specifier.startsWith(".")) {
    const parts = [...directory.split("/").filter(Boolean), ...specifier.split("/")];
    const stack: string[] = [];
    for (const part of parts) {
      if (part === "." || part === "") continue;
      if (part === "..") { stack.pop(); continue; }
      stack.push(part);
    }
    base = stack.join("/");
  } else if (specifier.startsWith("@/") || specifier.startsWith("~/")) {
    // The alias points at the project's source root, which is `src/` in every
    // AI builder's output — but only if this repository actually has one.
    const root = [...files].some((file) => file.startsWith("src/")) ? "src/" : "";
    base = `${root}${specifier.slice(2)}`;
  } else return null;

  for (const extension of EXTENSIONS) {
    if (files.has(`${base}${extension}`)) return `${base}${extension}`;
  }
  for (const extension of EXTENSIONS) {
    if (files.has(`${base}/index${extension}`)) return `${base}/index${extension}`;
  }
  return files.has(base) ? base : null;
}

function joinPaths(parent: string, child: string): string {
  if (child.startsWith("/")) return child;
  const joined = `${parent === "/" ? "" : parent}/${child}`.replace(/\/+/g, "/");
  return joined === "" ? "/" : joined;
}

function titleFor(route: string, component: string | null): string {
  // `AboutComponent` and `AboutView` are both "About": the suffix is each
  // framework's naming convention, not part of the page's name.
  const named = component?.replace(/^(.+?)(?:Component|View|Page)$/, "$1") ?? null;
  if (named && !/^(App|Layout|Root|Index|Page)$/i.test(named)) {
    return named.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[-_]+/g, " ");
  }
  if (route === "/") return "Home";
  const last = route.split("/").filter(Boolean).at(-1) ?? route;
  return last.replace(/[-_]+/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

/**
 * The routes a router file declares, with each one's component file where the
 * repository has it.
 *
 * `files` is the repository's file list, used only to resolve an import to a
 * path that exists. Nothing is read from it.
 */
export function discoverRouterRoutes(source: string, filePath: string, files: readonly string[], listed: Set<string> = new Set()): DiscoveredRoute[] {
  const repoFiles = new Set(files);
  /** `specifier` is a lazily imported module named in the route itself; `title` is one the route declares. */
  const found: Array<{ path: string; component: string | null; specifier?: string | null; title?: string }> = [];
  let file: ts.SourceFile;
  try {
    // A `.ts` file is read as TypeScript, not TSX: Angular and Vue route files
    // are `.ts`, and as TSX an `<Routes>[…]` assertion reads as an element.
    const kind = /\.tsx$/i.test(filePath) ? ts.ScriptKind.TSX : /\.[mc]?ts$/i.test(filePath) ? ts.ScriptKind.TS : ts.ScriptKind.JSX;
    file = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, kind);
  } catch { return []; }

  // ── Which local name came from which module ─────────────────────────────
  const imports = new Map<string, string>();
  const collectImports = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      const clause = node.importClause;
      if (clause?.name) imports.set(clause.name.text, specifier);
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) imports.set(element.name.text, specifier);
      }
    }
    // `const About = lazy(() => import("./pages/About"))`, which is how every
    // code-split AI export names its pages.
    if (ts.isVariableDeclaration(node) && node.name && ts.isIdentifier(node.name) && node.initializer) {
      const dynamic = findDynamicImport(node.initializer);
      if (dynamic) imports.set(node.name.text, dynamic);
    }
    ts.forEachChild(node, collectImports);
  };
  collectImports(file);

  function findDynamicImport(node: ts.Node): string | null {
    let specifier: string | null = null;
    const visit = (candidate: ts.Node): void => {
      if (specifier) return;
      if (ts.isCallExpression(candidate) && candidate.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const argument = candidate.arguments[0];
        if (argument && ts.isStringLiteral(argument)) specifier = argument.text;
        return;
      }
      ts.forEachChild(candidate, visit);
    };
    visit(node);
    return specifier;
  }

  function componentName(node: ts.Node | undefined): string | null {
    if (!node) return null;
    if (ts.isJsxExpression(node) && node.expression) return componentName(node.expression);
    if (ts.isJsxElement(node)) return node.openingElement.tagName.getText(file);
    if (ts.isJsxSelfClosingElement(node)) return node.tagName.getText(file);
    if (ts.isIdentifier(node)) return node.text;
    if (ts.isPropertyAccessExpression(node)) return node.name.text;
    return null;
  }

  // ── `<Route path="…" element={<X />}>` ──────────────────────────────────
  function readRouteElement(node: ts.JsxElement | ts.JsxSelfClosingElement, parent: string): void {
    if (found.length >= MAX_ROUTES) return;
    const opening = ts.isJsxElement(node) ? node.openingElement : node;
    const tag = opening.tagName.getText(file);
    if (!/(^|\.)Route$/.test(tag)) {
      // Not a Route, but its children may be — `<Routes>`, a layout wrapper, a
      // fragment, whatever the exporter wrapped the table in.
      if (ts.isJsxElement(node)) for (const child of node.children) walkJsx(child, parent);
      return;
    }
    let path: string | null = null;
    let index = false;
    let component: string | null = null;
    for (const attribute of opening.attributes.properties) {
      if (!ts.isJsxAttribute(attribute)) continue;
      const name = attribute.name.getText(file);
      const value = attribute.initializer;
      if (name === "path") {
        if (value && ts.isStringLiteral(value)) path = value.text;
        else if (value && ts.isJsxExpression(value) && value.expression && ts.isStringLiteral(value.expression)) path = value.expression.text;
        else path = null;
      }
      if (name === "index") index = true;
      if (name === "element" || name === "Component" || name === "component") component = componentName(value);
    }
    const own = index ? parent : path === null ? null : joinPaths(parent, path);
    // A route whose path is computed is not an address anybody can be sent to.
    // Its children are still worth walking: they often are literal.
    if (own !== null && path !== "*" && !index) found.push({ path: own, component });
    else if (index) found.push({ path: parent, component });
    const next = own ?? parent;
    if (ts.isJsxElement(node)) for (const child of node.children) walkJsx(child, next);
  }

  function walkJsx(node: ts.Node, parent: string): void {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) { readRouteElement(node, parent); return; }
    ts.forEachChild(node, (child) => walkJsx(child, parent));
  }

  // ── `createBrowserRouter([{ path, element, children }])` ────────────────
  // The same object shape is Vue Router's and Angular's, which add a lazy
  // `component: () => import(…)` / `loadComponent`, a `redirectTo` that is
  // not a page, and (Angular) a `title`.
  function readRouteObject(node: ts.ObjectLiteralExpression, parent: string): void {
    if (found.length >= MAX_ROUTES) return;
    let path: string | null = null;
    let index = false;
    let component: string | null = null;
    let specifier: string | null = null;
    let title: string | undefined;
    let redirect = false;
    let children: ts.ArrayLiteralExpression | null = null;
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property) || !property.name) continue;
      const name = property.name.getText(file).replace(/['"]/g, "");
      if (name === "path" && ts.isStringLiteralLike(property.initializer)) path = property.initializer.text;
      if (name === "index" && property.initializer.kind === ts.SyntaxKind.TrueKeyword) index = true;
      if (name === "element" || name === "Component" || name === "component" || name === "lazy" || name === "loadComponent") {
        component = componentName(property.initializer);
        specifier = findDynamicImport(property.initializer) ?? specifier;
      }
      if (name === "title" && ts.isStringLiteralLike(property.initializer)) title = property.initializer.text;
      if (name === "redirectTo" || name === "redirect") redirect = true;
      if (name === "children" && ts.isArrayLiteralExpression(property.initializer)) children = property.initializer;
    }
    const own = index ? parent : path === null ? null : joinPaths(parent, path);
    if (own !== null && path !== "*" && path !== "**" && !redirect) found.push({ path: own, component, specifier, title });
    if (children) for (const entry of children.elements) if (ts.isObjectLiteralExpression(entry)) readRouteObject(entry, own ?? parent);
  }

  // A table written as a `const` and handed over by name — `const routes =
  // […]` then `createRouter({ routes })` or `provideRouter(routes)`.
  const declared = new Map<string, ts.Expression>();
  const collectDeclared = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) declared.set(node.name.text, node.initializer);
    ts.forEachChild(node, collectDeclared);
  };
  collectDeclared(file);
  const read = new Set<ts.Node>();
  const readTable = (expression: ts.Expression | undefined, depth = 0): void => {
    if (!expression || depth > 3) return;
    let table = expression;
    while (ts.isAsExpression(table) || ts.isSatisfiesExpression(table) || ts.isParenthesizedExpression(table) || ts.isTypeAssertionExpression(table)) table = table.expression;
    if (ts.isIdentifier(table)) return readTable(declared.get(table.text), depth + 1);
    if (!ts.isArrayLiteralExpression(table) || read.has(table)) return;
    read.add(table);
    for (const entry of table.elements) if (ts.isObjectLiteralExpression(entry)) readRouteObject(entry, "/");
  };

  const objectRouters = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(file);
      if (/create(Browser|Hash|Memory)Router|createRoutesFromElements|useRoutes/.test(callee)) {
        for (const argument of node.arguments) {
          // Inline, or a `const routes = […]` handed over by name.
          if (ts.isArrayLiteralExpression(argument) || ts.isIdentifier(argument)) readTable(argument);
          else walkJsx(argument, "/");
        }
      } else if (/(^|\.)createRouter$/.test(callee)) {
        // Vue Router: `createRouter({ history, routes })`.
        const options = node.arguments[0];
        if (options && ts.isObjectLiteralExpression(options)) {
          for (const property of options.properties) {
            if (ts.isPropertyAssignment(property) && property.name.getText(file) === "routes") readTable(property.initializer);
            else if (ts.isShorthandPropertyAssignment(property) && property.name.text === "routes") readTable(property.name);
          }
        }
      } else if (/(^|\.)(forRoot|forChild|provideRouter)$/.test(callee)) {
        // Angular: `RouterModule.forRoot(routes)`, `provideRouter(routes)`.
        readTable(node.arguments[0]);
      }
    }
    // Angular's `export const routes: Routes = […]`, which is often all the
    // file holds: the call that uses it sits in `app.config.ts`.
    if (ts.isVariableDeclaration(node) && node.initializer && node.type && /^(?:Routes|Route\[\]|RouteRecordRaw\[\]|Array<(?:Route|RouteRecordRaw)>)$/.test(node.type.getText(file).replace(/\s+/g, ""))) {
      readTable(node.initializer);
    }
    ts.forEachChild(node, objectRouters);
  };

  try {
    walkJsx(file, "/");
    objectRouters(file);
  } catch { return []; }

  // ── One route per address, with its own file where we can name it ───────
  const byPath = new Map<string, DiscoveredRoute>();
  for (const entry of found) {
    const path = entry.path === "" ? "/" : entry.path.replace(/\/+$/, "") || "/";
    // A route is only as good as its address: a wildcard, a splat and a path
    // with an expression left in it are all addresses nobody can visit.
    if (path.includes("*") || path.includes("${") || byPath.has(path)) continue;
    const specifier = entry.specifier ?? (entry.component ? imports.get(entry.component) ?? null : null);
    let resolved = specifier ? resolveImport(specifier, filePath, repoFiles) : null;
    // An Angular component keeps its words in the template beside it.
    if (resolved && /\.ts$/.test(resolved) && repoFiles.has(resolved.replace(/\.ts$/, ".html"))) resolved = resolved.replace(/\.ts$/, ".html");
    byPath.set(path, {
      // Where the words are, when we can say. Otherwise the router file, which
      // is where a route with an inline element genuinely keeps them.
      filePath: resolved ?? filePath,
      path,
      title: entry.title ?? titleFor(path, entry.component),
      listed: listed.has(path),
    });
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}
