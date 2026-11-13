import type { Prisma } from "@prisma/client";
import { SETTING, getSetting } from "../../lib/settings.js";
import { agentMode } from "./orchestrator.js";

/**
 * How many tasks one skill may work at once, and which ones may share it.
 *
 * The rule used to be one: an agent took one task at a time, enforced inside
 * the claim. The reason was memory — an agent writes what it concluded as it
 * goes and reads it back on its next task about the same subject, so two
 * tasks about one lead running side by side interleave those writes and the
 * agent contradicts itself, with nothing on the timeline to show why.
 *
 * That reason is about **a record**, and the rule was about **an agent**. Five
 * first letters to five different companies never touch the same record, and
 * under one orchestrator they are not five agents' work either — yet they ran
 * in a row, each waiting for the one before it, while five other skills sat
 * idle beside them. So in orchestrator mode a skill may work several tasks at
 * once, on these terms:
 *
 * - **Never two about the same record.** A task shares a record with another
 *   when any of its lead, client, project, proposal or invoice is the same.
 *   That is the whole of the original guarantee, kept exactly.
 * - **A task about no record has the skill to itself.** Standing work and an
 *   Owner's errand name no record on the row and may touch many — the morning
 *   batch writes to a dozen leads — so nothing can be said about what it will
 *   not collide with. It neither starts beside other work nor lets other work
 *   start beside it.
 * - **Up to a ceiling per skill** (`agents.perSkillTasks`, three unless set),
 *   inside the process-wide ceiling, which is unchanged. This moves which
 *   tasks fill the slots; it does not add slots, so it asks no more of a
 *   free model tier than before.
 *
 * On the roster the answer is still one, and the suite that holds the roster's
 * rules runs there. `AGENTS_PER_SKILL=1` puts orchestrator mode back to one
 * with no deploy.
 */

export const DEFAULT_PER_SKILL = 3;
const MAX_PER_SKILL = 6;

/** The ceiling for one skill. Zero and nonsense read as the default, never as "none". */
export async function perSkillLimit(): Promise<number> {
  const raw = (await getSetting(SETTING.AGENT_PER_SKILL))?.trim();
  if (raw && /^\d+$/.test(raw)) {
    const parsed = Number(raw);
    if (parsed >= 1) return Math.min(parsed, MAX_PER_SKILL);
  }
  return (await agentMode()) === "orchestrator" ? DEFAULT_PER_SKILL : 1;
}

export interface TaskRecords {
  leadId: string | null;
  clientId: string | null;
  projectId: string | null;
  proposalId: string | null;
  invoiceId: string | null;
}

const RECORD_FIELDS = ["leadId", "clientId", "projectId", "proposalId", "invoiceId"] as const;

/** The records a task is about, as `field:id`. Empty for a task about none. */
export function recordsOf(task: TaskRecords): string[] {
  return RECORD_FIELDS.flatMap((field) => (task[field] ? [`${field}:${task[field]}`] : []));
}

/**
 * Whether a task may start beside what its skill is already working. Pure.
 *
 * `active` is one entry per running task of the same skill: the records it is
 * about. This is the tick's answer; the claim asks the database the same
 * question (`claimGuard`), so two processes cannot both win.
 */
export function mayStartBeside(mine: string[], active: string[][], limit: number): boolean {
  if (active.length === 0) return true;
  if (limit <= 1 || active.length >= limit) return false;
  if (mine.length === 0) return false;
  return active.every((other) => other.length > 0 && !other.some((record) => mine.includes(record)));
}

/**
 * The condition a claim is made under, for the database to arbitrate.
 *
 * At a ceiling of one, or for a task about no record: nothing of this skill is
 * running — the rule as it always was. Otherwise: nothing of this skill is
 * running that is about no record, or about any record this task is about.
 * The count against the ceiling is not in here — a relation filter cannot
 * count — and is read just before the claim instead; being one over for a
 * moment costs nothing, being two tasks deep in one lead does.
 */
export function claimGuard(task: TaskRecords, limit: number): Prisma.AgentTaskWhereInput {
  const mine = RECORD_FIELDS.flatMap((field) => (task[field] ? [{ [field]: task[field] } as Prisma.AgentTaskWhereInput] : []));
  if (limit <= 1 || mine.length === 0) return { agent: { tasks: { none: { status: "RUNNING" } } } };
  const aboutNothing: Prisma.AgentTaskWhereInput = { leadId: null, clientId: null, projectId: null, proposalId: null, invoiceId: null };
  return { agent: { tasks: { none: { status: "RUNNING", OR: [aboutNothing, ...mine] } } } };
}
