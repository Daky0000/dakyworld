import { analystConfigured } from "../../lib/claude.js";
import { PROVIDER_KEYS, providerConfigured } from "../../lib/models/registry.js";
import { apifyConfigured } from "../../lib/apify.js";
import { mailerConfigured } from "../../lib/mailer.js";
import { paystackConfigured } from "../../lib/paystack.js";
import { hubtelConfigured, hubtelSmsConfigured } from "../../lib/hubtel.js";
import { whatsappConfigured } from "../../lib/whatsapp.js";
import { stripeConfigured } from "../../lib/stripe.js";
import { cloudinaryConfigured } from "../../lib/cloudinary.js";
import { googleConfigured, googleConnected } from "../../lib/google.js";
import { slackConfigured } from "../../lib/slack.js";
import { githubConfigured } from "../../lib/github.js";
import { calendarReady } from "../../lib/calendar.js";
import { prisma } from "../../lib/prisma.js";
import type { ToolRequirement } from "./types.js";

/**
 * Is the thing behind this tool actually connected.
 *
 * Split out from the tool registry so the answer is the same in both places —
 * the Tools screen and the moment an agent calls something. A tool whose
 * integration is missing has to refuse with a sentence naming what to paste
 * and where, because the alternative is an agent reporting that it sent an
 * email nobody received.
 */

export interface Readiness {
  ready: boolean;
  /** Why not, in one sentence, naming where the credential goes. */
  reason: string | null;
}

const ok: Readiness = { ready: true, reason: null };
const no = (reason: string): Readiness => ({ ready: false, reason });

/** Short-lived: this is checked on every tool call and the answers rarely change. */
const CACHE_MS = 15_000;
const cache = new Map<ToolRequirement, { at: number; readiness: Readiness }>();

export function clearReadinessCache() {
  cache.clear();
}

export async function toolReadiness(requirement: ToolRequirement): Promise<Readiness> {
  const cached = cache.get(requirement);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.readiness;

  const readiness = await compute(requirement);
  cache.set(requirement, { at: Date.now(), readiness });
  return readiness;
}

async function compute(requirement: ToolRequirement): Promise<Readiness> {
  switch (requirement) {
    case "database":
      return ok;
    case "claude":
      return (await analystConfigured()) ? ok : no("No Anthropic API key. Add one under Settings → Analyst.");
    case "models": {
      // Ready when *any* vendor is connected, because every job falls back to
      // whichever one is. Which vendor serves which job is settings, not
      // readiness — see lib/models/registry.ts.
      const connected = await Promise.all(PROVIDER_KEYS.map((key) => providerConfigured(key)));
      return connected.some(Boolean)
        ? ok
        : no("No AI model is connected. Add a key under Settings → AI models.");
    }
    case "apify":
      return (await apifyConfigured()) ? ok : no("No Apify token. Add one under Settings → Lead capture.");
    case "email":
      return (await mailerConfigured()) ? ok : no("Email isn't connected. Set it up under Settings → Email.");
    case "slack":
      return (await slackConfigured()) ? ok : no("Slack isn't connected. Add a webhook URL or bot token under Settings → Alerts.");
    case "stripe":
      return (await stripeConfigured()) ? ok : no("Stripe isn't connected. Add a secret key under Settings → Payments.");
    case "paystack":
      return (await paystackConfigured()) ? ok : no("Paystack isn't connected. Add a secret key under Settings → Payments.");
    case "hubtel":
      return (await hubtelConfigured()) ? ok : no("Hubtel isn't connected. Add the client id, secret and merchant account number under Settings → Payments.");
    case "hubtelSms":
      // Named apart from the payments pair on purpose: Hubtel issues two, and
      // being told "Hubtel isn't connected" while looking at connected Hubtel
      // payments is the confusing version of this message.
      return (await hubtelSmsConfigured()) ? ok : no("Hubtel SMS isn't connected. It uses a different credential pair from payments — add it under Settings → Payments.");
    case "whatsapp":
      return (await whatsappConfigured())
        ? ok
        : no("WhatsApp isn't connected. Add the access token and phone number ID under Settings → Messaging.");
    case "cloudinary":
      return (await cloudinaryConfigured()) ? ok : no("Cloudinary isn't connected. Add the three values under Settings → Storage.");
    case "github":
      return (await githubConfigured()) ? ok : no("GitHub isn't connected. Add a personal access token under Settings → Developer.");
    case "webhooks":
      // The secret mints itself on first use, so there is nothing to configure.
      return ok;
    case "mcp": {
      // Ready when at least one server is switched on. Which server answers a
      // given tool is the tool's own business — see services/tools/mcpTools.ts.
      const connected = await prisma.mcpServer.count({ where: { enabled: true } });
      return connected > 0 ? ok : no("No MCP server is connected. Add one under Settings → Connected tools.");
    }
    case "google": {
      const [configured, connected] = await Promise.all([googleConfigured(), googleConnected()]);
      if (!configured) return no("Google OAuth isn't set up. Add the client ID and secret under Settings → Google.");
      return connected ? ok : no("Google is set up but no account is connected. Connect one under Settings → Google.");
    }
    case "calendar": {
      const ready = await calendarReady();
      if (!ready.connected) return no("Google isn't connected. Connect an account under Settings → Google.");
      if (!ready.scoped) {
        return no("The Google account was connected before calendar access existed. Reconnect it under Settings → Google.");
      }
      return ok;
    }
    default:
      return no("That tool needs something this app doesn't know how to check.");
  }
}
