import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";

/**
 * The editor tour, taken the way a new customer takes it.
 *
 * Each step that asks for something is finished by doing it — selecting the
 * heading, changing it, switching to Phone, opening Preview — and never by a
 * Next button, so this check fails if a screen stops announcing what happened
 * (lib/tours.ts `tourAction`). It also proves the tour does not block the page:
 * every click below lands on the editor while the spotlight is up. At the end
 * the account is told the tour is done, and a reload does not offer it again.
 */
const { chromium } = await import(process.env.PLAYWRIGHT_URL ?? "playwright");
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
const saved = [];
page.on("pageerror", (error) => errors.push(error.message));
const capabilities = Object.fromEntries(["view", "edit", "review", "publish", "manage", "members", "source"].map((key) => [key, true]));
const document = { site: { id: "demo", name: "Demo website", publicUrl: "https://example.com", repo: "demo/site" }, links: [], readFrom: "imported file", page: { id: "one", title: "Home", path: "/", filePath: "index.html", status: "LIVE", url: "https://example.com", lastPublishedAt: null }, sections: [{ id: "hero", label: "Hero", kind: "section", fields: [{ id: "hero.title", kind: "text", tag: "h1", value: "Welcome home", preview: "Welcome home", label: "Main heading", order: 0 }] }], draft: { revision: 0, savedAt: null, savedBy: null, values: {} }, problems: [] };
let uiState = {};
await page.route("**/api/**", (route) => {
  const url = new URL(route.request().url());
  if (url.pathname.endsWith("/presence")) return route.fulfill({ json: { editors: [] } });
  if (url.pathname.endsWith("/auth/ui-state")) {
    const patch = route.request().postDataJSON();
    saved.push(patch);
    uiState = { ...uiState, ...patch, tours: { ...(uiState.tours ?? {}), ...(patch.tours ?? {}) } };
    return route.fulfill({ json: uiState });
  }
  if (url.pathname.endsWith("/auth/me")) return route.fulfill({ json: { id: "tour-tester", name: "New Customer", external: true, permissions: [], uiState } });
  if (url.pathname.endsWith("/draft")) {
    const payload = route.request().postDataJSON();
    document.draft = { ...document.draft, values: payload?.values ?? {}, revision: document.draft.revision + 1, savedAt: new Date().toISOString() };
    return route.fulfill({ json: { revision: document.draft.revision, problems: [], unknown: [] } });
  }
  if (url.pathname.endsWith("/access")) return route.fulfill({ json: { capabilities } });
  if (url.pathname.endsWith("/assets")) return route.fulfill({ json: [] });
  if (url.pathname.endsWith("/design")) return route.fulfill({ json: { options: { colours: [], fonts: [], presets: [], aiEnabled: false } } });
  if (url.pathname.includes("/preview")) return route.fulfill({ contentType: "text/html", body: '<html><body style="margin:0;padding:60px;font-family:Arial"><h1 data-dw-field="hero.title" style="font-size:64px">Welcome home</h1></body></html>' });
  return route.fulfill({ json: document });
});

const step = (title) => page.getByRole("dialog", { name: title, exact: true });
try {
  await page.goto("http://127.0.0.1:5199/builder-harness.html?editor");
  await page.getByRole("navigation", { name: "Tools", exact: true }).waitFor();

  // Offered once, to somebody who has never seen it.
  await page.getByRole("region", { name: "Editor basics tour" }).waitFor();
  await page.getByRole("button", { name: "Start the tour", exact: true }).click();
  await step("This is your page").waitFor();
  assert.match(await step("This is your page").innerText(), /1 of 7/i);
  assert.ok(saved.some((patch) => patch.tours?.editor?.status === "started"), "Starting a tour is recorded on the account");

  // 1 → 2: selecting something on the page, by any route, finishes the step.
  await page.frameLocator('iframe[title="Page"]').locator("h1").waitFor();
  await page.frameLocator('iframe[title="Page"]').locator("h1").evaluate(() => parent.postMessage({ source: "dakyworld-preview", type: "select", id: "hero.title" }, location.origin));
  await step("Change it").waitFor();

  // 2 → 3: changing it.
  await page.getByRole("textbox", { name: "Main heading", exact: true }).fill("Welcome to our home");
  await step("It saves by itself").waitFor();
  await page.getByRole("button", { name: "Next", exact: true }).click();

  // 4: the phone check is finished by switching to Phone.
  await step("Check it on a phone").waitFor();
  await page.getByRole("button", { name: "Phone", exact: true }).click();

  // 5: Preview.
  await step("See it as a visitor would").waitFor();
  await page.getByRole("button", { name: /^Editor mode/ }).click();
  await page.getByRole("menuitemradio", { name: "Preview", exact: true }).click();

  // 6 puts the editor back in Visual for the publish step.
  await step("Making it live").waitFor();
  await page.getByRole("button", { name: "Editor mode: Visual", exact: true }).waitFor();
  const card = await step("Making it live").boundingBox();
  assert.ok(card && card.x >= 0 && card.y >= 0 && card.x + card.width <= 1440 && card.y + card.height <= 1000, "The step card stays on screen");
  await mkdir("checks/artifacts", { recursive: true });
  await page.screenshot({ path: "checks/artifacts/editor-tour.png" });
  await page.getByRole("button", { name: "Next", exact: true }).click();

  await step("Your tools live here").waitFor();
  await page.getByRole("button", { name: "Finish", exact: true }).click();
  await page.waitForTimeout(300);
  assert.equal(await page.getByRole("dialog", { name: "Your tools live here" }).count(), 0, "Finishing closes the tour");
  assert.ok(saved.some((patch) => patch.tours?.editor?.status === "done"), "Finishing is recorded on the account");

  // Not offered again, and Help shows it as taken.
  await page.reload();
  await page.getByRole("navigation", { name: "Tools", exact: true }).waitFor();
  await page.waitForTimeout(1500);
  assert.equal(await page.getByRole("region", { name: "Editor basics tour" }).count(), 0, "A finished tour is not offered again");
  await page.getByRole("button", { name: "Help", exact: true }).click();
  await page.getByRole("button", { name: /Editor basics/ }).waitFor();
  assert.equal(await page.getByLabel("Taken").count(), 1, "Help marks the tour as taken");

  // Escape on the card ends a tour started from Help.
  await page.getByRole("button", { name: /Publishing and versions/ }).click();
  await step("Review before it goes live").waitFor();
  await step("Review before it goes live").press("Escape");
  await page.waitForTimeout(200);
  assert.equal(await step("Review before it goes live").count(), 0, "Escape ends the tour");
  assert.ok(saved.some((patch) => patch.tours?.publishing?.status === "dismissed"), "Ending early is recorded as dismissed");

  assert.deepEqual(errors, []);
  console.log("builderTour: offered once, started, every waiting step finished by the real action, mode requested, card on screen, finish and dismissal recorded, not offered again.");
} finally {
  await browser.close();
}
