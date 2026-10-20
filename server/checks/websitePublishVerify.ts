/**
 * Whether a publish reached the live site — the deciding, without a database.
 *
 *   npx tsx checks/websitePublishVerify.ts
 *
 * The part that can be wrong in a way nobody notices: a backoff that gives up
 * too early reports a working host as broken, and one that never gives up leaves
 * a row saying "waiting" for ever — which is the same silence the whole feature
 * was built to end. `checks/websitePublishJobs.ts` covers the same code with the
 * rows and the clock; this one needs nothing but the module.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { PublishJob } from "@prisma/client";
import { decideVerification, livePageShowsChange, publishJobView, verificationText, HOST_LATE_LABEL, PUBLISH_JOB_STATES } from "../src/services/websitePublishJobs.js";
import { componentsFor, githubTroubleFor, hostFromHeaders, parseGithubComponents, GITHUB_TROUBLE_NOTICE } from "../src/services/githubStatus.js";

let checks = 0;
function check(name: string, condition: unknown) { assert.ok(condition, name); checks++; }
function equal(name: string, actual: unknown, expected: unknown) { assert.deepEqual(actual, expected, name); checks++; }

const change = (part: "words" | "styling" | "destination", to: string) => ({ id: "a", label: "Heading", kind: "text" as const, part, from: "before", to });

/* ------------------------------------------------- what to look for */

equal("the longest new sentence is what the live page is searched for", verificationText([change("words", "Ready to improve your systems?"), change("words", "Talk to us")]), "Ready to improve your systems?");
equal("a link's new destination will do", verificationText([change("destination", "/services/automation")]), "/services/automation");
equal("something too short to be distinctive is refused", verificationText([change("words", "Contact")]), null);
equal("and so is a styling change, which puts no words on the page", verificationText([change("styling", "colour")]), null);
check("markup is never used as the needle", verificationText([change("words", "<span>Ready to improve things</span>")]) === null);

/* ------------------------------------------------ what the page says */

const html = "<!doctype html><html><body><h1>Ready to improve your systems?</h1></body></html>";
const hash = createHash("sha256").update(html).digest("hex");

check("the words being on the page is the answer", livePageShowsChange({ body: html, verifyText: "Ready to improve your systems?", expectedHash: hash }));
check("the old page is not", !livePageShowsChange({ body: "<h1>The old one</h1>", verifyText: "Ready to improve your systems?", expectedHash: hash }));
check("a styling change is settled by the whole file instead", livePageShowsChange({ body: html, verifyText: null, expectedHash: hash }));
check("a file the host rewrote does not match on its hash", !livePageShowsChange({ body: `${html}\n<!-- injected -->`, verifyText: null, expectedHash: hash }));
check("but the words still settle it when the host rewrote the file", livePageShowsChange({ body: `${html}\n<!-- injected -->`, verifyText: "Ready to improve your systems?", expectedHash: hash }));
check("with nothing to look for at all, there is nothing to wait for", livePageShowsChange({ body: "anything", verifyText: null, expectedHash: null }));

/* ------------------------------------------------------ the backoff */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

equal("a page that shows the change is done", decideVerification({ verified: true, attempts: 1, elapsedMs: 10_000 }), { state: "COMPLETED" });

/**
 * Walks the watch the way the scheduler does: one look, wait what it says, look
 * again. `liveAt` is when the host finally shows the change, or never.
 */
function watch(liveAt: number | null, error?: string) {
  const looks: Array<{ at: number; state: string; wait?: number }> = [];
  let at = 10_000;
  let previousError = false;
  for (let attempts = 1; attempts < 1_000; attempts++) {
    const verified = liveAt !== null && at >= liveAt;
    const step = decideVerification({ verified, attempts, elapsedMs: at, error: verified ? undefined : error, previousError });
    looks.push({ at, state: step.state, wait: step.state === "VERIFYING" ? step.nextCheckInMs : undefined });
    if (step.state !== "VERIFYING") return { looks, last: step };
    previousError = Boolean(error);
    at += step.nextCheckInMs;
  }
  throw new Error("the watch never ended");
}

const quick = watch(40_000);
equal("a host that rebuilds in forty seconds is seen as live", quick.last.state, "COMPLETED");
check("within a minute of it going live", quick.looks[quick.looks.length - 1]!.at < 40_000 + MINUTE);

const early = watch(null).looks.filter((look) => look.at < 5 * MINUTE).map((look) => look.wait!);
check("the first look comes quickly", early[0]! <= 45_000);
check("and the early looks spread out rather than hammering the host", early.every((wait, index) => index === 0 || wait >= early[index - 1]!));
check("after the first five minutes it looks every two minutes", watch(null).looks.filter((look) => look.at >= 5 * MINUTE && look.at < 2 * HOUR).every((look) => look.wait === 2 * MINUTE));

// 19 Oct 2026: a GitHub Actions incident held the africon-app rebuild (commit
// 20a09f5) for about forty minutes. The old watch gave up at twelve and recorded
// a publish that worked as "the live page has not changed".
const nineteenth = watch(40 * MINUTE);
equal("the 19 October publish ends live, not failed", nineteenth.last.state, "COMPLETED");
check("and was never reported as failed on the way", nineteenth.looks.every((look) => look.state !== "VERIFY_FAILED"));
check("and was seen within two minutes of going live", nineteenth.looks[nineteenth.looks.length - 1]!.at <= 42 * MINUTE + 10_000);

const slow = watch(5 * HOUR);
equal("a host five hours late is still seen when it finally rebuilds", slow.last.state, "COMPLETED");
check("looking every fifteen minutes once it is two hours late", slow.looks.filter((look) => look.at >= 2 * HOUR && look.wait).every((look) => look.wait === 15 * MINUTE));

const never = watch(null);
equal("a host that never rebuilds is reported, not waited on for ever", never.last.state, "VERIFY_FAILED");
check("only after a day", never.looks[never.looks.length - 1]!.at >= 24 * HOUR);
check("and says the commit is there while the page is not", /commit is in the repository/.test((never.last as { reason: string }).reason));
check("in fewer than two hundred looks", never.looks.length < 200);

const unreachable = watch(null, "getaddrinfo ENOTFOUND example.test");
equal("an address that never answers is reported", unreachable.last.state, "VERIFY_FAILED");
check("as what it is, not a wrong story about caching", (unreachable.last as { reason: string }).reason.includes("ENOTFOUND"));
check("after two hours, not a day", (() => { const at = unreachable.looks[unreachable.looks.length - 1]!.at; return at >= 2 * HOUR && at < 3 * HOUR; })());
equal(
  "one failed read at the two-hour mark is a blip, not a verdict",
  decideVerification({ verified: false, attempts: 70, elapsedMs: 2 * HOUR + MINUTE, error: "socket hang up", previousError: false }).state,
  "VERIFYING",
);

/* ------------------------------------------------------- the words */

check("every state has something a person can read", Object.values(PUBLISH_JOB_STATES).every((label) => label.length > 3 && label === label.trim()));
equal("and 'published' is never claimed before it is live", PUBLISH_JOB_STATES.COMMITTED, "Committed");
equal("only the live state says live", PUBLISH_JOB_STATES.COMPLETED, "Live");

/* ------------------------------------------------ when GitHub is the hold-up */

const github = (status: Record<string, string>) => parseGithubComponents({ components: Object.entries(status).map(([name, value]) => ({ name, status: value })) });
const allWell = github({ Pages: "operational", Actions: "operational", Webhooks: "operational", Issues: "major_outage" });
const actionsDown = github({ Pages: "operational", Actions: "degraded_performance", Webhooks: "operational" });
const webhooksDown = github({ Pages: "operational", Actions: "operational", Webhooks: "partial_outage" });

equal("only the parts a deploy goes through are read", Object.keys(allWell).sort(), ["Actions", "Pages", "Webhooks"]);
equal("an outage somewhere irrelevant says nothing", githubTroubleFor(allWell, "github-pages"), null);
equal("a GitHub Pages site waiting through degraded Actions is told why", githubTroubleFor(actionsDown, "github-pages"), GITHUB_TROUBLE_NOTICE);
equal("a Vercel site is not blamed on Actions", githubTroubleFor(actionsDown, "vercel"), null);
equal("but is held up by webhooks", githubTroubleFor(webhooksDown, "vercel"), GITHUB_TROUBLE_NOTICE);
equal("a host not yet known is told about any of the three", githubTroubleFor(webhooksDown, null), GITHUB_TROUBLE_NOTICE);
equal("not knowing GitHub's health is not a notice", githubTroubleFor(null, "github-pages"), null);
check("the notice says the change is saved and not to publish again", /saved/.test(GITHUB_TROUBLE_NOTICE) && /No need to publish again/.test(GITHUB_TROUBLE_NOTICE));
equal("a page with no components is no answer, not a crash", parseGithubComponents({ nope: true }), {});

equal("GitHub Pages is known by its request id", hostFromHeaders({ server: "cloudflare", "x-github-request-id": "C926:1" }), "github-pages");
equal("or by its server name", hostFromHeaders({ server: "GitHub.com" }), "github-pages");
equal("Vercel", hostFromHeaders({ server: "Vercel", "x-vercel-id": "cpt1::x" }), "vercel");
equal("Netlify", hostFromHeaders({ server: "Netlify" }), "netlify");
equal("a bare Cloudflare proxy is not taken for any host behind it", hostFromHeaders({ server: "cloudflare" }), "cloudflare");
equal("and is watched like an unknown host", componentsFor("cloudflare"), componentsFor(null));
equal("no headers, no guess", hostFromHeaders({}), null);

/* ------------------------------------------------------- the words */

const jobAt = (state: "VERIFYING" | "VERIFY_FAILED", ageMs: number, detail: Record<string, string> = {}): PublishJob => ({
  id: "job", siteId: "site", kind: "PAGE", state, pageId: null, sharedElementId: null, startedById: null, detail, commitSha: "20a09f5", commitUrl: null,
  verifyUrl: "https://africon.example/", verifyText: "Words", expectedHash: null, attempts: 3, nextCheckAt: null, verifiedAt: null, lastError: null,
  createdAt: new Date(Date.now() - ageMs), updatedAt: new Date(), finishedAt: null,
  route: null, fallbackFrom: null, routeLog: [], stage: null, stageTimes: {}, hostMessage: null,
});
equal("two hours on, the host is late, not failed", publishJobView(jobAt("VERIFYING", 2 * HOUR + MINUTE)).stateLabel, HOST_LATE_LABEL);
check("and never says the live page has not changed", !/has not changed/.test(HOST_LATE_LABEL));
equal("an hour in, it is still just waiting", publishJobView(jobAt("VERIFYING", HOUR)).late, false);
equal("GitHub's trouble is shown on a waiting GitHub Pages publish", publishJobView(jobAt("VERIFYING", MINUTE, { servedBy: "github-pages" }), { github: actionsDown }).notice, GITHUB_TROUBLE_NOTICE);
equal("and is what it is labelled with", publishJobView(jobAt("VERIFYING", MINUTE, { servedBy: "github-pages" }), { github: actionsDown }).stateLabel, GITHUB_TROUBLE_NOTICE);
equal("but not on one that has finished", publishJobView(jobAt("VERIFY_FAILED", MINUTE, { servedBy: "github-pages" }), { github: actionsDown }).notice, null);
equal("and not on a Vercel site, whose deploy does not go through Actions", publishJobView(jobAt("VERIFYING", MINUTE, { servedBy: "vercel" }), { github: actionsDown }).notice, null);

console.log(`websitePublishVerify: ${checks} checks — what to look for, what the live page proves, a watch that outlasts a bad day at GitHub without waiting for ever, and saying when GitHub is the hold-up`);
