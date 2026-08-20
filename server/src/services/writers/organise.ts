import { callModel } from "../../lib/models/call.js";
import { PROMPT_LAYERS } from "../agentRegistry.js";

/**
 * Sorting a written instruction into the sections a prompt is made of.
 *
 * The founder writes doctrine the way a person writes doctrine — a playbook, a
 * page of rules, a paste out of a document — and the Agents screen wants ten
 * named layers. Until now that gap was manual, so the realistic outcome was
 * everything going into `process` because it is the only layer big enough to
 * take a page, which is how a prompt ends up as one wall of text with nine
 * empty headings above it.
 *
 * So a model reads the writing and files it. Three rules make it safe to run
 * over somebody's own words:
 *
 *  1. **It may not write.** Every sentence it returns has to be one it was
 *     given. It is allowed to split a paragraph, drop a heading that has become
 *     a layer name, and reorder — nothing else. A model that "tidies" doctrine
 *     is a model quietly rewriting the founder's instruction, which is the
 *     exact failure this whole area of the codebase exists to prevent.
 *  2. **Nothing is lost.** Anything that does not belong under a heading goes
 *     into `process`, and `unplaced` reports what it could not file, so the
 *     screen can say so rather than letting a paragraph vanish.
 *  3. **It proposes, it does not save.** The route hands the result back for a
 *     person to read and press Save on. An organiser that wrote directly to the
 *     agent would be a model editing a prompt with nobody looking.
 */

const LAYER_MEANING: Record<string, string> = {
  role: "Who it is. The job title and the business it works in.",
  mission: "What it is for — the outcome it exists to produce.",
  scope: "Where it stops. What it does not touch, and what goes back to somebody else instead.",
  dataRules: "What it may treat as true, and how it separates what it observed from what it inferred or assumed.",
  tools: "How it should use what it has been given — when to reach for something, and when not to.",
  policy: "The lines it must not cross whatever it concludes. Guards, prohibitions, things that are never done.",
  process: "How it works through a job, in order. The steps, the structure of the output, the shape of the thing it produces.",
  escalateWhen: "What makes it stop and ask a person rather than carry on.",
  output: "The form of what it hands back, so one result is comparable to the last.",
  memory: "How it decides what is worth keeping between jobs.",
};

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["layers", "unplaced", "summary"],
  properties: {
    layers: {
      type: "object",
      additionalProperties: false,
      required: [...PROMPT_LAYERS],
      properties: Object.fromEntries(
        PROMPT_LAYERS.map((layer) => [
          layer,
          {
            type: "string",
            description: `${LAYER_MEANING[layer] ?? layer} Sentences copied from the source, unchanged. Empty string when the source says nothing about this.`,
          },
        ]),
      ),
    },
    unplaced: {
      type: "array",
      items: { type: "string" },
      description:
        "Anything from the source you could not confidently file, quoted. Normally empty. This is how a person checks that nothing was dropped.",
    },
    summary: {
      type: "string",
      description: "One sentence on how you split it, for the person about to read the result.",
    },
  },
} as const;

const SYSTEM = `You sort a written instruction into the ten named sections a Dakyworld agent prompt is made of.

**You are filing, not writing.** Every sentence you place must be a sentence you were given, word for word. You may split a paragraph across two sections where it plainly covers both, drop a heading from the source that has become the name of a section, and put things in a sensible order within a section. You may not rewrite, summarise, shorten, improve, correct or add anything at all — not one clause. The words belong to the person who wrote them, and this is the one job where being helpful about the prose is the failure.

**Lose nothing.** Every substantive sentence in the source ends up in exactly one section. Where something genuinely fits no heading, put it in \`process\`, which is the general one, rather than dropping it. If you are still unsure, quote it in \`unplaced\` — an honest "I did not know where this goes" is far more useful than a confident wrong filing.

**An empty section is a correct answer.** If the writing says nothing about when to escalate, \`escalateWhen\` is an empty string. Do not invent a plausible sentence to fill a heading; a section you wrote is a section the author never approved.

**Keep the formatting.** Markdown, bold, numbered lists and bullets carry meaning in an instruction — a numbered list of rules in order of importance stops meaning that if you flatten it. Copy it across as it was.`;

export interface OrganisedPrompt {
  layers: Record<string, string>;
  unplaced: string[];
  summary: string;
  /** Who sorted it, since the chain may have handed it on. */
  organisedBy: string;
  /** Set when the first-choice model could not and somebody else did. */
  note: string | null;
  costUsd: number;
}

export async function organisePrompt(text: string): Promise<OrganisedPrompt> {
  const result = await callModel<{ layers: Record<string, string>; unplaced: string[]; summary: string }>({
    purpose: "prompt.organise",
    job: "organise",
    system: SYSTEM,
    prompt: () =>
      [
        "The sections, and what each one is for:",
        PROMPT_LAYERS.map((layer) => `- ${layer}: ${LAYER_MEANING[layer] ?? ""}`).join("\n"),
        "",
        "The instruction to sort:",
        text.trim(),
      ].join("\n"),
    schema: SCHEMA as unknown as Record<string, unknown>,
    // Comprehension over a long document, where the cost of putting a rule
    // under the wrong heading is that somebody later reads the prompt and
    // believes the agent was told something it was not.
    effort: "high",
    maxTokens: 12_000,
    messages: {
      noKey: "No model is connected that can sort a prompt. Add a Claude, ChatGPT or Gemini key under Settings → AI models — any one of them can do this.",
      refusal: "The model declined to sort this one. Paste it into the sections by hand.",
      truncated: "That instruction was too long to sort in one pass. Split it and sort each half.",
    },
  });

  // Only the ten known layers, and only strings. A vendor that invents an
  // eleventh key would otherwise have it written straight into the prompt
  // column, where nothing reads it and nothing shows it.
  const layers: Record<string, string> = {};
  for (const layer of PROMPT_LAYERS) {
    const value = result.data.layers?.[layer];
    layers[layer] = typeof value === "string" ? value.trim() : "";
  }

  return {
    layers,
    unplaced: Array.isArray(result.data.unplaced) ? result.data.unplaced.filter((line) => typeof line === "string") : [],
    summary: typeof result.data.summary === "string" ? result.data.summary : "",
    organisedBy: result.model,
    note: result.fallbackNote,
    costUsd: result.costUsd,
  };
}
