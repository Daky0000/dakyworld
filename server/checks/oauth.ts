/**
 * Signing in to the Marketing SaaS through the OS, over real HTTP. Database only.
 *
 *   npx tsx checks/oauth.ts
 *
 * The four properties the flow exists to hold: the redirect is exact, a code
 * works once and for sixty seconds, the client secret is checked, and PKCE
 * makes a code lifted from a URL worthless on its own. Half of what follows is
 * the refusals, because a flow that only ever says yes passes every positive.
 * The partner key on the entitlements API is held to the same standard.
 */
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { createHash, randomBytes } from "node:crypto";

const REDIRECT = "https://marketing.example.test/api/auth/dakyx/callback";
process.env.OAUTH_CLIENT_MARKETING_SECRET = "client-secret-for-checks-only";
process.env.OAUTH_CLIENT_MARKETING_REDIRECTS = `${REDIRECT},https://staging.example.test/cb`;
process.env.PARTNER_MARKETING_API_KEY = "partner-key-for-checks-only";
process.env.OAUTH_ISSUER = "https://os.example.test";

const { prisma } = await import("../src/lib/prisma.js");
const { oauthRouter, partnerRouter } = await import("../src/routes/partner.js");

let checks = 0;
function check(name: string, condition: unknown) { assert.ok(condition, name); checks++; }
function equal(name: string, actual: unknown, expected: unknown) { assert.deepEqual(actual, expected, name); checks++; }

const stamp = `oauth-${Date.now()}`;
const userIds: string[] = [];
const clientIds: string[] = [];

const app = express();
app.use(express.json());
// Stands in for attachUser: the session itself is lib/session.ts's business
// and is covered elsewhere. What matters here is what the router does with one.
app.use(async (req, _res, next) => {
  const id = req.get("x-check-user");
  if (id) req.dbUser = (await prisma.user.findUnique({ where: { id }, include: { accessRole: true } })) as never;
  next();
});
app.use("/api/auth/oauth", oauthRouter);
app.use("/api/partner", partnerRouter);
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const state = randomBytes(16).toString("hex");

function authorizeUrl(overrides: Record<string, string | null> = {}) {
  const params: Record<string, string | null> = {
    response_type: "code", client_id: "marketing", redirect_uri: REDIRECT, state,
    code_challenge: challenge, code_challenge_method: "S256", ...overrides,
  };
  const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== null) as [string, string][]);
  return `${base}/api/auth/oauth/authorize?${query}`;
}
const authorize = (userId: string | null, overrides: Record<string, string | null> = {}) =>
  fetch(authorizeUrl(overrides), { redirect: "manual", headers: userId ? { "x-check-user": userId } : {} });
const codeFrom = (response: Response) => new URL(response.headers.get("location")!).searchParams.get("code")!;
const basic = (id: string, secret: string) => `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;
function redeem(code: string, overrides: Record<string, string> = {}, auth = basic("marketing", process.env.OAUTH_CLIENT_MARKETING_SECRET!)) {
  const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: verifier, ...overrides });
  return fetch(`${base}/api/auth/oauth/token`, { method: "POST", headers: { authorization: auth, "content-type": "application/x-www-form-urlencoded" }, body });
}

try {
  const person = await prisma.user.create({ data: { email: `${stamp}@oauth.test`, name: "Esi", emailVerifiedAt: new Date() } });
  const off = await prisma.user.create({ data: { email: `${stamp}-off@oauth.test`, name: "Off", active: false } });
  userIds.push(person.id, off.id);
  const client = await prisma.client.create({ data: { name: `OAuth Co ${stamp}` } });
  clientIds.push(client.id);
  await prisma.clientMember.create({ data: { clientId: client.id, userId: person.id } });
  await prisma.carePlan.create({ data: { clientId: client.id, tier: "TRANSFORMATION", monthlyFee: "15000.00" } });

  /* --------------------------------------------------------- authorize -- */

  let response = await authorize(person.id, { redirect_uri: "https://evil.example.test/cb" });
  equal("an unregistered redirect is refused here, not followed", [response.status, response.headers.get("location")], [400, null]);
  response = await authorize(person.id, { redirect_uri: `${REDIRECT}/../x` });
  equal("so is one that merely starts with a registered one", response.status, 400);
  response = await authorize(person.id, { client_id: "someone-else" });
  equal("and an unknown client", response.status, 400);

  response = await authorize(person.id, { code_challenge: null });
  check("no PKCE challenge goes back as invalid_request", response.headers.get("location")?.includes("error=invalid_request"));
  response = await authorize(person.id, { code_challenge_method: "plain" });
  check("plain PKCE is refused", response.headers.get("location")?.includes("error=invalid_request"));
  response = await authorize(person.id, { state: "short" });
  check("a guessable state is refused", response.headers.get("location")?.includes("error=invalid_request"));

  response = await authorize(null);
  const signIn = response.headers.get("location") ?? "";
  check("signed out goes to the sign-in hop with the request intact", signIn.startsWith("/sso/continue?") && signIn.includes(`state=${state}`));
  response = await authorize(off.id);
  check("a switched-off account is denied", response.headers.get("location")?.includes("error=access_denied"));

  response = await authorize(person.id);
  equal("a signed-in person is sent back with a code", response.status, 302);
  const back = new URL(response.headers.get("location")!);
  equal("to exactly the registered redirect", `${back.origin}${back.pathname}`, REDIRECT);
  equal("carrying the caller's state", back.searchParams.get("state"), state);
  equal("and the issuer", back.searchParams.get("iss"), "https://os.example.test");
  const code = back.searchParams.get("code")!;
  const row = await prisma.oAuthCode.findFirst({ where: { userId: person.id }, orderBy: { createdAt: "desc" } });
  check("the code is stored only as a hash", row && row.codeHash !== code && row.codeHash.length === 64);
  check("and lives a minute", row && row.expiresAt.getTime() - row.createdAt.getTime() <= 61_000);

  /* ------------------------------------------------------------- token -- */

  response = await redeem(code, {}, basic("marketing", "wrong"));
  equal("a wrong client secret is invalid_client", response.status, 401);
  check("and did not spend the code", !(await prisma.oAuthCode.findUnique({ where: { id: row!.id } }))?.usedAt);

  response = await redeem(code);
  equal("the right secret, redirect and verifier redeem it", response.status, 200);
  const answer = await response.json() as { sub: string; email: string; email_verified: boolean; iss: string; aud: string; entitlements: { grants: Array<{ product: string; tier: string }> } };
  equal("naming the OS user", answer.sub, person.id);
  equal("for this client", [answer.iss, answer.aud], ["https://os.example.test", "marketing"]);
  equal("with the verified flag the account actually has", answer.email_verified, true);
  equal("and the grants a Transformation retainer gives", answer.entitlements.grants.map((g) => `${g.product}:${g.tier}`).sort(), ["marketing-suite:agency", "website-builder:MANAGED"]);
  check("and no access token: nothing long-lived leaves", !("access_token" in answer));
  equal("the response is not cached", response.headers.get("cache-control"), "no-store");

  response = await redeem(code);
  equal("the same code a second time is refused", response.status, 400);

  // Two at once: exactly one wins.
  const raced = codeFrom(await authorize(person.id));
  const results = await Promise.all([redeem(raced), redeem(raced), redeem(raced)]);
  equal("of three simultaneous redemptions exactly one succeeds", results.filter((r) => r.status === 200).length, 1);

  response = await redeem(codeFrom(await authorize(person.id)), { code_verifier: randomBytes(32).toString("base64url") });
  equal("a stolen code without its verifier is useless", response.status, 400);
  response = await redeem(codeFrom(await authorize(person.id)), { redirect_uri: "https://staging.example.test/cb" });
  equal("a code issued for one redirect cannot be redeemed against another", response.status, 400);

  const stale = codeFrom(await authorize(person.id));
  await prisma.oAuthCode.updateMany({ where: { userId: person.id, usedAt: null }, data: { expiresAt: new Date(Date.now() - 1000) } });
  equal("an expired code is refused", (await redeem(stale)).status, 400);

  const late = codeFrom(await authorize(person.id));
  await prisma.user.update({ where: { id: person.id }, data: { active: false } });
  equal("an account switched off between authorize and token is refused", (await redeem(late)).status, 400);
  await prisma.user.update({ where: { id: person.id }, data: { active: true } });

  /* -------------------------------------------------- partner entitlements -- */

  const partner = (sub: string, key?: string) => fetch(`${base}/api/partner/v1/entitlements/${sub}`, { headers: key ? { authorization: `Bearer ${key}` } : {} });
  equal("the partner API refuses no key", (await partner(person.id)).status, 401);
  equal("and a wrong one", (await partner(person.id, "partner-key-for-checks-onlx")).status, 401);
  equal("and the OAuth client secret, which is not the partner key", (await partner(person.id, process.env.OAUTH_CLIENT_MARKETING_SECRET)).status, 401);
  response = await partner(person.id, process.env.PARTNER_MARKETING_API_KEY);
  equal("the right key reads a person's grants", response.status, 200);
  const read = await response.json() as { subject: string; grants: unknown[] };
  equal("the same ones the token carried", read.grants.length, 2);
  equal("an injected subject is refused before any query", (await partner("..%2Fusers", process.env.PARTNER_MARKETING_API_KEY)).status, 400);
} finally {
  server.close();
  await prisma.oAuthCode.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.carePlan.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
}

console.log(`oauth: ${checks} checks passed`);
