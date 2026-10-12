import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The published interaction rules, asked of a real browser.
 *
 * `shared/websiteInteraction.ts` turns `--dw-*` properties on an element into
 * animation. Everything the Interactions tab does rests on those few rules, and
 * so does every page already published with the older names (`--dw-enter`,
 * `--dw-loop`, `--dw-scroll`), so what is asserted here is what a browser
 * computes — never that a string is in the stylesheet.
 *
 * The rules are the *published* ones (`interactionCss()` with no preview
 * hooks), loaded through the harness so this file holds no copy of them.
 */
const { chromium } = await import(process.env.PLAYWRIGHT_URL ?? "playwright");
const here = dirname(fileURLToPath(import.meta.url));
const shared = join(here, "..", "..", "src", "shared", "websiteInteraction.ts").replace(/\\/g, "/");

const browser = await chromium.launch({ headless: true });
const errors = [];
try {
  const loader = await browser.newPage();
  await loader.goto("http://127.0.0.1:5199/inspector-harness.html");
  const css = await loader.evaluate(async (path) => (await import(/* @vite-ignore */ `/@fs/${path}`)).interactionCss(), shared);
  await loader.close();
  assert.ok(css.includes("@keyframes dw-enter-fade"), "the rules were loaded from the shared module");

  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on("pageerror", (error) => errors.push(error.message));
  const box = (id, style, extra = "") => `<div id="${id}" ${extra} style="width:120px;height:40px;background:#3157ff;${style}">${id}</div>`;
  await page.setContent(`<!doctype html><html><head><style>
    @keyframes site-spin{to{transform:rotate(360deg)}}
    .site{animation:site-spin 4s linear infinite}
    body{margin:0;padding:20px;min-height:3000px}
    ${css}
  </style></head><body>
    ${box("load", "--dw-enter: dw-enter-up; --dw-enter-start: load; --dw-enter-dur: 100000ms")}
    ${box("view", "--dw-enter: dw-enter-up")}
    ${box("combo", "--dw-enter: dw-enter-fade; --dw-enter-start: load; --dw-loop: dw-loop-pulse")}
    ${box("loop", "--dw-loop: dw-loop-pulse; --dw-loop-dur: 2.4s")}
    ${box("scroll", "--dw-scroll: dw-scroll-parallax")}
    ${box("page", "--dw-scroll: dw-enter-fade; --dw-scroll-tl: scroll(root); --dw-scroll-range: 10% 90%")}
    ${box("hover", "--dw-onhover: dw-loop-wiggle", 'class="site"')}
    ${box("both", "--dw-enter: dw-enter-fade; --dw-enter-start: load; --dw-enter-dur: 100000ms; --dw-onhover: dw-enter-zoom")}
    ${box("click", "--dw-onclick: dw-enter-zoom")}
    ${box("phone", "--dw-enter: dw-enter-fade; --dw-enter-start: load; --dw-enter-no-m: 1")}
    ${box("custom", "--dw-enter: dw-fx-custom-enter; --dw-enter-start: load; --dw-enter-dur: 100000ms; --dw-enter-o0: 0.25; --dw-enter-t0: translate3d(30px,0px,0px) rotateX(0deg) rotateY(0deg) rotateZ(0deg) skew(0deg,0deg) scale(1,1); --dw-enter-o1: 1; --dw-enter-t1: translate3d(0px,0px,0px) rotateX(0deg) rotateY(0deg) rotateZ(0deg) skew(0deg,0deg) scale(1,1)")}
    ${box("out", "--dw-enter: dw-enter-fade; --dw-enter-start: load; --dw-enter-dir: reverse; --dw-enter-dur: 60ms")}
    ${box("thrice", "--dw-enter: dw-enter-fade; --dw-enter-start: load; --dw-enter-count: 3")}
    ${box("plain", "", 'class="site"')}
  </body></html>`);

  const style = (id, property) => page.locator(`#${id}`).evaluate((element, name) => getComputedStyle(element)[name], property);
  const names = async (id) => (await style(id, "animationName")).split(",").map((name) => name.trim());
  // The pointer goes to the element's centre by hand: Playwright's own hover waits for an
  // element to stop moving, and one of these spins for ever on purpose.
  const over = async (id) => {
    const centre = await page.locator(`#${id}`).evaluate((element) => { const box = element.getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; });
    await page.mouse.move(centre.x, centre.y);
  };

  /* ------------------------------------------------ what is already published */
  assert.deepEqual(await names("load"), ["dw-enter-up", "none", "none", "none", "none"], "an entrance is the first layer");
  assert.equal((await style("load", "animationTimeline")).split(",")[0].trim(), "auto", "a page-load entrance runs on the clock");
  assert.equal((await style("view", "animationTimeline")).split(",")[0].trim(), "view()", "a scroll-into-view entrance follows the scroll where the browser can");
  assert.deepEqual(await names("combo"), ["dw-enter-fade", "dw-loop-pulse", "none", "none", "none"], "an entrance and a loop are two layers of one list");
  assert.equal((await style("combo", "animationDelay")).split(",")[1].trim(), "0.6s", "the loop waits for the entrance to finish");
  assert.equal((await style("loop", "animationDelay")).split(",")[1].trim(), "0s", "a loop alone starts at once");
  assert.equal((await style("loop", "animationDuration")).split(",")[1].trim(), "2.4s", "and keeps its speed");
  assert.equal((await style("loop", "animationIterationCount")).split(",")[1].trim(), "infinite");
  assert.equal((await names("scroll"))[2], "dw-scroll-parallax", "a scroll effect is the third layer");
  assert.equal((await style("scroll", "animationTimeline")).split(",")[2].trim(), "view()", "tied to the element's place in the viewport");
  assert.equal((await style("page", "animationTimeline")).split(",")[2].trim(), "scroll(root)", "or to the page's own scroll");

  /* ------------------------------------------------------------- hover, click */
  assert.deepEqual(await names("hover"), ["site-spin"], "a hover interaction leaves the site's own animation alone at rest");
  assert.deepEqual(await names("plain"), ["site-spin"], "and an element with no interaction is never touched");
  await over("hover");
  assert.equal((await names("hover"))[3], "dw-loop-wiggle", "the pointer switches the hover layer on");
  await page.mouse.move(900, 700);
  assert.deepEqual(await names("hover"), ["site-spin"], "and leaving switches it off");

  // An entrance must not start again because the pointer arrived: an
  // animation whose name stays in the list carries on where it was.
  const before = await page.locator("#both").evaluate((element) => element.getAnimations().find((animation) => animation.animationName === "dw-enter-fade")?.currentTime ?? -1);
  await page.waitForTimeout(250);
  await over("both");
  await page.waitForTimeout(150);
  const after = await page.locator("#both").evaluate((element) => element.getAnimations().find((animation) => animation.animationName === "dw-enter-fade")?.currentTime ?? -1);
  assert.ok(before >= 0 && after > before + 200, `hovering does not restart the entrance (${before} → ${after})`);
  assert.equal((await names("both"))[3], "dw-enter-zoom", "while the hover layer plays beside it");
  await page.mouse.move(900, 700);

  await over("click");
  assert.deepEqual(await names("click"), ["none"], "a click interaction does nothing until it is pressed");
  await page.mouse.down();
  assert.equal((await names("click"))[4], "dw-enter-zoom", "pressing switches the click layer on");
  await page.mouse.up();
  await page.mouse.move(900, 700);

  /* ------------------------------------------------------- the numbers it reads */
  // Read on the animation's own clock, not the wall's. This used to sample the
  // element whenever the line above had finished and expect 29–30px, which is
  // "early in a 100-second animation" on a fast machine; a slower one got there
  // later and read 28.7. The animation has to be running by itself first —
  // a custom effect that never started fails here — and is then held at its
  // first and last moments, where the element's own numbers are the answer
  // exactly, whatever the machine.
  const custom = (at) => page.locator("#custom").evaluate((element, time) => {
    const animation = element.getAnimations().find((candidate) => candidate.animationName === "dw-fx-custom-enter");
    if (!animation) return null;
    const running = animation.playState === "running" && Number(animation.currentTime) > 0;
    animation.pause();
    animation.currentTime = time === "end" ? Number(animation.effect.getComputedTiming().endTime) : time;
    const computed = getComputedStyle(element);
    return { running, opacity: computed.opacity, transform: computed.transform };
  }, at);
  const start = await custom(0);
  assert.ok(start?.running, "a custom effect plays on its own");
  assert.equal(start.opacity, "0.25", "it starts from the element's own opacity");
  assert.equal(start.transform, "matrix(1, 0, 0, 1, 30, 0)", "and its own transform");
  const end = await custom("end");
  assert.equal(end.opacity, "1", "and ends on the element's own numbers");
  assert.equal(end.transform, "matrix(1, 0, 0, 1, 0, 0)");
  await page.waitForTimeout(300);
  assert.equal(await style("out", "opacity"), "0", "an Out effect ends hidden and stays there");
  assert.equal((await style("thrice", "animationIterationCount")).split(",")[0].trim(), "3", "a repeat count is honoured");

  /* ------------------------------------------------- per screen, reduced motion */
  assert.equal((await names("phone"))[0], "dw-enter-fade", "an interaction switched off on phones still plays on desktop");
  await page.setViewportSize({ width: 390, height: 800 });
  assert.equal((await names("phone"))[0], "none", "and not on a phone");
  assert.equal((await names("load"))[0], "dw-enter-up", "while others carry on there");
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const id of ["load", "combo", "loop", "scroll", "both"]) assert.deepEqual(await names(id), ["none"], `${id} stops for reduced motion`);
  assert.deepEqual(await names("plain"), ["site-spin"], "the site's own animation is the site's business");
  // A hover interaction simply does not exist for this visitor: the element is
  // left as the site made it, at rest and under the pointer alike.
  assert.deepEqual(await names("hover"), ["site-spin"], "a hover interaction never stops the site's own animation at rest");
  await over("hover");
  assert.deepEqual(await names("hover"), ["site-spin"], "nor while hovered, for somebody who asked for less motion");
  await page.mouse.move(900, 700);

  assert.deepEqual(errors, []);
  console.log("motionRules: published entrances, loops and scroll effects as layers, loop waits for the entrance, hover and click switch on and off without restarting the entrance or touching site animations, custom keyframes read the element's numbers, Out stays hidden, per-screen switches and reduced motion passed in Chromium.");
} finally {
  await browser.close();
}
