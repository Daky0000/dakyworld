import { createHash } from "node:crypto";

/**
 * What makes a repeat of this exact call the same call.
 *
 * Task, tool and a hash of the arguments. Scoped to the task on purpose:
 * within one run, asking twice for the same send is always a replay — a
 * resumed half-finished turn, a retried claim — and across runs it may well be
 * a second letter somebody meant to send. `invokeTool` only ever acts on it
 * for outward tools, and only when a caller supplies one, because two
 * identical sends can be two correct sends.
 *
 * The keys are sorted before hashing, because a model does not emit its object
 * properties in a stable order and two spellings of one payload must not read
 * as two different calls.
 *
 * **It lives here rather than in the runner because two callers derive it.**
 * The runner does, on the way into a tool. And `approvals.approve()` does, on
 * the way into the *same* tool weeks later — because carrying out a prepared
 * action is that call happening, not a new one. While that second caller
 * passed nothing, an approved-and-executed send left a `ToolCall` with a null
 * key, so the guard could not see it: the task that prepared the letter could
 * be resumed at a higher autonomy and send it again, and a duplicate card
 * approved twice was two letters. Two copies of one hashing rule would have
 * been one copy away from two different rules, which is the failure this
 * codebase has already had over `vendorBase`.
 */
export function outwardKey(taskId: string, toolKey: string, input: unknown): string {
  const canonical = JSON.stringify(input, (_k, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : value,
  );
  const digest = createHash("sha256").update(canonical ?? "null").digest("hex").slice(0, 32);
  return `${taskId}:${toolKey}:${digest}`;
}
