/**
 * What a forty-word message is actually told, and who writes it.
 *
 * The founder's report was that the WhatsApp drafts "are not related to
 * context", written against a pipeline that researches a business, fetches its
 * site, photographs its homepage twice and puts four reviewers over it. Three
 * separate faults produced that one sentence, and none of them would fail a
 * typecheck or show up on any screen:
 *
 *  - **The agent path never looked.** `POST /messages/draft` has prepared the
 *    lead since the phone channels shipped; the `message.draft` *tool* went
 *    straight to `resolveContext`, so an agent drafting for a scraped row was
 *    handed one fact — "Nobody has looked at this business yet" — and asked to
 *    write something specific from it.
 *  - **The facts were a letter's facts.** `buildFacts` composes evidence for a
 *    cold email and says so in the words — "THIS LETTER ARGUES FROM IT", "put
 *    it in the letter on its own line", "I have put them in a short report and
 *    attached it". Handed whole to a writer producing a chat bubble, that is
 *    instructions for a different job, and a model given instructions for a
 *    different job falls back to the generic message it already knew. This
 *    codebase has paid for that failure twice already; `angle()` and the
 *    scenario cancelling each other out was the same shape.
 *  - **The strength was computed and thrown away.** The route worked out
 *    whether there was any case at all, printed it on the screen in amber, and
 *    never told the drafter — so a business with nothing wrong with it got a
 *    confident pitch, because writing one is what the drafter was asked to do.
 *
 * And the routing half: cold outreach is its own model job now, served by the
 * vendor that reads the live web while it answers. That is the *reason* for the
 * fence asserted below — a searching model can return a fault about a business
 * nobody in this system checked, told to the one person who knows whether it is
 * true — so the request must go out pinned to the prospect's own domain and the
 * contract must carry the rule in words for the leads that have no domain.
 *
 * The negatives are half of this file, and they are the ones that catch the
 * next version of the bug:
 *
 *  - **A fact is never rewritten**, only kept or dropped. Swapping "letter" for
 *    "message" across the block would turn "We already emailed them 3 days ago"
 *    into a false statement about what this company did.
 *  - **A demo link, the guard on what may not be claimed and the strongest
 *    point are never among the lines cut for the cap.**
 *  - **A client email must not be routed to the outreach job.** A project
 *    update to somebody we have billed for a year is not a cold approach, and
 *    a model that searches has no business writing one.
 *  - **A lead with no website is not fenced to a guessed domain.**
 *
 * A database, and a fake Perplexity on localhost. No API key and no network.
 *   npx tsx checks/coldOutreach.ts
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

const failures: string[] = [];
let passed = 0;

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed += 1;
    console.log(`  ok    ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Every body the model layer sent to the fake vendor, in order. */
const sent: Record<string, any>[] = [];

function fakePerplexity(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        const body = raw ? JSON.parse(raw) : {};
        sent.push({ ...body, __path: req.url });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            // Shaped like the vendor's, filled from the caller's own schema —
            // a stub that answers with something else is a stub that would let
            // a broken adapter pass.
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    body: "Hi Kwame — Daky here from Dakyworld, we look after IT for businesses around Kumasi. Your number is not tappable on a phone. Want the screenshot?",
                    rationale: "Opened on the strongest confirmed observation.",
                    confidence: 0.7,
                  }),
                },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 900, completion_tokens: 60 },
            search_results: [],
          }),
        );
      });
    });
    // Port 0 and read it back, per checks/README — four files here bind a fixed
    // port and the collisions surface as failures in files nobody touched.
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

const stub = await fakePerplexity();
process.env.PERPLEXITY_BASE_URL = stub.url;

const { phoneFacts, buildMessagePrompt, draftMessage } = await import("../src/lib/messageDrafter.js");
const { modelJobFor } = await import("../src/lib/emailDrafter.js");
const { ownDomain } = await import("../src/services/emailContext.js");
const { JOBS, PROVIDERS, FREE_LADDER_BY_JOB, MODEL_JOBS, routeFor } = await import("../src/lib/models/registry.js");
const { SETTING, deleteSetting, getSetting, setSetting } = await import("../src/lib/settings.js");
const { checkTemplate, STARTER_TEMPLATES } = await import("../src/services/whatsappTemplates.js");
const { prisma } = await import("../src/lib/prisma.js");

const startedAt = new Date();

// --- The evidence, as `buildFacts` really writes it -------------------------

const STRONGEST =
  "THE STRONGEST THING TO OPEN ON (high, something they can see on their own page): Somebody landing on your website cannot tell in five seconds what you sell. What it costs them: they leave before finding out. You can say this because: read off the first screen of the homepage";
const GUARD =
  "WHAT YOU MAY NOT CLAIM, because the evidence does not support it: that the site is slow; that anybody has stopped buying";
const OFFER = "WHAT TO OFFER: the fix itself. The one thing found is small and specific.";
const DEMO =
  "A demo page has been built for them at https://os.dakyworld.com/demos/accra-dental — Accra Dental Centre, headlined \"Book a dentist in Adum\". Status: ready, not opened yet.";
const LETTER_MECHANICS =
  "THE FULL REVIEW WAS RUN AND THIS LETTER ARGUES FROM IT, NOT FROM THE QUICK CHECKS. Four reviewers went over their site. It came out at 61 out of 100 — \"needs work\". Never put that number in the letter.";
const REVIEW_PARAGRAPH =
  "HOW THE REVIEW PUT IT TO THEM, in full — use its language, do not use the whole paragraph: The page reads as though it were built for a different business.";
const EMAILED_BEFORE = 'We already emailed them 3 days ago: "your booking form"';

const FACTS = [
  "Contact name: Kwame Mensah",
  "Business: Accra Dental Centre",
  "Business type: dental clinic",
  "City: Kumasi, Ashanti, Ghana",
  "Website: https://www.accradental.com",
  "Google rating: 4.6 from 212 reviews",
  "How we found them: google maps",
  "Which list: Healthcare",
  "Pipeline status: NEW",
  "Lead score (0-100, how reachable and sellable-to): 62",
  "Estimated deal size: GHS 8000",
  EMAILED_BEFORE,
  DEMO,
  STRONGEST,
  LETTER_MECHANICS,
  GUARD,
  OFFER,
  REVIEW_PARAGRAPH,
  "Found in the review — high: the phone number is not tappable (seen on the phone screenshot)",
  "Found in the review — medium: no link preview image (checked in the markup)",
  "Found in the review — medium: the footer year is 2023 (seen on the page)",
  "Found in the review — low: no favicon (checked in the markup)",
  "Found in the review — low: heading levels skip (checked in the markup)",
  "Found in the review — low: no alt text on four images (checked in the markup)",
  "Found in the review — low: the contact form has no label (checked in the markup)",
  "Found in the review — low: the map embed loads on first paint (measured)",
  "Found in the review — low: two links go nowhere (verified by request)",
  "Already good, and worth conceding in a sentence: the certificate is valid; the page opens quickly",
  "What was actually checked: the homepage; the mail domain; the certificate",
];

console.log("\nWhat a message of forty words is told");

const selected = phoneFacts(FACTS);
const joined = selected.join("\n");

check("the strongest point leads", selected[0] === STRONGEST, selected[0]?.slice(0, 60));
check("the guard on what may not be claimed survives", selected.includes(GUARD));
check("what to offer survives", selected.includes(OFFER));
check("the demo link survives", selected.includes(DEMO));
check("the letter's own mechanics are dropped", !joined.includes("THE FULL REVIEW WAS RUN"));
check("the review's paragraph is dropped", !joined.includes("HOW THE REVIEW PUT IT TO THEM"));
check("the site score never reaches the writer", !joined.includes("61 out of 100"));
check("the pipeline's own bookkeeping is dropped", !joined.includes("Lead score") && !joined.includes("Pipeline status"));
check("the deal size never reaches the writer", !joined.includes("Estimated deal size"));

// The negative that matters most: selection, never rewriting. Every line that
// survives has to be byte-identical to the one `buildFacts` wrote, or a fact
// can no longer be traced back to the record it came from.
const heldBackLine = selected.find((fact) => fact.includes("deliberately not listed here"));
const carried = selected.filter((fact) => fact !== heldBackLine);
check(
  "every surviving line is byte-identical to the fact it came from",
  carried.every((fact) => FACTS.includes(fact)),
  carried.find((fact) => !FACTS.includes(fact)),
);
check("a true statement about our own history is not reworded", selected.includes(EMAILED_BEFORE));

check("the rest are held back rather than dumped", Boolean(heldBackLine), "no held-back line");
check(
  "the held-back line forbids referring to them",
  Boolean(heldBackLine && /Do not refer to them/.test(heldBackLine)),
);
check("the selection is shorter than the letter's", selected.length < FACTS.length, `${selected.length} of ${FACTS.length}`);

// A thin lead is the other half. Nothing to hold back, and the one line saying
// nobody has looked must survive — it is what stops a model reaching for
// something specific that was never established.
const thin = phoneFacts([
  "Contact name: Ama",
  "Business: Ama's Kitchen",
  "Website: none found — this is the strongest reason to write to them",
  "Nobody has looked at this business yet — no research, no check of their site, no look at their homepage. Keep the email short rather than reaching for something specific that is not here.",
]);
check("a thin record loses nothing", thin.length === 4);
check("nothing is held back when there is nothing to hold back", !thin.some((fact) => fact.includes("deliberately not listed")));

// --- The prompt the model is actually handed --------------------------------

console.log("\nThe composed instruction");

const leadContext = (over: Partial<{ website: string }> = {}) => ({
  kind: "lead" as const,
  email: "kwame@accradental.com",
  phone: "0244123456",
  name: "Kwame Mensah",
  facts: FACTS,
  variables: {
    first_name: "Kwame",
    contact_name: "Kwame Mensah",
    company: "Accra Dental Centre",
    city: "Kumasi",
    category: "dental clinic",
    website: over.website ?? "https://www.accradental.com",
    rating: "4.6",
  },
  leadId: "checkcoldoutreachlead",
});

const withSite = await buildMessagePrompt({
  channel: "WHATSAPP",
  purpose: "COLD_OUTREACH",
  context: leadContext(),
  caseStrength: "STRONG",
});

check("it says which of the two messages this is", withSite.user.includes("Which message this is:"));
check(
  "a business with a site is told to open on the strongest single thing",
  withSite.user.includes("Open on the one thing named as the strongest"),
);
check("it is told how far the evidence goes", withSite.user.includes("How far the evidence goes:"));
check("a strong case says so", withSite.user.includes("The evidence here is strong."));
check("the letter's mechanics are absent from the whole instruction", !withSite.user.includes("THE FULL REVIEW WAS RUN"));

const noSite = await buildMessagePrompt({
  channel: "WHATSAPP",
  purpose: "COLD_OUTREACH",
  context: leadContext({ website: "" }),
  caseStrength: "NONE",
});
check("a business with no site gets the other message", noSite.user.includes("They have no website. That is the message."));
check(
  "no case at all is stated in the words that stop a pitch",
  noSite.user.includes("**There is no real case here.**") && noSite.user.includes("set confidence low"),
);

// The negative that would be the expensive one to get wrong. A client's facts
// are invoices, projects and care plans, and on a payment reminder any of them
// may be the entire point of the message — a cap there is a chase that never
// reaches the overdue invoice.
const clientFacts = [
  "Client: Accra Dental Centre",
  "Sector: healthcare",
  "Main contact: Kwame Mensah, Practice Manager",
  "Client since: 8 months ago",
  "Lifetime value: GHS 42000",
  "Payment terms: 14 days",
  "On a growth care plan at GHS 3000/month, 6 hours included",
  'Project "Website rebuild" (WEBSITE) — active, next milestone "Content sign-off"',
  'Project "Email migration" (SUPPORT) — complete, all milestones complete',
  "Invoice DW-2026-002 for GHS 4500 — paid",
  "Invoice DW-2026-005 for GHS 3000 — paid",
  "Invoice DW-2026-008 for GHS 3000 — paid",
  "Invoice DW-2026-011 for GHS 3000 — paid",
  "Invoice DW-2026-014 for GHS 4500 — sent, OVERDUE since Mon Aug 24 2026",
  'We emailed them 6 days ago: "invoice DW-2026-014"',
];
const chase = await buildMessagePrompt({
  channel: "SMS",
  purpose: "INVOICE_REMINDER",
  context: {
    kind: "client",
    email: "kwame@accradental.com",
    phone: "0244123456",
    name: "Kwame Mensah",
    facts: clientFacts,
    variables: { first_name: "Kwame", contact_name: "Kwame Mensah", company: "Accra Dental Centre", client_name: "Accra Dental Centre", sector: "healthcare" },
    clientId: "checkcoldoutreachclient",
  },
});
check("a client's facts are never capped", clientFacts.every((fact) => chase.user.includes(fact)));
check("the overdue invoice reaches a payment chase", chase.user.includes("DW-2026-014"));
check("nothing is held back from a client message", !chase.user.includes("deliberately not listed here"));

const unknownStrength = await buildMessagePrompt({
  channel: "WHATSAPP",
  purpose: "COLD_OUTREACH",
  context: leadContext(),
});
check(
  "a strength nobody worked out is left unsaid rather than guessed",
  !unknownStrength.user.includes("How far the evidence goes:"),
);

// Two accounts of one message is the failure this repository has already paid
// for twice, so the angle belongs to a first approach and nothing else: a
// follow-up keeps the same issue, and a demo-ready message is the link.
const followUp = await buildMessagePrompt({
  channel: "WHATSAPP",
  purpose: "FOLLOW_UP",
  context: leadContext(),
  caseStrength: "STRONG",
});
check("a follow-up is not told to open on the strongest thing", !followUp.user.includes("Which message this is:"));
check("a follow-up is still told how far the evidence goes", followUp.user.includes("How far the evidence goes:"));

const demoReady = await buildMessagePrompt({
  channel: "WHATSAPP",
  purpose: "DEMO_READY",
  context: leadContext({ website: "" }),
  caseStrength: "NONE",
});
check("a demo-ready message gets no angle", !demoReady.user.includes("Which message this is:"));
check("and is not told there is no case for sending it", !demoReady.user.includes("How far the evidence goes:"));

check(
  "the contract carries the live-search rule",
  withSite.system.includes("that search may only confirm"),
);
check(
  "the live-search rule is in the contract, not the doctrine",
  withSite.system.indexOf("that search may only confirm") >
    withSite.system.indexOf("How to return this answer"),
);

// --- Which vendor writes it -------------------------------------------------

console.log("\nThe routing");

check("cold outreach is a job of its own", MODEL_JOBS.includes("outreach"));
check("it is routed to Perplexity by default", JOBS.outreach.defaultProvider === "perplexity");
check("NVIDIA is behind it", JOBS.outreach.fallback === "nvidia");
check("it has a free ladder", (FREE_LADDER_BY_JOB.outreach ?? []).length === 3);
check(
  "every vendor that can write prose can also write outreach",
  (["anthropic", "openai", "gemini", "perplexity", "nvidia"] as const).every(
    (key) => !PROVIDERS[key].jobs.includes("text") || PROVIDERS[key].jobs.includes("outreach"),
  ),
);
check("a cold email routes to it", modelJobFor("COLD_OUTREACH") === "outreach");
check("a follow-up routes to it", modelJobFor("FOLLOW_UP") === "outreach");
check("a client project update does not", modelJobFor("PROJECT_UPDATE") === "text");
check("an invoice does not", modelJobFor("INVOICE_DELIVERY") === "text");

check("a known site fences the search to their own domain", JSON.stringify(ownDomain(leadContext())) === '["accradental.com"]');
check("a lead with no site is not fenced to a guess", ownDomain(leadContext({ website: "" })) === undefined);
check(
  "a stored value that is not a URL is not turned into one",
  ownDomain({ ...leadContext(), variables: { ...leadContext().variables, website: "ask them" } }) === undefined,
);

// --- The wire ---------------------------------------------------------------
//
// Asserted on the request body rather than on the helpers, for the reason
// `checks/modelChoice.ts` gives: a perfectly correct fence that nothing passes
// to `callModel` is exactly the defect being closed here.

console.log("\nWhat went over the wire");

const previousKey = await prisma.appSetting.findUnique({ where: { key: SETTING.PERPLEXITY_KEY } });
await setSetting(SETTING.PERPLEXITY_KEY, "pplx-check-cold-outreach", { secret: true });

const route = await routeFor("outreach");
if (route.serving !== "perplexity") {
  check(
    "the outreach job reaches Perplexity",
    false,
    `served by ${route.serving} — a PERPLEXITY_API_KEY in the environment overrides the stored key`,
  );
} else {
  const draft = await draftMessage({
    channel: "WHATSAPP",
    purpose: "COLD_OUTREACH",
    context: leadContext(),
    caseStrength: "STRONG",
  });

  const request = sent.at(-1);
  check("the call went to Perplexity's endpoint", request?.__path === "/v1/sonar", request?.__path);
  check(
    "the search was pinned to the prospect's own domain",
    JSON.stringify(request?.search_domain_filter) === '["accradental.com"]',
    JSON.stringify(request?.search_domain_filter),
  );
  check("the answer's shape was still demanded", Boolean(request?.response_format?.json_schema));
  check("the letter's mechanics never reached the vendor", !JSON.stringify(request).includes("THE FULL REVIEW WAS RUN"));
  check("a draft came back", draft.body.startsWith("Hi Kwame"));

  await draftMessage({
    channel: "WHATSAPP",
    purpose: "COLD_OUTREACH",
    context: leadContext({ website: "" }),
    caseStrength: "MODERATE",
  });
  check(
    "a lead with no site sends no domain filter at all",
    sent.at(-1)?.search_domain_filter === undefined,
    JSON.stringify(sent.at(-1)?.search_domain_filter),
  );
}

// --- The template that can carry it -----------------------------------------
//
// A cold WhatsApp is always a template — the free-form window has never been
// open to somebody who has never written to us — so a drafter that argues from
// a four-reviewer review and a set of templates that can only name three stock
// faults are two halves that do not meet.

console.log("\nThe template that carries the finding");

const observation = STARTER_TEMPLATES.find((one) => one.name === "site_observation");
check("there is a starter template with the finding as a variable", Boolean(observation));
if (observation) {
  check("it takes the finding as its own variable", observation.variables.length === 3);
  check("it is offered for a first approach", observation.purpose === "COLD_OUTREACH");
  check(
    "Meta would accept it",
    checkTemplate({
      name: observation.name,
      body: observation.body,
      header: null,
      footer: observation.footer,
      category: observation.category,
    }).length === 0,
    JSON.stringify(
      checkTemplate({
        name: observation.name,
        body: observation.body,
        header: null,
        footer: observation.footer,
        category: observation.category,
      }),
    ),
  );
}

// --- Put everything back ----------------------------------------------------
//
// The ledger counts: `checks/costs.ts` sums LlmCall rows over an hour band, and
// rows left behind here move a cache rate somewhere else — the file that goes
// red is then not the file that is wrong.

await prisma.llmCall.deleteMany({ where: { purpose: "message.draft", createdAt: { gte: startedAt } } });
if (previousKey) {
  await prisma.appSetting.update({
    where: { key: SETTING.PERPLEXITY_KEY },
    data: { value: previousKey.value, secret: previousKey.secret },
  });
} else {
  await deleteSetting(SETTING.PERPLEXITY_KEY);
}
void getSetting;
stub.server.close();
await prisma.$disconnect();

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const name of failures) console.log(`  - ${name}`);
  process.exit(1);
}
