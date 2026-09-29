import type { RequestHandler } from "express";
import { capacity } from "../lib/capacity.js";

/** Bound work before authentication reaches PostgreSQL; writes have their own allowance. */
export function createRequestAdmission(readLimit: number, writeLimit: number): RequestHandler {
  const active = { read: 0, write: 0 };
  return (req, res, next) => {
    const kind = ["GET", "HEAD", "OPTIONS"].includes(req.method) ? "read" : "write";
    const limit = kind === "read" ? readLimit : writeLimit;
    if (active[kind] >= limit) {
      res.status(503).set("Cache-Control", "private, no-store").set("Retry-After", "15")
        .json({ error: "The service is busy. Please try again shortly." });
      return;
    }
    active[kind]++;
    let released = false;
    const release = () => { if (!released) { released = true; active[kind]--; } };
    res.once("finish", release); res.once("close", release);
    next();
  };
}
const admission = createRequestAdmission(capacity.readConcurrency, capacity.writeConcurrency);
export const requestAdmission: RequestHandler = (req, res, next) => {
  if (!capacity.cache && !capacity.admission) { next(); return; }
  admission(req, res, next);
};
