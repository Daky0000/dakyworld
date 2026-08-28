import { SETTING, getSetting } from "../lib/settings.js";
import { defaultChannel, slackApprovers, slackInbound, slackTransport, type SlackInbound, type SlackTransport } from "../lib/slack.js";
import { appUrl } from "./emailSender.js";

/**
 * Whether Slack actually works, said in the words that name the fix.
 *
 * This exists because of one bug report — *"when I decide, nothing happens in
 * Slack"* — and because that sentence is the only symptom five completely
 * different faults produce:
 *
 * 1. Nothing is connected at all.
 * 2. A bot token is set and no default channel is, so every outbound post
 *    throws `No Slack channel to send to` inside a `catch` that logs and
 *    returns false. Cards are built, and none is ever posted.
 * 3. The bot was never invited to the channel, so Slack answers `ok: false`
 *    with `not_in_channel` — a 200 that means no.
 * 4. Outbound works and there is no signing secret, so cards appear and every
 *    button on them is refused with a 503 nobody sees.
 * 5. Everything is configured and Interactivity was never switched on in the
 *    Slack app, so the button posts to nowhere and the app never hears of it.
 *
 * Four of those five are invisible from inside the app. `console.warn` in a
 * Railway log is not an answer for somebody looking at a channel wondering why
 * the button did nothing, so every one of them is now a sentence on a screen.
 *
 * **It reports, it never repairs.** Nothing here writes a setting or sends a
 * message; the test message and the `/dakyworld ping` are separate, deliberate
 * acts, because a health check that posts to the Owner's channel every time
 * somebody opens Settings is a health check that gets turned off.
 */

export interface SlackHealth {
  /** Can this app post? */
  outbound: {
    transport: SlackTransport;
    channel: string | null;
    /** True when a post would at least be attempted. Not proof it lands — see `problems`. */
    ready: boolean;
  };
  /** Can Slack post back? */
  inbound: {
    signingSecret: boolean;
    approvers: string[];
    /** Everybody in the channel may decide, because no approver was named. */
    openToAnyone: boolean;
    /** Proof, or the lack of it: has a request from Slack ever verified here. */
    everVerified: boolean;
  } & SlackInbound;
  /** The two URLs that have to be pasted into the Slack app, spelled out. */
  requestUrls: { actions: string; commands: string };
  /** What is wrong, worst first, each one naming what to do about it. */
  problems: string[];
  /** Both directions work as far as configuration can prove. */
  ready: boolean;
}

export async function slackHealth(): Promise<SlackHealth> {
  const [transport, channel, secret, approvers, inbound, base] = await Promise.all([
    slackTransport(),
    defaultChannel(),
    getSetting(SETTING.SLACK_SIGNING_SECRET),
    slackApprovers(),
    slackInbound(),
    appUrl(),
  ]);

  const problems: string[] = [];

  // --- Outbound ------------------------------------------------------------
  if (transport === "NONE") {
    problems.push(
      "Slack is not connected. Paste an incoming webhook URL — one URL, one channel, no app to create — or a bot token if cards should be able to choose their channel.",
    );
  }

  // The quiet one. A token with no channel builds every card and posts none of
  // them, and the only trace is a line in the server log.
  if (transport === "TOKEN" && !channel) {
    problems.push(
      "A bot token is set but no default channel is, so every card is built and none is posted — `chat.postMessage` needs somewhere to send it. Set a default channel below.",
    );
  }

  // --- Inbound -------------------------------------------------------------
  if (!secret) {
    problems.push(
      "No signing secret, so every button and slash command is refused. Slack app → Basic Information → App Credentials → Signing Secret, pasted below. Without it a card can be posted and none of its buttons can ever do anything.",
    );
  } else if (!inbound.lastOkAt) {
    problems.push(
      `A signing secret is set and no request from Slack has ever verified. Switch on Interactivity in the Slack app with the request URL ${base}/api/slack/actions, add the slash command \`/dakyworld\` pointing at ${base}/api/slack/commands, then run \`/dakyworld ping\` — it proves this end to end.`,
    );
  }

  if (inbound.lastRefusedReason && (!inbound.lastOkAt || (inbound.lastRefusedAt ?? "") > inbound.lastOkAt)) {
    problems.push(`The last request from Slack was refused — ${inbound.lastRefusedReason}`);
  }

  if (secret && approvers.length === 0) {
    problems.push(
      "Nobody is named under “Who may approve”, so anyone who can see the channel can employ an agent or approve a payment. Right while you are alone in it; wrong the day somebody else joins.",
    );
  }

  const outboundReady = transport !== "NONE" && !(transport === "TOKEN" && !channel);

  return {
    outbound: { transport, channel, ready: outboundReady },
    inbound: {
      signingSecret: Boolean(secret),
      approvers,
      openToAnyone: approvers.length === 0,
      everVerified: Boolean(inbound.lastOkAt),
      ...inbound,
    },
    requestUrls: { actions: `${base}/api/slack/actions`, commands: `${base}/api/slack/commands` },
    problems,
    ready: outboundReady && Boolean(secret) && Boolean(inbound.lastOkAt),
  };
}
