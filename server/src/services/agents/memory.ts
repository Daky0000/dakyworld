import type { AgentMemoryKind } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";

/**
 * What an agent remembers between tasks.
 *
 * Every seeded agent's prompt already ends with the rule — *retain decisions,
 * their reasons and their outcomes; never retain secrets, tokens, passwords or
 * personal data beyond what the task needs* — and until now there was nowhere
 * to put them. Each task started from nothing, which meant an agent could
 * reach the same wrong conclusion about the same lead every morning and never
 * notice it had been there before.
 *
 * **Recall is by subject, not by similarity.** A memory is filed against the
 * thing it is about — `lead:abc123`, `client:xyz`, or `self` for the general
 * lessons — and an agent picking up a task about a lead is handed what *it*
 * previously concluded about *that* lead, plus its own standing lessons, and
 * nothing about anybody else. That is a deliberate limit: an embedding search
 * across every memory would occasionally surface something about a different
 * client in the context of this one, and the failure mode of that is a letter
 * to the wrong company mentioning the right facts.
 *
 * **There are two kinds, and only one of them is private.** An `AGENT` memory
 * is what one agent worked out, and only that agent is ever shown it. A
 * `SHARED` memory belongs to the company: every agent is shown it. That second
 * kind exists because the first one had a hole in it — the Owner telling the
 * workforce "we do not take on unregistered businesses" had to be typed
 * nineteen times, once per agent, and the twentieth agent hired next month
 * would never hear it at all. Now it is said once.
 *
 * **Sharing widens who sees a memory, never when it comes up.** A shared
 * memory is still filed against a subject and still recalled by subject, so a
 * shared fact about one client surfaces on tasks about that client and nowhere
 * else. `company` is the subject for anything that applies to all work — it is
 * to shared memory what `self` is to an agent's own.
 */

/** The subject key for a record. One spelling, so writes and recalls agree. */
export const subjectOf = {
  lead: (id: string) => `lead:${id}`,
  client: (id: string) => `client:${id}`,
  project: (id: string) => `project:${id}`,
  proposal: (id: string) => `proposal:${id}`,
  invoice: (id: string) => `invoice:${id}`,
  /** Anything about the agent's own way of working, rather than about a record. */
  self: () => "self",
  /**
   * How Dakyworld works, rather than how one agent does. Shared memories filed
   * here are recalled on every task by every agent — the standing instruction,
   * the house rule, the thing the Owner should only have to say once.
   */
  company: () => "company",
};

/**
 * How much of the prompt memory is allowed to take.
 *
 * An agent with three hundred memories about one client would spend its whole
 * context recalling and have none left to work in. The cap is per recall, and
 * the ranking below decides what survives it.
 */
const RECALL_LIMIT = 24;
const CONTENT_MAX = 600;

export interface MemoryInput {
  /** Who wrote it. `owner` when a person did. Kept even on a shared memory. */
  agentKey: string;
  kind: AgentMemoryKind;
  subject: string;
  content: string;
  importance?: number;
  sourceTaskId?: string | null;
  expiresAt?: Date | null;
  /**
   * True to file this against the company rather than against the agent, so
   * every agent is shown it. The row's `agentKey` is then null — a shared
   * memory has to outlive the agent that happened to write it — and
   * `authorKey` records who concluded it.
   */
  shared?: boolean;
}

/**
 * Things that must never be written down, whatever an agent decides.
 *
 * The prompt tells every agent not to retain a secret. This is the part that
 * does not depend on it having listened: a memory is a durable, re-read record
 * with no expiry by default, so a token written into one is a token that is
 * re-read into a prompt every morning for a year.
 */
const SECRET_PATTERNS: Array<{ pattern: RegExp; what: string }> = [
  { pattern: /\bsk-[A-Za-z0-9_-]{16,}/, what: "an API key" },
  { pattern: /\bghp_[A-Za-z0-9]{20,}/, what: "a GitHub token" },
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/, what: "a Slack token" },
  { pattern: /\bBearer\s+[A-Za-z0-9._-]{20,}/i, what: "a bearer token" },
  { pattern: /\b[A-Za-z0-9+/]{40,}={0,2}\b/, what: "something that looks like an encoded secret" },
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, what: "a private key" },
];

/**
 * A credential word followed by something that looks like the value.
 *
 * Separate from the patterns above because the shape is different: those match
 * a token by its own format, and this matches *the sentence somebody writes
 * when they are about to hand one over* — "the password is …", "api key: …",
 * "their token = …". Matching on the word alone would refuse "the password
 * reset is broken", so the value that follows has to look like one too.
 */
const CREDENTIAL_SENTENCE =
  /\b(pass(?:word|phrase)|api[ _-]?key|secret[ _-]?key|access[ _-]?token|auth[ _-]?token|credentials?)\b[^\n]{0,40}?(?:\bis\b|\bare\b|:|=)\s*["']?(\S{6,})/i;

/**
 * True when a value looks like a credential rather than an ordinary word.
 *
 * **A digit inside the word is the strongest signal there is.** English words
 * do not contain them and passwords almost always do, which separates
 * "hunter2000" from "stored" without needing to be clever.
 *
 * Note the character classes are tested against the value as written, not a
 * trimmed copy: stripping the trailing punctuation off `hunter2000!` removes
 * the symbol that made it look like a password in the first place. Only the
 * length test uses the trimmed form, where a full stop would otherwise count
 * toward it.
 *
 * Deliberately eager. Refusing a memory costs a rephrase; accepting one costs
 * a credential re-read into a prompt every morning until somebody notices.
 */
function looksLikeAValue(value: string): boolean {
  if (/\d/.test(value)) return true;
  if (value.replace(/["'.,;!?]+$/, "").length >= 16) return true;
  return /[A-Z]/.test(value) && /[^A-Za-z0-9]/.test(value);
}

/** Null when the text is safe to keep; otherwise what was found in it. */
export function findSecret(content: string): string | null {
  for (const { pattern, what } of SECRET_PATTERNS) {
    if (pattern.test(content)) return what;
  }
  const sentence = CREDENTIAL_SENTENCE.exec(content);
  // Named in brackets rather than inline, which sidesteps "a api key".
  if (sentence && looksLikeAValue(sentence[2])) return `a credential (${sentence[1].toLowerCase().replace(/[_-]/g, " ")})`;
  return null;
}

export class MemoryRefused extends Error {}

/**
 * Writes one memory.
 *
 * Refuses anything carrying a credential, and de-duplicates: an agent that
 * concludes the same thing twice about the same subject should have one
 * memory that matters more, not two that each matter a little.
 *
 * De-duplication is per scope, deliberately. The same sentence held privately
 * by one agent and shared with all of them are two different facts about the
 * company — one is somebody's opinion, the other is policy — and collapsing
 * them would quietly promote the first into the second.
 */
export async function remember(input: MemoryInput) {
  const content = input.content.trim().slice(0, CONTENT_MAX);
  if (content.length < 8) throw new MemoryRefused("That is too short to be worth remembering.");

  const secret = findSecret(content);
  if (secret) {
    throw new MemoryRefused(
      `That looks like it contains ${secret}. Memories are re-read into a prompt every time this subject comes up — write down what you concluded, never the credential.`,
    );
  }

  const shared = input.shared ?? false;
  const scope = shared ? "SHARED" : "AGENT";

  const existing = await prisma.agentMemory.findFirst({
    where: { scope, agentKey: shared ? null : input.agentKey, subject: input.subject, content },
  });
  if (existing) {
    return prisma.agentMemory.update({
      where: { id: existing.id },
      data: { importance: Math.min(5, existing.importance + 1), sourceTaskId: input.sourceTaskId ?? existing.sourceTaskId },
    });
  }

  return prisma.agentMemory.create({
    data: {
      scope,
      agentKey: shared ? null : input.agentKey,
      authorKey: input.agentKey,
      kind: input.kind,
      subject: input.subject,
      content,
      importance: Math.min(5, Math.max(1, input.importance ?? 3)),
      sourceTaskId: input.sourceTaskId ?? null,
      expiresAt: input.expiresAt ?? null,
    },
  });
}

export interface Recalled {
  /** What to put in the prompt. */
  line: string;
  shared: boolean;
}

/**
 * What this agent knows that bears on this task.
 *
 * Three things, in one query: its own standing lessons (`self`), everything it
 * has concluded about the specific subjects this task is about, and the
 * company's shared memory for those same subjects plus `company`.
 *
 * Ranked by importance and then by recency, because a strongly-held old
 * conclusion should outrank a weakly-held new one — and truncated, because a
 * prompt has a budget. **Shared memories get a point of importance in the
 * ranking, not in the record**: a house rule that survives the cut only when
 * an agent happens to hold few opinions is not a house rule, and inflating the
 * stored value instead would corrupt what the Owner actually typed.
 */
export async function recall(agentKey: string, subjects: string[]): Promise<Recalled[]> {
  const own = [...new Set(["self", ...subjects.filter(Boolean)])];
  // `self` is an agent's own; the company's equivalent is `company`. A shared
  // memory filed against `self` would be one agent's habit imposed on all of
  // them, so it is deliberately not recalled here.
  const shared = [...new Set(["company", ...subjects.filter(Boolean)])];

  const memories = await prisma.agentMemory.findMany({
    where: {
      OR: [
        { scope: "AGENT", agentKey, subject: { in: own } },
        { scope: "SHARED", subject: { in: shared } },
      ],
      AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }],
    },
    orderBy: [{ importance: "desc" }, { createdAt: "desc" }],
    // Read wider than the budget, then rank and cut below — otherwise the
    // database's ordering decides which half of a tie survives, and a shared
    // house rule can lose to an agent's passing observation.
    take: RECALL_LIMIT * 2,
  });

  if (memories.length === 0) return [];

  const ranked = memories
    .map((memory) => ({ memory, weight: memory.importance + (memory.scope === "SHARED" ? 1 : 0) }))
    .sort((a, b) => b.weight - a.weight || b.memory.createdAt.getTime() - a.memory.createdAt.getTime())
    .slice(0, RECALL_LIMIT);

  // Recall is usage: a memory nothing ever pulls up can be found and removed.
  await prisma.agentMemory.updateMany({
    where: { id: { in: ranked.map((entry) => entry.memory.id) } },
    data: { useCount: { increment: 1 }, lastUsedAt: new Date() },
  });

  return ranked.map((entry) => ({
    line: `[${entry.memory.kind.toLowerCase()}] ${entry.memory.content}`,
    shared: entry.memory.scope === "SHARED",
  }));
}

/**
 * For the agent drawer: what it holds, newest first.
 *
 * Includes the shared memories it will be shown, because "what does this agent
 * know" is a question about what reaches its prompt, not about which rows
 * happen to carry its key. Each is marked, so the drawer can say which ones
 * editing here would change for everybody.
 */
export async function listMemories(agentKey: string, subject?: string) {
  return prisma.agentMemory.findMany({
    where: {
      OR: [{ scope: "AGENT", agentKey }, { scope: "SHARED" }],
      ...(subject ? { subject } : {}),
    },
    orderBy: [{ createdAt: "desc" }],
    take: 200,
  });
}

/** The company's own memory, on its own — what the shared panel shows. */
export async function listSharedMemories(subject?: string) {
  return prisma.agentMemory.findMany({
    where: { scope: "SHARED", ...(subject ? { subject } : {}) },
    orderBy: [{ importance: "desc" }, { createdAt: "desc" }],
    take: 200,
  });
}

export async function forget(id: string) {
  await prisma.agentMemory.deleteMany({ where: { id } });
}

/**
 * Changes what a memory says.
 *
 * A memory is an instruction that is re-read into a prompt every time its
 * subject comes up, so being unable to correct one meant the only fix for a
 * conclusion that had gone stale was deleting it and losing the fact that it
 * had ever been held. The credential check runs again on the new wording, for
 * the same reason it runs on the first: the danger is in what gets stored, not
 * in how it got there.
 */
export async function editMemory(
  id: string,
  changes: { content?: string; importance?: number; subject?: string; expiresAt?: Date | null },
) {
  const data: Record<string, unknown> = {};

  if (changes.content !== undefined) {
    const content = changes.content.trim().slice(0, CONTENT_MAX);
    if (content.length < 8) throw new MemoryRefused("That is too short to be worth remembering.");
    const secret = findSecret(content);
    if (secret) {
      throw new MemoryRefused(
        `That looks like it contains ${secret}. Memories are re-read into a prompt every time this subject comes up — write down what you concluded, never the credential.`,
      );
    }
    data.content = content;
  }

  if (changes.importance !== undefined) data.importance = Math.min(5, Math.max(1, changes.importance));
  if (changes.subject !== undefined) data.subject = changes.subject.slice(0, 80);
  if (changes.expiresAt !== undefined) data.expiresAt = changes.expiresAt;

  return prisma.agentMemory.update({ where: { id }, data });
}

/**
 * Clears out what has stopped being true.
 *
 * Expired memories, and memories nothing has recalled in a long time. The
 * second is the one that matters: an agent accumulating memories it never uses
 * is an agent whose recall is getting worse, because the cap above means the
 * junk crowds out the useful.
 */
export async function pruneMemories(agentKey?: string): Promise<number> {
  const stale = new Date(Date.now() - 180 * 24 * 60 * 60_000);
  const { count } = await prisma.agentMemory.deleteMany({
    where: {
      ...(agentKey ? { agentKey } : {}),
      OR: [
        { expiresAt: { lt: new Date() } },
        // Never the company's own. A shared memory is something a person
        // decided the whole workforce should know, and "nothing has come up
        // about it in six months" is not evidence that it stopped being true —
        // a house rule about refunds is right to sit unused until there is a
        // refund. Only the agent's own conclusions are swept.
        { scope: "AGENT", useCount: 0, importance: { lte: 2 }, createdAt: { lt: stale } },
      ],
    },
  });
  return count;
}
