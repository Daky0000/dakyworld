import { createHash } from "node:crypto";
import type { Prisma, PublishJob, PublishJobState, Site, SitePage } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { readFile } from "../lib/github.js";
import { fetchWebsiteText } from "../lib/websiteFetch.js";
import { pageUrl, repoFilePath, siteRepo } from "./website/site.js";
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

/** How long to keep asking the live site, and how often. */
const VERIFY_ATTEMPTS = 8;
// The first look is early on purpose: a static host can rebuild in well under a
// minute, and starting at twenty seconds left those jobs sitting in VERIFYING
// for minutes after the page was already live. The number of looks and the
// twelve minutes they span are unchanged — only their spacing is, so a slow
// host is given exactly as long as it was before.
const VERIFY_BACKOFF_MS = [10_000, 20_000, 30_000, 45_000, 60_000, 90_000, 180_000, 300_000];

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
}): Promise<void> {
  await prisma.publishJob.update({
    where: { id: input.id },
    data: {
      state: "DEPLOYING",
      commitSha: input.commit.sha,
      commitUrl: input.commit.url,
      verifyUrl: pageUrl(input.site, input.page),
      verifyText: verificationText(input.summary),
      expectedHash: hash(input.html),
      nextCheckAt: new Date(Date.now() + VERIFY_BACKOFF_MS[0]!),
      attempts: 0,
    },
  });
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
      nextCheckAt: new Date(Date.now() + VERIFY_BACKOFF_MS[0]!),
      attempts: 0,
    },
  });
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
async function verifyOne(job: PublishJob): Promise<{ verified: boolean; error?: string }> {
  if (!job.verifyUrl) return { verified: true };
  try {
    const body = await fetchWebsiteText(job.verifyUrl);
    return { verified: livePageShowsChange({ body, verifyText: job.verifyText, expectedHash: job.expectedHash }) };
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
 * a backoff that gives up too early reports a working site as broken, and one
 * that never gives up leaves a row saying "waiting" for ever, which is the same
 * silence the whole feature was built to end.
 */
export function decideVerification(input: { verified: boolean; attempts: number; error?: string }): VerificationStep {
  if (input.verified) return { state: "COMPLETED" };
  if (input.attempts >= VERIFY_ATTEMPTS) {
    return {
      state: "VERIFY_FAILED",
      reason:
        input.error ??
        "The commit is in the repository, but the live page still shows the old version. The host may not have rebuilt, or it may be serving a cached copy.",
    };
  }
  return { state: "VERIFYING", nextCheckInMs: VERIFY_BACKOFF_MS[input.attempts] ?? 300_000 };
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

/**
 * Every job waiting to be seen live, checked once.
 *
 * Runs on the app's own minute tick. Deliberately not a tight poll: a static
 * host takes tens of seconds to a couple of minutes, so the backoff walks from
 * twenty seconds out to five minutes and then stops asking. Stopping is a
 * result — `VERIFY_FAILED` means the commit is in the repository and the live
 * site did not change, which is a real thing that happens and needs somebody.
 */
export async function verifyDuePublishJobs(now = new Date()): Promise<number> {
  const due = await prisma.publishJob.findMany({
    where: { state: { in: ["DEPLOYING", "VERIFYING"] }, nextCheckAt: { lte: now } },
    orderBy: { nextCheckAt: "asc" },
    take: 10,
  });

  let settled = 0;
  for (const job of due) {
    const attempts = job.attempts + 1;
    const result = await verifyOne(job);
    const step = decideVerification({ verified: result.verified, attempts, error: result.error });

    if (step.state === "COMPLETED") {
      await prisma.publishJob.update({
        where: { id: job.id },
        data: { state: "COMPLETED", attempts, verifiedAt: now, finishedAt: now, nextCheckAt: null, lastError: null },
      });
      settled += 1;
    } else if (step.state === "VERIFY_FAILED") {
      await prisma.publishJob.update({
        where: { id: job.id },
        data: { state: "VERIFY_FAILED", attempts, nextCheckAt: null, finishedAt: now, lastError: step.reason },
      });
      settled += 1;
    } else {
      await prisma.publishJob.update({
        where: { id: job.id },
        data: { state: "VERIFYING", attempts, nextCheckAt: new Date(now.getTime() + step.nextCheckInMs), lastError: result.error ?? null },
      });
    }
  }
  return settled;
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
export async function reconcileInterruptedPublishJobs(): Promise<number> {
  const stuck = await prisma.publishJob.findMany({
    where: { state: { in: ["QUEUED", "VALIDATING", "COMMITTING"] } },
    include: { site: true, page: true },
    take: 20,
  });

  let handled = 0;
  for (const job of stuck) {
    if (job.state !== "COMMITTING") {
      await failPublishJob(job.id, "COMMIT_FAILED", "The publish was interrupted before anything was committed. Nothing was changed; publish again.");
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
    if (live !== null && hash(live) === detail.expectedHtmlHash) {
      await failPublishJob(
        job.id,
        "RECONCILIATION_REQUIRED",
        "The commit reached the repository but this system was interrupted before recording it. The live site will update; the version history here is missing this publish.",
      );
    } else {
      await failPublishJob(job.id, "COMMIT_FAILED", "The publish was interrupted before the commit landed. Nothing was changed; publish again.");
    }
    handled += 1;
  }
  return handled;
}

/** What the editor shows after a publish, and on the site's activity screen. */
export function publishJobView(job: PublishJob) {
  // A framework publish commits a source file, and nobody sees it until the
  // host has built the project — minutes, not the seconds a static host takes.
  // "Waiting for the host to rebuild" is true of both and useless for this one,
  // because the thing being waited on is a build that can fail on its own terms.
  const built = Boolean((job.detail as { source?: unknown } | null)?.source);
  return {
    id: job.id,
    kind: job.kind,
    state: job.state,
    /** True when what was committed is source that has to be built first. */
    fromSource: built,
    stateLabel: built && (job.state === "DEPLOYING" || job.state === "VERIFYING")
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
    res.json({
      jobs: jobs.map((job) => ({
        ...publishJobView(job),
        page: job.page,
        startedBy: job.startedBy,
        label: publishJobView(job).stateLabel,
      })),
    });
  }));

  router.get("/sites/:siteId/publish-jobs/:jobId", handler(async (req, res) => {
    const site = await access.loadSite(req, req.params.siteId);
    const job = await prisma.publishJob.findFirst({ where: { id: req.params.jobId, siteId: site.id } });
    if (!job) {
      res.status(404).json({ error: "That publish is not on this website." });
      return;
    }
    res.json({ ...publishJobView(job), label: publishJobView(job).stateLabel });
  }));
}
