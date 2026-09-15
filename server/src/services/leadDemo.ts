import { prisma } from "../lib/prisma.js";
import { buildDemo, demoUrl, subjectFromLead } from "./demoBuilder.js";
import { appUrl } from "./emailSender.js";
import type { CompanyAudit } from "./companyAudit.js";
import type { HomepageLook } from "./homepageLook.js";
import type { WebsiteAuditReport } from "./audit/types.js";
import { conceptEligibility, type Eligibility } from "./concept/eligibility.js";
import { failureSummary } from "./concept/checks.js";
import { recordBuild } from "./concept/record.js";
import { ensureConcept, moveStage } from "./concept/stage.js";
import { autoRedesignEnabled } from "./concept/settings.js";

/**
 * The process that decides whether a lead gets a page built for them, builds
 * it, checks it, and puts it in front of a person.
 *
 * Everything else this pipeline does is evidence: the scan fetches their site,
 * the audit measures it, the look photographs it, and the letter argues from
 * what was found. The concept page is the argument itself rather than a claim
 * about it — their name, their trade, their town, the services their own
 * listing lists, on a page they can open on their phone in ten seconds.
 *
 * Two businesses get one:
 *
 * - **The ones with no website.** There is nothing to compare against, so the
 *   page is the whole letter. This has run since August.
 * - **The ones whose site scored badly enough to argue for replacing it.**
 *   This is the new half, and it is gated harder, because it can be wrong in a
 *   way the first cannot: telling somebody their site is dated when it is not
 *   is the one sentence that ends the conversation. `concept/eligibility.ts`
 *   holds that rule, and it reads the **redesign call**, not the site's
 *   overall score — a site can land in the sixties on a slow server and an
 *   expired certificate while looking perfectly respectable.
 *
 * Three rules that have not changed:
 *
 * - **Never twice.** A lead that already has a page keeps its link: rebuilding
 *   changes what the prospect sees at an address they may already have opened.
 * - **A failure is a note, never an error.** Every other stage of the prep
 *   degrades to a sentence, and the letter still has to be writable when the
 *   HTML model is down. What must never happen is a letter that offers a link
 *   that does not exist, which is why the fact the drafter reads says which of
 *   the two happened.
 * - **Building is not permission to send.** A built page stops at
 *   NEEDS_REVIEW. The automated checks in `concept/checks.ts` run first, but
 *   passing them only means nothing observable is wrong; whether the services
 *   named are services they offer is a question only a person can answer.
 */

export interface EnsuredDemo {
  /** Null when no page exists and none could be built. */
  url: string | null;
  demoId: string | null;
  /** True when this call built it, rather than finding one already there. */
  built: boolean;
  /** Why nothing was built, when nothing was. */
  note: string | null;
  costUsd: number;
  /** Why it was not eligible, when it was not. Null when a build was attempted. */
  skipped: string | null;
}

const nothing = (note: string | null, skipped: string | null = null): EnsuredDemo => ({
  url: null,
  demoId: null,
  built: false,
  note,
  costUsd: 0,
  skipped,
});

/** The redesign section of the most recent audit for this lead, and whether that audit reached the site. */
export async function latestRedesign(leadId: string): Promise<{ report: WebsiteAuditReport | null; auditId: string | null }> {
  const audit = await prisma.websiteAudit.findFirst({ where: { leadId }, orderBy: { ranAt: "desc" } });
  if (!audit) return { report: null, auditId: null };
  return { report: (audit.report ?? null) as WebsiteAuditReport | null, auditId: audit.id };
}

export async function ensureDemoForLead(leadId: string, options: { force?: boolean; by?: string | null } = {}): Promise<EnsuredDemo> {
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    include: { research: true, demos: { orderBy: { updatedAt: "desc" }, take: 1 }, concept: true },
  });
  if (!lead) return nothing("Lead not found.");

  const base = await appUrl();
  const existing = lead.demos[0];
  if (existing) {
    // Already sendable. Rebuilding would change a page the prospect may have
    // opened, and the whole point of the link is that it is theirs to look at.
    return { url: demoUrl(existing.slug, base), demoId: existing.id, built: false, note: null, costUsd: 0, skipped: null };
  }

  const audit = (lead.research?.audit ?? null) as CompanyAudit | null;
  const look = (lead.research?.look ?? null) as HomepageLook | null;
  const { report, auditId } = await latestRedesign(leadId);

  const sentAlready = await prisma.emailMessage.count({
    where: { leadId, status: "SENT", purpose: { in: ["COLD_OUTREACH", "DEMO_READY"] } },
  });

  const verdict: Eligibility = conceptEligibility({
    status: lead.status,
    rehearsal: lead.rehearsal,
    website: lead.website,
    redesign: report?.redesign ?? null,
    // A report that could not be scored is a report on a site nobody got into.
    auditReachedSite: report ? report.scored : undefined,
    hasActiveConcept: Boolean(lead.concept?.demoId),
    initialOutreachSent: sentAlready > 0,
  });

  // `force` is how a person overrules the rule — the Build button, and the
  // agent tool behind it. It does not overrule the *record*: the skip reason is
  // still written, so a page built against the rule says so afterwards.
  if (!verdict.eligible && !options.force) {
    await moveStage(leadId, "SKIPPED", { reason: verdict.reason, by: options.by ?? null, data: { auditId } });
    return nothing(verdict.reason, verdict.reason);
  }

  const kind = verdict.kind ?? (lead.website?.trim() ? "REDESIGN" : "NEW_SITE");

  // The rollout switch. Redesign concepts stay off until the gates have been
  // watched working, and off means off for the automatic path only — a person
  // pressing Build is a person taking the decision.
  if (kind === "REDESIGN" && !options.force && !(await autoRedesignEnabled())) {
    const reason = "Automatic redesign concepts are switched off during the pilot. Build this one deliberately if it is the offer.";
    await moveStage(leadId, "SKIPPED", { reason, by: options.by ?? null, data: { kind, auditId } });
    return nothing(reason, reason);
  }

  // The same guard `POST /demos/build` and the `demo.build` tool keep, for the
  // same reason: a page built from a bare record is a template with a business
  // name dropped into it, which is the one thing this feature exists not to
  // produce. Here it matters more than anywhere — a lead with no website has
  // nothing on the record but what research and the listing supplied.
  if (!lead.research) {
    const reason = "Nobody has looked at this business yet, so there is nothing to build a page from. Run the scan first.";
    await moveStage(leadId, "SKIPPED", { reason, by: options.by ?? null, data: { kind, auditId } });
    return nothing(reason, reason);
  }

  await ensureConcept(leadId, { kind });
  await moveStage(leadId, "BUILDING", {
    by: options.by ?? null,
    data: {
      kind,
      auditId,
      redesignCall: report?.redesign?.call ?? null,
      redesignScore: report?.redesign?.score ?? null,
    },
  });

  const startedAt = Date.now();
  try {
    const built = await buildDemo(subjectFromLead(lead, audit, look));

    // Built and checked, and still not ready: the checks answer whether
    // anything observable is wrong, and "nothing observable is wrong" is not
    // the same claim as "this is fit to send to a stranger". The recording is
    // shared with the Build button and the agent tool — see concept/record.ts.
    const checks = await recordBuild(leadId, built, { by: options.by ?? null, startedAt });

    const note = [built.notes.join(" "), !checks || checks.passed ? "" : `The page did not pass its checks: ${failureSummary(checks)}`]
      .filter(Boolean)
      .join(" ");
    return { url: built.url, demoId: built.demoId, built: true, note: note || null, costUsd: built.costUsd, skipped: null };
  } catch (err) {
    const reason = `No demo page could be built for them: ${(err as Error).message}`;
    await moveStage(leadId, "FAILED", { reason, by: options.by ?? null, data: { buildMs: Date.now() - startedAt } });
    return nothing(`${reason} The letter must not offer a link, and should offer to send one instead.`, null);
  }
}
