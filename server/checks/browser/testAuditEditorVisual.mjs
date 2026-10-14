import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
const { chromium } = await import(process.env.PLAYWRIGHT_URL ?? "playwright");
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
page.on("console", msg => console.log("[BROWSER CONSOLE]", msg.type(), msg.text()));

const capabilities = Object.fromEntries(["view", "edit", "review", "publish", "manage", "members", "source"].map(key => [key, true]));
const document = { site: { id: "demo", name: "Demo website", publicUrl: "https://example.com", repo: "demo/site" }, links: [], readFrom: "imported file", page: { id: "one", title: "Home", path: "/", filePath: "index.html", status: "LIVE", url: "https://example.com", lastPublishedAt: null }, sections: [{ id: "hero", label: "Hero", kind: "section", fields: [{ id: "hero.title", kind: "text", tag: "h1", value: "Strategic Consulting & Audit for Modern African Enterprises.", preview: "Strategic Consulting & Audit for Modern African Enterprises.", label: "Main heading", order: 0 }] }], draft: { revision: 0, savedAt: null, savedBy: null, values: {} }, problems: [] };

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
  if (url.pathname.includes("/preview")) return route.fulfill({ contentType: "text/html", body: '<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script><style>body { font-size: 1rem; } h1 { font-size: clamp(2.5rem, 5.5vw, 4.5rem); line-height: 1.08; color: #ffffff; letter-spacing: -0.03em; } p { color: #94a3b8; }</style></head><body style="margin:0;background:#0a0c10;font-family:Arial;padding:60px"><div class="max-w-4xl mx-auto"><h1 data-dw-field="hero.title" class="font-extrabold tracking-tight text-white mb-6">Strategic Consulting &amp; Audit for Modern African Enterprises.</h1><p class="text-lg text-slate-300 font-light max-w-2xl leading-relaxed">We help corporate boards navigate statutory audit compliance with confidence.</p></div></body></html>' });
  return route.fulfill({ json: document });
});

await mkdir("checks/artifacts", { recursive: true });

const frameH1 = () => page.frameLocator('iframe[title="Page"]').locator("h1");
const computedOf = (property) => frameH1().evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), property);

try {
  await page.goto("http://127.0.0.1:5199/builder-harness.html?editor");
  await page.getByRole("navigation", { name: "Tools" }).waitFor();
  await frameH1().waitFor();
  await frameH1().evaluate(() => parent.postMessage({ source: "dakyworld-preview", type: "select", id: "hero.title" }, location.origin));
  await page.getByRole("tab", { name: "Style", exact: true }).click();
  const panel = page.locator(".dx-style");
  await panel.waitFor();

  // Desktop screenshot
  await page.screenshot({ path: "checks/artifacts/responsive-1-desktop.png" });

  const typography = panel.locator('[data-section="typography"]');
  if (!(await typography.evaluate((details) => details.open))) await typography.locator(":scope > summary").click();
  const fontSizeInput = typography.getByLabel("Font size", { exact: true });

  console.log("Desktop initial font size:", await computedOf("font-size"));
  console.log("Desktop placeholder:", await fontSizeInput.getAttribute("placeholder"));
  console.log("Desktop value:", await fontSizeInput.inputValue());

  // Switch to Phone
  console.log("\nSwitching to Phone...");
  await page.getByRole("button", { name: "Phone" }).click();
  await page.waitForTimeout(500);

  console.log("Phone initial font size:", await computedOf("font-size"));
  console.log("Phone placeholder:", await fontSizeInput.getAttribute("placeholder"));
  console.log("Phone value:", await fontSizeInput.inputValue());
  await page.screenshot({ path: "checks/artifacts/responsive-2-phone-initial.png" });

  // Change font size on phone
  console.log("Changing font size on Phone to 20...");
  await fontSizeInput.fill("20");
  await page.waitForTimeout(500);

  console.log("Phone font size after edit:", await computedOf("font-size"));
  console.log("Phone input value:", await fontSizeInput.inputValue());
  const h1Rect = await frameH1().evaluate(el => ({
    rect: el.getBoundingClientRect(),
    computed: {
      fontSize: getComputedStyle(el).fontSize,
      lineHeight: getComputedStyle(el).lineHeight,
      height: getComputedStyle(el).height
    }
  }));
  const overlayBox = await page.locator(".dx-box-selected, [data-walkthrough='canvas'] [style*='position: absolute']").evaluateAll(nodes => nodes.map(n => ({
    cls: n.className,
    style: n.getAttribute("style"),
    rect: n.getBoundingClientRect()
  })));
  console.log("H1 rect:", JSON.stringify(h1Rect, null, 2));
  console.log("Overlay:", JSON.stringify(overlayBox, null, 2));
  await page.screenshot({ path: "checks/artifacts/responsive-3-phone-after-20.png" });

  // Switch to Tablet
  console.log("\nSwitching to Tablet...");
  await page.getByRole("button", { name: "Tablet" }).click();
  await page.waitForTimeout(500);

  console.log("Tablet font size:", await computedOf("font-size"));
  console.log("Tablet placeholder:", await fontSizeInput.getAttribute("placeholder"));
  console.log("Tablet value:", await fontSizeInput.inputValue());
  await page.screenshot({ path: "checks/artifacts/responsive-4-tablet.png" });

  // Switch to Desktop
  console.log("\nSwitching to Desktop...");
  await page.getByRole("button", { name: "Desktop" }).click();
  await page.waitForTimeout(500);

  console.log("Desktop font size now:", await computedOf("font-size"));
  console.log("Desktop placeholder:", await fontSizeInput.getAttribute("placeholder"));
  console.log("Desktop value:", await fontSizeInput.inputValue());
  await page.screenshot({ path: "checks/artifacts/responsive-5-desktop-again.png" });

} catch (err) {
  console.error("Test failed:", err);
} finally {
  await browser.close();
}
