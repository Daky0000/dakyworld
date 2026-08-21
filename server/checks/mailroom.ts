/**
 * Does the mail room hold?
 *
 * Nine claims about what happens to a message between arriving and being
 * somebody's job. Every one of them was a decision rather than a consequence
 * of the code, and every one is easy to reverse by accident:
 *
 *  1. A message is stored once, however many times the folder is re-read.
 *  2. A reply lands in the conversation it belongs to, by header.
 *  3. A reply is joined to the letter it answers, and through it to the lead.
 *  4. A real reply stops every sequence that person is in.
 *  5. **An out-of-office stops nothing.** The most expensive mistake available
 *     here, and the one a future change is likeliest to reintroduce.
 *  6. Asking to be removed suppresses the address and cancels what is queued.
 *  7. A bounce suppresses the address that *failed*, not `mailer-daemon`.
 *  8. A copy of our own outbound is not an arrival.
 *  9. A message read with low confidence is given to nobody.
 *
 * Everything runs through the real `ingestMessage`, on real RFC822 sources
 * parsed by the real parser — not by hand-built rows, which is a check that
 * goes on passing after the code stops working that way. Triage is skipped,
 * so there is **no model call and no key**: the intents are set the way the
 * headers set them, which is exactly the path a bounce and an out-of-office
 * take in production.
 *
 * Database only. No API key, no network, no Docker beyond Postgres itself.
 *   npx tsx checks/mailroom.ts
 */
import { prisma } from "../src/lib/prisma.js";
import { SETTING, clearSettingsCache, deleteSetting, setSetting } from "../src/lib/settings.js";
import { parseMessage, stripQuotedHistory } from "../src/services/mailbox/parse.js";
import { ingestMessage } from "../src/services/mailbox/ingest.js";
import { destinationFor, routeMessage } from "../src/services/mailbox/router.js";
import { markHandled } from "../src/services/mailbox/actions.js";

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

const MARK = "mailroomcheck";
const US = "dan@mailroomcheck.test";
const OWN = [US, "mailroomcheck.test"];

/**
 * A prospect of this scenario's own.
 *
 * Every scenario gets a fresh address and fresh Message-IDs. Sharing one made
 * two of these checks pass for the wrong reason: `stopOnReply` is keyed on an
 * address, so an earlier scenario's reply was stopping a later scenario's
 * sequence, and a thread key built from a shared root put unrelated messages in
 * one conversation.
 */
function prospect(scenario: string) {
  return {
    them: `owner-${scenario}@prospect-${MARK}.test`,
    sentId: `<sent-${scenario}@${MARK}.test>`,
  };
}

/** UIDs are unique per run so a second run cannot collide with a leftover row. */
let nextUid = 1000;

function rfc822(parts: {
  from: string;
  to: string;
  subject: string;
  body: string;
  messageId: string;
  inReplyTo?: string;
  references?: string;
  extraHeaders?: string[];
}): Buffer {
  const headers = [
    `From: ${parts.from}`,
    `To: ${parts.to}`,
    `Subject: ${parts.subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${parts.messageId}`,
    parts.inReplyTo ? `In-Reply-To: ${parts.inReplyTo}` : null,
    parts.references ? `References: ${parts.references}` : null,
    ...(parts.extraHeaders ?? []),
    "Content-Type: text/plain; charset=utf-8",
  ].filter((line): line is string => line !== null);
  return Buffer.from(`${headers.join("\r\n")}\r\n\r\n${parts.body}\r\n`, "utf8");
}

async function ingest(source: Buffer, folder: "INBOX" | "SENT" = "INBOX") {
  const parsed = await parseMessage(source, new Date());
  nextUid += 1;
  return ingestMessage({ parsed, folder, uid: nextUid, uidValidity: 1n, own: OWN, skipTriage: true });
}

/**
 * Deletes everything this run made.
 *
 * Called at the start and at the end, and the final call is the delete-only
 * half — a reset that also creates would re-make on the way out exactly what
 * it was there to remove.
 */
async function reset() {
  await prisma.mailMessage.deleteMany({ where: { OR: [{ fromEmail: { contains: MARK } }, { subject: { contains: MARK } }] } });
  await prisma.mailThread.deleteMany({ where: { counterpartEmail: { contains: MARK } } });
  await prisma.mailSyncState.deleteMany({ where: { mailbox: { contains: MARK } } });
  await prisma.emailSuppression.deleteMany({ where: { email: { contains: MARK } } });
  await prisma.communication.deleteMany({ where: { summary: { contains: MARK } } });

  const enrolments = await prisma.emailEnrollment.findMany({ where: { toEmail: { contains: MARK } }, select: { id: true } });
  await prisma.emailMessage.deleteMany({ where: { enrollmentId: { in: enrolments.map((row) => row.id) } } });
  await prisma.emailEnrollment.deleteMany({ where: { toEmail: { contains: MARK } } });
  await prisma.emailMessage.deleteMany({ where: { toEmail: { contains: MARK } } });
  await prisma.emailSequenceStep.deleteMany({ where: { sequence: { name: { contains: MARK } } } });
  await prisma.emailSequence.deleteMany({ where: { name: { contains: MARK } } });

  const leads = await prisma.lead.findMany({ where: { contactEmail: { contains: MARK } }, select: { id: true } });
  const leadIds = leads.map((lead) => lead.id);
  if (leadIds.length > 0) {
    await prisma.communication.deleteMany({ where: { leadId: { in: leadIds } } });
    await prisma.emailMessage.deleteMany({ where: { leadId: { in: leadIds } } });
    await prisma.lead.deleteMany({ where: { id: { in: leadIds } } });
  }
}

/** The addresses that are "us", which is what tells an arrival from our own post. */
async function settings() {
  await setSetting(SETTING.MAIL_OWN_DOMAINS, OWN.join(","));
  await setSetting(SETTING.MAIL_TRIAGE, "false");
  clearSettingsCache();
}

async function makeLeadInASequence(scenario: string) {
  const { them, sentId } = prospect(scenario);
  const lead = await prisma.lead.create({
    data: { contactName: "A Prospect", contactEmail: them, companyName: `Prospect ${MARK}`, status: "NEW" },
  });

  const sequence = await prisma.emailSequence.create({
    data: {
      name: `Check sequence ${scenario} ${MARK}`,
      trigger: "MANUAL",
      stopOnReply: true,
      active: true,
      steps: {
        create: [
          { position: 1, delayDays: 0, subject: `First ${MARK}`, bodyHtml: "<p>one</p>" },
          { position: 2, delayDays: 3, subject: `Second ${MARK}`, bodyHtml: "<p>two</p>" },
        ],
      },
    },
    include: { steps: true },
  });

  const enrollment = await prisma.emailEnrollment.create({
    data: {
      sequenceId: sequence.id,
      leadId: lead.id,
      toEmail: them,
      status: "ACTIVE",
      nextPosition: 2,
      nextSendAt: new Date(Date.now() + 86_400_000),
    },
  });

  // The letter they are answering, and the one still queued behind it.
  const sent = await prisma.emailMessage.create({
    data: {
      subject: `About your website ${MARK}`,
      bodyHtml: "<p>hello</p>",
      bodyText: "hello",
      toEmail: them,
      status: "SENT",
      sentAt: new Date(),
      messageId: sentId,
      leadId: lead.id,
      enrollmentId: enrollment.id,
    },
  });
  const queued = await prisma.emailMessage.create({
    data: {
      subject: `Following up ${MARK}`,
      bodyHtml: "<p>again</p>",
      bodyText: "again",
      toEmail: them,
      status: "SCHEDULED",
      scheduledFor: new Date(Date.now() + 86_400_000),
      leadId: lead.id,
      enrollmentId: enrollment.id,
    },
  });

  return { lead, sequence, enrollment, sent, queued, them, sentId };
}

// --- The checks -------------------------------------------------------------

async function aRealReplyIsFiledAndStopsTheChase() {
  const { lead, enrollment, sent, queued, them, sentId } = await makeLeadInASequence("reply");

  const reply = rfc822({
    from: `A Prospect <${them}>`,
    to: US,
    subject: `Re: About your website ${MARK}`,
    messageId: `<reply-1@prospect-${MARK}.test>`,
    inReplyTo: sentId,
    references: sentId,
    body: [
      "Yes please, that sounds useful. Can you send the screenshot?",
      "",
      "On Tue, 12 Aug 2026 at 09:14, Dan <dan@mailroomcheck.test> wrote:",
      "> I was looking at your website before writing and noticed the contact",
      "> form does not work on a phone.",
    ].join("\n"),
  });

  const first = await ingest(reply);
  check("a reply is filed as inbound", first.fresh && first.message.direction === "INBOUND", first.message.direction);
  check("it is joined to the letter it answers", first.message.replyToEmailId === sent.id);
  check("and through the address to the lead", first.message.leadId === lead.id);
  check(
    "the quoted history is cut off before anything reads it",
    !first.message.bodyText.includes("contact") && first.message.bodyText.includes("screenshot"),
    first.message.bodyText.slice(0, 120),
  );

  // Claim 1: the same message read twice is one row.
  const again = await ingest(reply);
  check("the same message read twice is stored once", !again.fresh && again.message.id === first.message.id);

  const enrolment = await prisma.emailEnrollment.findUnique({ where: { id: enrollment.id } });
  check("a real reply stops the sequence", enrolment?.status === "STOPPED", enrolment?.status);

  const stillQueued = await prisma.emailMessage.findUnique({ where: { id: queued.id } });
  check("and pulls back the email already queued behind it", stillQueued?.status === "CANCELLED", stillQueued?.status);

  const lead2 = await prisma.lead.findUnique({ where: { id: lead.id } });
  check("the lead moves off New", lead2?.status === "QUALIFYING", lead2?.status);

  const logged = await prisma.communication.count({ where: { leadId: lead.id, type: "EMAIL" } });
  check("the conversation is logged against the lead", logged === 1, String(logged));

  return first;
}

async function anOutOfOfficeStopsNothing() {
  const { enrollment, them, sentId } = await makeLeadInASequence("ooo");

  const away = rfc822({
    from: `A Prospect <${them}>`,
    to: US,
    subject: `Automatic reply: About your website ${MARK}`,
    messageId: `<ooo-1@prospect-${MARK}.test>`,
    inReplyTo: sentId,
    extraHeaders: ["Auto-Submitted: auto-replied", "X-Autoreply: yes"],
    body: "I am out of the office until the 3rd with limited access to email.",
  });

  const result = await ingest(away);
  check("an out-of-office is recognised from its headers", result.message.autoSubmitted);
  check("it is labelled as machine-sent without a model", result.message.intent === "AUTO_REPLY", String(result.message.intent));

  const enrolment = await prisma.emailEnrollment.findUnique({ where: { id: enrollment.id } });
  check("AN OUT-OF-OFFICE DOES NOT STOP THE SEQUENCE", enrolment?.status === "ACTIVE", enrolment?.status);

  const destination = destinationFor("AUTO_REPLY", false);
  check("and it is handed to nobody", destination.agentKey === null);
}

async function askingToBeRemovedIsActedOn() {
  const { enrollment, them } = await makeLeadInASequence("stop");

  const stop = rfc822({
    from: `A Prospect <${them}>`,
    to: US,
    subject: `Re: About your website ${MARK}`,
    messageId: `<stop-1@prospect-${MARK}.test>`,
    body: "Please take me off your list and do not contact me again.",
  });

  await ingest(stop);

  const suppressed = await prisma.emailSuppression.findUnique({ where: { email: them } });
  check("the address is suppressed", suppressed !== null && suppressed.source === "UNSUBSCRIBED", suppressed?.source);

  const enrolment = await prisma.emailEnrollment.findUnique({ where: { id: enrollment.id } });
  check("every sequence they are in stops", enrolment?.status === "STOPPED", enrolment?.status);

  const queued = await prisma.emailMessage.count({ where: { toEmail: them, status: { in: ["DRAFT", "SCHEDULED"] } } });
  check("nothing is left queued for them", queued === 0, String(queued));
}

async function aBounceSuppressesTheAddressThatFailed() {
  const dead = `nobody@dead-${MARK}.test`;
  const bounce = rfc822({
    from: `Mail Delivery Subsystem <mailer-daemon@mailroomcheck.test>`,
    to: US,
    subject: `Undeliverable: About your website ${MARK}`,
    messageId: "<bounce-1@mailroomcheck.test>",
    extraHeaders: ["Auto-Submitted: auto-replied"],
    body: ["Your message could not be delivered.", "", `Final-Recipient: rfc822; ${dead}`, "Action: failed", "Status: 5.1.1"].join("\n"),
  });

  const result = await ingest(bounce);
  check("a bounce is recognised without a model", result.message.intent === "BOUNCE", String(result.message.intent));

  const suppressed = await prisma.emailSuppression.findUnique({ where: { email: dead } });
  check("the address that FAILED is suppressed, not mailer-daemon", suppressed !== null && suppressed.source === "BOUNCED", suppressed?.source);

  const daemon = await prisma.emailSuppression.findUnique({ where: { email: "mailer-daemon@mailroomcheck.test" } });
  check("the daemon's own address is not added to the list", daemon === null);

  await prisma.emailSuppression.deleteMany({ where: { email: { contains: MARK } } });
}

async function ourOwnPostIsNotAnArrival() {
  const { enrollment, sent, them, sentId } = await makeLeadInASequence("sent");

  // What the app itself sent, turning up in Sent a moment later. It carries a
  // Message-ID the outbox already knows, and it must change nothing.
  const ourAutomatedSend = rfc822({
    from: `Dan <${US}>`,
    to: them,
    subject: `About your website ${MARK}`,
    messageId: sent.messageId!,
    body: "hello",
  });
  const mine = await ingest(ourAutomatedSend, "SENT");
  check("a copy of our own send is filed as outbound", mine.message.direction === "OUTBOUND", mine.message.direction);

  const untouched = await prisma.emailEnrollment.findUnique({ where: { id: enrollment.id } });
  check("the app's own send does not stop its own sequence", untouched?.status === "ACTIVE", untouched?.status);

  // Now the other case: the Owner answering from his phone, which the outbox
  // has never heard of. That one *must* stop the chase.
  const byHand = rfc822({
    from: `Dan <${US}>`,
    to: them,
    subject: `Re: About your website ${MARK}`,
    messageId: `<from-my-phone@${MARK}.test>`,
    inReplyTo: sentId,
    body: "Sure — I'll send it over this afternoon.",
  });
  const handwritten = await ingest(byHand, "SENT");
  check("a reply sent by hand is filed as outbound too", handwritten.message.direction === "OUTBOUND");

  const stopped = await prisma.emailEnrollment.findUnique({ where: { id: enrollment.id } });
  check("ANSWERING FROM YOUR OWN WEBMAIL STOPS THE CHASE", stopped?.status === "STOPPED", stopped?.status);
  check("and the conversation is one thread, not two", handwritten.thread.messageCount >= 2, String(handwritten.thread.messageCount));
}

function routingIsATableAnybodyCanRead() {
  check("a client's complaint goes to support", destinationFor("SUPPORT_ISSUE", true).agentKey === "support.desk");
  check("a stranger's interest goes to the follow-up writer", destinationFor("INTERESTED", false).agentKey === "outreach.followup");
  check("the same interest from a client does not", destinationFor("INTERESTED", true).agentKey === "cco");
  check("an invoice query goes to billing", destinationFor("INVOICE_QUERY", false).agentKey === "billing.invoicer");
  check("junk goes to nobody", destinationFor("SPAM", false).agentKey === null);
  check("and something unclear goes to the mail room", destinationFor("OTHER", false).agentKey === "mail.room");
}

/**
 * A model that is not sure does not start work.
 *
 * Asserted against the real router rather than against the constant, because
 * the failure this guards is somebody raising the floor in one place and not
 * the other, and a check that reads the same constant the code reads would go
 * on passing through that.
 */
async function anUnsureReadingGoesToNobody() {
  const { them } = await makeLeadInASequence("unsure");
  const source = rfc822({
    from: `A Prospect <${them}>`,
    to: US,
    subject: `Something ${MARK}`,
    messageId: `<unsure-1@prospect-${MARK}.test>`,
    body: "Following on from the thing we discussed.",
  });
  const ingested = await ingest(source);

  const unsure = await prisma.mailMessage.update({
    where: { id: ingested.message.id },
    data: { triage: "TRIAGED", intent: "INTERESTED", confidence: 0.2, summary: `unclear ${MARK}`, urgency: 2 },
  });
  const held = await routeMessage(unsure, ingested.thread);
  check("a message read without confidence is handed to nobody", held.taskId === null, String(held.taskId));
  check("and the screen is told why", (held.note ?? "").includes("not confidently enough"), held.note ?? "");

  const sure = await prisma.mailMessage.update({ where: { id: unsure.id }, data: { confidence: 0.95 } });
  const routed = await routeMessage(sure, ingested.thread);
  // Whether an agent takes it depends on the roster this database happens to
  // have, so the claim is about the *decision*, not about a task existing.
  check(
    "the same message read confidently is not held back for that reason",
    routed.taskId !== null || !(routed.note ?? "").includes("not confidently enough"),
    routed.note ?? "routed",
  );

  if (routed.taskId) {
    await prisma.agentTaskTransition.deleteMany({ where: { taskId: routed.taskId } });
    await prisma.agentTask.deleteMany({ where: { id: routed.taskId } });
  }
}

async function closingAMessageTwiceCannotBreakTheCount(messageId: string, threadId: string) {
  const before = await prisma.mailThread.findUnique({ where: { id: threadId } });

  await markHandled({ messageId, note: `dealt with ${MARK}` });
  const afterOne = await prisma.mailThread.findUnique({ where: { id: threadId } });

  await markHandled({ messageId, note: `dealt with again ${MARK}` });
  const afterTwo = await prisma.mailThread.findUnique({ where: { id: threadId } });

  check(
    "closing a message drops the unread count",
    (afterOne?.unreadCount ?? 0) === (before?.unreadCount ?? 0) - 1,
    `${before?.unreadCount} then ${afterOne?.unreadCount}`,
  );
  check(
    "closing it twice does not drop it twice",
    afterOne?.unreadCount === afterTwo?.unreadCount,
    `${afterOne?.unreadCount} then ${afterTwo?.unreadCount}`,
  );
  check("and it never goes below zero", (afterTwo?.unreadCount ?? -1) >= 0, String(afterTwo?.unreadCount));
}

function theQuoteCutterIsConservative() {
  const underneath = "> I was asking about the site\n\nSorry for the delay — yes, go ahead please.";
  check(
    "a reply written under the quote is not thrown away",
    stripQuotedHistory(underneath).includes("go ahead"),
    stripQuotedHistory(underneath),
  );

  const mentionsOn = "On the subject of the homepage, I agree with all of it and would like to proceed.";
  check("a sentence that merely starts with “On” is not treated as a quote", stripQuotedHistory(mentionsOn) === mentionsOn);
}

async function main() {
  console.log("The mail room\n=============");
  await reset();
  await settings();

  theQuoteCutterIsConservative();
  const reply = await aRealReplyIsFiledAndStopsTheChase();
  await anOutOfOfficeStopsNothing();
  await askingToBeRemovedIsActedOn();
  await aBounceSuppressesTheAddressThatFailed();
  await ourOwnPostIsNotAnArrival();
  routingIsATableAnybodyCanRead();
  await anUnsureReadingGoesToNobody();
  await closingAMessageTwiceCannotBreakTheCount(reply.message.id, reply.thread.id);

  await reset();
  await deleteSetting(SETTING.MAIL_OWN_DOMAINS);
  await deleteSetting(SETTING.MAIL_TRIAGE);
  clearSettingsCache();

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const name of failures) console.log(`  - ${name}`);
    process.exitCode = 1;
  }
  await prisma.$disconnect();
}

void main().catch(async (err) => {
  console.error(err);
  await reset().catch(() => {});
  await prisma.$disconnect();
  process.exitCode = 1;
});
