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
import { decideVerification, livePageShowsChange, verificationText, PUBLISH_JOB_STATES } from "../src/services/websitePublishJobs.js";

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

equal("a page that shows the change is done", decideVerification({ verified: true, attempts: 1 }), { state: "COMPLETED" });

const waits: number[] = [];
for (let attempts = 1; attempts < 8; attempts++) {
  const step = decideVerification({ verified: false, attempts });
  assert.equal(step.state, "VERIFYING", `attempt ${attempts} keeps waiting`);
  waits.push((step as { nextCheckInMs: number }).nextCheckInMs);
}
checks++;
check("each look waits longer than the one before it", waits.every((wait, index) => index === 0 || wait > waits[index - 1]!));
check("the first look comes quickly", waits[0]! <= 45_000);
check("and the last is minutes rather than hours", waits[waits.length - 1]! <= 300_000);
check("the whole watch covers a slow static host", waits.reduce((total, wait) => total + wait, 0) >= 8 * 60_000);

const given = decideVerification({ verified: false, attempts: 8 });
equal("it stops asking rather than waiting for ever", given.state, "VERIFY_FAILED");
check("and says the commit is there while the page is not", /commit is in the repository/.test((given as { reason: string }).reason));

const unreachable = decideVerification({ verified: false, attempts: 8, error: "getaddrinfo ENOTFOUND example.test" });
check("a site that could not be read reports that, not a wrong story about caching", (unreachable as { reason: string }).reason.includes("ENOTFOUND"));

/* ------------------------------------------------------- the words */

check("every state has something a person can read", Object.values(PUBLISH_JOB_STATES).every((label) => label.length > 3 && label === label.trim()));
equal("and 'published' is never claimed before it is live", PUBLISH_JOB_STATES.COMMITTED, "Committed");
equal("only the live state says live", PUBLISH_JOB_STATES.COMPLETED, "Live");

console.log(`websitePublishVerify: ${checks} checks — what to look for, what the live page proves, and a backoff that neither gives up early nor waits for ever`);
