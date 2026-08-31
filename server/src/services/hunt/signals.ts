import type { CompanyAudit } from "../companyAudit.js";
import type { HomepageLook } from "../homepageLook.js";

/**
 * The things a thesis is allowed to test a business against.
 *
 * A thesis says who we are looking for — "businesses trading well enough to be
 * on Maps with no website at all". That sentence is for a person. This is the
 * half a machine can check, and keeping the two apart is the whole point of
 * the file: a qualifier that names a signal here is decided from evidence
 * already on the record, at no cost and with the same answer every time. A
 * qualifier that names nothing here is prose, and prose goes to a model with
 * the evidence attached (see `judge.ts`) — which is slower, costs something,
 * and is the reason the vocabulary below is worth having.
 *
 * **Every signal reads something that was actually looked at.** The ids match
 * `companyAudit.ts`'s findings one for one, `HomepageLook`'s fields, or a
 * column a scrape filled in. Nothing here infers from a trade name or a
 * category, because "law firms usually need X" is a guess about an industry
 * dressed up as a fact about a company, and a pipeline built on those is a
 * pipeline of strangers.
 *
 * **Three answers, not two.** `true`, `false`, and `null` for *could not tell* —
 * the site would not load, the audit never ran, nobody looked at the homepage.
 * Treating "could not tell" as "no" is how a thesis quietly deletes every
 * business whose host was having a bad afternoon, which is why `judge.ts`
 * scores against what was actually checkable rather than against the whole
 * list.
 */

/** What a judgement gets to look at. Everything here is evidence somebody paid for. */
export interface SignalEvidence {
  lead: {
    website: string | null;
    contactEmail: string | null;
    contactPhone: string | null;
    companyName: string | null;
    category: string | null;
    city: string | null;
    rating: number | null;
    reviewsCount: number | null;
    socialLinks: Record<string, string> | null;
    clientId: string | null;
  };
  audit: CompanyAudit | null;
  look: HomepageLook | null;
}

export interface SignalOutcome {
  /** True fired, false did not, null could not be told from what was looked at. */
  fired: boolean | null;
  /** What was seen, in the words a person would use. Empty when nothing was. */
  evidence: string;
}

export interface SignalDefinition {
  key: string;
  /** What firing means, in plain words. Shown when a thesis is being written. */
  says: string;
  test: (evidence: SignalEvidence) => SignalOutcome;
}

/** True when the audit ran far enough for its findings to mean anything. */
function audited(evidence: SignalEvidence): boolean {
  return Boolean(evidence.audit && evidence.audit.checked.length > 0);
}

/**
 * A finding on the audit, by id.
 *
 * The absence of a finding only means "not found" when the audit actually ran —
 * otherwise it means nobody looked, which is a different answer. Hence the
 * `audited` guard on every caller rather than a bare `.some()`.
 */
function finding(evidence: SignalEvidence, id: string) {
  return evidence.audit?.findings.find((entry) => entry.id === id) ?? null;
}

/** A signal that is exactly "the audit raised this finding". Most of them are. */
function fromFinding(key: string, says: string, id = key): SignalDefinition {
  return {
    key,
    says,
    test: (evidence) => {
      const hit = finding(evidence, id);
      if (hit) return { fired: true, evidence: `${hit.observed} (${hit.evidence})` };
      if (!audited(evidence)) return { fired: null, evidence: "" };
      return { fired: false, evidence: "" };
    },
  };
}

const DEFINITIONS: SignalDefinition[] = [
  // --- The shopfront ------------------------------------------------------
  {
    key: "no-website",
    says: "They have no website at all.",
    test: (evidence) => {
      const hit = finding(evidence, "no-website");
      if (hit) return { fired: true, evidence: `${hit.observed} (${hit.evidence})` };
      // Answerable without an audit: a blank website column on a lead that came
      // off a Maps listing is the same fact, and it is the one case worth
      // deciding for free.
      if (!evidence.lead.website) return { fired: true, evidence: "No web address on the record." };
      if (!audited(evidence)) return { fired: null, evidence: "" };
      return { fired: false, evidence: `They have a site: ${evidence.lead.website}` };
    },
  },
  {
    key: "has-website",
    says: "They have a website — there is something to review.",
    test: (evidence) => {
      // The inverse of `no-website`, and worth its own entry rather than a
      // negation syntax on qualifiers: a thesis about a *failing* website has
      // to be able to say that having one is the precondition, and "not
      // (no-website)" is not the same statement — an unaudited business with a
      // blank record would satisfy it.
      if (evidence.lead.website) return { fired: true, evidence: evidence.lead.website };
      if (finding(evidence, "no-website")) return { fired: false, evidence: "No website was found." };
      return { fired: false, evidence: "No web address on the record." };
    },
  },
  fromFinding(
    "rented-presence",
    "A Facebook or Instagram page is standing in for a website they do not own.",
  ),
  fromFinding(
    "demand-without-destination",
    "People are already looking for them and there is nowhere to send anyone.",
  ),
  fromFinding("site-unreachable", "Their website would not load at all."),
  fromFinding("site-error", "Their website answered with an error."),
  fromFinding("no-https", "Their site is served without HTTPS, so browsers warn about it."),
  fromFinding("cert-untrusted", "Their certificate does not verify — visitors see a security warning."),
  fromFinding("not-mobile", "The site is not built for a phone."),
  fromFinding("slow-site", "The site is slow enough to lose visitors."),
  fromFinding("stale-site", "Nothing on the site has changed in a long time."),
  fromFinding("outdated-cms", "The site runs on a version old enough to be a security problem."),
  fromFinding("cms-version-exposed", "The site publishes which version it runs, which is what a scanner looks for."),
  fromFinding("page-builder", "The site is on a hosted page builder they do not control."),
  fromFinding("one-host-only", "Everything they have sits on one host with nothing behind it."),

  // --- Being reachable ----------------------------------------------------
  fromFinding("no-contact-route", "There is no way to make contact from the site."),
  fromFinding("no-written-contact", "No email address or phone number is written anywhere on the site."),
  fromFinding("free-mail-on-site", "The site publishes a Gmail or Yahoo address rather than their own domain."),
  fromFinding("free-mail-contact", "The contact address on file is a free mailbox, not their own domain."),
  fromFinding("no-business-email", "Their domain cannot receive mail — there are no MX records."),
  fromFinding("no-spf", "Their domain has no SPF record, so anyone can send mail as them."),
  fromFinding("no-dmarc", "Their domain has no DMARC record, so nothing stops a spoofed invoice."),
  fromFinding("no-analytics", "Nothing on the site measures whether any of it works."),
  fromFinding("no-link-preview", "Their link shows as a bare URL when it is shared."),

  // --- Evidence they are actually trading ---------------------------------
  {
    key: "trading",
    says: "There is real evidence of trade: reviews, a rating, or a phone somebody answers.",
    test: (evidence) => {
      const reviews = evidence.lead.reviewsCount ?? 0;
      if (reviews >= 5) return { fired: true, evidence: `${reviews} reviews on their listing.` };
      if (evidence.lead.rating != null && reviews > 0) {
        return { fired: true, evidence: `Rated ${evidence.lead.rating} across ${reviews} review(s).` };
      }
      if (evidence.lead.contactPhone) return { fired: true, evidence: "A published phone number." };
      if (reviews === 0 && !evidence.lead.contactPhone) {
        return { fired: false, evidence: "No reviews and no number — nothing showing they trade." };
      }
      return { fired: null, evidence: "" };
    },
  },
  {
    key: "well-reviewed",
    says: "Enough reviews, well enough rated, to be an established business rather than a new one.",
    test: (evidence) => {
      const reviews = evidence.lead.reviewsCount;
      const rating = evidence.lead.rating;
      if (reviews == null && rating == null) return { fired: null, evidence: "" };
      if ((reviews ?? 0) >= 15 && (rating ?? 0) >= 3.8) {
        return { fired: true, evidence: `Rated ${rating} across ${reviews} reviews.` };
      }
      return { fired: false, evidence: `Rated ${rating ?? "—"} across ${reviews ?? 0} review(s).` };
    },
  },
  fromFinding("weak-reputation", "Their public rating is poor enough to be costing them work."),
  fromFinding("strong-reputation", "They are well rated in public — a reputation worth protecting."),
  {
    key: "reachable",
    says: "There is at least one way to get in touch with them.",
    test: (evidence) => {
      if (evidence.lead.contactEmail) return { fired: true, evidence: `Email on file: ${evidence.lead.contactEmail}` };
      if (evidence.lead.contactPhone) return { fired: true, evidence: `Phone on file: ${evidence.lead.contactPhone}` };
      return { fired: false, evidence: "No email address and no phone number — nobody to write to." };
    },
  },
  {
    key: "has-email",
    says: "We have an email address for them, so a letter is possible.",
    test: (evidence) =>
      evidence.lead.contactEmail
        ? { fired: true, evidence: evidence.lead.contactEmail }
        : { fired: false, evidence: "No email address on the record." },
  },

  // --- What a visitor actually sees ---------------------------------------
  {
    key: "offer-unclear",
    says: "A visitor cannot tell what they sell without scrolling.",
    test: (evidence) => {
      if (!evidence.look) return { fired: null, evidence: "" };
      return evidence.look.offerClear
        ? { fired: false, evidence: "" }
        : { fired: true, evidence: evidence.look.firstImpression };
    },
  },
  {
    key: "contact-unclear",
    says: "A visitor cannot see how to get in touch without hunting for it.",
    test: (evidence) => {
      if (!evidence.look) return { fired: null, evidence: "" };
      return evidence.look.contactClear
        ? { fired: false, evidence: "" }
        : { fired: true, evidence: evidence.look.firstImpression };
    },
  },
  {
    key: "looks-dated",
    says: "The design is visibly of another decade.",
    test: (evidence) => {
      if (!evidence.look) return { fired: null, evidence: "" };
      return evidence.look.looksDated
        ? { fired: true, evidence: evidence.look.looksDated }
        : { fired: false, evidence: "" };
    },
  },
  {
    key: "looks-smaller-than-it-is",
    says: "The site makes the business look smaller or less serious than it actually is.",
    test: (evidence) => {
      if (!evidence.look) return { fired: null, evidence: "" };
      return evidence.look.fitsTheBusiness
        ? { fired: false, evidence: "" }
        : { fired: true, evidence: evidence.look.fitNote };
    },
  },

  // --- Reasons to stop ----------------------------------------------------
  {
    key: "already-a-client",
    says: "They are already on our books.",
    test: (evidence) =>
      evidence.lead.clientId
        ? { fired: true, evidence: "This record is already attached to a client." }
        : { fired: false, evidence: "" },
  },
  {
    key: "no-way-to-reach-them",
    says: "No email, no phone, no social — there is no way to open a conversation.",
    test: (evidence) => {
      const socials = Object.keys(evidence.lead.socialLinks ?? {}).length;
      if (evidence.lead.contactEmail || evidence.lead.contactPhone || socials > 0) return { fired: false, evidence: "" };
      return { fired: true, evidence: "Nothing on the record to make contact with." };
    },
  },
  {
    key: "competitor",
    says: "They sell what we sell — a web, IT, software or digital agency.",
    test: (evidence) => {
      const haystack = `${evidence.lead.companyName ?? ""} ${evidence.lead.category ?? ""}`.toLowerCase();
      // Deliberately a short, specific list. A long one catches "Digital Farms
      // Ltd" and quietly deletes a real prospect on the strength of one word.
      const words = [
        "web design",
        "web development",
        "software company",
        "software development",
        "it services",
        "it solutions",
        "digital agency",
        "digital marketing agency",
        "seo agency",
        "internet marketing service",
        "computer support",
      ];
      const hit = words.find((word) => haystack.includes(word));
      if (hit) return { fired: true, evidence: `"${hit}" appears in their name or category.` };
      if (!evidence.lead.category && !evidence.lead.companyName) return { fired: null, evidence: "" };
      return { fired: false, evidence: "" };
    },
  },
  {
    key: "site-is-fine",
    says: "Nothing serious was found — their setup is in good order.",
    test: (evidence) => {
      if (!audited(evidence)) return { fired: null, evidence: "" };
      const serious = (evidence.audit?.findings ?? []).filter(
        (entry) => entry.severity === "CRITICAL" || entry.severity === "HIGH",
      );
      if (serious.length > 0) return { fired: false, evidence: `${serious.length} serious finding(s).` };
      return { fired: true, evidence: "Nothing critical or high was found." };
    },
  },
];

export const SIGNALS: Record<string, SignalDefinition> = Object.fromEntries(
  DEFINITIONS.map((definition) => [definition.key, definition]),
);

export const SIGNAL_KEYS = DEFINITIONS.map((definition) => definition.key);

/**
 * A qualifier line, split into the part a machine decides and the part a person reads.
 *
 * A thesis is written as `no-website — they have nowhere to send anyone`. The
 * key before the dash is looked up here; everything after it is the sentence
 * shown to whoever is reading the verdict. A line with no known key in front is
 * not an error — it is prose, and `judge.ts` sends it to a model with the
 * evidence rather than dropping it.
 */
export function parseQualifier(line: string): { signal: SignalDefinition | null; prose: string; required: boolean } {
  // A leading `!` marks the line as **defining** rather than supporting.
  //
  // This exists because of a real fault caught by the check: the "no website"
  // thesis has one defining test and three supporting ones, and a business
  // with a perfectly good website scored 3 of 4 on the supporting ones — it
  // was trading, reachable and well reviewed — and qualified under a thesis
  // whose entire subject is not having a website. A score is a weighing, and
  // some tests are not there to be weighed.
  const withoutMark = line.trim().replace(/^!\s*/, "");
  const required = withoutMark !== line.trim();

  // Em dash, en dash, hyphen or colon — whichever somebody typed.
  const split = withoutMark.match(/^([a-z][a-z0-9-]*)\s*(?:—|–|-{1,2}|:)\s*(.+)$/i);
  const key = (split?.[1] ?? withoutMark).toLowerCase();
  const known = SIGNALS[key] ?? null;
  if (!known) return { signal: null, prose: withoutMark, required };
  return { signal: known, prose: split?.[2]?.trim() || known.says, required };
}

/** Every signal, as the wording an editor should see beside the key. */
export function signalCatalogue(): Array<{ key: string; says: string }> {
  return DEFINITIONS.map((definition) => ({ key: definition.key, says: definition.says }));
}
