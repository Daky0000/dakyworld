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

/**
 * A list of lines as however many section blocks it takes.
 *
 * Slack refuses a section whose text runs past 3,000 characters, and refuses
 * it as `invalid_blocks` — a name that says nothing about which block or why.
 * Both digests built one section out of an unbounded list, so each worked
 * perfectly until there was enough to report, and then failed on exactly the
 * days the report mattered most. Twenty waiting escalations at a hundred and
 * fifty characters each is over the line.
 *
 * Splits on line boundaries, because a digest cut mid-sentence is worse than
 * one that runs to two blocks.
 */
const SECTION_LIMIT = 2_900;

export function sectionsFrom(lines: string[]): unknown[] {
  const sections: unknown[] = [];
  let current: string[] = [];
  let length = 0;

  for (const line of lines) {
    // One line longer than a whole section is its own problem; trim it rather
    // than let it take the whole digest down with it.
    const safe = line.length > SECTION_LIMIT ? `${line.slice(0, SECTION_LIMIT - 1)}…` : line;
    if (length + safe.length + 1 > SECTION_LIMIT && current.length > 0) {
      sections.push({ type: "section", text: { type: "mrkdwn", text: current.join("\n") } });
      current = [];
      length = 0;
    }
    current.push(safe);
    length += safe.length + 1;
  }

  if (current.length > 0) sections.push({ type: "section", text: { type: "mrkdwn", text: current.join("\n") } });
  return sections;
}
