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

  // Lead capture. Everything an Apify run needs that isn't the actor itself:
  // what a new source starts out as, what a run is allowed to cost, where it
  // searches, and who hears about it. See services/captureConfig.ts.
  CAPTURE_MAX_ITEMS: "capture.maxItems",
  CAPTURE_MIN_SCORE: "capture.minScore",
  CAPTURE_AUTO_QUALIFY: "capture.autoQualify",
  CAPTURE_QUALIFY_SCORE: "capture.qualifyScore",
  CAPTURE_RUN_TIMEOUT: "capture.runTimeoutSecs",
  CAPTURE_MEMORY: "capture.memoryMbytes",
  CAPTURE_PROXY_MODE: "capture.proxyMode",
  CAPTURE_PROXY_COUNTRY: "capture.proxyCountry",
  CAPTURE_MONTHLY_BUDGET: "capture.monthlyBudgetUsd",
  CAPTURE_MAX_RUN_CHARGE: "capture.maxRunChargeUsd",
  CAPTURE_MAX_CONCURRENT: "capture.maxConcurrentRuns",
  CAPTURE_LOCATION: "capture.location",
  CAPTURE_COUNTRY_CODE: "capture.countryCode",
  CAPTURE_LANGUAGE: "capture.language",
  CAPTURE_NOTIFY: "capture.notify",
  CAPTURE_NOTIFY_EMAIL: "capture.notifyEmail",
  CAPTURE_RETENTION_DAYS: "capture.retentionDays",
  /**
   * Which Apify actor runs which kind of capture, as JSON, holding only what
   * has been changed from the shipped pairing: `{"WEBSITE":{"actorId":"…"}}`.
   * See services/captureActors.ts.
   */
  CAPTURE_ACTORS: "capture.actors",
  /**
   * Which Apify actor takes the homepage screenshots. Blank uses the shipped
   * default (`apify/screenshot-url`). A setting rather than a constant because
   * every screenshot actor does the same job at a different price, and
   * switching to a cheaper one should be a dropdown rather than a deploy —
   * see services/screenshotActors.ts.
   */
  SCREENSHOT_ACTOR: "capture.screenshotActor",

  /** Powers the spreadsheet analyst — see lib/anthropic.ts. */
  ANTHROPIC_KEY: "anthropic.apiKey",
  /** Which model every Claude call uses unless it names another. */
  ANTHROPIC_MODEL: "anthropic.model",
  /**
   * Per-model rate overrides as JSON, so a price change doesn't need a
   * redeploy: `{"claude-opus-5":{"inputPerMTok":5,"outputPerMTok":25}}`.
   * See lib/claudePricing.ts.
   */
  ANTHROPIC_PRICING: "anthropic.pricing",
  // The other three model vendors. One key each is the whole configuration:
  // which job goes to which vendor has a shipped default, and every job falls
  // back to Claude while its key is missing. See lib/models/registry.ts.
  /** ChatGPT — images and complete web pages. */
  OPENAI_KEY: "openai.apiKey",
  OPENAI_MODEL: "openai.model",
  /** The image model, which is a different model from the same vendor. */
  OPENAI_IMAGE_MODEL: "openai.imageModel",
  /** Gemini — everything the system writes. */
  GEMINI_KEY: "gemini.apiKey",
  GEMINI_MODEL: "gemini.model",
  /** Perplexity — fact-checking against live sources, and plain-English rewrites. */
  PERPLEXITY_KEY: "perplexity.apiKey",
  PERPLEXITY_MODEL: "perplexity.model",
  /**
   * Which vendor serves which job, as JSON, holding only what has been changed
   * from the shipped routing: `{"text":"anthropic"}`.
   */
  MODEL_ROUTES: "models.routes",
  /**
   * Per-model rate overrides for the non-Claude vendors, same shape and same
   * reasoning as `anthropic.pricing`.
   */
  MODEL_PRICING: "models.pricing",

  GOOGLE_CLIENT_ID: "google.clientId",
  GOOGLE_CLIENT_SECRET: "google.clientSecret",
  /** Written by the OAuth callback; the only Google credential that persists. */
  GOOGLE_REFRESH_TOKEN: "google.refreshToken",
  GOOGLE_ACCOUNT: "google.account",
  STRIPE_SECRET_KEY: "stripe.secretKey",
  STRIPE_WEBHOOK_SECRET: "stripe.webhookSecret",
  CLOUDINARY_CLOUD_NAME: "cloudinary.cloudName",
  CLOUDINARY_API_KEY: "cloudinary.apiKey",
  CLOUDINARY_API_SECRET: "cloudinary.apiSecret",
  /** The app's own public URL — what Google's redirect URI is built from. */
  APP_URL: "app.url",

  // Outbound email. SMTP works with every mailbox Dakyworld might send from —
  // Google Workspace, Hostinger, Zoho — and none of them need a new account
  // opening to start. Hostinger's own mailbox has a second, shorter route: an
  // MCP server that takes one API token instead of five SMTP fields.
  /** "SMTP" or "HOSTINGER" — which of the two paths below actually sends. */
  MAIL_TRANSPORT: "mail.transport",
  SMTP_HOST: "smtp.host",
  SMTP_PORT: "smtp.port",
  SMTP_SECURE: "smtp.secure",
  SMTP_USER: "smtp.user",
  SMTP_PASSWORD: "smtp.password",
  MAIL_FROM_NAME: "mail.fromName",
  MAIL_FROM_EMAIL: "mail.fromEmail",
  MAIL_REPLY_TO: "mail.replyTo",
  /** Appended to every outbound email — address, unsubscribe line, sign-off. */
  MAIL_SIGNATURE: "mail.signature",

  // Hostinger Agentic Mail. The token is the whole configuration: the mailbox
  // it may send from is read back from Hostinger rather than typed in, so
  // connecting is one paste. See lib/hostingerMail.ts.
  HOSTINGER_MAIL_TOKEN: "hostinger.mailToken",
  HOSTINGER_MAILBOX_ID: "hostinger.mailboxId",
  HOSTINGER_MAILBOX_ADDRESS: "hostinger.mailboxAddress",

  // Slack, for internal alerts and escalation. Either route works and the
  // token wins when both are set — see lib/slack.ts.
  SLACK_WEBHOOK_URL: "slack.webhookUrl",
  SLACK_BOT_TOKEN: "slack.botToken",
  SLACK_DEFAULT_CHANNEL: "slack.defaultChannel",

  // GitHub, read-mostly, for the technical agents. See lib/github.ts.
  GITHUB_TOKEN: "github.token",
  /** Lets a repository be named `os` rather than `dakyworld/os`. */
  GITHUB_OWNER: "github.owner",

  /**
   * Which calendar bookings land in. Blank means the connected account's own.
   * Calendar rides on the Google connection above rather than its own OAuth —
   * see lib/calendar.ts.
   */
  GOOGLE_CALENDAR_ID: "google.calendarId",
  /** What Google actually granted, so a connection missing a scope is visible. */
  GOOGLE_SCOPES: "google.scopes",

  /** Shared secret for inbound and outbound webhooks. See lib/webhooks.ts. */
  WEBHOOK_SECRET: "webhooks.secret",
  /**
   * Where a lead created by an inbound webhook is filed, as a LeadSource.
   * Defaults to OTHER, which is right for a form on the website.
   */
  WEBHOOK_LEAD_SOURCE: "webhooks.leadSource",

  /**
   * Which agents may call which tools, as JSON, holding only what has been
   * changed from each agent's seeded toolkit. See services/tools/grants.ts.
   */
  AGENT_TOOL_GRANTS: "agents.toolGrants",
  /**
   * Hard ceiling on what one tool call may spend, in USD. The tool layer
   * refuses anything above it rather than trusting an agent's arithmetic.
   */
  AGENT_MAX_CALL_USD: "agents.maxCallUsd",
} as const;

/** Env fallbacks, checked before the database. */
const ENV_FALLBACK: Record<string, string | undefined> = {
  [SETTING.APIFY_TOKEN]: "APIFY_TOKEN",
  [SETTING.DEFAULT_TIMEZONE]: "SCRAPER_TIMEZONE",
  // The two capture limits worth pinning from the deploy: they're the ones
  // that stop a mistake in the UI from costing money.
  [SETTING.CAPTURE_MONTHLY_BUDGET]: "APIFY_MONTHLY_BUDGET_USD",
  [SETTING.CAPTURE_MAX_CONCURRENT]: "APIFY_MAX_CONCURRENT_RUNS",
  [SETTING.ANTHROPIC_KEY]: "ANTHROPIC_API_KEY",
  // Worth pinning from the deploy for the same reason as the capture budget:
  // the model decides what a call costs. Pricing overrides are deliberately
  // database-only — they're a correction to a published rate, not a knob.
  [SETTING.ANTHROPIC_MODEL]: "ANTHROPIC_MODEL",
  // Pinnable from the deploy for the same reason as the Anthropic key: the
  // model decides what a call costs, and a key baked into Railway shouldn't be
  // silently replaceable through the UI.
  [SETTING.OPENAI_KEY]: "OPENAI_API_KEY",
  [SETTING.OPENAI_MODEL]: "OPENAI_MODEL",
  [SETTING.GEMINI_KEY]: "GEMINI_API_KEY",
  [SETTING.GEMINI_MODEL]: "GEMINI_MODEL",
  [SETTING.PERPLEXITY_KEY]: "PERPLEXITY_API_KEY",
  [SETTING.PERPLEXITY_MODEL]: "PERPLEXITY_MODEL",
  [SETTING.GOOGLE_CLIENT_ID]: "GOOGLE_CLIENT_ID",
  [SETTING.GOOGLE_CLIENT_SECRET]: "GOOGLE_CLIENT_SECRET",
  [SETTING.GOOGLE_REFRESH_TOKEN]: "GOOGLE_REFRESH_TOKEN",
  [SETTING.STRIPE_SECRET_KEY]: "STRIPE_SECRET_KEY",
  [SETTING.STRIPE_WEBHOOK_SECRET]: "STRIPE_WEBHOOK_SECRET",
  [SETTING.CLOUDINARY_CLOUD_NAME]: "CLOUDINARY_CLOUD_NAME",
  [SETTING.CLOUDINARY_API_KEY]: "CLOUDINARY_API_KEY",
  [SETTING.CLOUDINARY_API_SECRET]: "CLOUDINARY_API_SECRET",
  [SETTING.APP_URL]: "APP_URL",
  [SETTING.MAIL_TRANSPORT]: "MAIL_TRANSPORT",
  [SETTING.HOSTINGER_MAIL_TOKEN]: "HOSTINGER_MAIL_TOKEN",
  [SETTING.HOSTINGER_MAILBOX_ID]: "HOSTINGER_MAILBOX_ID",
  [SETTING.HOSTINGER_MAILBOX_ADDRESS]: "HOSTINGER_MAILBOX_ADDRESS",
  [SETTING.SMTP_HOST]: "SMTP_HOST",
  [SETTING.SMTP_PORT]: "SMTP_PORT",
  [SETTING.SMTP_SECURE]: "SMTP_SECURE",
  [SETTING.SMTP_USER]: "SMTP_USER",
  [SETTING.SMTP_PASSWORD]: "SMTP_PASSWORD",
  [SETTING.MAIL_FROM_NAME]: "MAIL_FROM_NAME",
  [SETTING.MAIL_FROM_EMAIL]: "MAIL_FROM_EMAIL",
  [SETTING.MAIL_REPLY_TO]: "MAIL_REPLY_TO",
  // Alerting and the developer tools follow the same rule as the rest: the
  // deploy can pin them, the Settings screen can set them, env wins.
  [SETTING.SLACK_WEBHOOK_URL]: "SLACK_WEBHOOK_URL",
  [SETTING.SLACK_BOT_TOKEN]: "SLACK_BOT_TOKEN",
  [SETTING.SLACK_DEFAULT_CHANNEL]: "SLACK_DEFAULT_CHANNEL",
  [SETTING.GITHUB_TOKEN]: "GITHUB_TOKEN",
  [SETTING.GITHUB_OWNER]: "GITHUB_OWNER",
  [SETTING.GOOGLE_CALENDAR_ID]: "GOOGLE_CALENDAR_ID",
  // Pinning this one from the deploy is the difference between rotating the
  // secret in the UI and having every sender break on the next restart.
  [SETTING.WEBHOOK_SECRET]: "WEBHOOK_SECRET",
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
