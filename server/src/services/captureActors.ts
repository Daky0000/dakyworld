import { SETTING, deleteSetting, getSetting, setSetting } from "../lib/settings.js";
import { QUICK_ACTORS, type QuickActorKind } from "./scraperTemplates.js";

/**
 * Which actor runs which kind of capture, and whether the thing typed in is
 * the right shape for it.
 *
 * Quick capture reads what someone typed and picks a task — a website, a Maps
 * search, a LinkedIn company, a Facebook Page, an Instagram account. Behind
 * each task sits one pre-defined Apify actor with its own input, so nobody has
 * to know an actor id to capture a lead. Two things were missing and are here:
 *
 * **The pairing is now configurable.** It lived in `scraperTemplates.ts` as
 * source code, which meant a better actor, a renamed one, or one that had
 * started failing needed a deploy. The defaults still live there — this stores
 * only what has been *changed*, so an override is visible as an override and a
 * reset genuinely returns to the shipped pairing.
 *
 * **A task now checks its own input before it spends anything.** Every one of
 * these actors is pay-per-event. An Instagram handle sent to the Facebook Page
 * actor is a run that costs money and returns nothing, so each task says what
 * it takes, normalises what it is given, and refuses in a sentence when the two
 * do not match — which is also what makes "no, run it as a website" safe to
 * offer in the UI.
 */

export type CaptureTask = QuickActorKind;

export interface TaskDefinition {
  kind: CaptureTask;
  label: string;
  /** The family it belongs to, for grouping in Settings. */
  family: "Website" | "Social media" | "Directories";
  /** What this task takes, in the words the Owner would use. */
  takes: string;
  example: string;
  /** The actor shipped with the app, before any override. */
  defaultActorId: string;
}

export const TASKS: TaskDefinition[] = [
  {
    kind: "WEBSITE",
    label: "Website",
    family: "Website",
    takes: "A site address. The crawler reads it and the pages under it for contact details.",
    example: "kessben.com",
    defaultActorId: QUICK_ACTORS.WEBSITE.actorId,
  },
  {
    kind: "MAPS_SEARCH",
    label: "Google Maps",
    family: "Directories",
    takes: "A search phrase — a trade and a place. The market from Lead capture fills in when no place is given.",
    example: "dental clinics in Kumasi",
    defaultActorId: QUICK_ACTORS.MAPS_SEARCH.actorId,
  },
  {
    kind: "LINKEDIN_COMPANY",
    label: "LinkedIn company",
    family: "Social media",
    takes: "A company page URL. Personal profiles are not readable.",
    example: "linkedin.com/company/kessben",
    defaultActorId: QUICK_ACTORS.LINKEDIN_COMPANY.actorId,
  },
  {
    kind: "FACEBOOK_PAGE",
    label: "Facebook Page",
    family: "Social media",
    takes: "A business Page URL. A personal profile will not work.",
    example: "facebook.com/kessbenhotel",
    defaultActorId: QUICK_ACTORS.FACEBOOK_PAGE.actorId,
  },
  {
    kind: "INSTAGRAM",
    label: "Instagram",
    family: "Social media",
    takes: "A username. A profile URL is fine — the handle is taken out of it.",
    example: "adjeidental",
    defaultActorId: QUICK_ACTORS.INSTAGRAM.actorId,
  },
];

export const TASK_KINDS = TASKS.map((task) => task.kind);

// --- Overrides ---------------------------------------------------------------

export interface ActorOverride {
  /** A different actor for this task. Empty or absent means the shipped one. */
  actorId?: string;
  /**
   * Extra input merged over the actor's defaults. Only for keys the actor
   * actually publishes — an undeclared key is silently dropped by Apify, which
   * is how a cap that looks set turns out not to be.
   */
  input?: Record<string, unknown>;
}

export type ActorOverrides = Partial<Record<CaptureTask, ActorOverride>>;

export async function readActorOverrides(): Promise<ActorOverrides> {
  const raw = await getSetting(SETTING.CAPTURE_ACTORS);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as ActorOverrides;
    // Anything for a task that no longer exists is dropped rather than kept as
    // a setting nobody can see or clear.
    return Object.fromEntries(Object.entries(parsed).filter(([kind]) => TASK_KINDS.includes(kind as CaptureTask))) as ActorOverrides;
  } catch {
    return {};
  }
}

export async function writeActorOverride(kind: CaptureTask, override: ActorOverride | null): Promise<ActorOverrides> {
  const current = await readActorOverrides();
  if (override === null || (!override.actorId?.trim() && !override.input)) delete current[kind];
  else current[kind] = { ...(override.actorId?.trim() ? { actorId: override.actorId.trim() } : {}), ...(override.input ? { input: override.input } : {}) };

  if (Object.keys(current).length === 0) await deleteSetting(SETTING.CAPTURE_ACTORS);
  else await setSetting(SETTING.CAPTURE_ACTORS, JSON.stringify(current));
  return current;
}

export interface ResolvedActor {
  kind: CaptureTask;
  actorId: string;
  /** True when the Owner has pointed this task at a different actor. */
  overridden: boolean;
  inputKey: string;
  wrap: string;
  preset: (typeof QUICK_ACTORS)[CaptureTask]["preset"];
  leadSource: (typeof QUICK_ACTORS)[CaptureTask]["leadSource"];
  label: string;
  input: Record<string, unknown>;
}

/** The actor that will actually run for a task, defaults and override merged. */
export async function resolveActor(kind: CaptureTask, overrides?: ActorOverrides): Promise<ResolvedActor> {
  const base = QUICK_ACTORS[kind];
  const override = (overrides ?? (await readActorOverrides()))[kind] ?? {};
  return {
    kind,
    actorId: override.actorId?.trim() || base.actorId,
    overridden: Boolean(override.actorId?.trim() || override.input),
    inputKey: base.inputKey,
    wrap: base.wrap,
    preset: base.preset,
    leadSource: base.leadSource,
    label: TASKS.find((task) => task.kind === kind)?.label ?? base.label,
    input: { ...base.input, ...(override.input ?? {}) },
  };
}

/** Builds the actor input for one group of values on a task. */
export function actorInput(actor: ResolvedActor, values: string[]): Record<string, unknown> {
  const payload = actor.wrap === "url-objects" ? values.map((url) => ({ url })) : values;
  return { ...actor.input, [actor.inputKey]: payload };
}

// --- Does this input suit this task? -----------------------------------------

export interface Checked {
  /** The value as the actor wants it — a bare handle, a full URL, a phrase. */
  value: string;
  /** Set when the value cannot be run as this task. Said in one sentence. */
  problem: string | null;
  /** The task this value actually looks like, when it is not the one asked for. */
  suggestion: CaptureTask | null;
}

const URLISH = /^(https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,}(\/|$|\?|#)/i;
const HOST_OF = (value: string) => {
  const match = value.match(/^(?:https?:\/\/)?(?:www\.)?([^/?#\s]+)/i);
  return (match?.[1] ?? "").toLowerCase();
};

function looksLike(value: string): CaptureTask | null {
  const host = HOST_OF(value);
  if (host.includes("linkedin.")) return "LINKEDIN_COMPANY";
  if (host.includes("facebook.") || host.includes("fb.com")) return "FACEBOOK_PAGE";
  if (host.includes("instagram.")) return "INSTAGRAM";
  if (host.includes("google.") && value.includes("/maps")) return "MAPS_SEARCH";
  if (URLISH.test(value)) return "WEBSITE";
  return null;
}

const withScheme = (value: string) => (/^https?:\/\//i.test(value) ? value : `https://${value.replace(/^\/+/, "")}`);

/**
 * Checks and cleans one value against one task, before anything is charged for.
 * Being told "that is an Instagram link — run it as Instagram?" costs nothing;
 * a Facebook actor run on an Instagram URL costs money and returns nothing.
 */
export function checkForTask(kind: CaptureTask, raw: string): Checked {
  const value = raw.trim();
  if (!value) return { value, problem: "Nothing to capture.", suggestion: null };
  const actually = looksLike(value);

  switch (kind) {
    case "MAPS_SEARCH": {
      // A phrase is what this takes; a pasted link is somebody meaning a page.
      if (URLISH.test(value) && actually && actually !== "MAPS_SEARCH") {
        return { value, problem: `That is a ${TASKS.find((t) => t.kind === actually)?.label} link, not a search phrase.`, suggestion: actually };
      }
      return { value: value.replace(/\s+/g, " "), problem: null, suggestion: null };
    }

    case "WEBSITE": {
      if (!URLISH.test(value)) {
        return { value, problem: "That is not a site address. A trade and a place runs as a Google Maps search instead.", suggestion: "MAPS_SEARCH" };
      }
      if (actually && actually !== "WEBSITE") {
        return { value, problem: `That is a ${TASKS.find((t) => t.kind === actually)?.label} link.`, suggestion: actually };
      }
      return { value: withScheme(value), problem: null, suggestion: null };
    }

    case "LINKEDIN_COMPANY": {
      const host = HOST_OF(value);
      if (!host.includes("linkedin.")) {
        return { value, problem: "That is not a LinkedIn URL.", suggestion: actually };
      }
      if (/\/in\//i.test(value)) {
        return { value, problem: "That is a personal profile. Only company pages can be read — the /company/ URL.", suggestion: null };
      }
      return { value: withScheme(value), problem: null, suggestion: null };
    }

    case "FACEBOOK_PAGE": {
      const host = HOST_OF(value);
      if (!host.includes("facebook.") && !host.includes("fb.com")) {
        return { value, problem: "That is not a Facebook URL.", suggestion: actually };
      }
      if (/facebook\.com\/(profile\.php|people\/)/i.test(value)) {
        return { value, problem: "That is a personal profile. Only business Pages can be read.", suggestion: null };
      }
      return { value: withScheme(value), problem: null, suggestion: null };
    }

    case "INSTAGRAM": {
      // The actor takes usernames, so a pasted profile URL is reduced to one.
      const handle = value
        .replace(/^https?:\/\//i, "")
        .replace(/^www\./i, "")
        .replace(/^instagram\.com\//i, "")
        .replace(/^@/, "")
        .split(/[/?#]/)[0]
        .trim();
      if (!handle) return { value, problem: "No Instagram username in that.", suggestion: null };
      if (!/^[A-Za-z0-9._]{1,30}$/.test(handle)) {
        return { value: handle, problem: "That is not an Instagram username.", suggestion: actually };
      }
      return { value: handle, problem: null, suggestion: null };
    }
  }
}

/** The roster for the Settings screen and the task picker in Quick capture. */
export async function describeTasks() {
  const overrides = await readActorOverrides();
  return Promise.all(
    TASKS.map(async (task) => {
      const actor = await resolveActor(task.kind, overrides);
      return {
        ...task,
        actorId: actor.actorId,
        overridden: actor.overridden,
        input: actor.input,
      };
    }),
  );
}
