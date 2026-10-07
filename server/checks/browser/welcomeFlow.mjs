import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";

/**
 * The first-visit onboarding, end to end, against a mocked API.
 *
 * What it holds the flow to: Continue stays off until the answers that decide
 * the build are given; the site is created exactly once, with the starter the
 * answers chose and no invented web address; the last step reports what the
 * request actually returned (a failure is said, never ticked); the answers are
 * recorded on the account; and Open the editor lands in the editor with the
 * tour asked for.
 */
const { chromium } = await import(process.env.PLAYWRIGHT_URL ?? "playwright");
const browser = await chromium.launch({ headless: true });
const errors = [];

async function run({ method, failCreate = false }) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  page.on("pageerror", (error) => errors.push(error.message));
  const created = [];
  const uiState = [];
  const help = [];
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const method_ = route.request().method();
    if (url.pathname.endsWith("/auth/me")) return route.fulfill({ json: { id: "u1", name: "Ama Mensah", email: "ama@example.com", external: true, permissions: [], uiState: {} } });
    if (url.pathname.endsWith("/auth/ui-state")) { uiState.push(route.request().postDataJSON()); return route.fulfill({ json: {} }); }
    if (url.pathname.endsWith("/tier-status") || url.pathname.includes("/tier")) return route.fulfill({ json: null });
    if (url.pathname.endsWith("/setup-assistance") && method_ === "GET") return route.fulfill({ json: { display: "GHS 600", amount: 600, currency: "GHS" } });
    if (url.pathname.endsWith("/setup-assistance")) { help.push(route.request().postDataJSON()); return route.fulfill({ status: 201, json: { message: "Your request is logged.", paymentUrl: null } }); }
    if (url.pathname.endsWith("/website/sites") && method_ === "POST") {
      created.push(route.request().postDataJSON());
      if (failCreate) return route.fulfill({ status: 402, json: { error: "Payment must be verified before connecting a website." } });
      await new Promise((resolve) => setTimeout(resolve, 300));
      return route.fulfill({ status: 201, json: { id: "site1", pageId: "page1" } });
    }
    return route.fulfill({ json: [] });
  });
  await page.goto("http://127.0.0.1:5199/builder-harness.html?welcome");
  const cont = page.getByRole("button", { name: "Continue", exact: true });

  // Step 1: nothing is enough until every answer that decides the build is in.
  await page.getByLabel("Website name").fill("Accra Bakery");
  assert.equal(await cont.isDisabled(), true, "Continue waits for what the site is for");
  await page.getByRole("radio", { name: /Business/ }).click();
  await page.getByLabel("What kind of business?").selectOption("Food & restaurant");
  assert.equal(await cont.isDisabled(), true, "Continue waits for the address question");
  await page.getByRole("button", { name: "Not yet", exact: true }).click();
  await cont.click();

  // Step 2.
  const methodName = { template: /ready-made page/, team: /our team set it up/ }[method];
  await page.getByRole("radio", { name: methodName }).click();
  if (method === "team") {
    assert.equal(await cont.isDisabled(), true, "The team route needs a number to call");
    await page.getByLabel("Phone or WhatsApp").fill("+233 20 123 4567");
    await page.getByText(/one-off GHS 600/).waitFor();
  }
  await cont.click();

  // Step 3.
  const build = page.getByRole("button", { name: "Build my website", exact: true });
  assert.equal(await build.isDisabled(), true);
  await page.getByRole("button", { name: "WhatsApp", exact: true }).click();
  await build.click();

  if (failCreate) {
    await page.getByRole("alert").getByText("Payment must be verified").waitFor();
    assert.equal(await page.getByRole("button", { name: "Open the editor" }).count(), 0, "A failed build offers no editor");
    assert.equal(created.length, 1, "Created once, not retried behind somebody's back");
    await page.close();
    return;
  }

  await page.getByRole("button", { name: "Open the editor", exact: true }).waitFor();
  assert.equal(created.length, 1, "The site is created exactly once");
  assert.equal(created[0].templateKey, "local", "Food & restaurant builds from the local-business starter");
  assert.equal(created[0].publicUrl, undefined, "No web address is invented for somebody who has none");
  assert.ok(uiState.some((patch) => patch.welcome?.status === "done" && patch.welcome.heardFrom === "whatsapp" && patch.welcome.purpose === "business"), "The answers are kept on the account");
  if (method === "team") {
    assert.equal(help.length, 1);
    assert.equal(help[0].siteId, "site1");
    assert.match(help[0].notes, /\+233 20 123 4567/);
  }
  await mkdir("checks/artifacts", { recursive: true });
  await page.screenshot({ path: `checks/artifacts/welcome-${method}.png` });
  await page.getByRole("button", { name: "Open the editor", exact: true }).click();
  assert.equal(await page.getByTestId("landed").innerText(), "/website/pages/page1?walkthrough=interactive");
  await page.close();
}

try {
  await run({ method: "template" });
  await run({ method: "team" });
  await run({ method: "template", failCreate: true });
  assert.deepEqual(errors, []);
  console.log("welcomeFlow: answers gate each step, one create with the chosen starter and no invented address, failure said not ticked, answers recorded, team request sent, lands in the editor with the tour.");
} finally {
  await browser.close();
}
