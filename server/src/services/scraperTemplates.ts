import type { LeadSource, ScraperPreset } from "@prisma/client";

/**
 * One-click starting points for the Lead Sources screen. Any Apify actor can
 * be added by searching the store, but these are the three shapes that
 * actually match how Dakyworld sells — local businesses on Google Maps, the
 * same list enriched with emails, and a contact sweep over a list of sites —
 * pre-filled so a working source is a name change away.
 */

export interface ScraperTemplate {
  id: string;
  name: string;
  actorId: string;
  headline: string;
  description: string;
  preset: ScraperPreset;
  leadSource: LeadSource;
  groupName: string;
  maxItems: number;
  minScore: number;
  input: Record<string, unknown>;
  /** Which input keys the Owner should edit first, highlighted in the UI. */
  editFirst: string[];
}

export const SCRAPER_TEMPLATES: ScraperTemplate[] = [
  {
    id: "google-maps-no-website",
    name: "Google Maps — businesses with no website",
    actorId: "compass/crawler-google-places",
    headline: "The strongest fit for Dakyworld",
    description:
      "Local businesses on Google Maps that have a phone and reviews but no website at all. These are the prospects with the shortest path to a build.",
    preset: "GOOGLE_MAPS",
    leadSource: "GOOGLE_MAPS",
    groupName: "No website — {{date}}",
    maxItems: 100,
    minScore: 30,
    editFirst: ["searchStringsArray", "locationQuery"],
    input: {
      searchStringsArray: ["restaurant", "dental clinic", "law firm", "real estate agency"],
      locationQuery: "Accra, Ghana",
      maxCrawledPlacesPerSearch: 25,
      language: "en",
      website: "withoutWebsite",
      skipClosedPlaces: true,
    },
  },
  {
    id: "google-maps-contacts",
    name: "Google Maps + emails",
    actorId: "lukaskrivka/google-maps-with-contact-details",
    headline: "Best coverage of email addresses",
    description:
      "Google Maps results, then each business's website is crawled for an email address and social profiles. Slower and costs more per result, but it lands leads you can actually email.",
    preset: "GOOGLE_MAPS",
    leadSource: "GOOGLE_MAPS",
    groupName: "Maps + email — {{date}}",
    maxItems: 100,
    minScore: 40,
    editFirst: ["searchStringsArray", "locationQuery"],
    input: {
      searchStringsArray: ["marketing agency", "private school", "hotel"],
      locationQuery: "Accra, Ghana",
      maxCrawledPlacesPerSearch: 25,
      language: "en",
      skipClosedPlaces: true,
      maxReviews: 0,
      maxImages: 0,
    },
  },
  {
    id: "contact-details",
    name: "Contact details from a list of sites",
    actorId: "vdrmota/contact-info-scraper",
    headline: "For directories and shortlists you already have",
    description:
      "Give it a set of URLs — a directory page, an association's member list, a competitor's client page — and it pulls emails, phone numbers and social links from each.",
    preset: "GENERIC_CONTACT",
    leadSource: "WEB_SCRAPE",
    groupName: "Contact sweep — {{date}}",
    maxItems: 200,
    minScore: 35,
    editFirst: ["startUrls"],
    input: {
      startUrls: [{ url: "https://example.com/members" }],
      maxRequestsPerStartUrl: 50,
      maxDepth: 2,
      considerChildFrames: true,
    },
  },
];

export function findTemplate(id: string): ScraperTemplate | undefined {
  return SCRAPER_TEMPLATES.find((template) => template.id === id);
}
