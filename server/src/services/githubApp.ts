import { createHmac, createSign, timingSafeEqual } from "node:crypto";
import { SETTING, getSetting } from "../lib/settings.js";
import { GitHubError, type GithubCredential } from "../lib/github.js";

/**
 * DakyXTech's GitHub App, and the tokens it borrows.
 *
 * The shared personal access token this replaces is the wrong shape of secret
 * for a product with customers. One token reaches every repository the account
 * can see, so a hundred clients would be a hundred repositories behind one
 * credential; the customer cannot see what it can reach, cannot narrow it, and
 * cannot take it back without asking us to.
 *
 * An installation inverts all of that. The customer installs the app on the
 * repositories *they* choose, GitHub refuses anything outside that set whatever
 * this process asks for, the tokens it issues expire in an hour, and they can
 * narrow or remove the installation themselves without a conversation. It is a
 * better answer for them and a smaller thing for us to hold.
 *
 * What this system holds is the app's private key, and it is the one secret here
 * that must never move: it authenticates the app across every installation. It
 * lives in settings (encrypted at rest, like every other secret) or in the
 * environment, is never returned by any route, and never reaches a client.
 *
 * **The shared token is not removed.** Both work, per site: a site with an
 * installation uses it, everything else carries on exactly as before. That is
 * deliberate — replacing a working publishing path in one move, for a mechanism
 * whose failure mode is "nobody can publish", is not a trade worth making.
 */

const API_BASE = "https://api.github.com";
/** GitHub rejects a JWT older than ten minutes; nine leaves room for clock drift. */
const JWT_TTL_SECONDS = 9 * 60;
/** An installation token lasts an hour. Dropped early so one is never used cold. */
const TOKEN_MARGIN_MS = 5 * 60_000;

export async function githubAppConfigured(): Promise<boolean> {
  return Boolean((await getSetting(SETTING.GITHUB_APP_ID)) && (await getSetting(SETTING.GITHUB_APP_PRIVATE_KEY)));
}

/** Where a customer is sent to choose which repositories DakyXTech may reach. */
export async function githubAppInstallUrl(): Promise<string | null> {
  const slug = await getSetting(SETTING.GITHUB_APP_SLUG);
  return slug ? `https://github.com/apps/${encodeURIComponent(slug)}/installations/new` : null;
}

const base64url = (value: Buffer | string) => Buffer.from(value).toString("base64url");

/**
 * The app proving it is itself. Signed with the private key, good for minutes.
 *
 * A JWT is not a repository credential — it can only ask which installations
 * exist and swap one for a token. Everything that touches code uses the token.
 */
async function appJwt(): Promise<string> {
  const id = await getSetting(SETTING.GITHUB_APP_ID);
  const key = (await getSetting(SETTING.GITHUB_APP_PRIVATE_KEY))?.replace(/\\n/g, "\n");
  if (!id || !key) throw new GitHubError(503, "The DakyXTech GitHub App is not set up. Add its ID and private key under Settings → Developer.");

  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  // Backdated by a minute: GitHub refuses a token issued in its future, and a
  // developer machine a few seconds ahead is the usual cause of that.
  const payload = base64url(JSON.stringify({ iat: now - 60, exp: now + JWT_TTL_SECONDS, iss: id }));
  try {
    const signature = createSign("RSA-SHA256").update(`${header}.${payload}`).end().sign(key);
    return `${header}.${payload}.${base64url(signature)}`;
  } catch (error) {
    throw new GitHubError(503, `The GitHub App private key could not be used: ${error instanceof Error ? error.message : "it is not a valid PEM key"}.`);
  }
}

type CachedToken = { token: string; expiresAt: number };
const tokens = new Map<string, CachedToken>();

/**
 * An hour-long token for one installation, cached until shortly before it dies.
 *
 * Cached because a publish reads and writes several times and each exchange is a
 * round trip; dropped five minutes early because a token that expires mid-commit
 * fails a publish rather than merely a request.
 */
export async function installationToken(installationId: string): Promise<string> {
  const held = tokens.get(installationId);
  if (held && held.expiresAt - TOKEN_MARGIN_MS > Date.now()) return held.token;

  const jwt = await appJwt();
  const response = await fetch(`${API_BASE}/app/installations/${encodeURIComponent(installationId)}/access_tokens`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${jwt}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "dakyworld-os",
    },
  }).catch((error: Error) => {
    throw new GitHubError(502, `Could not reach GitHub: ${error.message}`);
  });

  if (response.status === 404) {
    tokens.delete(installationId);
    throw new GitHubError(404, "That GitHub installation no longer exists. The customer may have removed the DakyXTech app; ask them to install it again.");
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new GitHubError(response.status, `GitHub refused a token for that installation: ${body.slice(0, 200) || response.statusText}`);
  }

  const body = (await response.json()) as { token?: string; expires_at?: string };
  if (!body.token) throw new GitHubError(502, "GitHub returned no token for that installation.");
  const expiresAt = body.expires_at ? Date.parse(body.expires_at) : Date.now() + 60 * 60_000;
  tokens.set(installationId, { token: body.token, expiresAt });
  return body.token;
}

/** Thrown away when an installation changes, so a withdrawn one stops working at once. */
export function forgetInstallationToken(installationId: string): void {
  tokens.delete(installationId);
}

/** What repositories an installation actually reaches, for the connect screen. */
export async function installationRepositories(installationId: string): Promise<Array<{ id: string; fullName: string; defaultBranch: string; private: boolean }>> {
  const token = await installationToken(installationId);
  const response = await fetch(`${API_BASE}/installation/repositories?per_page=100`, {
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "dakyworld-os" },
  });
  if (!response.ok) throw new GitHubError(response.status, "That installation's repositories could not be listed.");
  const body = (await response.json()) as { repositories?: Array<{ id: number; full_name: string; default_branch: string; private: boolean }> };
  return (body.repositories ?? []).map((repo) => ({ id: String(repo.id), fullName: repo.full_name, defaultBranch: repo.default_branch, private: repo.private }));
}

/** The credential a piece of work should run under, for a site that has one. */
export async function siteGithubCredential(site: { githubInstallationId: string | null }): Promise<GithubCredential | null> {
  if (!site.githubInstallationId) return null;
  if (!(await githubAppConfigured())) return null;
  return { token: await installationToken(site.githubInstallationId), kind: "installation", label: `installation ${site.githubInstallationId}` };
}

/**
 * Whether a webhook really came from GitHub.
 *
 * Compared in constant time, because a byte-at-a-time comparison of a signature
 * is a way to guess one. An unsigned or wrongly signed delivery is dropped
 * without being read.
 */
export async function verifyGithubWebhook(signature: string | undefined, body: string): Promise<boolean> {
  const secret = await getSetting(SETTING.GITHUB_APP_WEBHOOK_SECRET);
  if (!secret || !signature?.startsWith("sha256=")) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

// --- Proving who installed it --------------------------------------------------
//
// An installation id is a number GitHub puts in a redirect URL. They are
// sequential, anybody can type one, and an installation token reaches whatever
// that installation was given — so "connect installation 51234 to my website"
// cannot be taken on trust from somebody outside the company. That is why the
// connect screen was staff-only.
//
// The way a customer can do it themselves: during the install, GitHub signs them
// in to the app (the app's "Request user authorization (OAuth) during
// installation" box) and hands back a code. That code becomes a short-lived
// token that speaks for *them*, and `/user/installations` answers with only the
// installations and repositories they can actually reach. That answer is what
// gets stored; the token is revoked straight afterwards and never kept.

const GITHUB_HEADERS = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "dakyworld-os" } as const;
/** How long an install may take between leaving here and coming back. */
const STATE_TTL_MS = 30 * 60_000;

let cachedClientId: string | null = null;

/** The app's OAuth client id: from settings, or read from GitHub with the app's key. */
export async function githubAppClientId(): Promise<string | null> {
  const configured = await getSetting(SETTING.GITHUB_APP_CLIENT_ID);
  if (configured) return configured;
  if (cachedClientId) return cachedClientId;
  if (!(await githubAppConfigured())) return null;
  const response = await fetch(`${API_BASE}/app`, { headers: { ...GITHUB_HEADERS, Authorization: `Bearer ${await appJwt()}` } }).catch(() => null);
  if (!response?.ok) return null;
  const body = (await response.json().catch(() => ({}))) as { client_id?: string };
  cachedClientId = body.client_id ?? null;
  return cachedClientId;
}

/** Whether somebody outside the company can connect their own repository yet. */
export async function githubSignInReady(): Promise<boolean> {
  return Boolean((await githubAppConfigured()) && (await getSetting(SETTING.GITHUB_APP_CLIENT_SECRET)) && (await githubAppClientId()));
}

async function stateKey(): Promise<string> {
  const secret = await getSetting(SETTING.GITHUB_APP_CLIENT_SECRET);
  if (!secret) throw new GitHubError(503, "Connecting your own GitHub repository is not switched on yet.");
  return secret;
}

/**
 * Ties the trip to GitHub to the person who started it, so a callback URL that
 * somebody else opens — or one forwarded to a customer — does nothing.
 */
export async function githubConnectState(userId: string): Promise<string> {
  const issued = Date.now().toString(36);
  const mac = createHmac("sha256", await stateKey()).update(`${userId}.${issued}`).digest("base64url");
  return `${issued}.${mac}`;
}

export async function githubConnectStateValid(state: string | undefined, userId: string): Promise<boolean> {
  const [issued, mac] = (state ?? "").split(".");
  if (!issued || !mac) return false;
  const at = parseInt(issued, 36);
  if (!Number.isFinite(at) || Date.now() - at > STATE_TTL_MS || at > Date.now() + 60_000) return false;
  const expected = createHmac("sha256", await stateKey()).update(`${userId}.${issued}`).digest("base64url");
  const left = Buffer.from(mac);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Where to install the app, carrying the state back with it. */
export async function githubInstallUrlWithState(state: string): Promise<string | null> {
  const base = await githubAppInstallUrl();
  return base ? `${base}?state=${encodeURIComponent(state)}` : null;
}

/** Sign-in only, for an install that came back without a code. */
export async function githubAuthorizeUrl(redirectUri: string, state: string): Promise<string> {
  const clientId = await githubAppClientId();
  if (!clientId) throw new GitHubError(503, "The DakyXTech GitHub App is not set up.");
  const query = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, state });
  return `https://github.com/login/oauth/authorize?${query}`;
}

export type VerifiedRepository = { installationId: string; id: string; fullName: string; defaultBranch: string; private: boolean };

async function userGet<T>(token: string, path: string): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, { headers: { ...GITHUB_HEADERS, Authorization: `Bearer ${token}` } }).catch((error: Error) => {
    throw new GitHubError(502, `Could not reach GitHub: ${error.message}`);
  });
  if (!response.ok) throw new GitHubError(response.status, `GitHub refused ${path.split("?")[0]} (${response.status}).`);
  return (await response.json()) as T;
}

/**
 * Turns the code GitHub sent back into the repositories this person can reach
 * through this app — and nothing else. The token is revoked before returning.
 */
export async function verifiedRepositoriesFor(code: string, redirectUri: string): Promise<{ login: string; repositories: VerifiedRepository[] }> {
  const clientId = await githubAppClientId();
  const clientSecret = await getSetting(SETTING.GITHUB_APP_CLIENT_SECRET);
  const appId = await getSetting(SETTING.GITHUB_APP_ID);
  if (!clientId || !clientSecret || !appId) throw new GitHubError(503, "Connecting your own GitHub repository is not switched on yet.");

  const exchanged = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "dakyworld-os" },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
  }).catch((error: Error) => {
    throw new GitHubError(502, `Could not reach GitHub: ${error.message}`);
  });
  const grant = (await exchanged.json().catch(() => ({}))) as { access_token?: string; error_description?: string };
  if (!grant.access_token) throw new GitHubError(400, `GitHub did not sign you in${grant.error_description ? `: ${grant.error_description}` : "."}`);
  const token = grant.access_token;

  try {
    const user = await userGet<{ login: string }>(token, "/user");
    const installations = await userGet<{ installations?: Array<{ id: number; app_id: number }> }>(token, "/user/installations?per_page=100");
    const repositories: VerifiedRepository[] = [];
    for (const installation of installations.installations ?? []) {
      // The endpoint is already limited to this app's installations. Checked
      // anyway, because this list is what grants publishing rights.
      if (String(installation.app_id) !== String(appId)) continue;
      for (let page = 1; page <= 10; page += 1) {
        const batch = await userGet<{ repositories?: Array<{ id: number; full_name: string; default_branch: string; private: boolean }> }>(
          token,
          `/user/installations/${installation.id}/repositories?per_page=100&page=${page}`,
        );
        const found = batch.repositories ?? [];
        repositories.push(...found.map((repo) => ({ installationId: String(installation.id), id: String(repo.id), fullName: repo.full_name, defaultBranch: repo.default_branch, private: repo.private })));
        if (found.length < 100) break;
      }
    }
    return { login: user.login, repositories };
  } finally {
    // Not kept, and not left alive either.
    void fetch(`${API_BASE}/applications/${encodeURIComponent(clientId)}/token`, {
      method: "DELETE",
      headers: { ...GITHUB_HEADERS, Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`, "Content-Type": "application/json" },
      body: JSON.stringify({ access_token: token }),
    }).catch(() => undefined);
  }
}
