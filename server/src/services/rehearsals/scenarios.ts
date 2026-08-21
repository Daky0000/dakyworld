/**
 * The workflows a rehearsal can put a website through.
 *
 * A scenario is not a script. It names **one agent to start with** and writes
 * **one brief**, and everything after that is the workforce deciding for
 * itself — who to ask, what to look at, what to hand down and to whom. That is
 * deliberate and it is the whole value of the exercise: a scripted pipeline
 * would prove that the script works, which nobody doubts. What is actually in
 * question is whether an agent given a website and a goal reaches the right
 * colleague, and this is the only way to watch it happen.
 *
 * **Why the starting agent is usually a director.** Handing the job straight
 * to the Cold Lead Writer tests the Cold Lead Writer. Handing it to the Sales
 * Director tests the routing — whether the lead gets scored before it gets
 * written to, whether anybody thinks to look at the site first — which is the
 * part that goes wrong silently in production and never shows up in a single
 * agent's timeline.
 *
 * **The briefs say what to achieve and not how.** A brief listing the tools to
 * call in order would hide exactly the defect a rehearsal exists to find: an
 * agent that does not know it should have run the audit before writing the
 * letter. Each one names the goal, the site, and what "finished" means — the
 * same three things a person would be told.
 */

export interface Scenario {
  key: string;
  /** What it is called on the page. */
  name: string;
  /** One line: what this run is for. */
  purpose: string;
  /** The agent the work starts with. Everything after that is its own decision. */
  startAgent: string;
  /** What the run is expected to exercise, for the person reading the timeline. */
  exercises: string[];
  /**
   * Roughly how far this fans out, so the page can say before a run that will
   * wake a dozen agents and spend accordingly. Not enforced — the workforce
   * decides how wide to go, and a scenario that fans out further than this
   * says is itself a finding.
   */
  reach: "narrow" | "wide";
  /** Builds the brief. `site` is the normalised URL; `name` is the business, when known. */
  brief: (subject: { site: string; name: string }) => string;
}

/**
 * The sentence every brief ends with.
 *
 * Identical across scenarios on purpose: when two runs end differently, the
 * difference is in the agents rather than in how each was asked.
 */
const FINISH =
  "When you are done, say plainly what you did, what you found, what you have prepared for a person to approve, and what you would do next. If something stopped you, say what and why rather than working around it.";

export const SCENARIOS: Scenario[] = [
  {
    key: "cold-outreach",
    name: "Website to first letter",
    purpose: "The main road. Judge a business off its own site, and get a first approach ready to send.",
    startAgent: "cro",
    reach: "wide",
    exercises: [
      "Whether anybody looks at the site before writing to them",
      "Whether the lead is scored on evidence or on the trade",
      "Which finding the letter ends up leading on",
      "Whether the send stops at a preview, and what the preview says",
    ],
    brief: ({ site, name }) => `${name} is a business we have never approached. Their website is ${site}.

Decide whether they are worth approaching, and if they are, get the first letter ready to go out.

That means finding out what is actually true about them and their site rather than what their trade suggests, deciding what Dakyworld could genuinely do for them, and having somebody write the approach off what was found. A lead record for them already exists — work from it, and put what you learn back on it.

${FINISH}`,
  },
  {
    key: "site-review",
    name: "Four reviewers over the site",
    purpose: "The audit team: design, speed and findability, content, security — compiled into one report.",
    startAgent: "cmo",
    reach: "narrow",
    exercises: [
      "Whether the audit team is reached at all, or one agent tries to review it alone",
      "What the four reviewers disagree about",
      "Whether a score is shown when too little of the site could be checked",
      "Whether findings are quoted with evidence or asserted",
    ],
    brief: ({ site, name }) => `Have ${name}'s website at ${site} properly reviewed — the way we would review it before putting a number in front of them.

I want to know what is genuinely wrong with it, what it costs them, and which single thing they should fix first. Findings must be things you can point at on the site, not general advice about websites.

Where the review cannot establish something, say so rather than filling the gap. A confident sentence about a page nobody could load is the one thing that loses us the meeting.

${FINISH}`,
  },
  {
    key: "demo-page",
    name: "Build them a demo page",
    purpose: "The free-page offer: design direction off their own site, then a page carrying their name.",
    startAgent: "cto",
    reach: "narrow",
    exercises: [
      "Where the design direction is sourced from",
      "Whether anything about the business gets invented to fill the page",
      "The guards on publishing a page in somebody else's name",
      "Whether the build stops at a preview, and what it says it would publish",
    ],
    brief: ({ site, name }) => `We want to offer ${name} a free demo page — a better version of their homepage, built from what is already on ${site}, that we can put in front of them as the whole pitch.

Work out what their site is trying to do and where it fails at it, then get the page built. Everything on it must come from something real about this business. Nothing invented: no services they do not offer, no claims they have not made, no testimonials.

${FINISH}`,
  },
  {
    key: "scope-and-price",
    name: "Scope and price the work",
    purpose: "From a site to a proposal: what we would actually do for them, and what the catalogue says it costs.",
    startAgent: "cro",
    reach: "narrow",
    exercises: [
      "Whether scope is argued from evidence or from what is easy to price",
      "What happens when the catalogue has no price for the scope",
      "Which assumptions get flagged for a person to confirm",
    ],
    brief: ({ site, name }) => `Assume ${name} (${site}) has come back interested and we now have to put a proposal together.

Establish what is actually wrong with their setup, decide what Dakyworld would do about it, and get that scoped and priced. Every line has to trace to something found on their site or something they asked for — not to what is easiest to sell.

Where you have to assume something, say so and mark it for me to confirm before it goes out. If the catalogue has no price for part of it, stop there and say so rather than inventing a number.

${FINISH}`,
  },
  {
    key: "whole-floor",
    name: "The whole floor",
    purpose: "Everything at once, from the top. The one that shows how far a single website travels through the company.",
    startAgent: "ceo",
    reach: "wide",
    exercises: [
      "How work is split between the directors, and whether any of it is done twice",
      "Whether anybody asks a colleague rather than guessing",
      "Where the chain breaks — the agent that receives a brief it cannot act on",
      "What the whole thing costs, and which agent spends the most",
    ],
    brief: ({ site, name }) => `${name}, at ${site}, is a business nobody here has looked at.

I want to know what Dakyworld would do with them if we decided to go after them properly — what is wrong with their site, what we would offer, what it would cost them, what we would say to them first, and whether they are worth our time at all.

Split it up as you see fit. I would rather have four directors' honest answers than one summary that agrees with itself.

${FINISH}`,
  },
];

export function findScenario(key: string): Scenario | null {
  return SCENARIOS.find((scenario) => scenario.key === key) ?? null;
}

/**
 * The name to show for a scenario that has since been renamed or removed.
 *
 * Rehearsals outlive the catalogue — the workflows change as the roster does —
 * and a run whose scenario is gone should still read back as something rather
 * than as a bare key nobody recognises.
 */
export function scenarioName(key: string): string {
  return findScenario(key)?.name ?? `${key} — no longer in the catalogue`;
}
