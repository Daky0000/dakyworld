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
//
// These run synchronously on the event loop after every reported error, over
// text a stranger can choose: Express puts a whole path parameter into the
// message of the error it throws. So every pattern below is linear. A pattern
// may start a match only on the character before a run (the leads), may not
// share a long run between many starting points (the scheme is at most 64
// characters, and a path without a query is consumed rather than retried), and
// every string is cut to `MAX_SCRUBBED` before they run. Three of them used to
// be quadratic and the encoded-address one cubic: a 5 KB path segment of
// `a%40` held the process for seven seconds. A lead is matched rather than
// looked behind for because the browser's copy has to parse on Safari before
// 16.4, where a lookbehind is a syntax error that would stop the app loading.

/** A path segment shaped like a credential — a review link's token, a checkout key. Same rule as `redactedRoute`. */
const CREDENTIAL_SEGMENT = /^[A-Za-z0-9_-]{24,}$/;
/** A cuid is a row id, which is what makes an error findable, not a secret. */
const ROW_ID = /^c[a-z0-9]{20,}$/;
/** Stripped before the test above, so a link cut off mid-character (`<token>%E2%80`) is still a token. */
const PERCENT_ESCAPE = /%[0-9A-Fa-f]{0,2}/g;
/** Tested with `%40` decoded first; the `@` it leaves is what keeps this to one start per run. */
const EMAIL_SEGMENT = /(?:^|[/@\s])[^/@\s]+@[^/@\s]+\.[a-z]{2,}/i;
const PARAM_NAME = /^[A-Za-z_][\w.[\]-]{0,63}$/;
const URL_IN_TEXT = /[a-z][a-z0-9+.-]{0,63}:\/\/[^\s"'<>`]+/gi;
/** The query is optional so that a path without one is consumed in one step, not tried again from every `=/` inside it. */
const PATH_WITH_QUERY = /(^|[\s"'(=])(\/[^\s"'<>`?]*)(\?[^\s"'<>`]+)?/g;
/**
 * Addresses written back to back (`a@x.com%2Cb@y.com`) are one match, because
 * the second has no lead of its own to start from.
 */
const EMAIL = /(^|[^A-Za-z0-9._%+-])((?:[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})+)/g;
const SECRET_HEADER = /authorization|cookie|token|secret|signature|api-?key|session|password/i;
/** How the error handler's `route` tag and a transaction name begin. */
const REQUEST_LINE = /^[A-Z]+ \//;

/** Far longer than any real address, route or sentence; anything longer is cut before it is scrubbed. */
const MAX_SCRUBBED = 4096;
/** The SDK's own cut, below. Above `MAX_SCRUBBED`, so whatever the SDK cut is cut again here, back to a safe place. */
const MAX_VALUE_LENGTH = 64 * 1024;
/** Characters an address, a token or the password in a link is made of. */
const WORD_TAIL = /[\w.%+@:-]/;

/**
 * Scrubs at most `MAX_SCRUBBED` characters. The cut goes back to the last
 * character that cannot be inside an address or a token, because a review
 * token cut to twelve characters no longer looks like a token, and the half of
 * an address before the cut no longer looks like an address.
 */
function withinLimit(text: string, scrub: (text: string) => string): string {
  if (text.length <= MAX_SCRUBBED) return scrub(text);
  let end = MAX_SCRUBBED;
  while (end > 0 && WORD_TAIL.test(text.charAt(end - 1))) end--;
  return `${scrub(text.slice(0, end))}[truncated]`;
}

function scrubPath(path: string): string {
  return path
    .split("/")
    .map((segment) => {
      const bare = segment.replace(PERCENT_ESCAPE, "");
      return EMAIL_SEGMENT.test(segment.replace(/%40/g, "@")) ? ":email" : CREDENTIAL_SEGMENT.test(bare) && !ROW_ID.test(bare) ? ":token" : segment;
    })
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
  return withinLimit(url, (whole) => {
    const beforeFragment = whole.split("#", 1)[0] ?? "";
    const queryAt = beforeFragment.indexOf("?");
    const base = queryAt === -1 ? beforeFragment : beforeFragment.slice(0, queryAt);
    const authority = /^[a-z][a-z0-9+.-]*:\/\/[^/]*/i.exec(base)?.[0] ?? "";
    const query = queryAt === -1 ? "" : beforeFragment.slice(queryAt + 1);
    return (
      authority.replace(/\/\/[^/]*@/, "//[Filtered]@") +
      scrubPath(base.slice(authority.length)) +
      (query ? `?${query.split("&").map(scrubParam).join("&")}` : "")
    );
  });
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

/**
 * Free text — an error message, a breadcrumb — with every URL in it scrubbed
 * and every address masked. Prisma's arguments go before the cut, because
 * they come before its verdict and a page's HTML is longer than the limit.
 */
export function scrubText(text: string): string {
  return withinLimit(scrubPrismaArguments(text), (short) =>
    short
      .replace(URL_IN_TEXT, (url) => scrubUrl(url))
      .replace(PATH_WITH_QUERY, (match: string, lead: string, path: string, query?: string) => (query ? lead + scrubUrl(path + query) : match))
      .replace(EMAIL, (_match: string, lead: string) => `${lead}[email]`),
  );
}

/** `GET /review/<token>` → `GET /review/:token`. */
function scrubRouteName(name: string): string {
  return withinLimit(name, (whole) => {
    const space = whole.indexOf(" ");
    return space === -1 ? scrubUrl(whole) : whole.slice(0, space + 1) + scrubUrl(whole.slice(space + 1));
  });
}

/**
 * Every string in `extra` or `contexts`, scrubbed as free text. Nothing in the
 * app sets either, but the SDK fills `contexts` and an integration may add to
 * it — a span's data holds the full URL. Deeper than the SDK normalises to is
 * dropped rather than walked.
 */
function scrubValues(value: unknown, depth: number): unknown {
  if (typeof value === "string") return scrubText(value);
  if (!value || typeof value !== "object") return value;
  if (depth > 5) return "[Filtered]";
  if (Array.isArray(value)) return value.map((item) => scrubValues(item, depth + 1));
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const scrubbed = scrubValues(record[key], depth + 1);
    if (scrubbed !== record[key]) record[key] = scrubbed;
  }
  return record;
}

/**
 * Something thrown that is not an Error — a library rejecting with a plain
 * object — arrives serialised whole in `extra.__serialized__`, and the server's
 * SDK makes the object's own `message` (or `name`) the exception's value. That
 * object is data, not a sentence: a mail payload, an enquiry. The event keeps
 * which keys it had and the stack; its values never leave.
 */
function scrubThrownObject(event: Event): void {
  if (!event.extra || !("__serialized__" in event.extra)) return;
  const thrown = event.extra.__serialized__;
  delete event.extra.__serialized__;
  const keys = thrown && typeof thrown === "object" ? Object.keys(thrown).sort().slice(0, 20) : [];
  const named = keys.map((key) => (PARAM_NAME.test(key) ? key : "[Filtered]")).join(", ");
  for (const exception of event.exception?.values ?? []) exception.value = `Object captured as exception with keys: ${named || "none"}`;
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
  scrubThrownObject(event);
  for (const exception of event.exception?.values ?? []) {
    if (exception.value) exception.value = scrubText(exception.value);
    // A frame's local variables can be the very body this file keeps out.
    for (const frame of exception.stacktrace?.frames ?? []) delete frame.vars;
  }
  // A tag sits beside the message. The error handler's `route` is a request
  // line, written before any of this ran.
  const tags = event.tags;
  if (tags) {
    for (const name of Object.keys(tags)) {
      const value = tags[name];
      if (typeof value === "string") tags[name] = REQUEST_LINE.test(value) ? scrubRouteName(value) : scrubText(value);
    }
  }
  if (event.extra) scrubValues(event.extra, 0);
  if (event.contexts) scrubValues(event.contexts, 0);
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
    // The SDK cuts the URL and each exception's value to this before
    // `beforeSend` sees them: a ceiling on what reaches the scrubbers at all.
    // Generous on purpose, because Prisma prints a page's HTML before its
    // verdict and the verdict has to survive until `scrubText` drops the HTML.
    maxValueLength: MAX_VALUE_LENGTH,
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
