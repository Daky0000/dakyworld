import { SETTING, getSetting, isEnvManaged } from "../settings.js";
import { MODEL_DEFAULT, defaultModel, type ModelRate } from "../claudePricing.js";

/**
 * The four model vendors, and which job each one does.
 *
 * Until now every model call in this app went to Claude, which was right when
 * there was one thing to ask a model. There are four now, and they are not the
 * same job: writing prose, drawing a picture, building a page, and checking
 * whether a sentence is still true in the world. A single vendor answers all
 * four and is best at none of them.
 *
 * So the app names the **job**, never the vendor. `callModel({ job: "text" })`
 * asks for prose; which company serves it is a row in a settings table the
 * Owner controls, and re-routing every piece of writing in the system from
 * Gemini to Claude is one dropdown rather than a deploy.
 *
 * **A missing key is never a failure.** Every job falls back to Claude, which
 * is already connected — so the day this shipped, nothing broke and nothing
 * changed, and each new key the Owner pastes moves one job onto the model
 * chosen for it. That is the whole configuration story: paste a key, and the
 * work it was picked for starts using it.
 */

/** The vendors. `anthropic` is the floor everything falls back to. */
export type ProviderKey = "anthropic" | "openai" | "gemini" | "perplexity";

/**
 * What is being asked for, in the app's own words rather than a vendor's.
 *
 * These are jobs, not capabilities: `text` and `html` are both "generate
 * tokens" to an API and completely different work to a person, which is
 * exactly why they route separately.
 */
export type ModelJob =
  /** Prose. Emails, proposals, ad copy, briefs — anything a person reads. */
  | "text"
  /** Pictures. */
  | "image"
  /** A complete web page: HTML, CSS, the lot. */
  | "html"
  /** Is this true, and is it still true — answered against live sources. */
  | "factcheck"
  /** Who is this company, answered against live sources rather than from memory. */
  | "research"
  /** The same text, in plain English a person would actually say. */
  | "humanise"
  /** Looking at a picture and saying what is in it — a screenshot of a page, mostly. */
  | "vision";

export const MODEL_JOBS: ModelJob[] = ["text", "image", "html", "factcheck", "research", "humanise", "vision"];

export interface JobDescription {
  job: ModelJob;
  /** A heading. Title case, two words at most. */
  name: string;
  /**
   * The same job inside a sentence — "No model is connected for **writing**".
   * Separate from `name` because a heading and a clause want different words:
   * lowercasing "Plain English" gives "plain english", which reads as a typo.
   */
  phrase: string;
  /** What routing this job elsewhere actually changes, for the Settings screen. */
  blurb: string;
  /** Which vendor it goes to when nobody has said otherwise. */
  fallback: ProviderKey;
}

/**
 * The shipped routing.
 *
 * These are the Owner's choices, written down: Gemini writes, ChatGPT draws
 * and builds pages, Perplexity checks facts and rewrites for a human reader.
 * Each falls back to Claude while its key is missing.
 */
export const JOBS: Record<ModelJob, JobDescription & { defaultProvider: ProviderKey }> = {
  text: {
    job: "text",
    name: "Writing",
    phrase: "writing",
    blurb: "Every piece of prose the system produces — proposal copy, email drafts, ad concepts, page copy, cold outreach.",
    defaultProvider: "gemini",
    fallback: "anthropic",
  },
  image: {
    job: "image",
    name: "Images",
    phrase: "images",
    blurb: "Pictures for ads, social posts and mock-ups.",
    defaultProvider: "openai",
    fallback: "anthropic",
  },
  html: {
    job: "html",
    name: "Web pages",
    phrase: "building web pages",
    blurb: "Complete HTML pages on the brand design system — the thing a developer opens and edits.",
    defaultProvider: "openai",
    fallback: "anthropic",
  },
  factcheck: {
    job: "factcheck",
    name: "Fact-checking",
    phrase: "fact-checking",
    blurb: "Checks a draft's claims against live sources, so nothing goes out that stopped being true last year.",
    defaultProvider: "perplexity",
    fallback: "anthropic",
  },
  research: {
    job: "research",
    name: "Research",
    phrase: "researching a company",
    blurb:
      "Finds out who a prospect actually is — trade, address, reputation, who runs it — from live sources, and fills the blanks a scrape left behind.",
    defaultProvider: "perplexity",
    fallback: "anthropic",
  },
  humanise: {
    job: "humanise",
    name: "Plain English",
    phrase: "plain-English rewrites",
    blurb: "Rewrites a draft to sound like a person wrote it and to be understood on one reading.",
    defaultProvider: "perplexity",
    fallback: "anthropic",
  },
  vision: {
    job: "vision",
    name: "Looking",
    phrase: "looking at a page",
    blurb:
      "Reads a screenshot of a prospect's homepage and says what a first-time visitor actually sees — the half of a site audit that markup cannot answer.",
    defaultProvider: "openai",
    fallback: "anthropic",
  },
};

export interface ProviderDefinition {
  key: ProviderKey;
  /** What the Owner calls it. "ChatGPT", not "OpenAI's chat completions API". */
  name: string;
  /** Who bills for it. */
  vendor: string;
  /** What it is here to do, in one line. */
  purpose: string;
  keySetting: string;
  modelSetting: string;
  defaultModel: string;
  /** Where the key comes from. */
  console: string;
  /** What the key looks like, as placeholder text. */
  keyHint: string;
  /** The jobs this vendor can be routed to. */
  jobs: ModelJob[];
  /** The models worth offering in a dropdown. Anything else can still be typed. */
  models: string[];
}

export const PROVIDERS: Record<ProviderKey, ProviderDefinition> = {
  anthropic: {
    key: "anthropic",
    name: "Claude",
    vendor: "Anthropic",
    purpose: "Reads spreadsheets, runs the agents, and stands in for any job whose own model isn't connected yet.",
    keySetting: SETTING.ANTHROPIC_KEY,
    modelSetting: SETTING.ANTHROPIC_MODEL,
    defaultModel: MODEL_DEFAULT,
    console: "https://console.anthropic.com/settings/keys",
    keyHint: "sk-ant-…",
    // Deliberately every job: it is the floor, and a floor with holes in it
    // isn't one.
    jobs: ["text", "image", "html", "factcheck", "research", "humanise", "vision"],
    models: ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"],
  },
  openai: {
    key: "openai",
    name: "ChatGPT",
    vendor: "OpenAI",
    purpose: "Images, and complete web pages.",
    keySetting: SETTING.OPENAI_KEY,
    modelSetting: SETTING.OPENAI_MODEL,
    defaultModel: "gpt-5.4",
    console: "https://platform.openai.com/api-keys",
    keyHint: "sk-proj-…",
    jobs: ["text", "image", "html", "vision"],
    models: ["gpt-5.4", "gpt-5.5", "gpt-5.4-mini"],
  },
  gemini: {
    key: "gemini",
    name: "Gemini",
    vendor: "Google",
    purpose: "Everything the system writes.",
    keySetting: SETTING.GEMINI_KEY,
    modelSetting: SETTING.GEMINI_MODEL,
    defaultModel: "gemini-3.7-flash",
    console: "https://aistudio.google.com/apikey",
    keyHint: "AIza…",
    // No image job: Gemini generates pictures through a separate model family
    // this app doesn't wire up, and offering a route that silently can't serve
    // is worse than not offering it. It does read pictures, though, which is a
    // different model family it does wire up — so `vision` is on the list.
    jobs: ["text", "html", "vision"],
    models: ["gemini-3.7-flash", "gemini-3.1-pro-preview", "gemini-2.5-flash"],
  },
  perplexity: {
    key: "perplexity",
    name: "Perplexity",
    vendor: "Perplexity",
    purpose: "Checks claims against live sources, and rewrites drafts into plain English.",
    keySetting: SETTING.PERPLEXITY_KEY,
    modelSetting: SETTING.PERPLEXITY_MODEL,
    defaultModel: "sonar",
    console: "https://www.perplexity.ai/account/api/group",
    keyHint: "pplx-…",
    // It searches the live web on every call, which is what makes it the right
    // answer for "is this still true" and the wrong one for drawing a picture.
    jobs: ["text", "factcheck", "research", "humanise"],
    models: ["sonar", "sonar-pro", "sonar-reasoning-pro"],
  },
};

export const PROVIDER_KEYS = Object.keys(PROVIDERS) as ProviderKey[];

export function isProviderKey(value: unknown): value is ProviderKey {
  return typeof value === "string" && (PROVIDER_KEYS as string[]).includes(value);
}

export function isModelJob(value: unknown): value is ModelJob {
  return typeof value === "string" && (MODEL_JOBS as string[]).includes(value);
}

// --- Keys and models --------------------------------------------------------

export async function providerKey(provider: ProviderKey): Promise<string | null> {
  return getSetting(PROVIDERS[provider].keySetting);
}

export async function providerConfigured(provider: ProviderKey): Promise<boolean> {
  return Boolean(await providerKey(provider));
}

/** Which model this provider uses — the Owner's choice, else the shipped default. */
export async function providerModel(provider: ProviderKey): Promise<string> {
  if (provider === "anthropic") return defaultModel();
  const configured = (await getSetting(PROVIDERS[provider].modelSetting))?.trim();
  return configured || PROVIDERS[provider].defaultModel;
}

/** The image model, which is a different model from the same vendor. */
export async function imageModel(): Promise<string> {
  const configured = (await getSetting(SETTING.OPENAI_IMAGE_MODEL))?.trim();
  return configured || "gpt-image-1.5";
}

// --- Routing ----------------------------------------------------------------

/**
 * Which vendor serves which job.
 *
 * Stored as JSON holding only what has been changed from the shipped routing —
 * the same shape as `capture.actors` and for the same reason: a stored copy of
 * a default is a default that silently stops tracking the code.
 */
export async function readRoutes(): Promise<Partial<Record<ModelJob, ProviderKey>>> {
  const raw = await getSetting(SETTING.MODEL_ROUTES);
  if (!raw?.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn("[models] models.routes is not valid JSON — using the shipped routing.");
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

  const routes: Partial<Record<ModelJob, ProviderKey>> = {};
  for (const [job, provider] of Object.entries(parsed as Record<string, unknown>)) {
    if (!isModelJob(job) || !isProviderKey(provider)) continue;
    // A route to a vendor that cannot do the job is dropped rather than
    // stored: "Gemini draws the pictures" is a setting that would look saved
    // and never once be honoured.
    if (!PROVIDERS[provider].jobs.includes(job)) continue;
    routes[job] = provider;
  }
  return routes;
}

export interface Routing {
  job: ModelJob;
  /** Who was chosen for this job. */
  chosen: ProviderKey;
  /** Who will actually serve it right now. Differs when the chosen one has no key. */
  serving: ProviderKey;
  /** The model that vendor will use. */
  model: string;
  /** True when the chosen vendor is connected and really is serving. */
  ready: boolean;
  /** Why it is falling back, in one sentence, when it is. */
  note: string | null;
}

/**
 * Who serves this job right now.
 *
 * The fallback is the point of this function. A job routed to a vendor with no
 * key does not fail and does not silently produce nothing — it goes to Claude
 * and says so, so the system keeps working from the moment it is deployed and
 * gets better with each key that arrives.
 */
export async function routeFor(job: ModelJob): Promise<Routing> {
  const routes = await readRoutes();
  const chosen = routes[job] ?? JOBS[job].defaultProvider;

  if (await providerConfigured(chosen)) {
    return { job, chosen, serving: chosen, model: await providerModel(chosen), ready: true, note: null };
  }

  const fallback = JOBS[job].fallback;
  const chosenName = PROVIDERS[chosen].name;
  if (chosen !== fallback && (await providerConfigured(fallback))) {
    return {
      job,
      chosen,
      serving: fallback,
      model: await providerModel(fallback),
      ready: false,
      note: `${chosenName} isn't connected, so ${PROVIDERS[fallback].name} is doing ${JOBS[job].phrase} for now. Add a ${chosenName} key under Settings → AI models.`,
    };
  }

  // Nothing is connected. The caller turns this into the sentence the Owner
  // reads, so it is named here rather than thrown.
  return {
    job,
    chosen,
    serving: chosen,
    model: await providerModel(chosen),
    ready: false,
    note: `No model is connected for ${JOBS[job].phrase}. Add a ${chosenName} key under Settings → AI models.`,
  };
}

/** Every job and who serves it — what the Settings screen and the Tools screen show. */
export async function describeRouting(): Promise<Routing[]> {
  return Promise.all(MODEL_JOBS.map((job) => routeFor(job)));
}

export interface ProviderStatus {
  key: ProviderKey;
  name: string;
  vendor: string;
  purpose: string;
  configured: boolean;
  envManaged: boolean;
  /** Masked. Never the key itself. */
  keyPreview: string | null;
  model: string;
  defaultModel: string;
  models: string[];
  console: string;
  keyHint: string;
  jobs: ModelJob[];
  /** The jobs currently routed here. */
  serving: ModelJob[];
}

export async function describeProviders(): Promise<ProviderStatus[]> {
  const routing = await describeRouting();
  return Promise.all(
    PROVIDER_KEYS.map(async (key) => {
      const definition = PROVIDERS[key];
      const value = await providerKey(key);
      return {
        key,
        name: definition.name,
        vendor: definition.vendor,
        purpose: definition.purpose,
        configured: Boolean(value),
        envManaged: isEnvManaged(definition.keySetting),
        keyPreview: null as string | null,
        model: await providerModel(key),
        defaultModel: definition.defaultModel,
        models: definition.models,
        console: definition.console,
        keyHint: definition.keyHint,
        jobs: definition.jobs,
        // `ready` matters here: when nothing at all is connected, a route
        // reports itself as its own server because there is no fallback to name.
        // Counting those would have an unconfigured vendor claiming to be
        // doing work.
        serving: routing.filter((route) => route.serving === key && route.ready).map((route) => route.job),
      };
    }),
  );
}

// --- What it costs ----------------------------------------------------------

/**
 * Published rates, per million tokens.
 *
 * Here for the same reason the Claude table is: a price is a fact about the
 * world, not a preference. And overridable from `AppSetting` for the same
 * reason too — a vendor changing a rate must not need a redeploy, and a stale
 * number inside a spending guard fails silently.
 *
 * Checked against each vendor's published pricing on 18 Aug 2026.
 */
export const PROVIDER_PRICING: Record<string, ModelRate> = {
  // OpenAI — developers.openai.com/api/docs/pricing
  "gpt-5.6-sol": { inputPerMTok: 5, outputPerMTok: 30 },
  "gpt-5.6-terra": { inputPerMTok: 2, outputPerMTok: 12 },
  "gpt-5.6-luna": { inputPerMTok: 0.2, outputPerMTok: 1.2 },
  "gpt-5.5": { inputPerMTok: 5, outputPerMTok: 30 },
  "gpt-5.4": { inputPerMTok: 2.5, outputPerMTok: 15 },
  "gpt-5.4-mini": { inputPerMTok: 0.75, outputPerMTok: 4.5 },
  "gpt-5-mini": { inputPerMTok: 0.25, outputPerMTok: 2 },
  // Image models bill their output as image tokens, which is why the output
  // rate looks nothing like a text model's.
  "gpt-image-2": { inputPerMTok: 5, outputPerMTok: 30 },
  "gpt-image-1.5": { inputPerMTok: 5, outputPerMTok: 32 },
  "gpt-image-1-mini": { inputPerMTok: 2, outputPerMTok: 8 },

  // Gemini — ai.google.dev/gemini-api/docs/pricing. Flash is on introductory
  // pricing until 31 Dec 2026; the *standard* rate is stored deliberately, the
  // same call the Claude table makes about Sonnet: a ceiling that overestimates
  // still holds when the introduction ends, and one that underestimates stops
  // holding on a date nobody is watching for.
  "gemini-3.7-flash": { inputPerMTok: 1.5, outputPerMTok: 7.5 },
  "gemini-3.6-flash": { inputPerMTok: 1.5, outputPerMTok: 7.5 },
  "gemini-3.5-flash": { inputPerMTok: 1.5, outputPerMTok: 9 },
  "gemini-2.5-flash": { inputPerMTok: 0.3, outputPerMTok: 2.5 },
  // The long-prompt tier costs more; the higher of the two is stored, for the
  // reason above.
  "gemini-3.1-pro-preview": { inputPerMTok: 4, outputPerMTok: 18 },
  "gemini-2.5-pro": { inputPerMTok: 2.5, outputPerMTok: 15 },

  // Perplexity — docs.perplexity.ai/getting-started/pricing
  sonar: { inputPerMTok: 1, outputPerMTok: 1 },
  "sonar-pro": { inputPerMTok: 3, outputPerMTok: 15 },
  "sonar-reasoning-pro": { inputPerMTok: 2, outputPerMTok: 8 },
  "sonar-deep-research": { inputPerMTok: 2, outputPerMTok: 8 },
};

/**
 * What Perplexity charges *per request*, on top of the tokens.
 *
 * The searching is the product, and it is billed per thousand requests rather
 * than per token — so a cost worked out from tokens alone understates a
 * Perplexity call by more than the tokens cost. The high-search-context rate
 * is stored, again because a ceiling that overestimates is the safe direction.
 */
export const REQUEST_FEES: Record<string, number> = {
  sonar: 12 / 1000,
  "sonar-pro": 14 / 1000,
  "sonar-reasoning-pro": 14 / 1000,
  "sonar-deep-research": 14 / 1000,
};

export function requestFee(model: string): number {
  return REQUEST_FEES[model] ?? 0;
}
