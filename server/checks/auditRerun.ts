/**
 * Running one section of a website review again.
 *
 * A section fails for reasons that have nothing to do with the site — no Apify
 * token when the pictures were due, no model that can look at one, a browser
 * that would not start — and the review then carries a hole that used to cost
 * the whole team to fill. `rerunAuditSection` fills one section; the awkward
 * part is not running the reviewer, it is the bookkeeping around it, which is
 * what `mergeRerunReport` does and what this file is about.
 *
 * Three ways a partial re-run makes a document lie, all of them silent:
 *
 *  - **Keeping the old section's notes.** "No screenshot could be taken" beside
 *    a section that has just reviewed two screenshots is the exact defect this
 *    whole feature exists to end.
 *  - **Dropping a note about a step this run skipped.** A content re-run does
 *    not rent a browser, so "the page could not be opened in a real browser" is
 *    still why the speed section reads as it does — and without it those
 *    numbers look like a complete measurement.
 *  - **Saying nothing about the fact that half the document is a fortnight
 *    old.** A reader comparing a UI/UX section written today with a security
 *    section from three weeks ago is entitled to know that is what they are
 *    doing.
 *
 * The scoring half matters as much: a section that goes from unscored to scored
 * changes the coverage, and coverage is what decides whether the front page may
 * carry a number at all.
 *
 * No database, no key, no network.
 */
import { SECTION_EVIDENCE, mergeRerunReport } from "../src/services/audit/team.js";
import { reviewUx } from "../src/services/audit/ux.js";
import type { AuditEvidence } from "../src/services/audit/evidence.js";
import { DISCIPLINES, MIN_SCORED_WEIGHT, type Discipline, type DisciplineReport, type WebsiteAuditReport } from "../src/services/audit/types.js";
import { prisma } from "../src/lib/prisma.js";

let bad = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(ok ? `  ok    ${label}` : `  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) bad += 1;
}

const NO_PICTURE = "No screenshot could be taken, so nobody has seen how the site actually looks.";
const NO_BROWSER = "The page could not be opened in a real browser: the actor timed out.";
const SECURITY_NOTE = "Their mail domain could not be checked: the resolver did not answer.";

function section(discipline: Discipline, over: Partial<DisciplineReport> = {}): DisciplineReport {
  return {
    discipline,
    reviewer: `${discipline} reviewer`,
    reviewedBy: "a model",
    score: 80,
    scored: true,
    headline: `${discipline} headline`,
    summary: `${discipline} summary`,
    findings: [],
    checked: [`something ${discipline}`],
    notes: [],
    costUsd: 0.01,
    ...over,
  };
}

/** A review whose UI/UX section never ran, which is the case this was written for. */
function storedReport(): WebsiteAuditReport {
  return {
    leadId: "lead-1",
    businessName: "Kwame Plumbing",
    website: "https://example.test/",
    ranAt: "2026-08-19T09:00:00.000Z",
    overallScore: 74,
    scored: true,
    verdict: "Solid, with gaps",
    disciplines: [
      section("UX", { score: 0, scored: false, headline: "Nobody has seen how the site looks", reviewedBy: "Not run", checked: [], notes: [NO_PICTURE] }),
      section("SPEED_SEO", { score: 70, notes: [] }),
      section("CONTENT", { score: 80 }),
      section("SECURITY", { score: 72, notes: [SECURITY_NOTE] }),
    ],
    synthesis: null,
    screenshots: [],
    notes: [NO_PICTURE, NO_BROWSER, SECURITY_NOTE],
    stepNotes: { screenshots: [NO_PICTURE], rendered: [NO_BROWSER] },
    costUsd: 0.42,
  };
}

console.log("── which evidence each section needs ─────────────────────────────");
{
  // The reason a partial re-run is worth having at all: the sections that cost
  // money are not the same sections, so mending one is not paying for four.
  check("every discipline has an entry", DISCIPLINES.every((discipline) => Boolean(SECTION_EVIDENCE[discipline])));
  check("only UI/UX reads the pictures", DISCIPLINES.filter((d) => SECTION_EVIDENCE[d].screenshots).join() === "UX");
  check("only speed and findability rents a browser", DISCIPLINES.filter((d) => SECTION_EVIDENCE[d].rendered).join() === "SPEED_SEO");
  check("content and security need neither", !SECTION_EVIDENCE.CONTENT.screenshots && !SECTION_EVIDENCE.CONTENT.rendered && !SECTION_EVIDENCE.SECURITY.rendered);
}

console.log("\n── the section that ran again ────────────────────────────────────");
{
  const stored = storedReport();
  const merged = mergeRerunReport({
    stored,
    fresh: section("UX", { score: 55, headline: "The page does not say what they sell", notes: [] }),
    evidence: { notes: ["The homepage answered in 210ms."], stepNotes: { screenshots: [], rendered: [] }, finalUrl: "https://example.test/" },
    ran: { screenshots: true, rendered: false },
    at: "2026-09-02T10:00:00.000Z",
  });

  const ux = merged.disciplines.find((entry) => entry.discipline === "UX")!;
  check("the section is replaced", ux.score === 55 && ux.scored, `${ux.score}`);
  check("and is stamped with when it was run", ux.rerunAt === "2026-09-02T10:00:00.000Z", String(ux.rerunAt));
  check("the other three are untouched", merged.disciplines.filter((entry) => entry.rerunAt).length === 1);
  check("the sections stay in their declared order", merged.disciplines.map((entry) => entry.discipline).join() === DISCIPLINES.join());
  check("the review keeps its original date", merged.ranAt === stored.ranAt);

  // The defect this exists for: the old reason is no longer true, and it is the
  // sentence the reader would see beside a section that now has findings in it.
  check("the old section's note is gone", !merged.notes.includes(NO_PICTURE));
  check("a note about a step this run skipped is carried forward", merged.notes.includes(NO_BROWSER));
  check("another section's own note survives", merged.notes.includes(SECURITY_NOTE));
  check("the fresh evidence is in", merged.notes.includes("The homepage answered in 210ms."));
  check("and the document says which part is new", merged.notes.some((note) => note.startsWith("Not every section of this report was run at the same time.") && note.includes("UI/UX")));

  // The screenshot step ran this time, so its notes are this run's; the browser
  // was not rented, so those are the ones that had to be kept.
  check("stepNotes now describe what is actually true", merged.stepNotes?.screenshots.length === 0 && merged.stepNotes?.rendered.join() === NO_BROWSER);
}

console.log("\n── what it does to the score ─────────────────────────────────────");
{
  const stored = storedReport();
  const before = stored.overallScore;
  const merged = mergeRerunReport({
    stored,
    fresh: section("UX", { score: 40 }),
    evidence: { notes: [], stepNotes: { screenshots: [], rendered: [] }, finalUrl: "https://example.test/" },
    ran: { screenshots: true, rendered: false },
    at: "2026-09-02T10:00:00.000Z",
  });

  // 0.16·40 + 0.28·70 + 0.18·80 + 0.22·72 = 56.24 over 0.84 of coverage — the
  // redesign call's own 0.16 is absent here, because this fixture has no call
  // on it. That is the point of the next section.
  check("the overall is recomputed over four sections", merged.overallScore === 67, `${before} → ${merged.overallScore}`);
  check("and it may be shown", merged.scored && merged.verdict === "Needs work", merged.verdict);
}

console.log("\n── and what the redesign call is worth of it ─────────────────────");
{
  // The look of a page is measured twice: the UI/UX section subtracts points
  // per fault, and the redesign call scores ten headings out of a hundred.
  // Both are in the site's one number, and this is the arithmetic that says so.
  const withCall = mergeRerunReport({
    stored: storedReport(),
    fresh: section("UX", { score: 40 }),
    redesign: { call: "REBUILD", score: 30, headline: "", assessment: "", issues: [], impact: { trust: "", usability: "", conversion: "", howItFeels: "" }, direction: [], summary: "", reviewer: "UI/UX Designer", decidedBy: "Perplexity", decidedAt: "2026-09-03T10:00:00.000Z", sources: [] } as never,
    evidence: { notes: [], stepNotes: { screenshots: [], rendered: [] }, finalUrl: "https://example.test/" },
    ran: { screenshots: true, rendered: false },
    at: "2026-09-03T10:00:00.000Z",
  });
  // 56.24 + 0.16·30 = 61.04 over a full 1.0 of coverage.
  check("the call's scorecard is part of the site's score", withCall.overallScore === 61, String(withCall.overallScore));
  check("and the call itself is on the merged report", withCall.redesign?.call === "REBUILD");

  // Another section's re-run does not decide again — and the stored call's
  // score still has to reach the arithmetic, or mending the security section
  // would silently drop the look out of the site's number.
  const carried = mergeRerunReport({
    stored: { ...storedReport(), redesign: { call: "REBUILD", score: 30 } as never },
    fresh: section("SECURITY", { score: 72 }),
    evidence: { notes: [], stepNotes: { screenshots: [], rendered: [] }, finalUrl: "https://example.test/" },
    ran: { screenshots: false, rendered: false },
    at: "2026-09-03T10:00:00.000Z",
  });
  // UI/UX still unscored: 0.28·70 + 0.18·80 + 0.22·72 + 0.16·30 = 54.64 over 0.84.
  check("a re-run of something else carries the stored call's score", carried.overallScore === 65, String(carried.overallScore));
  check("and does not decide the call again", carried.redesign?.call === "REBUILD");

  // A call that could not be made is left out, exactly as an unscored section
  // is. Arriving as a zero would state that the page looks as bad as a page
  // can look, about a business nobody photographed.
  const noCall = mergeRerunReport({
    stored: storedReport(),
    fresh: section("UX", { score: 40 }),
    redesign: null,
    evidence: { notes: [], stepNotes: { screenshots: [], rendered: [] }, finalUrl: "https://example.test/" },
    ran: { screenshots: true, rendered: false },
    at: "2026-09-03T10:00:00.000Z",
  });
  check("a call that could not be made counts as nothing, not as zero", noCall.overallScore === 67, String(noCall.overallScore));
}

console.log("\n── a re-run that failed again ────────────────────────────────────");
{
  // Nothing was fixed: the section comes back unscored, and the document has to
  // go back to saying so rather than keeping the number the first run showed.
  const stored = storedReport();
  stored.disciplines = stored.disciplines.map((entry) =>
    entry.discipline === "CONTENT" || entry.discipline === "SECURITY" ? { ...entry, scored: false, score: 0 } : entry,
  );

  const merged = mergeRerunReport({
    stored,
    fresh: section("UX", { score: 0, scored: false, reviewedBy: "Not run", notes: ["Still no model can look at a picture."] }),
    evidence: { notes: [], stepNotes: { screenshots: [], rendered: [] }, finalUrl: "https://example.test/" },
    ran: { screenshots: true, rendered: false },
    at: "2026-09-02T10:00:00.000Z",
  });

  // Only SPEED_SEO ran, which is 0.28 of the site — under the coverage floor,
  // so one section's score may not go on the front page as the whole site's.
  check("a section under the coverage floor publishes no number", !merged.scored && merged.verdict === "Not scored", `${MIN_SCORED_WEIGHT}`);
  check("and says why in words", merged.notes.some((note) => note.startsWith("Too little of the site could be examined")));
  check("the new reason replaces the old one", merged.notes.includes("Still no model can look at a picture.") && !merged.notes.includes(NO_PICTURE));
}

console.log("\n── a second section, later ───────────────────────────────────────");
{
  const first = mergeRerunReport({
    stored: storedReport(),
    fresh: section("UX", { score: 55 }),
    evidence: { notes: [], stepNotes: { screenshots: [], rendered: [] }, finalUrl: "https://example.test/" },
    ran: { screenshots: true, rendered: false },
    at: "2026-09-02T10:00:00.000Z",
  });
  const second = mergeRerunReport({
    stored: first,
    fresh: section("CONTENT", { score: 61 }),
    evidence: { notes: [], stepNotes: { screenshots: [], rendered: [] }, finalUrl: "https://example.test/" },
    ran: { screenshots: false, rendered: false },
    at: "2026-09-03T10:00:00.000Z",
  });

  check("both stamps survive", second.disciplines.filter((entry) => entry.rerunAt).length === 2);
  const freshness = second.notes.filter((note) => note.startsWith("Not every section of this report was run at the same time."));
  // One sentence, rewritten — not one per re-run, or the list grows a
  // contradicting line every time somebody mends a section.
  check("there is exactly one freshness sentence", freshness.length === 1, String(freshness.length));
  check("and it names both sections", freshness[0]?.includes("UI/UX") && freshness[0]?.includes("Content"));
  check("and still names what has not been re-checked", freshness[0]?.includes("Speed & SEO") && freshness[0]?.includes("Security"));
  // The screenshot step did not run this time either, so the note the first
  // re-run legitimately cleared must not come back from the stored copy.
  check("a cleared note stays cleared", !second.notes.includes(NO_PICTURE));
  check("and the browser note is still carried", second.notes.includes(NO_BROWSER));
}

console.log("\n── a review written before this existed ──────────────────────────");
{
  // No `stepNotes` on the row. The carried notes are unknown rather than empty,
  // and guessing at them is what would put a false sentence in the document —
  // so nothing is carried and the section's own notes still speak for it.
  const stored = storedReport();
  delete stored.stepNotes;

  const merged = mergeRerunReport({
    stored,
    fresh: section("UX", { score: 55 }),
    evidence: { notes: [], stepNotes: { screenshots: [], rendered: [] }, finalUrl: "https://example.test/" },
    ran: { screenshots: true, rendered: false },
    at: "2026-09-02T10:00:00.000Z",
  });

  check("an old row still merges", merged.disciplines.length === 4 && merged.overallScore > 0);
  check("the old section's note is still cleared", !merged.notes.includes(NO_PICTURE));
  check("and the row now carries stepNotes for next time", Boolean(merged.stepNotes));
}

console.log("\n── the address that answered ─────────────────────────────────────");
{
  const merged = mergeRerunReport({
    stored: storedReport(),
    fresh: section("SECURITY", { score: 90 }),
    evidence: { notes: [], stepNotes: { screenshots: [], rendered: [] }, finalUrl: "https://www.example.test/" },
    ran: { screenshots: false, rendered: false },
    at: "2026-09-02T10:00:00.000Z",
  });
  check("a site that has moved says so", merged.website === "https://www.example.test/", String(merged.website));

  // And a re-run against nothing must not wipe the address off the front page.
  const unreachable = mergeRerunReport({
    stored: storedReport(),
    fresh: section("SECURITY", { score: 90 }),
    evidence: { notes: [], stepNotes: { screenshots: [], rendered: [] }, finalUrl: null },
    ran: { screenshots: false, rendered: false },
    at: "2026-09-02T10:00:00.000Z",
  });
  check("and a site that did not answer keeps the one on file", unreachable.website === "https://example.test/", String(unreachable.website));
}

// --- The reason a section did not run has to be the real one ----------------
//
// The same defect this whole file is about, one layer down. A UI/UX section
// with no pictures used to print a **guess** at the cause — "it usually means
// no Apify token is connected" — whatever had actually happened. The first time
// that guess was wrong it was wrong expensively: a deployment whose token was
// perfectly good, and whose screenshot actor had simply never been deployed,
// printed that sentence on the one screen that had been handed the true reason,
// and sent somebody to check a setting that was not the problem.
//
// `reviewUx` returns before any model call when there are no pictures, so this
// needs no key. The negatives matter as much as the positive: a real reason
// must not be paraphrased away, and a section with no reason must not invent
// one.
console.log("\nWhy a section did not run");
{
  const evidence = (over: Partial<AuditEvidence>): AuditEvidence =>
    ({ shots: [], reachable: true, notes: [], stepNotes: { screenshots: [], rendered: [] }, ...over }) as unknown as AuditEvidence;
  const about = { name: "Adom Dental", trade: null, town: null };

  const actorMissing =
    'No screenshot was taken \u2014 Apify would not start the run: The screenshot actor "daky_world/website-screenshot" is not on this Apify account.';
  const missing = await reviewUx(evidence({ stepNotes: { screenshots: [actorMissing], rendered: [] } }), about);
  check("the section is unscored and left out", missing.scored === false && missing.score === 0);
  check("and it says what actually stopped it", missing.summary.includes("not on this Apify account"), missing.summary);
  check("rather than guessing at a token", !/token/i.test(missing.summary), missing.summary);

  const noToken = await reviewUx(
    evidence({ stepNotes: { screenshots: ["No screenshot was taken \u2014 Apify is not connected. Add a token under Lead Sources \u2192 Connection."], rendered: [] } }),
    about,
  );
  check("a missing token is still named, because that is what was said", noToken.summary.includes("Add a token"), noToken.summary);

  const nothingSaid = await reviewUx(evidence({}), about);
  check("with no reason to give, it invents none", !/token|actor/i.test(nothingSaid.summary), nothingSaid.summary);

  const dead = await reviewUx(evidence({ reachable: false }), about);
  check("and a site that never answered says that instead", dead.summary.includes("could not be retrieved"), dead.summary);
}

await prisma.$disconnect();

console.log(bad ? `\n${bad} PROBLEM(S)` : `\nOne section can be run again without the rest of the report lying about what was checked.`);
process.exitCode = bad ? 1 : 0;
