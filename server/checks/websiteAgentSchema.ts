/**
 * The Website Builder agent's model schema, and the two refusals a person
 * reads when publishing or asking the agent fails. No database, no network.
 *
 * The agent's schema used to be generated with zodToJsonSchema's "openAi"
 * target, which renders `.optional()` as `anyOf [{ not: { $ref: … } }]` over a
 * recursive definition. Structured outputs compile a schema and refuse what
 * they cannot compile, and the planner's catch filed each refusal as a report
 * "to the business owner". These assertions keep the hand-written schema in
 * the subset every vendor here compiles.
 */
import assert from "node:assert/strict";
import { AI_PLAN_JSON_SCHEMA, isExplicitEscalationRequest, planFromModel } from "../src/services/websiteBuilderAgent.js";
import { githubFailure } from "../src/services/website/site.js";
import { GitHubError } from "../src/lib/github.js";

// ---------------------------------------------------------------- the schema
const REFUSED = new Set(["not", "$ref", "definitions", "$defs", "default", "$schema", "anyOf", "oneOf", "allOf"]);
function walk(node: unknown, path: string) {
  if (!node || typeof node !== "object") return;
  const schema = node as Record<string, unknown>;
  for (const key of Object.keys(schema)) assert.ok(!REFUSED.has(key), `${path} uses "${key}", which a structured-output compiler can refuse`);
  if (schema.type === "object") {
    assert.equal(schema.additionalProperties, false, `${path} must be closed`);
    const properties = Object.keys((schema.properties ?? {}) as object).sort();
    assert.deepEqual([...((schema.required ?? []) as string[])].sort(), properties, `${path} must require every property`);
    for (const [name, child] of Object.entries((schema.properties ?? {}) as Record<string, unknown>)) walk(child, `${path}.${name}`);
  }
  assert.ok(!Array.isArray(schema.type), `${path} has a type list; use an empty value for "nothing"`);
  if (schema.items) walk(schema.items, `${path}[]`);
}
walk(AI_PLAN_JSON_SCHEMA, "plan");

// ------------------------------------------------- reading the model's answer
const empty = planFromModel({
  explanation: "Done.",
  intent: "page_edits",
  editorCommand: "none",
  escalationReason: "",
  escalationCategory: "none",
  parsedOperation: { from: "", to: "", property: "" },
  structuralActions: [],
  pages: [{ pageId: "p1", changes: [{ fieldId: "f1", operation: "set_style", property: "font-size", value: "20px" }, { fieldId: "f2", operation: "replace_text", property: "", value: "Hi" }] }],
});
assert.equal(empty.editorCommand, null, '"none" is no command');
assert.equal(empty.escalationCategory, undefined);
assert.equal(empty.escalationReason, undefined);
assert.equal(empty.parsedOperation?.to, "", "an empty target is falsy, so no site-wide change runs");
assert.equal(empty.pages[0].changes[0].property, "font-size");
assert.equal(empty.pages[0].changes[1].property, null, "an empty property is no property");

const sloppy = planFromModel({ explanation: 3, intent: "nonsense", pages: [{ pageId: "p", changes: [{ fieldId: "x", operation: "run_script", value: "x" }, null] }], structuralActions: [{ kind: "explode", fieldId: "a" }] });
assert.equal(sloppy.explanation, "");
assert.equal(sloppy.intent, "page_edits", "an unknown intent is treated as ordinary edits");
assert.equal(sloppy.pages[0].changes.length, 0, "an operation outside the list is dropped");
assert.equal(sloppy.structuralActions.length, 0);
assert.equal(planFromModel(null).pages.length, 0, "no answer is no changes, not a crash");

// ---------------------------------------------------------- asking for help
for (const phrase of ["I need a developer", "Request developer help", "can a developer help with this", "let us help", "hand off to a developer", "talk to a human"]) {
  assert.equal(isExplicitEscalationRequest(phrase), true, `"${phrase}" asks for a developer`);
}
assert.equal(isExplicitEscalationRequest("change button text to Submit"), false);
assert.equal(isExplicitEscalationRequest("make the heading bold"), false);

// ------------------------------------------------------ publishing refusals
const tokenRefusal = new GitHubError(403, "Resource not accessible by personal access token");
tokenRefusal.via = "token";
const tokenMessage = (githubFailure(tokenRefusal, "Daky0000/dakyworld", "main") as Error).message;
assert.match(tokenMessage, /saved under Settings → Developer/);
assert.match(tokenMessage, /GitHub said: "Resource not accessible by personal access token"/, "GitHub's own reason is passed on");
assert.match(tokenMessage, /Contents: read and write/);
assert.match(tokenMessage, /read-only is not enough/);

const appRefusal = new GitHubError(403, "Resource not accessible by integration");
appRefusal.via = "installation";
const appMessage = (githubFailure(appRefusal, "someone/site", "main") as Error).message;
assert.match(appMessage, /DakyXTech GitHub app/, "an app installation is named as the app, not as a token");
assert.doesNotMatch(appMessage, /Settings → Developer/, "a customer's app refusal is not fixed in our Settings");

const bare = (githubFailure(new GitHubError(403, "GitHub returned 403"), "a/b", "main") as Error).message;
assert.doesNotMatch(bare, /GitHub said/, "no quote when GitHub gave no reason");

console.log("websiteAgentSchema: closed schema with nothing a compiler refuses, tolerant reading, developer-help phrases, and publish refusals that say which credential and why — passed.");
