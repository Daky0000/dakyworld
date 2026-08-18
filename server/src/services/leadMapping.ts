/**
 * Turns an arbitrary Apify dataset row into a Lead.
 *
 * Every actor names its fields differently — Google Maps scrapers emit
 * `title`/`totalScore`/`placeId`, contact scrapers emit `domain`/`emails[]`,
 * Instagram emits `username`/`externalUrl`, LinkedIn emits
 * `name`/`locations[]`. Rather than requiring the Owner to write a mapping for
 * each one, the row is **read for what it is**: `detectShape()` recognises the
 * five shapes this app actually captures, and each shape names the paths that
 * hold each lead field. A per-source `fieldMap` still wins over all of it.
 *
 * This used to guess from one shared list of candidate paths, with a `CUSTOM`
 * preset that switched the list off entirely. Three of the five quick-capture
 * actors are stored as CUSTOM, so every Instagram, Facebook and LinkedIn
 * capture mapped to nothing at all: the run charged, the dataset filled, and
 * the pipeline stayed empty because each row was dropped in turn for having
 * "no usable name". `CUSTOM` now means *the field map is tried first*, not
 * *nothing else is tried*, and a row that still cannot be read says which
 * shape it was read as and what was missing — see `MappedRow.reason`, which
 * the runner records against the run.
 */

export type Preset = "AUTO" | "GOOGLE_MAPS" | "GENERIC_CONTACT" | "CUSTOM";

/**
 * What a row actually is, worked out from its own keys. Deliberately separate
 * from `Preset`, which is the Owner's stored choice on a source: one source
 * set to AUTO can receive two shapes in a single dataset, and a source set to
 * CUSTOM still deserves to be read properly beyond the fields it names.
 */
export type Shape = "GOOGLE_MAPS" | "CONTACT_SWEEP" | "INSTAGRAM" | "FACEBOOK_PAGE" | "LINKEDIN_COMPANY" | "GENERIC";

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
  /**
   * A network-native identity — `instagram:kessbenhotel`, `facebook:1007…`,
   * `linkedin:kessben`. Used for de-duplication when the business has no
   * website and no email, which is exactly the case for a social capture.
   */
  externalKey: string | null;
}

/** The outcome of reading one row, including why nothing came of it. */
export interface MappedRow {
  shape: Shape;
  lead: NormalizedLead | null;
  /** Set when there is no lead. One sentence, meant to be read by the Owner. */
  reason: string | null;
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
  return current;
}

/**
 * Every string a set of paths could yield, in order — an array contributes all
 * of its entries, not only the first.
 *
 * This is the difference between reading `emails: ["noreply@x.com",
 * "sales@x.com"]` as "no email" and as "sales@x.com". Actors return contact
 * details as arrays with the noise at the front often enough that taking `[0]`
 * and then rejecting it threw away a usable address on every such row.
 */
function candidates(item: unknown, paths: string[]): string[] {
  const found: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === "string" && value.trim()) found.push(value.trim());
    else if (typeof value === "number" && Number.isFinite(value)) found.push(String(value));
  };

  for (const path of paths) {
    const value = readPath(item, path);
    if (Array.isArray(value)) {
      for (const entry of value) {
        // Arrays of objects: `externalUrls: [{ url }]`, `locations: [{ text }]`.
        if (entry && typeof entry === "object") push((entry as any).url ?? (entry as any).value ?? (entry as any).text);
        else push(entry);
      }
    } else {
      push(value);
    }
  }
  return found;
}

function firstString(item: unknown, paths: string[]): string | null {
  return candidates(item, paths)[0] ?? null;
}

/** The first candidate the cleaner accepts, rather than the first candidate. */
function firstClean(item: unknown, paths: string[], clean: (value: string) => string | null): string | null {
  for (const value of candidates(item, paths)) {
    const cleaned = clean(value);
    if (cleaned) return cleaned;
  }
  return null;
}

function firstNumber(item: unknown, paths: string[]): number | null {
  for (const path of paths) {
    const value = readPath(item, path);
    const raw = Array.isArray(value) ? value.find((entry) => entry != null) : value;
    const parsed = typeof raw === "string" ? Number(raw.replace(/[^\d.-]/g, "")) : raw;
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
  "businessEmail",
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
  "businessPhoneNumber",
  // Last, and only because a probable number beats no number at all on a lead
  // somebody was going to ring anyway.
  "phonesUncertain",
];
const WEBSITE_PATHS = ["website", "websiteUrl", "webSite", "site", "homepage", "domain", "companyWebsite", "websites", "externalUrl"];
const ADDRESS_PATHS = ["address", "fullAddress", "formattedAddress", "street", "location.address", "addressLine1"];
const CITY_PATHS = ["city", "town", "locality", "address.city", "location.city"];
const REGION_PATHS = ["state", "region", "province", "county", "address.state"];
const COUNTRY_PATHS = ["country", "countryCode", "address.country", "location.country"];
const CATEGORY_PATHS = [
  "categoryName",
  "category",
  "categories",
  "type",
  "businessType",
  "industry",
  "sector",
  "businessCategoryName",
  "industries",
];
const RATING_PATHS = ["totalScore", "rating", "stars", "score", "reviewsAverage", "averageRating"];
const REVIEWS_PATHS = ["reviewsCount", "userRatingsTotal", "reviewCount", "numberOfReviews", "totalReviews", "reviews"];
const LAT_PATHS = ["location.lat", "location.latitude", "latitude", "lat", "coordinates.lat", "geo.latitude"];
const LNG_PATHS = ["location.lng", "location.longitude", "longitude", "lng", "lon", "coordinates.lng", "geo.longitude"];
const NOTES_PATHS = ["description", "about", "summary", "snippet", "bio", "biography", "headline", "tagline", "intro", "about_me"];
const CLOSED_PATHS = ["permanentlyClosed", "temporarilyClosed", "isClosed", "closed", "businessStatus"];

const SOCIAL_PATHS: Record<string, string[]> = {
  facebook: ["facebooks", "facebook", "socialLinks.facebook", "contactDetails.facebooks"],
  instagram: ["instagrams", "instagram", "socialLinks.instagram", "contactDetails.instagrams"],
  linkedin: ["linkedIns", "linkedin", "linkedIn", "socialLinks.linkedin", "contactDetails.linkedIns", "companyLinkedin"],
  twitter: ["twitters", "twitter", "socialLinks.twitter", "contactDetails.twitters"],
  youtube: ["youtubes", "youtube", "socialLinks.youtube"],
  tiktok: ["tiktoks", "tiktok"],
};

/**
 * Where each shape actually keeps each field, tried before the shared lists
 * above. Every path here was read off the actor's own published output sample
 * on 18 Aug 2026 rather than assumed — the previous round of assuming is what
 * produced empty captures.
 *
 * Google Maps rows carry `url` as the *Maps listing* URL, not the business's
 * own site, which is why `url` never appears in a website path.
 */
const SHAPE_PATHS: Record<Shape, Partial<Record<keyof NormalizedLead, string[]>>> = {
  // compass/crawler-google-places and the wrappers around it. With contacts
  // enrichment on, the same row also carries emails[]/phones[]/socials[].
  GOOGLE_MAPS: {
    contactName: ["title"],
    website: ["website"],
    contactEmail: ["emails"],
    contactPhone: ["phone", "phoneUnformatted", "phones"],
    category: ["categoryName", "categories"],
    externalId: ["placeId", "place_id", "cid", "fid"],
    address: ["address", "street"],
    city: ["city"],
    region: ["state", "neighborhood"],
    country: ["countryCode"],
    rating: ["totalScore"],
    reviewsCount: ["reviewsCount"],
    discoveryNotes: ["description"],
  },

  // vdrmota/contact-info-scraper. No name field of any kind — the domain is
  // the row's only label, which `nameFromDomain` turns into one.
  CONTACT_SWEEP: {
    website: ["domain", "originalStartUrl"],
    contactEmail: ["emails"],
    contactPhone: ["phones", "phonesUncertain"],
    externalId: ["domain", "originalStartUrl"],
  },

  // apify/instagram-profile-scraper. There is no email or phone anywhere in
  // this actor's output: the win is `externalUrl`, the site they link in their
  // bio, which is then what the website sweep runs on.
  INSTAGRAM: {
    contactName: ["fullName", "username"],
    companyName: ["fullName"],
    website: ["externalUrl", "externalUrls"],
    category: ["businessCategoryName"],
    discoveryNotes: ["biography"],
    externalId: ["id"],
  },

  // apify/facebook-pages-scraper. `website` is a bare host ("example.com"),
  // which cleanWebsite gives a scheme.
  FACEBOOK_PAGE: {
    contactName: ["title", "pageName"],
    companyName: ["title"],
    contactEmail: ["email"],
    website: ["website", "websites"],
    category: ["categories"],
    discoveryNotes: ["intro", "about_me"],
    externalId: ["pageId", "facebookId"],
    address: ["address"],
  },

  // harvestapi/linkedin-company. Addresses sit a level deeper than anywhere
  // else, under the headquarters entry of `locations[]`.
  LINKEDIN_COMPANY: {
    contactName: ["name"],
    companyName: ["name"],
    website: ["website"],
    contactPhone: ["phone.number", "phone"],
    category: ["industries"],
    discoveryNotes: ["description", "tagline"],
    externalId: ["universalName", "id"],
    address: ["locations.line1", "locations.parsed.text"],
    city: ["locations.city", "locations.parsed.city"],
    region: ["locations.geographicArea", "locations.parsed.state"],
    country: ["locations.parsed.country", "locations.country"],
  },

  GENERIC: {},
};

/** The social profile a row *is*, as opposed to ones it merely mentions. */
const SELF_PROFILE: Partial<Record<Shape, { network: string; paths: string[] }>> = {
  INSTAGRAM: { network: "instagram", paths: ["url", "inputUrl"] },
  FACEBOOK_PAGE: { network: "facebook", paths: ["pageUrl", "facebookUrl"] },
  LINKEDIN_COMPANY: { network: "linkedin", paths: ["linkedinUrl"] },
};

// --- Shape detection -------------------------------------------------------

const has = (item: Record<string, unknown>, ...keys: string[]) => keys.some((key) => key in item);

/**
 * Reads a row's own keys to say what it is. Ordered most distinctive first —
 * `placeId` only ever appears on a Maps row, `universalName` only on a
 * LinkedIn company.
 */
export function detectShape(item: Record<string, unknown>): Shape {
  if (has(item, "placeId", "categoryName") || (has(item, "totalScore") && has(item, "reviewsCount"))) return "GOOGLE_MAPS";
  if (has(item, "universalName", "employeeCountRange") || (has(item, "linkedinUrl") && has(item, "name"))) return "LINKEDIN_COMPANY";
  if (has(item, "pageId", "facebookUrl", "pageName")) return "FACEBOOK_PAGE";
  if (has(item, "username") && has(item, "followersCount", "biography", "externalUrl")) return "INSTAGRAM";
  // The contact sweep is the only shape with no name field whatsoever, so it
  // is identified by what it has rather than by what it lacks.
  if (has(item, "domain", "originalStartUrl") && has(item, "emails", "phones", "scrapedUrls")) return "CONTACT_SWEEP";
  return "GENERIC";
}

/**
 * The shape to read a row as. An explicit preset pins it — the Owner said so —
 * except AUTO and CUSTOM, which both detect. CUSTOM detects *as well as*
 * honouring the field map, because a field map naming two fields should not
 * cost you the other fifteen.
 */
export function resolveShape(preset: Preset, item: Record<string, unknown>): Shape {
  if (preset === "GOOGLE_MAPS") return "GOOGLE_MAPS";
  if (preset === "GENERIC_CONTACT") {
    const detected = detectShape(item);
    return detected === "GENERIC" ? "CONTACT_SWEEP" : detected;
  }
  return detectShape(item);
}

/** Kept for the call sites that still speak in presets. */
export function resolvePreset(preset: Preset, item: Record<string, unknown>): Preset {
  if (preset !== "AUTO") return preset;
  return detectShape(item) === "GOOGLE_MAPS" ? "GOOGLE_MAPS" : "GENERIC_CONTACT";
}

// --- Value cleaning --------------------------------------------------------

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
// Addresses that exist to receive nothing. Sending a proposal here is wasted effort.
const ROLE_EMAIL_NOISE = /^(no-?reply|do-?not-?reply|postmaster|abuse|privacy|unsubscribe)@/i;
// Addresses belonging to the platform or the template, not to the business.
const PLATFORM_EMAIL = /@(sentry\.|wixpress\.com|example\.com|domain\.com|yourdomain\.|email\.com)/i;

function cleanEmail(value: string): string | null {
  const email = value.trim().toLowerCase().replace(/^mailto:/, "").split("?")[0];
  if (!EMAIL_PATTERN.test(email) || ROLE_EMAIL_NOISE.test(email) || PLATFORM_EMAIL.test(email)) return null;
  return email;
}

function cleanPhone(value: string): string | null {
  const phone = value.trim().replace(/^tel:/, "");
  // Fewer than 7 digits isn't a dialable number — usually a scraped price or
  // id. More than 16 is not a phone number at all: E.164 stops at 15.
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 16) return null;
  return phone;
}

/** Link shorteners and platform pages that are not the business's own site. */
const NOT_A_WEBSITE =
  /^(l\.instagram\.com|lnk\.bio|linktr\.ee|bit\.ly|goo\.gl|facebook\.com|instagram\.com|linkedin\.com|twitter\.com|x\.com|tiktok\.com|youtube\.com|wa\.me|api\.whatsapp\.com|maps\.google\.com|g\.page)$/i;

export function cleanWebsite(value: string | null): string | null {
  if (!value) return null;
  let url = value.trim();
  if (!url || /^(n\/?a|none|null)$/i.test(url)) return null;
  if (!/^https?:\/\//i.test(url)) url = `https://${url.replace(/^\/+/, "")}`;
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.includes(".")) return null;
    if (NOT_A_WEBSITE.test(parsed.hostname.replace(/^www\./i, ""))) return null;
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

/**
 * Reads one dataset row. Always returns the shape it decided on and, when
 * there is no lead, the reason — a run that fetches forty rows and files no
 * leads has to be able to say why, or the only way to find out is to read the
 * raw dataset by hand.
 */
export function mapRow(item: Record<string, unknown>, options: MappingOptions = {}): MappedRow {
  const shape = resolveShape(options.preset ?? "AUTO", item);
  const overrides = options.fieldMap ?? {};
  const shapePaths = SHAPE_PATHS[shape];

  // Owner override → this shape's paths → the shared candidates.
  const paths = (field: keyof NormalizedLead, shared: string[]): string[] => {
    const custom = overrides[field as string];
    return [...(custom ? [custom] : []), ...(shapePaths[field] ?? []), ...shared];
  };

  const website = firstClean(item, paths("website", WEBSITE_PATHS), cleanWebsite);

  let name = firstString(item, paths("contactName", NAME_PATHS));
  // A contact sweep returns a page, not a person: url, domain, emails, phones
  // and a social link per network, and not one of them is a name. The domain
  // is the row's natural label, so use it rather than throwing the lead away.
  if (!name) name = nameFromDomain(websiteDomain(website));
  if (!name) {
    return {
      shape,
      lead: null,
      reason:
        shape === "GENERIC"
          ? "No name, company or website field this app recognises. Set a field map on the source to point at the right keys."
          : `Read as ${describeShape(shape)}, but it came back with no name and no website, so there is nothing to file it under.`,
    };
  }

  const socialLinks: Record<string, string> = {};
  for (const [network, networkPaths] of Object.entries(SOCIAL_PATHS)) {
    const link = firstString(item, networkPaths);
    if (link && /^https?:\/\//i.test(link)) socialLinks[network] = link;
  }
  // The profile this row *is* outranks any profile it merely mentions.
  const self = SELF_PROFILE[shape];
  if (self) {
    const own = firstString(item, self.paths);
    if (own && /^https?:\/\//i.test(own)) socialLinks[self.network] = own;
  }

  const category = firstString(item, paths("category", CATEGORY_PATHS));

  return {
    shape,
    reason: null,
    lead: {
      contactName: name,
      companyName: firstString(item, paths("companyName", ["companyName", "company", "businessName"])) ?? name,
      contactEmail: firstClean(item, paths("contactEmail", EMAIL_PATHS), cleanEmail),
      contactPhone: firstClean(item, paths("contactPhone", PHONE_PATHS), cleanPhone),
      website,
      address: firstString(item, paths("address", ADDRESS_PATHS)),
      city: firstString(item, paths("city", CITY_PATHS)),
      region: firstString(item, paths("region", REGION_PATHS)),
      country: firstString(item, paths("country", COUNTRY_PATHS)),
      category,
      rating: clamp(firstNumber(item, paths("rating", RATING_PATHS)), 0, 5),
      // Follower and like counts are not review counts and must not be read as
      // one: the scoring below treats reviews as evidence of a trading local
      // business, and a page with 40,000 likes would otherwise outrank one
      // with 40 genuine reviews.
      reviewsCount:
        shape === "FACEBOOK_PAGE" || shape === "INSTAGRAM" ? null : firstNumber(item, paths("reviewsCount", REVIEWS_PATHS)),
      latitude: clamp(firstNumber(item, paths("latitude", LAT_PATHS)), -90, 90),
      longitude: clamp(firstNumber(item, paths("longitude", LNG_PATHS)), -180, 180),
      socialLinks: Object.keys(socialLinks).length ? socialLinks : null,
      externalId: firstString(item, paths("externalId", ["placeId", "id", "url", "link", "profileUrl"])),
      discoveryNotes: firstString(item, paths("discoveryNotes", NOTES_PATHS))?.slice(0, 2000) ?? null,
      tags: category ? [category.toLowerCase()] : [],
      closed: firstBoolean(item, CLOSED_PATHS),
      externalKey: socialKey(shape, item),
    },
  };
}

export function describeShape(shape: Shape): string {
  switch (shape) {
    case "GOOGLE_MAPS":
      return "a Google Maps place";
    case "CONTACT_SWEEP":
      return "a website contact sweep";
    case "INSTAGRAM":
      return "an Instagram profile";
    case "FACEBOOK_PAGE":
      return "a Facebook Page";
    case "LINKEDIN_COMPANY":
      return "a LinkedIn company";
    default:
      return "an unrecognised row";
  }
}

/**
 * The identity a social row has on its own network. A business captured from
 * Instagram twice is one lead; without this it is two, because the only other
 * identity available would be its display name.
 */
function socialKey(shape: Shape, item: Record<string, unknown>): string | null {
  const value = (paths: string[]) => firstString(item, paths);
  switch (shape) {
    case "INSTAGRAM": {
      const handle = value(["username"]);
      return handle ? `instagram:${handle.toLowerCase()}` : null;
    }
    case "FACEBOOK_PAGE": {
      const id = value(["pageId", "facebookId", "pageName"]);
      return id ? `facebook:${id.toLowerCase()}` : null;
    }
    case "LINKEDIN_COMPANY": {
      const id = value(["universalName", "id"]);
      return id ? `linkedin:${id.toLowerCase()}` : null;
    }
    default:
      return null;
  }
}

/** The older signature, kept for call sites that only want the lead. */
export function mapItemToLead(item: Record<string, unknown>, options: MappingOptions = {}): NormalizedLead | null {
  return mapRow(item, options).lead;
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
 *
 * The domain outranks the social key deliberately: an Instagram account and
 * the website it links to are one business, and reaching the business behind
 * the account is the entire point of capturing it.
 */
export function buildDedupeKey(lead: NormalizedLead): string | null {
  if (lead.externalId && /^(ChI|0x|place)/i.test(lead.externalId)) return `place:${lead.externalId}`;

  const domain = websiteDomain(lead.website);
  if (domain) return `domain:${domain}`;
  if (lead.externalKey) return lead.externalKey;
  if (lead.contactEmail) return `email:${lead.contactEmail}`;

  const digits = lead.contactPhone?.replace(/\D/g, "");
  if (digits && digits.length >= 9) return `phone:${digits.slice(-9)}`;

  const name = slug(lead.contactName);
  if (!name) return null;
  return `name:${name}${lead.city ? `:${slug(lead.city)}` : ""}`;
}
