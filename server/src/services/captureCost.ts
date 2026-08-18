import { getActorPricing, type ApifyPricing } from "../lib/apify.js";

/**
 * What a capture will cost, before it runs.
 *
 * Every actor this app uses is pay-per-event, and the events are not the same
 * shape as the results: a Google Maps run is billed per place *plus* a
 * separate charge for every filter applied to every place, plus another for
 * contact enrichment, plus another per review and per image. So "100 places"
 * can be anywhere between $0.40 and $4.00 depending only on which switches are
 * on in the input JSON — and nothing in the app said so before the bill.
 *
 * The prices come from Apify at run time (lib/apify.getActorPricing); this
 * file is only the arithmetic that turns an input into a count of events. Two
 * things fall out of it:
 *
 * - **An estimate the Owner sees before spending.** Shown by quick capture and
 *   by the source editor.
 * - **A ceiling when none was set.** `suggestedCharge()` gives the runner a
 *   `maxTotalChargeUsd` derived from the estimate, so a bad search string
 *   stops at roughly twice what it should have cost instead of running until
 *   the month's budget is gone.
 *
 * Add-ons whose data this pipeline never reads are called out by name, because
 * the expensive mistakes are all of that shape: `maxReviews: 10` on a Maps
 * source costs $0.005 per review for rows nothing ever looks at.
 */

export interface CostLine {
  label: string;
  unitUsd: number;
  units: number;
  totalUsd: number;
  /** An optional extra switched on by the input, rather than the base charge. */
  addOn: boolean;
}

export interface CostEstimate {
  actorId: string;
  model: string;
  /** Null when the actor's pricing could not be read. */
  totalUsd: number | null;
  /** What each captured business works out at, all charges included. */
  perResultUsd: number | null;
  /** How many results this input is expected to produce. */
  results: number;
  /** The lowest per-run ceiling Apify will accept for this actor, when it sets one. */
  minChargeUsd: number | null;
  lines: CostLine[];
  /** Paid switches that are on and buy nothing this app reads. */
  waste: string[];
  /** Where the number is approximate, said plainly. */
  caveats: string[];
}

type Input = Record<string, unknown>;

const num = (value: unknown, fallback = 0): number => {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : fallback;
};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const on = (value: unknown): boolean => value === true;

/**
 * How many results the input asks for. Actors cap themselves from their own
 * input rather than from `maxItems` — which pay-per-event ignores — so this
 * reads the same keys the actor does.
 */
export function expectedResults(input: Input, maxItems: number): number {
  const searches = list(input.searchStringsArray).length + list(input.startUrls).length + list(input.placeIds).length;
  const perSearch = num(input.maxCrawledPlacesPerSearch, 0);
  if (searches > 0 && perSearch > 0) return Math.min(searches * perSearch, maxItems || Infinity);

  const targets =
    list(input.usernames).length ||
    list(input.companies).length ||
    list(input.searches).length ||
    list(input.startUrls).length ||
    list(input.searchStringsArray).length;
  if (targets > 0) return targets;

  return maxItems || 1;
}

/** Pages the website sweep will open, which is what it bills on rather than results. */
function expectedPages(input: Input): number {
  const starts = Math.max(1, list(input.startUrls).length);
  const perStart = num(input.maxRequestsPerStartUrl, 20);
  const overall = num(input.maxRequests, 0);
  const pages = starts * Math.max(1, perStart);
  return overall > 0 ? Math.min(pages, overall) : pages;
}

/** How many billable filters a Google Maps input has switched on. */
function filterCount(input: Input): number {
  let count = 0;
  if (list(input.categoryFilterWords).length) count += 1;
  if (typeof input.searchMatching === "string" && input.searchMatching !== "all") count += 1;
  if (typeof input.placeMinimumStars === "string" && input.placeMinimumStars !== "") count += 1;
  if (typeof input.website === "string" && input.website !== "allPlaces") count += 1;
  if (on(input.skipClosedPlaces)) count += 1;
  return count;
}

/**
 * How many times each charged event fires, per event key. Keyed by Apify's own
 * event names, which are shared across the actors from the same vendors, so
 * one table covers the Maps scrapers and the contact sweep alike.
 */
const UNITS: Record<string, (input: Input, results: number) => number> = {
  "apify-actor-start": () => 1,
  "actor-start-gb": (input) => Math.max(1, num(input.memoryMbytes, 4096) / 1024),

  // One per result, under the name each vendor gave it.
  "place-scraped": (_input, results) => results,
  "apify-default-dataset-item": (_input, results) => results,
  profile: (_input, results) => results,

  // Google Maps add-ons.
  "filter-applied": (input, results) => results * filterCount(input),
  "place-details-scraped": (input, results) =>
    on(input.scrapePlaceDetailPage) ||
    on(input.scrapeTableReservationProvider) ||
    on(input.scrapeOrderOnline) ||
    on(input.includeWebResults) ||
    num(input.maxQuestions) > 0
      ? results
      : 0,
  "contact-details-scraped": (input, results) => (on(input.scrapeContacts) ? results : 0),
  "social-profile-scraped": (input, results) =>
    Object.values((input.scrapeSocialMediaProfiles as Record<string, unknown>) ?? {}).some(on) ? results : 0,
  "lead-scraped": (input, results) => results * num(input.maximumLeadsEnrichmentRecords),
  "lead-email-verified": (input, results) =>
    on(input.verifyLeadsEnrichmentEmails) ? results * num(input.maximumLeadsEnrichmentRecords) : 0,
  "review-scraped": (input, results) => results * num(input.maxReviews),
  "image-scraped": (input, results) => results * num(input.maxImages),
  "competitor-analyzed": (input, results) =>
    on(input.enableCompetitorAnalysis) ? results * num(input.maxCompetitorsToAnalyze, 30) : 0,

  // Instagram.
  "about-account": (input, results) => (on(input.includeAboutSection) ? results : 0),

  // The website contact sweep bills per page opened, not per business found.
  "pages-scraped": (input) => expectedPages(input),
  "page-with-browser": (input) => (on(input.useBrowser) ? expectedPages(input) : 0),
  "page-wait-event": (input) =>
    typeof input.waitUntil === "string" && !["domcontentloaded", "load"].includes(input.waitUntil) ? expectedPages(input) : 0,
  "page-with-residential-proxy": (input) => {
    const proxy = (input.proxyConfig ?? input.proxyConfiguration) as Record<string, unknown> | undefined;
    return list(proxy?.apifyProxyGroups).includes("RESIDENTIAL") ? expectedPages(input) : 0;
  },
};

/**
 * Add-ons that some actors bake in rather than offer as a switch.
 *
 * `lukaskrivka/google-maps-with-contact-details` charges
 * `contact-details-scraped` on every place and publishes no `scrapeContacts`
 * input to turn it off — enrichment *is* the actor. Reading the switch alone
 * would price that run 36% under what it bills, so an add-on whose switch the
 * actor doesn't declare is treated as always on.
 */
const ALWAYS_ON_WITHOUT: Record<string, string> = {
  "contact-details-scraped": "scrapeContacts",
  "social-profile-scraped": "scrapeSocialMediaProfiles",
  "about-account": "includeAboutSection",
};

/** Add-ons that charge for data nothing downstream of the mapper ever reads. */
const WASTE: Array<{ event: string; when: (input: Input) => boolean; say: (unit: number) => string }> = [
  {
    event: "review-scraped",
    when: (input) => num(input.maxReviews) > 0,
    say: (unit) => `Review text is charged at $${unit} each and nothing in the app reads it — only the review *count*, which is free. Set maxReviews to 0.`,
  },
  {
    event: "image-scraped",
    when: (input) => num(input.maxImages) > 0,
    say: (unit) => `Images cost $${unit} each and are never used. Set maxImages to 0.`,
  },
  {
    event: "about-account",
    when: (input) => on(input.includeAboutSection),
    say: (unit) =>
      `“About this account” costs $${unit} per profile — more than the profile itself — and only adds the country and the date the account was created. Turn it off.`,
  },
  {
    event: "competitor-analyzed",
    when: (input) => on(input.enableCompetitorAnalysis),
    say: (unit) => `Competitor analysis is $${unit} per competitor per place and is not read anywhere. Turn it off.`,
  },
  {
    event: "place-details-scraped",
    when: (input) => on(input.scrapeTableReservationProvider) || on(input.scrapeOrderOnline) || on(input.includeWebResults),
    say: (unit) => `Table booking, order-online and web-results details cost $${unit} per place and are not mapped to any lead field.`,
  },
  {
    event: "page-with-browser",
    when: (input) => on(input.useBrowser),
    say: (unit) =>
      `Opening every page in a browser costs $${unit} extra per page. Contact details are in the HTML on nearly every site — leave it off unless a specific site needs it.`,
  },
];

/**
 * The estimate. `null` total when the actor's pricing can't be read, which is
 * shown as "couldn't price this" rather than as zero — a silent zero is how a
 * spending guard turns into a rubber stamp.
 */
export async function estimateCost(
  actorId: string,
  input: Input,
  maxItems: number,
  /** The actor's declared input keys, when known — see ALWAYS_ON_WITHOUT. */
  declaredKeys?: string[] | null,
): Promise<CostEstimate> {
  const pricing = await getActorPricing(actorId);
  const results = expectedResults(input, maxItems);
  const base: CostEstimate = {
    actorId,
    model: pricing?.model ?? "UNKNOWN",
    totalUsd: null,
    perResultUsd: null,
    results,
    minChargeUsd: pricing?.minChargeUsd ?? null,
    lines: [],
    waste: [],
    caveats: [],
  };
  if (!pricing) {
    base.caveats.push("Apify didn't return a price for this actor, so this run can't be costed in advance.");
    return base;
  }

  if (pricing.model === "PRICE_PER_DATASET_ITEM" && pricing.perResultUsd != null) {
    const total = pricing.perResultUsd * results;
    return {
      ...base,
      model: pricing.model,
      totalUsd: round(total),
      perResultUsd: pricing.perResultUsd,
      lines: [{ label: "Result", unitUsd: pricing.perResultUsd, units: results, totalUsd: round(total), addOn: false }],
    };
  }

  if (pricing.model === "FLAT_PRICE_PER_MONTH") {
    return {
      ...base,
      model: pricing.model,
      caveats: [`This actor is a $${pricing.perMonthUsd ?? "?"}/month subscription, not a per-run charge.`],
    };
  }

  if (pricing.model !== "PAY_PER_EVENT") {
    return { ...base, model: pricing.model, totalUsd: 0, perResultUsd: 0, caveats: ["This actor is free to run; you pay only for Apify platform usage."] };
  }

  const lines: CostLine[] = [];
  for (const event of pricing.events) {
    const bakedIn =
      declaredKeys != null && ALWAYS_ON_WITHOUT[event.key] != null && !declaredKeys.includes(ALWAYS_ON_WITHOUT[event.key]);
    const units = bakedIn ? results : (UNITS[event.key]?.(input, results) ?? 0);
    if (units <= 0 || event.priceUsd == null) continue;
    lines.push({
      label: event.title,
      unitUsd: event.priceUsd,
      units: Math.round(units),
      totalUsd: round(event.priceUsd * units),
      addOn: !event.primary && event.key !== "apify-actor-start",
    });
  }

  const total = lines.reduce((sum, line) => sum + line.totalUsd, 0);
  const waste = WASTE.filter((rule) => rule.when(input))
    .map((rule) => {
      const price = pricing.events.find((event) => event.key === rule.event)?.priceUsd;
      return price == null ? null : rule.say(price);
    })
    .filter((line): line is string => Boolean(line));

  const caveats: string[] = [`Priced at Apify's list rate; a busier account pays less per unit.`];
  if (lines.some((line) => line.label.toLowerCase().includes("page"))) {
    caveats.push("Charged per page opened, so a site with fewer pages than the cap costs less.");
  }
  if (UNITS["place-scraped"]?.(input, results) > 0) {
    caveats.push("Google Maps rarely returns the full number asked for, so this is a ceiling rather than a forecast.");
  }

  return {
    ...base,
    model: pricing.model,
    totalUsd: round(total),
    perResultUsd: results > 0 ? round(total / results) : null,
    lines,
    waste,
    caveats,
  };
}

/**
 * A per-run ceiling for an actor the Owner hasn't set one for. Twice the
 * estimate, never below Apify's own floor for the actor, and never above the
 * remaining monthly budget.
 *
 * Twice, rather than exactly: an estimate that binds too tightly aborts an
 * honest run half way, and a half-finished run has still been paid for. Twice
 * is loose enough to absorb a search returning more than expected and tight
 * enough that a runaway stops in dollars rather than in hundreds of them.
 */
export function suggestedCharge(estimate: CostEstimate, minChargeUsd: number | null): number | null {
  if (estimate.totalUsd == null || estimate.totalUsd <= 0) return null;
  const doubled = Math.ceil(estimate.totalUsd * 2 * 100) / 100;
  return Math.max(doubled, minChargeUsd ?? 0);
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/** Pricing lookup shared with the routes, so the UI can show rates per actor. */
export async function actorPricing(actorId: string): Promise<ApifyPricing | null> {
  return getActorPricing(actorId);
}
