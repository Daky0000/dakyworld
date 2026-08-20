import { callModel } from "../lib/models/call.js";
import { PROVIDERS } from "../lib/models/registry.js";
import { writerSystem } from "./writers/brief.js";

/**
 * Finding out who a lead actually is, before anybody writes to them.
 *
 * A scraped row arrives half-empty. The screenshot in the drawer that started
 * this is the ordinary case: a name, an email, a phone number, and then three
 * em-dashes where the trade, the address and the reputation should be. An
 * email written from that record can only be generic, because generic is all
 * the record contains.
 *
 * So this runs first. It goes to whoever serves the `research` job —
 * Perplexity by default, because it searches the live web on every call — and
 * asks one question: what can be established about this business from sources
 * you can cite. What comes back fills the blanks and writes the discovery note
 * the drafter then argues from.
 *
 * Two rules make the difference between this and a machine that invents a
 * plausible dental clinic:
 *
 *  - **A field is filled or it is left empty.** Never guessed. "Probably a
 *    restaurant, given the name" is not an answer; an empty category is. Every
 *    value carries the URL it came from, so a wrong one can be traced to the
 *    page that claimed it.
 *  - **Nothing already on the record is overwritten.** A scrape that found the
 *    address beats a search that found a different one, always. This only ever
 *    writes into a blank.
 *
 * And one thing it deliberately does *not* do: it may propose a contact email
 * or phone number, and the app will not apply either automatically. Everything
 * else here being wrong costs a sentence in a draft somebody reads before
 * sending. An email address being wrong sends a letter about a stranger's
 * business to a stranger, which is the one mistake with no reviewer in front
 * of it.
 */

/** The Lead scalars this pass is allowed to write into. */
export const FILLABLE = [
  "companyName",
  "category",
  "address",
  "city",
  "region",
  "country",
  "website",
  "rating",
  "reviewsCount",
] as const;

export type FillableField = (typeof FILLABLE)[number];

export interface FoundField {
  value: string;
  /** The URL it was read from. Empty means it was not sourced, and it is dropped. */
  source: string;
  confidence: "HIGH" | "MEDIUM" | "LOW";
}

export interface LeadResearchResult {
  /** Only fields that were both found and sourced. */
  found: Partial<Record<FillableField, FoundField>>;
  /** Proposed, never applied — see the note at the top of this file. */
  proposedContact: { email: string | null; phone: string | null; source: string } | null;
  /** Social profiles found, as `{ facebook: url }`. */
  socialLinks: Record<string, string>;
  /**
   * What is worth knowing before writing to them, in the Owner's own terms.
   * Written as desk research and labelled as such — it is not a call.
   */
  discoveryNote: string;
  /** What could not be established. Says "nobody looked" apart from "nothing found". */
  couldNotFind: string[];
  /** Who answered, and whether they actually searched. */
  researchedBy: string;
  searchedLiveSources: boolean;
  sources: { title: string; url: string; date?: string | null }[];
  costUsd: number;
}

const FIELD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["value", "source", "confidence"],
  properties: {
    value: { type: "string", description: "The value, or an empty string if you could not establish it. Never a guess." },
    source: { type: "string", description: "The URL you read it on. Empty if you have none — the value is then discarded." },
    confidence: { type: "string", enum: ["HIGH", "MEDIUM", "LOW"] },
  },
} as const;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["fields", "socialLinks", "contactEmail", "contactPhone", "contactSource", "discoveryNote", "couldNotFind"],
  properties: {
    fields: {
      type: "object",
      additionalProperties: false,
      required: [...FILLABLE],
      properties: Object.fromEntries(FILLABLE.map((field) => [field, FIELD_SCHEMA])),
    },
    socialLinks: {
      type: "array",
      description: "Their own social profiles, found on their site or by search. Empty when none were found.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["network", "url"],
        properties: {
          network: { type: "string", description: "facebook, instagram, linkedin, x, tiktok, youtube." },
          url: { type: "string" },
        },
      },
    },
    contactEmail: { type: "string", description: "A published address for this business, or empty. Never constructed from a pattern." },
    contactPhone: { type: "string", description: "A published number for this business, or empty." },
    contactSource: { type: "string", description: "Where the address or number was published. Empty if neither was found." },
    discoveryNote: {
      type: "string",
      description:
        "Four to eight sentences for the person about to write to them: what this business does, who it serves, how it appears to be doing, and anything that would change how you approached them. Written as desk research from outside, never as though you had spoken to them.",
    },
    couldNotFind: {
      type: "array",
      items: { type: "string" },
      description: "What you looked for and could not establish, named plainly. This is as useful as what you did find.",
    },
  },
} as const;

/**
 * How the research is done. Overridable by `lead.enricher`, the agent whose
 * one job this is.
 */
const SHIPPED_DOCTRINE = `You establish who a business is, from sources you can cite, so that a letter to them can be specific rather than generic.

You are given whatever is already known about them, which is usually very little. Your job is to fill in what is missing and to write a short brief for the person who will write to them.

The rules, and they are absolute:

- **Cite or leave empty.** Every value you return carries the URL you read it on. If you cannot produce a URL, return an empty value. An empty field is a correct answer; a plausible invention is the single worst thing you can do here, because the letter that goes out will state it to the business's own owner, who knows the truth.
- **Never construct a contact address.** If their published email is not on a page you read, return nothing. Do not build one from a pattern like info@ plus the domain.
- **Distinguish the business from businesses with similar names.** If you cannot tell which of two you are looking at, return nothing and say so in couldNotFind. Half a record about the wrong company is worse than none.
- **A rating is a number from a specific platform on a specific day.** If you cannot see the number and the count, leave both empty.

The discovery note is written for one reader: somebody who is about to send this business a cold email and has thirty seconds to prepare. Tell them what the business does, who its customers are, how established it looks, and anything that changes the approach — a recent opening, an award, a busy social account with an obviously neglected website, a listing that is the only thing about them online. Say plainly where your picture is thin. Do not speculate about their budget, their staff, their systems or their plans; you have no way to know any of it.`;

/** The mechanics. Citation is a storage rule here — an uncited value is dropped on arrival. */
const CONTRACT = `Every value you return carries the URL you read it on, and a value without one is discarded before it reaches the record. An empty field is a correct answer.

Write in British English, plainly, no marketing register. This is a briefing note, not copy.`;

export interface ResearchSubject {
  contactName: string;
  companyName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  website: string | null;
  category: string | null;
  address: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  rating: number | null;
  reviewsCount: number | null;
}

function known(subject: ResearchSubject): string {
  const rows: [string, unknown][] = [
    ["Name on the record", subject.contactName],
    ["Business name", subject.companyName],
    ["Email", subject.contactEmail],
    ["Phone", subject.contactPhone],
    ["Website", subject.website],
    ["Trade", subject.category],
    ["Address", subject.address],
    ["Town or city", subject.city],
    ["Region", subject.region],
    ["Country", subject.country],
    ["Rating", subject.rating != null ? `${subject.rating} from ${subject.reviewsCount ?? "unknown"} reviews` : null],
  ];
  return rows
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .map(([label, value]) => `- ${label}: ${value}`)
    .join("\n");
}

export async function researchLead(subject: ResearchSubject): Promise<LeadResearchResult> {
  const result = await callModel<{
    fields: Record<FillableField, FoundField>;
    socialLinks: { network: string; url: string }[];
    contactEmail: string;
    contactPhone: string;
    contactSource: string;
    discoveryNote: string;
    couldNotFind: string[];
  }>({
    purpose: "lead.research",
    job: "research",
    system: await writerSystem("lead.research", SHIPPED_DOCTRINE, { contract: CONTRACT }),
    prompt: () =>
      [
        "Everything currently on file for this lead:",
        known(subject) || "- nothing but a name",
        "",
        "Find out who they are. Fill only what you can cite, leave the rest empty, and write the briefing note.",
        subject.country || subject.city
          ? ""
          : "No location is on file, so be careful: businesses with this name exist in more than one country. If you cannot tell which, return nothing rather than the wrong one.",
      ]
        .filter(Boolean)
        .join("\n"),
    schema: SCHEMA as unknown as Record<string, unknown>,
    // A company that closed last year is a live fact, and a year-old page
    // saying otherwise is exactly what this is here to avoid trusting.
    recency: "year",
    effort: "medium",
    maxTokens: 6000,
    messages: {
      noKey: "No model is connected for research. Add a Perplexity key under Settings → AI models, or fill these fields by hand.",
      empty: "The research came back empty. Try again.",
      refusal: "The research model declined this one.",
    },
  });

  // Anything without a source is dropped here rather than trusted — the prompt
  // says so, and this is what makes it true whichever vendor answered.
  const found: Partial<Record<FillableField, FoundField>> = {};
  for (const field of FILLABLE) {
    const entry = result.data.fields?.[field];
    if (!entry) continue;
    const value = entry.value?.trim();
    const source = entry.source?.trim();
    if (!value || !source || !/^https?:\/\//i.test(source)) continue;
    found[field] = { value, source, confidence: entry.confidence ?? "LOW" };
  }

  const socialLinks: Record<string, string> = {};
  for (const link of result.data.socialLinks ?? []) {
    const network = link.network?.trim().toLowerCase();
    const url = link.url?.trim();
    if (network && url && /^https?:\/\//i.test(url)) socialLinks[network] = url;
  }

  const email = result.data.contactEmail?.trim() || null;
  const phone = result.data.contactPhone?.trim() || null;

  return {
    found,
    proposedContact: email || phone ? { email, phone, source: result.data.contactSource?.trim() ?? "" } : null,
    socialLinks,
    discoveryNote: result.data.discoveryNote?.trim() ?? "",
    couldNotFind: (result.data.couldNotFind ?? []).filter((entry) => entry.trim()),
    researchedBy: PROVIDERS[result.provider].name,
    // The honest part, same as the fact-checker: a company profile assembled
    // from a model's training data is a different and much weaker thing than
    // one assembled from pages read this minute, and the reader has to be able
    // to tell which they got.
    searchedLiveSources: result.provider === "perplexity",
    sources: result.sources,
    costUsd: result.costUsd,
  };
}
