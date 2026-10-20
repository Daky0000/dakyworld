import { promises as dns } from "node:dns";
import type { Prisma, Site } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { GitHubError, githubRead, listRepoFiles, readFile, repoFullName } from "../lib/github.js";
import { fetchWebsitePage } from "../lib/websiteFetch.js";
import { hostFromHeaders } from "./githubStatus.js";
import { siteRepo, underSiteCredential } from "./website/site.js";

/**
 * How a site goes live after a publish, worked out rather than asked.
 *
 * A publish is a commit. Whether that commit reaches the public page depends on
 * a host this system does not run: GitHub Pages building the branch, Vercel or
 * Netlify hearing about the push, Hostinger pulling it, or nobody at all. The
 * customer cannot be asked, because most of them do not know, and a deploy hook
 * URL is a secret the host never lets anyone read back. So it is detected from
 * five kinds of evidence:
 *
 * 1. the live page's response headers (which host answered);
 * 2. DNS (where the domain points);
 * 3. GitHub's records of deploys: deployments, check runs and commit statuses
 *    that Vercel, Netlify, Cloudflare and GitHub Pages leave on each commit;
 * 4. the repository: its Pages settings, webhooks, workflows and config files;
 * 5. what happened to the last publishes.
 *
 * Four answers. **auto**: the host deploys this branch on its own. **needs-hook**:
 * a host was found, and the evidence says a commit alone does not reach it.
 * **branch-mismatch**: the host deploys a different branch or folder from the one
 * publishing writes to, so a publish would never appear. That one is a silent
 * failure, which is why it is detected before the first publish. **unsure**: not
 * enough evidence. It says so instead of guessing, and learns from the next
 * publish. Hostinger's newer GitHub auto-deploy leaves no trace anywhere, so for
 * it, watching a publish go live is the only evidence there can be.
 *
 * Every GitHub read is allowed to fail. A customer who has not yet approved the
 * app's new read permissions still gets an answer from headers, DNS, files and
 * the last publish, and `missingAccess` says what approving would add.
 */

export type DeployHost = "github-pages" | "vercel" | "netlify" | "cloudflare-pages" | "hostinger" | "render" | "unknown";
export type DeployAnswer = "auto" | "needs-hook" | "branch-mismatch" | "unsure";
export type FastRoute = "direct" | "pages" | "hook";
export const FAST_ROUTES: readonly FastRoute[] = ["direct", "pages", "hook"];

export type EvidenceKind = "headers" | "dns" | "deployments" | "checks" | "statuses" | "pages" | "hooks" | "files" | "workflows" | "observed";

export type Evidence = {
  kind: EvidenceKind;
  host?: DeployHost;
  /** What was seen, in words for the support screen. */
  detail: string;
  /** This says which host serves the public page (headers, DNS). */
  serves?: boolean;
  /** This says a host deploys commits on its own. */
  deploys?: boolean;
  /** The branch a host deploys from, when the evidence says. */
  branch?: string;
  /** The folder a host serves from, when the evidence says. */
  folder?: string;
  /** This says the host did *not* pick up a publish. */
  missed?: boolean;
};

export type PagesFacts = {
  buildType: "legacy" | "workflow" | null;
  branch?: string;
  folder?: string;
  htmlUrl?: string;
  cname?: string | null;
  /** `.nojekyll` sits in the folder Pages serves. */
  noJekyll: boolean;
  /** `_config.yml` is there, so Jekyll is doing real work and must not be skipped. */
  jekyllContent: boolean;
};

export type DeployProfile = {
  host: DeployHost;
  answer: DeployAnswer;
  evidence: Evidence[];
  deployBranch?: string;
  deployFolder?: string;
  /** null: not known, which makes the site ineligible for a direct upload. */
  hasBuildStep: boolean | null;
  /** Median seconds from publish to live, over the last five that went live. */
  typicalSeconds?: number;
  lastCheckedAt: string;
  /** GitHub refused these reads: the app's new read permissions are not approved yet. */
  missingAccess: string[];
  pages?: PagesFacts;
  routes: {
    /** Route P: DakyX's Pages workflow is in the repository and Pages builds from it. */
    pages?: { workflowInstalled: boolean };
  };
  /** Faster routes switched off for this site. Kept across detections. */
  disabledRoutes: FastRoute[];
  /** The branch publishing writes to is not in the repository: every publish would fail. */
  branchMissing?: boolean;
  /** The credential the site publishes with cannot write to the repository. null: not known. */
  canWrite?: boolean | null;
  /** Where GitHub Pages built from before Route P switched it, for undo. Kept across detections. */
  pagesPrevious?: { branch: string; folder: string };
};

/** The workflow Route P installs. Detection recognises it by this path. */
export const PAGES_WORKFLOW_PATH = ".github/workflows/dakyx-pages.yml";

/** A stored profile, or a blank one, read without trusting its shape. */
export function deployProfileOf(site: Pick<Site, "deployProfile">): DeployProfile | null {
  const raw = site.deployProfile as Partial<DeployProfile> | null;
  if (!raw || typeof raw !== "object" || typeof raw.host !== "string") return null;
  return {
    host: raw.host,
    answer: raw.answer ?? "unsure",
    evidence: Array.isArray(raw.evidence) ? raw.evidence : [],
    deployBranch: raw.deployBranch,
    deployFolder: raw.deployFolder,
    hasBuildStep: raw.hasBuildStep ?? null,
    typicalSeconds: raw.typicalSeconds,
    lastCheckedAt: raw.lastCheckedAt ?? new Date(0).toISOString(),
    missingAccess: Array.isArray(raw.missingAccess) ? raw.missingAccess : [],
    pages: raw.pages,
    routes: raw.routes ?? {},
    disabledRoutes: Array.isArray(raw.disabledRoutes) ? raw.disabledRoutes.filter((route): route is FastRoute => FAST_ROUTES.includes(route as FastRoute)) : [],
    pagesPrevious: raw.pagesPrevious,
    branchMissing: raw.branchMissing,
    canWrite: raw.canWrite,
  };
}

/* ------------------------------------------------------------ reading names */

const HOST_FROM_HEADER: Record<string, DeployHost> = {
  "github-pages": "github-pages",
  vercel: "vercel",
  netlify: "netlify",
  hostinger: "hostinger",
  render: "render",
};

/** Which host a CNAME target or address belongs to. */
export function hostFromDns(cnames: string[], addresses: string[]): DeployHost | null {
  for (const name of cnames.map((value) => value.toLowerCase().replace(/\.$/, ""))) {
    if (name.endsWith(".github.io")) return "github-pages";
    if (name.endsWith("vercel-dns.com") || name.endsWith(".vercel.app")) return "vercel";
    if (name.endsWith(".netlify.app") || name.endsWith(".netlify.com") || name.endsWith(".netlifyglobalcdn.com")) return "netlify";
    if (name.endsWith(".pages.dev")) return "cloudflare-pages";
    if (name.includes("hostinger") || name.endsWith(".hostingersite.com")) return "hostinger";
    if (name.endsWith(".onrender.com")) return "render";
  }
  for (const address of addresses) {
    if (/^185\.199\.(108|109|110|111)\.153$/.test(address)) return "github-pages";
    if (/^76\.76\.21\.\d+$/.test(address)) return "vercel";
    if (address === "75.2.60.5" || address === "99.83.231.61") return "netlify";
    if (address === "216.24.57.1") return "render";
  }
  return null;
}

/** Which host left a GitHub deployment, from who made it and what it is called. */
export function hostFromDeployment(deployment: { creator?: { login?: string } | null; environment?: string; payload?: unknown }): DeployHost | null {
  const login = (deployment.creator?.login ?? "").toLowerCase();
  const environment = (deployment.environment ?? "").toLowerCase();
  if (environment === "github-pages") return "github-pages";
  if (login.startsWith("vercel")) return "vercel";
  if (login.startsWith("netlify")) return "netlify";
  if (login.startsWith("cloudflare")) return "cloudflare-pages";
  if (login.startsWith("render")) return "render";
  return null;
}

/** Whether a deployment environment is the live one rather than a preview. */
export function isProductionEnvironment(environment: string | undefined): boolean {
  const value = (environment ?? "").toLowerCase();
  if (/preview|staging|development|test/.test(value)) return false;
  return value === "github-pages" || value.includes("production");
}

export function hostFromCheck(slug: string | undefined): DeployHost | null {
  const value = (slug ?? "").toLowerCase();
  if (value === "vercel") return "vercel";
  if (value.startsWith("netlify")) return "netlify";
  if (value.startsWith("cloudflare")) return "cloudflare-pages";
  if (value === "github-pages") return "github-pages";
  if (value.startsWith("render")) return "render";
  return null;
}

export function hostFromStatusContext(context: string | undefined): DeployHost | null {
  const value = (context ?? "").toLowerCase();
  if (value.startsWith("vercel")) return "vercel";
  if (value.startsWith("netlify")) return "netlify";
  if (value.startsWith("cloudflare pages") || value.startsWith("cloudflare")) return "cloudflare-pages";
  if (value.startsWith("render")) return "render";
  return null;
}

export function hostFromHookUrl(url: string | undefined): DeployHost | null {
  const value = (url ?? "").toLowerCase();
  if (value.includes("netlify.com")) return "netlify";
  if (value.includes("vercel.com")) return "vercel";
  if (value.includes("cloudflare.com")) return "cloudflare-pages";
  if (value.includes("hostinger")) return "hostinger";
  if (value.includes("render.com")) return "render";
  return null;
}

/**
 * What a workflow file deploys, and on which branches. Read as text: a YAML
 * parser would be exact, and nothing here needs exactness beyond "this uses the
 * Pages deploy action and runs on pushes to main".
 */
export function readWorkflow(text: string): { host: DeployHost | null; pushBranches: string[] | null; deploysToBranch?: string } {
  const host: DeployHost | null =
    /actions\/deploy-pages@/.test(text) ? "github-pages"
      : /peaceiris\/actions-gh-pages@|JamesIves\/github-pages-deploy-action@/.test(text) ? "github-pages"
        : /cloudflare\/(pages-action|wrangler-action)@|wrangler\s+pages\s+deploy/.test(text) ? "cloudflare-pages"
          : /netlify\s+deploy|nwtgck\/actions-netlify@/.test(text) ? "netlify"
            : /vercel\s+(deploy|--prod)|amondnet\/vercel-action@/.test(text) ? "vercel"
              : /hostinger/i.test(text) ? "hostinger"
                : null;
  // `on: push: branches: [main]` in its flow and block forms.
  let pushBranches: string[] | null = null;
  const flow = text.match(/push:\s*\n\s+branches:\s*\[([^\]]*)\]/);
  if (flow) pushBranches = flow[1]!.split(",").map((entry) => entry.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  else {
    const block = text.match(/push:\s*\n\s+branches:\s*\n((?:\s+-\s*.+\n?)+)/);
    if (block) pushBranches = block[1]!.split("\n").map((line) => line.replace(/^\s*-\s*/, "").trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    else if (/on:\s*\[?\s*push\b|on:\s*\n\s+push:\s*(\n|$)/.test(text)) pushBranches = [];
  }
  // A workflow that builds and pushes to a `gh-pages` branch: Pages then serves that branch.
  const target = text.match(/publish_branch:\s*([\w./-]+)|branch:\s*(gh-pages)\b/);
  return { host, pushBranches, deploysToBranch: target ? target[1] ?? target[2] : undefined };
}

/** `/docs` and `docs/` and `docs` are one folder; `/` and `` are the root. */
export function sameFolder(left: string | undefined, right: string | undefined): boolean {
  const clean = (value: string | undefined) => (value ?? "").replace(/^\/+|\/+$/g, "");
  return clean(left) === clean(right);
}

/* ----------------------------------------------------------------- deciding */

const WEIGHT: Partial<Record<EvidenceKind, number>> = { headers: 3, dns: 2, deployments: 3, checks: 2, statuses: 2, pages: 3, hooks: 1, workflows: 2, files: 1, observed: 1 };

function vote(evidence: Evidence[]): DeployHost | null {
  const tally = new Map<DeployHost, number>();
  for (const entry of evidence) {
    if (!entry.host || entry.host === "unknown") continue;
    tally.set(entry.host, (tally.get(entry.host) ?? 0) + (WEIGHT[entry.kind] ?? 1));
  }
  let best: DeployHost | null = null;
  let score = 0;
  for (const [host, value] of tally) if (value > score) { best = host; score = value; }
  return best;
}

/**
 * The answer, from the evidence alone. No network in here, so the checks can
 * hand it any combination of findings and hold it to the result.
 */
export function decideProfile(input: {
  evidence: Evidence[];
  repoBranch: string;
  repoPath: string;
  pages?: PagesFacts;
  /** Reads that were refused, so "nothing found" is not mistaken for "nothing there". */
  missingAccess: string[];
}): Pick<DeployProfile, "host" | "answer" | "deployBranch" | "deployFolder"> {
  const { evidence, repoBranch, repoPath, pages } = input;
  const host = vote(evidence.filter((entry) => entry.serves)) ?? vote(evidence.filter((entry) => entry.deploys)) ?? vote(evidence) ?? "unknown";

  // GitHub Pages decides from its own settings, which say exactly what it serves.
  if (host === "github-pages" && pages?.buildType === "legacy") {
    if (pages.branch && pages.branch !== repoBranch) return { host, answer: "branch-mismatch", deployBranch: pages.branch, deployFolder: pages.folder };
    if (!sameFolder(pages.folder, repoPath)) return { host, answer: "branch-mismatch", deployBranch: pages.branch, deployFolder: pages.folder };
    return { host, answer: "auto", deployBranch: pages.branch, deployFolder: pages.folder };
  }

  const forHost = (entry: Evidence) => !entry.host || entry.host === host || host === "unknown";
  const deploying = evidence.filter((entry) => entry.deploys && forHost(entry));
  const onBranch = deploying.filter((entry) => !entry.branch || entry.branch === repoBranch);
  const elsewhere = deploying.filter((entry) => entry.branch && entry.branch !== repoBranch);
  const folder = evidence.find((entry) => entry.folder !== undefined && forHost(entry))?.folder;

  if (onBranch.length) return { host, answer: "auto", deployBranch: repoBranch, deployFolder: folder };
  if (elsewhere.length) return { host, answer: "branch-mismatch", deployBranch: elsewhere[0]!.branch, deployFolder: folder };
  if (host === "unknown") return { host, answer: "unsure" };

  // A host was found and nothing shows it deploying. That is only "needs a hook"
  // when it is known rather than assumed: a publish was seen not to arrive, or a
  // host that always leaves records on GitHub left none while GitHub let us look.
  const missed = evidence.some((entry) => entry.missed);
  const leavesRecords = host === "vercel" || host === "netlify" || host === "cloudflare-pages";
  const couldLook = !["deployments", "statuses", "checks"].some((area) => input.missingAccess.includes(area));
  const lookedAtCommits = evidence.some((entry) => entry.kind === "deployments" && !entry.host);
  if (missed || (leavesRecords && couldLook && lookedAtCommits)) return { host, answer: "needs-hook", deployFolder: folder };
  return { host, answer: "unsure", deployFolder: folder };
}

/** Whether the host runs a build, from the repository's own configuration. */
export function decideBuildStep(input: { files: string[] | null; sourceKind: string | null; packageJson: string | null; netlifyToml: string | null; vercelJson: string | null }): boolean | null {
  if (input.sourceKind) return true;
  if (input.files === null) return null;
  if (input.packageJson) {
    try {
      const scripts = (JSON.parse(input.packageJson) as { scripts?: Record<string, string> }).scripts ?? {};
      if (typeof scripts.build === "string" && scripts.build.trim()) return true;
    } catch {
      return null;
    }
  }
  if (input.netlifyToml && /^\s*command\s*=\s*["'][^"']+["']/m.test(input.netlifyToml)) return true;
  if (input.vercelJson) {
    try {
      const config = JSON.parse(input.vercelJson) as { buildCommand?: string | null; framework?: string | null };
      if (config.buildCommand || config.framework) return true;
    } catch {
      return null;
    }
  }
  return false;
}

/* ------------------------------------------------------------------ looking */

/** Runs one read; a refusal is recorded as missing access instead of failing detection. */
async function attempt<T>(area: string, missing: Set<string>, work: () => Promise<T>): Promise<T | null> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof GitHubError && (error.status === 403 || error.status === 401)) missing.add(area);
    return null;
  }
}

function median(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return Math.round(sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2);
}

type DnsLookup = { cname: (host: string) => Promise<string[]>; a: (host: string) => Promise<string[]> };
const realDns: DnsLookup = { cname: (host) => dns.resolveCname(host), a: (host) => dns.resolve4(host) };

/** Headers and DNS: which host serves the public address. */
async function servingEvidence(publicUrl: string, lookup: DnsLookup): Promise<Evidence[]> {
  const found: Evidence[] = [];
  let hostname: string | null = null;
  try { hostname = new URL(publicUrl).hostname; } catch { return found; }
  const page = await fetchWebsitePage(publicUrl).catch(() => null);
  if (page) {
    const named = hostFromHeaders(page.headers);
    const host = named ? HOST_FROM_HEADER[named] : undefined;
    if (host) found.push({ kind: "headers", host, serves: true, detail: `The live page was answered by ${host} (server: ${page.headers.server ?? "not given"}).` });
    else if (named === "cloudflare") found.push({ kind: "headers", detail: "The live page comes through Cloudflare, which hides the host behind it." });
    else found.push({ kind: "headers", detail: `The live page's headers do not name a known host (server: ${page.headers.server ?? "not given"}).` });
  } else {
    found.push({ kind: "headers", detail: "The live page could not be read." });
  }
  if (hostname.endsWith(".github.io")) found.push({ kind: "dns", host: "github-pages", serves: true, detail: `${hostname} is a GitHub Pages address.` });
  else if (hostname.endsWith(".vercel.app")) found.push({ kind: "dns", host: "vercel", serves: true, detail: `${hostname} is a Vercel address.` });
  else if (hostname.endsWith(".netlify.app")) found.push({ kind: "dns", host: "netlify", serves: true, detail: `${hostname} is a Netlify address.` });
  else if (hostname.endsWith(".pages.dev")) found.push({ kind: "dns", host: "cloudflare-pages", serves: true, detail: `${hostname} is a Cloudflare Pages address.` });
  else {
    const cnames = await lookup.cname(hostname).catch(() => [] as string[]);
    const addresses = cnames.length ? [] : await lookup.a(hostname).catch(() => [] as string[]);
    const host = hostFromDns(cnames, addresses);
    if (host) found.push({ kind: "dns", host, serves: true, detail: `${hostname} points at ${cnames[0] ?? addresses.join(", ")}, which is ${host}.` });
    else if (cnames.length || addresses.length) found.push({ kind: "dns", detail: `${hostname} points at ${cnames[0] ?? addresses.join(", ")}.` });
  }
  return found;
}

type GithubFacts = {
  evidence: Evidence[];
  branchMissing: boolean;
  canWrite: boolean | null;
  pages?: PagesFacts;
  files: string[] | null;
  read: (path: string) => Promise<string | null>;
  workflowInstalled: boolean;
};

/** Deployments, checks, statuses, Pages, hooks, workflows and files. */
async function githubEvidence(site: Site, repo: string, missing: Set<string>): Promise<GithubFacts> {
  const evidence: Evidence[] = [];
  const full = await repoFullName(repo);
  const branch = site.repoBranch;

  // The two setup problems that make every publish fail, found before anybody publishes.
  let branchMissing = false;
  try {
    await githubRead(`/repos/${full}/branches/${encodeURIComponent(branch)}`);
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) {
      branchMissing = true;
      evidence.push({ kind: "files", detail: `Branch ${branch} is not in the repository, so a publish has nowhere to go.` });
    }
  }
  const info = await attempt("contents", missing, () => githubRead<{ permissions?: { push?: boolean } }>(`/repos/${full}`));
  // A personal token reports what it may do; an app installation does not, and
  // holds Contents write by definition.
  const canWrite = typeof info?.permissions?.push === "boolean" ? info.permissions.push : null;
  if (canWrite === false) evidence.push({ kind: "files", detail: "The access DakyX publishes with can read this repository but not write to it." });

  const listing = await attempt("contents", missing, () => listRepoFiles(repo, branch));
  const files = listing ? listing.files : null;
  const has = (path: string) => Boolean(files?.includes(path));
  const read = async (path: string) => (has(path) ? readFile(repo, path, branch).catch(() => null) : null);

  // Recent commits on the branch publishing writes to, and what hosts left on them.
  const commits = (await attempt("contents", missing, () => githubRead<Array<{ sha: string }>>(`/repos/${full}/commits?sha=${encodeURIComponent(branch)}&per_page=3`))) ?? [];
  for (const commit of commits) {
    const deployments = await attempt("deployments", missing, () => githubRead<Array<{ ref: string; environment: string; creator?: { login?: string } }>>(`/repos/${full}/deployments?sha=${commit.sha}&per_page=10`));
    if (deployments) {
      if (!deployments.length) evidence.push({ kind: "deployments", detail: `No deploys recorded on commit ${commit.sha.slice(0, 7)}.` });
      for (const deployment of deployments.filter((entry) => isProductionEnvironment(entry.environment))) {
        const host = hostFromDeployment(deployment);
        evidence.push({ kind: "deployments", host: host ?? undefined, deploys: true, branch, detail: `${host ?? deployment.creator?.login ?? "A host"} deployed commit ${commit.sha.slice(0, 7)} to ${deployment.environment}.` });
      }
    }
    const checks = await attempt("checks", missing, () => githubRead<{ check_runs?: Array<{ app?: { slug?: string }; name?: string }> }>(`/repos/${full}/commits/${commit.sha}/check-runs?per_page=30`));
    for (const run of checks?.check_runs ?? []) {
      const host = hostFromCheck(run.app?.slug);
      if (host) evidence.push({ kind: "checks", host, deploys: true, branch, detail: `${host} ran "${run.name ?? "a check"}" on commit ${commit.sha.slice(0, 7)}.` });
    }
    const statuses = await attempt("statuses", missing, () => githubRead<Array<{ context?: string; state?: string }>>(`/repos/${full}/commits/${commit.sha}/statuses?per_page=30`));
    for (const status of statuses ?? []) {
      const host = hostFromStatusContext(status.context);
      if (host && !/preview/i.test(status.context ?? "")) evidence.push({ kind: "statuses", host, deploys: true, branch, detail: `${host} reported "${status.context}" on commit ${commit.sha.slice(0, 7)}.` });
    }
  }

  // Deploys from other branches only: the host is watching the wrong one.
  const recent = await attempt("deployments", missing, () => githubRead<Array<{ ref: string; environment: string; creator?: { login?: string } }>>(`/repos/${full}/deployments?per_page=20`));
  for (const deployment of (recent ?? []).filter((entry) => isProductionEnvironment(entry.environment) && entry.ref !== branch && !/^[0-9a-f]{40}$/.test(entry.ref))) {
    const host = hostFromDeployment(deployment);
    evidence.push({ kind: "deployments", host: host ?? undefined, deploys: true, branch: deployment.ref, detail: `${host ?? "A host"} deploys branch ${deployment.ref} to ${deployment.environment}.` });
  }

  // GitHub Pages' own settings.
  let pages: PagesFacts | undefined;
  try {
    const info = await githubRead<{ build_type?: "legacy" | "workflow"; source?: { branch?: string; path?: string }; html_url?: string; cname?: string | null }>(`/repos/${full}/pages`);
    const folder = info.source?.path ?? "/";
    const inFolder = (name: string) => `${folder.replace(/^\/+|\/+$/g, "")}${folder.replace(/^\/+|\/+$/g, "") ? "/" : ""}${name}`;
    pages = {
      buildType: info.build_type ?? null,
      branch: info.source?.branch,
      folder,
      htmlUrl: info.html_url,
      cname: info.cname ?? null,
      noJekyll: has(inFolder(".nojekyll")),
      jekyllContent: has(inFolder("_config.yml")),
    };
    evidence.push({
      kind: "pages",
      host: "github-pages",
      // A workflow-built site deploys when its workflow says so, which the
      // workflow evidence below decides; the setting alone proves nothing.
      deploys: info.build_type === "legacy",
      branch: info.build_type === "legacy" ? info.source?.branch : undefined,
      folder: info.build_type === "legacy" ? folder : undefined,
      detail: info.build_type === "workflow" ? "GitHub Pages is switched on and builds from a workflow." : `GitHub Pages is switched on and builds branch ${info.source?.branch ?? "?"}, folder ${folder}.`,
    });
  } catch (error) {
    if (error instanceof GitHubError && (error.status === 403 || error.status === 401)) missing.add("pages");
    else if (error instanceof GitHubError && error.status === 404) evidence.push({ kind: "pages", detail: "GitHub Pages is not switched on for this repository." });
  }

  // Webhooks pointing at a host.
  const hooks = await attempt("webhooks", missing, () => githubRead<Array<{ active?: boolean; config?: { url?: string } }>>(`/repos/${full}/hooks?per_page=30`));
  for (const hook of hooks ?? []) {
    const host = hostFromHookUrl(hook.config?.url);
    if (host && hook.active !== false) evidence.push({ kind: "hooks", host, deploys: true, detail: `The repository tells ${host} about every push through a webhook.` });
  }

  // Workflows that deploy.
  let workflowInstalled = false;
  for (const path of (files ?? []).filter((name) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(name)).slice(0, 8)) {
    const text = await read(path);
    if (!text) continue;
    const workflow = readWorkflow(text);
    if (path === PAGES_WORKFLOW_PATH) workflowInstalled = true;
    if (!workflow.host) continue;
    const onBranch = workflow.pushBranches === null ? undefined : workflow.pushBranches.length === 0 || workflow.pushBranches.includes(branch) ? branch : workflow.pushBranches[0];
    evidence.push({ kind: "workflows", host: workflow.host, deploys: workflow.pushBranches !== null, branch: onBranch, detail: `${path} deploys to ${workflow.host}${onBranch ? ` on pushes to ${onBranch}` : ""}.` });
  }

  // Config files that name a host.
  const named: Array<[string, DeployHost]> = [["netlify.toml", "netlify"], ["vercel.json", "vercel"], ["wrangler.toml", "cloudflare-pages"], ["wrangler.json", "cloudflare-pages"], ["render.yaml", "render"], ["CNAME", "github-pages"]];
  for (const [path, host] of named) if (has(path)) evidence.push({ kind: "files", host, detail: `The repository has ${path}.` });

  return { evidence, branchMissing, canWrite, pages, files, read, workflowInstalled: workflowInstalled && pages?.buildType === "workflow" };
}

/** What the last publishes did. */
async function observedEvidence(site: Site): Promise<{ evidence: Evidence[]; typicalSeconds?: number }> {
  const jobs = await prisma.publishJob.findMany({
    where: { siteId: site.id, commitSha: { not: null }, state: { in: ["COMPLETED", "VERIFY_FAILED", "DEPLOY_FAILED", "VERIFYING", "DEPLOYING"] } },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { state: true, createdAt: true, verifiedAt: true, route: true, verifyText: true, expectedHash: true },
  });
  const evidence: Evidence[] = [];
  // Only publishes the host carried itself: one a faster route delivered proves nothing about the host.
  const followed = jobs.filter((job) => !job.route || job.route === "follow" || job.route === "hook");
  const live = followed.filter((job) => job.state === "COMPLETED" && job.verifiedAt && (job.verifyText || job.expectedHash));
  const seconds = live.slice(0, 5).map((job) => (job.verifiedAt!.getTime() - job.createdAt.getTime()) / 1000);
  if (live.length) evidence.push({ kind: "observed", deploys: true, branch: site.repoBranch, detail: `${live.length} recent publish${live.length === 1 ? "" : "es"} went live on ${live.length === 1 ? "its" : "their"} own, typically in ${median(seconds)} seconds.` });
  const lost = followed.filter((job) => job.state === "VERIFY_FAILED" || (job.state === "VERIFYING" && Date.now() - job.createdAt.getTime() > 2 * 60 * 60_000));
  if (lost.length && !live.length) evidence.push({ kind: "observed", missed: true, detail: "The last publish never appeared on the live page." });
  return { evidence, typicalSeconds: median(seconds) };
}

/**
 * Detects how a site goes live. Every read is allowed to fail; the profile is
 * whatever could be learned.
 */
export async function detectDeployProfile(site: Site, options: { dnsLookup?: DnsLookup } = {}): Promise<DeployProfile> {
  const previous = deployProfileOf(site);
  const missing = new Set<string>();
  const evidence: Evidence[] = [];
  evidence.push(...(await servingEvidence(site.publicUrl, options.dnsLookup ?? realDns)));

  const repo = siteRepo(site);
  let github: GithubFacts | null = null;
  if (repo) {
    github = await underSiteCredential(site, () => githubEvidence(site, repo, missing)).catch(() => null);
    if (github) evidence.push(...github.evidence);
  }
  const observed = await observedEvidence(site);
  evidence.push(...observed.evidence);

  const missingAccess = [...missing].sort();
  const decided = decideProfile({ evidence, repoBranch: site.repoBranch, repoPath: site.repoPath, pages: github?.pages, missingAccess });
  const hasBuildStep = decideBuildStep({
    files: github?.files ?? null,
    sourceKind: site.sourceKind,
    packageJson: github ? await github.read("package.json") : null,
    netlifyToml: github ? await github.read("netlify.toml") : null,
    vercelJson: github ? await github.read("vercel.json") : null,
  });

  return {
    ...decided,
    evidence,
    hasBuildStep,
    typicalSeconds: observed.typicalSeconds,
    lastCheckedAt: new Date().toISOString(),
    missingAccess,
    pages: github?.pages,
    routes: { pages: github ? { workflowInstalled: github.workflowInstalled } : previous?.routes.pages },
    disabledRoutes: previous?.disabledRoutes ?? [],
    pagesPrevious: previous?.pagesPrevious,
    branchMissing: github?.branchMissing ?? false,
    canWrite: github ? github.canWrite : null,
  };
}

/** Detects and stores. Never throws: detection is advice, not a gate. */
export async function refreshDeployProfile(siteId: string): Promise<DeployProfile | null> {
  try {
    const site = await prisma.site.findUnique({ where: { id: siteId } });
    if (!site || site.deletionScheduledFor) return null;
    const profile = await detectDeployProfile(site);
    await prisma.site.update({ where: { id: siteId }, data: { deployProfile: profile as unknown as Prisma.InputJsonValue } });
    return profile;
  } catch (error) {
    console.error(`[deploy-detect] ${siteId}:`, error);
    return null;
  }
}

/** Detection in the background, for the moments a site's connection changes. */
export function refreshDeployProfileSoon(siteId: string): void {
  setTimeout(() => void refreshDeployProfile(siteId), 0);
}

/**
 * The nightly re-check, a few sites at a time. A host can change under a site
 * (a customer moves from GitHub Pages to Vercel) without anybody telling us.
 */
export async function refreshStaleDeployProfiles(now = new Date(), limit = 10): Promise<number> {
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60_000);
  const sites = await prisma.site.findMany({
    where: { repoName: { not: null }, deletionScheduledFor: null },
    select: { id: true, deployProfile: true },
    take: 500,
  });
  const stale = sites.filter((site) => {
    const profile = deployProfileOf(site);
    return !profile || new Date(profile.lastCheckedAt) < dayAgo;
  }).slice(0, limit);
  for (const site of stale) await refreshDeployProfile(site.id);
  return stale.length;
}
