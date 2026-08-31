import type { LeadThesis, Prisma, ScraperPreset, LeadSource } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";

/**
 * The reasons Dakyworld goes looking for anybody.
 *
 * A `ScraperSource` says how to search. A thesis says **why that search is
 * worth paying for**, and what would make a business it finds worth keeping.
 * The two are separate on purpose: the same Google Maps search serves several
 * theses, and the same thesis can be hunted through several searches as the
 * market moves.
 *
 * Each one below is a complete argument, and each is meant to be arguable:
 *
 * - a **target** — who, in a sentence somebody would say out loud;
 * - a **rationale** — why them, why now, and what makes them buyable;
 * - an **offer** — what we would actually sell them if it holds. A target with
 *   no offer behind it is a mailing list;
 * - **qualifiers** — the tests that decide whether one particular business
 *   really fits, checked against what was audited rather than assumed;
 * - **disqualifiers** — what rules one out however well it scores.
 *
 * ## How a qualifier is written
 *
 * `signal-key — the sentence a person reads`. The key is looked up in
 * `signals.ts` and decided for free from the audit. A line with no known key in
 * front of it is prose, and prose goes to a model with the evidence attached.
 * Both are legitimate; the first is free and repeatable, so it is preferred
 * wherever the question can honestly be asked that way.
 *
 * ## The seeding contract
 *
 * The same one `AGENT_SEEDS` keeps: a deploy adds a thesis that does not exist
 * yet and **never** overwrites one, never enables one, and never widens one.
 * Enabling a thesis starts spending money twice a day, which is the Owner's
 * decision and nobody else's.
 */

export interface ThesisSeed {
  key: string;
  name: string;
  target: string;
  rationale: string;
  offer: string;
  qualifiers: string[];
  disqualifiers: string[];
  minScore: number;
  leadsPerRun: number;
  runTimes: string[];
  routePriority: number;
  routeAgentKey: string | null;
  /** The search this thesis hunts with, created alongside it if it is missing. */
  source: {
    name: string;
    actorId: string;
    preset: ScraperPreset;
    leadSource: LeadSource;
    groupName: string;
    /** Deliberately a small over-fetch of `leadsPerRun`: some rows are already judged. */
    maxItems: number;
    minScore: number;
    input: Record<string, unknown>;
  };
}

/**
 * Every thesis rules the same three things out, so the wording does not drift.
 *
 * `no-way-to-reach-them` is the one that saves real money: a business nobody
 * can write to cannot become anything, and auditing it is a payment for a row
 * that will sit in the pipeline for ever.
 */
const NEVER = [
  "already-a-client — they are already on our books.",
  "competitor — they sell what we sell, so this is not a prospect.",
  "no-way-to-reach-them — no email, no phone and no social account, so there is no way to open a conversation.",
];

/** The market comes from Settings → Lead capture, so moving it moves every hunt. */
const MARKET = "{{location}}";

export const THESIS_SEEDS: ThesisSeed[] = [
  {
    key: "no-shopfront",
    name: "Trading businesses with no website",
    target:
      "Established businesses in Ghana that are clearly trading — a phone somebody answers, real reviews on their listing — and have no website at all.",
    rationale:
      "Customers are already looking for them and finding a map pin with nowhere to go. There is no argument to have on the call: they are not being asked to believe a marketing claim, they are being shown that people are already searching and landing nowhere. It is also the shortest path from a first email to a signed build, because nothing has to be migrated, nobody has to be talked out of an existing agency, and the deliverable is obvious to them before we say a word.",
    offer:
      "A Foundation Build — a real site with the pages that actually get used, their own domain email, and hosting that somebody looks after.",
    qualifiers: [
      // Defining, not supporting. Without the `!` a business with a perfectly
      // good website scored three of four on "trading", "reachable" and
      // "well-reviewed" and qualified under a thesis about not having one.
      "!no-website — they have no website at all.",
      "trading — there is real evidence of trade: reviews, a rating, or a published number.",
      "reachable — there is at least one way to get in touch with them.",
      "well-reviewed — enough reviews, well enough rated, to be an established business rather than a new one.",
    ],
    disqualifiers: [...NEVER],
    minScore: 60,
    leadsPerRun: 5,
    runTimes: ["07:30", "15:30"],
    routePriority: 2,
    routeAgentKey: "lead.orchestrator",
    source: {
      name: "Hunt · no website",
      actorId: "compass/crawler-google-places",
      preset: "GOOGLE_MAPS",
      leadSource: "GOOGLE_MAPS",
      groupName: "Hunt · no website",
      maxItems: 20,
      minScore: 20,
      input: {
        searchStringsArray: [
          "real estate agency",
          "law firm",
          "private school",
          "dental clinic",
          "construction company",
          "logistics company",
          "printing press",
        ],
        locationQuery: MARKET,
        maxCrawledPlacesPerSearch: 5,
        language: "en",
        website: "withoutWebsite",
        maxReviews: 0,
        maxImages: 0,
      },
    },
  },
  {
    key: "broken-shopfront",
    name: "Businesses whose website is costing them work",
    target:
      "Businesses that already have a website and are being let down by it — it will not load, it warns visitors, it is unusable on a phone, or it is visibly of another decade.",
    rationale:
      "They have already decided they need a website, which is the hardest sale in the segment and it is already made. What is left is a specific, demonstrable fault with a date and a screenshot behind it, and a business that has paid for a site once will pay to have it work. The evidence also survives being forwarded: the person who opens our email is rarely the person who commissioned the site, and a picture of their own homepage on a phone does the arguing.",
    offer:
      "A rebuild or a rescue — the same Foundation Build where the site is beyond saving, and a fixed-scope repair where it is not, on hosting that is watched.",
    qualifiers: [
      // Defining: this thesis is about a site that is letting them down, so
      // there has to be a site. The `site-is-fine` disqualifier handles the
      // other half — a business whose setup is in good order has nothing
      // honest to be sold.
      "!has-website — they have a website, so there is something to review.",
      "looks-smaller-than-it-is — the site makes them look smaller or less serious than they actually are.",
      "not-mobile — the site is not built for a phone, and most of their visitors are on one.",
      "slow-site — it is slow enough to be losing visitors before the page appears.",
      "no-https — it is served without HTTPS, so a browser warns about it.",
      "looks-dated — the design is visibly of another decade.",
      "trading — there is real evidence of trade.",
    ],
    disqualifiers: [
      ...NEVER,
      "site-is-fine — nothing serious was found; their setup is in good order and there is nothing honest to sell them.",
    ],
    minScore: 40,
    leadsPerRun: 5,
    runTimes: ["09:30", "17:30"],
    routePriority: 2,
    routeAgentKey: "lead.orchestrator",
    source: {
      name: "Hunt · failing website",
      actorId: "compass/crawler-google-places",
      preset: "GOOGLE_MAPS",
      leadSource: "GOOGLE_MAPS",
      groupName: "Hunt · failing website",
      maxItems: 20,
      minScore: 20,
      input: {
        searchStringsArray: [
          "hotel",
          "private hospital",
          "manufacturing company",
          "wholesale distributor",
          "insurance company",
          "travel agency",
        ],
        locationQuery: MARKET,
        maxCrawledPlacesPerSearch: 5,
        language: "en",
        website: "withWebsite",
        maxReviews: 0,
        maxImages: 0,
      },
    },
  },
  {
    key: "manual-operations",
    name: "Businesses running on manual work worth automating",
    target:
      "Businesses whose bookings, orders, quotes or records still move by phone call, WhatsApp message and paper — where the volume is high enough that somebody is spending hours a week retyping things.",
    rationale:
      "This is the highest-margin work Dakyworld does and the least contested: nobody in the market is selling it to a Ghanaian mid-sized business, because it needs somebody to sit down and understand how they actually work. The tell is visible from outside — a business taking appointments or orders with no way to make one online is a business doing it by hand, and the hours behind that are a number they can check themselves. It is also the offer that survives a bad month, because it removes a cost rather than adding one.",
    offer:
      "An automation build — the booking, quoting or order flow they run by hand, connected up, with their existing tools rather than a replacement for them.",
    qualifiers: [
      // Defining, and deliberately the prose one: this is the whole thesis,
      // and it is not answerable from an audit. Marked required so that a
      // business scoring well on the supporting checks cannot qualify while
      // the thing the hunt is actually about went unanswered.
      "!The evidence shows this business takes bookings, appointments, orders or quotes, and there is no way at all to make one online — no form, no booking widget, no order page. State what you saw on the page that shows how a customer is expected to get in touch.",
      "contact-unclear — a visitor cannot see how to get in touch without hunting for it, which is the tell that everything routes through one phone number.",
      "The evidence shows a business with enough volume for manual handling to be expensive — several branches, long opening hours, a large review count, or a page describing a team rather than one person.",
      "no-analytics — nothing on the site measures whether any of it works, which usually means nothing behind it is measured either.",
      "trading — there is real evidence of trade.",
    ],
    disqualifiers: [
      ...NEVER,
      "The evidence shows they already run a proper booking, ordering or customer portal — a real system, not a contact form.",
    ],
    minScore: 50,
    leadsPerRun: 5,
    runTimes: ["08:30", "16:30"],
    routePriority: 2,
    routeAgentKey: "lead.orchestrator",
    source: {
      name: "Hunt · manual operations",
      actorId: "compass/crawler-google-places",
      preset: "GOOGLE_MAPS",
      leadSource: "GOOGLE_MAPS",
      groupName: "Hunt · manual operations",
      maxItems: 20,
      minScore: 20,
      input: {
        searchStringsArray: [
          "dental clinic",
          "diagnostic centre",
          "car rental",
          "event venue",
          "driving school",
          "veterinary clinic",
          "physiotherapy clinic",
          "tour operator",
        ],
        locationQuery: MARKET,
        maxCrawledPlacesPerSearch: 5,
        language: "en",
        maxReviews: 0,
        maxImages: 0,
      },
    },
  },
  {
    key: "spoofable-mail",
    name: "Businesses whose email can be forged",
    target:
      "Businesses that send invoices and quotes from a domain with no SPF and no DMARC — or from a free Gmail address — so anybody can send mail that appears to come from them.",
    rationale:
      "Invoice fraud is the one technical problem in this market that has already happened to somebody the prospect knows, which makes it the rare security conversation that does not need explaining. The check is objective, cheap and verifiable by them in a minute, and it is not a matter of opinion the way a design is. It also opens the door to the rest: a business that accepts they have a mail problem has accepted that nobody is looking after their setup.",
    offer:
      "Mail and domain hardening — SPF, DKIM and DMARC set up properly, their own domain addresses off free mailboxes, and a monthly plan that keeps it that way.",
    qualifiers: [
      // Defining: this thesis has nothing honest to say to a business whose
      // mail is already authenticated, and the other four are true of almost
      // everybody.
      "!no-dmarc — nothing stops a forged invoice appearing to come from them.",
      "no-spf — anyone can send mail as their domain.",
      "free-mail-contact — the address they do business from is a free mailbox rather than their own domain.",
      "trading — there is real evidence of trade, so a forged invoice would be paid.",
      "has-email — we have an address to write to.",
    ],
    disqualifiers: [
      ...NEVER,
      "mail-authenticated — their mail is already authenticated properly, so there is nothing to fix.",
    ],
    minScore: 55,
    leadsPerRun: 5,
    runTimes: ["10:30", "18:30"],
    routePriority: 2,
    routeAgentKey: "lead.orchestrator",
    source: {
      name: "Hunt · forgeable mail",
      actorId: "compass/crawler-google-places",
      preset: "GOOGLE_MAPS",
      leadSource: "GOOGLE_MAPS",
      groupName: "Hunt · forgeable mail",
      maxItems: 20,
      minScore: 20,
      input: {
        searchStringsArray: [
          "accounting firm",
          "law firm",
          "insurance broker",
          "freight forwarder",
          "import export company",
          "construction company",
        ],
        locationQuery: MARKET,
        maxCrawledPlacesPerSearch: 5,
        language: "en",
        website: "withWebsite",
        maxReviews: 0,
        maxImages: 0,
      },
    },
  },
];

/** Bumped when the shipped wording above changes. Never overwrites an edited row. */
const SEED_REVISION = 1;

/**
 * Puts the shipped theses on the database, and the searches they hunt with.
 *
 * Idempotent and additive. A thesis that already exists is left exactly as it
 * is — including `enabled`, which is the one field where being helpful would
 * mean starting to spend money on somebody's behalf.
 *
 * The search is created **disabled for the scheduler** on purpose. A thesis
 * drives its own capture; a source that also had its own schedule would run
 * twice a day on its own account as well, and the second set of rows would
 * arrive with no thesis attached and nothing to judge them by.
 */
export async function ensureTheses(): Promise<{ created: number; sources: number }> {
  let created = 0;
  let sources = 0;

  for (const seed of THESIS_SEEDS) {
    const existing = await prisma.leadThesis.findUnique({ where: { key: seed.key } });
    if (existing) continue;

    // Adopt a source of the same name before making another. A second "Hunt ·
    // no website" is the kind of duplicate nobody notices until both of them
    // are billing.
    let source = await prisma.scraperSource.findFirst({ where: { name: seed.source.name } });
    if (!source) {
      source = await prisma.scraperSource.create({
        data: {
          name: seed.source.name,
          actorId: seed.source.actorId,
          description: `Hunted under "${seed.name}". ${seed.rationale.split(".")[0]}.`,
          preset: seed.source.preset,
          leadSource: seed.source.leadSource,
          groupName: seed.source.groupName,
          maxItems: seed.source.maxItems,
          minScore: seed.source.minScore,
          input: seed.source.input as Prisma.InputJsonValue,
          // The thesis owns the clock. See the note above.
          enabled: true,
          scheduleEnabled: false,
          scheduleTimes: [],
          // The judge decides, not the mapper's score.
          autoQualify: false,
        },
      });
      sources += 1;
    }

    await prisma.leadThesis.create({
      data: {
        key: seed.key,
        name: seed.name,
        target: seed.target,
        rationale: seed.rationale,
        offer: seed.offer,
        qualifiers: seed.qualifiers,
        disqualifiers: seed.disqualifiers,
        minScore: seed.minScore,
        leadsPerRun: seed.leadsPerRun,
        runTimes: seed.runTimes,
        routePriority: seed.routePriority,
        routeAgentKey: seed.routeAgentKey,
        sourceId: source.id,
        seedRevision: SEED_REVISION,
        enabled: false,
      },
    });
    created += 1;
  }

  return { created, sources };
}

/** The shipped wording for one thesis, for a Reset action. Null for a custom one. */
export function shippedThesis(key: string): ThesisSeed | null {
  return THESIS_SEEDS.find((seed) => seed.key === key) ?? null;
}

/** Every line of a thesis, as one block a person or an agent can read. */
export function thesisForPrompt(thesis: Pick<LeadThesis, "name" | "target" | "rationale" | "offer" | "qualifiers" | "disqualifiers" | "minScore">): string {
  return [
    `Thesis: ${thesis.name}`,
    `Who: ${thesis.target}`,
    `Why them: ${thesis.rationale}`,
    `What we would sell them: ${thesis.offer}`,
    `Fits when: ${thesis.qualifiers.join(" / ")}`,
    `Ruled out by: ${thesis.disqualifiers.join(" / ")}`,
    `Kept at a score of ${thesis.minScore} or more.`,
  ].join("\n");
}
