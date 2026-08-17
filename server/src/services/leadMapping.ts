/**
 * Turns an arbitrary Apify dataset row into a Lead.
 *
 * Every actor names its fields differently — Google Maps scrapers emit
 * `title`/`totalScore`/`placeId`, contact scrapers emit `name`/`emails[]`, a
 * LinkedIn scraper emits something else again. Rather than requiring the Owner
 * to write a mapping for each one, each lead field has a list of candidate
 * paths tried in order, with an optional per-source `fieldMap` taking
 * precedence when an actor does something genuinely unusual.
 */

export type Preset = "AUTO" | "GOOGLE_MAPS" | "GENERIC_CONTACT" | "CUSTOM";

export interface NormalizedLead {
  contactName: string;
  companyName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  website: string | null;
  address: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  category: string | null;
  rating: number | null;
  reviewsCount: number | null;
  latitude: number | null;
  longitude: number | null;
  socialLinks: Record<string, string> | null;
  externalId: string | null;
  discoveryNotes: string | null;
  tags: string[];
  /** Permanently/temporarily closed businesses are not prospects. */
  closed: boolean;
}

// --- Path resolution -------------------------------------------------------

/** Reads `a.b[0].c` out of a parsed JSON item. A bare array yields its first entry. */
function readPath(item: unknown, path: string): unknown {
  const segments = path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean);

  let current: any = item;
  for (const segment of segments) {
    if (current == null) return undefined;
    if (Array.isArray(current) && !/^\d+$/.test(segment)) current = current[0];
    if (current == null) return undefined;
    current = current[segment];
  }
  if (Array.isArray(current)) current = current.find((entry) => entry != null);
  return current;
}

function firstString(item: unknown, paths: string[]): string | null {
  for (const path of paths) {
    const value = readPath(item, path);
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return null;
}

function firstNumber(item: unknown, paths: string[]): number | null {
  for (const path of paths) {
    const value = readPath(item, path);
    const parsed = typeof value === "string" ? Number(value.replace(/[^\d.-]/g, "")) : value;
    if (typeof parsed === "number" && Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function firstBoolean(item: unknown, paths: string[]): boolean {
  for (const path of paths) {
    const value = readPath(item, path);
    if (value === true) return true;
    if (typeof value === "string" && /^(true|yes|closed_permanently|closed_temporarily)$/i.test(value.trim())) return true;
  }
  return false;
}

// --- Candidate paths -------------------------------------------------------

const NAME_PATHS = ["title", "name", "businessName", "companyName", "company", "fullName", "organization", "displayName"];
const EMAIL_PATHS = [
  "email",
  "emails",
  "contactDetails.emails",
  "contact.email",
  "contacts.email",
  "emailAddress",
  "publicEmail",
];
const PHONE_PATHS = [
  "phone",
  "phoneUnformatted",
  "phones",
  "contactDetails.phones",
  "contact.phone",
  "telephone",
  "phoneNumber",
  "mobile",
];
const WEBSITE_PATHS = ["website", "websiteUrl", "webSite", "site", "homepage", "domain", "companyWebsite"];
const ADDRESS_PATHS = ["address", "fullAddress", "formattedAddress", "street", "location.address", "addressLine1"];
const CITY_PATHS = ["city", "town", "locality", "address.city", "location.city"];
const REGION_PATHS = ["state", "region", "province", "county", "address.state"];
const COUNTRY_PATHS = ["country", "countryCode", "address.country", "location.country"];
const CATEGORY_PATHS = ["categoryName", "category", "categories", "type", "businessType", "industry", "sector"];
const RATING_PATHS = ["totalScore", "rating", "stars", "score", "reviewsAverage", "averageRating"];
const REVIEWS_PATHS = ["reviewsCount", "userRatingsTotal", "reviewCount", "numberOfReviews", "totalReviews", "reviews"];
const LAT_PATHS = ["location.lat", "location.latitude", "latitude", "lat", "coordinates.lat", "geo.latitude"];
const LNG_PATHS = ["location.lng", "location.longitude", "longitude", "lng", "lon", "coordinates.lng", "geo.longitude"];
const NOTES_PATHS = ["description", "about", "summary", "snippet", "bio", "headline"];
const CLOSED_PATHS = ["permanentlyClosed", "temporarilyClosed", "isClosed", "closed", "businessStatus"];

const SOCIAL_PATHS: Record<string, string[]> = {
  facebook: ["facebooks", "facebook", "socialLinks.facebook", "contactDetails.facebooks"],
  instagram: ["instagrams", "instagram", "socialLinks.instagram", "contactDetails.instagrams"],
  linkedin: ["linkedIns", "linkedin", "linkedIn", "socialLinks.linkedin", "contactDetails.linkedIns"],
  twitter: ["twitters", "twitter", "socialLinks.twitter", "contactDetails.twitters"],
  youtube: ["youtubes", "youtube", "socialLinks.youtube"],
  tiktok: ["tiktoks", "tiktok"],
};

/**
 * Google Maps rows carry `url` as the *Maps listing* URL, not the business's
 * own site, so the generic WEBSITE_PATHS must not see it. Handled by putting
 * the preset's paths first and never adding `url` to the shared list.
 */
const PRESET_PATHS: Record<Exclude<Preset, "AUTO" | "CUSTOM">, Partial<Record<keyof NormalizedLead, string[]>>> = {
  GOOGLE_MAPS: {
    contactName: ["title"],
    website: ["website"],
    contactPhone: ["phone", "phoneUnformatted"],
    category: ["categoryName", "categories"],
    externalId: ["placeId", "place_id", "cid", "fid"],
    address: ["address", "street"],
    rating: ["totalScore"],
    reviewsCount: ["reviewsCount"],
  },
  GENERIC_CONTACT: {
    contactName: ["name", "title", "fullName"],
    website: ["website", "url", "link", "domain"],
    externalId: ["url", "link", "profileUrl", "id"],
  },
};

// --- Value cleaning --------------------------------------------------------

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
// Addresses that exist to receive nothing. Sending a proposal here is wasted effort.
const ROLE_EMAIL_NOISE = /^(no-?reply|do-?not-?reply|postmaster|abuse|privacy|unsubscribe)@/i;

function cleanEmail(value: string | null): string | null {
  if (!value) return null;
  const email = value.trim().toLowerCase().replace(/^mailto:/, "").split("?")[0];
  if (!EMAIL_PATTERN.test(email) || ROLE_EMAIL_NOISE.test(email)) return null;
  return email;
}

function cleanPhone(value: string | null): string | null {
  if (!value) return null;
  const phone = value.trim().replace(/^tel:/, "");
  // Fewer than 7 digits isn't a dialable number — usually a scraped price or id.
  return phone.replace(/\D/g, "").length >= 7 ? phone : null;
}

export function cleanWebsite(value: string | null): string | null {
  if (!value) return null;
  let url = value.trim();
  if (!url || /^(n\/?a|none|null)$/i.test(url)) return null;
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.includes(".")) return null;
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

/** The registrable-ish host, used for de-duplication. */
export function websiteDomain(website: string | null): string | null {
  if (!website) return null;
  try {
    return new URL(website).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return null;
  }
}

/**
 * "ghacem.com" -> "Ghacem". The first label is the business; everything after
 * it is the registry (.com, .com.gh, .org). Good enough to work the lead and
 * far better than dropping it — the Owner renames the handful that come out
 * odd, which is a minute's work against a scrape that returned nothing.
 */
function nameFromDomain(domain: string | null): string | null {
  if (!domain) return null;
  const label = domain.split(".")[0]?.replace(/[-_]+/g, " ").trim();
  if (!label || label.length < 2) return null;
  return label
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function clamp(value: number | null, min: number, max: number): number | null {
  if (value == null) return null;
  return value < min || value > max ? null : value;
}

// --- Mapping ---------------------------------------------------------------

export interface MappingOptions {
  preset?: Preset;
  /** Owner overrides: lead field -> dot path into the item. Highest precedence. */
  fieldMap?: Record<string, string> | null;
}

/** True when the row looks like a Google Maps place, used to resolve preset AUTO. */
function looksLikeGoogleMaps(item: Record<string, unknown>): boolean {
  return "placeId" in item || "categoryName" in item || ("totalScore" in item && "reviewsCount" in item);
}

export function resolvePreset(preset: Preset, item: Record<string, unknown>): Preset {
  if (preset !== "AUTO") return preset;
  return looksLikeGoogleMaps(item) ? "GOOGLE_MAPS" : "GENERIC_CONTACT";
}

export function mapItemToLead(item: Record<string, unknown>, options: MappingOptions = {}): NormalizedLead | null {
  const preset = resolvePreset(options.preset ?? "AUTO", item);
  const overrides = options.fieldMap ?? {};

  // Owner override → preset paths → shared candidates.
  const paths = (field: keyof NormalizedLead, shared: string[]): string[] => {
    const custom = overrides[field as string];
    const presetPaths = preset === "CUSTOM" ? [] : (PRESET_PATHS[preset as "GOOGLE_MAPS" | "GENERIC_CONTACT"]?.[field] ?? []);
    return [...(custom ? [custom] : []), ...presetPaths, ...(preset === "CUSTOM" ? [] : shared)];
  };

  const website = cleanWebsite(firstString(item, paths("website", WEBSITE_PATHS)));

  let name = firstString(item, paths("contactName", NAME_PATHS));
  // A contact sweep returns a page, not a person. vdrmota/contact-info-scraper
  // declares exactly these fields — url, domain, emails, phones, and a social
  // link per network — and not one of them is a name, so every row it produced
  // used to fail the check below and vanish without a trace. The domain is the
  // row's natural label, so use it rather than throwing the lead away.
  if (!name) name = nameFromDomain(websiteDomain(website));
  // No name and nothing to derive one from — a row we can't even label isn't
  // worth a pipeline slot.
  if (!name) return null;

  const socialLinks: Record<string, string> = {};
  for (const [network, candidates] of Object.entries(SOCIAL_PATHS)) {
    const link = firstString(item, candidates);
    if (link && /^https?:\/\//i.test(link)) socialLinks[network] = link;
  }

  const category = firstString(item, paths("category", CATEGORY_PATHS));

  return {
    contactName: name,
    companyName: firstString(item, ["companyName", "company", "businessName"]) ?? name,
    contactEmail: cleanEmail(firstString(item, paths("contactEmail", EMAIL_PATHS))),
    contactPhone: cleanPhone(firstString(item, paths("contactPhone", PHONE_PATHS))),
    website,
    address: firstString(item, paths("address", ADDRESS_PATHS)),
    city: firstString(item, paths("city", CITY_PATHS)),
    region: firstString(item, paths("region", REGION_PATHS)),
    country: firstString(item, paths("country", COUNTRY_PATHS)),
    category,
    rating: clamp(firstNumber(item, paths("rating", RATING_PATHS)), 0, 5),
    reviewsCount: firstNumber(item, paths("reviewsCount", REVIEWS_PATHS)),
    latitude: clamp(firstNumber(item, paths("latitude", LAT_PATHS)), -90, 90),
    longitude: clamp(firstNumber(item, paths("longitude", LNG_PATHS)), -180, 180),
    socialLinks: Object.keys(socialLinks).length ? socialLinks : null,
    externalId: firstString(item, paths("externalId", ["placeId", "id", "url", "link", "profileUrl"])),
    discoveryNotes: firstString(item, paths("discoveryNotes", NOTES_PATHS))?.slice(0, 2000) ?? null,
    tags: category ? [category.toLowerCase()] : [],
    closed: firstBoolean(item, CLOSED_PATHS),
  };
}

// --- Scoring ---------------------------------------------------------------

/**
 * 0-100, weighted towards "can I actually contact this business, and does it
 * look like it has money to spend". Reachability dominates: a five-star
 * restaurant with no email, phone or site is not a lead you can work.
 */
export function scoreLead(lead: NormalizedLead): number {
  let score = 20;

  if (lead.contactEmail) score += 25;
  if (lead.contactPhone) score += 15;

  if (lead.website) {
    // A business already online is easier to sell a rebuild or care plan to.
    score += 15;
    const domain = websiteDomain(lead.website);
    // A free page-builder or social page instead of a real domain is the
    // strongest buying signal Dakyworld has: they need a proper site.
    if (domain && /(wixsite|weebly|blogspot|wordpress\.com|business\.site|godaddysites|squarespace\.com)$/i.test(domain)) {
      score += 10;
    }
  } else if (lead.socialLinks) {
    // Social presence but no website at all — same signal, one step earlier.
    score += 12;
  }

  if (lead.reviewsCount != null) {
    if (lead.reviewsCount >= 100) score += 10;
    else if (lead.reviewsCount >= 25) score += 7;
    else if (lead.reviewsCount >= 5) score += 4;
  }

  if (lead.rating != null && lead.rating >= 4) score += 5;
  if (lead.address || lead.city) score += 3;

  return Math.max(0, Math.min(100, score));
}

// --- De-duplication --------------------------------------------------------

function slug(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\da-z]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * A stable identity for a scraped business, in falling order of trust. Stored
 * unique on Lead, so the same place found by two actors — or by the same actor
 * next week — updates one record instead of cluttering the pipeline.
 */
export function buildDedupeKey(lead: NormalizedLead): string | null {
  if (lead.externalId && /^(ChI|0x|place)/i.test(lead.externalId)) return `place:${lead.externalId}`;

  const domain = websiteDomain(lead.website);
  if (domain) return `domain:${domain}`;
  if (lead.contactEmail) return `email:${lead.contactEmail}`;

  const digits = lead.contactPhone?.replace(/\D/g, "");
  if (digits && digits.length >= 9) return `phone:${digits.slice(-9)}`;

  const name = slug(lead.contactName);
  if (!name) return null;
  return `name:${name}${lead.city ? `:${slug(lead.city)}` : ""}`;
}
