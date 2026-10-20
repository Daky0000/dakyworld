import assert from "node:assert/strict";
const { chromium } = await import(process.env.PLAYWRIGHT_URL ?? "playwright");

/**
 * "How this site goes live" in Website settings, in a real browser.
 *
 * The panel is the only place a customer meets the publish router, so what it
 * says has to be right for each kind of site: the branch warning that stops
 * publishes silently never appearing, the one "Make updates instant" option
 * that fits, the deploy hook field only where a hook is needed, the setup
 * problems that would make every publish fail, and the history of publishes.
 */
const ORIGIN = "http://127.0.0.1:5199";
const browser = await chromium.launch({ headless: true });
const errors = [];
let passed = 0;
const check = (label, condition, detail = "") => { assert.ok(condition, `${label}${detail ? ` — ${detail}` : ""}`); passed += 1; };

const profile = (over) => ({ host: "github-pages", answer: "auto", evidence: [{ kind: "headers", detail: "The live page was answered by github-pages." }], hasBuildStep: false, lastCheckedAt: new Date().toISOString(), missingAccess: [], routes: {}, disabledRoutes: [], ...over });
const view = (over) => ({
  profile: profile({}), hook: { configured: false, masked: null, provider: null, used: false }, connections: [], providers: { netlify: true, vercel: true },
  pagesApp: { configured: true, installed: false }, recent: [], disabledGlobally: [],
  offer: { kind: "pages", text: "Publish to GitHub Pages without waiting for the Jekyll build.", button: "Make faster", active: false }, ...over,
});

async function open(state, onRequest = () => undefined) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  const requests = [];
  await page.route("**/api/**", (route) => {
    const url = new URL(route.request().url());
    requests.push(`${route.request().method()} ${url.pathname}`);
    const answered = onRequest(route.request().method(), url.pathname, route.request());
    if (answered) return route.fulfill({ json: answered });
    if (url.pathname === "/api/website/sites/demo/deploy") return route.fulfill({ json: state });
    if (url.pathname.endsWith("/auth/me")) return route.fulfill({ json: { id: "tester", name: "Client", external: true, permissions: [], uiState: {} } });
    return route.fulfill({ json: {} });
  });
  await page.goto(`${ORIGIN}/builder-harness.html?deploy`);
  await page.locator('[data-section="deploy-how"]').waitFor();
  return { page, context, requests };
}

try {
  {
    const { page, context } = await open(view({ profile: profile({ answer: "branch-mismatch", deployBranch: "gh-pages" }) }));
    const warning = page.locator('[data-section="deploy-how"]');
    await warning.getByText("Publishes will not appear yet").waitFor();
    check("a host deploying another branch is said plainly", (await warning.textContent()).includes("branch gh-pages"));
    await context.close();
  }
  {
    const { page, context } = await open(view({
      profile: profile({ pages: { buildType: "legacy", noJekyll: false, jekyllContent: false } }),
      recent: [
        { id: "j2", page: { title: "Home", path: "/" }, startedBy: "Ama", label: "Live", state: "COMPLETED", route: "follow", fallbackFrom: null, deployedInSeconds: 41, hostMessage: null, lastError: null, createdAt: new Date().toISOString() },
        { id: "j1", page: { title: "About", path: "/about" }, startedBy: "Ama", label: "The host did not rebuild", state: "DEPLOY_FAILED", route: "follow", fallbackFrom: "direct", deployedInSeconds: null, hostMessage: "Build script returned non-zero exit code: 2", lastError: null, createdAt: new Date().toISOString() },
      ],
    }), (method, path) => (method === "POST" && path.endsWith("/deploy/pages") ? { installUrl: `${ORIGIN}/builder-harness.html?after-pages` } : undefined));
    check("a plain HTML GitHub Pages site is offered Skip Jekyll", await page.locator('[data-section="deploy-nojekyll"]').isVisible());
    check("an automatic host gets no deploy hook field", (await page.locator('[data-section="deploy-hook"]').count()) === 0);
    const recent = await page.locator('[data-section="deploy-recent"]').textContent();
    check("recent publishes say how long each took and how it went live", recent.includes("Live in 41 s, your host rebuilt it"), recent);
    check("and a failure in the host's own words", recent.includes("Your host said: Build script returned non-zero exit code: 2"), recent);
    check("and a faster route that fell back", recent.includes("Direct upload did not work this time"), recent);
    await page.getByRole("button", { name: "Make faster" }).click();
    await page.waitForURL(/after-pages/);
    check("Make faster sends the browser to install DakyX Pages", true);
    await context.close();
  }
  {
    const { page, context } = await open(view({ profile: profile({ branchMissing: true, canWrite: false }) }));
    const how = await page.locator('[data-section="deploy-how"]').textContent();
    check("a missing branch is caught before anybody publishes", how.includes("Publishing has nowhere to go"));
    check("and so is access that cannot write", how.includes("DakyX cannot write to this repository"));
    await context.close();
  }
  {
    let connected = null;
    const { page, context } = await open(view({ profile: profile({ host: "netlify" }), offer: { kind: "direct-netlify", text: "Connect Netlify to publish in seconds.", button: "Connect Netlify", active: false } }), (method, path) => {
      if (method === "POST" && path.endsWith("/connect/netlify")) { connected = path; return { url: `${ORIGIN}/builder-harness.html?after-netlify` }; }
      return undefined;
    });
    await page.getByRole("button", { name: "Connect Netlify" }).click();
    await page.waitForURL(/after-netlify/);
    check("Connect Netlify sends the browser to Netlify's own approval screen", connected === "/api/website/sites/demo/connect/netlify");
    await context.close();
  }
  {
    const { page, context } = await open(view({ profile: profile({ host: "hostinger", answer: "needs-hook" }), offer: { kind: null, text: null, button: null, active: false }, connections: [{ provider: "netlify", name: "my-site", matched: true, paused: true, pausedReason: "Netlify stopped accepting DakyX's sign-in. Reconnect Netlify to turn instant updates back on.", lastUsedAt: null }] }));
    check("a host that needs a hook gets the hook field", await page.locator('[data-section="deploy-hook"]').isVisible());
    check("a paused connection says so and offers to reconnect", await page.getByRole("button", { name: "Reconnect Netlify" }).isVisible());
    await context.close();
  }
  check("no page errors", errors.length === 0, errors.join(" | "));
  console.log(`deployPanel: ${passed} checks — the branch warning, the one instant option per site, the hook field only where needed, setup problems, publish history, and the host's own approval screen, in Chromium.`);
} finally {
  await browser.close();
}
