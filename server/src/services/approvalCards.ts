import type { ActionRequest } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { sendSlackBlocks, slackConfigured, updateSlack } from "../lib/slack.js";
import { appUrl } from "./emailSender.js";
import { resolveTool } from "./tools/catalogue.js";

/**
 * An approval, as a Slack card.
 *
 * Kept out of `approvals.ts` so that file stays about deciding and executing.
 * The shape follows the hiring card deliberately — one builder for every state,
 * so a settled decision rewrites its own message rather than leaving a live
 * Approve button under a question that has already been answered.
 *
 * **Slack is never the only road.** Everything here is best-effort: the queue
 * works, and every button has an authenticated route behind it, whether or not
 * a workspace was ever connected. Failing to post a card must not stop an agent
 * preparing work, and failing to rewrite one must not undo a decision that has
 * already taken effect.
 */

export const APPROVAL_ACTIONS = {
  approve: "dky_action_approve",
  decline: "dky_action_decline",
} as const;

function button(text: string, actionId: string, value: string, style?: "primary" | "danger") {
  return { type: "button", text: { type: "plain_text", text, emoji: true }, action_id: actionId, value, ...(style ? { style } : {}) };
}

async function approvalBlocks(request: ActionRequest, decidedBy: string | null): Promise<{ text: string; blocks: unknown[] }> {
  const base = await appUrl();
  const [agent, tool] = await Promise.all([
    prisma.agent.findUnique({ where: { key: request.agentKey }, select: { name: true } }),
    resolveTool(request.tool),
  ]);
  const who = agent?.name ?? request.agentKey;
  const what = tool?.name ?? request.tool;

  const headline =
    request.status === "PENDING"
      ? `${who} wants to ${what.toLowerCase()}`
      : request.status === "EXECUTED"
        ? `Done — ${what}`
        : request.status === "FAILED"
          ? `Approved but failed — ${what}`
          : request.status === "EXPIRED"
            ? `Expired — ${what}`
            : `Declined — ${what}`;

  const blocks: unknown[] = [
    { type: "header", text: { type: "plain_text", text: headline.slice(0, 150), emoji: true } },
    { type: "section", text: { type: "mrkdwn", text: `*It would:* ${request.wouldDo}`.slice(0, 3000) } },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Why*\n${request.why}`.slice(0, 2000) },
        { type: "mrkdwn", text: `*What we gain*\n${request.gain}`.slice(0, 2000) },
      ],
    },
    { type: "section", text: { type: "mrkdwn", text: `*Risk*\n${request.risk}`.slice(0, 3000) } },
  ];

  if (tool?.spends) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: ":coin: *This one costs money.*" } });
  }

  if (request.status === "PENDING") {
    blocks.push({
      type: "actions",
      elements: [button("Approve — do it", APPROVAL_ACTIONS.approve, request.id, "primary"), button("Decline", APPROVAL_ACTIONS.decline, request.id, "danger")],
    });
  }

  const settled =
    request.status === "PENDING"
      ? "Nothing has happened yet. Approving carries it out exactly as prepared."
      : request.status === "FAILED"
        ? `failed — ${request.error ?? "the tool did not carry it out"}`
        : `${request.status.toLowerCase()}${decidedBy ? ` by ${decidedBy}` : ""}${request.decisionNote ? ` — ${request.decisionNote}` : ""}`;

  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: `Prepared by \`${request.agentKey}\` · ${settled} · <${base}/approvals|Open the queue>` }],
  });

  return { text: `${headline} — ${request.wouldDo}`.slice(0, 300), blocks };
}

/** Posts a newly prepared action and remembers where, so it can be settled later. */
export async function postApprovalCard(requestId: string): Promise<boolean> {
  const request = await prisma.actionRequest.findUnique({ where: { id: requestId } });
  if (!request || request.status !== "PENDING") return false;
  if (!(await slackConfigured())) return false;

  try {
    const { text, blocks } = await approvalBlocks(request, null);
    const result = await sendSlackBlocks({ text, blocks });
    if (result.delivered && result.ts && result.channel) {
      await prisma.actionRequest.update({ where: { id: requestId }, data: { slackChannel: result.channel, slackTs: result.ts } });
    }
    return result.delivered;
  } catch (err) {
    console.error("[approvals] could not post the card:", (err as Error).message);
    return false;
  }
}

/**
 * Rewrites a decided card.
 *
 * A webhook-only Slack cannot edit what it posted, so the outcome is posted as
 * a fresh message instead — the same fallback the hiring card uses, and for the
 * same reason: a stale Approve button is worse than a second message.
 */
export async function settleApprovalCard(request: ActionRequest, decidedBy: string | null = null): Promise<void> {
  if (!(await slackConfigured())) return;
  try {
    const { text, blocks } = await approvalBlocks(request, decidedBy);
    if (request.slackChannel && request.slackTs && (await updateSlack(request.slackChannel, request.slackTs, { text, blocks }))) return;
    await sendSlackBlocks({ text, blocks });
  } catch (err) {
    console.error("[approvals] could not update the card:", (err as Error).message);
  }
}
