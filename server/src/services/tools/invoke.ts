import { prisma } from "../../lib/prisma.js";
import { attribution } from "../../lib/runContext.js";
import { SETTING, getSetting } from "../../lib/settings.js";
import { resolveTool } from "./catalogue.js";
import { check, scopesForTool } from "../budgets.js";
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
  /**
   * What makes a repeat of this exact call the same call.
   *
   * Set by the runner for outward tools as
   * `${taskId}:${tool}:${sha256(input)}`. When one is given and a *successful,
   * non-dry-run* call with the same key is already on record, this returns that
   * call's recorded output instead of running the tool again.
   *
   * Deliberately opt-in rather than derived here. Two identical sends can be
   * two correct sends — a monthly reminder is the same payload every month —
   * so the caller is the only thing that knows whether "again" means a retry or
   * a repeat. What the runner knows, and what this exists for, is that a
   * resumed run replaying a turn is always a retry.
   */
  idempotencyKey?: string;
  /**
   * This call belongs to a rehearsal, so anything it prepares is a specimen.
   *
   * Set by the runner from `AgentTask.rehearsal`. It changes nothing about the
   * call itself — a rehearsal that behaved differently from the real thing
   * would be testing the rehearsal — and only marks what the preview leaves
   * behind, so it stays readable on the rehearsal screen and stays out of the
   * approval queue, out of the pending count and out of Slack.
   *
   * Without it, pointing the workforce at one real company filed a queue of
   * live, approvable actions against that company and posted an "Approve — do
   * it" card to Slack for each one. Approving any of them would have sent the
   * letter for real, which is exactly what the rehearsal guarantee says cannot
   * happen.
   */
  rehearsal?: boolean;
  /** Set when the tool call touches a category the agent is not responsible for. */
  boundaryViolation?: boolean;
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

  // --- Boundary Enforcement: not_responsible check ---
  // If the agent has a not_responsible list, reject calls that touch
  // categories/tools they are not responsible for.
  if (agent.not_responsible && agent.not_responsible.length > 0) {
    const notResponsiblePatterns = agent.not_responsible;
    // Check if the tool key matches any not_responsible pattern
    for (const pattern of notResponsiblePatterns) {
      const regex = new RegExp(`^${pattern.replace(/\*/g, '.*')}$`);
      if (regex.test(tool.key)) {
        // Log boundary violation in audit trail
        const violationId = await record({
          tool: tool.key,
          options: { ...options, boundaryViolation: true },
          ok: false,
          refusedReason: `${agent.name} is not responsible for ${tool.key}.`,
          durationMs: 0,
        });
        // Increment the agent's boundary violations counter
        await prisma.agent.update({
          where: { key: options.agentKey },
          data: { boundaryViolations: { increment: 1 } },
          select: { boundaryViolations: true },
        });
        // Check if the agent has exceeded the violation threshold
        const updatedAgent = await prisma.agent.findUnique({
          where: { key: options.agentKey },
          select: { boundaryViolations: true, status: true, name: true },
        });
        if (updatedAgent?.boundaryViolations >= 3) {
          // Suspend the agent after 3 consecutive violations
          await prisma.agent.update({
            where: { key: options.agentKey },
            data: { status: "PAUSED" },
          });
          return {
            allowed: false,
            mustDryRun: false,
            reason: `${agent.name} has been suspended after 3 consecutive boundary violations. Requires human review.`,
          };
        }
        return {
          allowed: false,
          mustDryRun: false,
          reason: `${agent.name} is not responsible for ${tool.key}. (boundary violation ${updatedAgent?.boundaryViolations}/3 recorded)`,
        };
      }
    }
  }

  // A spend ceiling the Owner set, and the only check here an approval cannot
  // lift. Deliberately **only for a tool that spends** — a blanket hold would
  // stop an agent reading a record, which blinds it without saving a penny and
  // is the mistake `rehearsals/policy.ts` argues out at length.
  //
  // A hard limit refuses outright, before the approval bypass below, for the
  // same reason readiness and the grant are checked before it: approving a
  // letter is a decision about the letter, not a decision to go over budget,
  // and the sentence that comes back says what the ceiling is so it can be
  // raised and the card approved again.
  if (tool.spends) {
    const budget = await check(scopesForTool(tool.key, options.agentKey));
    if (budget.action === "pause") {
      return { allowed: false, mustDryRun: false, reason: budget.note ?? "This is over its spending ceiling." };
    }
    // At 90% the work is prepared instead — which is the machinery that already
    // exists for an agent below the spend autonomy level, reused rather than
    // reinvented. Not applied to an already-approved call, or a card could
    // never be carried out at all and the queue would fill with re-asks.
    if (budget.action === "approve" && !options.approvedRequestId) {
      return { allowed: true, mustDryRun: true, reason: budget.note ?? "Close to a spending ceiling, so this is prepared for a decision." };
    }
  }

  // A person has already looked at this exact call and said yes. Everything
  // above still had to pass — the agent exists, is not paused, still holds the
  // tool, and is not over a hard ceiling — and it is only the "prepare rather
  // than act" downgrade below that the approval lifts. Without this the queue
  // could file an action and never carry one out, which is the state the app
  // was already in.
  if (options.approvedRequestId) return { allowed: true, mustDryRun: false, reason: null };

  // The agent's own dry-run flag is a floor, not a default: an Owner asking for
  // a real run cannot switch it off from the call site.
  //
  // `scope === "send"` is in here as well as `outward`, and it is not
  // redundant. `slack.send` is the one tool in the catalogue that sends
  // something without being outward — it goes to our own team rather than to a
  // client — so it fell through all three tests and would have posted for real
  // from an agent whose card says dry run. A tool whose scope is "send" is
  // doing the thing by definition; that is the whole of the test.
  if (agent.dryRun && (tool.outward || tool.spends || tool.scope === "write" || tool.scope === "send")) {
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
    const callId = await record({ tool: key, options, ok: false, refusedReason: `There is no tool called ${key}.`, durationMs: 0 });
    return refusal(key, `There is no tool called ${key}.`, 0, callId);
  }

  const readiness = await toolReadiness(tool.requires);
  if (!readiness.ready) {
    const callId = await record({ tool: key, options, ok: false, refusedReason: readiness.reason, durationMs: Date.now() - startedAt });
    return refusal(key, readiness.reason ?? "That tool isn't configured yet.", Date.now() - startedAt, callId);
  }

  const permission = await permissionFor(tool, options);
  if (!permission.allowed) {
    const callId = await record({ tool: key, options, ok: false, refusedReason: permission.reason, durationMs: Date.now() - startedAt });
    return refusal(key, permission.reason ?? "Not permitted.", Date.now() - startedAt, callId);
  }

  const parsed = tool.input.safeParse(rawInput ?? {});
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ");
    const callId = await record({ tool: key, options, ok: false, error: detail, input: rawInput, durationMs: Date.now() - startedAt });
    return { tool: key, callId, ok: false, output: null, dryRun: false, error: `That input isn't right — ${detail}`, costUsd: 0, durationMs: Date.now() - startedAt };
  }

  const dryRun = permission.mustDryRun;
  const context: ToolContext = { agentKey: options.agentKey, userId: options.userId, dryRun };

  if (dryRun) {
    // A tool that can't say what it would do must not be dry-run into silently
    // doing it, and must not report success for work that never happened.
    if (!tool.preview) {
      const reason = `${tool.name} can't be previewed, and a dry run must not carry it out.`;
      const callId = await record({ tool: key, options, ok: false, refusedReason: reason, input: parsed.data, durationMs: Date.now() - startedAt });
      return refusal(key, reason, Date.now() - startedAt, callId);
    }
    let wouldDo: string;
    try {
      wouldDo = await tool.preview(parsed.data, context);
    } catch (err) {
      wouldDo = `Couldn't work out what this would do: ${(err as Error).message}`;
    }
    const durationMs = Date.now() - startedAt;
    const callId = await record({ tool: key, options, ok: true, dryRun: true, input: parsed.data, output: { wouldDo }, durationMs });

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
        rehearsal: options.rehearsal ?? false,
      });
    }

    return {
      tool: key,
      callId,
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

  // Has this exact call already happened? Only asked for outward tools, and
  // only when the caller supplied a key — see `idempotencyKey` above for why
  // the caller rather than this function decides what "the same call" means.
  //
  // Checked here rather than before the permission gate on purpose: a replay
  // that no longer has the grant, or whose integration has been disconnected,
  // must be refused like any other call. Being a repeat is not a way past the
  // checks.
  if (options.idempotencyKey && tool.outward) {
    const already = await priorCall(options.idempotencyKey);
    if (already) {
      const durationMs = Date.now() - startedAt;
      const callId = await record({
        tool: key,
        options,
        ok: true,
        input: parsed.data,
        output: { replayed: true, of: already.id, at: already.createdAt },
        durationMs,
      });
      return {
        tool: key,
        callId,
        ok: true,
        output: already.output as never,
        dryRun: false,
        replayed: true,
        costUsd: 0,
        durationMs,
      };
    }
  }

  try {
    const output = await tool.run(parsed.data, context);
    const durationMs = Date.now() - startedAt;
    const costUsd = await priceOf(tool, output);
    const callId = await record({ tool: key, options, ok: true, input: parsed.data, output, costUsd, durationMs });
    return { tool: key, callId, ok: true, output, dryRun: false, costUsd, durationMs };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const message = (err as Error).message ?? "The tool failed.";
    const callId = await record({ tool: key, options, ok: false, input: parsed.data, error: message, durationMs });
    return { tool: key, callId, ok: false, output: null, dryRun: false, error: message, costUsd: 0, durationMs };
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
  rehearsal: boolean;
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
        rehearsal: entry.rehearsal,
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
    //
    // Never for a rehearsal. Nine agents rehearsing against one company would
    // fill the channel with Approve buttons for letters to a business nobody
    // has decided to write to, and the one card that mattered that morning
    // would be somewhere above them.
    if (!entry.rehearsal) {
      void import("../approvalCards.js")
        .then(({ postApprovalCard }) => postApprovalCard(request.id))
        .catch((err: Error) => console.error("[tools] could not post the approval card:", err.message));
    }

    return request.id;
  } catch (err) {
    console.error(`[tools] could not file an approval for ${entry.tool}:`, (err as Error).message);
    return undefined;
  }
}

/**
 * The earlier call this one would repeat, if there is one.
 *
 * Successful and not a dry run, because those are the only ones that had an
 * effect worth not having twice. A previous refusal, failure or preview sharing
 * the key is a true part of the history and must not stop the real attempt —
 * which is exactly the case that matters: a run interrupted after preparing an
 * email and resumed once its autonomy was raised has a dry-run row with this
 * key on it, and the letter still needs to go.
 */
async function priorCall(idempotencyKey: string) {
  return prisma.toolCall.findFirst({
    where: { idempotencyKey, ok: true, dryRun: false },
    orderBy: { createdAt: "asc" },
    select: { id: true, output: true, createdAt: true },
  });
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

function refusal(tool: string, reason: string, durationMs: number, callId?: string): ToolResult {
  return { tool, callId, ok: false, output: null, dryRun: false, refusedReason: reason, error: reason, costUsd: 0, durationMs };
}

/** Trims a value so one enormous tool result can't fill the database. */
function trim(value: unknown): unknown {
  if (value === undefined) return undefined;
  const json = JSON.stringify(value);
  if (json === undefined) return null;
  if (json.length <= 20_000) return JSON.parse(json);
  return { truncated: true, preview: json.slice(0, 2000) };
}

/**
 * Writes the audit row and hands back its id.
 *
 * Returning the id is what lets a caller join its own record to this one —
 * `AgentTaskStep.toolCallId` was declared and documented as that join from the
 * day the runtime shipped, and stayed empty because nothing gave the id back.
 *
 * Attribution comes from the caller first and the ambient run second
 * (`lib/runContext.ts`), so a tool driven straight from the API records no task
 * and one called mid-run records the run that called it.
 */
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
}): Promise<string | undefined> {
  try {
    const where = attribution({ taskId: entry.options.taskId, agentKey: entry.options.agentKey });
    const row = await prisma.toolCall.create({
      data: {
        tool: entry.tool,
        agentKey: entry.options.agentKey,
        userId: entry.options.userId,
        taskId: where.taskId,
        traceId: where.traceId,
        idempotencyKey: entry.options.idempotencyKey ?? null,
        input: trim(entry.input) as never,
        output: trim(entry.output) as never,
        ok: entry.ok,
        dryRun: entry.dryRun ?? false,
        error: entry.error ?? null,
        refusedReason: entry.refusedReason ?? null,
        costUsd: entry.costUsd ?? 0,
        durationMs: entry.durationMs,
      },
      select: { id: true },
    });
    return row.id;
  } catch (err) {
    // The audit trail failing must not fail the work it was recording, but it
    // is worth shouting about — an agent acting with no record is the thing
    // this table exists to prevent.
    console.error(`[tools] could not record a ${entry.tool} call:`, (err as Error).message);
    return undefined;
  }
}

/** The ceiling on a single spending call, from Settings. Null means no ceiling. */
export async function maxCallSpend(): Promise<number | null> {
  const raw = await getSetting(SETTING.AGENT_MAX_CALL_USD);
  const parsed = Number.parseFloat(raw ?? "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
