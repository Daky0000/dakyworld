/**
 * Puts the app that `createGithubApp.mjs` made into the deployment.
 *
 *   node scripts/configureGithubApp.mjs [--file ../.github-app.json] [--service dakyworld]
 *
 * Four variables, set on Railway rather than pasted into the settings screen.
 * The private key authenticates the app across every customer installation, so
 * the fewer places it exists the better, and a deployment secret is the smallest
 * of the available places — `lib/settings.ts` reads the environment first.
 *
 * Proves the key works before it sets anything: an app JWT is minted from it and
 * exchanged for the app's own record. A key GitHub will not accept is worth
 * finding here rather than at somebody's first publish. Then it checks the
 * webhook is really pointed at this system, and points it there if it is not.
 */
import { readFileSync } from "node:fs";
import { createSign } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};

const file = resolve(flag("file", "../.github-app.json"));
const service = flag("service", "dakyworld");
const webhookUrl = flag("webhook", process.env.GITHUB_APP_WEBHOOK_URL ?? "https://os.dakyworld.com/api/github/webhook");
const app = JSON.parse(readFileSync(file, "utf8"));

for (const key of ["id", "slug", "privateKey", "webhookSecret"]) {
  if (!app[key]) throw new Error(`${file} has no ${key}. Run scripts/createGithubApp.mjs first.`);
}

const base64url = (value) => Buffer.from(value).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
const payload = base64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: app.id }));
const signature = base64url(createSign("RSA-SHA256").update(`${header}.${payload}`).end().sign(app.privateKey));
const jwt = `${header}.${payload}.${signature}`;

const github = async (path, method = "GET", body) => {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${jwt}`,
      "User-Agent": "dakyworld-os",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error(`GitHub refused ${method} ${path}: ${response.status} ${await response.text()}`);
  return response.json();
};

const live = await github("/app");
console.log(`  ✓ GitHub accepts the key — ${live.name} (id ${live.id}, owner ${live.owner?.login})`);
console.log(`  ✓ Permissions: ${Object.entries(live.permissions ?? {}).map(([k, v]) => `${k}:${v}`).join(", ")}`);
console.log(`  ✓ Subscribed events: ${(live.events ?? []).length ? live.events.join(", ") : "none (installation events arrive anyway)"}`);

/**
 * The webhook, checked and repaired.
 *
 * `GET /app` does not report it at all, so its absence there proves nothing.
 * This asks the endpoint that does know — and can put it right with the same
 * JWT, which matters because a manifest that quietly dropped the webhook would
 * leave the one thing that notices a customer withdrawing access permanently
 * deaf.
 */
let hook = await github("/app/hook/config");
if (hook.url !== webhookUrl) {
  console.log(`  … webhook was ${hook.url || "unset"}; pointing it at this system`);
  hook = await github("/app/hook/config", "PATCH", { url: webhookUrl, content_type: "json", secret: app.webhookSecret, insecure_ssl: "0" });
}
console.log(`  ✓ Webhook ${hook.url} (${hook.content_type}, secret ${hook.secret ? "set" : "MISSING"})`);

/**
 * One variable per call, because a single failed one must not look like all four
 * having worked.
 *
 * Secrets go in over **stdin**, never as `--set KEY=value`. A PEM is multi-line
 * and full of dashes and spaces, and on Windows the CLI shim is invoked through
 * a shell that reads `-----BEGIN RSA PRIVATE KEY-----` as further arguments:
 * "unrecognized subcommand 'RSA'". Anything with a space in it belongs on stdin.
 */
const variables = {
  GITHUB_APP_ID: String(live.id),
  GITHUB_APP_SLUG: live.slug ?? app.slug,
  // Newlines survive the trip as \n, and lib/settings.ts puts them back.
  GITHUB_APP_PRIVATE_KEY: app.privateKey.replace(/\r?\n/g, "\\n"),
  GITHUB_APP_WEBHOOK_SECRET: app.webhookSecret,
};

for (const [key, value] of Object.entries(variables)) {
  const secret = /KEY|SECRET/.test(key);
  const result = secret
    ? spawnSync("railway", ["variables", "--service", service, "--set-from-stdin", key, "--skip-deploys"], {
        input: value,
        stdio: ["pipe", "pipe", "pipe"],
        shell: process.platform === "win32",
        encoding: "utf8",
      })
    : spawnSync("railway", ["variables", "--service", service, "--set", `${key}=${value}`, "--skip-deploys"], {
        stdio: ["ignore", "pipe", "pipe"],
        shell: process.platform === "win32",
        encoding: "utf8",
      });
  if (result.status !== 0) throw new Error(`Setting ${key} failed: ${result.stderr || result.stdout}`);
  console.log(`  ✓ ${key} set${secret ? " (value not printed)" : ` to ${value}`}`);
}

console.log("\n  Redeploy for the service to pick them up: railway up --service dakyworld --ci (from server/)\n");
