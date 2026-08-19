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
 */
export function forceHttps(req: Request, res: Response, next: NextFunction) {
  if (!isProduction()) return next();
  // req.secure is only meaningful with `trust proxy` set; index.ts sets it.
  if (req.secure) return next();
  if (req.method !== "GET" && req.method !== "HEAD") {
    return res.status(403).json({ error: "HTTPS is required." });
  }
  return res.redirect(308, `https://${req.headers.host}${req.originalUrl}`);
}

// --- Rate limiting -----------------------------------------------------------

/**
 * In memory on purpose: this runs as a single Railway service, and a Redis
 * dependency to slow down a brute force on one login form is the wrong trade.
 * If a second instance ever appears this weakens rather than breaks — each
 * instance still enforces its own ceiling.
 */
interface Bucket {
  count: number;
  resetAt: number;
}

const SWEEP_AT = 5000;

function makeStore() {
  const hits = new Map<string, Bucket>();
  return {
    /** Counts this request and returns the bucket it landed in. */
    take(key: string, windowMs: number): Bucket {
      const now = Date.now();
      const seen = hits.get(key);
      if (!seen || seen.resetAt <= now) {
        const fresh = { count: 1, resetAt: now + windowMs };
        hits.set(key, fresh);
        // Cheap sweep so a long uptime can't grow this map without bound.
        if (hits.size > SWEEP_AT) for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
        return fresh;
      }
      seen.count += 1;
      return seen;
    },
    clear(key: string) {
      hits.delete(key);
    },
  };
}

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
  const store = makeStore();
  const keyOf = options.key ?? clientIp;

  const middleware = (req: Request, res: Response, next: NextFunction) => {
    const bucket = store.take(keyOf(req), options.windowMs);
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
    forgive(req: Request) {
      store.clear(keyOf(req));
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
export function clearLoginAttempts(req: Request) {
  loginRateLimit.forgive(req);
  loginAccountRateLimit.forgive(req);
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
export const webhookRateLimit = rateLimit({
  windowMs: 60_000,
  max: 60,
  message: "Too many events. Try again in {minutes}.",
});
