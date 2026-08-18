import { prisma } from "./prisma.js";

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
    await prisma.llmCall.create({
      data: {
        purpose: entry.purpose,
        model: entry.model,
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
