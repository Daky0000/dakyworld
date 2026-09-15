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

/**
 * The home market, from Settings → Lead capture. Moving it moves every hunt
 * that uses this token — and only those.
 *
 * A thesis is free to name its own city instead, and the ones below that hunt
 * outside Ghana do exactly that. That is the point of the split: `{{location}}`
 * means "wherever we are selling from", a literal like "Lagos, Nigeria" means
 * "this market, whatever the setting says". Changing the setting must never
 * silently drag the Toronto hunt to Accra, and pointing a Toronto hunt at
 * Accra by hand must not move anything else.
 *
 * Every hunt below ships disabled, foreign or not. A new market is a decision
 * about money — each enabled thesis is two Apify runs a day — so a deploy may
 * offer one and may not start one.
 */
const MARKET = "{{location}}";

export const THESIS_SEEDS: ThesisSeed[] = [
  {
    key: "no-shopfront",
    name: "Trading businesses with no website",
    target:
      "Established businesses in the home market that are clearly trading — a phone somebody answers, real reviews on their listing — and have no website at all.",
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
  // --- Ghana, beyond Accra -------------------------------------------------
  {
    key: "kumasi-no-shopfront",
    name: "Kumasi and the Ashanti trade with no website",
    target:
      "Established traders, wholesalers, schools and clinics in Kumasi and around Ashanti that are clearly doing business and have no website at all.",
    rationale:
      "Accra is where every agency in the country is already writing, and Kumasi is a second city with a real commercial middle that almost nobody is selling to properly. The businesses are the same size and the same age as the Accra ones, the search demand is already there, and the first credible email a Kumasi wholesaler has ever had about their web presence is worth more than the tenth one an Accra hotel gets this month. Being from Ghana and not being in their street is an advantage here: we can say we work across the country and mean it.",
    offer:
      "A Foundation Build — a real site with the pages that actually get used, their own domain email, and hosting that somebody looks after.",
    qualifiers: [
      "!no-website — they have no website at all.",
      "trading — there is real evidence of trade: reviews, a rating, or a published number.",
      "reachable — there is at least one way to get in touch with them.",
      "well-reviewed — enough reviews, well enough rated, to be an established business rather than a new one.",
    ],
    disqualifiers: [...NEVER],
    minScore: 60,
    leadsPerRun: 5,
    runTimes: ["07:45", "15:45"],
    routePriority: 2,
    routeAgentKey: "lead.orchestrator",
    source: {
      name: "Hunt · Kumasi · no website",
      actorId: "compass/crawler-google-places",
      preset: "GOOGLE_MAPS",
      leadSource: "GOOGLE_MAPS",
      groupName: "Hunt · Kumasi · no website",
      maxItems: 20,
      minScore: 20,
      input: {
        searchStringsArray: [
          "wholesale distributor",
          "private school",
          "dental clinic",
          "hardware store",
          "transport company",
          "printing press",
        ],
        locationQuery: "Kumasi, Ghana",
        maxCrawledPlacesPerSearch: 5,
        language: "en",
        website: "withoutWebsite",
        maxReviews: 0,
        maxImages: 0,
      },
    },
  },

  // --- West Africa ---------------------------------------------------------
  {
    key: "lagos-no-shopfront",
    name: "Lagos businesses with no website",
    target:
      "Trading businesses in Lagos — agencies, clinics, schools, logistics firms — with reviews on their listing, a number somebody answers, and nowhere to send a customer.",
    rationale:
      "Lagos is the largest concentration of buyable businesses inside our own timezone, it works in English, and it pays for work like this at rates Accra is still learning. The argument does not change at the border: people are searching and landing on a map pin. What changes is the volume — the same thesis that finds five prospects a run in Accra will not run out in Lagos for years. Delivery is unaffected, because nothing about this work needs us in the room.",
    offer:
      "A Foundation Build — a real site with the pages that actually get used, their own domain email, and hosting that somebody looks after.",
    qualifiers: [
      "!no-website — they have no website at all.",
      "trading — there is real evidence of trade: reviews, a rating, or a published number.",
      "reachable — there is at least one way to get in touch with them.",
      "well-reviewed — enough reviews, well enough rated, to be an established business rather than a new one.",
    ],
    disqualifiers: [...NEVER],
    minScore: 60,
    leadsPerRun: 5,
    runTimes: ["08:00", "16:00"],
    routePriority: 2,
    routeAgentKey: "lead.orchestrator",
    source: {
      name: "Hunt · Lagos · no website",
      actorId: "compass/crawler-google-places",
      preset: "GOOGLE_MAPS",
      leadSource: "GOOGLE_MAPS",
      groupName: "Hunt · Lagos · no website",
      maxItems: 20,
      minScore: 20,
      input: {
        searchStringsArray: [
          "real estate agency",
          "private school",
          "dental clinic",
          "logistics company",
          "construction company",
          "travel agency",
        ],
        locationQuery: "Lagos, Nigeria",
        maxCrawledPlacesPerSearch: 5,
        language: "en",
        website: "withoutWebsite",
        maxReviews: 0,
        maxImages: 0,
      },
    },
  },
  {
    key: "abuja-broken-shopfront",
    name: "Abuja businesses whose website is costing them work",
    target:
      "Abuja businesses that already have a website and are being let down by it — it will not load, it warns visitors, it is unusable on a phone, or it is visibly of another decade.",
    rationale:
      "Abuja money is institutional: consultancies, contractors and suppliers who are judged on how they look to a government client or a bank, and who already believe a website matters because they bought one. That belief is the expensive half of the sale and it is already paid for. What is left is a screenshot of their own homepage on a phone, which travels further inside an organisation than any claim we could make about ourselves.",
    offer:
      "A rebuild or a rescue — the same Foundation Build where the site is beyond saving, and a fixed-scope repair where it is not, on hosting that is watched.",
    qualifiers: [
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
    runTimes: ["09:45", "17:45"],
    routePriority: 2,
    routeAgentKey: "lead.orchestrator",
    source: {
      name: "Hunt · Abuja · failing website",
      actorId: "compass/crawler-google-places",
      preset: "GOOGLE_MAPS",
      leadSource: "GOOGLE_MAPS",
      groupName: "Hunt · Abuja · failing website",
      maxItems: 20,
      minScore: 20,
      input: {
        searchStringsArray: [
          "management consultant",
          "engineering company",
          "private hospital",
          "hotel",
          "insurance company",
          "security services",
        ],
        locationQuery: "Abuja, Nigeria",
        maxCrawledPlacesPerSearch: 5,
        language: "en",
        website: "withWebsite",
        maxReviews: 0,
        maxImages: 0,
      },
    },
  },

  // --- East and Southern Africa -------------------------------------------
  {
    key: "nairobi-manual-operations",
    name: "Nairobi businesses running on manual work worth automating",
    target:
      "Nairobi businesses taking bookings, orders or quotes by phone call and WhatsApp, at a volume where somebody is spending hours a week retyping things.",
    rationale:
      "Nairobi is the one market in the region where a business already expects things to be done online — M-Pesa taught a whole economy that — and that expectation is what makes an automation pitch land without a lecture first. The tell is still visible from outside: a clinic or a tour operator taking appointments with no way to make one online is doing it by hand. Kenya also buys software as software rather than as a favour, which makes the recurring half of the offer easier to keep.",
    offer:
      "An automation build — the booking, quoting or order flow they run by hand, connected up, with their existing tools rather than a replacement for them.",
    qualifiers: [
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
    runTimes: ["08:45", "16:45"],
    routePriority: 2,
    routeAgentKey: "lead.orchestrator",
    source: {
      name: "Hunt · Nairobi · manual operations",
      actorId: "compass/crawler-google-places",
      preset: "GOOGLE_MAPS",
      leadSource: "GOOGLE_MAPS",
      groupName: "Hunt · Nairobi · manual operations",
      maxItems: 20,
      minScore: 20,
      input: {
        searchStringsArray: [
          "dental clinic",
          "diagnostic centre",
          "tour operator",
          "car rental",
          "event venue",
          "physiotherapy clinic",
        ],
        locationQuery: "Nairobi, Kenya",
        maxCrawledPlacesPerSearch: 5,
        language: "en",
        maxReviews: 0,
        maxImages: 0,
      },
    },
  },
  {
    key: "kampala-no-shopfront",
    name: "Kampala businesses with no website",
    target:
      "Established Kampala businesses — schools, clinics, suppliers, hospitality — trading visibly and with no website at all.",
    rationale:
      "Kampala is an English-speaking capital an hour ahead of us with very little agency competition writing credible email into it, and the gap between what a business there earns and what a Foundation Build costs is the same gap that makes the offer work in Accra. It is a deliberately cheap hunt: if the replies do not come, we have learnt that for the price of a few Maps searches rather than a trip.",
    offer:
      "A Foundation Build — a real site with the pages that actually get used, their own domain email, and hosting that somebody looks after.",
    qualifiers: [
      "!no-website — they have no website at all.",
      "trading — there is real evidence of trade: reviews, a rating, or a published number.",
      "reachable — there is at least one way to get in touch with them.",
      "well-reviewed — enough reviews, well enough rated, to be an established business rather than a new one.",
    ],
    disqualifiers: [...NEVER],
    minScore: 60,
    leadsPerRun: 5,
    runTimes: ["07:15", "15:15"],
    routePriority: 3,
    routeAgentKey: "lead.orchestrator",
    source: {
      name: "Hunt · Kampala · no website",
      actorId: "compass/crawler-google-places",
      preset: "GOOGLE_MAPS",
      leadSource: "GOOGLE_MAPS",
      groupName: "Hunt · Kampala · no website",
      maxItems: 20,
      minScore: 20,
      input: {
        searchStringsArray: [
          "private school",
          "medical clinic",
          "hardware store",
          "hotel",
          "transport company",
          "law firm",
        ],
        locationQuery: "Kampala, Uganda",
        maxCrawledPlacesPerSearch: 5,
        language: "en",
        website: "withoutWebsite",
        maxReviews: 0,
        maxImages: 0,
      },
    },
  },
  {
    key: "johannesburg-broken-shopfront",
    name: "Johannesburg businesses whose website is costing them work",
    target:
      "Johannesburg and Pretoria businesses with a website that is letting them down — slow, insecure, unusable on a phone, or clearly untouched for a decade.",
    rationale:
      "South Africa pays properly and in a currency that survives the trip, and it has a large stock of small business websites built once in the 2010s and never opened again. The fault is objective and photographable, which is the only kind of argument that works on a stranger in a market where we have no name yet. It is also the market where the monthly plan sells hardest: a business that has been let down once by a builder who disappeared understands exactly what it is paying for.",
    offer:
      "A rebuild or a rescue — the same Foundation Build where the site is beyond saving, and a fixed-scope repair where it is not, on hosting that is watched.",
    qualifiers: [
      "!has-website — they have a website, so there is something to review.",
      "looks-dated — the design is visibly of another decade.",
      "not-mobile — the site is not built for a phone, and most of their visitors are on one.",
      "slow-site — it is slow enough to be losing visitors before the page appears.",
      "no-https — it is served without HTTPS, so a browser warns about it.",
      "looks-smaller-than-it-is — the site makes them look smaller or less serious than they actually are.",
      "trading — there is real evidence of trade.",
    ],
    disqualifiers: [
      ...NEVER,
      "site-is-fine — nothing serious was found; their setup is in good order and there is nothing honest to sell them.",
    ],
    minScore: 40,
    leadsPerRun: 5,
    runTimes: ["10:00", "18:00"],
    routePriority: 2,
    routeAgentKey: "lead.orchestrator",
    source: {
      name: "Hunt · Johannesburg · failing website",
      actorId: "compass/crawler-google-places",
      preset: "GOOGLE_MAPS",
      leadSource: "GOOGLE_MAPS",
      groupName: "Hunt · Johannesburg · failing website",
      maxItems: 20,
      minScore: 20,
      input: {
        searchStringsArray: [
          "manufacturing company",
          "wholesale distributor",
          "accounting firm",
          "private school",
          "plumbing company",
          "guest house",
        ],
        locationQuery: "Johannesburg, South Africa",
        maxCrawledPlacesPerSearch: 5,
        language: "en",
        website: "withWebsite",
        maxReviews: 0,
        maxImages: 0,
      },
    },
  },

  // --- UK and Ireland ------------------------------------------------------
  {
    key: "london-spoofable-mail",
    name: "London professional firms whose email can be forged",
    target:
      "London accountants, solicitors, brokers and freight agents invoicing from a domain with no SPF and no DMARC, or from a free mailbox.",
    rationale:
      "This is the one thesis that travels into an expensive market without us needing a reputation first, because it is not an opinion. A firm that moves client money and has no DMARC record can verify what we tell them in under a minute, and in the UK the consequence has a name and a regulator attached to it. It is also the cheapest possible qualification — the check is a DNS lookup, not a rendered page — so a market where most sites are competent does not make the hunt expensive.",
    offer:
      "Mail and domain hardening — SPF, DKIM and DMARC set up properly, their own domain addresses off free mailboxes, and a monthly plan that keeps it that way.",
    qualifiers: [
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
    runTimes: ["11:00", "19:00"],
    routePriority: 2,
    routeAgentKey: "lead.orchestrator",
    source: {
      name: "Hunt · London · forgeable mail",
      actorId: "compass/crawler-google-places",
      preset: "GOOGLE_MAPS",
      leadSource: "GOOGLE_MAPS",
      groupName: "Hunt · London · forgeable mail",
      maxItems: 20,
      minScore: 20,
      input: {
        searchStringsArray: [
          "accountant",
          "solicitor",
          "insurance broker",
          "freight forwarder",
          "letting agent",
          "recruitment agency",
        ],
        locationQuery: "London, United Kingdom",
        maxCrawledPlacesPerSearch: 5,
        language: "en",
        website: "withWebsite",
        maxReviews: 0,
        maxImages: 0,
      },
    },
  },
  {
    key: "uk-trades-broken-shopfront",
    name: "UK trades and services with a website of another decade",
    target:
      "Builders, electricians, garages, dental practices and care providers across Manchester and the North West whose site is dated, slow, or unusable on the phone every one of their customers is holding.",
    rationale:
      "UK trades buy from evidence and hate being sold to, which suits a hunt whose entire opening is a photograph of their own homepage. The work is small, fixed and unglamorous, the numbers are in pounds, and the segment renews because a working site is how the phone rings. Manchester rather than London on purpose: the same businesses, a fraction of the agencies writing to them, and nobody expecting a meeting in person.",
    offer:
      "A rebuild or a rescue — the same Foundation Build where the site is beyond saving, and a fixed-scope repair where it is not, on hosting that is watched.",
    qualifiers: [
      "!has-website — they have a website, so there is something to review.",
      "not-mobile — the site is not built for a phone, and most of their visitors are on one.",
      "looks-dated — the design is visibly of another decade.",
      "slow-site — it is slow enough to be losing visitors before the page appears.",
      "no-https — it is served without HTTPS, so a browser warns about it.",
      "trading — there is real evidence of trade.",
    ],
    disqualifiers: [
      ...NEVER,
      "site-is-fine — nothing serious was found; their setup is in good order and there is nothing honest to sell them.",
    ],
    minScore: 45,
    leadsPerRun: 5,
    runTimes: ["11:30", "19:30"],
    routePriority: 3,
    routeAgentKey: "lead.orchestrator",
    source: {
      name: "Hunt · Manchester · failing website",
      actorId: "compass/crawler-google-places",
      preset: "GOOGLE_MAPS",
      leadSource: "GOOGLE_MAPS",
      groupName: "Hunt · Manchester · failing website",
      maxItems: 20,
      minScore: 20,
      input: {
        searchStringsArray: [
          "builder",
          "electrician",
          "car garage",
          "dental practice",
          "care home",
          "landscaping company",
        ],
        locationQuery: "Manchester, United Kingdom",
        maxCrawledPlacesPerSearch: 5,
        language: "en",
        website: "withWebsite",
        maxReviews: 0,
        maxImages: 0,
      },
    },
  },
  {
    key: "dublin-manual-operations",
    name: "Dublin businesses running on manual work worth automating",
    target:
      "Dublin clinics, studios, venues and service firms taking bookings and quotes by phone and email, with no way to make one online.",
    rationale:
      "Ireland is a small, English-speaking, high-wage market, and high wages are what make manual handling worth removing: an hour a day of retyping costs a Dublin business several times what it costs an Accra one, which is the whole arithmetic of the pitch. It is also a market that buys remotely without blinking, and one where a well-argued email still gets read because the volume of cold outreach is lower than in London.",
    offer:
      "An automation build — the booking, quoting or order flow they run by hand, connected up, with their existing tools rather than a replacement for them.",
    qualifiers: [
      "!The evidence shows this business takes bookings, appointments, orders or quotes, and there is no way at all to make one online — no form, no booking widget, no order page. State what you saw on the page that shows how a customer is expected to get in touch.",
      "contact-unclear — a visitor cannot see how to get in touch without hunting for it.",
      "The evidence shows a business with enough volume for manual handling to be expensive — several branches, long opening hours, a large review count, or a page describing a team rather than one person.",
      "no-analytics — nothing on the site measures whether any of it works.",
      "trading — there is real evidence of trade.",
    ],
    disqualifiers: [
      ...NEVER,
      "The evidence shows they already run a proper booking, ordering or customer portal — a real system, not a contact form.",
    ],
    minScore: 50,
    leadsPerRun: 5,
    runTimes: ["12:00", "20:00"],
    routePriority: 3,
    routeAgentKey: "lead.orchestrator",
    source: {
      name: "Hunt · Dublin · manual operations",
      actorId: "compass/crawler-google-places",
      preset: "GOOGLE_MAPS",
      leadSource: "GOOGLE_MAPS",
      groupName: "Hunt · Dublin · manual operations",
      maxItems: 20,
      minScore: 20,
      input: {
        searchStringsArray: [
          "physiotherapy clinic",
          "dental practice",
          "beauty salon",
          "event venue",
          "driving school",
          "veterinary clinic",
        ],
        locationQuery: "Dublin, Ireland",
        maxCrawledPlacesPerSearch: 5,
        language: "en",
        maxReviews: 0,
        maxImages: 0,
      },
    },
  },

  // --- North America -------------------------------------------------------
  {
    key: "toronto-broken-shopfront",
    name: "Toronto businesses whose website is costing them work",
    target:
      "Toronto and Mississauga businesses — trades, clinics, suppliers, immigration and legal practices — with a site that is slow, insecure or built before the phone was the default.",
    rationale:
      "Toronto is the North American market where a Ghanaian firm starts with the least explaining to do: a large West African and Caribbean business community, English throughout, and a time difference that still leaves an overlapping afternoon. The offer is unchanged and the evidence is unchanged; what changes is the ticket, which is several times the Accra one for the same week of work.",
    offer:
      "A rebuild or a rescue — the same Foundation Build where the site is beyond saving, and a fixed-scope repair where it is not, on hosting that is watched.",
    qualifiers: [
      "!has-website — they have a website, so there is something to review.",
      "not-mobile — the site is not built for a phone, and most of their visitors are on one.",
      "slow-site — it is slow enough to be losing visitors before the page appears.",
      "looks-dated — the design is visibly of another decade.",
      "looks-smaller-than-it-is — the site makes them look smaller or less serious than they actually are.",
      "no-https — it is served without HTTPS, so a browser warns about it.",
      "trading — there is real evidence of trade.",
    ],
    disqualifiers: [
      ...NEVER,
      "site-is-fine — nothing serious was found; their setup is in good order and there is nothing honest to sell them.",
    ],
    minScore: 45,
    leadsPerRun: 5,
    runTimes: ["13:00", "21:00"],
    routePriority: 3,
    routeAgentKey: "lead.orchestrator",
    source: {
      name: "Hunt · Toronto · failing website",
      actorId: "compass/crawler-google-places",
      preset: "GOOGLE_MAPS",
      leadSource: "GOOGLE_MAPS",
      groupName: "Hunt · Toronto · failing website",
      maxItems: 20,
      minScore: 20,
      input: {
        searchStringsArray: [
          "immigration consultant",
          "law firm",
          "dental clinic",
          "hvac contractor",
          "moving company",
          "accounting firm",
        ],
        locationQuery: "Toronto, Canada",
        maxCrawledPlacesPerSearch: 5,
        language: "en",
        website: "withWebsite",
        maxReviews: 0,
        maxImages: 0,
      },
    },
  },
  {
    key: "us-services-spoofable-mail",
    name: "US service firms whose email can be forged",
    target:
      "Houston contractors, brokers, freight agents and property managers invoicing from a domain with no SPF and no DMARC.",
    rationale:
      "The United States is the most crowded market on earth for anybody selling websites and one of the least crowded for somebody arriving with a specific, checkable security fault. Invoice fraud against small contractors is common enough there to be an insurance category, so the opening line needs no education, and the fix is a day of work that leads directly into somebody looking after their setup monthly. The city is chosen on purpose: large, transactional, and not San Francisco.",
    offer:
      "Mail and domain hardening — SPF, DKIM and DMARC set up properly, their own domain addresses off free mailboxes, and a monthly plan that keeps it that way.",
    qualifiers: [
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
    runTimes: ["14:00", "22:00"],
    routePriority: 3,
    routeAgentKey: "lead.orchestrator",
    source: {
      name: "Hunt · Houston · forgeable mail",
      actorId: "compass/crawler-google-places",
      preset: "GOOGLE_MAPS",
      leadSource: "GOOGLE_MAPS",
      groupName: "Hunt · Houston · forgeable mail",
      maxItems: 20,
      minScore: 20,
      input: {
        searchStringsArray: [
          "general contractor",
          "freight broker",
          "property management company",
          "insurance agency",
          "hvac contractor",
          "commercial cleaning company",
        ],
        locationQuery: "Houston, Texas, United States",
        maxCrawledPlacesPerSearch: 5,
        language: "en",
        website: "withWebsite",
        maxReviews: 0,
        maxImages: 0,
      },
    },
  },

  // --- Angles that follow the home market ---------------------------------
  {
    key: "rented-shopfront",
    name: "Businesses renting their shopfront from Facebook",
    target:
      "Businesses whose entire web presence is a Facebook or Instagram page — an address they do not own, on a platform that can suspend it without explanation.",
    rationale:
      "This is the segment that has already decided a web presence matters, has done the work of posting for years, and owns none of it. They are not being asked to believe in the internet; they are being shown that everything they have built sits in somebody else's account. The audience, the posts and the reviews are all evidence we can point at, and the risk of losing it is concrete rather than theoretical to anybody who has had a page locked. It converts faster than the no-website thesis because the customer has already been earned — they just have nowhere to send them.",
    offer:
      "A Foundation Build on their own domain, with the social pages kept as a feeder rather than the destination, and their own domain email.",
    qualifiers: [
      "!rented-presence — a Facebook or Instagram page is standing in for a website they do not own.",
      "demand-without-destination — people are already looking for them and there is nowhere to send anyone.",
      "trading — there is real evidence of trade.",
      "reachable — there is at least one way to get in touch with them.",
      "no-link-preview — their link shows as a bare URL when it is shared.",
    ],
    disqualifiers: [
      ...NEVER,
      "has-website — they already own a site, so this is not the argument to make to them.",
    ],
    minScore: 50,
    leadsPerRun: 5,
    runTimes: ["09:00", "17:00"],
    routePriority: 2,
    routeAgentKey: "lead.orchestrator",
    source: {
      name: "Hunt · rented shopfront",
      actorId: "compass/crawler-google-places",
      preset: "GOOGLE_MAPS",
      leadSource: "GOOGLE_MAPS",
      groupName: "Hunt · rented shopfront",
      maxItems: 20,
      minScore: 20,
      input: {
        searchStringsArray: [
          "beauty salon",
          "fashion designer",
          "furniture shop",
          "catering service",
          "gym",
          "photography studio",
          "restaurant",
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
    key: "unmaintained-site",
    name: "Businesses running a site nobody has maintained",
    target:
      "Businesses on a website that is years out of date underneath — an old CMS publishing its own version number, no HTTPS, everything on one host with nothing behind it.",
    rationale:
      "This is the thesis that sells the monthly plan rather than the build, which is the part of the business we actually want to grow. The findings are technical, dated and verifiable, and every one of them is the result of nobody being responsible — which is exactly what a care plan is. It also finds a different business from the other hunts: one that already paid somebody once, which means the budget exists and the objection is about trust rather than money.",
    offer:
      "A care plan — updates, backups, certificates and monitoring, with the outstanding faults fixed on the way in.",
    qualifiers: [
      "!has-website — they have a website, so there is something to review.",
      "outdated-cms — the site runs on a version old enough to be a security problem.",
      "cms-version-exposed — the site publishes which version it runs, which is what a scanner looks for.",
      "no-https — it is served without HTTPS, so a browser warns about it.",
      "stale-site — nothing on the site has changed in a long time.",
      "one-host-only — everything they have sits on one host with nothing behind it.",
      "trading — there is real evidence of trade.",
    ],
    disqualifiers: [
      ...NEVER,
      "site-is-fine — nothing serious was found; their setup is in good order and there is nothing honest to sell them.",
    ],
    minScore: 45,
    leadsPerRun: 5,
    runTimes: ["10:15", "18:15"],
    routePriority: 2,
    routeAgentKey: "lead.orchestrator",
    source: {
      name: "Hunt · unmaintained site",
      actorId: "compass/crawler-google-places",
      preset: "GOOGLE_MAPS",
      leadSource: "GOOGLE_MAPS",
      groupName: "Hunt · unmaintained site",
      maxItems: 20,
      minScore: 20,
      input: {
        searchStringsArray: [
          "private school",
          "church",
          "ngo",
          "hotel",
          "clinic",
          "law firm",
          "microfinance company",
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
const SEED_REVISION = 2;

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
