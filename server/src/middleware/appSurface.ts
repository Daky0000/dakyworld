import type { NextFunction, Request, Response } from "express";

export type AppSurface = "os" | "editor" | "app";

export function appSurface(req?: Request): AppSurface {
  const value = (process.env.APP_SURFACE ?? "").trim().toLowerCase();
  if (value) {
    if (value !== "os" && value !== "editor" && value !== "app") {
      throw new Error("APP_SURFACE must be either os, editor, or app");
    }
    return value;
  }
  if (req) {
    const host = (req.hostname || req.get("host") || "").toLowerCase().split(":")[0];
    if (host === "editor.dakyx.com") return "editor";
    if (host === "app.dakyx.com") return "app";
  }
  return "os";
}

const COMMON_PUBLIC_PATHS = [
  "/api/health",
  "/api/ready",
  "/api/auth",
  "/api/public",
  "/api/github/webhook",
  "/api/webhooks/stripe",
  "/api/webhooks/paystack",
  "/api/webhooks/hubtel",
  "/assets/dw/",
];

const EDITOR_AUTHENTICATED_PATHS = ["/api/website", "/api/products"];
const APP_AUTHENTICATED_PATHS = ["/api/products", "/api/website/tier-plans", "/api/website/sites"];

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
