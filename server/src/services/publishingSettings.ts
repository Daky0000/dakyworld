import { createHash, createPrivateKey } from "node:crypto";
import { SETTING, deleteSetting, getSetting, isEnvManaged, setSetting } from "../lib/settings.js";
import { maskSecret } from "../lib/secrets.js";
import { appIdentity, type AppIdentity, type AppKind } from "./githubApp.js";
import { customerAppUrl } from "./emailSender.js";
import { FAST_ROUTES, type FastRoute } from "./websiteDeployDetect.js";
import { globallyDisabledRoutes } from "./websitePublishRouter.js";

/**
 * Every outside credential the publish router needs, on one settings screen.
 *
 * The router was built reading these through `getSetting`, so a value saved
 * here works exactly as a Railway variable does, and a Railway variable still
 * wins where one is set. Until this screen existed the only way in was the
 * environment, and nothing in the app said which of them were missing — see
 * docs/publish-router.md for what each one is for.
 *
 * Four groups, each saved and removed as a unit, because a client id without
 * its secret (or an app id without its key) is not half a connection, it is a
 * connection that fails at the moment a customer presses Connect.
 */

type FieldSpec = { id: string; key: string; env: string; label: string; secret?: boolean; multiline?: boolean; placeholder?: string };

export const PUBLISHING_GROUPS = {
  githubApp: [
    { id: "appId", key: SETTING.GITHUB_APP_ID, env: "GITHUB_APP_ID", label: "App ID", placeholder: "123456" },
    { id: "slug", key: SETTING.GITHUB_APP_SLUG, env: "GITHUB_APP_SLUG", label: "App slug", placeholder: "dakyworld-website-editor" },
    { id: "privateKey", key: SETTING.GITHUB_APP_PRIVATE_KEY, env: "GITHUB_APP_PRIVATE_KEY", label: "Private key (.pem)", secret: true, multiline: true },
    { id: "webhookSecret", key: SETTING.GITHUB_APP_WEBHOOK_SECRET, env: "GITHUB_APP_WEBHOOK_SECRET", label: "Webhook secret", secret: true },
    { id: "clientId", key: SETTING.GITHUB_APP_CLIENT_ID, env: "GITHUB_APP_CLIENT_ID", label: "Client ID", placeholder: "Iv23li…" },
    { id: "clientSecret", key: SETTING.GITHUB_APP_CLIENT_SECRET, env: "GITHUB_APP_CLIENT_SECRET", label: "Client secret", secret: true },
  ],
  pagesApp: [
    { id: "appId", key: SETTING.GITHUB_PAGES_APP_ID, env: "GITHUB_PAGES_APP_ID", label: "App ID", placeholder: "123456" },
    { id: "slug", key: SETTING.GITHUB_PAGES_APP_SLUG, env: "GITHUB_PAGES_APP_SLUG", label: "App slug", placeholder: "dakyx-pages" },
    { id: "privateKey", key: SETTING.GITHUB_PAGES_APP_PRIVATE_KEY, env: "GITHUB_PAGES_APP_PRIVATE_KEY", label: "Private key (.pem)", secret: true, multiline: true },
  ],
  netlify: [
    { id: "clientId", key: SETTING.NETLIFY_CLIENT_ID, env: "NETLIFY_CLIENT_ID", label: "Client ID" },
    { id: "clientSecret", key: SETTING.NETLIFY_CLIENT_SECRET, env: "NETLIFY_CLIENT_SECRET", label: "Secret", secret: true },
  ],
  vercel: [
    { id: "clientId", key: SETTING.VERCEL_CLIENT_ID, env: "VERCEL_CLIENT_ID", label: "Client ID", placeholder: "oac_…" },
    { id: "clientSecret", key: SETTING.VERCEL_CLIENT_SECRET, env: "VERCEL_CLIENT_SECRET", label: "Client secret", secret: true },
    { id: "slug", key: SETTING.VERCEL_INTEGRATION_SLUG, env: "VERCEL_INTEGRATION_SLUG", label: "Integration slug", placeholder: "dakyx" },
  ],
} satisfies Record<string, FieldSpec[]>;

export type PublishingGroup = keyof typeof PUBLISHING_GROUPS;
export const isPublishingGroup = (value: string): value is PublishingGroup => Object.hasOwn(PUBLISHING_GROUPS, value);

/**
 * The six read permissions Route D detection asks for (docs/publish-router.md,
 * step 1), under the names GitHub's `/app` answer uses.
 */
const MAIN_APP_READS: Array<{ key: string; label: string }> = [
  { key: "deployments", label: "Deployments" },
  { key: "checks", label: "Checks" },
  { key: "statuses", label: "Commit statuses" },
  { key: "actions", label: "Actions" },
  { key: "repository_hooks", label: "Webhooks" },
  { key: "pages", label: "Pages" },
];
/** What DakyX Pages must hold to write the workflow and ask for a rebuild. */
const PAGES_APP_WRITES: Array<{ key: string; label: string }> = [
  { key: "contents", label: "Contents" },
  { key: "workflows", label: "Workflows" },
  { key: "pages", label: "Pages" },
  { key: "actions", label: "Actions" },
];

const rank = (level: string | undefined) => (level === "write" || level === "admin" ? 2 : level === "read" ? 1 : 0);

// The identity check is a GitHub round trip and the settings page polls, so it
// is held for a few minutes, keyed by what was asked with.
const IDENTITY_MS = 5 * 60_000;
const identities = new Map<AppKind, { at: number; fingerprint: string; identity: AppIdentity }>();

async function cachedIdentity(app: AppKind, fingerprint: string): Promise<AppIdentity> {
  const held = identities.get(app);
  if (held && held.fingerprint === fingerprint && Date.now() - held.at < IDENTITY_MS) return held.identity;
  const identity = await appIdentity(app);
  identities.set(app, { at: Date.now(), fingerprint, identity });
  return identity;
}

/** Dropped after a save, and when somebody presses "Check again". */
export function forgetAppIdentities(): void {
  identities.clear();
}

async function describeFields(group: PublishingGroup) {
  return Promise.all(
    PUBLISHING_GROUPS[group].map(async (field: FieldSpec) => {
      const value = await getSetting(field.key);
      return {
        id: field.id,
        label: field.label,
        env: field.env,
        secret: Boolean(field.secret),
        multiline: Boolean(field.multiline),
        placeholder: field.placeholder ?? null,
        set: Boolean(value),
        envManaged: isEnvManaged(field.key),
        // A secret is shown masked, a private key not at all: its first and last
        // characters are the PEM armour and say nothing about which key it is.
        shown: !value ? null : field.multiline ? "saved" : field.secret ? maskSecret(value) : value,
      };
    }),
  );
}

async function describeApp(app: AppKind, required: Array<{ key: string; label: string }>, need: 1 | 2) {
  const group: PublishingGroup = app === "main" ? "githubApp" : "pagesApp";
  const fields = await describeFields(group);
  const id = fields.find((field) => field.id === "appId");
  const key = fields.find((field) => field.id === "privateKey");
  const configured = Boolean(id?.set && key?.set);
  if (!configured) return { fields, configured, identity: null, permissions: [] };

  const spec = (fieldId: string) => (PUBLISHING_GROUPS[group] as FieldSpec[]).find((field) => field.id === fieldId)!.key;
  const fingerprint = createHash("sha256").update(`${await getSetting(spec("appId"))}\n${await getSetting(spec("privateKey"))}`).digest("hex");
  const identity = await cachedIdentity(app, fingerprint);
  const permissions = required.map((entry) => ({
    ...entry,
    level: identity.ok ? (identity.permissions[entry.key] ?? null) : null,
    ok: identity.ok && rank(identity.permissions[entry.key]) >= need,
  }));
  return { fields, configured, identity: identity.ok ? { ok: true as const, slug: identity.slug, name: identity.name } : { ok: false as const, error: identity.error }, permissions };
}

export async function describePublishing() {
  const editor = customerAppUrl();
  const [githubApp, pagesApp, netlify, vercel, disabled] = await Promise.all([
    describeApp("main", MAIN_APP_READS, 1),
    describeApp("pages", PAGES_APP_WRITES, 2),
    describeFields("netlify"),
    describeFields("vercel"),
    globallyDisabledRoutes(),
  ]);
  return {
    githubApp: {
      ...githubApp,
      urls: { callback: `${editor}/api/website/github/callback`, webhook: `${editor}/api/github/webhook` },
    },
    pagesApp: { ...pagesApp, urls: { setup: `${editor}/api/website/github-pages/callback` } },
    netlify: { fields: netlify, configured: netlify.every((field) => field.set), urls: { redirect: `${editor}/api/website/connect/netlify/callback` } },
    vercel: { fields: vercel, configured: vercel.every((field) => field.set), urls: { redirect: `${editor}/api/website/connect/vercel/callback` } },
    routes: {
      envManaged: isEnvManaged(SETTING.PUBLISH_ROUTES_DISABLED),
      disabled: FAST_ROUTES.filter((route) => disabled.has(route)),
    },
  };
}

export class PublishingInputError extends Error {}

/**
 * Saves one group. A blank field keeps what is saved, so a secret never has to
 * be pasted again to change the field next to it; a field pinned by the
 * environment is refused rather than silently ignored.
 */
export async function savePublishingGroup(group: PublishingGroup, values: Record<string, unknown>): Promise<void> {
  const writes: Array<{ field: FieldSpec; value: string }> = [];
  for (const field of PUBLISHING_GROUPS[group] as FieldSpec[]) {
    const raw = values[field.id];
    if (typeof raw !== "string" || !raw.trim()) continue;
    if (isEnvManaged(field.key)) throw new PublishingInputError(`${field.label} is set by the ${field.env} environment variable. Change it in Railway instead.`);
    // A key pasted from a one-line environment variable carries literal \n.
    const value = field.multiline ? raw.trim().replace(/\\n/g, "\n") : raw.trim();
    if (field.id === "appId" && !/^\d+$/.test(value)) throw new PublishingInputError("The App ID is the number on the app's General page, not its name.");
    if (field.id === "privateKey") {
      try {
        createPrivateKey(value);
      } catch {
        throw new PublishingInputError("That private key could not be read. Paste the whole .pem file, from -----BEGIN to -----END.");
      }
    }
    writes.push({ field, value });
  }
  if (!writes.length) throw new PublishingInputError("Nothing to save: every field was left blank.");
  for (const { field, value } of writes) await setSetting(field.key, value, { secret: Boolean(field.secret) });
  forgetAppIdentities();
}

/** Removes what this screen saved for a group. Anything pinned by the environment stays. */
export async function clearPublishingGroup(group: PublishingGroup): Promise<void> {
  for (const field of PUBLISHING_GROUPS[group] as FieldSpec[]) {
    if (!isEnvManaged(field.key)) await deleteSetting(field.key);
  }
  forgetAppIdentities();
}

export async function saveDisabledRoutes(routes: string[]): Promise<void> {
  if (isEnvManaged(SETTING.PUBLISH_ROUTES_DISABLED)) throw new PublishingInputError("The fast routes are switched by the PUBLISH_ROUTES_DISABLED environment variable. Change it in Railway instead.");
  const off = FAST_ROUTES.filter((route: FastRoute) => routes.includes(route));
  if (off.length) await setSetting(SETTING.PUBLISH_ROUTES_DISABLED, off.join(","));
  else await deleteSetting(SETTING.PUBLISH_ROUTES_DISABLED);
}
