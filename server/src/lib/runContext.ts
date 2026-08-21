import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Who is working, for anything deep enough in a call stack not to have been
 * told.
 *
 * The audit trail had a hole with a specific shape. `invokeTool` is handed a
 * `taskId` and writes a `ToolCall`; fine. But a tool handler calls a writer,
 * and the writer calls a model, and `recordLlmCall` is four frames below
 * anything that knows whose work this is — so every model call in the system
 * was attributed by a free-text `purpose` string and nothing else. Spend could
 * be grouped by feature and never traced to the run that caused it.
 *
 * The alternative was threading `taskId` through every writer, every model
 * adapter and every tool handler: forty signatures, each of which is one
 * forgetful edit away from a silent gap in the ledger. This is one store, set
 * once by the runner around the whole task, read by the two functions that
 * write audit rows.
 *
 * **An explicit argument always wins.** The store is a fallback for callers
 * that could not know, never an override of a caller that does — an approval
 * carrying out a request months later passes its own `taskId`, and must not
 * pick up whatever task happens to be running in the same process.
 *
 * **Nothing here may change behaviour.** It carries attribution and nothing
 * else: no permissions, no limits, no identity a check could read. Ambient
 * state that decides what is *allowed* is the kind nobody can review at the
 * call site, which is why the agent key here is for labelling a ledger row and
 * the grant is still read from the `Agent` row inside `permissionFor`.
 */

export interface RunContext {
  /** The `AgentTask` being worked on. */
  taskId: string;
  /** Its trace, which outlives it. */
  traceId: string;
  /** The agent doing the work. */
  agentKey: string;
}

const storage = new AsyncLocalStorage<RunContext>();

/**
 * Runs `work` with this context attached to everything it awaits.
 *
 * Nested calls replace it wholesale rather than merging — a delegated child
 * task running inside its parent's frame is its own piece of work and its rows
 * belong to it.
 */
export function withRunContext<T>(context: RunContext, work: () => Promise<T>): Promise<T> {
  return storage.run(context, work);
}

/** The context, when there is one. Null for a person driving a tool directly. */
export function currentRun(): RunContext | null {
  return storage.getStore() ?? null;
}

/**
 * Attribution for an audit row: what the caller said, then what is ambient.
 *
 * `undefined` means "I wasn't told" and falls through to the store; `null`
 * means "I know there is none" and does not. That distinction is why an
 * approval executing outside any task does not inherit one.
 */
export function attribution(explicit?: {
  taskId?: string | null;
  agentKey?: string | null;
  traceId?: string | null;
}): {
  taskId: string | null;
  traceId: string | null;
  agentKey: string | null;
} {
  const ambient = currentRun();
  const taskId = explicit?.taskId !== undefined ? explicit.taskId : (ambient?.taskId ?? null);
  const agentKey = explicit?.agentKey !== undefined ? explicit.agentKey : (ambient?.agentKey ?? null);
  // The trace belongs to the task, so an ambient one only comes along when the
  // ambient task is the one being recorded. A caller working on a task it was
  // told about — the approval queue carrying out a request weeks later — knows
  // the trace and passes it.
  const traceId =
    explicit?.traceId !== undefined
      ? explicit.traceId
      : taskId && ambient?.taskId === taskId
        ? ambient.traceId
        : null;
  return { taskId, traceId, agentKey };
}
