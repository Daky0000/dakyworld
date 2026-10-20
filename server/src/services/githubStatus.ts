/**
 * Whether GitHub itself is having a bad day, from githubstatus.com.
 *
 * On 19 Oct 2026 a publish to a GitHub Pages site took forty minutes to go live
 * because GitHub Actions and Pages were degraded. Nothing on our side was wrong
 * and nothing on our side said so: the publish looked like it had done nothing.
 * GitHub publishes the state of each of its parts, so a waiting publish can say
 * plainly that the hold-up is GitHub, that the change is saved, and that there
 * is no need to publish again.
 *
 * Read at most once every two minutes per process, and only when somebody is
 * actually waiting on a publish. A failed read keeps the last answer for ten
 * minutes and then gives up: no answer means no notice, never a guess.
 */

const COMPONENTS_URL = "https://www.githubstatus.com/api/v2/components.json";
const FRESH_MS = 2 * 60_000;
const STALE_LIMIT_MS = 10 * 60_000;

/** The parts of GitHub a site's deploy can be held up by. */
export type GithubComponent = "Pages" | "Actions" | "Webhooks";
const WATCHED: readonly GithubComponent[] = ["Pages", "Actions", "Webhooks"];

/** Statuspage's own words: operational, degraded_performance, partial_outage, major_outage, under_maintenance. */
export type GithubHealth = Partial<Record<GithubComponent, string>>;

let cached: { at: number; health: GithubHealth } | null = null;
let inFlight: Promise<GithubHealth | null> | null = null;

/** Reads one Statuspage `components.json` body. Exported so the checks can feed it a recorded day. */
export function parseGithubComponents(body: unknown): GithubHealth {
  const components = (body as { components?: Array<{ name?: unknown; status?: unknown }> } | null)?.components;
  const health: GithubHealth = {};
  if (!Array.isArray(components)) return health;
  for (const component of components) {
    if (typeof component?.name !== "string" || typeof component.status !== "string") continue;
    const name = WATCHED.find((watched) => watched === component.name);
    if (name) health[name] = component.status;
  }
  return health;
}

/** The current health of the parts that matter, or null when it is not known. */
export async function githubHealth(now = Date.now()): Promise<GithubHealth | null> {
  if (cached && now - cached.at < FRESH_MS) return cached.health;
  inFlight ??= (async () => {
    try {
      const response = await fetch(COMPONENTS_URL, { signal: AbortSignal.timeout(5_000), headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(`githubstatus.com answered ${response.status}`);
      const health = parseGithubComponents(await response.json());
      cached = { at: Date.now(), health };
      return health;
    } catch {
      return cached && Date.now() - cached.at < STALE_LIMIT_MS ? cached.health : null;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** For the checks: forget what was read, so each case starts from nothing. */
export function resetGithubHealth(): void {
  cached = null;
  inFlight = null;
}

/** The parts of GitHub that must be working for a site served by this host to update. */
export function componentsFor(servedBy: string | null | undefined): GithubComponent[] {
  // GitHub Pages builds and deploys on Actions. Vercel and Netlify hear about a
  // commit through a webhook, so that is the part that holds them up. Any other
  // host might deploy from a webhook or from an Actions workflow. Not knowing the
  // host at all (including a site behind a Cloudflare proxy, which hides what is
  // behind it), any of the three could be the reason.
  if (servedBy === "github-pages") return ["Pages", "Actions"];
  if (servedBy === "vercel" || servedBy === "netlify") return ["Webhooks"];
  if (servedBy === "other") return ["Webhooks", "Actions"];
  return ["Pages", "Actions", "Webhooks"];
}

export const GITHUB_TROUBLE_NOTICE =
  "GitHub is having problems right now. Your change is saved and will appear when they recover. No need to publish again.";

/** The notice for a site served by this host, when a part it depends on is not working. */
export function githubTroubleFor(health: GithubHealth | null, servedBy: string | null | undefined): string | null {
  if (!health) return null;
  const troubled = componentsFor(servedBy).some((name) => {
    const status = health[name];
    return status !== undefined && status !== "operational";
  });
  return troubled ? GITHUB_TROUBLE_NOTICE : null;
}

/**
 * Which host answered, from the response headers of the live page.
 *
 * Each of the big three leaves its own request id, which survives a proxy in
 * front of it where `Server` does not. A bare `Server: cloudflare` is kept apart
 * from "other": it is either Cloudflare Pages or any site at all behind a
 * Cloudflare proxy, GitHub Pages included.
 */
export function hostFromHeaders(headers: Record<string, string> | null | undefined): string | null {
  if (!headers) return null;
  const server = (headers.server ?? "").trim().toLowerCase();
  if (headers["x-github-request-id"] || server === "github.com") return "github-pages";
  if (headers["x-vercel-id"] || server.startsWith("vercel")) return "vercel";
  if (headers["x-nf-request-id"] || server.startsWith("netlify")) return "netlify";
  if (server === "cloudflare") return "cloudflare";
  return server ? "other" : null;
}
