/** Shared-element identity, slots and resolution, through the real parse. No IO. */
import assert from "node:assert/strict";
import {
  detachSnapshot, elementFingerprint, instanceShape, resolveSharedValues, sharedCandidates, slotFieldIds, slotForField,
} from "../src/services/website/shared.js";
import { readPage } from "../src/services/website/regions.js";

let checks = 0;
function check(name: string, condition: unknown) { assert.ok(condition, name); checks++; }
function equal(name: string, actual: unknown, expected: unknown) { assert.deepEqual(actual, expected, name); checks++; }

/* ------------------------------------------------------------- fixtures */

const header = (current: string) =>
  `<header class="site-header"><a class="brand" href="/"><img src="/logo.svg" alt="Dakyworld"></a><nav class="main-nav">` +
  `<a href="/services"${current === "services" ? ' class="nav-link active" aria-current="page"' : ' class="nav-link"'}>Services</a>` +
  `<a href="/contact"${current === "contact" ? ' class="nav-link active" aria-current="page"' : ' class="nav-link"'}>Contact</a>` +
  `</nav></header>`;

const cta = (words: string, extra = "") =>
  `<section class="cta" data-dw-shared="main-cta"><h2>${words}</h2>${extra}<a class="btn btn-primary" href="/contact">Let us talk</a></section>`;

const page = (name: string, body: string) =>
  `<!doctype html><html><head><title>${name}</title></head><body>${header(name)}<main><h1>${name}</h1><p>Words about ${name}.</p></main>${body}</body></html>`;

const home = page("home", cta("Ready to improve your systems?"));
const services = page("services", cta("Ready to improve your systems?"));
const contact = page("contact", cta("Ready to improve your systems?"));
/** The same component after somebody added a paragraph to this page's copy. */
const drifted = page("about", cta("Ready to improve your systems?", "<p>An extra line only this page has.</p>"));

const ctaId = readPage(home).fields.find((field) => field.tag === "section")!.id;
const headerId = readPage(home).fields.find((field) => field.tag === "header")!.id;

/* ------------------------------------------------------------ the shape */

const shape = instanceShape(home, ctaId)!;
equal("the instance is itself and what is editable inside it", shape.slots.map((slot) => `${slot.key}:${slot.kind}/${slot.tag}`), [
  "self:container/section",
  "0:text/h2",
  "1:button/a",
]);
equal("an element that is not on the page has no shape", instanceShape(home, "nothing.here"), null);
equal("the reverse map answers with the slot an edit belongs to", slotForField(home, ctaId, readPage(home).fields.find((field) => field.tag === "h2")!.id), "0");
equal("a field outside the instance belongs to no slot", slotForField(home, ctaId, readPage(home).fields.find((field) => field.tag === "h1")!.id), null);

/* -------------------------------------------------- one change, many pages */

const edit = { "0": { value: "Ready to get started?", original: "Ready to improve your systems?" } };
const onServices = resolveSharedValues({ html: services, rootFieldId: ctaId, slots: shape.slots, values: edit });
equal("a shared change lands on the other page's own field id", Object.keys(onServices.values), [
  readPage(services).fields.find((field) => field.tag === "h2" && field.value.startsWith("Ready"))!.id,
]);
equal("and nothing is reported as unplaceable", onServices.mismatched, []);
equal("the words that travel are the ones that were reviewed", Object.values(onServices.values)[0], edit["0"]);

/* ------------------------------------------------------------ shape drift */

// The page gained a paragraph inside the component, so slot 1 is now a
// paragraph rather than the button. Nothing may be written into it.
const buttonEdit = { "1": { value: "Book a call" } };
const onDrifted = resolveSharedValues({ html: drifted, rootFieldId: ctaId, slots: shape.slots, values: buttonEdit });
equal("a slot whose kind has changed underneath is refused", onDrifted.mismatched, ["1"]);
equal("and nothing at all is written to that page", Object.keys(onDrifted.values), []);
const headingOnDrifted = resolveSharedValues({ html: drifted, rootFieldId: ctaId, slots: shape.slots, values: edit });
equal("the slot that did not move is still reported as drifted overall", headingOnDrifted.mismatched, ["1"]);
check("but the heading itself still places, so a caller can say which is which", Object.keys(headingOnDrifted.values).length === 1);
const drift = slotFieldIds(drifted, ctaId, shape.slots);
equal("the drift is named by slot rather than counted", drift.mismatched, ["1"]);
equal("a missing instance root reports every slot", slotFieldIds(home, "gone.away", shape.slots).mismatched, ["self", "0", "1"]);

/* ---------------------------------------------------------------- detach */

const snapshot = detachSnapshot({ html: contact, rootFieldId: ctaId, slots: shape.slots, values: edit });
equal("detaching keeps exactly what the shared element was giving this page", snapshot, resolveSharedValues({ html: contact, rootFieldId: ctaId, slots: shape.slots, values: edit }).values);
check("so the page does not move when it stops being linked", Object.values(snapshot)[0]!.value === "Ready to get started?");

/* ----------------------------------------------------------- fingerprints */

const homePrint = elementFingerprint(home, headerId)!;
const servicesPrint = elementFingerprint(services, headerId)!;
equal("which page you are on is not part of what a header is", homePrint.structure, servicesPrint.structure);
equal("nor is the nav link marked as the current page", homePrint.content, servicesPrint.content);
check("but the words in a block are", elementFingerprint(home, ctaId)!.content !== elementFingerprint(page("x", cta("Something else entirely")), ctaId)!.content);
equal("an element that is not there has no fingerprint", elementFingerprint(home, "nothing.here"), null);

/* ------------------------------------------------------------- detection */

const found = sharedCandidates([
  { pageId: "home", title: "Home", html: home },
  { pageId: "services", title: "Services", html: services },
  { pageId: "contact", title: "Contact", html: contact },
]);
const annotated = found.find((candidate) => candidate.key === "main-cta")!;
check("an annotated element is found", annotated !== undefined);
equal("and is high confidence on the annotation alone", annotated.confidence, "high");
equal("on every page that carries it", annotated.instances.map((instance) => instance.pageId).sort(), ["contact", "home", "services"]);

const repeated = found.find((candidate) => candidate.name.includes("header") || candidate.key.startsWith("header"));
check("a header repeated word for word is found without any annotation", repeated !== undefined);
equal("and is high confidence", repeated!.confidence, "high");

check("the nav inside the header is not offered as a second shared element", !found.some((candidate) => candidate.key.startsWith("nav")));
check("the page's own main region is never offered on structure alone", !found.some((candidate) => candidate.key !== "main-cta" && /^main/.test(candidate.name)));

const single = sharedCandidates([{ pageId: "home", title: "Home", html: home }]);
equal("one page is not a shared element", single, []);

// The same structure with different words is a question, not a fact.
const differentWords = sharedCandidates([
  { pageId: "one", title: "One", html: `<!doctype html><html><head><title>a</title></head><body><section class="card"><h2>Design</h2><p>One</p></section></body></html>` },
  { pageId: "two", title: "Two", html: `<!doctype html><html><head><title>b</title></head><body><section class="card"><h2>Automation</h2><p>Two</p></section></body></html>` },
]);
equal("structure alone is offered as medium confidence", differentWords.map((candidate) => candidate.confidence), ["medium"]);
check("and says why in words somebody can act on", /different words/.test(differentWords[0]!.reason));

const differentStructure = sharedCandidates([
  { pageId: "one", title: "One", html: `<!doctype html><html><head><title>a</title></head><body><section class="card"><h2>Design</h2></section></body></html>` },
  { pageId: "two", title: "Two", html: `<!doctype html><html><head><title>b</title></head><body><section class="panel"><h3>Automation</h3><img src="/x.png" alt="x"></section></body></html>` },
]);
equal("two blocks that merely both exist are not grouped", differentStructure, []);

/* ------------------------------------------------- developer-named slots */

const named = `<!doctype html><html><head><title>n</title></head><body><section class="cta" data-dw-shared="cta"><h2 data-dw-shared-field="cta.heading">Old</h2><a class="btn btn-primary" data-dw-shared-field="cta.button" href="/c">Go</a></section></body></html>`;
const moved = `<!doctype html><html><head><title>n</title></head><body><section class="cta" data-dw-shared="cta"><a class="btn btn-primary" data-dw-shared-field="cta.button" href="/c">Go</a><h2 data-dw-shared-field="cta.heading">Old</h2></section></body></html>`;
const namedId = readPage(named).fields.find((field) => field.tag === "section")!.id;
const namedShape = instanceShape(named, namedId)!;
equal("a developer-given name travels with the slot", namedShape.slots.map((slot) => slot.name), [undefined, "cta.heading", "cta.button"]);
const acrossMove = resolveSharedValues({ html: moved, rootFieldId: namedId, slots: namedShape.slots, values: { "0": { value: "New heading" } } });
equal("and a named slot follows the element rather than the position", acrossMove.mismatched, []);
equal("landing on the heading even though it is now second", Object.keys(acrossMove.values), [readPage(moved).fields.find((field) => field.tag === "h2")!.id]);

console.log(`websiteShared: ${checks} checks — instance shape, slot resolution, drift refusal, detach snapshots, page-state-insensitive fingerprints, confidence grading and named slots passed`);
