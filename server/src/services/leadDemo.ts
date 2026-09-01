import { prisma } from "../lib/prisma.js";
import { buildDemo, demoUrl, subjectFromLead } from "./demoBuilder.js";
import { appUrl } from "./emailSender.js";
import { demoIsTheArgument } from "./leadPrep.js";
import type { CompanyAudit } from "./companyAudit.js";
import type { HomepageLook } from "./homepageLook.js";

/**
 * The process for a lead with no website.
 *
 * Everything else this pipeline does is evidence: the scan fetches their site,
 * the audit measures it, the look photographs it, and the letter argues from
 * what was found. A business with no website has none of that — so every cold
 * email to one was written from an *absence*, and an email written from an
 * absence can only be a lecture about websites in general. "A site would bring
 * you customers" is a claim about the future made by a stranger, and the
 * reader has heard it before from somebody who wanted a meeting.
 *
 * The demo is the argument itself rather than a claim about it: their name,
 * their trade, their town, the services their own listing lists, on a page they
 * can open on their phone in ten seconds. It is far easier to say yes to than a
 * call, and it is the one thing this company can offer that costs the reader
 * nothing to judge.
 *
 * `demoBuilder.ts` has been able to build one since August. What was missing is
 * that **nothing built one on its own**: a person had to notice the lead had no
 * site, open the Demos screen and press a button, and the drafter meanwhile was
 * told to offer "a page built for them to look at" that did not exist. So this
 * is the step that closes it — run before the letter is written, on the leads
 * where the page *is* the letter.
 *
 * Three rules:
 *
 * - **Only where there is no site.** A demo for a business with a working site
 *   is a redesign pitch, which is a real and sometimes better offer — but it is
 *   somebody's decision, not a default. `force` is how that decision is made.
 * - **Never twice.** A lead that already has a page keeps its link: rebuilding
 *   changes what the prospect sees at an address they may already have opened.
 * - **A failure is a note, never an error.** Every other stage of the prep
 *   degrades to a sentence, and the letter still has to be writable when the
 *   HTML model is down. What must never happen is a letter that offers a link
 *   that does not exist, which is why the fact the drafter reads says which of
 *   the two happened.
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
}

const nothing = (note: string | null): EnsuredDemo => ({ url: null, demoId: null, built: false, note, costUsd: 0 });

export async function ensureDemoForLead(leadId: string, options: { force?: boolean } = {}): Promise<EnsuredDemo> {
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    include: { research: true, demos: { orderBy: { updatedAt: "desc" }, take: 1 } },
  });
  if (!lead) return nothing("Lead not found.");

  const base = await appUrl();
  const existing = lead.demos[0];
  if (existing) {
    // Already sendable. Rebuilding would change a page the prospect may have
    // opened, and the whole point of the link is that it is theirs to look at.
    return { url: demoUrl(existing.slug, base), demoId: existing.id, built: false, note: null, costUsd: 0 };
  }

  const audit = (lead.research?.audit ?? null) as CompanyAudit | null;
  const look = (lead.research?.look ?? null) as HomepageLook | null;

  if (!options.force && !demoIsTheArgument({ website: lead.website, audit })) {
    return nothing("They already have a website, so a demo is a redesign pitch rather than the argument — build one deliberately if that is the offer.");
  }

  // The same guard `POST /demos/build` and the `demo.build` tool keep, for the
  // same reason: a page built from a bare record is a template with a business
  // name dropped into it, which is the one thing this feature exists not to
  // produce. Here it matters more than anywhere — a lead with no website has
  // nothing on the record but what research and the listing supplied.
  if (!lead.research) {
    return nothing("Nobody has looked at this business yet, so there is nothing to build a page from. Run the scan first.");
  }

  try {
    const built = await buildDemo(subjectFromLead(lead, audit, look));
    return { url: built.url, demoId: built.demoId, built: true, note: built.notes.join(" ") || null, costUsd: built.costUsd };
  } catch (err) {
    return nothing(`No demo page could be built for them: ${(err as Error).message} The letter must not offer a link, and should offer to send one instead.`);
  }
}
