import { SETTING, getSetting } from "./settings.js";

/**
 * A small Apify REST client (https://docs.apify.com/api/v2).
 *
 * Deliberately not the `apify-client` SDK: the four calls we need — start a
 * run, poll it, read its dataset, list actors — are plain HTTP, and keeping
 * them here means the actor-store browser and the runner share one place where
 * auth, timeouts and error shapes are decided.
 */

const API_BASE = "https://api.apify.com/v2";
const REQUEST_TIMEOUT_MS = 30_000;

export class ApifyError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApifyError";
    this.status = status;
  }
}

export class ApifyNotConfiguredError extends ApifyError {
  constructor() {
    super(503, "Apify is not connected. Add an API token under Lead Sources → Connection.");
    this.name = "ApifyNotConfiguredError";
  }
}

export async function getApifyToken(): Promise<string | null> {
  return getSetting(SETTING.APIFY_TOKEN);
}

export async function apifyConfigured(): Promise<boolean> {
  return Boolean(await getApifyToken());
}

/**
 * Actor ids are written `username/actor-name` everywhere in Apify's UI, but
 * the API path segment wants `username~actor-name`. Accepting either and
 * normalising here means the Owner can paste whatever they copied.
 */
export function normalizeActorId(actorId: string): string {
  return actorId.trim().replace(/^https?:\/\/(?:console|apify)\.apify\.com\/actors\//, "").replace("/", "~");
}

/** Back to the display form, for links and labels. */
export function displayActorId(actorId: string): string {
  return actorId.trim().replace("~", "/");
}

interface RequestOptions {
  method?: "GET" | "POST";
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  /** Store search is public; everything else needs the Owner's token. */
  token?: string | null;
  anonymous?: boolean;
  timeoutMs?: number;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const token = options.anonymous ? null : (options.token ?? (await getApifyToken()));
  if (!options.anonymous && !token) throw new ApifyNotConfiguredError();

  const url = new URL(`${API_BASE}${path}`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw new ApifyError(504, "Apify did not respond in time");
    throw new ApifyError(502, `Could not reach Apify: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    // Apify errors come back as { error: { type, message } }; fall back to text.
    const detail = await response
      .json()
      .then((body: any) => body?.error?.message ?? body?.message)
      .catch(() => null);
    const message =
      response.status === 401 || response.status === 403
        ? "Apify rejected the API token. Check it under Lead Sources → Connection."
        : (detail ?? `Apify returned ${response.status} ${response.statusText}`);
    throw new ApifyError(response.status, message);
  }

  if (response.status === 204) return undefined as T;
  const payload = (await response.json()) as { data?: T };
  // Every v2 endpoint wraps its payload in `data`, except dataset items.
  return (payload?.data ?? payload) as T;
}

// --- Account ---------------------------------------------------------------

export interface ApifyAccount {
  id: string;
  username: string;
  profile?: { name?: string };
  plan?: { id?: string; monthlyUsageCreditsUsd?: number };
}

export async function getAccount(token?: string): Promise<ApifyAccount> {
  return request<ApifyAccount>("/users/me", { token });
}

// --- Actors ----------------------------------------------------------------

export interface ApifyActorSummary {
  id: string;
  name: string;
  username: string;
  title?: string;
  description?: string;
  /** `username/name`, the form to store on a ScraperSource. */
  fullName: string;
  stats?: { totalRuns?: number };
  pictureUrl?: string;
  isPublic?: boolean;
}

function toSummary(actor: any): ApifyActorSummary {
  const username = actor.username ?? actor.userFullName ?? actor.user?.username ?? "";
  return {
    id: actor.id,
    name: actor.name,
    username,
    title: actor.title,
    description: actor.description,
    fullName: username ? `${username}/${actor.name}` : actor.name,
    stats: actor.stats,
    pictureUrl: actor.pictureUrl,
    isPublic: actor.isPublic,
  };
}

/** Actors on the Owner's own account. */
export async function listMyActors(): Promise<ApifyActorSummary[]> {
  const result = await request<{ items: any[] }>("/acts", { query: { limit: 100, desc: true } });
  return (result.items ?? []).map(toSummary);
}

/**
 * Apify Store search — this is what makes "add an actor" a search box rather
 * than a field where you have to already know the id. The store is public, so
 * it works before a token has been entered.
 */
export async function searchStore(search: string, limit = 20): Promise<ApifyActorSummary[]> {
  const result = await request<{ items: any[] }>("/store", {
    anonymous: true,
    query: { search: search || undefined, limit, sortBy: search ? undefined : "popularity" },
  });
  return (result.items ?? []).map(toSummary);
}

export interface ApifyActorDetail extends ApifyActorSummary {
  defaultRunOptions?: { build?: string; timeoutSecs?: number; memoryMbytes?: number };
  exampleRunInput?: { body?: string; contentType?: string };
  /** The actor's input JSON schema, when it publishes one. */
  inputSchema?: unknown;
}

export async function getActor(actorId: string): Promise<ApifyActorDetail> {
  const id = normalizeActorId(actorId);
  const actor = await request<any>(`/acts/${id}`);
  const detail: ApifyActorDetail = { ...toSummary(actor), defaultRunOptions: actor.defaultRunOptions };

  // The example input lives on the actor's default build, and is the best
  // starting point we can offer for the input editor.
  const buildTag = actor.defaultRunOptions?.build ?? "latest";
  const buildId = actor.taggedBuilds?.[buildTag]?.buildId;
  if (buildId) {
    try {
      const build = await request<any>(`/actor-builds/${buildId}`);
      const schema = build?.actorDefinition?.input;
      if (schema) detail.inputSchema = schema;
      if (build?.actorDefinition?.exampleRunInput) detail.exampleRunInput = build.actorDefinition.exampleRunInput;
    } catch {
      // An actor without a readable build is still perfectly runnable.
    }
  }
  return detail;
}

// --- Runs ------------------------------------------------------------------

export type ApifyRunStatus =
  | "READY"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "ABORTING"
  | "ABORTED"
  | "TIMING-OUT"
  | "TIMED-OUT";

export interface ApifyRun {
  id: string;
  actId: string;
  status: ApifyRunStatus;
  defaultDatasetId: string;
  startedAt: string;
  finishedAt?: string | null;
  stats?: { computeUnits?: number };
  statusMessage?: string;
}

export async function startRun(
  actorId: string,
  input: unknown,
  options: { timeoutSecs?: number; memoryMbytes?: number; maxItems?: number } = {},
): Promise<ApifyRun> {
  const id = normalizeActorId(actorId);
  return request<ApifyRun>(`/acts/${id}/runs`, {
    method: "POST",
    body: input ?? {},
    query: {
      timeout: options.timeoutSecs,
      memory: options.memoryMbytes,
      // Only meaningful for pay-per-result actors, ignored elsewhere.
      maxItems: options.maxItems,
    },
  });
}

export async function getRun(runId: string): Promise<ApifyRun> {
  return request<ApifyRun>(`/actor-runs/${runId}`);
}

export async function abortRun(runId: string): Promise<ApifyRun> {
  return request<ApifyRun>(`/actor-runs/${runId}/abort`, { method: "POST" });
}

// --- Datasets --------------------------------------------------------------

/** Raw scraped rows. `clean=true` drops Apify's empty/hidden records. */
export async function getDatasetItems(datasetId: string, limit = 1000, offset = 0): Promise<Record<string, unknown>[]> {
  const url = new URL(`${API_BASE}/datasets/${datasetId}/items`);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("offset", String(offset));
  url.searchParams.set("clean", "true");
  url.searchParams.set("format", "json");

  const token = await getApifyToken();
  if (!token) throw new ApifyNotConfiguredError();

  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  if (!response.ok) throw new ApifyError(response.status, `Could not read Apify dataset (${response.status})`);
  const items = await response.json();
  return Array.isArray(items) ? items : [];
}
