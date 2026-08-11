import type { LeadSource, ScraperPreset } from "@prisma/client";

/**
 * One-click starting points for the Lead Sources screen.
 *
 * Any Apify actor can be added by searching the store; these are pre-filled for
 * the way Dakyworld actually sells — an outsourced IT department for
 * established businesses in Ghana and West Africa, bought first as a one-off
 * project (usually a website build) and then grown into a retainer.
 *
 * Two things follow from that and shape every template below:
 *
 * 1. **A missing or amateur website is the buying signal.** The scoring in
 *    services/leadMapping.ts already rewards no-website and page-builder
 *    domains, so the searches lean the same way. `website: "withoutWebsite"`
 *    on the Maps actor makes that a hard filter rather than a preference.
 * 2. **Ghana first, Kumasi and Accra first of all** — Dakyworld is Kumasi-based
 *    and delivers 100% remotely, so location is about who's reachable and
 *    referenceable, not who's nearby.
 *
 * The segments are the ones already in the pipeline by hand — property
 * developers, schools, banks, professional services, manufacturers, government
 * agencies — plus the two that map to the newer Branding and Training &
 * Consulting lines.
 *
 * Every `input` below is written against the actor's published input schema:
 * an undeclared key isn't an error, it's silently dropped, so a template that
 * *looks* like it caps reviews may not be doing it. `{{location}}` is filled
 * from Settings → Lead capture at run time, so moving the market moves every
 * template with it.
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

/**
 * The main market comes from Settings → Lead capture, so it can be widened
 * without editing code. Kumasi is written out because that template is
 * specifically about being local, not about wherever the market is set to.
 */
const MARKET = "{{location}}";
const ASHANTI = "Kumasi, Ghana";

export const SCRAPER_TEMPLATES: ScraperTemplate[] = [
  {
    id: "google-maps-no-website",
    name: "No website at all — Accra",
    actorId: "compass/crawler-google-places",
    headline: "The shortest path to a build",
    description:
      "Established businesses on Google Maps with a phone and real reviews but no website whatsoever. Nothing to argue with on the call: they're trading, people are reviewing them, and there's nowhere to send a customer.",
    preset: "GOOGLE_MAPS",
    leadSource: "GOOGLE_MAPS",
    groupName: "No website · Accra · {{date}}",
    maxItems: 120,
    minScore: 30,
    editFirst: ["searchStringsArray", "locationQuery"],
    input: {
      searchStringsArray: [
        "real estate agency",
        "law firm",
        "accounting firm",
        "private school",
        "dental clinic",
        "construction company",
        "logistics company",
        "printing press",
      ],
      locationQuery: MARKET,
      maxCrawledPlacesPerSearch: 20,
      language: "en",
      website: "withoutWebsite",
      skipClosedPlaces: true,
      maxReviews: 0,
      maxImages: 0,
    },
  },
  {
    id: "google-maps-no-website-kumasi",
    name: "No website at all — Kumasi & Ashanti",
    actorId: "compass/crawler-google-places",
    headline: "Home ground — easiest meetings to get",
    description:
      "The same search on Dakyworld's own doorstep. Being local is worth a lot on a first call even when the work itself is delivered remotely, and Ashanti is under-served compared with Accra.",
    preset: "GOOGLE_MAPS",
    leadSource: "GOOGLE_MAPS",
    groupName: "No website · Kumasi · {{date}}",
    maxItems: 120,
    minScore: 25,
    editFirst: ["searchStringsArray", "locationQuery"],
    input: {
      searchStringsArray: [
        "real estate agency",
        "private school",
        "law firm",
        "hospital",
        "hotel",
        "manufacturing company",
        "wholesale distributor",
      ],
      locationQuery: ASHANTI,
      maxCrawledPlacesPerSearch: 20,
      language: "en",
      website: "withoutWebsite",
      skipClosedPlaces: true,
      maxReviews: 0,
      maxImages: 0,
    },
  },
  {
    id: "property-developers",
    name: "Property developers & estate agencies",
    actorId: "lukaskrivka/google-maps-with-contact-details",
    headline: "Already the biggest segment in the pipeline",
    description:
      "Developers, estate agents and property managers, with emails pulled from whatever site they do have. They sell high-value units off a listing page, so the site *is* the sales floor — and most of them are running one built by a nephew in 2019.",
    preset: "GOOGLE_MAPS",
    leadSource: "GOOGLE_MAPS",
    groupName: "Property · {{date}}",
    maxItems: 120,
    minScore: 40,
    editFirst: ["searchStringsArray", "locationQuery"],
    input: {
      searchStringsArray: [
        "real estate developer",
        "estate agency",
        "property management company",
        "land sales company",
        "serviced apartments",
      ],
      locationQuery: MARKET,
      maxCrawledPlacesPerSearch: 24,
      language: "en",
      skipClosedPlaces: true,
    },
  },
  {
    id: "schools-training",
    name: "Schools, colleges & training institutes",
    actorId: "lukaskrivka/google-maps-with-contact-details",
    headline: "Buys websites, then buys training",
    description:
      "Private schools, colleges and vocational institutes. They need a site parents can find and a workspace that doesn't lose records — and they're the natural buyers of the staff digital-skills and AI-adoption workshops, which is a second sale to the same relationship.",
    preset: "GOOGLE_MAPS",
    leadSource: "GOOGLE_MAPS",
    groupName: "Education · {{date}}",
    maxItems: 100,
    minScore: 35,
    editFirst: ["searchStringsArray", "locationQuery"],
    input: {
      searchStringsArray: [
        "private school",
        "international school",
        "vocational training institute",
        "college",
        "training centre",
      ],
      locationQuery: MARKET,
      maxCrawledPlacesPerSearch: 20,
      language: "en",
      skipClosedPlaces: true,
    },
  },
  {
    id: "professional-services",
    name: "Law, audit & consulting firms",
    actorId: "lukaskrivka/google-maps-with-contact-details",
    headline: "Where security and email actually sell",
    description:
      "Firms holding client money or client secrets. The website matters less to them than the rest of the offer — proper email and workspace, backups, breach response — which makes them retainer-shaped from the first conversation rather than project-shaped.",
    preset: "GOOGLE_MAPS",
    leadSource: "GOOGLE_MAPS",
    groupName: "Professional services · {{date}}",
    maxItems: 100,
    minScore: 45,
    editFirst: ["searchStringsArray", "locationQuery"],
    input: {
      searchStringsArray: [
        "law firm",
        "audit firm",
        "accounting firm",
        "management consulting",
        "insurance brokerage",
        "recruitment agency",
      ],
      locationQuery: MARKET,
      maxCrawledPlacesPerSearch: 20,
      language: "en",
      skipClosedPlaces: true,
    },
  },
  {
    id: "manufacturers-distributors",
    name: "Manufacturers, distributors & wholesalers",
    actorId: "lukaskrivka/google-maps-with-contact-details",
    headline: "The automation and integrations buyers",
    description:
      "Businesses running on spreadsheets, WhatsApp and a stack of delivery notes. They rarely want a prettier website — they want the manual burden cut, which is the automation and integrations line, and the one with the clearest number attached to it.",
    preset: "GOOGLE_MAPS",
    leadSource: "GOOGLE_MAPS",
    groupName: "Manufacturing & distribution · {{date}}",
    maxItems: 100,
    minScore: 40,
    editFirst: ["searchStringsArray", "locationQuery"],
    input: {
      searchStringsArray: [
        "manufacturing company",
        "food processing company",
        "wholesale distributor",
        "packaging company",
        "importer and distributor",
        "logistics company",
      ],
      locationQuery: MARKET,
      maxCrawledPlacesPerSearch: 20,
      language: "en",
      skipClosedPlaces: true,
    },
  },
  {
    id: "clinics-health",
    name: "Clinics, hospitals & diagnostic centres",
    actorId: "lukaskrivka/google-maps-with-contact-details",
    headline: "Patient records make security an easy conversation",
    description:
      "Private clinics, dental practices, labs and diagnostic centres. Booking and records are the pain, and the duty of care around patient data turns backups and access control from a nice-to-have into something they can be held to.",
    preset: "GOOGLE_MAPS",
    leadSource: "GOOGLE_MAPS",
    groupName: "Healthcare · {{date}}",
    maxItems: 100,
    minScore: 40,
    editFirst: ["searchStringsArray", "locationQuery"],
    input: {
      searchStringsArray: ["private clinic", "dental clinic", "diagnostic centre", "medical laboratory", "eye clinic", "pharmacy chain"],
      locationQuery: MARKET,
      maxCrawledPlacesPerSearch: 20,
      language: "en",
      skipClosedPlaces: true,
    },
  },
  {
    id: "ngos-associations",
    name: "NGOs, churches & associations",
    actorId: "lukaskrivka/google-maps-with-contact-details",
    headline: "Branding and one-off builds, often donor-funded",
    description:
      "Organisations that answer to a board or a donor, so a real website and a coherent identity are reporting requirements as much as marketing. Budgets are smaller and slower, but the work is well-defined and the referrals travel.",
    preset: "GOOGLE_MAPS",
    leadSource: "GOOGLE_MAPS",
    groupName: "NGOs & associations · {{date}}",
    maxItems: 100,
    minScore: 30,
    editFirst: ["searchStringsArray", "locationQuery"],
    input: {
      searchStringsArray: ["non-governmental organisation", "charity", "church", "trade association", "cooperative society"],
      locationQuery: MARKET,
      maxCrawledPlacesPerSearch: 20,
      language: "en",
      skipClosedPlaces: true,
    },
  },
  {
    id: "hospitality-retail",
    name: "Hotels, restaurants & retail",
    actorId: "compass/crawler-google-places",
    headline: "High volume, fast decisions, smaller tickets",
    description:
      "Hotels, guesthouses, restaurants and retail with a strong review count but no site — they live on Instagram and a phone number. Lower value per client and quicker to close, useful for filling a slow month rather than building the base.",
    preset: "GOOGLE_MAPS",
    leadSource: "GOOGLE_MAPS",
    groupName: "Hospitality & retail · {{date}}",
    maxItems: 150,
    minScore: 25,
    editFirst: ["searchStringsArray", "locationQuery"],
    input: {
      searchStringsArray: ["hotel", "guest house", "restaurant", "event venue", "boutique", "furniture store"],
      locationQuery: MARKET,
      maxCrawledPlacesPerSearch: 25,
      language: "en",
      website: "withoutWebsite",
      skipClosedPlaces: true,
      maxReviews: 0,
      maxImages: 0,
    },
  },
  {
    id: "google-maps-contacts",
    name: "Any segment, with email addresses",
    actorId: "lukaskrivka/google-maps-with-contact-details",
    headline: "The generic shape — edit the searches",
    description:
      "Google Maps results, then each business's own site crawled for an email and social profiles. Slower and dearer per result than plain Maps, but it lands leads you can actually write to rather than only ring.",
    preset: "GOOGLE_MAPS",
    leadSource: "GOOGLE_MAPS",
    groupName: "Maps + email · {{date}}",
    maxItems: 100,
    minScore: 40,
    editFirst: ["searchStringsArray", "locationQuery"],
    input: {
      searchStringsArray: ["marketing agency", "private school", "hotel"],
      locationQuery: MARKET,
      maxCrawledPlacesPerSearch: 25,
      language: "en",
      skipClosedPlaces: true,
    },
  },
  {
    id: "contact-details",
    name: "Contact details from a list of sites",
    actorId: "vdrmota/contact-info-scraper",
    headline: "For directories and shortlists you already have",
    description:
      "Give it a set of URLs — an association's member list, a chamber of commerce directory, a conference's exhibitor page — and it pulls emails, phone numbers and social links from each. The best-quality lists usually start here rather than on Maps.",
    preset: "GENERIC_CONTACT",
    leadSource: "WEB_SCRAPE",
    groupName: "Contact sweep · {{date}}",
    maxItems: 200,
    minScore: 35,
    editFirst: ["startUrls"],
    input: {
      startUrls: [{ url: "https://example.com/members" }],
      maxRequestsPerStartUrl: 50,
      maxDepth: 2,
      considerChildFrames: true,
      // This actor *requires* a proxy — a run without one is rejected before
      // it starts. Delete this key to have the proxy from Settings → Lead
      // capture filled in instead.
      proxyConfig: { useApifyProxy: true },
    },
  },
];

export function findTemplate(id: string): ScraperTemplate | undefined {
  return SCRAPER_TEMPLATES.find((template) => template.id === id);
}
