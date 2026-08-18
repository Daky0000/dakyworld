import express, { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireRole } from "../middleware/auth.js";
import { SETTING, deleteSetting, getSetting, isEnvManaged, setSetting } from "../lib/settings.js";
import { maskSecret } from "../lib/secrets.js";
import { ApifyError, clearApifyCaches, getAccount, getMonthlyUsage } from "../lib/apify.js";
import { CAPTURE_DEFAULTS, captureEnvManaged, readCaptureConfig, writeCaptureConfig } from "../services/captureConfig.js";
import { TASK_KINDS, describeTasks, writeActorOverride, type CaptureTask } from "../services/captureActors.js";
import { isValidTimezone } from "../services/scheduler.js";
import { AnalystError, ANALYST_MODEL, verifyKey } from "../lib/anthropic.js";
import {
  GoogleError,
  buildAuthUrl,
  clearGoogleTokenCache,
  consumeState,
  exchangeCode,
  googleConfigured,
  googleConnected,
  redirectUri,
  rememberState,
} from "../lib/google.js";
import { verifyStripeKey } from "../lib/stripe.js";
import { MailerError, activeTransport, readMailerConfig, sendMail, verifySmtp } from "../lib/mailer.js";
import {
  HostingerMailError,
  clearHostingerSession,
  fetchMailboxes,
  probeMcp,
  type HostingerMailbox,
  type McpProbe,
} from "../lib/hostingerMail.js";
import { logoSources, signature, toHtml, toText } from "../services/emailRender.js";
import { SlackError, sendSlack, slackTransport, verifySlack } from "../lib/slack.js";
import { GitHubError, verifyGitHubToken } from "../lib/github.js";
import { calendarReady, listCalendars } from "../lib/calendar.js";
import { rotateWebhookSecret, webhookSecret } from "../lib/webhooks.js";
import { clearReadinessCache } from "../services/tools/readiness.js";
import {
  BRAND_SLOTS,
  DEFAULT_PROFILE,
  brandImages,
  companyProfile,
  deleteBrandImage,
  saveBrandImage,
  saveCompanyProfile,
  type BrandSlot,
} from "../services/systemProfile.js";

/**
 * Everything the Owner configures at runtime, in one place.
 *
 * Every credential here is stored in `AppSetting` — encrypted when it's a
 * secret — rather than in an environment variable, so a key can be added or
 * rotated from the Settings screen without a redeploy. An environment variable
 * still wins where one is set: the screen then shows the value as
 * env-managed and refuses to edit it, so the deploy stays the source of truth
 * wherever someone chose to make it one.
 */
export const settingsRouter = Router();

// These credentials spend real money and reach outside the company.
settingsRouter.use(requireRole("OWNER"));

// A logo rides in the JSON body as a data URL, so this one path parses bodies
// larger than the 100 kB the rest of the API allows. Deliberately after the
// role check, and scoped to the one route: see index.ts → UPLOAD_PATHS.
settingsRouter.use("/system/brand", express.json({ limit: "2mb" }));

// --- Apify -----------------------------------------------------------------

// The account lookup is a network round trip; the settings page polls, so a
// short cache keeps it from hammering Apify on every render.
const ACCOUNT_CACHE_MS = 60_000;
let accountCache: { at: number; token: string; account: unknown | null; error: string | null } | null = null;

async function describeApify() {
  const token = await getSetting(SETTING.APIFY_TOKEN);
  if (!token) {
    return { connected: false, envManaged: isEnvManaged(SETTING.APIFY_TOKEN), token: null, account: null, error: null };
  }

  if (!accountCache || accountCache.token !== token || Date.now() - accountCache.at > ACCOUNT_CACHE_MS) {
    try {
      const account = await getAccount(token);
      accountCache = { at: Date.now(), token, account, error: null };
    } catch (err) {
      accountCache = { at: Date.now(), token, account: null, error: (err as Error).message };
    }
  }

  return {
    connected: Boolean(accountCache.account),
    envManaged: isEnvManaged(SETTING.APIFY_TOKEN),
    token: maskSecret(token),
    account: accountCache.account,
    error: accountCache.error,
    // What the month has cost so far, next to the ceiling it's measured
    // against. Apify itself caches this for a minute.
    usage: accountCache.account ? await getMonthlyUsage(token).catch(() => null) : null,
  };
}

/**
 * How lead capture behaves for every source — see services/captureConfig.ts.
 * Shipped with the settings snapshot so the Lead capture panel is one request.
 */
async function describeCapture() {
  return {
    config: await readCaptureConfig(),
    defaults: CAPTURE_DEFAULTS,
    envManaged: captureEnvManaged(),
    /** Which pre-defined actor runs which kind of capture — see captureActors.ts. */
    tasks: await describeTasks(),
  };
}

// --- The whole picture -----------------------------------------------------

/** The app's public URL: the setting, else the env var, else this request's own host. */
function origin(req: Request, configured: string | null): string {
  return (configured || `${req.protocol}://${req.get("host") ?? "localhost"}`).replace(/\/$/, "");
}

async function describeAll(req: Request) {
  const [apify, anthropicKey, googleClientId, googleAccount, stripeKey, stripeHook, cloudName, cloudKey, cloudSecret, appUrl, timezone] =
    await Promise.all([
      describeApify(),
      getSetting(SETTING.ANTHROPIC_KEY),
      getSetting(SETTING.GOOGLE_CLIENT_ID),
      getSetting(SETTING.GOOGLE_ACCOUNT),
      getSetting(SETTING.STRIPE_SECRET_KEY),
      getSetting(SETTING.STRIPE_WEBHOOK_SECRET),
      getSetting(SETTING.CLOUDINARY_CLOUD_NAME),
      getSetting(SETTING.CLOUDINARY_API_KEY),
      getSetting(SETTING.CLOUDINARY_API_SECRET),
      getSetting(SETTING.APP_URL),
      getSetting(SETTING.DEFAULT_TIMEZONE),
    ]);

  return {
    apify,
    capture: await describeCapture(),
    analyst: {
      configured: Boolean(anthropicKey),
      envManaged: isEnvManaged(SETTING.ANTHROPIC_KEY),
      key: anthropicKey ? maskSecret(anthropicKey) : null,
      model: ANALYST_MODEL,
    },
    google: {
      configured: await googleConfigured(),
      connected: await googleConnected(),
      envManaged: isEnvManaged(SETTING.GOOGLE_CLIENT_ID),
      clientId: googleClientId ? `${googleClientId.slice(0, 16)}…` : null,
      account: googleAccount,
      /** Register this on the OAuth client, exactly as shown. */
      redirectUri: redirectUri(origin(req, appUrl)),
    },
    stripe: {
      configured: Boolean(stripeKey),
      envManaged: isEnvManaged(SETTING.STRIPE_SECRET_KEY),
      key: stripeKey ? maskSecret(stripeKey) : null,
      livemode: stripeKey ? !stripeKey.startsWith("sk_test_") : null,
      webhookConfigured: Boolean(stripeHook),
      webhookUrl: `${origin(req, appUrl)}/api/webhooks/stripe`,
    },
    cloudinary: {
      configured: Boolean(cloudName && cloudKey && cloudSecret),
      envManaged: isEnvManaged(SETTING.CLOUDINARY_CLOUD_NAME),
      cloudName,
      apiKey: cloudKey ? maskSecret(cloudKey) : null,
    },
    email: await describeEmail(),
    alerts: await describeSlack(),
    developer: await describeGitHub(),
    calendar: await describeCalendar(),
    webhooks: await describeWebhooks(req, appUrl),
    system: await describeSystem(),
    general: {
      appUrl,
      appUrlEnvManaged: isEnvManaged(SETTING.APP_URL),
      resolvedAppUrl: origin(req, appUrl),
      timezone: timezone ?? "Africa/Accra",
    },
  };
}

/**
 * The company's own details and artwork.
 *
 * Sent whole rather than as a diff against the defaults: the form needs to
 * show what is currently printed on a letterhead, and "blank, meaning it falls
 * back to Dakyworld" is a distinction the screen makes with placeholder text
 * rather than with an empty field.
 */
async function describeSystem() {
  const [profile, images] = await Promise.all([companyProfile(), brandImages()]);
  return {
    profile,
    defaults: DEFAULT_PROFILE,
    /** Which slots have artwork uploaded. The bytes go out only on request. */
    brand: BRAND_SLOTS.map((entry) => ({ ...entry, uploaded: Boolean(images[entry.slot]) })),
    images,
  };
}

/** Slack: which route is live, and where messages land by default. */
async function describeSlack() {
  const [transport, webhook, token, channel] = await Promise.all([
    slackTransport(),
    getSetting(SETTING.SLACK_WEBHOOK_URL),
    getSetting(SETTING.SLACK_BOT_TOKEN),
    getSetting(SETTING.SLACK_DEFAULT_CHANNEL),
  ]);
  return {
    configured: transport !== "NONE",
    transport,
    envManaged: isEnvManaged(SETTING.SLACK_WEBHOOK_URL) || isEnvManaged(SETTING.SLACK_BOT_TOKEN),
    // Only the tail of a webhook URL: the whole thing is a credential — anyone
    // holding it can post into the channel.
    webhookUrl: webhook ? maskSecret(webhook) : null,
    botToken: token ? maskSecret(token) : null,
    defaultChannel: channel,
  };
}

/** GitHub: whether the token is there, and what a bare repo name means. */
async function describeGitHub() {
  const [token, owner] = await Promise.all([getSetting(SETTING.GITHUB_TOKEN), getSetting(SETTING.GITHUB_OWNER)]);
  return {
    configured: Boolean(token),
    envManaged: isEnvManaged(SETTING.GITHUB_TOKEN),
    token: token ? maskSecret(token) : null,
    owner,
  };
}

/**
 * Calendar rides on the Google connection, so the thing worth saying here is
 * whether that connection actually carries the calendar scope — one made
 * before Calendar was added does not, and reconnecting is the fix.
 */
async function describeCalendar() {
  const ready = await calendarReady();
  return {
    ...ready,
    configured: ready.connected && ready.scoped,
    // Listing calendars is a Google round trip that fails for exactly the
    // reason above, so an empty list here is information rather than an error.
    calendars: ready.connected && ready.scoped ? await listCalendars().catch(() => []) : [],
  };
}

/** Webhooks: the URL to hand a sender, and the secret they sign with. */
async function describeWebhooks(req: Request, appUrl: string | null) {
  const secret = await webhookSecret();
  return {
    configured: true,
    envManaged: isEnvManaged(SETTING.WEBHOOK_SECRET),
    secret: maskSecret(secret),
    /** What the website contact form should post to. */
    formUrl: `${origin(req, appUrl)}/api/webhooks/website-form`,
    baseUrl: `${origin(req, appUrl)}/api/webhooks/`,
    leadSource: (await getSetting(SETTING.WEBHOOK_LEAD_SOURCE)) ?? "OTHER",
  };
}

/**
 * What Hostinger says about the token: which mailboxes it may send from, and
 * whether the MCP server answers. Both are network round trips and the Settings
 * page polls, so they are cached for a minute the same way Apify's account is.
 */
const HOSTINGER_CACHE_MS = 60_000;
let hostingerCache: { at: number; token: string; mailboxes: HostingerMailbox[]; error: string | null; mcp: McpProbe } | null = null;

async function describeHostinger() {
  const token = await getSetting(SETTING.HOSTINGER_MAIL_TOKEN);
  const [mailboxId, address] = await Promise.all([
    getSetting(SETTING.HOSTINGER_MAILBOX_ID),
    getSetting(SETTING.HOSTINGER_MAILBOX_ADDRESS),
  ]);

  if (!token) {
    return {
      configured: false,
      envManaged: isEnvManaged(SETTING.HOSTINGER_MAIL_TOKEN),
      token: null,
      mailboxId: null,
      mailboxAddress: null,
      mailboxes: [] as HostingerMailbox[],
      error: null as string | null,
      mcp: null as McpProbe | null,
    };
  }

  if (!hostingerCache || hostingerCache.token !== token || Date.now() - hostingerCache.at > HOSTINGER_CACHE_MS) {
    const [mailboxes, mcp] = await Promise.all([
      fetchMailboxes(token).then(
        (list) => ({ list, error: null as string | null }),
        (err: Error) => ({ list: [] as HostingerMailbox[], error: err.message }),
      ),
      probeMcp(token),
    ]);
    hostingerCache = { at: Date.now(), token, mailboxes: mailboxes.list, error: mailboxes.error, mcp };
  }

  return {
    configured: Boolean(mailboxId && address),
    envManaged: isEnvManaged(SETTING.HOSTINGER_MAIL_TOKEN),
    token: maskSecret(token),
    mailboxId,
    mailboxAddress: address,
    mailboxes: hostingerCache.mailboxes,
    error: hostingerCache.error,
    mcp: hostingerCache.mcp,
  };
}

/** The mailbox the app sends from. No credential is ever returned, only its shape. */
async function describeEmail() {
  const config = await readMailerConfig();
  const [transport, hostinger, host, port, user, fromName, fromEmail, replyTo, sign] = await Promise.all([
    activeTransport(),
    describeHostinger(),
    getSetting(SETTING.SMTP_HOST),
    getSetting(SETTING.SMTP_PORT),
    getSetting(SETTING.SMTP_USER),
    getSetting(SETTING.MAIL_FROM_NAME),
    getSetting(SETTING.MAIL_FROM_EMAIL),
    getSetting(SETTING.MAIL_REPLY_TO),
    getSetting(SETTING.MAIL_SIGNATURE),
  ]);
  return {
    transport,
    /** Whether the transport that is actually live can send. */
    configured: transport === "HOSTINGER" ? hostinger.configured : config !== null,
    envManaged: isEnvManaged(SETTING.SMTP_HOST),
    transportEnvManaged: isEnvManaged(SETTING.MAIL_TRANSPORT),
    host,
    port: port ? Number(port) : 587,
    secure: config?.secure ?? false,
    user,
    smtpConfigured: config !== null,
    hostinger,
    fromName,
    fromEmail,
    replyTo,
    signature: sign ?? (await signature()),
  };
}

export type SettingsSnapshot = Awaited<ReturnType<typeof describeAll>>;

settingsRouter.get("/", async (req, res, next) => {
  try {
    res.json(await describeAll(req));
  } catch (err) {
    next(err);
  }
});

/** Rejects a write to something the deploy has pinned, rather than saving a value that will never be read. */
function guardEnv(key: string, label: string, res: { status: (code: number) => { json: (body: unknown) => unknown } }): boolean {
  if (!isEnvManaged(key)) return false;
  res.status(409).json({ error: `${label} is set by an environment variable. Change it in Railway instead.` });
  return true;
}

// --- Apify -----------------------------------------------------------------

// The token is verified against Apify before it is stored, so a typo fails
// here rather than silently at 6am.
settingsRouter.put("/apify", async (req, res, next) => {
  try {
    if (guardEnv(SETTING.APIFY_TOKEN, "The Apify token", res)) return;
    const { token } = z.object({ token: z.string().min(10, "That doesn't look like an Apify token") }).parse(req.body);

    try {
      await getAccount(token.trim());
    } catch (err) {
      const status = err instanceof ApifyError ? err.status : 400;
      return res.status(status === 401 || status === 403 ? 400 : status).json({
        error: err instanceof ApifyError ? err.message : "Could not verify the token with Apify",
      });
    }

    await setSetting(SETTING.APIFY_TOKEN, token.trim(), { secret: true });
    accountCache = null;
    clearApifyCaches();
    res.json(await describeAll(req));
  } catch (err) {
    next(err);
  }
});

// Disconnecting leaves sources and captured leads alone; scheduled runs simply stop firing.
settingsRouter.delete("/apify", async (req, res, next) => {
  try {
    if (guardEnv(SETTING.APIFY_TOKEN, "The Apify token", res)) return;
    await deleteSetting(SETTING.APIFY_TOKEN);
    accountCache = null;
    clearApifyCaches();
    res.json(await describeAll(req));
  } catch (err) {
    next(err);
  }
});

// --- Lead capture behaviour ------------------------------------------------

/**
 * Everything about how scrapes run that isn't the token: what a new source
 * starts as, what a run may cost, where it searches, and who is told about it.
 *
 * Each field is optional — the panel saves one card at a time — and an empty
 * string clears a value back to its default rather than storing a blank.
 */
settingsRouter.put("/capture", async (req, res, next) => {
  try {
    const input = z
      .object({
        maxItems: z.number().int().min(1).max(1000),
        minScore: z.number().int().min(0).max(100),
        autoQualify: z.boolean(),
        qualifyScore: z.number().int().min(0).max(100),
        timezone: z.string().refine(isValidTimezone, { message: "Unknown timezone" }),
        runTimeoutSecs: z.number().int().min(60, "Give a run at least a minute").max(21_600, "Six hours is the ceiling"),
        memoryMbytes: z.union([z.literal(0), z.literal(1024), z.literal(2048), z.literal(4096), z.literal(8192)]),
        proxyMode: z.enum(["NONE", "AUTO", "DATACENTER", "RESIDENTIAL"]),
        proxyCountry: z
          .string()
          .regex(/^[A-Za-z]{2}$/, "Use a two-letter country code, e.g. GH")
          .or(z.literal(""))
          .nullable(),
        monthlyBudgetUsd: z.number().min(0).max(100_000).nullable(),
        maxRunChargeUsd: z.number().min(0).max(10_000).nullable(),
        maxConcurrentRuns: z.number().int().min(1).max(10),
        location: z.string().min(2).max(120),
        countryCode: z.string().regex(/^[A-Za-z]{2}$/, "Use a two-letter country code, e.g. gh"),
        language: z.string().min(2).max(10),
        notify: z.enum(["OFF", "FAILURES", "ALL"]),
        notifyEmail: z.string().email().or(z.literal("")).nullable(),
        retentionDays: z.number().int().min(0).max(3650),
      })
      .partial()
      .parse(req.body);

    await writeCaptureConfig(input);
    res.json(await describeAll(req));
  } catch (err) {
    next(err);
  }
});

/**
 * Points one capture task at a different actor, or puts it back to the one the
 * app ships with. Nothing is validated against Apify here: an actor id that
 * does not exist fails loudly on the first run with Apify's own message, and
 * checking it at save time would mean a network round trip on a screen that is
 * usually just being read.
 */
settingsRouter.put("/capture/actors/:kind", async (req, res, next) => {
  try {
    const kind = req.params.kind as CaptureTask;
    if (!TASK_KINDS.includes(kind)) return res.status(404).json({ error: `There is no capture task called ${req.params.kind}.` });

    const { actorId, input } = z
      .object({
        // Written `username/actor-name` in Apify's UI; the runner normalises it.
        actorId: z.string().max(120).optional(),
        input: z.record(z.unknown()).optional(),
      })
      .parse(req.body);

    await writeActorOverride(kind, { actorId, input });
    res.json(await describeAll(req));
  } catch (err) {
    next(err);
  }
});

settingsRouter.delete("/capture/actors/:kind", async (req, res, next) => {
  try {
    const kind = req.params.kind as CaptureTask;
    if (!TASK_KINDS.includes(kind)) return res.status(404).json({ error: `There is no capture task called ${req.params.kind}.` });
    await writeActorOverride(kind, null);
    res.json(await describeAll(req));
  } catch (err) {
    next(err);
  }
});

// --- Anthropic -------------------------------------------------------------

settingsRouter.put("/anthropic", async (req, res, next) => {
  try {
    if (guardEnv(SETTING.ANTHROPIC_KEY, "The Anthropic API key", res)) return;
    const { key } = z.object({ key: z.string().min(10, "That doesn't look like an Anthropic API key") }).parse(req.body);
    await verifyKey(key.trim());
    await setSetting(SETTING.ANTHROPIC_KEY, key.trim(), { secret: true });
    res.json(await describeAll(req));
  } catch (err) {
    if (err instanceof AnalystError) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

settingsRouter.delete("/anthropic", async (req, res, next) => {
  try {
    if (guardEnv(SETTING.ANTHROPIC_KEY, "The Anthropic API key", res)) return;
    await deleteSetting(SETTING.ANTHROPIC_KEY);
    res.json(await describeAll(req));
  } catch (err) {
    next(err);
  }
});

// --- Google ----------------------------------------------------------------

settingsRouter.put("/google", async (req, res, next) => {
  try {
    if (guardEnv(SETTING.GOOGLE_CLIENT_ID, "The Google OAuth client", res)) return;
    const { clientId, clientSecret } = z
      .object({
        clientId: z.string().min(10, "That doesn't look like a Google client ID"),
        clientSecret: z.string().min(10, "That doesn't look like a Google client secret"),
      })
      .parse(req.body);

    await setSetting(SETTING.GOOGLE_CLIENT_ID, clientId.trim());
    await setSetting(SETTING.GOOGLE_CLIENT_SECRET, clientSecret.trim(), { secret: true });
    clearGoogleTokenCache();
    res.json(await describeAll(req));
  } catch (err) {
    next(err);
  }
});

settingsRouter.get("/google/auth-url", async (req, res, next) => {
  try {
    // Only a path within this app, never an absolute URL — an open redirect is
    // not a feature worth having.
    const requested = typeof req.query.return === "string" ? req.query.return : "/settings";
    const returnTo = requested.startsWith("/") && !requested.startsWith("//") ? requested : "/settings";
    const appUrl = await getSetting(SETTING.APP_URL);
    res.json({ url: await buildAuthUrl(origin(req, appUrl), rememberState(returnTo)) });
  } catch (err) {
    if (err instanceof GoogleError) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

/**
 * Completes the consent redirect. Exported rather than mounted here because
 * Google sends the browser to the URI registered on the OAuth client, which
 * lives under /api/imports (see lib/google.ts → redirectUri) — moving the path
 * would mean re-registering it. It is a page navigation, not an API call, so
 * it answers with a redirect either way and carries the outcome in the query
 * string.
 */
export async function handleGoogleCallback(req: Request, res: Response) {
  const appUrl = await getSetting(SETTING.APP_URL);
  const base = origin(req, appUrl);
  const state = typeof req.query.state === "string" ? req.query.state : "";
  const pending = state ? consumeState(state) : null;

  const back = (params: Record<string, string>) => {
    const url = new URL(pending?.returnTo ?? "/settings", base);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    res.redirect(url.toString());
  };

  if (typeof req.query.error === "string") return back({ google: "error", message: req.query.error });
  if (!pending) return back({ google: "error", message: "That sign-in link had expired. Try again." });

  const code = typeof req.query.code === "string" ? req.query.code : "";
  if (!code) return back({ google: "error", message: "Google didn't return an authorisation code." });

  try {
    const { email } = await exchangeCode(code, base);
    back({ google: "connected", ...(email ? { account: email } : {}) });
  } catch (err) {
    back({ google: "error", message: err instanceof GoogleError ? err.message : "Could not complete the Google sign-in." });
  }
}

settingsRouter.post("/google/disconnect", async (req, res, next) => {
  try {
    await deleteSetting(SETTING.GOOGLE_REFRESH_TOKEN);
    await deleteSetting(SETTING.GOOGLE_ACCOUNT);
    clearGoogleTokenCache();
    res.json(await describeAll(req));
  } catch (err) {
    next(err);
  }
});

// Removes the client itself, which implies disconnecting the account.
settingsRouter.delete("/google", async (req, res, next) => {
  try {
    if (guardEnv(SETTING.GOOGLE_CLIENT_ID, "The Google OAuth client", res)) return;
    await Promise.all([
      deleteSetting(SETTING.GOOGLE_CLIENT_ID),
      deleteSetting(SETTING.GOOGLE_CLIENT_SECRET),
      deleteSetting(SETTING.GOOGLE_REFRESH_TOKEN),
      deleteSetting(SETTING.GOOGLE_ACCOUNT),
    ]);
    clearGoogleTokenCache();
    res.json(await describeAll(req));
  } catch (err) {
    next(err);
  }
});

// --- Stripe ----------------------------------------------------------------

settingsRouter.put("/stripe", async (req, res, next) => {
  try {
    if (guardEnv(SETTING.STRIPE_SECRET_KEY, "The Stripe secret key", res)) return;
    const { secretKey, webhookSecret } = z
      .object({
        secretKey: z.string().min(10, "That doesn't look like a Stripe secret key"),
        webhookSecret: z.string().optional(),
      })
      .parse(req.body);

    try {
      await verifyStripeKey(secretKey.trim());
    } catch (err) {
      return res.status(400).json({ error: `Stripe rejected that key: ${(err as Error).message}` });
    }

    await setSetting(SETTING.STRIPE_SECRET_KEY, secretKey.trim(), { secret: true });
    if (webhookSecret?.trim()) await setSetting(SETTING.STRIPE_WEBHOOK_SECRET, webhookSecret.trim(), { secret: true });
    res.json(await describeAll(req));
  } catch (err) {
    next(err);
  }
});

settingsRouter.delete("/stripe", async (req, res, next) => {
  try {
    if (guardEnv(SETTING.STRIPE_SECRET_KEY, "The Stripe secret key", res)) return;
    await Promise.all([deleteSetting(SETTING.STRIPE_SECRET_KEY), deleteSetting(SETTING.STRIPE_WEBHOOK_SECRET)]);
    res.json(await describeAll(req));
  } catch (err) {
    next(err);
  }
});

// --- Cloudinary ------------------------------------------------------------

settingsRouter.put("/cloudinary", async (req, res, next) => {
  try {
    if (guardEnv(SETTING.CLOUDINARY_CLOUD_NAME, "The Cloudinary credentials", res)) return;
    const { cloudName, apiKey, apiSecret } = z
      .object({
        cloudName: z.string().min(2),
        apiKey: z.string().min(4),
        apiSecret: z.string().min(4),
      })
      .parse(req.body);

    await setSetting(SETTING.CLOUDINARY_CLOUD_NAME, cloudName.trim());
    await setSetting(SETTING.CLOUDINARY_API_KEY, apiKey.trim());
    await setSetting(SETTING.CLOUDINARY_API_SECRET, apiSecret.trim(), { secret: true });
    res.json(await describeAll(req));
  } catch (err) {
    next(err);
  }
});

settingsRouter.delete("/cloudinary", async (req, res, next) => {
  try {
    if (guardEnv(SETTING.CLOUDINARY_CLOUD_NAME, "The Cloudinary credentials", res)) return;
    await Promise.all([
      deleteSetting(SETTING.CLOUDINARY_CLOUD_NAME),
      deleteSetting(SETTING.CLOUDINARY_API_KEY),
      deleteSetting(SETTING.CLOUDINARY_API_SECRET),
    ]);
    res.json(await describeAll(req));
  } catch (err) {
    next(err);
  }
});

// --- Email -----------------------------------------------------------------

settingsRouter.put("/email", async (req, res, next) => {
  try {
    if (guardEnv(SETTING.SMTP_HOST, "The mail server settings", res)) return;
    const input = z
      .object({
        host: z.string().min(3),
        port: z.number().int().min(1).max(65535).default(587),
        secure: z.boolean().optional(),
        user: z.string().min(3),
        password: z.string().min(1),
        fromName: z.string().min(1).default("Dakyworld"),
        fromEmail: z.string().email(),
        replyTo: z.string().email().or(z.literal("")).optional(),
        signature: z.string().max(600).optional(),
      })
      .parse(req.body);

    // Checked against the server before it is stored, so a wrong password
    // fails on this screen rather than silently at 8am inside a sequence.
    await verifySmtp({
      host: input.host.trim(),
      port: input.port,
      secure: input.secure ?? input.port === 465,
      user: input.user.trim(),
      password: input.password,
      fromName: input.fromName,
      fromEmail: input.fromEmail,
      replyTo: input.replyTo || null,
    });

    await setSetting(SETTING.SMTP_HOST, input.host.trim());
    await setSetting(SETTING.SMTP_PORT, String(input.port));
    await setSetting(SETTING.SMTP_SECURE, String(input.secure ?? input.port === 465));
    await setSetting(SETTING.SMTP_USER, input.user.trim());
    await setSetting(SETTING.SMTP_PASSWORD, input.password, { secret: true });
    await setSetting(SETTING.MAIL_FROM_NAME, input.fromName.trim());
    await setSetting(SETTING.MAIL_FROM_EMAIL, input.fromEmail.trim());
    if (input.replyTo !== undefined) {
      if (input.replyTo) await setSetting(SETTING.MAIL_REPLY_TO, input.replyTo.trim());
      else await deleteSetting(SETTING.MAIL_REPLY_TO);
    }
    if (input.signature !== undefined) await setSetting(SETTING.MAIL_SIGNATURE, input.signature);
    // Connecting a mailbox is also choosing it: whatever was sending before,
    // this is what sends now.
    await setSetting(SETTING.MAIL_TRANSPORT, "SMTP");

    res.json(await describeAll(req));
  } catch (err) {
    if (err instanceof MailerError) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// --- Hostinger Agentic Mail ------------------------------------------------

/**
 * The one-field path. A token is all that is asked for: the mailbox it may send
 * from is read back from Hostinger and stored, rather than typed in and got
 * wrong. Sending afterwards goes through the MCP server — see
 * lib/hostingerMail.ts for what happens when that server can't be reached.
 *
 * Re-postable without the token, which is how the mailbox is switched on an
 * account that has more than one.
 */
settingsRouter.put("/email/hostinger", async (req, res, next) => {
  try {
    if (guardEnv(SETTING.HOSTINGER_MAIL_TOKEN, "The Hostinger mail token", res)) return;
    // Saving a token that a pinned transport would then ignore is worse than
    // refusing: mail would look connected and still go out the other way.
    if (isEnvManaged(SETTING.MAIL_TRANSPORT) && (await getSetting(SETTING.MAIL_TRANSPORT)) !== "HOSTINGER") {
      return res.status(409).json({ error: "MAIL_TRANSPORT is pinned to SMTP by an environment variable. Change it in Railway first." });
    }
    const input = z
      .object({
        token: z.string().min(10, "That doesn't look like a Hostinger API token").optional(),
        /** Only needed when the token can reach more than one mailbox. */
        mailboxId: z.string().min(1).optional(),
        fromName: z.string().min(1).max(120).optional(),
        replyTo: z.string().email().or(z.literal("")).optional(),
        signature: z.string().max(600).optional(),
      })
      .parse(req.body);

    const token = input.token?.trim() || (await getSetting(SETTING.HOSTINGER_MAIL_TOKEN));
    if (!token) return res.status(400).json({ error: "Paste the Hostinger API token first." });

    // Verified before anything is stored, so a bad paste fails on this screen
    // rather than at 8am inside a sequence.
    const mailboxes = await fetchMailboxes(token);
    const current = await getSetting(SETTING.HOSTINGER_MAILBOX_ID);
    const chosen =
      mailboxes.find((box) => box.resourceId === input.mailboxId) ??
      mailboxes.find((box) => box.resourceId === current) ??
      mailboxes[0];

    await setSetting(SETTING.HOSTINGER_MAIL_TOKEN, token, { secret: true });
    await setSetting(SETTING.HOSTINGER_MAILBOX_ID, chosen.resourceId);
    await setSetting(SETTING.HOSTINGER_MAILBOX_ADDRESS, chosen.address);
    // The rest of the app reads the from-address from one place, whichever
    // transport put it there.
    await setSetting(SETTING.MAIL_FROM_EMAIL, chosen.address);
    if (input.fromName?.trim()) await setSetting(SETTING.MAIL_FROM_NAME, input.fromName.trim());
    else if (!(await getSetting(SETTING.MAIL_FROM_NAME))) await setSetting(SETTING.MAIL_FROM_NAME, "Dakyworld");
    if (input.replyTo !== undefined) {
      if (input.replyTo) await setSetting(SETTING.MAIL_REPLY_TO, input.replyTo.trim());
      else await deleteSetting(SETTING.MAIL_REPLY_TO);
    }
    if (input.signature !== undefined) await setSetting(SETTING.MAIL_SIGNATURE, input.signature);
    await setSetting(SETTING.MAIL_TRANSPORT, "HOSTINGER");

    hostingerCache = null;
    clearHostingerSession();
    res.json(await describeAll(req));
  } catch (err) {
    if (err instanceof HostingerMailError) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

/** Hands sending back to SMTP, if that is connected; otherwise nothing sends. */
settingsRouter.delete("/email/hostinger", async (req, res, next) => {
  try {
    if (guardEnv(SETTING.HOSTINGER_MAIL_TOKEN, "The Hostinger mail token", res)) return;
    await Promise.all([
      deleteSetting(SETTING.HOSTINGER_MAIL_TOKEN),
      deleteSetting(SETTING.HOSTINGER_MAILBOX_ID),
      deleteSetting(SETTING.HOSTINGER_MAILBOX_ADDRESS),
    ]);
    await setSetting(SETTING.MAIL_TRANSPORT, "SMTP");
    hostingerCache = null;
    clearHostingerSession();
    res.json(await describeAll(req));
  } catch (err) {
    next(err);
  }
});

/** Proves the whole path works, end to end, by sending one real email. */
settingsRouter.post("/email/test", async (req, res, next) => {
  try {
    const { to } = z.object({ to: z.string().email() }).parse(req.body);
    // On the live identity, not the shipped defaults: a test whose letterhead
    // says something different from a real email is not a test of anything.
    const [sign, profile, shell] = await Promise.all([signature(), companyProfile(), logoSources(false)]);
    const body = `This is a test from ${profile.displayName} OS.\n\nIf you are reading it, the mailbox is connected and the app can send on your behalf — proposals, invoices, deliverables and sequences will all go out through this address.`;
    await sendMail({
      to,
      subject: `${profile.displayName} OS — mail is working`,
      html: toHtml(body, sign, null, { profile, ...shell }),
      text: toText(body, sign, null, profile),
    });
    res.json({ ok: true, to });
  } catch (err) {
    if (err instanceof MailerError) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

settingsRouter.delete("/email", async (req, res, next) => {
  try {
    if (guardEnv(SETTING.SMTP_HOST, "The mail server settings", res)) return;
    await Promise.all([
      deleteSetting(SETTING.SMTP_HOST),
      deleteSetting(SETTING.SMTP_PORT),
      deleteSetting(SETTING.SMTP_SECURE),
      deleteSetting(SETTING.SMTP_USER),
      deleteSetting(SETTING.SMTP_PASSWORD),
      deleteSetting(SETTING.MAIL_FROM_NAME),
      deleteSetting(SETTING.MAIL_FROM_EMAIL),
      deleteSetting(SETTING.MAIL_REPLY_TO),
    ]);
    res.json(await describeAll(req));
  } catch (err) {
    next(err);
  }
});

// --- General ---------------------------------------------------------------

settingsRouter.put("/general", async (req, res, next) => {
  try {
    const { appUrl, timezone } = z
      .object({
        appUrl: z.string().url("That isn't a valid URL").or(z.literal("")).optional(),
        timezone: z.string().min(1).optional(),
      })
      .parse(req.body);

    if (appUrl !== undefined && !isEnvManaged(SETTING.APP_URL)) {
      if (appUrl) await setSetting(SETTING.APP_URL, appUrl.replace(/\/$/, ""));
      else await deleteSetting(SETTING.APP_URL);
    }
    if (timezone) await setSetting(SETTING.DEFAULT_TIMEZONE, timezone);

    res.json(await describeAll(req));
  } catch (err) {
    next(err);
  }
});


// --- Alerts (Slack) --------------------------------------------------------

settingsRouter.put("/slack", async (req, res, next) => {
  try {
    if (guardEnv(SETTING.SLACK_WEBHOOK_URL, "The Slack connection", res)) return;
    const { webhookUrl, botToken, defaultChannel } = z
      .object({
        webhookUrl: z.string().optional(),
        botToken: z.string().optional(),
        defaultChannel: z.string().max(80).optional(),
      })
      .parse(req.body);

    // Verified before it is stored, so a typo is caught here rather than the
    // first time an alert silently fails to arrive.
    if (botToken?.trim()) {
      try {
        await verifySlack({ token: botToken.trim() });
      } catch (err) {
        return res.status(400).json({ error: (err as SlackError).message });
      }
      await setSetting(SETTING.SLACK_BOT_TOKEN, botToken.trim(), { secret: true });
    }

    if (webhookUrl?.trim()) {
      try {
        await verifySlack({ webhookUrl: webhookUrl.trim() });
      } catch (err) {
        return res.status(400).json({ error: (err as SlackError).message });
      }
      await setSetting(SETTING.SLACK_WEBHOOK_URL, webhookUrl.trim(), { secret: true });
    }

    if (defaultChannel !== undefined) {
      if (defaultChannel.trim()) await setSetting(SETTING.SLACK_DEFAULT_CHANNEL, defaultChannel.trim());
      else await deleteSetting(SETTING.SLACK_DEFAULT_CHANNEL);
    }

    clearReadinessCache();
    res.json(await describeAll(req));
  } catch (err) {
    next(err);
  }
});

/** Puts a real message in the channel — the only honest test of a webhook URL. */
settingsRouter.post("/slack/test", async (req, res, next) => {
  try {
    const { channel } = z.object({ channel: z.string().max(80).optional() }).parse(req.body ?? {});
    const result = await sendSlack({
      title: "Dakyworld OS",
      text: "Slack is connected. Alerts about captures, sequences and escalations will arrive here.",
      channel: channel ?? null,
    });
    if (!result.delivered) return res.status(400).json({ error: "Slack isn't connected yet." });
    res.json(result);
  } catch (err) {
    if (err instanceof SlackError) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

settingsRouter.delete("/slack", async (req, res, next) => {
  try {
    if (guardEnv(SETTING.SLACK_WEBHOOK_URL, "The Slack connection", res)) return;
    await Promise.all([
      deleteSetting(SETTING.SLACK_WEBHOOK_URL),
      deleteSetting(SETTING.SLACK_BOT_TOKEN),
      deleteSetting(SETTING.SLACK_DEFAULT_CHANNEL),
    ]);
    clearReadinessCache();
    res.json(await describeAll(req));
  } catch (err) {
    next(err);
  }
});

// --- Developer (GitHub) ----------------------------------------------------

settingsRouter.put("/github", async (req, res, next) => {
  try {
    if (guardEnv(SETTING.GITHUB_TOKEN, "The GitHub token", res)) return;
    const { token, owner } = z
      .object({ token: z.string().min(8, "That doesn't look like a GitHub token").optional(), owner: z.string().max(80).optional() })
      .parse(req.body);

    if (token?.trim()) {
      try {
        await verifyGitHubToken(token.trim());
      } catch (err) {
        return res.status(400).json({ error: `GitHub rejected that token: ${(err as GitHubError).message}` });
      }
      await setSetting(SETTING.GITHUB_TOKEN, token.trim(), { secret: true });
    }

    if (owner !== undefined) {
      if (owner.trim()) await setSetting(SETTING.GITHUB_OWNER, owner.trim());
      else await deleteSetting(SETTING.GITHUB_OWNER);
    }

    clearReadinessCache();
    res.json(await describeAll(req));
  } catch (err) {
    next(err);
  }
});

settingsRouter.delete("/github", async (req, res, next) => {
  try {
    if (guardEnv(SETTING.GITHUB_TOKEN, "The GitHub token", res)) return;
    await Promise.all([deleteSetting(SETTING.GITHUB_TOKEN), deleteSetting(SETTING.GITHUB_OWNER)]);
    clearReadinessCache();
    res.json(await describeAll(req));
  } catch (err) {
    next(err);
  }
});

// --- Calendar --------------------------------------------------------------

settingsRouter.put("/calendar", async (req, res, next) => {
  try {
    const { calendarId } = z.object({ calendarId: z.string().max(200) }).parse(req.body);
    if (calendarId.trim() && calendarId.trim() !== "primary") await setSetting(SETTING.GOOGLE_CALENDAR_ID, calendarId.trim());
    else await deleteSetting(SETTING.GOOGLE_CALENDAR_ID);
    clearReadinessCache();
    res.json(await describeAll(req));
  } catch (err) {
    next(err);
  }
});

// --- Webhooks --------------------------------------------------------------

settingsRouter.put("/webhooks", async (req, res, next) => {
  try {
    const { leadSource } = z.object({ leadSource: z.string().max(40) }).parse(req.body);
    if (leadSource.trim()) await setSetting(SETTING.WEBHOOK_LEAD_SOURCE, leadSource.trim().toUpperCase());
    else await deleteSetting(SETTING.WEBHOOK_LEAD_SOURCE);
    res.json(await describeAll(req));
  } catch (err) {
    next(err);
  }
});

/**
 * Mints a new shared secret. Every sender has to be updated afterwards, which
 * the UI says before it lets this happen — a rotation nobody follows up looks
 * exactly like an endpoint that has stopped working.
 */
settingsRouter.post("/webhooks/rotate", async (req, res, next) => {
  try {
    if (guardEnv(SETTING.WEBHOOK_SECRET, "The webhook secret", res)) return;
    const secret = await rotateWebhookSecret();
    // Returned in full exactly once — it is not readable again afterwards.
    res.json({ secret, snapshot: await describeAll(req) });
  } catch (err) {
    next(err);
  }
});

// --- System (the company's own details) ------------------------------------

/**
 * One address, one phone number, one logo.
 *
 * Everything the company says about itself used to be a constant in
 * `services/dakyworld.ts`: correct, single-sourced, and only changeable by a
 * developer with a deploy. This is the same single source made editable —
 * see services/systemProfile.ts for what reads it.
 *
 * There is no env-managed guard here, unlike every credential above. These are
 * not secrets and there is no deployment reason to pin them; the reason the
 * screen exists is that the Owner changes them.
 */
const profileInput = z.object({
  name: z.string().max(80).optional(),
  displayName: z.string().max(80).optional(),
  legalName: z.string().max(120).optional(),
  tagline: z.string().max(160).optional(),
  footerLine: z.string().max(120).optional(),
  promise: z.string().max(160).optional(),
  positioning: z.string().max(300).optional(),
  location: z.string().max(120).optional(),
  addressLines: z.array(z.string().max(120)).max(6).optional(),
  email: z.string().email("That isn't a valid email address").or(z.literal("")).optional(),
  phone: z.string().max(40).optional(),
  phoneAlt: z.string().max(40).optional(),
  web: z.string().max(120).optional(),
  social: z
    .object({
      linkedin: z.string().max(200).optional(),
      x: z.string().max(200).optional(),
      instagram: z.string().max(200).optional(),
      facebook: z.string().max(200).optional(),
      youtube: z.string().max(200).optional(),
    })
    .optional(),
  currency: z.string().max(6).optional(),
  registrationNumber: z.string().max(60).optional(),
  vatNumber: z.string().max(60).optional(),
});

settingsRouter.put("/system", async (req, res, next) => {
  try {
    const input = profileInput.parse(req.body);
    await saveCompanyProfile(input);
    res.json(await describeAll(req));
  } catch (err) {
    next(err);
  }
});

/**
 * A logo, as a data URL in the JSON body.
 *
 * The same shape `/api/imports` uses for a workbook, and for the same reason:
 * nothing else in this API takes multipart, and one upload path is easier to
 * reason about than two. 1 MB is a generous ceiling for a lock-up that rides
 * along on every email — a master export belongs in `assets/brand/`, not here.
 */
const MAX_LOGO_BYTES = 1_000_000;
const LOGO_TYPES = ["image/png", "image/jpeg", "image/svg+xml", "image/webp", "image/gif"];

settingsRouter.put("/system/brand/:slot", async (req, res, next) => {
  try {
    const slot = req.params.slot as BrandSlot;
    if (!BRAND_SLOTS.some((entry) => entry.slot === slot)) {
      return res.status(404).json({ error: `There is no brand slot called ${req.params.slot}.` });
    }
    const { dataUrl } = z.object({ dataUrl: z.string().min(20) }).parse(req.body);

    const match = /^data:([\w/+.-]+);base64,(.+)$/s.exec(dataUrl.trim());
    if (!match) return res.status(400).json({ error: "That doesn't look like an image — re-pick the file." });
    if (!LOGO_TYPES.includes(match[1])) {
      return res.status(400).json({ error: `${match[1]} isn't an image type email clients render. Use PNG, JPEG, SVG, WebP or GIF.` });
    }
    if (Buffer.from(match[2], "base64").length > MAX_LOGO_BYTES) {
      return res.status(400).json({ error: "That file is over 1 MB. Export a smaller cut — this rides along on every email." });
    }

    await saveBrandImage(slot, dataUrl.trim());
    res.json(await describeAll(req));
  } catch (err) {
    next(err);
  }
});

/** Removes an upload, which falls the slot back to the artwork shipped on disk. */
settingsRouter.delete("/system/brand/:slot", async (req, res, next) => {
  try {
    const slot = req.params.slot as BrandSlot;
    if (!BRAND_SLOTS.some((entry) => entry.slot === slot)) {
      return res.status(404).json({ error: `There is no brand slot called ${req.params.slot}.` });
    }
    await deleteBrandImage(slot);
    res.json(await describeAll(req));
  } catch (err) {
    next(err);
  }
});
