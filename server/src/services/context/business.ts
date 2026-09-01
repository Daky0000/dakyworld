import type { Prisma, Site, SitePage } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { callModel } from "../../lib/models/call.js";
import {
  SHIPPED_OFFER,
  brandFrom,
  catalogueFrom,
  type BusinessOffer,
  type CarePlanTier,
  type ProjectPackage,
  type ServiceLine,
} from "../dakyworld.js";
import { pageSource } from "../website/site.js";

/**
 * What this company sells, read from the company's own website.
 *
 * Every agent is told who Dakyworld is and what it may offer. Until Sep 2026
 * that description was a constant in `services/dakyworld.ts` and nothing kept
 * it in step with dakyworld.com — so when the site dropped from eight service
 * lines to four, renamed its plans, published a Founding Partner discount and
 * stated plainly that Dakyworld does not administer business email or run
 * managed cybersecurity, none of it reached the workforce. Agents went on
 * offering work the company had stopped doing, at prices nobody could still
 * buy, while the page the prospect was reading said something else. A prospect
 * who is quoted GHS 5,000 for a plan the website sells at 3,000 does not
 * conclude that the sales agent is out of date.
 *
 * So the website is the source and this is the reader:
 *
 * ```
 * dakyworld.com pages ──→ visibleText() ──→ one model call ──→ AppSetting
 *   (services, pricing,     markup out,      job: "organise"    business.offer
 *    plans, projects,       ~40k of prose    strict schema
 *    about, home)
 * ```
 *
 * Four rules, and each of them is the difference between this being useful and
 * being a second place for the offer to be wrong:
 *
 * 1. **The shipped constant is the floor, never the ceiling.** No key, no
 *    network, an unreadable row, a sync that has never run — every one of those
 *    lands on `SHIPPED_OFFER` rather than on nothing. An agent with no
 *    description of its own company writes a letter about a company in general.
 * 2. **Nothing is invented and nothing is merged field-by-field.** A stored
 *    offer replaces the shipped one wholesale, because half of last year's
 *    catalogue mixed into this year's is a price list that never existed. The
 *    only merging is per *top-level list*: a section the reader could not find
 *    on the site keeps the shipped wording rather than becoming empty, since
 *    "no services" is a claim, and a false one.
 * 3. **A sync is skipped when the site has not changed.** The fingerprint is
 *    over the text that was read, so the daily tick costs one read and no model
 *    call on the ordinary day where nothing was published.
 * 4. **It never throws at a caller.** `brandBlock()` is on the path of every
 *    agent turn and every draft; a website that is briefly unreachable must
 *    cost accuracy, not the letter.
 */

const OFFER_KEY = "business.offer";

/** Which pages describe the offer. Anything else on the site is not about what is sold. */
const OFFER_PAGES = [
  "index.html",
  "services.html",
  "pricing.html",
  "monthly-support.html",
  "one-time-projects.html",
  "foundation-build.html",
  "about.html",
];

/** How much of one page's prose is worth sending. Past this it is footers and FAQs. */
const MAX_PAGE_CHARS = 12_000;

export interface StoredOffer extends BusinessOffer {
  /** When the website was last read successfully. */
  syncedAt: string;
  /** Which pages it was read from. */
  pages: string[];
  /** Which model read them. */
  readBy: string;
  /** Of the text that was read, so an unchanged site is not re-read by a model. */
  fingerprint: string;
}

export interface OfferState {
  offer: BusinessOffer;
  /** Where the value came from — the website, or the constants this ships with. */
  from: "website" | "shipped";
  syncedAt: string | null;
  pages: string[];
  readBy: string | null;
}

// One process, one cache — the same contract `systemProfile.ts` keeps, and for
// the same reason: this is read several times per agent turn and changes only
// when a sync writes it.
let cached: OfferState | null = null;

export function clearBusinessOfferCache() {
  cached = null;
}

// --- Reading what is stored -------------------------------------------------

const text = (value: unknown, fallback: string): string => {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || fallback;
};

const lines = (value: unknown, fallback: string[], max = 12): string[] => {
  if (!Array.isArray(value)) return fallback;
  const cleaned = value.map((entry) => String(entry ?? "").trim()).filter(Boolean).slice(0, max);
  // An empty list is the one answer that cannot be taken at face value: "this
  // company sells nothing" and "the reader could not find the list" arrive
  // looking identical, and only one of them is true.
  return cleaned.length ? cleaned : fallback;
};

const price = (value: unknown): number | null => {
  const amount = typeof value === "number" ? value : Number(String(value ?? "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(amount) && amount > 0 ? Math.round(amount) : null;
};

function slug(value: string, index: number): string {
  const made = value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return made || `service-${index + 1}`;
}

function readServices(value: unknown): ServiceLine[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const services = value.slice(0, 10).map((entry, index): ServiceLine => {
    const raw = (entry ?? {}) as Record<string, unknown>;
    const name = text(raw.name, `Service ${index + 1}`);
    return {
      id: text(raw.id, slug(name, index)),
      name,
      what: text(raw.what, ""),
      fixes: Array.isArray(raw.fixes) ? raw.fixes.map((one) => String(one ?? "").trim()).filter(Boolean).slice(0, 10) : [],
      anchorPrice: price(raw.anchorPrice),
      billing: raw.billing === "MONTHLY" ? "MONTHLY" : "ONE_OFF",
      priceNote: text(raw.priceNote, "Quoted after a consultation."),
    };
  });
  return services.filter((service) => service.name && service.what);
}

function readPlans(value: unknown): CarePlanTier[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const plans = value.slice(0, 8).map((entry): CarePlanTier => {
    const raw = (entry ?? {}) as Record<string, unknown>;
    return {
      tier: text(raw.tier, ""),
      monthly: price(raw.monthly),
      discountedMonthly: price(raw.discountedMonthly),
      discountNote: text(raw.discountNote, ""),
      for: text(raw.for, ""),
    };
  });
  return plans.filter((plan) => plan.tier);
}

function readProjects(value: unknown): ProjectPackage[] | null {
  if (!Array.isArray(value)) return null;
  const projects = value.slice(0, 10).map((entry): ProjectPackage => {
    const raw = (entry ?? {}) as Record<string, unknown>;
    return { name: text(raw.name, ""), from: price(raw.from), what: text(raw.what, "") };
  });
  return projects.filter((project) => project.name);
}

/** A stored answer, clamped to something a prompt can be built from. */
export function readOffer(stored: unknown): BusinessOffer {
  if (!stored || typeof stored !== "object") return SHIPPED_OFFER;
  const raw = stored as Record<string, unknown>;
  return {
    positioning: text(raw.positioning, SHIPPED_OFFER.positioning),
    summary: lines(raw.summary, SHIPPED_OFFER.summary, 8),
    doesNotDo: lines(raw.doesNotDo, SHIPPED_OFFER.doesNotDo, 10),
    proofPoints: lines(raw.proofPoints, SHIPPED_OFFER.proofPoints, 8),
    services: readServices(raw.services) ?? SHIPPED_OFFER.services,
    plans: readPlans(raw.plans) ?? SHIPPED_OFFER.plans,
    projects: readProjects(raw.projects) ?? SHIPPED_OFFER.projects,
    // The one list allowed to be genuinely empty: a company with no discount
    // running is the ordinary case, and carrying the shipped one forward would
    // have agents offering a programme that closed.
    offers: Array.isArray(raw.offers) ? raw.offers.map((one) => String(one ?? "").trim()).filter(Boolean).slice(0, 8) : SHIPPED_OFFER.offers,
  };
}

/** What the company currently sells. Every prompt builder calls this. */
export async function businessOffer(): Promise<OfferState> {
  if (cached) return cached;

  let row: { value: string } | null = null;
  try {
    row = await prisma.appSetting.findUnique({ where: { key: OFFER_KEY }, select: { value: true } });
  } catch {
    // A prompt must not need a reachable database to say who the sender is.
    console.error("[business] couldn't read the offer — using the shipped catalogue.");
    return { offer: SHIPPED_OFFER, from: "shipped", syncedAt: null, pages: [], readBy: null };
  }

  if (!row) {
    cached = { offer: SHIPPED_OFFER, from: "shipped", syncedAt: null, pages: [], readBy: null };
    return cached;
  }

  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(row.value) as Record<string, unknown>;
  } catch {
    console.error("[business] the stored offer isn't valid JSON — using the shipped catalogue.");
  }

  cached = parsed
    ? {
        offer: readOffer(parsed),
        from: "website",
        syncedAt: typeof parsed.syncedAt === "string" ? parsed.syncedAt : null,
        pages: Array.isArray(parsed.pages) ? parsed.pages.map(String) : [],
        readBy: typeof parsed.readBy === "string" ? parsed.readBy : null,
      }
    : { offer: SHIPPED_OFFER, from: "shipped", syncedAt: null, pages: [], readBy: null };
  return cached;
}

/** Who the sender is, for a prompt. The successor to the old `BRAND` constant. */
export async function brandBlock(): Promise<string> {
  return brandFrom((await businessOffer()).offer);
}

/** What may be sold and at what price, for a prompt. */
export async function catalogueBlock(): Promise<string> {
  return catalogueFrom((await businessOffer()).offer);
}

/** The ids a writer may tag a recommendation with — whatever is currently sold. */
export async function serviceIds(): Promise<string[]> {
  const { offer } = await businessOffer();
  return offer.services.map((service) => service.id);
}

// --- Reading the website ----------------------------------------------------

/** The words on a page, with the markup, the script and the styling taken out. */
export function visibleText(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(?:br|\/p|\/h[1-6]|\/li|\/tr|\/div|\/section)\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (entity, body: string) => {
      const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", middot: "·", rsquo: "’", mdash: "—", ndash: "–" };
      if (body.startsWith("#x") || body.startsWith("#X")) return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
      if (body.startsWith("#")) return String.fromCodePoint(Number(body.slice(1)));
      return named[body.toLowerCase()] ?? entity;
    })
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

async function fingerprintOf(value: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

/**
 * The offer pages, as prose.
 *
 * Read through the website module's own source reader, so this gets the same
 * answer the editor does — the repository where a GitHub token is configured,
 * the live site where it is not — and the same cache. Nothing here is
 * Dakyworld-specific except which site it asks for: `Site.slug` is the only
 * thing naming the company, and a second site would be a second row.
 */
async function readOfferPages(site: Site & { pages?: SitePage[] }): Promise<{ pages: { path: string; text: string }[]; notes: string[] }> {
  const notes: string[] = [];
  const pages = await prisma.sitePage.findMany({ where: { siteId: site.id }, orderBy: { filePath: "asc" } });
  const wanted = OFFER_PAGES.map((file) => pages.find((page) => page.filePath === file)).filter((page): page is SitePage => Boolean(page));

  if (!wanted.length) {
    notes.push(
      `None of the pages that describe the offer (${OFFER_PAGES.join(", ")}) are known on ${site.name} yet. Open the site once on the Website screen so its pages are discovered, then sync again.`,
    );
    return { pages: [], notes };
  }

  const read: { path: string; text: string }[] = [];
  for (const page of wanted) {
    try {
      const source = await pageSource(site, page);
      const prose = visibleText(source.html).slice(0, MAX_PAGE_CHARS);
      if (prose) read.push({ path: page.filePath, text: prose });
    } catch (err) {
      // One page that will not load must not cost the other six. The pricing
      // page failing is worth saying out loud; the about page failing is not
      // worth stopping for.
      notes.push(`${page.filePath} could not be read: ${(err as Error).message}`);
    }
  }
  return { pages: read, notes };
}

// --- The extraction ---------------------------------------------------------

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["positioning", "summary", "doesNotDo", "proofPoints", "services", "plans", "projects", "offers"],
  properties: {
    positioning: { type: "string", description: "What the company is, in the one sentence the site itself leads with." },
    summary: {
      type: "array",
      items: { type: "string" },
      description:
        "Four to six lines describing the sender to somebody who has never heard of them: who they serve, where, how the work is delivered, and how a client usually starts. Each a complete sentence, taken from what the pages say.",
    },
    doesNotDo: {
      type: "array",
      items: { type: "string" },
      description:
        "Everything the site says the company does NOT do, each as one short sentence. Look for a boundary or exclusions section. Empty only if the site states no boundary at all.",
    },
    proofPoints: {
      type: "array",
      items: { type: "string" },
      description:
        "Figures and results the site publishes about itself — percentages, counts, hours saved — each with what it refers to. Only numbers actually printed on a page. No claims, no adjectives.",
    },
    services: {
      type: "array",
      description: "The capabilities the site says are sold, in the order the site lists them. One entry per capability, not one per bullet point.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "name", "what", "fixes", "anchorPrice", "billing", "priceNote"],
        properties: {
          id: { type: "string", description: "A short lower-case slug for this capability — websites, automation, integrations, training." },
          name: { type: "string", description: "The capability's name as the site writes it." },
          what: { type: "string", description: "One sentence a buyer would recognise, from the site's own description." },
          fixes: {
            type: "array",
            items: { type: "string" },
            description: "The problems the site says this is for, each in a few plain words. These are matched against faults found on a prospect's website.",
          },
          anchorPrice: {
            type: "number",
            description: "The lowest price the site publishes for this capability, as a plain number with no currency. Use -1 when the site publishes no price for it. Never estimate one.",
          },
          billing: { type: "string", enum: ["ONE_OFF", "MONTHLY"], description: "ONE_OFF for project work, MONTHLY for anything retained." },
          priceNote: { type: "string", description: "How it is priced, in the site's own terms, including what makes the final number move." },
        },
      },
    },
    plans: {
      type: "array",
      description: "The monthly retainer tiers, in the order the site lists them.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["tier", "monthly", "discountedMonthly", "discountNote", "for"],
        properties: {
          tier: { type: "string", description: "The tier's name." },
          monthly: { type: "number", description: "The standard monthly rate as a plain number. -1 when the site publishes none." },
          discountedMonthly: {
            type: "number",
            description: "The reduced rate currently on offer, as a plain number. -1 when there is no discount on this tier. Never the standard rate repeated.",
          },
          discountNote: { type: "string", description: "What the discount is and how long it lasts, in one sentence. Empty when there is no discount." },
          for: { type: "string", description: "Who the tier is for, from the site." },
        },
      },
    },
    projects: {
      type: "array",
      description: "The defined one-off projects the site lists, with their published starting prices.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "from", "what"],
        properties: {
          name: { type: "string" },
          from: { type: "number", description: "The published starting price as a plain number. -1 when none is published." },
          what: { type: "string", description: "One sentence on what the project delivers." },
        },
      },
    },
    offers: {
      type: "array",
      items: { type: "string" },
      description:
        "Programmes, discounts and standing commercial terms running right now, each as one sentence a salesperson could say out loud. Include what is excluded from a price. Empty when the site advertises none.",
    },
  },
} as const;

const SYSTEM = `You read a company's own website and write down what it currently sells, so that the people writing to its prospects describe the same company the prospects are reading about.

You are not writing marketing copy and you are not summarising. You are transcribing an offer into fields.

Rules:

- **Only what the pages say.** Every price, every tier name, every capability and every exclusion must appear on the pages you were given. If something is not there, leave it out. An invented price is quoted to a real customer.
- **Prices are numbers, exactly as published.** "From GHS 15,000" is 15000. Where a page shows both a standard rate and a lower rate on offer now, the standard rate is the price and the lower one is the discount — never the other way round, and never averaged.
- **A discount is temporary and must say so.** Record what the reduced rate is, who it is for and how long it lasts. If the site has no discount, say so by leaving the fields empty rather than repeating the standard price.
- **The boundary matters as much as the offer.** Where a page says what the company does not do, will not take on, or is a poor fit for, record every item. This is what stops a salesperson offering work the company has stopped doing.
- Prefer the site's own words over tidier ones. Plain, complete sentences. British spelling.`;

export interface SyncResult {
  changed: boolean;
  offer: BusinessOffer;
  from: "website" | "shipped";
  syncedAt: string | null;
  pages: string[];
  readBy: string | null;
  notes: string[];
  costUsd: number;
}

/**
 * Read the website and store what it says.
 *
 * Degrades to a note at every step. The one thing it will never do is store a
 * partial answer over a good one: a read that produced no pages, or a model
 * that produced no services, leaves whatever is already stored alone.
 */
export async function syncBusinessOffer(options: { force?: boolean; siteSlug?: string } = {}): Promise<SyncResult> {
  const notes: string[] = [];
  const current = await businessOffer();
  const unchanged = (extra: string[] = []): SyncResult => ({
    changed: false,
    offer: current.offer,
    from: current.from,
    syncedAt: current.syncedAt,
    pages: current.pages,
    readBy: current.readBy,
    notes: [...notes, ...extra],
    costUsd: 0,
  });

  const site = await prisma.site.findUnique({ where: { slug: options.siteSlug ?? "dakyworld" } });
  if (!site) return unchanged(["There is no company website connected, so there is nothing to read the offer from."]);

  const { pages, notes: readNotes } = await readOfferPages(site);
  notes.push(...readNotes);
  if (!pages.length) return unchanged();

  const document = pages.map((page) => `--- ${page.path} ---\n${page.text}`).join("\n\n");
  const fingerprint = await fingerprintOf(document);

  // The ordinary day. A daily read of seven pages costs seven cached HTTP
  // requests and no model call at all, which is what makes running this every
  // day defensible.
  const stored = await prisma.appSetting.findUnique({ where: { key: OFFER_KEY }, select: { value: true } });
  if (!options.force && stored) {
    try {
      const previous = JSON.parse(stored.value) as { fingerprint?: string };
      if (previous.fingerprint === fingerprint) return unchanged();
    } catch {
      // Unreadable: treat it as never having been synced rather than skipping.
    }
  }

  let extracted: Record<string, unknown>;
  let readBy: string;
  let costUsd = 0;
  try {
    const result = await callModel<Record<string, unknown>>({
      purpose: "business.offer",
      // Following a schema over prose that has a right answer — the same job
      // the sheet analyst and the post room run on, and the same reason: what
      // comes back is read by us, never by a customer.
      job: "organise",
      system: SYSTEM,
      prompt: () => `These are the pages of ${site.name} (${site.publicUrl}). Write down what this company currently sells.\n\n${document}`,
      schema: SCHEMA as unknown as Record<string, unknown>,
      effort: "medium",
      maxTokens: 8_000,
      messages: {
        noKey: "No model is connected to read the website, so the shipped catalogue is still what every agent is told. Add a key under Settings → AI models.",
      },
    });
    extracted = result.data;
    readBy = result.model;
    costUsd = result.costUsd;
  } catch (err) {
    return unchanged([`The website could not be read into the business context: ${(err as Error).message}`]);
  }

  const next = readOffer(normalise(extracted));
  if (!next.services.length) return unchanged(["The reader found no services on the website, so what was already stored has been kept."]);

  const syncedAt = new Date().toISOString();
  const value: StoredOffer = { ...next, syncedAt, pages: pages.map((page) => page.path), readBy, fingerprint };
  await prisma.appSetting.upsert({
    where: { key: OFFER_KEY },
    update: { value: JSON.stringify(value), secret: false },
    create: { key: OFFER_KEY, value: JSON.stringify(value), secret: false },
  });
  cached = { offer: next, from: "website", syncedAt, pages: value.pages, readBy };

  return { changed: true, offer: next, from: "website", syncedAt, pages: value.pages, readBy, notes, costUsd };
}

/**
 * `-1` back into `null`.
 *
 * A schema cannot say "a number or nothing" on every wire this app speaks —
 * a nullable number is where two of the free models answer 400 — so the prompt
 * asks for a sentinel, exactly as the sheet analyst does for a missing row.
 */
function normalise(raw: Record<string, unknown>): Record<string, unknown> {
  const clean = (value: unknown) => (typeof value === "number" && value <= 0 ? null : value);
  const list = (value: unknown, keys: string[]) =>
    Array.isArray(value)
      ? value.map((entry) => {
          const row = { ...((entry ?? {}) as Record<string, unknown>) };
          for (const key of keys) row[key] = clean(row[key]);
          return row;
        })
      : value;

  return {
    ...raw,
    services: list(raw.services, ["anchorPrice"]),
    plans: list(raw.plans, ["monthly", "discountedMonthly"]),
    projects: list(raw.projects, ["from"]),
  };
}

/**
 * Called after a page is published, so the workforce is told the new thing
 * rather than the old one.
 *
 * Fire-and-forget on purpose: a publish must not fail, or wait, because a
 * model was slow to read the page it just wrote. The daily tick is the floor
 * under this — if this one never lands, the offer is right by tomorrow rather
 * than never.
 *
 * Only the pages that describe the offer. Publishing a change to the privacy
 * notice is not a change to what the company sells, and re-reading seven pages
 * with a model every time somebody fixes a typo on the terms page is how a
 * useful refresh becomes a bill.
 */
export function offerPagePublished(filePath: string): boolean {
  if (!OFFER_PAGES.includes(filePath)) return false;
  void syncBusinessOffer({ force: true })
    .then((result) => {
      if (result.changed) console.log(`[business] ${filePath} was published, so what the agents are told was re-read from the site.`);
    })
    .catch((err) => console.warn(`[business] couldn't re-read the offer after publishing ${filePath}: ${(err as Error).message}`));
  return true;
}

/** Everything the Settings screen shows about the business context. */
export async function businessContextStatus() {
  const state = await businessOffer();
  return {
    ...state,
    /** What every agent is actually told, so "where do these words go" has an answer. */
    brand: brandFrom(state.offer),
    catalogue: catalogueFrom(state.offer),
    shippedPages: OFFER_PAGES,
  };
}

/** Kept for the writer that needs a Prisma-shaped value. */
export type StoredOfferJson = Prisma.InputJsonValue;
