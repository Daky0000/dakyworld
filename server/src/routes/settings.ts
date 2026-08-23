import express, { Router, type Request, type Response } from "express";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { describeNumber, verifyWhatsAppKeys } from "../lib/whatsapp.js";
import { SETTING, deleteSetting, getSetting, isEnvManaged, setSetting } from "../lib/settings.js";
import { maskSecret } from "../lib/secrets.js";
import { ImapError, imapConfigured, readImapConfig, suggestFromSmtp, verifyImap } from "../lib/imap.js";
import { restartWatcher, watcherStatus } from "../services/mailbox/watcher.js";
import { ApifyError, clearApifyCaches, getAccount, getActorPricing, getActorSchema, getMonthlyUsage } from "../lib/apify.js";
import { DEFAULT_SCREENSHOT_ACTOR, KNOWN_SCREENSHOT_ACTORS, screenshotActorId } from "../services/screenshotActors.js";
import { DEFAULT_SEO_ACTOR, seoActorId } from "../services/seoAudit.js";
import { CAPTURE_DEFAULTS, captureEnvManaged, readCaptureConfig, writeCaptureConfig } from "../services/captureConfig.js";
import { TASK_KINDS, describeTasks, writeActorOverride, type CaptureTask } from "../services/captureActors.js";
import { isValidTimezone } from "../services/scheduler.js";
import { AnalystError, ANALYST_MODEL, verifyKey } from "../lib/anthropic.js";
import {
  JOBS,
  MODEL_JOBS,
  PROVIDERS,
  PROVIDER_KEYS,
  describeProviders,
  describeRouting,
  isModelJob,
  isPricedModel,
  isProviderKey,
  readJobModels,
  readRoutes,
  type ModelJob,
  type ProviderKey,
} from "../lib/models/registry.js";
import { verifyProviderKey } from "../lib/models/call.js";
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
import { verifyPaystackKey } from "../lib/paystack.js";
import { verifyHubtelKeys } from "../lib/hubtel.js";
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
import { assertImageBytes, FileTypeError } from "../lib/fileType.js";
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
import { gateBy } from "../middleware/permissionGate.js";

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

settingsRouter.use(
  gateBy({
    view: "settings.view",
    create: "settings.integrations",
    edit: "settings.integrations",
    remove: "settings.integrations",
    routes: [
      // Order matters here: /hubtel-sms is the SMS provider and /hubtel is the
      // payment one, so both are anchored rather than left as prefixes.
      { path: /^\/hubtel-sms$/, permission: "messages.settings" },
      { path: /^\/(paystack|stripe|hubtel)$/, permission: "settings.payments" },
      { path: /^\/(whatsapp|sms-callback-token)$/, permission: "messages.settings" },
      { path: /^\/messaging\//, permission: "messages.settings" },
      { path: /^\/system\/brand\//, permission: "settings.templates" },
      { path: /^\/(system|general)$/, permission: "settings.company" },
      { path: /^\/(models|anthropic)/, permission: "settings.models" },
      { path: /^\/(apify|capture)/, permission: "leads.sources" },
    ],
  }),
);

// These credentials spend real money and reach outside the company.

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
  const [
    apify, anthropicKey, googleClientId, googleAccount, stripeKey, stripeHook, cloudName, cloudKey, cloudSecret, appUrl, timezone,
    paystackKey, hubtelClientId, hubtelMerchant, hubtelSmsId, hubtelSender, githubRepos,
  ] =
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
      getSetting(SETTING.PAYSTACK_SECRET_KEY),
      getSetting(SETTING.HUBTEL_CLIENT_ID),
      getSetting(SETTING.HUBTEL_MERCHANT_ID),
      getSetting(SETTING.HUBTEL_SMS_ID),
      getSetting(SETTING.HUBTEL_SMS_SENDER),
      getSetting(SETTING.GITHUB_ALLOWED_REPOS),
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
    // The two Ghanaian rails. Each carries the webhook address to paste into
    // the provider's dashboard, because that is the step most likely to be
    // missed — a key with no webhook takes money and never marks an invoice
    // paid, which looks like the integration not working at all.
    paystack: {
      configured: Boolean(paystackKey),
      envManaged: isEnvManaged(SETTING.PAYSTACK_SECRET_KEY),
      key: paystackKey ? maskSecret(paystackKey) : null,
      livemode: paystackKey ? paystackKey.startsWith("sk_live_") : null,
      webhookUrl: `${origin(req, appUrl)}/api/webhooks/paystack`,
    },
    hubtel: {
      configured: Boolean(hubtelClientId && hubtelMerchant),
      envManaged: isEnvManaged(SETTING.HUBTEL_CLIENT_ID),
      clientId: hubtelClientId ? maskSecret(hubtelClientId) : null,
      merchantId: hubtelMerchant,
      callbackUrl: `${origin(req, appUrl)}/api/webhooks/hubtel`,
      sms: {
        configured: Boolean(hubtelSmsId),
        envManaged: isEnvManaged(SETTING.HUBTEL_SMS_ID),
        smsId: hubtelSmsId ? maskSecret(hubtelSmsId) : null,
        sender: hubtelSender || null,
      },
    },
    messaging: await describeMessaging(req, appUrl),
    /**
     * Which repositories agents may write to. Deliberately reported even when
     * empty, because empty is a meaningful state — it is what stops an agent
     * changing the software that runs the company — and a panel that hid itself
     * until configured would never explain that.
     */
    agentRepos: {
      envManaged: isEnvManaged(SETTING.GITHUB_ALLOWED_REPOS),
      repos: githubRepos ?? "",
      writable: Boolean(githubRepos?.trim()),
    },
    cloudinary: {
      configured: Boolean(cloudName && cloudKey && cloudSecret),
      envManaged: isEnvManaged(SETTING.CLOUDINARY_CLOUD_NAME),
      cloudName,
      apiKey: cloudKey ? maskSecret(cloudKey) : null,
    },
    models: await describeModels(),
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

/**
 * The four model vendors and what each is doing.
 *
 * The routing is sent whole rather than as a diff against the defaults, for
 * the same reason the company profile is: the screen has to show what is
 * happening now, and "unset, meaning it falls back" is a distinction the UI
 * makes with a note rather than with an empty field.
 *
 * Keys are masked here and nowhere unmasked — a settings snapshot is a
 * response body, and a response body is a place a credential must never be.
 */
async function describeModels() {
  const [providers, routing] = await Promise.all([describeProviders(), describeRouting()]);

  const withKeys = await Promise.all(
    providers.map(async (provider) => {
      const value = await getSetting(PROVIDERS[provider.key].keySetting);
      return { ...provider, keyPreview: value ? maskSecret(value) : null };
    }),
  );

  return {
    providers: withKeys,
    routing,
    /** What each job is, so the screen doesn't have to hold its own copy. */
    jobs: MODEL_JOBS.map((job) => JOBS[job]),
  };
}

/** Slack: which route is live, where messages land, and whether it can talk back. */
async function describeSlack() {
  const [transport, webhook, token, channel, signing, approvers] = await Promise.all([
    slackTransport(),
    getSetting(SETTING.SLACK_WEBHOOK_URL),
    getSetting(SETTING.SLACK_BOT_TOKEN),
    getSetting(SETTING.SLACK_DEFAULT_CHANNEL),
    getSetting(SETTING.SLACK_SIGNING_SECRET),
    getSetting(SETTING.SLACK_APPROVERS),
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
    // The inbound half. Reported separately from `configured` because they are
    // genuinely different states: Slack can be perfectly able to receive alerts
    // and completely unable to send a decision back, and the symptom of that is
    // a hiring card whose buttons do nothing.
    signingSecret: signing ? maskSecret(signing) : null,
    canReceive: Boolean(signing),
    approvers: (approvers ?? "").split(/[,\s]+/).filter(Boolean),
    signingSecretEnvManaged: isEnvManaged(SETTING.SLACK_SIGNING_SECRET),
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
    inbox: await describeInbox(),
  };
}

/**
 * Whether the mailbox can be *read*, which is a different question from
 * whether it can be written to.
 *
 * Reported beside sending rather than under it: a provider with IMAP switched
 * off, or an App Password scoped to SMTP alone, sends perfectly and reads
 * nothing — and one "email is connected" covering both is what would hide that.
 */
async function describeInbox() {
  const [config, connected, enabled, sentFolder, backfill, triage, autoRoute, ownDomains, cursors] = await Promise.all([
    readImapConfig(),
    imapConfigured(),
    getSetting(SETTING.IMAP_ENABLED),
    getSetting(SETTING.IMAP_SENT_FOLDER),
    getSetting(SETTING.MAIL_BACKFILL_DAYS),
    getSetting(SETTING.MAIL_TRIAGE),
    getSetting(SETTING.MAIL_AUTOROUTE),
    getSetting(SETTING.MAIL_OWN_DOMAINS),
    prisma.mailSyncState.findMany({ orderBy: { folder: "asc" } }),
  ]);

  return {
    configured: connected,
    /** Credentials stored but switched off — not the same as never connected. */
    paused: enabled === "false",
    envManaged: isEnvManaged(SETTING.IMAP_HOST),
    host: config?.host ?? (await getSetting(SETTING.IMAP_HOST)),
    port: config?.port ?? Number((await getSetting(SETTING.IMAP_PORT)) ?? 993),
    secure: config?.secure ?? true,
    user: config?.user ?? (await getSetting(SETTING.IMAP_USER)),
    sentFolder,
    backfillDays: backfill ? Number(backfill) : 14,
    triage: triage !== "false",
    autoRoute: autoRoute !== "false",
    ownDomains,
    watcher: watcherStatus(),
    folders: cursors.map((cursor) => ({
      folder: cursor.folder,
      lastSyncAt: cursor.lastSyncAt,
      lastError: cursor.lastError,
      messagesSeen: cursor.messagesSeen,
    })),
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

/**
 * Which actor takes the homepage screenshots, and what each candidate costs
 * right now.
 *
 * The prices come from Apify at read time rather than from a constant, for the
 * reason the capture actors already follow: they change, and a stale number is
 * the wrong basis for a decision that is meant to save money. Compute-priced
 * actors report no per-event price at all, which is itself the answer — those
 * cost platform compute, and batching is what makes them cheap.
 */
async function describeActorChoice(current: string, shipped: string, known: string[]) {
  const candidates = await Promise.all(
    [...new Set([current, ...known])].map(async (actorId) => {
      const [pricing, schema] = await Promise.all([
        getActorPricing(actorId).catch(() => null),
        getActorSchema(actorId).catch(() => null),
      ]);
      return {
        actorId,
        current: actorId === current,
        shipped: actorId === shipped,
        title: schema?.title ?? null,
        pricingModel: pricing?.model ?? schema?.pricingModel ?? null,
        /** Per-event prices, when it charges per event rather than for compute. */
        events: pricing?.events ?? [],
        perResultUsd: pricing?.perResultUsd ?? null,
        memoryMbytes: schema?.defaultRunOptions?.memoryMbytes ?? null,
        readable: Boolean(schema),
      };
    }),
  );
  return { current, shipped, candidates };
}

settingsRouter.get("/capture/screenshot-actor", async (_req, res, next) => {
  try {
    res.json(await describeActorChoice(await screenshotActorId(), DEFAULT_SCREENSHOT_ACTOR, KNOWN_SCREENSHOT_ACTORS));
  } catch (err) {
    next(err);
  }
});

/**
 * Which actor opens the page in a real browser for the speed and SEO review.
 *
 * Priced per page analysed rather than per picture, so the number that matters
 * here is what one audit costs — the audit team asks for exactly one page.
 */
settingsRouter.get("/capture/seo-actor", async (_req, res, next) => {
  try {
    res.json(await describeActorChoice(await seoActorId(), DEFAULT_SEO_ACTOR, [DEFAULT_SEO_ACTOR]));
  } catch (err) {
    next(err);
  }
});

/** Points the speed and SEO measurements at a different actor, or back at the shipped one. */
settingsRouter.put("/capture/seo-actor", async (req, res, next) => {
  try {
    const { actorId } = z.object({ actorId: z.string().max(120).nullish() }).parse(req.body);
    const wanted = actorId?.trim();
    if (wanted) await setSetting(SETTING.SEO_AUDIT_ACTOR, wanted);
    else await deleteSetting(SETTING.SEO_AUDIT_ACTOR);
    res.json({ current: await seoActorId() });
  } catch (err) {
    next(err);
  }
});

/** Points the screenshots at a different actor, or back at the shipped one. */
settingsRouter.put("/capture/screenshot-actor", async (req, res, next) => {
  try {
    const { actorId } = z.object({ actorId: z.string().max(120).nullish() }).parse(req.body);
    const wanted = actorId?.trim();
    // Clearing it is how you go back to the shipped default, so an empty value
    // deletes the row rather than storing an empty string that reads as a
    // deliberate choice of nothing.
    if (wanted) await setSetting(SETTING.SCREENSHOT_ACTOR, wanted);
    else await deleteSetting(SETTING.SCREENSHOT_ACTOR);
    res.json({ current: await screenshotActorId() });
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

// --- AI models -------------------------------------------------------------

/**
 * One key per vendor, and one dropdown per job.
 *
 * There is deliberately no route that takes all four keys at once: a key is
 * verified against its vendor before it is stored, and a form that saves four
 * would have to decide what to do when two of them work and two do not.
 */
settingsRouter.put("/models/:provider", async (req, res, next) => {
  try {
    const provider = req.params.provider;
    if (!isProviderKey(provider)) return res.status(404).json({ error: "No such model provider." });

    const definition = PROVIDERS[provider];
    const input = z
      .object({
        key: z.string().min(8).optional(),
        /** The model this vendor uses. Blank restores the shipped default. */
        model: z.string().max(80).nullish(),
        /** ChatGPT only: the image model, which is a different model. */
        imageModel: z.string().max(80).nullish(),
      })
      .parse(req.body);

    if (input.key !== undefined) {
      if (guardEnv(definition.keySetting, `The ${definition.vendor} API key`, res)) return;
      // Checked against the vendor before it is stored, the same way the Apify
      // token and the Anthropic key are: a key that fails on first use is a
      // support conversation, and one refused at the moment it is pasted is a
      // typo fixed in ten seconds.
      await verifyProviderKey(provider, input.key.trim());
      await setSetting(definition.keySetting, input.key.trim(), { secret: true });
    }

    if (input.model !== undefined) {
      if (guardEnv(definition.modelSetting, `The ${definition.vendor} model`, res)) return;
      const model = input.model?.trim();
      if (model) await setSetting(definition.modelSetting, model);
      else await deleteSetting(definition.modelSetting);
    }

    if (input.imageModel !== undefined && provider === "openai") {
      const model = input.imageModel?.trim();
      if (model) await setSetting(SETTING.OPENAI_IMAGE_MODEL, model);
      else await deleteSetting(SETTING.OPENAI_IMAGE_MODEL);
    }

    // A new key changes what every model tool can do, and readiness is cached.
    clearReadinessCache();
    res.json(await describeAll(req));
  } catch (err) {
    if (err instanceof AnalystError) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

settingsRouter.delete("/models/:provider", async (req, res, next) => {
  try {
    const provider = req.params.provider;
    if (!isProviderKey(provider)) return res.status(404).json({ error: "No such model provider." });
    const definition = PROVIDERS[provider];
    if (guardEnv(definition.keySetting, `The ${definition.vendor} API key`, res)) return;

    await deleteSetting(definition.keySetting);
    clearReadinessCache();
    res.json(await describeAll(req));
  } catch (err) {
    next(err);
  }
});

/**
 * Which vendor does which job.
 *
 * Stored as only what differs from the shipped routing, so a default that
 * changes in a later deploy is picked up rather than frozen by a saved copy of
 * itself. A route to a vendor that cannot do the job is refused here rather
 * than dropped silently on read — the Owner should find out at the moment they
 * choose it, not by noticing months later that nothing changed.
 */
settingsRouter.put("/models/routes/:job", async (req, res, next) => {
  try {
    const job = req.params.job;
    if (!isModelJob(job)) return res.status(404).json({ error: "No such job." });

    const { provider } = z.object({ provider: z.string().max(40).nullable() }).parse(req.body);

    const routes: Partial<Record<ModelJob, ProviderKey>> = { ...(await readRoutes()) };
    if (provider === null) {
      delete routes[job];
    } else {
      if (!isProviderKey(provider)) return res.status(400).json({ error: "No such model provider." });
      if (!PROVIDERS[provider].jobs.includes(job)) {
        return res.status(400).json({ error: `${PROVIDERS[provider].name} can't do that job, so it can't be routed there.` });
      }
      routes[job] = provider;
    }

    if (Object.keys(routes).length === 0) await deleteSetting(SETTING.MODEL_ROUTES);
    else await setSetting(SETTING.MODEL_ROUTES, JSON.stringify(routes));

    res.json(await describeAll(req));
  } catch (err) {
    next(err);
  }
});

/**
 * Which *model* does which job.
 *
 * The sibling of the route above, and the answer to a different question: that
 * one picks the vendor, this one picks how much the job is worth paying for.
 * Reading the post runs once per arriving message and sorting a pasted prompt
 * has a right answer — neither is worth the rate a letter to a stranger is —
 * so both ship on the economy tier and this is how the Owner overrules that.
 *
 * A model with no published rate is refused here rather than dropped on read,
 * for the same reason a bad route is: an unpriced model prices at the most
 * expensive rate we know of, which is the safe direction for a budget and a
 * terrible place to discover a typo.
 */
settingsRouter.put("/models/jobs/:job", async (req, res, next) => {
  try {
    const job = req.params.job;
    if (!isModelJob(job)) return res.status(404).json({ error: "No such job." });

    const { model } = z.object({ model: z.string().max(80).nullable() }).parse(req.body);

    const chosen: Partial<Record<ModelJob, string>> = { ...(await readJobModels()) };
    const trimmed = model?.trim();
    // Blank and null both mean "put it back on the shipped tier". A form that
    // sends an empty string when somebody clears a field is the normal case,
    // and storing "" would be a model name nothing can serve.
    if (!trimmed) {
      delete chosen[job];
    } else {
      if (!isPricedModel(trimmed)) {
        return res.status(400).json({
          error: `There is no published rate here for ${trimmed}, so what it costs could not be recorded. Add one under models.pricing first, or choose a listed model.`,
        });
      }
      chosen[job] = trimmed;
    }

    if (Object.keys(chosen).length === 0) await deleteSetting(SETTING.MODEL_JOB_MODELS);
    else await setSetting(SETTING.MODEL_JOB_MODELS, JSON.stringify(chosen));

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

// --- Reading the inbox ------------------------------------------------------
//
// The other half of the mailbox. Kept in its own block rather than folded into
// the SMTP one above because the two fail independently: a mailbox that sends
// perfectly can be unreadable (a provider with IMAP switched off, an App
// Password scoped to sending), and saying "email is connected" for both would
// hide exactly that.

/**
 * What connecting the reader would look like, filled in from what is already
 * stored.
 *
 * Offered rather than demanded. The host is the SMTP host with `smtp` swapped
 * for `imap` on every provider this company is likely to meet, the port is
 * 993, and the password is usually the same App Password already pasted in for
 * sending — so the form arrives filled in and the Owner confirms it, which is
 * the difference between connecting mail in a minute and connecting it in an
 * evening.
 */
settingsRouter.get("/inbox/suggestion", async (_req, res, next) => {
  try {
    const [smtpHost, smtpUser] = await Promise.all([getSetting(SETTING.SMTP_HOST), getSetting(SETTING.SMTP_USER)]);
    const suggestion = suggestFromSmtp(smtpHost);
    res.json({
      ...(suggestion ?? { host: "", port: 993, secure: true }),
      user: smtpUser ?? "",
      /** True when there is an SMTP password stored that this could reuse. */
      canReusePassword: Boolean(await getSetting(SETTING.SMTP_PASSWORD)),
      from: smtpHost ? "smtp" : null,
    });
  } catch (err) {
    next(err);
  }
});

settingsRouter.put("/inbox", async (req, res, next) => {
  try {
    if (guardEnv(SETTING.IMAP_HOST, "The inbox settings", res)) return;
    const input = z
      .object({
        host: z.string().min(3),
        port: z.number().int().min(1).max(65535).default(993),
        secure: z.boolean().optional(),
        user: z.string().min(3),
        /** Blank means "use the SMTP password", which is the usual answer. */
        password: z.string().optional(),
        sentFolder: z.string().max(120).optional(),
        backfillDays: z.number().int().min(1).max(365).optional(),
        triage: z.boolean().optional(),
        autoRoute: z.boolean().optional(),
        ownDomains: z.string().max(400).optional(),
      })
      .parse(req.body);

    const password = input.password?.trim() || (await getSetting(SETTING.SMTP_PASSWORD));
    if (!password) {
      return res.status(400).json({ error: "No password for the mailbox, and none stored for sending to borrow." });
    }

    // Proved against the real server before it is stored, exactly as SMTP is.
    // The folder list that comes back is what the Sent-folder dropdown is
    // built from, so the Owner picks a name the server actually has.
    const verification = await verifyImap({
      host: input.host.trim(),
      port: input.port,
      secure: input.secure ?? input.port === 993,
      user: input.user.trim(),
      password,
      sentFolder: input.sentFolder?.trim() || null,
    });

    await setSetting(SETTING.IMAP_HOST, input.host.trim());
    await setSetting(SETTING.IMAP_PORT, String(input.port));
    await setSetting(SETTING.IMAP_SECURE, String(input.secure ?? input.port === 993));
    await setSetting(SETTING.IMAP_USER, input.user.trim());
    await setSetting(SETTING.IMAP_PASSWORD, password, { secret: true });
    await setSetting(SETTING.IMAP_ENABLED, "true");
    // Stored as the server spells it, not as it was typed. A name that differs
    // by a case or a delimiter opens nothing, and the failure is silent.
    if (verification.sentFolder) await setSetting(SETTING.IMAP_SENT_FOLDER, verification.sentFolder);
    else await deleteSetting(SETTING.IMAP_SENT_FOLDER);
    if (input.backfillDays !== undefined) await setSetting(SETTING.MAIL_BACKFILL_DAYS, String(input.backfillDays));
    if (input.triage !== undefined) await setSetting(SETTING.MAIL_TRIAGE, String(input.triage));
    if (input.autoRoute !== undefined) await setSetting(SETTING.MAIL_AUTOROUTE, String(input.autoRoute));
    if (input.ownDomains !== undefined) await setSetting(SETTING.MAIL_OWN_DOMAINS, input.ownDomains.trim());

    // Reconnect now rather than on a timer, so pasting a password visibly does
    // something: the watcher comes up and the first read starts before the
    // person has looked away from the screen.
    await restartWatcher();

    res.json({ ...(await describeAll(req)), verification });
  } catch (err) {
    if (err instanceof ImapError) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

/** Switches reading off without throwing the credentials away. */
settingsRouter.post("/inbox/pause", async (req, res, next) => {
  try {
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    await setSetting(SETTING.IMAP_ENABLED, String(enabled));
    await restartWatcher();
    res.json(await describeAll(req));
  } catch (err) {
    next(err);
  }
});

settingsRouter.delete("/inbox", async (req, res, next) => {
  try {
    if (guardEnv(SETTING.IMAP_HOST, "The inbox settings", res)) return;
    for (const key of [
      SETTING.IMAP_HOST,
      SETTING.IMAP_PORT,
      SETTING.IMAP_SECURE,
      SETTING.IMAP_USER,
      SETTING.IMAP_PASSWORD,
      SETTING.IMAP_SENT_FOLDER,
      SETTING.IMAP_ENABLED,
    ]) {
      await deleteSetting(key);
    }
    // The cursors go too. Reconnecting a different mailbox and resuming from
    // another one's UID would silently skip everything below that number.
    await prisma.mailSyncState.deleteMany({});
    await restartWatcher();
    res.json(await describeAll(req));
  } catch (err) {
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
    const { webhookUrl, botToken, defaultChannel, signingSecret, approvers } = z
      .object({
        webhookUrl: z.string().optional(),
        botToken: z.string().optional(),
        defaultChannel: z.string().max(80).optional(),
        /** Slack app → Basic Information → Signing Secret. Lets Slack talk back. */
        signingSecret: z.string().max(200).optional(),
        /** Slack user ids allowed to decide a hire. Empty means anyone in the channel. */
        approvers: z.array(z.string().max(32)).max(20).optional(),
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

    // Not verified against Slack, because there is nothing to verify it
    // against — a signing secret is only ever proved by a request arriving and
    // matching. What *is* checked is the shape, since the commonest mistake is
    // pasting the app's Verification Token or Client Secret instead.
    if (signingSecret !== undefined) {
      if (guardEnv(SETTING.SLACK_SIGNING_SECRET, "The Slack signing secret", res)) return;
      const value = signingSecret.trim();
      if (value) {
        if (!/^[0-9a-f]{16,}$/i.test(value)) {
          return res.status(400).json({
            error: "That doesn't look like a Slack signing secret — they're a long string of hex. Find it under your Slack app → Basic Information → App Credentials → Signing Secret.",
          });
        }
        await setSetting(SETTING.SLACK_SIGNING_SECRET, value, { secret: true });
      } else {
        await deleteSetting(SETTING.SLACK_SIGNING_SECRET);
      }
    }

    if (approvers !== undefined) {
      const ids = approvers.map((id) => id.trim().toUpperCase()).filter(Boolean);
      if (ids.length > 0) await setSetting(SETTING.SLACK_APPROVERS, ids.join(","));
      else await deleteSetting(SETTING.SLACK_APPROVERS);
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
      deleteSetting(SETTING.SLACK_SIGNING_SECRET),
      deleteSetting(SETTING.SLACK_APPROVERS),
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
    const bytes = Buffer.from(match[2], "base64");
    if (bytes.length > MAX_LOGO_BYTES) {
      return res.status(400).json({ error: "That file is over 1 MB. Export a smaller cut — this rides along on every email." });
    }
    // The type above is whatever the caller typed into the front of the data
    // URL, not a fact about the bytes. This checks the bytes, which matters
    // most for SVG: it is markup, it can carry a script, and this artwork is
    // rendered into the OS UI, into email and onto every generated document.
    assertImageBytes(bytes, match[1]);

    await saveBrandImage(slot, dataUrl.trim());
    res.json(await describeAll(req));
  } catch (err) {
    if (err instanceof FileTypeError) return res.status(err.status).json({ error: err.message });
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

// --- Paystack and Hubtel ---------------------------------------------------
//
// Stripe does not acquire in Ghana, and every invoice this system produces is
// in GHS. Two rails rather than one because a business here commonly has one
// and not the other, and because they answer different questions: a hosted page
// for somebody comfortable paying on the web, a prompt on the handset for
// somebody who is not.

settingsRouter.put("/paystack", async (req, res, next) => {
  try {
    if (guardEnv(SETTING.PAYSTACK_SECRET_KEY, "The Paystack secret key", res)) return;
    const { secretKey } = z.object({ secretKey: z.string().min(10, "That doesn't look like a Paystack secret key") }).parse(req.body);

    try {
      await verifyPaystackKey(secretKey.trim());
    } catch (err) {
      return res.status(400).json({ error: `Paystack rejected that key: ${(err as Error).message}` });
    }

    await setSetting(SETTING.PAYSTACK_SECRET_KEY, secretKey.trim(), { secret: true });
    res.json(await describeAll(req));
  } catch (err) {
    next(err);
  }
});

settingsRouter.delete("/paystack", async (req, res, next) => {
  try {
    if (guardEnv(SETTING.PAYSTACK_SECRET_KEY, "The Paystack secret key", res)) return;
    await deleteSetting(SETTING.PAYSTACK_SECRET_KEY);
    res.json(await describeAll(req));
  } catch (err) {
    next(err);
  }
});

/**
 * Hubtel's payment credentials.
 *
 * Verified before they are stored, the same as every other key here. A 404 from
 * the status endpoint counts as success: it means the credentials were accepted
 * and the reference simply does not exist, which is exactly what a connection
 * check wants to see.
 */
settingsRouter.put("/hubtel", async (req, res, next) => {
  try {
    if (guardEnv(SETTING.HUBTEL_CLIENT_ID, "The Hubtel credentials", res)) return;
    const { clientId, clientSecret, merchantId } = z
      .object({
        clientId: z.string().min(4),
        clientSecret: z.string().min(4),
        merchantId: z.string().min(4, "That is the Merchant Account number from the Hubtel dashboard"),
      })
      .parse(req.body);

    try {
      await verifyHubtelKeys(clientId.trim(), clientSecret.trim(), merchantId.trim());
    } catch (err) {
      return res.status(400).json({ error: `Hubtel rejected those: ${(err as Error).message}` });
    }

    await Promise.all([
      setSetting(SETTING.HUBTEL_CLIENT_ID, clientId.trim(), { secret: true }),
      setSetting(SETTING.HUBTEL_CLIENT_SECRET, clientSecret.trim(), { secret: true }),
      setSetting(SETTING.HUBTEL_MERCHANT_ID, merchantId.trim()),
    ]);
    res.json(await describeAll(req));
  } catch (err) {
    next(err);
  }
});

settingsRouter.delete("/hubtel", async (req, res, next) => {
  try {
    if (guardEnv(SETTING.HUBTEL_CLIENT_ID, "The Hubtel credentials", res)) return;
    await Promise.all([
      deleteSetting(SETTING.HUBTEL_CLIENT_ID),
      deleteSetting(SETTING.HUBTEL_CLIENT_SECRET),
      deleteSetting(SETTING.HUBTEL_MERCHANT_ID),
    ]);
    res.json(await describeAll(req));
  } catch (err) {
    next(err);
  }
});

/**
 * Hubtel SMS, which is a different credential pair from Hubtel payments.
 *
 * Not verified on save: Hubtel has no free probe for the SMS API, and the only
 * way to check is to send a message, which is not something a Settings screen
 * should do to somebody's phone without being asked.
 */
settingsRouter.put("/hubtel-sms", async (req, res, next) => {
  try {
    if (guardEnv(SETTING.HUBTEL_SMS_ID, "The Hubtel SMS credentials", res)) return;
    const { smsId, smsSecret, sender } = z
      .object({ smsId: z.string().min(4), smsSecret: z.string().min(4), sender: z.string().max(11).optional() })
      .parse(req.body);

    await Promise.all([
      setSetting(SETTING.HUBTEL_SMS_ID, smsId.trim(), { secret: true }),
      setSetting(SETTING.HUBTEL_SMS_SECRET, smsSecret.trim(), { secret: true }),
      setSetting(SETTING.HUBTEL_SMS_SENDER, sender?.trim() ?? ""),
    ]);
    res.json(await describeAll(req));
  } catch (err) {
    next(err);
  }
});

settingsRouter.delete("/hubtel-sms", async (req, res, next) => {
  try {
    if (guardEnv(SETTING.HUBTEL_SMS_ID, "The Hubtel SMS credentials", res)) return;
    await Promise.all([
      deleteSetting(SETTING.HUBTEL_SMS_ID),
      deleteSetting(SETTING.HUBTEL_SMS_SECRET),
      deleteSetting(SETTING.HUBTEL_SMS_SENDER),
    ]);
    res.json(await describeAll(req));
  } catch (err) {
    next(err);
  }
});

/**
 * Which repositories agents may write to.
 *
 * Separate from the GitHub token on purpose. The token decides what the app can
 * see; this decides what an *agent* may change, and the two are different
 * decisions — reading a codebase is research, writing to one changes the
 * software running the company. Empty means none, which is where it starts.
 */
settingsRouter.put("/github-repos", async (req, res, next) => {
  try {
    if (guardEnv(SETTING.GITHUB_ALLOWED_REPOS, "The writable repositories", res)) return;
    const { repos } = z.object({ repos: z.string().max(2000) }).parse(req.body);
    await setSetting(SETTING.GITHUB_ALLOWED_REPOS, repos.trim());
    res.json(await describeAll(req));
  } catch (err) {
    next(err);
  }
});


// ---------------------------------------------------------------------------
// Messaging — WhatsApp and SMS
// ---------------------------------------------------------------------------
//
// The panel for reaching a lead who has a phone number and no email, which is
// most of a scraped list. Two integrations behind one heading because from the
// Owner's point of view they are one job, and because the app chooses between
// them per lead — see services/messageSender.ts.
//
// **Both callback URLs are reported whether or not anything is connected.**
// Pasting the URL into the provider's dashboard is the step most likely to be
// missed, and missing it does not look like a missing setting: WhatsApp simply
// never delivers a reply, so a prospect who answered appears not to have.

/**
 * What is connected, and the two addresses that have to be pasted elsewhere.
 *
 * The verify token and the SMS callback token are **shown in full, once
 * generated**, because they are not credentials that grant anything — they are
 * shared strings that have to be typed into somebody else's dashboard, and a
 * masked one cannot be. The Meta app secret and the access token are masked
 * like every other credential here.
 */
async function describeMessaging(req: Request, appUrl: string | null) {
  const [token, phoneId, businessId, verifyToken, appSecret, smsToken, countryCode] = await Promise.all([
    getSetting(SETTING.WHATSAPP_TOKEN),
    getSetting(SETTING.WHATSAPP_PHONE_NUMBER_ID),
    getSetting(SETTING.WHATSAPP_BUSINESS_ID),
    getSetting(SETTING.WHATSAPP_VERIFY_TOKEN),
    getSetting(SETTING.WHATSAPP_APP_SECRET),
    getSetting(SETTING.SMS_INBOUND_TOKEN),
    getSetting(SETTING.PHONE_COUNTRY_CODE),
  ]);

  const base = origin(req, appUrl);

  // Meta's own read on how recipients are reacting to us. Fetched live because
  // it changes without anybody doing anything: a number whose quality reaches
  // RED has its sending limit cut and then loses the ability to start
  // conversations at all, and there is nowhere else in this app to see it.
  let number: Awaited<ReturnType<typeof describeNumber>> | null = null;
  let numberError: string | null = null;
  if (token && phoneId) {
    try {
      number = await describeNumber();
    } catch (err) {
      numberError = (err as Error).message;
    }
  }

  const approvedTemplates = await prisma.whatsAppTemplate.count({ where: { status: "APPROVED" } });

  return {
    whatsapp: {
      configured: Boolean(token && phoneId),
      envManaged: isEnvManaged(SETTING.WHATSAPP_TOKEN),
      token: token ? maskSecret(token) : null,
      phoneNumberId: phoneId,
      businessId,
      appSecret: appSecret ? maskSecret(appSecret) : null,
      /** Shown in full: it has to be typed into Meta's dashboard to mean anything. */
      verifyToken: verifyToken || null,
      /** What goes in the Callback URL field of the WhatsApp product's Configuration tab. */
      callbackUrl: `${base}/api/messaging/whatsapp`,
      /** Without the app secret, inbound replies are stored and never acted on. */
      inboundTrusted: Boolean(appSecret),
      number,
      numberError,
      approvedTemplates,
    },
    sms: {
      /** The credentials themselves live under Payments — Hubtel issues one pair for both. */
      inboundToken: smsToken || null,
      inboundUrl: smsToken ? `${base}/api/messaging/sms/inbound?token=${encodeURIComponent(smsToken)}` : null,
      statusUrl: smsToken ? `${base}/api/messaging/sms/status?token=${encodeURIComponent(smsToken)}` : null,
      inboundTrusted: Boolean(smsToken),
    },
    countryCode: countryCode || "233",
  };
}

/**
 * Connects WhatsApp.
 *
 * **Verified against Meta before anything is stored.** The commonest mistake
 * here is pasting the App Secret into the token field, which produces a 190
 * that reads as an expired token — and the second commonest is a *temporary*
 * token, which works perfectly for 24 hours and then stops. Neither is visible
 * from a Settings screen that only writes what it is given, and both surface
 * as "WhatsApp stopped working" days later.
 */
settingsRouter.put("/whatsapp", async (req, res, next) => {
  try {
    if (guardEnv(SETTING.WHATSAPP_TOKEN, "The WhatsApp credentials", res)) return;
    const input = z
      .object({
        token: z.string().min(20),
        phoneNumberId: z.string().min(5).max(40),
        businessId: z.string().max(40).optional(),
        appSecret: z.string().max(120).optional(),
      })
      .parse(req.body);

    const number = await verifyWhatsAppKeys(input.token.trim(), input.phoneNumberId.trim());

    // Minted here rather than asked for. It is a string we choose and echo back
    // during Meta's handshake, so making somebody invent one is a field they
    // will fill with "test".
    const existingVerify = await getSetting(SETTING.WHATSAPP_VERIFY_TOKEN);

    await Promise.all([
      setSetting(SETTING.WHATSAPP_TOKEN, input.token.trim(), { secret: true }),
      setSetting(SETTING.WHATSAPP_PHONE_NUMBER_ID, input.phoneNumberId.trim()),
      setSetting(SETTING.WHATSAPP_BUSINESS_ID, input.businessId?.trim() ?? ""),
      input.appSecret?.trim()
        ? setSetting(SETTING.WHATSAPP_APP_SECRET, input.appSecret.trim(), { secret: true })
        : Promise.resolve(),
      existingVerify ? Promise.resolve() : setSetting(SETTING.WHATSAPP_VERIFY_TOKEN, randomBytes(18).toString("hex")),
    ]);

    res.json({ number, ...(await describeAll(req)) });
  } catch (err) {
    next(err);
  }
});

settingsRouter.delete("/whatsapp", async (req, res, next) => {
  try {
    if (guardEnv(SETTING.WHATSAPP_TOKEN, "The WhatsApp credentials", res)) return;
    await Promise.all([
      deleteSetting(SETTING.WHATSAPP_TOKEN),
      deleteSetting(SETTING.WHATSAPP_PHONE_NUMBER_ID),
      deleteSetting(SETTING.WHATSAPP_BUSINESS_ID),
      deleteSetting(SETTING.WHATSAPP_APP_SECRET),
      deleteSetting(SETTING.WHATSAPP_VERIFY_TOKEN),
    ]);
    res.json(await describeAll(req));
  } catch (err) {
    next(err);
  }
});

/**
 * Mints the secret that goes in Hubtel's SMS callback URL.
 *
 * Hubtel signs nothing, so this string is the only thing separating a real
 * delivery report from anybody who guessed the address — and a forged inbound
 * could opt a live prospect out of everything. Regenerating it invalidates the
 * URL already in Hubtel's dashboard, which is said plainly in the response
 * rather than discovered when replies quietly stop being acted on.
 */
settingsRouter.post("/sms-callback-token", async (req, res, next) => {
  try {
    if (guardEnv(SETTING.SMS_INBOUND_TOKEN, "The SMS callback token", res)) return;
    await setSetting(SETTING.SMS_INBOUND_TOKEN, randomBytes(18).toString("hex"));
    res.json({
      note: "Paste the two URLs below into Hubtel's dashboard. Any URL you had there before this will no longer be accepted.",
      ...(await describeAll(req)),
    });
  } catch (err) {
    next(err);
  }
});

/** The country a bare local number is read as. See lib/phone.ts for why it matters. */
settingsRouter.put("/messaging/country", async (req, res, next) => {
  try {
    const { countryCode } = z.object({ countryCode: z.string().regex(/^\d{1,4}$/) }).parse(req.body);
    await setSetting(SETTING.PHONE_COUNTRY_CODE, countryCode);
    res.json(await describeAll(req));
  } catch (err) {
    next(err);
  }
});
