import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

const APP_PASSWORD = process.env.APP_PASSWORD ?? "";
const DEV_NO_AUTH = process.env.DEV_NO_AUTH === "true";
const IS_PRODUCTION = process.env.NODE_ENV === "production";

/**
 * Paths that must stay reachable without a password:
 * Stripe can't send credentials with its webhook calls, and Railway's
 * healthcheck hits /api/health before any human is involved.
 */
const OPEN_PATHS = new Set(["/api/health", "/api/webhooks/stripe"]);

/** Constant-time compare that doesn't leak length through early return. */
function passwordMatches(candidate: string): boolean {
  const a = Buffer.from(candidate);
  const b = Buffer.from(APP_PASSWORD);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function unauthorized(res: Response) {
  res.set("WWW-Authenticate", 'Basic realm="Dakyworld OS", charset="UTF-8"');
  res.status(401).type("text/plain").send("Authentication required.");
}

/**
 * Shared-password gate over the whole app, as a stopgap until Clerk is wired
 * up. Active whenever APP_PASSWORD is set.
 *
 * In production without Clerk, this is the *only* thing standing between the
 * public internet and the full CRM — DEV_NO_AUTH resolves every request to an
 * implicit Owner. So if neither is configured, we fail closed and serve setup
 * instructions rather than the app.
 */
export function passwordGate(req: Request, res: Response, next: NextFunction) {
  if (OPEN_PATHS.has(req.path)) return next();

  if (!APP_PASSWORD) {
    if (IS_PRODUCTION && DEV_NO_AUTH) {
      return res.status(503).type("html").send(setupRequiredPage());
    }
    return next(); // local development: no password, no gate
  }

  const header = req.get("authorization") ?? "";
  if (!header.startsWith("Basic ")) return unauthorized(res);

  const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
  const password = decoded.slice(decoded.indexOf(":") + 1); // any username, password is what matters
  if (!passwordMatches(password)) return unauthorized(res);

  next();
}

/** Shown in production when the app has no protection configured at all. */
function setupRequiredPage() {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Dakyworld OS — setup required</title>
<style>body{font-family:system-ui,sans-serif;background:#0B0B0C;color:#F7F4EE;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:1.5rem}
.card{border:1px solid rgba(247,244,238,.15);padding:2.5rem 3rem;max-width:34rem}
h1{font-size:1.1rem;letter-spacing:.08em;text-transform:uppercase;margin:0 0 1rem}
p{line-height:1.6;color:rgba(247,244,238,.75)}
code{color:#C7A24C;background:rgba(199,162,76,.1);padding:.15em .4em}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#C7A24C;margin-right:8px}</style></head>
<body><div class="card"><h1><span class="dot"></span>Setup required</h1>
<p>Dakyworld OS is deployed but has no access protection configured, so it
won't serve the app. Every request would otherwise resolve to a full Owner
account.</p>
<p>Set <code>APP_PASSWORD</code> in the Railway service variables to enable the
shared-password gate, or configure Clerk and set
<code>DEV_NO_AUTH=false</code> for real accounts.</p>
</div></body></html>`;
}
