import { prisma } from "../../lib/prisma.js";
import { SETTING, getSetting } from "../../lib/settings.js";
import { resolveTool } from "./catalogue.js";
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
  /** The task this call belongs to, so a prepared action can be traced back to the work that proposed it. */
  taskId?: string | null;
  /**
   * The case the agent made for acting outside the company or spending money.
   *
   * Required for those tools and supplied by the model, because the schema in
   * `agents/runner.ts` asks for it — not by a prompt that can be forgotten.
   * It is what turns a preview into something a person can actually decide on:
   * "send this email" is not a question anybody can answer, and "send this
   * email, because their certificate expired, which gets us the strongest
   * opening we have, and the risk is that their host caused it" is.
   */
  rationale?: { why: string; gain: string; risk: string };
  /**
   * Set only when carrying out an action a person has already approved.
   *
   * This is the one thing that lifts the dry-run floor, and it is deliberately
   * narrow: it lifts *only* that. Readiness and the grant are still checked, so
   * an approval sitting in the queue after the tool is revoked, or after the
   * integration is disconnected, is refused rather than honoured. That is the
   * difference between this and `asOwner`, which skips the checks entirely
   * because a person is driving the tool directly.
   */
  approvedRequestId?: string;
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

  // A person has already looked at this exact call and said yes. Everything
  // above still had to pass — the agent exists, is not paused, and still holds
  // the tool — and it is only the "prepare rather than act" downgrade below
  // that the approval lifts. Without this the queue could file an action and
  // never carry one out, which is the state the app was already in.
  if (options.approvedRequestId) return { allowed: true, mustDryRun: false, reason: null };

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
  // Resolved across both halves of the catalogue: a tool an MCP server
  // contributes is called through exactly this path, and so meets every check
  // below on the same terms as a built-in one.
  const tool = await resolveTool(key);

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

    // A preview that nobody can act on is a description of work that will only
    // ever be done again by hand. Filing it here — with the input as the tool's
    // own schema validated it — is what lets Approve mean "carry this out"
    // rather than "mark it read".
    //
    // Only for the calls that actually need a decision. A `write` tool held
    // back by the agent's dry-run flag is prepared work, not a proposal for the
    // Owner's desk, and putting fifty of those in the queue would bury the two
    // that matter.
    let requestId: string | undefined;
    if (options.agentKey && (tool.outward || tool.spends)) {
      requestId = await fileActionRequest({
        agentKey: options.agentKey,
        taskId: options.taskId ?? null,
        tool: key,
        input: parsed.data,
        wouldDo,
        heldBecause: permission.reason ?? null,
        rationale: options.rationale,
      });
    }

    return {
      tool: key,
      ok: true,
      output: null,
      dryRun: true,
      wouldDo,
      refusedReason: permission.reason ?? undefined,
      actionRequestId: requestId,
      costUsd: 0,
      durationMs,
    };
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

/** How long a prepared action stays decidable before it has to be re-proposed. */
const REQUEST_LIVES_FOR_MS = 7 * 24 * 60 * 60_000;

/**
 * Files a prepared action for a person to decide on.
 *
 * Lives here rather than in `services/approvals.ts` so the two do not import
 * each other: approvals calls back into `invokeTool` to carry an approved
 * action out, and a cycle between the gate and the queue is the kind that only
 * shows up as an undefined export at boot.
 *
 * **Failing to file must not fail the preview.** The preview itself is
 * accurate and the agent should carry on preparing the rest of the work; a
 * queue write that fell over is worth shouting about in the log, not worth
 * turning into a failed task.
 */
async function fileActionRequest(entry: {
  agentKey: string;
  taskId: string | null;
  tool: string;
  input: unknown;
  wouldDo: string;
  heldBecause: string | null;
  rationale?: { why: string; gain: string; risk: string };
}): Promise<string | undefined> {
  try {
    const request = await prisma.actionRequest.create({
      data: {
        agentKey: entry.agentKey,
        taskId: entry.taskId,
        tool: entry.tool,
        input: trim(entry.input) as never,
        wouldDo: entry.wouldDo.slice(0, 2000),
        heldBecause: entry.heldBecause,
        // The schema asks the model for these on every outward tool, so they
        // are normally present. The fallback covers a tool driven from the API
        // rather than by an agent mid-task, where there is no model to ask.
        why: entry.rationale?.why?.slice(0, 1000) || "Not stated.",
        gain: entry.rationale?.gain?.slice(0, 1000) || "Not stated.",
        risk: entry.rationale?.risk?.slice(0, 1000) || "Not stated.",
        expiresAt: new Date(Date.now() + REQUEST_LIVES_FOR_MS),
      },
      select: { id: true },
    });

    // Posted without waiting. The agent is mid-loop and the card is a courtesy
    // — the queue in the app is the record. Imported here rather than at module
    // scope because the card builder reaches back into the catalogue, and a
    // cycle between the gate and anything else is the kind that shows up as an
    // undefined export at boot.
    void import("../approvalCards.js")
      .then(({ postApprovalCard }) => postApprovalCard(request.id))
      .catch((err: Error) => console.error("[tools] could not post the approval card:", err.message));

    return request.id;
  } catch (err) {
    console.error(`[tools] could not file an approval for ${entry.tool}:`, (err as Error).message);
    return undefined;
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
