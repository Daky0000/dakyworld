import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { ApprovalRefused, approve, countPending, decline, flagStalePreparedActions, freshPreview, listRequests } from "../services/approvals.js";
import { settleApprovalCard } from "../services/approvalCards.js";
import { gateBy } from "../middleware/permissionGate.js";

/**
 * The queue of things agents have prepared and cannot carry out alone.
 *
 * Owner-gated as a whole, because every row in it is either an action visible
 * outside the company or one that spends money — which is the same test the
 * tool gate applies, and the reason these ended up here rather than happening.
 *
 * **Everything a Slack button does, these routes do too.** That is not
 * duplication for its own sake: a workspace nobody connected, a signing secret
 * nobody pasted, or an app somebody removed would otherwise mean a queue of
 * proposals with no way to answer any of them, and the symptom would read as
 * the agents being broken rather than Slack being unconfigured.
 */
export const approvalsRouter = Router();

approvalsRouter.use(
  gateBy({
    view: "agents.approvals.view",
    create: "agents.approvals.decide",
  }),
);


approvalsRouter.get("/", async (req, res, next) => {
  try {
    const status = z
      .enum(["PENDING", "APPROVED", "EXECUTED", "FAILED", "DECLINED", "EXPIRED", "ALL"])
      .default("PENDING")
      .parse(req.query.status ?? "PENDING");

    const requests = await listRequests(status === "ALL" ? "ALL" : status);
    const [pending, counts, stale] = await Promise.all([
      countPending(),
      // Rehearsal specimens are excluded here as well as from the list. A tab
      // reading "42 declined" that shows nothing when opened is worse than no
      // number at all.
      prisma.actionRequest.groupBy({ by: ["status"], where: { rehearsal: false }, _count: true }),
      // Which agents have work nobody has read in two days. The sweep behind
      // this has run on the housekeeping tick for months and said so only in
      // the log, where it answered nobody's question — a person looking at the
      // queue could not see that eleven of these cards belong to one agent.
      flagStalePreparedActions(),
    ]);

    res.json({
      requests,
      pending,
      counts: Object.fromEntries(counts.map((row) => [row.status, row._count])),
      /** Agents whose prepared work has been waiting more than 48 hours. */
      stale,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * One request, with the preview worked out again as at now.
 *
 * The card was written when the agent prepared it, which may have been a day
 * ago. In that time the invoice may have been paid and the lead may have gone
 * cold. Where the answer has changed, saying so is the single most useful thing
 * on the screen — it is the difference between approving what you think you are
 * approving and approving what it was.
 */
approvalsRouter.get("/:id", async (req, res, next) => {
  try {
    const request = await prisma.actionRequest.findUnique({ where: { id: req.params.id } });
    if (!request) return res.status(404).json({ error: "No such request." });

    const [fresh] = await Promise.all([freshPreview(request)]);
    res.json({
      ...request,
      nowWouldDo: fresh?.wouldDo ?? null,
      previewChanged: fresh?.changed ?? false,
      expired: request.status === "PENDING" && request.expiresAt < new Date(),
    });
  } catch (err) {
    next(err);
  }
});

const decisionInput = z.object({ note: z.string().max(600).optional() });

approvalsRouter.post("/:id/approve", async (req, res, next) => {
  try {
    const input = decisionInput.parse(req.body ?? {});
    const outcome = await approve(req.params.id, { userId: req.dbUser?.id ?? null, note: input.note ?? null });

    // The Slack card, if there is one, must stop showing a live Approve button
    // under a decision that has already been made. Best-effort: the action has
    // happened by now, and failing to tidy the message is not a reason to tell
    // the Owner it did not.
    await settleApprovalCard(outcome.request);

    res.json({
      request: outcome.request,
      alreadySettled: outcome.alreadySettled,
      // Said plainly. "Approved" and "carried out" are different claims and the
      // whole point of this feature is that the second one is now true.
      outcome:
        outcome.request.status === "EXECUTED"
          ? "Carried out."
          : outcome.request.status === "FAILED"
            ? `Approved, but it did not go through — ${outcome.request.error}`
            : outcome.alreadySettled
              ? `That was already ${outcome.request.status.toLowerCase()}.`
              : "Approved.",
    });
  } catch (err) {
    if (err instanceof ApprovalRefused) return res.status(409).json({ error: err.message });
    next(err);
  }
});

approvalsRouter.post("/:id/decline", async (req, res, next) => {
  try {
    const input = decisionInput.parse(req.body ?? {});
    const outcome = await decline(req.params.id, { userId: req.dbUser?.id ?? null, note: input.note ?? null });
    await settleApprovalCard(outcome.request);
    res.json({
      request: outcome.request,
      alreadySettled: outcome.alreadySettled,
      outcome: outcome.alreadySettled ? `That was already ${outcome.request.status.toLowerCase()}.` : "Declined. The agent will be told when it next picks this up.",
    });
  } catch (err) {
    if (err instanceof ApprovalRefused) return res.status(409).json({ error: err.message });
    next(err);
  }
});
