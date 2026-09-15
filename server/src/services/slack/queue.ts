import type { SlackDelivery, SlackDeliveryKind, SlackDeliveryStatus } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";

/**
 * Writing an outgoing Slack message down before trying to send it.
 *
 * The rule this file exists to enforce is that nothing decides to say
 * something to Slack and then discovers, alone and without a witness, that it
 * could not. Enqueueing is a database insert and nothing else: it cannot fail
 * because Slack is down, it takes no network, and it is safe to call from the
 * middle of a task that is doing something more important.
 *
 * The worker in `worker.ts` is what turns rows into requests.
 */

/**
 * Stands in for a channel on a webhook-only Slack, which reports neither a
 * channel nor a message id.
 *
 * Never sent to Slack. It is only ever read back, as the record that a card
 * did reach a wall somewhere — which is the difference between "this question
 * was never posted", where announcing an answer would be talking to a channel
 * that never saw the question, and "this question is on the wall with live
 * buttons under it", where saying nothing leaves it answerable twice.
 *
 * It lives here rather than beside the escalation card because the worker is
 * now what writes it, and two copies of a sentinel is one copy too many.
 */
export const POSTED_BY_WEBHOOK = "webhook";

/** Twenty-four hours, after which a card is about something too old to bother. */
const TTL_MS = 24 * 60 * 60 * 1000;

export interface EnqueueInput {
  /**
   * What this message is, stably. Enqueueing the same key twice is a no-op —
   * which is what makes it safe for a boot pass to re-raise every open
   * escalation without asking whether it already did.
   */
  idempotencyKey: string;
  kind: SlackDeliveryKind;
  text: string;
  blocks?: unknown[] | null;
  channel?: string | null;
  ts?: string | null;
  threadTs?: string | null;
  /** Everything about one card, so it goes out in the order it was written. */
  orderKey?: string | null;
  /** Which slot in that order. A newer unsent row with the same slot wins. */
  coalesceKey?: string | null;
  subjectType?: string | null;
  subjectId?: string | null;
}

/**
 * Puts one message in the queue.
 *
 * Two things happen in one transaction, and the order is the whole design:
 *
 * 1. **Anything unsent that this replaces is marked superseded.** If a task
 *    was answered before its question card ever left, sending the question and
 *    then immediately editing it to say "answered" is two notifications for
 *    nothing. Rows already being sent are deliberately left alone: a request
 *    on the wire cannot be recalled, and pretending otherwise would make the
 *    status a lie.
 * 2. **The row is written with the next sequence number for its order.** Not a
 *    timestamp — two rows written in the same millisecond would then be in an
 *    arbitrary order, and for a card that is the difference between the answer
 *    arriving before the question.
 */
export async function enqueueSlack(input: EnqueueInput): Promise<SlackDelivery> {
  const now = new Date();
  try {
    return await prisma.$transaction(async (tx) => {
      if (input.orderKey && input.coalesceKey) {
        await tx.slackDelivery.updateMany({
          where: {
            orderKey: input.orderKey,
            coalesceKey: input.coalesceKey,
            status: { in: ["PENDING", "RETRYING"] },
          },
          data: { status: "SUPERSEDED" },
        });
      }

      const highest = input.orderKey
        ? await tx.slackDelivery.aggregate({ where: { orderKey: input.orderKey }, _max: { seq: true } })
        : null;
      const seq = (highest?._max.seq ?? 0) + 1;

      return tx.slackDelivery.create({
        data: {
          idempotencyKey: input.idempotencyKey,
          kind: input.kind,
          text: input.text.slice(0, 40_000),
          blocks: (input.blocks ?? undefined) as Prisma.InputJsonValue | undefined,
          channel: input.channel ?? null,
          ts: input.ts ?? null,
          threadTs: input.threadTs ?? null,
          orderKey: input.orderKey ?? null,
          coalesceKey: input.coalesceKey ?? null,
          subjectType: input.subjectType ?? null,
          subjectId: input.subjectId ?? null,
          seq,
          expiresAt: new Date(now.getTime() + TTL_MS),
        },
      });
    });
  } catch (err) {
    // Somebody else wrote this exact message first. That is the idempotency
    // key doing its job, so hand back the row they wrote rather than treating
    // a successful outcome as an error.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const existing = await prisma.slackDelivery.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
      if (existing) return existing;
    }
    throw err;
  }
}

export class DeliveryNotRetryable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeliveryNotRetryable";
  }
}

/**
 * Tries a given-up delivery once more, because a person fixed whatever was
 * wrong.
 *
 * Only failed and uncertain deliveries may be retried by hand, and they are
 * the two that need it: the first because the fix was a setting and nothing
 * will reconsider on its own, the second because only a person can look in
 * Slack and say whether the message is already there.
 *
 * The attempt counter is reset. The point of a manual retry is that the
 * circumstances changed, so counting the attempts made under the old ones
 * against it would mean the button worked once and then stopped working.
 */
export async function retrySlackDelivery(id: string, actorId?: string | null): Promise<SlackDelivery> {
  const row = await prisma.slackDelivery.findUnique({ where: { id } });
  if (!row) throw new DeliveryNotRetryable("That delivery no longer exists.");
  if (row.status !== "FAILED" && row.status !== "UNCERTAIN") {
    throw new DeliveryNotRetryable(
      row.status === "DELIVERED"
        ? "That message was delivered. Sending it again would post a second copy."
        : `That delivery is ${row.status.toLowerCase()} and will be attempted on its own.`,
    );
  }
  return prisma.slackDelivery.update({
    where: { id },
    data: {
      status: "PENDING",
      attempts: 0,
      permanent: false,
      nextAttemptAt: new Date(),
      expiresAt: new Date(Date.now() + TTL_MS),
      leaseOwner: null,
      leaseUntil: null,
      retriedById: actorId ?? null,
      retriedAt: new Date(),
    },
  });
}

export interface HistoryFilter {
  status?: SlackDeliveryStatus[];
  subjectType?: string;
  subjectId?: string;
  since?: Date;
  limit?: number;
}

export async function deliveryHistory(filter: HistoryFilter = {}): Promise<SlackDelivery[]> {
  return prisma.slackDelivery.findMany({
    where: {
      ...(filter.status?.length ? { status: { in: filter.status } } : {}),
      ...(filter.subjectType ? { subjectType: filter.subjectType } : {}),
      ...(filter.subjectId ? { subjectId: filter.subjectId } : {}),
      ...(filter.since ? { createdAt: { gte: filter.since } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(filter.limit ?? 50, 200),
  });
}

export interface SlackQueueHealth {
  pending: number;
  retrying: number;
  failed: number;
  uncertain: number;
  lastSuccessAt: string | null;
  /**
   * How long the oldest thing still waiting has been waiting. The number that
   * says "the queue is stuck" when every other number looks fine.
   */
  oldestPendingAt: string | null;
}

export async function slackQueueHealth(): Promise<SlackQueueHealth> {
  const [counts, lastSuccess, oldest] = await Promise.all([
    prisma.slackDelivery.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.slackDelivery.findFirst({
      where: { status: "DELIVERED" },
      orderBy: { deliveredAt: "desc" },
      select: { deliveredAt: true },
    }),
    prisma.slackDelivery.findFirst({
      where: { status: { in: ["PENDING", "RETRYING"] } },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    }),
  ]);
  const of = (status: SlackDeliveryStatus) => counts.find((row) => row.status === status)?._count._all ?? 0;
  return {
    pending: of("PENDING"),
    retrying: of("RETRYING"),
    failed: of("FAILED"),
    uncertain: of("UNCERTAIN"),
    lastSuccessAt: lastSuccess?.deliveredAt?.toISOString() ?? null,
    oldestPendingAt: oldest?.createdAt?.toISOString() ?? null,
  };
}

/** Drops delivered rows that are old enough to be nobody's business. */
export async function pruneDeliveries(days = 30): Promise<number> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const { count } = await prisma.slackDelivery.deleteMany({
    where: { status: { in: ["DELIVERED", "SUPERSEDED"] }, createdAt: { lt: cutoff } },
  });
  return count;
}
