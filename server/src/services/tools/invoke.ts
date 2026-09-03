import { prisma } from "../../lib/prisma.js";
import { attribution } from "../../lib/runContext.js";
import { SETTING, getSetting } from "../../lib/settings.js";
import { resolveTool } from "./catalogue.js";
import { check, scopesForTool } from "../budgets.js";
import { devToolMock } from "./devMode.js";
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
export const EXECUTE_LEVEL = 3;
/** Spending needs one level above executing: money is the harder mistake to undo. */
export const SPEND_LEVEL = 4;

/**
 * Boundary crossings in a row before an agent is paused for somebody to look at.
 *
 * **In a row**, and that word is load-bearing: `invokeTool` clears the count on
 * the agent's next call that the gate allows. Without that it was a lifetime
 * tally, so an agent that crossed a boundary once a quarter was silently paused
 * on its third occasion — months apart — under a message claiming three
 * consecutive violations. A count that never resets is not a strike system, it
 * is a slow fuse.
 */
const BOUNDARY_STRIKES = 3;

/**
 * The first `not_responsible` pattern this tool key crosses, or null.
 *
 * A glob rather than a regex, and deliberately so. The first version compiled
 * each pattern with `new RegExp` after replacing `*` with `.*` and escaping
 * nothing else, which is wrong twice: the unescaped `.` in `lead.update` also
 * matches any character, and a pattern carrying a `(` — which the Agent
 * Creator can write, since a hired agent's boundaries come from an approved
 * design rather than from a seed — throws a `SyntaxError` out of the
 * permission gate. That exception is not thrown for the agent that owns the
 * bad pattern; it is thrown inside `permissionFor`, which every tool call in
 * the system passes through.
 *
 * `*` is the only wildcard. It matches any run of characters, including none.
 */
function boundaryCrossed(patterns: string[], toolKey: string): string | null {
  return patterns.find((pattern) => matchesGlob(pattern, toolKey)) ?? null;
}

/**
 * Exported so `checks/roster.ts` asserts the seeds against the matcher that
 * actually runs. A second copy of this rule in the harness is a harness that
 * goes on passing after the real one changes.
 */
export function matchesGlob(pattern: string, value: string): boolean {
  const parts = pattern.split("*");
  if (parts.length === 1) return pattern === value;

  const head = parts[0];
  const tail = parts[parts.length - 1];
  if (!value.startsWith(head) || !value.endsWith(tail)) return false;

  let at = head.length;
  for (const part of parts.slice(1, -1)) {
    const found = value.indexOf(part, at);
    if (found === -1) return false;
    at = found + part.length;
  }
  // The head and the tail must not overlap each other: "aa*aa" needs four
  // characters and must not be satisfied by "aaa". (`a*b` matching `ab` is
  // correct — a `*` matches nothing at all.)
  return at <= value.length - tail.length;
}

export class ToolRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolRefused";
  }
}

/**
 * `taskId` is optional here and required on `ToolContext`, so it is omitted
 * and redeclared: a route calling a tool directly has no task, and every
 * handler that reads one should get `null` rather than `undefined`.
 */
export interface InvokeOptions extends Omit<ToolContext, "taskId"> {
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
   * This call is one a previous run of the task may already have made.
   *
   * Set by the runner for the calls inside a turn a resume restored, and for
   * nothing else. It widens `idempotencyKey` from outward tools to **every**
   * tool, which is the right reading for exactly that window: the crash the
   * checkpoint cannot cover is a tool that ran and was never written down, and
   * the tools most often lost that way are not outward at all. They are the
   * ones that spend money without leaving the building — a capture run, a
   * homepage photographed, a section of an audit — and the ones that write a
   * row a person then finds twice, like `proposal.draft`.
   *
   * Deliberately not the default. Outside that window two identical calls can
   * both be meant — a page looked at again after it was changed is the case —
   * and a replay guard on every call would answer the second one with the
   * first one's stale output. See `AgentToolCallMeta` in `lib/claudeAgent.ts`.
   */
  replayOfLostTurn?: boolean;
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
  /**
   * Set when this refusal is a boundary crossing, and holding the sentence
   * that says which one — a forbidden tool, or a forbidden subject.
   *
   * Reported rather than acted on, because **this function is a question, not
   * an event.** The Agents and Tools screens call it once per tool per agent
   * purely to draw a roster — see `routes/agents.ts` — so a version of it that
   * counted a strike and paused the agent would pause `cro` the moment somebody
   * opened its page and three forbidden tools appeared in the listing. Nobody
   * would have called a tool. The strike belongs to `invokeTool`, where an
   * agent has actually tried something.
   */
  boundaryCrossing?: string;
  /**
   * Strikes standing against this agent when the question was asked.
   *
   * Carried out so `invokeTool` can clear them on an allowed call without
   * reading the row a second time — the agent is already loaded here.
   */
  boundaryStrikes?: number;
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

  // The work this agent is explicitly not responsible for, in tool keys.
  //
  // Seeded from `AgentSeed.not_responsible` and carried onto the row by
  // `ensureAgents()` and `refreshUneditedSeedPrompts()`. Until Aug 2026 neither
  // of those wrote the column, so this read an empty array on every agent on
  // every database and had never once fired — the enforcement was correct,
  // shipped, documented, and unreachable.
  //
  // Answered here and acted on in `invokeTool`. See `boundaryPattern`.
  const crossed = boundaryCrossed(agent.not_responsible, tool.key);
  if (crossed) {
    const sentence = `${agent.name} is not responsible for ${tool.key} (matched "${crossed}").`;
    return { allowed: false, mustDryRun: false, reason: sentence, boundaryCrossing: sentence, boundaryStrikes: agent.boundaryViolations };
  }

  // The other half of a boundary: not what is being done, but who it is being
  // done about. A tool key cannot say this — `email.draft` is the right tool
  // for a stranger and for a client of two years, and what separates them is
  // the record the task hangs off.
  //
  // Read only when the agent actually declares one, so every other agent pays
  // nothing for the feature. A call with no task behind it is not refused:
  // there is no subject to be wrong about.
  if (agent.not_responsible_subject.length > 0 && options.taskId) {
    const forbidden = await forbiddenSubject(options.taskId, agent.not_responsible_subject);
    if (forbidden) {
      const sentence =
        `${agent.name} is not responsible for work about a ${forbidden}, and this task is about one. ` +
        `Hand it to whoever is, or escalate.`;
      return { allowed: false, mustDryRun: false, reason: sentence, boundaryCrossing: sentence, boundaryStrikes: agent.boundaryViolations };
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

  return { allowed: true, mustDryRun: options.dryRun, reason: null, boundaryStrikes: agent.boundaryViolations };
}

/**
 * The first subject this task carries that the agent must not work on.
 *
 * A task can carry several at once — the mail router sets `leadId` and
 * `clientId` together when a message matches both, and a delegated child
 * inherits the pair. That is deliberately a crossing rather than an excuse: a
 * lead that is also a client is a client, and the point of this boundary is
 * that the Cold Lead Writer must not open a first message to one.
 */
async function forbiddenSubject(taskId: string, forbidden: string[]): Promise<string | null> {
  const task = await prisma.agentTask.findUnique({
    where: { id: taskId },
    select: { leadId: true, clientId: true, projectId: true, proposalId: true, invoiceId: true },
  });
  if (!task) return null;

  const carried: [string, string | null][] = [
    ["lead", task.leadId],
    ["client", task.clientId],
    ["project", task.projectId],
    ["proposal", task.proposalId],
    ["invoice", task.invoiceId],
  ];
  return carried.find(([kind, id]) => id && forbidden.includes(kind))?.[0] ?? null;
}

/**
 * Counts a crossing, pauses on the third in a row, and says which it was.
 *
 * Separate from `permissionFor` because it writes. Reached only from
 * `invokeTool`, so only a real attempt to call a tool counts against an agent.
 */
async function countBoundaryCrossing(agentKey: string, toolKey: string, sentence: string): Promise<string> {
  const after = await prisma.agent.update({
    where: { key: agentKey },
    data: { boundaryViolations: { increment: 1 } },
    select: { boundaryViolations: true, name: true },
  });

  if (after.boundaryViolations < BOUNDARY_STRIKES) {
    return `${sentence} Crossing ${after.boundaryViolations} of ${BOUNDARY_STRIKES} before it is paused.`;
  }

  await prisma.agent.update({ where: { key: agentKey }, data: { status: "PAUSED" } });
  // What was crossed is named, here and in the sentence above. A paused agent
  // whose card says nothing about why is the "fixable setting rendering as
  // Something went wrong" failure this codebase has a rule about — and the fix
  // is more often to correct the boundary than to scold the agent.
  return (
    `${sentence} That is ${BOUNDARY_STRIKES} boundary crossings in a row, the last of them on ${toolKey}, so ` +
    `${after.name} has been paused. Either the boundary is wrong or the work is being sent to the wrong agent. ` +
    `Setting it back to Active on the Agents screen clears the count.`
  );
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
    // A boundary refusal is the one that has a consequence attached. Counted
    // here rather than inside the gate, so that drawing the Agents screen —
    // which asks the same question once per tool — costs an agent nothing.
    const reason =
      permission.boundaryCrossing && options.agentKey
        ? await countBoundaryCrossing(options.agentKey, key, permission.boundaryCrossing)
        : permission.reason;
    // No separate boundary marker on the row: `refusedReason` names the tool
    // and the pattern it matched, which is what somebody reading the ledger
    // needs. A flag with no column behind it was there before and recorded
    // nothing.
    const callId = await record({ tool: key, options, ok: false, refusedReason: reason, durationMs: Date.now() - startedAt });
    return refusal(key, reason ?? "Not permitted.", Date.now() - startedAt, callId);
  }

  // What makes the strikes consecutive: a call this agent was allowed to make
  // clears the count. Without it, three crossings months apart add up to a
  // suspension under a message claiming three in a row.
  //
  // The count came out of the gate with the permission, so this writes only
  // when there is something to clear and never reads the row again.
  if (options.agentKey && (permission.boundaryStrikes ?? 0) > 0) {
    await prisma.agent.update({ where: { key: options.agentKey }, data: { boundaryViolations: 0 } });
  }

  const parsed = tool.input.safeParse(rawInput ?? {});
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ");
    const callId = await record({ tool: key, options, ok: false, error: detail, input: rawInput, durationMs: Date.now() - startedAt });
    return { tool: key, callId, ok: false, output: null, dryRun: false, error: `That input isn't right — ${detail}`, costUsd: 0, durationMs: Date.now() - startedAt };
  }

  const dryRun = permission.mustDryRun;
  const context: ToolContext = { agentKey: options.agentKey, userId: options.userId, taskId: options.taskId ?? null, dryRun };

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

    // Why this stopped, in one sentence, and never blank.
    //
    // `permissionFor` returns no reason when the *caller* asked for the dry run
    // rather than the agent's card forcing it — which in a rehearsal is the
    // guarantee itself. So the one call a rehearsal is actually built to hold
    // was the one that came back unexplained, and the screen filled the silence
    // with the wrong answer: it labelled every prepared call outward, including
    // the internal research an agent simply had not been allowed to run.
    //
    // The rehearsal's floor is named first when it applies, because it binds
    // whatever the card says — an agent at autonomy 5 with dry run off still
    // stops here.
    const heldBecause =
      options.dryRun && options.rehearsal
        ? "This would have left the building, and a rehearsal holds every one of those at a preview whatever the agent's autonomy says."
        : (permission.reason ?? null);

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
        heldBecause,
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
      refusedReason: heldBecause ?? undefined,
      actionRequestId: requestId,
      costUsd: 0,
      durationMs,
    };
  }

  // Has this exact call already happened? Asked for outward tools always, and
  // for every tool when the runner says this call is one a dead process may
  // already have made — and in both cases only when the caller supplied a key,
  // since the caller rather than this function decides what "the same call"
  // means. See `replayOfLostTurn` above for why those are two different tests
  // rather than one.
  //
  // Checked here rather than before the permission gate on purpose: a replay
  // that no longer has the grant, or whose integration has been disconnected,
  // must be refused like any other call. Being a repeat is not a way past the
  // checks.
  if (options.idempotencyKey && (tool.outward || options.replayOfLostTurn)) {
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

  // The other half of `DEV_MODE`, and it is not optional — see the note on
  // `Readiness.mocked`. The readiness gate above let this through because
  // nothing is connected and DEV_MODE is standing in; running the handler now
  // would call a client with no credentials, which either throws something
  // unrelated to what an agent did wrong or, on a half-configured account,
  // really sends.
  //
  // Deliberately below every gate rather than above them. The grant, the
  // autonomy level, the boundary and the schema all still decide, so a run
  // with DEV_MODE on exercises the same refusals as a real one — the only
  // thing standing in is the integration itself. And it is below the dry-run
  // branch too: previewing a call is the *real* behaviour of an agent under
  // its autonomy level, and a preview is worth having whether or not the
  // credential exists.
  //
  // `ok: true` with `devMode` in the output, never a silent success: every
  // stand-in carries a sentence saying nothing left the building, because an
  // agent summarising "I sent it" about a mock is the one failure mode of this
  // switch that reaches a person as a lie.
  if (readiness.mocked) {
    const output = devToolMock(tool.requires).output;
    const durationMs = Date.now() - startedAt;
    const callId = await record({ tool: key, options, ok: true, input: parsed.data, output, durationMs });
    return { tool: key, callId, ok: true, output: output as never, dryRun: false, costUsd: 0, durationMs };
  }

  try {
    const output = await tool.run(parsed.data, context);
    const durationMs = Date.now() - startedAt;
    const costUsd = await priceOf(tool, output);
    const callId = await record({ tool: key, options, ok: true, input: parsed.data, output, costUsd, durationMs });
    return { tool: key, callId, ok: true, output, dryRun: false, costUsd, durationMs };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const message = toolErrorMessage(err);
    const callId = await record({ tool: key, options, ok: false, input: parsed.data, error: message, durationMs });
    return { tool: key, callId, ok: false, output: null, dryRun: false, error: message, costUsd: 0, durationMs };
  }
}

/**
 * A tool that names its own failure gets the name carried through.
 *
 * An agent reading "Google Maps capture is switched off" has to infer whether
 * that is worth trying again, worth working around, or worth escalating; an
 * agent reading "ACTOR_DISABLED — Google Maps capture is switched off" does
 * not. The code goes into the `ToolCall` row too, which is what makes "how
 * often does this refuse, and for which reason" a query rather than a grep
 * over prose.
 *
 * Anything with an upper-case `code` qualifies, not only this app's own
 * errors: a Node `ECONNREFUSED` and a Prisma `P2002` are exactly as worth
 * naming, and both are otherwise a sentence that could have come from
 * anywhere.
 */
function toolErrorMessage(err: unknown): string {
  const message = (err as Error)?.message ?? "The tool failed.";
  const code = (err as { code?: unknown })?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{2,}$/.test(code) ? `${code} — ${message}` : message;
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
