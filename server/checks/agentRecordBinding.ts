/**
 * Does a fact about one lead stay with that lead?
 *
 * Standing work — the daily chain the scheduler raises — is about a batch of
 * leads and about none of them, so its tasks have no subject. Every per-lead
 * fact those agents wrote with `update_living_context` (the fault a letter
 * will lead on, the demo link, the hook already used) fell back to the
 * company subject, where the next lead's value overwrote it, and the agents
 * the briefs name could not read it back per lead because the history tools
 * were pruned on a task with no subject. The failure mode is a letter built on
 * another company's fault.
 *
 * So a workflow tool can be pointed at one record with `record`, and a task
 * about no record that does not name one is refused rather than quietly
 * writing to the whole company. The negatives are the half that matter:
 *
 *   - **Nothing is written when the record is missing, unknown or malformed**,
 *     and the company's own state is never touched by a per-lead write.
 *   - **One lead's value does not show on another's**, and writing the second
 *     leaves the first intact.
 *   - **A rehearsal may not name a record that is not its own** — it is pointed
 *     at a scratch lead precisely so that it writes nowhere real.
 *   - **`remember` will not promise every agent a memory nobody can recall.**
 *
 * And the hand-off half: `delegate` and `handOff` carry `record` and
 * `acceptance` to the child, and without either the child is the same row,
 * with the same brief, as before — the replay guard and the deliberate repeat
 * both still behave.
 *
 * A database and nothing else. No API key, no network.
 *   npx tsx checks/agentRecordBinding.ts
 */
import type { Agent, AgentTask } from "@prisma/client";
import { prisma } from "../src/lib/prisma.js";
import { ensureAgents } from "../src/services/agentRegistry.js";
import { livingContextBlock } from "../src/services/agents/memory.js";
import { workflowAvailability, workflowTools, type Counters } from "../src/services/agents/runner.js";

const TITLE = "Binding:";
const KEY = "handoff_check_fault";

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

const fresh = (): Counters => ({
  toolCalls: 0,
  dryRun: 0,
  refused: 0,
  escalated: null,
  delegated: 0,
  consulted: 0,
  consultedBy: { low: 0, medium: 0, high: 0 },
  handedOff: 0,
  gapsRaised: 0,
});

async function reset() {
  const leads = await prisma.lead.findMany({ where: { contactName: { startsWith: "Binding" } }, select: { id: true } });
  const subjects = leads.map((lead) => `lead:${lead.id}`);
  const parents = await prisma.agentTask.findMany({ where: { title: { startsWith: TITLE } }, select: { id: true } });
  const children = await prisma.agentTask.findMany({ where: { parentId: { in: parents.map((t) => t.id) } }, select: { id: true } });
  const ids = [...children, ...parents].map((t) => t.id);
  if (ids.length > 0) {
    await prisma.agentTaskTransition.deleteMany({ where: { taskId: { in: ids } } });
    await prisma.agentTaskStep.deleteMany({ where: { taskId: { in: ids } } });
    await prisma.agentMemory.deleteMany({ where: { sourceTaskId: { in: ids } } });
    await prisma.contextNote.deleteMany({ where: { sourceTaskId: { in: ids } } });
    await prisma.agentTask.deleteMany({ where: { id: { in: children.map((t) => t.id) } } });
    await prisma.agentTask.deleteMany({ where: { id: { in: parents.map((t) => t.id) } } });
  }
  await prisma.agentMemory.deleteMany({ where: { OR: [{ subject: { in: subjects } }, { content: { contains: KEY } }, { content: { contains: "Binding check" } }] } });
  await prisma.contextNote.deleteMany({ where: { OR: [{ subject: { in: subjects } }, { summary: { contains: "Binding check" } }] } });
  await prisma.lead.deleteMany({ where: { id: { in: leads.map((lead) => lead.id) } } });
}

async function taskOf(agent: Agent, title: string, over: Partial<AgentTask> = {}): Promise<AgentTask> {
  return prisma.agentTask.create({
    data: {
      agentKey: agent.key,
      title: `${TITLE} ${title}`,
      brief: "Exists so the workflow tools have something to hang off.",
      origin: "SCHEDULE",
      status: "RUNNING",
      ...(over as object),
    },
  });
}

const tool = (agent: Agent, task: AgentTask, name: string, counters = fresh()) => workflowTools(agent, task, counters, 3).find((t) => t.name === name);
const text = (outcome: { content: string }) => String(outcome.content);
const livingRows = (subject: string) => prisma.agentMemory.findMany({ where: { scope: "SHARED", subject, content: { startsWith: `[state:${KEY}]` } } });

async function main() {
  await reset();
  await ensureAgents();

  const director = await prisma.agent.findFirstOrThrow({
    where: { key: { in: (await prisma.agent.findMany({ where: { managerKey: { not: null } }, select: { managerKey: true } })).map((a) => a.managerKey!) } },
    orderBy: { key: "asc" },
  });
  const report = await prisma.agent.findFirstOrThrow({ where: { managerKey: director.key }, orderBy: { key: "asc" } });
  const leadA = await prisma.lead.create({ data: { contactName: "Binding A", companyName: "Binding Clinic A" } });
  const leadB = await prisma.lead.create({ data: { contactName: "Binding B", companyName: "Binding Clinic B" } });
  const A = `lead:${leadA.id}`;
  const B = `lead:${leadB.id}`;

  // --- Standing work over a batch -------------------------------------------
  console.log("\nStanding work, about no record of its own");
  const standing = await taskOf(director, "standing work");
  check("its task is about no record", !standing.leadId && !standing.clientId && !standing.projectId);
  check("but still carries the history tools — it names a record per call", workflowAvailability(director, standing, fresh(), 3).history === true);
  const names = workflowTools(director, standing, fresh(), 3).map((t) => t.name);
  check("readHistory is sent", names.includes("readHistory"));
  check("and so is update_living_context", names.includes("update_living_context"));

  const living = tool(director, standing, "update_living_context")!;
  const companyBefore = await livingRows("company");

  const unbound = await living.run({ scope: "this record", key: KEY, value: "Binding check: the booking form is broken on mobile." });
  check("without a record it is refused", unbound.isError === true, text(unbound));
  check("telling it how to name one", text(unbound).includes("record: lead:<id>"), text(unbound));
  check("and nothing is written anywhere", (await prisma.agentMemory.count({ where: { content: { startsWith: `[state:${KEY}]` } } })) === 0);

  const toA = await living.run({ scope: "this record", key: KEY, value: "Binding check: the booking form is broken on mobile.", record: A });
  check("with record: lead:A it is written", !toA.isError, text(toA));
  const aRows = await livingRows(A);
  check("as one row, on lead A", aRows.length === 1, String(aRows.length));
  const blockA = (await livingContextBlock([A])) ?? "";
  const blockB = (await livingContextBlock([B])) ?? "";
  check("lead A's living context shows it", blockA.includes("booking form is broken"), blockA.slice(0, 120));
  check("lead B's does not", !blockB.includes("booking form is broken"));
  check("and the company's own state is untouched", (await livingRows("company")).length === companyBefore.length, `${companyBefore.length} → ${(await livingRows("company")).length}`);

  await living.run({ scope: "this record", key: KEY, value: "Binding check: no SSL certificate on the site.", record: B });
  check("a second write for lead B lands on lead B", (await livingRows(B)).length === 1);
  const aAfter = await livingRows(A);
  check("and leaves lead A's value as it was", aAfter.length === 1 && aAfter[0].content.includes("booking form is broken"), aAfter[0]?.content);

  const unknown = await living.run({ scope: "this record", key: KEY, value: "Binding check: anything.", record: "lead:no-such-lead" });
  check("an id that does not exist is refused", unknown.isError === true, text(unknown));
  const malformed = await living.run({ scope: "this record", key: KEY, value: "Binding check: anything.", record: "proposal:abc" });
  check("so is something that is not a lead, client or project", malformed.isError === true, text(malformed));
  check("and neither wrote a row", (await prisma.agentMemory.count({ where: { content: { startsWith: `[state:${KEY}]` } } })) === 2);

  const companyWide = await living.run({ scope: "the whole company", key: `${KEY}_co`, value: "Binding check: company-wide on purpose." });
  check("scope 'the whole company' still writes company-wide, on purpose", !companyWide.isError && (await prisma.agentMemory.count({ where: { subject: "company", content: { startsWith: `[state:${KEY}_co]` } } })) === 1);
  await prisma.agentMemory.deleteMany({ where: { subject: "company", content: { startsWith: `[state:${KEY}_co]` } } });

  console.log("\nReading a record's history from standing work");
  const read = tool(director, standing, "readHistory")!;
  const history = await read.run({ record: A });
  check("readHistory with a record returns that lead's dossier", !history.isError && text(history).includes("Binding Clinic A"), text(history).slice(0, 160));
  check("including the living key written against it", text(history).includes(KEY), text(history).slice(0, 400));
  check("and not the other lead's", !text(history).includes("no SSL certificate"));
  const readNothing = await read.run({});
  check("without a record it says how to name one", readNothing.isError === true && text(readNothing).includes("record"), text(readNothing));

  const note = tool(director, standing, "addToHistory")!;
  const noted = await note.run({ kind: "NOTE", summary: "Binding check: called, no answer.", record: B });
  check("addToHistory with a record files against that lead", !noted.isError && (await prisma.contextNote.count({ where: { subject: B, summary: { contains: "called, no answer" } } })) === 1, text(noted));

  console.log("\nA rehearsal writes only to its own record");
  const rehearsal = await taskOf(director, "rehearsal", { rehearsal: true, leadId: leadA.id });
  const rehearsalLiving = tool(director, rehearsal, "update_living_context")!;
  const elsewhere = await rehearsalLiving.run({ scope: "this record", key: KEY, value: "Binding check: written from a rehearsal.", record: B });
  check("naming a record that is not its own is refused", elsewhere.isError === true, text(elsewhere));
  check("and lead B is unchanged", (await livingRows(B))[0]?.content.includes("no SSL certificate") === true);
  const own = await rehearsalLiving.run({ scope: "this record", key: KEY, value: "Binding check: the rehearsal's own lead.", record: A });
  check("its own record is still allowed", !own.isError, text(own));

  console.log("\nA memory nobody could recall is not promised to everybody");
  const rememberTool = tool(director, standing, "remember")!;
  const shared = await rememberTool.run({ kind: "FACT", content: "Binding check: they close on Fridays.", about: "this record (shared)" });
  check("'this record (shared)' on a task about no record is refused", shared.isError === true, text(shared));
  check("and stores nothing", (await prisma.agentMemory.count({ where: { content: { contains: "close on Fridays" } } })) === 0);
  const sharedA = await rememberTool.run({ kind: "FACT", content: "Binding check: they open late on Mondays.", about: "this record (shared)", record: A });
  check("with a record it is shared against that record", !sharedA.isError && (await prisma.agentMemory.count({ where: { subject: A, scope: "SHARED", content: { contains: "open late" } } })) === 1, text(sharedA));
  const own2 = await rememberTool.run({ kind: "LESSON", content: "Binding check: batch the follow-ups by city.", about: "this task" });
  check("'this task' with no record is filed as a lesson about its own work — and says so", !own2.isError && text(own2).includes("not about one record"), text(own2));

  console.log("\nAn errand from a person, about no record, is unchanged");
  const errand = await taskOf(director, "errand", { origin: "OWNER" });
  const errandNames = workflowTools(director, errand, fresh(), 3).map((t) => t.name);
  check("the history tools are still not sent", !errandNames.includes("readHistory") && !errandNames.includes("addToHistory"));
  check("update_living_context still is", errandNames.includes("update_living_context"));

  // --- Hand-offs ------------------------------------------------------------
  console.log("\nHanding work on, with a record and a definition of done");
  const delegate = tool(director, standing, "delegate")!;
  const acceptance = ["The letter leads on the booking-form fault.", "It names the clinic.", "It is under 120 words."];
  const bound = await delegate.run({ agentKey: report.key, title: `${TITLE} write to A`, brief: "Write the first letter to clinic A from the fault on file.", record: A, acceptance });
  check("the delegation is accepted", !bound.isError, text(bound));
  const child = await prisma.agentTask.findFirst({ where: { parentId: standing.id, title: `${TITLE} write to A` } });
  check("the child is about lead A", child?.leadId === leadA.id, String(child?.leadId));
  check("and only lead A", !child?.clientId && !child?.projectId);
  check("its input carries the acceptance checks exactly", JSON.stringify((child?.input as { acceptance?: unknown } | null)?.acceptance) === JSON.stringify(acceptance), JSON.stringify(child?.input));

  const plainBrief = "Twenty characters at least, written for somebody who was not here.";
  await delegate.run({ agentKey: report.key, title: `${TITLE} plain`, brief: plainBrief });
  const plain = await prisma.agentTask.findFirst({ where: { parentId: standing.id, title: `${TITLE} plain` } });
  check("without either, the child's input is empty", plain?.input === null, JSON.stringify(plain?.input));
  check("and its brief is byte-for-byte what was given", plain?.brief === plainBrief, plain?.brief);
  check("and it inherits the parent's records, as before", plain?.leadId === null && plain?.clientId === null);

  const messy = await delegate.run({
    agentKey: report.key,
    title: `${TITLE} messy`,
    brief: "Twenty characters at least, written for somebody who was not here.",
    acceptance: ["one", "", "two", "three", "four", "five", "x".repeat(400)],
  });
  const messyChild = await prisma.agentTask.findFirst({ where: { parentId: standing.id, title: `${TITLE} messy` } });
  const kept = (messyChild?.input as { acceptance?: string[] } | null)?.acceptance ?? [];
  check("acceptance is held to four non-empty checks", !messy.isError && kept.length === 4 && kept.every((line) => line.length > 0 && line.length <= 160), JSON.stringify(kept));

  const replay = await delegate.run({ agentKey: report.key, title: `${TITLE} write to A`, brief: "Write the first letter to clinic A from the fault on file.", record: A, acceptance }, { replay: true });
  check("a replayed call after a crash is still answered 'Already queued'", text(replay).includes("Already queued"), text(replay));
  check("and raises nothing", (await prisma.agentTask.count({ where: { parentId: standing.id, title: `${TITLE} write to A` } })) === 1);
  await delegate.run({ agentKey: report.key, title: `${TITLE} write to A`, brief: "Write the first letter to clinic A from the fault on file.", record: A, acceptance });
  check("the same title raised twice on purpose is still two tasks", (await prisma.agentTask.count({ where: { parentId: standing.id, title: `${TITLE} write to A` } })) === 2);

  const nowhere = await delegate.run({ agentKey: report.key, title: `${TITLE} nowhere`, brief: "Twenty characters at least, written out.", record: "lead:no-such-lead" });
  check("a delegation naming a record that does not exist is refused", nowhere.isError === true, text(nowhere));
  check("and files nothing", !(await prisma.agentTask.findFirst({ where: { title: `${TITLE} nowhere` } })));

  const handOff = tool(director, standing, "handOff")!;
  const across = await handOff.run({
    agentKey: report.key === director.key ? "ceo" : report.key,
    title: `${TITLE} across to B`,
    brief: "Everything they need, written out in full for somebody who was not here.",
    why: "It is their craft and not mine.",
    record: B,
    acceptance: ["The audit names the missing certificate."],
  });
  const handed = await prisma.agentTask.findFirst({ where: { parentId: standing.id, title: `${TITLE} across to B` } });
  check("a hand-off carries the record too", !across.isError && handed?.leadId === leadB.id, `${text(across).slice(0, 80)} / ${handed?.leadId}`);
  check("and its acceptance", (handed?.input as { acceptance?: string[] } | null)?.acceptance?.[0] === "The audit names the missing certificate.");

  const rehearsalDelegate = tool(director, rehearsal, "delegate")!;
  const outOfBounds = await rehearsalDelegate.run({ agentKey: report.key, title: `${TITLE} rehearsal out`, brief: "Twenty characters at least, written out.", record: B });
  check("a rehearsal cannot hand work out against somebody else's record", outOfBounds.isError === true, text(outOfBounds));

  await reset();
  await prisma.$disconnect();
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const name of failures) console.log(`  - ${name}`);
    process.exit(1);
  }
}

main().catch(async (err) => {
  console.error(err);
  await reset().catch(() => {});
  await prisma.$disconnect();
  process.exit(1);
});
