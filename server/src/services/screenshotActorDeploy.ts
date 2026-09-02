import {
  ApifyError,
  ApifyNotConfiguredError,
  apifyConfigured,
  displayActorId,
  ensureActor,
  findActor,
  getActorBuild,
  normalizeActorId,
  setActorGitVersion,
  startActorBuild,
} from "../lib/apify.js";
import { SETTING, getSetting, setSetting } from "../lib/settings.js";
import { ACTOR_SOURCE_VERSION, screenshotActorId } from "./apifyScreenshot.js";

/**
 * Putting Dakyworld's own screenshot actor onto Dakyworld's own Apify account,
 * from inside the app, with the token the app already holds.
 *
 * The gap this closes is small and was completely blocking. The actor's source
 * is in this repository and the documented way to deploy it is `apify push`,
 * which needs the Apify CLI, Docker, and a login on whatever machine runs it.
 * The **app** has the token; nothing else reliably does. So a deployment could
 * be perfectly up to date in front of an account that had never had the actor
 * pushed, with every screenshot failing for a reason nobody could act on from
 * inside the product — and the only fix was a developer at a terminal.
 *
 * Apify's `GIT_REPO` source type is the way round it: an actor version can name
 * a **public** repository and a subdirectory, and Apify clones and builds it
 * itself. No Docker here, no CLI, and — the part that matters — no need for the
 * actor's source to be in this container at all, which it is not: Railway's
 * root directory is `server/` and the actor lives beside it.
 *
 * Three rules:
 *
 *  - **It never throws.** Every failure is a value with a sentence on it, for
 *    the same reason the screenshot path itself never throws: the caller is a
 *    boot log or a settings screen, and both have to say something useful.
 *  - **It is idempotent.** Creating an actor that exists is not an error here,
 *    and the version is written with `PUT`, so running it twice updates rather
 *    than fails. That is deliberate — this is also how the actor gets *updated*
 *    when its source changes, not only how it first arrives.
 *  - **It will not build somebody else's actor.** If `capture.screenshotActor`
 *    names an account that is not the token's, there is nothing to deploy and
 *    it says so instead of creating a confusingly-named actor on the wrong
 *    account.
 */

/**
 * Where Apify clones the source from.
 *
 * A public repository and a subdirectory, in Apify's own `#branch:folder`
 * syntax. Overridable by environment for a fork or a branch, because the one
 * thing that would make this useless is being pinned to a repository somebody
 * cannot change.
 */
export function sourceRepoUrl(): string {
  return process.env.SCREENSHOT_ACTOR_REPO?.trim() || "https://github.com/Daky0000/dakyworld#main:apify/dakyworld-screenshot";
}

const VERSION = "1.0";
const BUILD_TAG = "latest";

/** How long to watch a build before handing back "still going". The run is not stopped. */
const WATCH_MS = 4 * 60_000;
const POLL_MS = 5_000;

export interface DeployResult {
  ok: boolean;
  /** The actor this was about, in `username/name` form. */
  actorId: string;
  /** What happened, in one sentence a person can act on. */
  message: string;
  /** Set once a build exists, so a caller can point at it in the console. */
  buildId?: string;
  status?: string;
  /** True when the actor already existed and this only rebuilt it. */
  updated?: boolean;
}

/**
 * Creates the actor if it is missing, points it at the repository, and builds.
 *
 * Waits for the build rather than returning as soon as it starts, because the
 * only question worth answering is *can screenshots be taken now*, and a build
 * that is still going does not answer it. Past `WATCH_MS` it hands back what it
 * knows and names the build; the build carries on regardless.
 */
export async function deployScreenshotActor(): Promise<DeployResult> {
  const wanted = await screenshotActorId();
  const actorId = displayActorId(normalizeActorId(wanted));

  if (!(await apifyConfigured())) {
    return { ok: false, actorId, message: "Apify is not connected. Add a token under Lead Sources → Connection first." };
  }

  const [username, name] = actorId.split("/");
  if (!username || !name) {
    return { ok: false, actorId, message: `"${wanted}" is not an actor id. It should look like account/website-screenshot.` };
  }

  try {
    // Does it already exist? A rebuild of an actor that is there is the normal
    // case once this has run once, and is how a source change is picked up.
    const existing = await findActor(actorId);
    let id = existing?.id ?? null;
    let updated = Boolean(existing);

    if (!id) {
      const created = await ensureActor(name, "Dakyworld Website Screenshot", "Screenshots a batch of websites and returns one row per requested URL, carrying back the caller's own id.");
      // The account the token belongs to decides the username half, and Apify
      // has just told us what it is. If it does not match what the setting
      // asked for, the actor we have made is not the actor this app will call —
      // so say so rather than leaving a working actor under a name nothing
      // looks for.
      if (created.username && created.username !== username) {
        return {
          ok: false,
          actorId: `${created.username}/${name}`,
          message:
            `This Apify token belongs to "${created.username}", not "${username}". The actor has been created as ` +
            `${created.username}/${name} — set Settings → Lead Sources → Screenshot actor to that, then deploy again.`,
        };
      }
      id = created.id;
      updated = false;
    }

    await setActorGitVersion(id, { versionNumber: VERSION, gitRepoUrl: sourceRepoUrl(), buildTag: BUILD_TAG });

    const started = await startActorBuild(id, VERSION, BUILD_TAG);
    const finished = await watchBuild(started.buildId);

    if (finished.status === "SUCCEEDED") {
      // What was built, so the next boot can tell *deployed* from *up to date*.
      // Written only on success: recording a version the build never produced
      // would leave a broken actor looking current for ever.
      await setSetting(SETTING.SCREENSHOT_ACTOR_BUILT, `${ACTOR_SOURCE_VERSION}:${actorId}`).catch(() => undefined);
      return {
        ok: true,
        actorId,
        buildId: finished.buildId,
        status: finished.status,
        updated,
        message: updated
          ? `Rebuilt ${actorId} from ${sourceRepoUrl()}. Screenshots are using the new build.`
          : `Created and built ${actorId} from ${sourceRepoUrl()}. Screenshots will work from now on.`,
      };
    }

    if (finished.status === "RUNNING" || finished.status === "READY") {
      return {
        ok: false,
        actorId,
        buildId: finished.buildId,
        status: finished.status,
        message: `The build of ${actorId} is still going after ${Math.round(WATCH_MS / 60_000)} minutes. It has not been stopped — check it in the Apify console, then try a screenshot.`,
      };
    }

    return {
      ok: false,
      actorId,
      buildId: finished.buildId,
      status: finished.status,
      message: `The build of ${actorId} ${finished.status.toLowerCase().replace("-", " ")}.${finished.message ? ` ${finished.message}` : ""} The full log is in the Apify console.`,
    };
  } catch (err) {
    if (err instanceof ApifyNotConfiguredError) return { ok: false, actorId, message: err.message };
    if (err instanceof ApifyError) {
      if (err.status === 401 || err.status === 403) {
        return { ok: false, actorId, message: "Apify rejected the API token, or it is not allowed to create actors on this account." };
      }
      return { ok: false, actorId, message: `Apify would not deploy the actor: ${err.message}` };
    }
    return { ok: false, actorId, message: `The actor could not be deployed: ${(err as Error).message}` };
  }
}

/**
 * Something that changes when a new version of this app is deployed and does
 * not change when the same one restarts.
 *
 * Railway injects the deployment id; the commit is the fallback for a host that
 * does not, and the date is the floor for running it anywhere else — which is
 * no worse than the behaviour this replaced.
 */
function deploymentTag(): string {
  return (
    process.env.RAILWAY_DEPLOYMENT_ID?.trim() ||
    process.env.RAILWAY_GIT_COMMIT_SHA?.trim() ||
    new Date().toISOString().slice(0, 10)
  );
}

async function watchBuild(buildId: string): Promise<{ buildId: string; status: string; message: string | null }> {
  const giveUpAt = Date.now() + WATCH_MS;
  let last = { buildId, status: "RUNNING", message: null as string | null };

  for (;;) {
    try {
      last = await getActorBuild(buildId);
    } catch {
      // One unanswered poll is not a failed build. Only a poll with no time
      // left gives up, and it still names the build so it can be looked at.
      if (Date.now() >= giveUpAt) return last;
    }
    if (last.status !== "RUNNING" && last.status !== "READY") return last;
    if (Date.now() >= giveUpAt) return last;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/**
 * The boot pass: deploy the actor when it is missing or unbuilt, once per
 * deployment.
 *
 * Automatic because the alternative is what actually happened — the app knew
 * the actor was missing, printed a line saying so on every deploy, and could do
 * nothing about it while holding the one credential that could. It only ever
 * fires when there is a token *and* the actor is absent or unbuilt, which is
 * the exact state in which every screenshot is already failing.
 *
 * **Once per deployment, and that is the third answer to this question.** Once
 * ever hides a build that failed on a bad afternoon behind a marker nobody can
 * see. Once a *day* was the second answer and it was wrong in a way only a real
 * failure showed: a build failed at lunchtime, the fix was one line, and the
 * marker then refused to try again until tomorrow — so the thing standing
 * between a working fix and a working system was a rate limit meant to stop
 * waste. A deployment is the right unit, because a new deployment is exactly
 * the signal that something may have changed: a restart, a crash loop or a
 * scale event keeps the same id and does not retry, and a push does.
 */
export async function deployScreenshotActorIfMissing(): Promise<DeployResult | null> {
  if (!(await apifyConfigured())) return null;

  const actorId = displayActorId(normalizeActorId(await screenshotActorId()));
  // Three states, not two. Present is not runnable — an actor created by a run
  // of this that then failed to build would otherwise be skipped for ever as
  // "already there". And runnable is not current: the actor's source is in this
  // repository and changes with it, so a fix could sit in git while Apify went
  // on running the version that was broken.
  const existing = await findActor(actorId).catch(() => null);
  const built = await getSetting(SETTING.SCREENSHOT_ACTOR_BUILT).catch(() => null);
  if (existing?.hasBuild && built === `${ACTOR_SOURCE_VERSION}:${actorId}`) return null;

  // The marker names the deployment *and* the actor, and both halves were
  // learned from a real failure. The actor, because the first automatic run
  // went out under the wrong account name and a marker without it would have
  // refused to try the corrected one. The deployment, because the run after
  // that failed on a one-line bug and the marker then refused to try the fix.
  const attempt = `${deploymentTag()}:${actorId}`;
  const attempted = await getSetting(SETTING.SCREENSHOT_ACTOR_BUILD).catch(() => null);
  if (attempted === attempt) return null;
  await setSetting(SETTING.SCREENSHOT_ACTOR_BUILD, attempt).catch(() => undefined);

  return deployScreenshotActor();
}
