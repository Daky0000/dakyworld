import type { ConceptKind, ConceptStage, LeadConcept, Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";

/**
 * Where a lead is in the concept workflow, and how it gets to the next place.
 *
 * One row per lead, one writer for it. Every stage change goes through
 * `moveStage` so three things are always true together: the stage, the reason
 * it is there, and the history of how it got there. A stage set by hand in one
 * route and by a service in another is how a pipeline ends up with leads that
 * are APPROVED with nothing approved.
 *
 * The history is append-only and it is the thing worth having during a pilot:
 * "built, failed checks, rebuilt, passed, reviewed, sent" is the sentence that
 * answers whether this is worth doing at scale, and none of it is recoverable
 * from a single current stage.
 */

/** In order. Nothing here enforces that order — a lead can be held or skipped from anywhere. */
export const STAGE_ORDER: ConceptStage[] = [
  "QUALIFIED",
  "AUDIT_COMPLETE",
  "BUILDING",
  "NEEDS_REVIEW",
  "PREVIEW_CHECKED",
  "PROPOSAL_READY",
  "EMAIL_READY",
  "APPROVED",
  "SENDING",
  "SENT",
];

/** The three that are not progress: nothing downstream may run from them. */
export const HELD_STAGES: ConceptStage[] = ["NEEDS_REVIEW", "SKIPPED", "FAILED"];

export interface HistoryEntry {
  stage: ConceptStage;
  at: string;
  reason: string | null;
  by: string | null;
}

export function historyOf(concept: Pick<LeadConcept, "history">): HistoryEntry[] {
  return Array.isArray(concept.history) ? (concept.history as unknown as HistoryEntry[]) : [];
}

export async function conceptFor(leadId: string): Promise<LeadConcept | null> {
  return prisma.leadConcept.findUnique({ where: { leadId } });
}

/**
 * The row, created if this lead has never been in the workflow.
 *
 * Deliberately an upsert rather than a create: the first thing that touches a
 * lead — the eligibility pass, a person pressing Build, an agent tool — should
 * not have to know whether it is the first.
 */
export async function ensureConcept(leadId: string, init: { kind?: ConceptKind } = {}): Promise<LeadConcept> {
  return prisma.leadConcept.upsert({
    where: { leadId },
    create: { leadId, kind: init.kind ?? "NEW_SITE" },
    update: init.kind ? { kind: init.kind } : {},
  });
}

export interface MoveOptions {
  reason?: string | null;
  /** Who or what moved it: a user id, or an agent key. */
  by?: string | null;
  /** Fields to write in the same update — the evidence for the new stage. */
  data?: Prisma.LeadConceptUpdateInput;
}

/**
 * Moves a lead to a stage and records why, in one write.
 *
 * `reason` is required in spirit for SKIPPED and FAILED — a lead sitting in
 * either with a null reason is a lead nobody can do anything about — so those
 * two get a placeholder rather than being allowed to say nothing.
 */
export async function moveStage(leadId: string, stage: ConceptStage, options: MoveOptions = {}): Promise<LeadConcept> {
  const existing = await ensureConcept(leadId);
  const reason = options.reason ?? (stage === "SKIPPED" || stage === "FAILED" ? "No reason recorded." : null);

  const entry: HistoryEntry = { stage, at: new Date().toISOString(), reason, by: options.by ?? null };
  const history = [...historyOf(existing), entry];

  return prisma.leadConcept.update({
    where: { leadId },
    data: {
      ...(options.data ?? {}),
      stage,
      reason,
      history: history as unknown as Prisma.InputJsonValue,
    },
  });
}

/** True when the lead is at or past this stage, and not held or skipped. */
export function atLeast(stage: ConceptStage, target: ConceptStage): boolean {
  const at = STAGE_ORDER.indexOf(stage);
  const want = STAGE_ORDER.indexOf(target);
  if (at === -1 || want === -1) return false;
  return at >= want;
}
