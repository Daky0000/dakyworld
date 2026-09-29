import assert from "node:assert/strict";
import express from "express";
const database = new URL(process.env.DATABASE_URL ?? "");
assert.ok(["localhost", "127.0.0.1"].includes(database.hostname) && database.pathname.includes("capacity_load"));
assert.notEqual(process.env.NODE_ENV, "production");
process.env.DEV_NO_AUTH = "false";
process.env.OPENAI_API_KEY = "local-stub-only";
process.env.OPENAI_MODEL = "gpt-4o-mini";
const vendor = express(); vendor.use(express.json({ limit: "2mb" }));
let mockStatus = 0; let mockCalls = 0;
vendor.post("/v1/chat/completions", (_req, res) => {
  mockCalls++;
  if (mockStatus) { res.status(mockStatus).json({ error: { message: "Local provider failure fixture" } }); return; }
  setTimeout(() => res.json({ choices: [{ message: { role: "assistant", content: JSON.stringify({ explanation: "No change needed.", changes: [] }) }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 20 } }), Number(process.env.LOAD_MODEL_DELAY_MS ?? 1000));
});
const vendorServer = vendor.listen(0, "127.0.0.1");
await new Promise<void>(resolve => vendorServer.once("listening", resolve));
process.env.OPENAI_BASE_URL = `http://127.0.0.1:${(vendorServer.address() as import("node:net").AddressInfo).port}/v1`;
const { attachUser, requireAuth, scopeExternal } = await import("../src/middleware/auth.js");
const { websiteRouter } = await import("../src/routes/website.js");
const { errorHandler } = await import("../src/middleware/errorHandler.js");
const { measureRequests, performanceSnapshot } = await import("../src/middleware/performance.js");
const { requestCacheContext } = await import("../src/lib/requestCache.js");
const { startLocalInvalidations, invalidateAfterWrite, deliverInvalidations } = await import("../src/services/cacheInvalidation.js");
const { startWebsiteWorkQueue } = await import("../src/services/websiteWorkQueue.js");
const { setSetting, SETTING } = await import("../src/lib/settings.js");
const { prisma } = await import("../src/lib/prisma.js");
const { requestAdmission } = await import("../src/middleware/requestAdmission.js");
await setSetting(SETTING.OPENAI_KEY, "local-stub-only");
const app = express();
const startedAt = new Date();
app.use(express.json({ limit: "2mb" }));
app.use(measureRequests, requestCacheContext, invalidateAfterWrite);
app.use((_req, res, next) => { res.set("Cache-Control", "private, no-store"); next(); });
app.get("/metrics", async (_req, res, next) => {
  try {
    const jobs = await prisma.websiteWorkJob.groupBy({ by: ["state"], where: { createdAt: { gte: startedAt } }, _count: true });
    res.json({ ...performanceSnapshot(), mockCalls, jobs });
  } catch (error) { next(error); }
});
app.post("/stub-control", (req, res) => {
  const status = Number(req.body.status ?? 0);
  if (![0, 429, 500, 503].includes(status)) { res.status(400).end(); return; }
  mockStatus = status; res.json({ status, mockCalls });
});
app.use("/api", requestAdmission, attachUser, requireAuth, scopeExternal);
app.use("/api/website", websiteRouter);
app.use(errorHandler);
startLocalInvalidations();
setInterval(() => { void deliverInvalidations().catch(() => undefined); }, 1000).unref();
if (process.env.JOB_ADMISSION_ENABLED === "true") startWebsiteWorkQueue();
app.listen(Number(process.env.PORT ?? 4009), "127.0.0.1", () => console.log("Isolated load server ready; provider calls target the local stub."));
