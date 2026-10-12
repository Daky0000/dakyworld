/**
 * The inspector's rules, without a browser. No IO.
 *
 * Three pure modules sit under the General · Style · Interactions tabs, and
 * this holds each one and — more usefully — the seams between them and the
 * server:
 *
 * - `lib/websiteStyleValues` takes list-valued CSS apart into rows and puts it
 *   back, and decides when a shorthand may be expanded. A value it cannot
 *   express must come back as "cannot", never as a near miss.
 * - `lib/websiteMotion` reads interactions out of a style and writes them back.
 *   Every keyframe it can name must exist in the published rules, and every
 *   value it writes must survive the server's sanitiser unchanged — otherwise an
 *   interaction looks right in the panel and does nothing on the page.
 * - `lib/elementInspector` lists the properties the frame is asked for; a Style
 *   control reading one that is not measured shows a blank for a value the site
 *   really sets.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { INSPECTED_PROPERTIES, toHex } from "../client/src/lib/elementInspector.js";
import {
  allowedAt, readBackground, readFilters, readGradient, readShadows, readTransforms, readTransitions, readable, splitTop,
  writeBackground, writeFilters, writeGradient, writeProperty, writeShadows, writeTransforms, writeTransitions,
} from "../client/src/lib/websiteStyleValues.js";
import {
  APPEARING, ATTENTION, FEEDBACK, IDENTITY, defaultInteraction, effectsFor, keyframeFor, readInteractions, slotOf, stateTransform,
  writeInteraction, type Direction, type Interaction, type Trigger,
} from "../client/src/lib/websiteMotion.js";
import { motionCss } from "../src/shared/websiteInteraction.js";
import { safeStyle } from "../src/services/website/regions.js";

let checks = 0;
function check(name: string, condition: unknown) { assert.ok(condition, name); checks++; }
function equal(name: string, actual: unknown, expected: unknown) { assert.deepEqual(actual, expected, name); checks++; }

/* ------------------------------------------------------------ splitting */

equal("commas inside a function are not separators", splitTop("rgba(0,0,0,.5) 0 1px, inset 0 0 2px red"), ["rgba(0,0,0,.5) 0 1px", "inset 0 0 2px red"]);
equal("spaces inside a function are not separators", splitTop("0 1px rgba(0, 0, 0, .2)", " "), ["0", "1px", "rgba(0, 0, 0, .2)"]);

/* -------------------------------------------------------------- shadows */

const shadows = readShadows("0 2px 8px rgba(0,0,0,.12), inset 0 1px 0 #fff");
equal("two shadows, one inset", shadows?.map((shadow) => shadow.inset), [false, true]);
equal("lengths in order", shadows?.[0] && [shadows[0].x, shadows[0].y, shadows[0].blur, shadows[0].spread], [0, 2, 8, 0]);
equal("and back", writeShadows(shadows!), "0px 2px 8px 0px rgba(0,0,0,.12), inset 0px 1px 0px 0px #fff");
equal("none is no shadows", readShadows("none"), []);
equal("a shadow these rows cannot hold is refused, not approximated", readShadows("0 0 calc(2px + 1px) red"), null);

/* ----------------------------------------------------------- transforms */

const transforms = readTransforms("translate(10px, 0px) rotate(5deg) scale(1.2) skewX(3deg)");
equal("a transform list reads as rows", transforms?.map((item) => item.kind), ["move", "rotate", "scale", "skew"]);
equal("and writes back in order", writeTransforms(transforms!), "translate(10px, 0px) rotate(5deg) scale(1.2, 1.2) skew(3deg, 0deg)");
equal("3D moves keep their depth", writeTransforms(readTransforms("translate3d(1px, 2px, 3px)")!), "translate3d(1px, 2px, 3px)");
equal("a matrix is the developer's, not a row", readTransforms("matrix(1, 0, 0, 1, 10, 0)"), null);
equal("percent moves are too", readTransforms("translate(-50%, 0)"), null);

/* -------------------------------------------------------------- filters */

const filters = readFilters("brightness(1.2) blur(2px) drop-shadow(0 4px 6px rgba(0,0,0,.4))");
equal("a fraction on a percentage filter is a percentage", filters?.[0], { fn: "brightness", value: 120 });
equal("drop shadows keep their colour", filters?.[2], { fn: "drop-shadow", x: 0, y: 4, blur: 6, color: "rgba(0,0,0,.4)" });
equal("and write back", writeFilters(filters!), "brightness(120%) blur(2px) drop-shadow(0px 4px 6px rgba(0,0,0,.4))");
equal("an unknown filter is refused", readFilters("url(#noise)"), null);

/* ---------------------------------------------------------- transitions */

const transitions = readTransitions("opacity .3s ease-in, transform 200ms 50ms");
equal("durations become milliseconds", transitions?.map((item) => item.duration), [300, 200]);
equal("timing and delay survive", transitions?.map((item) => item.rest), ["ease-in", "50ms"]);
equal("and write back", writeTransitions(transitions!), "opacity 300ms ease-in, transform 200ms 50ms");

/* ------------------------------------------------------------ gradients */

const gradient = readGradient("linear-gradient(to right, #fff, #000 80%)");
equal("a side keyword is an angle", gradient?.angle, 90);
equal("stops without a place are spread", gradient?.stops, [{ color: "#fff", at: 0 }, { color: "#000", at: 80 }]);
equal("and write back", writeGradient(gradient!), "linear-gradient(90deg, #fff 0%, #000 80%)");
equal("radial keeps its centre", readGradient("radial-gradient(circle at top left, red, blue)")?.position, "top left");

/* ----------------------------------------------------------- backgrounds */

const shorthand = readBackground({ background: "url('/hero.jpg') center/cover no-repeat, #0D1526" });
equal("a background shorthand reads as one picture layer and a colour", shorthand?.layers.map((layer) => layer.kind), ["image"]);
equal("its fit, place and repeat are kept", shorthand?.layers[0] && [shorthand.layers[0].position, shorthand.layers[0].size, shorthand.layers[0].repeat], ["center", "cover", "no-repeat"]);
equal("the colour is the base colour", shorthand?.color, "#0D1526");
const written = writeBackground(shorthand!.layers, shorthand!.color);
equal("writing a layer takes the shorthand apart", written.background, null);
equal("into the longhands", [written["background-image"], written["background-size"], written["background-color"]], ["url('/hero.jpg')", "cover", "#0D1526"]);
const overlay = readBackground({ "background-image": "linear-gradient(#00000080, #00000080), url('/a.jpg')", "background-size": "auto, cover" });
equal("a flat gradient is a colour layer", overlay?.layers.map((layer) => layer.kind), ["color", "image"]);
equal("lists line up by layer", overlay?.layers.map((layer) => layer.size), ["auto", "cover"]);
equal("a background these rows cannot read is left alone", readBackground({ background: "element(#x)" }), null);

/* ------------------------------------------------------------ shorthands */

const developer = { margin: "0 auto", color: "#111" };
equal("a shorthand reads as its sides", readable(developer)["margin-right"], "auto");
equal("changing something else never expands it", writeProperty(developer, "color", "red"), { margin: "0 auto", color: "red" });
equal("changing one side expands it once", writeProperty(developer, "margin-top", "8px"), { color: "#111", "margin-top": "8px", "margin-right": "auto", "margin-bottom": "0", "margin-left": "auto" });
equal("a border shorthand reads as width, type and colour", [readable({ border: "1px solid #000" })["border-top-width"], readable({ border: "1px solid #000" })["border-style"]], ["1px", "solid"]);
equal("a calc() shorthand is never guessed at", readable({ padding: "calc(1rem + 2px)" })["padding-top"], undefined);
equal("flex: 1 reads as grow, shrink and basis", [readable({ flex: "1" })["flex-grow"], readable({ flex: "1" })["flex-shrink"]], ["1", "1"]);

/* ---------------------------------------------------- what a screen allows */

check("desktop takes anything the sanitiser allows", allowedAt("desktop", "-webkit-text-stroke", "1px #000"));
check("a -webkit- property can't vary by screen", !allowedAt("tablet", "-webkit-text-stroke", "1px #000"));
check("nor can a picture", !allowedAt("mobile", "background-image", "url(x.png)"));
check("a gradient can", allowedAt("mobile", "background-image", "linear-gradient(red, blue)"));
check("nor can the editor's own properties", !allowedAt("tablet", "--dw-enter", "dw-enter-fade"));

/* ------------------------------------------------------- reading motion */

const legacy = readInteractions({ "--dw-enter": "dw-enter-up", "--dw-enter-start": "load", "--dw-loop": "dw-loop-pulse", "--dw-loop-dur": "2.4s", "--dw-active-transform": "scale(.94)", "--dw-scroll": "dw-scroll-fade" });
equal("published motion reads as interactions", legacy.map((interaction) => interaction.trigger), ["load", "scroll", "click", "loop"]);
equal("an old slide-up is a fade from the bottom", [legacy[0]!.effect, legacy[0]!.direction], ["fade", "bottom"]);
equal("a loop keeps its speed", legacy[3]!.duration, 2400);
equal("an old press is a pressed look", legacy[2]!.effect, "press");
equal("an old scroll fade keeps its own keyframe until somebody chooses another", legacy[1]!.keyframe, "dw-scroll-fade");
equal("an entrance with no start plays on scroll", readInteractions({ "--dw-enter": "dw-enter-zoom" }).map((interaction) => [interaction.trigger, interaction.effect]), [["view", "scale"]]);

/* ------------------------------------------------------- writing motion */

const apply = (map: Record<string, string>, patch: Record<string, string | null>) => {
  const next = { ...map };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next;
};
const only = (patch: Record<string, string | null>) => Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== null));

equal("a default entrance is two declarations", only(writeInteraction({}, "load", defaultInteraction("load"))), { "--dw-enter": "dw-enter-fade", "--dw-enter-start": "load" });
const hover: Interaction = { ...defaultInteraction("hover"), effect: "slide", direction: "left", type: "out", repeat: "infinite", duration: 900, delay: 100, easing: "ease-out", devices: { desktop: true, tablet: true, mobile: false } };
equal("a hover slide writes its slot", only(writeInteraction({}, "hover", hover)), {
  "--dw-onhover": "dw-fx-slide-left", "--dw-onhover-dur": "900ms", "--dw-onhover-delay": "100ms", "--dw-onhover-ease": "ease-out",
  "--dw-onhover-dir": "reverse", "--dw-onhover-count": "infinite", "--dw-onhover-no-m": "1",
});
const page: Interaction = { ...defaultInteraction("scroll"), relative: "page", start: 10, end: 90 };
equal("scrolling against the page uses the root's scroll", only(writeInteraction({}, "scroll", page)), { "--dw-scroll": "dw-enter-fade", "--dw-scroll-tl": "scroll(root)", "--dw-scroll-range": "10% 90%" });
const custom: Interaction = { ...defaultInteraction("click"), effect: "custom", from: { ...IDENTITY, opacity: 0, moveY: 20 }, to: { ...IDENTITY } };
const customPatch = only(writeInteraction({}, "click", custom));
equal("a custom effect is its two states", [customPatch["--dw-onclick"], customPatch["--dw-onclick-o0"], customPatch["--dw-onclick-t0"]], ["dw-fx-custom-onclick", "0", stateTransform({ ...IDENTITY, moveY: 20 })]);
const pressed = { "--dw-active-transform": "scale(.94)", transition: "transform 150ms, opacity 150ms" };
const replaced = apply(pressed, writeInteraction(pressed, "click", { ...defaultInteraction("click"), effect: "scale" }));
equal("a click animation replaces a pressed look entirely", replaced, { "--dw-onclick": "dw-enter-zoom" });
const moved = apply({ "--dw-enter": "dw-enter-fade", "--dw-enter-start": "load", "--dw-enter-no-m": "1" }, writeInteraction({}, "load", null));
equal("emptying a slot leaves nothing of it", moved, {});

for (const sample of [hover, page, custom, { ...defaultInteraction("view"), effect: "flip" as const }, { ...defaultInteraction("loop"), effect: "spin" as const, duration: 900 }]) {
  const back = readInteractions(apply({}, writeInteraction({}, sample.trigger, sample)));
  equal(`${sample.trigger} reads back as it was written`, back.map((interaction) => [interaction.trigger, interaction.effect, interaction.direction, interaction.type]), [[sample.trigger, sample.effect, sample.direction, APPEARING.includes(sample.effect) ? sample.type : "in"]]);
}

/* ------------------------------------------------- the seams to the server */

// Every keyframe the panel can name must be one the published rules define, or
// the interaction is a name pointing at nothing.
const css = motionCss();
const triggers: Trigger[] = ["load", "view", "scroll", "hover", "click", "loop"];
const directions: Direction[] = ["", "top", "bottom", "left", "right"];
for (const trigger of triggers) {
  for (const effect of effectsFor(trigger).flatMap((group) => group.effects)) {
    if (FEEDBACK.includes(effect)) continue;
    for (const direction of effect === "fade" || effect === "slide" ? directions : [""]) {
      const name = keyframeFor(effect, direction as Direction, slotOf(trigger));
      check(`${trigger} · ${effect}${direction ? ` · ${direction}` : ""} names a keyframe that exists (${name})`, css.includes(`@keyframes ${name}{`));
    }
  }
}
check("every attention effect is a loop keyframe", ATTENTION.every((effect) => css.includes(`@keyframes dw-loop-${effect}{`)));

// Every value the panel writes must reach the page unchanged.
const busy: Interaction = { ...custom, from: { opacity: 0, scaleX: 0.5, scaleY: 0.5, moveX: -1000, moveY: -1000, moveZ: -1000, rotateX: -720, rotateY: -720, rotateZ: -720, skewX: -89, skewY: -89 } };
for (const [trigger, interaction] of [["hover", hover], ["scroll", page], ["click", busy]] as const) {
  const style = Object.entries(only(writeInteraction({}, trigger, interaction))).map(([key, value]) => `${key}: ${value}`).join("; ");
  equal(`the server keeps every ${trigger} declaration`, safeStyle(style), style);
}

// The same for the Style tab's list values: what the rows write is what the
// server stores. A two-layer background is the case that matters — its position
// is a list, and a validator that only knew single positions dropped it whole.
const declarations = (patch: Record<string, string | null>) => Object.entries(only(patch)).map(([key, value]) => `${key}: ${value}`).join("; ");
const twoLayers = declarations(writeBackground([
  { kind: "color", color: "rgba(0,0,0,0.4)", position: "", size: "", repeat: "", attachment: "" },
  { kind: "image", url: "/assets/dw/hero.jpg", position: "center center", size: "cover", repeat: "no-repeat", attachment: "fixed" },
], "#0D1526"));
equal("the server keeps every declaration of a layered background", safeStyle(twoLayers), twoLayers);
check("including each layer's own position", twoLayers.includes("background-position: 0% 0%, center center"));
const gradientLayer = declarations(writeBackground([{ kind: "gradient", gradient: { type: "linear", angle: 135, position: "center", stops: [{ color: "rgba(49,87,255,0.9)", at: 0 }, { color: "#B8FF3D", at: 100 }] }, position: "", size: "", repeat: "", attachment: "" }], ""));
equal("and of a gradient with a translucent stop", safeStyle(gradientLayer), gradientLayer);
for (const style of [
  writeShadows([{ inset: false, x: 0, y: 18, blur: 40, spread: -4, color: "rgba(13,21,38,0.28)" }, { inset: true, x: 0, y: 1, blur: 0, spread: 0, color: "rgba(255,255,255,0.6)" }, { inset: false, x: 0, y: 0, blur: 0, spread: 4, color: "rgba(77,123,255,0.35)" }]).replace(/^/, "box-shadow: "),
  `transform: ${writeTransforms([{ kind: "move", x: 12, y: -8, z: 40 }, { kind: "rotate", x: 10, y: 20, z: 30 }, { kind: "scale", x: 1.05, y: 1.05, z: 1 }, { kind: "skew", x: 4, y: 0 }])}`,
  `filter: ${writeFilters([{ fn: "blur", value: 2 }, { fn: "brightness", value: 110 }, { fn: "drop-shadow", x: 0, y: 8, blur: 12, color: "rgba(0,0,0,0.4)" }])}`,
  `transition: ${writeTransitions([{ property: "opacity", duration: 300, rest: "ease-in" }, { property: "transform", duration: 200, rest: "" }, { property: "background-color", duration: 150, rest: "" }])}`,
  "grid-template-columns: repeat(4, minmax(0, 1fr))",
  "aspect-ratio: 16/9",
  "-webkit-text-stroke: 1px #000000",
  "background-clip: text; -webkit-background-clip: text; -webkit-text-fill-color: transparent",
  "transform-origin: 50% 50% 0px; perspective: 800px; perspective-origin: 50% 50%",
  'font-family: "Space Grotesk"',
  "scroll-margin-top: 80px; mix-blend-mode: multiply; column-count: 2; direction: rtl; order: -9999",
]) {
  equal(`the server keeps: ${style.slice(0, 60)}`, safeStyle(style), style);
}

// Every property a Style control shows a placeholder for is measured.
const tab = readFileSync("client/src/components/WebsiteStyleTab.tsx", "utf8");
const shown = new Set([...tab.matchAll(/property="([a-z-]+)"/g)].map((match) => match[1]!).filter((property) => !property.startsWith("-webkit-")));
for (const property of shown) check(`${property} is measured in the frame`, INSPECTED_PROPERTIES.includes(property));
check("the frame is asked for each property once", new Set(INSPECTED_PROPERTIES).size === INSPECTED_PROPERTIES.length);

equal("rgb reads as hex", toHex("rgb(8, 16, 31)"), "#08101F");

console.log(`websiteInspector: ${checks} checks — list values as rows and back, refusals instead of near misses, shorthands expanded only when touched, screen-size limits, legacy motion read, interactions written and read back, every keyframe exists, the server keeps every value, every shown property measured passed`);
