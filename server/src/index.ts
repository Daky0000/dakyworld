import "dotenv/config";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import { attachUser, bootstrapOwner, requireAuth, DEV_NO_AUTH } from "./middleware/auth.js";
import { authRouter } from "./routes/auth.js";
import { clientsRouter } from "./routes/clients.js";
import { leadsRouter } from "./routes/leads.js";
import { importsRouter } from "./routes/imports.js";
import { proposalsRouter } from "./routes/proposals.js";
import { projectsRouter } from "./routes/projects.js";
import { invoicesRouter } from "./routes/invoices.js";
import { carePlansRouter } from "./routes/carePlans.js";
import { emailsRouter, unsubscribeRouter } from "./routes/emails.js";
import { usersRouter } from "./routes/users.js";
import { dashboardRouter } from "./routes/dashboard.js";
import { scrapersRouter } from "./routes/scrapers.js";
import { settingsRouter } from "./routes/settings.js";
import { prisma } from "./lib/prisma.js";
import { getStripe, stripeWebhookSecret } from "./lib/stripe.js";
import { startScheduler } from "./services/scheduler.js";
import { ensureBuiltinTemplates } from "./services/emailTemplates.js";

const app = express();
const PORT = Number(process.env.PORT ?? 4000);

// The built React client, served by this same process in production so the
// UI and the API share one origin (and one Railway service, one domain).
// Empty during local development, where Vite serves the client on :5173.
//
// The client lives under server/ because Railway's Root Directory for this
// service is `server`, which is the whole build context — a sibling folder at
// the repo root is simply not present at build time. From server/dist/ that
// makes the built client ../client/dist.
const CLIENT_DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../client/dist");
const hasBuiltClient = existsSync(path.join(CLIENT_DIST, "index.html"));

app.use(cors({ origin: process.env.CLIENT_ORIGIN ?? "http://localhost:5173", credentials: true }));

// Stripe webhook needs the raw request body for signature verification, so
// it's mounted before the global express.json() parser below.
app.post("/api/webhooks/stripe", express.raw({ type: "application/json" }), async (req, res) => {
  const stripe = await getStripe();
  const webhookSecret = await stripeWebhookSecret();
  if (!stripe || !webhookSecret) {
    return res.status(503).send("Stripe webhook not configured");
  }
  let event;
  try {
    const signature = req.headers["stripe-signature"] as string;
    event = stripe.webhooks.constructEvent(req.body, signature, webhookSecret);
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

// A spreadsheet arrives base64-encoded inside the JSON body, so the import
// routes need a far bigger ceiling than the rest of the API. Their parser is
// mounted inside the imports router, behind requireAuth and an Owner check, so
// an anonymous request can't push 28 MB at us — which means the global parser
// has to leave those paths alone rather than rejecting them at 100 kB first.
const jsonParser = express.json();
app.use((req, res, next) => (req.path.startsWith("/api/imports") ? next() : jsonParser(req, res, next)));

// Public: Railway's healthcheck runs before anyone has logged in.
app.get("/api/health", (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// Also public, and deliberately so: an unsubscribe link that needs a login is
// not an unsubscribe link. Every cold email this app sends carries one.
app.use("/api/emails", unsubscribeRouter);

// Resolves the session cookie but never rejects — /api/auth/login has to stay
// reachable without one. requireAuth below is what actually closes the door.
app.use(attachUser);
app.use("/api/auth", authRouter);
app.use("/api", requireAuth);

app.use("/api/clients", clientsRouter);
app.use("/api/leads", leadsRouter);
app.use("/api/imports", importsRouter);
app.use("/api/proposals", proposalsRouter);
app.use("/api/projects", projectsRouter);
app.use("/api/invoices", invoicesRouter);
app.use("/api/care-plans", carePlansRouter);
app.use("/api/emails", emailsRouter);
app.use("/api/users", usersRouter);
app.use("/api/dashboard", dashboardRouter);
app.use("/api/scrapers", scrapersRouter);
app.use("/api/settings", settingsRouter);

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

// Runs before the port opens, so the first request can't beat the Owner into
// existence. A failure here shouldn't take the whole API down — the rest of
// the app works, and the cause is on stdout.
bootstrapOwner()
  .catch((err) => console.error("Owner bootstrap failed:", err))
  .finally(() => {
    app.listen(PORT, () => {
      console.log(`Dakyworld OS API listening on http://localhost:${PORT}`);
      console.log(hasBuiltClient ? "  → Serving the built client from client/dist" : "  → No client build found — API only");
      // Daily lead capture, monthly billing, and outbound email. Harmless with
      // nothing configured: it finds nothing due and goes back to sleep.
      startScheduler();
      // The letters that ship with the app, copied in once so they can be
      // edited. Failing here must not take the API down.
      void ensureBuiltinTemplates().catch((err) => console.error("Template seed failed:", err));
      if (DEV_NO_AUTH) {
        console.log("  → DEV_NO_AUTH=true: implicit Owner, no login required (ignored when NODE_ENV=production).");
      } else if (!process.env.OWNER_EMAIL || !process.env.OWNER_PASSWORD) {
        console.warn("  ⚠ OWNER_EMAIL / OWNER_PASSWORD are not set — no way to create the first account.");
      }
    });
  });
