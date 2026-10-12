import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { applyValues, buildPreview, buildPublishPlan, discoverFields, sanitizeValue, sanitizeSharedValue } from "../src/services/website/index.js";
import { interactionCss } from "../src/shared/websiteInteraction.js";

const source = '<!doctype html><html><head><title>Test title</title></head><body><section><h1 data-dw-field="hero.title">Make your next idea real</h1><a class="btn-primary" data-dw-field="hero.cta" href="/start">Start today</a></section></body></html>';
const fields = discoverFields(source).fields;
const heading = fields.find(field => field.id === "hero.title")!;
const cta = fields.find(field => field.id === "hero.cta")!;
assert.equal(heading.kind, "text");
const words = 'Make your <span style="color: #ff0000">next idea</span> real';
const edit = sanitizeValue(heading, { value: words });
assert.equal(edit.value, words);
assert.equal(sanitizeSharedValue(heading, { value: words }).value, words);
const saved = applyValues(source, { [heading.id]: edit });
assert.equal(saved.conflicts.length, 0);
assert.ok(saved.html.includes(words));
assert.equal(discoverFields(saved.html).fields.find(field => field.id === heading.id)?.kind, "richtext");
assert.equal(sanitizeValue(fields.find(field => field.tag === "title")!, { value: '<span style="color:red">Title</span>' }).value?.includes("<span"), false);
assert.doesNotMatch(sanitizeValue(heading, { value: 'Words<script>alert(1)</script><span onclick="evil()" style="color:red">here</span>' }).value!, /script|onclick|alert/);
assert.equal(sanitizeValue(cta, { value: 'Start <span style="font-weight:700">today</span>' }).value, 'Start <span style="font-weight:700">today</span>');
const style = 'color: #000000; --dw-hover-color: #ff0000; --dw-focus-background-color: #ffff00; transition: color 150ms';
const styled = sanitizeValue(cta, { style });
assert.match(styled.style!, /--dw-hover-color/);
const plan = buildPublishPlan({ source, values: { [cta.id]: styled, [heading.id]: edit } });
assert.equal(plan.publishable, true);
assert.match(plan.html!, /data-dw-interaction-styles/);
assert.match(plan.html!, /:focus-visible/);
assert.doesNotMatch(plan.html!, /data-dw-state-preview/);
assert.match(interactionCss(), /prefers-reduced-motion/);
const newCta = discoverFields(plan.html!).fields.find(field => field.id === cta.id)!;
const reset = applyValues(plan.html!, { [cta.id]: sanitizeValue(newCta, { style: 'color: #000000' }) });
assert.doesNotMatch(reset.html, /data-dw-interaction-styles/);
assert.equal(applyValues(source, {}).html, source);
assert.doesNotMatch(sanitizeValue(cta, { style: '--dw-hover-color: url(https://evil.test)' }).style ?? "", /url/);
const preview = buildPreview(source, "https://example.com/", fields);
assert.match(preview.html, /data-dw-interaction-preview/);
assert.match(preview.html, /data-dw-state-preview/);
const fragment = buildPreview('<h1>Hello</h1>', "https://example.com/");
assert.match(fragment.html, /data-dw-interaction-preview/);
// Motion from the Interactions tab: named keyframes in custom properties,
// kept by the sanitiser, and the fixed rules that animate them published with
// the page — and nothing that is not one of those names can become CSS.
{
  const motion = "--dw-enter: dw-enter-up; --dw-enter-dur: 0.8s; --dw-loop: dw-loop-pulse; --dw-active-transform: scale(.94); --dw-scroll: dw-scroll-fade";
  const moved = sanitizeValue(cta, { style: motion });
  for (const part of ["--dw-enter: dw-enter-up", "--dw-enter-dur: 0.8s", "--dw-loop: dw-loop-pulse", "--dw-active-transform: scale(.94)", "--dw-scroll: dw-scroll-fade"]) {
    assert.ok(moved.style?.includes(part), `motion value survives sanitising: ${part}`);
  }
  assert.doesNotMatch(sanitizeValue(cta, { style: "--dw-enter: url(https://evil.example/x)" }).style ?? "", /url/, "a motion value cannot fetch");
  const published = applyValues(source, { [cta.id]: moved }).html;
  assert.match(published, /data-dw-interaction-styles/, "a page using motion carries the interaction rules");
  assert.match(published, /@keyframes dw-enter-up\{/, "the entrance keyframes are published");
  // Every slot is a layer of one animation list, so an element can carry an
  // entrance, a loop and a hover interaction without one rule erasing another.
  assert.match(published, /animation-name:var\(--dw-enter,none\),var\(--dw-loop,none\),var\(--dw-scroll-live,none\),var\(--dw-onhover-live,none\),var\(--dw-onclick-live,none\)/, "loops and entrances animate by name, as layers");
  assert.match(published, /\[style\*="--dw-enter"\]\[style\*="--dw-loop"\]\{--dw-loop-wait:calc/, "a loop still waits for the entrance to finish");
  assert.match(published, /prefers-reduced-motion:reduce\)\{\[style\*="--dw-enter"\]/, "motion stops for reduced motion");
  assert.match(interactionCss(), /animation-timeline:view\(\)/, "scroll-linked entrances where the browser supports it");
}
// The Interactions tab's slots: hover and click switch a layer on rather than
// writing their own animation, each slot can be switched off per screen size,
// a custom effect is fixed keyframes over numbers the element carries, and the
// editor's Play hooks never reach a published page.
{
  const css = interactionCss();
  assert.match(css, /\[style\*="--dw-onhover"\]:hover\{--dw-onhover-live:var\(--dw-onhover\)\}/, "hover switches its layer on");
  assert.match(css, /\[style\*="--dw-onclick"\]:active,\[style\*="--dw-onclick"\]:focus\{--dw-onclick-live:var\(--dw-onclick\)\}/, "a press switches the click layer on");
  assert.match(css, /@media\(max-width:640px\)\{[^}]*\[style\*="--dw-enter-no-m"\]\{--dw-enter:none !important\}/, "an entrance can be switched off on phones");
  const desktop = /^@media\(min-width:1025px\)\{(.*)\}$/m.exec(css)?.[1] ?? "";
  assert.ok(desktop.includes('[style*="--dw-onhover-no-d"]{--dw-onhover:none !important}'), "and a hover one on desktop");
  for (const slot of ["enter", "scroll", "onhover", "onclick"]) {
    assert.match(css, new RegExp(`@keyframes dw-fx-custom-${slot}\\{from\\{opacity:var\\(--dw-${slot}-o0,1\\);transform:var\\(--dw-${slot}-t0,none\\)\\}`), `${slot} has fixed custom keyframes`);
  }
  // Hover and click layers do not exist for somebody who asked for less motion.
  // They are not switched off with `animation: none`, which would also stop
  // whatever the site itself animates on that element.
  assert.match(css, /@media\(prefers-reduced-motion:no-preference\)\{\[style\*="--dw-onhover"\]:hover,\[style\*="--dw-onclick"\]:active/, "hover and click play only without a reduced-motion preference");
  assert.doesNotMatch(css, /prefers-reduced-motion:reduce\)\{[^{]*--dw-on(?:hover|click)/, "and are never forced to none, which would stop the site's own animation");
  assert.doesNotMatch(css, /data-dw-play/, "the editor's Play hook is not on a published page");
  assert.match(interactionCss(true), /\[data-dw-play="onhover"\]\{|,\[data-dw-play="onhover"\]\{/, "but is in the editing preview");

  const hover = "--dw-onhover: dw-fx-slide-left; --dw-onhover-dur: 900ms; --dw-onhover-dir: reverse; --dw-onhover-count: infinite; --dw-onhover-no-m: 1; --dw-onhover-t0: translate3d(-120px,0px,0px) rotateX(0deg) rotateY(0deg) rotateZ(-15deg) skew(0deg,0deg) scale(0.8,0.8); --dw-scroll: dw-enter-fade; --dw-scroll-tl: scroll(root); --dw-scroll-range: 10% 90%";
  const kept = sanitizeValue(cta, { style: hover }).style ?? "";
  for (const part of hover.split("; ")) assert.ok(kept.includes(part), `interaction value survives sanitising: ${part}`);
  const onlyHover = applyValues(source, { [cta.id]: sanitizeValue(cta, { style: "--dw-onhover: dw-enter-zoom" }) }).html;
  assert.match(onlyHover, /data-dw-interaction-styles/, "a page whose only motion is a hover interaction still gets the rules");
}
await mkdir('checks/artifacts', { recursive: true });
await writeFile('checks/artifacts/interaction-published.html', plan.html!);
console.log('websiteInteractions: selection markup, shared sanitization, metadata safety, published hover/focus CSS, resets and fragment previews passed.');
