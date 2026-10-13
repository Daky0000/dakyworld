import type { Breadcrumb, BrowserOptions, Event } from "@sentry/react";

/**
 * Error reporting from the browser.
 *
 * Until this existed a screen that stopped drawing told the person a reference
 * and told us nothing. The ErrorBoundary now hands what it caught to Sentry with
 * that reference as a tag, and an error nothing caught is reported too.
 *
 * Only the hosts that serve the real app report, unless `VITE_SENTRY_DSN` is set
 * when the client is built (`off` silences even those). The SDK is fetched as
 * its own chunk once that is decided, so a local run never downloads it and a
 * blocker that refuses the chunk costs the app nothing. A render error caught
 * before the chunk has arrived waits for it rather than being lost.
 *
 * Nothing in this file touches `window` or `import.meta.env`; main.tsx passes
 * them in. That keeps it importable by `server/checks/monitoring.ts`, which
 * runs these scrubbers over the same table as the server's copy in
 * `server/src/instrument.ts`. Change the rules in both.
 */

/** The browser project's DSN. It is in the bundle either way; Sentry documents a DSN as safe to publish. */
export const BROWSER_DSN = "https://3c79059905ad2387d597cdd8b5936d4f@o4511716208869376.ingest.de.sentry.io/4512240593403984";

export const PRODUCTION_HOSTS: ReadonlySet<string> = new Set(["os.dakyx.com", "editor.dakyx.com", "app.dakyx.com", "os.dakyworld.com"]);

/* ------------------------------------------------------------ scrubbing -- */

// The same rules as the server: the path stays, every query value, fragment,
// token-shaped segment and address goes. Set-password and reset links carry a
// token and an email in the address bar, and the address bar is the first
// thing an error report records.
//
// Every pattern is linear and every string is cut to `MAX_SCRUBBED` before they
// run, as on the server, where the reasons are written out: an address bar can
// hold whatever a link put there. No lookbehind: Safari before 16.4 refuses to
// parse one, and this module is in the bundle every page loads.

const CREDENTIAL_SEGMENT = /^[A-Za-z0-9_-]{24,}$/;
const ROW_ID = /^c[a-z0-9]{20,}$/;
const PERCENT_ESCAPE = /%[0-9A-Fa-f]{0,2}/g;
const EMAIL_SEGMENT = /(?:^|[/@\s])[^/@\s]+@[^/@\s]+\.[a-z]{2,}/i;
const PARAM_NAME = /^[A-Za-z_][\w.[\]-]{0,63}$/;
const URL_IN_TEXT = /[a-z][a-z0-9+.-]{0,63}:\/\/[^\s"'<>`]+/gi;
const PATH_WITH_QUERY = /(^|[\s"'(=])(\/[^\s"'<>`?]*)(\?[^\s"'<>`]+)?/g;
const EMAIL = /(^|[^A-Za-z0-9._%+-])((?:[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})+)/g;
const SECRET_HEADER = /authorization|cookie|token|secret|signature|api-?key|session|password/i;
const REQUEST_LINE = /^[A-Z]+ \//;

const MAX_SCRUBBED = 4096;
const MAX_VALUE_LENGTH = 64 * 1024;
const WORD_TAIL = /[\w.%+@:-]/;

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

function scrubParam(pair: string): string {
  if (!pair) return pair;
  const name = pair.split("=", 1)[0] ?? "";
  return PARAM_NAME.test(name) ? `${name}=[Filtered]` : "[Filtered]";
}

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

// A development build shows the server's own error message, and Prisma's
// carries the arguments of the call that failed.
function scrubPrismaArguments(text: string): string {
  const at = text.search(/Invalid `[^`\n]+` invocation/);
  if (at === -1) return text;
  const [head = "", ...rest] = text.slice(at).split("\n");
  const location = head.endsWith(" in") && rest[0]?.startsWith("/") ? rest.splice(0, 1) : [];
  const verdict = rest.filter((line) => /^[A-Z]/.test(line));
  const dropped = rest.some((line) => line.trim() && !/^[A-Z]/.test(line));
  return [text.slice(0, at) + head, ...location, ...(dropped ? ["[arguments filtered]"] : []), ...verdict].join("\n");
}

export function scrubText(text: string): string {
  return withinLimit(scrubPrismaArguments(text), (short) =>
    short
      .replace(URL_IN_TEXT, (url) => scrubUrl(url))
      .replace(PATH_WITH_QUERY, (match: string, lead: string, path: string, query?: string) => (query ? lead + scrubUrl(path + query) : match))
      .replace(EMAIL, (_match: string, lead: string) => `${lead}[email]`),
  );
}

function scrubRouteName(name: string): string {
  return withinLimit(name, (whole) => {
    const space = whole.indexOf(" ");
    return space === -1 ? scrubUrl(whole) : whole.slice(0, space + 1) + scrubUrl(whole.slice(space + 1));
  });
}

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

// An unhandled rejection with a plain object arrives serialised whole in
// `extra.__serialized__`. Its keys stay; its values are data, never a sentence.
function scrubThrownObject(event: Event): void {
  if (!event.extra || !("__serialized__" in event.extra)) return;
  const thrown = event.extra.__serialized__;
  delete event.extra.__serialized__;
  const keys = thrown && typeof thrown === "object" ? Object.keys(thrown).sort().slice(0, 20) : [];
  const named = keys.map((key) => (PARAM_NAME.test(key) ? key : "[Filtered]")).join(", ");
  for (const exception of event.exception?.values ?? []) exception.value = `Object captured as exception with keys: ${named || "none"}`;
}

export function scrubBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb | null {
  // A log line can hold anything the screen had loaded.
  if (breadcrumb.category === "console") return null;
  if (breadcrumb.message) breadcrumb.message = scrubText(breadcrumb.message);
  const data = breadcrumb.data;
  if (data) {
    for (const key of Object.keys(data)) {
      const value = data[key];
      if (/(^|[._])(query|fragment|query_string|body)$/i.test(key)) delete data[key];
      // A navigation breadcrumb's `from` and `to` are the address bar.
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
    for (const frame of exception.stacktrace?.frames ?? []) delete frame.vars;
  }
  const tags = event.tags;
  if (tags) {
    for (const name of Object.keys(tags)) {
      const value = tags[name];
      if (typeof value === "string") tags[name] = REQUEST_LINE.test(value) ? scrubRouteName(value) : scrubText(value);
    }
  }
  // The ErrorBoundary's component stack is in `contexts.react`.
  if (event.extra) scrubValues(event.extra, 0);
  if (event.contexts) scrubValues(event.contexts, 0);
  if (event.breadcrumbs) event.breadcrumbs = event.breadcrumbs.flatMap((breadcrumb) => scrubBreadcrumb(breadcrumb) ?? []);
  return event;
}

function failClosed<T>(scrub: (value: T) => T | null): (value: T) => T | null {
  return (value) => {
    try {
      return scrub(value);
    } catch {
      return null;
    }
  };
}

/* ------------------------------------------------------- whose error it is -- */

/**
 * Script addresses an error is not ours to fix when it was thrown there.
 * Sentry tests the frame the error was thrown in against these.
 *
 * - A browser extension runs its own scripts in our page; Safari hides their
 *   address behind `webkit-masked-url:`.
 * - The page being edited is a real customer page running its own scripts, in a
 *   same-origin frame served from `/api/website/…`, as are previews and demos.
 *   Its errors are that site's, and they surface here only when the editor
 *   calls into the frame.
 * - Any other host. The app's own CSP allows scripts from this host alone, so a
 *   frame elsewhere is somebody else's page.
 */
export function foreignScriptUrls(host: string): RegExp[] {
  const ownHost = host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [
    /^(?:chrome|moz|safari|safari-web|ms-browser)-extension:\/\//i,
    /^webkit-masked-url:/i,
    /^about:srcdoc/i,
    /\/api\/website\//,
    /\/demos\//,
    new RegExp(`^https?://(?!${ownHost}(?::\\d+)?(?:/|$))`, "i"),
  ];
}

/* -------------------------------------------------------------- starting -- */

/** The DSN to report to, or null when this build on this host should stay quiet. */
export function monitoringDsn(host: string, configured: string | undefined): string | null {
  const dsn = (configured ?? "").trim();
  if (dsn.toLowerCase() === "off") return null;
  if (dsn) return dsn;
  return PRODUCTION_HOSTS.has(host) ? BROWSER_DSN : null;
}

export function browserOptions(dsn: string, host: string): BrowserOptions {
  return {
    dsn,
    environment: PRODUCTION_HOSTS.has(host) ? "production" : "development",
    // Errors only. No replay integration is added either: a recording of the
    // editor is a recording of a customer's page.
    tracesSampleRate: 0,
    // A ceiling on what reaches the scrubbers; they cut to 4 KB themselves.
    maxValueLength: MAX_VALUE_LENGTH,
    // v11 collects every one of these by default; `sendDefaultPii` is gone.
    // The user agent stays, because it is what says which browser broke.
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
    denyUrls: foreignScriptUrls(host),
    integrations: (defaults) => defaults.filter((integration) => integration.name !== "Console"),
    beforeSend: failClosed(scrubEvent),
    beforeBreadcrumb: failClosed(scrubBreadcrumb),
  };
}

type Capture = typeof import("@sentry/react")["captureException"];
let capture: Promise<Capture | null> | null = null;

/**
 * Called once, from main.tsx, before the first render. Never throws, and a
 * chunk that will not load or a DSN Sentry rejects leaves the app exactly as it
 * was without monitoring.
 *
 * The two functions are destructured where the chunk arrives on purpose: that
 * is what lets the bundler drop the rest of the SDK. Holding the whole module
 * made the chunk 154 kB gzipped, replay and feedback included.
 */
export function startMonitoring(host: string, configured: string | undefined): void {
  if (capture) return;
  const dsn = monitoringDsn(host, configured);
  if (!dsn) return;
  capture = import("@sentry/react")
    .then(({ init, captureException }) => {
      init(browserOptions(dsn, host));
      return captureException;
    })
    .catch((error: unknown) => {
      console.warn("[monitoring] error reporting did not start:", error);
      return null;
    });
}

/** What an ErrorBoundary caught, with the label of the boundary and the reference the person was shown. */
export function reportRenderError(error: Error, boundary: string, reference: string | null, componentStack?: string | null): void {
  if (!capture) return;
  void capture
    .then((captureException) => {
      captureException?.(error, {
        tags: { boundary, ...(reference ? { reference } : {}) },
        ...(componentStack ? { contexts: { react: { componentStack } } } : {}),
      });
    })
    .catch(() => undefined);
}
