import { REDESIGN_FLOOR, normaliseCall, type RedesignVerdict } from "../audit/redesign.js";

/**
 * Who gets a concept built for them, and who does not.
 *
 * A concept page costs real money to build and carries a real business's name
 * on the public internet, so the question "should we build one" is answered
 * here, once, from facts rather than from whoever happened to press a button.
 * Every caller — the route, the agent tool, the scheduled prep — asks this.
 *
 * Two shapes of yes:
 *
 *  - **They have no website.** The page is the argument itself; there is
 *    nothing to compare it against and nothing to be wrong about.
 *  - **They have one and it scored badly.** The page is the alternative. This
 *    is the new half, and it is the one that can be wrong in a way that costs
 *    us the lead: pitching a rebuild at somebody whose site is fine reads as
 *    a stranger chasing a bigger job.
 *
 * The rules that keep the second half honest:
 *
 *  - **The redesign call decides, not the site's overall score.** The overall
 *    score is four disciplines averaged, so a site can land in the sixties on
 *    an expired certificate and a slow server while looking perfectly
 *    respectable — and "your site is dated" said about a site that is not is
 *    the one sentence that ends the conversation. `audit/redesign.ts` is the
 *    section that actually looked at the page and decided.
 *  - **A missing or failed audit is not a bad website.** Absence of evidence
 *    is the reason this is written out rather than left to a truthy check: a
 *    verdict that could not be produced, or one from a run that never fetched
 *    the page, must read as "we do not know", and we do not pitch against a
 *    page nobody opened.
 *  - **Never twice.** A lead with a live concept, or one that has already had
 *    its first letter, is not a candidate — rebuilding changes a page the
 *    prospect may already have opened, and a second "I built you a homepage"
 *    to the same person is the sort of thing that gets a domain blocked.
 */

export type ConceptKind = "NEW_SITE" | "REDESIGN";

export interface EligibilityInput {
  /** `LeadStatus`. Only QUALIFIED leads are candidates. */
  status: string;
  rehearsal?: boolean;
  website: string | null | undefined;
  /**
   * The redesign section of their most recent audit, or null when no audit has
   * run, the run failed, or the section could not be produced.
   */
  redesign: RedesignVerdict | null | undefined;
  /** True when the audit that produced `redesign` actually reached the site. */
  auditReachedSite?: boolean;
  /** A concept already exists for this lead and has not been abandoned. */
  hasActiveConcept?: boolean;
  /** The first cold letter has already gone to them. */
  initialOutreachSent?: boolean;
}

export interface Eligibility {
  eligible: boolean;
  kind: ConceptKind | null;
  /** Always set when `eligible` is false — this is what `LeadConcept.reason` stores. */
  reason: string | null;
}

const no = (reason: string): Eligibility => ({ eligible: false, kind: null, reason });

/** True for a lead with no address on file at all. */
export function hasNoWebsite(website: string | null | undefined): boolean {
  return !website?.trim();
}

/**
 * Whether this verdict is grounds for offering to rebuild.
 *
 * Under the floor the call is not allowed to disagree (`audit/redesign.ts`
 * enforces that), so the two conditions agree in almost every case — but
 * `REBUILD` above the floor is a real combination: a well-made page that never
 * says what the company sells scores in the seventies and still needs
 * replacing, and the section is allowed one band of judgement to say so.
 */
export function verdictArguesForRedesign(redesign: RedesignVerdict | null | undefined): boolean {
  if (!redesign) return false;
  const call = normaliseCall(redesign.call);
  if (call === "REBUILD") return true;
  return typeof redesign.score === "number" && redesign.score < REDESIGN_FLOOR;
}

export function conceptEligibility(input: EligibilityInput): Eligibility {
  if (input.rehearsal) return no("This is a rehearsal's scratch lead, not a prospect.");
  if (input.status !== "QUALIFIED") {
    return no(`Not qualified yet — the lead is ${input.status.toLowerCase()}. A concept is built for businesses we have decided to approach.`);
  }
  if (input.initialOutreachSent) {
    return no("They have already had their first letter, so a concept now would be a second opening rather than an opening.");
  }
  if (input.hasActiveConcept) {
    return no("A concept already exists for this lead. Rebuilding changes a page they may already have opened.");
  }

  if (hasNoWebsite(input.website)) {
    return { eligible: true, kind: "NEW_SITE", reason: null };
  }

  if (!input.redesign) {
    return no("No redesign verdict on file, so nothing has actually looked at their page. Run the website audit first — a site we could not read is not a bad site.");
  }
  if (input.auditReachedSite === false) {
    return no("The audit never reached their site, so its verdict describes nothing. A page behind a firewall or a dead certificate is still a page their customers open.");
  }
  if (!verdictArguesForRedesign(input.redesign)) {
    const call = normaliseCall(input.redesign.call);
    const score = typeof input.redesign.score === "number" ? ` (${input.redesign.score}/100)` : "";
    return no(`Their site scored ${call.toLowerCase().replace("_", " ")}${score}, which is above the line where a rebuild is the honest offer.`);
  }

  return { eligible: true, kind: "REDESIGN", reason: null };
}
