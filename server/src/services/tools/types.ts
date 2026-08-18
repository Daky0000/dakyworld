import type { z } from "zod";
import type { ModelJob } from "../../lib/models/registry.js";

/**
 * What a tool is.
 *
 * The blueprint describes agents with tool kits and permissions; until now
 * that was a list of strings on the Agent row that nothing read. A tool here
 * is four things an agent can't argue with: a **scope** (may it read, write,
 * send, spend), a **schema** its arguments have to satisfy, a **handler**, and
 * a **preview** for anything that reaches outside the company or costs money.
 *
 * The catalogue is code rather than configuration on purpose. What an agent is
 * *allowed* to call is configuration — that is the grant, and the Owner owns
 * it. What a tool *does* is behaviour, and behaviour that can be edited at
 * runtime is behaviour nobody can review.
 */

/** What kind of thing this tool does, in the order they get riskier. */
export type ToolScope = "read" | "write" | "send" | "charge";

/**
 * The integration a tool needs before it can run. Checked against the tool
 * registry so a tool whose key is missing reports "needs a key" instead of
 * failing at the moment an agent tries to use it.
 */
export type ToolRequirement =
  | "database"
  | "claude"
  /**
   * A model — any of the four vendors. Deliberately not one of them by name:
   * every job falls back to Claude when the vendor chosen for it has no key,
   * so a tool that names a vendor would refuse work it could still do. Which
   * vendor actually answers is decided per call by lib/models/registry.ts, and
   * the tool's own result says who it was.
   */
  | "models"
  | "apify"
  | "email"
  | "slack"
  | "stripe"
  | "cloudinary"
  | "google"
  | "calendar"
  | "github"
  | "webhooks"
  /** A connected MCP server. See services/tools/mcpTools.ts. */
  | "mcp";

export interface ToolContext {
  /** The agent making the call, when one is. Null when a person is. */
  agentKey: string | null;
  /** The signed-in user, when there is one. */
  userId: string | null;
  /**
   * When true the tool explains what it would do and changes nothing.
   * An agent's own `dryRun` flag decides this; a person can ask for it too.
   */
  dryRun: boolean;
}

export interface ToolDefinition<I = unknown, O = unknown> {
  /** `lead.read`, `email.send` — matches the vocabulary in the agent seeds. */
  key: string;
  name: string;
  /**
   * How the Tools screen groups it. `Studio` is the creative work the
   * specialist agents do; `Connected` is everything an MCP server contributes,
   * which is grouped apart because it is the only part of the catalogue that
   * is not in this repository.
   */
  group:
    | "Pipeline"
    | "Clients"
    | "Delivery"
    | "Money"
    | "Communication"
    | "Research"
    | "Documents"
    | "Operations"
    | "Studio"
    | "Connected";
  purpose: string;
  scope: ToolScope;
  requires: ToolRequirement;
  /** True when a call costs real money. */
  spends: boolean;
  /**
   * True when a call is visible to somebody outside the company — an email
   * lands, a calendar invitation arrives, a card is charged. These are the
   * ones dry run exists for, and the ones an agent below autonomy 3 may
   * prepare but never carry out.
   */
  outward: boolean;
  /**
   * Which model job this tool asks for, when it asks for one. Read by the
   * Tools screen so "which of these does Gemini do" has an answer, and by
   * nothing else — the tool's own handler names its job when it calls.
   */
  job?: ModelJob;
  input: z.ZodType<I>;
  run: (input: I, ctx: ToolContext) => Promise<O>;
  /**
   * What a dry run would have done, as a sentence for a person to approve.
   * Required for anything outward-facing or spending; the invoker refuses to
   * dry-run a tool that can't describe itself, rather than quietly doing it.
   */
  preview?: (input: I, ctx: ToolContext) => Promise<string>;
}

export interface ToolResult<O = unknown> {
  tool: string;
  ok: boolean;
  /** Null on a dry run — nothing was done, so there is nothing to return. */
  output: O | null;
  dryRun: boolean;
  /** Set on a dry run: what would have happened. */
  wouldDo?: string;
  error?: string;
  /** Set when the call was refused rather than attempted. */
  refusedReason?: string;
  costUsd: number;
  durationMs: number;
}
