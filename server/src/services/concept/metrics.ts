import { prisma } from "../../lib/prisma.js";

/**
 * What the pilot is actually measuring.
 *
 * Ten leads is a small enough number that every one of these can be read off a
 * screen, and that is the point: the decision at the end of it — widen the
 * eligibility, change the templates, spend more or stop — is made from build
 * cost against revenue and from how often a page passed its checks first time.
 * Neither is recoverable later from a pipeline that only stored its current
 * stage.
 *
 * **Replies and acceptances are read from the rows that already hold them**,
 * and overridden by anything typed in by hand. A reply that arrived in the
 * shared mailbox is a `MailMessage` against the lead; an accepted proposal is
 * a status on the proposal. A meeting booked over WhatsApp is neither, which
 * is why the manual fields exist — a pilot that can only count what happens to
 * be instrumented is measuring the instrumentation.
 */

export interface PilotMetrics {
  leads: number;
  built: number;
  /** Of those built, how many passed every automated check on the first build. */
  firstPassRate: number | null;
  averageCheckAttempts: number | null;
  averageBuildSeconds: number | null;
  totalBuildCostUsd: number;
  averageBuildCostUsd: number | null;
  rebuilds: number;
  reviewed: number;
  /** Of those reviewed, how many a person passed rather than sent back. */
  reviewPassRate: number | null;
  approved: number;
  sent: number;
  uncertainSends: number;
  replies: number;
  meetings: number;
  proposalsAccepted: number;
  revenueUsd: number;
  /** Revenue against what the concepts cost to produce. Null until something was spent. */
  returnOnBuildCost: number | null;
  byStage: Record<string, number>;
}

function rate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? Number((numerator / denominator).toFixed(3)) : null;
}

export async function pilotMetrics(): Promise<PilotMetrics> {
  const concepts = await prisma.leadConcept.findMany();
  const leadIds = concepts.map((concept) => concept.leadId);

  // The instrumented halves, for the leads that have none typed in by hand.
  const [inboundByLead, acceptedByLead] = await Promise.all([
    prisma.mailMessage.groupBy({ by: ["leadId"], where: { leadId: { in: leadIds }, direction: "INBOUND" }, _count: { _all: true } }).catch(() => []),
    prisma.proposal.groupBy({ by: ["leadId"], where: { leadId: { in: leadIds }, status: "ACCEPTED" }, _count: { _all: true } }).catch(() => []),
  ]);
  const replied = new Set((inboundByLead as { leadId: string | null }[]).map((row) => row.leadId).filter((id): id is string => Boolean(id)));
  const accepted = new Set((acceptedByLead as { leadId: string | null }[]).map((row) => row.leadId).filter((id): id is string => Boolean(id)));

  const built = concepts.filter((concept) => concept.demoId);
  const checked = built.filter((concept) => concept.firstPassOk !== null);
  const reviewed = concepts.filter((concept) => concept.reviewedAt || concept.reviewNotes);

  const buildMs = built.map((concept) => concept.buildMs).filter((value): value is number => typeof value === "number");
  const cost = concepts.reduce((total, concept) => total + Number(concept.buildCostUsd), 0);
  const revenue = concepts.reduce((total, concept) => total + Number(concept.revenueUsd ?? 0), 0);

  const byStage: Record<string, number> = {};
  for (const concept of concepts) byStage[concept.stage] = (byStage[concept.stage] ?? 0) + 1;

  return {
    leads: concepts.length,
    built: built.length,
    firstPassRate: rate(checked.filter((concept) => concept.firstPassOk).length, checked.length),
    averageCheckAttempts: checked.length ? Number((checked.reduce((total, concept) => total + concept.checkAttempts, 0) / checked.length).toFixed(2)) : null,
    averageBuildSeconds: buildMs.length ? Number((buildMs.reduce((total, value) => total + value, 0) / buildMs.length / 1000).toFixed(1)) : null,
    totalBuildCostUsd: Number(cost.toFixed(4)),
    averageBuildCostUsd: built.length ? Number((cost / built.length).toFixed(4)) : null,
    rebuilds: concepts.reduce((total, concept) => total + concept.rebuilds, 0),
    reviewed: reviewed.length,
    reviewPassRate: rate(concepts.filter((concept) => concept.reviewedAt).length, reviewed.length),
    approved: concepts.filter((concept) => concept.approvedAt).length,
    sent: concepts.filter((concept) => concept.sentAt).length,
    uncertainSends: concepts.filter((concept) => concept.sendUncertain).length,
    replies: concepts.filter((concept) => concept.repliedAt || replied.has(concept.leadId)).length,
    meetings: concepts.filter((concept) => concept.meetingAt).length,
    proposalsAccepted: concepts.filter((concept) => concept.proposalAcceptedAt || accepted.has(concept.leadId)).length,
    revenueUsd: Number(revenue.toFixed(2)),
    returnOnBuildCost: cost > 0 ? Number((revenue / cost).toFixed(2)) : null,
    byStage,
  };
}
