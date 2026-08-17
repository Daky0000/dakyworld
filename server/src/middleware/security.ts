import type { NextFunction, Request, Response } from "express";

/**
 * Headers the browser enforces for us, and a brake on password guessing.
 *
 * Hand-written rather than pulled from helmet: the set that actually matters
 * here is five headers, and a dependency that ships a Content-Security-Policy
 * by default would break the client's inline styles on the first deploy —
 * which is exactly the kind of security change that gets reverted and never
 * put back. CSP is worth doing properly and separately.
 */
export function securityHeaders(req: Request, res: Response, next: NextFunction) {
  // Railway terminates TLS in front of us, so tell the browser never to try
  // plain HTTP again. Only in production: this header on localhost would make
  // http://localhost unreachable in that browser for a year.
  if (process.env.NODE_ENV === "production") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  next();
}

/**
 * Password guessing is the one unauthenticated write this app exposes, so it
 * is the one that needs a brake.
 *
 * In memory on purpose: this runs as a single Railway service, and a Redis
 * dependency to slow down a brute force on one login form is the wrong trade.
 * If a second instance ever appears this weakens rather than breaks — each
 * instance still enforces its own ceiling.
 */
const WINDOW_MS = 15 * 60_000;
const MAX_ATTEMPTS = 10;
const attempts = new Map<string, { count: number; resetAt: number }>();

export function loginRateLimit(req: Request, res: Response, next: NextFunction) {
  const now = Date.now();
  // Railway sits in front of us, so the socket address is the proxy's.
  const forwarded = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim();
  const key = forwarded || req.socket.remoteAddress || "unknown";

  const seen = attempts.get(key);
  if (!seen || seen.resetAt < now) {
    attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
    // Cheap sweep so a long uptime can't grow this map without bound.
    if (attempts.size > 5000) for (const [k, v] of attempts) if (v.resetAt < now) attempts.delete(k);
    return next();
  }

  seen.count += 1;
  if (seen.count > MAX_ATTEMPTS) {
    const minutes = Math.max(1, Math.ceil((seen.resetAt - now) / 60_000));
    res.setHeader("Retry-After", String(Math.ceil((seen.resetAt - now) / 1000)));
    return res.status(429).json({ error: `Too many sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.` });
  }
  next();
}

/** Called on a successful sign-in so a legitimate user isn't punished. */
export function clearLoginAttempts(req: Request) {
  const forwarded = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim();
  attempts.delete(forwarded || req.socket.remoteAddress || "unknown");
}
