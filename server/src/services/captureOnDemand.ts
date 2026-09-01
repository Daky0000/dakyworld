import type { ScraperRun } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { getActorSchema } from "../lib/apify.js";
import { UNTRUSTED_CONTENT_RULE } from "../lib/untrusted.js";
import { TASK_KINDS, actorInput, checkForTask, resolveActor, type CaptureTask } from "./captureActors.js";
import { capabilityFor, maxRunsPerTask, type Capability } from "./actorCapabilities.js";
import { readCaptureConfig } from "./captureConfig.js";
import { estimateCost } from "./captureCost.js";
import {
  CaptureBudgetError,
  CaptureBusyError,
  ScrapeInProgressError,
  assertCanRun,
  runSource,
} from "./scraperRunner.js";

/**
 * Capture, started by an agent, on demand.
 *
 * The gap this closes is narrow and was total. `capture.run` has always
 * existed, and it takes a `sourceId` — a lead source somebody configured by
 * hand on the Lead Sources screen. So the Lead Capture Runner, whose whole
 * written process is "estimate it, run it, compare what came back with the
 * estimate", could estimate and could compare and could not run anything that
 * did not already exist. `capture.plan` reads "dental clinics in Kumasi" into
 * a plan and then stops, by design, because a plan is what a person confirms.
 * An agent had no confirming step and therefore no way through.
 *
 * Quick capture already solved exactly this for a person pasting a link: it
 * builds a throwaway source, runs it, and lets the run's own machinery file
 * the leads. This is that path, made available to an agent with the four
 * things an agent needs and a person does not — a capability switch, ceilings
 * on generated parameters, a bounded wait, and a per-task run limit.
 *
 * ## What it deliberately does not do
 *
 * **It does not talk to Apify.** It builds a source and calls `runSource`,
 * which means an agent's capture gets the identical lifecycle a scheduled one
 * gets: the cost ceiling derived from the actor's live pricing, the proxy
 * field the actor actually declares, the detached poller, the ingestion into
 * leads with its scoring and dedupe, the diagnostics that say why forty rows
 * became no leads, the resume after a deploy, and the failure notification.
 * A second path to Apify would have had none of that and would have needed all
 * of it.
 *
 * **It does not hand the dataset to the model.** An actor's rows are wide,
 * repetitive and occasionally enormous; what comes back here is the leads that
 * were actually filed, in a handful of fields, capped. The rest is in the
 * pipeline where `lead.read` can page through it.
 */

/** The vocabulary an agent gets back. Every refusal is one of these. */
export type CaptureErrorCode =
  | "ACTOR_DISABLED"
  | "INVALID_INPUT"
  | "USAGE_LIMIT_REACHED"
  | "CAPTURE_BUSY"
  | "BUDGET_REACHED"
  | "ACTOR_START_FAILED";

export class CaptureRefused extends Error {
  code: CaptureErrorCode;
  /** What the caller could do about it, when there is something. */
  detail?: unknown;
  constructor(code: CaptureErrorCode, message: string, detail?: unknown) {
    super(message);
    this.name = "CaptureRefused";
    this.code = code;
    this.detail = detail;
  }
}

export interface CaptureRequest {
  kind: CaptureTask;
  /** Search phrases, site addresses, page URLs or handles — whatever the task takes. */
  values: string[];
  /** What the agent asked for. Capped at the capability's ceiling. */
  maxResults?: number;
  /** Names the list these land in, on the Leads screen. */
  label?: string;
  /** Run it even if these targets were captured recently. */
  fresh?: boolean;
  /** How long to wait for rows before handing back a run id. Capped too. */
  waitSecs?: number;
  /** The task this belongs to, for the per-task run ceiling. Null for a person. */
  taskId?: string | null;
}

/** One captured business, in the fields worth putting in a model's context. */
export interface CapturedLead {
  id: string;
  company: string | null;
  contact: string;
  website: string | null;
  email: string | null;
  phone: string | null;
  city: string | null;
  category: string | null;
  rating: number | null;
  reviews: number | null;
  score: number;
  /** True when this row was already in the pipeline and was not captured now. */
  known: boolean;
}

export interface CaptureOutcome {
  status: "DONE" | "RUNNING" | "CACHED" | "NOTHING_TO_DO";
  /**
   * Null only on a collected run whose actor is no longer paired with any
   * capability — the Owner swapped it between the run and the collection.
   * Said as null rather than guessed: the leads are still the leads, and a
   * wrong label on them is worse than no label.
   */
  kind: CaptureTask | null;
  actorId: string;
  /** Null when everything was served from what was already captured. */
  runId: string | null;
  /** The list the results are in, so `lead.read` can page through the rest. */
  groupId: string | null;
  /** Targets that actually ran, after validation and capping. */
  ran: string[];
  /** Targets refused before anything was charged, each with the reason. */
  rejected: Array<{ value: string; problem: string; runInsteadAs: CaptureTask | null }>;
  /** Said out loud when a generated parameter was brought back inside a ceiling. */
  capped: string[];
  /** Served from an earlier capture rather than a new run. */
  reused: string[];
  estimateUsd: number | null;
  costUsd: number | null;
  found: number;
  leads: CapturedLead[];
  /** How many more are in the list than are printed here. */
  more: number;
  /** Everything a person or an agent should know that is not a number. */
  notes: string[];
  /** The standing rule about text somebody else wrote. Travels with the rows. */
  contentWarning: string;
}

/** How many leads go back to the model. The rest are in the list. */
const MAX_LEADS_RETURNED = 25;
const POLL_MS = 4_000;

/**
 * Which input key carries the per-run row cap for this task's actor.
 *
 * Actors cap themselves from their own input, not from Apify's `maxItems` —
 * which pay-per-event actors ignore entirely — so an agent asking for 20
 * results has to be translated into the key its actor reads. An actor with no
 * such key gets nothing added: an undeclared key is silently dropped by Apify,
 * and a cap that looks set and is not is worse than no cap, because the source
 * editor prints it back.
 */
const RESULT_CAP_KEY: Partial<Record<CaptureTask, string>> = {
  MAPS_SEARCH: "maxCrawledPlacesPerSearch",
  WEBSITE: "maxRequests",
};

/**
 * Leads already captured for these targets, recently enough to reuse.
 *
 * Matched on the website host for a site sweep and on the stored social link
 * for the three networks, because that is the only thing about a captured lead
 * that corresponds to what was asked for. Deliberately narrow: a near match is
 * a different business, and serving one would attach somebody else's contact
 * details to a name.
 *
 * **And matched on the actor that captured it.** A Google Maps run files a
 * lead carrying that business's website, and without this the very next
 * `capture.read` of that website is served from it — so an agent asking to
 * sweep the site for an address is handed the Maps row that had no address in
 * it and told the sweep was already done. The two captures return genuinely
 * different fields off genuinely different pages; only a capture by the same
 * actor answers the same question. Swapping the paired actor therefore also
 * invalidates the cache, which is right: a different actor reads a different
 * set of fields.
 */
async function alreadyCaptured(
  kind: CaptureTask,
  actorId: string,
  values: string[],
  hours: number,
): Promise<Map<string, CapturedLead>> {
  const found = new Map<string, CapturedLead>();
  if (hours <= 0 || values.length === 0) return found;
  const since = new Date(Date.now() - hours * 3_600_000);

  for (const value of values) {
    const where =
      kind === "WEBSITE"
        ? { website: { contains: hostOf(value), mode: "insensitive" as const } }
        : { socialLinks: { path: [networkKey(kind)], string_contains: socialNeedle(kind, value) } };

    const lead = await prisma.lead
      .findFirst({
        where: { ...where, updatedAt: { gte: since }, scraperSource: { actorId } },
        orderBy: { updatedAt: "desc" },
        select: LEAD_FIELDS,
      })
      .catch(() => null);
    if (lead) found.set(value, toCapturedLead(lead, true));
  }
  return found;
}

function hostOf(value: string): string {
  try {
    return new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`).hostname.replace(/^www\./i, "");
  } catch {
    return value;
  }
}

const networkKey = (kind: CaptureTask): string =>
  kind === "LINKEDIN_COMPANY" ? "linkedin" : kind === "FACEBOOK_PAGE" ? "facebook" : "instagram";

/** The part of a social address that identifies the account, whatever form it arrived in. */
function socialNeedle(kind: CaptureTask, value: string): string {
  if (kind === "INSTAGRAM") return value.replace(/^@/, "");
  const parts = value.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || value;
}

const LEAD_FIELDS = {
  id: true,
  companyName: true,
  contactName: true,
  website: true,
  contactEmail: true,
  contactPhone: true,
  city: true,
  category: true,
  rating: true,
  reviewsCount: true,
  leadScore: true,
} as const;

type LeadRow = { [K in keyof typeof LEAD_FIELDS]: unknown };

function toCapturedLead(lead: LeadRow, known: boolean): CapturedLead {
  return {
    id: String(lead.id),
    company: (lead.companyName as string | null) ?? null,
    contact: String(lead.contactName ?? ""),
    website: (lead.website as string | null) ?? null,
    email: (lead.contactEmail as string | null) ?? null,
    phone: (lead.contactPhone as string | null) ?? null,
    city: (lead.city as string | null) ?? null,
    category: (lead.category as string | null) ?? null,
    rating: lead.rating == null ? null : Number(lead.rating),
    reviews: (lead.reviewsCount as number | null) ?? null,
    score: Number(lead.leadScore ?? 0),
    known,
  };
}

/**
 * How many actor runs this task has already started.
 *
 * Counted off the audit trail rather than a counter of its own, which means it
 * cannot drift from what actually happened and survives a restart mid-task.
 * Dry runs and refusals do not count: neither of them started anything.
 */
async function runsAlreadyStarted(taskId: string): Promise<number> {
  return prisma.toolCall.count({
    where: { taskId, ok: true, dryRun: false, tool: { in: [...CAPTURE_TOOL_KEYS] } },
  });
}

/** The catalogue keys that start an actor. Kept here so the ceiling counts all of them. */
export const CAPTURE_TOOL_KEYS = ["capture.find", "capture.read", "capture.run"] as const;

export async function runCapture(request: CaptureRequest): Promise<CaptureOutcome> {
  const capability = await capabilityFor(request.kind);
  if (!capability.enabled) {
    throw new CaptureRefused(
      "ACTOR_DISABLED",
      `${capability.label} capture is switched off. An Owner can turn it back on under Settings → Lead capture.`,
    );
  }

  const notes: string[] = [];
  const capped: string[] = [];

  // 1. Validate every value against the task it was given, before a penny.
  //    `checkForTask` also normalises — a pasted Instagram URL becomes the
  //    handle its actor actually takes.
  const rejected: CaptureOutcome["rejected"] = [];
  const usable: string[] = [];
  const seen = new Set<string>();
  for (const raw of request.values) {
    const checked = checkForTask(request.kind, raw);
    if (checked.problem) {
      rejected.push({ value: raw, problem: checked.problem, runInsteadAs: checked.suggestion });
      continue;
    }
    const key = checked.value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    usable.push(checked.value);
  }

  if (usable.length === 0) {
    throw new CaptureRefused(
      "INVALID_INPUT",
      rejected.length > 0
        ? `Nothing here can be run as ${capability.label}: ${rejected[0].problem}`
        : `Nothing to capture — no targets were given.`,
      { rejected },
    );
  }

  // 2. Bring the generated parameters inside the ceilings. Capped rather than
  //    refused: a run of 120 when 500 was asked for is the work getting done.
  let targets = usable;
  if (targets.length > capability.maxTargets) {
    capped.push(`${usable.length} targets asked for; ${capability.maxTargets} is the most one ${capability.label} call may run, so the rest were left.`);
    targets = targets.slice(0, capability.maxTargets);
  }
  const askedResults = request.maxResults ?? capability.maxResults;
  const maxResults = Math.max(1, Math.min(askedResults, capability.maxResults));
  if (askedResults > capability.maxResults) {
    capped.push(`${askedResults} results asked for; capped at ${capability.maxResults} for ${capability.label}.`);
  }
  const waitMs = Math.min(request.waitSecs ?? capability.waitSecs, capability.waitSecs) * 1000;

  // 3. Reuse what is already here. Only for capabilities whose targets are
  //    named — see `cacheHours` in actorCapabilities.ts for why a search is
  //    never served from cache.
  const reuse = request.fresh
    ? new Map<string, CapturedLead>()
    : await alreadyCaptured(request.kind, capability.actorId, targets, capability.cacheHours);
  const toRun = targets.filter((value) => !reuse.has(value));
  if (reuse.size > 0) {
    notes.push(
      `${reuse.size} of these ${reuse.size === 1 ? "was" : "were"} captured within the last ${capability.cacheHours} hours, so ${reuse.size === 1 ? "it was" : "they were"} read from the pipeline instead of being scraped again. Pass fresh to override.`,
    );
  }

  if (toRun.length === 0) {
    const leads = [...reuse.values()];
    return {
      status: "CACHED",
      kind: request.kind,
      actorId: capability.actorId,
      runId: null,
      groupId: null,
      ran: [],
      rejected,
      capped,
      reused: [...reuse.keys()],
      estimateUsd: 0,
      costUsd: 0,
      found: leads.length,
      leads,
      more: 0,
      notes,
      contentWarning: UNTRUSTED_CONTENT_RULE,
    };
  }

  // 4. The per-task ceiling. Neither the monthly budget nor the per-run charge
  //    cap stops an agent starting a hundred small runs in one night; this
  //    does, and it is counted off the audit trail so it survives a restart.
  if (request.taskId) {
    const ceiling = await maxRunsPerTask();
    const already = await runsAlreadyStarted(request.taskId);
    if (already >= ceiling) {
      throw new CaptureRefused(
        "USAGE_LIMIT_REACHED",
        `This task has already started ${already} capture run(s), which is the limit. Work with what has been captured, or hand the rest on as a new task.`,
      );
    }
  }

  // 5. Price it, then check the guards that spend money — concurrency and the
  //    month's budget — before writing anything.
  const config = await readCaptureConfig();
  const actor = await resolveActor(request.kind);
  const input = withResultCap(actorInput(actor, toRun), request.kind, maxResults);
  const schema = await getActorSchema(actor.actorId).catch(() => null);
  const estimate = await estimateCost(actor.actorId, input, maxResults, schema?.properties ?? null).catch(() => null);

  try {
    await assertCanRun(config);
  } catch (err) {
    if (err instanceof CaptureBudgetError) throw new CaptureRefused("BUDGET_REACHED", err.message);
    if (err instanceof CaptureBusyError || err instanceof ScrapeInProgressError) {
      throw new CaptureRefused("CAPTURE_BUSY", err.message);
    }
    throw err;
  }

  // 6. A throwaway source, exactly as Quick capture makes one — so the run
  //    gets the whole configured lifecycle rather than a second copy of it.
  const label = request.label?.trim() || defaultLabel(request.kind, toRun);
  const source = await prisma.scraperSource.create({
    data: {
      name: `${label} · ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
      actorId: actor.actorId,
      input: input as object,
      preset: actor.preset,
      leadSource: actor.leadSource,
      groupName: label,
      adhoc: true,
      enabled: true,
      scheduleEnabled: false,
      maxItems: maxResults,
      // An agent asked for these specific businesses. A score floor here would
      // silently drop the ones it asked about, and it would have no way to
      // find out that it had.
      minScore: 0,
    },
  });

  let run: ScraperRun;
  try {
    run = await runSource(source.id, "MANUAL");
  } catch (err) {
    // `runSource` turns an Apify refusal into a FAILED run rather than a throw,
    // so anything caught here happened *before* a run row existed — the guards
    // re-checked inside it, which the pre-flight `assertCanRun` above can lose a
    // race to. The throwaway source has nothing hanging off it in that case, and
    // leaving it behind fills the Lead capture screen with sources that never
    // ran. Deleting it must never mask the real error.
    await prisma.scraperSource.delete({ where: { id: source.id } }).catch(() => null);
    if (err instanceof CaptureBudgetError) throw new CaptureRefused("BUDGET_REACHED", err.message);
    if (err instanceof CaptureBusyError || err instanceof ScrapeInProgressError) {
      throw new CaptureRefused("CAPTURE_BUSY", err.message);
    }
    throw new CaptureRefused("ACTOR_START_FAILED", (err as Error).message);
  }

  // 7. Wait, but only for as long as the capability allows. Past that the run
  //    carries on and files its leads on its own; the agent is given the run
  //    id and collects it with `capture.result`.
  const finished = await waitForRun(run.id, waitMs);
  const leads = await leadsFrom(finished.id);
  const reused = [...reuse.values()];
  const all = [...reused, ...leads];

  if (finished.error) notes.push(finished.error);
  if (finished.status === "SUCCEEDED" && leads.length === 0) {
    notes.push(diagnosisOf(finished) ?? "The run finished and produced no usable leads.");
  }

  return {
    status: finished.status === "QUEUED" || finished.status === "RUNNING" ? "RUNNING" : all.length > 0 ? "DONE" : "NOTHING_TO_DO",
    kind: request.kind,
    actorId: actor.actorId,
    runId: finished.id,
    groupId: await groupOf(finished.id),
    ran: toRun,
    rejected,
    capped,
    reused: [...reuse.keys()],
    estimateUsd: estimate?.totalUsd ?? null,
    costUsd: finished.costUsd ?? null,
    found: all.length,
    leads: all.slice(0, MAX_LEADS_RETURNED),
    more: Math.max(0, all.length - MAX_LEADS_RETURNED),
    notes:
      finished.status === "QUEUED" || finished.status === "RUNNING"
        ? [
            ...notes,
            `Still running after ${Math.round(waitMs / 1000)} seconds. It has not been stopped — the leads will file themselves. Collect them with capture.result and this run id.`,
          ]
        : notes,
    contentWarning: UNTRUSTED_CONTENT_RULE,
  };
}

/** Adds the row cap under whichever key this task's actor reads it from. */
function withResultCap(input: Record<string, unknown>, kind: CaptureTask, maxResults: number): Record<string, unknown> {
  const key = RESULT_CAP_KEY[kind];
  if (!key) return input;
  // Never *raise* what the shipped input already sets: those numbers were
  // chosen against the actor's own pricing, and an agent asking for more
  // should be capped by the capability rather than by silence here.
  const existing = Number(input[key]);
  const value = Number.isFinite(existing) && existing > 0 ? Math.min(existing, maxResults) : maxResults;
  return { ...input, [key]: value };
}

function defaultLabel(kind: CaptureTask, values: string[]): string {
  const first = values[0] ?? "";
  if (kind === "MAPS_SEARCH") return first.slice(0, 60) || "Search";
  return `${values.length} ${values.length === 1 ? "target" : "targets"}`;
}

async function waitForRun(runId: string, waitMs: number): Promise<ScraperRun> {
  const giveUpAt = Date.now() + waitMs;
  let run = await prisma.scraperRun.findUniqueOrThrow({ where: { id: runId } });
  while ((run.status === "QUEUED" || run.status === "RUNNING") && Date.now() < giveUpAt) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    run = await prisma.scraperRun.findUniqueOrThrow({ where: { id: runId } });
  }
  return run;
}

async function leadsFrom(runId: string): Promise<CapturedLead[]> {
  const rows = await prisma.lead.findMany({
    where: { scraperRunId: runId },
    orderBy: { leadScore: "desc" },
    take: 200,
    select: LEAD_FIELDS,
  });
  return rows.map((row) => toCapturedLead(row, false));
}

async function groupOf(runId: string): Promise<string | null> {
  const lead = await prisma.lead.findFirst({ where: { scraperRunId: runId }, select: { groupId: true } });
  return lead?.groupId ?? null;
}

/**
 * The run's own account of why its rows became no leads.
 *
 * Written by `ingestItems` and normally read only by the Lead capture screen.
 * An agent that captured forty rows and was handed no businesses needs the
 * same sentence, or it will report that the search found nothing — which is a
 * claim about the market rather than about a mapper that could not read the
 * shape.
 */
function diagnosisOf(run: ScraperRun): string | null {
  const diagnostics = run.diagnostics as { dropped?: Array<{ reason: string; count: number }> } | null;
  const dropped = diagnostics?.dropped ?? [];
  if (dropped.length === 0) return null;
  return `${run.itemsFetched} row(s) came back and none became a lead: ${dropped
    .map((entry) => `${entry.count} ${entry.reason}`)
    .join("; ")}.`;
}

/** Collects a run started earlier — the other half of the bounded wait. */
export async function collectCapture(runId: string): Promise<CaptureOutcome> {
  const run = await prisma.scraperRun.findUnique({ where: { id: runId }, include: { source: true } });
  if (!run) throw new CaptureRefused("INVALID_INPUT", `There is no capture run with the id ${runId}.`);

  const leads = await leadsFrom(run.id);
  const notes: string[] = [];
  if (run.error) notes.push(run.error);
  if (run.status === "QUEUED" || run.status === "RUNNING") notes.push("Still running. Try again shortly.");
  else if (run.status === "SUCCEEDED" && leads.length === 0) {
    notes.push(diagnosisOf(run) ?? "The run finished and produced no usable leads.");
  }

  return {
    status: run.status === "QUEUED" || run.status === "RUNNING" ? "RUNNING" : leads.length > 0 ? "DONE" : "NOTHING_TO_DO",
    // Which task this was, resolved from the actor the run actually used rather
    // than inferred from the preset. Two of the five tasks share `AUTO`, so a
    // preset can only ever separate Maps from everything else — and a collected
    // run labelled "website" when it read an Instagram account is a sentence an
    // agent will repeat to the Owner.
    kind: await kindOfActor(run.source.actorId),
    actorId: run.source.actorId,
    runId: run.id,
    groupId: await groupOf(run.id),
    ran: [],
    rejected: [],
    capped: [],
    reused: [],
    estimateUsd: run.estimateUsd ?? null,
    costUsd: run.costUsd ?? null,
    found: leads.length,
    leads: leads.slice(0, MAX_LEADS_RETURNED),
    more: Math.max(0, leads.length - MAX_LEADS_RETURNED),
    notes,
    contentWarning: UNTRUSTED_CONTENT_RULE,
  };
}

/** The task paired with this actor right now, or null if none is. */
async function kindOfActor(actorId: string): Promise<CaptureTask | null> {
  for (const kind of TASK_KINDS) {
    const actor = await resolveActor(kind);
    if (actor.actorId === actorId) return kind;
  }
  return null;
}

/** What a capability would do, for a preview a person approves. */
export async function describeCapture(request: CaptureRequest): Promise<string> {
  const capability: Capability = await capabilityFor(request.kind);
  if (!capability.enabled) return `${capability.label} capture is switched off, so nothing would run.`;

  const checked = request.values.map((value) => checkForTask(request.kind, value));
  const usable = checked.filter((entry) => !entry.problem).map((entry) => entry.value);
  if (usable.length === 0) return `None of those can be run as ${capability.label}, so nothing would run.`;

  const targets = usable.slice(0, capability.maxTargets);
  const maxResults = Math.max(1, Math.min(request.maxResults ?? capability.maxResults, capability.maxResults));
  const actor = await resolveActor(request.kind);
  const input = withResultCap(actorInput(actor, targets), request.kind, maxResults);
  const schema = await getActorSchema(actor.actorId).catch(() => null);
  const estimate = await estimateCost(actor.actorId, input, maxResults, schema?.properties ?? null).catch(() => null);
  const cost = estimate?.totalUsd == null ? "an amount Apify wouldn't quote" : `about $${estimate.totalUsd.toFixed(2)}`;

  return (
    `Run ${actor.actorId} over ${targets.length} ${capability.label} target(s) — ${targets.slice(0, 3).join(", ")}` +
    `${targets.length > 3 ? `, and ${targets.length - 3} more` : ""} — for up to ${maxResults} result(s), costing ${cost}. ` +
    `Anything it finds is filed as leads.`
  );
}
