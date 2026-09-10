/**
 * The GitHub App credential path, with the wire answered by a fixed responder.
 *
 *   npx tsx checks/githubApp.ts
 *
 * Three things worth holding to: a webhook signature is the whole of that
 * endpoint's authentication, an installation token must be scoped by GitHub
 * rather than by us, and none of this may break the shared token that every
 * existing site still publishes with.
 */
import assert from "node:assert/strict";
import { generateKeyPairSync, createHmac } from "node:crypto";

let checks = 0;
function check(name: string, condition: unknown) { assert.ok(condition, name); checks++; }
function equal(name: string, actual: unknown, expected: unknown) { assert.deepEqual(actual, expected, name); checks++; }

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
process.env.GITHUB_APP_ID = "123456";
process.env.GITHUB_APP_SLUG = "dakyworld-website-editor";
process.env.GITHUB_APP_PRIVATE_KEY = privateKey as string;
process.env.GITHUB_APP_WEBHOOK_SECRET = "a-shared-webhook-secret";
process.env.GITHUB_TOKEN = "the-shared-token";
process.env.GITHUB_ALLOWED_REPOS = "dakyworld/os";

/* --------------------------------------------------------- the wire */

let issued = 0;
let jwtSeen: string | null = null;
let tokenAuthorisation: string | null = null;
let installationExists = true;
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const target = new URL(String(input));
  assert.equal(target.origin, "https://api.github.com", "no check may reach a real service");
  const authorisation = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? "");
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

  if (target.pathname.endsWith("/access_tokens")) {
    if (!installationExists) return json({ message: "Not Found" }, 404);
    jwtSeen = authorisation.replace("Bearer ", "");
    issued += 1;
    return json({ token: `installation-token-${issued}`, expires_at: new Date(Date.now() + 60 * 60_000).toISOString() });
  }
  if (target.pathname === "/installation/repositories") {
    tokenAuthorisation = authorisation;
    return json({ repositories: [{ id: 18273645, full_name: "acme/website", default_branch: "main", private: true }] });
  }
  if (target.pathname.includes("/contents/")) {
    tokenAuthorisation = authorisation;
    return json({ content: Buffer.from("<h1>hello</h1>").toString("base64"), encoding: "base64" });
  }
  throw new Error(`Unexpected GitHub request ${target.pathname}`);
}) as typeof fetch;

const { githubAppConfigured, githubAppInstallUrl, installationToken, forgetInstallationToken, installationRepositories, verifyGithubWebhook, siteGithubCredential } =
  await import("../src/services/githubApp.js");
const { withGithubCredential, currentGithubCredential, readFile, githubConfigured } = await import("../src/lib/github.js");

try {
  /* ------------------------------------------------------ the app */

  check("the app reads as set up when it has an id and a key", await githubAppConfigured());
  equal("the install link is the customer's way in", await githubAppInstallUrl(), "https://github.com/apps/dakyworld-website-editor/installations/new");

  /* ------------------------------------------------ borrowed tokens */

  const first = await installationToken("18472931");
  equal("an installation is exchanged for a token", first, "installation-token-1");
  const [header, payload] = jwtSeen!.split(".");
  const claims = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")) as { iss: string; iat: number; exp: number };
  equal("signed as the app itself", claims.iss, "123456");
  equal("with RS256", JSON.parse(Buffer.from(header!, "base64url").toString("utf8")).alg, "RS256");
  check("backdated, so a fast clock cannot make it a token from the future", claims.iat <= Math.floor(Date.now() / 1000));
  check("and short-lived", claims.exp - claims.iat <= 10 * 60);

  equal("a second call reuses the cached token rather than paying for another", await installationToken("18472931"), "installation-token-1");
  equal("and only one was ever issued", issued, 1);

  forgetInstallationToken("18472931");
  equal("an installation that changed drops its cached token at once", await installationToken("18472931"), "installation-token-2");

  installationExists = false;
  forgetInstallationToken("18472931");
  await assert.rejects(() => installationToken("18472931"), /no longer exists/);
  checks++;
  installationExists = true;
  forgetInstallationToken("18472931");

  /* ------------------------------------------- which credential is used */

  equal("a site with no installation has no credential of its own", await siteGithubCredential({ githubInstallationId: null }), null);
  const credential = (await siteGithubCredential({ githubInstallationId: "18472931" }))!;
  equal("a site with one borrows an installation token", credential.kind, "installation");

  await withGithubCredential(credential, async () => {
    equal("work inside that scope uses it", currentGithubCredential()?.token, credential.token);
    await readFile("acme/website", "index.html", "main");
    equal("and every call inside inherits it", tokenAuthorisation, `Bearer ${credential.token}`);
    check("GitHub is configured for that scope whatever the shared token says", await githubConfigured());
  });

  tokenAuthorisation = null;
  await readFile("dakyworld/os", "README.md", "main");
  equal("outside it, the shared token is still what publishes", tokenAuthorisation, "Bearer the-shared-token");

  const repositories = await installationRepositories("18472931");
  equal("an installation lists exactly what the customer granted", repositories.map((repo) => repo.fullName), ["acme/website"]);
  equal("with GitHub's own id, which survives a rename", repositories[0]!.id, "18273645");

  /* ----------------------------------------------------- the webhook */

  const body = JSON.stringify({ action: "removed", installation: { id: 18472931 } });
  const signature = `sha256=${createHmac("sha256", "a-shared-webhook-secret").update(body).digest("hex")}`;
  check("a correctly signed delivery is accepted", await verifyGithubWebhook(signature, body));
  check("an unsigned one is not", !(await verifyGithubWebhook(undefined, body)));
  check("nor one signed with the wrong secret", !(await verifyGithubWebhook(`sha256=${createHmac("sha256", "guess").update(body).digest("hex")}`, body)));
  check("nor a right signature over a different body", !(await verifyGithubWebhook(signature, `${body} `)));
  check("nor a signature of the wrong shape", !(await verifyGithubWebhook("sha1=deadbeef", body)));
  check("nor a truncated one, which must not read as a prefix match", !(await verifyGithubWebhook(signature.slice(0, 20), body)));

  console.log(`githubApp: ${checks} checks — app JWTs, borrowed installation tokens, the shared token still publishing, and signed webhooks`);
} finally {
  globalThis.fetch = originalFetch;
}
