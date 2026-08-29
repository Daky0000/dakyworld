import type { Agent } from "@prisma/client";
import { PROMPT_LAYERS } from "../agentRegistry.js";

/**
 * The instruction an agent works to, as a person authored it.
 *
 * A leaf on purpose. This used to live in `runner.ts`, which imports the tool
 * catalogue, which imports the drafters — so the moment a drafter needed to
 * know what its owning agent had been told, importing it from there would have
 * closed a cycle and left one of the two modules half-initialised at boot.
 * There is exactly one definition of "what a person wrote for this agent" and
 * everything reads it here: the runner, the Agents screen, and every writer.
 *
 * `promptText` is the Owner's own wording and wins outright when it is set.
 * Otherwise the ten layers are run together in their declared order, which is
 * what every seeded agent ships with — **under their headings**, which they
 * were not until 28 Aug 2026.
 *
 * Ten paragraphs joined by blank lines is a wall of prose in which the rule
 * about money, the definition of finished and the description of the craft all
 * look alike. A strong model reads the wall and works out which paragraph is
 * which; a weaker one — and every agent turn now starts on a free model — reads
 * it as one long piece of advice and follows the parts that sound most like
 * instructions. The headings cost about thirty tokens and turn the instruction
 * into a document with parts that can be referred to: the shared method says
 * "one finished thing, of the kind named under *What you produce*", and now
 * there is something under that name to look at.
 *
 * The words are untouched. This is how they are laid out, not what they say.
 */
const LAYER_HEADINGS: Record<(typeof PROMPT_LAYERS)[number], string> = {
  role: "Who you are",
  mission: "What you are for",
  scope: "What is yours and what is not",
  dataRules: "What you may treat as fact",
  tools: "How you use what you have been given",
  policy: "The rules you work under",
  process: "How this job is done well",
  escalateWhen: "When to stop and ask",
  output: "What you produce",
  memory: "What to keep",
};

export function authoredInstruction(agent: Pick<Agent, "prompt" | "promptText" | "title" | "mission">): string {
  const written = agent.promptText?.trim();
  if (written) return written;

  const prompt = (agent.prompt ?? {}) as Record<string, string>;
  const layers = PROMPT_LAYERS.filter((layer) => typeof prompt[layer] === "string" && prompt[layer]!.trim())
    .map((layer) => `## ${LAYER_HEADINGS[layer]}\n${prompt[layer]!.trim()}`)
    .join("\n\n");

  return layers || `You are the Dakyworld ${agent.title}. ${agent.mission}`;
}

/**
 * True when a person has rewritten this agent, rather than it still standing
 * as shipped.
 *
 * `promptEditedAt` is set by the PATCH route on any wording change;
 * `promptText` is the stronger signal — prose written to replace the layers
 * entirely. Either one means the words on the screen are the founder's, and a
 * writer that ignores them is the bug this whole module exists to close.
 */
export function hasBeenAuthored(agent: Pick<Agent, "promptText" | "promptEditedAt">): boolean {
  return Boolean(agent.promptText?.trim() || agent.promptEditedAt);
}
