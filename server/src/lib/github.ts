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

async function request<T>(path: string, options: { method?: "GET" | "POST"; body?: unknown; token?: string } = {}): Promise<T> {
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
