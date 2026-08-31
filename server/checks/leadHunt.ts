/**
 * Hunting: the judgement, the tombstone, and putting a run down instead of ending it.
 *
 * Everything asserted here is a decision that costs money or deletes a
 * business, so each one is a place where being quietly wrong would be
 * expensive and invisible:
 *
 *  - **"Could not tell" must never mean "no".** A site that would not load
 *    produces an audit with no findings, and treating an absent finding as a
 *    failed test would score that business zero, reject it, delete it, *and*
 *    write a tombstone that stops it ever being looked at again. One bad
 *    afternoon at their host, and a real prospect is gone for good.
 *  - **The score is out of what was checked**, not out of the whole list. A
 *    thesis with six qualifiers of which four were unanswerable is scored out
 *    of two.
 *  - **A disqualifier ends it** whatever the score. That is the whole
 *    difference between the two columns.
 *  - **The tombstone outlives the lead.** It is the only thing standing between
 *    this design and re-auditing the same rejected company twice a day for ever.
 *  - **A rate-limited free model pauses a task; a missing key asks a question.**
 *    Neither ends one. The first is the case the Owner asked for; the second is
 *    the one that reads as temporary — "not connected" is a 503 in this
 *    codebase — and would otherwise be retried for two hours before blocking
 *    anyway.
 *
 * No key, no network. The judge is exercised with `offline: true`, so the only
 * thing under test is arithmetic and evidence, which is the half that must be
 * right every time rather than usually.
 */
import { AnalystError } from "../src/lib/claude.js";
import { SIGNALS, parseQualifier } from "../src/services/hunt/signals.js";
import type { SignalEvidence } from "../src/services/hunt/signals.js";
import { judge, settle, type JudgedSignal } from "../src/services/hunt/judge.js";
import { nextHuntAt } from "../src/services/hunt/run.js";
import { THESIS_SEEDS } from "../src/services/hunt/theses.js";
import { MAX_WAITS, planFor, waitMinutesFor } from "../src/services/agents/retry.js";
import type { CompanyAudit } from "../src/services/companyAudit.js";
import { prisma } from "../src/lib/prisma.js";

let bad = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(ok ? `  ok    ${label}` : `  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) bad += 1;
}

// --- Fixtures ---------------------------------------------------------------

function lead(overrides: Partial<SignalEvidence["lead"]> = {}): SignalEvidence["lead"] {
  return {
    website: "https://example.com",
    contactEmail: "hello@example.com",
    contactPhone: "+233200000000",
    companyName: "Adom Clinic",
    category: "Dental clinic",
    city: "Accra",
    rating: 4.4,
    reviewsCount: 42,
    socialLinks: null,
    clientId: null,
    ...overrides,
  };
}

function audit(findings: Array<{ id: string; observed: string }>, checked = ["website", "domain"]): CompanyAudit {
  return {
    ranAt: new Date().toISOString(),
    site: { requested: "example.com", finalUrl: "https://example.com", reachable: true, status: 200, responseMs: 400, https: true, platform: null, server: null },
    domain: { name: "example.com", hasMx: true, mailProvider: null, hasSpf: true, hasDmarc: true },
    published: { emails: [], phones: [], socials: {} },
    findings: findings.map((entry) => ({ id: entry.id, area: "WEBSITE", severity: "HIGH", observed: entry.observed, evidence: "seen on the page", service: null })),
    checked,
    notes: [],
  };
}

/** An audit that ran and found nothing — as opposed to one that never ran. */
const NOTHING_CHECKED: CompanyAudit = { ...audit([]), checked: [] };

// --- 1. Reading a qualifier line -------------------------------------------

console.log("\nReading a thesis line");
{
  const known = parseQualifier("no-website — they have no website at all.");
  check("a known signal is recognised", known.signal?.key === "no-website", String(known.signal?.key));
  check("and the sentence after the dash is what a person reads", known.prose === "they have no website at all.", known.prose);

  const colon = parseQualifier("slow-site: it is slow enough to lose visitors");
  check("a colon separates just as well as a dash", colon.signal?.key === "slow-site", String(colon.signal?.key));

  const prose = parseQualifier("The evidence shows they take bookings with no way to make one online.");
  check("a line with no known signal stays prose", prose.signal === null);
  check("and prose keeps its whole sentence", prose.prose.startsWith("The evidence shows"), prose.prose);

  // The trap this guards: a qualifier naming a signal that does not exist reads
  // as a rule and tests nothing. It must fall through to the model rather than
  // being silently dropped.
  const typo = parseQualifier("no-wesbite — misspelled on purpose");
  check("a misspelled signal is treated as prose, not discarded", typo.signal === null && typo.prose.includes("misspelled"));

  const defining = parseQualifier("!no-website — they have no website at all.");
  check("a leading ! marks a line as defining", defining.required === true);
  check("and the mark does not eat the signal key", defining.signal?.key === "no-website", String(defining.signal?.key));
  check("an ordinary line is not defining", parseQualifier("trading — they trade").required === false);
  check("prose can be defining too", parseQualifier("!The evidence shows X").required === true);
}

// --- 2. Could not tell is not no -------------------------------------------

console.log("\nWhat an unanswered check means");
{
  const nothing: SignalEvidence = { lead: lead(), audit: NOTHING_CHECKED, look: null };
  check("an unrun audit cannot answer a finding-backed signal", SIGNALS["slow-site"].test(nothing).fired === null);
  check("nor can it answer one about the homepage", SIGNALS["looks-dated"].test(nothing).fired === null);

  const ran: SignalEvidence = { lead: lead(), audit: audit([]), look: null };
  check("an audit that ran and found nothing answers no", SIGNALS["slow-site"].test(ran).fired === false);

  // `no-website` is the one signal deliberately answerable without an audit,
  // because a blank website column on a Maps listing is the same fact.
  const blank: SignalEvidence = { lead: lead({ website: null }), audit: null, look: null };
  check("no website on the record answers yes for free", SIGNALS["no-website"].test(blank).fired === true);
  check("and it says what it saw", SIGNALS["no-website"].test(blank).evidence.length > 0);
}

// --- 3. The arithmetic ------------------------------------------------------

console.log("\nHow a score is worked out");
{
  const line = (says: string, matched: boolean | null, kind: "qualifier" | "disqualifier" = "qualifier"): JudgedSignal => ({
    signal: "x",
    says,
    matched,
    evidence: matched === true ? "seen" : "",
    kind,
  });

  const two = settle([line("a", true), line("b", false)], 50);
  check("one of two checkable is 50", two.score === 50, String(two.score));
  check("and 50 clears a minimum of 50", two.verdict === "QUALIFIED", two.verdict);

  // The point of the whole design: four unanswerable lines must not drag the
  // score down. Out of six this would be 17 and rejected; out of the two that
  // were actually checked it is 50 and kept.
  const withUnknowns = settle(
    [line("a", true), line("b", false), line("c", null), line("d", null), line("e", null), line("f", null)],
    50,
  );
  check("unanswerable lines are left out of the denominator", withUnknowns.score === 50, String(withUnknowns.score));
  check("and the reason says how many could not be checked", withUnknowns.reason.includes("4 could not be checked"), withUnknowns.reason);

  const nothingChecked = settle([line("a", null), line("b", null)], 50);
  check("nothing checkable is undecided, not rejected", nothingChecked.verdict === "UNDECIDED", nothingChecked.verdict);
  check("and it says so in words a person can act on", nothingChecked.reason.toLowerCase().includes("kept"), nothingChecked.reason);

  const under = settle([line("a", true), line("b", false), line("c", false)], 50);
  check("under the minimum is rejected", under.verdict === "REJECTED", `${under.verdict} at ${under.score}`);
  check("and the rejection names what did not fit", under.reason.includes("Does not fit"), under.reason);

  const ruledOut = settle([line("a", true), line("b", true), line("already a client", true, "disqualifier")], 50);
  check("a disqualifier beats a perfect score", ruledOut.verdict === "REJECTED", `${ruledOut.verdict} at ${ruledOut.score}`);
  check("and it names the line that ended it", ruledOut.reason.startsWith("Ruled out:"), ruledOut.reason);

  const noQualifiers = settle([], 50);
  check("a thesis with no qualifiers decides nothing", noQualifiers.verdict === "UNDECIDED", noQualifiers.verdict);

  // The fault this check found: a thesis's defining test is not something to be
  // outvoted by its supporting ones.
  const defining = (matched: boolean | null): JudgedSignal => ({ ...line("the one thing this is about", matched), required: true });
  const outvoted = settle([defining(false), line("b", true), line("c", true), line("d", true)], 60);
  check("three supporting checks cannot carry a failed defining one", outvoted.verdict === "REJECTED", `${outvoted.verdict} at ${outvoted.score}`);
  check("and the rejection says it does not fit at all", outvoted.reason.startsWith("Does not fit at all:"), outvoted.reason);

  const unanswered = settle([defining(null), line("b", true), line("c", true)], 60);
  check("a defining test nobody could answer is undecided, not rejected", unanswered.verdict === "UNDECIDED", unanswered.verdict);
  check("so the business is kept rather than deleted", unanswered.reason.includes("Kept"), unanswered.reason);

  const met = settle([defining(true), line("b", true), line("c", false)], 60);
  check("a defining test that fires is still weighed with the rest", met.verdict === "QUALIFIED" && met.score === 67, `${met.verdict} at ${met.score}`);
}

// --- 4. A real thesis against a real-shaped business -----------------------

console.log("\nThe shipped theses, judged offline");
{
  const noShopfront = THESIS_SEEDS.find((seed) => seed.key === "no-shopfront")!;
  const thesis = { ...noShopfront, minScore: noShopfront.minScore };

  const fits = await judge({
    thesis,
    evidence: { lead: lead({ website: null }), audit: audit([{ id: "no-website", observed: "No website was found" }]), look: null },
    offline: true,
  });
  check("a trading business with no website qualifies", fits.verdict === "QUALIFIED", `${fits.verdict} at ${fits.score}`);
  check("its every qualifier is a free signal, so nothing was skipped", fits.note === null, String(fits.note));

  const hasOne = await judge({
    thesis,
    evidence: { lead: lead(), audit: audit([]), look: null },
    offline: true,
  });
  check("a business that already has a site does not", hasOne.verdict === "REJECTED", `${hasOne.verdict} at ${hasOne.score}`);

  const unreachable = await judge({
    thesis,
    evidence: { lead: lead({ contactEmail: null, contactPhone: null, reviewsCount: 0, rating: null }), audit: audit([]), look: null },
    offline: true,
  });
  check("a business nobody can contact is ruled out outright", unreachable.verdict === "REJECTED", unreachable.verdict);
  check("and by the disqualifier rather than by the score", unreachable.reason.startsWith("Ruled out:"), unreachable.reason);

  // The manual-operations thesis is the one that genuinely needs a model. With
  // the model skipped, its prose lines must be reported as unread rather than
  // quietly counted as failures.
  const manual = THESIS_SEEDS.find((seed) => seed.key === "manual-operations")!;
  const offline = await judge({ thesis: manual, evidence: { lead: lead(), audit: audit([]), look: null }, offline: true });
  check("a thesis with prose says which lines nobody read", Boolean(offline.note?.includes("skipped")), String(offline.note));
  check("and it costs nothing when the model is skipped", offline.costUsd === 0, String(offline.costUsd));
}

// --- 5. The clock -----------------------------------------------------------

console.log("\nWhen a hunt next runs");
{
  const thesis = { enabled: true, runTimes: ["07:30", "15:30"], timezone: "Africa/Accra" };
  // 06:00 UTC is 06:00 in Accra, which keeps no offset.
  const morning = new Date(Date.UTC(2026, 7, 31, 6, 0, 0));
  const next = nextHuntAt(thesis, morning);
  check("the next slot is later the same day", next?.toISOString() === "2026-08-31T07:30:00.000Z", String(next?.toISOString()));

  const evening = new Date(Date.UTC(2026, 7, 31, 16, 0, 0));
  const tomorrow = nextHuntAt(thesis, evening);
  check("past the last slot it rolls to tomorrow", tomorrow?.toISOString() === "2026-09-01T07:30:00.000Z", String(tomorrow?.toISOString()));

  check("a switched-off thesis has no next run", nextHuntAt({ ...thesis, enabled: false }, morning) === null);
  check("nor does one with no times", nextHuntAt({ ...thesis, runTimes: [] }, morning) === null);

  // Two a day, five a run, is the Owner's instruction — asserted so a later
  // edit to the seeds cannot quietly change what the system does per day.
  for (const seed of THESIS_SEEDS) {
    check(`"${seed.key}" runs twice a day`, seed.runTimes.length === 2, seed.runTimes.join(", "));
    check(`"${seed.key}" keeps five a run`, seed.leadsPerRun === 5, String(seed.leadsPerRun));
  }
}

// --- 6. The tombstone -------------------------------------------------------

console.log("\nThe record that outlives the lead");
{
  const KEY = "check.hunt.thesis";
  await prisma.leadVerdict.deleteMany({ where: { thesis: { key: KEY } } });
  await prisma.leadThesis.deleteMany({ where: { key: KEY } });

  const thesis = await prisma.leadThesis.create({
    data: { key: KEY, name: "Check", target: "t", rationale: "r", offer: "o", qualifiers: ["no-website — none"], custom: true },
  });
  const business = await prisma.lead.create({
    data: { contactName: "Check Business", companyName: "Check Business", dedupeKey: "check:hunt:tombstone", rehearsal: true },
  });
  await prisma.leadVerdict.create({
    data: {
      thesisId: thesis.id,
      leadId: business.id,
      companyName: business.companyName,
      dedupeKey: business.dedupeKey,
      verdict: "REJECTED",
      score: 10,
      reason: "Scored under the minimum.",
    },
  });

  await prisma.lead.delete({ where: { id: business.id } });
  const survivor = await prisma.leadVerdict.findFirst({ where: { thesisId: thesis.id } });
  check("the verdict survives the lead being deleted", Boolean(survivor), "the tombstone went with the lead");
  check("its lead link is cleared rather than blocking the delete", survivor?.leadId === null, String(survivor?.leadId));
  check("and the identity that stops a re-audit is still on it", survivor?.dedupeKey === "check:hunt:tombstone", String(survivor?.dedupeKey));

  // One business, one verdict per thesis. Without this a hunt could write a
  // second row for the same company and the skip query would still work, but
  // the counts on the screen would double.
  let refused = false;
  try {
    await prisma.leadVerdict.create({
      data: { thesisId: thesis.id, dedupeKey: "check:hunt:tombstone", verdict: "QUALIFIED", score: 90, reason: "again" },
    });
  } catch {
    refused = true;
  }
  check("the same business cannot be judged twice under one thesis", refused);

  await prisma.leadThesis.delete({ where: { id: thesis.id } });
  const gone = await prisma.leadVerdict.count({ where: { thesisId: thesis.id } });
  check("deleting a thesis takes its verdicts with it", gone === 0, String(gone));
}

// --- 7. Paused, not stopped -------------------------------------------------

console.log("\nWhat happens when a model provider will not answer");
{
  const rateLimited = planFor(new AnalystError(429, "OpenRouter rate-limited: free-models-per-day"), 0);
  check("a rate limit waits rather than fails", rateLimited.remedy === "wait", rateLimited.remedy);
  check("and it waits five minutes the first time", rateLimited.waitMinutes === 5, String(rateLimited.waitMinutes));
  check("and it says what a free tier means", rateLimited.reason.includes("free tier"), rateLimited.reason);

  check("a busy model waits", planFor(new AnalystError(503, "The model is overloaded"), 0).remedy === "wait");
  check("a gateway error waits", planFor(new AnalystError(502, "Bad gateway"), 0).remedy === "wait");
  check("a timeout waits", planFor(new AnalystError(504, "Apify did not respond in time"), 0).remedy === "wait");
  check("a dropped socket waits", planFor(new Error("fetch failed: ECONNRESET"), 0).remedy === "wait");

  // The chain-exhausted sentence `callModel` throws when every free rung was
  // rate-limited. Its status is whatever the last vendor said, and the fact
  // that five models were tried survives only in the words.
  const exhausted = planFor(
    new AnalystError(429, "writing could not be done. model-a rate-limited; model-b rate-limited. Last error: 429"),
    1,
  );
  check("a whole exhausted free ladder waits too", exhausted.remedy === "wait", exhausted.remedy);

  // The one that reads as temporary and is not. "not connected" is a 503 here.
  const noKey = planFor(new AnalystError(503, "No key is set for OpenRouter — add one under Settings."), 0);
  check("a missing key asks rather than waiting", noKey.remedy === "ask", noKey.remedy);
  check("and it says where to put one", noKey.reason.includes("Settings"), noKey.reason);

  // The exact sentence lib/claudeAgent.ts throws when nothing is configured,
  // at the status it actually throws it with. A live run found this reading as
  // temporary: 503 is in the temporary list, so the task paused for five
  // minutes rather than asking, and would have gone on doing that for two and a
  // half hours before blocking with the same sentence it started with.
  const noModel = planFor(
    new AnalystError(
      503,
      "No model is connected for running agents. Add an OpenRouter, Claude, ChatGPT or Gemini key under Settings → AI models — any one of them can do this.",
    ),
    0,
  );
  check("nothing configured at all asks immediately, at 503", noModel.remedy === "ask", noModel.remedy);

  const noCredit = planFor(new AnalystError(402, "OpenRouter: insufficient credit"), 0);
  check("no credit asks rather than waiting for it to come back", noCredit.remedy === "ask", noCredit.remedy);

  const badShape = planFor(new AnalystError(400, "The model refused the request shape"), 0);
  check("a malformed request asks rather than being retried identically", badShape.remedy === "ask", badShape.remedy);

  check("a genuine fault still fails", planFor(new Error("Cannot read properties of undefined"), 0).remedy === "fail");

  // The backoff, and the ending. A run that has waited its whole budget must
  // reach a question, never a dead task — the conversation is still good.
  check("the wait grows", waitMinutesFor(0) === 5 && waitMinutesFor(2) === 10 && waitMinutesFor(4) === 40);
  check("and it stops growing at an hour", waitMinutesFor(99) === 60, String(waitMinutesFor(99)));
  const spent = planFor(new AnalystError(429, "still rate-limited"), MAX_WAITS);
  check("a run that has waited its whole budget asks, and does not fail", spent.remedy === "ask", spent.remedy);
  check("and it says the task itself is fine", spent.reason.includes("Nothing is wrong with this task"), spent.reason);
}

console.log(
  bad
    ? `\n${bad} PROBLEM(S)`
    : `\nA hunt scores what it checked, an unchecked business is kept, the tombstone outlives the lead, and a busy vendor pauses a run instead of ending it.`,
);
process.exitCode = bad ? 1 : 0;
await prisma.$disconnect();
