import { SETTING, getSetting, isEnvManaged } from "../settings.js";
import type { Effort } from "../claude.js";
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
export type ProviderKey = "anthropic" | "openai" | "gemini" | "perplexity" | "nvidia";

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
  /** Reading an imported spreadsheet of leads into tables and columns. */
  | "spreadsheet"
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
  | "vision"
  /** Looking at the same picture and deciding whether the page needs rebuilding. */
  | "redesign";

export const MODEL_JOBS: ModelJob[] = ["text", "spreadsheet", "organise", "triage", "image", "html", "factcheck", "research", "humanise", "vision", "redesign"];

/**
 * The jobs that are handed a picture, and therefore may only ever be served by
 * a model that can see one.
 *
 * Two of them now, which is why this is a list rather than a comparison against
 * the word "vision" written out in three places. The cost of getting it wrong
 * is the same for both and it is a quiet one: a screenshot bought at Apify,
 * sent to a model that cannot open it, and described convincingly anyway.
 */
export const PICTURE_JOBS: ModelJob[] = ["vision", "redesign"];

/** True for a job whose request carries an image. */
export function needsSight(job: ModelJob | "agent"): boolean {
  return (PICTURE_JOBS as string[]).includes(job);
}

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
 * These are the Owner's choices, written down: **NVIDIA serves every job it
 * can do**, ChatGPT draws the pictures, and each job moves down its chain when
 * NVIDIA isn't connected or a call through it fails — the declared fallback
 * first, then every other vendor that can do the work.
 *
 * NVIDIA is asked on the **free model picked for that job**, and only pays for
 * one when three free ones have refused the work. See `FREE_LADDER_BY_JOB`.
 */
export const JOBS: Record<ModelJob, JobDescription & { defaultProvider: ProviderKey }> = {
  text: {
    job: "text",
    name: "Writing",
    phrase: "writing",
    blurb: "Every piece of prose the system produces — proposal copy, email drafts, ad concepts, page copy, cold outreach.",
    defaultProvider: "nvidia",
    fallback: "anthropic",
  },
  spreadsheet: {
    job: "spreadsheet",
    name: "Reading sheets",
    phrase: "reading a spreadsheet",
    blurb:
      "Reads an imported spreadsheet of leads — where every table starts and stops, what each column means, which columns don't fit — and returns the plan a person reviews before anything is written.",
    // NVIDIA first like everything else. This was the one judgement job in
    // the system still hard-wired to Claude through its own private call path,
    // which made it the one model nobody could change. It is a routing
    // decision like any other now: NVIDIA by default, Claude standing in
    // behind it, both changeable from the Settings screen.
    defaultProvider: "nvidia",
    fallback: "anthropic",
    // No economy tier on purpose. Getting a table boundary wrong costs the
    // Owner an afternoon of cleanup, and a sheet is analysed once per file,
    // not once per row — this is not the place to save thinking.
  },
  organise: {
    job: "organise",
    name: "Sorting a prompt",
    phrase: "sorting a prompt into sections",
    blurb:
      "Reading a written instruction and filing it under the ten headings an agent prompt is made of — so a pasted playbook becomes a prompt rather than a wall of text.",
    // NVIDIA first like everything else. This job is comprehension and
    // filing, not prose: nothing it returns is read by a customer, and the
    // failure that matters is a paragraph put under the wrong heading or
    // quietly reworded. Every vendor that can follow a schema can do it, so
    // the chain is wide and the cost is a rounding error against being wrong.
    defaultProvider: "nvidia",
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
    defaultProvider: "nvidia",
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
    blurb: "Pictures for ads, social posts and mock-ups. Drawn free on NVIDIA, with ChatGPT behind it.",
    // **Free first, like every other job**, as of 1 Sep 2026. It was ChatGPT
    // and only ChatGPT, with a comment explaining that naming anybody else
    // would be a fallback that does not exist — which was true, and was a fact
    // about this app rather than about the world: `generateImage` spoke one
    // vendor's images API and refused everything else outright. So the one job
    // in the system that costs real money per call was also the one job with
    // no alternative and no chain, and a missing ChatGPT key meant no pictures
    // at all rather than free ones.
    defaultProvider: "nvidia",
    // A real fallback now, and the reason the chain matters here more than
    // anywhere else: a free image endpoint is the least reliable thing in the
    // system — three of the four in `IMAGE_MODELS` would not serve at all when
    // this was written — and the work behind a picture (an ad concept, a
    // mock-up somebody is waiting on) is worth paying for when free capacity
    // is short.
    fallback: "openai",
  },
  html: {
    job: "html",
    name: "Web pages",
    phrase: "building web pages",
    blurb: "Complete HTML pages on the brand design system — the thing a developer opens and edits.",
    defaultProvider: "nvidia",
    fallback: "anthropic",
  },
  factcheck: {
    job: "factcheck",
    name: "Fact-checking",
    phrase: "fact-checking",
    blurb: "Checks a draft's claims against live sources, so nothing goes out that stopped being true last year.",
    // NVIDIA carries the job by default, per the Owner's call. It does not
    // search the live web, so an answer it gives reports itself as checked
    // against no live source — the tool result says who checked and against
    // what, and Perplexity stays one step down the chain for when that
    // distinction matters more than the default does.
    defaultProvider: "nvidia",
    fallback: "anthropic",
  },
  research: {
    job: "research",
    name: "Research",
    phrase: "researching a company",
    blurb:
      "Finds out who a prospect actually is — trade, address, reputation, who runs it — from live sources, and fills the blanks a scrape left behind.",
    // Same reasoning as factcheck above: NVIDIA by default, and the result
    // records honestly whether what came back was searched for or remembered.
    defaultProvider: "nvidia",
    fallback: "anthropic",
  },
  humanise: {
    job: "humanise",
    name: "Plain English",
    phrase: "plain-English rewrites",
    blurb: "Rewrites a draft to sound like a person wrote it and to be understood on one reading.",
    defaultProvider: "nvidia",
    fallback: "anthropic",
  },
  vision: {
    job: "vision",
    name: "Looking",
    phrase: "looking at a page",
    blurb:
      "Reads a screenshot of a prospect's homepage and says what a first-time visitor actually sees — the half of a site audit that markup cannot answer.",
    defaultProvider: "nvidia",
    fallback: "anthropic",
  },
  redesign: {
    job: "redesign",
    name: "The redesign call",
    phrase: "deciding whether a page needs a redesign",
    blurb:
      "Looks at the same pictures the reviewer read and answers the question the business owner is actually asking — rebuild it, fix a few things, or leave it alone — with the paragraph that goes into a proposal.",
    // **Perplexity, and it is the only job routed there for something other
    // than searching.** The Owner's call, and it separates two questions that
    // one model was answering in one breath: what is visibly true of this page,
    // and what should be done about it. A reviewer that has just listed six
    // faults slides into recommending a rebuild, because that is where a list
    // of faults leads — and "you need a new website" is the most expensive
    // sentence in a proposal to have got wrong.
    //
    // What the vendor brings that a describing model does not is the live half:
    // the judgement is made against what a page in this trade looks like now
    // rather than against whatever was current when a model finished training.
    //
    // NVIDIA behind it rather than Claude, because this is a picture job before
    // it is a writing one and the free vision ladder does it for nothing.
    // Claude is still in the chain underneath. Every vendor that can be reached
    // for this job can see — `standInsFor` guarantees it.
    defaultProvider: "perplexity",
    fallback: "nvidia",
  },
};

// --- The free models --------------------------------------------------------

/**
 * What one free NVIDIA model can actually do.
 *
 * **This table is written down rather than read from the catalogue, and that
 * is not laziness.** NVIDIA's `/v1/models` returns `id`, `object`, `created`
 * and `owned_by` — and nothing else. There is no `supported_parameters`, no
 * capability list, nothing that says whether a model calls tools, honours a
 * strict JSON schema or can see a picture. OpenRouter published all three,
 * which is why the vendor this replaced could ask the catalogue at runtime
 * (`openRouterCompilesSchemas`) instead of keeping a list.
 *
 * So each flag below is the result of an actual request against the actual
 * endpoint, and the date it was checked is recorded. A flag nobody has proved
 * is a flag that is wrong eventually — and getting these wrong is expensive in
 * two different directions: claiming a schema a model ignores means the model
 * is asked for "a plan" with no description of one anywhere in the request
 * (see `schemaContract`), and claiming vision a model does not have means a
 * homepage screenshot is paid for at Apify and then described by a model that
 * cannot see it.
 */
export interface FreeModel {
  id: string;
  /** What it is called on screen. "GPT-OSS 120B", not the slug. */
  name: string;
  /** Who built it. Used to keep a ladder from being three hats on one head. */
  house: string;
  /** NVIDIA's own one-line description of what it is for. */
  blurb: string;
  /** Function calling — required by the agent loop, ignored by `callModel`. */
  tools: boolean;
  /**
   * How this model can be asked for JSON, which is three answers rather than
   * two — and finding that out cost three probes, so it is written down here.
   *
   * - `enforced` — takes `response_format: json_schema` and actually compiles
   *   it. The schema alone is the whole instruction.
   * - `accepted` — takes `json_schema`, answers 200, and hands back an object
   *   with field names it invented. `google/diffusiongemma` does this, and it
   *   **rejects `json_object` outright** ("requires a JSON schema"), so the
   *   schema still has to be sent; it just cannot be relied on.
   * - `object` — 500s on a strict schema and takes `json_object` instead.
   *   `meta/llama-3.2-90b-vision-instruct` is this one.
   *
   * Anything but `enforced` gets the shape written into the prompt as well —
   * see `schemaContract`. Without that, a model is asked for "a plan" with no
   * description of one anywhere in the request, because every caller in this
   * app describes its answer in the schema and nowhere else.
   */
  schema: "enforced" | "accepted" | "object";
  /** Reads images. Three of these do; most do not. */
  vision: boolean;
  /**
   * Takes `reasoning_effort`, and takes it on the OpenAI scale.
   *
   * Load-bearing: `openai/gpt-oss-*` answers **400** — "Input should be 'low',
   * 'medium' or 'high'" — to anything else, and the vendor this replaced sent
   * its own word `max` on every high-effort call. A model with this false is
   * sent no effort at all rather than a guess.
   */
  reasoning: boolean;
  /** When these flags were last proved against the endpoint. */
  checked: string;
  /** Set when the endpoint would not serve at all, with what it said. */
  down?: string;
}

/**
 * Every free NVIDIA model this app has verified, and what each is for.
 *
 * Two of them are listed and currently unserviceable. They are kept here
 * rather than deleted because a model that is overloaded today is a model that
 * works next month, and the Owner can put one back in a ladder from the
 * Settings screen the moment it does — but neither is in a shipped ladder, so
 * no job spends its first attempt on a known-dead endpoint.
 */
export const FREE_MODELS: FreeModel[] = [
  {
    id: "moonshotai/kimi-k3",
    name: "Kimi K3",
    house: "Moonshot AI",
    blurb: "~2.8T hybrid KDA+MLA multimodal MoE for long-horizon coding, agentic tool use, and image understanding.",
    tools: true,
    schema: "enforced",
    vision: true,
    reasoning: true,
    checked: "2026-09-01",
  },
  {
    id: "nvidia/nemotron-3-super-120b-a12b",
    name: "Nemotron 3 Super 120B",
    house: "NVIDIA",
    blurb: "Open, efficient hybrid Mamba-Transformer MoE with 1M context, excelling in agentic reasoning, coding, planning and tool calling.",
    tools: true,
    schema: "enforced",
    vision: false,
    reasoning: true,
    checked: "2026-09-01",
  },
  {
    id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
    name: "Nemotron 3 Nano Omni",
    house: "NVIDIA",
    blurb: "Omni-modal reasoning model that understands images, video, speech and text.",
    tools: true,
    schema: "enforced",
    vision: true,
    reasoning: true,
    checked: "2026-09-01",
  },
  {
    id: "openai/gpt-oss-120b",
    name: "GPT-OSS 120B",
    house: "OpenAI",
    blurb: "Mixture of Experts (MoE) reasoning LLM (text-only) designed to fit within an 80GB GPU.",
    tools: true,
    schema: "enforced",
    vision: false,
    reasoning: true,
    checked: "2026-09-01",
  },
  {
    id: "openai/gpt-oss-20b",
    name: "GPT-OSS 20B",
    house: "OpenAI",
    blurb: "Smaller Mixture of Experts (MoE) text-only LLM for efficient AI reasoning and math.",
    tools: true,
    schema: "enforced",
    vision: false,
    reasoning: true,
    checked: "2026-09-01",
  },
  {
    id: "google/diffusiongemma-26b-a4b-it",
    name: "DiffusionGemma 26B",
    house: "Google",
    blurb: "Diffusion-based 26B parameter LLM enabling parallel token generation for real-time text apps.",
    tools: true,
    // Accepts `json_schema`, answers 200, and returns a fenced object with its
    // own field names. Accepting a parameter is not honouring it — and it
    // refuses `json_object`, so the schema is still what goes on the wire.
    schema: "accepted",
    vision: true,
    reasoning: false,
    checked: "2026-09-01",
  },
  {
    id: "meta/llama-3.2-90b-vision-instruct",
    name: "Llama 3.2 90B Vision",
    house: "Meta",
    blurb: "Cutting-edge vision-language model excelling in high-quality reasoning from images.",
    tools: true,
    // 500 on a strict schema, reliably; `json_object` is what it takes. The
    // shape goes in the prompt alongside it.
    schema: "object",
    vision: true,
    reasoning: false,
    checked: "2026-09-01",
  },
  {
    id: "google/gemma-4-31b-it",
    name: "Gemma 4 31B",
    house: "Google",
    blurb: "Dense 31B model delivering frontier reasoning for coding, agentic workflows and fine-tuning.",
    tools: true,
    schema: "enforced",
    vision: true,
    reasoning: true,
    checked: "2026-09-01",
    down: "504 Gateway Timeout on every request, twice, fifteen minutes apart. Not in any shipped ladder until it serves again.",
  },
  {
    id: "mistralai/mistral-nemotron",
    name: "Mistral Nemotron",
    house: "Mistral AI",
    blurb: "Built for agentic workflows, this model excels in coding, instruction following and function calling.",
    tools: true,
    schema: "enforced",
    vision: false,
    reasoning: false,
    checked: "2026-09-01",
    down: "Times out at three minutes, or answers 500 'Inference connection error'. The expensive failure shape — a request that hangs rather than refusing — so it is kept out of every shipped ladder.",
  },
];

export const FREE_MODEL_IDS = FREE_MODELS.map((model) => model.id);

const FREE_BY_ID = new Map(FREE_MODELS.map((model) => [model.id, model]));

/** What this app knows about a free model, or null for one it has never checked. */
export function freeModel(id: string): FreeModel | null {
  return FREE_BY_ID.get(id) ?? null;
}

/** True when every model on this vendor is free, which is the whole point of it. */
export function isNvidiaModel(id: string): boolean {
  return FREE_BY_ID.has(id);
}

// --- The free image models --------------------------------------------------

/**
 * One free NVIDIA image model, and what it is actually called at.
 *
 * These are **not** in `FREE_MODELS` and must not be: they live on a different
 * host, speak a different wire, and cannot serve a single one of the text jobs.
 * Putting them in one list would let somebody pick FLUX for the `triage` job
 * from a dropdown, which is exactly the kind of route that looks saved and
 * never once serves.
 *
 * **Addressed by function id, not by slug.** NVIDIA serves these through Cloud
 * Functions (`/v2/nvcf/pexec/functions/<id>`) rather than through the
 * OpenAI-shaped catalogue, and the friendly path on `ai.api.nvidia.com` either
 * hangs or 404s "Not found for account". The id is what actually works, so the
 * id is what is written down; `id` here is a name for people.
 */
export interface ImageModel {
  /** What the Owner picks and what is stored. */
  id: string;
  /** What it is called on screen. */
  name: string;
  /** Who built it. */
  house: string;
  /** What it is for, in one line. */
  blurb: string;
  /** The NVCF function this actually invokes. */
  functionId: string;
  /** When this was last proved against the endpoint. */
  checked: string;
  /** Set when the endpoint would not serve, with what it said. */
  down?: string;
}

/**
 * Every free NVIDIA image model this app has verified.
 *
 * One of the four serves today. The other three are listed as ACTIVE functions
 * on the account and answer **504** or hang — which is capacity rather than a
 * dead slug, and is exactly why they are kept here rather than deleted: the
 * Owner can put one back in the ladder from the Settings screen the moment it
 * starts serving again. None of them is in the shipped ladder.
 */
export const IMAGE_MODELS: ImageModel[] = [
  {
    id: "black-forest-labs/flux.2-klein-4b",
    name: "FLUX.2 Klein 4B",
    house: "Black Forest Labs",
    blurb: "Fast text-to-image. Returns a 1024px JPEG in a few seconds, and honours width and height.",
    functionId: "f67e96d8-1c4e-422e-a913-90f00e19aa9a",
    checked: "2026-09-01",
  },
  {
    id: "black-forest-labs/flux.1-schnell",
    name: "FLUX.1 Schnell",
    house: "Black Forest Labs",
    blurb: "The fast FLUX.1 variant, built for few-step generation.",
    functionId: "105fe02c-924b-4dfa-9797-92d89c3936ad",
    checked: "2026-09-01",
    down: "504 Gateway Timeout after a minute, twice. The function is ACTIVE on the account, so this is capacity rather than a retired model — worth trying again another day.",
  },
  {
    id: "black-forest-labs/flux.1-dev",
    name: "FLUX.1 Dev",
    house: "Black Forest Labs",
    blurb: "The higher-quality, slower FLUX.1 variant.",
    functionId: "0c474133-6fd2-42f6-be29-8ebbbaeaaeb2",
    checked: "2026-09-01",
    down: "504 Gateway Timeout after a minute. Same capacity story as Schnell.",
  },
  {
    id: "nvidia/cosmos3-super-text2image",
    name: "Cosmos 3 Super",
    house: "NVIDIA",
    blurb: "NVIDIA's own text-to-image model.",
    functionId: "f65a2585-3b67-46ce-a431-af764d93e954",
    checked: "2026-09-01",
    down: "Never answered — held the connection open past three minutes. The expensive failure shape, so it is kept out of the shipped ladder.",
  },
];

export const IMAGE_MODEL_IDS = IMAGE_MODELS.map((model) => model.id);

const IMAGE_BY_ID = new Map(IMAGE_MODELS.map((model) => [model.id, model]));

/** What this app knows about a free image model, or null for one it has never checked. */
export function imageModelInfo(id: string): ImageModel | null {
  return IMAGE_BY_ID.get(id) ?? null;
}

/**
 * Where a free image model is invoked.
 *
 * Null for an id this app has not got a function for — which is the whole
 * reason a typed id cannot be honoured here the way a typed chat model can.
 * On the text wire a slug is the address; here the address is a UUID nobody
 * can guess, so an unknown image model is refused rather than attempted.
 */
export function imageFunctionUrl(id: string): string | null {
  const model = IMAGE_BY_ID.get(id);
  if (!model) return null;
  return `${nvcfBase()}/v2/nvcf/pexec/functions/${model.functionId}`;
}

/** Where a queued NVCF request is polled. */
export function imageStatusUrl(requestId: string): string {
  return `${nvcfBase()}/v2/nvcf/pexec/status/${requestId}`;
}

/**
 * NVIDIA Cloud Functions, which is a **different host** from the chat wire.
 *
 * `integrate.api.nvidia.com` serves the OpenAI-shaped catalogue and knows
 * nothing about these; `ai.api.nvidia.com/v1/genai/...` is the documented
 * friendly path and either hangs or answers "Not found for account" here. So
 * this is its own base with its own override, rather than a path under
 * `vendorBase("nvidia")` — one function, read per call, for the same reason
 * `vendorBase` is one function.
 */
export function nvcfBase(): string {
  return (process.env.NVCF_BASE_URL || "https://api.nvcf.nvidia.com").replace(/\/$/, "");
}

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
    jobs: ["text", "spreadsheet", "organise", "triage", "html", "factcheck", "research", "humanise", "vision", "redesign"],
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
    jobs: ["text", "spreadsheet", "organise", "triage", "image", "html", "vision", "redesign"],
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
    jobs: ["text", "spreadsheet", "organise", "triage", "html", "vision", "redesign"],
    models: ["gemini-3.7-flash", "gemini-3.1-pro-preview", "gemini-2.5-flash"],
  },
  perplexity: {
    key: "perplexity",
    name: "Perplexity",
    vendor: "Perplexity",
    purpose: "Checks claims against live sources, rewrites drafts into plain English, and makes the redesign call on a homepage it has been shown.",
    keySetting: SETTING.PERPLEXITY_KEY,
    modelSetting: SETTING.PERPLEXITY_MODEL,
    defaultModel: "sonar",
    economyModel: "sonar",
    console: "https://www.perplexity.ai/account/api/group",
    keyHint: "pplx-…",
    // It searches the live web on every call, which is what makes it the right
    // answer for "is this still true" and the wrong one for drawing a picture.
    //
    // **`redesign` and not `vision`, and the difference is the whole point.**
    // This vendor takes an image now (see `callPerplexity`), so the temptation
    // is to list both. They are not the same job. `vision` is description —
    // what is visibly true of this page, boxed and numbered onto the
    // screenshot — and a vendor that answers every question with the live web
    // behind it is the wrong instrument for describing a picture in front of
    // it. `redesign` is a decision about what to do, and there the live half
    // is exactly what is wanted.
    jobs: ["text", "triage", "factcheck", "research", "humanise", "redesign"],
    models: ["sonar", "sonar-pro", "sonar-reasoning-pro"],
  },
  nvidia: {
    key: "nvidia",
    // **The shop, not the model**, and this time the shop is the point.
    //
    // Every model here is served free from NVIDIA's own build catalogue, on
    // one OpenAI-shaped wire, against one key. It replaced OpenRouter on
    // 1 Sep 2026 for a reason that was costing real work: OpenRouter served
    // one free model to every job at once, so one busy endpoint or one
    // exhausted daily cap took the whole workforce down together. NVIDIA
    // lists a **different model per kind of work** — a small fast one for
    // reading the post, a 1M-context one for a spreadsheet, three that can
    // actually look at a picture — so the ladder underneath each job is now
    // three models picked for that job rather than three copies of one guess.
    //
    // See `FREE_MODELS` for the catalogue and `FREE_LADDER_BY_JOB` for the
    // assignment.
    name: "NVIDIA",
    vendor: "NVIDIA",
    purpose:
      "The default for every job it can do, and every model on it is free. One key covers writing, sorting, triage, pages, research, fact-checking, plain English, looking at a page and the redesign call — each on the free model picked for that job.",
    keySetting: SETTING.NVIDIA_KEY,
    modelSetting: SETTING.NVIDIA_MODEL,
    // What NVIDIA is asked for when the free ladders are switched off, which
    // is a strange thing to do here and is allowed anyway: every model on this
    // vendor is free, so "off" means *one* free model for everything instead
    // of the right one per job. It is the strongest all-rounder in the
    // catalogue — the only model that does tools, a strict schema and vision
    // at once.
    defaultModel: "moonshotai/kimi-k3",
    // The small, fast, genuinely cheaper-to-wait-for one. Free either way, so
    // the economy tier here buys latency rather than money — which is exactly
    // what triage and prompt-sorting want.
    economyModel: "openai/gpt-oss-20b",
    console: "https://build.nvidia.com/settings/api-keys",
    keyHint: "nvapi-…",
    // **Every job, `image` included as of 1 Sep 2026.** It was excluded on the
    // true-at-the-time reasoning that `generateImage` only spoke OpenAI's
    // images API, so listing it would put a route in the dropdown that looks
    // saved and never once serves. That is still the rule; what changed is
    // that the app now speaks a second image wire. NVIDIA's image models are
    // not on this vendor's chat host at all — they are Cloud Functions on
    // `api.nvcf.nvidia.com`, addressed by function id. See `IMAGE_MODELS`.
    jobs: ["text", "spreadsheet", "organise", "triage", "image", "html", "factcheck", "research", "humanise", "vision", "redesign"],
    // The dropdown offers what this app has actually verified against the
    // endpoint, which is a narrower list than NVIDIA's catalogue on purpose —
    // see `FREE_MODELS`. Anything else can still be typed.
    models: FREE_MODEL_IDS,
  },
};

export const PROVIDER_KEYS = Object.keys(PROVIDERS) as ProviderKey[];

export function isProviderKey(value: unknown): value is ProviderKey {
  return typeof value === "string" && (PROVIDER_KEYS as string[]).includes(value);
}

export function isModelJob(value: unknown): value is ModelJob {
  return typeof value === "string" && (MODEL_JOBS as string[]).includes(value);
}

// --- How hard the model thinks ----------------------------------------------

/**
 * Our effort word onto the scale the wire actually accepts.
 *
 * **low / medium / high, and nothing else.** This is the one line in the model
 * layer with a live 400 behind it: `openai/gpt-oss-120b` and `-20b` answer
 *
 *     400 {"type":"literal_error","loc":["body","reasoning_effort"],
 *          "msg":"Input should be 'low', 'medium' or 'high'"}
 *
 * to anything outside that set, and the vendor this replaced sent its own word
 * `max` on every high-effort call. Carrying that mapping across would have
 * taken down every high-effort job on two of the seven models the moment this
 * shipped, and taken it down as a *request-shape* failure — which climbs the
 * ladder, so the symptom would have been three free models refusing every
 * important piece of work and the paid floor quietly finishing all of it.
 *
 * That is exactly the shape of bug `checks/modelChoice.ts` exists for: nothing
 * breaks, every answer is correct, and the only symptom is the bill.
 *
 * A model that does not declare `reasoning` is sent no effort at all — see
 * `FreeModel.reasoning`. A parameter a model ignores is free; a parameter it
 * rejects costs the whole request.
 */
export function reasoningEffortFor(effort: Effort): "low" | "medium" | "high" {
  if (effort === "low") return "low";
  if (effort === "medium") return "medium";
  return "high";
}

/**
 * Room for the thinking, on top of room for the answer.
 *
 * On an OpenAI-shaped wire `max_tokens` caps **reasoning plus reply**, the
 * same trap Anthropic's does — but nothing here was leaving any slack for it.
 * The sheet analyst asks for 16,000 tokens because a plan describing forty
 * columns across three tables is genuinely long, and at high effort a reasoning
 * model can spend that much before it writes a character. What comes back then is
 * `finish_reason: "length"` with an empty message, which this layer correctly
 * reads as "produced nothing usable" and hands to the next vendor — so the
 * Owner pays for a reasoning run, waits for it, and gets somebody else's
 * answer, or the pattern rules.
 *
 * So the caller's number keeps meaning what it says — the size of the
 * *answer* — and the thinking is budgeted on top of it here, by the effort we
 * just asked for.
 */
const REASONING_HEADROOM: Record<"low" | "medium" | "high", number> = { low: 2_000, medium: 8_000, high: 16_000 };

/**
 * A ceiling, because `max_tokens` above what a model can actually emit is a
 * 400 on some of them rather than a clamp. 32,000 is twice the agent loop's
 * own budget and inside what every model in `FREE_MODELS` accepts.
 */
const MAX_TOKENS_CEILING = 32_000;

/** The wire's `max_tokens`: the answer the caller asked for, plus the thinking. */
export function tokensWithReasoning(answerTokens: number, effort: Effort): number {
  return Math.min(answerTokens + REASONING_HEADROOM[reasoningEffortFor(effort)], MAX_TOKENS_CEILING);
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

// --- The free ladders -------------------------------------------------------

/**
 * How many free models are worth trying before paying for one.
 *
 * Three, which is the Owner's own number — "if they fail three times, then
 * they move to the paid version" — and it is also the number the mechanism
 * argues for on its own. A free endpoint that does not answer is usually busy
 * rather than broken, so a second one is very likely to work; by the third,
 * the sensible conclusion is that free capacity is short right now and the
 * work still has to happen. Each rung costs a request and some seconds of
 * waiting, and a ladder of ten would turn a busy afternoon into minutes of
 * latency in front of a person, paid for in nothing but delay.
 */
export const FREE_LADDER_MAX = 3;

/**
 * The things a ladder can be picked for.
 *
 * Every routed job, plus `agent` — the loop that runs the workforce, which is
 * not a `ModelJob` because it is not a one-shot call. It needs its own list
 * anyway: it is the only consumer that genuinely *requires* function calling,
 * where the one-shot half only requires a schema, and picking one list for
 * both would mean either barring a good writer that cannot call tools or
 * putting a model in the agent ladder that will fail on its first turn.
 */
export type LadderKey = ModelJob | "agent";

export const LADDER_KEYS: LadderKey[] = [...MODEL_JOBS, "agent"];

export function isLadderKey(value: unknown): value is LadderKey {
  return typeof value === "string" && (LADDER_KEYS as string[]).includes(value);
}

/**
 * Which free models serve which job, in the order they are tried.
 *
 * **This is the assignment**, and it is the reason this vendor replaced the
 * last one. OpenRouter served *one* free model to every job in the system, so
 * every job was only as good as that one model was at the worst thing it was
 * asked to do — and when that endpoint was busy, everything stopped together.
 * NVIDIA lists a different model per kind of work, so each job gets three
 * picked for it.
 *
 * Three rules were applied to every row:
 *
 * 1. **Capability first.** A model that cannot see is never in the `vision`
 *    ladder, however good it is; a model whose schema is ignored is fine
 *    anywhere, because the shape is written into the prompt for it (see
 *    `schemaContract`), but it is not put first on a job whose answer is
 *    forty structured fields.
 * 2. **Three houses where three exist.** Free capacity goes short one provider
 *    at a time, and a ladder of three models from one house is one rung
 *    wearing three hats — it fails as one. `vision` is the row where this
 *    could not be fully honoured: only three models here can see at all.
 * 3. **Nothing that is currently down.** `google/gemma-4-31b-it` and
 *    `mistralai/mistral-nemotron` are both in `FREE_MODELS` and in neither
 *    ladder. A first rung that times out costs every call sixty seconds before
 *    anything useful happens, which is worse than not having it.
 */
export const FREE_LADDER_BY_JOB: Record<LadderKey, string[]> = {
  // Prose a customer reads. The two biggest models here, then a reasoning
  // model that writes cleanly, across three houses.
  text: ["moonshotai/kimi-k3", "nvidia/nemotron-3-super-120b-a12b", "openai/gpt-oss-120b"],

  // A spreadsheet is the one job where context length is the whole game: forty
  // columns across three tables, and the plan is wrong if the model only saw
  // half of it. Nemotron Super carries 1M tokens of context and leads for that
  // reason alone.
  spreadsheet: ["nvidia/nemotron-3-super-120b-a12b", "moonshotai/kimi-k3", "openai/gpt-oss-120b"],

  // Filing a written instruction under ten headings: comprehension, not prose,
  // with a right answer and nothing a customer reads. The small fast model
  // first, and this is what the `economy` tier means on a vendor where
  // everything is free — it buys latency, not money.
  organise: ["openai/gpt-oss-20b", "google/diffusiongemma-26b-a4b-it", "nvidia/nemotron-3-super-120b-a12b"],

  // Runs once per *arriving* message rather than once per piece of work, so a
  // busy mailbox is a thousand calls a month. The two fastest models in the
  // catalogue, in order; DiffusionGemma decodes in parallel and is built for
  // exactly this.
  triage: ["openai/gpt-oss-20b", "google/diffusiongemma-26b-a4b-it", "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning"],

  // **One rung, not three, and that is the honest number.** Four free image
  // models are listed as ACTIVE on the account and exactly one of them serves;
  // the other three answer 504 or hold the connection open past three minutes.
  // A ladder padded out to three with endpoints known not to serve is two
  // wasted attempts and a minute of somebody waiting before the paid vendor is
  // asked. They are in `IMAGE_MODELS` and one click away on the Settings
  // screen for the day they come back.
  //
  // Note these are **image** model ids, from `IMAGE_MODELS` — not the chat
  // catalogue. The two lists never mix: a rung here is a Cloud Function on a
  // different host, and it cannot serve a single one of the text jobs.
  image: ["black-forest-labs/flux.2-klein-4b"],

  // A complete page is a coding job. Kimi K3 is built for long-horizon coding,
  // Nemotron Super for coding and planning, and GPT-OSS 120B reasons its way
  // through a layout well enough to finish one.
  html: ["moonshotai/kimi-k3", "nvidia/nemotron-3-super-120b-a12b", "openai/gpt-oss-120b"],

  // **None of these searches the live web**, which is a real limit rather than
  // a detail: what comes back is reasoned from training data, and the tool
  // result says so (`checkedAgainstLiveSources`). Perplexity stays one step
  // down the chain for when that distinction matters more than free does. So
  // the ladder is ordered by reasoning quality, which is what is actually on
  // offer here.
  factcheck: ["openai/gpt-oss-120b", "nvidia/nemotron-3-super-120b-a12b", "moonshotai/kimi-k3"],

  // Same limit, same honesty, and a longer answer — a company profile is more
  // writing than a claim check, so the 1M-context model leads.
  research: ["nvidia/nemotron-3-super-120b-a12b", "moonshotai/kimi-k3", "openai/gpt-oss-120b"],

  // A rewrite is short, mechanical and wanted immediately, usually with
  // somebody waiting on the screen. DiffusionGemma generates tokens in
  // parallel and is the fastest thing here by a distance.
  humanise: ["google/diffusiongemma-26b-a4b-it", "moonshotai/kimi-k3", "openai/gpt-oss-120b"],

  // The three models in this catalogue that can actually look at a picture,
  // strongest first. Llama 3.2 90B Vision is the largest and is built for
  // reasoning *from* an image rather than captioning one, which is the whole
  // job: what does a first-time visitor to this homepage actually see.
  //
  // Its schema is ignored (500 on a strict one), so the shape goes in the
  // prompt — which is the right trade here, because the alternative is
  // describing a screenshot with a model that cannot see it.
  vision: ["meta/llama-3.2-90b-vision-instruct", "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning", "moonshotai/kimi-k3"],

  // The redesign call is made from the same two pictures, so it is the vision
  // ladder — a model that cannot see cannot decide whether a page needs
  // rebuilding, however well it writes. The order differs by one place and the
  // reason is the job: this answer is a page of prose a client reads rather
  // than a list of observations, so Kimi K3 comes up behind the largest vision
  // model and ahead of the small omni one.
  redesign: ["meta/llama-3.2-90b-vision-instruct", "moonshotai/kimi-k3", "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning"],

  // The workforce loop. Every rung has to call tools — a model that cannot
  // fails on turn one, having read the whole system prompt first — and has to
  // hold a long conversation without losing the thread. All three are verified
  // tool-callers, and Kimi K3 leads because it is the only one built for
  // long-horizon agentic use *and* able to look at a screenshot a tool
  // returned.
  agent: ["moonshotai/kimi-k3", "nvidia/nemotron-3-super-120b-a12b", "openai/gpt-oss-120b"],
};

/**
 * A heading, a clause and an explanation for each thing a ladder serves.
 *
 * Ten of the twelve are already written down in `JOBS`; this exists for the
 * two that are not. `agent` is not a `ModelJob` — it is the loop that runs the
 * workforce — and `image` has no ladder at all, so a screen listing every
 * ladder needs a sentence for both or it shows a blank row and a job the Owner
 * cannot make sense of.
 */
export function ladderLabel(key: LadderKey): { name: string; phrase: string; blurb: string } {
  if (key === "agent") {
    return {
      name: "Running agents",
      phrase: "running an agent",
      blurb:
        "The loop the whole workforce runs on: read the record, decide, call a tool, read what came back, decide again. Every model here has to be able to call tools — one that cannot fails on its first turn, having read the entire system prompt first.",
    };
  }
  const job = JOBS[key];
  return { name: job.name, phrase: job.phrase, blurb: job.blurb };
}

/**
 * The Owner's own ladders, holding only what has been changed.
 *
 * Same shape and same reasoning as `readRoutes` and `capture.actors`: a stored
 * copy of a default is a default that silently stops tracking the code, so a
 * job nobody has touched is absent from this object rather than present with
 * the shipped value in it.
 *
 * **Unset, empty and unreadable are three different states**, and conflating
 * any two of them is a money bug:
 *
 * - **A key absent** — the shipped ladder for that job. A fresh deployment
 *   tries free models without anybody configuring anything.
 * - **A stored list** — that list, capped at three, duplicates dropped.
 * - **A stored empty list** — free models are off *for that job*, deliberately,
 *   and it goes straight to whatever NVIDIA's own model setting names. Somebody
 *   who turned this off must not have it turned back on by a deploy, which is
 *   exactly what would happen if "empty" and "unset" meant the same thing.
 * - **Unreadable JSON** — the shipped ladders, because answering a corrupt
 *   settings row by falling through to a paid model is answering it with money.
 */
export async function readFreeLadders(): Promise<Partial<Record<LadderKey, string[]>>> {
  const raw = await getSetting(SETTING.NVIDIA_FREE_MODELS);
  if (!raw?.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn("[models] nvidia.freeModels is not valid JSON — using the shipped free ladders.");
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

  const ladders: Partial<Record<LadderKey, string[]>> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!isLadderKey(key)) continue;
    if (!Array.isArray(value)) continue;
    const seen = new Set<string>();
    const rungs: string[] = [];
    for (const entry of value) {
      if (typeof entry !== "string") continue;
      const id = entry.trim();
      // A duplicate rung is a rung that proves nothing: the same endpoint that
      // just failed is asked again, and the ladder is one shorter than it looks.
      if (!id || seen.has(id)) continue;
      seen.add(id);
      rungs.push(id);
      if (rungs.length >= FREE_LADDER_MAX) break;
    }
    ladders[key] = rungs;
  }
  return ladders;
}

/** The free models to try for this job, in order. */
export async function freeLadderFor(key: LadderKey): Promise<string[]> {
  const stored = (await readFreeLadders())[key];
  if (stored) return stored;
  return [...FREE_LADDER_BY_JOB[key]];
}

/**
 * Where the ladder in use came from.
 *
 * The screen needs this and cannot infer it: "three rungs" looks identical
 * whether they are the shipped picks or the Owner's own, and "no rungs" reads
 * as *not set up* when it actually means *deliberately switched off*. Every
 * one of those is a different sentence to put in front of somebody.
 */
export type LadderSource = "shipped" | "owner" | "off";

export async function freeLadderSource(key: LadderKey): Promise<LadderSource> {
  const stored = (await readFreeLadders())[key];
  if (!stored) return "shipped";
  return stored.length > 0 ? "owner" : "off";
}

/**
 * True when this model costs nothing.
 *
 * Two ways to be free, and both are needed:
 *
 * 1. **It is in `FREE_MODELS`** — a model this app has called against NVIDIA's
 *    endpoint and recorded. Every model NVIDIA serves there is free, which is
 *    the whole reason this vendor was chosen.
 * 2. **It is a rung of a ladder** — including one the Owner picked from the
 *    part of NVIDIA's catalogue this app has never probed. The picker offers
 *    those and marks them unchecked; they are still NVIDIA models on the free
 *    endpoint, and pricing one at the unknown-model rate would charge for a
 *    call that cost nothing.
 *
 * Getting this wrong only ever goes one way in practice and it is the
 * expensive way: an unpriced model falls through to `FALLBACK` in
 * claudePricing.ts, which is deliberately the dearest rate known, so a day's
 * work on free models would read on the costs screen as the most expensive day
 * this company has ever had and trip every budget ceiling on money nobody
 * spent. That is exactly what happened the first time this was written as
 * catalogue-membership alone.
 *
 * A model that is in neither is not assumed free — a slug typed into a
 * vendor's model field is not a promise about its price.
 */
export async function isFreeModel(model: string): Promise<boolean> {
  if (isNvidiaModel(model)) return true;
  // The image catalogue is a separate list on a separate host, and it is just
  // as free. Left out, every picture drawn on NVIDIA would be recorded at the
  // unknown-model floor rate.
  if (imageModelInfo(model)) return true;
  const stored = await readFreeLadders();
  for (const key of LADDER_KEYS) {
    const ladder = stored[key] ?? FREE_LADDER_BY_JOB[key];
    if (ladder.includes(model)) return true;
  }
  return false;
}

/**
 * Every model an NVIDIA attempt should try for this job, in order.
 *
 * The ladder when there is one. **`[undefined]` when there is not** — that is,
 * when somebody has deliberately turned this job's free models off — meaning
 * "whatever this vendor's ordinary model is".
 *
 * When a ladder *is* in use it **replaces** the vendor's model rather than
 * sitting in front of it: the point is a run of free attempts and then the
 * paid floor, and slipping another call in between would be latency nobody
 * asked for at exactly the moment free capacity was short.
 */
export async function nvidiaAttempts(job: ModelJob): Promise<(string | undefined)[]> {
  const ladder = await freeLadderFor(job);
  return ladder.length > 0 ? ladder : [undefined];
}

// --- The paid floor ---------------------------------------------------------

/**
 * The paid models that finish the work when every free rung has refused it,
 * best first.
 *
 * The Owner's instruction on 28 Aug 2026 was: free models first, and when
 * three of them have failed, **the best paid model of the three** — not one
 * named vendor. Until then the floor was Anthropic alone, which is a floor
 * with a single point of failure under a ladder built entirely out of
 * endpoints that fail. A run that got past three busy free models and then met
 * a rate-limited Claude died with two connected vendors sitting unasked.
 *
 * **Why this order.** All three write well and the difference between them at
 * the end of an agent run is not prose, it is whether the model can hold a
 * long tool-calling conversation without losing the thread — twelve turns,
 * sixteen tool results, a checkpoint in the middle, and an escalation that has
 * to be recognised as an ending. Claude is measurably the strongest of the
 * three at that here and is the vendor this loop's own wire was written
 * against; ChatGPT speaks the same chat-completions shape the free rungs do,
 * so it is the smallest possible step sideways; Gemini is last because its
 * function-calling wire is the one furthest from both, not because of the
 * model.
 *
 * **Only what is connected is asked.** A missing key removes a vendor from the
 * chain rather than failing the run — the same rule as `serveChain`, which is
 * what the one-shot half of the model layer has always done and what this
 * brings the agent loop into line with.
 *
 * This is deliberately a constant rather than a setting. The per-job routing
 * screen already lets the Owner say who writes prose and who reads pictures;
 * what order to try the survivors in when three free models have just failed
 * is an engineering answer, and a second dropdown for it would be a way to
 * configure a worse one.
 */
export type PaidProvider = Extract<ProviderKey, "anthropic" | "openai" | "gemini">;
export const PAID_AGENT_CHAIN: readonly PaidProvider[] = ["anthropic", "openai", "gemini"];

/**
 * Where a vendor's API lives, honouring the per-vendor base override.
 *
 * One function, because there were two: `models/call.ts` had its own and the
 * agent loop had `openRouterBase()`, and on 20 Aug 2026 they disagreed — one
 * captured at import, one read per call — so a harness repointing a vendor
 * between scenarios got a frozen address in one half and a live one in the
 * other. That is a check that passes while testing nothing, and on a machine
 * with real keys it is a check that spends money.
 *
 * Read per call, never captured. `anthropic` is absent because the SDK owns
 * its own base URL (`ANTHROPIC_BASE_URL`) and asking twice is how the two
 * halves get to disagree again.
 */
export function vendorBase(vendor: Exclude<ProviderKey, "anthropic">): string {
  const fromEnv = {
    openai: process.env.OPENAI_BASE_URL,
    gemini: process.env.GEMINI_BASE_URL,
    perplexity: process.env.PERPLEXITY_BASE_URL,
    nvidia: process.env.NVIDIA_BASE_URL,
  }[vendor];
  const fallback = {
    openai: "https://api.openai.com/v1",
    gemini: "https://generativelanguage.googleapis.com/v1beta",
    perplexity: "https://api.perplexity.ai",
    nvidia: "https://integrate.api.nvidia.com/v1",
  }[vendor];
  return fromEnv?.replace(/\/$/, "") || fallback;
}

/**
 * NVIDIA's image model when the `image` ladder has been switched off.
 *
 * The same shape as `openRouterAttempts` returning the vendor's own model with
 * no ladder: turning free models off for a job must leave that vendor usable
 * rather than unreachable. There is no per-vendor setting behind this because
 * there is nothing to choose between — the one image model that serves is the
 * one the shipped ladder names.
 */
export async function nvidiaImageModel(): Promise<string> {
  return FREE_LADDER_BY_JOB.image[0] ?? IMAGE_MODEL_IDS[0]!;
}

/** The ChatGPT image model, which is a different model from the same vendor. */
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
 * ever end at somebody who can. Perplexity is not a stand-in for `vision` no
 * matter how many keys are missing — it declares `redesign`, which is a
 * decision made from a picture, and not the describing job that draws boxes on
 * one.
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

  // NVIDIA — build.nvidia.com. **Zero, explicitly**, and the explicitness is
  // the point: an unpriced model falls through to `FALLBACK` in
  // claudePricing.ts, which is deliberately the dearest rate we know of, so a
  // day served entirely by free models would read as the most expensive day
  // this company has ever had. Every id here is in `FREE_MODELS`; the two that
  // are currently down are priced anyway, because they are still free when
  // they come back and a ladder the Owner edits can reach them tomorrow.
  "moonshotai/kimi-k3": { inputPerMTok: 0, outputPerMTok: 0 },
  "nvidia/nemotron-3-super-120b-a12b": { inputPerMTok: 0, outputPerMTok: 0 },
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning": { inputPerMTok: 0, outputPerMTok: 0 },
  "openai/gpt-oss-120b": { inputPerMTok: 0, outputPerMTok: 0 },
  "openai/gpt-oss-20b": { inputPerMTok: 0, outputPerMTok: 0 },
  "google/diffusiongemma-26b-a4b-it": { inputPerMTok: 0, outputPerMTok: 0 },
  "meta/llama-3.2-90b-vision-instruct": { inputPerMTok: 0, outputPerMTok: 0 },
  "google/gemma-4-31b-it": { inputPerMTok: 0, outputPerMTok: 0 },
  "mistralai/mistral-nemotron": { inputPerMTok: 0, outputPerMTok: 0 },

  // The free image models. Zero for the same reason and with the same danger:
  // an unpriced model is charged at the floor rate, and an image call reports
  // no token usage at all, so a picture drawn for nothing would be recorded at
  // whatever the dearest known rate makes of zero tokens.
  "black-forest-labs/flux.2-klein-4b": { inputPerMTok: 0, outputPerMTok: 0 },
  "black-forest-labs/flux.1-schnell": { inputPerMTok: 0, outputPerMTok: 0 },
  "black-forest-labs/flux.1-dev": { inputPerMTok: 0, outputPerMTok: 0 },
  "nvidia/cosmos3-super-text2image": { inputPerMTok: 0, outputPerMTok: 0 },
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