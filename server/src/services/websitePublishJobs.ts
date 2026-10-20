import { capacity } from "../lib/capacity.js";
import { createHash } from "node:crypto";
import type { Prisma, PublishJob, PublishJobState, Site, SitePage } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { readFile } from "../lib/github.js";
import { mapConcurrent } from "../lib/concurrency.js";
import { fetchWebsitePage } from "../lib/websiteFetch.js";
import { pageUrl, repoFilePath, siteRepo } from "./website/site.js";
import { hostedUrlFor } from "./websiteHosting.js";
import { githubHealth, githubTroubleFor, hostFromHeaders, type GithubHealth } from "./githubStatus.js";
import { readHostProgress, retryPagesBuild, type HostProgress } from "./websiteDeployWatch.js";
import { deployProfileOf } from "./websiteDeployDetect.js";
import { bridgeBypassHeaders, clearBridgeFor } from "./websiteEdgeBridge.js";
import { schedulePublishDispatch } from "./websitePublishRouter.js";
import type { FieldChangeSummary } from "./website/index.js";

/**
 * A publish, recorded from before it starts until it is seen on the live site.
 *
 * Two things were invisible before this and both cost trust rather than data.
 *
 * **A commit is not a deployment.** The editor committed, said "published", and
 * left somebody refreshing a page that GitHub Pages had not rebuilt yet. There
 * was no way to tell a slow rebuild from a failed one, so every slow one looked
 * like a bug. The job carries what the change put on the page, and a later look
 * at the public address settles it: `COMPLETED`, with how long the rebuild took,
 * or `VERIFY_FAILED` with the page still saying the old thing.
 *
 * **A commit that lands while the database write after it fails leaves the
 * repository ahead of the OS**, with nothing recording that it happened. So the
 * row is written *before* GitHub is touched, and a process that dies mid-publish
 * leaves a `COMMITTING` row that the next boot can ask GitHub about — the commit
 * is either there, in which case this is `RECONCILIATION_REQUIRED` and names the
 * sha, or it is not, in which case nothing happened and it says so.
 *
 * The job does not *run* the publish. The route still does that, synchronously,
 * because somebody is waiting on the answer and a queue would only move the
 * waiting somewhere they cannot see. This is the record of it, and the half that
 * happens after they have gone.
 */

export type PublishJobKind = "PAGE" | "SHARED" | "ROLLBACK";

/**
 * How long to keep asking the live site, and how often, measured from when the
 * publish started rather than by counting looks.
 *
 * The watch used to stop after eight looks spanning twelve minutes. On 19 Oct
 * 2026 a GitHub Actions incident held a GitHub Pages rebuild for forty minutes,
 * and a publish that worked was recorded as "the live page has not changed". A
 * host that is merely slow must never be reported as failed, so:
 *
 * - quick looks for the first five minutes, because a static host can rebuild
 *   in well under one and the page should say "live" as soon as it is;
 * - then every two minutes up to two hours, which covers a bad day at GitHub;
 * - then every fifteen minutes up to a day, saying the host has not updated yet
 *   rather than that anything failed;
 * - and only then stopping, because a day without a rebuild is something a
 *   person has to look at.
 */
const QUICK_LOOKS_MS = [10_000, 20_000, 30_000, 45_000, 60_000, 90_000];
const QUICK_PHASE_MS = 5 * 60_000;
const STEADY_EVERY_MS = 2 * 60_000;
/** From here on the host is late rather than busy, and the words say so. */
export const HOST_LATE_AFTER_MS = 2 * 60 * 60_000;
const LATE_EVERY_MS = 15 * 60_000;
export const GIVE_UP_AFTER_MS = 24 * 60 * 60_000;
export const HOST_LATE_LABEL = "Your host hasn't updated yet. We'll keep checking.";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * A distinctive thing the change put on the page.
 *
 * Words, not markup: the live page is fetched as text and searched. Short and
 * common strings are useless — "Home" appears in a nav on every page — so this
 * takes the longest new value and refuses anything under twelve characters,
 * leaving verification to the whole-file hash instead of pretending.
 */
export function verificationText(summary: FieldChangeSummary[]): string | null {
  const candidates = summary
    .filter((change) => change.part === "words" || change.part === "destination")
    .map((change) => change.to.replace(/\s+/g, " ").trim())
    .filter((value) => value.length >= 12 && !/[<>]/.test(value))
    .sort((left, right) => right.length - left.length);
  return candidates[0] ?? null;
}

export async function startPublishJob(input: {
  site: Site;
  kind: PublishJobKind;
  pageId?: string;
  sharedElementId?: string;
  startedById?: string;
  detail: Prisma.InputJsonValue;
}): Promise<PublishJob> {
  return prisma.publishJob.create({
    data: {
      siteId: input.site.id,
      kind: input.kind,
      pageId: input.pageId ?? null,
      sharedElementId: input.sharedElementId ?? null,
      startedById: input.startedById ?? null,
      detail: input.detail,
      state: "VALIDATING",
    },
  });
}

export async function advancePublishJob(id: string, state: PublishJobState, data: Prisma.PublishJobUpdateInput = {}): Promise<void> {
  await prisma.publishJob.update({ where: { id }, data: { state, ...data } });
}

/**
 * The commit landed. What is left is whether the world can see it.
 *
 * Called with everything a later look needs, because by the time it is looked at
 * the request that published is long gone and the draft it came from has been
 * cleared.
 */
export async function publishJobCommitted(input: {
  id: string;
  commit: { sha: string; url: string };
  site: Site;
  page: SitePage;
  html: string;
  summary: FieldChangeSummary[];
}, db: Prisma.TransactionClient = prisma): Promise<void> {
  const isLocalHosted = !siteRepo(input.site);
  const now = new Date();
  // A hosted page is live the moment this row commits, because the OS serves it
  // from the database — but only at the hosted address. The site's own
  // `publicUrl` is wherever the customer's old site lives, and pointing "Open
  // live website" there showed them a page without their change on it. Read
  // after `ensureHostedAddress`, which may have just given the site its slug.
  let hostedUrl: string | null = null;
  if (isLocalHosted) {
    const hosting = await db.site.findUnique({ where: { id: input.site.id }, select: { hostedSlug: true, customDomain: true, customDomainVerifiedAt: true } });
    const root = hosting ? hostedUrlFor(hosting) : null;
    hostedUrl = root ? `${root}${input.page.path === "/" ? "/" : input.page.path}` : null;
  }
  await db.publishJob.update({
    where: { id: input.id },
    data: {
      state: isLocalHosted ? "COMPLETED" : "DEPLOYING",
      commitSha: input.commit.sha,
      commitUrl: isLocalHosted ? null : input.commit.url,
      verifyUrl: isLocalHosted ? hostedUrl : pageUrl(input.site, input.page),
      verifyText: verificationText(input.summary),
      expectedHash: hash(input.html),
      nextCheckAt: isLocalHosted ? null : new Date(Date.now() + QUICK_LOOKS_MS[0]!),
      verifiedAt: isLocalHosted ? now : undefined,
      finishedAt: isLocalHosted ? now : undefined,
      attempts: isLocalHosted ? 1 : 0,
    },
  });
  // The faster routes (bridge, direct upload, deploy hook) run from here, once
  // the transaction this may be inside has committed. See websitePublishRouter.ts.
  if (!isLocalHosted) schedulePublishDispatch(input.id);
}

/**
 * The same record, for a source file rather than a rendered page.
 *
 * A framework publish is a commit like any other, but what happens next is not
 * a static host copying a file: Vercel, Netlify or Cloudflare has to build the
 * project first, which takes minutes and can fail on its own terms. Committing
 * and saying "your host will build this" left somebody with no way to tell a
 * build that is slow from one that failed, which is the exact silence the
 * publish jobs were built to end — so a source publish gets a job too.
 *
 * The one difference that matters: there is no expected hash. The file that was
 * committed is not the file the visitor receives — it is compiled first — so the
 * only honest signal is the words themselves appearing on the address the route
 * is served at. Where a change has no words long enough to look for, the job
 * completes rather than claiming an answer it cannot have.
 */
export async function sourcePublishCommitted(input: {
  id: string;
  commit: { sha: string; url: string };
  site: Site;
  page: SitePage | null;
  changes: Array<{ before: string; after: string }>;
}): Promise<void> {
  const verifyText = verificationText(input.changes.map((change) => ({ id: "", label: "", kind: "text", part: "words", from: change.before, to: change.after } as FieldChangeSummary)));
  await prisma.publishJob.update({
    where: { id: input.id },
    data: {
      state: "DEPLOYING",
      commitSha: input.commit.sha,
      commitUrl: input.commit.url,
      // The page's own address when the scan knows it, and the site's front
      // door when it does not — looking at the wrong page would report a
      // perfectly good publish as unverified for ever.
      verifyUrl: input.page ? pageUrl(input.site, input.page) : input.site.publicUrl,
      verifyText,
      expectedHash: null,
      nextCheckAt: new Date(Date.now() + QUICK_LOOKS_MS[0]!),
      attempts: 0,
    },
  });
  schedulePublishDispatch(input.id);
}

export async function failPublishJob(id: string, state: PublishJobState, message: string): Promise<void> {
  await prisma.publishJob
    .update({ where: { id }, data: { state, lastError: message.slice(0, 500), finishedAt: new Date() } })
    .catch(() => {
      /* The job row is a record, not the publish. Never fail a publish over it. */
    });
}

/**
 * Looks at the public page and decides whether the change is on it.
 *
 * Both tests are needed and neither is enough on its own. The text is the
 * reliable one — it is the thing somebody changed — but a change that was only
 * styling has no text to look for. The whole-file hash covers that, and fails
 * quietly on any host that rewrites what it serves, which is why a job with
 * neither signal is completed rather than reported as unverified: saying "we
 * could not confirm it" about a host that can never confirm anything is noise.
 */
async function verifyOne(job: PublishJob): Promise<{ verified: boolean; error?: string; servedBy?: string | null }> {
  if (!job.verifyUrl) return { verified: true };
  try {
    // Behind the edge bridge the public address answers with the bridge's own
    // copy at once, which would say "live" before the host has rebuilt. The
    // bypass header asks for what the host itself serves.
    const page = await fetchWebsitePage(job.verifyUrl, { headers: await bridgeBypassHeaders(job.siteId) });
    return { verified: livePageShowsChange({ body: page.text, verifyText: job.verifyText, expectedHash: job.expectedHash }), servedBy: hostFromHeaders(page.headers) };
  } catch (error) {
    return { verified: false, error: error instanceof Error ? error.message : "The live page could not be read." };
  }
}

export type VerificationStep =
  | { state: "COMPLETED" }
  | { state: "VERIFYING"; nextCheckInMs: number }
  | { state: "VERIFY_FAILED"; reason: string };

/**
 * What one look at the live page means, decided without a database in the way.
 *
 * Pulled out because this is the part that can be wrong in a way nobody notices:
 * a watch that gives up too early reports a working site as broken (19 Oct
 * 2026), and one that never gives up leaves a row saying "waiting" for ever,
 * which is the same silence the whole feature was built to end.
 *
 * A page that could not be read at all is a different story from a page that
 * still shows the old version, and is not given a day: two hours of the address
 * not answering, on this look and the one before it, is reported as that.
 */
export function decideVerification(input: { verified: boolean; attempts: number; elapsedMs: number; error?: string; previousError?: boolean }): VerificationStep {
  if (input.verified) return { state: "COMPLETED" };
  if (input.error && input.previousError && input.elapsedMs >= HOST_LATE_AFTER_MS) {
    return { state: "VERIFY_FAILED", reason: input.error };
  }
  if (input.elapsedMs >= GIVE_UP_AFTER_MS) {
    return {
      state: "VERIFY_FAILED",
      reason:
        input.error ??
        "The commit is in the repository, but a day later the live page still shows the old version. The host may have stopped rebuilding the site, or it may be serving a cached copy. Check the host's deploy page.",
    };
  }
  const nextCheckInMs =
    input.elapsedMs < QUICK_PHASE_MS ? QUICK_LOOKS_MS[input.attempts] ?? STEADY_EVERY_MS
      : input.elapsedMs < HOST_LATE_AFTER_MS ? STEADY_EVERY_MS
        : LATE_EVERY_MS;
  return { state: "VERIFYING", nextCheckInMs };
}

/**
 * Whether the page in front of us is the page that was published.
 *
 * Both tests are needed and neither is enough alone — see `verifyOne`.
 */
export function livePageShowsChange(input: { body: string; verifyText: string | null; expectedHash: string | null }): boolean {
  if (input.verifyText && input.body.includes(input.verifyText)) return true;
  if (input.expectedHash && hash(input.body) === input.expectedHash) return true;
  // A host that can never confirm anything must not be reported as unverified
  // for ever; with no signal at all there is nothing to wait for.
  return !input.verifyText && !input.expectedHash;
}

const WAITING_STATES: PublishJobState[] = ["DEPLOYING", "VERIFYING"];

const jobDetail = (job: PublishJob): Record<string, unknown> =>
  job.detail && typeof job.detail === "object" && !Array.isArray(job.detail) ? (job.detail as Record<string, unknown>) : {};

/**
 * Every job waiting to be seen live, checked once.
 *
 * Runs on the app's own minute tick. Deliberately not a tight poll: see the
 * schedule above. Stopping is a result: `VERIFY_FAILED` means the commit is in
 * the repository and a day later the live site still has not changed, which is
 * a real thing that happens and needs somebody.
 *
 * Every write is conditional on the job still waiting, because a newer publish
 * on the same site settling in the same tick may already have settled it.
 */
export async function verifyDuePublishJobs(now = new Date()): Promise<number> {
  const due = await prisma.publishJob.findMany({
    where: { state: { in: WAITING_STATES }, nextCheckAt: { lte: now } },
    orderBy: { nextCheckAt: "asc" },
    take: 25,
    include: { site: true },
  });

  // A few at a time: each look can take up to twenty seconds, and the rest of
  // the tick (billing, capture) waits behind this.
  const settledEach = await mapConcurrent(due, 5, (job) => verifyDueJob(job, now).catch((error) => {
    console.error(`[publish-jobs] verifying ${job.id} failed:`, error);
    return 0;
  }));
  return settledEach.reduce((total, count) => total + count, 0);
}

/**
 * What to do when the host itself reports that its build failed (D1, D6).
 *
 * - GitHub having problems with the part this host builds on: keep waiting. A
 *   build that failed during an outage is GitHub's problem, and it is never
 *   retried while GitHub is still down.
 * - A GitHub Pages build that can be asked for again, not asked for yet: ask,
 *   once, and keep waiting.
 * - Otherwise the host did not rebuild, and that is the answer, in the host's
 *   own words.
 */
export function decideHostFailure(input: { githubTrouble: boolean; canRetry: boolean; retried: boolean }): "wait" | "retry" | "fail" {
  if (input.githubTrouble) return "wait";
  if (input.canRetry && !input.retried) return "retry";
  return "fail";
}

async function verifyDueJob(job: PublishJob & { site: Site }, now: Date): Promise<number> {
  const attempts = job.attempts + 1;
  const elapsedMs = now.getTime() - job.createdAt.getTime();
  const result = await verifyOne(job);
  const step = decideVerification({ verified: result.verified, attempts, elapsedMs, error: result.error, previousError: Boolean(job.lastError) });
  const stillWaiting = { id: job.id, state: { in: WAITING_STATES } };
  // Which host answered, kept on the job so a reader in another process can tell
  // which parts of GitHub this site's deploy depends on.
  const detail = jobDetail(job);
  const nextDetail: Record<string, unknown> = { ...detail };
  if (result.servedBy) nextDetail.servedBy = result.servedBy;

  // What the host says it is doing, while that can still change and is worth
  // reading: not once it is live, and not once it is hours late (the page check
  // alone carries on then). Without the app's read permissions this is null.
  let progress: HostProgress | null = null;
  if (step.state !== "COMPLETED" && job.commitSha && siteRepo(job.site) && job.stage !== "live" && elapsedMs < HOST_LATE_AFTER_MS) {
    progress = await readHostProgress(job.site, job.commitSha, deployProfileOf(job.site)?.host ?? null).catch(() => null);
  }
  const stageTimes = { ...((job.stageTimes ?? {}) as Record<string, string>) };
  const stage = step.state === "COMPLETED" ? "live" : progress?.stage ?? job.stage;
  if (stage && !stageTimes[stage]) stageTimes[stage] = now.toISOString();
  const progressData = { stage, stageTimes: stageTimes as Prisma.InputJsonValue, detail: nextDetail as Prisma.InputJsonValue };

  if (step.state === "COMPLETED") {
    const { count } = await prisma.publishJob.updateMany({
      where: stillWaiting,
      data: { state: "COMPLETED", attempts, verifiedAt: now, finishedAt: now, nextCheckAt: null, lastError: null, ...progressData },
    });
    if (!count) return 0;
    // The host has the change: the edge bridge can stop serving its copy.
    await clearBridgeFor(job).catch((error) => console.error(`[publish-jobs] clearing the bridge for ${job.id} failed:`, error));
    return 1 + (await settleOvertakenJobs(job, now));
  }

  if (progress?.stage === "failed") {
    const servedBy = typeof nextDetail.servedBy === "string" ? nextDetail.servedBy : deployProfileOf(job.site)?.host ?? null;
    const githubTrouble = Boolean(githubTroubleFor(await githubHealth(), servedBy));
    const decision = decideHostFailure({ githubTrouble, canRetry: Boolean(progress.retry), retried: Boolean(detail.retriedAt) });
    const message = progress.message ?? "The host reported that the build failed.";
    if (decision === "retry") {
      const retried = await retryPagesBuild(job.site, progress.retry!);
      if (retried.ok) {
        nextDetail.retriedAt = now.toISOString();
        await prisma.publishJob.updateMany({
          where: stillWaiting,
          data: { ...progressData, stage: "queued", detail: nextDetail as Prisma.InputJsonValue, state: "VERIFYING", attempts, hostMessage: `${message} DakyX asked GitHub to build it again.`, nextCheckAt: new Date(now.getTime() + STEADY_EVERY_MS), lastError: null },
        });
        return 0;
      }
      nextDetail.retriedAt = now.toISOString();
      nextDetail.retryRefused = retried.reason;
    }
    if (decision !== "wait") {
      const { count } = await prisma.publishJob.updateMany({
        where: stillWaiting,
        data: { ...progressData, detail: nextDetail as Prisma.InputJsonValue, state: "DEPLOY_FAILED", attempts, nextCheckAt: null, finishedAt: now, hostMessage: message, lastError: `The host did not rebuild: ${message}` },
      });
      return count;
    }
    await prisma.publishJob.updateMany({
      where: stillWaiting,
      data: { ...progressData, state: "VERIFYING", attempts, hostMessage: message, nextCheckAt: new Date(now.getTime() + STEADY_EVERY_MS), lastError: result.error ?? null },
    });
    return 0;
  }

  if (step.state === "VERIFY_FAILED") {
    const { count } = await prisma.publishJob.updateMany({
      where: stillWaiting,
      data: { state: "VERIFY_FAILED", attempts, nextCheckAt: null, finishedAt: now, lastError: step.reason, ...progressData },
    });
    return count;
  }
  await prisma.publishJob.updateMany({
    where: stillWaiting,
    data: { state: "VERIFYING", attempts, nextCheckAt: new Date(now.getTime() + step.nextCheckInMs), lastError: result.error ?? null, ...progressData },
  });
  return 0;
}

/**
 * Older publishes on the same site, settled by a newer one going live.
 *
 * A host deploys the whole repository at a commit, so a page from a later
 * publish being live means every earlier commit is deployed too. Without this,
 * an earlier publish whose words the later one replaced would wait a day for
 * words that are never coming back, and then say it had failed.
 *
 * Only when the newer job proved it: one with nothing to look for completes
 * without having seen anything, and proves nothing about the others.
 */
async function settleOvertakenJobs(job: PublishJob, now: Date): Promise<number> {
  if (!job.verifyText && !job.expectedHash) return 0;
  // A build that failed for an earlier commit is overtaken too: the later
  // commit's build carried its change live. Only within a day, so an old
  // failure is not rewritten long after anybody looked at it.
  const { count } = await prisma.publishJob.updateMany({
    where: {
      siteId: job.siteId,
      id: { not: job.id },
      createdAt: { lt: job.createdAt, gt: new Date(now.getTime() - GIVE_UP_AFTER_MS) },
      state: { in: [...WAITING_STATES, "DEPLOY_FAILED"] },
    },
    data: { state: "COMPLETED", verifiedAt: now, finishedAt: now, nextCheckAt: null, lastError: null, stage: "live" },
  });
  return count;
}

/**
 * Jobs the last process died in the middle of.
 *
 * A row still saying `COMMITTING` is the dangerous one: the commit may or may
 * not have happened. GitHub is asked rather than guessed at — if the file in the
 * repository is what this job was going to write, the commit landed and the
 * database is behind, which is a state a person has to look at rather than one
 * to quietly fix. If it is not, nothing happened, and the row says so.
 */
export async function reconcileInterruptedPublishJobs(before?: Date): Promise<number> {
  const stuck = await prisma.publishJob.findMany({
    where: { state: { in: ["QUEUED", "VALIDATING", "COMMITTING"] }, ...(before ? { createdAt: { lt: before } } : {}) },
    orderBy: { createdAt: "asc" },
    include: { site: true, page: true },
    take: 20,
  });

  let handled = 0;
  for (const job of stuck) {
    const active = await prisma.serviceLease.findFirst({ where: { key: { in: [`publication:site:${job.siteId}`, `publication:page:${job.pageId}`] }, expiresAt: { gt: new Date() } } });
    if (active) continue;
    if (job.state !== "COMMITTING") {
      await failPublishJob(job.id, "COMMIT_FAILED", "The publish was interrupted before anything was committed. Nothing was changed; publish again.");
      handled += 1;
      continue;
    }

    if (job.commitSha) {
      await failPublishJob(job.id, "RECONCILIATION_REQUIRED", "The repository commit was recorded, but publication did not finish. Compare the commit with the local page history before publishing again.");
      handled += 1;
      continue;
    }

    const detail = (job.detail ?? {}) as { expectedHtmlHash?: string };
    const repo = siteRepo(job.site);
    if (!repo || !job.page || !detail.expectedHtmlHash) {
      await failPublishJob(job.id, "RECONCILIATION_REQUIRED", "This publish was interrupted while committing and cannot be checked automatically. Compare the repository with this page before publishing again.");
      handled += 1;
      continue;
    }

    const live = await readFile(repo, repoFilePath(job.site, job.page), job.site.repoBranch).catch(() => null);
    if (live === null || hash(live) === detail.expectedHtmlHash) {
      await failPublishJob(
        job.id,
        "RECONCILIATION_REQUIRED",
        "The publish may have reached the repository, but local recording did not finish. Compare the repository with the local version history before publishing again.",
      );
    } else {
      await failPublishJob(job.id, "COMMIT_FAILED", "The publish was interrupted before the commit landed. Nothing was changed; publish again.");
    }
    handled += 1;
  }
  return handled;
}

/**
 * What the editor shows after a publish, and on the site's activity screen.
 *
 * `github` is what githubstatus.com said, when the caller asked: a waiting
 * publish on a site whose deploy runs through a part of GitHub that is not
 * working says so, because otherwise the wait looks like our fault or theirs.
 */
export function publishJobView(job: PublishJob, context: { github?: GithubHealth | null; now?: Date } = {}) {
  // A framework publish commits a source file, and nobody sees it until the
  // host has built the project — minutes, not the seconds a static host takes.
  // "Waiting for the host to rebuild" is true of both and useless for this one,
  // because the thing being waited on is a build that can fail on its own terms.
  const detail = jobDetail(job);
  const built = Boolean(detail.source);
  const waiting = WAITING_STATES.includes(job.state);
  const servedBy = typeof detail.servedBy === "string" ? detail.servedBy : null;
  const notice = waiting ? githubTroubleFor(context.github ?? null, servedBy) : null;
  const late = waiting && (context.now ?? new Date()).getTime() - job.createdAt.getTime() >= HOST_LATE_AFTER_MS;
  return {
    id: job.id,
    kind: job.kind,
    state: job.state,
    /** True when what was committed is source that has to be built first. */
    fromSource: built,
    /** Which host answered the last look at the live page, when it could tell. */
    servedBy,
    /** A reason for the wait that is nobody's fault here: GitHub having problems. */
    notice,
    /** Still waiting two hours on: the host is late, not failed. */
    late,
    /** Which route made it live, and the faster one that failed first. See websitePublishRouter.ts. */
    route: job.route,
    fallbackFrom: job.fallbackFrom,
    routeLog: Array.isArray(job.routeLog) ? job.routeLog : [],
    /** What the host says it is doing: queued, building, deploying, live, failed. */
    stage: job.stage,
    stageTimes: (job.stageTimes ?? {}) as Record<string, string>,
    hostMessage: job.hostMessage,
    stateLabel: notice
      ? notice
      : late
        ? HOST_LATE_LABEL
        : built && waiting
          ? "Committed — waiting for the build and deploy"
          : built && job.state === "VERIFY_FAILED"
            ? "Committed, but the built site still shows the old version — check the build on your host"
            : PUBLISH_JOB_STATES[job.state],
    pageId: job.pageId,
    sharedElementId: job.sharedElementId,
    commit: job.commitSha ? { sha: job.commitSha, url: job.commitUrl } : null,
    verifyUrl: job.verifyUrl,
    attempts: job.attempts,
    verifiedAt: job.verifiedAt,
    /** How long the host took to show it, in seconds, once it has. */
    deployedInSeconds: job.verifiedAt ? Math.max(1, Math.round((job.verifiedAt.getTime() - job.createdAt.getTime()) / 1000)) : null,
    lastError: job.lastError,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
  };
}

export const PUBLISH_JOB_STATES: Record<PublishJobState, string> = {
  QUEUED: "Queued",
  VALIDATING: "Checking the page",
  COMMITTING: "Committing",
  COMMITTED: "Committed",
  DEPLOYING: "Waiting for the host to rebuild",
  VERIFYING: "Looking at the live page",
  COMPLETED: "Live",
  CONFLICT: "The page moved underneath it",
  COMMIT_FAILED: "The commit did not happen",
  DEPLOY_FAILED: "The host did not rebuild",
  VERIFY_FAILED: "Committed, but the live page has not changed",
  RECONCILIATION_REQUIRED: "Needs checking by hand",
};

/**
 * Reading a publish back.
 *
 * Two routes and both are site-scoped, because that is where the record of who
 * may see a website lives — a job id on its own would be authorising on a value
 * the caller supplied.
 */
export function registerWebsitePublishJobs(
  router: import("express").Router,
  access: { loadSite: (req: import("express").Request, id: string) => Promise<Site> },
) {
  const handler = (fn: (req: import("express").Request, res: import("express").Response) => Promise<unknown>) =>
    (req: import("express").Request, res: import("express").Response, next: (error?: unknown) => void) => {
      void fn(req, res).catch(next);
    };

  router.get("/sites/:siteId/publish-jobs", handler(async (req, res) => {
    const site = await access.loadSite(req, req.params.siteId);
    const jobs = await prisma.publishJob.findMany({
      where: { siteId: site.id },
      orderBy: { createdAt: "desc" },
      take: 25,
      include: { page: { select: { id: true, title: true, path: true } }, startedBy: { select: { id: true, name: true } } },
    });
    // Only asked when something is still waiting: nobody needs GitHub's health
    // to read a list of finished publishes.
    const github = jobs.some((job) => WAITING_STATES.includes(job.state)) ? await githubHealth() : null;
    res.json({
      jobs: jobs.map((job) => {
        const view = publishJobView(job, { github });
        return { ...view, page: job.page, startedBy: job.startedBy, label: view.stateLabel };
      }),
    });
  }));

  router.get("/sites/:siteId/publish-jobs/:jobId", handler(async (req, res) => {
    const site = await access.loadSite(req, req.params.siteId);
    const job = await prisma.publishJob.findFirst({ where: { id: req.params.jobId, siteId: site.id } });
    if (!job) {
      res.status(404).json({ error: "That publish is not on this website." });
      return;
    }
    const pending = capacity.edge ? await prisma.cacheInvalidation.count({ where: { siteId: site.id, resource: "pages", deliveredAt: null } }) : 0;
    const view = publishJobView(job, { github: WAITING_STATES.includes(job.state) ? await githubHealth() : null });
    res.json({ ...view, label: view.stateLabel, cdnState: capacity.edge ? pending ? "PENDING" : "PROPAGATED" : "DISABLED" });
  }));
}
