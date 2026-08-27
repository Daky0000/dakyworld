import type { NextFunction, Request, Response } from "express";
import { AnalystError } from "../lib/claude.js";
import { ApifyError } from "../lib/apify.js";
import { WhatsAppError } from "../lib/whatsapp.js";
import { HubtelError } from "../lib/hubtel.js";
import { MessagingError } from "../services/messageSender.js";
import { BudgetExceeded } from "../services/budgets.js";
import { WebsiteError } from "../services/website/site.js";

/**
 * The one place an unhandled error becomes a response.
 *
 * Its own module rather than an inline `app.use` in `index.ts` because deciding
 * which errors reach the user as a sentence is a rule with real consequences,
 * and a rule that can only be exercised by booting the whole application is a
 * rule nothing checks. A harness mounting one router now mounts this too, and
 * "the refusal arrives as something a person can act on" becomes an assertion
 * rather than a hope.
 *
 * Zod validation errors become 400s, everything else 500s.
 *
 * The 500 body is deliberately uninformative in production. It used to return
 * `err.message`, which is whatever threw: a Prisma failure names the table and
 * the constraint, a fetch failure names the internal host, and a stack-shaped
 * message names the file layout. All of that is a map of the system handed to
 * whoever caused the error. The real message is on stdout, where Railway keeps
 * it, and the reference ties the two together so a user reporting "it said
 * something went wrong" can be traced to the exact log line.
 */
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
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
  // The website editor's refusals are all configuration or a page that moved
  // under a draft — "add the repository to the writable list", "reopen the page
  // and look at it as it is now". Every one of them is a sentence somebody
  // composed for the person reading it, and rendered as "Something went wrong."
  // it would send them looking for a bug in an editor that is working.
  if (err instanceof WebsiteError) {
    return res.status(err.status).json({ error: err.message, reference });
  }

  if (err instanceof BudgetExceeded) {
    return res.status(402).json({ error: err.message, budget: err.state, reference });
  }

  if (process.env.NODE_ENV === "production") {
    return res.status(500).json({ error: "Something went wrong.", reference });
  }
  res.status(500).json({ error: err instanceof Error ? err.message : "Internal server error", reference });
}
