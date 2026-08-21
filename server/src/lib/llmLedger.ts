import { prisma } from "./prisma.js";
import { attribution } from "./runContext.js";

/**
 * Every model call the app makes, priced and written down.
 *
 * There were two identical copies of this — one in `claude.ts`, one in
 * `claudeAgent.ts` — and adding a third provider would have made four. It is
 * one function now because the ledger has to be the same shape whichever
 * vendor served the request: the question the Owner asks is "what did this
 * month cost and which feature spent it", and an answer that only covers
 * Anthropic is not an answer.
 *
 * **Never throws.** Accounting must not fail the work it is accounting for. A
 * failed write goes to stdout and the feature carries on — a missing ledger
 * row is a gap in a report; a failed proposal is a failed proposal.
 */
export interface LedgerEntry {
  /** What asked for it: "email.draft", "content.humanise", "agent.cro". */
  purpose: string;
  /**
   * The run this belongs to, when the caller knows.
   *
   * Usually it does not, and does not need to: most model calls happen several
   * frames below anything holding a task id — a writer inside a tool handler
   * inside an agent's loop — so this falls through to the ambient run context
   * (`runContext.ts`) that the runner sets once around the whole task. Passing
   * it explicitly is for the caller that knows better than the ambient one.
   */
  taskId?: string | null;
  agentKey?: string | null;
  traceId?: string | null;
  /** The model that actually served it, as the API reported it. */
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUsd: number;
  durationMs: number;
  effort?: string;
  stopReason?: string | null;
  ok: boolean;
  error?: string;
}

export async function recordLlmCall(entry: LedgerEntry): Promise<void> {
  try {
    const where = attribution({ taskId: entry.taskId, agentKey: entry.agentKey, traceId: entry.traceId });
    await prisma.llmCall.create({
      data: {
        purpose: entry.purpose,
        model: entry.model,
        taskId: where.taskId,
        agentKey: where.agentKey,
        traceId: where.traceId,
        inputTokens: entry.inputTokens,
        outputTokens: entry.outputTokens,
        cacheReadTokens: entry.cacheReadTokens ?? 0,
        cacheCreationTokens: entry.cacheCreationTokens ?? 0,
        costUsd: entry.costUsd.toFixed(6),
        durationMs: entry.durationMs,
        effort: entry.effort ?? null,
        stopReason: entry.stopReason ?? null,
        ok: entry.ok,
        error: entry.error ?? null,
      },
    });
  } catch (err) {
    console.error("[llm] could not record spend:", (err as Error).message);
  }
}
