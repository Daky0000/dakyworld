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
 * Both shapes in circulation are read:
 *
 *  - `<Routes>` / `<Route>` elements (react-router v6 and v7, and the same JSX
 *    shape used by most AI builders);
 *  - `createBrowserRouter([{ path, element, children }])` objects.
 */
import ts from "typescript";
import type { DiscoveredRoute } from "./frameworks.js";

const MAX_ROUTES = 500;
const EXTENSIONS = [".tsx", ".ts", ".jsx", ".js"] as const;

/** The files worth reading to find a route table, most likely first. */
export function routerCandidates(files: readonly string[]): string[] {
  const wanted = /(^|\/)(src\/)?(App|app|main|index|router|routes|Router|Routes)\.(tsx|jsx|ts|js)$/;
  return files
    .filter((file) => wanted.test(file) && !/(^|\/)(node_modules|dist|build|\.next)(\/|$)/i.test(file))
    // `App.tsx` before `main.tsx` before the rest: the table is in the first of
    // those far more often than not, and reading three files is a budget.
    .sort((a, b) => score(b) - score(a) || a.length - b.length)
    .slice(0, 3);
}

function score(file: string): number {
  const name = file.split("/").at(-1)!.toLowerCase();
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
  if (component && !/^(App|Layout|Root|Index|Page)$/i.test(component)) {
    return component.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[-_]+/g, " ");
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
  const found: Array<{ path: string; component: string | null }> = [];
  let file: ts.SourceFile;
  try {
    file = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, /\.tsx?$/i.test(filePath) ? ts.ScriptKind.TSX : ts.ScriptKind.JSX);
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
  function readRouteObject(node: ts.ObjectLiteralExpression, parent: string): void {
    if (found.length >= MAX_ROUTES) return;
    let path: string | null = null;
    let index = false;
    let component: string | null = null;
    let children: ts.ArrayLiteralExpression | null = null;
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property) || !property.name) continue;
      const name = property.name.getText(file).replace(/['"]/g, "");
      if (name === "path" && ts.isStringLiteral(property.initializer)) path = property.initializer.text;
      if (name === "index" && property.initializer.kind === ts.SyntaxKind.TrueKeyword) index = true;
      if (name === "element" || name === "Component" || name === "component" || name === "lazy") component = componentName(property.initializer);
      if (name === "children" && ts.isArrayLiteralExpression(property.initializer)) children = property.initializer;
    }
    const own = index ? parent : path === null ? null : joinPaths(parent, path);
    if (own !== null && path !== "*") found.push({ path: own, component });
    if (children) for (const entry of children.elements) if (ts.isObjectLiteralExpression(entry)) readRouteObject(entry, own ?? parent);
  }

  const objectRouters = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(file);
      if (/create(Browser|Hash|Memory)Router|createRoutesFromElements|useRoutes/.test(callee)) {
        for (const argument of node.arguments) {
          if (ts.isArrayLiteralExpression(argument)) for (const entry of argument.elements) if (ts.isObjectLiteralExpression(entry)) readRouteObject(entry, "/");
          else walkJsx(argument, "/");
        }
      }
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
    const specifier = entry.component ? imports.get(entry.component) ?? null : null;
    const resolved = specifier ? resolveImport(specifier, filePath, repoFiles) : null;
    byPath.set(path, {
      // Where the words are, when we can say. Otherwise the router file, which
      // is where a route with an inline element genuinely keeps them.
      filePath: resolved ?? filePath,
      path,
      title: titleFor(path, entry.component),
      listed: listed.has(path),
    });
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}
