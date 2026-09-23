import type { Demo, LeadConcept } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { demoUrl } from "../demoBuilder.js";
import { appUrl } from "../emailSender.js";
import { atLeast, conceptFor } from "./stage.js";
import type { PreviewChecks } from "./checks.js";

/**
 * The one place that answers "is this preview fit to be used yet".
 *
 * It exists as a service rather than as a condition in a route because three
 * different things generate outreach — the screens, the agent tools, and the
 * scheduled prep — and a rule enforced in one of them is a rule that holds
 * until somebody uses a different door. The proposal writer, the email
 * drafter, the email context builder and the sender all ask this, and they all
 * get the same answer.
 *
 * "Fit" means all three of:
 *
 *  - a page exists,
 *  - the automated checks passed **against that version of it**, and
 *  - a person looked at it afterwards.
 *
 * The middle condition is the one worth spelling out: checks that passed
 * against version 2 say nothing about version 3, and a rebuild is exactly when
 * somebody is most likely to assume the earlier pass still counts.
 */

export interface PreviewGate {
  ok: boolean;
  /** Why not, in words that can be shown to a person. Null when ok. */
  reason: string | null;
  concept: LeadConcept | null;
  demo: Demo | null;
  /** The public link, only when the gate is open. Nothing may print an unchecked link. */
  url: string | null;
  checks: PreviewChecks | null;
}

const shut = (reason: string, concept: LeadConcept | null = null, demo: Demo | null = null): PreviewGate => ({
  ok: false,
  reason,
  concept,
  demo,
  url: null,
  checks: null,
});

export async function previewGate(leadId: string): Promise<PreviewGate> {
  const concept = await conceptFor(leadId);
  if (!concept) {
    const imported = await prisma.demo.findFirst({
      where: { leadId, builtBy: "Imported HTML", status: { notIn: ["ARCHIVED", "DECLINED"] } },
      orderBy: { updatedAt: "desc" },
    });
    if (imported) {
      return {
        ok: true,
        reason: null,
        concept: null,
        demo: imported,
        url: demoUrl(imported.slug, await appUrl()),
        checks: { passed: true, ranAt: imported.updatedAt.toISOString(), checks: [] },
      };
    }
    return shut("This lead has no concept page — nothing has been built for them.");
  }
  if (concept.stage === "SKIPPED") return shut(`This lead was skipped: ${concept.reason ?? "no reason recorded"}`, concept);
  if (concept.stage === "FAILED") return shut(`The concept failed: ${concept.reason ?? "no reason recorded"}`, concept);
  if (!concept.demoId) return shut("No page has been built for this lead yet.", concept);

  const demo = await prisma.demo.findUnique({ where: { id: concept.demoId } });
  if (!demo) return shut("The page this lead was approved against no longer exists.", concept);

  const checks = (concept.checks ?? null) as PreviewChecks | null;
  if (!checks) return shut("The page has not been checked yet.", concept, demo);
  if (!checks.passed) {
    return shut("The page has not passed its quality checks, so it may not be sent or quoted from.", concept, demo);
  }
  if (concept.demoVersion !== demo.version) {
    return shut(
      `The page has been rebuilt since it was checked (checked version ${concept.demoVersion ?? "unknown"}, page is now version ${demo.version}). It has to be checked again.`,
      concept,
      demo,
    );
  }
  if (!concept.reviewedAt) {
    return shut("The automated checks passed, but nobody has looked at the page yet.", concept, demo);
  }
  if (!atLeast(concept.stage, "PREVIEW_CHECKED")) {
    return shut(`The lead is at ${concept.stage.toLowerCase().replace(/_/g, " ")}, which is before the preview was signed off.`, concept, demo);
  }

  return { ok: true, reason: null, concept, demo, url: demoUrl(demo.slug, await appUrl()), checks };
}

/**
 * Whether outreach may be written for this lead at all.
 *
 * Narrower than `previewGate` on purpose. A lead that is not in the concept
 * workflow, or one whose page has not been built, is not affected — the
 * pipeline still writes letters and proposals for everybody it always did.
 * What is refused is the specific case this workflow exists to control: a page
 * **has** been built for this business, and it has not passed its checks or
 * nobody has looked at it. Writing the proposal then is writing a document
 * around a link that may be wrong about them, and the writing is where the
 * link gets quoted, screenshotted and attached.
 *
 * Enforced in a service rather than in a route because there are four doors —
 * the Proposals screen, the Emails screen, `proposal.draft` and `email.draft` —
 * and a rule held by one of them holds until somebody uses another.
 */
export async function outreachGate(leadId: string | null | undefined): Promise<{ ok: boolean; reason: string | null }> {
  if (!leadId) return { ok: true, reason: null };
  const concept = await conceptFor(leadId);
  if (!concept?.demoId) return { ok: true, reason: null };

  const gate = await previewGate(leadId);
  if (gate.ok) return { ok: true, reason: null };
  return {
    ok: false,
    reason: `A concept page has been built for this lead and it is not cleared yet: ${gate.reason} Check the page first — the proposal and the letter are written around it.`,
  };
}

/**
 * The gate as one fact for a prompt.
 *
 * The drafters are told they may use only the facts they are given, so the
 * absence of a link has to arrive as a sentence rather than as silence — a
 * drafter that is simply not told about a page will write around it, and the
 * one thing that must never happen is a letter offering a link that is not fit
 * to be opened.
 */
export function gateFact(gate: PreviewGate): string {
  if (gate.ok) return `A checked concept page has been built for them at ${gate.url}. It has passed its quality checks and been reviewed, so the letter may offer it.`;
  return `There is no checked concept page for them: ${gate.reason} Do not offer a link, and do not describe a page as though it exists.`;
}
