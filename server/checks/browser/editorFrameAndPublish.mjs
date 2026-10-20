import assert from "node:assert/strict";
const { chromium } = await import(process.env.PLAYWRIGHT_URL ?? "playwright");

/**
 * Two things from the launch audit of 12 Oct 2026 that only show in a browser:
 * where the editor's messages to the page go, and what a publish leaves
 * running behind it.
 *
 *  - The editor addressed every message to the frame as `"*"`. The editing
 *    frame keeps the app's origin, so it is addressed to that origin now; the
 *    isolated preview (a page drawn by its own scripts, with an opaque origin)
 *    has no picker in it, so nothing is sent there at all. What the frame
 *    actually hears is read from inside it, not from the editor's code.
 *  - After a publish the editor looks again at 20s, 45s and 90s. Those looks
 *    were never cancelled: two publishes in a row ran six, and leaving the
 *    editor left them all to fire. The timers are watched as they are made and
 *    cleared, since the point is what is still due — nothing waits 90 seconds.
 */
const ORIGIN = "http://127.0.0.1:5199";
const LOOKS = [20000, 45000, 90000];
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const errors = [];

await context.addInitScript((looks) => {
  if (window === window.top) {
    const set = window.setTimeout.bind(window);
    const clear = window.clearTimeout.bind(window);
    window.__looks = [];
    window.setTimeout = (handler, delay, ...rest) => {
      if (typeof handler !== "function" || !looks.includes(delay)) return set(handler, delay, ...rest);
      const entry = { delay, cleared: false, id: 0 };
      window.__looks.push(entry);
      entry.id = set(handler, delay, ...rest);
      return entry.id;
    };
    window.clearTimeout = (id) => {
      for (const entry of window.__looks) if (entry.id === id) entry.cleared = true;
      return clear(id);
    };
    window.__sent = [];
    window.__heard = [];
    window.addEventListener("message", (event) => { if (event.data?.spy) window.__heard.push(event.data); });
    return;
  }
  // Inside the frame: report everything the editor says to it, and — where the
  // frame shares the editor's origin — what the editor addressed it to.
  window.addEventListener("message", (event) => {
    if (event.data?.source === "dakyworld-editor") parent.postMessage({ spy: "heard", type: event.data.type }, "*");
  });
  const original = window.postMessage;
  window.postMessage = function (message, targetOrigin, transfer) {
    try { window.top.__sent.push({ type: message?.type ?? null, targetOrigin }); } catch { /* An opaque frame cannot reach the editor. */ }
    return original.call(this, message, targetOrigin, transfer);
  };
  window.addEventListener("load", () => parent.postMessage({ spy: "ready" }, "*"));
}, LOOKS);

const capabilities = Object.fromEntries(["view", "edit", "review", "publish", "manage", "members", "source"].map((key) => [key, true]));
const documentFor = (drawnByScript) => ({
  site: { id: "demo", name: "Demo website", publicUrl: "https://example.com", repo: "demo/site" }, links: [], readFrom: "imported file", drawnByScript,
  page: { id: "one", title: "Home", path: "/", filePath: "index.html", status: "LIVE", url: "https://example.com", lastPublishedAt: null },
  sections: drawnByScript ? [] : [{ id: "hero", label: "Hero", kind: "section", fields: [{ id: "hero.title", kind: "text", tag: "h1", value: "Welcome home", preview: "Welcome home", label: "Main heading", order: 0, structure: { remove: true, duplicate: true, move: true, group: "main" } }] }],
  draft: { revision: 0, savedAt: null, savedBy: null, values: {} }, problems: [],
});
const PREVIEW = '<html><body style="margin:0;padding:60px;font-family:Arial"><h1 data-dw-field="hero.title" style="font-size:64px">Welcome home</h1></body></html>';

async function open({ drawnByScript }) {
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  const publishes = [];
  const document = documentFor(drawnByScript);
  await page.route("**/api/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/presence")) return route.fulfill({ json: { editors: [] } });
    if (url.pathname.endsWith("/draft")) return route.fulfill({ json: { revision: document.draft.revision, problems: [], unknown: [] } });
    if (url.pathname.endsWith("/review")) return route.fulfill({ json: { revision: document.draft.revision, sourceHash: "fixture", summary: [], problems: [], conflicts: [], missing: [], publishable: true } });
    if (url.pathname.endsWith("/publish")) {
      publishes.push(route.request().postDataJSON());
      return route.fulfill({ json: { version: publishes.length, changed: 1, summary: [], touched: { text: true, links: false, images: false, styles: false, seo: false }, commit: { sha: `c${publishes.length}`, url: null }, url: "https://example.com/", note: "" } });
    }
    if (url.pathname.endsWith("/auth/me")) return route.fulfill({ json: { id: "tester", name: "Client", external: true, permissions: [], uiState: { tours: { editor: { status: "dismissed", at: "2026-10-07T00:00:00.000Z" }, "publish-delay-notice": { status: "dismissed", at: "2026-10-19T00:00:00.000Z" } } } } });
    if (url.pathname.endsWith("/access")) return route.fulfill({ json: { capabilities } });
    if (url.pathname.endsWith("/assets")) return route.fulfill({ json: [] });
    if (url.pathname.endsWith("/design")) return route.fulfill({ json: { options: { colours: [], fonts: [], presets: [], aiEnabled: true } } });
    if (url.pathname.includes("/preview")) {
      // A page drawn by its own scripts is served the way the server serves it:
      // sandboxed without `allow-same-origin`, so its origin is opaque.
      const headers = drawnByScript ? { "Content-Security-Policy": "sandbox allow-scripts" } : {};
      return route.fulfill({ contentType: "text/html", headers, body: PREVIEW });
    }
    return route.fulfill({ json: document });
  });
  await page.goto(`${ORIGIN}/builder-harness.html?editor`);
  return { page, publishes };
}

let passed = 0;
const check = (label, condition, detail = "") => { assert.ok(condition, `${label}${detail ? ` — ${detail}` : ""}`); passed += 1; };
const spied = (page) => page.evaluate(() => ({ sent: window.__sent, heard: window.__heard, looks: window.__looks }));

try {
  /* --------------------------------------------- the editing frame: its origin */
  {
    const { page, publishes } = await open({ drawnByScript: false });
    await page.getByRole("button", { name: "Layers", exact: true }).click();
    await page.getByRole("treeitem", { name: /Welcome home/ }).click();
    await page.waitForFunction(() => window.__heard.some((message) => message.spy === "ready"));
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => window.__heard.some((message) => message.type === "stopEdit"));
    const { sent } = await spied(page);
    check("the editing frame is told things", sent.some((message) => message.type === "stopEdit"), JSON.stringify(sent));
    check("and only ever addressed to the editor's own origin", sent.length > 0 && sent.every((message) => message.targetOrigin === ORIGIN), JSON.stringify(sent));

    /* ------------------------------------------- publishing, and looking again */
    const publishOnce = async (count) => {
      await page.keyboard.press("Control+Enter");
      await page.waitForFunction((expected) => window.__looks.length === expected, count * 3);
      check(`publish ${count} went out`, publishes.length === count);
    };
    await publishOnce(1);
    let { looks } = await spied(page);
    check("a publish looks again three times", looks.map((entry) => entry.delay).join() === LOOKS.join() && looks.every((entry) => !entry.cleared), JSON.stringify(looks));
    await page.getByText(/Changes sent/).waitFor();
    await publishOnce(2);
    ({ looks } = await spied(page));
    check("a newer publish cancels the older one's looks", looks.slice(0, 3).every((entry) => entry.cleared), JSON.stringify(looks));
    check("and keeps its own", looks.slice(3).every((entry) => !entry.cleared), JSON.stringify(looks));

    await page.getByRole("link", { name: "Back to Pages" }).click();
    await page.locator(".website-editor").waitFor({ state: "detached" });
    ({ looks } = await spied(page));
    check("leaving the editor cancels every look still due", looks.length === 6 && looks.every((entry) => entry.cleared), JSON.stringify(looks));
    await page.close();
  }

  /* ------------------------------------------ the isolated frame: nothing sent */
  {
    const { page } = await open({ drawnByScript: true });
    await page.getByText(/drawn by its own scripts/).waitFor();
    // The spy is heard from inside the opaque frame, so silence below is the
    // frame hearing nothing, not a spy that never ran.
    await page.waitForFunction(() => window.__heard.some((message) => message.spy === "ready"));
    check("the isolated frame is opaque to the editor", await page.locator('iframe[title="Page"]').evaluate((frame) => frame.contentDocument === null));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    const { heard } = await spied(page);
    check("the page's own scripts are told nothing", heard.every((message) => message.spy === "ready"), JSON.stringify(heard));
    await page.close();
  }

  check("no page errors", errors.length === 0, errors.join(" | "));
  console.log(`editorFrameAndPublish: ${passed} checks — the editing frame is addressed to the editor's own origin and the isolated preview is sent nothing, a newer publish cancels the older one's looks and leaving the editor cancels the rest, in Chromium.`);
} finally {
  await browser.close();
}
