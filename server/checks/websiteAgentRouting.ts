/**
 * The Builder agent: which requests a rule answers and which reach the model,
 * and what the model can now do. Needs Postgres and nothing else.
 *
 *   DATABASE_URL=postgresql://…/<a local *check* database> npx tsx checks/websiteAgentRouting.ts
 *
 * Until 23 Oct 2026 the rules ran first and matched single words, and eight
 * ordinary sentences on the DakyX homepage all went to a rule and none to the
 * model: "remove the word 'external' from this heading" deleted the heading,
 * "delete the testimonials section" deleted the logo, "change font to Inter"
 * with one heading selected changed 180 elements. The first half holds those
 * eight, and the exact commands that must still be rules (free, instant).
 *
 * The second half drives the real planner against a stand-in model that reads
 * the outline it is sent the way a model would — finding an element's id by
 * its words — and answers with each new capability: a question with answers
 * to tap, animations, a section placed where asked, a review, a second try
 * when most of an answer would not apply, a change on a page the request
 * named, and the refusals that keep a plan honest.
 *
 * Every site it makes is deleted, and so are the `LlmCall` rows its stand-in
 * calls wrote, scoped to the two purposes and to the start of the run.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const databaseUrl = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/invalid");
if (!["localhost", "127.0.0.1", "[::1]"].includes(databaseUrl.hostname) || !/(test|check|editor)/i.test(databaseUrl.pathname)) {
  throw new Error("These checks require an isolated local test/editor database. Set DATABASE_URL to one.");
}

let passed = 0;
const failures: string[] = [];
async function check(name: string, test: () => unknown | Promise<unknown>) {
  try { await test(); passed += 1; console.log(`  ok  ${name}`); }
  catch (error) {
    failures.push(name);
    const detail = error instanceof assert.AssertionError && error.operator !== "fail" ? ` (got ${JSON.stringify(error.actual)}, wanted ${JSON.stringify(error.expected)})` : "";
    console.log(`FAIL  ${name}\n      ${(error as Error).message.trim().split("\n")[0]}${detail}`);
  }
}

// ------------------------------------------------------------- the stand-in
type Asked = { request: string; system: string; prompt: string; maxTokens: number };
const asked: Asked[] = [];
type Answer = Record<string, unknown>;
let answer: (call: Asked, index: number) => Answer = () => ({});
const empty = (): Answer => ({ explanation: "(the model would plan this)", intent: "page_edits", editorCommand: "none", escalationReason: "", escalationCategory: "none", parsedOperation: { from: "", to: "", property: "" }, structuralActions: [], sections: [], pages: [], options: [], suggestions: [], findings: [] });
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const json = body ? JSON.parse(body) : {};
    const messages = (json.messages ?? []) as Array<{ role: string; content: string }>;
    const system = String(messages.find((message) => message.role === "system")?.content ?? "");
    const prompt = String(messages.find((message) => message.role === "user")?.content ?? "");
    let content: unknown;
    if (system.includes("You size work")) content = { level: "standard", reason: "a stand-in's view" };
    else {
      const call = { request: /User request:\n([^\n]*)/.exec(prompt)?.[1] ?? "", system, prompt, maxTokens: Number(json.max_tokens ?? json.max_completion_tokens ?? 0) };
      asked.push(call);
      content = { ...empty(), ...answer(call, asked.filter((entry) => entry.request === call.request).length - 1) };
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "x", object: "chat.completion", model: "stand-in", choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(content) }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }));
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
process.env.NVIDIA_API_KEY = "nv-check";
process.env.NVIDIA_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "PERPLEXITY_API_KEY", "OPENROUTER_API_KEY"]) delete process.env[key];

const startedAt = new Date();
const { prisma } = await import("../src/lib/prisma.js");
const { planAgentInstruction, executeBuilderPlan } = await import("../src/services/websiteBuilderAgent.js");
const { discoverFields } = await import("../src/services/website/index.js");

/** The id of the outline line that says these words, as a model reading the outline would find it. */
const idOf = (prompt: string, words: string, page?: string) => {
  const scope = page ? prompt.slice(prompt.indexOf(`<page id="${page}"`)) : prompt;
  // A section's container repeats its heading after §; the words themselves are the element's.
  const line = scope.split("\n").find((entry) => entry.includes(words) && (words.startsWith("§") || !entry.includes(`§${words}`)));
  assert.ok(line, `no outline line says ${words}`);
  return line.trim().split(" ")[0]!;
};
const callsFor = (request: string) => asked.filter((entry) => entry.request === request).length;

const homeHtml = `<!doctype html><html><head><title>Kumasi Bakery</title><meta name="description" content="Fresh bread, cakes and pastries baked every morning in Kumasi since 1998."></head><body>
<header><a href="/"><img src="/logo.png" alt="Kumasi Bakery logo"></a><nav><a href="/menu">Menu</a><a href="/about">About</a></nav></header>
<main>
  <section id="hero"><div class="wrap"><h1>Fresh bread every morning</h1><p>Baked in Kumasi since 1998.</p><a class="btn btn-primary" href="/order">Order now</a></div></section>
  <section id="pricing"><h2>Our prices</h2><div class="cards"><div class="card"><h3>Loaf</h3><p>Sourdough, rye and white.</p></div><div class="card"><h3>Cake</h3><p>For birthdays and weddings.</p></div></div></section>
  <section id="gallery"><h2>The oven</h2><img src="/uploads/oven.jpg"></section>
</main>
<footer><p>Open every day from six</p></footer>
</body></html>`;
const aboutHtml = `<!doctype html><html><head><title>About</title></head><body><main><section><h1>Our story</h1><p>A family bakery.</p></section></main></body></html>`;

const mark = `agentcheck-${randomUUID().slice(0, 8)}`;
const siteIds: string[] = [];
const makeSite = async (name: string, pages: Array<{ title: string; path: string; filePath: string; html: string }>) => {
  const site = await prisma.site.create({ data: { name, slug: `${mark}-${siteIds.length}`, publicUrl: `https://${mark}-${siteIds.length}.example.test`, pages: { create: pages.map((page, index) => ({ title: page.title, path: page.path, filePath: page.filePath, sourceHtml: page.html, sortOrder: index })) } }, include: { pages: true } });
  siteIds.push(site.id);
  return site;
};

try {
  console.log("\nThe eight sentences that went to the wrong rule");
  const dakyx = await makeSite("DakyX", [{ title: "Home", path: "/", filePath: "index.html", html: readFileSync(new URL("../../index.html", import.meta.url), "utf8") }]);
  const dakyxHome = dakyx.pages[0]!;
  const heading = discoverFields(dakyxHome.sourceHtml!).fields.find((field) => field.tag === "h1")!;
  answer = () => ({});
  for (const [prompt, selected] of [
    ["Remove the word 'external' from this heading", true],
    ["Remove the underline from the links", false],
    ["Make the background blue and the text white", true],
    ["Copy this text into the footer", true],
    ["Move the booking button below the pricing cards", false],
    ["Clear the background colour", true],
    ["Delete the testimonials section", false],
  ] as const) {
    await check(`"${prompt}" reaches the model`, async () => {
      const before = callsFor(prompt);
      const plan = await planAgentInstruction(dakyx, dakyx.pages, prompt, { pageId: dakyxHome.id, selectedFieldId: selected ? heading.id : null });
      assert.equal(callsFor(prompt) - before, 1, "the model was asked once");
      assert.equal(plan.structuralActions, undefined, "no rule deleted, duplicated or moved anything");
    });
  }
  await check(`"Change font to Inter" with the heading selected changes that heading, and offers the rest`, async () => {
    const plan = await planAgentInstruction(dakyx, dakyx.pages, "Change font to Inter", { pageId: dakyxHome.id, selectedFieldId: heading.id });
    assert.equal(callsFor("Change font to Inter"), 0, "an exact command needs no model");
    assert.deepEqual(plan.pages.flatMap((page) => page.changes.map((change) => [change.fieldId, change.property, change.after])), [[heading.id, "font-family", "Inter"]]);
    assert.ok(plan.suggestions?.some((suggestion) => /whole site/.test(suggestion)));
  });
  await check("a site-wide font change leaves the browser title and search description alone", async () => {
    const plan = await planAgentInstruction(dakyx, dakyx.pages, "Change every font family to Inter", { pageId: dakyxHome.id });
    const ids = plan.pages.flatMap((page) => page.changes.map((change) => change.fieldId));
    assert.ok(ids.length > 10, `${ids.length} elements`);
    assert.ok(!ids.some((id) => id.startsWith("meta.")), "no meta field has a font");
  });

  console.log("\nExact commands are still rules");
  const site = await makeSite("Kumasi Bakery", [
    { title: "Home", path: "/", filePath: "index.html", html: homeHtml },
    { title: "About", path: "/about", filePath: "about.html", html: aboutHtml },
  ]);
  const home = site.pages.find((page) => page.path === "/")!;
  const about = site.pages.find((page) => page.path === "/about")!;
  const homeFields = discoverFields(homeHtml).fields;
  const by = (preview: string) => homeFields.find((field) => field.preview === preview)!;
  const rule = async (prompt: string, selected: string | null) => {
    const before = asked.length;
    const plan = await planAgentInstruction(site, site.pages, prompt, { pageId: home.id, selectedFieldId: selected });
    assert.equal(asked.length, before, `"${prompt}" needed no model`);
    return plan;
  };
  await check("delete this, duplicate this card, move this down", async () => {
    const loaf = by("Loaf");
    const removed = await rule("Delete this", loaf.id);
    assert.deepEqual(removed.structuralActions?.map((action) => [action.kind, action.fieldId]), [["remove", loaf.id]]);
    assert.equal(removed.requiresApproval, true, "a deletion always asks");
    const duplicated = await rule("duplicate this card", loaf.id);
    assert.deepEqual(duplicated.structuralActions?.map((action) => [action.kind, action.fieldId]), [["duplicate", loaf.parentId]], "the card around the heading");
    const card = homeFields.find((field) => field.id === loaf.parentId)!;
    const moved = await rule("move this down", card.id);
    assert.equal(moved.structuralActions?.[0]?.kind, "after");
  });
  await check("quoted words for the selected heading, a colour for the selection, undo", async () => {
    const h1 = by("Fresh bread every morning");
    const words = await rule("Change the heading to 'Fresh loaves daily'", h1.id);
    assert.equal(words.pages[0]?.edits[h1.id]?.value, "Fresh loaves daily");
    const hero = homeFields.find((field) => field.kind === "container" && field.tag === "section")!;
    const painted = await rule("make the background #fff7e6", hero.id);
    assert.match(painted.pages[0]?.edits[hero.id]?.style ?? "", /background-color: #fff7e6/);
    assert.equal((await rule("Undo", null)).editorCommand, "undo");
  });
  await check("a command naming something other than the selection goes to the model", async () => {
    const h1 = by("Fresh bread every morning");
    answer = () => ({});
    for (const prompt of ["Delete the pricing section", "change the heading to sound friendlier", "make the background blue"]) {
      const before = callsFor(prompt);
      await planAgentInstruction(site, site.pages, prompt, { pageId: home.id, selectedFieldId: prompt === "make the background blue" ? null : h1.id });
      assert.equal(callsFor(prompt) - before, 1, `"${prompt}" was the model's`);
    }
  });

  console.log("\nWhat the model is shown");
  await check("every element of the page, the facts, and nothing of DakyXTech's own business", async () => {
    answer = () => ({});
    await planAgentInstruction(site, site.pages, "Make the hero feel warmer", { pageId: home.id });
    const call = asked.at(-1)!;
    for (const field of homeFields) assert.ok(call.prompt.includes(`\n${field.id} `) || call.prompt.includes(` ${field.id} `), `${field.id} is in the outline`);
    assert.match(call.prompt, /Untrusted page data/);
    assert.match(call.prompt, /<facts>[\s\S]*1 picture has no description/);
    assert.match(call.system, /You are the Builder agent/);
    assert.match(call.system, /set_animation/, "the operations are in the fixed contract");
    assert.doesNotMatch(call.system, /DYNAMIC LIVING CONTEXT|OWNING AGENT PROCESS/, "the workforce's live state is DakyXTech's, not this customer's");
  });

  console.log("\nWhat the model can do");
  await check("a question with answers to tap", async () => {
    answer = () => ({ intent: "clarify", explanation: "Which should stand out: the Order now button or the links in the menu?", options: ["The Order now button", "The menu links", "Both", "Neither", "A fifth"] });
    const plan = await planAgentInstruction(site, site.pages, "Make the button stand out", { pageId: home.id });
    assert.equal(plan.actionKind, "clarify");
    assert.deepEqual(plan.options, ["The Order now button", "The menu links", "Both", "Neither"], "four at most");
    assert.equal(plan.summary.totalChanges, 0);
  });
  await check("animations, as the Interactions tab writes them, with a reason each", async () => {
    answer = (call) => ({
      explanation: "The price cards now rise into view.",
      pages: [{ pageId: home.id, changes: [
        { fieldId: idOf(call.prompt, '"Loaf"'), operation: "set_animation", property: "view", value: "fade-from-bottom", reason: "Draws the eye to the prices." },
        { fieldId: idOf(call.prompt, "logo"), operation: "set_animation", property: "loop", value: "slide-from-left", reason: "x" },
      ] }],
      suggestions: ["Make the cake card rise too", "Slow the animation down", "Review this page", "A fourth"],
    });
    const plan = await planAgentInstruction(site, site.pages, "Make the loaf price fade in as you scroll", { pageId: home.id });
    const change = plan.pages[0]?.changes[0];
    assert.equal(change?.after, "Fades in from the bottom as it scrolls into view");
    assert.equal(change?.reason, "Draws the eye to the prices.");
    assert.match(plan.pages[0]!.edits[change!.fieldId]!.style ?? "", /--dw-enter: dw-enter-up/);
    assert.doesNotMatch(plan.pages[0]!.edits[change!.fieldId]!.style ?? "", /--dw-enter-start/, "scroll into view, not page load");
    assert.match(plan.explanation, /Not changed: .*cannot play continuously/);
    assert.equal(plan.suggestions?.length, 3, "three suggestions at most");
  });
  await check("a new section, placed after the section its anchor is in, and signed", async () => {
    answer = (call) => ({ explanation: "Added an FAQ after the prices.", sections: [{ pageId: home.id, kind: "faq", anchorId: idOf(call.prompt, '"Loaf"'), position: "after" }] });
    const plan = await executeBuilderPlan(site, { action: "instruction", prompt: "Add an FAQ below the pricing", pageId: home.id }, null);
    const update = plan.documentHtmlUpdates?.[home.id];
    assert.ok(update?.signature, "a whole-page rewrite is signed for the person who asked");
    const at = update!.html.indexOf('id="sec-faq-');
    assert.ok(at > update!.html.indexOf("For birthdays and weddings.") && at < update!.html.indexOf('<section id="gallery"'), "between the pricing section and the gallery, never inside a card");
    assert.equal(plan.requiresApproval, true);
  });
  await check("a section asked for on another page goes there, not onto the open one", async () => {
    const prompt = "Add a testimonials section to the About page";
    answer = () => ({ explanation: "Added testimonials to About.", sections: [{ pageId: about.id, kind: "testimonials", anchorId: "", position: "end" }] });
    const plan = await planAgentInstruction(site, site.pages, prompt, { pageId: home.id });
    assert.equal(callsFor(prompt), 1, "the rule would have put it on the open page");
    assert.deepEqual(Object.keys(plan.documentHtmlUpdates ?? {}), [about.id]);
  });
  await check("a review: findings, fixes with reasons, and approval always", async () => {
    answer = (call) => ({
      intent: "review",
      explanation: "Two things would help most.",
      findings: [
        { title: "The oven picture has no description", detail: "Screen readers skip it.", severity: "high", fieldId: idOf(call.prompt, "oven.jpg") },
        { title: "One call to action", detail: "Only the hero asks for an order.", severity: "medium", fieldId: "" },
      ],
      pages: [{ pageId: home.id, changes: [{ fieldId: idOf(call.prompt, "oven.jpg"), operation: "set_alt", property: "", value: "The wood-fired oven at Kumasi Bakery", reason: "People who cannot see the picture hear what it shows." }] }],
    });
    const plan = await planAgentInstruction(site, site.pages, "Review this page", { pageId: home.id });
    assert.equal(plan.actionKind, "review");
    assert.equal(plan.findings?.length, 2);
    assert.equal(plan.requiresApproval, true);
    assert.equal(plan.pages[0]?.changes[0]?.reason, "People who cannot see the picture hear what it shows.");
    assert.notEqual(plan.routing?.level, "simple", "a review is never sized as a small task");
  });
  await check("most of an answer would not apply: asked again once, with the reasons", async () => {
    const prompt = "Make the order link red";
    answer = (call, index) => index === 0
      ? { pages: [{ pageId: home.id, changes: [{ fieldId: "s9.99", operation: "set_style", property: "color", value: "#c00", reason: "x" }] }] }
      : { explanation: "The Order now button is red.", pages: [{ pageId: home.id, changes: [{ fieldId: idOf(call.prompt, '"Order now"'), operation: "set_style", property: "color", value: "#c00", reason: "x" }] }] };
    const plan = await planAgentInstruction(site, site.pages, prompt, { pageId: home.id });
    assert.equal(callsFor(prompt), 2);
    assert.match(asked.at(-1)!.prompt, /could not be applied:\n- s9\.99 is not an element/);
    assert.equal(plan.summary.totalChanges, 1, plan.explanation);
  });
  await check("a page the request names is shown and changed; a page it does not is refused", async () => {
    const prompt = "On the About page, change the main heading to 'About Kumasi Bakery'";
    answer = (call) => ({ pages: [{ pageId: about.id, changes: [{ fieldId: idOf(call.prompt, '"Our story"', about.id), operation: "replace_text", property: "", value: "About Kumasi Bakery", reason: "x" }] }] });
    const named = await planAgentInstruction(site, site.pages, prompt, { pageId: home.id });
    assert.match(asked.at(-1)!.prompt, new RegExp(`<page id="${about.id}"`));
    assert.deepEqual(named.pages.map((page) => page.pageId), [about.id], named.explanation);
    answer = () => ({ pages: [{ pageId: about.id, changes: [{ fieldId: "s0.0", operation: "replace_text", property: "", value: "x", reason: "x" }] }] });
    const unseen = await planAgentInstruction(site, site.pages, "Make the heading shorter", { pageId: home.id });
    assert.equal(unseen.summary.totalChanges, 0);
    assert.match(unseen.explanation, /not shown About/);
  });
  await check("a move only beside a sibling, as the editor's own layout controls allow", async () => {
    answer = (call) => ({ structuralActions: [{ pageId: home.id, kind: "after", fieldId: idOf(call.prompt, '"Order now"'), targetId: idOf(call.prompt, '§"Our prices"'), label: "Order button" }] });
    const plan = await planAgentInstruction(site, site.pages, "Move the order button below the pricing cards", { pageId: home.id });
    assert.equal(plan.summary.totalChanges, 0);
    assert.match(plan.explanation, /same container/);
  });
  await check("a change the page already carries is said as that, not as a change", async () => {
    answer = (call) => ({ explanation: "Removed the heading's colour.", pages: [{ pageId: home.id, changes: [{ fieldId: idOf(call.prompt, '"Loaf"'), operation: "set_style", property: "color", value: "", reason: "x" }] }] });
    const plan = await planAgentInstruction(site, site.pages, "Take the colour off the loaf heading", { pageId: home.id });
    assert.equal(plan.summary.totalChanges, 0);
    assert.equal(plan.explanation, "Nothing needed changing: the page already says and shows that.");
  });
  await check("a simple request gets less room to answer than a review", async () => {
    answer = () => ({});
    await planAgentInstruction(site, site.pages, "make this bold", { pageId: home.id, selectedFieldId: by("Loaf").id });
    const bold = asked.at(-1)!;
    const review = asked.find((entry) => entry.request === "Review this page")!;
    assert.ok(bold.maxTokens > 0 && bold.maxTokens < review.maxTokens, `${bold.maxTokens} against ${review.maxTokens}`);
  });
} finally {
  for (const id of siteIds) await prisma.site.deleteMany({ where: { id } });
  await prisma.llmCall.deleteMany({ where: { purpose: { in: ["website.assistant", "routing.website.builder"] }, createdAt: { gte: startedAt } } });
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
}

console.log(`\n${passed} passed${failures.length ? `, ${failures.length} failed:\n  ${failures.join("\n  ")}` : ""}`);
process.exit(failures.length ? 1 : 0);
