import { AsyncLocalStorage } from "node:async_hooks";
import type { RequestHandler } from "express";
const context = new AsyncLocalStorage<boolean>();
export const bypassRequestCache = () => context.getStore() === true;
export const requestCacheContext: RequestHandler = (req, _res, next) => {
  context.run(req.get("X-DW-Cache-Bypass") === "1" || !["GET", "HEAD"].includes(req.method), next);
};
