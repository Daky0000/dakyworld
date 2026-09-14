import assert from "node:assert/strict";
import { versionDraft } from "../src/services/website/versionRestore.js";
import { applyValues, buildPreview, discoverFields, sanitizeValue } from "../src/services/website/index.js";

const old = '<html><body><h1 data-dw-field="title">First title</h1><p data-dw-field="copy">First copy</p></body></html>';
const current = old.replace("First title", "Latest title").replace("First copy", "Latest copy");
const pending = { copy: sanitizeValue(discoverFields(current).fields.find(field => field.id === "copy")!, { value: "Unsaved copy" }) };
for (const framework of [false, true]) {
  const restored = versionDraft(current, pending, old, framework, "Restore version 1");
  assert.deepEqual(restored.dropped, []);
  const applied = applyValues(current, restored.values);
  assert.deepEqual(applied.conflicts, []);
  assert.equal(applied.html, old, "restore includes fields changed by later versions and replaces the pending draft");
}
const fields = discoverFields(current).fields;
const preview = buildPreview(current, "https://example.test/", fields.map(field => ({ ...field, previewReadOnly: field.id === "title" })));
assert.match(preview.html, /data-dw-field="title" data-dw-kind="text" data-dw-readonly="true"/);
assert.match(preview.html, /data-dw-field="copy" data-dw-kind="text"/);
assert.match(preview.html, /data-dw-selected/);
assert.match(preview.html, /if \(el.hasAttribute\("data-dw-readonly"\)\) return false/);
console.log("websiteVersionRestore: snapshots restore all content; source-managed elements remain selectable without allowing typing");
