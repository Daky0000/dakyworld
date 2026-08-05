import "dotenv/config";
import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import { clerkParser, attachUser } from "./middleware/auth.js";
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
  if (process.env.DEV_NO_AUTH === "true") {
    console.log("  → DEV_NO_AUTH=true: running as a single implicit Owner user, no real login required.");
  }
});
