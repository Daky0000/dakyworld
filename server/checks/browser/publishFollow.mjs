import assert from "node:assert/strict";
const { chromium } = await import(process.env.PLAYWRIGHT_URL ?? "playwright");

/**
 * After a publish to a site a host rebuilds, the corner toast keeps following
 * the publish (Phase 0 of the publish router plan, 20 Oct 2026).
 *
 * On 19 Oct 2026 a GitHub incident held a GitHub Pages rebuild for forty
 * minutes and the editor said nothing at all after its first eight seconds. The
 * server now knows when GitHub is the hold-up and when the host is merely late;
 * this checks that the editor actually says so, keeps saying it until it is
 * dismissed, and then says when the change went live and how long it took.
 */
const ORIGIN = "http://127.0.0.1:5199";
const GITHUB = "GitHub is having problems right now. Your change is saved and will appear when they recover. No need to publish again.";
const LATE = "Your host hasn't updated yet. We'll keep checking.";
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const errors = [];

const capabilities = Object.fromEntries(["view", "edit", "review", "publish", "manage", "members", "source"].map((key) => [key, true]));
const document = {
  site: { id: "demo", name: "Demo website", publicUrl: "https://example.com", repo: "demo/site" }, links: [], readFrom: "imported file", drawnByScript: false,
  page: { id: "one", title: "Home", path: "/", filePath: "index.html", status: "LIVE", url: "https://example.com", lastPublishedAt: null },
  sections: [{ id: "hero", label: "Hero", kind: "section", fields: [{ id: "hero.title", kind: "text", tag: "h1", value: "Welcome home", preview: "Welcome home", label: "Main heading", order: 0, structure: { remove: true, duplicate: true, move: true, group: "main" } }] }],
  draft: { revision: 0, savedAt: null, savedBy: null, values: {} }, problems: [],
};
const PREVIEW = '<html><body style="margin:0;padding:60px;font-family:Arial"><h1 data-dw-field="hero.title" style="font-size:64px">Welcome home</h1></body></html>';

/** What the server says about the publish, changed as the check goes. */
let job = null;
const jobAsked = [];
let publishes = 0;

const page = await context.newPage();
page.on("pageerror", (error) => errors.push(error.message));
await page.route("**/api/**", (route) => {
  const url = new URL(route.request().url());
  if (url.pathname.endsWith("/presence")) return route.fulfill({ json: { editors: [] } });
  if (url.pathname.endsWith("/draft")) return route.fulfill({ json: { revision: 0, problems: [], unknown: [] } });
  if (url.pathname.endsWith("/review")) return route.fulfill({ json: { revision: 0, sourceHash: "fixture", summary: [], problems: [], conflicts: [], missing: [], publishable: true } });
  if (url.pathname.endsWith("/publish")) {
    publishes += 1;
    return route.fulfill({ json: { job: { id: `job-${publishes}`, state: "DEPLOYING" }, version: 1, changed: 1, summary: [], touched: { text: true, links: false, images: false, styles: false, seo: false }, commit: { sha: "20a09f5", url: "https://github.com/demo/site/commit/20a09f5" }, url: "https://example.com/", hosted: false, mode: "commit", note: "" } });
  }
  if (url.pathname.endsWith(`/website/sites/demo/publish-jobs/job-${publishes}`)) {
    jobAsked.push(Date.now());
    return route.fulfill({ json: { ...job, id: `job-${publishes}` } });
  }
  if (url.pathname.endsWith("/auth/me")) {
    const dismissed = { status: "dismissed", at: "2026-10-07T00:00:00.000Z" };
    return route.fulfill({ json: { id: "tester", name: "Client", external: true, permissions: [], uiState: { tours: { editor: dismissed, "publish-delay-notice": dismissed } } } });
  }
  if (url.pathname.endsWith("/access")) return route.fulfill({ json: { capabilities } });
  if (url.pathname.endsWith("/assets")) return route.fulfill({ json: [] });
  if (url.pathname.endsWith("/design")) return route.fulfill({ json: { options: { colours: [], fonts: [], presets: [], aiEnabled: true } } });
  if (url.pathname.includes("/preview")) return route.fulfill({ contentType: "text/html", body: PREVIEW });
  return route.fulfill({ json: document });
});

let passed = 0;
const check = (label, condition, detail = "") => { assert.ok(condition, `${label}${detail ? ` — ${detail}` : ""}`); passed += 1; };
const toast = () => page.locator('[role="status"].fixed');
const status = (state, extra = {}) => ({ id: "job-1", kind: "PAGE", state, label: state, verifyUrl: "https://example.com/", attempts: 1, lastError: null, deployedInSeconds: null, notice: null, late: false, createdAt: new Date().toISOString(), ...extra });

try {
  await page.goto(`${ORIGIN}/builder-harness.html?editor`);
  await page.getByRole("button", { name: "Layers", exact: true }).click();
  await page.getByRole("treeitem", { name: /Welcome home/ }).click();
  await page.keyboard.press("Escape");

  /* ------------------------------------------- GitHub is the hold-up */
  job = status("VERIFYING", { notice: GITHUB, label: GITHUB });
  await page.keyboard.press("Control+Enter");
  await toast().getByText(GITHUB).waitFor({ timeout: 10_000 });
  check("a publish held up by GitHub says so", true);
  check("the editor asked the server about this publish", jobAsked.length >= 1);
  // The plain "Changes sent" note goes after eight seconds. This one must not.
  await page.waitForTimeout(9_000);
  check("and the notice is still there after the first note would have gone", await toast().getByText(GITHUB).isVisible());
  check("the editor kept asking while it waited", jobAsked.length >= 2, String(jobAsked.length));

  /* ------------------------------------------------- it goes live */
  job = status("COMPLETED", { label: "Live", deployedInSeconds: 41 * 60, verifiedAt: new Date().toISOString() });
  await toast().getByText("Your changes are live · took 41 min").waitFor({ timeout: 15_000 });
  check("then says it went live, and how long the host took", true);
  check("with the way to look at it", await toast().getByRole("link", { name: "Open the live page" }).isVisible());
  const asked = jobAsked.length;
  await page.waitForTimeout(6_000);
  check("and stops asking once it is live", jobAsked.length === asked, `${asked} then ${jobAsked.length}`);
  await toast().getByRole("button", { name: "Dismiss" }).click();
  check("and goes when dismissed", (await toast().count()) === 0);

  /* ------------------------------------- what the host says it is doing */
  job = status("VERIFYING", { stage: "building" });
  await page.keyboard.press("Control+Enter");
  await toast().getByText("Your host is building your site").waitFor({ timeout: 10_000 });
  check("while the host builds, the toast says so", true);
  job = status("DEPLOY_FAILED", { label: "The host did not rebuild", hostMessage: "Build script returned non-zero exit code: 2" });
  await toast().getByText("Your host said: Build script returned non-zero exit code: 2").waitFor({ timeout: 15_000 });
  check("and a failed build is reported in the host's own words", true);
  await toast().getByRole("button", { name: "Dismiss" }).click();

  /* ------------------------------------------- the host is late */
  job = status("VERIFYING", { late: true, label: LATE, createdAt: new Date(Date.now() - 2 * 60 * 60_000 - 60_000).toISOString() });
  await page.keyboard.press("Control+Enter");
  await toast().getByText(LATE).waitFor({ timeout: 10_000 });
  check("a host two hours late is called late, not failed", !(await toast().textContent()).includes("has not changed"));

  check("no page errors", errors.length === 0, errors.join(" | "));
  console.log(`publishFollow: ${passed} checks — after a publish the editor says when GitHub is the hold-up and keeps saying it, says when the change went live and how long it took, then stops asking, in Chromium.`);
} finally {
  await browser.close();
}
