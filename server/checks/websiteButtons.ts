/**
 * Buttons: the two things they have that a link does not.
 *
 * The editor could always change a button's words and its destination, because
 * a button is an `<a>` and those are what an `<a>` has. What it could not reach
 * was the part that makes a button a button — **which style it wears** — so
 * turning the lime call to action on a page into the dark one meant editing
 * HTML, which is the thing this editor exists to avoid. And **opening a link in
 * a new tab** had no control at all, which matters more than it sounds: the
 * hand-written way to do it is `target="_blank"`, and `target` without
 * `rel="noopener"` hands the page it opens a live handle on the one it came
 * from.
 *
 * Six claims, asserted against the real pages in this repository rather than a
 * fixture, because a fixture is a page nobody visits:
 *
 *  1. A styled call to action is recognised as a button, with its style read
 *     off it, and an ordinary link in a sentence is not.
 *  2. Changing a style swaps one class token and leaves every other class the
 *     developer wrote — including the spacing ones — exactly where they were.
 *  3. A style can only ever be another token under the button's own stem. This
 *     is the security claim: free-text class editing, which is what a naive
 *     version of this feature is, could reach any utility class on the page.
 *  4. `target` and `rel` are written together and removed together. There is no
 *     path through this module that produces one without the other.
 *  5. A button restyled by a developer since the draft was written refuses,
 *     exactly as a heading they rewrote does.
 *  6. None of it disturbs the guarantee the whole module rests on: applying no
 *     edits still reproduces every file byte for byte.
 *
 * No database, no network, no key.
 *   npx tsx checks/websiteButtons.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyValues, describeChanges, discoverFields, sanitizeValue } from "../src/services/website/index.js";
import type { SiteField } from "../src/services/website/index.js";

const here = dirname(fileURLToPath(import.meta.url));
/** The website lives at the repository root, beside `server/`. See CLAUDE.md. */
const siteRoot = join(here, "..", "..");

let failures = 0;
let passed = 0;
function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed += 1;
    return;
  }
  failures += 1;
  console.error(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
}

const pages = readdirSync(siteRoot)
  .filter((name) => name.endsWith(".html"))
  .sort();

/** Every button on the site, with the page it came from. */
const buttons: Array<{ file: string; source: string; field: SiteField }> = [];
for (const file of pages) {
  const source = readFileSync(join(siteRoot, file), "utf8");
  for (const field of discoverFields(source).fields) {
    if (field.kind === "button") buttons.push({ file, source, field });
  }
}

// --- 1. Recognised, and not over-recognised --------------------------------

check("this site has buttons to test against", buttons.length > 0, `${pages.length} page(s) scanned`);

const styled = buttons.filter((entry) => entry.field.variant);
check("a styled call to action carries the style it wears", styled.length > 0, `${buttons.length} button(s), none with a variant`);
check(
  "and the stem it hangs off",
  styled.every((entry) => entry.field.variantStem && entry.field.variant!.startsWith(`${entry.field.variantStem}-`)),
  styled.map((entry) => `${entry.field.variant} under ${entry.field.variantStem}`).join(", "),
);

// The negative that matters most: a link inside a sentence must stay a link.
// Turning every anchor into a button would put a style menu on the footer's
// privacy link, and the menu would be a lie — there is no style to pick.
const plainLinks = pages.flatMap((file) =>
  discoverFields(readFileSync(join(siteRoot, file), "utf8")).fields.filter((field) => field.kind === "link"),
);
check("an ordinary link is still a link", plainLinks.length > 0, "every anchor on the site was read as a button");
check(
  "and carries no style menu",
  plainLinks.every((field) => field.variant === undefined && field.variantsOnPage === undefined),
);

// A `<button>` element has words and no destination, so it gets a style and no
// new-tab switch. Offering one would be a control that cannot do anything.
const elements = buttons.filter((entry) => entry.field.tag === "button");
check(
  "a <button> has no destination and no tab to open",
  elements.every((entry) => entry.field.href === undefined && entry.field.newTab === undefined),
  elements.map((entry) => `${entry.file} ${entry.field.id}`).join(", "),
);

// --- 2 & 3. Changing a style -----------------------------------------------

const subject = styled.find((entry) => entry.field.variantsOnPage && entry.field.variantsOnPage.length > 1);
check("some page offers a real choice of styles", Boolean(subject), styled.map((entry) => (entry.field.variantsOnPage ?? []).join("/")).join(" · "));

if (subject) {
  const { source, field } = subject;
  const other = field.variantsOnPage!.find((candidate) => candidate !== field.variant)!;
  const result = applyValues(source, { [field.id]: { variant: other, originalVariant: field.variant } });

  check("changing a style writes the page", result.changed.includes(field.id), JSON.stringify(result));
  const after = discoverFields(result.html).fields.find((candidate) => candidate.id === field.id);
  check("and the button now wears the new one", after?.variant === other, `${after?.variant} (wanted ${other})`);

  // The claim that the swap is a swap. Reading the class attribute back out of
  // the written HTML rather than trusting the field, because the field is
  // computed by the same code that did the writing.
  const before = source.slice(0, 0); // placeholder to keep the shape obvious
  void before;
  const beforeClasses = classAttrAround(source, field.id);
  const afterClasses = classAttrAround(result.html, field.id);
  check(
    "every other class survives the swap",
    beforeClasses.filter((token) => token !== field.variant).join(" ") === afterClasses.filter((token) => token !== other).join(" "),
    `${beforeClasses.join(" ")}  ->  ${afterClasses.join(" ")}`,
  );
  check("and the swap is one token, not a reorder", beforeClasses.length === afterClasses.length, `${beforeClasses.length} -> ${afterClasses.length}`);

  // The diff a publish shows. One class changing must not read as the whole
  // element changing.
  const diff = result.html.length - source.length;
  check("the file grows or shrinks only by the difference in the two names", Math.abs(diff) === Math.abs(other.length - field.variant!.length), String(diff));

  // 3. The security claim. Every one of these is refused, and the page is left
  // exactly as it was — not written with a fallback, not written at all.
  const forbidden = ["hidden", "btn", "", "btn-primary hidden", "../x", "btn-<script>"];
  for (const attempt of forbidden) {
    const refused = applyValues(source, { [field.id]: { variant: attempt, originalVariant: field.variant } });
    check(`a style of "${attempt}" is refused`, refused.html === source, `${refused.changed.length} field(s) written`);
  }

  // Taking the style off entirely is a real thing to want, and the only way
  // back to a plain link.
  const bare = applyValues(source, { [field.id]: { variant: null, originalVariant: field.variant } });
  const bareField = discoverFields(bare.html).fields.find((candidate) => candidate.id === field.id);
  check("a style can be taken off", bareField?.variant === undefined, String(bareField?.variant));
  check("and taking it off leaves the rest of the class list", classAttrAround(bare.html, field.id).includes(field.variantStem!));

  // 5. The draft is dated, like every other kind of edit.
  const stale = applyValues(source, { [field.id]: { variant: other, originalVariant: "btn-somethingelse" } });
  check("a style the page no longer wears refuses rather than writing", stale.html === source && stale.conflicts.length === 1, JSON.stringify(stale.conflicts));

  // What a person reads before publishing. "Primary → Dark", not the classes.
  const [line] = describeChanges([field], { [field.id]: { variant: other, originalVariant: field.variant } });
  check("the change reads as a style, in words", line?.part === "button style", JSON.stringify(line));
  check("named the way the button is labelled, not by its class", Boolean(line && !line.to.includes("-")), JSON.stringify(line));
}

// --- 3b. A button with no style yet ----------------------------------------
//
// The one-way door. "None" takes a style off, and if a styleless button could
// not be given one back, publishing that would leave a button no menu could
// ever reach again. The rule takes its stem from the style being *asked for*
// rather than from the one already worn, which is what makes the door swing
// both ways — and is exactly as safe, because the element still has to carry
// the class the request hangs off.

if (subject) {
  const bare = applyValues(subject.source, { [subject.field.id]: { variant: null, originalVariant: subject.field.variant } });
  const bareField = discoverFields(bare.html).fields.find((candidate) => candidate.id === subject.field.id)!;
  check("a styleless button still knows what classes it carries", bareField.classes?.includes(subject.field.variantStem!) ?? false, bareField.classes);

  const restored = applyValues(bare.html, { [bareField.id]: { variant: subject.field.variant! } });
  const restoredField = discoverFields(restored.html).fields.find((candidate) => candidate.id === bareField.id);
  check("and can be given a style back", restoredField?.variant === subject.field.variant, String(restoredField?.variant));
  check("landing exactly where it started", restored.html === subject.source, "the round trip did not close");

  // And the safety claim again, from the harder starting point: a button
  // wearing only its base must not become a doorway to any class on the page.
  for (const attempt of ["hidden", "cta", "btn", "nav-open"]) {
    const refused = applyValues(bare.html, { [bareField.id]: { variant: attempt } });
    check(`a styleless button cannot be given "${attempt}"`, refused.html === bare.html, `${refused.changed.length} written`);
  }

  // Nothing unpublishable is stored either. `sanitizeValue` is what a save runs.
  check("and a save drops it rather than storing it", sanitizeValue(bareField, { variant: "hidden" }).variant === undefined);
  check("while a real one is stored", sanitizeValue(bareField, { variant: subject.field.variant! }).variant === subject.field.variant);
}

// --- 4. Opening in a new tab -----------------------------------------------

const linkButton = buttons.find((entry) => entry.field.hrefSpan && entry.field.newTab === false);
check("some button on the site opens in the same tab", Boolean(linkButton));

if (linkButton) {
  const { source, field } = linkButton;
  const opened = applyValues(source, { [field.id]: { newTab: true, originalNewTab: false } });
  const openedTag = tagAround(opened.html, field.id);
  check("turning it on writes target", openedTag.includes('target="_blank"'), openedTag);
  check("and writes rel in the same breath — never one without the other", /rel="[^"]*noopener[^"]*"/.test(openedTag), openedTag);
  check("with noreferrer as well", /rel="[^"]*noreferrer[^"]*"/.test(openedTag), openedTag);

  const reread = discoverFields(opened.html).fields.find((candidate) => candidate.id === field.id);
  check("and the page now reads as opening in a new tab", reread?.newTab === true, String(reread?.newTab));

  // Off again, and all the way off: `target=""` is not "no target" to a browser.
  const closed = applyValues(opened.html, { [field.id]: { newTab: false, originalNewTab: true } });
  check("turning it off puts the page back exactly as it was", closed.html === source, tagAround(closed.html, field.id));

  // A `rel` the developer put there for their own reasons is theirs.
  const withNofollow = source.replace(tagAround(source, field.id), (tag) => tag.replace("<a ", '<a rel="nofollow" '));
  const nofollowField = discoverFields(withNofollow).fields.find((candidate) => candidate.id === field.id);
  if (nofollowField) {
    const both = applyValues(withNofollow, { [nofollowField.id]: { newTab: true, originalNewTab: false } });
    const bothTag = tagAround(both.html, nofollowField.id);
    check("an existing rel keeps its own tokens", bothTag.includes("nofollow") && bothTag.includes("noopener"), bothTag);

    const undone = applyValues(both.html, { [nofollowField.id]: { newTab: false, originalNewTab: true } });
    const undoneTag = tagAround(undone.html, nofollowField.id);
    check("and keeps them when the new tab is taken away", undoneTag.includes("nofollow"), undoneTag);
    check("while ours go", !undoneTag.includes("noopener") && !undoneTag.includes('target="_blank"'), undoneTag);
  }

  // The editor's control is the only producer, and it cannot make a new tab out
  // of a `<button>`. Asserted through `sanitizeValue`, which is what a save
  // actually goes through.
  const element = buttons.find((entry) => entry.field.tag === "button");
  if (element) {
    const attempted = sanitizeValue(element.field, { newTab: true });
    check("a <button> cannot be given a new tab", attempted.newTab === undefined, JSON.stringify(attempted));
  }
}

// --- 6. The guarantee everything else rests on ------------------------------

for (const file of pages) {
  const source = readFileSync(join(siteRoot, file), "utf8");
  const untouched = applyValues(source, {});
  check(`${file}: applying no edits still changes nothing`, untouched.html === source, `${source.length} in, ${untouched.html.length} out`);
}

/** The whole opening tag of a marked field, read back out of written HTML. */
function tagAround(html: string, id: string): string {
  const fields = discoverFields(html).fields;
  const field = fields.find((candidate) => candidate.id === id);
  if (!field) return "";
  const anchor = field.classSpan?.start ?? field.hrefSpan?.start ?? field.attrInsert ?? 0;
  const open = html.lastIndexOf("<", anchor);
  const close = html.indexOf(">", anchor);
  return open === -1 || close === -1 ? "" : html.slice(open, close + 1);
}

function classAttrAround(html: string, id: string): string[] {
  const match = /class="([^"]*)"/.exec(tagAround(html, id));
  return match ? match[1]!.split(/\s+/).filter(Boolean) : [];
}

console.log(`\n${passed} passed, ${failures} failed`);
if (failures > 0) process.exitCode = 1;
else console.log("websiteButtons: all checks passed");
