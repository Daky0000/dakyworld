/**
 * The redesign call, against a fake Perplexity and a fake Claude.
 *
 * The thing being proved is that the decision about whether a homepage needs
 * rebuilding is made **by the vendor the Owner chose, from the picture** — and
 * that when that vendor cannot be shown the picture, the work moves to one that
 * can rather than being answered blind.
 *
 * Why each section is here:
 *
 *  - **The job routes to Perplexity.** It is the only job in the system that
 *    does, and it is a routing decision one edit could silently undo.
 *  - **The picture is on the wire.** Perplexity's adapter ignored images until
 *    this section existed. An adapter that quietly drops them answers with
 *    total confidence about a page nothing looked at, and there is no way to
 *    tell that answer from a real one afterwards.
 *  - **A vendor that refuses the picture loses the job.** Not the whole call:
 *    the chain moves to a model that can see, and the document says who
 *    decided.
 *  - **The reviewer's findings are handed over.** Two sections of one document
 *    disagreeing about one homepage is the fault this arrangement exists to
 *    prevent, and the only mechanism preventing it is that the decider is shown
 *    what the reviewer found.
 *  - **LEAVE_IT is a real answer**, and a model that answers it while also
 *    listing five changes has answered both ways. The list is dropped.
 *  - **The document prints it.** A call nobody renders is a call nobody reads.
 *
 * A database and a local express. No key: `PERPLEXITY_BASE_URL` and
 * `ANTHROPIC_BASE_URL` point the real adapters at the stub — see
 * checks/README.md.
 */
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

let bad = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(ok ? `  ok    ${label}` : `  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) bad += 1;
}

// --- The fake vendors --------------------------------------------------------

/** Every body each vendor was sent, so an assertion can read the wire. */
const perplexityRequests: any[] = [];
const anthropicRequests: any[] = [];

/**
 * What the fake Perplexity does next. Set per scenario.
 *
 * `scoreEach` is the number every one of the ten headings comes back with, so
 * a scenario can put the answer in a chosen band without writing out ten rows:
 * a flat 30 is a page in the REBUILD band and a flat 85 is one in LEAVE_IT,
 * which is what the verdict-coherence section needs to say.
 */
let perplexity: { mode: "answer" | "refuse"; call: string; scoreEach: number | null; direction: { change: string; why: string }[] } = {
  mode: "answer",
  call: "REBUILD",
  scoreEach: null,
  direction: [{ change: "Say what you sell on the first screen.", why: "Nothing there says it now." }],
};

/**
 * Ten headings whose weighted total is 42 — deliberately not a round number
 * and deliberately not any single one of the scores, so an implementation that
 * averaged them, took the first, or handed back a number the model supplied
 * would produce a different answer.
 *
 *   15×40 + 10×50 + 15×30 + 10×40 + 10×60 + 10×20 + 10×50 + 10×60 + 5×40 + 5×20
 *   = 6.0 + 5.0 + 4.5 + 4.0 + 6.0 + 2.0 + 5.0 + 6.0 + 2.0 + 1.0 = 41.5 → 42
 */
const SCORES: Record<string, number> = {
  VISUAL_DESIGN: 40,
  TYPOGRAPHY: 50,
  LAYOUT: 30,
  HIERARCHY: 40,
  NAVIGATION: 60,
  HERO: 20,
  BRANDING: 50,
  CONTENT: 60,
  IMAGERY: 40,
  CONVERSION: 20,
};

const EXPECTED_TOTAL = 42;

function verdictJson(call: string, direction: { change: string; why: string }[], scoreEach: number | null = null) {
  return JSON.stringify({
    call,
    scores: Object.entries(SCORES).map(([category, score]) => ({
      category,
      score: scoreEach ?? score,
      reasoning: "Judged from the picture.",
    })),
    headline: "The page is losing you the comparison before anybody reads it.",
    assessment: "A plain page with a stretched photograph across the top and no statement of what is sold.",
    issues: [
      {
        category: "HIERARCHY",
        title: "Nothing on the first screen says what they do",
        observed: "Nothing on the first screen says what the business does.",
        view: "desktop",
        costsThem: "A visitor goes back to the search results.",
        severity: "CRITICAL",
        necessity: "MUST_FIX",
      },
      // Deliberately attributed to a picture that was not taken in one of the
      // scenarios below, so the snap-back can be asserted.
      {
        category: "LAYOUT",
        title: "The menu covers the whole screen",
        observed: "The menu covers the whole screen.",
        view: "mobile",
        costsThem: "Nobody on a phone reaches the number.",
        severity: "HIGH",
        necessity: "SHOULD_FIX",
      },
    ],
    sections: [
      { name: "the bar across the top", view: "desktop", works: "The name is legible.", doesNotWork: "There is no way to make contact from it.", severity: "MEDIUM", needsRebuilding: false },
      { name: "the first screen", view: "desktop", works: "The photograph is large.", doesNotWork: "It says nothing about the business.", severity: "CRITICAL", needsRebuilding: true },
    ],
    impact: {
      trust: "It reads as a smaller firm than it is.",
      usability: "The number is three scrolls down.",
      conversion: "A builder comparing three suppliers picks one of the other two.",
      howItFeels: "Like walking into a shop with the lights off.",
    },
    firstLook: {
      score: 30,
      whoTheyAre: true,
      whatTheyDo: false,
      whyItMatters: false,
      whyBelieveThem: false,
      whatToDoNext: false,
      explanation: "A stranger leaves with a name and nothing else.",
    },
    standing: {
      looksEstablished: false,
      assessment: "It looks newer and smaller than a firm of this age should.",
      whatUnderminesIt: ["The photograph is stretched out of shape."],
    },
    age: { era: "CLEARLY_OUTDATED", why: "The lettering and the spacing are of a period." },
    problems: [
      { problem: "Nobody can tell what is sold", whyItMatters: "The comparison is lost before it starts.", evidence: "The first screen carries a photograph and a name.", severity: "CRITICAL" },
    ],
    strengths: [
      { strength: "The name is clear and well set", why: "It is the one thing a rebuild should keep." },
      { strength: "The photograph is their own", why: "Real premises beat stock pictures." },
      { strength: "The page loads to something", why: "There is a foundation to work from." },
    ],
    worthIt: { answer: "YES", why: "The gap between what they are and what the page says is wide." },
    direction,
    bottomLine: {
      quality: "A page that was made once and never revisited.",
      biggestReason: "Nobody can tell what is sold.",
      biggestStrength: "The name is well set.",
      recommendation: "Build it again, and start from what you sell.",
    },
    summary: "Your website is doing less for you than it should. Somebody who has never heard of you cannot tell in five seconds what you sell.",
  });
}

const app = express();
app.use(express.json({ limit: "25mb" }));

app.post("/perplexity/v1/sonar", (req, res) => {
  perplexityRequests.push(req.body);
  if (perplexity.mode === "refuse") {
    // What a vendor says when it will not take the picture it was sent. The
    // status matters: anything but a refusal has to fail over.
    return res.status(400).json({ error: { message: "This model does not accept image content." } });
  }
  res.json({
    id: "pplx-check",
    model: req.body?.model ?? "sonar",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: verdictJson(perplexity.call, perplexity.direction, perplexity.scoreEach) } }],
    search_results: [{ title: "What law firm websites look like in 2026", url: "https://example.com/design", date: "2026-08-01" }],
    usage: { prompt_tokens: 1400, completion_tokens: 320 },
  });
});

app.post("/anthropic/v1/messages", (req, res) => {
  anthropicRequests.push(req.body);
  res.json({
    id: "msg_check_redesign",
    type: "message",
    role: "assistant",
    model: req.body?.model ?? "claude-opus-5",
    content: [{ type: "text", text: verdictJson("REBUILD", [{ change: "Put the phone number in the header.", why: "It is the only thing most visitors want." }]) }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 900, output_tokens: 210, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  });
});

const server: Server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const PORT = (server.address() as AddressInfo).port;

const settings = await import("../src/lib/settings.js");
const { prisma } = await import("../src/lib/prisma.js");
const { encodePng } = await import("../src/services/png.js");

/** A real PNG, so nothing downstream has to guess at its size. */
function picture(width: number, height: number): string {
  return encodePng(width, height, new Uint8Array(width * height * 4).fill(0x88)).toString("base64");
}

const DESKTOP = picture(64, 96);
const PHONE = picture(32, 64);

const { decideRedesign, callLabel, callForScore, weighApart, agreeWithTheNumbers, normaliseCall, CATEGORY_WEIGHTS, CATEGORIES } = await import(
  "../src/services/audit/redesign.js"
);
const { auditMarkdown } = await import("../src/services/audit/markdown.js");
const { JOBS, PROVIDERS, needsSight, FREE_LADDER_BY_JOB, FREE_MODELS } = await import("../src/lib/models/registry.js");

/**
 * When this run started, so its own ledger rows can be taken back out.
 *
 * This file drives a real `callModel`, and a real `callModel` writes `LlmCall`
 * rows — money rows that `checks/costs.ts` sums over an hour band. checks/README
 * rule 3: a check that creates rows deletes them, scoped to its own purpose and
 * to this moment.
 */
const startedAt = new Date();

function shot(view: "desktop" | "mobile", base64: string) {
  return {
    view,
    result: {
      base64,
      shot: {
        id: view,
        requested: "https://example.com/",
        finalUrl: "https://example.com/",
        imageUrl: null,
        mediaType: "image/png",
        width: view === "mobile" ? 32 : 64,
        height: view === "mobile" ? 64 : 96,
        viewportWidth: view === "mobile" ? 390 : 1280,
        cropped: true,
        insecure: false,
        partiallyLoaded: false,
        takenAt: new Date().toISOString(),
        costUsd: 0,
      },
      note: null,
    },
  } as any;
}

function evidenceWith(shots: any[], overrides: Record<string, unknown> = {}) {
  return {
    requested: "example.com",
    finalUrl: "https://example.com/",
    status: 200,
    reachable: true,
    fetch: {} as any,
    page: null,
    seo: null,
    security: null,
    robots: {} as any,
    shots,
    rendered: null,
    notes: [],
    stepNotes: { screenshots: [], rendered: [] },
    costUsd: 0,
    ...overrides,
  } as any;
}

const BUSINESS = { name: "Bridgefield Law", trade: "Law firm", town: "Accra" };

const FINDING = {
  id: "ux-1",
  discipline: "UX" as const,
  severity: "HIGH" as const,
  title: "Nothing above the fold says what they do",
  observed: "The first screen carries a photograph and a name and no statement of the service.",
  evidence: "the hero, desktop view",
  impact: "A visitor leaves without learning anything.",
  plainly: "Somebody landing on your site cannot tell what you do.",
  recommendation: "Put one line under the name saying what you handle.",
  region: null,
  marker: null,
};

function reset() {
  perplexityRequests.length = 0;
  anthropicRequests.length = 0;
  perplexity = {
    mode: "answer",
    call: "REBUILD",
    scoreEach: null,
    direction: [{ change: "Say what you sell on the first screen.", why: "Nothing there says it now." }],
  };
}

// Point both vendors at the stub, and leave the other three unconnected so the
// chain cannot reach a wire this file is not watching.
process.env.PERPLEXITY_BASE_URL = `http://127.0.0.1:${PORT}/perplexity`;
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${PORT}/anthropic`;
process.env.PERPLEXITY_API_KEY = "pplx-check-not-a-real-key";
process.env.ANTHROPIC_API_KEY = "sk-ant-check-not-a-real-key";
for (const key of ["OPENAI_API_KEY", "GEMINI_API_KEY", "NVIDIA_API_KEY"]) process.env[key] = "";
settings.clearSettingsCache();

// --- 1. The routing ----------------------------------------------------------
console.log("Who the job belongs to");
{
  check("the redesign call is routed to Perplexity", JOBS.redesign.defaultProvider === "perplexity", JOBS.redesign.defaultProvider);
  check("and Perplexity declares it", PROVIDERS.perplexity.jobs.includes("redesign"));
  // The distinction the whole arrangement rests on: this vendor decides from a
  // picture, it does not describe one.
  check("but never the looking", !PROVIDERS.perplexity.jobs.includes("vision"));
  check("it is a job that carries a picture", needsSight("redesign") && needsSight("vision"));

  // A blind rung here means an Apify screenshot bought and never read.
  const blind = FREE_LADDER_BY_JOB.redesign.filter((id) => {
    const model = FREE_MODELS.find((entry) => entry.id === id);
    return model ? !model.vision : false;
  });
  check("every free rung under it can see", blind.length === 0, blind.join(", "));

  // Whoever the chain reaches has to be able to open the picture.
  const chain = Object.values(PROVIDERS).filter((provider) => provider.jobs.includes("redesign"));
  check("and so can every vendor in the chain", chain.every((provider) => provider.jobs.includes("vision") || provider.key === "perplexity"), chain.map((p) => p.key).join(", "));
}

// --- 2. The picture is on the wire -------------------------------------------
console.log("\nWhat Perplexity is actually sent");
{
  reset();
  const result = await decideRedesign(evidenceWith([shot("desktop", DESKTOP), shot("mobile", PHONE)]), BUSINESS, [FINDING]);

  check("the call comes back", result.verdict !== null, result.notes.join(" "));
  check("decided by Perplexity", result.verdict?.decidedBy === "Perplexity", result.verdict?.decidedBy);
  check("and nobody else was asked", anthropicRequests.length === 0);

  const body = perplexityRequests[0];
  const content = body?.messages?.[1]?.content ?? [];
  const images = Array.isArray(content) ? content.filter((part: any) => part?.type === "image_url") : [];
  check("both pictures are on the wire", images.length === 2, JSON.stringify(images.length));
  check("as data, not as a link that expires", String(images[0]?.image_url?.url ?? "").startsWith("data:image/png;base64,"));
  // The whole point of the section: the bytes the actor produced are the bytes
  // the decision was made from.
  check("and the bytes are the ones photographed", String(images[0]?.image_url?.url ?? "").endsWith(DESKTOP));
  check("the words come first", Array.isArray(content) && content[0]?.type === "text");

  const words = Array.isArray(content) ? (content.find((part: any) => part?.type === "text")?.text ?? "") : "";
  check("it is told what it is looking at", words.includes("Bridgefield Law") && words.includes("https://example.com/"));
  // Handed over so the two sections of one document cannot contradict.
  check("and what the reviewer already found", words.includes("Nothing above the fold says what they do"), words.slice(-200));
  check("with the instruction not to contradict it", words.includes("you may not contradict it"));

  const system = body?.messages?.[0]?.content ?? "";
  check("the doctrine reaches it", system.includes("You are deciding, not reviewing"));
  check("with the plain-words rule on the paragraph", system.includes("no hero, above the fold, CTA"));

  check("the searched sources are kept", (result.verdict?.sources.length ?? 0) === 1, JSON.stringify(result.verdict?.sources));
}

// --- 3. A vendor that will not take the picture -------------------------------
console.log("\nWhen Perplexity refuses the picture");
{
  reset();
  perplexity.mode = "refuse";
  const result = await decideRedesign(evidenceWith([shot("desktop", DESKTOP)]), BUSINESS, [FINDING]);

  check("Perplexity was asked first", perplexityRequests.length === 1);
  check("the call is still made", result.verdict !== null, result.notes.join(" "));
  // Not answered blind, and not abandoned: moved to a vendor that can see.
  check("by a vendor that can see", result.verdict?.decidedBy === "Claude", result.verdict?.decidedBy);
  check("which was sent the picture too", (anthropicRequests[0]?.messages?.[0]?.content ?? []).some((part: any) => part?.type === "image"));
  check("and the document says who decided", result.notes.some((note) => note.includes("Perplexity")), result.notes.join(" "));
}

// --- 4. A picture too big for the vendor --------------------------------------
console.log("\nWhen the picture is past what Perplexity accepts");
{
  reset();
  // Larger than the documented 5MB ceiling. The failure that matters is not the
  // 413 — it is a request that arrives with the words and without the picture,
  // and is answered anyway.
  const huge = "A".repeat(5 * 1024 * 1024 + 10);
  const result = await decideRedesign(evidenceWith([shot("desktop", huge)]), BUSINESS, []);
  check("Perplexity is not sent a picture it cannot open", perplexityRequests.length === 0);
  check("and the call is made by somebody who can", result.verdict?.decidedBy === "Claude", result.verdict?.decidedBy ?? result.notes.join(" "));
}

// --- 5. The answer is cleaned up ----------------------------------------------
console.log("\nWhat comes back");
{
  reset();
  // One picture, and a model that attributes a point to the other one.
  const result = await decideRedesign(evidenceWith([shot("desktop", DESKTOP)]), BUSINESS, []);
  const views = result.verdict?.issues.map((issue) => issue.view) ?? [];
  check("no observation is filed against a picture nobody took", views.every((view) => view === "desktop"), views.join(", "));

  reset();
  // A page that is fine, decided by a model that then lists changes to it.
  // Scored in the band that answer belongs to, or the coherence guard below
  // would correctly overrule it and this would be a test of that instead.
  perplexity.call = "LEAVE_IT";
  perplexity.scoreEach = 85;
  const fine = await decideRedesign(evidenceWith([shot("desktop", DESKTOP)]), BUSINESS, []);
  check("a page that needs nothing is a real answer", fine.verdict?.call === "LEAVE_IT", `${fine.verdict?.call} at ${fine.verdict?.score}`);
  check("and it is not given a list of changes as well", (fine.verdict?.direction.length ?? 0) === 0, JSON.stringify(fine.verdict?.direction));
  check("the heading says so plainly", callLabel("LEAVE_IT") === "This page does not need a redesign");
}

// --- 5b. The scorecard is arithmetic, not an opinion --------------------------
console.log("\nThe scorecard");
{
  reset();
  const result = await decideRedesign(evidenceWith([shot("desktop", DESKTOP), shot("mobile", PHONE)]), BUSINESS, []);
  const verdict = result.verdict!;

  check("the ten headings are worth a hundred between them", Object.values(CATEGORY_WEIGHTS).reduce((a, b) => a + b, 0) === 100);
  check("every heading comes back, once", verdict.scores?.length === CATEGORIES.length, String(verdict.scores?.length));

  // The whole point of computing it here: the model is never asked for the
  // total and could not have supplied this number.
  check("the total is the weighted sum, worked out in code", verdict.score === EXPECTED_TOTAL, `${verdict.score} vs ${EXPECTED_TOTAL}`);
  check(
    "and each row shows its own contribution",
    (verdict.scores ?? []).every((row) => Math.abs(row.points - (row.score * row.weight) / 100) < 0.06),
    JSON.stringify(verdict.scores?.slice(0, 2)),
  );
  check(
    "the weights are the code's, whatever the model says",
    (verdict.scores ?? []).every((row) => row.weight === CATEGORY_WEIGHTS[row.category]),
  );

  // A heading the model left out is nought and says so, rather than being
  // dropped out of a total that then describes nine tenths of a page.
  const short = weighApart([{ category: "LAYOUT", score: 100, reasoning: "Fine." }]);
  check("a heading nobody scored counts as nothing", short.score === 15, String(short.score));
  check("and every heading is still in the list", short.scores.length === CATEGORIES.length);
  check("with the gap said rather than hidden", short.scores.some((row) => row.reasoning.includes("not scored")));

  check("the bands are the ones the contract states", callForScore(85) === "LEAVE_IT" && callForScore(75) === "REFINE" && callForScore(65) === "REDESIGN" && callForScore(42) === "REBUILD");
}

// --- 5c. The verdict has to be reachable from the working ---------------------
console.log("\nWhen the verdict and the scores disagree");
{
  // One band apart is judgement, and judgement is why a model is asked.
  const near = agreeWithTheNumbers("REDESIGN", 75);
  check("one step from the arithmetic is left alone", near.call === "REDESIGN" && near.adjusted === null, near.adjusted ?? near.call);

  reset();
  // Three bands apart: a page scored in the forties, declared fine.
  perplexity.call = "LEAVE_IT";
  perplexity.scoreEach = 30;
  const argued = await decideRedesign(evidenceWith([shot("desktop", DESKTOP)]), BUSINESS, []);
  check("two or more is pulled back to the score", argued.verdict?.call === "REBUILD", `${argued.verdict?.call} at ${argued.verdict?.score}`);
  check("what the arithmetic said is kept beside it", argued.verdict?.scoreCall === "REBUILD");
  // Recorded rather than done quietly, and never in the client-facing PDF.
  check("and the move is written down", Boolean(argued.verdict?.adjusted), argued.verdict?.adjusted ?? "nothing");
  check("but it is not filed as something that could not be checked", !argued.notes.join(" ").includes("scorecard"), argued.notes.join(" "));

  // A stored report from before the four-call split still renders.
  check("the call this replaced still reads", normaliseCall("TARGETED_FIXES") === "REFINE");
  check("and an unknown one does not crash the page", normaliseCall("SOMETHING_ELSE") === "REDESIGN");
}

// --- 6. No picture, no call ---------------------------------------------------
console.log("\nWhen there is no picture");
{
  reset();
  const result = await decideRedesign(evidenceWith([], { stepNotes: { screenshots: ["The screenshot actor is not on this Apify account."], rendered: [] } }), BUSINESS, []);
  check("no model is asked", perplexityRequests.length === 0 && anthropicRequests.length === 0);
  check("there is no call", result.verdict === null);
  // The rule the UI/UX section learned expensively: say what happened, never
  // what usually happens.
  check("and the reason given is the real one", result.notes.some((note) => note.includes("not on this Apify account")), result.notes.join(" "));
  check("with no cause invented", !result.notes.join(" ").includes("usually"));
}

// --- 7. The document prints it ------------------------------------------------
console.log("\nThe report");
{
  reset();
  const decided = await decideRedesign(evidenceWith([shot("desktop", DESKTOP)]), BUSINESS, [FINDING]);
  const markdown = auditMarkdown({
    leadId: null,
    businessName: BUSINESS.name,
    website: "https://example.com/",
    ranAt: new Date().toISOString(),
    overallScore: 0,
    scored: false,
    verdict: "Not scored",
    disciplines: [],
    synthesis: null,
    redesign: decided.verdict,
    screenshots: [],
    notes: [],
    costUsd: 0,
  } as any);

  check("the call has its own heading", markdown.includes("## Does this page need a redesign?"));
  check("with the decision in it", markdown.includes("This page should be built again"));
  check("and the score, with its band", markdown.includes(`How the page looks: ${EXPECTED_TOTAL}/100 — Weak`));
  // Two numbers in one document is a fault unless the document says which is
  // which, and this one carries the site's own score at the top.
  check("saying what that number is and is not", markdown.includes("This number is about how the page looks, and only that."));
  check("the working is printed rather than asserted", markdown.includes("| **Overall** | **100** |"));
  check("the page is read top to bottom", markdown.includes("### The page, top to bottom") && markdown.includes("the first screen"));
  check("the five-second test is its own score", markdown.includes("### Five seconds on it — 30/100"));
  check("what is already good is not dropped from a bad review", markdown.includes("### What is already good"));
  check("and the ranked problems are there", markdown.includes("### The biggest problems, worst first"));
  check("the proposal paragraph is marked out", markdown.includes("### The paragraph for a proposal"));
  check("and it is the paragraph itself", markdown.includes("Your website is doing less for you than it should"));
  // These are pages about how sites look now, not evidence about this business.
  check("the sources are labelled for what they are", markdown.includes("What the decider read while deciding"));
  // The agent whose wording made the call, then the vendor that answered — the
  // same shape every other section of the document ends on.
  check("who made the call is on the page", markdown.includes("made this call from the pictures above") && markdown.includes("Perplexity."));
}

await prisma.llmCall.deleteMany({ where: { purpose: "audit.redesign", createdAt: { gte: startedAt } } });
await prisma.$disconnect();
server.close();

console.log(bad === 0 ? "\nAll redesign checks passed" : `\n${bad} redesign check(s) failed`);
process.exit(bad === 0 ? 0 : 1);
