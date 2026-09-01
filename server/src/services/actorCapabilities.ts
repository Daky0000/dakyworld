import { SETTING, deleteSetting, getSetting, setSetting } from "../lib/settings.js";
import { TASKS, TASK_KINDS, resolveActor, type CaptureTask, type TaskDefinition } from "./captureActors.js";

/**
 * What an agent may start on its own, and how far it may go.
 *
 * `captureActors.ts` already answers "which actor runs a Google Maps search"
 * and "is this value the right shape for it". Neither of those is the question
 * this file exists for. An agent asking for a capture is a different caller
 * from a person pressing a button: it decides for itself, it can decide again
 * a second later, and the parameters it passes are generated rather than
 * typed. So three things have to be true before an actor starts on an agent's
 * say-so, and none of them belongs on the actor pairing:
 *
 *  1. **The capability is switched on.** An actor the Owner has stopped
 *     trusting must stop being reachable without being unpaired — because
 *     unpairing it also breaks Quick capture, which a person drives and which
 *     was never the problem.
 *  2. **The numbers are capped, not trusted.** A model will ask for 100,000
 *     results as readily as 50. The ceiling is applied here and the call is
 *     told it was applied, rather than being refused — a capped run returns
 *     the leads it was asked for, and a refused one returns an argument.
 *  3. **The wait is bounded.** An agent turn holding open for half an hour is
 *     a task that looks hung. A capability says how long its tool waits before
 *     handing back a run id to collect later.
 *
 * The shipped numbers are code, the overrides are settings — the same split as
 * the tool catalogue, and for the same reason: what a capability *is* should
 * be reviewable in a diff, and what the Owner has changed about it should not
 * need a deploy.
 */

export interface CapabilityLimits {
  /** False stops an agent starting this, and says so. Quick capture is unaffected. */
  enabled: boolean;
  /** Most values one call may aim at — search phrases, URLs, handles. */
  maxTargets: number;
  /** Most rows one call may ask the actor for, across all its targets. */
  maxResults: number;
  /** How long a tool call waits before handing back a run id instead of rows. */
  waitSecs: number;
  /**
   * Hours a business captured earlier still counts as current.
   *
   * Zero means never reuse. Only ever applied to a capability whose targets
   * are *named* — a site, a page, a handle — because "the same request" is
   * only meaningful when the request names what it wants. A discovery search
   * is not that: the whole reason to run "dental clinics in Kumasi" again is
   * that the answer may have changed, and serving yesterday's rows for it
   * would quietly turn a hunt into a re-read of its own pipeline.
   */
  cacheHours: number;
}

export interface Capability extends CapabilityLimits {
  kind: CaptureTask;
  label: string;
  /** What this capability is for, in the words the tool description uses. */
  purpose: string;
  /** When an agent should reach for something else instead. */
  notFor: string;
  /** True when the targets are named things, so a recent capture can be reused. */
  cacheable: boolean;
  /** The actor that will actually run, after any pairing override. */
  actorId: string;
  /** True when a limit here has been changed from the shipped one. */
  overridden: boolean;
}

/**
 * The shipped limits, one per approved task.
 *
 * `maxResults` differs by an order of magnitude between discovery and reading
 * a named target, and that is the point rather than an oversight: a Maps
 * search is billed per place and is how a pipeline gets filled, so 120 is a
 * real day's work; asking an Instagram profile actor for 120 rows about five
 * handles is asking for four rows that do not exist, at the price of a run.
 */
const SHIPPED: Record<CaptureTask, CapabilityLimits & { cacheable: boolean; purpose: string; notFor: string }> = {
  MAPS_SEARCH: {
    enabled: true,
    maxTargets: 5,
    maxResults: 120,
    waitSecs: 240,
    cacheHours: 0,
    cacheable: false,
    purpose:
      "Find businesses that are not in the pipeline yet, by trade and place — “dental clinics in Kumasi”, “estate agents in Accra”. Returns the business, its phone, its address and its website when it has one.",
    notFor:
      "A business already in the pipeline (read it with lead.read), a company you can name (read its site instead), or a general question about a market. It searches; it does not answer.",
  },
  WEBSITE: {
    enabled: true,
    maxTargets: 10,
    maxResults: 40,
    waitSecs: 240,
    cacheHours: 168,
    cacheable: true,
    purpose:
      "Sweep a company's own website for the contact details published on it — addresses, phone numbers, the social accounts it links to.",
    notFor:
      "Judging a website. company.audit reads its markup, DNS and certificate for nothing, site.look photographs it, and audit.website reviews it properly — this only harvests contact details, and running it to “have a look at their site” spends money on the wrong thing.",
  },
  LINKEDIN_COMPANY: {
    enabled: true,
    maxTargets: 10,
    maxResults: 20,
    waitSecs: 180,
    cacheHours: 336,
    cacheable: true,
    purpose: "Read a LinkedIn **company page** — the company's own description, size, industry and website.",
    notFor: "A person's profile. Those cannot be read at all, and a /in/ URL will be refused before anything is charged.",
  },
  FACEBOOK_PAGE: {
    enabled: true,
    maxTargets: 10,
    maxResults: 20,
    waitSecs: 180,
    cacheHours: 336,
    cacheable: true,
    purpose: "Read a business's Facebook **Page** — the details it publishes there, which for a lot of small businesses is the only place they publish anything.",
    notFor: "A personal profile, which Facebook does not allow to be read even when it is public.",
  },
  INSTAGRAM: {
    enabled: true,
    maxTargets: 10,
    maxResults: 20,
    waitSecs: 180,
    cacheHours: 336,
    cacheable: true,
    purpose: "Read a business's Instagram account — the name, the bio and the link in it.",
    notFor: "A post, a reel or a hashtag. This reads accounts.",
  },
};

/** How many actor runs one agent task may start, before the Owner changes it. */
export const DEFAULT_MAX_RUNS_PER_TASK = 6;

// --- Overrides ---------------------------------------------------------------

export type CapabilityOverride = Partial<CapabilityLimits>;
export type CapabilityOverrides = Partial<Record<CaptureTask, CapabilityOverride>>;

const NUMERIC: Array<keyof CapabilityLimits> = ["maxTargets", "maxResults", "waitSecs", "cacheHours"];

/**
 * Clamps whatever is in the setting to something a run can survive.
 *
 * A stored zero for `maxTargets` is a capability that refuses everything under
 * a message about the input, and a stored 10,000 for `maxResults` is the
 * ceiling not existing. Both are one bad PUT away, and neither should be able
 * to reach a run.
 */
const BOUNDS: Record<keyof CapabilityLimits, [number, number]> = {
  enabled: [0, 1],
  maxTargets: [1, 50],
  maxResults: [1, 1000],
  waitSecs: [30, 900],
  cacheHours: [0, 24 * 90],
};

function clean(raw: unknown): CapabilityOverride {
  const entry = (raw ?? {}) as Record<string, unknown>;
  const override: CapabilityOverride = {};
  if (typeof entry.enabled === "boolean") override.enabled = entry.enabled;
  for (const key of NUMERIC) {
    const value = Number(entry[key]);
    if (Number.isFinite(value)) {
      const [low, high] = BOUNDS[key];
      override[key] = Math.min(high, Math.max(low, Math.round(value))) as never;
    }
  }
  return override;
}

export async function readCapabilityOverrides(): Promise<CapabilityOverrides> {
  const raw = await getSetting(SETTING.CAPTURE_CAPABILITIES);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: CapabilityOverrides = {};
    for (const [kind, value] of Object.entries(parsed)) {
      // A capability that no longer exists is dropped rather than kept as a
      // setting nobody can see or clear.
      if (!TASK_KINDS.includes(kind as CaptureTask)) continue;
      const override = clean(value);
      if (Object.keys(override).length > 0) out[kind as CaptureTask] = override;
    }
    return out;
  } catch {
    return {};
  }
}

export async function writeCapabilityOverride(kind: CaptureTask, override: CapabilityOverride | null): Promise<CapabilityOverrides> {
  const current = await readCapabilityOverrides();
  const cleaned = override === null ? {} : clean(override);
  if (Object.keys(cleaned).length === 0) delete current[kind];
  else current[kind] = cleaned;

  if (Object.keys(current).length === 0) await deleteSetting(SETTING.CAPTURE_CAPABILITIES);
  else await setSetting(SETTING.CAPTURE_CAPABILITIES, JSON.stringify(current));
  return current;
}

// --- Reading -----------------------------------------------------------------

/** The limits in force for one capability, shipped defaults and override merged. */
export async function capabilityFor(kind: CaptureTask, overrides?: CapabilityOverrides): Promise<Capability> {
  const shipped = SHIPPED[kind];
  const override = (overrides ?? (await readCapabilityOverrides()))[kind] ?? {};
  const actor = await resolveActor(kind);
  const task: TaskDefinition | undefined = TASKS.find((entry) => entry.kind === kind);
  return {
    kind,
    label: task?.label ?? kind,
    purpose: shipped.purpose,
    notFor: shipped.notFor,
    cacheable: shipped.cacheable,
    actorId: actor.actorId,
    overridden: Object.keys(override).length > 0,
    enabled: override.enabled ?? shipped.enabled,
    maxTargets: override.maxTargets ?? shipped.maxTargets,
    maxResults: override.maxResults ?? shipped.maxResults,
    waitSecs: override.waitSecs ?? shipped.waitSecs,
    // A capability whose targets are not named can never be served from cache,
    // whatever a setting says. The Owner can turn caching *off* for one that
    // is; they cannot turn it on for one that is not, because there is no key
    // to look it up by.
    cacheHours: shipped.cacheable ? (override.cacheHours ?? shipped.cacheHours) : 0,
  };
}

/** Every capability, for the admin screen and for the tool descriptions. */
export async function describeCapabilities(): Promise<Capability[]> {
  const overrides = await readCapabilityOverrides();
  return Promise.all(TASK_KINDS.map((kind) => capabilityFor(kind, overrides)));
}

/** The ceiling on actor runs in one agent task. */
export async function maxRunsPerTask(): Promise<number> {
  const raw = Number.parseInt((await getSetting(SETTING.CAPTURE_MAX_RUNS_PER_TASK)) ?? "", 10);
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_MAX_RUNS_PER_TASK;
  return Math.min(50, raw);
}
