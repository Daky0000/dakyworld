import assert from "node:assert/strict";
const { chromium } = await import(process.env.PLAYWRIGHT_URL ?? "playwright");

/**
 * "How this site goes live" in Website settings, in a real browser.
 *
 * The panel is the only place a customer meets the publish router, so what it
 * says has to be right for each kind of site: the branch warning that stops
 * publishes silently never appearing, the one "Make updates instant" option
 * that fits, the deploy hook field only where a hook is needed, and the DNS
 * records for the edge bridge with the promise that email is not touched.
 */
const ORIGIN = "http://127.0.0.1:5199";
const browser = await chromium.launch({ headless: true });
const errors = [];
let passed = 0;
const check = (label, condition, detail = "") => { assert.ok(condition, `${label}${detail ? ` — ${detail}` : ""}`); passed += 1; };

const profile = (over) => ({ host: "github-pages", answer: "auto", evidence: [{ kind: "headers", detail: "The live page was answered by github-pages." }], hasBuildStep: false, lastCheckedAt: new Date().toISOString(), missingAccess: [], routes: {}, disabledRoutes: [], ...over });
const view = (over) => ({
  profile: profile({}), hook: { configured: false, masked: null, provider: null, used: false }, connections: [], providers: { netlify: true, vercel: true },
  pagesApp: { configured: true, installed: false }, bridge: null, bridgeConfigured: true, disabledGlobally: [],
  offer: { kind: "bridge", text: "Make updates instant with one change to your domain.", button: "Make instant", active: false }, ...over,
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
    const { page, context } = await open(view({ profile: profile({ pages: { buildType: "legacy", noJekyll: false, jekyllContent: false } }) }), (method, path) =>
      method === "POST" && path.endsWith("/bridge") ? { dns: { txt: { name: "_dakyworld.www.example.com", value: "dakyx-bridge=abc" }, cname: { name: "www.example.com", value: "edge.dakyxsites.com" }, apex: false, guidance: null, untouched: "Only this one record changes. Your email (MX) and every other record stay exactly as they are." }, oneClick: null, view: view({ bridge: { hostname: "www.example.com", origin: "https://fixture.github.io/site", status: "pending-dns", sslStatus: null, disabledReason: null, dns: null } }) } : undefined);
    check("a plain HTML GitHub Pages site is offered Skip Jekyll", await page.locator('[data-section="deploy-nojekyll"]').isVisible());
    check("an automatic host gets no deploy hook field", (await page.locator('[data-section="deploy-hook"]').count()) === 0);
    await page.getByRole("button", { name: "Make instant" }).click();
    const bridge = page.locator('[data-section="deploy-bridge"]');
    await bridge.getByText("edge.dakyxsites.com").waitFor();
    check("starting the bridge shows the exact CNAME", (await bridge.textContent()).includes("www.example.com → edge.dakyxsites.com"));
    check("and says email is not touched", (await bridge.textContent()).includes("Your email (MX)"));
    check("with a Check button", await bridge.getByRole("button", { name: "Check" }).isVisible());
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
  console.log(`deployPanel: ${passed} checks — the branch warning, the one instant option per site, the hook field only where needed, the bridge's DNS records, and the host's own approval screen, in Chromium.`);
} finally {
  await browser.close();
}
