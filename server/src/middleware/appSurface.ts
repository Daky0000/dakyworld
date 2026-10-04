import type { NextFunction, Request, Response } from "express";

export type AppSurface = "os" | "editor";

export function appSurface(): AppSurface {
  const value = (process.env.APP_SURFACE ?? "os").trim().toLowerCase();
  if (value !== "os" && value !== "editor") {
    throw new Error("APP_SURFACE must be either os or editor");
  }
  return value;
}

const EDITOR_PUBLIC_PATHS = [
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

function matches(path: string, allowed: string): boolean {
  return path === allowed || path.startsWith(allowed.endsWith("/") ? allowed : `${allowed}/`);
}

export function editorPublicSurfaceGate(req: Request, res: Response, next: NextFunction) {
  if (appSurface() !== "editor" || (!req.path.startsWith("/api/") && !req.path.startsWith("/assets/dw/"))) return next();
  if (EDITOR_PUBLIC_PATHS.some(path => matches(req.path, path))) return next();
  if (EDITOR_AUTHENTICATED_PATHS.some(path => matches(req.path, path))) return next();
  return res.status(404).json({ error: "Not found" });
}

export const editorAllowedApiPrefixes = Object.freeze([...EDITOR_PUBLIC_PATHS, ...EDITOR_AUTHENTICATED_PATHS]);
