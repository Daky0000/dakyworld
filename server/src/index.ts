import "dotenv/config";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import { attachUser, bootstrapOwner, requireAuth, scopeExternal, DEV_NO_AUTH, DEV_NO_AUTH_REFUSED } from "./middleware/auth.js";
import { ensureSystemRoles } from "./lib/accessRoles.js";
import { authRouter } from "./routes/auth.js";
import { clientsRouter } from "./routes/clients.js";
import { leadsRouter } from "./routes/leads.js";
import { importsRouter } from "./routes/imports.js";
import { proposalsRouter } from "./routes/proposals.js";
import { projectsRouter } from "./routes/projects.js";
import { invoicesRouter } from "./routes/invoices.js";
import { carePlansRouter } from "./routes/carePlans.js";
import { emailsRouter, unsubscribeRouter } from "./routes/emails.js";
import { inboxRouter } from "./routes/inbox.js";
import { hubtelWebhook, paystackWebhook } from "./routes/paymentWebhooks.js";
import { webhooksRouter } from "./routes/webhooks.js";
import { slackRouter } from "./routes/slack.js";
import { messagingRouter } from "./routes/messaging.js";
import { messagesRouter } from "./routes/messages.js";
import { usersRouter } from "./routes/users.js";
import { accessRouter } from "./routes/access.js";
import { dashboardRouter } from "./routes/dashboard.js";
import { scrapersRouter } from "./routes/scrapers.js";
import { agentsRouter } from "./routes/agents.js";
import { rehearsalsRouter } from "./routes/rehearsals.js";
import { captureRouter } from "./routes/capture.js";
import { toolsRouter } from "./routes/tools.js";
import { costsRouter } from "./routes/costs.js";
import { approvalsRouter } from "./routes/approvals.js";
import { contextRouter } from "./routes/context.js";
import { mcpRouter } from "./routes/mcp.js";
import { apiRateLimit, forceHttps, securityHeaders, webhookRateLimit } from "./middleware/security.js";
import { settingsRouter } from "./routes/settings.js";
import { prisma } from "./lib/prisma.js";
import { SETTING } from "./lib/settings.js";
import { getStripe, stripeWebhookSecret } from "./lib/stripe.js";
import { demosRouter, demoPagesRouter } from "./routes/demos.js";
import { auditsRouter } from "./routes/audits.js";
import { startScheduler } from "./services/scheduler.js";
import { ensureBuiltinTemplates } from "./services/emailTemplates.js";
import { applyColdEmailPlaybook, applyOutreachDoctrine, ensureAgents, narrowSeededAgents, refreshUneditedSeedPrompts } from "./services/agentRegistry.js";
import { drainRunningTasks } from "./services/agents/runner.js";
import { backfillTags } from "./services/leadTags.js";
import { startWatcher, stopWatcher } from "./services/mailbox/watcher.js";
import { AnalystError } from "./lib/claude.js";
import { ApifyError } from "./lib/apify.js";
import { WhatsAppError } from "./lib/whatsapp.js";
import { HubtelError } from "./lib/hubtel.js";
import { MessagingError } from "./services/messageSender.js";
import { BudgetExceeded } from "./services/budgets.js";

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

// Railway terminates TLS and rewrites the host one hop in front of us. Without
// this, `req.ip` is the proxy's address and `req.secure` is always false — so
// every rate limiter would share one bucket and the HTTPS check would redirect
// forever. A hop *count* rather than `true`: trusting the whole chain means
// trusting whatever the caller put at the front of X-Forwarded-For, which is
// how a per-IP limiter becomes a per-request one.
app.set("trust proxy", 1);
app.disable("x-powered-by");

app.use(forceHttps);

// In production the client is served from this same origin, so nothing needs a
// cross-origin grant at all and the safe answer is to issue none. Locally, Vite
// on :5173 does. Handing out `credentials: true` against a default of
// localhost:5173 on the live system would be a standing offer nobody needs.
const CORS_ORIGIN = process.env.CLIENT_ORIGIN ?? (process.env.NODE_ENV === "production" ? null : "http://localhost:5173");
if (CORS_ORIGIN) app.use(cors({ origin: CORS_ORIGIN, credentials: true }));

app.use(securityHeaders);

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

// Paystack and Hubtel, above the generic handler below because each verifies
// its own way — Paystack signs with HMAC-SHA512 over the raw body keyed by the
// secret key, and Hubtel signs nothing at all — and neither fits the shared
// secret the generic route uses. Registered as exact paths so they win over
// `/api/webhooks/:source`, which would otherwise swallow both.
app.post("/api/webhooks/paystack", webhookRateLimit, express.raw({ type: "*/*", limit: "256kb" }), paystackWebhook);
app.post("/api/webhooks/hubtel", webhookRateLimit, express.raw({ type: "*/*", limit: "256kb" }), hubtelWebhook);

// Everything that isn't Stripe comes in here, and for the same reason it sits
// above the JSON parser: the signature covers the exact bytes that were sent,
// so the body has to arrive raw. Public by design — a contact form on a static
// site cannot log in. routes/webhooks.ts explains what guards it instead.
app.use("/api/webhooks", webhookRateLimit, express.raw({ type: "*/*", limit: "256kb" }), webhooksRouter);

// Slack pressing a button, and the /dakyworld slash command. Above the JSON
// parser for the same reason as the two routes above it — Slack signs the
// exact bytes it sent, and a parsed-and-restringified body is not those bytes.
// Public, because Slack cannot log in; what guards it is the signing secret,
// and with none configured it refuses everything. See routes/slack.ts.
app.use("/api/slack", webhookRateLimit, express.raw({ type: "*/*", limit: "128kb" }), slackRouter);

// Replies on WhatsApp and SMS, and the delivery receipts for both. Above the
// JSON parser for the third time on this page and for the same reason: Meta
// signs the exact bytes it sent. Public, because neither Meta nor Hubtel can
// log in — what guards each is in routes/messaging.ts, and it matters more
// here than on the generic webhook route, because an unverified inbound would
// open a 24-hour free-form window or opt a live prospect out.
app.use("/api/messaging", webhookRateLimit, express.raw({ type: "*/*", limit: "128kb" }), messagingRouter);

// A prospect's demo page, to whoever holds the link. Mounted here for two
// reasons: it is public — the whole point is that it can be opened from an
// email — and it has to come before the SPA catch-all below, which would
// otherwise answer /demos/<slug> with the React app.
//
// `/demos` on its own has no route here and falls through to the app, which is
// deliberate: the individual pages are unlisted-but-public, and the list of
// every business Dakyworld is pitching to stays behind the login.
app.use("/demos", demoPagesRouter);

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

// A spreadsheet, a logo and an email attachment all arrive base64-encoded
// inside the JSON body, so those routes need a far bigger ceiling than the
// rest of the API. Each mounts its own parser inside its router, behind
// requireAuth and a role check, so an anonymous request can't push 28 MB at
// us — which means the global parser has to leave those paths alone rather
// than rejecting them at 100 kB first.
const UPLOAD_PATHS = ["/api/imports", "/api/settings/system/brand", "/api/emails/attachments"];
const jsonParser = express.json();
app.use((req, res, next) =>
  UPLOAD_PATHS.some((prefix) => req.path.startsWith(prefix)) ? next() : jsonParser(req, res, next),
);

// Public: Railway's healthcheck runs before anyone has logged in.
app.get("/api/health", (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// Also public, and deliberately so: an unsubscribe link that needs a login is
// not an unsubscribe link. Every cold email this app sends carries one.
app.use("/api/emails", unsubscribeRouter);

// A ceiling on everything under /api. Above attachUser on purpose: a request
// that is going to be refused should be refused before it costs a database
// round trip.
app.use("/api", apiRateLimit);

// Resolves the session cookie but never rejects — /api/auth/login has to stay
// reachable without one. requireAuth below is what actually closes the door.
app.use(attachUser);
app.use("/api/auth", authRouter);
app.use("/api", requireAuth);
// Signed in is not the same as "belongs in here" — see scopeExternal.
app.use("/api", scopeExternal);

app.use("/api/clients", clientsRouter);
app.use("/api/leads", leadsRouter);
app.use("/api/imports", importsRouter);
app.use("/api/proposals", proposalsRouter);
app.use("/api/projects", projectsRouter);
app.use("/api/invoices", invoicesRouter);
app.use("/api/care-plans", carePlansRouter);
app.use("/api/emails", emailsRouter);
// The other half of the door. Beside the outbox rather than inside it — see routes/inbox.ts.
app.use("/api/inbox", inboxRouter);
app.use("/api/messages", messagesRouter);
app.use("/api/users", usersRouter);
app.use("/api/access", accessRouter);
app.use("/api/dashboard", dashboardRouter);
app.use("/api/scrapers", scrapersRouter);
app.use("/api/agents", agentsRouter);
// One workflow, one real website, nothing able to leave the building. Beside
// the workforce rather than inside it: it is about all of them at once.
app.use("/api/rehearsals", rehearsalsRouter);
app.use("/api/capture", captureRouter);
app.use("/api/demos", demosRouter);
app.use("/api/audits", auditsRouter);
app.use("/api/tools", toolsRouter);
app.use("/api/costs", costsRouter);
app.use("/api/approvals", approvalsRouter);
app.use("/api/context", contextRouter);
app.use("/api/mcp", mcpRouter);
app.use("/api/settings", settingsRouter);

if (!hasBuiltClient) {
  // No client build present (local API-only run) — show what's running.
  app.get("/", (_req, res) => {
    res.type("html").send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Dakyworld OS API</title>
<style>body{font-family:"DM Sans",system-ui,sans-serif;background:#08101F;color:#F4F5F0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{border:1px solid rgba(255,255,255,.10);padding:2.5rem 3rem;text-align:center}
h1{font-size:1.1rem;letter-spacing:.08em;text-transform:uppercase;margin:0 0 .5rem}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#B8FF3D;margin-right:8px}
a{color:#B8FF3D;text-decoration:none}</style></head>
<body><div class="card"><h1><span class="dot"></span>Dakyworld OS API — Running</h1>
<p><a href="/api/health">/api/health</a></p></div></body></html>`);
  });
}

// Central error handler — zod validation errors become 400s, everything else 500s.
//
// The 500 body is deliberately uninformative in production. It used to return
// `err.message`, which is whatever threw: a Prisma failure names the table and
// the constraint, a fetch failure names the internal host, and a stack-shaped
// message names the file layout. All of that is a map of the system handed to
// whoever caused the error. The real message is on stdout, where Railway keeps
// it, and the reference ties the two together so a user reporting "it said
// something went wrong" can be traced to the exact log line.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const reference = Math.random().toString(36).slice(2, 10);
  console.error(`[${reference}]`, err);

  if (err && typeof err === "object" && "issues" in err) {
    return res.status(400).json({ error: "Validation failed", details: (err as { issues: unknown }).issues });
  }

  // The exceptions to the rule above, and the reason the rule needed one.
  //
  // "Add a ChatGPT key under Settings -> AI models" is not a leak, it is the
  // answer. These two classes are the only ones in the app whose message is
  // *written for the person reading it* — they are raised deliberately, at a
  // known point, with a sentence somebody composed. Everything else that
  // reaches here is an accident, and an accident's message is a map of the
  // system.
  //
  // This mattered: building a demo with no model connected threw a 503 saying
  // exactly what to do about it, and the Owner was shown "Something went
  // wrong." A useless sentence about a fixable problem sends somebody looking
  // for a bug that was never there.
  if (err instanceof AnalystError) {
    return res.status(err.status).json({ error: err.message, reference });
  }
  if (err instanceof ApifyError) {
    return res.status(503).json({ error: err.message, reference });
  }

  // The messaging classes belong in the same exemption and for the same
  // reason. "They haven't messaged us in 24 hours, so WhatsApp will only carry
  // an approved template" is the answer, not a leak — and rendered as
  // "Something went wrong." it sends somebody hunting for a bug in an app that
  // is working exactly as Meta requires.
  if (err instanceof WhatsAppError || err instanceof HubtelError || err instanceof MessagingError) {
    return res.status(err.status).json({ error: err.message, reference });
  }

  // A spend ceiling is the clearest case of all: it is a number the Owner typed
  // in, doing exactly what they asked it to. 402 rather than 500, and the
  // sentence names the scope, what it has spent and what it was allowed —
  // everything needed to decide between raising it and leaving it alone.
  if (err instanceof BudgetExceeded) {
    return res.status(402).json({ error: err.message, budget: err.state, reference });
  }

  if (process.env.NODE_ENV === "production") {
    return res.status(500).json({ error: "Something went wrong.", reference });
  }
  res.status(500).json({ error: err instanceof Error ? err.message : "Internal server error", reference });
});

// Runs before the port opens, so the first request can't beat the Owner into
// existence. A failure here shouldn't take the whole API down — the rest of
// the app works, and the cause is on stdout.
// Roles first, and strictly first: `bootstrapOwner` pins the Owner account to
// the Owner *role*, and every permission check reads a role off the user row.
// A boot that opened the port before this would answer the first few requests
// as though nobody had any access at all — which fails closed, but reads to
// whoever is holding the browser as a system that has forgotten them.
ensureSystemRoles()
  .catch((err) => console.error("Role seed failed:", err))
  .then(() => bootstrapOwner())
  .catch((err) => console.error("Owner bootstrap failed:", err))
  .finally(() => {
    const server = app.listen(PORT, () => {
      console.log(`Dakyworld OS API listening on http://localhost:${PORT}`);
      console.log(hasBuiltClient ? "  → Serving the built client from client/dist" : "  → No client build found — API only");
      // Daily lead capture, monthly billing, and outbound email. Harmless with
      // nothing configured: it finds nothing due and goes back to sleep.
      startScheduler();
      // The letters that ship with the app, copied in once so they can be
      // edited. Failing here must not take the API down.
      void ensureBuiltinTemplates().catch((err) => console.error("Template seed failed:", err));
      // Adds agents that don't exist yet; never overwrites one the Owner has changed.
      void ensureAgents()
        .then(async (added) => {
          if (added) console.log(`  → Seeded ${added} agent(s) into the workforce`);
          // The other half of the one-job split: the new agents arrive above,
          // and this narrows the ones they were carved out of. Runs once ever.
          // The Cold Email Playbook v3 wording, onto the two agents that
          // write outreach. Runs once; skips a prompt the Owner has rewritten.
          const playbook = await applyColdEmailPlaybook();
          if (playbook?.updated.length) {
            console.log(`  → Cold Email Playbook v3 applied to ${playbook.updated.join(", ")}`);
          }
          if (playbook?.keptAsEdited.length) {
            console.log(`  → Playbook not applied to ${playbook.keptAsEdited.join(", ")} — you have rewritten those prompts.`);
          }

          // Everything the Owner has not rewritten, kept in step with the
          // seed. This is the general mechanism; the two marked passes above
          // are history, already run, and left in place so a database that has
          // not seen them still gets them in the right order.
          const refreshed = await refreshUneditedSeedPrompts();
          if (refreshed.updated.length) {
            console.log(`  → Updated ${refreshed.updated.length} agent prompt(s) you have not rewritten: ${refreshed.updated.join(", ")}`);
          }
          // The other half, which was silent and should never have been.
          //
          // An agent whose prompt the Owner has rewritten is skipped for ever
          // after — that is the contract and it is right — but the *absence* of
          // a name from the line above is the only way anybody could tell, and
          // nobody reads a boot log for what is missing from it. So a shipped
          // doctrine can be rewritten, deployed, verified against the seed and
          // still not be what the agent runs on, with every screen agreeing
          // that it was. That is this codebase's oldest defect wearing yet
          // another hat: the prompt being edited is not the prompt being run.
          if (refreshed.keptAsEdited.length) {
            console.log(
              `  → Left alone — your own wording is in charge of ${refreshed.keptAsEdited.length} agent(s): ${refreshed.keptAsEdited.join(", ")}. ` +
                `A shipped doctrine change does NOT reach these; reset one on the Agents screen to hand it back.`,
            );
          }

          // The one pass that overrides the Owner's own wording, and only on
          // the two outreach agents. Runs after the refresh above so that what
          // it hands back is the seed as this deploy states it. See the note on
          // `applyOutreachDoctrine` for why this one is allowed to.
          const handback = await applyOutreachDoctrine();
          if (handback?.updated.length) {
            console.log(`  → Outreach doctrine applied to ${handback.updated.join(", ")}`);
          }
          if (handback?.overrode.length) {
            console.log(
              `  → Overrode your own wording on ${handback.overrode.join(", ")} — you asked for the cold email playbook to be removed entirely. ` +
                `The replaced wording is kept verbatim in the "${SETTING.AGENT_OUTREACH_PRIOR}" setting.`,
            );
          }

          const narrowed = await narrowSeededAgents();
          if (!narrowed) return;
          if (narrowed.updated.length) {
            console.log(`  → Narrowed ${narrowed.updated.length} agent(s) to one job each: ${narrowed.updated.join(", ")}`);
          }
          if (narrowed.keptAsEdited.length) {
            console.log(`  → Left alone because you have rewritten their prompts: ${narrowed.keptAsEdited.join(", ")}`);
          }
          for (const surplus of narrowed.surplusTools) {
            console.log(
              `  → ${surplus.name} still holds ${surplus.tools.join(", ")} — its narrowed job has no use for those. Untick them on the Agents screen if you agree.`,
            );
          }
        })
        .catch((err) => console.error("Agent seed failed:", err));
      // Every tag written into a lead before the registry existed. Without
      // this the Tags screen opens empty on a database full of tagged leads.
      void backfillTags()
        .then((added) => added && console.log(`  → Registered ${added} tag(s) already in use`))
        .catch((err) => console.error("Tag backfill failed:", err));
      // Sits in IMAP IDLE on the inbox so a reply is read in seconds rather
      // than on the next minute tick. Silent when no mailbox is connected, and
      // the tick reads the mailbox anyway — this is an optimisation over a
      // poll that runs regardless, never the only path.
      void startWatcher().catch((err) => console.error("Mailbox watcher failed to start:", err));
      if (DEV_NO_AUTH_REFUSED) {
        // Said loudly, because a variable that is set and silently ignored is
        // one somebody believes is doing something. It is doing nothing, and
        // the safe thing is to delete it from the deployed service entirely.
        console.warn(
          "  ⚠ DEV_NO_AUTH=true is set on a deployed service and is being IGNORED. " +
            "Login is enforced. Delete that variable — it does nothing here except sit one config change away from disabling authentication.",
        );
      }
      if (DEV_NO_AUTH) {
        console.log("  → DEV_NO_AUTH=true: implicit Owner, no login required (never honoured on a deployed service).");
      } else if (!process.env.OWNER_EMAIL || !process.env.OWNER_PASSWORD) {
        console.warn("  ⚠ OWNER_EMAIL / OWNER_PASSWORD are not set — no way to create the first account.");
      }
    });

    /**
     * Put the agents down properly before the container goes.
     *
     * Railway sends SIGTERM and then waits a few seconds. An agent task is
     * minutes long, so a redeploy almost always lands mid-run — and what
     * happens in these few seconds decides whether that run resumes from where
     * it was or from the brief. Each one is asked to stop at its next safe
     * point, which writes a checkpoint and puts the task back in the queue;
     * anything that does not make it is picked up on the next boot instead,
     * from the same checkpoint.
     */
    let stopping = false;
    const shutdown = (signal: string) => {
      if (stopping) return;
      stopping = true;
      console.log(`
${signal} — finishing up.`);
      // The mailbox connection goes first and is not waited on: it holds a
      // socket the server thinks is logged in, and closing it politely is
      // worth a moment but never worth one of the few seconds the agents need.
      void stopWatcher().catch(() => undefined);
      void drainRunningTasks()
        .catch((err) => console.error("Agent drain failed:", err))
        .finally(() => {
          server.close(() => process.exit(0));
          // A held-open keep-alive connection must not outlive the deploy.
          setTimeout(() => process.exit(0), 3_000).unref();
        });
    };
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
  });
