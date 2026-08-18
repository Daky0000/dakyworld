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
  agentKey: string;
  kind: AgentMemoryKind;
  subject: string;
  content: string;
  importance?: number;
  sourceTaskId?: string | null;
  expiresAt?: Date | null;
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

  const existing = await prisma.agentMemory.findFirst({
    where: { agentKey: input.agentKey, subject: input.subject, content },
  });
  if (existing) {
    return prisma.agentMemory.update({
      where: { id: existing.id },
      data: { importance: Math.min(5, existing.importance + 1), sourceTaskId: input.sourceTaskId ?? existing.sourceTaskId },
    });
  }

  return prisma.agentMemory.create({
    data: {
      agentKey: input.agentKey,
      kind: input.kind,
      subject: input.subject,
      content,
      importance: Math.min(5, Math.max(1, input.importance ?? 3)),
      sourceTaskId: input.sourceTaskId ?? null,
      expiresAt: input.expiresAt ?? null,
    },
  });
}

/**
 * What this agent knows that bears on this task.
 *
 * Always its standing lessons about itself, plus everything it knows about the
 * specific subjects the task is about. Ranked by importance and then by
 * recency, because a strongly-held old conclusion should outrank a weakly-held
 * new one — and truncated, because a prompt has a budget.
 */
export async function recall(agentKey: string, subjects: string[]): Promise<string[]> {
  const wanted = [...new Set(["self", ...subjects.filter(Boolean)])];
  const memories = await prisma.agentMemory.findMany({
    where: {
      agentKey,
      subject: { in: wanted },
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    orderBy: [{ importance: "desc" }, { createdAt: "desc" }],
    take: RECALL_LIMIT,
  });

  if (memories.length === 0) return [];

  // Recall is usage: a memory nothing ever pulls up can be found and removed.
  await prisma.agentMemory.updateMany({
    where: { id: { in: memories.map((memory) => memory.id) } },
    data: { useCount: { increment: 1 }, lastUsedAt: new Date() },
  });

  return memories.map((memory) => `[${memory.kind.toLowerCase()}] ${memory.content}`);
}

/** For the agent drawer: what it holds, newest first. */
export async function listMemories(agentKey: string, subject?: string) {
  return prisma.agentMemory.findMany({
    where: { agentKey, ...(subject ? { subject } : {}) },
    orderBy: [{ createdAt: "desc" }],
    take: 200,
  });
}

export async function forget(id: string) {
  await prisma.agentMemory.deleteMany({ where: { id } });
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
        { useCount: 0, importance: { lte: 2 }, createdAt: { lt: stale } },
      ],
    },
  });
  return count;
}
