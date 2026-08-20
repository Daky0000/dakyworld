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
 * what every seeded agent ships with.
 */
export function authoredInstruction(agent: Pick<Agent, "prompt" | "promptText" | "title" | "mission">): string {
  const written = agent.promptText?.trim();
  if (written) return written;

  const prompt = (agent.prompt ?? {}) as Record<string, string>;
  const layers = PROMPT_LAYERS.map((layer) => prompt[layer])
    .filter((value) => typeof value === "string" && value.trim())
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
