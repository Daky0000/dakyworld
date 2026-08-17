import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireRole } from "../middleware/auth.js";
import { SETTING, deleteSetting, getSetting, isEnvManaged, setSetting } from "../lib/settings.js";
import { maskSecret } from "../lib/secrets.js";
import { ApifyError, clearApifyCaches, getAccount, getMonthlyUsage } from "../lib/apify.js";
import { CAPTURE_DEFAULTS, captureEnvManaged, readCaptureConfig, writeCaptureConfig } from "../services/captureConfig.js";
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
import { signature, toHtml, toText } from "../services/emailRender.js";

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
    general: {
      appUrl,
      appUrlEnvManaged: isEnvManaged(SETTING.APP_URL),
      resolvedAppUrl: origin(req, appUrl),
      timezone: timezone ?? "Africa/Accra",
    },
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
    const sign = await signature();
    const body = `This is a test from Dakyworld OS.\n\nIf you are reading it, the mailbox is connected and the app can send on your behalf — proposals, invoices, deliverables and sequences will all go out through this address.`;
    await sendMail({
      to,
      subject: "Dakyworld OS — mail is working",
      html: toHtml(body, sign, null),
      text: toText(body, sign, null),
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
