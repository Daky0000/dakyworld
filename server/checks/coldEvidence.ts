/**
 * One fault in the letter, the rest in the attachment — and a page for the
 * businesses that have no website at all.
 *
 * Two gaps in the outreach pipeline, both of which produced a worse email than
 * the evidence deserved.
 *
 * **Several red flags became several paragraphs.** Looking properly at a
 * business routinely turns up three or four serious faults, and everything the
 * drafter was told encouraged it to argue from all of them. A list of
 * everything wrong with somebody's website, posted by a stranger, is a sales
 * audit: it invites an argument about the third item instead of a conversation
 * about the first, and nobody replies to it. The letter now names **one** and
 * the four-reviewer report goes out with it as a PDF — which means the report
 * has to exist, and the attachment has to be added by the system rather than
 * by whoever remembers to tick a box. An email that says "the rest are
 * attached" and carries nothing is the one mistake here a prospect definitely
 * notices.
 *
 * **A business with no website got a lecture about websites.** There is no
 * evidence to argue from — nothing fetched, nothing measured, nothing
 * photographed — so every letter was a stranger predicting their future. The
 * demo page is the argument itself, and `demoBuilder` has been able to build
 * one since August; what was missing is that nothing built one on its own,
 * while the drafter was being told to offer "a page built for them to look at"
 * that did not exist.
 *
 * The negatives are half of this file: one red flag must attach nothing, a
 * client update must never carry an audit of a stranger's website, a review
 * with no rendered PDF must be skipped rather than failing the send, and a
 * business that already has a site must not have a demo built behind
 * somebody's back.
 *
 * Database only. No API key, no network.
 *   npx tsx checks/coldEvidence.ts
 */
import { prisma } from "../src/lib/prisma.js";
import { automaticAttachments, composeMessage, parseAttachments, reportToAttach, resolveAttachments } from "../src/services/emailSender.js";
import { auditTeamFindings, caseStrength, demoIsTheArgument, redFlags, strongestPoint } from "../src/services/leadPrep.js";
import { ensureDemoForLead } from "../src/services/leadDemo.js";
import { COLD_EMAIL_DOCTRINE } from "../src/services/outreachDoctrine.js";
import type { CompanyAudit } from "../src/services/companyAudit.js";
import type { HomepageLook } from "../src/services/homepageLook.js";

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

/** Everything this run makes carries the mark, so cleanup cannot touch real data. */
const MARK = "coldevidencecheck";

const finding = (id: string, severity: string) => ({
  id,
  area: "SITE",
  severity,
  observed: `${id} is wrong`,
  evidence: "checked just now",
  service: null,
});

const observation = (severity: string, plainly: string) => ({
  severity,
  observed: plainly,
  plainly,
  soWhat: "it costs them enquiries",
  where: "the top of the page",
});

const auditWith = (severities: string[]) =>
  ({ ranAt: new Date().toISOString(), site: null, domain: null, findings: severities.map((severity, at) => finding(`f${at}`, severity)), checked: [], notes: [] }) as unknown as CompanyAudit;

const lookWith = (severities: string[]) =>
  ({ observations: severities.map((severity, at) => observation(severity, `seen ${at}`)) }) as unknown as HomepageLook;

/**
 * A four-reviewer report, as a `WebsiteAudit.report` column holds one.
 *
 * Only the fields the letter is written from. That is the point of the shape:
 * the drafter reads `facts`, and this file is about which findings get in.
 */
const reportWith = (input: {
  ux?: string[];
  security?: string[];
  openOn?: string | null;
  call?: string;
  lookScore?: number;
  doNotSay?: string[];
}) =>
  ({
    overallScore: 61,
    scored: true,
    verdict: "Needs work",
    disciplines: [
      {
        discipline: "UX",
        reviewer: "UI/UX Designer",
        scored: true,
        score: 45,
        checked: ["how the homepage looks"],
        findings: (input.ux ?? []).map((severity, at) => ({
          id: `ux-${at + 1}`,
          severity,
          observed: `ux ${at} observed`,
          plainly: `nothing on the first screen says what they sell (${at})`,
          impact: "a buyer goes back to the search results",
          evidence: "the first screen, desktop view",
        })),
      },
      {
        discipline: "SECURITY",
        reviewer: "Security Analyst",
        scored: true,
        score: 70,
        checked: ["their mail domain"],
        findings: (input.security ?? []).map((severity, at) => ({
          id: `sec-no-dmarc`,
          severity,
          observed: `security ${at} observed`,
          plainly: "",
          impact: "anybody can send mail as them",
          evidence: "their DNS records",
        })),
      },
    ],
    synthesis:
      input.openOn === null
        ? null
        : {
            executiveSummary: "",
            theOneThing: "",
            whatIsWorking: ["the photographs are their own"],
            emailBrief: {
              openOn: input.openOn ?? "nothing on your first screen says what you sell",
              consequence: "a buyer comparing three suppliers opens the next result",
              ask: "FIX",
              whyThatAsk: "it is one afternoon's work",
              doNotSay: input.doNotSay ?? [],
            },
          },
    redesign: input.call ? { call: input.call, score: input.lookScore ?? 42, headline: "", summary: "", strengths: [] } : null,
  }) as never;

async function reset() {
  const leads = await prisma.lead.findMany({ where: { contactName: { contains: MARK } }, select: { id: true } });
  const ids = leads.map((lead) => lead.id);
  if (ids.length) {
    await prisma.emailMessage.deleteMany({ where: { leadId: { in: ids } } });
    await prisma.demo.deleteMany({ where: { leadId: { in: ids } } });
    await prisma.websiteAudit.deleteMany({ where: { leadId: { in: ids } } });
    await prisma.leadResearch.deleteMany({ where: { leadId: { in: ids } } });
    await prisma.lead.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.storedFile.deleteMany({ where: { filename: { contains: MARK } } });
}

async function main() {
  await reset();

  console.log("\nWhich faults count as a red flag");
  check("critical and high count", redFlags(auditWith(["CRITICAL", "HIGH"]), null).length === 2);
  check("medium and low do not — housekeeping is not an alarm", redFlags(auditWith(["MEDIUM", "LOW"]), null).length === 0);
  check("what is good never counts", redFlags(auditWith(["GOOD", "GOOD"]), null).length === 0);
  check("what a visitor can see counts too", redFlags(null, lookWith(["CRITICAL"])).length === 1);
  check("both halves are counted together", redFlags(auditWith(["HIGH"]), lookWith(["CRITICAL", "MEDIUM"])).length === 2);
  check("a page nobody looked at produces no flags", redFlags(null, null).length === 0);
  // The severity ladder these sit on is the same one the case strength reads,
  // so a lead with red flags is never simultaneously "nothing worth writing".
  check("red flags and a strong case agree with each other", caseStrength(auditWith(["HIGH"]), null) === "STRONG");

  console.log("\nWhen the full review ran, it is what the letter argues from");
  // The defect this section exists for produced a real letter: a business
  // whose review found nothing on the first screen saying what they sell, and
  // whose email opened on the year in their footer — with that review attached
  // to it. The review was in the database the whole time and nothing read it.
  const review = reportWith({ ux: ["CRITICAL", "HIGH"], security: ["MEDIUM"] });
  check("its findings are what get counted", redFlags(auditWith(["MEDIUM"]), lookWith(["LOW"]), review).length === 2);
  // Not added to the scan's: the review's security section is handed the scan's
  // own audit, so counting both counts the same faults twice.
  check("and the scan's are not counted on top", redFlags(auditWith(["CRITICAL"]), lookWith(["CRITICAL"]), review).length === 2);
  check("worst first, and what a visitor can see wins a tie", auditTeamFindings(review)[0].kind === "seen");
  check("nothing good ever counts", auditTeamFindings(reportWith({ ux: ["GOOD", "GOOD"] })).length === 0);

  // The compiler wrote the opening line for this exact purpose and nothing
  // was reading it.
  const opener = strongestPoint(auditWith(["CRITICAL"]), lookWith(["CRITICAL"]), review);
  check("the review's own opening line wins", opener?.say === "nothing on your first screen says what you sell", opener?.say);
  check("with what it costs them beside it", opener?.costs.includes("opens the next result") === true);
  // A compile that failed still leaves findings better than the scan's.
  const noBrief = strongestPoint(auditWith(["CRITICAL"]), null, reportWith({ ux: ["CRITICAL"], openOn: null }));
  check("no brief falls back to the review's worst finding", noBrief?.say.startsWith("nothing on the first screen") === true, noBrief?.say);
  // And no review at all is the old behaviour, untouched.
  check("no review falls back to the scan", strongestPoint(auditWith(["CRITICAL"]), null)?.say === "f0 is wrong");

  // A page under the redesign floor is a case even when no single fault is
  // serious — the "nothing is broken and none of it is working" business.
  check("a page the review says to rebuild is a strong case", caseStrength(auditWith(["LOW"]), null, reportWith({ ux: ["MEDIUM"], call: "REBUILD" })) === "STRONG");
  check("and so is one it says to redesign", caseStrength(null, null, reportWith({ ux: ["LOW"], call: "REDESIGN" })) === "STRONG");
  check("a page it says to leave alone is judged on its faults", caseStrength(null, null, reportWith({ ux: ["LOW"], call: "LEAVE_IT" })) === "WEAK");
  // Rows written before any of this must not throw inside the path that
  // decides what a cold email says.
  check("a stored report of the wrong shape is not a crash", auditTeamFindings({ businessName: "x" } as never).length === 0);

  console.log("\nThe doctrine says what to do with more than one");
  check("it tells the writer to name one", /names \*\*one\*\*/.test(COLD_EMAIL_DOCTRINE));
  check("and to say the rest are attached", COLD_EMAIL_DOCTRINE.includes("attached to this email"));
  check("and never to list them", COLD_EMAIL_DOCTRINE.includes("Do not list them"));
  // The negative: nothing anywhere in the doctrine may encourage the report
  // email this rule exists to prevent.
  check("nothing in it asks for a list of findings", COLD_EMAIL_DOCTRINE.includes("Never a list of findings"));
  check("it covers the business with no website", COLD_EMAIL_DOCTRINE.includes("When they have no website"));
  check("and says the page is the ask there", COLD_EMAIL_DOCTRINE.includes("the page is the ask"));

  console.log("\nWhose letter carries the report");
  const lead = await prisma.lead.create({
    data: { contactName: `Kofi ${MARK}`, companyName: "Flagged Ltd", contactEmail: `flagged.${MARK}@example.invalid`, website: "https://flagged.example", source: "OUTREACH" },
  });
  await prisma.leadResearch.create({
    data: {
      leadId: lead.id,
      ranAt: new Date(),
      filled: {},
      audit: auditWith(["CRITICAL", "HIGH", "MEDIUM"]) as never,
      look: lookWith(["HIGH"]) as never,
      facts: [],
      notes: [],
      costUsd: 0,
    },
  });

  // A review with a rendered PDF, exactly as `runWebsiteAudit` leaves one.
  const pdf = await prisma.storedFile.create({
    data: { filename: `${MARK}-review.pdf`, contentType: "application/pdf", size: 5, data: Buffer.from("%PDF-"), purpose: "AUDIT_PDF" },
  });
  const audit = await prisma.websiteAudit.create({
    data: {
      leadId: lead.id,
      businessName: "Flagged Ltd",
      website: "https://flagged.example",
      overallScore: 41,
      verdict: "Serious problems",
      report: {} as never,
      markdown: "# review",
      pdfFileId: pdf.id,
    },
  });

  const cold = await reportToAttach({ purpose: "COLD_OUTREACH", leadId: lead.id });
  check("a first letter to a lead with several flags carries the review", cold?.kind === "audit" && (cold as { auditId: string }).auditId === audit.id);

  const update = await reportToAttach({ purpose: "PROJECT_UPDATE", leadId: lead.id });
  check("a project update does not — it is not a first approach", update === null);
  const nobody = await reportToAttach({ purpose: "COLD_OUTREACH", leadId: null });
  check("and neither does a letter with no lead behind it", nobody === null);

  // One flag is an email about that one flag. There is nothing being held back,
  // so there is nothing to attach and nothing to promise.
  await prisma.leadResearch.update({ where: { leadId: lead.id }, data: { audit: auditWith(["HIGH", "LOW"]) as never, look: {} as never } });
  const onlyOne = await reportToAttach({ purpose: "COLD_OUTREACH", leadId: lead.id });
  check("one red flag attaches nothing", onlyOne === null);

  // Back to several, for the compose path.
  await prisma.leadResearch.update({ where: { leadId: lead.id }, data: { audit: auditWith(["CRITICAL", "HIGH"]) as never } });

  console.log("\nComposing attaches it, without anybody remembering to");
  const composed = await composeMessage({
    subject: "your booking form",
    body: "Hello,\n\nOne thing I noticed.",
    purpose: "COLD_OUTREACH",
    kind: "AI_DRAFT",
    leadId: lead.id,
  });
  const attached = parseAttachments(composed.attachments);
  check("the report is on the message the moment it is composed", attached.some((entry) => (entry as { kind?: string }).kind === "audit"));

  const resolved = await resolveAttachments(attached);
  check("and it resolves to real PDF bytes at send time", resolved.length === 1 && resolved[0].contentType === "application/pdf");
  check("named after the business rather than after a file id", String(resolved[0].filename).includes("Flagged Ltd"));

  // The negative that keeps a send from failing on a missing file: a review
  // whose PDF never rendered is skipped, not thrown.
  const nothingRendered = await prisma.websiteAudit.create({
    data: { leadId: lead.id, businessName: "Flagged Ltd", website: null, overallScore: 0, verdict: "Not scored", report: {} as never, markdown: "" },
  });
  const skipped = await resolveAttachments([{ kind: "audit", auditId: nothingRendered.id }]);
  check("a review with no PDF is skipped rather than failing the send", skipped.length === 0);
  const missing = await resolveAttachments([{ kind: "audit", auditId: "does-not-exist" }]);
  check("and so is a review that no longer exists", missing.length === 0);

  // A person who has decided this one letter should not carry it.
  const refused = await composeMessage({
    subject: "your booking form",
    body: "Hello,\n\nOne thing I noticed.",
    purpose: "COLD_OUTREACH",
    kind: "MANUAL",
    leadId: lead.id,
    attachReport: false,
  });
  check("a sender can refuse the attachment", parseAttachments(refused.attachments).length === 0);

  // A file that appears on the sent record and appeared nowhere on the screen
  // the sender pressed Send on is the same class of mistake as a letter
  // referring to an attachment that is not there — the sender is answering for
  // a document they were never shown. That happened: a cold letter went out
  // carrying a website review and the composer listed no attachments at all.
  // The fix is one function feeding both, so these assert that the list the
  // composer draws is the list the send uses.
  console.log("\nWhat the sender sees is what leaves");
  const visible = await automaticAttachments({ purpose: "COLD_OUTREACH", leadId: lead.id });
  check("the composer is told about the review before anything is sent", visible.length === 1 && (visible[0] as { kind?: string }).kind === "audit");
  check(
    "and it is the same review the send attaches",
    (visible[0] as { auditId?: string }).auditId === (parseAttachments(composed.attachments)[0] as { auditId?: string }).auditId,
  );

  const kindsOf = (entries: unknown[]) => entries.map((entry) => (entry as { kind?: string }).kind ?? "file").sort();
  check(
    "nothing reaches the message that the composer could not have drawn",
    kindsOf(parseAttachments(composed.attachments)).join() === kindsOf(visible).join(),
  );

  const refusedVisible = await automaticAttachments({ purpose: "COLD_OUTREACH", leadId: lead.id, attachReport: false });
  check("taking it off empties the chip and the letter together", refusedVisible.length === 0 && parseAttachments(refused.attachments).length === 0);

  // The dedupe, in both directions. A draft opened to be finished hands its own
  // attachments back, and the review must not be added a second time.
  const alreadyThere = await automaticAttachments({
    purpose: "COLD_OUTREACH",
    leadId: lead.id,
    existing: [{ kind: "audit", auditId: audit.id }],
  });
  check("a review already on the draft is not attached twice", alreadyThere.length === 0);

  const withInvoice = await automaticAttachments({ purpose: "INVOICE_DELIVERY", invoiceId: "inv-1" });
  check("an email about an invoice shows the invoice", withInvoice.length === 1 && (withInvoice[0] as { invoiceId?: string }).invoiceId === "inv-1");
  const invoicePicked = await automaticAttachments({
    purpose: "INVOICE_DELIVERY",
    invoiceId: "inv-1",
    existing: [{ kind: "invoice", invoiceId: "inv-1" }],
  });
  check("one the sender listed themselves is left as they listed it", invoicePicked.length === 0);

  console.log("\nThe business with no website");
  check("no website means the demo is the argument", demoIsTheArgument({ website: null, audit: null }));
  check("an empty string counts as no website", demoIsTheArgument({ website: "   ", audit: null }));
  check("a business with a site is not one of these", !demoIsTheArgument({ website: "https://theirs.example", audit: null }));

  const noSite = await prisma.lead.create({
    data: { contactName: `Ama ${MARK}`, companyName: "No Site Ltd", contactEmail: `nosite.${MARK}@example.invalid`, website: null, source: "OUTREACH" },
  });

  // Nobody has looked at them yet: a page built from a bare record is a
  // template with a business name dropped into it, which is the one thing the
  // demo exists not to be.
  const unlooked = await ensureDemoForLead(noSite.id);
  check("a lead nobody has scanned gets no page and says why", unlooked.url === null && Boolean(unlooked.note?.includes("scan")));

  await prisma.leadResearch.create({
    data: { leadId: noSite.id, ranAt: new Date(), filled: {}, audit: auditWith(["CRITICAL"]) as never, facts: [], notes: [], costUsd: 0 },
  });

  // A page that already exists is handed back rather than rebuilt: the link may
  // already be in a prospect's inbox, and what is at the end of it must not
  // change under them.
  const existing = await prisma.demo.create({
    data: { slug: `${MARK}-no-site-ltd`, leadId: noSite.id, title: "No Site Ltd — new site", businessName: "No Site Ltd", html: "<!doctype html><html></html>", builtBy: "check", status: "SENT" },
  });
  const found = await ensureDemoForLead(noSite.id);
  check("an existing page is handed back, not rebuilt", found.demoId === existing.id && found.built === false);
  check("and its link is the one to put in the letter", Boolean(found.url?.endsWith(`/demos/${existing.slug}`)));

  // The negative: a business that has a website is never given one behind
  // somebody's back. A redesign pitch is a decision, not a default.
  const hasSite = await prisma.lead.create({
    data: { contactName: `Yaw ${MARK}`, companyName: "Has Site Ltd", website: "https://hassite.example", source: "OUTREACH" },
  });
  await prisma.leadResearch.create({
    data: { leadId: hasSite.id, ranAt: new Date(), filled: {}, audit: auditWith(["HIGH"]) as never, facts: [], notes: [], costUsd: 0 },
  });
  const refusedDemo = await ensureDemoForLead(hasSite.id);
  check("a business with a website is not given a demo by default", refusedDemo.url === null && Boolean(refusedDemo.note?.includes("redesign")));
  check("and nothing was written for it", (await prisma.demo.count({ where: { leadId: hasSite.id } })) === 0);

  await reset();
  await prisma.$disconnect();

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log(failures.map((name) => `  - ${name}`).join("\n"));
    process.exit(1);
  }
}

main().catch(async (err) => {
  console.error(err);
  await reset().catch(() => {});
  await prisma.$disconnect();
  process.exit(1);
});
