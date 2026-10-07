import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
const { chromium } = await import(process.env.PLAYWRIGHT_URL ?? "playwright");
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
const writes = [];
page.on("pageerror", error => errors.push(error.message));
const capabilities = Object.fromEntries(["view", "edit", "review", "publish", "manage", "members", "source"].map(key => [key, true]));
const document = { site: { id: "demo", name: "Demo website", publicUrl: "https://example.com", repo: "demo/site" }, links: [], readFrom: "imported file", page: { id: "one", title: "Home", path: "/", filePath: "index.html", status: "LIVE", url: "https://example.com", lastPublishedAt: null }, sections: [{ id: "hero", label: "Hero", kind: "section", fields: [{ id: "hero.title", kind: "text", tag: "h1", value: "Welcome home", preview: "Welcome home", label: "Main heading", order: 0 }] }], draft: { revision: 0, savedAt: null, savedBy: null, values: {} }, problems: [] };
await page.route("**/api/**", route => {
  const url = new URL(route.request().url());
  // Presence leases are expected on mount; all other writes remain subject to the assertions below.
  if (url.pathname.endsWith("/presence")) return route.fulfill({ json: { editors: [] } });
  // Remembering which tours somebody has seen is not a change to the page.
  if (route.request().method() !== "GET" && !url.pathname.endsWith("/auth/ui-state")) writes.push(url.pathname);
  if (url.pathname.endsWith("/auth/me")) return route.fulfill({ json: { id: "tester", name: "Client", external: true, permissions: [] } });
  if (url.pathname.endsWith("/access")) return route.fulfill({ json: { capabilities } });
  if (url.pathname.endsWith("/assets")) return route.fulfill({ json: [] });
  if (url.pathname.endsWith("/design")) return route.fulfill({ json: { options: { colours: [], fonts: [], presets: [], aiEnabled: false } } });
  if (url.pathname.includes("/preview")) return route.fulfill({ contentType: "text/html", body: '<html><body style="margin:0;background:#f4f0e8;font-family:Arial;padding:60px"><h1 data-dw-field="hero.title" style="font-size:64px">Welcome home</h1><p>A quiet space to make your next idea real.</p></body></html>' });
  return route.fulfill({ json: document });
});
try {
  await page.goto("http://127.0.0.1:5199/builder-harness.html?editor");
  await page.getByRole("navigation", { name: "Tools", exact: true }).waitFor();
  // The editor offers its tour once, to somebody who has never seen it.
  await page.getByRole("region", { name: "Editor basics tour" }).waitFor();
  await page.getByRole("button", { name: "Not now", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "Versions", exact: true }).isVisible(), false);
  await page.getByRole("button", { name: "More publish options", exact: true }).click();
  await page.getByRole("menuitem", { name: "Versions", exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Account and editor settings", exact: true }).click();
  await page.getByLabel("Designer controls", { exact: true }).check();
  assert.equal(await page.getByLabel("Designer controls", { exact: true }).isChecked(), true);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Phone", exact: true }).click();
  await page.getByRole("button", { name: /^Editor mode/ }).click();
  await page.getByRole("menuitemradio", { name: "Preview", exact: true }).click();
  assert.equal(writes.length, 0, "Opening controls and changing preview must not mutate the draft");
  await page.getByRole("button", { name: /^Editor mode/ }).click();
  await page.getByRole("menuitemradio", { name: "Visual", exact: true }).click();
  await page.getByRole("button", { name: "Desktop", exact: true }).click();
  await mkdir("checks/artifacts", { recursive: true });
  await page.screenshot({ path: "checks/artifacts/builder-editor.png", fullPage: true });
  await page.reload();
  await page.getByRole("button", { name: "Account and editor settings", exact: true }).click();
  assert.equal(await page.getByLabel("Designer controls", { exact: true }).isChecked(), true);
  await page.waitForTimeout(1500);
  assert.equal(await page.getByRole("region", { name: "Editor basics tour" }).count(), 0, "A tour offer put away stays put away");
  assert.deepEqual(errors, []);
  console.log("builderEditor: assembled editor toolbar, mode persistence, guide dismissal, preview switching and zero incidental writes passed.");
} finally { await browser.close(); }
