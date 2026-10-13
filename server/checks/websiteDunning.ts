/**
 * A declined renewal, through the real Paystack event queue and a real
 * database: how long editing stays open, which notice goes out, and the amount
 * it quotes.
 *
 *   DATABASE_URL=postgresql://…/<a local *test* database> npx tsx checks/websiteDunning.ts
 *
 * Two ways the past-due path said one thing and did another:
 *
 * - **Every Paystack event restarted the fortnight.** With no paid-up date it
 *   ran from `updatedAt`, and the event handler rewrites the row on every
 *   `subscription.*` and `invoice.*` event, changed or not. A customer locked
 *   for non-payment was unlocked by the next declined charge, and the notice
 *   sent straight after that write always counted zero days, so the warning
 *   and the "editing paused" notice never went out while the lock still did.
 * - **The notice quoted the standard monthly list price at today's rate**, not
 *   what the plan charges: $45/mo to somebody whose $25 had just been declined,
 *   "/mo" to an annual customer, and a cedi figure recomputed from the exchange
 *   rate rather than the amount they agreed to.
 *
 * Needs Postgres and nothing else. Paystack is a stubbed `fetch` that refuses
 * any other address, mail goes to a sink on a local port, and every row this
 * makes is removed at the end.
 */
import assert from "node:assert/strict";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";

const databaseUrl = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/invalid");
if (!["localhost", "127.0.0.1", "[::1]"].includes(databaseUrl.hostname) || !/(test|check|editor)/i.test(databaseUrl.pathname)) {
  throw new Error("These checks require an isolated local test/editor database. Set DATABASE_URL to one.");
}

let passed = 0;
const failures: string[] = [];
async function check(name: string, test: () => unknown | Promise<unknown>) {
  try { await test(); passed += 1; console.log(`  ok  ${name}`); }
  catch (error) {
    failures.push(name);
    const detail = error instanceof assert.AssertionError && error.operator !== "fail" ? ` (got ${JSON.stringify(error.actual)}, wanted ${JSON.stringify(error.expected)})` : "";
    console.log(`FAIL  ${name}\n      ${(error as Error).message.split("\n")[0]}${detail}`);
  }
}

/* ------------------------------------------------------------- set-up ---- */

// A test key that reaches nothing — every Paystack call is answered below.
// The exchange rate is deliberately not the one any purchase here was sold
// at, so a notice that recomputes a price instead of reading it shows.
Object.assign(process.env, {
  PAYSTACK_SECRET_KEY: "sk_test_dunningcheck",
  PAYSTACK_TEST_SECRET_KEY: "sk_test_dunningcheck",
  PAYSTACK_MODE: "test",
  PAYSTACK_USD_GHS_RATE: "15",
});

// A mail server on a local port that keeps what it is sent.
const delivered: string[] = [];
const sink = net.createServer((socket) => {
  socket.write("220 sink ESMTP\r\n");
  let data: string | null = null;
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk.toString("latin1");
    let at: number;
    while ((at = buffer.indexOf("\r\n")) >= 0) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 2);
      if (data !== null) {
        if (line === ".") { delivered.push(data); data = null; socket.write("250 2.0.0 queued\r\n"); }
        else data += `${line.startsWith("..") ? line.slice(1) : line}\r\n`;
        continue;
      }
      const verb = line.slice(0, 4).toUpperCase();
      if (verb === "EHLO" || verb === "HELO") socket.write("250-sink\r\n250 AUTH PLAIN LOGIN\r\n");
      else if (verb === "AUTH") socket.write("235 2.7.0 ok\r\n");
      else if (verb === "DATA") { data = ""; socket.write("354 go\r\n"); }
      else if (verb === "QUIT") { socket.write("221 bye\r\n"); socket.end(); }
      else socket.write("250 ok\r\n");
    }
  });
});
await new Promise<void>((resolve) => sink.listen(0, "127.0.0.1", resolve));
Object.assign(process.env, {
  SMTP_HOST: "127.0.0.1", SMTP_PORT: String((sink.address() as AddressInfo).port), SMTP_SECURE: "false",
  SMTP_USER: "sink@dunning.test", SMTP_PASSWORD: "local-sink", MAIL_FROM_EMAIL: "sink@dunning.test", MAIL_TRANSPORT: "SMTP",
});

/** The readable text of a captured message, whatever transfer encoding each part used. */
function readable(raw: string): string {
  const unfolded = raw.replace(/=\r\n/g, "");
  const decodedQp = unfolded.replace(/=([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  const base64Parts = [...raw.matchAll(/Content-Transfer-Encoding: base64\r\n(?:[^\r\n]+\r\n)*\r\n([A-Za-z0-9+/=\r\n]+)/gi)]
    .map((match) => Buffer.from(match[1]!.replace(/\s/g, ""), "base64").toString("utf8"));
  return [decodedQp, ...base64Parts].join("\n");
}

// Paystack, as far as this process can tell. `subscription` is what it reports
// the next time it is asked; anything that is not the Paystack API is refused,
// so nothing here can reach the network.
let subscription: Record<string, unknown> = {};
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (url: string | URL | Request) => {
  const href = String(url instanceof Request ? url.url : url);
  if (!href.startsWith("https://api.paystack.co/")) throw new Error(`This check makes no network calls (asked for ${href}).`);
  const data = href.includes("/manage/link") ? { link: "https://paystack.com/manage/subscriptions/check" } : subscription;
  return new Response(JSON.stringify({ status: true, message: "ok", data }), { status: 200 });
}) as typeof fetch;

const { prisma } = await import("../src/lib/prisma.js");
const { enqueuePaystackEvent, processPaystackEvents } = await import("../src/services/paystackEvents.js");
const { editingLockedForNonPayment, sendDunningNotice } = await import("../src/services/websiteDunning.js");

const mark = `dunning-${randomUUID().slice(0, 8)}`;
const email = `${mark}@example.test`;
const code = `SUB_${mark}`;
const planCode = `PLN_${mark}`;
const DAY = 86_400_000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY);

// Events are queued the way the webhook queues them, then given a due time
// nothing else in the table has, so the queue is run over these alone and a
// leftover from another check is never touched.
const OURS = new Date("2001-01-01T00:00:00Z");
async function paystackSays(event: string) {
  const data = { subscription: { subscription_code: code }, nonce: randomUUID() };
  await enqueuePaystackEvent(Buffer.from(JSON.stringify({ event, data })), event, data);
  await prisma.paystackEvent.updateMany({ where: { handledAt: null, payload: { path: ["subscription", "subscription_code"], equals: code } }, data: { nextTryAt: OURS } });
  delivered.length = 0;
  await processPaystackEvents(new Date(OURS.getTime() + 1000));
  // A handler that threw writes nothing, and "still locked" would then pass
  // for the wrong reason.
  const unhandled = await prisma.paystackEvent.count({ where: { handledAt: null, payload: { path: ["subscription", "subscription_code"], equals: code } } });
  assert.equal(unhandled, 0, `the ${event} event was reconciled`);
}
const attention = (nextPaymentDate: Date | null = null) => {
  subscription = { ...subscription, status: "attention", next_payment_date: nextPaymentDate?.toISOString() ?? null };
};
const lastNotice = () => prisma.mailDelivery.findFirst({ where: { toEmail: email }, orderBy: { createdAt: "desc" } });
const quoted = () => /payment \(([^)]+)\)/.exec(readable(delivered[0] ?? ""))?.[1];

const client = await prisma.client.create({ data: { name: mark } });
const product = await prisma.product.create({ data: { key: `${mark}-product`, name: `${mark} product`, monthlyPrice: 1 } });

try {
  // A Business customer paying in dollars, in their introductory months: the
  // Paystack plan charges $25 a month until the step-up to $45.
  const purchase = await prisma.websitePurchase.create({ data: {
    clientId: client.id, productId: product.id, tier: "MANAGED", status: "ACTIVE", billingState: "ACTIVE",
    businessName: "Dunning Shop", contactName: "Ama Dunning", email, billingEmail: email, websiteUrl: "https://dunning.example.test",
    compatibilityStatus: "COMPATIBLE", monthlyPrice: 25, standardRecurringPrice: 45, setupPrice: 0, currency: "USD",
    providerPlanCode: planCode, providerSubscriptionCode: code, setupPaidAt: daysAgo(40), activatedAt: daysAgo(40),
  } });
  subscription = {
    domain: "test", subscription_code: code, status: "active", email_token: "check-token", next_payment_date: null,
    customer: { email }, plan: { plan_code: planCode, amount: 2500, currency: "USD", interval: "monthly" },
  };
  const row = () => prisma.websitePurchase.findUniqueOrThrow({ where: { id: purchase.id } });
  // Both dates moved together, as the days passing would move them.
  const pastDueFor = async (days: number) => {
    const since = daysAgo(days);
    await prisma.$executeRaw`UPDATE "WebsitePurchase" SET "pastDueSince" = ${since}, "updatedAt" = ${since} WHERE "id" = ${purchase.id}`;
    return since;
  };

  /* ----------------------------- past due with no paid-up date, over time -- */

  console.log("\nPast due with no paid-up date, through further Paystack events");
  await check("the day it goes past due: the date is kept, the first notice goes out, editing stays open", async () => {
    attention();
    const before = Date.now();
    await paystackSays("invoice.payment_failed");
    const after = await row();
    assert.equal(after.billingState, "PAST_DUE");
    assert.ok(after.pastDueSince && after.pastDueSince.getTime() >= before - 1000 && after.pastDueSince.getTime() <= Date.now(), "past due since now");
    assert.equal(await editingLockedForNonPayment(purchase.id), false);
    assert.equal(delivered.length, 1, "one notice reached the mail server");
    assert.equal((await lastNotice())?.category, "billing:past-due-1");
  });
  await check("a further event that day keeps the date it went past due", async () => {
    const first = (await row()).pastDueSince;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await paystackSays("invoice.update");
    assert.deepEqual((await row()).pastDueSince, first);
    assert.equal((await lastNotice())?.category, "billing:past-due-1");
  });
  await check("six days in, the next declined charge sends the second notice — not the first again", async () => {
    const since = await pastDueFor(6);
    await paystackSays("invoice.payment_failed");
    assert.equal((await lastNotice())?.category, "billing:past-due-2");
    assert.equal((await lastNotice())?.subject, "Still declined — please update your card");
    assert.equal((await row()).pastDueSince?.getTime(), since.getTime());
    assert.equal(await editingLockedForNonPayment(purchase.id), false);
  });
  await check("twenty days in, editing is paused — and stays paused through a further invoice.create", async () => {
    const since = (await pastDueFor(20)).getTime();
    assert.equal(await editingLockedForNonPayment(purchase.id), true, "locked before the event");
    await paystackSays("invoice.create");
    assert.equal(await editingLockedForNonPayment(purchase.id), true, "still locked after it");
    assert.equal((await row()).pastDueSince?.getTime(), since, "the date it went past due did not move");
    assert.ok(Date.now() - (await row()).updatedAt.getTime() < 60_000, "although the row itself was written");
  });
  await check("…and through another declined charge, which sends the third notice, saying editing is paused", async () => {
    await paystackSays("invoice.payment_failed");
    assert.equal(await editingLockedForNonPayment(purchase.id), true);
    const notice = await lastNotice();
    assert.equal(notice?.category, "billing:past-due-3");
    assert.equal(notice?.subject, "Editing paused — payment still outstanding");
    assert.match(readable(delivered[0] ?? ""), /editing is paused on your account/);
  });
  await check("the date it went past due decides, not the last write — a recent spell is not locked by an old row", async () => {
    await prisma.$executeRaw`UPDATE "WebsitePurchase" SET "pastDueSince" = ${daysAgo(3)}, "updatedAt" = ${daysAgo(30)} WHERE "id" = ${purchase.id}`;
    assert.equal(await editingLockedForNonPayment(purchase.id), false);
  });
  await check("paying up leaves past due and clears the date, with no notice", async () => {
    await pastDueFor(20);
    subscription = { ...subscription, status: "active", next_payment_date: new Date(Date.now() + 25 * DAY).toISOString() };
    await paystackSays("invoice.update");
    const after = await row();
    assert.equal(after.billingState, "ACTIVE");
    assert.equal(after.pastDueSince, null);
    assert.equal(await editingLockedForNonPayment(purchase.id), false);
    assert.equal(delivered.length, 0, "nothing was sent");
  });
  await check("going past due again starts a new fortnight, not the old one", async () => {
    // Paystack's date is in the future here, so the paid-up date cannot be
    // what is being counted; clear it as a subscription that never had one.
    await prisma.websitePurchase.update({ where: { id: purchase.id }, data: { nextBillingAt: null } });
    attention();
    await paystackSays("invoice.payment_failed");
    const after = await row();
    assert.equal(after.billingState, "PAST_DUE");
    assert.ok(after.pastDueSince && Date.now() - after.pastDueSince.getTime() < 60_000, "past due since now");
    assert.equal(await editingLockedForNonPayment(purchase.id), false);
    assert.equal((await lastNotice())?.category, "billing:past-due-1");
  });

  /* ------------------------------------------- a paid-up date, as before -- */

  console.log("\nA paid-up date, where Paystack gives one");
  await check("is what the fortnight runs from, over a recent past-due date", async () => {
    const paidUpTo = daysAgo(15);
    attention(paidUpTo);
    await paystackSays("invoice.payment_failed");
    assert.equal((await row()).nextBillingAt?.getTime(), paidUpTo.getTime());
    assert.equal(await editingLockedForNonPayment(purchase.id), true);
    assert.equal((await lastNotice())?.category, "billing:past-due-3");
  });
  await check("…and a recent one keeps editing open, however long ago it went past due", async () => {
    await prisma.$executeRaw`UPDATE "WebsitePurchase" SET "nextBillingAt" = ${daysAgo(3)}, "pastDueSince" = ${daysAgo(30)}, "updatedAt" = ${daysAgo(30)} WHERE "id" = ${purchase.id}`;
    assert.equal(await editingLockedForNonPayment(purchase.id), false);
  });
  await check("a past-due row with neither date still locks a fortnight after its last write, never sooner", async () => {
    await prisma.$executeRaw`UPDATE "WebsitePurchase" SET "nextBillingAt" = NULL, "pastDueSince" = NULL, "updatedAt" = ${daysAgo(15)} WHERE "id" = ${purchase.id}`;
    assert.equal(await editingLockedForNonPayment(purchase.id), true);
    await prisma.$executeRaw`UPDATE "WebsitePurchase" SET "updatedAt" = ${daysAgo(13)} WHERE "id" = ${purchase.id}`;
    assert.equal(await editingLockedForNonPayment(purchase.id), false);
  });
  await check("…and the next event gives it a date from that write, so the fortnight is not restarted", async () => {
    const lastWrite = daysAgo(16);
    await prisma.$executeRaw`UPDATE "WebsitePurchase" SET "updatedAt" = ${lastWrite} WHERE "id" = ${purchase.id}`;
    attention();
    await paystackSays("invoice.create");
    assert.equal((await row()).pastDueSince?.getTime(), lastWrite.getTime());
    assert.equal(await editingLockedForNonPayment(purchase.id), true);
  });

  /* -------------------------------------------- the amount it quotes ---- */

  console.log("\nThe amount a declined-payment notice quotes");
  const noticeFor = async (data: Record<string, unknown>) => {
    await prisma.websitePurchase.update({ where: { id: purchase.id }, data: { billingState: "PAST_DUE", pastDueSince: new Date(), ...data } });
    delivered.length = 0;
    await sendDunningNotice(purchase.id);
    assert.equal(delivered.length, 1, "one notice reached the mail server");
    return readable(delivered[0]!);
  };
  await check("a dollar Business plan in its first months is quoted what it charges: $25/mo", async () => {
    const text = await noticeFor({ currency: "USD", billingCycle: "monthly", monthlyPrice: 25, standardRecurringPrice: 45, billingPriceUpdatedAt: null });
    assert.equal(quoted(), "$25/mo");
    assert.ok(!text.includes("$45"), "not the standard price it has not reached");
  });
  await check("…and $45/mo once the plan has been stepped up at Paystack", async () => {
    await noticeFor({ billingPriceUpdatedAt: daysAgo(10) });
    assert.equal(quoted(), "$45/mo");
  });
  await check("an annual plan is quoted per year, at the price it renews at", async () => {
    const text = await noticeFor({ billingCycle: "annual", monthlyPrice: 25, standardRecurringPrice: 450, billingPriceUpdatedAt: null });
    assert.equal(quoted(), "$450/yr");
    assert.ok(!/\/mo\b/.test(text), "nothing a month");
    assert.match(text, /this year's/i);
  });
  await check("a cedi plan is quoted the amount stored on it, not today's rate", async () => {
    // At today's rate of 15 the list price would read GHS 375 (and 675).
    const text = await noticeFor({ currency: "GHS", billingCycle: "monthly", monthlyPrice: 300, standardRecurringPrice: 540, billingPriceUpdatedAt: null });
    assert.equal(quoted(), "GHS 300/mo");
    assert.ok(!/\(\$\d/.test(text), "no dollar figure in a cedi customer's notice");
    assert.ok(!/GHS 375|GHS 675/.test(text), "nothing recomputed at the current rate");
  });
  await check("…in pesewas where the stored amount has them", async () => {
    await noticeFor({ monthlyPrice: 312.5 });
    assert.equal(quoted(), "GHS 312.50/mo");
  });
  await check("a dollar plan's notice holds no cedi figure", async () => {
    const text = await noticeFor({ currency: "USD", monthlyPrice: 25 });
    assert.equal(quoted(), "$25/mo");
    assert.ok(!/GHS/.test(text));
  });
} finally {
  globalThis.fetch = originalFetch;
  await new Promise<void>((resolve) => sink.close(() => resolve()));
  await prisma.paystackEvent.deleteMany({ where: { payload: { path: ["subscription", "subscription_code"], equals: code } } });
  await prisma.mailDelivery.deleteMany({ where: { toEmail: email } });
  await prisma.websitePurchase.deleteMany({ where: { clientId: client.id } });
  await prisma.client.deleteMany({ where: { id: client.id } });
  await prisma.product.deleteMany({ where: { id: product.id } });
  await prisma.$disconnect();
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
