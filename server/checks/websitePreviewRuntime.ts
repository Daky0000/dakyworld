/// <reference lib="dom" />
/** Executes the actual picker handlers against a DOM double. This is not visual/browser QA. */
import assert from "node:assert/strict";
import { Script } from "node:vm";
import { buildPreview, discoverFields, renderResponsiveCss } from "../src/services/website/index.js";
import { responsivePreviewCss, writeResponsivePreview } from "../client/src/lib/websiteResponsive.js";

class ElementDouble {
  attributes = new Map<string, string>();
  textContent = "";
  innerHTML = "";
  removed = false;
  focused = false;
  classList = { add() {}, remove() {} };
  constructor(readonly tagName: string, attributes: Record<string, string> = {}) { for (const [key, value] of Object.entries(attributes)) this.setAttribute(key, value); }
  setAttribute(key: string, value: string) { this.attributes.set(key, value); }
  getAttribute(key: string) { return this.attributes.get(key) ?? null; }
  hasAttribute(key: string) { return this.attributes.has(key); }
  removeAttribute(key: string) { this.attributes.delete(key); }
  remove() { this.removed = true; }
  focus() { this.focused = true; }
  blur() { this.focused = false; }
  scrollIntoView() {}
}

function fixture(allowEditing = true) {
  const heading = new ElementDouble("H1", { "data-dw-field": "hero.title", "data-dw-kind": "text", "data-dw-style": "saved-heading" });
  const image = new ElementDouble("IMG", { "data-dw-field": "hero.image", "data-dw-kind": "image", "src": "old.jpg", "srcset": "old-2x.jpg 2x", "data-dw-style": "saved-image" });
  const sheets: ElementDouble[] = [];
  const fields = [heading, image];
  const documentListeners = new Map<string, (event: any) => void>();
  const listeners = new Map<string, (event: any) => void>();
  const doc = {
    readyState: "loading", body: {},
    head: { appendChild(sheet: ElementDouble) { sheets.push(sheet); } },
    querySelector(selector: string) { const id = /^\[data-dw-field="([^"]+)"\]$/.exec(selector)?.[1]; return fields.find(field => field.getAttribute("data-dw-field") === id) ?? null; },
    querySelectorAll(selector: string) { return selector === "style[data-dw-responsive-preview]" ? sheets.filter(sheet => !sheet.removed) : selector === "[data-dw-field]" ? fields : []; },
    createElement(tag: string) { return new ElementDouble(tag.toUpperCase()); },
    addEventListener(name: string, callback: (event: any) => void) { documentListeners.set(name, callback); },
  };
  const messages: any[] = [];
  const parent = { postMessage(message: unknown) { messages.push(message); } };
  const origin = "https://editor.test";
  const html = '<html><head></head><body><h1 data-dw-field="hero.title">Hello</h1><img data-dw-field="hero.image" src="old.jpg" alt="Old"></body></html>';
  const preview = buildPreview(html, "https://site.test/page", discoverFields(html).fields, allowEditing);
  const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(preview.html)?.[1];
  assert.ok(script, "preview contains trusted nonce picker");
  new Script(script).runInNewContext({ document: doc, parent, location: { origin }, window: { addEventListener(name: string, callback: (event: any) => void) { listeners.set(name, callback); }, setTimeout() {} }, clearTimeout() {}, setTimeout() {} });
  const send = (data: Record<string, unknown>, source: unknown = parent, eventOrigin = origin) => listeners.get("message")!({ source, origin: eventOrigin, data: { source: "dakyworld-editor", ...data } });
  return { heading, image, doc, sheets, messages, send };
}

const map = { tablet: "font-size:42px; padding:2rem", mobile: "font-size:28px!important; background:linear-gradient(red, blue)" };
const token = "dw-aaaaaaaaaaaaaaaaaaaaaaaa";
const expected = renderResponsiveCss(token, map).replaceAll(`[data-dw-style="${token}"]`, '[data-dw-field="hero.title"]');
assert.equal(responsivePreviewCss("hero.title", map), expected, "preview and published CSS share normalization and cascade");
assert.equal(responsivePreviewCss('"]{}body{color:red}', map), "", "preview refuses selector injection");
for (const style of ['background: url(https://bad.test)', 'background: var(--tracking-url)', 'width: 1px}</style><script>bad()</script>', 'width: expression(bad())']) {
  assert.equal(responsivePreviewCss("hero.title", { mobile: style }), "", "preview rejects fetching and executable CSS");
}

const f = fixture();
f.send({ type: "responsive", id: "hero.title", css: expected }, {});
f.send({ type: "responsive", id: "hero.title", css: expected }, undefined, "https://other.test");
f.send({ source: "other", type: "responsive", id: "hero.title", css: expected });
assert.equal(f.heading.getAttribute("data-dw-style"), "saved-heading", "untrusted messages cannot disable saved rules");
assert.equal(f.sheets.length, 0);
f.send({ type: "responsive", id: "hero.title", css: expected });
assert.equal(f.heading.getAttribute("data-dw-style"), null, "saved target rules no longer compete with complete replacement");
assert.equal(f.image.getAttribute("data-dw-style"), "saved-image", "sibling responsive styling stays in effect");
assert.equal(f.sheets[0]?.textContent, expected);
assert.equal(f.messages.at(-1)?.want, "responsive", "trusted update acknowledged");
f.send({ type: "responsive", id: "hero.title", css: "replacement" });
assert.equal(f.sheets.length, 1, "repeated updates reuse the target sheet");
f.send({ type: "responsive", id: "hero.title", css: "" });
assert.equal(f.sheets[0]?.removed, true, "clearing overrides removes live rules");
f.send({ type: "image", id: "hero.image", src: "new.jpg" });
assert.equal(f.image.getAttribute("src"), "new.jpg");
assert.equal(f.image.getAttribute("srcset"), null, "old image candidates cannot mask the new source");
f.send({ type: "responsive", id: "missing", css: expected });
assert.equal(f.messages.at(-1)?.type, "absent", "missing fields trigger the editor fallback");
const readonly = fixture(false);
readonly.send({ type: "edit", id: "hero.title" });
assert.equal(readonly.heading.hasAttribute("contenteditable"), false, "viewer picker cannot start in-place editing");

const direct = fixture();
writeResponsivePreview(direct.doc as unknown as Document, direct.heading as unknown as Element, "hero.title", map);
assert.equal(direct.sheets[0]?.textContent, expected, "same-origin direct path writes identical CSS");
writeResponsivePreview(direct.doc as unknown as Document, direct.heading as unknown as Element, "hero.title", {});
assert.equal(direct.sheets[0]?.removed, true);
console.log("websitePreviewRuntime: picker origin checks, responsive preview parity/reset, image replacement and viewer controls passed (DOM double; no browser rendering)");
