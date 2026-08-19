import { ApifyNotConfiguredError, apifyConfigured, getActorSchema, getDatasetItems, getRun, runCost, startRun } from "../lib/apify.js";
import { SETTING, getSetting } from "../lib/settings.js";

/**
 * The half of "is this site fast" that a fetch cannot answer.
 *
 * `audit/evidence.ts` measures everything that is visible in a response: how
 * long the server took to send its first byte, whether the markup is
 * compressed, how many scripts block the first paint. All of it is true and
 * none of it is what a visitor experiences, because a visitor experiences a
 * *rendered* page — how long until something appears, how long until it stops
 * moving, how long the browser is locked up running scripts. Those need a real
 * browser, and this is a small Node process.
 *
 * So a browser is rented. `smart-digital/complete-seo-audit-tool` loads the
 * page in Chrome and reports first contentful paint, speed index, total
 * blocking time and cumulative layout shift, plus two things our own fetch
 * cannot check at any price: whether the links on the page actually resolve
 * (it requests them) and how many kilobytes each image really is.
 *
 * Three rules, each of them the same rule the rest of the audit runs on:
 *
 *  - **Only the measurements are taken, never the verdict.** The actor returns
 *    its own 0-100 score and its own issue list, covering meta tags, headings
 *    and content this app already reads for itself. Adopting those would put
 *    two scoring systems in one document and report the same missing title
 *    twice in different words. What is used is what nothing else here can
 *    measure.
 *  - **A lab measurement says so.** These numbers come from one machine, on
 *    one connection, once. They are a strong indication and they are not what
 *    the business's customers experienced, and every finding built on them
 *    carries that sentence.
 *  - **It never throws.** No token, actor down, site behind a bot wall — each
 *    is a note, and the speed section falls back to the measurements taken
 *    from the fetch, which need nothing.
 *
 * **It costs money per page**, which is why `crawlPages` is off and `maxPages`
 * is one. The audit team reviews a homepage; crawling five pages would
 * quintuple the bill to answer a question nobody asked.
 */

/** Charged per page analysed. Read the live rate before quoting it anywhere. */
export const DEFAULT_SEO_ACTOR = "smart-digital/complete-seo-audit-tool";

const POLL_EVERY_MS = 3000;
const GIVE_UP_AFTER_MS = 180_000;

/** Which actor does this, or the shipped default. */
export async function seoActorId(): Promise<string> {
  const configured = (await getSetting(SETTING.SEO_AUDIT_ACTOR))?.trim();
  return configured || DEFAULT_SEO_ACTOR;
}

/**
 * What a browser saw, in milliseconds, plus the two lists a fetch cannot build.
 *
 * Every field is optional because an actor reports what it managed to measure:
 * the README is explicit that some Core Web Vitals only arrive when the page
 * exposes them, and a missing number must read as missing rather than as zero.
 */
export interface RenderedMeasurements {
  /** The address the actor actually audited. */
  pageUrl: string | null;
  httpStatus: number | null;
  timeToFirstByteMs: number | null;
  firstContentfulPaintMs: number | null;
  speedIndexMs: number | null;
  totalBlockingTimeMs: number | null;
  /** Unitless. Above 0.1 is visible movement while the page settles. */
  cumulativeLayoutShift: number | null;
  pageLoadMs: number | null;
  /** Links that were requested and did not resolve. */
  brokenLinks: { count: number; urls: string[] } | null;
  images: { total: number; oversized: number; totalKB: number | null; largest: { url: string; sizeKB: number } | null } | null;
}

export interface SeoAuditResult {
  measured: RenderedMeasurements | null;
  /** What it cost, from Apify's own accounting. Null when it could not be read. */
  costUsd: number | null;
  /** Why there is nothing here, in plain words. Never a failure. */
  note: string | null;
  actorId: string;
}

const nothing = (actorId: string, note: string): SeoAuditResult => ({ measured: null, costUsd: null, note, actorId });

export async function runSeoAudit(url: string): Promise<SeoAuditResult> {
  const actorId = await seoActorId();

  if (!(await apifyConfigured())) {
    return nothing(actorId, "The page was not opened in a real browser — Apify is not connected, so first paint, layout shift and broken links could not be measured. Add a token under Lead Sources → Connection.");
  }

  const input = await buildSeoInput(url, actorId);

  let run;
  try {
    run = await startRun(actorId, input, { timeoutSecs: 300, memoryMbytes: 4096 });
  } catch (err) {
    if (err instanceof ApifyNotConfiguredError) return nothing(actorId, err.message);
    return nothing(actorId, `The page was not opened in a real browser — Apify would not start the run: ${(err as Error).message}`);
  }

  const giveUpAt = Date.now() + GIVE_UP_AFTER_MS;
  let finished = run;
  while (finished.status === "READY" || finished.status === "RUNNING") {
    if (Date.now() > giveUpAt) {
      return nothing(actorId, `The page was not opened in a real browser — the run was still going after ${Math.round(GIVE_UP_AFTER_MS / 1000)} seconds.`);
    }
    await wait(POLL_EVERY_MS);
    try {
      finished = await getRun(run.id);
    } catch (err) {
      return nothing(actorId, `The page was not opened in a real browser — Apify stopped answering: ${(err as Error).message}`);
    }
  }

  if (finished.status !== "SUCCEEDED") {
    return nothing(actorId, `The page was not opened in a real browser — the run ${finished.status.toLowerCase()}. Their site may block automated browsers.`);
  }

  let items: Record<string, unknown>[];
  try {
    // A handful: one `page` record and one `site-summary`, plus headroom in
    // case the actor ever adds a third kind.
    items = await getDatasetItems(finished.defaultDatasetId, 10);
  } catch (err) {
    return nothing(actorId, `The page was opened but the measurements could not be read back: ${(err as Error).message}`);
  }

  const cost = await runCost(finished, actorId).catch(() => ({ totalUsd: null, events: null }));
  const record = items.find((item) => item.type === "page") ?? items.find((item) => item.audit);
  if (!record) {
    return { ...nothing(actorId, "The page was opened in a real browser but no measurements came back for it."), costUsd: cost.totalUsd };
  }

  return { measured: readSeoRecord(record), costUsd: cost.totalUsd, note: null, actorId };
}

/**
 * The run body, built against the actor's own schema.
 *
 * Same rule as the screenshot actors and for the same reason: Apify ignores an
 * unknown input key silently, so a misspelt `crawlPages` is not an error — it
 * is a five-page crawl at five times the price, and nothing anywhere says so.
 */
export async function buildSeoInput(url: string, actorId: string): Promise<Record<string, unknown>> {
  const schema = await getActorSchema(actorId).catch(() => null);
  const declared = schema ? new Set(schema.properties) : null;
  const input: Record<string, unknown> = { startUrls: [url] };

  const put = (key: string, value: unknown) => {
    if (!declared || declared.has(key)) input[key] = value;
  };

  // One page, the one we were asked about. Both are set: `crawlPages: false`
  // is the documented switch and `maxPages: 1` is the belt, because the bill
  // is per page analysed.
  put("crawlPages", false);
  put("maxPages", 1);
  put("respectRobotsTxt", true);
  put("includeSubdomains", false);

  // Only the modules whose output is read. The four that are off — meta tags,
  // headings, content and schema — are all things `audit/evidence.ts` already
  // reads out of the markup it fetched, and running them again would buy a
  // second opinion on a question that is not in doubt.
  put("auditPerformance", true);
  put("auditLinks", true);
  put("auditImages", true);
  put("auditTechnical", true);
  put("auditMetaTags", false);
  put("auditHeadings", false);
  put("auditContent", false);
  put("auditSchema", false);
  put("auditAccessibility", false);

  if (schema?.proxyField) input[schema.proxyField] = { ...(schema.proxyDefault ?? {}), useApifyProxy: true };

  return input;
}

/**
 * Pulls the numbers out, treating anything that is not a finite number as absent.
 *
 * Exported with `buildSeoInput` because those two are the whole of this file
 * that can be checked without a token, and they are where the mistakes live:
 * an input key the actor does not declare is ignored in silence, and a field
 * read from the wrong place comes back `undefined` rather than wrong.
 */
export function readSeoRecord(record: Record<string, unknown>): RenderedMeasurements {
  const audit = (record.audit ?? {}) as Record<string, unknown>;
  const performance = (audit.performance ?? {}) as Record<string, unknown>;
  const links = (audit.links ?? {}) as Record<string, unknown>;
  const broken = (links.broken ?? {}) as Record<string, unknown>;
  const images = (audit.images ?? {}) as Record<string, unknown>;
  const vitals = (performance.coreWebVitals ?? {}) as Record<string, unknown>;

  const list = Array.isArray(images.images) ? (images.images as Record<string, unknown>[]) : [];
  const sized = list.filter((image) => num(image.sizeKB) != null);
  const largest = sized.reduce<{ url: string; sizeKB: number } | null>((worst, image) => {
    const sizeKB = num(image.sizeKB)!;
    if (worst && worst.sizeKB >= sizeKB) return worst;
    return { url: String(image.url ?? ""), sizeKB };
  }, null);

  return {
    pageUrl: typeof record.pageUrl === "string" ? record.pageUrl : null,
    httpStatus: num(record.httpStatus),
    timeToFirstByteMs: num(performance.timeToFirstByte),
    firstContentfulPaintMs: num(performance.firstContentfulPaint),
    speedIndexMs: num(performance.speedIndex),
    totalBlockingTimeMs: num(performance.totalBlockingTime),
    // The actor reports it in both places depending on the build.
    cumulativeLayoutShift: num(performance.cumulativeLayoutShift) ?? num(vitals.cls),
    pageLoadMs: num(performance.pageLoadTime) ?? num(performance.loadTime),
    brokenLinks:
      num(broken.count) == null
        ? null
        : { count: num(broken.count)!, urls: (Array.isArray(broken.urls) ? broken.urls : []).map(String).slice(0, 5) },
    images: num(images.total) == null ? null : {
      total: num(images.total)!,
      oversized: num(images.largeImages) ?? 0,
      totalKB: sized.length ? Math.round(sized.reduce((sum, image) => sum + num(image.sizeKB)!, 0)) : null,
      largest,
    },
  };
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
