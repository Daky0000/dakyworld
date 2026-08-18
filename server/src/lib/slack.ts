import { SETTING, getSetting } from "./settings.js";

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
