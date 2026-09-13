/**
 * Why a publish is refused, said out loud — and the GitHub reads worth retrying.
 *
 *   npx tsx checks/websitePublishReason.ts
 *
 * Two defects with the same shape behind them: something the system knows and
 * does not say. A plan that refuses because the draft matches the live page came
 * back as three empty lists and a dead button, which reads as a fault rather
 * than as the answer; and a GitHub read that failed on a 502 or a burst ceiling
 * was given up on, when the one thing GitHub asks for in both cases is that you
 * ask again. Needs no database and no network.
 */
import assert from "node:assert/strict";
import { buildPublishPlan } from "../src/services/website/index.js";
import { retryableStatus } from "../src/lib/github.js";

let checks = 0;
function check(name: string, condition: unknown) { assert.ok(condition, name); checks++; }
function equal(name: string, actual: unknown, expected: unknown) { assert.deepEqual(actual, expected, name); checks++; }

const page = `<!doctype html><html><body><main><h1 data-dw-field="title">Systems that run themselves</h1><p data-dw-field="lede">We build the quiet half.</p></main></body></html>`;

/* ------------------------------------------- a plan that changes nothing */

const unchanged = buildPublishPlan({ source: page, values: { title: { value: "Systems that run themselves" } } });
check("a draft matching the page is not publishable", !unchanged.publishable);
equal("and nothing is written", unchanged.changed, []);
check("the refusal says why", typeof unchanged.reason === "string" && unchanged.reason.length > 0);
check("in words a person can act on", /nothing to publish/i.test(unchanged.reason ?? ""));

/* ------------------------------------------------- a plan that does something */

const changed = buildPublishPlan({ source: page, values: { title: { value: "Systems that run themselves, quietly" } } });
check("a real change is publishable", changed.publishable);
equal("only the field that moved is written", changed.changed, ["title"]);
equal("and there is no reason to give", changed.reason, null);

/* -------------------------- a plan refused for a reason that explains itself */

const conflicted = buildPublishPlan({ source: page, values: { title: { value: "Something else", original: "A heading this page has never had" } } });
check("a page that moved under the draft is refused", !conflicted.publishable);
equal("without a reason of its own — the conflicts are the reason", conflicted.reason, null);
check("and the conflict is reported", conflicted.conflicts.length > 0 || conflicted.missing.length > 0);

/* ------------------------------------ which GitHub failures are worth repeating */

check("GitHub's own 5xx is worth asking again", retryableStatus(502, null, null));
check("so is a gateway timeout", retryableStatus(504, "upstream", null));
check("a secondary rate limit says so and means wait", retryableStatus(403, "You have exceeded a secondary rate limit", null));
check("abuse detection is the same ceiling by another name", retryableStatus(403, "abuse detection mechanism triggered", null));
check("anything handing back a Retry-After is telling us how long", retryableStatus(429, null, "12"));
check("the hourly limit is not: it resets on the hour, not in a second", !retryableStatus(403, "API rate limit exceeded for user", null));
check("a rejected token is never retried", !retryableStatus(401, "Bad credentials", null));
check("nor is a 404", !retryableStatus(404, "Not Found", null));
check("nor a refusal that is simply a refusal", !retryableStatus(403, "Resource not accessible by integration", null));
check("nor a bad request", !retryableStatus(422, "Invalid request", null));

console.log(`websitePublishReason: ${checks} checks — a refusal that says why, and the GitHub reads worth asking twice`);
