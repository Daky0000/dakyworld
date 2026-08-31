import { prisma } from "../lib/prisma.js";
import { ApifyError, apifyConfigured, getAccount, getMonthlyUsage } from "../lib/apify.js";
import { readCaptureConfig } from "./captureConfig.js";
import { computeNextRunAt } from "./scheduler.js";

/**
 * Why nothing is capturing.
 *
 * "There is money in the Apify account and nothing runs" has, in this system,
 * at least nine distinct causes, and every one of them is silent. The token
 * may be missing or rejected; the account may have credit and no *plan* that
 * permits a run; the sources may exist and be disabled; they may be enabled
 * with no schedule; scheduled with times nobody set; scheduled correctly and
 * held every time by a monthly budget the Owner set months ago; running fine
 * and filing nothing because every row is a duplicate; or the whole thing may
 * be working and the *agent* asking for it is in dry run, so the call was
 * prepared rather than made.
 *
 * Each of those is visible somewhere — on a different screen, in a log line, or
 * only in a database row. None of them announces itself. So this asks all of
 * them in order and returns **one list of plain sentences with the fix on
 * each**, because the useful output of a diagnosis is a thing to do.
 *
 * **It changes nothing.** Every check is a read. A diagnosis that repaired what
 * it found would be a diagnosis nobody could run twice.
 */

export type CheckState = "ok" | "warn" | "stop" | "unknown";

export interface CaptureCheck {
  /** Short label for the row: "Apify token", "Schedules", "Budget". */
  name: string;
  state: CheckState;
  /** What was actually found, in a sentence. */
  found: string;
  /** What to do about it. Null when there is nothing to do. */
  fix: string | null;
}

export interface CaptureDiagnosis {
  /** The one sentence somebody came for. */
  verdict: string;
  /** True when nothing at all can capture right now. */
  blocked: boolean;
  checks: CaptureCheck[];
}

export async function diagnoseCapture(now = new Date()): Promise<CaptureDiagnosis> {
  const checks: CaptureCheck[] = [];
  const config = await readCaptureConfig();

  // --- 1. Is there a token, and does Apify accept it? ----------------------
  //
  // **Nothing short-circuits here.** The first draft returned as soon as it
  // found a missing or rejected token, which is defensible — it *is* an answer
  // — and wrong for the question being asked. Somebody whose token was revoked
  // this morning very often also has three sources switched off and a ceiling
  // set in June, and answering one cause at a time means running this, fixing
  // it, and running it again. Everything below is a cheap local query; the
  // whole list is worth having in one go.
  const configured = await apifyConfigured();
  let reachable = false;

  if (!configured) {
    checks.push({
      name: "Apify token",
      state: "stop",
      found: "No Apify API token is stored.",
      fix: "Paste one under Lead Sources → Connection. It is stored encrypted; the APIFY_TOKEN environment variable overrides it if set.",
    });
  } else {
    try {
      const account = await getAccount();
      reachable = true;
      checks.push({
        name: "Apify token",
        state: "ok",
        found: `Accepted. Signed in as ${account.username}${account.plan?.id ? ` on the ${account.plan.id} plan` : ""}.`,
        fix: null,
      });
    } catch (err) {
      const rejected = err instanceof ApifyError && (err.status === 401 || err.status === 403);
      checks.push({
        name: "Apify token",
        // Rejected is a stop; unreachable is not, and conflating them costs an
        // afternoon. A revoked token refuses every run. A network blip between
        // here and Apify refuses nothing — `assertCanRun` deliberately fails
        // open on exactly this — so reporting it as "nothing can capture"
        // would send somebody to replace a credential that was never at fault.
        state: rejected ? "stop" : "unknown",
        found: rejected ? "Apify rejected the stored token." : `Apify could not be reached from here: ${(err as Error).message}`,
        fix: rejected
          ? "The token has been revoked or mistyped. Make a new one at console.apify.com → Settings → Integrations and paste it under Lead Sources → Connection."
          : "This does not by itself stop a run — the budget check fails open when Apify's own endpoints are unreachable. If it persists, check console.apify.com is up before changing anything here.",
      });
    }
  }

  // --- 2. Credit, and the difference between credit and a budget ----------
  //
  // The two get confused constantly and they fail in opposite directions:
  // Apify refuses when *their* credit runs out, and this app refuses when *our*
  // ceiling is reached — which is a number typed into Settings that has nothing
  // to do with the balance.
  let usage: Awaited<ReturnType<typeof getMonthlyUsage>> | null = null;
  try {
    if (!reachable) throw new Error("Apify was not reachable, so there are no figures to read.");
    usage = await getMonthlyUsage();
    const spent = usage.spentUsd;
    const included = usage.includedUsd;
    checks.push({
      name: "Apify credit",
      state: included != null && spent >= included ? "warn" : "ok",
      found:
        included != null
          ? `$${spent.toFixed(2)} used of $${included.toFixed(2)} included this cycle${usage.cycleEnd ? `, which ends ${usage.cycleEnd.slice(0, 10)}` : ""}.`
          : `$${spent.toFixed(2)} used this cycle. Apify does not report an included allowance for this plan.`,
      fix:
        included != null && spent >= included
          ? "The plan's included credit is used up. Runs past this bill as overage, or stop until the cycle rolls over."
          : null,
    });

    if (config.monthlyBudgetUsd != null) {
      const over = spent >= config.monthlyBudgetUsd;
      const close = !over && spent >= config.monthlyBudgetUsd * 0.9;
      checks.push({
        name: "Our own ceiling",
        state: over ? "stop" : close ? "warn" : "ok",
        found: over
          ? `Every run is being refused: $${spent.toFixed(2)} spent against the $${config.monthlyBudgetUsd.toFixed(2)} ceiling set under Settings → Lead capture.`
          : close
            ? `$${spent.toFixed(2)} of the $${config.monthlyBudgetUsd.toFixed(2)} ceiling. Past 90% an agent's run is prepared for approval rather than started.`
            : `$${spent.toFixed(2)} of the $${config.monthlyBudgetUsd.toFixed(2)} ceiling.`,
        fix: over
          ? "This is our ceiling, not Apify's — money in the Apify account makes no difference to it. Raise or clear it under Settings → Lead capture."
          : close
            ? "Raise the ceiling under Settings → Lead capture if these runs should still start on their own."
            : null,
      });
    } else {
      checks.push({
        name: "Our own ceiling",
        state: "warn",
        found: "No monthly spending ceiling is set, so nothing here will stop a run on cost grounds.",
        fix: "Set one under Settings → Lead capture. Every actor in use is pay-per-event, so there is no natural stop without it.",
      });
    }
  } catch (err) {
    // Deliberately not a stop. `assertCanRun` fails open when Apify's usage
    // endpoint is unreachable, precisely so a monitoring blip cannot halt lead
    // generation — and this has to say the same thing the runner does.
    checks.push({
      name: "Apify credit",
      state: "unknown",
      found: `Apify's usage figures could not be read: ${(err as Error).message}`,
      fix: "Runs are still allowed — the budget check deliberately fails open — so this does not explain nothing happening.",
    });
  }

  // --- 3. Are there sources at all, and are they switched on? -------------
  const sources = await prisma.scraperSource.findMany({ orderBy: { name: "asc" } });
  const real = sources.filter((source) => !source.adhoc);
  const enabled = real.filter((source) => source.enabled);

  // A source a hunt drives is *supposed* to have no schedule of its own — the
  // thesis owns the clock, and a second schedule on the source would run the
  // same search again on its own account, filing rows with no thesis attached
  // and nothing to judge them by. Without knowing that, the schedule check
  // below reports a permanent "stop" about a deliberate design decision, which
  // is the fastest way to teach somebody to stop reading a diagnosis.
  const theses = await prisma.leadThesis.findMany({
    select: { name: true, enabled: true, sourceId: true, runTimes: true, nextRunAt: true, leadsPerRun: true },
  });
  const huntDriven = new Set(theses.filter((thesis) => thesis.sourceId).map((thesis) => thesis.sourceId as string));

  if (real.length === 0) {
    checks.push({
      name: "Lead sources",
      state: "stop",
      found: "No lead sources are configured.",
      fix: "Add one under Lead Sources — the templates are pre-filled and only need a town and a trade.",
    });
  } else checks.push({
    name: "Lead sources",
    state: enabled.length === 0 ? "stop" : "ok",
    found:
      enabled.length === 0
        ? `All ${real.length} lead source(s) are switched off.`
        : `${enabled.length} of ${real.length} lead source(s) are switched on.`,
    fix: enabled.length === 0 ? "Switch at least one on under Lead Sources." : null,
  });

  // --- 4. The schedule, which is where this usually is --------------------
  const ownClock = enabled.filter((source) => !huntDriven.has(source.id));
  const scheduled = ownClock.filter((source) => source.scheduleEnabled && source.scheduleTimes.length > 0);
  const scheduledNoTimes = ownClock.filter((source) => source.scheduleEnabled && source.scheduleTimes.length === 0);
  const notScheduled = ownClock.filter((source) => !source.scheduleEnabled);

  if (real.length === 0 || ownClock.length === 0) {
    // Nothing to say. Either there is nothing to schedule, or every source
    // there is belongs to a hunt — and a hunt's clock is checked below on its
    // own terms.
  } else if (scheduled.length === 0) {
    checks.push({
      name: "Schedules",
      state: "stop",
      found:
        scheduledNoTimes.length > 0
          ? `${scheduledNoTimes.length} source(s) are set to run on a schedule with no times entered, so no slot ever comes round.`
          : `${notScheduled.length} switched-on source(s) have no schedule — they only run when somebody presses Run.`,
      fix:
        scheduledNoTimes.length > 0
          ? `Add at least one time in 24-hour HH:mm to ${scheduledNoTimes.map((source) => `“${source.name}”`).join(", ")}.`
          : "Turn on the schedule and add run times on the source, or run it by hand. This is the most common reason nothing happens overnight.",
    });
  } else {
    // A stored `nextRunAt` that disagrees with the times on the row is the
    // quiet one: a schedule edited before `syncSchedule` existed, or a row
    // whose times were changed by hand, keeps firing on the old clock or never
    // fires again.
    const stale = scheduled.filter((source) => {
      const expected = computeNextRunAt(source, now);
      if (!source.nextRunAt) return true;
      if (!expected) return false;
      return Math.abs(source.nextRunAt.getTime() - expected.getTime()) > 25 * 60 * 60_000;
    });
    const next = scheduled
      .filter((source) => source.nextRunAt)
      .sort((a, b) => a.nextRunAt!.getTime() - b.nextRunAt!.getTime())[0];

    checks.push({
      name: "Schedules",
      state: stale.length > 0 ? "warn" : "ok",
      found:
        `${scheduled.length} source(s) are scheduled` +
        (next?.nextRunAt ? `; the next is “${next.name}” at ${next.nextRunAt.toISOString()}.` : ", but none has a next run time worked out.") +
        (stale.length > 0 ? ` ${stale.length} of them has a stored next-run that does not match its own times.` : ""),
      fix: stale.length > 0 ? "Open each of those and save it again — that recomputes the next run from the times on the row." : null,
    });
  }

  // --- 4b. The hunts, which have a clock of their own ---------------------
  if (theses.length > 0) {
    const running = theses.filter((thesis) => thesis.enabled && thesis.sourceId && thesis.runTimes.length > 0);
    const noSource = theses.filter((thesis) => thesis.enabled && !thesis.sourceId);
    const perDay = running.reduce((sum, thesis) => sum + thesis.runTimes.length * thesis.leadsPerRun, 0);
    const next = running
      .filter((thesis) => thesis.nextRunAt)
      .sort((a, b) => a.nextRunAt!.getTime() - b.nextRunAt!.getTime())[0];

    checks.push({
      name: "Hunts",
      // Not a stop. Hunts are one way leads arrive and the sources above are
      // another; neither being switched on is a reason the other cannot work.
      state: running.length === 0 ? "warn" : noSource.length > 0 ? "warn" : "ok",
      found:
        running.length === 0
          ? `${theses.length} hunt(s) are written and none is running, so nothing is being looked for on a schedule.`
          : `${running.length} hunt(s) running, about ${perDay} business(es) audited a day` +
            (next?.nextRunAt ? `; the next is “${next.name}” at ${next.nextRunAt.toISOString()}.` : ".") +
            (noSource.length > 0 ? ` ${noSource.length} is switched on with no search attached and will do nothing.` : ""),
      fix:
        running.length === 0
          ? "Switch one on under Leads → Hunts. Each one says how many businesses a day it will look at before you start it."
          : noSource.length > 0
            ? "Attach a lead source to the hunts that have none, under Leads → Hunts."
            : null,
    });
  }

  // --- 5. Runs that were started and did not work -------------------------
  const since = new Date(now.getTime() - 7 * 86_400_000);
  const [recent, failed, lastRun] = await Promise.all([
    prisma.scraperRun.count({ where: { startedAt: { gte: since } } }),
    prisma.scraperRun.findMany({
      where: { startedAt: { gte: since }, status: { in: ["FAILED", "TIMED_OUT", "ABORTED"] } },
      orderBy: { startedAt: "desc" },
      take: 3,
      include: { source: { select: { name: true } } },
    }),
    prisma.scraperRun.findFirst({ orderBy: { startedAt: "desc" }, include: { source: { select: { name: true } } } }),
  ]);

  if (recent === 0) {
    checks.push({
      name: "Recent runs",
      state: "warn",
      found: lastRun
        ? `Nothing has run in the last seven days. The last was “${lastRun.source.name}” on ${lastRun.startedAt.toISOString().slice(0, 10)}.`
        : "Nothing has ever run.",
      fix: "If the checks above are all green, press Run on a source once — a manual run proves the token and the actor in about a minute.",
    });
  } else if (failed.length > 0) {
    checks.push({
      name: "Recent runs",
      state: "warn",
      found: `${recent} run(s) in the last seven days, of which these did not finish: ${failed
        .map((run) => `“${run.source.name}” — ${run.error ?? run.status}`)
        .join("; ")}`,
      fix: "Open the run under Lead Sources → Runs. The error is Apify's own words, and an input-validation failure means a key in the source's input that the actor does not declare.",
    });
  } else {
    checks.push({ name: "Recent runs", state: "ok", found: `${recent} run(s) in the last seven days, none failed.`, fix: null });
  }

  // --- 6. Runs that worked and filed nothing ------------------------------
  const empty = await prisma.scraperRun.findMany({
    where: { startedAt: { gte: since }, status: "SUCCEEDED", leadsCreated: 0, itemsFetched: { gt: 0 } },
    orderBy: { startedAt: "desc" },
    take: 3,
    include: { source: { select: { name: true } } },
  });
  if (empty.length > 0) {
    checks.push({
      name: "Rows that became nothing",
      state: "warn",
      found: `${empty.length} run(s) fetched rows and filed no leads: ${empty.map((run) => `“${run.source.name}” (${run.itemsFetched} rows)`).join(", ")}`,
      fix: "Open the run and read its diagnostics — it records why each row was dropped. Usually every row was a duplicate, or the minimum score on the source is above what those rows can reach.",
    });
  }

  // --- 7. The agents that ask for a run -----------------------------------
  //
  // The last cause, and the one nobody looks for: capture is configured
  // perfectly and the *agent* that would ask for it is in dry run, so the call
  // was prepared and is sitting under Approvals.
  const askers = await prisma.agent.findMany({
    where: { toolkit: { hasSome: ["capture.run", "hunt.run"] } },
    select: { key: true, name: true, status: true, dryRun: true, autonomyLevel: true },
  });
  const held = askers.filter((agent) => agent.status === "ACTIVE" && (agent.dryRun || agent.autonomyLevel < 4));
  if (askers.length > 0) {
    checks.push({
      name: "Agents that start runs",
      state: held.length === askers.length ? "warn" : "ok",
      found:
        held.length === 0
          ? `${askers.length} agent(s) can start a run for real.`
          : `${held.map((agent) => agent.name).join(", ")} would prepare a run rather than start one — ${held[0].dryRun ? "dry run is on" : `autonomy is ${held[0].autonomyLevel}, and spending needs 4`}.`,
      fix:
        held.length > 0
          ? "This does not stop the schedule, which runs sources directly. It only means an agent asked to capture files a card under Approvals instead. Switch dry run off and raise autonomy to 4 if it should spend on its own."
          : null,
    });
  }

  const stops = checks.filter((check) => check.state === "stop");
  const verdict =
    stops.length === 1
      ? `Nothing will capture: ${stops[0].found} ${stops[0].fix ?? ""}`.trim()
      : stops.length > 1
        ? // All of them, because fixing one and then finding the next is how a
          // ten-minute problem becomes an afternoon.
          `Nothing will capture, and there is more than one reason. ${stops.map((stop) => stop.found).join(" ")}`
        : checks.some((check) => check.state === "warn")
          ? "Capture is configured and should run. The warnings below are the things most likely to be making it look idle."
          : "Everything checks out — capture is connected, scheduled and running.";

  return finish(checks, verdict);
}

function finish(checks: CaptureCheck[], verdict: string): CaptureDiagnosis {
  return { verdict, blocked: checks.some((check) => check.state === "stop"), checks };
}
