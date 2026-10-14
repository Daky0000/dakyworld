import assert from "node:assert/strict";
const { chromium } = await import(process.env.PLAYWRIGHT_URL ?? "playwright");
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
page.on("console", msg => console.log("[BROWSER CONSOLE]", msg.type(), msg.text()));

const capabilities = Object.fromEntries(["view", "edit", "review", "publish", "manage", "members", "source"].map(key => [key, true]));
const document = { site: { id: "demo", name: "Demo website", publicUrl: "https://example.com", repo: "demo/site" }, links: [], readFrom: "imported file", page: { id: "one", title: "Home", path: "/", filePath: "index.html", status: "LIVE", url: "https://example.com", lastPublishedAt: null }, sections: [{ id: "hero", label: "Hero", kind: "section", fields: [{ id: "hero.title", kind: "text", tag: "h1", value: "Welcome home", preview: "Welcome home", label: "Main heading", order: 0 }] }], draft: { revision: 0, savedAt: null, savedBy: null, values: {} }, problems: [] };

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
  if (url.pathname.includes("/preview")) return route.fulfill({ contentType: "text/html", body: '<html><head><script src="https://cdn.tailwindcss.com"></script><style>body { font-size: 1rem; } h1 { font-size: clamp(2.5rem, 5.5vw, 4.5rem); line-height: 1.08; color: #ffffff; letter-spacing: -0.03em; } p { color: #94a3b8; }</style></head><body style="margin:0;background:#0a0c10;font-family:Arial;padding:60px"><h1 data-dw-field="hero.title" class="font-extrabold tracking-tight">Strategic Consulting & Audit for Modern African Enterprises.</h1><p class="text-base sm:text-lg text-slate-300 font-light max-w-2xl leading-relaxed">We help corporate boards navigate statutory audit compliance.</p></body></html>' });
  return route.fulfill({ json: document });
});

const frameH1 = () => page.frameLocator('iframe[title="Page"]').locator("h1");
const computedOf = (property) => frameH1().evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), property);
const spanComputedOf = (property) => page.frameLocator('iframe[title="Page"]').locator("h1 span").evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), property);

try {
  await page.goto("http://127.0.0.1:5199/builder-harness.html?editor");
  await page.getByRole("navigation", { name: "Tools" }).waitFor();
  await frameH1().waitFor();
  await frameH1().evaluate(() => parent.postMessage({ source: "dakyworld-preview", type: "select", id: "hero.title" }, location.origin));
  await page.getByRole("tab", { name: "Style", exact: true }).click();
  const panel = page.locator(".dx-style");
  await panel.waitFor();

  console.log("=== STEP 1: DESKTOP EDIT ===");
  console.log("Initial desktop font-size:", await computedOf("font-size"));
  const typography = panel.locator('[data-section="typography"]');
  if (!(await typography.evaluate((details) => details.open))) await typography.locator(":scope > summary").click();
  const fontSizeInput = typography.getByLabel("Font size", { exact: true });
  console.log("Editing desktop font size to 50...");
  await fontSizeInput.fill("50");
  await page.waitForTimeout(400);
  console.log("Desktop font-size after edit:", await computedOf("font-size"));
  console.log("Element style attribute on desktop:", await frameH1().evaluate(el => el.getAttribute("style")));

  console.log("\n=== STEP 2: SWITCH TO PHONE (MOBILE) ===");
  await page.getByRole("button", { name: "Phone" }).click();
  await page.waitForTimeout(400);
  console.log("Phone font-size before mobile edit:", await computedOf("font-size"));
  console.log("Phone placeholder:", await fontSizeInput.getAttribute("placeholder"));
  console.log("Phone value:", await fontSizeInput.inputValue());

  console.log("Editing phone font size to 24...");
  await fontSizeInput.fill("24");
  await page.waitForTimeout(400);
  console.log("Phone font-size after mobile edit:", await computedOf("font-size"));
  console.log("Element style attribute on phone:", await frameH1().evaluate(el => el.getAttribute("style")));

  console.log("\n=== STEP 3: SWITCH TO TABLET ===");
  await page.getByRole("button", { name: "Tablet" }).click();
  await page.waitForTimeout(400);
  console.log("Tablet font-size before tablet edit:", await computedOf("font-size"));
  console.log("Tablet placeholder:", await fontSizeInput.getAttribute("placeholder"));
  console.log("Tablet value:", await fontSizeInput.inputValue());

  console.log("Editing tablet font size to 32...");
  await fontSizeInput.fill("32");
  await page.waitForTimeout(400);
  console.log("Tablet font-size after tablet edit:", await computedOf("font-size"));

  console.log("\n=== STEP 4: SWITCH BACK TO DESKTOP ===");
  await page.getByRole("button", { name: "Desktop" }).click();
  await page.waitForTimeout(400);
  console.log("Desktop font-size now:", await computedOf("font-size"));

  console.log("Changing font size to 36 on Tablet...");
  await fontSizeInput.fill("36");
  await page.waitForTimeout(400);

  console.log("Tablet computed font-size: h1:", await computedOf("font-size"));

  // Now switch back to Desktop!
  console.log("\n=== SWITCHING BACK TO DESKTOP ===");
  await page.getByRole("button", { name: "Desktop" }).click();
  await page.waitForTimeout(300);

  console.log("Desktop computed font-size: h1:", await computedOf("font-size"));
  console.log("Desktop font size input placeholder:", await fontSizeInput.getAttribute("placeholder"));
  console.log("Desktop font size input value:", await fontSizeInput.inputValue());

  // Now switch to Mobile!
  console.log("\n=== SWITCHING TO PHONE (MOBILE) ===");
  await page.getByRole("button", { name: "Phone" }).click();
  await page.waitForTimeout(300);

  console.log("Mobile computed font-size before edit: h1:", await computedOf("font-size"));
  console.log("Mobile font size input placeholder:", await fontSizeInput.getAttribute("placeholder"));
  console.log("Mobile font size input value:", await fontSizeInput.inputValue());

  console.log("Changing font size to 22 on Phone...");
  await fontSizeInput.fill("22");
  await page.waitForTimeout(400);

  console.log("Mobile computed font-size after edit: h1:", await computedOf("font-size"));

  // Check iframe style tags
  const styles = await page.frameLocator('iframe[title="Page"]').locator("head").evaluate(el => {
    return Array.from(el.querySelectorAll("style")).map(s => ({
      attr: s.getAttributeNames().join(","),
      text: s.textContent.slice(0, 200)
    }));
  });
  console.log("\nIframe <style> tags:", JSON.stringify(styles, null, 2));

} catch (err) {
  console.error("Diagnostic error:", err);
} finally {
  await browser.close();
}
