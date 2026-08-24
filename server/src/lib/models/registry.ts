import { SETTING, getSetting, isEnvManaged } from "../settings.js";
import { MODEL_DEFAULT, MODEL_ECONOMY, MODEL_PRICING, defaultModel, type ModelRate } from "../claudePricing.js";

/**
 * The five model vendors, and which job each one does.
 *
 * Until now every model call in this app went to Claude, which was right when
 * there was one thing to ask a model. There are five now, and they are not the
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
export type ProviderKey = "anthropic" | "openai" | "gemini" | "perplexity" | "openrouter";

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
  /** Sorting a written instruction into the sections an agent prompt is made of. */
  | "organise"
  /** Reading a message that arrived and saying what it is and whose it is. */
  | "triage"
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

export const MODEL_JOBS: ModelJob[] = ["text", "organise", "triage", "image", "html", "factcheck", "research", "humanise", "vision"];

/**
 * How much a job is worth paying for, before anybody has said otherwise.
 *
 * Two tiers rather than five, because two is what the code can actually act on:
 * `economy` resolves to the cheap model a vendor offers, `standard` to whatever
 * that vendor's own model setting says. The blueprint's tier 0 — validation,
 * arithmetic, dates, suppression, state transitions — is not a tier here at all
 * because none of it reaches a model in the first place.
 *
 * **A job with no tier declared is `standard`.** Named that way round on
 * purpose, the same call `modelForEffort` makes: a job added later and not
 * thought about should cost too much rather than quietly be done badly.
 */
export type ModelTier = "economy" | "standard";

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
  /** What this job is worth paying for. Absent means `standard`. */
  tier?: ModelTier;
}

/**
 * The shipped routing.
 *
 * These are the Owner's choices, written down: **ox-alpha through OpenRouter
 * serves every job it can do**, ChatGPT draws the pictures, and each job moves
 * down its chain when ox-alpha isn't connected or a call through it fails —
 * the declared fallback first, then every other vendor that can do the work.
 */
export const JOBS: Record<ModelJob, JobDescription & { defaultProvider: ProviderKey }> = {
  text: {
    job: "text",
    name: "Writing",
    phrase: "writing",
    blurb: "Every piece of prose the system produces — proposal copy, email drafts, ad concepts, page copy, cold outreach.",
    defaultProvider: "openrouter",
    fallback: "anthropic",
  },
  organise: {
    job: "organise",
    name: "Sorting a prompt",
    phrase: "sorting a prompt into sections",
    blurb:
      "Reading a written instruction and filing it under the ten headings an agent prompt is made of — so a pasted playbook becomes a prompt rather than a wall of text.",
    // ox-alpha first like everything else. This job is comprehension and
    // filing, not prose: nothing it returns is read by a customer, and the
    // failure that matters is a paragraph put under the wrong heading or
    // quietly reworded. Every vendor that can follow a schema can do it, so
    // the chain is wide and the cost is a rounding error against being wrong.
    defaultProvider: "openrouter",
    fallback: "anthropic",
    // Following a schema, on a job with a right answer, where nothing it
    // returns is read by a customer.
    tier: "economy",
  },
  triage: {
    job: "triage",
    name: "Reading the post",
    phrase: "reading incoming mail",
    blurb:
      "Reading an email that arrived and saying what it is — a yes, a question, a complaint, an out-of-office — so it can be handed to the agent whose job it is. See services/mailbox/.",
    // Its own job rather than borrowing `organise`, for a reason that is about
    // money: this is the only job in the list that runs once per *arriving*
    // message rather than once per piece of work somebody asked for. A busy
    // mailbox is a thousand calls a month, and separating it is what lets the
    // Owner put it on a cheap model from the Settings screen without moving
    // everything else there too.
    defaultProvider: "openrouter",
    fallback: "gemini",
    // The argument above, carried out. Separating the job was only half of it:
    // for months this still resolved to whichever model the vendor's own
    // setting named, which on Claude is the headline one — so the cheap-model
    // promise in that comment was not kept by anything. It is now the default
    // rather than something the Owner has to go and find.
    tier: "economy",
  },
  image: {
    job: "image",
    name: "Images",
    phrase: "images",
    blurb: "Pictures for ads, social posts and mock-ups.",
    defaultProvider: "openai",
    // Itself, because it is the only vendor here that draws. `standInsFor`
    // filters candidates by what they declare, so naming anybody else would
    // be filtered out anyway — saying it plainly beats a line that reads like
    // a fallback exists when none does.
    fallback: "openai",
  },
  html: {
    job: "html",
    name: "Web pages",
    phrase: "building web pages",
    blurb: "Complete HTML pages on the brand design system — the thing a developer opens and edits.",
    defaultProvider: "openrouter",
    fallback: "anthropic",
  },
  factcheck: {
    job: "factcheck",
    name: "Fact-checking",
    phrase: "fact-checking",
    blurb: "Checks a draft's claims against live sources, so nothing goes out that stopped being true last year.",
    // ox-alpha carries the job by default, per the Owner's call. It does not
    // search the live web, so an answer it gives reports itself as checked
    // against no live source — the tool result says who checked and against
    // what, and Perplexity stays one step down the chain for when that
    // distinction matters more than the default does.
    defaultProvider: "openrouter",
    fallback: "anthropic",
  },
  research: {
    job: "research",
    name: "Research",
    phrase: "researching a company",
    blurb:
      "Finds out who a prospect actually is — trade, address, reputation, who runs it — from live sources, and fills the blanks a scrape left behind.",
    // Same reasoning as factcheck above: ox-alpha by default, and the result
    // records honestly whether what came back was searched for or remembered.
    defaultProvider: "openrouter",
    fallback: "anthropic",
  },
  humanise: {
    job: "humanise",
    name: "Plain English",
    phrase: "plain-English rewrites",
    blurb: "Rewrites a draft to sound like a person wrote it and to be understood on one reading.",
    defaultProvider: "openrouter",
    fallback: "anthropic",
  },
  vision: {
    job: "vision",
    name: "Looking",
    phrase: "looking at a page",
    blurb:
      "Reads a screenshot of a prospect's homepage and says what a first-time visitor actually sees — the half of a site audit that markup cannot answer.",
    defaultProvider: "openrouter",
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
  /**
   * The cheap model this vendor offers, for jobs tiered `economy`.
   *
   * Every vendor here has one and they are not interchangeable, which is why
   * this is a property of the vendor rather than one global "cheap model": the
   * economy tier has to resolve to something the vendor serving the job can
   * actually be asked for. A vendor with nothing cheaper than its default names
   * its default, which makes the tier a no-op rather than a broken request.
   */
  economyModel: string;
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
    economyModel: MODEL_ECONOMY,
    console: "https://console.anthropic.com/settings/keys",
    keyHint: "sk-ant-…",
    // Deliberately every job it can actually do: it is the floor, and a floor
    // with holes in it isn't one.
    //
    // **`image` is not one of them.** It was listed here on the "every job"
    // reasoning, and that made the floor a trap rather than a floor: Claude
    // does not draw pictures, `generateImage` refuses outright anything that
    // is not ChatGPT, so routing images to Claude — or simply having no
    // ChatGPT key and letting the chain reach for the stand-in — produced
    // "Images are routed to Claude, which this app cannot ask for a picture"
    // instead of a picture. A vendor belongs in a job's chain only if asking
    // it would work, because the chain is now what runs when the first choice
    // fails and a candidate that cannot do the work is a wasted attempt with
    // a confusing error at the end of it.
    jobs: ["text", "organise", "triage", "html", "factcheck", "research", "humanise", "vision"],
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
    economyModel: "gpt-5.4-mini",
    console: "https://platform.openai.com/api-keys",
    keyHint: "sk-proj-…",
    jobs: ["text", "organise", "triage", "image", "html", "vision"],
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
    economyModel: "gemini-2.5-flash",
    console: "https://aistudio.google.com/apikey",
    keyHint: "AIza…",
    // No image job: Gemini generates pictures through a separate model family
    // this app doesn't wire up, and offering a route that silently can't serve
    // is worse than not offering it. It does read pictures, though, which is a
    // different model family it does wire up — so `vision` is on the list.
    jobs: ["text", "organise", "triage", "html", "vision"],
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
    economyModel: "sonar",
    console: "https://www.perplexity.ai/account/api/group",
    keyHint: "pplx-…",
    // It searches the live web on every call, which is what makes it the right
    // answer for "is this still true" and the wrong one for drawing a picture.
    jobs: ["text", "triage", "factcheck", "research", "humanise"],
    models: ["sonar", "sonar-pro", "sonar-reasoning-pro"],
  },
  openrouter: {
    key: "openrouter",
    // The Owner calls it by the model, not by the shop it came from — the same
    // reason ChatGPT is not called "OpenAI" here.
    name: "ox-alpha",
    vendor: "OpenRouter",
    purpose:
      "The default for every job it can do — one key covers writing, sorting, triage, pages, research, fact-checking, plain English and looking at a page.",
    keySetting: SETTING.OPENROUTER_KEY,
    modelSetting: SETTING.OPENROUTER_MODEL,
    defaultModel: "stealth/ox-alpha",
    // Nothing cheaper names its default, which makes the economy tier a no-op
    // here rather than a broken request.
    economyModel: "stealth/ox-alpha",
    console: "https://openrouter.ai/settings/keys",
    keyHint: "sk-or-…",
    // Every job except `image`. Drawing a picture goes through an images API
    // this app only wires up for ChatGPT (`generateImage` refuses anything
    // else), so listing `image` here would put a route in the dropdown that
    // looks saved and never once serves — the exact thing the routing exists
    // to prevent. Everything else is chat completions, which OpenRouter
    // speaks for any model on it; if ox-alpha turns out not to read pictures,
    // a vision call fails over to the next vendor that can.
    jobs: ["text", "organise", "triage", "html", "factcheck", "research", "humanise", "vision"],
    // The shipped id. If OpenRouter lists the model under a different slug,
    // paste that instead — the field takes anything, and verifying the key
    // checks the id against OpenRouter's own catalogue before saving.
    models: ["stealth/ox-alpha"],
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

// --- Which model, for which job ---------------------------------------------

/**
 * The Owner's per-job model choices, holding only what has been changed.
 *
 * Validated the same way `readRoutes` is, and dropped rather than clamped for
 * the same reason: a typo must not become a policy. The extra check here is
 * that the model has to be one we can *price* — an unknown model falls through
 * to `FALLBACK` in `claudePricing.ts`, which is deliberately the most expensive
 * rate we know of, and a budget ceiling reading a guess is the one place a
 * silent typo costs real money.
 */
export async function readJobModels(): Promise<Partial<Record<ModelJob, string>>> {
  const raw = await getSetting(SETTING.MODEL_JOB_MODELS);
  if (!raw?.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn("[models] models.jobModels is not valid JSON — using the shipped tiers.");
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

  const chosen: Partial<Record<ModelJob, string>> = {};
  for (const [job, model] of Object.entries(parsed as Record<string, unknown>)) {
    if (!isModelJob(job)) continue;
    if (typeof model !== "string" || !model.trim()) continue;
    chosen[job] = model.trim();
  }
  return chosen;
}

/** True when we hold a published rate for this model, from either table. */
export function isPricedModel(model: string): boolean {
  return model in MODEL_PRICING || model in PROVIDER_PRICING;
}

/**
 * The model that will serve this job on this vendor.
 *
 * Three answers in order: what the Owner set for this job, then the job's tier,
 * then the vendor's own model setting. The tier is the part that was missing —
 * `providerModel` answers "which Gemini", which is a different question from
 * "how much is reading the post worth paying for", and asking only the first
 * had a thousand mailbox messages a month served by the headline model.
 *
 * An override naming a model we cannot price is ignored with a line in the log
 * rather than honoured. `verifyProviderKey` is where a typed model name is
 * proved against the vendor; this is a spending guard, and a guard that trusts
 * a string it cannot price is not one.
 */
export async function modelForJob(job: ModelJob, provider: ProviderKey): Promise<string> {
  const chosen = (await readJobModels())[job];
  if (chosen) {
    if (isPricedModel(chosen)) return chosen;
    console.warn(`[models] ${chosen} is set for ${job} but has no published rate here — using the tier instead. Add it to models.pricing to use it.`);
  }
  if ((JOBS[job].tier ?? "standard") === "economy") return PROVIDERS[provider].economyModel;
  return providerModel(provider);
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
  /** The model that vendor will use for this job, tier and override applied. */
  model: string;
  /** What this job costs by default: "economy" or "standard". */
  tier: ModelTier;
  /** The Owner's own model choice for this job, when they have made one. */
  modelOverride: string | null;
  /** True when the chosen vendor is connected and really is serving. */
  ready: boolean;
  /** Why it is falling back, in one sentence, when it is. */
  note: string | null;
}

/**
 * Everyone who could serve this job if the first choice is not connected, in
 * the order they should be tried.
 *
 * The declared fallback first — that is the Owner-facing promise, and Claude
 * is the floor for a reason — and then **every other vendor that can actually
 * do this job**. That last clause is the whole point of this function, and it
 * exists because of a real failure: `vision` is routed to ChatGPT and falls
 * back to Claude, so a deployment holding only a Gemini key had no model at
 * all for looking at a page. The audit dutifully took two screenshots of a
 * prospect's homepage, paid Apify for them, and then filed
 * "the homepage was photographed but not reviewed" — while a vendor that reads
 * pictures perfectly well sat connected and unasked one line away.
 *
 * A vendor that cannot do the job is never in this list, so the chain can only
 * ever end at somebody who can. Perplexity is not a stand-in for looking at a
 * screenshot no matter how many keys are missing.
 */
function standInsFor(job: ModelJob, chosen: ProviderKey): ProviderKey[] {
  const fallback = JOBS[job].fallback;
  const ordered = [fallback, ...PROVIDER_KEYS];
  const seen = new Set<ProviderKey>([chosen]);
  const chain: ProviderKey[] = [];
  for (const candidate of ordered) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (!PROVIDERS[candidate].jobs.includes(job)) continue;
    chain.push(candidate);
  }
  return chain;
}

/** "ChatGPT, Claude or Gemini" — everyone who could do this job. */
function couldServe(job: ModelJob): string {
  const names = PROVIDER_KEYS.filter((key) => PROVIDERS[key].jobs.includes(job)).map((key) => PROVIDERS[key].name);
  if (names.length <= 1) return names[0] ?? "a model";
  return `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`;
}

/**
 * Who serves this job right now.
 *
 * The fallback is the point of this function. A job routed to a vendor with no
 * key does not fail and does not silently produce nothing — it goes to whoever
 * *is* connected and can do the work, and says so, so the system keeps working
 * from the moment it is deployed and gets better with each key that arrives.
 *
 * "Not connected" is therefore reserved for what it actually means: not one of
 * the vendors that can do this job has a key. That is a sentence the Owner can
 * act on, and it is now only ever printed when it is true.
 */
export async function routeFor(job: ModelJob): Promise<Routing> {
  const routes = await readRoutes();
  const chosen = routes[job] ?? JOBS[job].defaultProvider;
  const tier = JOBS[job].tier ?? "standard";
  const modelOverride = (await readJobModels())[job] ?? null;

  if (await providerConfigured(chosen)) {
    return { job, chosen, serving: chosen, tier, modelOverride, model: await modelForJob(job, chosen), ready: true, note: null };
  }

  const chosenName = PROVIDERS[chosen].name;
  for (const standIn of standInsFor(job, chosen)) {
    if (!(await providerConfigured(standIn))) continue;
    return {
      job,
      chosen,
      tier,
      modelOverride,
      serving: standIn,
      model: await modelForJob(job, standIn),
      ready: false,
      note: `${chosenName} isn't connected, so ${PROVIDERS[standIn].name} is doing ${JOBS[job].phrase} for now. Add a ${chosenName} key under Settings → AI models.`,
    };
  }

  // Nothing that can do this job is connected. The caller turns this into the
  // sentence the Owner reads, so it is named here rather than thrown.
  return {
    job,
    chosen,
    tier,
    modelOverride,
    serving: chosen,
    model: await modelForJob(job, chosen),
    ready: false,
    note: `No model is connected for ${JOBS[job].phrase}. Add a ${couldServe(job)} key under Settings → AI models — any one of them can do this.`,
  };
}

/**
 * Everyone who could actually serve this job right now, best first.
 *
 * `routeFor` answers "who starts". This answers "and who takes over when that
 * one fails", which is a different question and was missing: the routing chain
 * only ever ran when a vendor had **no key**, so a vendor that was connected
 * and then rate-limited, rejected the key, timed out, ran out of credits or
 * returned something unparseable took the whole job down with it. A screenshot
 * nobody looked at and a demo page that was never built are the two that cost
 * the most, because both are paid for upstream — the Apify run happened, the
 * design lookup happened, and then the one vendor that mattered was busy.
 *
 * Only vendors that declare the job are in the chain, so a failing vision call
 * never falls through to a model that cannot see, however many keys exist.
 * Configured is checked here rather than at the point of failure so that a
 * chain of one is knowable in advance.
 */
export async function serveChain(job: ModelJob): Promise<{ chosen: ProviderKey; chain: ProviderKey[] }> {
  const routes = await readRoutes();
  const chosen = routes[job] ?? JOBS[job].defaultProvider;

  const ordered = [chosen, ...standInsFor(job, chosen)];
  const chain: ProviderKey[] = [];
  for (const candidate of ordered) {
    if (!PROVIDERS[candidate].jobs.includes(job)) continue;
    if (!(await providerConfigured(candidate))) continue;
    chain.push(candidate);
  }
  return { chosen, chain };
}

/**
 * The sentence a person reads when somebody other than the first choice
 * answered, or when nobody could.
 */
export function describeHandover(job: ModelJob, chosen: ProviderKey, serving: ProviderKey, why: string): string {
  return `${PROVIDERS[chosen].name} could not do ${JOBS[job].phrase} (${why}), so ${PROVIDERS[serving].name} did it instead.`;
}

/** "ChatGPT, Claude or Gemini" — everyone who could do this job. Exported for the caller's error wording. */
export function vendorsFor(job: ModelJob): string {
  return couldServe(job);
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
  economyModel: string;
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
        economyModel: definition.economyModel,
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
