import { prisma } from "../../lib/prisma.js";
import { SETTING, getSetting } from "../../lib/settings.js";
import { findTool } from "./catalogue.js";
import { toolReadiness } from "./readiness.js";
import type { ToolContext, ToolDefinition, ToolResult } from "./types.js";

/**
 * The one way a tool gets called.
 *
 * Everything an agent is not allowed to do is enforced here rather than in the
 * tools themselves, so a new tool inherits the whole policy by existing:
 *
 * 1. **Does this tool exist**, and is the integration behind it configured.
 * 2. **Is this agent granted it.** The grant is the agent's `toolkit`; an
 *    agent with an empty toolkit can call nothing at all.
 * 3. **Does the autonomy level allow it.** Below level 3 an agent may prepare
 *    an outward-facing or spending action and never carry it out — which is
 *    what `dryRun` produces rather than an error, because a prepared action a
 *    person can approve is the useful outcome.
 * 4. **Is the input the shape the tool declared.** A model will confidently
 *    pass a string where a date was wanted; the schema catches it before the
 *    handler does something odd with it.
 *
 * Every call is written to `ToolCall` — including the ones that were refused,
 * which is the record that answers "why did nothing happen last night".
 */

/** Below this an agent may prepare outward-facing work but not carry it out. */
const EXECUTE_LEVEL = 3;
/** Spending needs one level above executing: money is the harder mistake to undo. */
const SPEND_LEVEL = 4;

export class ToolRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolRefused";
  }
}

export interface InvokeOptions extends ToolContext {
  /** Skips the grant and autonomy checks. Only ever set for a person acting directly. */
  asOwner?: boolean;
}

/**
 * What the caller is allowed to do with this tool, before anything is run.
 * Exported so the Agents screen can show a roster of "can, can prepare only,
 * cannot" without attempting a call to find out.
 */
export interface Permission {
  allowed: boolean;
  /** True when the call is allowed but must stop at a preview. */
  mustDryRun: boolean;
  reason: string | null;
}

export async function permissionFor(tool: ToolDefinition, options: InvokeOptions): Promise<Permission> {
  if (options.asOwner || !options.agentKey) return { allowed: true, mustDryRun: options.dryRun, reason: null };

  const agent = await prisma.agent.findUnique({ where: { key: options.agentKey } });
  if (!agent) return { allowed: false, mustDryRun: false, reason: `No agent called ${options.agentKey}.` };
  if (agent.status === "RETIRED" || agent.status === "PAUSED") {
    return { allowed: false, mustDryRun: false, reason: `${agent.name} is ${agent.status.toLowerCase()}.` };
  }
  if (!agent.toolkit.includes(tool.key)) {
    return { allowed: false, mustDryRun: false, reason: `${agent.name} hasn't been granted ${tool.key}.` };
  }

  // The agent's own dry-run flag is a floor, not a default: an Owner asking for
  // a real run cannot switch it off from the call site.
  if (agent.dryRun && (tool.outward || tool.spends || tool.scope === "write")) {
    return { allowed: true, mustDryRun: true, reason: `${agent.name} is in dry run, so this is prepared rather than done.` };
  }
  if (tool.spends && agent.autonomyLevel < SPEND_LEVEL) {
    return { allowed: true, mustDryRun: true, reason: `Spending needs autonomy ${SPEND_LEVEL}; ${agent.name} is at ${agent.autonomyLevel}.` };
  }
  if (tool.outward && agent.autonomyLevel < EXECUTE_LEVEL) {
    return { allowed: true, mustDryRun: true, reason: `Acting outside the company needs autonomy ${EXECUTE_LEVEL}; ${agent.name} is at ${agent.autonomyLevel}.` };
  }

  return { allowed: true, mustDryRun: options.dryRun, reason: null };
}

export async function invokeTool(key: string, rawInput: unknown, options: InvokeOptions): Promise<ToolResult> {
  const startedAt = Date.now();
  const tool = findTool(key);

  if (!tool) {
    await record({ tool: key, options, ok: false, refusedReason: `There is no tool called ${key}.`, durationMs: 0 });
    return refusal(key, `There is no tool called ${key}.`, 0);
  }

  const readiness = await toolReadiness(tool.requires);
  if (!readiness.ready) {
    await record({ tool: key, options, ok: false, refusedReason: readiness.reason, durationMs: Date.now() - startedAt });
    return refusal(key, readiness.reason ?? "That tool isn't configured yet.", Date.now() - startedAt);
  }

  const permission = await permissionFor(tool, options);
  if (!permission.allowed) {
    await record({ tool: key, options, ok: false, refusedReason: permission.reason, durationMs: Date.now() - startedAt });
    return refusal(key, permission.reason ?? "Not permitted.", Date.now() - startedAt);
  }

  const parsed = tool.input.safeParse(rawInput ?? {});
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ");
    await record({ tool: key, options, ok: false, error: detail, input: rawInput, durationMs: Date.now() - startedAt });
    return { tool: key, ok: false, output: null, dryRun: false, error: `That input isn't right — ${detail}`, costUsd: 0, durationMs: Date.now() - startedAt };
  }

  const dryRun = permission.mustDryRun;
  const context: ToolContext = { agentKey: options.agentKey, userId: options.userId, dryRun };

  if (dryRun) {
    // A tool that can't say what it would do must not be dry-run into silently
    // doing it, and must not report success for work that never happened.
    if (!tool.preview) {
      const reason = `${tool.name} can't be previewed, and a dry run must not carry it out.`;
      await record({ tool: key, options, ok: false, refusedReason: reason, input: parsed.data, durationMs: Date.now() - startedAt });
      return refusal(key, reason, Date.now() - startedAt);
    }
    let wouldDo: string;
    try {
      wouldDo = await tool.preview(parsed.data, context);
    } catch (err) {
      wouldDo = `Couldn't work out what this would do: ${(err as Error).message}`;
    }
    const durationMs = Date.now() - startedAt;
    await record({ tool: key, options, ok: true, dryRun: true, input: parsed.data, output: { wouldDo }, durationMs });
    return { tool: key, ok: true, output: null, dryRun: true, wouldDo, refusedReason: permission.reason ?? undefined, costUsd: 0, durationMs };
  }

  try {
    const output = await tool.run(parsed.data, context);
    const durationMs = Date.now() - startedAt;
    const costUsd = await priceOf(tool, output);
    await record({ tool: key, options, ok: true, input: parsed.data, output, costUsd, durationMs });
    return { tool: key, ok: true, output, dryRun: false, costUsd, durationMs };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const message = (err as Error).message ?? "The tool failed.";
    await record({ tool: key, options, ok: false, input: parsed.data, error: message, durationMs });
    return { tool: key, ok: false, output: null, dryRun: false, error: message, costUsd: 0, durationMs };
  }
}

/**
 * What a call cost, where the tool can say. Only capture knows its own price
 * today — an Apify run reports its charge when it finishes, not when it starts
 * — so this records the *estimate* against the call and lets the run record
 * carry the real figure. Two numbers for one spend, but they answer different
 * questions: this one is "what did the agent commit us to".
 */
async function priceOf(tool: ToolDefinition, output: unknown): Promise<number> {
  if (!tool.spends) return 0;
  const estimate = (output as { estimateUsd?: number } | null)?.estimateUsd;
  return typeof estimate === "number" ? estimate : 0;
}

function refusal(tool: string, reason: string, durationMs: number): ToolResult {
  return { tool, ok: false, output: null, dryRun: false, refusedReason: reason, error: reason, costUsd: 0, durationMs };
}

/** Trims a value so one enormous tool result can't fill the database. */
function trim(value: unknown): unknown {
  if (value === undefined) return undefined;
  const json = JSON.stringify(value);
  if (json === undefined) return null;
  if (json.length <= 20_000) return JSON.parse(json);
  return { truncated: true, preview: json.slice(0, 2000) };
}

async function record(entry: {
  tool: string;
  options: InvokeOptions;
  ok: boolean;
  dryRun?: boolean;
  input?: unknown;
  output?: unknown;
  error?: string | null;
  refusedReason?: string | null;
  costUsd?: number;
  durationMs: number;
}) {
  try {
    await prisma.toolCall.create({
      data: {
        tool: entry.tool,
        agentKey: entry.options.agentKey,
        userId: entry.options.userId,
        input: trim(entry.input) as never,
        output: trim(entry.output) as never,
        ok: entry.ok,
        dryRun: entry.dryRun ?? false,
        error: entry.error ?? null,
        refusedReason: entry.refusedReason ?? null,
        costUsd: entry.costUsd ?? 0,
        durationMs: entry.durationMs,
      },
    });
  } catch (err) {
    // The audit trail failing must not fail the work it was recording, but it
    // is worth shouting about — an agent acting with no record is the thing
    // this table exists to prevent.
    console.error(`[tools] could not record a ${entry.tool} call:`, (err as Error).message);
  }
}

/** The ceiling on a single spending call, from Settings. Null means no ceiling. */
export async function maxCallSpend(): Promise<number | null> {
  const raw = await getSetting(SETTING.AGENT_MAX_CALL_USD);
  const parsed = Number.parseFloat(raw ?? "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
