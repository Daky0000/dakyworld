/**
 * The pre-send checklist, on the letters nobody typed.
 *
 * `coldEmailChecks.preSendCheck` ran in exactly two places — the composer's
 * draft routes — and nothing server-side read its verdict. An agent's
 * `email.draft` handed the model's words to `composeMessage` and returned the
 * whole row; `email.send`'s approval card said only "Send X to Y"; and a
 * sequence step was composed and sent in the same breath. So a first letter
 * reading "Hi {{first_nme}}" could leave this company with no person and no
 * check between the model and the prospect, while the architecture notes said
 * the checklist "blocks a send".
 *
 * What is asserted, in the order the letter travels:
 *
 *  - **The draft result carries the verdict, not the letter.** One ToolCall
 *    row, the row DRAFT, `checks.sendable` false naming the merge field, and
 *    no `bodyHtml` — the agent's own words re-sent on every later turn.
 *  - **Advisory by default.** With `flags.deliverables` off the same letter
 *    goes, exactly as it did before this file existed.
 *  - **Held when the flag is on**, and held properly: FAILED with the labels
 *    on the row, nothing delivered, and the scheduler does not pick it up again
 *    — a refusal that SCHEDULED would retry every minute for ever.
 *  - **The card says so.** The preview names "blocking" for a bad first letter
 *    and "sendable" for a clean one; a clean invoice's card is untouched.
 *
 * The negatives are half of it, and they are the ones that would make this a
 * worse system rather than a stricter one: a clean first letter still goes
 * with the flag on (the stored text carries a signature, a footer and an
 * unsubscribe link with a `?` in it, and none of that may count against the
 * words); a follow-up and an invoice with the same fault are reported on and
 * never held; the composer's own Send button still sends a letter with
 * blocking items, because a person is advisory; a scheduled row a person
 * composed is theirs, even one the composer's drafter wrote; and a held
 * sequence step does not jam the enrolment behind it.
 *
 * A database, a fake SMTP server and a fake Perplexity on localhost. No key,
 * no network.
 *   npx tsx checks/sendGuard.ts
 */
import net from "node:net";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

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

// --- A mail server that accepts everything and counts it ---------------------
//
// Copied from checks/mailRetry.ts. `delivered` is the number this file is
// about: a refusal that still reached the socket is not a refusal.

let delivered = 0;
const smtp = net.createServer((socket) => {
  socket.write("220 fake ESMTP\r\n");
  let data = false;
  socket.on("data", (chunk) => {
    for (const line of chunk.toString().split("\r\n").filter(Boolean)) {
      if (data) {
        if (line === ".") {
          data = false;
          delivered += 1;
          socket.write("250 2.0.0 Ok: queued\r\n");
        }
        continue;
      }
      const cmd = line.slice(0, 4).toUpperCase();
      if (cmd === "EHLO" || cmd === "HELO") socket.write("250-fake\r\n250 AUTH PLAIN LOGIN\r\n");
      else if (cmd === "AUTH") socket.write("235 2.7.0 ok\r\n");
      else if (cmd === "DATA") {
        data = true;
        socket.write("354 go\r\n");
      } else if (cmd === "QUIT") {
        socket.write("221 bye\r\n");
        socket.end();
      } else socket.write("250 ok\r\n");
    }
  });
});
await new Promise<void>((resolve) => smtp.listen(0, "127.0.0.1", resolve));
const smtpPort = (smtp.address() as AddressInfo).port;

// --- A fake Perplexity, for the one tool here that calls a model ------------

function fakePerplexity(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      req.on("data", () => undefined);
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    body: "Hi {{first_nme}} — Dan from DakyXTech. The phone number on your site cannot be tapped. Want the screenshot?",
                    rationale: "Opened on the observation.",
                    confidence: 0.7,
                  }),
                },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 400, completion_tokens: 40 },
            search_results: [],
          }),
        );
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
  });
}
const perplexity = await fakePerplexity();

// The environment beats the database for every one of these, so a stray
// FLAG_DELIVERABLES in the shell would decide every case below on its own.
delete process.env.FLAG_DELIVERABLES;
Object.assign(process.env, {
  SMTP_HOST: "127.0.0.1",
  SMTP_PORT: String(smtpPort),
  SMTP_SECURE: "false",
  SMTP_USER: "u@sendguard.test",
  SMTP_PASSWORD: "p",
  MAIL_FROM_EMAIL: "u@sendguard.test",
  MAIL_TRANSPORT: "SMTP",
  PERPLEXITY_BASE_URL: perplexity.url,
});

const { prisma } = await import("../src/lib/prisma.js");
const { invokeTool } = await import("../src/services/tools/invoke.js");
const { clearReadinessCache } = await import("../src/services/tools/readiness.js");
const { checklistFor, composeMessage, dispatchDueEmails, sendMessage } = await import("../src/services/emailSender.js");
const { runDueSequences } = await import("../src/services/emailSequences.js");
const { approve } = await import("../src/services/approvals.js");
const { preSendCheck } = await import("../src/services/coldEmailChecks.js");
const { FLAG, setFlag } = await import("../src/lib/featureFlags.js");
const { SETTING, deleteSetting, setSetting } = await import("../src/lib/settings.js");

const MARK = "sendguardcheck";
const AGENT_KEY = "check.sendguard";
const DOMAIN = "sendguard.example.invalid";
const startedAt = new Date();

const previousFlag = await prisma.appSetting.findUnique({ where: { key: FLAG.DELIVERABLES } });
const previousKey = await prisma.appSetting.findUnique({ where: { key: SETTING.PERPLEXITY_KEY } });

/** Deletes everything this run made. The final call is this, and it only deletes. */
async function reset() {
  const leads = await prisma.lead.findMany({ where: { contactName: { endsWith: MARK } }, select: { id: true } });
  const leadIds = leads.map((lead) => lead.id);
  const sequences = await prisma.emailSequence.findMany({ where: { name: { startsWith: MARK } }, select: { id: true } });
  const sequenceIds = sequences.map((sequence) => sequence.id);
  await prisma.emailMessage.deleteMany({ where: { OR: [{ toEmail: { endsWith: DOMAIN } }, { leadId: { in: leadIds } }] } });
  await prisma.emailEnrollment.deleteMany({ where: { sequenceId: { in: sequenceIds } } });
  await prisma.emailSequenceStep.deleteMany({ where: { sequenceId: { in: sequenceIds } } });
  await prisma.emailSequence.deleteMany({ where: { id: { in: sequenceIds } } });
  await prisma.communication.deleteMany({ where: { leadId: { in: leadIds } } });
  await prisma.mailDelivery.deleteMany({ where: { toEmail: { endsWith: DOMAIN } } });
  await prisma.toolCall.deleteMany({ where: { agentKey: AGENT_KEY } });
  await prisma.actionRequest.deleteMany({ where: { agentKey: AGENT_KEY } });
  await prisma.llmCall.deleteMany({ where: { purpose: "message.draft", createdAt: { gte: startedAt } } });
  await prisma.agent.deleteMany({ where: { key: AGENT_KEY } });
  await prisma.lead.deleteMany({ where: { id: { in: leadIds } } });
  await prisma.user.deleteMany({ where: { email: `person@${DOMAIN}` } });
}

async function flag(on: boolean) {
  await setFlag(FLAG.DELIVERABLES, on);
}

let leadCount = 0;
async function makeLead(first = "Ama") {
  leadCount += 1;
  return prisma.lead.create({
    data: {
      contactName: `${first} ${MARK}`,
      companyName: `Osu Bakery ${leadCount}`,
      contactEmail: `owner${leadCount}@${DOMAIN}`,
      source: "OUTREACH",
    },
  });
}

const as = { agentKey: AGENT_KEY, userId: null, dryRun: false } as const;
const toolCalls = (tool: string) => prisma.toolCall.count({ where: { agentKey: AGENT_KEY, tool } });

// The two letters every case below is built from. The clean one is written the
// way the doctrine asks — the observation first, DakyXTech named in the first
// lines, one question, no price — and is long enough to sit in the length band
// on its own words, so a signature or a footer counted against it would show.
const CLEAN_SUBJECT = "your contact page";
const CLEAN_BODY = `Hi {{first_name}},

I was on the Osu Bakery website this morning and noticed the phone number on the contact page cannot be tapped on a mobile, so somebody ordering a cake has to copy it out by hand. I'm Dan from DakyXTech, a small web studio in Accra.

It is a small fix and it is usually the page people open just before they decide to call. When the number is plain text, the ones in a hurry tend to give up and try the next bakery on the list instead.

Would it help if I sent you a screenshot showing exactly where it happens?

Dan`;
const BAD_SUBJECT = "your contact page";
const BAD_BODY = CLEAN_BODY.replace("Hi {{first_name}},", "Hi {{first_nme}},");

await reset();
await flag(false);
await setSetting(SETTING.PERPLEXITY_KEY, "pplx-check-send-guard", { secret: true });
clearReadinessCache();
await prisma.agent.create({
  data: {
    key: AGENT_KEY,
    name: "Send Guard Check",
    title: "Harness",
    tier: "SUB_AGENT",
    department: "TECHNOLOGY",
    status: "ACTIVE",
    mission: "Exists for the duration of one test run.",
    autonomyLevel: 4,
    dryRun: false,
    toolkit: ["email.draft", "email.send", "message.draft"],
  },
});
// Somebody signed in, for the one case that turns on a person having composed it.
const person = await prisma.user.create({ data: { email: `person@${DOMAIN}`, name: "Send Guard Person" } });

try {
  // --- 0. One verdict, whichever path asks ------------------------------------
  console.log("\nThe stored letter reads as the composer read it");
  {
    const lead = await makeLead();
    const clean = await composeMessage({ subject: CLEAN_SUBJECT, body: CLEAN_BODY, purpose: "COLD_OUTREACH", kind: "AI_DRAFT", leadId: lead.id });
    const routeArgs = (body: string) =>
      preSendCheck({ subject: CLEAN_SUBJECT, body, firstEmail: true, optOutAppended: true, channel: "EMAIL" });
    check("the composer's arguments call the clean letter sendable", routeArgs(CLEAN_BODY.replace("{{first_name}}", "Ama")).sendable);
    check(
      "the stored copy carries a footer link with a ? in it",
      (clean.bodyText.match(/\?/g) ?? []).length >= 2 && clean.bodyText.includes("\n--\n"),
      `${(clean.bodyText.match(/\?/g) ?? []).length} question marks`,
    );
    const stored = await checklistFor(clean);
    check("and the stored copy is still sendable", stored.sendable, JSON.stringify(stored.blocking));
    check(
      "with exactly one question counted — the footer's is not the writer's",
      stored.checks.find((one) => one.id === "one-question")?.passed === true,
      stored.checks.find((one) => one.id === "one-question")?.detail,
    );
    check(
      "and the signature and footer not counted as words",
      stored.checks.find((one) => one.id === "length")?.passed === true,
      stored.checks.find((one) => one.id === "length")?.detail,
    );
    check("a resolved {{first_name}} is not a merge-field failure", !stored.blocking.some((one) => one.id === "merge-fields"));

    const bad = await composeMessage({ subject: BAD_SUBJECT, body: BAD_BODY, purpose: "COLD_OUTREACH", kind: "AI_DRAFT", leadId: lead.id });
    const both = [routeArgs(BAD_BODY), await checklistFor(bad)];
    check(
      "an unresolved {{first_nme}} fails both ways",
      both.every((report) => !report.sendable && report.blocking.some((one) => one.id === "merge-fields")),
    );

    // A client's letter answers to the merge field and nothing else: it has no
    // opt-out and no question by design, and an agent told it "must" add one
    // would make the letter worse.
    const invoice = await composeMessage({
      subject: "Invoice 14 is due on Friday",
      body: "Hi {{first_name}},\n\nA reminder that invoice 14 is due on Friday. The link to pay is in the earlier email.\n\nThanks,\nDan",
      purpose: "INVOICE_REMINDER",
      kind: "AI_DRAFT",
      leadId: lead.id,
    });
    const invoiceReport = await checklistFor(invoice);
    check("a clean invoice reminder is sendable", invoiceReport.sendable, JSON.stringify(invoiceReport.blocking));
    check(
      "and is never told to carry an opt-out or a question",
      !invoiceReport.checks.some((one) => one.id === "opt-out" || one.id === "one-question"),
      invoiceReport.checks.map((one) => one.id).join(", "),
    );
  }

  // --- 1. The draft result ----------------------------------------------------
  console.log("\nemail.draft hands back the verdict, not the letter");
  const lead = await makeLead();
  const draftCallsBefore = await toolCalls("email.draft");
  const drafted = await invokeTool("email.draft", { subject: BAD_SUBJECT, body: BAD_BODY, leadId: lead.id, purpose: "COLD_OUTREACH" }, as);
  const out = drafted.output as Record<string, any> | null;
  check("the draft call succeeded", drafted.ok && Boolean(out?.id), drafted.error);
  check("exactly one ToolCall row for it", (await toolCalls("email.draft")) - draftCallsBefore === 1);
  const badRow = out?.id ? await prisma.emailMessage.findUnique({ where: { id: out.id } }) : null;
  check("the row exists as a DRAFT", badRow?.status === "DRAFT", badRow?.status);
  check("checks.sendable is false", out?.checks?.sendable === false);
  check(
    "naming the merge field",
    (out?.checks?.blocking ?? []).some((one: { id: string; detail: string }) => one.id === "merge-fields" && one.detail.includes("{{first_nme}}")),
    JSON.stringify(out?.checks?.blocking),
  );
  check("the result carries no bodyHtml and no bodyText", out !== null && !("bodyHtml" in out) && !("bodyText" in out));
  check("it still carries the subject the living context reads", out?.subject === BAD_SUBJECT);
  check("and says the verdict is advice while the flag is off", out?.checks?.holdsTheSend === false && /advisory/i.test(out?.checks?.note ?? ""));
  const recorded = await prisma.toolCall.findFirst({ where: { agentKey: AGENT_KEY, tool: "email.draft" }, orderBy: { createdAt: "desc" } });
  check("the ToolCall record carries the verdict too", JSON.stringify(recorded?.output ?? {}).includes("merge-fields"));

  // --- 2. The card ------------------------------------------------------------
  console.log("\nThe approval card says what the checklist found");
  const cleanDraft = await invokeTool("email.draft", { subject: CLEAN_SUBJECT, body: CLEAN_BODY, leadId: lead.id, purpose: "COLD_OUTREACH" }, as);
  const cleanId = (cleanDraft.output as { id?: string } | null)?.id ?? "";
  check("a clean draft reads sendable at once", (cleanDraft.output as any)?.checks?.sendable === true, JSON.stringify((cleanDraft.output as any)?.checks));

  const badCard = await invokeTool("email.send", { messageId: out?.id }, { ...as, dryRun: true });
  check("a bad first letter's preview says blocking", /blocking/.test(badCard.wouldDo ?? ""), badCard.wouldDo);
  check("and that it is advisory while the flag is off", /advisory/.test(badCard.wouldDo ?? ""), badCard.wouldDo);
  check("and names the field", (badCard.wouldDo ?? "").includes("{{first_nme}}"), badCard.wouldDo);
  const card = badCard.actionRequestId ? await prisma.actionRequest.findUnique({ where: { id: badCard.actionRequestId } }) : null;
  check("the filed approval carries the same sentence", Boolean(card?.wouldDo.includes("blocking")), card?.wouldDo);

  const cleanCard = await invokeTool("email.send", { messageId: cleanId }, { ...as, dryRun: true });
  check("a clean first letter's preview says sendable", /sendable/.test(cleanCard.wouldDo ?? "") && !/blocking/.test(cleanCard.wouldDo ?? ""), cleanCard.wouldDo);

  await flag(true);
  const heldCard = await invokeTool("email.send", { messageId: out?.id }, { ...as, dryRun: true });
  check("with the flag on, the card says it will be refused", /will be refused unless the draft is edited/.test(heldCard.wouldDo ?? ""), heldCard.wouldDo);
  await flag(false);

  // A client letter's card is exactly what it was, when there is nothing to say.
  const invoice = await composeMessage({
    subject: "Invoice 14 is due on Friday",
    body: "Hi {{first_name}},\n\nA reminder that invoice 14 is due on Friday.\n\nThanks,\nDan",
    purpose: "INVOICE_REMINDER",
    kind: "AI_DRAFT",
    leadId: lead.id,
  });
  const invoiceCard = await invokeTool("email.send", { messageId: invoice.id }, { ...as, dryRun: true });
  check(
    "a clean non-cold preview is byte-identical to before",
    invoiceCard.wouldDo === `Send “${invoice.subject}” to ${invoice.toEmail} — currently DRAFT.`,
    invoiceCard.wouldDo,
  );
  const flawedInvoice = await composeMessage({
    subject: "Invoice 14 is due on Friday",
    body: "Hi {{first_nme}},\n\nA reminder that invoice 14 is due on Friday.\n\nThanks,\nDan",
    purpose: "INVOICE_REMINDER",
    kind: "AI_DRAFT",
    leadId: lead.id,
  });
  const flawedInvoiceCard = await invokeTool("email.send", { messageId: flawedInvoice.id }, { ...as, dryRun: true });
  check(
    "a flawed one says so, as advice",
    /advisory/.test(flawedInvoiceCard.wouldDo ?? "") && (flawedInvoiceCard.wouldDo ?? "").includes("{{first_nme}}"),
    flawedInvoiceCard.wouldDo,
  );

  // --- 3. Sending, flag off: nothing changed ------------------------------------
  console.log("\nFlag off: the checklist advises and the letter goes");
  delivered = 0;
  const sendCallsBefore = await toolCalls("email.send");
  const sentAnyway = await invokeTool("email.send", { messageId: out?.id }, as);
  check("email.send of the bad draft delivers 1", delivered === 1, `${delivered} delivered`);
  check("one ToolCall row for the send", (await toolCalls("email.send")) - sendCallsBefore === 1);
  check("and the send result carries the verdict as advice", (sentAnyway.output as any)?.checks?.sendable === false && (sentAnyway.output as any)?.checks?.holdsTheSend === false);

  // --- 4. Sending, flag on: a first letter that fails is held -------------------
  console.log("\nFlag on: a failing first letter is held, and held properly");
  await flag(true);
  const second = await invokeTool("email.draft", { subject: BAD_SUBJECT, body: BAD_BODY, leadId: lead.id, purpose: "COLD_OUTREACH" }, as);
  const secondId = (second.output as { id?: string } | null)?.id ?? "";
  delivered = 0;
  const refused = await invokeTool("email.send", { messageId: secondId }, as);
  const held = await prisma.emailMessage.findUnique({ where: { id: secondId } });
  check("it is refused, as an error naming the field", !refused.ok && (refused.error ?? "").includes("{{first_nme}}"), refused.error);
  check("with a code the ledger can count", (refused.error ?? "").startsWith("CHECKLIST_HELD"), refused.error);
  const refusedRow = refused.callId ? await prisma.toolCall.findUnique({ where: { id: refused.callId } }) : null;
  check("and the ToolCall row says it failed — not a successful call that sent nothing", refusedRow?.ok === false && (refusedRow.error ?? "").includes("No merge field"));
  check("SMTP delivered 0", delivered === 0, `${delivered} delivered`);
  check("the row is FAILED, not SCHEDULED", held?.status === "FAILED", held?.status);
  check("with failedAt set", held?.failedAt instanceof Date);
  check("and an error naming the blocking label", (held?.error ?? "").includes("No merge field is left unresolved"), held?.error ?? "");
  check("nothing was claimed for sending", held?.attempts === 0, `${held?.attempts} attempts`);

  await dispatchDueEmails(new Date(Date.now() + 60_000));
  const after = await prisma.emailMessage.findUnique({ where: { id: secondId } });
  check("the scheduler does not retry it", delivered === 0 && after?.status === "FAILED" && after.attempts === 0);

  // Approving the card does not get round it, and does not call the refusal
  // a success: the request is FAILED with the reason, not EXECUTED.
  const third = await invokeTool("email.draft", { subject: BAD_SUBJECT, body: BAD_BODY, leadId: lead.id, purpose: "COLD_OUTREACH" }, as);
  const thirdCard = await invokeTool("email.send", { messageId: (third.output as { id?: string } | null)?.id }, { ...as, dryRun: true });
  delivered = 0;
  const decided = thirdCard.actionRequestId ? await approve(thirdCard.actionRequestId, { userId: person.id }) : null;
  check("an approved card for a held letter delivers 0", delivered === 0, `${delivered} delivered`);
  check(
    "and the approval is filed FAILED with the reason, not EXECUTED",
    decided?.request.status === "FAILED" && (decided.request.error ?? "").includes("No merge field"),
    `${decided?.request.status}: ${decided?.request.error}`,
  );

  // The positive control: the same flag, a clean first letter, one delivery.
  delivered = 0;
  const cleanSend = await invokeTool("email.send", { messageId: cleanId }, as);
  check("a clean first letter still goes with the flag on", delivered === 1 && (cleanSend.output as any)?.sent === true, `${delivered} delivered`);

  // --- 5. What the flag must not touch ------------------------------------------
  console.log("\nWhat stays advisory with the flag on");
  for (const purpose of ["FOLLOW_UP", "INVOICE_REMINDER"] as const) {
    const flawed = await invokeTool("email.draft", { subject: BAD_SUBJECT, body: BAD_BODY, leadId: lead.id, purpose }, as);
    const id = (flawed.output as { id?: string } | null)?.id ?? "";
    check(`a ${purpose} with the same fault is reported`, (flawed.output as any)?.checks?.sendable === false);
    delivered = 0;
    const went = await invokeTool("email.send", { messageId: id }, as);
    check(`and is not refused`, delivered === 1 && (went.output as any)?.sent === true, `${delivered} delivered, ${(went.output as any)?.reason ?? ""}`);
  }

  const composerDraft = await composeMessage({ subject: BAD_SUBJECT, body: BAD_BODY, purpose: "COLD_OUTREACH", kind: "MANUAL", leadId: lead.id });
  delivered = 0;
  const composerSend = await sendMessage(composerDraft.id);
  check("the composer's sendMessage(id) still sends a letter with blocking items", composerSend.sent && delivered === 1, composerSend.reason);

  // The scheduler: a row a person typed is theirs, and so is one the composer's
  // drafter wrote that a signed-in person read and scheduled — the composer
  // stores that as AI_DRAFT. A row a model wrote with nobody behind it is held.
  const past = new Date(Date.now() - 60_000);
  const typed = await composeMessage({ subject: BAD_SUBJECT, body: BAD_BODY, purpose: "COLD_OUTREACH", kind: "MANUAL", leadId: lead.id, scheduledFor: past });
  const reviewed = await composeMessage({ subject: BAD_SUBJECT, body: BAD_BODY, purpose: "COLD_OUTREACH", kind: "AI_DRAFT", leadId: lead.id, scheduledFor: past, createdById: person.id });
  const written = await composeMessage({ subject: BAD_SUBJECT, body: BAD_BODY, purpose: "COLD_OUTREACH", kind: "AI_DRAFT", leadId: lead.id, scheduledFor: past });
  delivered = 0;
  await dispatchDueEmails();
  const [typedAfter, reviewedAfter, writtenAfter] = await Promise.all([
    prisma.emailMessage.findUnique({ where: { id: typed.id } }),
    prisma.emailMessage.findUnique({ where: { id: reviewed.id } }),
    prisma.emailMessage.findUnique({ where: { id: written.id } }),
  ]);
  check("a scheduled letter a person typed is sent", typedAfter?.status === "SENT", typedAfter?.status);
  check("a drafted letter a person scheduled from the composer is sent", reviewedAfter?.status === "SENT", reviewedAfter?.status);
  check("a scheduled letter a model wrote is held", writtenAfter?.status === "FAILED" && delivered === 2, `${writtenAfter?.status}, ${delivered} delivered`);
  delivered = 0;
  await dispatchDueEmails();
  check("and a second tick leaves it alone", delivered === 0);

  // An agent's draft a person then scheduled from the outbox. The agent wrote
  // it with nobody behind it, so `createdById` was empty, and PATCH /emails/:id
  // set SCHEDULED without saying who — so a minute later the scheduler held
  // the Owner's deliberate decision as though no person had made one. The
  // route mounted as `index.ts` mounts it, with a person signed in.
  console.log("\nA person scheduling an agent's draft from the outbox");
  {
    const express = (await import("express")).default;
    const { emailsRouter } = await import("../src/routes/emails.js");
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.dbUser = person as never;
      req.permissions = new Set(["emails.view", "emails.draft"]);
      next();
    });
    app.use("/api/emails", emailsRouter);
    const api = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => api.once("listening", resolve));
    const patch = async (id: string, body: unknown) => {
      const res = await fetch(`http://127.0.0.1:${(api.address() as AddressInfo).port}/api/emails/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json().catch(() => null)) as any };
    };
    try {
      const drafted = await invokeTool("email.draft", { subject: BAD_SUBJECT, body: BAD_BODY, leadId: lead.id, purpose: "COLD_OUTREACH" }, as);
      const draftId = (drafted.output as { id?: string } | null)?.id ?? "";
      const before = await prisma.emailMessage.findUnique({ where: { id: draftId } });
      check("the agent's draft has nobody behind it", before?.createdById === null && before.kind === "AI_DRAFT", `${before?.createdById}/${before?.kind}`);

      const scheduled = await patch(draftId, { scheduledFor: past.toISOString() });
      check("PATCH schedules it", scheduled.status === 200 && scheduled.body?.status === "SCHEDULED", `${scheduled.status} ${scheduled.body?.status}`);
      check("and records the person who did", scheduled.body?.createdById === person.id, `${scheduled.body?.createdById}`);

      // Edited and scheduled in one go: the words are now the person's too.
      const other = await invokeTool("email.draft", { subject: BAD_SUBJECT, body: BAD_BODY, leadId: lead.id, purpose: "COLD_OUTREACH" }, as);
      const otherId = (other.output as { id?: string } | null)?.id ?? "";
      const edited = await patch(otherId, { body: BAD_BODY.replace("Would it help", "Would it be useful"), scheduledFor: past.toISOString() });
      check("an edit records them as well", edited.status === 200 && edited.body?.createdById === person.id, `${edited.status} ${edited.body?.createdById}`);

      // The negative: a sequence step the sequence scheduled itself, which no
      // person opened, is still a letter nobody read.
      const stepRow = await composeMessage({ subject: BAD_SUBJECT, body: BAD_BODY, purpose: "COLD_OUTREACH", kind: "SEQUENCE", leadId: lead.id, status: "SCHEDULED", scheduledFor: past });

      delivered = 0;
      await dispatchDueEmails();
      const [scheduledAfter, editedAfter, stepAfter] = await Promise.all([
        prisma.emailMessage.findUnique({ where: { id: draftId } }),
        prisma.emailMessage.findUnique({ where: { id: otherId } }),
        prisma.emailMessage.findUnique({ where: { id: stepRow.id } }),
      ]);
      check("an agent's draft a person scheduled is sent, not held", scheduledAfter?.status === "SENT", `${scheduledAfter?.status}: ${scheduledAfter?.error}`);
      check("so is one they edited and scheduled", editedAfter?.status === "SENT", `${editedAfter?.status}: ${editedAfter?.error}`);
      check("a letter the sequence scheduled with nobody opening it is still held", stepAfter?.status === "FAILED" && delivered === 2, `${stepAfter?.status}, ${delivered} delivered`);
    } finally {
      api.close();
    }
  }

  // --- 6. A sequence step -------------------------------------------------------
  console.log("\nA sequence step nobody read");
  async function sequenceStep(purpose: "COLD_OUTREACH" | "FOLLOW_UP") {
    const sequence = await prisma.emailSequence.create({
      data: {
        name: `${MARK} ${purpose}`,
        active: true,
        requireApproval: false,
        weekdaysOnly: false,
        steps: {
          create: [
            { position: 0, delayDays: 0, subject: "your contact page", bodyHtml: CLEAN_BODY.replace("{{first_name}}", "{{typo}}"), useAi: false, purpose },
            { position: 1, delayDays: 3, subject: "the screenshot", bodyHtml: "Hi {{first_name}}, the screenshot is attached. Dan", useAi: false, purpose: "FOLLOW_UP" },
          ],
        },
      },
    });
    const stepLead = await makeLead("Kofi");
    const enrollment = await prisma.emailEnrollment.create({
      data: { sequenceId: sequence.id, leadId: stepLead.id, toEmail: stepLead.contactEmail!, nextPosition: 0, nextSendAt: new Date(Date.now() - 60_000) },
    });
    return { sequence, enrollment };
  }

  await flag(true);
  const onRun = await sequenceStep("COLD_OUTREACH");
  delivered = 0;
  await runDueSequences(new Date());
  const enrolled = await prisma.emailEnrollment.findUnique({ where: { id: onRun.enrollment.id } });
  const stepMessage = await prisma.emailMessage.findFirst({ where: { enrollmentId: onRun.enrollment.id } });
  check("a first-letter step with {{typo}} delivers 0 with the flag on", delivered === 0, `${delivered} delivered`);
  check("the step's letter is FAILED with the reason on it", stepMessage?.status === "FAILED" && (stepMessage.error ?? "").includes("{{typo}}"), `${stepMessage?.status}: ${stepMessage?.error}`);
  check(
    "the enrolment still advanced and is not stuck",
    enrolled?.status === "ACTIVE" && enrolled.nextPosition === 1 && (enrolled.nextSendAt?.getTime() ?? 0) > Date.now(),
    `${enrolled?.status} at ${enrolled?.nextPosition}, next ${enrolled?.nextSendAt?.toISOString()}`,
  );
  delivered = 0;
  await runDueSequences(new Date());
  check("and the next tick sends nothing for it", delivered === 0);

  const followUp = await sequenceStep("FOLLOW_UP");
  delivered = 0;
  await runDueSequences(new Date());
  check("a follow-up step with the same fault is not held", delivered === 1, `${delivered} delivered`);
  await prisma.emailEnrollment.update({ where: { id: followUp.enrollment.id }, data: { status: "COMPLETED", nextSendAt: null } });

  await flag(false);
  await sequenceStep("COLD_OUTREACH");
  delivered = 0;
  await runDueSequences(new Date());
  check("with the flag off the same first-letter step delivers 1", delivered === 1, `${delivered} delivered`);

  // --- 7. message.draft -------------------------------------------------------
  console.log("\nmessage.draft carries the checklist with its channel");
  const phoneCallsBefore = await toolCalls("message.draft");
  const phone = await invokeTool("message.draft", { channel: "WHATSAPP", leadId: lead.id, purpose: "COLD_OUTREACH", prepare: "never" }, as);
  const phoneOut = phone.output as Record<string, any> | null;
  check("the draft came back", phone.ok && typeof phoneOut?.body === "string", phone.error);
  check("one ToolCall row for it", (await toolCalls("message.draft")) - phoneCallsBefore === 1);
  check("it carries checks", typeof phoneOut?.checks?.sendable === "boolean");
  check(
    "which caught the merge field in the chat bubble",
    (phoneOut?.checks?.blocking ?? []).some((one: { id: string }) => one.id === "merge-fields"),
    JSON.stringify(phoneOut?.checks),
  );
  check(
    "and ran with no subject to check, because a WhatsApp has none",
    ![...(phoneOut?.checks?.blocking ?? []), ...(phoneOut?.checks?.warnings ?? [])].some((one: { id: string }) => one.id === "subject"),
  );
  check("a phone message is never held by it", phoneOut?.checks?.holdsTheSend === false);
} finally {
  await reset();
  if (previousFlag) {
    await prisma.appSetting.update({ where: { key: FLAG.DELIVERABLES }, data: { value: previousFlag.value } });
  } else {
    await deleteSetting(FLAG.DELIVERABLES);
  }
  if (previousKey) {
    await prisma.appSetting.update({ where: { key: SETTING.PERPLEXITY_KEY }, data: { value: previousKey.value, secret: previousKey.secret } });
  } else {
    await deleteSetting(SETTING.PERPLEXITY_KEY);
  }
  smtp.close();
  perplexity.server.close();
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const failure of failures) console.log(`  - ${failure}`);
}
await prisma.$disconnect();
process.exit(failures.length ? 1 : 0);
