/**
 * Deleting what the privacy policy says will be deleted — and nothing else.
 *
 * Art 5(1)(e) GDPR and s.24 of Act 843 both say personal data may be kept no
 * longer than necessary, and neither is satisfied by intending to delete
 * something. On 4 Sep 2026 dakyworld.com/privacy started publishing a period
 * per category, which made the obligation concrete and created a sharper
 * problem alongside it: **a published period that nothing enforces is a false
 * statement in a privacy policy.** Vague and true beats specific and untrue.
 *
 * Almost all of this file is the guards, because the failure here is not a
 * missed sweep — it is deleting somebody's pipeline. Every negative below is a
 * separate reason a lead must survive, and each would be a different kind of
 * bad afternoon:
 *
 *   - a referral is data somebody gave us willingly and is not covered;
 *   - one sent email, one logged call or one WhatsApp makes a conversation
 *     with a history somebody may need;
 *   - a proposal or a client is obvious and worth asserting anyway;
 *   - a record touched last week is in use, whenever it was scraped.
 *
 * And the one that is not about correctness at all: **with the setting off,
 * nothing may be deleted.** That is the difference between a feature somebody
 * chose and a scheduler that quietly emptied a table.
 *
 * Database only. No API key, no network.
 *   npx tsx checks/retention.ts
 */
import { prisma } from "../src/lib/prisma.js";
import { FOUND_CONTACT_MONTHS, enforceRetention, leadsDueForDeletion } from "../src/services/retention.js";

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

const MARK = "retentioncheck";

async function reset() {
  await prisma.emailMessage.deleteMany({ where: { toEmail: { contains: MARK } } });
  await prisma.communication.deleteMany({ where: { summary: { contains: MARK } } });
  await prisma.proposal.deleteMany({ where: { title: { contains: MARK } } });
  await prisma.lead.deleteMany({ where: { contactName: { contains: MARK } } });
  await prisma.client.deleteMany({ where: { name: { contains: MARK } } });
}

/** Older than the published period, by a clear margin. */
const longAgo = () => {
  const date = new Date();
  date.setMonth(date.getMonth() - (FOUND_CONTACT_MONTHS + 2));
  return date;
};

/**
 * `updatedAt` is `@updatedAt`, so Prisma overwrites it on every write. Only raw
 * SQL can put a row in the past — and a check that cannot age a row cannot test
 * a retention period at all.
 */
async function age(id: string) {
  await prisma.$executeRaw`UPDATE "Lead" SET "updatedAt" = ${longAgo()} WHERE id = ${id}`;
}

async function makeLead(name: string, data: Record<string, unknown> = {}) {
  const lead = await prisma.lead.create({
    data: { contactName: `${name} ${MARK}`, companyName: `${name} Ltd`, source: "GOOGLE_MAPS", ...data } as never,
  });
  await age(lead.id);
  return lead;
}

const isDue = async (id: string) => (await leadsDueForDeletion(1000)).some((lead) => lead.id === id);

async function main() {
  await reset();

  // --- the one that should go -----------------------------------------------

  const stale = await makeLead("Forgotten");
  check("a scraped lead nobody touched for over a year is due", await isDue(stale.id));

  // --- the guards ------------------------------------------------------------

  const referral = await makeLead("Referred", { source: "REFERRAL" });
  check("a referral is never swept", !(await isDue(referral.id)));

  const enquiry = await makeLead("Enquired", { source: "CONTENT" });
  check("a website enquiry is never swept", !(await isDue(enquiry.id)));

  const recent = await prisma.lead.create({
    data: { contactName: `Fresh ${MARK}`, companyName: "Fresh Ltd", source: "GOOGLE_MAPS" },
  });
  check("a lead touched recently is never swept", !(await isDue(recent.id)));

  const qualified = await makeLead("Qualifying", { status: "QUALIFIED" });
  check("a lead somebody moved along the pipeline is never swept", !(await isDue(qualified.id)));

  const converted = await makeLead("Converted", { status: "CONVERTED" });
  check("a converted lead is never swept", !(await isDue(converted.id)));

  // One sent email is a conversation. This is the guard most likely to be got
  // wrong, because the lead itself looks untouched.
  const emailed = await makeLead("Emailed");
  await prisma.emailMessage.create({
    data: {
      subject: "hello",
      bodyHtml: "<p>hello</p>",
      bodyText: "hello",
      toEmail: `emailed.${MARK}@example.test`,
      kind: "MANUAL",
      purpose: "COLD_OUTREACH",
      leadId: emailed.id,
    },
  });
  await age(emailed.id);
  check("a lead we have written to is never swept", !(await isDue(emailed.id)));

  const called = await makeLead("Called");
  await prisma.communication.create({
    data: { leadId: called.id, type: "CALL", summary: `spoke to them ${MARK}`, occurredAt: longAgo() },
  });
  await age(called.id);
  check("a lead with a logged call is never swept", !(await isDue(called.id)));

  const client = await prisma.client.create({ data: { name: `Kept Client ${MARK}`, company: "Kept Ltd" } });
  const customer = await makeLead("Customer", { clientId: client.id });
  check("a lead attached to a client is never swept", !(await isDue(customer.id)));

  // --- the setting -----------------------------------------------------------

  const before = await prisma.lead.count({ where: { contactName: { contains: MARK } } });
  const dry = await enforceRetention({ apply: false });
  const afterDry = await prisma.lead.count({ where: { contactName: { contains: MARK } } });

  check("a dry run reports what is due", dry.due >= 1, `${dry.due} due`);
  check("a dry run deletes nothing", dry.deleted === 0 && afterDry === before, `${before} → ${afterDry}`);
  check("and says it is not enforcing", dry.enforced === false);
  check("and names a few, so the log can be sanity-checked", dry.sample.length > 0);

  // --- and when it is on -----------------------------------------------------

  const applied = await enforceRetention({ apply: true });
  check("switched on, it deletes", applied.deleted >= 1, `${applied.deleted} deleted`);
  check("the forgotten lead is gone", (await prisma.lead.count({ where: { id: stale.id } })) === 0);

  // The guards hold through a real delete, not only through the query that
  // feeds it — which is the assertion worth having, since a widened `where` in
  // enforceRetention would pass every check above and still empty the table.
  for (const [name, lead] of [
    ["referral", referral],
    ["enquiry", enquiry],
    ["recent", recent],
    ["qualified", qualified],
    ["converted", converted],
    ["emailed", emailed],
    ["called", called],
    ["customer", customer],
  ] as const) {
    check(`the ${name} lead survived the real delete`, (await prisma.lead.count({ where: { id: lead.id } })) === 1);
  }

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
