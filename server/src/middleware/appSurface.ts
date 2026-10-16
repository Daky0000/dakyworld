import type { NextFunction, Request, Response } from "express";

export type AppSurface = "os" | "editor" | "app";

/** How much of the API each surface hides; the larger number wins. app's list is a subset of editor's. */
const NARROWNESS: Record<AppSurface, number> = { os: 0, editor: 1, app: 2 };

function surfaceOfHost(value: string): AppSurface {
  const host = value.trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
  if (host === "editor.dakyx.com") return "editor";
  if (host === "app.dakyx.com") return "app";
  return "os";
}

/**
 * Which product a request is for, from the address it was sent to.
 *
 * Two headers can name that address and the caller writes both of them. The
 * edge proxy may set `X-Forwarded-Host`, so it cannot simply be ignored, but
 * reading it first — as this did — let a request to editor.dakyx.com send
 * `X-Forwarded-Host: os.dakyx.com` and walk past the gate below into leads,
 * invoices and agents. So `Host` and every entry of `X-Forwarded-Host` are each
 * read, and the narrowest surface any of them names is the answer: a forged
 * header can only ever take access away from the request that carries it.
 *
 * `req.hostname` is not used because Express fills it from `X-Forwarded-Host`
 * once `trust proxy` is on, which is the very header in question.
 */
export function appSurface(req?: Request): AppSurface {
  const value = (process.env.APP_SURFACE ?? "").trim().toLowerCase();
  if (value) {
    if (value !== "os" && value !== "editor" && value !== "app") {
      throw new Error("APP_SURFACE must be either os, editor, or app");
    }
    return value;
  }
  let surface: AppSurface = "os";
  if (req) {
    const named = [req.get("host") ?? "", ...(req.get("x-forwarded-host") ?? "").split(",")];
    for (const host of named) {
      const candidate = surfaceOfHost(host);
      if (NARROWNESS[candidate] > NARROWNESS[surface]) surface = candidate;
    }
  }
  return surface;
}

const COMMON_PUBLIC_PATHS = [
  "/api/health",
  "/api/ready",
  "/api/auth",
  // Server-to-server from the Marketing SaaS, which talks to whichever host its customers sign in at.
  "/api/partner",
  "/api/public",
  "/api/github/webhook",
  "/api/webhooks/stripe",
  "/api/webhooks/paystack",
  "/api/webhooks/hubtel",
  "/assets/dw/",
];

// Demos live on the editor too. Leads and clients stay concealed, so linking a
// demo to one of them is done from the OS.
const EDITOR_AUTHENTICATED_PATHS = ["/api/website", "/api/products", "/api/demos"];
// What the account screen reads: the sites list, and the plan with its usage.
const APP_AUTHENTICATED_PATHS = ["/api/products", "/api/website/tier-plans", "/api/website/tier-status", "/api/website/sites"];

function matches(path: string, allowed: string): boolean {
  return path === allowed || path.startsWith(allowed.endsWith("/") ? allowed : `${allowed}/`);
}

export function editorPublicSurfaceGate(req: Request, res: Response, next: NextFunction) {
  const surface = appSurface(req);
  if (surface === "os" || (!req.path.startsWith("/api/") && !req.path.startsWith("/assets/dw/"))) return next();
  
  if (COMMON_PUBLIC_PATHS.some(path => matches(req.path, path))) return next();

  if (surface === "editor") {
    if (EDITOR_AUTHENTICATED_PATHS.some(path => matches(req.path, path))) return next();
    return res.status(404).json({ error: "Not found" });
  }

  if (surface === "app") {
    if (APP_AUTHENTICATED_PATHS.some(path => matches(req.path, path))) return next();
    return res.status(404).json({ error: "Not found" });
  }

  return res.status(404).json({ error: "Not found" });
}

export const editorAllowedApiPrefixes = Object.freeze([...COMMON_PUBLIC_PATHS, ...EDITOR_AUTHENTICATED_PATHS]);
export const appAllowedApiPrefixes = Object.freeze([...COMMON_PUBLIC_PATHS, ...APP_AUTHENTICATED_PATHS]);
