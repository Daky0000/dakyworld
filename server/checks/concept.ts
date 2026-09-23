/**
 * The concept workflow's decisions, checked where they are decidable without a
 * database.
 *
 * Everything asserted here is a pure function on purpose, and the four of them
 * are the four places this feature can be wrong about somebody else's business
 * rather than merely late:
 *
 *  - **who gets a page built** — the rule that must not pitch a rebuild at a
 *    business whose site is fine, and must not read "we could not reach it" as
 *    "it is bad";
 *  - **what the page must not do** — take a visitor's details into an inbox
 *    nobody reads, or turn up in a search result;
 *  - **what the checks must catch** — their own phone number missing, a
 *    placeholder two screens down, an anchor that scrolls nowhere;
 *  - **what an approval covers** — and that editing any part of it voids the
 *    approval rather than travelling with it.
 *
 * The halves that need rows — the send claim, the stage machine, the gate —
 * are exercised by the database-backed checks in CI. There is no Postgres on
 * this machine by standing preference, and a check that silently skips is
 * worse than one that is honest about its scope, so this file asserts only
 * what it can actually run.
 */
import { conceptEligibility, verdictArguesForRedesign } from "../src/services/concept/eligibility.js";
import { runPreviewChecks } from "../src/services/concept/checks.js";
import { decodeHtmlUpload, extractHtmlMetadata, makeFormsInert, prepareImportedDemoHtml, withNoIndex } from "../src/services/demoBuilder.js";
import { approvalFingerprint, whatChanged, type ApprovalSubject } from "../src/services/concept/approval.js";
import type { RedesignVerdict } from "../src/services/audit/redesign.js";

let bad = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(ok ? `  ok    ${label}` : `  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) bad += 1;
}

function verdict(over: Partial<RedesignVerdict>): RedesignVerdict {
  return {
    call: "REFINE",
    headline: "",
    assessment: "",
    issues: [],
    impact: { summary: "" } as never,
    direction: [],
    summary: "",
    reviewer: "UI/UX Designer",
    decidedBy: "perplexity",
    decidedAt: new Date().toISOString(),
    sources: [],
    ...over,
  } as RedesignVerdict;
}

// --- Who gets one -----------------------------------------------------------

console.log("\neligibility");

check(
  "a qualified lead with no website is eligible, with no audit needed",
  conceptEligibility({ status: "QUALIFIED", website: null, redesign: null }).kind === "NEW_SITE",
);

check(
  "a qualified lead whose page scored under the floor is eligible without force",
  conceptEligibility({ status: "QUALIFIED", website: "https://example.gh", redesign: verdict({ call: "REDESIGN", score: 61 }), auditReachedSite: true }).kind ===
    "REDESIGN",
);

check(
  "REBUILD above the floor still argues for a redesign",
  verdictArguesForRedesign(verdict({ call: "REBUILD", score: 78 })),
);

{
  const good = conceptEligibility({
    status: "QUALIFIED",
    website: "https://example.gh",
    redesign: verdict({ call: "REFINE", score: 82 }),
    auditReachedSite: true,
  });
  check("a good site is skipped, with the score in the reason", !good.eligible && /82/.test(good.reason ?? ""), good.reason ?? "");
}

{
  const unqualified = conceptEligibility({ status: "NEW", website: null, redesign: null });
  check("an unqualified lead is skipped whatever its site", !unqualified.eligible, unqualified.reason ?? "");
}

{
  const noAudit = conceptEligibility({ status: "QUALIFIED", website: "https://example.gh", redesign: null });
  check("a site with no audit is not a bad site", !noAudit.eligible && /audit/i.test(noAudit.reason ?? ""), noAudit.reason ?? "");
}

{
  // The trap this rule exists for: a report that could not be scored describes
  // a site nobody opened, and its verdict must not be read as a judgement.
  const unreached = conceptEligibility({
    status: "QUALIFIED",
    website: "https://example.gh",
    redesign: verdict({ call: "REBUILD", score: 20 }),
    auditReachedSite: false,
  });
  check("an audit that never reached the site cannot justify a rebuild", !unreached.eligible, unreached.reason ?? "");
}

check(
  "a lead that already has a concept is not built a second one",
  !conceptEligibility({ status: "QUALIFIED", website: null, redesign: null, hasActiveConcept: true }).eligible,
);

check(
  "a lead that has already had its first letter is not built one",
  !conceptEligibility({ status: "QUALIFIED", website: null, redesign: null, initialOutreachSent: true }).eligible,
);

check("a rehearsal's scratch lead is never a prospect", !conceptEligibility({ status: "QUALIFIED", rehearsal: true, website: null, redesign: null }).eligible);

// --- What the page must not do ---------------------------------------------

console.log("\nthe page itself");

{
  const page = `<form action="/enquire" onsubmit="send()"><input name="email"><textarea name="note"></textarea><button type="submit">Send</button></form>`;
  const { html } = makeFormsInert(page);
  // `\sdisabled\b` rather than `disabled`, which also matches `aria-disabled`.
  check("every field in a form is disabled", (html.match(/\sdisabled\b/g) ?? []).length === 3, html);
  check("the form cannot submit", /onsubmit="return false"/.test(html) && /action="#"/.test(html), html);
  check("the original action is gone, not merely overridden", !/\/enquire/.test(html), html);
}

{
  const already = makeFormsInert(`<form><input disabled name="a"></form>`);
  check("a field that is already disabled is not disabled twice", (already.html.match(/\sdisabled\b/g) ?? []).length === 1, already.html);
}

check("a page with no form is left alone", makeFormsInert("<p>hello</p>").html === "<p>hello</p>");

{
  const withHead = withNoIndex("<html><head><title>x</title></head><body></body></html>");
  check("noindex goes into the head", /<head><meta name="robots" content="noindex/.test(withHead.replace(/\n/g, "")), withHead);
}

{
  const existing = withNoIndex('<html><head><meta name="robots" content="index, follow"></head></html>');
  check("a robots tag that says the opposite is replaced, not joined", !/index, follow/.test(existing) && /noindex/.test(existing), existing);
}

// --- What the checks must catch --------------------------------------------

console.log("\nthe quality checks");

const goodPage = `<!doctype html><html><head><meta name="robots" content="noindex, nofollow"></head>
<body><div id="dw-demo-bar">A concept design for Adjei Dental — not their website.</div>
<nav><a href="#services">Services</a><a href="#contact">Contact</a></nav>
<h1>Adjei Dental</h1><section id="services">Cleaning</section>
<section id="contact">Call <a href="tel:+233201234567">020 123 4567</a> or <a href="mailto:hi@adjei.gh">hi@adjei.gh</a></section>
</body></html>`;

{
  const result = runPreviewChecks(goodPage, { businessName: "Adjei Dental", phone: "+233 20 123 4567", email: "hi@adjei.gh" });
  check("a complete page passes", result.passed, result.checks.filter((entry) => !entry.ok).map((entry) => entry.label).join("; "));
}

{
  const wrongNumber = runPreviewChecks(goodPage, { businessName: "Adjei Dental", phone: "+233 55 999 0000" });
  check("a phone number that is not theirs fails", !wrongNumber.passed && wrongNumber.checks.some((entry) => entry.id === "phone" && !entry.ok));
}

{
  const missingName = runPreviewChecks(goodPage, { businessName: "Somebody Else Ltd" });
  check("a page that never names the business fails", !missingName.passed);
}

{
  const dangling = runPreviewChecks(goodPage.replace('href="#services"', 'href="#pricing"'), { businessName: "Adjei Dental" });
  const anchors = dangling.checks.find((entry) => entry.id === "anchors");
  check("an anchor that scrolls nowhere fails, and says which", !anchors?.ok && /#pricing/.test(anchors?.detail ?? ""), anchors?.detail ?? "");
}

{
  const placeholder = runPreviewChecks(goodPage.replace("Cleaning", "Lorem ipsum dolor sit amet"), { businessName: "Adjei Dental" });
  check("placeholder text fails", !placeholder.passed && placeholder.checks.some((entry) => entry.id === "no-placeholders" && !entry.ok));
}

{
  const unlabelled = runPreviewChecks(goodPage.replace('id="dw-demo-bar"', 'id="bar"'), { businessName: "Adjei Dental" });
  check("a page that does not say it is a concept fails", !unlabelled.passed && unlabelled.checks.some((entry) => entry.id === "concept-label" && !entry.ok));
}

{
  const indexable = runPreviewChecks(goodPage.replace('content="noindex, nofollow"', 'content="index"'), { businessName: "Adjei Dental" });
  check("a page that invites the index fails", !indexable.passed && indexable.checks.some((entry) => entry.id === "noindex" && !entry.ok));
}

{
  const live = runPreviewChecks(goodPage.replace("</body>", '<form><input name="email"><button>Send</button></form></body>'), { businessName: "Adjei Dental" });
  const forms = live.checks.find((entry) => entry.id === "forms-inert");
  check("a form that can still take details fails", !forms?.ok, forms?.detail ?? "");
}

{
  // The end-to-end property the page's own hardening is for: whatever the model
  // writes, what is stored cannot collect anything and cannot be indexed.
  const hardened = withNoIndex(makeFormsInert(goodPage.replace("</body>", '<form><input name="email"><button>Send</button></form></body>')).html);
  const result = runPreviewChecks(hardened, { businessName: "Adjei Dental" });
  check("hardening a page with a live form makes it pass", result.passed, result.checks.filter((entry) => !entry.ok).map((entry) => entry.label).join("; "));
}

// --- What an approval covers ------------------------------------------------

console.log("\napproval");

const subject: ApprovalSubject = {
  demoHtml: "<h1>Adjei Dental</h1>",
  demoSlug: "adjei-dental",
  proposalId: "p1",
  proposalUpdatedAt: new Date("2026-09-15T10:00:00Z"),
  toEmail: "Hi@Adjei.gh",
  emailSubject: "A homepage idea for Adjei Dental",
  emailBodyHtml: "<p>Hello</p>",
  emailBodyText: "Hello",
};

check("the same content fingerprints the same", approvalFingerprint(subject) === approvalFingerprint({ ...subject }));
check(
  "an address that differs only in case is the same recipient",
  approvalFingerprint(subject) === approvalFingerprint({ ...subject, toEmail: "hi@adjei.gh" }),
);

for (const [what, changed] of [
  ["the page", { demoHtml: "<h1>Adjei Dental Clinic</h1>" }],
  ["the proposal", { proposalUpdatedAt: new Date("2026-09-15T11:00:00Z") }],
  ["the recipient", { toEmail: "someone@else.gh" }],
  ["the subject line", { emailSubject: "Quick question" }],
  ["the letter", { emailBodyHtml: "<p>Hello again</p>" }],
  ["the plain-text half of the letter", { emailBodyText: "Hello again" }],
] as [string, Partial<ApprovalSubject>][]) {
  check(`editing ${what} voids the approval`, approvalFingerprint(subject) !== approvalFingerprint({ ...subject, ...changed }));
}

{
  const changed = whatChanged(subject, { ...subject, demoHtml: "<h1>New</h1>", toEmail: "other@adjei.gh" });
  check("a mismatch names what moved", changed.includes("the preview page") && changed.includes("the recipient"), changed.join(", "));
}

// --- Imported HTML demo handling --------------------------------------------

console.log("\nimported html demos");

{
  const sampleHtml = "<!DOCTYPE html><html><head><title>Kofi Cocoa — Artisan Roasters</title></head><body><h1>Kofi Cocoa</h1><form action=\"/submit\"><input name=\"email\"></form></body></html>";
  const b64 = `data:text/html;base64,${Buffer.from(sampleHtml, "utf8").toString("base64")}`;
  const decoded = decodeHtmlUpload({ dataBase64: b64 });
  check("decodes base64 data URL HTML upload", decoded.includes("<h1>Kofi Cocoa</h1>"));

  const meta = extractHtmlMetadata(decoded, "kofi-cocoa.html");
  check("extracts business name from <title>", meta.businessName === "Kofi Cocoa", meta.businessName ?? "");
  check("extracts full title from <title>", meta.title === "Kofi Cocoa — Artisan Roasters", meta.title ?? "");

  const prepared = prepareImportedDemoHtml(decoded, {
    businessName: meta.businessName ?? "Kofi Cocoa",
    senderName: "Dakyworld",
    senderSite: "https://dakyworld.com",
    includeBanner: true,
    makeInert: true,
  }).html;
  check("prepared imported HTML adds noindex and disables forms", prepared.includes("noindex, nofollow") && prepared.includes("disabled"));
  check("prepared imported HTML includes optional banner when requested", prepared.includes("id=\"dw-demo-bar\""));

  let rejectedBinary = false;
  try {
    // PNG magic bytes disguised as base64 HTML
    const fakePng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]).toString("base64");
    decodeHtmlUpload({ dataBase64: fakePng });
  } catch {
    rejectedBinary = true;
  }
  check("rejects binary files disguised as HTML upload via byte sniffing", rejectedBinary);
}

console.log(bad ? `\n${bad} failed` : "\nall good");
process.exit(bad ? 1 : 0);
