import assert from "node:assert/strict";
import { changeStructure, structureControls, discoverFields, editingSource, applyValues, sanitizeValue, buildPublishPlan, describeChanges, draftDocument, sourceHash, DOCUMENT_KEY, type FieldValue } from "../src/services/website/index.js";

const source = '<html><head><style>.card{color:navy}</style></head><body><main><section class="card"><h1>Heading</h1><p>First paragraph</p><p>Second paragraph</p><img src="photo.jpg" alt="Photo"></section><section id="fixed"><h2>Fixed section</h2></section><section><form><input name="email"></form><p>Interactive block</p></section></main><script>window.keep=true</script></body></html>';
const fields = discoverFields(source).fields;
const first = fields.find(field => field.value === "First paragraph")!;
const second = fields.find(field => field.value === "Second paragraph")!;
const heading = fields.find(field => field.tag === "h1")!;
const card = fields.find(field => field.id === first.parentId)!;
const controls = structureControls(source);
assert.equal(controls[first.id]?.duplicate, true);
assert.equal(controls[first.id]?.nextId, second.id);
assert.equal(controls[fields.find(field => field.label === "fixed")!.id]?.duplicate, false, "fixed HTML IDs are not duplicated");

// Nothing a person can see is locked. A block holding a form is moved like any
// other and deleted once they have said yes; only a copy of it is held back.
const contact = fields.find(field => field.kind === "container" && field.tag === "section" && field.id !== card.id && field.label !== "fixed")!;
const fixed = fields.find(field => field.label === "fixed")!;
const holdsForm = controls[contact.id]!;
assert.equal(holdsForm.remove, false, "a block holding a form is never deleted without asking");
assert.equal(holdsForm.forceRemove, true, "but it can be deleted");
assert.equal(holdsForm.move, true, "and moved");
assert.equal(holdsForm.duplicate, false, "a copy would repeat the form");
assert.equal(holdsForm.reason, undefined, "and it carries no standing refusal");
assert.match(holdsForm.removeWarning!, /holds a form/, "the question names what goes with it");
assert.doesNotMatch(JSON.stringify(controls), /source editor|controlled by the page source/, "nobody is sent to the source editor to delete something");
assert.equal(holdsForm.previousId, fixed.id, "it takes its place among its siblings");
assert.equal(controls[fixed.id]?.nextId, contact.id);
assert.throws(() => changeStructure(source, {}, { kind: "remove", fieldId: contact.id }), /holds a form/, "a bare delete is answered with the question, not carried out");
const withoutContact = applyValues(source, changeStructure(source, {}, { kind: "remove", fieldId: contact.id, force: true }).values).html;
assert.ok(!withoutContact.includes("<form>") && !withoutContact.includes("Interactive block"), "saying yes deletes the block and the form in it");
assert.ok(withoutContact.includes("Fixed section") && withoutContact.includes("<script>window.keep=true</script>"), "and nothing else");
const contactFirst = applyValues(source, changeStructure(source, {}, { kind: "before", fieldId: contact.id, targetId: fixed.id }).values).html;
assert.ok(contactFirst.indexOf('<form><input name="email"></form>') < contactFirst.indexOf("Fixed section"), "a block holding a form moves with the form intact");
assert.throws(() => changeStructure(source, {}, { kind: "duplicate", fieldId: contact.id }), /repeat its form/);

// The form itself, and what sits inside one.
const formSource = '<html><body><main><section><h2>Write to us</h2><form action="/send"><label>Your name</label><input name="name"><button type="submit">Send</button></form><iframe src="https://maps.example/embed"></iframe><p onclick="track()">Call us</p></section></main></body></html>';
const formFields = discoverFields(formSource).fields;
const formControls = structureControls(formSource);
const byTag = (tag: string) => formFields.find(field => field.tag === tag)!;
for (const tag of ["form", "iframe", "label", "p"]) {
  assert.equal(formControls[byTag(tag).id]?.forceRemove, true, `a <${tag}> can be deleted`);
  assert.equal(formControls[byTag(tag).id]?.remove, false, `and a <${tag}> asks first`);
}
assert.match(formControls[byTag("form").id]!.removeWarning!, /This is a form/);
assert.match(formControls[byTag("iframe").id]!.removeWarning!, /embedded frame/);
assert.match(formControls[byTag("label").id]!.removeWarning!, /part of a form/);
assert.match(formControls[byTag("p").id]!.removeWarning!, /holds scripts/);
const noForm = applyValues(formSource, changeStructure(formSource, {}, { kind: "remove", fieldId: byTag("form").id, force: true }).values).html;
assert.ok(!noForm.includes("<form") && !noForm.includes("</form>") && noForm.includes("<iframe"), "deleting the form takes the form and leaves its neighbours");
const noLabel = applyValues(formSource, changeStructure(formSource, {}, { kind: "remove", fieldId: byTag("label").id, force: true }).values).html;
assert.ok(!noLabel.includes("Your name") && noLabel.includes('<input name="name">'), "deleting a label leaves the field it named");

// The page itself is the one thing that stays.
const bodyField = formFields.find(field => field.tag === "body")!;
assert.equal(formControls[bodyField.id]?.forceRemove, undefined);
assert.match(formControls[bodyField.id]!.reason!, /page itself/);
assert.throws(() => changeStructure(formSource, {}, { kind: "remove", fieldId: bodyField.id, force: true }), /page itself/, "saying yes does not delete the page");

// A closing tag left off. The reader nests each later item inside the open one,
// so a deletion that trusted that would take the rest of the list with it.
const looseSource = "<html><body><main><ul><li>Alpha<li>Beta<li>Gamma</ul><p>After the list</p></main></body></html>";
const looseFields = discoverFields(looseSource).fields;
const looseControls = structureControls(looseSource);
const alpha = looseFields.find(field => field.tag === "li" && field.value.startsWith("Alpha"))!;
assert.ok(alpha, "an unclosed list item is still a field");
assert.equal(looseControls[alpha.id]?.forceRemove, true, "an element with no closing tag can be deleted");
assert.equal(looseControls[alpha.id]?.move, undefined, "but not moved: its bytes cannot be lifted safely");
assert.match(looseControls[alpha.id]!.reason!, /no closing tag/);
assert.throws(() => changeStructure(looseSource, {}, { kind: "before", fieldId: alpha.id, targetId: looseFields.find(field => field.tag === "p")!.id }), /no closing tag/);
const withoutAlpha = applyValues(looseSource, changeStructure(looseSource, {}, { kind: "remove", fieldId: alpha.id, force: true }).values).html;
assert.ok(!withoutAlpha.includes("Alpha"), "it is deleted");
assert.ok(withoutAlpha.includes("><li>Beta<li>Gamma</ul>") && withoutAlpha.includes("After the list"), "and the items after it are not");

// A link the editor wrapped around an element goes with the element.
const wrappedSource = '<html><body><main><section><h2>Our work</h2><a data-dw-link href="/work" style="display:contents;color:inherit;text-decoration:inherit"><img src="work.jpg" alt="A finished kitchen"></a><p>Closing words</p></section></main></body></html>';
const wrappedImage = discoverFields(wrappedSource).fields.find(field => field.kind === "image")!;
const unwrapped = applyValues(wrappedSource, changeStructure(wrappedSource, {}, { kind: "remove", fieldId: wrappedImage.id }).values).html;
assert.ok(!unwrapped.includes("work.jpg") && !unwrapped.includes("data-dw-link"), "deleting a linked picture does not leave an empty link behind");
assert.ok(unwrapped.includes("Our work") && unwrapped.includes("Closing words"));

const values = { [heading.id]: sanitizeValue(heading, { value: "Updated before moving", responsive: { mobile: "font-size: 2rem" } }) };
const moved = changeStructure(source, values, { kind: "before", fieldId: second.id, targetId: first.id });
const afterMove = applyValues(source, moved.values);
assert.equal(afterMove.conflicts.length, 0);
assert.ok(afterMove.html.indexOf("Second paragraph") < afterMove.html.indexOf("First paragraph"));
assert.equal(discoverFields(afterMove.html).fields.find(field => field.id === heading.id)?.value, "Updated before moving");
assert.deepEqual(discoverFields(afterMove.html).fields.find(field => field.id === heading.id)?.responsive, { mobile: "font-size: 2rem" });
assert.ok(afterMove.html.includes('<script>window.keep=true</script>'));
assert.ok(describeChanges(discoverFields(editingSource(source, moved.values)).fields, moved.values).some(change => change.to === "Updated before moving"), "review keeps text edits consumed by a layout action");
assert.equal(draftDocument(moved.values)?.baseHash, sourceHash(source));

const duplicate = changeStructure(source, moved.values, { kind: "duplicate", fieldId: card.id });
const duplicatedFields = discoverFields(editingSource(source, duplicate.values)).fields;
assert.equal(new Set(duplicatedFields.map(field => field.id)).size, duplicatedFields.length, "cloned subtree fields have unique stable identities");
assert.ok(duplicatedFields.find(field => field.id === duplicate.selectedId));
const clonedHeading = duplicatedFields.find(field => field.tag === "h1" && field.id !== heading.id)!;
const edited: Record<string, FieldValue> = { ...duplicate.values, [clonedHeading.id]: sanitizeValue(clonedHeading, { value: "Only the cloned heading" }) };
const clonedResult = applyValues(source, edited);
assert.equal(discoverFields(clonedResult.html).fields.find(field => field.id === heading.id)?.value, "Updated before moving");
assert.equal(discoverFields(clonedResult.html).fields.find(field => field.id === clonedHeading.id)?.value, "Only the cloned heading");
assert.equal(buildPublishPlan({ source, values: edited }).publishable, true);
assert.equal(buildPublishPlan({ source: source.replace("navy", "blue"), values: edited }).publishable, false, "source edits prevent stale structural publishing");
assert.throws(() => changeStructure(source.replace("navy", "blue"), edited, { kind: "remove", fieldId: first.id }), /original page changed/);

const removed = changeStructure(source, edited, { kind: "remove", fieldId: duplicate.selectedId! });
assert.ok(!applyValues(source, removed.values).html.includes("Only the cloned heading"));
const undo = changeStructure(source, removed.values, { kind: "undo" });
assert.ok(applyValues(source, undo.values).html.includes("Only the cloned heading"), "undo restores content edited after duplication");
const redo = changeStructure(source, undo.values, { kind: "redo" });
assert.equal(applyValues(source, redo.values).html, applyValues(source, removed.values).html, "redo restores exactly the same layout");
const originalAgain = changeStructure(source, moved.values, { kind: "undo" });
assert.equal(editingSource(source, originalAgain.values), source, "undo recovers original source bytes");
assert.deepEqual(originalAgain.values[heading.id], values[heading.id], "undo restores pending field edits rather than losing them");
const simpleMove = changeStructure(source, {}, { kind: "before", fieldId: second.id, targetId: first.id });
const simpleUndo = changeStructure(source, simpleMove.values, { kind: "undo" });
assert.equal(buildPublishPlan({ source, values: simpleUndo.values }).publishable, false, "undoing all changes leaves nothing to publish");
assert.throws(() => changeStructure(source, {}, { kind: "before", fieldId: first.id, targetId: fields.find(field => field.tag === "h2")!.id }), /same parent/);
assert.throws(() => changeStructure(source, {}, { kind: "before", fieldId: first.id, targetId: first.id }), /same parent/);
assert.throws(() => changeStructure(source, {}, { kind: "remove", fieldId: "missing" }), /no longer/);
assert.ok(simpleUndo.values[DOCUMENT_KEY], "undo history stays server-owned even at the original layout");
console.log("websiteStructure: stable moves/clones, independent editing, removal, undo/redo, reviews, stale-source protection, deleting and moving interactive blocks, unclosed elements and wrapped links passed");
