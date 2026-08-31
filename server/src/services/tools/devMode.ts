import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolRequirement } from "./types.js";

/**
 * Standing in for integrations nobody has connected, on a laptop only.
 *
 * The problem this solves is narrow and real: every outward tool in the
 * catalogue refuses before it runs unless the thing behind it is configured, so
 * a developer with no Meta account, no Hubtel merchant number and no Apify
 * token cannot exercise a single agent path that ends in a send. The refusal is
 * correct — see `readiness.ts`, and the sentence it exists to prevent is an
 * agent reporting that it sent an email nobody received — but it makes half the
 * workforce unrunnable on a machine that will never hold twenty-six
 * credentials.
 *
 * **The guard is `DEV_NO_AUTH`'s, deliberately copied rather than loosened.**
 * Two independent signals have to agree that this is not a deployment, and a
 * missing `NODE_ENV` fails closed. The reasoning there applies here with more
 * force, not less: a stray `DEV_MODE=true` on the live service would make every
 * readiness check pass, so the Tools screen would report twenty-six connected
 * integrations and every agent send would return a fabricated success. That is
 * the exact failure the readiness gate was written to prevent, arriving through
 * the switch meant to help with it.
 *
 * **It never makes a configured integration mock.** `toolReadiness` calls the
 * real check first and only stands in where the answer was "not connected", so
 * a machine with a working mailer still sends real email and a half-configured
 * deployment cannot have one live vendor and one imaginary one for the same
 * tool. That ordering is the whole safety property and is asserted.
 */

/** Set by a hosting platform about itself. Same list as `middleware/auth.ts`. */
const DEPLOYED = Boolean(
  process.env.RAILWAY_ENVIRONMENT ||
    process.env.RAILWAY_PROJECT_ID ||
    process.env.RAILWAY_SERVICE_ID ||
    process.env.RENDER ||
    process.env.FLY_APP_NAME ||
    process.env.DYNO ||
    process.env.VERCEL ||
    process.env.KUBERNETES_SERVICE_HOST,
);

/** Local convenience only. A stray env var must never fake an integration on a deployed system. */
export const DEV_MODE = process.env.NODE_ENV !== "production" && !DEPLOYED && process.env.DEV_MODE === "true";

/** True when the variable was set and deliberately ignored — worth saying out loud at boot. */
export const DEV_MODE_REFUSED = process.env.DEV_MODE === "true" && !DEV_MODE;

export interface DevToolMock {
  /** What the Tools screen says instead of "not connected". */
  readiness: string;
  /** What a call to a tool with this requirement returns instead of running. */
  output: Record<string, unknown>;
}

/**
 * The stand-ins, one JSON file per requirement, read once.
 *
 * Files rather than a table in this module so that adding a stand-in for a new
 * integration is a file rather than an edit to shared code — and so that what a
 * mock returns is visibly *data*, which is what stops it drifting into a second
 * implementation of the tool.
 *
 * A requirement with no file gets the generic mock below. That is deliberate:
 * the alternative is a new integration silently going back to refusing while
 * `DEV_MODE=true` is set, which reads as the switch being broken.
 *
 * **`tsc` does not copy JSON**, so a build run out of `dist/` finds no directory
 * and every requirement falls to the generic mock. Left alone rather than added
 * to the build: development runs from `src/` under tsx, and a deployment can
 * never honour `DEV_MODE` at all — so the only thing shipping these files into
 * `dist/` would achieve is putting fabricated integration responses one
 * misconfiguration closer to a live service.
 */
let loaded: Map<string, DevToolMock> | null = null;

function mocks(): Map<string, DevToolMock> {
  if (loaded) return loaded;
  loaded = new Map();
  try {
    const dir = join(dirname(fileURLToPath(import.meta.url)), "dev-tools");
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      const parsed = JSON.parse(readFileSync(join(dir, file), "utf8")) as DevToolMock;
      if (typeof parsed?.readiness === "string") loaded.set(file.replace(/\.json$/, ""), parsed);
    }
  } catch (err) {
    // Never fatal. A missing or unreadable directory means every requirement
    // falls to the generic mock, which is a worse development experience and
    // not a broken server.
    console.error("[dev-mode] could not read the stand-in configurations:", (err as Error).message);
  }
  return loaded;
}

/** Re-read the JSON files. For a harness that writes one; nothing else calls it. */
export function clearDevToolCache() {
  loaded = null;
}

export function devToolMock(requirement: ToolRequirement): DevToolMock {
  return (
    mocks().get(requirement) ?? {
      readiness: `Standing in for ${requirement} — DEV_MODE is on and nothing is really connected.`,
      output: { devMode: true, requirement },
    }
  );
}
