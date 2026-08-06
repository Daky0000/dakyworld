import "dotenv/config";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import { clerkParser, attachUser } from "./middleware/auth.js";
import { passwordGate } from "./middleware/gate.js";
import { clientsRouter } from "./routes/clients.js";
import { leadsRouter } from "./routes/leads.js";
import { proposalsRouter } from "./routes/proposals.js";
import { projectsRouter } from "./routes/projects.js";
import { invoicesRouter } from "./routes/invoices.js";
import { usersRouter } from "./routes/users.js";
import { dashboardRouter } from "./routes/dashboard.js";
import { prisma } from "./lib/prisma.js";
import { stripe, stripeEnabled } from "./lib/stripe.js";

const app = express();
const PORT = Number(process.env.PORT ?? 4000);

// The built React client, served by this same process in production so the
// UI and the API share one origin (and one Railway service, one domain).
// Empty during local development, where Vite serves the client on :5173.
const CLIENT_DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../client/dist");
const hasBuiltClient = existsSync(path.join(CLIENT_DIST, "index.html"));

app.use(cors({ origin: process.env.CLIENT_ORIGIN ?? "http://localhost:5173", credentials: true }));

// Stripe webhook needs the raw request body for signature verification, so
// it's mounted before the global express.json() parser below.
app.post("/api/webhooks/stripe", express.raw({ type: "application/json" }), async (req, res) => {
  if (!stripeEnabled || !stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(503).send("Stripe webhook not configured");
  }
  let event;
  try {
    const signature = req.headers["stripe-signature"] as string;
    event = stripe.webhooks.constructEvent(req.body, signature, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook signature verification failed: ${(err as Error).message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as { metadata?: { invoiceId?: string } };
    const invoiceId = session.metadata?.invoiceId;
    if (invoiceId) {
      await prisma.invoice.update({ where: { id: invoiceId }, data: { status: "PAID", paidAt: new Date() } });
    }
  }
  res.json({ received: true });
});

// Everything past this point is behind the shared-password gate. The Stripe
// webhook above is deliberately outside it — Stripe can't send credentials.
app.use(passwordGate);

// The client is served ahead of the auth middleware below: attachUser does a
// database round trip per request, and static assets have no business paying
// for one. The "/api/" guard keeps API routes falling through to their routers.
if (hasBuiltClient) {
  // Hashed asset filenames are safe to cache hard; index.html must not be,
  // or browsers keep serving the previous deploy's asset references.
  app.use(express.static(CLIENT_DIST, { index: false, maxAge: "1y" }));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api/")) return next();
    res.sendFile(path.join(CLIENT_DIST, "index.html"), { headers: { "Cache-Control": "no-cache" } });
  });
}

app.use(express.json());
app.use(clerkParser);
app.use(attachUser);

app.get("/api/health", (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.use("/api/clients", clientsRouter);
app.use("/api/leads", leadsRouter);
app.use("/api/proposals", proposalsRouter);
app.use("/api/projects", projectsRouter);
app.use("/api/invoices", invoicesRouter);
app.use("/api/users", usersRouter);
app.use("/api/dashboard", dashboardRouter);

if (!hasBuiltClient) {
  // No client build present (local API-only run) — show what's running.
  app.get("/", (_req, res) => {
    res.type("html").send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Dakyworld OS API</title>
<style>body{font-family:system-ui,sans-serif;background:#0B0B0C;color:#F7F4EE;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{border:1px solid rgba(247,244,238,.15);padding:2.5rem 3rem;text-align:center}
h1{font-size:1.1rem;letter-spacing:.08em;text-transform:uppercase;margin:0 0 .5rem}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#C7A24C;margin-right:8px}
a{color:#C7A24C;text-decoration:none}</style></head>
<body><div class="card"><h1><span class="dot"></span>Dakyworld OS API — Running</h1>
<p><a href="/api/health">/api/health</a></p></div></body></html>`);
  });
}

// Central error handler — zod validation errors become 400s, everything else 500s.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  if (err && typeof err === "object" && "issues" in err) {
    return res.status(400).json({ error: "Validation failed", details: (err as { issues: unknown }).issues });
  }
  const message = err instanceof Error ? err.message : "Internal server error";
  res.status(500).json({ error: message });
});

app.listen(PORT, () => {
  console.log(`Dakyworld OS API listening on http://localhost:${PORT}`);
  console.log(hasBuiltClient ? "  → Serving the built client from client/dist" : "  → No client build found — API only");
  if (process.env.DEV_NO_AUTH === "true") {
    console.log("  → DEV_NO_AUTH=true: running as a single implicit Owner user, no real login required.");
    if (!process.env.APP_PASSWORD) {
      console.warn("  ⚠ APP_PASSWORD is not set — nothing is protecting this instance.");
    }
  }
});
