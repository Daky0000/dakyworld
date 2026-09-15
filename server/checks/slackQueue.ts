/**
 * Does a Slack message survive Slack being unavailable?
 *
 * Every outgoing notification used to be a bare `fetch` inside the code that
 * had something to say, so the answer was no: a rate limit, a revoked token or
 * ninety seconds of downtime lost the message, and the only record it had ever
 * been meant to exist was a line in a log. A card asking the Owner to approve a
 * payment could simply never arrive, and nothing in the app looked wrong.
 *
 * Seven things are pinned down here, and each one is a way that could still be
 * true while every type checks:
 *
 * 1. **Enqueueing the same message twice sends it once.** A boot pass that
 *    re-raises every open escalation must not post a second copy of each.
 * 2. **A card that was overtaken is not sent.** A question answered before its
 *    card left should be replaced by the answer, not posted and then corrected.
 * 3. **Nothing about one card overtakes anything else about it.** An answer
 *    landing before its own question is the worst thing this queue could do.
 * 4. **A revoked token stops immediately.** Backing off for a day against a
 *    setting only a person can fix is a day of pretending to work.
 * 5. **A rate limit is honoured on Slack's own terms.** `Retry-After` knows
 *    when the window resets and no backoff we invent does.
 * 6. **Two workers racing send one message.** The lease is the only thing
 *    between this and a channel full of duplicates.
 * 7. **A request that never answered is never retried.** An aborted
 *    `chat.postMessage` may well have posted, and trying again would ask for
 *    the same decision twice.
 *
 * Drives the real worker against a local stub standing in for Slack, so there
 * is no network, no token and no workspace involved.
 *
 * Database only:
 *   set -a; . ./.env; set +a
 *   npx tsx checks/slackQueue.ts
 */
import express from "express";
import type { Server } from "node:http";
import { prisma } from "../src/lib/prisma.js";
import { SETTING, clearSettingsCache, deleteSetting, setSetting } from "../src/lib/settings.js";
import { FLAG, forgetFlags, setFlag } from "../src/lib/featureFlags.js";
import { postTaskCard, settleTaskCard } from "../src/services/agents/escalationCards.js";
import { recordCreated, transition } from "../src/services/agents/state.js";
import { postNotification, sectionsFrom } from "../src/services/slack/notify.js";
import { enqueueSlack, retrySlackDelivery, slackQueueHealth } from "../src/services/slack/queue.js";
import { drainSlackQueue, reclaimExpiredLeases } from "../src/services/slack/worker.js";

const PORT = 4597;
const AGENT_KEY = "tmp.slackqueue";
const CHANNEL = "#harness";

const failures: string[] = [];
let passed = 0;
function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed += 1;
    console.log(`  ok    ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** What the stub should do to the next request on each endpoint. */
type Behaviour =
  | { kind: "ok" }
  | { kind: "error"; code: string }
  | { kind: "ratelimited"; retryAfter: number }
  | { kind: "hang" };

let behaviour: Behaviour = { kind: "ok" };
const posted: Array<{ text: string; channel?: string }> = [];
let tsCounter = 0;

/**
 * Slack's own limits, as the stub enforces them.
 *
 * A section over 3,000 characters is refused as `invalid_blocks` — a name that
 * says nothing about which block or why. Without this the stub accepts
 * anything, and a digest that cannot be posted live passes here.
 */
function badBlocks(blocks: unknown): string | null {
  if (!Array.isArray(blocks)) return null;
  for (const block of blocks as Array<{ type?: string; text?: { text?: string } }>) {
    if (block?.type === "section" && (block.text?.text?.length ?? 0) > 3000) return "section too long";
    if (block?.type === "section" && !block.text?.text) return "section with no text";
  }
  return blocks.length > 50 ? "too many blocks" : null;
}

function stub(): Promise<Server> {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.post("/chat.postMessage", async (req, res) => {
    if (behaviour.kind === "hang") {
      // Never answers. The client's own timeout is what ends this, which is
      // exactly the shape of the outcome being tested — the request left, and
      // we never learned what became of it.
      return;
    }
    if (behaviour.kind === "ratelimited") {
      res.setHeader("retry-after", String(behaviour.retryAfter));
      return res.status(429).json({ ok: false, error: "ratelimited" });
    }
    if (behaviour.kind === "error") {
      return res.json({ ok: false, error: behaviour.code });
    }
    const bad = badBlocks(req.body?.blocks);
    if (bad) return res.json({ ok: false, error: "invalid_blocks" });
    posted.push({ text: String(req.body?.text ?? ""), channel: req.body?.channel });
    res.json({ ok: true, ts: `171000.${++tsCounter}`, channel: req.body?.channel ?? CHANNEL });
  });

  app.post("/chat.update", (req, res) => {
    if (behaviour.kind === "error") return res.json({ ok: false, error: behaviour.code });
    posted.push({ text: `update:${String(req.body?.text ?? "")}`, channel: req.body?.channel });
    res.json({ ok: true, ts: req.body?.ts });
  });

  return new Promise((resolve) => {
    const server = app.listen(PORT, () => resolve(server));
  });
}

async function reset() {
  await prisma.slackDelivery.deleteMany({ where: { idempotencyKey: { startsWith: "harness:" } } });
  const tasks = await prisma.agentTask.findMany({ where: { agentKey: AGENT_KEY }, select: { id: true } });
  const ids = tasks.map((task) => task.id);
  if (ids.length > 0) {
    // Both halves, and the second is the one that bit. A posted card carries
    // its task as the subject, so `subjectId` finds it — but the *settle* that
    // answers it deliberately carries no subject (the card reference is
    // cleared the moment it is queued, and writing it back afterwards would
    // resurrect a stale one). Those rows survived on `orderKey` alone, kept
    // their place in a queue whose task no longer existed, and ate the next
    // run's batch: every assertion after them saw PENDING and no send.
    await prisma.slackDelivery.deleteMany({
      where: { OR: [{ subjectId: { in: ids } }, { orderKey: { in: ids.map((id) => `task:${id}`) } }] },
    });
    await prisma.agentTaskTransition.deleteMany({ where: { taskId: { in: ids } } });
    await prisma.agentTaskStep.deleteMany({ where: { taskId: { in: ids } } });
    await prisma.agentTask.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.agent.deleteMany({ where: { key: AGENT_KEY } });
  // Deleted rather than written false: a row saying false is a different code
  // path from no row at all, and the default this ships with is no row.
  await deleteSetting(FLAG.SLACK_QUEUE);
  forgetFlags();
}

async function rowFor(key: string) {
  return prisma.slackDelivery.findUnique({ where: { idempotencyKey: `harness:${key}` } });
}

async function main() {
  process.env.SLACK_BASE_URL = `http://127.0.0.1:${PORT}`;
  const server = await stub();

  // A token transport, because a webhook cannot edit and half of what is
  // asserted below is about editing.
  await setSetting(SETTING.SLACK_BOT_TOKEN, "xoxb-harness");
  await setSetting(SETTING.SLACK_DEFAULT_CHANNEL, CHANNEL);
  clearSettingsCache();
  await reset();

  console.log("One message, enqueued twice");
  await enqueueSlack({ idempotencyKey: "harness:once", kind: "POST", text: "only once", channel: CHANNEL });
  await enqueueSlack({ idempotencyKey: "harness:once", kind: "POST", text: "only once", channel: CHANNEL });
  const dupes = await prisma.slackDelivery.count({ where: { idempotencyKey: "harness:once" } });
  check("is one row, not two", dupes === 1, `found ${dupes}`);

  posted.length = 0;
  await drainSlackQueue();
  check("and is sent once", posted.length === 1, `sent ${posted.length}`);
  check("and is recorded as delivered with the message id Slack gave it", (await rowFor("once"))?.status === "DELIVERED" && Boolean((await rowFor("once"))?.ts));

  console.log("\nThree updates to one card, written faster than they can be sent");
  await enqueueSlack({ idempotencyKey: "harness:c1", kind: "POST", text: "first", orderKey: "harness:card", coalesceKey: "card", channel: CHANNEL });
  await enqueueSlack({ idempotencyKey: "harness:c2", kind: "POST", text: "second", orderKey: "harness:card", coalesceKey: "card", channel: CHANNEL });
  await enqueueSlack({ idempotencyKey: "harness:c3", kind: "POST", text: "third", orderKey: "harness:card", coalesceKey: "card", channel: CHANNEL });
  check("the first is superseded", (await rowFor("c1"))?.status === "SUPERSEDED");
  check("the middle one is superseded too", (await rowFor("c2"))?.status === "SUPERSEDED");
  check("and only the current state is still waiting to go out", (await rowFor("c3"))?.status === "PENDING");

  posted.length = 0;
  await drainSlackQueue();
  check("so the channel is told once, not three times", posted.length === 1, `sent ${posted.length}`);
  check("and what it is told is the latest thing, not the oldest", posted[0]?.text === "third", posted[0]?.text);

  console.log("\nTwo messages about one card that must not overtake each other");
  await enqueueSlack({ idempotencyKey: "harness:o1", kind: "POST", text: "the question", orderKey: "harness:order", channel: CHANNEL });
  await enqueueSlack({ idempotencyKey: "harness:o2", kind: "POST", text: "the answer", orderKey: "harness:order", channel: CHANNEL });
  posted.length = 0;
  // One pass with room for both. Only the head of the order may be claimed,
  // so the second has to wait for the first to finish.
  await drainSlackQueue(new Date(), 10);
  check("the question goes first and alone", posted.length === 1 && posted[0]?.text === "the question", JSON.stringify(posted));
  await drainSlackQueue(new Date(), 10);
  check("and the answer follows it", posted.length === 2 && posted[1]?.text === "the answer", JSON.stringify(posted));

  console.log("\nA token somebody revoked");
  behaviour = { kind: "error", code: "invalid_auth" };
  await enqueueSlack({ idempotencyKey: "harness:revoked", kind: "POST", text: "will not go", channel: CHANNEL });
  await drainSlackQueue();
  const revoked = await rowFor("revoked");
  check("is given up on at once rather than backed off against", revoked?.status === "FAILED", revoked?.status);
  check("and is marked as needing a person, not more time", revoked?.permanent === true);
  check("and says what to actually do about it", (revoked?.lastError ?? "").includes("bot token"), revoked?.lastError ?? "");

  const attemptsBefore = revoked?.attempts ?? 0;
  await drainSlackQueue();
  check("and is not tried again on its own", (await rowFor("revoked"))?.attempts === attemptsBefore);

  console.log("\nSlack rate-limiting us");
  behaviour = { kind: "ratelimited", retryAfter: 120 };
  await enqueueSlack({ idempotencyKey: "harness:limited", kind: "POST", text: "too fast", channel: CHANNEL });
  const before = Date.now();
  await drainSlackQueue();
  const limited = await rowFor("limited");
  check("is kept for another attempt rather than dropped", limited?.status === "RETRYING", limited?.status);
  const waitMs = (limited?.nextAttemptAt.getTime() ?? 0) - before;
  check(
    "and waits as long as Slack asked, not as long as we guessed",
    waitMs > 110_000 && waitMs < 130_000,
    `waiting ${Math.round(waitMs / 1000)}s`,
  );
  // Same reason as the stranded row below: asserted on, so taken out of the
  // queue rather than left to come due in the middle of a later scenario.
  await prisma.slackDelivery.update({ where: { idempotencyKey: "harness:limited" }, data: { status: "SUPERSEDED" } });

  console.log("\nTwo workers reaching for the same message");
  behaviour = { kind: "ok" };
  await enqueueSlack({ idempotencyKey: "harness:race", kind: "POST", text: "contested", channel: CHANNEL });
  posted.length = 0;
  await Promise.all([drainSlackQueue(), drainSlackQueue()]);
  check("send it once between them", posted.length === 1, `sent ${posted.length}`);

  console.log("\nA process that died holding a message");
  await enqueueSlack({ idempotencyKey: "harness:stranded", kind: "POST", text: "stranded", channel: CHANNEL });
  await prisma.slackDelivery.update({
    where: { idempotencyKey: "harness:stranded" },
    data: { status: "SENDING", leaseOwner: "dead-process:1", leaseUntil: new Date(Date.now() - 60_000), attempts: 1 },
  });
  const reclaimed = await reclaimExpiredLeases();
  check("has it handed back", reclaimed === 1, `reclaimed ${reclaimed}`);
  check(
    "keeping the attempt it already spent, so a crash loop cannot buy itself unlimited tries",
    (await rowFor("stranded"))?.attempts === 1,
  );
  // Put back out of the way. It has been asserted on, and leaving a row that
  // is due right now in the queue means the next drain claims it alongside
  // whatever that scenario is actually about — which is how this check counted
  // two sends for one card and failed only when the timing was right.
  await prisma.slackDelivery.update({ where: { idempotencyKey: "harness:stranded" }, data: { status: "SUPERSEDED" } });

  console.log("\nA message that has been failing all day");
  await enqueueSlack({ idempotencyKey: "harness:spent", kind: "POST", text: "spent", channel: CHANNEL });
  behaviour = { kind: "error", code: "internal_error" };
  await prisma.slackDelivery.update({ where: { idempotencyKey: "harness:spent" }, data: { attempts: 8 } });
  await drainSlackQueue();
  const spent = await rowFor("spent");
  check("is given up on rather than retried for ever", spent?.status === "FAILED", spent?.status);
  check("and is not marked as a configuration problem, because it is not one", spent?.permanent === false);

  console.log("\nA given-up message, after somebody fixes the setting");
  behaviour = { kind: "ok" };
  await retrySlackDelivery((await rowFor("spent"))!.id, null);
  const retried = await rowFor("spent");
  check("is queued again", retried?.status === "PENDING", retried?.status);
  check("with its attempts reset, so the button works more than once", retried?.attempts === 0);
  posted.length = 0;
  await drainSlackQueue();
  check("and goes out", posted.length === 1, `sent ${posted.length}`);

  console.log("\nA message that was delivered");
  let refused = "";
  await retrySlackDelivery((await rowFor("spent"))!.id, null).catch((err: Error) => {
    refused = err.message;
  });
  check("cannot be sent again by hand", refused.includes("second copy"), refused);

  console.log("\nA request that left and never answered");
  // Ten seconds, because that is the client's own timeout, and shortening it
  // here would be testing something other than what happens live.
  behaviour = { kind: "hang" };
  await enqueueSlack({ idempotencyKey: "harness:silent", kind: "POST", text: "no answer", channel: CHANNEL });
  await drainSlackQueue();
  const silent = await rowFor("silent");
  check("is recorded as unknown rather than failed", silent?.status === "UNCERTAIN", silent?.status);
  check("and says so in words somebody can act on", (silent?.lastError ?? "").includes("Check Slack"), silent?.lastError ?? "");
  behaviour = { kind: "ok" };
  posted.length = 0;
  await drainSlackQueue();
  check(
    "and is never sent again on its own, because it may already be in the channel",
    posted.length === 0 && (await rowFor("silent"))?.status === "UNCERTAIN",
    `sent ${posted.length}`,
  );

  console.log("\nA real escalation card, with the queue switched on");
  // The one place a regression in this release could hide. Posting a card is
  // now asynchronous, so the message id arrives from the worker rather than
  // from the call — and a card whose `slackTs` never lands can never be edited,
  // which means the question it asks can never be shown as answered.
  await setFlag(FLAG.SLACK_QUEUE, true);
  await prisma.agent.create({
    data: {
      key: AGENT_KEY,
      name: "Delivery Harness",
      title: "Harness",
      tier: "SUB_AGENT",
      department: "TECHNOLOGY",
      status: "ACTIVE",
      mission: "Exists for one test run.",
      toolkit: ["email.send"],
    },
  });
  const task = await prisma.agentTask.create({
    data: { agentKey: AGENT_KEY, title: "Price the retainer", brief: "Quote the monthly plan.", origin: "OWNER", rehearsal: false },
  });
  await recordCreated(task.id, task.traceId, task.status, { reason: "Harness.", actor: "check" });
  await transition(task.id, { to: "RUNNING", reason: "Claimed.", actor: "check" });
  await transition(task.id, {
    to: "BLOCKED",
    reason: "Stopped and asked.",
    actor: "check",
    data: { blockedReason: "Cedis or dollars?", finishedAt: new Date() },
  });

  posted.length = 0;
  const enqueued = await postTaskCard(task.id);
  check("is accepted without waiting on Slack", enqueued);
  check("and nothing has been sent yet, because the queue owns it now", posted.length === 0, `sent ${posted.length}`);

  await drainSlackQueue();
  check("then the question reaches the channel", posted.length === 1, `sent ${posted.length}`);
  const carded = await prisma.agentTask.findUnique({ where: { id: task.id }, select: { slackTs: true, slackChannel: true } });
  check(
    "and the task learns where its card is, or it could never be settled",
    Boolean(carded?.slackTs) && Boolean(carded?.slackChannel),
    JSON.stringify(carded),
  );

  posted.length = 0;
  await settleTaskCard(task.id, "the Owner", "Cedis.");
  await drainSlackQueue();
  check("answering it edits that same card rather than posting a second one", posted.length === 1 && posted[0]!.text.startsWith("update:"), JSON.stringify(posted));

  console.log("\nA question answered before its card ever left");
  const quick = await prisma.agentTask.create({
    data: { agentKey: AGENT_KEY, title: "Second question", brief: "Ask something.", origin: "OWNER", rehearsal: false },
  });
  await recordCreated(quick.id, quick.traceId, quick.status, { reason: "Harness.", actor: "check" });
  await transition(quick.id, { to: "RUNNING", reason: "Claimed.", actor: "check" });
  await transition(quick.id, {
    to: "BLOCKED",
    reason: "Stopped and asked.",
    actor: "check",
    data: { blockedReason: "Anything?", finishedAt: new Date() },
  });
  await postTaskCard(quick.id);
  // Answered in the same breath, before any worker ran.
  await prisma.agentTask.update({ where: { id: quick.id }, data: { slackChannel: CHANNEL, slackTs: null } });
  await settleTaskCard(quick.id, "the Owner", "Yes.");
  posted.length = 0;
  await drainSlackQueue();
  await drainSlackQueue();
  check(
    "is announced once, not asked and then immediately corrected",
    posted.length === 1,
    JSON.stringify(posted.map((row) => row.text.slice(0, 40))),
  );

  await setFlag(FLAG.SLACK_QUEUE, false);

  console.log("\nA digest with more waiting on it than fits in one block");
  // The bug this caught in production: both digests built one section out of
  // an unbounded list, so each worked perfectly until there was enough to
  // report — and then failed as `invalid_blocks` on exactly the days the
  // report mattered most.
  const many = Array.from({ length: 40 }, (_, i) => `• *Agent ${i}* — a question that is quite long, ${"x".repeat(120)} _(${i}d)_`);
  const split = sectionsFrom(many);
  check("is split into more than one section", split.length > 1, `got ${split.length}`);
  check(
    "and no section is over the limit Slack actually enforces",
    split.every((block) => ((block as { text: { text: string } }).text.text.length ?? 0) <= 3000),
  );
  check("and keeps every line", split.map((b) => (b as { text: { text: string } }).text.text).join("\n").split("\n").length === many.length);

  posted.length = 0;
  // Through the queue, so the outcome is a row that can be asserted on rather
  // than a send that either threw or did not.
  await setFlag(FLAG.SLACK_QUEUE, true);
  await postNotification({ idempotencyKey: "harness:digest", text: "40 questions waiting on you", blocks: [...split] });
  await setFlag(FLAG.SLACK_QUEUE, false);
  await drainSlackQueue();
  check("so the digest actually reaches the channel", posted.length === 1, `sent ${posted.length}`);
  check("rather than being refused as invalid_blocks", (await rowFor("digest"))?.status === "DELIVERED", (await rowFor("digest"))?.lastError ?? "");

  console.log("\nHealth");
  const health = await slackQueueHealth();
  check("counts what was given up on", health.failed >= 1, JSON.stringify(health));
  check("and knows when something last arrived", Boolean(health.lastSuccessAt));

  // Destroyed, not merely closed. One scenario above deliberately leaves a
  // request hanging, and `close()` waits for open connections to drain — so
  // closing politely here would hold the whole check suite open for ever on
  // the one socket that is never going to answer.
  server.closeAllConnections();
  server.close();
  await reset();
  await deleteSetting(SETTING.SLACK_BOT_TOKEN);
  await deleteSetting(SETTING.SLACK_DEFAULT_CHANNEL);
  clearSettingsCache();

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) process.exitCode = 1;
  await prisma.$disconnect();
}

void main().catch(async (err) => {
  console.error(err);
  await reset().catch(() => {});
  await prisma.$disconnect();
  process.exitCode = 1;
});
