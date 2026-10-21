import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const { chromium } = await import(process.env.PLAYWRIGHT_URL ?? "playwright");

/**
 * The Builder agent changing the page that is open (21 Oct 2026, C1).
 *
 * The chat used to put the agent's edits into the editor — which autosaves a
 * second later at the revision it holds — *and* send them to /agent/apply at
 * that same revision. One of the two was always refused. A quick apply left the
 * autosave to meet a conflict dialog about the person's own change ("Client
 * saved changes to this page while you were editing it"); a slow one let the
 * autosave land first, and the chat then said "Nothing was changed" about a
 * change that had been saved.
 *
 * The open page now goes through the editor's own save, once, and only other
 * pages go to /agent/apply. The mock server below applies the real server's
 * rule: a write quoting a revision that has moved on is a 409.
 */
const RAW = '<html><body style="margin:0;font-family:Arial;padding:60px"><h1 style="font-size:64px">Welcome home</h1></body></html>';
const PREVIEW = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
  import { readFileSync } from "node:fs";
  const { previewDocument } = await import("./src/services/website/site.ts");
  const html = readFileSync(0, "utf8");
  const fields = [["hero.title", "text", "h1"]].map(([id, kind, tag]) => ({ id, kind, tag, label: id, value: "", attrInsert: html.indexOf("<" + tag) + tag.length + 1 }));
  process.stdout.write(previewDocument(html, "http://127.0.0.1:5199/", fields).html);
`], { cwd: join(dirname(fileURLToPath(import.meta.url)), "..", ".."), input: RAW, encoding: "utf8" });

const capabilities = Object.fromEntries(["view", "edit", "review", "publish", "manage", "members", "source"].map((key) => [key, true]));
let passed = 0;
const check = (label, condition, detail = "") => { assert.ok(condition, `${label}${detail ? ` — ${detail}` : ""}`); passed += 1; console.log(`  ok  ${label}`); };

/** One editor session against a mock server; `otherPage` adds a second page to the plan. */
async function session({ applyDelayMs, otherPage = false }) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const server = { revision: 0, value: "Welcome home", drafts: [], applies: [] };
  const document = () => ({
    site: { id: "demo", name: "Demo website", publicUrl: "https://example.com", repo: "demo/site" }, links: [], readFrom: "imported file",
    page: { id: "one", title: "Home", path: "/", filePath: "index.html", status: "LIVE", url: "https://example.com", lastPublishedAt: null },
    sections: [{ id: "hero", label: "Hero", kind: "section", fields: [{ id: "hero.title", kind: "text", tag: "h1", value: "Welcome home", preview: "Welcome home", label: "Main heading", order: 0, structure: { remove: true, duplicate: true, move: true, group: "main" } }] }],
    draft: { revision: server.revision, savedAt: null, savedBy: null, values: server.value === "Welcome home" ? {} : { "hero.title": { value: server.value } } }, problems: [],
  });
  const pagePlan = (pageId, title, revision) => ({ pageId, pageTitle: title, pagePath: pageId === "one" ? "/" : "/about", draftRevision: revision,
    changes: [{ fieldId: "hero.title", label: "Main heading", property: "value", before: "Welcome home", after: "Hello there" }],
    edits: { "hero.title": { value: "Hello there" } } });
  const plan = {
    explanation: otherPage ? 'Updated "Main heading" on Home and About.' : 'Updated "Main heading" text to "Hello there" on Home.', actionKind: "instruction",
    summary: { totalPages: 2, affectedPages: otherPage ? 2 : 1, totalChanges: otherPage ? 2 : 1 },
    pages: otherPage ? [pagePlan("one", "Home", 0), pagePlan("two", "About", 7)] : [pagePlan("one", "Home", 0)],
    requiresApproval: otherPage, approvalReasons: otherPage ? ["Modifies 2 pages across the entire website (2 total changes)."] : [], riskLevel: otherPage ? "medium" : "low",
  };

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.endsWith("/presence")) return route.fulfill({ json: { editors: [] } });
    if (url.pathname.endsWith("/auth/me")) return route.fulfill({ json: { id: "tester", name: "Client", external: true, permissions: [], uiState: { tours: { editor: { status: "dismissed", at: "2026-10-07T00:00:00.000Z" } } } } });
    if (url.pathname.endsWith("/access")) return route.fulfill({ json: { capabilities } });
    if (url.pathname.endsWith("/assets")) return route.fulfill({ json: [] });
    if (url.pathname.endsWith("/design")) return route.fulfill({ json: { options: { colours: [], fonts: [], presets: [], aiEnabled: true } } });
    if (url.pathname.includes("/preview")) return route.fulfill({ contentType: "text/html", body: PREVIEW });
    if (url.pathname.endsWith("/agent/plan")) return route.fulfill({ json: plan });
    if (url.pathname.endsWith("/agent/apply")) {
      const body = request.postDataJSON();
      const readAt = server.revision;
      server.applies.push(body);
      await new Promise((resolve) => setTimeout(resolve, applyDelayMs));
      const writesOpenPage = body.plan.pages.some((p) => p.pageId === "one");
      if (writesOpenPage && (body.pageRevisions.one !== readAt || server.revision !== readAt)) {
        return route.fulfill({ status: 409, json: { error: "Home was saved by somebody else while the plan was being applied. Nothing was changed — reload the pages and ask the assistant again." } });
      }
      if (writesOpenPage) { server.revision += 1; server.value = body.plan.pages.find((p) => p.pageId === "one").edits["hero.title"].value; }
      return route.fulfill({ json: { appliedPages: body.plan.pages.length, totalChanges: body.plan.pages.length, results: body.plan.pages.map((p) => ({ pageId: p.pageId, pageTitle: p.pageTitle, success: true, message: "Saved 1 change to draft." })) } });
    }
    if (url.pathname.endsWith("/pages/one/draft") && request.method() === "PUT") {
      const body = request.postDataJSON();
      server.drafts.push(body.ifRevision);
      if (body.ifRevision !== server.revision) {
        return route.fulfill({ status: 409, json: {
          error: "Client saved changes to this page while you were editing it. Nothing has been overwritten — choose which version to keep.",
          revision: server.revision, savedAt: new Date().toISOString(), savedBy: { id: "tester", name: "Client" },
          fields: [{ id: "hero.title", label: "Main heading", kind: "text", yours: body.values["hero.title"] ?? null, theirs: { value: server.value }, contested: false }],
        } });
      }
      server.revision += 1; server.value = body.values["hero.title"]?.value ?? server.value;
      return route.fulfill({ json: { revision: server.revision, savedAt: new Date().toISOString(), changed: 1, problems: [], unknown: [] } });
    }
    if (url.pathname.endsWith("/draft")) return route.fulfill({ json: { revision: server.revision } });
    return route.fulfill({ json: document() });
  });

  await page.goto("http://127.0.0.1:5199/builder-harness.html?editor");
  await page.getByRole("button", { name: "Builder agent" }).click({ timeout: 20_000 });
  await page.getByRole("textbox", { name: "Message the builder agent" }).fill("Change the main heading to Hello there");
  await page.getByRole("button", { name: "Send" }).click();
  if (otherPage) await page.getByRole("button", { name: "Approve & Apply Changes" }).click({ timeout: 10_000 });
  // Long enough for the autosave that used to collide (1.2 s) and the slow apply.
  await page.waitForTimeout(applyDelayMs + 3_500);
  const dialogs = (await page.locator('[role="dialog"], [role="alertdialog"], [aria-modal="true"]').allInnerTexts())
    .filter((text) => /saved changes to this page|choose which version/i.test(text));
  const chat = await page.getByRole("dialog", { name: "Website Builder Agent Chat" }).innerText().catch(() => "");
  await browser.close();
  return { server, dialogs, chat, errors };
}

try {
  for (const applyDelayMs of [150, 2_500]) {
    console.log(`\nOne page, the open one (apply would answer in ${applyDelayMs} ms)`);
    const run = await session({ applyDelayMs });
    check("no conflict dialog about the person's own change", run.dialogs.length === 0, run.dialogs.join(" | "));
    check("the open page is not sent to the apply route at all", run.server.applies.length === 0, JSON.stringify(run.server.applies));
    check("it is saved once, through the editor, at the revision it holds", JSON.stringify(run.server.drafts) === "[0]", JSON.stringify(run.server.drafts));
    check("and the change is saved", run.server.value === "Hello there" && run.server.revision === 1, `${run.server.value} @ ${run.server.revision}`);
    check("the chat says it was applied, not that nothing changed", /applied to drafts/i.test(run.chat) && !/Nothing was changed/i.test(run.chat), run.chat.slice(-300));
    check("no page errors", run.errors.length === 0, run.errors.join(" | "));
  }

  console.log("\nTwo pages: the open one and another");
  const both = await session({ applyDelayMs: 150, otherPage: true });
  check("the other page goes to the apply route alone, at its plan revision",
    both.server.applies.length === 1 && JSON.stringify(both.server.applies[0].plan.pages.map((p) => p.pageId)) === '["two"]' && both.server.applies[0].pageRevisions.two === 7,
    JSON.stringify(both.server.applies.map((a) => ({ pages: a.plan.pages.map((p) => p.pageId), revisions: a.pageRevisions }))));
  check("the open page is saved once through the editor", JSON.stringify(both.server.drafts) === "[0]", JSON.stringify(both.server.drafts));
  check("no conflict dialog", both.dialogs.length === 0, both.dialogs.join(" | "));
  check("the chat says it was applied", /applied to drafts/i.test(both.chat), both.chat.slice(-300));
} catch (error) {
  console.error(`FAIL  ${error.message}`);
  process.exit(1);
}
console.log(`\n${passed} passed`);
