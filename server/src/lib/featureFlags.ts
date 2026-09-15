import { SETTING, getSetting, setSetting } from "./settings.js";

/**
 * Whether a half-built capability is switched on yet.
 *
 * There is no flag service here and there should not be one: `settings.ts`
 * already gives a flag everything it needs — a value in the database, an env
 * variable that beats it, and a cache. This is the thin layer that spells
 * those three as a boolean, and nothing else.
 *
 * **Why the env override is the point rather than a nicety.** A flag exists so
 * that a capability which misbehaves in production can be turned off by
 * somebody who is not waiting on a build. Setting `FLAG_SLACK_QUEUE=false` in
 * Railway and restarting is thirty seconds; a revert, a deploy and a migration
 * is half an hour, during which the thing is still misbehaving.
 *
 * **On by default is wrong here.** Every flag below reads false unless
 * something says otherwise, because each of them fronts a path that changes
 * how work already in flight behaves. A release that arrives switched on has
 * no rollback that is not a deploy.
 */

export const FLAG = {
  /** Outgoing Slack messages go through the durable queue rather than straight out. */
  SLACK_QUEUE: SETTING.FLAG_SLACK_QUEUE,
  /** A request may carry a shared purse that every operation reserves against. */
  REQUEST_BUDGETS: SETTING.FLAG_REQUEST_BUDGETS,
  /** The bot answers plain messages, not only slash commands. */
  SLACK_CONVERSATIONS: SETTING.FLAG_SLACK_CONVERSATIONS,
  /** Staged work with dependencies between the stages. */
  WORKFLOWS: SETTING.FLAG_WORKFLOWS,
  /** Output is recorded as a versioned deliverable and checked before a person sees it. */
  DELIVERABLES: SETTING.FLAG_DELIVERABLES,
  /** Agent instructions are kept as immutable versions. */
  PROMPT_VERSIONS: SETTING.FLAG_PROMPT_VERSIONS,
  /** The performance dashboard. */
  AGENT_DASHBOARD: SETTING.FLAG_AGENT_DASHBOARD,
} as const;

export type FlagKey = (typeof FLAG)[keyof typeof FLAG];

export const ALL_FLAGS: FlagKey[] = Object.values(FLAG);

/**
 * One process, one cache, thirty seconds — the same arrangement `budgets.ts`
 * uses and for the same reason. A flag is read on nearly every path that has
 * one, and a database round trip per read would make the flag itself the cost.
 * Thirty seconds is the delay between switching one off and it taking hold,
 * which is a fair price for not asking the question ten thousand times a minute.
 */
const CACHE_MS = 30_000;
const cache = new Map<string, { on: boolean; at: number }>();

export function forgetFlags(): void {
  cache.clear();
}

function truthy(raw: string | null): boolean {
  if (!raw) return false;
  const value = raw.trim().toLowerCase();
  return value === "true" || value === "1" || value === "on" || value === "yes";
}

export async function flagOn(flag: FlagKey): Promise<boolean> {
  const hit = cache.get(flag);
  const now = Date.now();
  if (hit && now - hit.at < CACHE_MS) return hit.on;
  const on = truthy(await getSetting(flag));
  cache.set(flag, { on, at: now });
  return on;
}

export async function setFlag(flag: FlagKey, on: boolean): Promise<void> {
  await setSetting(flag, on ? "true" : "false");
  cache.delete(flag);
}

export async function readFlags(): Promise<Record<string, boolean>> {
  const entries = await Promise.all(ALL_FLAGS.map(async (flag) => [flag, await flagOn(flag)] as const));
  return Object.fromEntries(entries);
}
