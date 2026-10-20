import type { Prisma, PublishJob, Site } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { SETTING, getSetting } from "../lib/settings.js";
import { siteRepo } from "./website/site.js";
import { deployProfileOf, FAST_ROUTES, type DeployProfile, type FastRoute } from "./websiteDeployDetect.js";
import { callDeployHook, storedHook } from "./websiteDeployHook.js";
import { directDeploy, directEligible } from "./publishRoutes/direct.js";

/**
 * Which way a publish goes live, chosen per site, after the commit.
 *
 * Every publish commits to GitHub first, as it always has: the repository stays
 * the record, and the host's own deploy from that commit is the route every site
 * has on day one with nothing set up (Route D, "follow the host"). On top of it,
 * a site may have faster routes, each an upgrade the customer turned on once:
 *
 * - **direct** (Route A): the files are uploaded straight to Netlify or Vercel,
 *   for a site with no build step, through the customer's own sign-in;
 * - **pages** (Route P): GitHub Pages builds from DakyX's own workflow, which
 *   skips Jekyll and the classic build queue. Nothing to call: the commit
 *   starts it. It is recorded so the activity screen can say which route ran;
 * - **hook**: the host's deploy hook, for a host that does not deploy on push.
 *
 * Routes stack. A directly uploaded site still has its host deploy, and the watcher
 * (websitePublishJobs.ts) follows every publish until the change is seen live,
 * whichever route got it there. A fast route that fails or runs out of time is
 * recorded as `fallbackFrom` and the publish carries on: nobody is asked to do
 * anything about a failed fast route, and the settings screen says what to
 * reconnect.
 *
 * Every fast route can be switched off globally (SETTING.PUBLISH_ROUTES_DISABLED)
 * and per site (`deployProfile.disabledRoutes`). Following the host cannot be
 * switched off, because it is what all of them fall back to.
 *
 * Nothing here puts DakyX in a visitor's path. An edge bridge in front of the
 * customer's host (the plan's Route B) was built and then removed on 20 Oct
 * 2026 (Dan): it meant DakyX running infrastructure that every visit to a
 * customer's site passes through, which is hosting in all but name.
 */

export type RouteOutcome = { route: FastRoute; ok: boolean; ms: number; detail: string; at: string };

const TIMEOUT_MS: Record<FastRoute, number> = { direct: 60_000, pages: 1_000, hook: 50_000 };
/** Which route takes the credit when several succeed: the one the visitor sees first. */
const PRIORITY: readonly FastRoute[] = ["direct", "pages", "hook"];

/** Routes switched off everywhere, from the setting or the deploy. */
export async function globallyDisabledRoutes(): Promise<Set<FastRoute>> {
  const raw = (await getSetting(SETTING.PUBLISH_ROUTES_DISABLED)) ?? "";
  return new Set(raw.split(/[\s,]+/).filter((entry): entry is FastRoute => FAST_ROUTES.includes(entry as FastRoute)));
}

export async function disabledRoutesFor(profile: DeployProfile | null): Promise<Set<FastRoute>> {
  const off = await globallyDisabledRoutes();
  for (const route of profile?.disabledRoutes ?? []) off.add(route);
  return off;
}

/** Runs one route against its time limit and says how it went. Never throws. */
export async function tryRoute(route: FastRoute, work: () => Promise<string>, timeoutMs = TIMEOUT_MS[route]): Promise<RouteOutcome> {
  const started = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    const detail = await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`gave up after ${Math.round(timeoutMs / 1000)} seconds`)), timeoutMs);
        timer.unref?.();
      }),
    ]);
    return { route, ok: true, ms: Date.now() - started, detail, at: new Date(started).toISOString() };
  } catch (error) {
    return { route, ok: false, ms: Date.now() - started, detail: error instanceof Error ? error.message : "failed", at: new Date(started).toISOString() };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Which route the publish is credited to, and which faster one failed first. */
export function settleRoutes(log: RouteOutcome[]): { route: FastRoute | "follow"; fallbackFrom: FastRoute | null } {
  const ok = PRIORITY.find((route) => log.some((entry) => entry.route === route && entry.ok));
  const failed = PRIORITY.find((route) => log.some((entry) => entry.route === route && !entry.ok));
  return { route: ok ?? "follow", fallbackFrom: failed && (!ok || PRIORITY.indexOf(failed) < PRIORITY.indexOf(ok)) ? failed : null };
}

/**
 * The job, once its commit is recorded. `publishJobCommitted` runs inside the
 * publish's transaction, so the dispatch it schedules may look before that
 * transaction commits; it waits a few seconds, and gives up quietly if the
 * transaction rolled back.
 */
async function committedJob(jobId: string): Promise<(PublishJob & { site: Site }) | null> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const job = await prisma.publishJob.findUnique({ where: { id: jobId }, include: { site: true } });
    if (job?.commitSha && ["DEPLOYING", "VERIFYING", "COMPLETED"].includes(job.state)) return job;
    if (job && ["COMMIT_FAILED", "CONFLICT", "RECONCILIATION_REQUIRED"].includes(job.state)) return null;
    await new Promise<void>((resolve) => setTimeout(resolve, 250).unref?.());
  }
  return null;
}

/** Runs every fast route this site has, after a commit, and records how they went. */
export async function dispatchPublish(jobId: string): Promise<RouteOutcome[]> {
  const job = await committedJob(jobId);
  if (!job || !siteRepo(job.site) || !job.commitSha) return [];
  const site = job.site;
  const profile = deployProfileOf(site);
  const off = await disabledRoutesFor(profile);
  const log: RouteOutcome[] = [];

  if (!off.has("direct")) {
    const eligible = await directEligible(site, profile);
    if (eligible) log.push(await tryRoute("direct", () => directDeploy(site, job, profile!, eligible)));
  }

  if (!off.has("pages") && profile?.routes.pages?.workflowInstalled) {
    log.push(await tryRoute("pages", async () => "GitHub Pages builds this commit from the DakyX workflow."));
  }

  // A hook starts a second build on a host that already deploys on push, so it
  // is called only where detection has not seen the host do that.
  const hook = storedHook(site);
  if (hook && !off.has("hook") && profile?.answer !== "auto") {
    log.push(await tryRoute("hook", async () => {
      const called = await callDeployHook(hook);
      if (!called.ok) throw new Error(called.reason);
      return `The host's deploy hook accepted the build (${called.status}${called.attempts > 1 ? `, attempt ${called.attempts}` : ""}).`;
    }));
  }

  const settled = settleRoutes(log);
  await prisma.publishJob
    .update({ where: { id: job.id }, data: { route: settled.route, fallbackFrom: settled.fallbackFrom, routeLog: log as unknown as Prisma.InputJsonValue } })
    .catch(() => undefined);
  return log;
}

/** Fire-and-forget, from the moment a commit is recorded. A failure here never fails a publish. */
export function schedulePublishDispatch(jobId: string): void {
  if (process.env.PUBLISH_DISPATCH === "off") return;
  const timer = setTimeout(() => {
    void dispatchPublish(jobId).catch((error) => console.error(`[publish-router] ${jobId}:`, error));
  }, 25);
  timer.unref?.();
}
