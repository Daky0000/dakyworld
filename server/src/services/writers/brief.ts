import { prisma } from "../../lib/prisma.js";
import { authoredInstruction, hasBeenAuthored } from "../agents/authored.js";
import { briefSettingKey, writerJob, type WriterJob } from "./registry.js";

/**
 * What a writer is actually told, and where those words came from.
 *
 * Every writing job in this system is composed of parts that must not be
 * confused:
 *
 *  - **The doctrine.** How Dakyworld writes this thing — the voice, the
 *    judgement, what may and may not be claimed. This is the founder's, it is
 *    what the Agents screen shows, and editing it is the entire point.
 *  - **The contract.** The shape of the answer — the fields, the plain-text
 *    rule, the length. This is the code's. A prompt edit that could reach it
 *    would turn a bad sentence into a parse failure, so it never can: the
 *    contract is appended by `composeWriterSystem()` and no edit path touches
 *    it.
 *
 * **Read fresh on every call, never cached.** This is the property that makes
 * an edit land on the next draft rather than on the next restart, and it is
 * the same guarantee the task runner already gives. Note that the override is
 * read with a direct query rather than through `getSetting`: that cache is
 * per-process and cleared only by the process that wrote it, so on more than
 * one instance a brief edited on one would go on being ignored by the other —
 * which is this bug again, wearing a different hat.
 */

export type BriefSource = "override" | "agent" | "shipped";

export interface ResolvedBrief {
  job: WriterJob;
  /** The doctrine the model will be given. */
  text: string;
  source: BriefSource;
  /** A sentence for the screen: whose words these are and where to change them. */
  explains: string;
  /** Null when the owning agent is missing from the database entirely. */
  agentName: string | null;
}

/**
 * The doctrine for one writing job.
 *
 * Resolution order, most specific first:
 *
 *  1. **A per-job override**, written for this job alone. The escape hatch for
 *     "change how cold emails read without changing what the agent is". Rare,
 *     and deliberately not the default.
 *  2. **The owning agent's authored instruction — but only once a person has
 *     actually written one.** An untouched seed falls through instead of being
 *     used, because a seeded agent's ten layers describe a colleague ("you
 *     report to the CRO, escalate when...") and the shipped doctrine describes
 *     the letter. Swapping one for the other on an agent nobody has edited
 *     would quietly make every draft worse and blame it on this change.
 *  3. **The shipped doctrine**, passed in by the writer itself.
 *
 * The consequence worth stating plainly: the first time the founder edits
 * `outreach.writer`, that agent's wording takes over the cold email — because
 * that is what they were trying to do when they edited it.
 */
export async function resolveBrief(jobKey: string, shipped: string): Promise<ResolvedBrief> {
  const job = writerJob(jobKey);
  if (!job) {
    throw new Error(`No writing job called ${jobKey}. Add it to services/writers/registry.ts.`);
  }

  const override = await prisma.appSetting.findUnique({ where: { key: briefSettingKey(jobKey) } }).catch(() => null);
  const overrideText = override?.value?.trim();
  if (overrideText) {
    return {
      job,
      text: overrideText,
      source: "override",
      explains: `Written for this job alone. It replaces ${job.agentKey}'s wording here.`,
      agentName: null,
    };
  }

  const agent = await prisma.agent
    .findUnique({
      where: { key: job.agentKey },
      select: { key: true, name: true, title: true, mission: true, prompt: true, promptText: true, promptEditedAt: true },
    })
    .catch(() => null);

  if (agent && hasBeenAuthored(agent)) {
    return {
      job,
      text: authoredInstruction(agent),
      source: "agent",
      explains: `${agent.name}'s own instruction, as edited on the Agents screen. This is what writes it.`,
      agentName: agent.name,
    };
  }

  return {
    job,
    text: shipped,
    source: "shipped",
    explains: agent
      ? `The wording Dakyworld ships. Edit ${agent.name}'s prompt on the Agents screen and that takes over here.`
      : `The wording Dakyworld ships. There is no agent called ${job.agentKey} in the database, so nothing can override it.`,
    agentName: agent?.name ?? null,
  };
}

const CONTRACT_HEADING =
  "How to return this answer — these are the mechanics of the format, not the writing, and they are not negotiable:";

/**
 * The whole system prompt for a writing job: doctrine, then company facts,
 * then the contract.
 *
 * Three parts, and the order is not arbitrary.
 *
 *  - **The doctrine** goes first because it is the part being reasoned from,
 *    and it is the only part a person edits.
 *  - **The company facts** — who Dakyworld is, the contact details from
 *    Settings → System — sit outside the doctrine and are always present, even
 *    when a founder's own wording has replaced everything else. They are live
 *    state, not writing: an edit that accidentally dropped the company's own
 *    address from every letter would be a strange thing for a prompt box to be
 *    able to do. This is the same split `composePrompt()` makes for an agent.
 *  - **The contract** goes last because it is the part that must survive. A
 *    model reading a long instruction weights the end of it heavily, and the
 *    end is where "return plain text with these fields" belongs.
 *
 * The contract is separated by a rule and a heading rather than run on. A
 * model handed one undifferentiated wall cannot tell which sentences it may
 * exercise judgement about and which are the shape of the answer, and the
 * failure mode is the expensive one: it treats the format as advice.
 */
export function composeWriterSystem(
  brief: ResolvedBrief,
  parts: {
    /**
     * What must be said before the doctrine to make sense of it — who this
     * reviewer is, what they are looking at, and the limits of the evidence
     * they were handed. It goes first because a doctrine about how to judge is
     * unreadable before the reader knows what they are judging.
     */
    preamble?: string[];
    /** Live company state — BRAND, the contact block. Never editable here. */
    facts?: string[];
    /** The mechanics of the answer. Never reachable by an edit. */
    contract: string;
  },
): string {
  const clean = (list?: string[]) => (list ?? []).map((part) => part.trim()).filter(Boolean);
  const contract = ["---", "", CONTRACT_HEADING, "", parts.contract.trim()].join("\n");
  return [...clean(parts.preamble), brief.text.trim(), ...clean(parts.facts), contract].join("\n\n");
}

/** Doctrine, facts and contract in one call, for the common case. */
export async function writerSystem(
  jobKey: string,
  shipped: string,
  parts: { preamble?: string[]; facts?: string[]; contract: string },
): Promise<string> {
  const brief = await resolveBrief(jobKey, shipped);
  return composeWriterSystem(brief, parts);
}
