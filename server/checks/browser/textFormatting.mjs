import assert from "node:assert/strict";

/**
 * The formatting toggles, in a real browser, judged by computed style.
 *
 * Bold used to only ever write `font-weight: 700`, so nothing could take it off
 * again, and "clear formatting" wrote `normal` over everything rather than
 * removing anything — colour and highlight could never be cleared at all. These
 * are the round trips a person makes: on, off, and back to the HTML they
 * started with. Computed style, not the attribute, because a heading is bold
 * from its own CSS and the attribute says nothing about that.
 */
const { chromium } = await import(process.env.PLAYWRIGHT_URL ?? "playwright");
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
  await page.goto("http://127.0.0.1:5199/builder-harness.html?interaction");
  await page.locator("[contenteditable=true]").first().waitFor();

  const results = await page.evaluate(async () => {
    const lib = await import("/src/lib/websiteTextSelection.ts");
    const stage = document.createElement("div");
    document.body.appendChild(stage);
    /** Builds `html`, selects `words` (the nth occurrence across text nodes), runs actions, reports. */
    const run = (html, words, actions, occurrence = 0) => {
      stage.innerHTML = html;
      const root = stage.firstElementChild;
      const text = root.textContent;
      let from = -1;
      for (let i = 0; i <= occurrence; i += 1) from = text.indexOf(words, from + 1);
      if (from < 0) throw new Error(`"${words}" is not in ${html}`);
      const to = from + words.length;
      const walker = document.createTreeWalker(root, 4);
      const range = document.createRange();
      let seen = 0;
      let started = false;
      let node;
      while ((node = walker.nextNode())) {
        const end = seen + node.length;
        if (!started && from < end) { range.setStart(node, from - seen); started = true; }
        if (started && to <= end) { range.setEnd(node, to - seen); break; }
        seen = end;
      }
      let current = range;
      const states = [];
      for (const action of actions) {
        const next = lib.applyTextFormat(root, current, action);
        if (!next) throw new Error(`no range after ${JSON.stringify(action)}`);
        if (next.toString() !== words) throw new Error(`range drifted: "${next.toString()}"`);
        current = next;
        states.push(lib.textFormatState(root, current));
      }
      const firstText = current.startContainer.parentElement;
      return {
        html: root.innerHTML,
        states,
        weight: getComputedStyle(firstText).fontWeight,
        style: getComputedStyle(firstText).fontStyle,
        background: getComputedStyle(firstText).backgroundColor,
      };
    };
    const bold = { kind: "toggle", format: "bold" };
    const italic = { kind: "toggle", format: "italic" };
    const underline = { kind: "toggle", format: "underline" };
    const clear = { kind: "clear" };
    const highlight = { kind: "set", styles: { "background-color": lib.DEFAULT_HIGHLIGHT } };
    return {
      boldOn: run("<p>Make your next idea real.</p>", "your next", [bold]),
      boldRoundTrip: run("<p>Make your next idea real.</p>", "your next", [bold, bold]),
      partOfBoldSpan: run('<p><span style="font-weight: 700;">alpha beta gamma</span></p>', "beta", [bold]),
      strongUnwrapped: run("<p>x <strong>bold words</strong> y</p>", "bold words", [bold]),
      headingOff: run('<h2 style="font-weight: 800;">Big title here</h2>', "title", [bold]),
      headingOffOn: run('<h2 style="font-weight: 800;">Big title here</h2>', "title", [bold, bold]),
      italicRoundTrip: run("<p>one two three</p>", "two", [italic, italic]),
      underlineRoundTrip: run("<p>one two three</p>", "two", [underline, underline]),
      mixedSelection: run("<p>plain <b>strong</b> plain</p>", "plain strong", [bold]),
      highlightThenClear: run("<p>keep this marked</p>", "this", [highlight, bold, clear]),
      clearPartOfHighlight: run('<p><span style="background-color: rgb(253, 224, 71);">all of it</span></p>', "of", [clear]),
      formatTextRangeStillSets: (() => {
        stage.innerHTML = "<p>colour me</p>";
        const root = stage.firstElementChild;
        const range = document.createRange();
        range.setStart(root.firstChild, 0);
        range.setEnd(root.firstChild, 6);
        lib.formatTextRange(root, range, { color: "#008000" });
        return root.innerHTML;
      })(),
    };
  });

  assert.equal(results.boldOn.weight, "700");
  assert.equal(results.boldOn.states[0].bold, true, "the Bold button shows pressed over bold words");
  assert.equal(results.boldRoundTrip.html, "Make your next idea real.", "Bold pressed twice puts the words back exactly");
  assert.equal(results.boldRoundTrip.weight, "400");
  assert.equal(results.boldRoundTrip.states[1].bold, false);
  assert.equal(results.partOfBoldSpan.html, '<span style="font-weight: 700;">alpha </span>beta<span style="font-weight: 700;"> gamma</span>', "unbolding one word leaves its neighbours bold");
  assert.equal(results.partOfBoldSpan.weight, "400");
  assert.equal(results.strongUnwrapped.html, "x bold words y", "a bare <strong> around the words is removed");
  assert.equal(results.headingOff.weight, "400", "a heading's own bold can be switched off");
  assert.match(results.headingOff.html, /<span style="font-weight: 400;">title<\/span>/);
  assert.equal(results.headingOffOn.html, "Big title here", "off and on again in a heading leaves no override behind");
  assert.equal(results.headingOffOn.weight, "800");
  assert.equal(results.italicRoundTrip.html, "one two three");
  assert.equal(results.underlineRoundTrip.states[0].underline, true);
  assert.equal(results.underlineRoundTrip.html, "one two three");
  assert.equal(results.mixedSelection.states[0].bold, true, "half-bold words become all bold, not all regular");
  assert.equal(results.highlightThenClear.html, "keep this marked", "clear takes highlight and bold off");
  assert.equal(results.highlightThenClear.background, "rgba(0, 0, 0, 0)");
  assert.equal(
    results.clearPartOfHighlight.html,
    '<span style="background-color: rgb(253, 224, 71);">all </span>of<span style="background-color: rgb(253, 224, 71);"> it</span>',
    "clearing one word keeps the rest of the highlight",
  );
  assert.equal(results.formatTextRangeStillSets, '<span style="color: rgb(0, 128, 0);">colour</span> me');
  assert.deepEqual(errors, []);
  console.log("textFormatting browser: bold/italic/underline toggle off, partial unbold, heading bold off and back, clear removes highlight and colour, passed.");
} finally {
  await browser.close();
}
