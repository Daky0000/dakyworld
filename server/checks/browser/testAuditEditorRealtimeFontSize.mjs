import assert from "node:assert/strict";
const { chromium } = await import(process.env.PLAYWRIGHT_URL ?? "playwright");
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
page.on("console", msg => console.log("[BROWSER CONSOLE]", msg.type(), msg.text()));

const capabilities = Object.fromEntries(["view", "edit", "review", "publish", "manage", "members", "source"].map(key => [key, true]));
const document = {
  site: { id: "demo", name: "Demo website", publicUrl: "https://example.com", repo: "demo/site" },
  links: [],
  readFrom: "imported file",
  page: { id: "one", title: "Home", path: "/", filePath: "index.html", status: "LIVE", url: "https://example.com", lastPublishedAt: null },
  sections: [
    {
      id: "0",
      label: "Hero",
      kind: "section",
      fields: [
        {
          id: "0.0",
          kind: "richtext",
          tag: "h1",
          value: '<span class="text-4xl text-indigo-500 font-extrabold">Next-Gen Cloud Infrastructure</span>',
          preview: "Next-Gen Cloud Infrastructure",
          label: "Main heading",
          order: 0
        }
      ]
    }
  ],
  draft: { revision: 0, savedAt: null, savedBy: null, values: {} },
  problems: []
};

await page.route("**/api/**", route => {
  const url = new URL(route.request().url());
  if (url.pathname.endsWith("/presence")) return route.fulfill({ json: { editors: [] } });
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
      body: '<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script><style>body { font-size: 16px; margin: 0; padding: 40px; background: #0b0f19; color: #fff; font-family: sans-serif; } h1 { line-height: 1.1; margin: 0 0 20px; }</style></head><body><div class="max-w-2xl"><h1 data-dw-field="0.0" class="tracking-tight"><span class="text-4xl text-indigo-500 font-extrabold">Next-Gen Cloud Infrastructure</span></h1><p class="text-lg text-slate-300">Scale without limits.</p></div></body></html>'
    });
  }
  return route.fulfill({ json: document });
});

const frameH1 = () => page.frameLocator('iframe[title="Page"]').locator('h1[data-dw-field="0.0"]');
const frameSpan = () => page.frameLocator('iframe[title="Page"]').locator('h1[data-dw-field="0.0"] span');

const getH1FontSize = () => frameH1().evaluate(el => window.getComputedStyle(el).fontSize);
const getSpanFontSize = () => frameSpan().evaluate(el => window.getComputedStyle(el).fontSize);

try {
  await page.goto("http://127.0.0.1:5199/builder-harness.html?editor");
  await page.getByRole("navigation", { name: "Tools" }).waitFor();
  await frameH1().waitFor();
  await frameSpan().waitFor();

  console.log("=== Initial Desktop State ===");
  const initialH1Size = await getH1FontSize();
  const initialSpanSize = await getSpanFontSize();
  console.log("H1 font size:", initialH1Size);
  console.log("Span font size:", initialSpanSize);
  // In Tailwind, text-4xl is 36px (2.25rem * 16px)
  assert.equal(initialSpanSize, "36px", "Span should initially have Tailwind text-4xl (36px)");

  // Select the heading field 0.0
  await frameH1().evaluate(() => parent.postMessage({ source: "dakyworld-preview", type: "select", id: "0.0" }, location.origin));
  await page.getByRole("tab", { name: "Style", exact: true }).click();
  const panel = page.locator(".dx-style");
  await panel.waitFor();

  const typography = panel.locator('[data-section="typography"]');
  if (!(await typography.evaluate(details => details.open))) {
    await typography.locator(":scope > summary").click();
  }
  const fontSizeInput = typography.getByLabel("Font size", { exact: true });
  await fontSizeInput.waitFor();

  // -------------------------------------------------------------
  // Test 1: Switch to Phone (Mobile) and change font size to 20px
  // -------------------------------------------------------------
  console.log("\n=== Switching to Phone (Mobile) ===");
  await page.getByRole("button", { name: "Phone" }).click();
  await page.waitForTimeout(300);

  console.log("Changing mobile font size to 20px...");
  await fontSizeInput.fill("20");
  await page.waitForTimeout(400);

  const mobileH1Size = await getH1FontSize();
  const mobileSpanSize = await getSpanFontSize();
  console.log("Mobile H1 font size:", mobileH1Size);
  console.log("Mobile Span font size:", mobileSpanSize);
  assert.equal(mobileH1Size, "20px", "H1 font-size must be 20px in real time on mobile");
  assert.equal(mobileSpanSize, "20px", "Span font-size must cascade to 20px in real time on mobile");

  // Check that the style sheet was also injected for 0.0
  const previewSheet = await page.frameLocator('iframe[title="Page"]').locator('style[data-dw-responsive-preview="0.0"]').textContent();
  console.log("Injected responsive preview sheet:", previewSheet.trim().replace(/\s+/g, " "));
  assert.ok(previewSheet.includes("0.0"), "Responsive preview stylesheet must target 0.0");
  assert.ok(previewSheet.includes("20px"), "Responsive preview stylesheet must include 20px override");

  // -------------------------------------------------------------
  // Test 2: Switch to Tablet and change font size to 28px
  // -------------------------------------------------------------
  console.log("\n=== Switching to Tablet ===");
  await page.getByRole("button", { name: "Tablet" }).click();
  await page.waitForTimeout(300);

  console.log("Changing tablet font size to 28px...");
  await fontSizeInput.fill("28");
  await page.waitForTimeout(400);

  const tabletH1Size = await getH1FontSize();
  const tabletSpanSize = await getSpanFontSize();
  console.log("Tablet H1 font size:", tabletH1Size);
  console.log("Tablet Span font size:", tabletSpanSize);
  assert.equal(tabletH1Size, "28px", "H1 font-size must be 28px in real time on tablet");
  assert.equal(tabletSpanSize, "28px", "Span font-size must cascade to 28px in real time on tablet");

  // -------------------------------------------------------------
  // Test 3: Switch back to Desktop - should restore 36px
  // -------------------------------------------------------------
  console.log("\n=== Switching back to Desktop ===");
  await page.getByRole("button", { name: "Desktop" }).click();
  await page.waitForTimeout(300);

  const restoredSpanSize = await getSpanFontSize();
  console.log("Restored Desktop Span font size:", restoredSpanSize);
  assert.equal(restoredSpanSize, "36px", "Desktop span must restore to original 36px font-size");

  // -------------------------------------------------------------
  // Test 4: Switch back to Phone - should instantly re-apply 20px
  // -------------------------------------------------------------
  console.log("\n=== Switching back to Phone ===");
  await page.getByRole("button", { name: "Phone" }).click();
  await page.waitForTimeout(300);

  const reMobileSpanSize = await getSpanFontSize();
  console.log("Re-applied Phone Span font size:", reMobileSpanSize);
  assert.equal(reMobileSpanSize, "20px", "Phone span must instantly re-apply 20px font-size");

  // -------------------------------------------------------------
  // Test 5: Switch back to Tablet - should instantly re-apply 28px
  // -------------------------------------------------------------
  console.log("\n=== Switching back to Tablet ===");
  await page.getByRole("button", { name: "Tablet" }).click();
  await page.waitForTimeout(300);

  const reTabletSpanSize = await getSpanFontSize();
  console.log("Re-applied Tablet Span font size:", reTabletSpanSize);
  assert.equal(reTabletSpanSize, "28px", "Tablet span must instantly re-apply 28px font-size");

  console.log("\nALL REAL-TIME RESPONSIVE FONT SIZE AUDIT CHECKS PASSED!");
} catch (err) {
  console.error("Test failed:", err);
  throw err;
} finally {
  await browser.close();
}
