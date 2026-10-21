/**
 * Masks — a shape cut out of an element and an edge that fades away — through
 * the server's own sanitisers and writer. No IO.
 *
 * The seam that matters is the one `checks/websiteInspector.ts` names for every
 * Style control: the frame is pushed the raw value and the server stores the
 * filtered one, so a preset the sanitiser trims looks right in the panel and is
 * gone after a save. Every shape, and a fade of every edge at every length the
 * slider reaches, must survive `safeStyle` (Desktop) and `safeResponsiveStyle`
 * (Tablet and Phone) byte for byte.
 *
 * Half of it is negatives: a value the panel did not write must read as
 * unreadable rather than as the nearest preset, and a picture must never
 * become a mask by any route, because a `url()` mask is fetched with CORS and
 * the media library's storage does not send it (`shared/websiteMask.ts`).
 */
import assert from "node:assert/strict";
import { applyValues, discoverFields, renderResponsiveCss, safeResponsiveStyle, safeStyle, sanitizeValue } from "../src/services/website/index.js";
import { FADE_EDGES, FADE_MAX, FADE_MIN, MASK_SHAPES, maskShapeClip, readFade, readMaskShape, writeFade } from "../src/shared/websiteMask.js";
import { allowedAt } from "../client/src/lib/websiteStyleValues.js";

let checks = 0;
function check(name: string, condition: unknown) { assert.ok(condition, name); checks++; }
function equal(name: string, actual: unknown, expected: unknown) { assert.deepEqual(actual, expected, name); checks++; }

/* ----------------------------------------------------- every preset lands */

for (const shape of MASK_SHAPES) {
  const declaration = `clip-path: ${shape.clip}`;
  equal(`${shape.label} survives the Desktop sanitiser`, safeStyle(declaration), declaration);
  equal(`${shape.label} survives the tablet/phone sanitiser`, safeResponsiveStyle(declaration), declaration);
  check(`${shape.label} is offered on a phone`, allowedAt("mobile", "clip-path", shape.clip));
  equal(`${shape.label} reads back as itself`, readMaskShape(shape.clip), shape.id);
  equal(`${shape.label} is found by its id`, maskShapeClip(shape.id), shape.clip);
}
equal("shape ids are unique", new Set(MASK_SHAPES.map((shape) => shape.id)).size, MASK_SHAPES.length);

for (const { id: edge } of FADE_EDGES) {
  for (let length = FADE_MIN; length <= FADE_MAX; length += 1) {
    const image = writeFade(edge, length);
    const declaration = `mask-image: ${image}`;
    if (safeStyle(declaration) !== declaration) assert.fail(`${edge} fade at ${length}% is trimmed by the Desktop sanitiser: ${safeStyle(declaration)}`);
    if (safeResponsiveStyle(declaration) !== declaration) assert.fail(`${edge} fade at ${length}% is trimmed by the tablet/phone sanitiser`);
    const read = readFade(image);
    if (!read || read.edge !== edge) assert.fail(`${edge} fade at ${length}% does not read back as a ${edge} fade`);
    // An axis fade splits its length between two ends, so an odd length reads
    // back one higher; writing what was read must then be a fixed point.
    if (writeFade(read.edge, read.length) !== image) assert.fail(`${edge} fade at ${length}% is not a fixed point of read-then-write`);
  }
  checks += 1;
}
equal("a one-sided fade keeps its length exactly", readFade(writeFade("bottom", 35)), { edge: "bottom", length: 35 });
equal("a fade is clamped, not refused, at the ends of its range", readFade(writeFade("top", 400)), { edge: "top", length: FADE_MAX });

/* ----------------------------------------------- reading is never a guess */

equal("no clip is no shape", readMaskShape(undefined), "");
equal("none is no shape", readMaskShape("none"), "");
equal("spacing does not change which shape it is", readMaskShape("polygon(50% 0%,100% 100%,  0% 100%)"), "triangle");
equal("a developer's own polygon is not the nearest preset", readMaskShape("polygon(50% 0%, 100% 100%, 1% 100%)"), null);
equal("an inset is not a shape this panel offers", readMaskShape("inset(0 round 24px)"), null);
equal("a circle of another size is not the circle", readMaskShape("circle(40% at 50% 50%)"), null);
equal("no mask is no fade", readFade(""), "");
equal("a fade that stops at another colour is the developer's", readFade("linear-gradient(to bottom, red 65%, transparent 100%)"), null);
equal("a fade outside the slider's range is the developer's", readFade("linear-gradient(to bottom, black 99%, transparent 100%)"), null);
equal("a picture mask is never read as a fade", readFade("url(/assets/dw/shape.svg)"), null);

/* ------------------------------------------- a picture is never a mask */

for (const value of ["url(/assets/dw/a.svg)", "url('https://cdn.example/a.png')", "linear-gradient(black, transparent), url(/a.svg)"]) {
  equal(`Desktop refuses mask-image: ${value}`, safeStyle(`mask-image: ${value}`), "");
  equal(`tablet/phone refuse mask-image: ${value}`, safeResponsiveStyle(`mask-image: ${value}`), "");
}
equal("a var() in a mask could resolve to a picture, so a phone rule refuses it", safeResponsiveStyle("mask-image: var(--shape)"), "");
equal("a path() shape needs quotes, which an attribute cannot carry safely", safeStyle('clip-path: path("M0 0 L10 10")'), "");

/* -------------------------------------------- through the page writer */

const source = '<!doctype html><html><head><title>Masks</title></head><body><main><section id="team"><h2>Team</h2><img src="/ama.jpg" alt="Ama" style="width: 240px; clip-path: polygon(0% 0%, 100% 0%, 100% 90%, 95% 92%, 90% 94%, 85% 95%, 80% 96%, 75% 97%, 70% 98%, 65% 99%, 60% 100%, 40% 100%, 30% 99%, 20% 97%, 0% 100%)"><img src="/kofi.jpg" alt="Kofi"></section></main></body></html>';
const page = discoverFields(source);
const [ama, kofi] = page.fields.filter((field) => field.kind === "image");
check("both pictures are fields", ama && kofi);

const circle = `clip-path: ${maskShapeClip("circle")}`;
const kofiEdit = sanitizeValue(kofi!, { style: circle });
equal("a shape is stored as the panel wrote it", kofiEdit.style, circle);
const written = applyValues(source, { [kofi!.id]: kofiEdit });
equal("a shape is one edit with no conflicts", [written.changed, written.conflicts], [[kofi!.id], []]);
check("a shape is published on the element itself", written.html.includes(`<img style="${circle}" src="/kofi.jpg" alt="Kofi">`));
equal("and nothing else in the file moves", written.html.replace(` style="${circle}"`, ""), source);

// A developer's long polygon is a list, and a list gets the longer cap: an
// unrelated edit to the same element must not drop it on the way through.
const long = ama!.style!;
check("the developer's polygon is longer than an ordinary value may be", /clip-path: ([^;]+)/.exec(long)![1]!.length > 120);
const widened = sanitizeValue(ama!, { style: long.replace("width: 240px", "width: 280px") });
check("an unrelated change keeps the developer's long shape", widened.style?.includes("85% 95%, 80% 96%"));
check("and reads it as a shape the panel did not write", readMaskShape(/clip-path: ([^;]+)/.exec(long)![1]) === null);
// The page's own declarations are always kept; the cap is for a long shape
// written fresh, which at the ordinary 120 characters was dropped on save.
const fresh = `clip-path: ${/clip-path: ([^;]+)/.exec(long)![1]!.replace("0% 0%,", "1% 0%,")}`;
equal("a long shape written fresh is stored whole", safeStyle(fresh), fresh);

const fade = `mask-image: ${writeFade("bottom", 40)}`;
const phone = sanitizeValue(kofi!, { responsive: { mobile: `${circle}; ${fade}` } });
equal("a phone gets its own shape and fade", phone.responsive, { mobile: `${circle}; ${fade}` });
const responsive = applyValues(source, { [kofi!.id]: phone }).html;
const token = /data-dw-style="(dw-[a-f0-9]{24})"/.exec(responsive)?.[1];
check("a phone mask gives the element a token", token);
const css = renderResponsiveCss(token!, phone.responsive!);
check("the phone rule carries the shape", css.includes(`clip-path: ${maskShapeClip("circle")} !important`));
check("and the fade", css.includes(`mask-image: ${writeFade("bottom", 40)} !important`));
check("inside the phone media query", /max-width: 640px[\s\S]*clip-path/.test(css));

console.log(`websiteMasks: ${checks} checks — every shape and fade survives both sanitisers, reading never guesses, a picture is never a mask, and the writer publishes a one-attribute diff`);
