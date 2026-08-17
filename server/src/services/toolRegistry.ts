import { analystConfigured } from "../lib/claude.js";
import { apifyConfigured } from "../lib/apify.js";
import { activeTransport, mailerConfigured } from "../lib/mailer.js";
import { stripeConfigured } from "../lib/stripe.js";
import { cloudinaryConfigured } from "../lib/cloudinary.js";
import { googleConfigured, googleConnected } from "../lib/google.js";

/**
 * Every tool the blueprint names, and whether it is actually here.
 *
 * The point of this screen is to be trusted, which means it has to be willing
 * to say no. A tool the app cannot use yet reports `PLANNED` rather than
 * "not configured" — the difference matters, because one of those is fixed by
 * pasting a key and the other is fixed by writing code, and an agent roster
 * that claims Slack works because a webhook URL box exists would be a lie the
 * first time an alert silently goes nowhere.
 */

export type ToolState =
  /** Ready to use right now. */
  | "READY"
  /** Built and waiting on a key or an account connection. */
  | "NEEDS_KEY"
  /** Named in the blueprint; no code behind it yet. */
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
}

export async function toolStatuses(): Promise<ToolStatus[]> {
  const [claude, apify, mail, transport, stripe, cloudinary, google, googleLinked] = await Promise.all([
    analystConfigured(),
    apifyConfigured(),
    mailerConfigured(),
    activeTransport(),
    stripeConfigured(),
    cloudinaryConfigured(),
    googleConfigured(),
    googleConnected(),
  ]);

  const flag = (ok: boolean): ToolState => (ok ? "READY" : "NEEDS_KEY");

  return [
    {
      key: "prisma",
      name: "Business database",
      purpose: "Every lead, client, proposal, project, invoice and retainer. The system of record.",
      settingsTab: null,
      needs: null,
      state: "READY",
      scopes: ["read", "write"],
      spends: false,
    },
    {
      key: "claude",
      name: "Claude",
      purpose: "Reasoning, drafting, classification and planning. Never the system of record.",
      settingsTab: "analyst",
      needs: "An Anthropic API key",
      state: flag(claude),
      scopes: ["read"],
      spends: true,
    },
    {
      // Named for the path that is actually live, because "email is connected"
      // is not the same claim as "email is connected through the MCP server",
      // and the second is the one that explains a Hostinger-shaped failure.
      key: "email",
      name: transport === "HOSTINGER" ? "Email (Hostinger MCP)" : "Email (SMTP)",
      purpose: "Outbound business email — drafts, sequences, invoices, client updates.",
      settingsTab: "email",
      needs:
        transport === "HOSTINGER"
          ? "A Hostinger Agentic Mail API token — nothing else."
          : "SMTP host, user and password. Google Workspace needs an App Password.",
      state: flag(mail),
      scopes: ["read", "send"],
      spends: false,
      // The domain's mailbox is Hostinger's, and Hostinger takes one token
      // instead of five SMTP fields — so it gets its own way in from here.
      shortcut:
        transport === "HOSTINGER" ? null : { label: "Hostinger · one token ↗", to: "/settings?tab=email&provider=hostinger" },
    },
    {
      key: "apify",
      name: "Apify",
      purpose: "Lead capture — Google Maps, websites, LinkedIn, Facebook, Instagram.",
      settingsTab: "capture",
      needs: "An Apify API token",
      state: flag(apify),
      scopes: ["read", "charge"],
      spends: true,
    },
    {
      key: "stripe",
      name: "Stripe",
      purpose: "Payment links and reconciling what has actually been paid.",
      settingsTab: "payments",
      needs: "A Stripe secret key, and a webhook secret to confirm payments",
      state: flag(stripe),
      scopes: ["read", "charge"],
      spends: true,
    },
    {
      key: "cloudinary",
      name: "Cloudinary",
      purpose: "Hosting generated PDFs and documents so they can be linked rather than attached.",
      settingsTab: "storage",
      needs: "Cloud name, API key and API secret",
      state: flag(cloudinary),
      scopes: ["read", "write"],
      spends: false,
    },
    {
      key: "google",
      name: "Google Workspace",
      purpose: "Reading lead spreadsheets straight out of Drive.",
      settingsTab: "google",
      needs: google && !googleLinked ? "Connect the account — the keys are set" : "OAuth client ID and secret, then connect the account",
      state: google && googleLinked ? "READY" : "NEEDS_KEY",
      scopes: ["read"],
      spends: false,
    },
    {
      key: "documents",
      name: "Document generation",
      purpose: "Branded proposal and invoice PDFs and Word files.",
      settingsTab: null,
      needs: null,
      state: "READY",
      scopes: ["write"],
      spends: false,
    },
    {
      key: "audit",
      name: "Website & DNS audit",
      purpose: "Fetches a prospect's site and checks DNS, mail records and TLS — the evidence proposals argue from.",
      settingsTab: null,
      needs: null,
      state: "READY",
      scopes: ["read"],
      spends: false,
    },
    {
      key: "analytics",
      name: "Analytics",
      purpose: "Revenue, pipeline, retainer health and agent spend, computed from source records.",
      settingsTab: null,
      needs: null,
      state: "READY",
      scopes: ["read"],
      spends: false,
    },
    // Everything below is named in the blueprint and has no code behind it.
    // Reported as planned rather than unconfigured, so nobody grants an agent
    // a tool that will quietly do nothing.
    {
      key: "slack",
      name: "Slack",
      purpose: "Internal alerting and escalation.",
      settingsTab: null,
      needs: "Not built yet — escalations currently arrive by email",
      state: "PLANNED",
      scopes: ["send"],
      spends: false,
    },
    {
      key: "calendar",
      name: "Calendar",
      purpose: "Booking consultations and reading team capacity.",
      settingsTab: null,
      needs: "Not built yet",
      state: "PLANNED",
      scopes: ["read", "write"],
      spends: false,
    },
    {
      key: "github",
      name: "GitHub",
      purpose: "Code, issues and deployment context for the technical agents.",
      settingsTab: null,
      needs: "Not built yet",
      state: "PLANNED",
      scopes: ["read"],
      spends: false,
    },
    {
      key: "webhooks",
      name: "Inbound webhooks",
      purpose: "Events from other systems. Only Stripe's is wired today.",
      settingsTab: "payments",
      needs: "Generic webhook intake is not built yet",
      state: "PLANNED",
      scopes: ["read"],
      spends: false,
    },
  ];
}

export interface ToolSummary {
  ready: number;
  needsKey: number;
  planned: number;
}

export function summarise(tools: ToolStatus[]): ToolSummary {
  return {
    ready: tools.filter((t) => t.state === "READY").length,
    needsKey: tools.filter((t) => t.state === "NEEDS_KEY").length,
    planned: tools.filter((t) => t.state === "PLANNED").length,
  };
}
