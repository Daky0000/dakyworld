import type { Lead, LeadSource, Prisma, ScraperRun, ScraperRunStatus, ScraperRunTrigger, ScraperSource } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import {
  ApifyError,
  abortRun,
  getActorSchema,
  getDatasetItems,
  getMonthlyUsage,
  getRun,
  startRun,
  type ApifyRunStatus,
  type StartRunOptions,
} from "../lib/apify.js";
import { buildDedupeKey, mapItemToLead, scoreLead, type NormalizedLead, type Preset } from "./leadMapping.js";
import { enrolNewLeads } from "./emailSequences.js";
import { captureTokens, proxyInput, readCaptureConfig, runOptions, type CaptureConfig } from "./captureConfig.js";
import { reportRun } from "./captureNotify.js";

/**
 * Runs a configured Apify actor and turns its dataset into leads.
 *
 * A scrape takes minutes, so nothing here blocks an HTTP request: `runSource`
 * starts the Apify run, records it, and returns. A detached poller then waits
 * for the run and ingests the results, updating the ScraperRun row as it goes
 * — which is what the UI watches.
 *
 * What a run is allowed to cost, where it searches and whether it proxies all
 * come from the shared capture configuration (services/captureConfig.ts)
 * rather than from the source, so those can be changed once for everything.
 */

const POLL_FAST_MS = 5_000;
const POLL_SLOW_MS = 20_000;
const POLL_FAST_WINDOW_MS = 60_000;
/** How long the poller stays interested. Apify's own timeout is set alongside it. */
const DEFAULT_RUN_TIMEOUT_MS = 30 * 60_000;
const POLL_GRACE_MS = 2 * 60_000;

/** Runs this process is already polling, so a restart-resume can't double-attach. */
const polling = new Set<string>();

// --- Input templating ------------------------------------------------------

/**
 * `{{today}}`, `{{yesterday}}` and `{{date}}` inside string values of the
 * actor input, so a daily schedule can scrape "restaurants opened since
 * {{yesterday}}" without the Owner editing the JSON every morning.
 *
 * `extra` carries the market tokens — `{{location}}`, `{{country}}`,
 * `{{countryCode}}`, `{{language}}` — from the capture configuration, so
 * every source follows one answer to "where do we sell".
 */
export function applyInputTemplate(input: unknown, now = new Date(), extra: Record<string, string> = {}): unknown {
  const iso = (date: Date) => date.toISOString().slice(0, 10);
  const yesterday = new Date(now.getTime() - 24 * 60 * 60_000);
  const replacements: Record<string, string> = {
    date: iso(now),
    today: iso(now),
    yesterday: iso(yesterday),
    timestamp: now.toISOString(),
    ...Object.fromEntries(Object.entries(extra).map(([key, value]) => [key.toLowerCase(), value])),
  };

  const walk = (value: unknown): unknown => {
    if (typeof value === "string") {
      return value.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, token: string) => replacements[token.toLowerCase()] ?? match);
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, walk(v)]));
    }
    return value;
  };

  return walk(input);
}

export function renderGroupName(template: string | null, source: ScraperSource, now = new Date()): string {
  const base = template?.trim() || `${source.name} — {{date}}`;
  return base
    .replace(/\{\{\s*name\s*\}\}/gi, source.name)
    .replace(/\{\{\s*date\s*\}\}/gi, now.toISOString().slice(0, 10))
    .replace(/\{\{\s*month\s*\}\}/gi, now.toISOString().slice(0, 7))
    .slice(0, 120);
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^\da-z]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80) || "group"
  );
}

// --- Status mapping --------------------------------------------------------

function toRunStatus(status: ApifyRunStatus): ScraperRunStatus {
  switch (status) {
    case "READY":
      return "QUEUED";
    case "RUNNING":
    case "ABORTING":
    case "TIMING-OUT":
      return "RUNNING";
    case "SUCCEEDED":
      return "SUCCEEDED";
    case "ABORTED":
      return "ABORTED";
    case "TIMED-OUT":
      return "TIMED_OUT";
    default:
      return "FAILED";
  }
}

const TERMINAL: ApifyRunStatus[] = ["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"];

// --- Starting a run --------------------------------------------------------

export class ScrapeInProgressError extends Error {
  constructor() {
    super("This source is already running. Wait for it to finish, or stop it first.");
  }
}

/** Too many scrapes at once. Configurable under Settings → Lead capture. */
export class CaptureBusyError extends Error {
  constructor(limit: number) {
    super(
      `${limit} scrape${limit === 1 ? "" : "s"} already running, which is the limit. ` +
        `Wait for one to finish, or raise the limit under Settings → Lead capture.`,
    );
  }
}

/** The month's Apify spend has reached the ceiling set in Settings. */
export class CaptureBudgetError extends Error {
  constructor(spent: number, budget: number) {
    super(
      `This month's Apify spend ($${spent.toFixed(2)}) has reached the $${budget.toFixed(2)} budget. ` +
        `Raise it under Settings → Lead capture, or wait for the billing month to roll over.`,
    );
  }
}

/**
 * What has to be true before spending money: this source isn't already
 * running, nothing else is over-running, and the month still has budget.
 *
 * The budget check fails *open* if Apify can't be reached — a monitoring blip
 * shouldn't stop lead generation, and the run itself will fail loudly enough
 * if Apify is genuinely down.
 */
export async function assertCanRun(config: CaptureConfig, sourceId?: string) {
  if (sourceId) {
    const active = await prisma.scraperRun.findFirst({ where: { sourceId, status: { in: ["QUEUED", "RUNNING"] } } });
    if (active) throw new ScrapeInProgressError();
  }

  const running = await prisma.scraperRun.count({ where: { status: { in: ["QUEUED", "RUNNING"] } } });
  if (running >= config.maxConcurrentRuns) throw new CaptureBusyError(config.maxConcurrentRuns);

  if (config.monthlyBudgetUsd != null) {
    try {
      const usage = await getMonthlyUsage();
      if (usage.spentUsd >= config.monthlyBudgetUsd) {
        throw new CaptureBudgetError(usage.spentUsd, config.monthlyBudgetUsd);
      }
    } catch (err) {
      if (err instanceof CaptureBudgetError) throw err;
      console.warn("[scraper] Could not read Apify usage, letting the run proceed:", (err as Error).message);
    }
  }
}

/**
 * Builds the input Apify actually receives: the source's own JSON with the
 * date and market tokens filled in, plus a proxy in whichever field this
 * actor declares for one (see captureConfig.proxyInput).
 */
async function buildRunInput(source: ScraperSource, config: CaptureConfig) {
  const input = applyInputTemplate(source.input ?? {}, new Date(), captureTokens(config)) as Record<string, unknown>;
  const schema = await getActorSchema(source.actorId);
  const proxy = proxyInput(config, schema, input);
  return {
    input: proxy ? { ...input, [proxy.field]: proxy.value } : input,
    proxyField: proxy?.field ?? null,
    schema,
  };
}

/**
 * Apify enforces cost two different ways and each applies to one pricing
 * model: `maxItems` stops a pay-per-result actor at N rows, `maxTotalChargeUsd`
 * stops a pay-per-event actor at N dollars. Sending the wrong one is at best
 * ignored and at worst rejected, so the actor's own pricing decides. When the
 * pricing can't be read, `maxItems` is the safer guess — it's the older
 * parameter and the one every actor tolerates.
 */
function costCeiling(source: ScraperSource, config: CaptureConfig, pricingModel: string | null | undefined) {
  if (pricingModel === "PAY_PER_EVENT") {
    return config.maxRunChargeUsd != null ? { maxTotalChargeUsd: config.maxRunChargeUsd } : {};
  }
  return { maxItems: source.maxItems };
}

export async function runSource(sourceId: string, trigger: ScraperRunTrigger = "MANUAL") {
  const source = await prisma.scraperSource.findUnique({ where: { id: sourceId } });
  if (!source) throw new Error("Lead source not found");

  const config = await readCaptureConfig();
  await assertCanRun(config, sourceId);

  const { input, proxyField, schema } = await buildRunInput(source, config);
  const run = await prisma.scraperRun.create({
    data: { sourceId, trigger, status: "QUEUED", input: input as Prisma.InputJsonValue },
  });

  try {
    // The caps go to Apify rather than being applied to the dataset after the
    // fact, so the row limit saves money instead of only saving pipeline noise.
    const apifyRun = await startWithProxyFallback(source.actorId, input, proxyField, {
      ...runOptions(config),
      ...costCeiling(source, config, schema?.pricingModel),
    });
    const updated = await prisma.scraperRun.update({
      where: { id: run.id },
      data: { apifyRunId: apifyRun.id, datasetId: apifyRun.defaultDatasetId, status: toRunStatus(apifyRun.status) },
    });
    await prisma.scraperSource.update({ where: { id: sourceId }, data: { lastRunAt: new Date() } });
    void pollUntilDone(run.id).catch((err) => console.error(`[scraper] poll failed for run ${run.id}:`, err));
    return updated;
  } catch (err) {
    const message = err instanceof ApifyError ? err.message : (err as Error).message;
    const failed = await prisma.scraperRun.update({
      where: { id: run.id },
      data: { status: "FAILED", error: message, finishedAt: new Date() },
    });
    await notify(failed, source);
    return failed;
  }
}

/**
 * Actors publish input schemas that are sometimes out of date with the build
 * that runs, so a proxy field we read as valid can still be rejected. Rather
 * than lose the run to a field we added ourselves, drop it and go again once.
 */
async function startWithProxyFallback(
  actorId: string,
  input: Record<string, unknown>,
  proxyField: string | null,
  options: StartRunOptions,
) {
  try {
    return await startRun(actorId, input, options);
  } catch (err) {
    const rejectedOurProxy =
      proxyField != null && err instanceof ApifyError && err.status === 400 && err.message.includes(proxyField);
    if (!rejectedOurProxy) throw err;

    console.warn(`[scraper] ${actorId} rejected the injected "${proxyField}" — retrying without it.`);
    const { [proxyField]: _dropped, ...rest } = input;
    return startRun(actorId, rest, options);
  }
}

export async function stopRun(runId: string) {
  const run = await prisma.scraperRun.findUnique({ where: { id: runId } });
  if (!run) throw new Error("Run not found");
  if (run.apifyRunId) await abortRun(run.apifyRunId).catch(() => null);
  return prisma.scraperRun.update({
    where: { id: runId },
    data: { status: "ABORTED", finishedAt: new Date() },
  });
}

// --- Polling ---------------------------------------------------------------

async function pollUntilDone(runId: string) {
  if (polling.has(runId)) return;
  polling.add(runId);
  const startedPollingAt = Date.now();

  // Stay interested a little longer than Apify's own timeout, so a run that
  // stops on its own is read properly instead of being written off here.
  const config = await readCaptureConfig().catch(() => null);
  const patience = (config?.runTimeoutSecs ? config.runTimeoutSecs * 1000 : DEFAULT_RUN_TIMEOUT_MS) + POLL_GRACE_MS;

  try {
    for (;;) {
      const run = await prisma.scraperRun.findUnique({ where: { id: runId }, include: { source: true } });
      if (!run?.apifyRunId) return;
      if (run.status === "ABORTED") return;

      let apifyRun;
      try {
        apifyRun = await getRun(run.apifyRunId);
      } catch (err) {
        // A transient Apify blip shouldn't abandon the run — retry on the slow cadence.
        if (Date.now() - startedPollingAt > patience) {
          await failRun(runId, `Lost contact with Apify: ${(err as Error).message}`, run.source);
          return;
        }
        await sleep(POLL_SLOW_MS);
        continue;
      }

      const status = toRunStatus(apifyRun.status);
      if (status !== run.status) {
        await prisma.scraperRun.update({
          where: { id: runId },
          data: { status, datasetId: apifyRun.defaultDatasetId ?? run.datasetId },
        });
      }

      if (TERMINAL.includes(apifyRun.status)) {
        const datasetId = apifyRun.defaultDatasetId ?? run.datasetId;
        const note =
          apifyRun.status === "SUCCEEDED"
            ? null
            : (apifyRun.statusMessage ?? `Apify run ${apifyRun.status.toLowerCase().replace("-", " ")}`);

        // A run that timed out or was stopped has still been paid for, and its
        // dataset holds everything found up to that point. Those rows are as
        // good as any others — file them, and keep the reason alongside.
        if (datasetId) await ingestRun(runId, datasetId, run.source, note);
        else await failRun(runId, note ?? "Apify run finished without a dataset", run.source);
        return;
      }

      if (Date.now() - startedPollingAt > patience) {
        await failRun(
          runId,
          `Gave up waiting after ${Math.round(patience / 60_000)} minutes — the Apify run may still be going.`,
          run.source,
        );
        return;
      }

      await sleep(Date.now() - startedPollingAt < POLL_FAST_WINDOW_MS ? POLL_FAST_MS : POLL_SLOW_MS);
    }
  } finally {
    polling.delete(runId);
  }
}

async function failRun(runId: string, error: string, source?: ScraperSource) {
  const run = await prisma.scraperRun.update({
    where: { id: runId },
    data: { status: "FAILED", error, finishedAt: new Date() },
  });
  if (source) await notify(run, source);
}

/** Never lets a reporting failure change the outcome of a run. */
async function notify(run: ScraperRun, source: ScraperSource) {
  await reportRun(run, source).catch((err) => console.error("[scraper] could not send run report:", (err as Error).message));
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Re-attaches to runs left mid-flight by a deploy or a crash. Without this a
 * Railway restart would strand a scrape as RUNNING forever.
 */
export async function resumeInterruptedRuns() {
  const runs = await prisma.scraperRun.findMany({
    where: { status: { in: ["QUEUED", "RUNNING"] }, apifyRunId: { not: null } },
    select: { id: true },
  });
  for (const run of runs) {
    void pollUntilDone(run.id).catch((err) => console.error(`[scraper] resume failed for run ${run.id}:`, err));
  }
  if (runs.length) console.log(`  → Resumed ${runs.length} in-flight scraper run(s)`);
}

// --- Ingestion -------------------------------------------------------------

/**
 * `note` is set when the run didn't finish cleanly. Its rows are still read
 * and filed — Apify has already charged for them — and the note is kept as the
 * run's error so the UI can say what went wrong beside what was salvaged.
 */
export async function ingestRun(runId: string, datasetId: string | null, source: ScraperSource, note: string | null = null) {
  if (!datasetId) {
    await failRun(runId, note ?? "Apify run finished without a dataset", source);
    return;
  }

  let items: Record<string, unknown>[];
  try {
    items = await getDatasetItems(datasetId, Math.min(source.maxItems, 1000));
  } catch (err) {
    await failRun(runId, `Could not read the results: ${(err as Error).message}`, source);
    return;
  }

  const stats = await ingestItems(items.slice(0, source.maxItems), source, runId);

  const finished = await prisma.scraperRun.update({
    where: { id: runId },
    // A note means the status is already the one Apify reported (timed out,
    // aborted); only a clean run gets promoted to SUCCEEDED here.
    data: { ...stats, status: note ? undefined : "SUCCEEDED", error: note, finishedAt: new Date() },
  });
  console.log(
    `[scraper] ${source.name}: ${stats.itemsFetched} items → ${stats.leadsCreated} new, ` +
      `${stats.leadsUpdated} updated, ${stats.duplicates} duplicate, ${stats.filtered} filtered out` +
      (note ? ` (${note})` : ""),
  );
  await notify(finished, source);

  // Anything new goes to whichever email sequences are watching for it. Only
  // leads *created* by this run carry its id — a re-scrape that merely enriches
  // an existing lead leaves `scraperRunId` where it was, so nobody is enrolled
  // twice for having been found again.
  if (stats.leadsCreated > 0) {
    const created = await prisma.lead.findMany({ where: { scraperRunId: runId }, select: { id: true } });
    await enrolNewLeads(created.map((lead) => lead.id));
  }
}

export interface IngestStats {
  itemsFetched: number;
  leadsCreated: number;
  leadsUpdated: number;
  duplicates: number;
  filtered: number;
}

/** Shared by the runner and by the manual-import endpoint. */
export async function ingestItems(
  items: Record<string, unknown>[],
  source: ScraperSource,
  runId: string | null,
): Promise<IngestStats> {
  const stats: IngestStats = {
    itemsFetched: items.length,
    leadsCreated: 0,
    leadsUpdated: 0,
    duplicates: 0,
    filtered: 0,
  };

  const groupId = items.length ? await resolveGroup(source) : null;
  const fieldMap = (source.fieldMap ?? null) as Record<string, string> | null;

  for (const item of items) {
    const mapped = mapItemToLead(item, { preset: source.preset as Preset, fieldMap });
    if (!mapped || mapped.closed) {
      stats.filtered += 1;
      continue;
    }

    const score = scoreLead(mapped);
    if (score < source.minScore) {
      stats.filtered += 1;
      continue;
    }

    const outcome = await upsertLead(mapped, score, source, runId, groupId, item);
    if (outcome === "created") stats.leadsCreated += 1;
    else if (outcome === "updated") {
      stats.leadsUpdated += 1;
      stats.duplicates += 1;
    } else stats.duplicates += 1;
  }

  return stats;
}

async function resolveGroup(source: ScraperSource): Promise<string> {
  const name = renderGroupName(source.groupName, source);
  const slug = slugify(name);
  try {
    const group = await prisma.leadGroup.upsert({
      where: { slug },
      update: {},
      create: { name, slug, autoCreated: true, description: `Captured by “${source.name}”` },
    });
    return group.id;
  } catch (err) {
    // Two sources scheduled at the same minute can reach the same batch name
    // at once; upsert isn't atomic against that. Whoever lost just reads it.
    if (isUniqueViolation(err)) {
      const existing = await prisma.leadGroup.findUnique({ where: { slug } });
      if (existing) return existing.id;
    }
    throw err;
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "P2002";
}

type UpsertOutcome = "created" | "updated" | "unchanged";

async function upsertLead(
  mapped: NormalizedLead,
  score: number,
  source: ScraperSource,
  runId: string | null,
  groupId: string | null,
  raw: Record<string, unknown>,
): Promise<UpsertOutcome> {
  const dedupeKey = buildDedupeKey(mapped);
  const status = source.autoQualify && score >= source.qualifyScore ? "QUALIFYING" : "NEW";

  const base = {
    contactName: mapped.contactName,
    contactEmail: mapped.contactEmail,
    contactPhone: mapped.contactPhone,
    companyName: mapped.companyName,
    website: mapped.website,
    address: mapped.address,
    city: mapped.city,
    region: mapped.region,
    country: mapped.country,
    category: mapped.category,
    rating: mapped.rating,
    reviewsCount: mapped.reviewsCount,
    latitude: mapped.latitude,
    longitude: mapped.longitude,
    socialLinks: (mapped.socialLinks ?? undefined) as Prisma.InputJsonValue | undefined,
    externalId: mapped.externalId,
    discoveryNotes: mapped.discoveryNotes,
    tags: mapped.tags,
    enrichment: raw as Prisma.InputJsonValue,
    source: source.leadSource as LeadSource,
    captureMethod: "APIFY" as const,
    leadScore: score,
    scraperSourceId: source.id,
    scraperRunId: runId,
    groupId,
  };

  if (!dedupeKey) {
    await prisma.lead.create({ data: { ...base, status, dedupeKey: null } });
    return "created";
  }

  let existing = await prisma.lead.findUnique({ where: { dedupeKey } });
  if (!existing) {
    try {
      await prisma.lead.create({ data: { ...base, status, dedupeKey } });
      return "created";
    } catch (err) {
      // Another run created the same business between the read and the write.
      // Fall through and enrich it rather than failing the whole ingest.
      if (!isUniqueViolation(err)) throw err;
      existing = await prisma.lead.findUnique({ where: { dedupeKey } });
      if (!existing) throw err;
    }
  }

  // A lead already being worked belongs to whoever is working it. Re-scraping
  // may only fill blanks and refresh public facts — never overwrite an edit,
  // and never drag a QUALIFIED lead back to NEW.
  const enrichment: Prisma.LeadUncheckedUpdateInput = {
    contactEmail: existing.contactEmail ?? mapped.contactEmail,
    contactPhone: existing.contactPhone ?? mapped.contactPhone,
    companyName: existing.companyName ?? mapped.companyName,
    website: existing.website ?? mapped.website,
    address: existing.address ?? mapped.address,
    city: existing.city ?? mapped.city,
    region: existing.region ?? mapped.region,
    country: existing.country ?? mapped.country,
    category: existing.category ?? mapped.category,
    latitude: existing.latitude ?? mapped.latitude,
    longitude: existing.longitude ?? mapped.longitude,
    externalId: existing.externalId ?? mapped.externalId,
    discoveryNotes: existing.discoveryNotes ?? mapped.discoveryNotes,
    // Ratings and review counts move on their own; the newest reading wins.
    rating: mapped.rating ?? existing.rating,
    reviewsCount: mapped.reviewsCount ?? existing.reviewsCount,
    socialLinks: (mapped.socialLinks ?? existing.socialLinks ?? undefined) as Prisma.InputJsonValue | undefined,
    enrichment: raw as Prisma.InputJsonValue,
    tags: Array.from(new Set([...existing.tags, ...mapped.tags])),
    leadScore: Math.max(existing.leadScore, score),
    scraperSourceId: existing.scraperSourceId ?? source.id,
    groupId: existing.groupId ?? groupId,
  };

  const changed = didEnrich(existing, mapped);
  await prisma.lead.update({ where: { id: existing.id }, data: enrichment });
  return changed ? "updated" : "unchanged";
}

// --- Housekeeping ----------------------------------------------------------

/**
 * Drops run history past the configured retention window. Captured leads are
 * untouched — the foreign key is nullable, so a lead outlives the record of
 * the scrape that found it. A retention of 0 keeps everything for ever.
 */
export async function pruneRunHistory(retentionDays: number, now = new Date()): Promise<number> {
  if (retentionDays <= 0) return 0;
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60_000);
  const { count } = await prisma.scraperRun.deleteMany({
    where: { startedAt: { lt: cutoff }, status: { notIn: ["QUEUED", "RUNNING"] } },
  });
  if (count) console.log(`[scraper] Pruned ${count} run record(s) older than ${retentionDays} days`);
  return count;
}

/** Did this re-scrape actually add anything the Owner didn't already have? */
function didEnrich(existing: Lead, mapped: NormalizedLead): boolean {
  const filled = (["contactEmail", "contactPhone", "website", "address", "city", "category"] as const).some(
    (field) => !existing[field] && mapped[field],
  );
  const reviewsMoved = mapped.reviewsCount != null && mapped.reviewsCount !== existing.reviewsCount;
  return filled || reviewsMoved;
}
