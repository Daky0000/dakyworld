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
   * default (`i-scraper/website-screenshot`). A setting rather than a constant
   * because every screenshot actor does the same job at a different price, and
   * switching to a cheaper one should be a dropdown rather than a deploy —
   * see services/screenshotActors.ts.
   */
  SCREENSHOT_ACTOR: "capture.screenshotActor",

  /**
   * Which Apify actor opens the page in a real browser for the speed and SEO
   * review. Blank uses the shipped default
   * (`smart-digital/complete-seo-audit-tool`). Same reasoning as the
   * screenshot actor, and the same trap: it is billed per page analysed, so a
   * replacement has to be re-priced rather than assumed — see
   * services/seoAudit.ts.
   */
  SEO_AUDIT_ACTOR: "capture.seoAuditActor",

  /** Powers the spreadsheet analyst — see lib/anthropic.ts. */
  ANTHROPIC_KEY: "anthropic.apiKey",
  /** Which model every Claude call uses unless it names another. */
  ANTHROPIC_MODEL: "anthropic.model",
  /**
   * The model an agent runs on when its work does not need the expensive one.
   *
   * An agent loop is the costliest thing this app does — a dozen turns, each
   * re-sending the ones before it — and most of those turns are a sub-agent
   * reading a record, filling a field or checking a link. Paying Opus rates
   * for that was never a decision anybody made; it was `defaultModel()` being
   * the only answer the loop knew.
   *
   * The split follows `effortFor()` in the agent runner: whoever writes to
   * somebody outside the company, and whoever sits on the board, stays on the
   * headline model. Everybody else runs here. Set this to the same value as
   * `ANTHROPIC_MODEL` to put the whole workforce back on one model.
   */
  ANTHROPIC_MODEL_ECONOMY: "anthropic.model.economy",
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

  // The two Ghanaian rails. Stripe does not acquire in Ghana, so an invoice in
  // GHS — which every invoice, proposal and care plan in this system is — had
  // no way to be paid at all until these.
  //
  // Paystack is the hosted page: one link that takes a card, mobile money or a
  // bank transfer, which is what goes in an email. Hubtel is the prompt that
  // arrives on somebody's phone, which is what a client who has never paid for
  // anything on the web will actually complete. They are kept as separate
  // integrations rather than one "payments" setting because a business will
  // commonly have one and not the other.
  /** Secret key, `sk_live_…` or `sk_test_…`. Paystack signs webhooks with this same key. */
  PAYSTACK_SECRET_KEY: "paystack.secretKey",
  /** Hubtel Merchant Account number — the one the money lands in. */
  HUBTEL_MERCHANT_ID: "hubtel.merchantId",
  /** Basic-auth pair from the Hubtel dashboard, used for checkout and receive-money. */
  HUBTEL_CLIENT_ID: "hubtel.clientId",
  HUBTEL_CLIENT_SECRET: "hubtel.clientSecret",
  /**
   * SMS is a *different* Hubtel credential pair from payments, and using one
   * for the other returns a 401 that says nothing about which. Kept apart so
   * the Settings screen can ask for them separately and say why.
   */
  HUBTEL_SMS_ID: "hubtel.smsId",
  HUBTEL_SMS_SECRET: "hubtel.smsSecret",
  /** What a text appears to come from. Alphanumeric sender ids must be registered with Hubtel first. */
  HUBTEL_SMS_SENDER: "hubtel.smsSender",

  // WhatsApp, through Meta's Cloud API. The other half of reaching a lead who
  // has a number and no email — see lib/whatsapp.ts for why this is not simply
  // "email with a phone number" and why the wa.me path exists beside it.
  //
  // Five values rather than one because they come from three different places
  // in Meta's dashboard and mean three different things. Pasting the App
  // Secret into the token field is the commonest mistake and produces a 190
  // that reads as an expired token.
  /** A permanent System User access token. A temporary one expires in 24 hours. */
  WHATSAPP_TOKEN: "whatsapp.token",
  /** The sending number's id — *not* the number itself, which Meta will not accept here. */
  WHATSAPP_PHONE_NUMBER_ID: "whatsapp.phoneNumberId",
  /** The WhatsApp Business Account id. Only templates need it; sending does not. */
  WHATSAPP_BUSINESS_ID: "whatsapp.businessId",
  /**
   * A string we invent, echoed back during Meta's one-time GET handshake when
   * the webhook URL is saved. It proves the URL belongs to whoever configured
   * it and is never used again afterwards.
   */
  WHATSAPP_VERIFY_TOKEN: "whatsapp.verifyToken",
  /**
   * The Meta **app** secret, which is what every webhook delivery is signed
   * with. Without it inbound messages are stored and not acted on: an
   * unverified inbound could open a 24-hour free-form window or opt somebody
   * out, and neither should be reachable by guessing a URL.
   */
  WHATSAPP_APP_SECRET: "whatsapp.appSecret",

  /**
   * A secret in the SMS callback URL, because Hubtel signs nothing.
   *
   * WhatsApp has an app secret and a real HMAC; Hubtel's SMS callbacks arrive
   * with no signature of any kind, so the only thing that can distinguish a
   * real delivery report from anybody who guessed the URL is a token in the
   * query string. Blank means the SMS callbacks are refused entirely, which is
   * the right default — a forged inbound could opt a live prospect out.
   */
  SMS_INBOUND_TOKEN: "messaging.smsInboundToken",

  /**
   * The country a bare local number is read as — `233` for Ghana.
   *
   * The assumption is the whole risk: `0241234567` read as Ghanaian is right,
   * read as British sends the message to a different continent. See lib/phone.ts.
   */
  PHONE_COUNTRY_CODE: "messaging.countryCode",

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

  // Inbound email — the mail room. See services/mailbox/.
  //
  // IMAP rather than a provider API, because IMAP is the one thing every
  // mailbox this company might ever use already speaks: Hostinger, Google
  // Workspace, Zoho, a cPanel address. The host and port are usually the SMTP
  // ones with `smtp` swapped for `imap`, and the password is very often the
  // same app password already pasted in above — which is why the Settings
  // screen offers to fill all five in from the SMTP block rather than asking
  // for them twice.
  /** Master switch. Off means nothing connects and nothing is read. */
  IMAP_ENABLED: "imap.enabled",
  IMAP_HOST: "imap.host",
  IMAP_PORT: "imap.port",
  /** Implicit TLS on 993. Off means STARTTLS on 143, which is rarer and worse. */
  IMAP_SECURE: "imap.secure",
  IMAP_USER: "imap.user",
  IMAP_PASSWORD: "imap.password",
  /**
   * What this provider calls the Sent folder — `Sent`, `INBOX.Sent`,
   * `[Gmail]/Sent Mail`. Blank means look for it, which works on every server
   * that advertises the `\Sent` special-use flag and on most that do not.
   */
  IMAP_SENT_FOLDER: "imap.sentFolder",
  /**
   * How many days of mail the very first pass reads. Blank means 14.
   *
   * A brand-new connection to a mailbox with nine years in it would otherwise
   * classify nine years of post, at one model call each, before it read
   * anything that arrived today.
   */
  MAIL_BACKFILL_DAYS: "mail.backfillDays",
  /**
   * Whether a model reads inbound mail at all. Off still files everything,
   * still stops sequences and still suppresses bounces — those are code, not
   * judgement — it simply routes nothing.
   */
  MAIL_TRIAGE: "mail.triage",
  /**
   * Whether triage may hand work to agents, or only label it for a person.
   *
   * Separate from the switch above because they are different decisions: "read
   * my post" is one, "and give it to somebody" is another, and a new
   * deployment should be able to have the first without the second.
   */
  MAIL_AUTOROUTE: "mail.autoRoute",
  /**
   * The domains and addresses that are *us*, comma-separated. Blank derives
   * them from the sending address.
   *
   * This is the loop guard. Without it a message from the company's own
   * accounts address is a stranger writing in, and the mail room would file
   * its own notifications as new enquiries and give them to an agent.
   */
  MAIL_OWN_DOMAINS: "mail.ownDomains",

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
  /**
   * Slack's signing secret — the only thing that makes an *inbound* Slack
   * request trustworthy.
   *
   * The two settings above are outbound: they prove we are allowed to post.
   * This one proves a request that says it is Slack actually is, which is what
   * an Approve button on a hiring card depends on. Without it the interactivity
   * endpoint refuses everything rather than trusting a payload's word for who
   * sent it — see lib/slack.ts and routes/slackActions.ts.
   */
  SLACK_SIGNING_SECRET: "slack.signingSecret",
  /**
   * Slack user ids allowed to decide a hire, comma-separated (`U012ABCDEF`).
   *
   * Blank means anybody who can see the message can click the button, which is
   * the right default for a one-person company and the wrong one the day a
   * channel gets a second member. The Slack payload carries the clicking user's
   * id, verified by the signature, so this is a real check rather than a
   * cosmetic one.
   */
  SLACK_APPROVERS: "slack.approverIds",

  // GitHub, read-mostly, for the technical agents. See lib/github.ts.
  GITHUB_TOKEN: "github.token",
  /** Lets a repository be named `os` rather than `dakyworld/os`. */
  GITHUB_OWNER: "github.owner",
  /**
   * Repositories agents may *write* to — branch, commit, open a pull request.
   *
   * Empty by default and deny-by-default, which is the point: reading a
   * codebase is a research capability and writing to one changes the software
   * running the company. Naming this repository here is a deliberate act.
   * `*` opens everything the token can see.
   */
  GITHUB_ALLOWED_REPOS: "github.allowedRepos",

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
   * The date the one-job pass ran, or blank if it has not.
   *
   * `ensureAgents()` only ever creates, so splitting an agent that was doing
   * three jobs would otherwise change nothing on a database that already has
   * the old wording in it. This marker makes that a one-off migration rather
   * than a policy of overwriting the Owner's agents on every deploy — see
   * narrowSeededAgents() in services/agentRegistry.ts.
   */
  AGENT_ONE_JOB_PASS: "agents.oneJobPass",
  /**
   * The date the Cold Email Playbook v3 wording was pushed to the two outreach
   * agents, or blank if it has not been. Same mechanism and same reason as the
   * one-job pass above: `ensureAgents()` only ever creates, so re-wording a
   * seed changes nothing on a database that already holds the old text.
   */
  AGENT_COLD_EMAIL_V3: "agents.coldEmailPlaybookV3",
  /**
   * Hard ceiling on what one tool call may spend, in USD. The tool layer
   * refuses anything above it rather than trusting an agent's arithmetic.
   */
  AGENT_MAX_CALL_USD: "agents.maxCallUsd",

  /**
   * What happens when the Agent Creator proposes a new agent: `ASK` or `AUTO`.
   *
   * ASK posts the design to Slack with Approve and Decline on it and waits.
   * AUTO creates it there and then, and posts the same card with an Undo on it
   * instead. Defaults to ASK, and it is meant to be flipped from Slack —
   * `/dakyworld hiring auto` — because the moment somebody wants to change it
   * is the moment they are reading a hiring card, not the moment they are
   * looking at a Settings screen.
   *
   * **Sits under dry run, not beside it.** An agent in dry run decides nothing
   * at all, so the policy only comes into play once the Owner has taken the
   * Agent Creator out of dry run. AUTO then decides *who exists*; it never
   * decides what they may do, because every hire lands at autonomy 1 with dry
   * run on whichever way it was approved.
   */
  AGENT_HIRE_POLICY: "agents.hirePolicy",
  /**
   * The most custom agents the roster may hold. Beyond it the Agent Creator is
   * refused and told to escalate — a workforce that can grow without limit
   * grows to the size of every task that ever confused somebody.
   */
  AGENT_MAX_CUSTOM: "agents.maxCustomAgents",
  /**
   * The most agents that may be hired in one rolling day. A runaway loop —
   * agent asks for a craft, gets one, that one asks for another — is cheap to
   * start and expensive to unpick, and this is what stops it at three rather
   * than at thirty.
   */
  AGENT_MAX_HIRES_PER_DAY: "agents.maxHiresPerDay",
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
  [SETTING.ANTHROPIC_MODEL_ECONOMY]: "ANTHROPIC_MODEL_ECONOMY",
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
  [SETTING.PAYSTACK_SECRET_KEY]: "PAYSTACK_SECRET_KEY",
  [SETTING.HUBTEL_MERCHANT_ID]: "HUBTEL_MERCHANT_ID",
  [SETTING.HUBTEL_CLIENT_ID]: "HUBTEL_CLIENT_ID",
  [SETTING.HUBTEL_CLIENT_SECRET]: "HUBTEL_CLIENT_SECRET",
  [SETTING.HUBTEL_SMS_ID]: "HUBTEL_SMS_ID",
  [SETTING.HUBTEL_SMS_SECRET]: "HUBTEL_SMS_SECRET",
  [SETTING.HUBTEL_SMS_SENDER]: "HUBTEL_SMS_SENDER",
  [SETTING.WHATSAPP_TOKEN]: "WHATSAPP_TOKEN",
  [SETTING.WHATSAPP_PHONE_NUMBER_ID]: "WHATSAPP_PHONE_NUMBER_ID",
  [SETTING.WHATSAPP_BUSINESS_ID]: "WHATSAPP_BUSINESS_ID",
  [SETTING.WHATSAPP_VERIFY_TOKEN]: "WHATSAPP_VERIFY_TOKEN",
  [SETTING.WHATSAPP_APP_SECRET]: "WHATSAPP_APP_SECRET",
  [SETTING.SMS_INBOUND_TOKEN]: "SMS_INBOUND_TOKEN",
  [SETTING.PHONE_COUNTRY_CODE]: "PHONE_COUNTRY_CODE",
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
  // Inbound. Pinnable from the deploy for the same reason as SMTP: a mailbox
  // password baked into Railway should not be silently replaceable through a
  // screen.
  [SETTING.IMAP_ENABLED]: "IMAP_ENABLED",
  [SETTING.IMAP_HOST]: "IMAP_HOST",
  [SETTING.IMAP_PORT]: "IMAP_PORT",
  [SETTING.IMAP_SECURE]: "IMAP_SECURE",
  [SETTING.IMAP_USER]: "IMAP_USER",
  [SETTING.IMAP_PASSWORD]: "IMAP_PASSWORD",
  [SETTING.IMAP_SENT_FOLDER]: "IMAP_SENT_FOLDER",
  [SETTING.MAIL_OWN_DOMAINS]: "MAIL_OWN_DOMAINS",
  // Alerting and the developer tools follow the same rule as the rest: the
  // deploy can pin them, the Settings screen can set them, env wins.
  [SETTING.SLACK_WEBHOOK_URL]: "SLACK_WEBHOOK_URL",
  [SETTING.SLACK_BOT_TOKEN]: "SLACK_BOT_TOKEN",
  [SETTING.SLACK_DEFAULT_CHANNEL]: "SLACK_DEFAULT_CHANNEL",
  // Pinnable for the same reason as the webhook secret below: it is what
  // authenticates every inbound Slack request, and rotating it in the UI
  // should not be the same action as breaking every button already posted.
  [SETTING.SLACK_SIGNING_SECRET]: "SLACK_SIGNING_SECRET",
  [SETTING.GITHUB_TOKEN]: "GITHUB_TOKEN",
  [SETTING.GITHUB_OWNER]: "GITHUB_OWNER",
  [SETTING.GITHUB_ALLOWED_REPOS]: "GITHUB_ALLOWED_REPOS",
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
