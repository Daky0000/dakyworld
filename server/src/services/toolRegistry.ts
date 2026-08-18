import { activeTransport } from "../lib/mailer.js";
import { slackTransport } from "../lib/slack.js";
import { calendarReady } from "../lib/calendar.js";
import { defaultOwner } from "../lib/github.js";
import { PROVIDERS, PROVIDER_KEYS, describeRouting, providerConfigured, type ProviderKey } from "../lib/models/registry.js";
import { TOOLS } from "./tools/catalogue.js";
import { toolReadiness } from "./tools/readiness.js";
import type { ToolRequirement } from "./tools/types.js";

/**
 * Every integration the agents can reach, and whether it is actually here.
 *
 * The point of this screen is to be trusted, which means it has to be willing
 * to say no. It used to have a third state, `PLANNED` — named in the blueprint
 * with no code behind it — for Slack, Calendar, GitHub and inbound webhooks,
 * because an agent roster claiming Slack works on the strength of a settings
 * box would be a lie the first time an alert went nowhere.
 *
 * **All four are now built.** Nothing here is planned any more: each one is
 * either ready or waiting on a credential, and `PLANNED` survives only as a
 * state this file can still return if something is ever named before it works.
 *
 * The integrations are derived from the tool catalogue rather than listed
 * twice: `tools` on each row is every catalogue key that needs it, so a tool
 * added to the catalogue shows up here without anyone remembering to.
 */

export type ToolState =
  /** Ready to use right now. */
  | "READY"
  /** Built and waiting on a key or an account connection. */
  | "NEEDS_KEY"
  /** Named but not built. Nothing is in this state today. */
  | "PLANNED";

export interface ToolStatus {
  key: string;
  name: string;
  purpose: string;
  /** Where the credential goes, as a Settings tab, when there is one. */
  settingsTab: string | null;
  /** What the Owner actually has to supply. */
  needs: string | null;
  state: ToolState;
  /** Which permission scopes an agent can be granted over it. */
  scopes: string[];
  /** Said plainly when the tool can spend money. */
  spends: boolean;
  /** A faster way to satisfy this tool than the general settings form, when one exists. */
  shortcut?: { label: string; to: string } | null;
  /** Catalogue keys an agent can be granted against this integration. */
  tools: string[];
  /** How many of those reach outside the company. */
  outwardTools: number;
}

interface Integration {
  key: string;
  requirement: ToolRequirement;
  name: string;
  purpose: string;
  settingsTab: string | null;
  /** What to say when it is ready; the reason from `readiness` is used when it isn't. */
  readyNote: string | null;
  scopes: string[];
  spends: boolean;
  shortcut?: { label: string; to: string } | null;
  /**
   * Overrides both the readiness check and the derived tool list.
   *
   * One row per model vendor needs it, because those four rows all share the
   * `models` requirement — every job falls back, so no tool can name a vendor —
   * and deriving their tool lists from the requirement would give all four the
   * same list. What a vendor is actually doing is what the *routing* says, and
   * that changes when the Owner changes a dropdown rather than when code does.
   */
  override?: {
    ready: boolean;
    reason: string | null;
    tools: string[];
  };
}

/**
 * One row per model vendor.
 *
 * Derived from the routing rather than from the catalogue, so a row says what
 * that vendor is doing *right now* — move web pages from ChatGPT to Gemini in
 * Settings and the two rows swap the tool between them without a deploy.
 *
 * Claude is excluded: it has its own row above, because it does two jobs
 * nothing else here does (reading spreadsheets, running the agent loop) as well
 * as standing in for whichever vendor is not connected yet.
 */
async function modelIntegrations(): Promise<Integration[]> {
  const routing = await describeRouting();

  return Promise.all(
    PROVIDER_KEYS.filter((key): key is Exclude<ProviderKey, "anthropic"> => key !== "anthropic").map(async (key) => {
      const definition = PROVIDERS[key];
      const configured = await providerConfigured(key);
      const jobs = routing.filter((route) => route.serving === key).map((route) => route.job);
      // Every tool that names one of the jobs this vendor is currently serving.
      const tools = TOOLS.filter((tool) => tool.job && jobs.includes(tool.job)).map((tool) => tool.key);
      // What it was *chosen* for, which is what the Owner is owed a sentence
      // about when it isn't connected — "you picked Gemini for writing and
      // Claude is covering" is the useful thing to read.
      const chosenFor = routing.filter((route) => route.chosen === key).map((route) => route.job);

      return {
        key: `model.${key}`,
        requirement: "models" as ToolRequirement,
        name: definition.name,
        purpose: definition.purpose,
        settingsTab: "models",
        readyNote: jobs.length > 0 ? `Doing: ${jobs.join(", ")}.` : "Connected, but nothing is routed to it.",
        scopes: ["read"],
        spends: true,
        override: {
          ready: configured,
          reason: configured
            ? null
            : chosenFor.length > 0
              ? `Not connected, so ${chosenFor.join(" and ")} ${chosenFor.length > 1 ? "are" : "is"} falling back to Claude. Add a key under Settings \u2192 AI models.`
              : `Not connected. Add a key under Settings \u2192 AI models.`,
          tools,
        },
      } satisfies Integration;
    }),
  );
}

async function integrations(): Promise<Integration[]> {
  const [transport, slack, calendar, ghOwner, modelRows] = await Promise.all([
    activeTransport(),
    slackTransport(),
    calendarReady(),
    defaultOwner(),
    modelIntegrations(),
  ]);

  return [
    {
      key: "prisma",
      requirement: "database",
      name: "Business database",
      purpose: "Every lead, client, proposal, project, invoice and retainer. The system of record.",
      settingsTab: null,
      readyNote: null,
      scopes: ["read", "write"],
      spends: false,
    },
    {
      key: "claude",
      requirement: "claude",
      name: "Claude",
      purpose: "Reads spreadsheets and runs the agents. Never the system of record.",
      settingsTab: "analyst",
      readyNote: null,
      scopes: ["read"],
      spends: true,
    },
    ...modelRows,
    {
      // Named for the path that is actually live, because "email is connected"
      // is not the same claim as "email is connected through the MCP server",
      // and the second is the one that explains a Hostinger-shaped failure.
      key: "email",
      requirement: "email",
      name: transport === "HOSTINGER" ? "Email (Hostinger MCP)" : "Email (SMTP)",
      purpose: "Outbound business email — drafts, sequences, invoices, client updates.",
      settingsTab: "email",
      readyNote: null,
      scopes: ["read", "send"],
      spends: false,
      // The domain's mailbox is Hostinger's, and Hostinger takes one token
      // instead of five SMTP fields — so it gets its own way in from here.
      shortcut:
        transport === "HOSTINGER" ? null : { label: "Hostinger · one token ↗", to: "/settings?tab=email&provider=hostinger" },
    },
    {
      key: "apify",
      requirement: "apify",
      name: "Apify",
      purpose: "Lead capture — Google Maps, websites, LinkedIn, Facebook, Instagram.",
      settingsTab: "capture",
      readyNote: null,
      scopes: ["read", "charge"],
      spends: true,
    },
    {
      key: "stripe",
      requirement: "stripe",
      name: "Stripe",
      purpose: "Payment links and reconciling what has actually been paid.",
      settingsTab: "payments",
      readyNote: null,
      scopes: ["read", "charge"],
      spends: true,
    },
    {
      key: "cloudinary",
      requirement: "cloudinary",
      name: "Cloudinary",
      purpose: "Hosting generated PDFs and documents so they can be linked rather than attached.",
      settingsTab: "storage",
      readyNote: null,
      scopes: ["read", "write"],
      spends: false,
    },
    {
      key: "google",
      requirement: "google",
      name: "Google Workspace",
      purpose: "Reading lead spreadsheets straight out of Drive.",
      settingsTab: "google",
      readyNote: null,
      scopes: ["read"],
      spends: false,
    },
    {
      key: "slack",
      requirement: "slack",
      name: slack === "TOKEN" ? "Slack (bot)" : "Slack",
      purpose: "Internal alerting and escalation — a run that failed, a lead worth interrupting someone for.",
      settingsTab: "alerts",
      readyNote:
        slack === "WEBHOOK"
          ? "Connected by webhook, so every message lands in the one channel it was created for. A bot token lets an agent choose the channel."
          : null,
      scopes: ["send"],
      spends: false,
    },
    {
      key: "calendar",
      requirement: "calendar",
      name: "Calendar",
      purpose: "Booking consultations and reading who is free. Uses the Google account already connected.",
      settingsTab: "google",
      readyNote: calendar.calendarId === "primary" ? "Booking into the connected account's own calendar." : `Booking into “${calendar.calendarId}”.`,
      scopes: ["read", "write"],
      spends: false,
    },
    {
      key: "github",
      requirement: "github",
      name: "GitHub",
      purpose: "Code, issues and deployment context for the technical agents. Reads, plus opening an issue.",
      settingsTab: "developer",
      readyNote: ghOwner ? `Repositories can be named without the owner — “os” means “${ghOwner}/os”.` : null,
      scopes: ["read", "write"],
      spends: false,
    },
    {
      key: "webhooks",
      requirement: "webhooks",
      name: "Webhooks",
      purpose: "Events in from other systems — the website's contact form, a partner — and signed events out.",
      settingsTab: "webhooks",
      readyNote: "The shared secret is generated for you; nothing to paste.",
      scopes: ["read", "send"],
      spends: false,
    },
  ];
}

export async function toolStatuses(): Promise<ToolStatus[]> {
  const list = await integrations();

  return Promise.all(
    list.map(async (integration) => {
      const readiness = integration.override
        ? { ready: integration.override.ready, reason: integration.override.reason }
        : await toolReadiness(integration.requirement);
      const tools = integration.override
        ? TOOLS.filter((tool) => integration.override!.tools.includes(tool.key))
        : TOOLS.filter((tool) => tool.requires === integration.requirement);
      return {
        key: integration.key,
        name: integration.name,
        purpose: integration.purpose,
        settingsTab: integration.settingsTab,
        needs: readiness.ready ? integration.readyNote : readiness.reason,
        state: readiness.ready ? ("READY" as const) : ("NEEDS_KEY" as const),
        scopes: integration.scopes,
        spends: integration.spends,
        shortcut: integration.shortcut ?? null,
        tools: tools.map((tool) => tool.key),
        outwardTools: tools.filter((tool) => tool.outward).length,
      };
    }),
  );
}

export interface ToolSummary {
  ready: number;
  needsKey: number;
  planned: number;
  /** How many catalogue tools are callable right now. */
  callable: number;
  /** How many exist in total, so "12 of 28" is sayable. */
  total: number;
}

export function summarise(tools: ToolStatus[]): ToolSummary {
  const ready = tools.filter((tool) => tool.state === "READY");
  return {
    ready: ready.length,
    needsKey: tools.filter((tool) => tool.state === "NEEDS_KEY").length,
    planned: tools.filter((tool) => tool.state === "PLANNED").length,
    callable: ready.reduce((sum, tool) => sum + tool.tools.length, 0),
    total: TOOLS.length,
  };
}
