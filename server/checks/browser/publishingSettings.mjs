import assert from "node:assert/strict";
const { chromium } = await import(process.env.PLAYWRIGHT_URL ?? "playwright");

/**
 * Settings → Publishing, in a real browser.
 *
 * The screen is the only list of what the faster publish routes still need, so
 * it has to say plainly which step is done, which GitHub permission is missing,
 * and refuse to offer a field Railway pins. Saving sends only what was typed.
 */
const ORIGIN = "http://127.0.0.1:5199";
const browser = await chromium.launch({ headless: true });
const errors = [];
let passed = 0;
const check = (label, condition, detail = "") => { assert.ok(condition, `${label}${detail ? ` — ${detail}` : ""}`); passed += 1; };

const field = (id, label, over = {}) => ({ id, label, env: id.toUpperCase(), secret: false, multiline: false, placeholder: null, set: false, envManaged: false, shown: null, ...over });
const editor = "https://editor.dakyx.com";
const snapshot = (over = {}) => ({
  publishing: {
    githubApp: {
      fields: [
        field("appId", "App ID", { set: true, envManaged: true, env: "GITHUB_APP_ID", shown: "111" }),
        field("slug", "App slug", { set: true, envManaged: true, env: "GITHUB_APP_SLUG", shown: "dakyworld-website-editor" }),
        field("privateKey", "Private key (.pem)", { set: true, envManaged: true, env: "GITHUB_APP_PRIVATE_KEY", secret: true, multiline: true, shown: "saved" }),
        field("webhookSecret", "Webhook secret", { set: true, envManaged: true, env: "GITHUB_APP_WEBHOOK_SECRET", secret: true, shown: "hook-••••••••alue" }),
        field("clientId", "Client ID", { set: true, shown: "Iv23li" }),
        field("clientSecret", "Client secret", { secret: true }),
      ],
      configured: true,
      identity: { ok: true, slug: "dakyworld-website-editor", name: "DakyXTech Website Editor" },
      permissions: [
        { key: "deployments", label: "Deployments", level: "read", ok: true },
        { key: "checks", label: "Checks", level: null, ok: false },
        { key: "statuses", label: "Commit statuses", level: "read", ok: true },
        { key: "actions", label: "Actions", level: null, ok: false },
        { key: "repository_hooks", label: "Webhooks", level: "read", ok: true },
        { key: "pages", label: "Pages", level: "read", ok: true },
      ],
      urls: { callback: `${editor}/api/website/github/callback`, webhook: `${editor}/api/github/webhook` },
    },
    pagesApp: {
      fields: [field("appId", "App ID"), field("slug", "App slug"), field("privateKey", "Private key (.pem)", { secret: true, multiline: true })],
      configured: false, identity: null, permissions: [], urls: { setup: `${editor}/api/website/github-pages/callback` },
    },
    netlify: { fields: [field("clientId", "Client ID"), field("clientSecret", "Secret", { secret: true })], configured: false, urls: { redirect: `${editor}/api/website/connect/netlify/callback` } },
    vercel: { fields: [field("clientId", "Client ID"), field("clientSecret", "Client secret", { secret: true }), field("slug", "Integration slug")], configured: false, urls: { redirect: `${editor}/api/website/connect/vercel/callback` } },
    routes: { envManaged: false, disabled: [] },
    ...over,
  },
});

async function open(state, onRequest = () => undefined, width = 1280) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  const requests = [];
  await page.route("**/api/**", (route) => {
    const request = route.request();
    const url = new URL(request.url());
    requests.push({ method: request.method(), path: url.pathname, body: request.postDataJSON?.() ?? null });
    const answered = onRequest(request.method(), url.pathname, request);
    if (answered) return route.fulfill({ json: answered });
    if (url.pathname === "/api/settings") return route.fulfill({ json: state });
    return route.fulfill({ json: {} });
  });
  await page.goto(`${ORIGIN}/builder-harness.html?publishing`);
  await page.getByRole("heading", { name: "Publishing" }).waitFor();
  return { page, context, requests };
}

try {
  {
    const { page, context } = await open(snapshot());
    const overview = page.locator("section", { has: page.getByRole("heading", { name: "Publishing" }) });
    const text = await overview.textContent();
    check("the GitHub App step reads done", /done\s*The DakyXTech GitHub App/.test(text), text);
    check("missing read permissions read partly done", /partly\s*Its six read permissions/.test(text), text);
    check("Netlify is still to do", /to do\s*Netlify OAuth app/.test(text), text);

    const app = page.locator("section", { has: page.getByRole("heading", { name: "DakyXTech GitHub App" }) });
    const appText = await app.textContent();
    check("the missing permissions are named", appText.includes("Missing: Checks, Actions"), appText);
    check("the callback address is shown to copy", appText.includes(`${editor}/api/website/github/callback`));
    check("fields pinned by Railway are named, not offered", appText.includes("GITHUB_APP_ID, GITHUB_APP_SLUG, GITHUB_APP_PRIVATE_KEY, GITHUB_APP_WEBHOOK_SECRET are set in Railway"), appText);
    check("only the unpinned fields have inputs", (await app.locator("input, textarea").count()) === 2);
    check("a saved private key is said to be saved, never shown", appText.includes("Private key (.pem)saved") && !appText.includes("BEGIN"), appText);
    await context.close();
  }
  {
    const saved = snapshot({ netlify: { ...snapshot().publishing.netlify, configured: true, fields: [field("clientId", "Client ID", { set: true, shown: "nid" }), field("clientSecret", "Secret", { secret: true, set: true, shown: "netli••••••••alue" })] } });
    const { page, context, requests } = await open(snapshot(), (method, path) => (method === "PUT" && path === "/api/settings/publishing/netlify" ? saved : undefined));
    const netlify = page.locator("section", { has: page.getByRole("heading", { name: "Netlify", exact: true }) });
    await netlify.getByLabel("Client ID").fill("nid");
    await netlify.getByLabel("Secret").fill("netlify-secret-value");
    await netlify.getByRole("button", { name: "Save" }).click();
    await netlify.getByText("The Connect Netlify button works.").waitFor();
    const put = requests.find((entry) => entry.method === "PUT");
    check("saving sends the typed values to the group", put?.path === "/api/settings/publishing/netlify" && put.body?.values?.clientSecret === "netlify-secret-value", JSON.stringify(put));
    check("the secret field is cleared after saving", (await netlify.getByLabel("Replace Secret").inputValue()) === "");
    await context.close();
  }
  {
    const { page, context, requests } = await open(snapshot(), (method, path) => (method === "PUT" && path === "/api/settings/publishing/routes" ? snapshot({ routes: { envManaged: false, disabled: ["pages"] } }) : undefined));
    await page.getByRole("button", { name: "Faster Pages builds" }).click();
    await page.waitForFunction(() => document.querySelector('button[aria-pressed="false"]'));
    const put = requests.find((entry) => entry.path === "/api/settings/publishing/routes");
    check("switching a route off sends it as disabled", JSON.stringify(put?.body) === JSON.stringify({ disabled: ["pages"] }), JSON.stringify(put));
    await context.close();
  }
  {
    const { page, context } = await open(snapshot(), () => undefined, 390);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check("nothing scrolls sideways at phone width", overflow <= 0, `${overflow}px`);
    await context.close();
  }
  check("no page errors", errors.length === 0, errors.join(" | "));
  console.log(`publishingSettings: ${passed} checks passed`);
} finally {
  await browser.close();
}
