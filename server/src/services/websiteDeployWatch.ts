import type { Site } from "@prisma/client";
import { GitHubError, githubRead, githubRepoWrite, repoFullName, withGithubCredential } from "../lib/github.js";
import { siteRepo, underSiteCredential } from "./website/site.js";
import { pagesAppCredential } from "./githubApp.js";
import type { DeployHost } from "./websiteDeployDetect.js";
import { hostFromCheck, hostFromDeployment, hostFromStatusContext, isProductionEnvironment } from "./websiteDeployDetect.js";

/**
 * What the host says it is doing with a commit.
 *
 * The live-page check in websitePublishJobs.ts answers "is it live yet", and
 * that is the only answer that counts. It cannot say *why* not: a build still
 * queued behind somebody else's, one running, or one that failed and will
 * never finish. Those are different things to tell a person. The hosts leave
 * their progress on GitHub (deployments and their statuses, check runs, commit
 * statuses, and the Actions runs GitHub Pages builds on), so it is read from
 * there and turned into five stages: queued, building, deploying, live, failed.
 *
 * Every read is allowed to fail. Without the app's new read permissions this
 * returns null and the live-page check carries on alone, exactly as before.
 */

export type HostStage = "queued" | "building" | "deploying" | "live" | "failed";
export const STAGE_ORDER: readonly HostStage[] = ["queued", "building", "deploying", "live"];

export type HostProgress = {
  stage: HostStage;
  /** The host's own words, for a failure. */
  message?: string;
  /** What reported it, for the support screen. */
  source: string;
  /** How to ask for the build again, when GitHub can be asked. */
  retry?: { kind: "pages-build" } | { kind: "actions-run"; runId: number };
};

/** A GitHub deployment status. */
export function stageFromDeploymentState(state: string | undefined): HostStage | null {
  switch (state) {
    case "queued":
    case "pending":
      return "queued";
    case "in_progress":
      return "deploying";
    case "success":
      return "live";
    case "failure":
    case "error":
      return "failed";
    default:
      return null;
  }
}

/** A check run or an Actions workflow run: status, then conclusion. */
export function stageFromRun(status: string | undefined, conclusion: string | null | undefined): HostStage | null {
  if (status === "queued" || status === "waiting" || status === "requested" || status === "pending") return "queued";
  if (status === "in_progress") return "building";
  if (status !== "completed") return null;
  if (conclusion === "success") return "live";
  if (conclusion === "failure" || conclusion === "timed_out" || conclusion === "startup_failure") return "failed";
  // Cancelled usually means a newer commit superseded it, which is not a failure of this one.
  return null;
}

/** A commit status: pending, success, failure, error. */
export function stageFromCommitStatus(state: string | undefined): HostStage | null {
  if (state === "pending") return "building";
  if (state === "success") return "live";
  if (state === "failure" || state === "error") return "failed";
  return null;
}

/** GitHub Pages' legacy build record. */
export function stageFromPagesBuild(status: string | undefined): HostStage | null {
  if (status === "queued") return "queued";
  if (status === "building") return "building";
  if (status === "built") return "live";
  if (status === "errored") return "failed";
  return null;
}

/**
 * One answer from several reporters. Something live wins; then the furthest
 * stage still moving; a failure only when nothing else is still going, because
 * a retry that is building must not be reported as the failure it replaced.
 */
export function combineProgress(found: Array<HostProgress | null>): HostProgress | null {
  const present = found.filter((entry): entry is HostProgress => Boolean(entry));
  const live = present.find((entry) => entry.stage === "live");
  if (live) return live;
  const moving = present.filter((entry) => entry.stage !== "failed").sort((left, right) => STAGE_ORDER.indexOf(right.stage) - STAGE_ORDER.indexOf(left.stage));
  if (moving.length) return moving[0]!;
  return present.find((entry) => entry.stage === "failed") ?? null;
}

const quietly = async <T>(work: () => Promise<T>): Promise<T | null> => {
  try {
    return await work();
  } catch (error) {
    if (error instanceof GitHubError) return null;
    throw error;
  }
};

/** Reads what every reporter says about one commit. */
export async function readHostProgress(site: Site, commitSha: string, host: DeployHost | null): Promise<HostProgress | null> {
  const repo = siteRepo(site);
  if (!repo) return null;
  return underSiteCredential(site, async () => {
    const full = await repoFullName(repo);
    const found: Array<HostProgress | null> = [];

    const deployments = await quietly(() => githubRead<Array<{ id: number; environment: string; creator?: { login?: string } }>>(`/repos/${full}/deployments?sha=${commitSha}&per_page=10`));
    for (const deployment of (deployments ?? []).filter((entry) => isProductionEnvironment(entry.environment))) {
      const statuses = await quietly(() => githubRead<Array<{ state: string; description?: string }>>(`/repos/${full}/deployments/${deployment.id}/statuses?per_page=1`));
      const latest = statuses?.[0];
      const stage = latest ? stageFromDeploymentState(latest.state) : "queued";
      if (stage) found.push({ stage, message: stage === "failed" ? latest?.description || undefined : undefined, source: `${hostFromDeployment(deployment) ?? "host"} deployment` });
    }

    const checks = await quietly(() => githubRead<{ check_runs?: Array<{ status: string; conclusion: string | null; app?: { slug?: string }; output?: { title?: string | null; summary?: string | null } }> }>(`/repos/${full}/commits/${commitSha}/check-runs?per_page=30`));
    for (const run of checks?.check_runs ?? []) {
      const by = hostFromCheck(run.app?.slug);
      if (!by) continue;
      const stage = stageFromRun(run.status, run.conclusion);
      if (stage) found.push({ stage, message: stage === "failed" ? run.output?.title || run.output?.summary?.slice(0, 300) || undefined : undefined, source: `${by} check` });
    }

    const statuses = await quietly(() => githubRead<{ statuses?: Array<{ context: string; state: string; description?: string }> }>(`/repos/${full}/commits/${commitSha}/status`));
    for (const status of statuses?.statuses ?? []) {
      const by = hostFromStatusContext(status.context);
      if (!by || /preview/i.test(status.context)) continue;
      const stage = stageFromCommitStatus(status.state);
      if (stage) found.push({ stage, message: stage === "failed" ? status.description || undefined : undefined, source: `${by} status` });
    }

    // GitHub Pages builds on Actions, whether the site uses a workflow or the
    // classic branch build (which runs as "pages-build-deployment").
    if (!host || host === "github-pages" || host === "unknown") {
      const runs = await quietly(() => githubRead<{ workflow_runs?: Array<{ id: number; name?: string; path?: string; status: string; conclusion: string | null; event?: string }> }>(`/repos/${full}/actions/runs?head_sha=${commitSha}&per_page=20`));
      for (const run of (runs?.workflow_runs ?? []).filter((entry) => /pages/i.test(`${entry.name ?? ""} ${entry.path ?? ""}`))) {
        const stage = stageFromRun(run.status, run.conclusion);
        if (stage) found.push({ stage, message: stage === "failed" ? `The GitHub Pages build "${run.name ?? "pages"}" failed.` : undefined, source: "GitHub Pages build", retry: stage === "failed" ? (run.event === "dynamic" || run.name === "pages-build-deployment" ? { kind: "pages-build" } : { kind: "actions-run", runId: run.id }) : undefined });
      }
      if (!runs) {
        const build = await quietly(() => githubRead<{ status?: string; commit?: string; error?: { message?: string | null } }>(`/repos/${full}/pages/builds/latest`));
        if (build && build.commit === commitSha) {
          const stage = stageFromPagesBuild(build.status);
          if (stage) found.push({ stage, message: stage === "failed" ? build.error?.message || "The GitHub Pages build failed." : undefined, source: "GitHub Pages build", retry: stage === "failed" ? { kind: "pages-build" } : undefined });
        }
      }
    }

    return combineProgress(found);
  });
}

/**
 * Asks GitHub to build a failed GitHub Pages deploy again. Needs Pages or
 * Actions write, which only the opt-in DakyX Pages app holds; without it this
 * says so rather than failing a publish.
 */
export async function retryPagesBuild(site: Site, retry: NonNullable<HostProgress["retry"]>): Promise<{ ok: boolean; reason?: string }> {
  const repo = siteRepo(site);
  if (!repo) return { ok: false, reason: "No repository." };
  const credential = await pagesAppCredential(site).catch(() => null);
  if (!credential) return { ok: false, reason: "Rebuilding automatically needs the DakyX Pages app on this repository." };
  try {
    await withGithubCredential(credential, () =>
      retry.kind === "pages-build"
        ? githubRepoWrite(repo, "/pages/builds", "POST")
        : githubRepoWrite(repo, `/actions/runs/${retry.runId}/rerun`, "POST"),
    );
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "GitHub refused the rebuild." };
  }
}
