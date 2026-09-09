/** Structured proposals run through the real editor core, with no model or database. */
import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import type { Site, SitePage } from "@prisma/client";
import { discoverFields, applyValues, sanitizeValue, type FieldValue } from "../src/services/website/index.js";
import { prepareWebsiteAssistantContext, registerWebsiteAssistant, validateWebsiteAssistantPlan, websiteAssistantInput } from "../src/services/websiteAssistant.js";
import { importedWebsiteFields, websiteDesignOptions } from "../src/services/websiteManagement.js";
import { writerJob } from "../src/services/writers/registry.js";
import { shippedDoctrine } from "../src/services/writers/shipped.js";
import { AGENT_SEEDS } from "../src/services/agentRegistry.js";

assert.equal(writerJob("website.editor")?.agentKey, "website.editor");
assert.ok(AGENT_SEEDS.some(agent => agent.key === "website.editor"), "the assistant's wording has a real owner on the roster");
assert.match(await shippedDoctrine("website.editor"), /Preserve their design/);
assert.equal(websiteDesignOptions.parse({}).aiEnabled, false, "AI remains disabled until a manager enables it");
assert.equal(websiteDesignOptions.safeParse({ aiEnabled: "true" }).success, false);
assert.equal(websiteDesignOptions.safeParse({ brandVoice: "x".repeat(4001) }).success, false);
assert.equal(importedWebsiteFields('<!doctype html><html><head><title>Page</title></head><body><h1>Welcome</h1></body></html>'), 1);
assert.equal(importedWebsiteFields('<!-- Saved export --><section><h1>Welcome</h1><p>We make websites.</p></section>'), 2);
assert.throws(() => importedWebsiteFields('<html><head><title>React app</title><meta name="description" content="Our app"></head><body><div id="root"></div><script src="/app.js"></script></body></html>'), /no editable HTML content/);
assert.throws(() => importedWebsiteFields('<html><body><main><div hidden><h1>Hidden shell text</h1></div></main></body></html>'), /no editable HTML content/);
assert.throws(() => importedWebsiteFields('export default function Home() { return <h1>Hello</h1>; }'), /source adapter/);
assert.throws(() => importedWebsiteFields('Only plain text'), /HTML page/);

const source = `<!doctype html><html><head><title>Studio</title></head><body><main><section id="hero"><h1 data-dw-field="hero.title" style="color: #222; font-size: 40px">Build something beautiful</h1><p data-dw-field="hero.intro">Handmade websites for independent businesses.</p><a data-dw-field="hero.cta" class="btn btn-primary" href="/contact">Contact us</a><a class="btn btn-secondary" href="/work">See our work</a><img data-dw-field="hero.image" src="/studio.jpg" alt="Designers working in the studio"></section></main></body></html>`;
const fields = discoverFields(source).fields;
const title = fields.find(field => field.tag === "h1")!;
const intro = fields.find(field => field.tag === "p")!;
const button = fields.find(field => field.kind === "button")!;
const picture = fields.find(field => field.kind === "image")!;
assert.ok(title && intro && button && picture, "fixture exposes every supported field kind");
const context = prepareWebsiteAssistantContext(source, {});
type Change = { fieldId: string; operation: string; value: string; property: string | null };
const change = (fieldId: string, value: string, operation = "replace_text", property: string | null = null): Change => ({ fieldId, value, operation, property });
const plan = (...changes: Change[]) => ({ explanation: "A clearer page with more breathing room.", changes });
const rejects = (input: unknown, selected = context) => assert.throws(() => validateWebsiteAssistantPlan(selected, input));

const proposal = validateWebsiteAssistantPlan(context, plan(
  change(title.id, "Websites with purpose"),
  change(title.id, "48px", "set_style", "font-size"),
  change(title.id, "1.2", "set_style", "line-height"),
  change(button.id, "/start", "set_link"),
  change(button.id, "true", "set_new_tab"),
  change(picture.id, "Designers reviewing a website in the studio", "set_alt"),
));
assert.equal(proposal.values[title.id].value, "Websites with purpose");
assert.equal(proposal.values[title.id].style, "color: #222; font-size: 48px; line-height: 1.2", "specific style edits preserve existing properties and combine");
assert.equal(proposal.values[button.id].newTab, true);
assert.equal(proposal.changes.find(item => item.property === "value")?.before, title.value);
const coreValues: Record<string, FieldValue> = {};
for (const [id, edit] of Object.entries(proposal.values)) coreValues[id] = sanitizeValue(fields.find(field => field.id === id)!, edit);
const applied = applyValues(source, coreValues);
assert.equal(applied.conflicts.length, 0);
assert.equal(applied.missing.length, 0);
assert.ok(applied.html.includes("Websites with purpose"));
assert.ok(applied.html.includes("noopener noreferrer"), "core adds safe target attributes");
assert.ok(applied.html.includes(intro.value), "untargeted content stays untouched");
assert.equal(coreValues[title.id].original, title.value, "source owns the original used by publishing");

const draftContext = prepareWebsiteAssistantContext(source, { [title.id]: { value: "Unsaved draft heading", style: "color: #456; font-size: 40px" } }, title.id);
const restore = validateWebsiteAssistantPlan(draftContext, plan(change(title.id, title.value)));
assert.equal(restore.changes[0].before, "Unsaved draft heading", "before preview uses the unsaved draft");
assert.equal(restore.values[title.id].value, title.value, "restoring source content is still a real local patch");
assert.equal(restore.values[title.id].style, undefined, "a text suggestion never overwrites other draft controls");
const responsiveContext = prepareWebsiteAssistantContext(source, { [title.id]: { responsive: { mobile: "font-size:28px" } } }, title.id);
assert.deepEqual(responsiveContext.current[title.id].responsive, { mobile: "font-size: 28px" }, "assistant input retains normalized responsive drafts");
const responsiveProposal = validateWebsiteAssistantPlan(responsiveContext, plan(change(title.id, "Responsive heading")));
assert.equal(responsiveProposal.values[title.id].responsive, undefined, "copy suggestions leave device styling alone");
const responsiveMerged = sanitizeValue(title, { ...responsiveContext.current[title.id], ...responsiveProposal.values[title.id] });
assert.deepEqual(responsiveMerged.responsive, { mobile: "font-size: 28px" }, "applying a suggestion preserves unsaved phone styling");
const restoreOnlyContext = prepareWebsiteAssistantContext(source, { [title.id]: { value: "Unsaved only" } }, title.id);
assert.equal(validateWebsiteAssistantPlan(restoreOnlyContext, plan(change(title.id, title.value))).values[title.id].value, title.value, "restoring the entire source is permitted even with no published diff");
assert.equal(Object.keys(validateWebsiteAssistantPlan(context, plan(change(title.id, title.value))).values).length, 0, "no-op suggestions do not mark a page dirty");
assert.equal(validateWebsiteAssistantPlan(context, plan()).changes.length, 0, "the assistant may explain an unsupported request without making edits");

rejects(plan(change("nonexistent-field", "Oops")));
rejects(plan(change(intro.id, "Outside selection")), draftContext);
rejects(plan(change(title.id, "First"), change("nonexistent-field", "Second")));
rejects(plan(change(title.id, "First"), change(title.id, "Second")));
rejects(plan(change(button.id, "javascript:alert(1)", "set_link")));
rejects(plan(change(title.id, "/wrong-kind", "set_link")));
rejects(plan(change(title.id, "Misplaced description", "set_alt")));
rejects(plan(change(picture.id, "/replaced.jpg")));
rejects(plan(change(title.id, "", "replace_text")));
rejects(plan(change(title.id, "<script>alert(1)</script>", "replace_text")));
rejects(plan(change(title.id, "url(https://tracker.invalid/collect)", "set_style", "color")));
rejects(plan(change(title.id, "red; position: fixed", "set_style", "color")));
rejects(plan(change(title.id, "red", "set_style", "--unapproved-variable")));
rejects(plan(change(title.id, "red", "set_style", null)));
rejects(plan(change(title.id, "Words", "replace_text", "color")));
rejects(plan(change(button.id, "true", "set_new_tab", "color")));
rejects(plan(change(button.id, "maybe", "set_new_tab")));
rejects(plan(change(button.id, "hidden", "set_variant")));
rejects({ ...plan(change(title.id, "Words")), html: "<h1>replacement page</h1>" });
rejects({ ...plan(change(title.id, "Words")), changes: [{ ...change(title.id, "Words"), selector: "body" }] });
rejects(plan(...Array.from({ length: 41 }, () => change(title.id, "Too much"))));
assert.throws(() => prepareWebsiteAssistantContext(source, { unknown: { value: "Stale draft" } }));
assert.throws(() => prepareWebsiteAssistantContext(source, {}, "gone"));
assert.equal(websiteAssistantInput.safeParse({ prompt: "Fix it", values: { [title.id]: { value: "Fake", original: "Forged original" } } }).success, false);
assert.equal(websiteAssistantInput.safeParse({ prompt: "x".repeat(3001) }).success, false);
assert.equal(websiteAssistantInput.safeParse({ prompt: "Fix it", filePath: "secret.txt" }).success, false);

// Disabled AI and denied page access must stop before pageSource or the model.
// The synthetic page has no usable source; accidentally crossing that boundary
// would fail loudly, and the checks never need any credentials.
let authorised = 0;
let denied = false;
const app = express();
app.use(express.json());
const router = express.Router();
registerWebsiteAssistant(router, { loadPage: async () => {
  authorised += 1;
  if (denied) throw Object.assign(new Error("Not your site"), { status: 403 });
  return { site: { settings: { aiEnabled: false } } as unknown as Site, page: { status: "LIVE" } as SitePage };
} });
app.use(router);
app.use((error: Error & { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error.status ?? 400).json({ error: error.message }));
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
try {
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const request = () => fetch(`http://127.0.0.1:${address.port}/pages/page/assistant`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "Make the heading clearer", values: {} }) });
  const disabled = await request();
  assert.equal(disabled.status, 403);
  assert.match((await disabled.json() as { error: string }).error, /disabled/);
  assert.equal(authorised, 1, "AI settings are read after page authorization");
  denied = true;
  const refused = await request();
  assert.equal(refused.status, 403);
  assert.equal((await refused.json() as { error: string }).error, "Not your site");
} finally {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
console.log("Website assistant: validated proposals, unsaved draft context, atomic rejection, script/style safety and access gates passed (no model calls).");
