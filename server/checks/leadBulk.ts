/**
 * Bulk actions addressed by a filter, and what a deleted lead takes with it.
 *
 * Two things are being proved, and the second is where the defects were.
 *
 * **A filter is not a list of ids.** Every bulk endpoint took `ids`, which is
 * right for twenty ticked rows and cannot express the other half of the job —
 * this database holds 46,110 leads and "clear the March scrape" is not
 * forty-six thousand cuids in a request body.
 *
 * **A delete has to survive the foreign keys.** Five relations point at `Lead`
 * with the default RESTRICT. The old endpoint handled two, so a lead that had
 * ever been emailed could not be bulk-deleted at all and the foreign key
 * surfaced as a bare 500 — and a single proposal made every other lead in the
 * request undeletable, because it refused the lot.
 *
 * Database only. No key, no network.
 */
import { BulkCountChanged, countTarget, deleteLeads, updateLeads } from "../src/services/leadBulk.js";
import { buildWhere } from "../src/routes/leads.js";
import { prisma } from "../src/lib/prisma.js";

let bad = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(ok ? `  ok    ${label}` : `  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) bad += 1;
}

const MARK = "bulkcheck";
const GROUP = "Bulk Check List";

async function reset() {
  const leads = await prisma.lead.findMany({ where: { contactName: { startsWith: MARK } }, select: { id: true } });
  const ids = leads.map((lead) => lead.id);
  if (ids.length > 0) {
    await prisma.proposal.deleteMany({ where: { leadId: { in: ids } } });
    await prisma.communication.deleteMany({ where: { leadId: { in: ids } } });
    await prisma.emailMessage.deleteMany({ where: { leadId: { in: ids } } });
    await prisma.agentTask.deleteMany({ where: { leadId: { in: ids } } });
    await prisma.lead.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.leadGroup.deleteMany({ where: { name: GROUP } });
  await prisma.agent.deleteMany({ where: { key: "check.bulk.agent" } });
}

await reset();

const group = await prisma.leadGroup.create({ data: { name: GROUP, slug: "bulk-check-list" } });
const make = (n: number, extra: Record<string, unknown> = {}) =>
  prisma.lead.create({
    data: { contactName: `${MARK}-${n}`, companyName: `${MARK} Co ${n}`, groupId: group.id, ...extra } as never,
  });

console.log("\nA filter is a target");
{
  for (let n = 1; n <= 5; n += 1) await make(n);
  await make(6, { groupId: null });

  const inGroup = { where: buildWhere({ groupId: group.id }) };
  check("counting a filter counts what matches", (await countTarget(inGroup)) === 5, `${await countTarget(inGroup)}`);

  // The whole point: no id list anywhere in this call.
  const moved = await updateLeads({ where: buildWhere({ groupId: group.id }), expect: 5 }, { status: "QUALIFYING" });
  check("a filter update moves every match", moved === 5, `${moved}`);
  const untouched = await prisma.lead.findFirstOrThrow({ where: { contactName: `${MARK}-6` } });
  check("and nothing outside it", untouched.status === "NEW", untouched.status);
}

console.log("\nThe count is quoted back and checked");
{
  // A filter that matched five when the screen drew it can match six by the
  // time the button is pressed. Refused, with both numbers, rather than
  // applied to whatever is there now.
  let refused: unknown = null;
  try {
    await deleteLeads({ where: buildWhere({ groupId: group.id }), expect: 99 });
  } catch (err) {
    refused = err;
  }
  check("a stale count is refused", refused instanceof BulkCountChanged);
  check("and it names both numbers", (refused as BulkCountChanged)?.actual === 5, `${(refused as BulkCountChanged)?.actual}`);
  check("nothing was deleted", (await countTarget({ where: buildWhere({ groupId: group.id }) })) === 5);

  let noExpect: unknown = null;
  try {
    await deleteLeads({ where: buildWhere({ groupId: group.id }) });
  } catch (err) {
    noExpect = err;
  }
  check("a filter delete with no expected count is refused outright", noExpect instanceof Error);

  // An id list names every row, so there is nothing to be surprised by.
  const one = await make(7, { groupId: null });
  const byId = await deleteLeads({ ids: [one.id] });
  check("an id list needs no expected count", byId.deleted === 1, `${byId.deleted}`);
}

console.log("\nWhat a deleted lead takes with it");
{
  const lead = await prisma.lead.findFirstOrThrow({ where: { contactName: `${MARK}-1` } });

  // RESTRICT, all three. Without detaching, the delete below simply fails —
  // which is what happened to any lead that had ever been emailed.
  await prisma.communication.create({ data: { leadId: lead.id, type: "EMAIL", summary: "said hello" } as never });
  await prisma.emailMessage.create({
    data: { leadId: lead.id, toEmail: "someone@example.com", subject: "hello", bodyHtml: "<p>hello</p>", bodyText: "hello", status: "SENT" } as never,
  });
  await prisma.agent.create({
    data: {
      key: "check.bulk.agent",
      name: "Bulk Check",
      title: "Bulk Check",
      tier: "SUB_AGENT",
      department: "TECHNOLOGY",
      status: "DRAFT",
      mission: "Exists for one test run.",
      custom: true,
    },
  });
  const task = await prisma.agentTask.create({
    data: { agentKey: "check.bulk.agent", title: "wrote to them", brief: "wrote to them", leadId: lead.id },
  });

  const result = await deleteLeads({ ids: [lead.id] });
  check("a lead that has been emailed can be deleted", result.deleted === 1, `${result.deleted}`);

  // Detached, not destroyed. Each is a record of something that happened, and
  // the prospect going away is not a reason to lose the evidence of it.
  const email = await prisma.emailMessage.findFirst({ where: { subject: "hello" } });
  check("the email it sent survives", Boolean(email), "gone");
  check("with its link cleared", email?.leadId === null, `${email?.leadId}`);
  const after = await prisma.agentTask.findUnique({ where: { id: task.id } });
  check("the agent's work survives", Boolean(after));
  check("with its link cleared", after?.leadId === null, `${after?.leadId}`);
  check("and it is reported", result.detached.emails === 1 && result.detached.tasks === 1, JSON.stringify(result.detached));

  // The contact log is about this lead and means nothing without it.
  const log = await prisma.communication.count({ where: { summary: "said hello" } });
  check("the contact log goes with it", log === 0, `${log}`);
}

console.log("\nA proposal keeps its lead, and does not block the rest");
{
  const kept = await prisma.lead.findFirstOrThrow({ where: { contactName: `${MARK}-2` } });
  await prisma.proposal.create({
    data: { leadId: kept.id, title: "A priced document", serviceType: "Website Build", scopeSummary: "A page.", priceAmount: 1000 } as never,
  });

  const before = await countTarget({ where: buildWhere({ groupId: group.id }) });
  const result = await deleteLeads({ where: buildWhere({ groupId: group.id }), expect: before });

  // The old endpoint refused the whole request when any one lead had a
  // proposal, which turns one proposal into forty-six thousand leads that
  // cannot be cleared.
  check("everything else is still deleted", result.deleted === before - 1, `${result.deleted} of ${before}`);
  check("the one with a proposal is kept", result.keptWithProposals.length === 1, `${result.keptWithProposals.length}`);
  check("and it is named, not just counted", result.keptWithProposals[0]?.name.includes(MARK) === true, JSON.stringify(result.keptWithProposals));
  check("it really is still there", Boolean(await prisma.lead.findUnique({ where: { id: kept.id } })));

  // The paging loop must not spin for ever on a page it cannot delete.
  const second = await deleteLeads({ where: buildWhere({ groupId: group.id }), expect: 1 });
  check("running it again terminates rather than looping", second.deleted === 0 && second.keptWithProposals.length === 1);
}

console.log("\nRehearsal leads are not swept up");
{
  // `buildWhere` excludes them, and that is the whole exclusion rather than
  // the first of eight — a scratch lead belongs to a run in progress.
  const scratch = await make(90, { groupId: null, rehearsal: true });
  const everything = await countTarget({ where: buildWhere({}) });
  const all = await prisma.lead.count();
  check("a rehearsal lead is outside 'everything matching'", everything < all, `${everything} of ${all}`);
  await prisma.lead.delete({ where: { id: scratch.id } });
}

await reset();
console.log(bad ? `\n${bad} PROBLEM(S)` : `\nBulk actions reach a filter, and a delete survives the foreign keys.`);
process.exitCode = bad ? 1 : 0;
await prisma.$disconnect();
