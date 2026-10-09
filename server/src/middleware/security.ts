import { localRateStore, rateBucketKey, takeSharedRateBucket, clearSharedRateBucket } from "../lib/rateLimitStore.js";
import type { NextFunction, Request, Response } from "express";

/**
 * Headers the browser enforces for us, a redirect that keeps plain HTTP from
 * ever carrying a session cookie, and the rate limiters.
 *
 * Hand-written rather than pulled from helmet + express-rate-limit: the set
 * that matters here is small, and both dependencies would need configuring
 * away from their defaults anyway. What is *not* hand-waved any more is the
 * CSP — see below.
 */

const isProduction = () => process.env.NODE_ENV === "production";

/**
 * The address to hold a rate-limit counter against.
 *
 * `req.ip` is only trustworthy once `trust proxy` is set (index.ts does it),
 * and that matters more than it looks: reading `X-Forwarded-For` by hand — as
 * this file used to — hands the caller the key to its own bucket. A script that
 * sends a fresh `X-Forwarded-For` per request gets a fresh allowance per
 * request, which is a rate limiter that stops exactly nobody.
 *
 * With `trust proxy` set to a hop count, Express walks the header from the
 * right and takes the entry the trusted proxy itself wrote, which the caller
 * cannot reach past.
 */
export function clientIp(req: Request): string {
  return req.ip || req.socket.remoteAddress || "unknown";
}

/**
 * The client is a Vite build: one module script, one stylesheet, no inline
 * script anywhere. That is what makes `script-src 'self'` — the directive that
 * actually stops an injected script tag — affordable here without a nonce
 * pipeline.
 *
 * Two deliberate loosenings:
 * - `style-src 'unsafe-inline'` — React writes style attributes for the few
 *   computed widths in the UI, and the API-only status page carries a style
 *   block. Inline CSS is not the injection route worth a nonce for.
 * - `img-src https:` — lead screenshots and Apify actor icons come from hosts
 *   that change. An image is not executable, and pinning them would break the
 *   Leads screen the first time Apify moved a bucket.
 *
 * `/demos/:slug` sets its own, stricter CSP after this runs and wins, which is
 * correct: a page a model wrote gets less trust than the app does.
 */
const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob: https:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self' blob:",
  "upgrade-insecure-requests",
].join("; ");

export function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  // Railway terminates TLS in front of us, so tell the browser never to try
  // plain HTTP again. Only in production: this header on localhost would make
  // http://localhost unreachable in that browser for a year.
  if (isProduction()) {
    res.setHeader("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  }
  res.setHeader("Content-Security-Policy", CSP);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  // Keeps a cross-origin opener holding a handle on this window, and stops
  // another site pulling our responses in as a resource.
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  // The whole app is behind a login. None of it belongs in a search index.
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  // Express advertises itself by default; there is no reason to name the stack.
  res.removeHeader("X-Powered-By");
  next();
}

/**
 * HSTS only helps a browser that has already been here once. The redirect is
 * what covers the first visit, a typed http:// address, and a link somebody
 * pasted into a chat.
 *
 * A write over plain HTTP is refused rather than redirected: the body has
 * already crossed the network in clear by the time we could redirect it, and a
 * 308 would only send the same secret a second time.
 *
 * **It only acts on a request that carries `X-Forwarded-Proto: http`** — that
 * is, one that reached the public edge and came in over plain HTTP. A request
 * with no such header never went through the proxy at all, which on Railway
 * means it originated inside the private network: the platform's own
 * healthcheck, or another service on the same project. There is no plaintext
 * hop across the internet to protect, and redirecting it does real harm —
 * Railway healthchecks `/api/health` over internal HTTP and wants a 200, so a
 * 308 there marks every deploy unhealthy and rolls it back. `/api/health` is
 * exempted outright as well, because a healthcheck that can be broken by a
 * header change is a healthcheck waiting to break.
 */
const HEALTHCHECK_PATHS = new Set(["/api/health", "/api/ready"]);

export function forceHttps(req: Request, res: Response, next: NextFunction) {
  if (!isProduction()) return next();
  if (HEALTHCHECK_PATHS.has(req.path)) return next();

  // req.secure is only meaningful with `trust proxy` set; index.ts sets it.
  if (req.secure) return next();
  // No proxy header at all: internal traffic, not a plaintext request from the
  // internet. Nothing to upgrade.
  if (!req.headers["x-forwarded-proto"]) return next();

  if (req.method !== "GET" && req.method !== "HEAD") {
    return res.status(403).json({ error: "HTTPS is required." });
  }
  return res.redirect(308, `https://${req.headers.host}${req.originalUrl}`);
}

// --- Writes from pages we do not run ------------------------------------------

/**
 * The browser origins allowed to call the API with a session cookie. CORS in
 * index.ts reads the same list, so the two cannot drift apart.
 */
const TRUSTED_ORIGINS = new Set([
  "https://os.dakyx.com",
  "https://app.dakyx.com",
  "https://editor.dakyx.com",
  "https://dakyx.com",
  "https://www.dakyx.com",
  "https://os.dakyworld.com",
]);

export function isTrustedOrigin(origin: string): boolean {
  if (TRUSTED_ORIGINS.has(origin)) return true;
  if (process.env.CLIENT_ORIGIN && origin === process.env.CLIENT_ORIGIN) return true;
  return !isProduction() && (origin.includes("localhost") || origin.includes("127.0.0.1"));
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Refuses a write that a browser says came from a page that is not ours.
 *
 * The session cookie is `SameSite=Lax`, and "site" there means the registrable
 * domain. Every `*.dakyx.com` host therefore counts as the same site as
 * os.dakyx.com, and the browser attaches the Owner's cookie to whatever such a
 * page sends. That includes customer websites the moment they are hosted under
 * dakyx.com. CORS does not cover the gap. It stops a page *reading* the answer,
 * and it stops JSON bodies by refusing the preflight. A POST with no body, or a
 * form body, is a "simple" request: it is sent, with the cookie, and the route
 * runs. Approve, run, cancel and sign-out all take no body.
 *
 * A page cannot forge `Origin`, because the browser writes it. A request with no
 * `Origin` at all is not a browser making a cross-origin write: it is curl, an
 * MCP client or another server, and none of those carries somebody else's
 * cookie. `null` comes from sandboxed frames and `data:` pages and is never ours.
 */
export function refuseForeignWrites(req: Request, res: Response, next: NextFunction) {
  if (SAFE_METHODS.has(req.method)) return next();
  const origin = req.headers.origin;
  if (origin === undefined || (origin !== "null" && isTrustedOrigin(origin))) return next();
  return res.status(403).json({ error: "This request came from a page that is not part of DakyXTech, so it was refused." });
}

// --- Rate limiting -----------------------------------------------------------

interface LimitOptions {
  windowMs: number;
  max: number;
  /** "{minutes}" is replaced with how long is left. */
  message: string;
  /** Defaults to the caller's address. Pass one naming the account when the account is what's under attack. */
  key?: (req: Request) => string;
}

/**
 * A limiter, plus a way for a request that proves the caller is legitimate to
 * forgive its own attempts. Standard RateLimit-* headers go out on every
 * response so a real integration can back off rather than guess.
 */
export function rateLimit(options: LimitOptions) {
  const store = localRateStore();
  const scope = JSON.stringify([options.message, options.windowMs, options.max]);
  const shared = () => process.env.NODE_ENV === "production" || process.env.RATE_LIMIT_SHARED === "true";
  const keyOf = options.key ?? clientIp;

  const middleware = async (req: Request, res: Response, next: NextFunction) => {
    let bucket;
    try {
      bucket = shared() ? await takeSharedRateBucket(rateBucketKey(scope, keyOf(req)), options.windowMs, options.max)
        : store.take(keyOf(req), options.windowMs, options.max);
    } catch {
      return res.status(503).set("Retry-After", "15").set("Cache-Control", "no-store").json({ error: "Request protection is temporarily unavailable. Please retry shortly." });
    }
    const remaining = Math.max(0, options.max - bucket.count);
    const resetSeconds = Math.max(1, Math.ceil((bucket.resetAt - Date.now()) / 1000));

    res.setHeader("RateLimit-Limit", String(options.max));
    res.setHeader("RateLimit-Remaining", String(remaining));
    res.setHeader("RateLimit-Reset", String(resetSeconds));

    if (bucket.count > options.max) {
      res.setHeader("Retry-After", String(resetSeconds));
      const minutes = Math.max(1, Math.ceil(resetSeconds / 60));
      return res
        .status(429)
        .json({ error: options.message.replace("{minutes}", `${minutes} minute${minutes === 1 ? "" : "s"}`) });
    }
    next();
  };

  return Object.assign(middleware, {
    async forgive(req: Request) {
      store.clear(keyOf(req));
      if (shared()) await clearSharedRateBucket(rateBucketKey(scope, keyOf(req)));
    },
  });
}

/**
 * Password guessing is the one unauthenticated write this app exposes, so it
 * gets the tightest brake.
 */
export const loginRateLimit = rateLimit({
  windowMs: 15 * 60_000,
  max: 10,
  message: "Too many sign-in attempts. Try again in {minutes}.",
});

/**
 * The same window held against the account rather than the caller, so a botnet
 * spread across addresses still runs into a ceiling. Deliberately looser than
 * the per-address one: this is the counter an attacker can trip on somebody
 * else's behalf, and locking the real owner out of their own system is a denial
 * of service dressed as a defence.
 */
export const loginAccountRateLimit = rateLimit({
  windowMs: 15 * 60_000,
  max: 30,
  message: "Too many sign-in attempts for that account. Try again in {minutes}.",
  key: (req) => {
    const email = (req.body as { email?: unknown } | undefined)?.email;
    return `account:${String(email ?? "").trim().toLowerCase().slice(0, 120)}`;
  },
});

/** Called on a successful sign-in so a legitimate user isn't punished for typos. */
export async function clearLoginAttempts(req: Request) {
  // A cleanup outage must not reject an otherwise successful authentication.
  await Promise.allSettled([loginRateLimit.forgive(req), loginAccountRateLimit.forgive(req)]);
}

/**
 * A ceiling on the authenticated API. Not a brute-force guard — that is the
 * login limiter — but a brake on a runaway script, and on a stolen session
 * being used to walk the whole database inside a minute.
 */
export const apiRateLimit = rateLimit({
  windowMs: 60_000,
  max: 600,
  message: "Too many requests. Try again in {minutes}.",
});

/**
 * The webhook intake is public by design (routes/webhooks.ts explains why), so
 * it is the one place an anonymous caller can write rows. Generous enough for a
 * real integration replaying a backlog, tight enough that a bot cannot fill the
 * leads table through the contact form.
 */
/**
 * The public client-review pages. They answer anybody holding a link, and each
 * request reads the page it shows, so they get a ceiling of their own rather
 * than none — they are mounted above the API-wide limiter.
 */
export const publicReviewRateLimit = rateLimit({
  windowMs: 60_000,
  max: 120,
  message: "Too many requests for this review link. Try again in {minutes}.",
});

export const webhookRateLimit = rateLimit({
  windowMs: 60_000,
  max: 60,
  message: "Too many events. Try again in {minutes}.",
});
