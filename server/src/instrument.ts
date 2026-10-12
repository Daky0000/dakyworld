// .env has to be read before the options below look at the environment, and
// the entry files only load it after a dozen other imports. It never overrides
// a variable that is already set, so on Railway nothing changes.
import "dotenv/config";
import * as Sentry from "@sentry/node";
import type { Breadcrumb, Event, NodeOptions } from "@sentry/node";

/**
 * Error tracking, started before anything else in the process.
 *
 * Until this existed a 500 reached nobody: the message went to stdout, the
 * person saw "Something went wrong." and a reference, and unless five arrived
 * inside ten minutes (services/opsAlert.ts) the Owner never heard of it. Sentry
 * gets the unexpected ones — the error handler decides which those are — and a
 * crash on its way out.
 *
 * Imported as the first line of index.ts and worker.ts. It is its own module so
 * it runs before the app's own imports, and so the scrubbers below can be
 * exercised by `checks/monitoring.ts` without a network or a Sentry account.
 */

/**
 * The server project's DSN. A DSN only permits sending events into the
 * project — Sentry documents it as safe to publish — so it is a default here
 * rather than a secret, and `SENTRY_DSN` overrides it.
 */
export const SERVER_DSN = "https://cd54e2f87122685825ee4d8d76c8066d@o4511716208869376.ingest.de.sentry.io/4512240593338448";

/**
 * Default integrations left out, by name.
 *
 * - `Express` reports every error passed to `next()` that carries no status of
 *   its own, which includes a Zod refusal the handler answers with a 400. What
 *   counts as unexpected is decided once, in `middleware/errorHandler.ts`.
 * - `OnUncaughtException` and `OnUnhandledRejection` would report a crash a
 *   second time and take a vote on whether the process exits;
 *   `installCrashReporting` already owns both.
 * - `Console` turns every log line into a breadcrumb, and a log line can hold
 *   anything — an enquiry, a page's HTML. Railway keeps the logs already.
 */
export const LEFT_OUT_INTEGRATIONS = new Set(["Express", "OnUncaughtException", "OnUnhandledRejection", "Console"]);

/* ------------------------------------------------------------ scrubbing -- */

// What leaves this process is the stack, the route and the sentence; never the
// session, the body or a link that signs somebody in. Customer page HTML,
// enquiry messages, set-password tokens and payment references all pass
// through requests here. The SDK is also configured not to collect these
// (`dataCollection` below), but v11 changed what it collects by default from
// almost nothing to almost everything, and these functions do not trust the
// next default either. `client/src/lib/monitoring.ts` holds the browser's copy
// of the same rules, and `checks/monitoring.ts` runs both over one table.

/** A path segment shaped like a credential — a review link's token, a checkout key. Same rule as `redactedRoute`. */
const CREDENTIAL_SEGMENT = /^[A-Za-z0-9_-]{24,}$/;
/** A cuid is a row id, which is what makes an error findable, not a secret. */
const ROW_ID = /^c[a-z0-9]{20,}$/;
const EMAIL_SEGMENT = /[^/@\s]+(?:@|%40)[^/@\s]+\.[a-z]{2,}/i;
const PARAM_NAME = /^[A-Za-z_][\w.[\]-]{0,63}$/;
const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>`]+/gi;
const PATH_WITH_QUERY = /(^|[\s"'(=])(\/[^\s"'<>`?]*\?[^\s"'<>`]+)/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const SECRET_HEADER = /authorization|cookie|token|secret|signature|api-?key|session|password/i;

function scrubPath(path: string): string {
  return path
    .split("/")
    .map((segment) => (EMAIL_SEGMENT.test(segment) ? ":email" : CREDENTIAL_SEGMENT.test(segment) && !ROW_ID.test(segment) ? ":token" : segment))
    .join("/");
}

/** Keeps the name, so the event still says which parameters there were. */
function scrubParam(pair: string): string {
  if (!pair) return pair;
  const name = pair.split("=", 1)[0] ?? "";
  return PARAM_NAME.test(name) ? `${name}=[Filtered]` : "[Filtered]";
}

/**
 * One URL, absolute or a bare path: every query value replaced, the fragment
 * dropped, a password in the authority replaced, and a path segment that is a
 * token or an address masked. The path itself — which screen, which route — is
 * what makes the event useful, so it stays.
 */
export function scrubUrl(url: string): string {
  const beforeFragment = url.split("#", 1)[0] ?? "";
  const queryAt = beforeFragment.indexOf("?");
  const base = queryAt === -1 ? beforeFragment : beforeFragment.slice(0, queryAt);
  const authority = /^[a-z][a-z0-9+.-]*:\/\/[^/]*/i.exec(base)?.[0] ?? "";
  const query = queryAt === -1 ? "" : beforeFragment.slice(queryAt + 1);
  return (
    authority.replace(/\/\/[^/]*@/, "//[Filtered]@") +
    scrubPath(base.slice(authority.length)) +
    (query ? `?${query.split("&").map(scrubParam).join("&")}` : "")
  );
}

/**
 * Prisma's validation error prints the call's arguments, values and all — a
 * page's HTML, an enquiry — between the line naming the call and the sentence
 * saying what was wrong with it. Prisma's sentences start a line with a
 * capital letter; the arguments and the source lines around the call never
 * do, so those go and the call, where it was made and the verdict stay.
 */
function scrubPrismaArguments(text: string): string {
  const at = text.search(/Invalid `[^`\n]+` invocation/);
  if (at === -1) return text;
  const [head = "", ...rest] = text.slice(at).split("\n");
  const location = head.endsWith(" in") && rest[0]?.startsWith("/") ? rest.splice(0, 1) : [];
  const verdict = rest.filter((line) => /^[A-Z]/.test(line));
  const dropped = rest.some((line) => line.trim() && !/^[A-Z]/.test(line));
  return [text.slice(0, at) + head, ...location, ...(dropped ? ["[arguments filtered]"] : []), ...verdict].join("\n");
}

/** Free text — an error message, a breadcrumb — with every URL in it scrubbed and every address masked. */
export function scrubText(text: string): string {
  return scrubPrismaArguments(text)
    .replace(URL_IN_TEXT, (url) => scrubUrl(url))
    .replace(PATH_WITH_QUERY, (_match, lead: string, path: string) => lead + scrubUrl(path))
    .replace(EMAIL, "[email]");
}

/** `GET /review/<token>` → `GET /review/:token`. */
function scrubRouteName(name: string): string {
  const space = name.indexOf(" ");
  return space === -1 ? scrubUrl(name) : name.slice(0, space + 1) + scrubUrl(name.slice(space + 1));
}

export function scrubBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb | null {
  if (breadcrumb.category === "console") return null;
  if (breadcrumb.message) breadcrumb.message = scrubText(breadcrumb.message);
  const data = breadcrumb.data;
  if (data) {
    for (const key of Object.keys(data)) {
      const value = data[key];
      // `url.query` and `url.fragment` arrive beside the URL as well as in it.
      if (/(^|[._])(query|fragment|query_string|body)$/i.test(key)) delete data[key];
      else if (typeof value === "string") data[key] = /(^|[._])(url|from|to|href)$/i.test(key) ? scrubUrl(value) : scrubText(value);
    }
  }
  return breadcrumb;
}

export function scrubEvent<T extends Event>(event: T): T {
  const request = event.request;
  if (request) {
    delete request.cookies;
    delete request.data;
    delete request.query_string;
    delete request.env;
    if (request.url) request.url = scrubUrl(request.url);
    const headers = request.headers;
    if (headers) {
      for (const name of Object.keys(headers)) {
        if (SECRET_HEADER.test(name)) delete headers[name];
        else if (/^referr?er$/i.test(name)) headers[name] = scrubUrl(headers[name] ?? "");
      }
    }
  }
  if (event.user) {
    delete event.user.ip_address;
    delete event.user.email;
    delete event.user.username;
  }
  if (event.transaction) event.transaction = scrubRouteName(event.transaction);
  if (event.message) event.message = scrubText(event.message);
  if (event.logentry?.message) event.logentry.message = scrubText(event.logentry.message);
  for (const exception of event.exception?.values ?? []) {
    if (exception.value) exception.value = scrubText(exception.value);
    // A frame's local variables can be the very body this file keeps out.
    for (const frame of exception.stacktrace?.frames ?? []) delete frame.vars;
  }
  // Breadcrumbs added straight to a scope skip `beforeBreadcrumb`.
  if (event.breadcrumbs) event.breadcrumbs = event.breadcrumbs.flatMap((breadcrumb) => scrubBreadcrumb(breadcrumb) ?? []);
  return event;
}

/** A scrubber that throws drops the event rather than letting it out unscrubbed. */
function failClosed<T>(scrub: (value: T) => T | null): (value: T) => T | null {
  return (value) => {
    try {
      return scrub(value);
    } catch {
      return null;
    }
  };
}

/* -------------------------------------------------------------- options -- */

/**
 * The options Sentry starts with, or null when it should stay off.
 *
 * On in production, and anywhere `SENTRY_DSN` is set; `SENTRY_DSN=off` turns it
 * off even in production. Local development and the checks harness set
 * neither, so they send nothing.
 */
export function monitoringOptions(env: NodeJS.ProcessEnv = process.env): NodeOptions | null {
  const configured = env.SENTRY_DSN?.trim() ?? "";
  if (configured.toLowerCase() === "off") return null;
  if (!configured && env.NODE_ENV !== "production") return null;
  const role = env.SERVICE_ROLE || "combined";
  const sampled = Number(env.SENTRY_TRACES_SAMPLE_RATE);
  return {
    dsn: configured || SERVER_DSN,
    environment: env.RAILWAY_ENVIRONMENT_NAME || env.NODE_ENV || "development",
    ...(env.RAILWAY_GIT_COMMIT_SHA ? { release: env.RAILWAY_GIT_COMMIT_SHA } : {}),
    // The hostname Sentry would pick is a Railway container id that changes
    // on every deploy; the role says which half of the system it was.
    serverName: role,
    initialScope: { tags: { service: role } },
    // Errors only unless somebody asks for traces.
    tracesSampleRate: Number.isFinite(sampled) && sampled > 0 ? Math.min(sampled, 1) : 0,
    // What `sendDefaultPii: false` used to mean, spelled out, because v11
    // removed that option and defaults every one of these to on.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: { request: { allow: ["user-agent"] }, response: false },
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
    },
    // Otherwise every outgoing request — to Paystack, GitHub, every model
    // vendor — gains `sentry-trace` and `baggage` headers naming this
    // organisation. Nothing here follows a trace across services.
    tracePropagationTargets: [],
    // The runtime hooks rewrite modules such as Express as they load, to feed
    // the integrations left out below. Nothing here listens, so nothing is
    // rewritten.
    enableRuntimeChannelInjection: false,
    integrations: (defaults) => defaults.filter((integration) => !LEFT_OUT_INTEGRATIONS.has(integration.name)),
    // Spans, if tracing is ever turned on, are streamed and skip these; the
    // `dataCollection` above is what keeps queries, headers and bodies off them.
    beforeSend: failClosed(scrubEvent),
    beforeBreadcrumb: failClosed(scrubBreadcrumb),
  };
}

/**
 * Starts Sentry if it should run. Never throws: a monitoring outage — a bad
 * DSN, an SDK that will not load, Sentry unreachable — must not be the reason
 * the API does not boot. Sending is asynchronous and its failures stay inside
 * the SDK, so a blocked Sentry never reaches a request either.
 */
export function startMonitoring(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    const options = monitoringOptions(env);
    if (!options) return false;
    Sentry.init(options);
    return true;
  } catch (error) {
    console.error("[monitoring] error tracking did not start; carrying on without it:", (error as Error).message);
    return false;
  }
}

startMonitoring();
