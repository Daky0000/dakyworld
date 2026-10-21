/**
 * A form's words are fields: placeholders, a submit input's words and the
 * options in a drop-down. No IO.
 *
 * 1. **No existing id moves.** Ids are positional, and a draft is written
 *    against them. The new fields are counted in a series of their own
 *    (`s0.form.0`), so every field a page already had keeps its number — the
 *    first assertion compares against the ids this page had before.
 * 2. **A `<select>` is no longer rich text.** Its value used to be the
 *    `<option>` markup, so a word typed into it deleted every option. A draft
 *    written that way now conflicts instead of publishing.
 * 3. **An attribute value is written for its quote**, as a page description
 *    is: double, single or none, with `&`, `<` and the quote escaped and an
 *    apostrophe left readable where it can be.
 * 4. **Plain words only**: markup typed into an option or a placeholder is
 *    text on the page, never an element.
 * 5. **What is not words is not offered**: a hidden input, a checkbox, a date
 *    picker, a submit input with no value, an option that holds the next one.
 * 6. **The canvas never offers a caret in a form control**, and a pushed
 *    placeholder lands on the attribute.
 */
import assert from "node:assert/strict";
import { applyValues, buildPreview, discoverFields, sanitizeValue, validateFieldChange } from "../src/services/website/index.js";

let checks = 0;
function check(name: string, condition: unknown) { assert.ok(condition, name); checks++; }
function equal(name: string, actual: unknown, expected: unknown) { assert.deepEqual(actual, expected, name); checks++; }

const source = `<!doctype html><html><head><title>Contact</title></head><body><main>
<section id="contact"><h2>Write to us</h2>
<form method="post"><label for="n">Name</label><input id="n" name="name" placeholder="Your name">
<input type='email' name='email' placeholder='Your email'>
<input name=phone placeholder=Phone>
<input type="hidden" name="source" value="site"><input type="checkbox" name="news"><input type="date" name="when" placeholder="Pick a day">
<textarea name="message" placeholder="How can we help?"></textarea>
<select name="service"><option value="">Choose a service</option><option>Web design<option>Hosting</select>
<input type="submit" value="Send message"><input type="submit">
<button type="submit">Send</button></form>
<p>We reply within a day.</p></section>
</main></body></html>`;

const page = discoverFields(source);
const section = page.sections.find((each) => each.fields.some((field) => field.tag === "form"))!;
const byLabel = (label: string, value?: string) => section.fields.find((field) => field.label === label && (value === undefined || field.preview === value));

/* ------------------------------------------------- 1. no existing id moves */

equal(
  "every field the page already had keeps its positional id",
  section.fields.filter((field) => !field.formText).map((field) => [field.id, field.tag]),
  [["s0.0", "h2"], ["s0.1", "form"], ["s0.2", "label"], ["s0.3", "select"], ["s0.4", "button"], ["s0.5", "p"]],
);
equal(
  "the form's words are a series of their own, in document order",
  section.fields.filter((field) => field.formText).map((field) => [field.id, field.formText, field.preview]),
  [
    ["s0.form.0", "placeholder", "Your name"],
    ["s0.form.1", "placeholder", "Your email"],
    ["s0.form.2", "placeholder", "Phone"],
    ["s0.form.3", "placeholder", "How can we help?"],
    ["s0.form.4", "option", "Choose a service"],
    ["s0.form.5", "option", "Hosting"],
    ["s0.form.6", "value", "Send message"],
  ],
);
check("their order puts them where they sit on the page", byLabel("Placeholder", "Your name")!.order! < byLabel("Placeholder", "How can we help?")!.order! && byLabel("Menu option", "Hosting")!.order! < byLabel("Button label")!.order!);

/* ------------------------------------- 2. a select is not rich text now */

const select = section.fields.find((field) => field.tag === "select")!;
equal("a drop-down is a field of its own, not words", [select.kind, select.value], ["unsupported", ""]);
const stale = applyValues(source, { [select.id]: { value: "Our services", original: '<option value="">Choose a service</option><option>Web design<option>Hosting' } });
equal("a draft that typed over the options conflicts instead of deleting them", [stale.conflicts.map((conflict) => conflict.id), stale.html], [[select.id], source]);

/* -------------------------------------- 3. written for the attribute's quote */

const write = (label: string, value: string, preview?: string) => {
  const field = byLabel(label, preview)!;
  const edit = sanitizeValue(field, { value });
  const result = applyValues(source, { [field.id]: edit });
  equal(`${label} "${preview ?? ""}" is one change`, [result.changed, result.conflicts], [[field.id], []]);
  return { html: result.html, field: discoverFields(result.html).fields.find((each) => each.id === field.id)! };
};
const quoted = write("Placeholder", 'Name & "nickname"', "Your name");
check("double quotes: the quote and the ampersand are escaped", quoted.html.includes('placeholder="Name &amp; &quot;nickname&quot;"'));
equal("and it reads back as what was typed", quoted.field.preview, 'Name & "nickname"');
const single = write("Placeholder", "Your email, we'll reply", "Your email");
check("single quotes: the apostrophe is escaped for them", single.html.includes("placeholder='Your email, we&#39;ll reply'"));
const bare = write("Placeholder", "Phone or WhatsApp", "Phone");
check("no quotes: it is given some", bare.html.includes('placeholder="Phone or WhatsApp"'));
const submit = write("Button label", "Send it now");
check("a submit input's words are its value", submit.html.includes('<input type="submit" value="Send it now">'));
const option = write("Menu option", "Website care", "Hosting");
check("an option's words change and the menu stays whole", option.html.includes("<option>Web design<option>Website care</select>"));
equal("nothing else on the page moves", write("Placeholder", "Ask us anything", "How can we help?").html.replace('placeholder="Ask us anything"', 'placeholder="How can we help?"'), source);

// Settings → Link wraps words in a link; round a form control that is a
// control inside a link. Seen on the rendered panel, not in a test, first.
check("a form's words are never offered a link", section.fields.filter((field) => field.formText).every((field) => field.href === undefined && field.linkWrap === undefined));

/* ------------------------------------------------------ 4. plain words */

const tagged = sanitizeValue(byLabel("Menu option", "Hosting")!, { value: "<b>Hosting</b> & care" });
equal("markup in an option is text", tagged.value, "&lt;b&gt;Hosting&lt;/b&gt; &amp; care");
const escaping = sanitizeValue(byLabel("Placeholder", "Your name")!, { value: '"><script>alert(1)</script>' });
const escaped = applyValues(source, { [byLabel("Placeholder", "Your name")!.id]: escaping }).html;
check("a placeholder cannot leave its attribute", !/<script>/.test(escaped) && escaped.includes('placeholder="&quot;&gt;&lt;script&gt;'));

/* -------------------------------------------- 5. what is not words */

check("a hidden input is not offered", !section.fields.some((field) => field.preview === "site"));
check("a checkbox has no words to offer", !section.fields.some((field) => field.tag === "input" && field.attrInsert !== undefined && /name="news"/.test(source.slice(field.attrInsert - 6, field.attrInsert + 30))));
check("a date picker draws its own hint", !byLabel("Placeholder", "Pick a day"));
equal("a submit input with no value shows the browser's word, which is not ours to change", section.fields.filter((field) => field.formText === "value").length, 1);
check("an option holding the next one (no closing tag) is not offered", !byLabel("Menu option", "Web design"));

const emptied = validateFieldChange(page.fields, { [byLabel("Placeholder", "Your name")!.id]: { value: "" } });
equal("a placeholder may be emptied", emptied, []);
const blankOption = validateFieldChange(page.fields, { [byLabel("Menu option", "Hosting")!.id]: { value: " " } });
equal("an option may not: it would be a blank line in the menu", blankOption.length, 1);

/* ---------------------------------- 5b. words wrapped round a control */

// A label wrapped round its own control read as one rich-text field holding the
// control's markup, so changing its words sent the control through the rich-text
// sanitiser, which keeps none of them. It keeps its slot; its words are its run
// of text; the control's words join the form series.
const wrapped = `<!doctype html><html><head><title>Book</title></head><body><main>
<section><h2>Book a table</h2>
<label>Party size <select name="size"><option>Two</option><option>Four</option></select></label>
<label><input type="checkbox" name="agree"> I agree to the house rules</label>
<label>Email <input type="email" placeholder="you@example.com"> (we never share it)</label>
<p>See you soon.</p></section>
</main></body></html>`;
const wrappedPage = discoverFields(wrapped);
const wrappedFields = wrappedPage.sections.find((each) => each.fields.some((field) => field.tag === "label"))!.fields;
equal(
  "each wrapper keeps the positional id it had, and the paragraph after them keeps its own",
  wrappedFields.filter((field) => !field.formText || field.formText === "label").map((field) => [field.id, field.tag, field.kind]),
  [["s0.0", "h2", "text"], ["s0.1", "label", "text"], ["s0.2", "label", "text"], ["s0.3", "label", "unsupported"], ["s0.4", "p", "text"]],
);
const partySize = wrappedFields.find((field) => field.id === "s0.1")!;
equal("a label's words are its run of text, not the drop-down", [partySize.formText, partySize.value], ["label", "Party size"]);
const agree = wrappedFields.find((field) => field.id === "s0.2")!;
equal("words after a checkbox are the label's words", agree.value, "I agree to the house rules");
check("words on both sides of a control are left to the code and say why", /both sides/.test(wrappedFields.find((field) => field.id === "s0.3")!.unsupportedReason ?? ""));
equal(
  "the controls' own words are in the form series",
  wrappedFields.filter((field) => field.formText && field.formText !== "label").map((field) => [field.formText, field.preview]),
  [["option", "Two"], ["option", "Four"], ["placeholder", "you@example.com"]],
);
const resized = applyValues(wrapped, { [partySize.id]: sanitizeValue(partySize, { value: "Guests <b>tonight</b>" }) }).html;
check("changing a label's words keeps its drop-down whole", resized.includes('<label>Guests &lt;b&gt;tonight&lt;/b&gt; <select name="size"><option>Two</option><option>Four</option></select></label>'));
const agreed = applyValues(wrapped, { [agree.id]: sanitizeValue(agree, { value: "I accept the rules" }) }).html;
check("and a checkbox's", agreed.includes('<label><input type="checkbox" name="agree"> I accept the rules</label>'));
const typedOver = applyValues(wrapped, { [partySize.id]: { value: "Party size", original: 'Party size <select name="size"><option>Two</option><option>Four</option></select>' } });
equal("a draft that typed over the drop-down conflicts instead of deleting it", [typedOver.conflicts.map((conflict) => conflict.id), typedOver.html], [[partySize.id], wrapped]);
check("nor are the words round a control", wrappedFields.filter((field) => field.formText).every((field) => field.linkWrap === undefined));
const wrappedPreview = buildPreview(wrapped, "https://example.test/book", wrappedPage.fields);
check("the picker never puts a caret in anything that holds a control", wrappedPreview.html.includes('if (el.querySelector("input, select, textarea")) return false;'));

/* --------------------------------------------------- 6. the canvas */

const preview = buildPreview(source, "https://example.test/contact", page.fields);
check("an input is marked so it can be clicked", /<input data-dw-field="s0\.form\.0" data-dw-kind="text" id="n"/.test(preview.html));
check("the picker never puts a caret in a form control", /INPUT\|TEXTAREA\|SELECT\|OPTION/.test(preview.html));
check("and writes a pushed placeholder onto the attribute", preview.html.includes('written.setAttribute(asButton ? "value" : "placeholder", decoder.value)'));

console.log(`websiteFormText: ${checks} checks — form words are fields without moving any id, a drop-down is no longer typed over, attribute values are escaped for their quote, and the canvas never offers a caret in a control`);
