import { callModel } from "../lib/models/call.js";
import { PROVIDERS } from "../lib/models/registry.js";

/**
 * Where a demo page gets its design direction from.
 *
 * A model asked to "design a landing page" produces the same landing page it
 * produced for everybody else: a centred hero, three feature cards with icons,
 * a gradient nobody chose, and a footer. It is recognisable at a glance, and a
 * prospect who recognises it has learnt something about the sender rather than
 * about their own business.
 *
 * The fix is not a better adjective. It is to go and look at real work first,
 * on sites where designers publish, and to carry *that* into the build: a
 * named direction, the reasons it suits this trade, and the URLs it came from
 * so a person can check the reference before the page goes out.
 *
 * Two things make this honest rather than decorative:
 *
 *  - **The search is restricted to the sites the Owner chose.** Perplexity is
 *    given a domain filter, so the references are from those galleries rather
 *    than from whatever a content farm wrote about web design in 2019.
 *  - **A reference is a direction, never a copy.** The brief that reaches the
 *    builder describes layout, type, colour and motion in words. It never
 *    carries markup from somebody else's site, because that is somebody else's
 *    work and shipping it to a prospect under Dakyworld's name would be theft
 *    dressed as inspiration.
 */

/** Where design direction is allowed to come from. The Owner's own list. */
export const REFERENCE_SITES = ["variant.com", "themeforest.net", "motionsites.ai", "aura.build"];

export interface DesignReference {
  /** What the direction is called, in two or three words. */
  name: string;
  /** Where it was seen. One of REFERENCE_SITES. */
  source: string;
  url: string;
  /** Why it suits this business in particular. */
  whyItFits: string;
  /** How the page is laid out, in enough detail to build from. */
  layout: string;
  /** Type, colour and imagery, described rather than specified. */
  look: string;
  /** What moves, and what does not. Restraint is a legitimate answer. */
  motion: string;
}

export interface DesignDirection {
  /** The direction the build should take, in one sentence. */
  direction: string;
  references: DesignReference[];
  /** What to avoid for this trade specifically — the clichés. */
  avoid: string[];
  /** Who chose the direction, and whether it was from live sources. */
  chosenBy: string;
  fromLiveSources: boolean;
  sources: { title: string; url: string; date?: string | null }[];
  costUsd: number;
  /** Set when nothing could be looked up and the shipped fallback was used. */
  note: string | null;
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["direction", "references", "avoid"],
  properties: {
    direction: {
      type: "string",
      description:
        "One sentence naming the design direction this business's page should take, and why that one. Concrete: what a visitor sees first, how the page is organised, what it feels like.",
    },
    references: {
      type: "array",
      description: "Two or three real pages you actually found, each described in enough detail to build from without looking at it again.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "source", "url", "whyItFits", "layout", "look", "motion"],
        properties: {
          name: { type: "string", description: "What this direction is called, two or three words." },
          source: { type: "string", description: "The site it is on: variant.com, themeforest.net, motionsites.ai or aura.build." },
          url: { type: "string", description: "The page you read. Must be a real URL you actually retrieved." },
          whyItFits: { type: "string", description: "Why this suits this trade and this business, not businesses in general." },
          layout: {
            type: "string",
            description:
              "How the page is built: what is above the fold, the order of the sections, how wide the content runs, how the navigation behaves.",
          },
          look: { type: "string", description: "Type, colour, imagery and spacing, described in words a builder can work from." },
          motion: { type: "string", description: "What moves and what does not. 'Nothing moves' is a real answer and often the right one." },
        },
      },
    },
    avoid: {
      type: "array",
      items: { type: "string" },
      description:
        "The clichés for this trade specifically — the stock photograph everybody uses, the layout every competitor has, the phrase on every one of their websites.",
    },
  },
} as const;

const SYSTEM = `You choose a design direction for one small business's landing page, by looking at real published work.

You search only the sites you have been given. They are galleries and marketplaces where designers publish, and the whole reason you are searching them is that the alternative — designing from memory — produces the same page every time: a centred hero, three feature cards with icons, a gradient nobody chose, a footer. A business owner has seen that page a hundred times and it tells them nothing about themselves.

What you return:
- A direction, in one sentence, that a builder could act on.
- Two or three real references, each with the URL you actually read. Describe each one properly: layout, type, colour, imagery, what moves. Somebody has to build from your words without opening the link.
- What to avoid for this trade. Be specific and slightly unkind: every dental site in the world opens on a smiling woman in a chair, every law firm on a gavel or a skyline, every restaurant on a dim photograph of a plate. Name theirs.

The rules:
- **Never return a URL you did not read.** A reference nobody can open is worse than none, because the person checking it loses trust in everything else you said.
- **Direction, never markup.** You are describing how a page should feel and behave. You are not copying anybody's code, and you must never suggest reproducing a specific site's exact design — it belongs to whoever made it.
- **Suit the business, not the fashion.** A hardware shop in Kumasi needs a page that loads on a slow phone and says what is in stock. Elaborate motion is a cost to them, not a feature. If the honest answer is "plain, fast and clear", say that.

British spelling, plain words, no design-critic register.`;

/**
 * The direction to build in, when nothing can be looked up.
 *
 * Not a placeholder: a page built to this is a genuinely decent page, and the
 * alternative is refusing to build at all because a key is missing. It says so
 * in `note`, so nobody mistakes it for a researched direction.
 */
function fallbackDirection(trade: string | null): DesignDirection {
  return {
    direction: `A plain, fast page that says what ${trade ?? "the business"} does in the first line, shows the work, and puts a way to make contact within reach on every screen.`,
    references: [],
    avoid: [
      "A stock photograph as the hero — every competitor has the same one.",
      "Three feature cards with generic icons.",
      "A slogan where the first line should say what they actually do.",
    ],
    chosenBy: "the shipped default",
    fromLiveSources: false,
    sources: [],
    costUsd: 0,
    note: "No design references were looked up — nothing is connected that can search. The page was built to the house default rather than to a direction chosen for this business. Add a Perplexity key under Settings → AI models.",
  };
}

export interface DirectionRequest {
  businessName: string;
  trade: string | null;
  town: string | null;
  /** What they actually sell, in their own words where possible. */
  services: string[];
  /** Whether this is a rebuild or a first website — they want different pages. */
  hasExistingSite: boolean;
  /** What is wrong with the current one, when there is one. */
  problems: string[];
}

export async function chooseDirection(request: DirectionRequest): Promise<DesignDirection> {
  try {
    const result = await callModel<{
      direction: string;
      references: DesignReference[];
      avoid: string[];
    }>({
      purpose: "demo.direction",
      // The live-search job. A direction from a model's memory is the thing
      // this exists to avoid.
      job: "research",
      system: SYSTEM,
      prompt: () =>
        [
          `The business: ${request.businessName}${request.trade ? `, a ${request.trade}` : ""}${request.town ? ` in ${request.town}` : ""}.`,
          request.services.length ? `What they say they offer: ${request.services.join("; ")}.` : "",
          request.hasExistingSite
            ? `They already have a website and it is being redesigned. What is wrong with it now: ${request.problems.join("; ") || "not recorded"}.`
            : "They have no website at all. This would be the first thing about them on the internet that they own.",
          "",
          `Search these sites and no others: ${REFERENCE_SITES.join(", ")}.`,
          "Find the direction their page should take, and the references it comes from.",
        ]
          .filter(Boolean)
          .join("\n"),
      schema: SCHEMA as unknown as Record<string, unknown>,
      searchDomains: REFERENCE_SITES,
      effort: "medium",
      maxTokens: 6000,
    });

    const references = (result.data.references ?? []).filter((reference) => /^https?:\/\//i.test(reference.url ?? ""));

    return {
      direction: result.data.direction?.trim() || fallbackDirection(request.trade).direction,
      references,
      avoid: (result.data.avoid ?? []).filter((entry) => entry.trim()),
      chosenBy: PROVIDERS[result.provider].name,
      fromLiveSources: result.provider === "perplexity",
      sources: result.sources,
      costUsd: result.costUsd,
      note:
        result.provider === "perplexity"
          ? references.length === 0
            ? "The search returned no reference with a usable link, so the direction is a description rather than something you can go and look at."
            : null
          : `${PROVIDERS[result.provider].name} chose the direction from what it already knows rather than from the reference sites. Treat the references as suggestions until a Perplexity key is connected.`,
    };
  } catch {
    // A missing key is not a reason to refuse to build a page.
    return fallbackDirection(request.trade);
  }
}
