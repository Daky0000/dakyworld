import assert from "node:assert/strict";

/**
 * Dragging a button's background opacity, through the real editor and the real
 * colour picker, on the button shapes imported pages actually carry.
 *
 * Reported 10 Nov 2026 on the Ghacem demo: every button there is
 * `background-color: #DAA563 !important`, the picker could not read a value
 * with the flag on, fell back to its default navy, and dragging opacity painted
 * the button translucent navy instead of fading the gold. Asserted on the
 * computed style, never the attribute.
 */
const { chromium } = await import(process.env.PLAYWRIGHT_URL ?? "playwright");
const browser = await chromium.launch({ headless: true });
const capabilities = Object.fromEntries(["view", "edit", "review", "publish", "manage", "members", "source"].map((key) => [key, true]));
const structure = { remove: true, duplicate: true };

const CASES = [
  {
    name: "inline !important (the Ghacem buttons)",
    inline: "background-color: #DAA563 !important; border-color: #DAA563 !important; color: #141317 !important; font-weight: 600;",
    css: ".button{display:inline-block;padding:14px 22px;background-color:#222 !important}",
    want: "rgba(218, 165, 99, 0.5)",
    keeps: ["background-color: rgba(218, 165, 99, 0.5) !important", "border-color: #DAA563 !important", "color: #141317 !important"],
  },
  { name: "the site's own class", inline: "", css: ".button{display:inline-block;padding:14px 22px;background:#D4FF00}", want: "rgba(212, 255, 0, 0.5)" },
  { name: "a named colour", inline: "background-color: white", css: ".button{display:inline-block;padding:14px 22px}", want: "rgba(255, 255, 255, 0.5)" },
  { name: "a CSS variable", inline: "", css: ":root{--lime:#D4FF00}.button{display:inline-block;padding:14px 22px;background-color:var(--lime)}", want: "rgba(212, 255, 0, 0.5)" },
];

try {
  for (const example of CASES) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const document = {
      site: { id: "demo", name: "Demo website", publicUrl: "https://example.com", repo: "demo/site" },
      links: [{ path: "/contact", title: "Contact" }],
      readFrom: "imported file",
      page: { id: "one", title: "Home", path: "/", filePath: "index.html", status: "LIVE", url: "https://example.com", lastPublishedAt: null },
      sections: [{ id: "hero", label: "Hero", kind: "section", fields: [
        { id: "hero.title", kind: "text", tag: "h1", value: "Welcome", preview: "Welcome", label: "Main heading", order: 0, href: "", structure },
        { id: "hero.cta", kind: "button", tag: "a", value: "Get started", preview: "Get started", label: "Button", order: 1, href: "/contact", newTab: false, structure, style: example.inline },
      ] }],
      draft: { revision: 0, savedAt: null, savedBy: null, values: {} },
      problems: [],
    };
    await page.route("**/api/**", (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith("/presence")) return route.fulfill({ json: { editors: [] } });
      if (url.pathname.endsWith("/review-links")) return route.fulfill({ json: { links: [] } });
      if (url.pathname.endsWith("/draft")) {
        const payload = route.request().postDataJSON();
        document.draft = { ...document.draft, values: payload?.values ?? {}, revision: document.draft.revision + 1, savedAt: new Date().toISOString() };
        return route.fulfill({ json: { revision: document.draft.revision, problems: [], unknown: [] } });
      }
      if (url.pathname.endsWith("/auth/me")) return route.fulfill({ json: { id: "tester", name: "Client", external: true, permissions: [], uiState: { tours: { editor: { status: "dismissed", at: "2026-10-07T00:00:00.000Z" } } } } });
      if (url.pathname.endsWith("/access")) return route.fulfill({ json: { capabilities } });
      if (url.pathname.endsWith("/assets")) return route.fulfill({ json: [] });
      if (url.pathname.endsWith("/design")) return route.fulfill({ json: { options: { colours: [], fonts: [], presets: [], aiEnabled: true } } });
      if (url.pathname.includes("/preview")) {
        return route.fulfill({
          contentType: "text/html",
          body: `<html><head><style>${example.css}</style></head><body style="margin:0;background:#f4f0e8;font-family:Arial;padding:60px"><h1 data-dw-field="hero.title">Welcome</h1><a class="button" data-dw-field="hero.cta" style="${example.inline}" href="/contact">Get started</a></body></html>`,
        });
      }
      return route.fulfill({ json: document });
    });
    const button = () => page.frameLocator('iframe[title="Page"]').locator('a[data-dw-field="hero.cta"]');
    const inspector = () => page.getByRole("complementary", { name: "Element inspector" });

    await page.goto("http://127.0.0.1:5199/builder-harness.html?editor");
    await page.getByRole("navigation", { name: "Tools" }).waitFor();
    await button().waitFor();
    await button().evaluate(() => parent.postMessage({ source: "dakyworld-preview", type: "select", id: "hero.cta" }, location.origin));
    await inspector().waitFor();
    await inspector().getByRole("tab", { name: "Style", exact: true }).click();
    const section = page.locator('.dx-style [data-section="background"]');
    if (!(await section.evaluate((details) => details.open))) await section.locator(":scope > summary").click();
    // The tooltip layer moves `title` to `data-tip` on hover; the accessible name stays.
    await section.locator('button[aria-label^="Background color ("], button[title^="Background color ("]').first().click();
    await page.getByText("Color Picker").waitFor();
    // The popover places itself after its first paint.
    await page.waitForTimeout(300);
    const alpha = page.locator("div.fixed.z-\\[9999\\] div.relative.h-2\\.5").nth(1);
    const box = await alpha.boundingBox();
    await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2);
    await page.mouse.down();
    for (let step = 1; step <= 10; step += 1) await page.mouse.move(box.x + box.width * (1 - step * 0.05), box.y + box.height / 2);
    await page.mouse.up();

    const shown = await button().evaluate((element) => getComputedStyle(element).backgroundColor);
    assert.equal(shown, example.want, `${example.name}: dragging opacity to half fades the button's own colour`);
    const inline = await button().evaluate((element) => element.getAttribute("style") ?? "");
    for (const part of example.keeps ?? []) assert.ok(inline.includes(part), `${example.name}: the style keeps "${part}" — got ${inline}`);
    assert.deepEqual(errors, [], `${example.name}: no page errors`);
    await page.close();
  }
  console.log(`colourOpacity: opacity drag fades the button's own colour for ${CASES.map((example) => example.name).join(", ")}; !important is kept where it was.`);
} finally {
  await browser.close();
}
