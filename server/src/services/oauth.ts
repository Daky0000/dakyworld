import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { ProductKey } from "./entitlements.js";

/**
 * The OS as identity provider for DakyX's other products — a minimal OAuth 2.0
 * authorization-code flow with PKCE and a confidential client, not a full OIDC
 * provider. There is one client, it is ours and it has a backend, so what it
 * needs is four properties rather than a framework: an exact redirect, a code
 * that works once for sixty seconds, a secret that never reaches a browser,
 * and PKCE so a code lifted from a URL is worthless on its own. If a third
 * product ever arrives, that is the point to put `oidc-provider` behind the
 * same two URLs. docs/cross-product-access.md §3.3.
 *
 * Everything here is pure, so checks/oauth.ts can hold it to the rules.
 */

export const CODE_TTL_MS = 60_000;

export type OAuthClient = {
  id: string;
  /** What signing in through this client is for. */
  product: ProductKey;
  secret: string;
  redirects: string[];
};

/** Clients come from the environment: a secret in a table is a secret in every backup. */
export function oauthClients(env: NodeJS.ProcessEnv = process.env): OAuthClient[] {
  const secret = env.OAUTH_CLIENT_MARKETING_SECRET?.trim();
  const redirects = (env.OAUTH_CLIENT_MARKETING_REDIRECTS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  if (!secret || !redirects.length) return [];
  return [{ id: "marketing", product: "marketing-suite", secret, redirects }];
}

export function findClient(clientId: unknown, env: NodeJS.ProcessEnv = process.env): OAuthClient | null {
  if (typeof clientId !== "string") return null;
  return oauthClients(env).find((client) => client.id === clientId) ?? null;
}

/** Exact string match. No prefixes, no wildcards, no normalising — each of those has been an open redirect somewhere. */
export function redirectAllowed(client: OAuthClient, redirectUri: unknown): redirectUri is string {
  return typeof redirectUri === "string" && client.redirects.includes(redirectUri);
}

export function issuer(env: NodeJS.ProcessEnv = process.env): string {
  return (env.OAUTH_ISSUER?.trim() || "https://os.dakyx.com").replace(/\/$/, "");
}

export function newCode(): { code: string; hash: string } {
  const code = randomBytes(32).toString("base64url");
  return { code, hash: hashCode(code) };
}

export function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

/** A PKCE S256 challenge is 43 base64url characters. Anything else is refused up front. */
export function validChallenge(challenge: unknown): challenge is string {
  return typeof challenge === "string" && /^[A-Za-z0-9_-]{43}$/.test(challenge);
}

export function pkceMatches(verifier: unknown, challenge: string): boolean {
  if (typeof verifier !== "string" || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const computed = createHash("sha256").update(verifier).digest("base64url");
  return safeEqual(computed, challenge);
}

export function safeEqual(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}

/** Client credentials from HTTP Basic (preferred) or the form body. */
export function clientCredentials(authorization: string | undefined, body: Record<string, unknown>): { id: string; secret: string } | null {
  if (authorization?.startsWith("Basic ")) {
    const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
    const at = decoded.indexOf(":");
    if (at > 0) return { id: decodeURIComponent(decoded.slice(0, at)), secret: decodeURIComponent(decoded.slice(at + 1)) };
    return null;
  }
  if (typeof body.client_id === "string" && typeof body.client_secret === "string") return { id: body.client_id, secret: body.client_secret };
  return null;
}

export function authenticateClient(credentials: { id: string; secret: string } | null, env: NodeJS.ProcessEnv = process.env): OAuthClient | null {
  if (!credentials) return null;
  const client = findClient(credentials.id, env);
  if (!client) return null;
  return safeEqual(credentials.secret, client.secret) ? client : null;
}

/** Where to send a browser back with an error, once the redirect itself has been validated. */
export function errorRedirect(redirectUri: string, error: string, state: unknown): string {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  if (typeof state === "string") url.searchParams.set("state", state);
  return url.toString();
}

/** The partner API key, compared without leaking its length or prefix through timing. */
export function partnerKeyMatches(authorization: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  const expected = env.PARTNER_MARKETING_API_KEY?.trim();
  if (!expected || !authorization?.startsWith("Bearer ")) return false;
  return safeEqual(authorization.slice(7).trim(), expected);
}
