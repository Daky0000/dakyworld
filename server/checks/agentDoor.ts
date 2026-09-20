/**
 * The entrance an AI assistant acting for a real customer is told to use.
 *
 * The site's contact form is defended by a honeypot and a three-second clock
 * (services/botCheck.ts). Both are right, and both describe an honest agent
 * exactly: an agent fills every input it can see, including the hidden one,
 * and it submits far faster than a person types. So a customer who sends an
 * assistant instead of typing has their enquiry stored and then discarded,
 * with a success-looking response on the way out — the worst failure shape
 * there is, because neither side learns anything.
 *
 * `agent-enquiry` is the separate door. What this asserts:
 *
 *  - **The human door did not change.** The honeypot and the clock still bin a
 *    submission. If a refactor ever relaxes them, that is a real regression and
 *    this fails, because the split is only worth having if the original rules
 *    survive it.
 *  - **The agent door lets an agent in.** Honeypot filled, submitted in 40ms —
 *    accepted, because on this door that is the expected caller.
 *  - **The agent door is not an open sewer.** Adverts and mail-header injection
 *    are rejected there exactly as they are on the human door. The content
 *    rules have nothing to do with timing and are not part of the trade.
 *  - **The door is actually reachable.** It is useless unless it is in both
 *    `HANDLED_SOURCES` (something acts on it) and `UNSIGNED_OK` (an unsigned
 *    stranger is allowed to act). Miss either and the endpoint accepts posts
 *    and silently does nothing — the same failure it was built to fix.
 *  - **`llms.txt` tells the truth.** It is the only reason an agent knows any
 *    of this exists. It has to name the real endpoint, and its list of
 *    `service` values has to match the real `<select>` on contact.html. Those
 *    two drift apart the moment somebody edits one, and an agent sending a
 *    service value the form does not have is a lead filed under nothing.
 *
 * No database, no key, no network.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { looksAutomated, looksLikeSpamContent, HONEYPOT_FIELD, TIMESTAMP_FIELD } from "../src/services/botCheck.js";
import { AGENT_SOURCE, HANDLED_SOURCES } from "../src/services/webhookIntake.js";
import { prisma } from "../src/lib/prisma.js";

let bad = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(ok ? `  ok    ${label}` : `  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) bad += 1;
}

const here = dirname(fileURLToPath(import.meta.url));
/** The website lives at the repository root, two levels above `server/checks`. */
const site = join(here, "..", "..");

/** A plain, honest enquiry with nothing wrong with it. */
const honest = {
  name: "Ama Mensah",
  email: "ama@example.com",
  company: "Mensah Logistics",
  message: "Three systems that do not talk to each other. Looking for help connecting them.",
};

console.log("\nThe human door still refuses a machine");
{
  check(
    "a filled honeypot is refused",
    looksAutomated({ ...honest, [HONEYPOT_FIELD]: "bot@example.com" }).reason !== null,
  );
  check(
    "a form submitted in 40ms is refused",
    looksAutomated({ ...honest, [TIMESTAMP_FIELD]: String(Date.now() - 40) }).reason !== null,
  );
  check("an honest enquiry is let through", looksAutomated(honest).reason === null);
}

console.log("\nThe agent door lets an agent in");
{
  // Exactly the submission the human door just refused, twice over.
  const agentShaped = {
    ...honest,
    [HONEYPOT_FIELD]: "ama@example.com",
    [TIMESTAMP_FIELD]: String(Date.now() - 40),
  };
  check("the same post the human door refused is accepted", looksLikeSpamContent(agentShaped).reason === null);
}

console.log("\nThe agent door still refuses what is actually wrong");
{
  const advert = {
    ...honest,
    message: "Buy backlink packages https://a.example https://b.example https://c.example seo services",
  };
  check("an advert is refused", looksLikeSpamContent(advert).reason !== null);
  check(
    "a mail-header injection is refused",
    looksLikeSpamContent({ ...honest, name: "Ama\r\nBcc: someone@example.com" }).reason !== null,
  );
}

console.log("\nThe door is reachable");
{
  check(
    `“${AGENT_SOURCE}” has a handler behind it`,
    (HANDLED_SOURCES as readonly string[]).includes(AGENT_SOURCE),
    "without this the endpoint stores the post and acts on nothing",
  );

  // UNSIGNED_OK is private to the router, so this reads the source. A stranger's
  // assistant has nowhere to have been given a signing secret, so the door is
  // shut to everyone it was built for unless the source is on that list.
  const router = readFileSync(join(here, "..", "src", "routes", "webhooks.ts"), "utf8");
  const unsigned = router.match(/const UNSIGNED_OK = new Set\(\[([^\]]*)\]\)/);
  check(
    `“${AGENT_SOURCE}” may act while unsigned`,
    unsigned !== null && unsigned[1].includes("AGENT_SOURCE"),
    "an unsigned post is recorded and ignored, which is the failure this door exists to fix",
  );
}

console.log("\nllms.txt tells an agent the truth");
{
  const llms = readFileSync(join(site, "llms.txt"), "utf8");

  check(
    "it names the real endpoint",
    llms.includes(`/api/webhooks/${AGENT_SOURCE}`),
    "an agent cannot find a door that is not written down",
  );
  check(
    "it warns against the human contact form",
    /contact\.html/.test(llms) && /hidden field|timing|discarded/i.test(llms),
    "without the warning an agent uses the form and is silently binned",
  );

  // The service values an agent is told to send, against the ones the real
  // form offers. These are edited in different files by different people.
  const contact = readFileSync(join(site, "contact.html"), "utf8");
  const offered = [...contact.matchAll(/<option value="([a-z0-9-]+)"/g)]
    .map((match) => match[1])
    .filter(Boolean);
  const documented = [...llms.matchAll(/^- `([a-z0-9-]+)`$/gm)].map((match) => match[1]);

  check("llms.txt lists some service values", documented.length > 0);
  const missing = documented.filter((value) => !offered.includes(value));
  check(
    "every documented service value exists on the real form",
    missing.length === 0,
    missing.length ? `not on contact.html: ${missing.join(", ")}` : undefined,
  );
  const undocumented = offered.filter((value) => !documented.includes(value));
  check(
    "every service value on the form is documented",
    undocumented.length === 0,
    undocumented.length ? `missing from llms.txt: ${undocumented.join(", ")}` : undefined,
  );
}

console.log(bad === 0 ? "\nAll agent-door checks passed" : `\n${bad} agent-door check(s) failed`);
await prisma.$disconnect();
process.exit(bad > 0 ? 1 : 0);
