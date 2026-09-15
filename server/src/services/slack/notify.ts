import { FLAG, flagOn } from "../../lib/featureFlags.js";
import { sendSlack, sendSlackBlocks } from "../../lib/slack.js";
import { enqueueSlack } from "./queue.js";

/**
 * One standalone notification — a digest, a report, an alert — sent the
 * durable way when the queue is switched on and the old way when it is not.
 *
 * Every caller of this wants the same three things and none of them wants to
 * know about a flag: say this once, do not let a Slack outage lose it, and do
 * not let a Slack outage break whatever was actually happening. Written once
 * here because the alternative is the same eight lines in six files, five of
 * which would eventually stop matching the sixth.
 *
 * Cards are not sent through this. A card has an identity, an order and a
 * record that owns it, and those belong in the `enqueueSlack` call beside the
 * thing that builds the card.
 */

export interface Notification {
  /**
   * What this notification is, stably.
   *
   * For anything raised on a schedule this should carry the day and the shape
   * of what it says — `digest:escalations:2026-09-15:7` — so two ticks raising
   * the same digest produce one message, while a digest raised again after an
   * eighth question arrives is correctly a new one.
   */
  idempotencyKey: string;
  text: string;
  blocks?: unknown[] | null;
  channel?: string | null;
}

/**
 * Returns whether the message is now somebody's responsibility — queued or
 * delivered — rather than whether Slack has it. Nothing that calls this can
 * act on the difference, and a caller that could would be a caller that should
 * be waiting on the queue instead.
 */
export async function postNotification(input: Notification): Promise<boolean> {
  if (await flagOn(FLAG.SLACK_QUEUE)) {
    await enqueueSlack({
      idempotencyKey: input.idempotencyKey,
      kind: "POST",
      text: input.text,
      blocks: input.blocks,
      channel: input.channel,
    });
    return true;
  }

  const result = input.blocks?.length
    ? await sendSlackBlocks({ text: input.text, blocks: input.blocks, channel: input.channel })
    : await sendSlack({ text: input.text, channel: input.channel });
  return result.delivered;
}
