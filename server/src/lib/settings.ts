import { prisma } from "./prisma.js";
import { decryptSecret, encryptSecret } from "./secrets.js";

/**
 * Settings the Owner edits from the app, stored in AppSetting. Anything here
 * can also be supplied as an environment variable — the env wins, so a value
 * baked into Railway can't be silently overridden through the UI.
 */
export const SETTING = {
  APIFY_TOKEN: "apify.token",
  DEFAULT_TIMEZONE: "scrapers.timezone",
} as const;

/** Env fallbacks, checked before the database. */
const ENV_FALLBACK: Record<string, string | undefined> = {
  [SETTING.APIFY_TOKEN]: "APIFY_TOKEN",
  [SETTING.DEFAULT_TIMEZONE]: "SCRAPER_TIMEZONE",
};

// One process, one cache. Writes go through setSetting, which clears it.
const cache = new Map<string, string | null>();

export function clearSettingsCache() {
  cache.clear();
}

export async function getSetting(key: string): Promise<string | null> {
  if (cache.has(key)) return cache.get(key) ?? null;

  const envKey = ENV_FALLBACK[key];
  const fromEnv = envKey ? process.env[envKey]?.trim() : undefined;
  if (fromEnv) {
    cache.set(key, fromEnv);
    return fromEnv;
  }

  const row = await prisma.appSetting.findUnique({ where: { key } });
  const value = row ? (row.secret ? decryptSecret(row.value) : row.value) : null;
  cache.set(key, value);
  return value;
}

export async function setSetting(key: string, value: string, options: { secret?: boolean } = {}) {
  const secret = options.secret ?? false;
  const stored = secret ? encryptSecret(value) : value;
  await prisma.appSetting.upsert({
    where: { key },
    update: { value: stored, secret },
    create: { key, value: stored, secret },
  });
  cache.delete(key);
}

export async function deleteSetting(key: string) {
  await prisma.appSetting.deleteMany({ where: { key } });
  cache.delete(key);
}

/** True when the value is pinned by an environment variable and the UI shouldn't offer to edit it. */
export function isEnvManaged(key: string): boolean {
  const envKey = ENV_FALLBACK[key];
  return Boolean(envKey && process.env[envKey]?.trim());
}
