/**
 * Which website routes a plan has to include, and that every one of them is
 * actually asked.
 *
 * The plan gate used to be a middleware registered part-way down
 * routes/website.ts, so it saw only the routes registered after it — ten
 * register calls sat above it, and whether a new route was covered depended on
 * which line its register call happened to land on. The gate now runs ahead of
 * every route and reads one table, `websiteTierFeature`. This walks the real
 * router to hold both halves: the gate comes before the first route, and every
 * route with an SEO, assistant, agent or source segment maps to its feature —
 * with nothing else gated by accident.
 *
 * No database, no network.
 *   npx tsx checks/websiteTierFeatures.ts
 */
import assert from "node:assert/strict";

process.env.DEV_NO_AUTH = "false";
const { websiteRouter } = await import("../src/routes/website.js");
const { websiteTierFeature } = await import("../src/services/websiteTierPlans.js");

let passed = 0;
const failures: string[] = [];
function check(name: string, test: () => void) {
  try { test(); passed += 1; console.log(`  ok  ${name}`); }
  catch (error) { failures.push(name); console.log(`FAIL  ${name}\n      ${(error as Error).message.split("\n")[0]}`); }
}

console.log("\nThe table");
const matrix: Array<[string, ReturnType<typeof websiteTierFeature>]> = [
  ["/pages/p1/seo", "seoInspector"],
  ["/sites/s1/seo/audit", "seoInspector"],
  ["/pages/p1/assistant", "aiAssistant"],
  ["/pages/p1/suggest", "aiAssistant"],
  ["/sites/s1/ai/brief", "aiAssistant"],
  ["/sites/s1/agent/plan", "aiBuilderAgent"],
  ["/pages/p1/agent/apply", "aiBuilderAgent"],
  ["/sites/s1/source/files", "sourceCodeEditor"],
  ["/sites/s1/source-project", "sourceCodeEditor"],
  // Everything a plan does not sell stays open, and a prefix is not a segment.
  ["/sites/s1/global-content", null],
  ["/pages/p1/schedule", null],
  ["/pages/p1/review-links", null],
  ["/sites/s1/hosting", null],
  ["/sites/s1/ai-settings", null],
  ["/sites/s1/seoul-branch", null],
  ["/sites/s1/agents-note", null],
];
for (const [path, feature] of matrix) {
  check(`${path} needs ${feature ?? "no plan feature"}`, () => assert.equal(websiteTierFeature(path), feature));
}

console.log("\nThe real router");
type Layer = { route?: { path: string; methods: Record<string, boolean> }; handle: (...args: unknown[]) => unknown };
const stack = (websiteRouter as unknown as { stack: Layer[] }).stack;
const gateAt = stack.findIndex((layer) => !layer.route && String(layer.handle).includes("websiteTierFeature("));
const firstRoute = stack.findIndex((layer) => Boolean(layer.route));
check("the plan gate is registered", () => assert.ok(gateAt >= 0, "no middleware calls websiteTierFeature"));
check("and it runs before the first route", () => assert.ok(gateAt < firstRoute, `gate at layer ${gateAt}, first route at ${firstRoute}`));

/** What a route's segments say it is, read independently of the table's regexes. */
function expectedFeature(path: string): ReturnType<typeof websiteTierFeature> {
  const segments = path.split("/").filter(Boolean);
  if (segments.some((s) => s === "source" || s === "source-project")) return "sourceCodeEditor";
  if (segments.includes("agent")) return "aiBuilderAgent";
  if (segments.some((s) => s === "assistant" || s === "suggest" || s === "ai")) return "aiAssistant";
  if (segments.includes("seo")) return "seoInspector";
  return null;
}

const mismatched: string[] = [];
let gated = 0;
let routes = 0;
for (const layer of stack) {
  if (!layer.route) continue;
  routes += 1;
  const path = layer.route.path.replace(/:[A-Za-z]+/g, "sample");
  const actual = websiteTierFeature(path);
  if (actual) gated += 1;
  if (actual !== expectedFeature(path)) mismatched.push(`${Object.keys(layer.route.methods).join(",").toUpperCase()} ${layer.route.path}: table says ${actual}, segments say ${expectedFeature(path)}`);
}
check(`the router was walked (${routes} routes)`, () => assert.ok(routes > 100));
check(`some routes are plan features (${gated})`, () => assert.ok(gated > 5));
check("every route's plan feature matches what its path says it is", () => assert.deepEqual(mismatched, []));

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
