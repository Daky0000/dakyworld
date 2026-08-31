import type { LeadHunt, LeadThesis, Prisma, ScraperRunTrigger } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { parseScheduleTime, safeZone, zonedDateParts, zonedTimeToUtc } from "../../lib/timezone.js";
import { CaptureBudgetError, CaptureBusyError, ScrapeInProgressError, runSource } from "../scraperRunner.js";
import { prepareLeads } from "../leadPrep.js";
import { deleteLeads } from "../leadBulk.js";
import { registerTags } from "../leadTags.js";
import { recordCreated } from "../agents/state.js";
import { judge, type Judgement } from "./judge.js";
import type { SignalEvidence } from "./signals.js";
import { thesisForPrompt } from "./theses.js";

/**
 * One hunt: search, look, judge, keep or delete.
 *
 * The shape of this is the point, so it is worth stating plainly before the
 * code. A hunt is **five businesses at a time, twice a day** — not because
 * five is a magic number but because every one of them is genuinely looked at,
 * and looking costs money and takes a minute. A hundred unexamined rows in the
 * pipeline is not a hundred leads, it is a hundred strangers; five audited ones
 * are five conversations somebody can actually have.
 *
 * ## The order, and why it is this order
 *
 * 1. **Spend nothing you do not have to.** Candidates already captured and
 *    never judged are used first. A new Apify run only happens when there are
 *    not enough of those — which, after the first week, is most days.
 * 2. **Check the tombstones before looking at anything.** A business already
 *    judged under this thesis is skipped before it costs a penny. Without this
 *    the same rejected company is re-found, re-audited and re-rejected twice a
 *    day for ever, and the only visible symptom is the bill.
 * 3. **Look, then decide.** `prepareLeads` does the research, the audit, the
 *    screenshot and the read of the homepage in as few Apify runs as it can.
 *    The judge only ever sees evidence that was actually gathered.
 * 4. **Decide out loud.** Every verdict is written with the signals that fired
 *    and the sentence behind them, and that row outlives the lead.
 * 5. **Route what fits, delete what does not.** A qualified business becomes a
 *    task for a named agent at a named priority. A rejected one is deleted and
 *    its tombstone kept.
 *
 * ## What it will not do
 *
 * It will not delete a lead that has a proposal against it — `deleteLeads`
 * refuses those and says so. It will not delete an `UNDECIDED` one, because
 * "we could not check" is not a finding about the business. And it will not
 * start a second hunt for a thesis that already has one running.
 */

/** How long to wait for Apify before giving up on this cycle and keeping what arrived. */
const CAPTURE_TIMEOUT_MS = 12 * 60_000;
const POLL_MS = 10_000;

/** A slot missed by more than this was missed during an outage. Skip it. */
const MAX_CATCHUP_MS = 6 * 60 * 60_000;

/** Theses currently mid-cycle in this process. One hunt per thesis, like one task per agent. */
const hunting = new Set<string>();

// --- The clock -------------------------------------------------------------

/** The next instant this thesis should hunt, strictly after `from`. */
export function nextHuntAt(
  thesis: Pick<LeadThesis, "enabled" | "runTimes" | "timezone">,
  from = new Date(),
): Date | null {
  if (!thesis.enabled || thesis.runTimes.length === 0) return null;
  const zone = safeZone(thesis.timezone);
  const [year, month, day] = zonedDateParts(from, zone);

  let earliest: Date | null = null;
  for (const dayOffset of [0, 1]) {
    for (const raw of thesis.runTimes) {
      const time = parseScheduleTime(raw);
      if (!time) continue;
      const candidate = zonedTimeToUtc(year, month, day + dayOffset, time.hour, time.minute, zone);
      if (candidate.getTime() > from.getTime() && (!earliest || candidate < earliest)) earliest = candidate;
    }
  }
  return earliest;
}

/** Recomputes and stores `nextRunAt`. Call after any change to a thesis's schedule. */
export async function syncThesis(id: string): Promise<Date | null> {
  const thesis = await prisma.leadThesis.findUnique({ where: { id } });
  if (!thesis) return null;
  const nextRunAt = nextHuntAt(thesis);
  await prisma.leadThesis.update({ where: { id }, data: { nextRunAt } });
  return nextRunAt;
}

/**
 * Starts whichever hunts are due.
 *
 * Joins the minute tick beside lead capture and standing work, and keeps their
 * discipline exactly: **the slot is spent before the work starts**, so a hunt
 * that throws cannot be retried in a loop and a restart cannot fire the same
 * slot twice. The cycle itself is not awaited — it takes minutes, and holding
 * the tick open for it would stop an invoice going out.
 */
export async function runDueHunts(now = new Date()): Promise<number> {
  const unscheduled = await prisma.leadThesis.findMany({ where: { enabled: true, nextRunAt: null } });
  for (const thesis of unscheduled) {
    await prisma.leadThesis.update({ where: { id: thesis.id }, data: { nextRunAt: nextHuntAt(thesis, now) } });
  }

  const due = await prisma.leadThesis.findMany({ where: { enabled: true, nextRunAt: { lte: now } } });
  if (due.length === 0) return 0;

  let started = 0;
  for (const thesis of due) {
    const slot = thesis.nextRunAt;
    await prisma.leadThesis.update({
      where: { id: thesis.id },
      data: { nextRunAt: nextHuntAt(thesis, now), lastRunAt: now },
    });

    if (slot && now.getTime() - slot.getTime() > MAX_CATCHUP_MS) {
      console.warn(`[hunt] skipping "${thesis.name}" — its ${slot.toISOString()} slot is more than six hours stale.`);
      continue;
    }
    if (hunting.has(thesis.id)) {
      console.warn(`[hunt] "${thesis.name}" is still working through its last cycle — not starting another.`);
      continue;
    }

    started += 1;
    void hunt(thesis.id, "SCHEDULED").catch((err) => console.error(`[hunt] "${thesis.name}" failed:`, err));
  }
  return started;
}

// --- One cycle -------------------------------------------------------------

export interface HuntOutcome {
  huntId: string;
  captured: number;
  audited: number;
  qualified: number;
  rejected: number;
  skipped: number;
  routed: number;
  costUsd: number;
  summary: string;
}

export class HuntBusyError extends Error {
  constructor(name: string) {
    super(`"${name}" is already hunting. Wait for that cycle to finish.`);
    this.name = "HuntBusyError";
  }
}

export async function hunt(thesisId: string, trigger: ScraperRunTrigger = "MANUAL"): Promise<HuntOutcome> {
  const thesis = await prisma.leadThesis.findUnique({ where: { id: thesisId } });
  if (!thesis) throw new Error("That thesis does not exist.");
  if (hunting.has(thesisId)) throw new HuntBusyError(thesis.name);

  hunting.add(thesisId);
  const record = await prisma.leadHunt.create({ data: { thesisId, trigger, status: "RUNNING" } });

  try {
    const outcome = await cycle(thesis, record);
    return outcome;
  } catch (err) {
    const message = (err as Error).message;
    await prisma.leadHunt.update({
      where: { id: record.id },
      data: { status: "FAILED", error: message, finishedAt: new Date() },
    });
    throw err;
  } finally {
    hunting.delete(thesisId);
  }
}

async function cycle(thesis: LeadThesis, record: LeadHunt): Promise<HuntOutcome> {
  let costUsd = 0;
  let captured = 0;
  let scraperRunId: string | null = null;

  // 1. What is already on hand and has never been judged under this thesis.
  let candidates = await unjudged(thesis);

  // 2. Only if that is not enough does anything get paid for.
  if (candidates.length < thesis.leadsPerRun && thesis.sourceId) {
    const run = await capture(thesis);
    if (run) {
      scraperRunId = run.id;
      captured = run.leadsCreated + run.leadsUpdated;
      costUsd += run.costUsd ?? 0;
      candidates = await unjudged(thesis);
    }
  }

  // 3. Businesses already decided about, skipped before they cost anything.
  const { fresh, skipped } = await dropAlreadyJudged(thesis, candidates);
  const batch = fresh.slice(0, thesis.leadsPerRun);

  await prisma.leadHunt.update({
    where: { id: record.id },
    data: { captured, skipped, scraperRunId },
  });

  if (batch.length === 0) {
    const summary =
      skipped > 0
        ? `Nothing new to look at — every business this search returned has already been judged under "${thesis.name}".`
        : `Nothing to look at. The search returned no businesses this hunt had not already seen.`;
    await prisma.leadHunt.update({
      where: { id: record.id },
      data: { status: "SUCCEEDED", finishedAt: new Date(), summary, costUsd: costUsd as unknown as Prisma.Decimal },
    });
    return { huntId: record.id, captured, audited: 0, qualified: 0, rejected: 0, skipped, routed: 0, costUsd, summary };
  }

  // 4. Look at them. One call, so the screenshots batch into as few Apify runs
  //    as they can — five homepages is one boot, not five.
  const prepared = await prepareLeads(
    batch.map((lead) => lead.id),
    { withAuditTeam: false },
  );
  costUsd += prepared.costUsd;

  const byLead = new Map(prepared.prepared.map((entry) => [entry.leadId, entry]));

  // 5. Judge, one at a time, and write down why.
  let qualified = 0;
  let rejected = 0;
  let routed = 0;
  let undecided = 0;
  // Businesses the judge could not be asked about at all — counted, because a
  // silent `continue` here is how five businesses looked at became a hunt that
  // reported on two and called itself a success.
  let unjudgeable = 0;
  const toDelete: string[] = [];

  for (const lead of batch) {
    const prep = byLead.get(lead.id) ?? null;
    const evidence: SignalEvidence = {
      lead: {
        website: lead.website,
        contactEmail: lead.contactEmail,
        contactPhone: lead.contactPhone,
        companyName: lead.companyName,
        category: lead.category,
        city: lead.city,
        rating: lead.rating == null ? null : Number(lead.rating),
        reviewsCount: lead.reviewsCount,
        socialLinks: (lead.socialLinks ?? null) as Record<string, string> | null,
        clientId: lead.clientId,
      },
      audit: prep?.audit ?? null,
      look: prep?.look ?? null,
    };

    let verdict: Judgement;
    try {
      verdict = await judge({ thesis, evidence, facts: prep?.facts ?? [] });
    } catch (err) {
      // A judge that could not run is not a verdict. The lead stays exactly
      // where it is and the next hunt tries again — the one outcome that is
      // never allowed here is deleting a business because a model was down.
      console.error(`[hunt] could not judge ${lead.id}:`, (err as Error).message);
      unjudgeable += 1;
      continue;
    }
    costUsd += verdict.costUsd;

    await writeVerdict(thesis, record, lead, verdict);

    if (verdict.verdict === "QUALIFIED") {
      qualified += 1;
      await acceptLead(thesis, lead.id, verdict);
      if (await route(thesis, lead, verdict)) routed += 1;
    } else if (verdict.verdict === "REJECTED") {
      rejected += 1;
      if (thesis.deleteRejected) toDelete.push(lead.id);
      else await prisma.lead.update({ where: { id: lead.id }, data: { status: "DISQUALIFIED", winLossReason: verdict.reason } });
    } else {
      undecided += 1;
    }
  }

  // 6. The deletions, in one pass. `deleteLeads` keeps back anything with a
  //    priced document against it and says which — the tombstone is already
  //    written either way, so a business kept back is still never re-audited.
  let deleted = 0;
  const keptBack: string[] = [];
  if (toDelete.length > 0) {
    const result = await deleteLeads({ ids: toDelete });
    deleted = result.deleted;
    for (const kept of result.keptWithProposals) keptBack.push(kept.name);
    if (deleted > 0) {
      await prisma.leadVerdict.updateMany({
        where: { huntId: record.id, leadId: { in: toDelete }, verdict: "REJECTED" },
        data: { deleted: true },
      });
    }
  }

  const report = huntReport({
    thesisName: thesis.name,
    looked: batch.length,
    qualified,
    rejected,
    undecided,
    unjudgeable,
    deleted,
    keptBack,
    routed,
    skipped,
    costUsd,
  });
  const { audited, summary } = report;

  await prisma.leadHunt.update({
    where: { id: record.id },
    data: {
      status: report.status,
      finishedAt: new Date(),
      audited,
      qualified,
      rejected,
      routed,
      summary,
      costUsd: costUsd as unknown as Prisma.Decimal,
    },
  });

  return { huntId: record.id, captured, audited, qualified, rejected, skipped, routed, costUsd, summary };
}

/**
 * What a finished cycle says about itself.
 *
 * Its own function because it is the half of a hunt that has to be honest and
 * the half that cannot be exercised any other way: everything above it needs
 * Apify, a screenshot and a model, and this needs nothing. Two rules live here.
 *
 * **`audited` is what was judged, not what was paid to be looked at.** A
 * business whose judge call threw cost money at Apify and produced no verdict.
 * Counting it would make qualified + rejected + undecided fail to add up to
 * audited, which is the arithmetic somebody reading the screen does first —
 * and the missing ones would be invisible.
 *
 * **Anything unfinished makes the run PARTIAL.** A hunt that judged two of
 * five and called itself SUCCEEDED is how a model being unreachable for an
 * afternoon comes to look exactly like a thesis nobody qualifies under. The
 * leads keep their place and no verdict is written against them, so the next
 * hunt looks again — but the run has to say so.
 */
export function huntReport(counts: {
  thesisName: string;
  /** How many businesses this cycle set out to judge. */
  looked: number;
  qualified: number;
  rejected: number;
  /** The judge ran and could not decide. A finding about the evidence. */
  undecided: number;
  /** The judge could not be asked. Not a finding about anything. */
  unjudgeable: number;
  deleted: number;
  keptBack: string[];
  routed: number;
  skipped: number;
  costUsd: number;
}): { status: "SUCCEEDED" | "PARTIAL"; audited: number; summary: string } {
  const { thesisName, looked, qualified, rejected, undecided, unjudgeable, deleted, keptBack, routed, skipped, costUsd } = counts;
  const audited = Math.max(0, looked - unjudgeable);
  const summary = [
    `Looked at ${looked} business${looked === 1 ? "" : "es"} under "${thesisName}".`,
    `${qualified} fit, ${rejected} did not${undecided > 0 ? `, ${undecided} could not be decided` : ""}.`,
    unjudgeable > 0
      ? `${unjudgeable} could not be judged at all — the model was not reachable. They keep their place and the next hunt looks again.`
      : null,
    deleted > 0 ? `${deleted} removed from the pipeline.` : null,
    keptBack.length > 0 ? `Kept back because a proposal names them: ${keptBack.join(", ")}.` : null,
    routed > 0 ? `${routed} handed on for the next step.` : null,
    skipped > 0 ? `${skipped} skipped — already judged under this thesis.` : null,
    `About $${costUsd.toFixed(2)} spent.`,
  ]
    .filter(Boolean)
    .join(" ");

  return { status: undecided > 0 || unjudgeable > 0 ? "PARTIAL" : "SUCCEEDED", audited, summary };
}

// --- The pieces ------------------------------------------------------------

/** Leads this thesis's search has produced that nothing has decided about yet. */
async function unjudged(thesis: LeadThesis) {
  if (!thesis.sourceId) return [];
  return prisma.lead.findMany({
    where: {
      scraperSourceId: thesis.sourceId,
      rehearsal: false,
      status: { in: ["NEW", "QUALIFYING"] },
      verdicts: { none: { thesisId: thesis.id } },
    },
    // Oldest first: a business captured three days ago and never looked at is
    // more overdue than one captured this morning.
    orderBy: { createdAt: "asc" },
    take: thesis.leadsPerRun * 4,
  });
}

/**
 * Starts the thesis's search and waits for it, within reason.
 *
 * Returns the run when it finished, or null when nothing could be started. A
 * capture that is over budget or already busy is the guardrail working: the
 * hunt carries on with whatever candidates it already had rather than failing.
 */
async function capture(thesis: LeadThesis) {
  if (!thesis.sourceId) return null;
  try {
    const started = await runSource(thesis.sourceId, "SCHEDULED");
    const until = Date.now() + CAPTURE_TIMEOUT_MS;
    let run = started;
    while (Date.now() < until && (run.status === "QUEUED" || run.status === "RUNNING")) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      const fresh = await prisma.scraperRun.findUnique({ where: { id: run.id } });
      if (!fresh) break;
      run = fresh;
    }
    if (run.status === "QUEUED" || run.status === "RUNNING") {
      // Not an error and not abandoned. The run carries on and files its leads
      // in its own time; the next hunt finds them sitting there as candidates.
      console.warn(`[hunt] "${thesis.name}" did not finish capturing inside ${CAPTURE_TIMEOUT_MS / 60_000} minutes — carrying on with what is on hand.`);
    }
    return run;
  } catch (err) {
    if (err instanceof CaptureBusyError || err instanceof CaptureBudgetError || err instanceof ScrapeInProgressError) {
      console.warn(`[hunt] "${thesis.name}" could not capture: ${err.message}`);
      return null;
    }
    throw err;
  }
}

/**
 * Businesses already judged under this thesis, dropped before anything is spent.
 *
 * **This is the tombstone doing its job.** A rejected lead is deleted, so
 * `dedupeKey` on the lead table cannot answer "have we seen this before" — only
 * `LeadVerdict` can, which is exactly why that row outlives the lead.
 */
async function dropAlreadyJudged<T extends { id: string; dedupeKey: string | null }>(
  thesis: LeadThesis,
  candidates: T[],
): Promise<{ fresh: T[]; skipped: number }> {
  const keys = candidates.map((lead) => lead.dedupeKey).filter((key): key is string => Boolean(key));
  if (keys.length === 0) return { fresh: candidates, skipped: 0 };

  const seen = await prisma.leadVerdict.findMany({
    where: { thesisId: thesis.id, dedupeKey: { in: keys } },
    select: { dedupeKey: true },
  });
  const known = new Set(seen.map((row) => row.dedupeKey));
  const fresh = candidates.filter((lead) => !lead.dedupeKey || !known.has(lead.dedupeKey));
  return { fresh, skipped: candidates.length - fresh.length };
}

/**
 * The verdict row — the record that outlives the lead.
 *
 * Upserted on `(thesisId, dedupeKey)` rather than created, because a business
 * with no dedupe key at all must still get a row, and two hunts can genuinely
 * reach the same business through two different captures before either deletes
 * it.
 */
async function writeVerdict(
  thesis: LeadThesis,
  record: LeadHunt,
  lead: { id: string; companyName: string | null; website: string | null; city: string | null; dedupeKey: string | null },
  verdict: Judgement,
) {
  const data = {
    thesisId: thesis.id,
    huntId: record.id,
    leadId: lead.id,
    companyName: lead.companyName,
    website: lead.website,
    city: lead.city,
    dedupeKey: lead.dedupeKey,
    verdict: verdict.verdict,
    score: verdict.score,
    signals: verdict.signals as unknown as Prisma.InputJsonValue,
    reason: verdict.note ? `${verdict.reason} (${verdict.note})` : verdict.reason,
  };

  if (!lead.dedupeKey) {
    await prisma.leadVerdict.create({ data });
    return;
  }
  await prisma.leadVerdict.upsert({
    where: { thesisId_dedupeKey: { thesisId: thesis.id, dedupeKey: lead.dedupeKey } },
    create: data,
    update: data,
  });
}

/** What happens to a business that fits: the score, the status, and a tag naming the thesis. */
async function acceptLead(thesis: LeadThesis, leadId: string, verdict: Judgement) {
  const tag = `hunt:${thesis.key}`;
  await registerTags([tag]).catch(() => null);
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { tags: true, leadScore: true } });
  const tags = [...new Set([...(lead?.tags ?? []), tag])];
  await prisma.lead.update({
    where: { id: leadId },
    data: {
      status: "QUALIFIED",
      // The judge's score is about this thesis; the mapper's is about how
      // complete the row is. The higher of the two is kept rather than one
      // silently overwriting the other.
      leadScore: Math.max(verdict.score, lead?.leadScore ?? 0),
      tags,
      discoveryNotes: undefined,
    },
  });
}

/**
 * Hands a qualified business to whoever takes it next.
 *
 * The brief carries the thesis **and the verdict**, which is the whole reason
 * this exists rather than the lead simply appearing in a list: the agent that
 * picks it up is told what we think is wrong with this business, which signals
 * fired, and what was seen. An agent that has to re-derive that spends a model
 * call working out something a rule already decided.
 *
 * Returns false when the thesis routes to nobody, or to an agent that is not
 * on the roster — which is a configuration to fix, not a reason to lose the lead.
 */
async function route(
  thesis: LeadThesis,
  lead: { id: string; companyName: string | null; contactName: string; website: string | null },
  verdict: Judgement,
): Promise<boolean> {
  if (!thesis.routeAgentKey) return false;
  const agent = await prisma.agent.findUnique({ where: { key: thesis.routeAgentKey }, select: { key: true, status: true } });
  if (!agent) {
    console.warn(`[hunt] "${thesis.name}" routes to ${thesis.routeAgentKey}, which is not on the roster.`);
    return false;
  }

  const name = lead.companyName || lead.contactName;
  const fired = verdict.signals.filter((signal) => signal.kind === "qualifier" && signal.matched === true);

  const brief = [
    `${name} came in under the hunt "${thesis.name}" and was judged a fit at ${verdict.score}.`,
    "",
    thesisForPrompt(thesis),
    "",
    "What was actually found on this business:",
    ...fired.map((signal) => `- ${signal.says}${signal.evidence ? ` — ${signal.evidence}` : ""}`),
    "",
    verdict.note ? `Note: ${verdict.note}` : "",
    "",
    "Decide the next step and who takes it. The research, the audit and the look at their homepage are already on the record — read them before deciding anything, and do not re-run what has been run.",
  ]
    .filter((line) => line !== "")
    .join("\n");

  const task = await prisma.agentTask.create({
    data: {
      agentKey: agent.key,
      title: `Next step for ${name}`,
      brief,
      origin: "EVENT",
      priority: thesis.routePriority,
      leadId: lead.id,
      input: {
        thesis: thesis.key,
        score: verdict.score,
        signals: verdict.signals as unknown as Prisma.InputJsonValue,
      } as Prisma.InputJsonValue,
    },
    select: { id: true, traceId: true, status: true },
  });
  await recordCreated(task.id, task.traceId, task.status, {
    reason: `Qualified by the hunt "${thesis.name}" at ${verdict.score}.`,
    actor: "hunt",
  });
  return true;
}
