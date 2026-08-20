import { SETTING, getSetting } from "./settings.js";

/**
 * GitHub, read-mostly, for the technical agents.
 *
 * What the blueprint asks GitHub for is context, not control: what shipped
 * this week, what is open against a client's repository, whether the last
 * deployment succeeded. So this exposes reads, plus exactly one write —
 * opening an issue — because "raise it as an issue" is the only useful thing
 * an agent can do here that doesn't touch code.
 *
 * A fine-grained personal access token with **Contents: read**, **Issues:
 * read and write** and **Metadata: read** on the repositories that matter is
 * the whole configuration. Classic tokens work too; `repo` is broader than
 * needed but is what most people already have.
 */

const API_BASE = "https://api.github.com";
const TIMEOUT_MS = 15_000;
const ACCEPT = "application/vnd.github+json";

export class GitHubError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
  }
}

export class GitHubNotConfiguredError extends GitHubError {
  constructor() {
    super(503, "GitHub isn't connected. Add a personal access token under Settings → Developer.");
    this.name = "GitHubNotConfiguredError";
  }
}

export async function githubConfigured(): Promise<boolean> {
  return Boolean(await getSetting(SETTING.GITHUB_TOKEN));
}

/** The account or organisation reads default to, so a repo can be named `os` rather than `owner/os`. */
export async function defaultOwner(): Promise<string | null> {
  return getSetting(SETTING.GITHUB_OWNER);
}

async function request<T>(path: string, options: { method?: "GET" | "POST" | "PATCH" | "PUT"; body?: unknown; token?: string } = {}): Promise<T> {
  const token = options.token ?? (await getSetting(SETTING.GITHUB_TOKEN));
  if (!token) throw new GitHubNotConfiguredError();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method: options.method ?? "GET",
      headers: {
        Accept: ACCEPT,
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "dakyworld-os",
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw new GitHubError(504, "GitHub did not respond in time.");
    throw new GitHubError(502, `Could not reach GitHub: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const detail = await response
      .json()
      .then((body: any) => body?.message)
      .catch(() => null);
    if (response.status === 401) throw new GitHubError(401, "GitHub rejected the token. Check it under Settings → Developer.");
    if (response.status === 403 && detail?.includes("rate limit")) {
      throw new GitHubError(429, "GitHub's rate limit has been hit. Try again shortly.");
    }
    if (response.status === 404) {
      throw new GitHubError(404, "GitHub returned 404 — the repository doesn't exist, or the token can't see it.");
    }
    throw new GitHubError(response.status, detail ?? `GitHub returned ${response.status}`);
  }

  return (await response.json()) as T;
}

/** `os` becomes `dakyworld/os` when a default owner is set. */
async function fullName(repo: string): Promise<string> {
  const trimmed = repo.trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/i, "");
  if (trimmed.includes("/")) return trimmed;
  const owner = await defaultOwner();
  if (!owner) throw new GitHubError(400, `Name the repository as owner/name — or set a default owner under Settings → Developer.`);
  return `${owner}/${trimmed}`;
}

export interface GitHubAccount {
  login: string;
  name: string | null;
  type: string;
}

export async function getAccount(token?: string): Promise<GitHubAccount> {
  const user = await request<any>("/user", { token });
  return { login: user.login, name: user.name ?? null, type: user.type ?? "User" };
}

export interface RepoSummary {
  fullName: string;
  description: string | null;
  private: boolean;
  defaultBranch: string;
  pushedAt: string | null;
  openIssues: number;
  url: string;
}

export async function listRepos(limit = 30): Promise<RepoSummary[]> {
  const repos = await request<any[]>(`/user/repos?per_page=${Math.min(limit, 100)}&sort=pushed`);
  return repos.map((repo) => ({
    fullName: repo.full_name,
    description: repo.description ?? null,
    private: Boolean(repo.private),
    defaultBranch: repo.default_branch ?? "main",
    pushedAt: repo.pushed_at ?? null,
    openIssues: repo.open_issues_count ?? 0,
    url: repo.html_url,
  }));
}

export interface CommitSummary {
  sha: string;
  message: string;
  author: string | null;
  at: string | null;
  url: string;
}

export async function listCommits(repo: string, limit = 20): Promise<CommitSummary[]> {
  const name = await fullName(repo);
  const commits = await request<any[]>(`/repos/${name}/commits?per_page=${Math.min(limit, 100)}`);
  return commits.map((commit) => ({
    sha: commit.sha.slice(0, 7),
    // Only the subject line: a body can be paragraphs, and every one of these
    // ends up in a model's context window.
    message: (commit.commit?.message ?? "").split("\n")[0],
    author: commit.commit?.author?.name ?? commit.author?.login ?? null,
    at: commit.commit?.author?.date ?? null,
    url: commit.html_url,
  }));
}

export interface IssueSummary {
  number: number;
  title: string;
  state: string;
  isPullRequest: boolean;
  labels: string[];
  author: string | null;
  updatedAt: string | null;
  url: string;
}

export async function listIssues(repo: string, state: "open" | "closed" | "all" = "open", limit = 30): Promise<IssueSummary[]> {
  const name = await fullName(repo);
  const issues = await request<any[]>(`/repos/${name}/issues?state=${state}&per_page=${Math.min(limit, 100)}`);
  return issues.map((issue) => ({
    number: issue.number,
    title: issue.title,
    state: issue.state,
    // GitHub returns pull requests from the issues endpoint. They are usually
    // not what somebody asking for "open issues" means, so they are flagged
    // rather than silently mixed in.
    isPullRequest: Boolean(issue.pull_request),
    labels: (issue.labels ?? []).map((label: any) => (typeof label === "string" ? label : label.name)),
    author: issue.user?.login ?? null,
    updatedAt: issue.updated_at ?? null,
    url: issue.html_url,
  }));
}

export async function createIssue(repo: string, title: string, body: string, labels: string[] = []): Promise<IssueSummary> {
  const name = await fullName(repo);
  const issue = await request<any>(`/repos/${name}/issues`, { method: "POST", body: { title, body, labels } });
  return {
    number: issue.number,
    title: issue.title,
    state: issue.state,
    isPullRequest: false,
    labels: (issue.labels ?? []).map((label: any) => (typeof label === "string" ? label : label.name)),
    author: issue.user?.login ?? null,
    updatedAt: issue.updated_at ?? null,
    url: issue.html_url,
  };
}

/** Confirms a token works, and says what it can see, before it is stored. */
export async function verifyGitHubToken(token: string): Promise<{ login: string; repos: number }> {
  const account = await getAccount(token);
  const repos = await request<any[]>("/user/repos?per_page=1", { token }).catch(() => []);
  return { login: account.login, repos: repos.length };
}

// ---------------------------------------------------------------------------
// Writing code — branches, commits, pull requests
// ---------------------------------------------------------------------------

/**
 * Everything below this line lets an agent change a repository.
 *
 * That includes *this* repository, which is the one that runs the agents, so
 * the boundaries are drawn deliberately rather than by what the API happens to
 * allow:
 *
 * - **An agent may open a pull request. It may not merge one.** Merging `main`
 *   here auto-deploys to Railway, so a merge puts code in front of clients and
 *   is a decision a person makes. `mergePullRequest` is reachable only through
 *   the approval queue, where the Owner sees the diffstat and the agent's
 *   reasoning first.
 * - **Every agent branch is prefixed `agent/`**, so what software wrote is
 *   obvious in a branch list and a stray branch is easy to sweep.
 * - **Nothing force-pushes and nothing commits to a default branch.**
 *   `createBranch` refuses to write over an existing ref: moving a ref is how
 *   one agent's work disappears under another's with nothing in the history to
 *   say it happened.
 * - **`repo.allowedRepos` is the outer fence, and it denies by default.**
 */

/** Repositories an agent may write to, from Settings. Empty means none. */
export async function allowedRepos(): Promise<string[]> {
  const raw = (await getSetting(SETTING.GITHUB_ALLOWED_REPOS)) ?? "";
  return raw
    .split(/[\s,]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Whether an agent may write to this repository.
 *
 * **Deny by default.** An empty list means an agent can read but write nowhere,
 * which is the right starting position for a capability that can change the
 * software running the company. Pointing agents at Dakyworld OS itself is then
 * a deliberate act — somebody typing the repository's name into a settings
 * field — rather than something that arrived switched on.
 *
 * `*` opens everything the token can see, for when that is genuinely wanted.
 */
export async function repoAllowed(repo: string): Promise<boolean> {
  const full = (await fullName(repo)).toLowerCase();
  const allowed = await allowedRepos();
  if (allowed.length === 0) return false;
  if (allowed.includes("*")) return true;
  return allowed.includes(full) || allowed.includes(full.split("/")[1]);
}

export class RepoNotAllowedError extends GitHubError {
  constructor(repo: string) {
    super(
      403,
      `Agents are not allowed to write to ${repo}. Add it to the writable repositories under Settings -> Developer — the list is empty by default, deliberately.`,
    );
  }
}

async function assertWritable(repo: string): Promise<string> {
  if (!(await repoAllowed(repo))) throw new RepoNotAllowedError(repo);
  return fullName(repo);
}

/** Every branch an agent opens carries this, so what software wrote is obvious. */
export const AGENT_BRANCH_PREFIX = "agent/";

export function agentBranchName(slug: string): string {
  const clean = slug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
  return `${AGENT_BRANCH_PREFIX}${clean || "change"}-${Date.now().toString(36)}`;
}

export interface RepoFile {
  path: string;
  content: string;
}

/** The default branch's name and the commit it points at. */
export async function defaultBranch(repo: string): Promise<{ name: string; sha: string }> {
  const full = await fullName(repo);
  const info = await request<{ default_branch: string }>(`/repos/${full}`);
  const ref = await request<{ object: { sha: string } }>(`/repos/${full}/git/ref/heads/${info.default_branch}`);
  return { name: info.default_branch, sha: ref.object.sha };
}

/** One file's text, or null when it is not there. */
export async function readFile(repo: string, path: string, ref?: string): Promise<string | null> {
  const full = await fullName(repo);
  try {
    const file = await request<{ content?: string; encoding?: string }>(
      `/repos/${full}/contents/${path.split("/").map(encodeURIComponent).join("/")}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`,
    );
    if (!file.content) return null;
    return Buffer.from(file.content, (file.encoding as BufferEncoding) ?? "base64").toString("utf8");
  } catch (err) {
    if (err instanceof GitHubError && err.status === 404) return null;
    throw err;
  }
}

/** What is in a directory, so an agent can look before it writes. */
export async function listTree(repo: string, path = "", ref?: string): Promise<Array<{ path: string; type: string; size: number }>> {
  const full = await fullName(repo);
  const entries = await request<Array<{ path: string; type: string; size?: number }>>(
    `/repos/${full}/contents/${path.split("/").filter(Boolean).map(encodeURIComponent).join("/")}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`,
  );
  return (Array.isArray(entries) ? entries : []).map((entry) => ({ path: entry.path, type: entry.type, size: entry.size ?? 0 }));
}

/** Opens a branch off the default one. Refuses to move an existing ref. */
export async function createBranch(repo: string, branch: string, fromSha?: string): Promise<{ branch: string; sha: string }> {
  const full = await assertWritable(repo);
  const base = fromSha ?? (await defaultBranch(repo)).sha;

  try {
    await request(`/repos/${full}/git/refs`, { method: "POST", body: { ref: `refs/heads/${branch}`, sha: base } });
  } catch (err) {
    if (err instanceof GitHubError && err.status === 422) {
      throw new GitHubError(409, `The branch ${branch} already exists. Pick another name rather than writing over it.`);
    }
    throw err;
  }
  return { branch, sha: base };
}

/**
 * Writes a set of files to a branch as one commit.
 *
 * Built as a tree rather than one Contents API call per file, because per-file
 * commits leave the branch in states that never existed as a whole: a change
 * touching three files becomes three commits, two of which do not compile, and
 * a reviewer reading the pull request sees work in progress rather than a
 * change.
 */
export async function commitFiles(input: { repo: string; branch: string; message: string; files: RepoFile[] }): Promise<{ sha: string; url: string }> {
  const full = await assertWritable(input.repo);
  if (input.files.length === 0) throw new GitHubError(400, "There are no files in that change.");

  const head = await request<{ object: { sha: string } }>(`/repos/${full}/git/ref/heads/${input.branch}`);
  const parent = head.object.sha;
  const commit = await request<{ tree: { sha: string } }>(`/repos/${full}/git/commits/${parent}`);

  const blobs = await Promise.all(
    input.files.map(async (file) => {
      const blob = await request<{ sha: string }>(`/repos/${full}/git/blobs`, {
        method: "POST",
        body: { content: Buffer.from(file.content, "utf8").toString("base64"), encoding: "base64" },
      });
      return { path: file.path.replace(/^\/+/, ""), mode: "100644" as const, type: "blob" as const, sha: blob.sha };
    }),
  );

  const tree = await request<{ sha: string }>(`/repos/${full}/git/trees`, {
    method: "POST",
    body: { base_tree: commit.tree.sha, tree: blobs },
  });

  const created = await request<{ sha: string; html_url: string }>(`/repos/${full}/git/commits`, {
    method: "POST",
    body: { message: input.message.slice(0, 2000), tree: tree.sha, parents: [parent] },
  });

  // No `force`. A branch that has moved under us is a conflict to be reported,
  // never something to overwrite.
  await request(`/repos/${full}/git/refs/heads/${input.branch}`, { method: "PATCH", body: { sha: created.sha, force: false } });

  return { sha: created.sha, url: created.html_url };
}

export interface PullRequestSummary {
  number: number;
  url: string;
  title: string;
  branch: string;
  state: string;
  merged: boolean;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
}

export async function openPullRequest(input: { repo: string; branch: string; title: string; body: string; base?: string }): Promise<PullRequestSummary> {
  const full = await assertWritable(input.repo);
  const base = input.base ?? (await defaultBranch(input.repo)).name;

  const pr = await request<{ number: number; html_url: string; title: string; state: string }>(`/repos/${full}/pulls`, {
    method: "POST",
    body: { title: input.title.slice(0, 250), head: input.branch, base, body: input.body.slice(0, 60_000) },
  });
  return { number: pr.number, url: pr.html_url, title: pr.title, branch: input.branch, state: pr.state, merged: false };
}

/** A pull request with its diffstat, which is what a person decides on. */
export async function getPullRequest(repo: string, number: number): Promise<PullRequestSummary> {
  const full = await fullName(repo);
  const pr = await request<{
    number: number;
    html_url: string;
    title: string;
    state: string;
    merged: boolean;
    additions: number;
    deletions: number;
    changed_files: number;
    head: { ref: string };
  }>(`/repos/${full}/pulls/${number}`);
  return {
    number: pr.number,
    url: pr.html_url,
    title: pr.title,
    branch: pr.head.ref,
    state: pr.state,
    merged: pr.merged,
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changed_files,
  };
}

/**
 * Merges a pull request.
 *
 * **This is the one that deploys.** Railway builds `server/` on every push to
 * `main`, so merging here puts code in front of clients. It is never reached
 * from a model: `code.merge` is `outward`, so an agent below autonomy 3 can
 * only prepare it, and preparing it files an approval card carrying the
 * diffstat and the agent's reasoning.
 *
 * Idempotent about an already-merged request, because a decision can be
 * retried from Slack.
 */
export async function mergePullRequest(
  repo: string,
  number: number,
  method: "squash" | "merge" | "rebase" = "squash",
): Promise<{ merged: boolean; sha: string | null; note: string }> {
  const full = await assertWritable(repo);
  const existing = await getPullRequest(repo, number);
  if (existing.merged) return { merged: true, sha: null, note: `#${number} was already merged.` };
  if (existing.state !== "open") return { merged: false, sha: null, note: `#${number} is ${existing.state}, so there is nothing to merge.` };

  try {
    const result = await request<{ merged: boolean; sha: string; message: string }>(`/repos/${full}/pulls/${number}/merge`, {
      method: "PUT",
      body: { merge_method: method },
    });
    return { merged: result.merged, sha: result.sha, note: result.message };
  } catch (err) {
    if (err instanceof GitHubError && (err.status === 405 || err.status === 409)) {
      throw new GitHubError(409, `GitHub would not merge #${number}: ${err.message}. That usually means the branch is behind, or a check has not passed.`);
    }
    throw err;
  }
}

/** A new repository, for a client project. */
export async function createRepo(input: { name: string; description?: string; private?: boolean }): Promise<{ fullName: string; url: string; cloneUrl: string }> {
  const owner = await defaultOwner();
  const body = {
    name: input.name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-"),
    description: input.description?.slice(0, 350),
    // Private by default. A client's half-built site, under Dakyworld's
    // account, is not something to make public by omission.
    private: input.private ?? true,
    auto_init: true,
  };

  const repo = await request<{ full_name: string; html_url: string; clone_url: string }>(owner ? `/orgs/${owner}/repos` : "/user/repos", {
    method: "POST",
    body,
  }).catch(async (err: unknown) => {
    // A personal account is not an organisation, and GitHub answers 404 for
    // `/orgs/<user>/repos` rather than saying so.
    if (err instanceof GitHubError && err.status === 404 && owner) {
      return request<{ full_name: string; html_url: string; clone_url: string }>("/user/repos", { method: "POST", body });
    }
    throw err;
  });

  return { fullName: repo.full_name, url: repo.html_url, cloneUrl: repo.clone_url };
}
