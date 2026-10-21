/**
 * Settings → Publishing: the publish router's keys, with no database.
 *
 *   npx tsx checks/publishingSettings.ts
 *
 * Every value comes from the environment, the way Railway pins them, so the
 * screen's description is read without a table. GitHub's `/app` answer is a
 * stub; any other outbound request fails the check. Saving is checked only as
 * far as its refusals, which all happen before anything is written.
 */
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";

process.env.APP_SECRET ??= "publishing-settings-check-secret";
process.env.DATABASE_URL ??= "postgresql://checks:checks@127.0.0.1:1/checks";

let checks = 0;
function check(name: string, condition: unknown) { assert.ok(condition, name); checks++; }
function equal(name: string, actual: unknown, expected: unknown) { assert.deepEqual(actual, expected, name); checks++; }

const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }).toString();
Object.assign(process.env, {
  GITHUB_APP_ID: "111",
  GITHUB_APP_SLUG: "dakyworld-website-editor",
  // As Railway holds it: one line, with literal \n.
  GITHUB_APP_PRIVATE_KEY: pem.replace(/\n/g, "\\n"),
  GITHUB_APP_WEBHOOK_SECRET: "hook-secret-value",
  GITHUB_APP_CLIENT_ID: "Iv23liCheck",
  GITHUB_APP_CLIENT_SECRET: "client-secret-value",
  GITHUB_PAGES_APP_ID: "222",
  GITHUB_PAGES_APP_SLUG: "dakyx-pages",
  GITHUB_PAGES_APP_PRIVATE_KEY: pem,
  NETLIFY_CLIENT_ID: "netlify-id",
  NETLIFY_CLIENT_SECRET: "netlify-secret-value",
  VERCEL_CLIENT_ID: "oac_check",
  VERCEL_CLIENT_SECRET: "vercel-secret-value",
  PUBLISH_ROUTES_DISABLED: "pages",
  EDITOR_URL: "https://editor.example.test",
});
process.env.VERCEL_INTEGRATION_SLUG = "dakyx";

const asked: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  assert.equal(url, "https://api.github.com/app", `unexpected request to ${url}`);
  const jwt = String(new Headers(init?.headers).get("authorization")).replace(/^Bearer /, "");
  const issuer = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString()).iss as string;
  asked.push(issuer);
  const permissions = issuer === "111"
    ? { contents: "write", metadata: "read", deployments: "read", checks: "read", statuses: "read", actions: "read", pages: "read" }
    : { contents: "write", workflows: "write", pages: "write", actions: "read" };
  return new Response(JSON.stringify({ slug: issuer === "111" ? "dakyworld-website-editor" : "dakyx-pages", name: "App", permissions }), { status: 200 });
}) as typeof fetch;

const settings = await import("../src/services/publishingSettings.js");
const described = await settings.describePublishing();

// What the screen is told.
check("the main app counts as configured", described.githubApp.configured);
check("its one-line Railway key signs a JWT GitHub accepts", described.githubApp.identity?.ok === true);
equal("the main app is missing only the Webhooks read", described.githubApp.permissions.filter((entry) => !entry.ok).map((entry) => entry.label), ["Webhooks"]);
equal("DakyX Pages is short of Actions write", described.pagesApp.permissions.filter((entry) => !entry.ok).map((entry) => entry.label), ["Actions"]);
check("every field reads as pinned by Railway", [described.githubApp, described.pagesApp, described.netlify].every((group) => group.fields.every((field) => field.envManaged)));
check("a private key is never shown, only said to be saved", described.githubApp.fields.find((field) => field.id === "privateKey")?.shown === "saved");
check("a secret is masked", !described.githubApp.fields.find((field) => field.id === "clientSecret")?.shown?.includes("client-secret-value"));
check("a plain id is shown as it is", described.githubApp.fields.find((field) => field.id === "appId")?.shown === "111");
check("Netlify is complete", described.netlify.configured);
check("Vercel with its slug is complete", described.vercel.configured && described.vercel.fields.find((field) => field.id === "slug")?.shown === "dakyx");
equal("the redirect addresses are the editor's", described.netlify.urls.redirect, "https://editor.example.test/api/website/connect/netlify/callback");
equal("the webhook address is the one index.ts mounts", described.githubApp.urls.webhook, "https://editor.example.test/api/github/webhook");
equal("the off switch is read", described.routes, { envManaged: true, disabled: ["pages"] });

// The identity check is held, and let go on request.
await settings.describePublishing();
equal("a second look asks GitHub nothing", asked.length, 2);
settings.forgetAppIdentities();
await settings.describePublishing();
equal("Check again asks again", asked.length, 4);

// Refusals, all before anything is written.
const refused = async (name: string, work: () => Promise<unknown>, pattern: RegExp) => {
  await assert.rejects(work, (error: Error) => error instanceof settings.PublishingInputError && pattern.test(error.message), name);
  checks++;
};
await refused("a field Railway pins is not overwritten", () => settings.savePublishingGroup("netlify", { clientId: "other" }), /NETLIFY_CLIENT_ID/);
await refused("a pinned off switch is not flipped", () => settings.saveDisabledRoutes([]), /PUBLISH_ROUTES_DISABLED/);
delete process.env.GITHUB_PAGES_APP_ID;
delete process.env.GITHUB_PAGES_APP_PRIVATE_KEY;
await refused("an App ID must be the number", () => settings.savePublishingGroup("pagesApp", { appId: "dakyx-pages" }), /number/);
await refused("a key that is not a key is refused", () => settings.savePublishingGroup("pagesApp", { privateKey: "-----BEGIN RSA PRIVATE KEY-----\nnope\n-----END RSA PRIVATE KEY-----" }), /could not be read/);
await refused("an all-blank save says so", () => settings.savePublishingGroup("vercel", { slug: "  " }), /Nothing to save/);
check("an inherited name is not a group", !settings.isPublishingGroup("constructor") && !settings.isPublishingGroup("__proto__"));
check("a real group is", settings.isPublishingGroup("vercel"));

console.log(`publishing settings: ${checks} checks passed`);
