import crypto from "node:crypto";
import { SETTING, getSetting, setSetting } from "./settings.js";

/**
 * Slack, for internal alerting and escalation.
 *
 * Two ways in, because they cost very different amounts of setup and the
 * cheap one is enough for what the agents actually need:
 *
 * - **An incoming webhook URL.** Paste one URL, messages land in the one
 *   channel it was created for. No app to review, no scopes, no install.
 *   This is the default and covers "tell me when a run fails".
 * - **A bot token** (`xoxb-…`). Needed only to choose the channel per message,
 *   which matters once escalations should go somewhere different from run
 *   reports. Requires creating a Slack app with `chat:write` and inviting it
 *   to each channel.
 *
 * Whichever is configured is what `sendSlack` uses; the token wins when both
 * are present, since it is strictly more capable.
 *
 * Everything here fails soft on purpose. An alert that cannot be delivered
 * must never take down the thing it was reporting on — a failed scrape that
 * also crashes the notifier is two problems instead of one.
 */

const WEBHOOK_HOST = "hooks.slack.com";
const API_BASE = "https://slack.com/api";
const TIMEOUT_MS = 10_000;

export class SlackError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "SlackError";
    this.status = status;
  }
}

export type SlackTransport = "TOKEN" | "WEBHOOK" | "NONE";

export async function slackTransport(): Promise<SlackTransport> {
  const [token, webhook] = await Promise.all([getSetting(SETTING.SLACK_BOT_TOKEN), getSetting(SETTING.SLACK_WEBHOOK_URL)]);
  if (token) return "TOKEN";
  if (webhook) return "WEBHOOK";
  return "NONE";
}

export async function slackConfigured(): Promise<boolean> {
  return (await slackTransport()) !== "NONE";
}

/** The channel a message goes to when the caller doesn't name one. */
export async function defaultChannel(): Promise<string | null> {
  return getSetting(SETTING.SLACK_DEFAULT_CHANNEL);
}

export interface SlackMessage {
  text: string;
  /** `#alerts` or a channel id. Token transport only — a webhook has its channel baked in. */
  channel?: string | null;
  /** A short heading rendered above the text. */
  title?: string | null;
  /** A link the message should carry, e.g. straight to the run that failed. */
  link?: { text: string; url: string } | null;
}

function blocks(message: SlackMessage) {
  const parts: unknown[] = [];
  if (message.title) {
    parts.push({ type: "header", text: { type: "plain_text", text: message.title.slice(0, 150), emoji: true } });
  }
  parts.push({ type: "section", text: { type: "mrkdwn", text: message.text.slice(0, 3000) } });
  if (message.link) {
    parts.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `<${message.link.url}|${message.link.text}>` }],
    });
  }
  return parts;
}

async function post(url: string, body: unknown, token?: string | null): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

export interface SlackResult {
  delivered: boolean;
  transport: SlackTransport;
  channel: string | null;
  /** Slack's own message id, when the API path was used. */
  ts?: string | null;
}

/**
 * Sends one message. Throws only when Slack is configured and refuses —
 * an unconfigured Slack returns `delivered: false` rather than an error, so
 * a caller can say "Slack isn't connected" without a try/catch.
 */
export async function sendSlack(message: SlackMessage): Promise<SlackResult> {
  const [token, webhook, fallbackChannel] = await Promise.all([
    getSetting(SETTING.SLACK_BOT_TOKEN),
    getSetting(SETTING.SLACK_WEBHOOK_URL),
    defaultChannel(),
  ]);

  if (token) {
    const channel = message.channel?.trim() || fallbackChannel;
    if (!channel) {
      throw new SlackError(400, "No Slack channel to send to. Set a default channel under Settings → Alerts.");
    }
    const response = await post(`${API_BASE}/chat.postMessage`, { channel, text: message.text, blocks: blocks(message) }, token);
    // Slack answers 200 with `ok: false` for real failures, so the status code
    // alone means nothing here.
    const payload = (await response.json().catch(() => null)) as { ok?: boolean; error?: string; ts?: string } | null;
    if (!payload?.ok) throw new SlackError(response.status, slackErrorMessage(payload?.error));
    return { delivered: true, transport: "TOKEN", channel, ts: payload.ts ?? null };
  }

  if (webhook) {
    const response = await post(webhook, { text: message.text, blocks: blocks(message) });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new SlackError(response.status, `Slack rejected the webhook: ${detail || response.statusText}`);
    }
    return { delivered: true, transport: "WEBHOOK", channel: null };
  }

  return { delivered: false, transport: "NONE", channel: null };
}

/** Slack's error codes are terse; these are the ones worth translating. */
function slackErrorMessage(code?: string): string {
  switch (code) {
    case "channel_not_found":
      return "That Slack channel doesn't exist, or the bot hasn't been invited to it.";
    case "not_in_channel":
      return "The bot isn't in that channel. Invite it with /invite @Dakyworld.";
    case "invalid_auth":
    case "token_revoked":
    case "account_inactive":
      return "Slack rejected the bot token. Check it under Settings → Alerts.";
    case "missing_scope":
      return "The Slack app is missing the chat:write scope. Add it and reinstall the app.";
    case "ratelimited":
      return "Slack is rate-limiting us. Try again in a minute.";
    default:
      return code ? `Slack refused the message: ${code}` : "Slack refused the message.";
  }
}

/** Confirms a credential works before it is stored. */
export async function verifySlack(credential: { token?: string; webhookUrl?: string }): Promise<{ transport: SlackTransport; team: string | null }> {
  if (credential.token) {
    const response = await fetch(`${API_BASE}/auth.test`, {
      method: "POST",
      headers: { Authorization: `Bearer ${credential.token}`, "Content-Type": "application/json" },
    });
    const payload = (await response.json().catch(() => null)) as { ok?: boolean; team?: string; error?: string } | null;
    if (!payload?.ok) throw new SlackError(401, slackErrorMessage(payload?.error));
    return { transport: "TOKEN", team: payload.team ?? null };
  }

  if (credential.webhookUrl) {
    // A webhook URL can only be checked by sending to it, which would put a
    // test message in the Owner's channel. Check the shape instead, and let
    // the explicit "send a test message" button do the real thing.
    const url = credential.webhookUrl.trim();
    if (!url.startsWith("https://") || !url.includes(WEBHOOK_HOST)) {
      throw new SlackError(400, `That doesn't look like a Slack webhook URL — they start https://${WEBHOOK_HOST}/services/.`);
    }
    return { transport: "WEBHOOK", team: null };
  }

  throw new SlackError(400, "Give either a bot token or a webhook URL.");
}

// --- Slack talking back -----------------------------------------------------

/**
 * Everything above is outbound: it proves *we* may post. This half is the
 * other direction, and it is a different problem — a request that says it is
 * Slack has to be proved to be Slack before a button on it can approve
 * anything.
 *
 * Slack signs every interactive payload and every slash command with the app's
 * signing secret, over `v0:${timestamp}:${rawBody}`. Three things have to hold
 * and all three are checked here:
 *
 *  - the signature matches, compared in constant time;
 *  - the timestamp is recent, so a payload captured off the wire cannot be
 *    replayed tomorrow to approve a hire;
 *  - the secret exists at all. An unconfigured Slack refuses inbound requests
 *    rather than accepting them, which is the opposite of the outbound rule
 *    above and the right way round for each: failing to *send* an alert must
 *    not break the work, and failing to *verify* a click must never approve.
 */

/** Slack's own header names. */
export const SLACK_SIGNATURE_HEADER = "x-slack-signature";
export const SLACK_TIMESTAMP_HEADER = "x-slack-request-timestamp";
/** Slack's documented replay window. */
const MAX_SKEW_SECONDS = 5 * 60;

export interface SlackVerification {
  verified: boolean;
  /** Why not, in a sentence worth logging. Null when it verified. */
  reason: string | null;
  /** True when no signing secret is configured — a setup problem, not an attack. */
  unconfigured: boolean;
}

export async function verifySlackRequest(headers: Record<string, unknown>, rawBody: string, kind = "request"): Promise<SlackVerification> {
  const verdict = await judge(headers, rawBody);
  // Recorded on the way out rather than at each `return` above, so a verdict
  // added later cannot be the one that forgets to leave a trace.
  await noteInbound(verdict, kind);
  return verdict;
}

async function judge(headers: Record<string, unknown>, rawBody: string): Promise<SlackVerification> {
  const secret = await getSetting(SETTING.SLACK_SIGNING_SECRET);
  if (!secret) {
    return { verified: false, unconfigured: true, reason: "No Slack signing secret is set, so an inbound Slack request cannot be trusted." };
  }

  const signature = String(headers[SLACK_SIGNATURE_HEADER] ?? "");
  const timestamp = String(headers[SLACK_TIMESTAMP_HEADER] ?? "");
  if (!signature || !timestamp) {
    return { verified: false, unconfigured: false, reason: "The request carried no Slack signature." };
  }

  const sent = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(sent) || Math.abs(Date.now() / 1000 - sent) > MAX_SKEW_SECONDS) {
    return { verified: false, unconfigured: false, reason: "That Slack request is too old to act on." };
  }

  // An empty body against a present signature is the mounting mistake, not an
  // attack, and it is worth saying so by name: this router has to sit above
  // the JSON parser because the signature covers the exact bytes Slack sent,
  // and a parsed body is not those bytes. Said here because the symptom —
  // every signature failing — is identical to a wrong secret, and the two have
  // completely different fixes.
  if (!rawBody) {
    return {
      verified: false,
      unconfigured: false,
      reason: "That Slack request arrived with no raw body, so its signature cannot be checked. The Slack router must be mounted above the JSON body parser.",
    };
  }

  const expected = `v0=${crypto.createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
  // Length-checked first: timingSafeEqual throws on a mismatch rather than
  // returning false, and a wrong-length signature is a wrong signature.
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  return ok
    ? { verified: true, unconfigured: false, reason: null }
    : { verified: false, unconfigured: false, reason: "That Slack signature did not match the signing secret this app holds." };
}

/**
 * Leaves a trace of every inbound request, so the inbound half is observable.
 *
 * Best-effort and never thrown from: this is a diagnostic, and a diagnostic
 * that can refuse a verified request is worse than no diagnostic at all.
 */
async function noteInbound(verdict: SlackVerification, kind: string): Promise<void> {
  try {
    const at = new Date().toISOString();
    if (verdict.verified) {
      await setSetting(SETTING.SLACK_INBOUND_OK_AT, at);
      await setSetting(SETTING.SLACK_INBOUND_OK_KIND, kind);
      return;
    }
    await setSetting(SETTING.SLACK_INBOUND_REFUSED_AT, at);
    await setSetting(SETTING.SLACK_INBOUND_REFUSED_REASON, `${kind}: ${verdict.reason ?? "refused"}`.slice(0, 300));
  } catch {
    // Deliberately silent. See above.
  }
}

export interface SlackInbound {
  /** When a request from Slack last verified, and what kind it was. */
  lastOkAt: string | null;
  lastOkKind: string | null;
  /** When one was last refused, and why — the sentence that names the actual fix. */
  lastRefusedAt: string | null;
  lastRefusedReason: string | null;
}

export async function slackInbound(): Promise<SlackInbound> {
  const [lastOkAt, lastOkKind, lastRefusedAt, lastRefusedReason] = await Promise.all([
    getSetting(SETTING.SLACK_INBOUND_OK_AT),
    getSetting(SETTING.SLACK_INBOUND_OK_KIND),
    getSetting(SETTING.SLACK_INBOUND_REFUSED_AT),
    getSetting(SETTING.SLACK_INBOUND_REFUSED_REASON),
  ]);
  return { lastOkAt, lastOkKind, lastRefusedAt, lastRefusedReason };
}

/**
 * Who, if anyone, is allowed to decide things from Slack.
 *
 * Empty means anybody in the channel, which is deliberate rather than
 * forgotten: Dakyworld is one person today, and demanding a user id be pasted
 * before a button works would mean the button never works. The moment a second
 * person is in the channel it is worth filling in — see the setting's note.
 */
export async function slackApprovers(): Promise<string[]> {
  const raw = await getSetting(SETTING.SLACK_APPROVERS);
  return (raw ?? "")
    .split(/[,\s]+/)
    .map((id) => id.trim())
    .filter(Boolean);
}

export async function mayDecideFromSlack(userId: string | null | undefined): Promise<boolean> {
  const allowed = await slackApprovers();
  if (allowed.length === 0) return true;
  return Boolean(userId && allowed.includes(userId));
}

/**
 * Rewrites a message already in the channel — how a settled decision stops
 * showing a live Approve button.
 *
 * Token transport only. A webhook has no way to edit what it posted, so a
 * webhook-only Slack gets the outcome as a reply instead; `updateSlack` says
 * so by returning false rather than throwing, and the caller posts.
 */
export async function updateSlack(channel: string, ts: string, message: SlackMessage | { text: string; blocks: unknown[] }): Promise<boolean> {
  const token = await getSetting(SETTING.SLACK_BOT_TOKEN);
  if (!token) return false;
  const body = "blocks" in message ? { channel, ts, text: message.text, blocks: message.blocks } : { channel, ts, text: message.text, blocks: blocks(message) };
  const response = await post(`${API_BASE}/chat.update`, body, token);
  const payload = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
  if (!payload?.ok) throw new SlackError(response.status, slackErrorMessage(payload?.error));
  return true;
}

/**
 * Posts one message built from Block Kit blocks the caller assembled itself.
 *
 * `sendSlack` builds its own blocks from a title and some text, which is right
 * for an alert and useless for a card with buttons on it. This is the escape
 * hatch, and it keeps the same fail-soft contract: an unconfigured Slack
 * answers `delivered: false` rather than throwing.
 */
export async function sendSlackBlocks(input: { text: string; blocks: unknown[]; channel?: string | null }): Promise<SlackResult> {
  const [token, webhook, fallbackChannel] = await Promise.all([
    getSetting(SETTING.SLACK_BOT_TOKEN),
    getSetting(SETTING.SLACK_WEBHOOK_URL),
    defaultChannel(),
  ]);

  if (token) {
    const channel = input.channel?.trim() || fallbackChannel;
    if (!channel) throw new SlackError(400, "No Slack channel to send to. Set a default channel under Settings → Alerts.");
    const response = await post(`${API_BASE}/chat.postMessage`, { channel, text: input.text, blocks: input.blocks }, token);
    const payload = (await response.json().catch(() => null)) as { ok?: boolean; error?: string; ts?: string } | null;
    if (!payload?.ok) throw new SlackError(response.status, slackErrorMessage(payload?.error));
    return { delivered: true, transport: "TOKEN", channel, ts: payload.ts ?? null };
  }

  if (webhook) {
    const response = await post(webhook, { text: input.text, blocks: input.blocks });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new SlackError(response.status, `Slack rejected the webhook: ${detail || response.statusText}`);
    }
    return { delivered: true, transport: "WEBHOOK", channel: null };
  }

  return { delivered: false, transport: "NONE", channel: null };
}

/**
 * Opens a dialog on top of whatever the clicker was looking at.
 *
 * Token transport only, and that is a real limit rather than an oversight:
 * `views.open` is an API call, and a webhook has no API. So a webhook-only
 * Slack cannot be asked to type anything, which is exactly why every card that
 * wants words also prints the slash command that does the same job — see
 * `escalationCards.ts`.
 *
 * Returns false rather than throwing when there is no token, so a caller can
 * fall back to saying "use the command instead" in one line.
 *
 * `trigger_id` expires three seconds after the click, which is the reason the
 * interaction router opens the dialog *before* it acknowledges rather than
 * after: an acknowledgement first and a dialog second is a dialog that never
 * opens, and it fails silently.
 */
export async function openSlackModal(triggerId: string, view: unknown): Promise<boolean> {
  const token = await getSetting(SETTING.SLACK_BOT_TOKEN);
  if (!token) return false;
  const response = await post(`${API_BASE}/views.open`, { trigger_id: triggerId, view }, token);
  const payload = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
  if (!payload?.ok) throw new SlackError(response.status, slackErrorMessage(payload?.error));
  return true;
}

/**
 * Answers straight back down the `response_url` Slack hands out with every
 * interaction. Works without a bot token, expires after thirty minutes, and is
 * the only way to say anything at all to somebody on a webhook-only setup.
 */
export async function replyToInteraction(responseUrl: string, text: string, replaceOriginal = false): Promise<void> {
  await post(responseUrl, { text, replace_original: replaceOriginal, response_type: "ephemeral" }).catch(() => undefined);
}
