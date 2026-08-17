import { callClaude } from "../lib/claude.js";
import { planCapture, type CaptureItem, type CaptureKind } from "./quickCapture.js";
import { QUICK_ACTORS } from "./scraperTemplates.js";

/**
 * Say what you want captured, in words.
 *
 * `quickCapture.planCapture()` handles the case where somebody pastes links:
 * it reads them for free, in memory, with no model call. This is the other
 * half — "scrape this website for emails", "find me dental clinics in Kumasi",
 * "get the contact details off their Instagram" — where the instruction is a
 * sentence rather than a URL.
 *
 * **The cheap path runs first and usually wins.** A paste that already
 * contains usable links never reaches the model: `interpret()` returns the
 * classifier's answer and costs nothing. The model is for prose, and prose is
 * the minority case. That ordering is the whole cost story here — these actors
 * are pay-per-event, and an LLM call on top of every capture would be a second
 * bill for work a regular expression already did.
 *
 * **Nothing runs from this.** It returns a plan for a person to look at. The
 * targets are paid runs against five different networks; interpreting "get me
 * some leads" as forty Maps searches and spending the month's Apify budget on
 * it is the failure this design exists to prevent. The route confirms first.
 */

/** What the person wants pulled out, which decides how a run is described back to them. */
export const CAPTURE_WANTS = ["EMAIL", "PHONE", "SOCIAL", "ADDRESS", "WEBSITE"] as const;
export type CaptureWant = (typeof CAPTURE_WANTS)[number];

/** Only the kinds this app can actually run — REJECTED and ROWS are not offers. */
const RUNNABLE = Object.keys(QUICK_ACTORS) as Array<keyof typeof QUICK_ACTORS>;

export interface InterpretedTarget {
  kind: keyof typeof QUICK_ACTORS;
  value: string;
  /** One line shown back to the person, so the guess is visible before it costs money. */
  why: string;
}

export interface CaptureIntent {
  targets: InterpretedTarget[];
  wants: CaptureWant[];
  /** Set when the request is too vague to act on. Empty string means "clear enough". */
  question: string;
  summary: string;
  /** True when this came from the classifier rather than the model — i.e. it was free. */
  free: boolean;
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["targets", "wants", "question", "summary"],
  properties: {
    targets: {
      type: "array",
      description:
        "One entry per thing to capture. Empty when the request is too vague — say so in `question` instead of guessing.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "value", "why"],
        properties: {
          kind: {
            type: "string",
            enum: RUNNABLE,
            description:
              "WEBSITE for a company site or directory page. MAPS_SEARCH for a category-and-place search. LINKEDIN_COMPANY, FACEBOOK_PAGE or INSTAGRAM only when the person actually named that network.",
          },
          value: {
            type: "string",
            description:
              "For WEBSITE, LINKEDIN_COMPANY and FACEBOOK_PAGE: the full URL, exactly as it appeared in the request. For INSTAGRAM: the username alone, no URL and no @. For MAPS_SEARCH: the search phrase, like 'dental clinics in Kumasi'. Never invent a URL that was not in the request.",
          },
          why: {
            type: "string",
            description: "One short sentence telling the person how you read their request. Shown to them before anything runs.",
          },
        },
      },
    },
    wants: {
      type: "array",
      description: "What they asked to get out. Infer EMAIL and PHONE when they say 'contact details'. Empty if they didn't say.",
      items: { type: "string", enum: [...CAPTURE_WANTS] },
    },
    question: {
      type: "string",
      description:
        "Empty string when the request is clear. Otherwise the one question that would make it actionable — 'which town?', 'which company?'. Ask rather than guess: every target costs money to run.",
    },
    summary: {
      type: "string",
      description: "Plain sentence describing what will happen, for the confirmation screen. e.g. 'Search Google Maps for dental clinics in Kumasi and pull contact details.'",
    },
  },
} as const;

const SYSTEM = `You turn a short instruction into a lead-capture plan for Dakyworld, an outsourced IT department in Ghana that sells to established local businesses.

You are reading what a member of staff typed into a capture box. They may paste a link, describe a search, or both. Your only job is to say what should be captured — you never capture anything yourself, and a person approves your plan before it costs money.

Rules that matter:

1. **Never invent a URL, a company or a place.** If they didn't name it, it isn't a target. A request you can't pin down is a question, not a guess.
2. **A named network means that network.** "their Instagram" is INSTAGRAM; "their site" is WEBSITE. If they just say "find X in Y", that's MAPS_SEARCH.
3. **Instagram values are usernames**, never URLs and never with an @.
4. **Facebook can only read business Pages, not personal profiles.** If they've described a person's profile, ask for the Page instead.
5. **A vague request is the expensive mistake.** "Get me some leads" has no targets — return none and ask which trade and which town. Turning that into a dozen searches spends real money on guesses.
6. When no location is given for a Maps search, leave the phrase as they wrote it — the app fills the configured market in itself.`;

function describe(item: CaptureItem): string {
  switch (item.kind) {
    case "WEBSITE":
      return "Read this site for contact details.";
    case "MAPS_SEARCH":
      return "Search Google Maps for this.";
    case "LINKEDIN_COMPANY":
      return "Read this LinkedIn company page.";
    case "FACEBOOK_PAGE":
      return "Read this Facebook Page.";
    case "INSTAGRAM":
      return "Read this Instagram account.";
    default:
      return "";
  }
}

const isRunnable = (kind: CaptureKind): kind is keyof typeof QUICK_ACTORS => (RUNNABLE as string[]).includes(kind);

/**
 * Reads an instruction. Uses the classifier when the text already contains
 * links, and only asks the model when it doesn't — so pasting a URL is free.
 */
export async function interpret(text: string): Promise<CaptureIntent> {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return { targets: [], wants: [], question: "What would you like to capture?", summary: "", free: true };

  const plan = planCapture(trimmed);

  // Rows are somebody's data, not an instruction — the import analyst owns that.
  if (plan.rows) {
    return {
      targets: [],
      wants: [],
      question: "",
      summary: "That looks like a list rather than an instruction — it will go to the importer, which reads it into leads.",
      free: true,
    };
  }

  // The classifier only truly resolved it if it found links. A bare phrase
  // becomes a MAPS_SEARCH by default, which is right for "dentists in Kumasi"
  // and wrong for "scrape their instagram" — so prose still goes to the model.
  const resolved = plan.items.filter((item) => isRunnable(item.kind));
  const foundLinks = resolved.some((item) => item.kind !== "MAPS_SEARCH");

  if (foundLinks) {
    const targets = resolved.map((item) => ({
      kind: item.kind as keyof typeof QUICK_ACTORS,
      value: item.value,
      why: describe(item),
    }));
    const rejected = plan.items.filter((item) => item.kind === "REJECTED");
    return {
      targets,
      wants: [],
      question: rejected.length ? rejected[0].reason ?? "" : "",
      summary: `${targets.length} thing${targets.length === 1 ? "" : "s"} to capture from what you pasted.`,
      free: true,
    };
  }

  const { data } = await callClaude<Omit<CaptureIntent, "free">>({
    purpose: "capture.intent",
    system: SYSTEM,
    prompt: () => `Someone typed this into the capture box:\n\n${trimmed}\n\nWhat should be captured?`,
    schema: SCHEMA as unknown as Record<string, unknown>,
    // Short input, a small decision, and it sits in front of a person clicking
    // a button — this is the cheap end of the effort scale on purpose.
    effort: "low",
    maxTokens: 2000,
    messages: {
      noKey: "No Anthropic API key is set, so plain-language capture is off. Paste a link or a search phrase instead.",
      refusal: "That request couldn't be read. Try naming the site or the search directly.",
      empty: "Nothing came back. Try rephrasing what you want captured.",
      parse: "That request couldn't be read. Try naming the site or the search directly.",
    },
  });

  return {
    targets: (data.targets ?? []).filter((t) => isRunnable(t.kind)),
    wants: data.wants ?? [],
    question: data.question ?? "",
    summary: data.summary ?? "",
    free: false,
  };
}
