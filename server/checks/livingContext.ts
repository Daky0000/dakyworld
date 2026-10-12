/**
 * Living context reaches a prompt once, honestly dated, inside a ceiling — and
 * the brief says what else is happening on the record and what "done" means.
 *
 * Living state (`[state:<key>]` rows, written by `update_living_context`) used
 * to reach an agent three times: recalled into the system prompt as a house
 * rule, printed in the brief, and for a lead printed again in its dossier
 * under a heading calling it "what happened, not what anyone concluded". It was
 * read newest-*created* first although keys are updated in place, so a key
 * refreshed every morning was the first to fall out, and nothing capped it.
 * Nothing told an agent that a colleague was already working the same lead,
 * and an Owner's answer to one agent's question stayed on that one task.
 *
 * Every acceptance criterion is asserted on the real functions — `recall`,
 * `composePrompt`, `describeTask`, `renderDossier`, `livingContextBlock`,
 * `listLivingContext`, `recordOwnerAnswer` — and half of them are negatives:
 * an ordinary shared memory must still be recalled, the full dossier must still
 * print what the brief now leaves out, a deliberate repeat must still be
 * possible, and a brief with no acceptance must read byte for byte as it did.
 *
 * Database only. No key, no network. Every row it creates is removed, including
 * the baseline company keys if this database did not have them yet.
 */
import type { Agent, AgentTask } from "@prisma/client";
import { prisma } from "../src/lib/prisma.js";
import {
  BASELINE_STATE_KEYS,
  MemoryRefused,
  ensureBaselineLivingContext,
  livingContextBlock,
  recall,
  remember,
  upsertLivingContext,
} from "../src/services/agents/memory.js";
import { appendNote, listLivingContext, renderDossier } from "../src/services/context/dossier.js";
import { describeTask } from "../src/services/agents/context.js";
import { composePrompt } from "../src/services/agents/runner.js";
import { recordOwnerAnswer } from "../src/services/agents/escalations.js";

let bad = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(ok ? `  ok    ${label}` : `  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) bad += 1;
}

const MARK = "check-livingctx";
const AGENT = "check.livingctx.agent";
const COLLEAGUE_B = "check.livingctx.b";
const COLLEAGUE_C = "check.livingctx.c";
const COLLEAGUE_D = "check.livingctx.d";
const AGENTS = [AGENT, COLLEAGUE_B, COLLEAGUE_C, COLLEAGUE_D];
const COMPANY_KEY_PREFIX = "check_lc_c_";

const pad = (n: number, width = 2) => String(n).padStart(width, "0");
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;
/** The keys a living-context block printed, by section. */
function keysIn(block: string | null): { company: string[]; record: string[] } {
  const company: string[] = [];
  const record: string[] = [];
  for (const line of (block ?? "").split("\n")) {
    const match = /^- \*\*([^*]+)\*\*( \([^)]+\))?:/.exec(line);
    if (match) (match[2] ? record : company).push(match[1]);
  }
  return { company, record };
}

/**
 * describeTask() as the code before this change printed it, captured from that
 * code. The company living-context block depends on the database, so it was
 * replaced by a token at capture and is put back from the current code here.
 */
const FIXTURE = {
  withInput:
    'TASK: Fixture: write the quarterly note\n\nWrite the quarterly note for the board.\nKeep it to one page.\n\nDue: 2026-11-02.\n\n{{LIVING_CONTEXT}}\n\nAdditional context supplied with the task:\n{\n "audience": "board",\n "points": [\n  "cash",\n  "hiring"\n ],\n "depth": {\n  "level": 2,\n  "note": "plain"\n }\n}\n\nWork the task. Use your tools to establish what is true before you conclude anything. When your work establishes or updates a key state fact (e.g. decision_maker, bleeding_neck_fault, matched_outreach_scenario, price_anchor_quoted, payment_gate_status, active_campaign_hook), call `update_living_context` so the next agent in the chain sees the updated state immediately.',
  noInput:
    "TASK: Fixture: write the quarterly note\n\nWrite the quarterly note for the board.\nKeep it to one page.\n\n{{LIVING_CONTEXT}}\n\nWork the task. Use your tools to establish what is true before you conclude anything. When your work establishes or updates a key state fact (e.g. decision_maker, bleeding_neck_fault, matched_outreach_scenario, price_anchor_quoted, payment_gate_status, active_campaign_hook), call `update_living_context` so the next agent in the chain sees the updated state immediately.",
};
/** The one paragraph this change removes on purpose. */
const TRAILER_START = "\n\nWork the task. Use your tools";

async function reset() {
  const leads = await prisma.lead.findMany({ where: { contactName: { startsWith: MARK } }, select: { id: true } });
  const leadSubjects = leads.map((lead) => `lead:${lead.id}`);
  await prisma.contextNote.deleteMany({ where: { subject: { in: leadSubjects } } });
  await prisma.agentMemory.deleteMany({
    where: {
      OR: [
        { subject: { in: leadSubjects } },
        { agentKey: { in: AGENTS } },
        { subject: "company", content: { startsWith: `[state:${COMPANY_KEY_PREFIX}` } },
        { scope: "SHARED", content: { contains: MARK } },
      ],
    },
  });
  await prisma.agentTask.deleteMany({ where: { agentKey: { in: AGENTS } } });
  await prisma.agent.deleteMany({ where: { key: { in: AGENTS } } });
  await prisma.lead.deleteMany({ where: { id: { in: leads.map((lead) => lead.id) } } });
}

await reset();

// The baseline company keys are seeded on boot. A database that has never
// booted does not have them; the ones this check creates, it removes.
const baselineWhere = { scope: "SHARED" as const, subject: "company", OR: BASELINE_STATE_KEYS.map((key) => ({ content: { startsWith: `[state:${key}] ` } })) };
const baselineBefore = new Set((await prisma.agentMemory.findMany({ where: baselineWhere, select: { id: true } })).map((row) => row.id));
await ensureBaselineLivingContext();
const baselineCreated = (await prisma.agentMemory.findMany({ where: baselineWhere, select: { id: true } }))
  .map((row) => row.id)
  .filter((id) => !baselineBefore.has(id));

for (const [key, name] of [
  [AGENT, "Living Check Agent"],
  [COLLEAGUE_B, "Living Check Researcher"],
  [COLLEAGUE_C, "Living Check Writer"],
  [COLLEAGUE_D, "Living Check Manager"],
] as const) {
  await prisma.agent.create({
    data: { key, name, title: name, tier: "SUB_AGENT", department: "MARKETING", status: "ACTIVE", mission: "Exists for the length of this check.", custom: true },
  });
}
const agentRow: Agent = await prisma.agent.findUniqueOrThrow({ where: { key: AGENT } });

const newLead = (label: string) => prisma.lead.create({ data: { contactName: `${MARK} ${label}`, companyName: `${label} Ltd`, leadScore: 0 } });
const leadX = await newLead("X");
const leadY = await newLead("Y");
const leadZ = await newLead("Z");
const leadL = await newLead("L");
const leadQ = await newLead("Q");
const leadW = await newLead("W");
const subjectX = `lead:${leadX.id}`;

const newTask = (data: Partial<AgentTask> & { agentKey: string; title: string }) =>
  prisma.agentTask.create({ data: { brief: "Exists for the length of this check.", ...data } as never });

try {
  // -------------------------------------------------------------------------
  console.log("\nLiving state reaches a prompt through one channel");
  for (let i = 1; i <= 30; i += 1) {
    await upsertLivingContext({ subject: "company", key: `${COMPANY_KEY_PREFIX}${pad(i)}`, value: `company value ${i}`, agentKey: COLLEAGUE_D });
  }
  for (let i = 1; i <= 3; i += 1) {
    await upsertLivingContext({ subject: subjectX, key: `check_lc_x_${i}`, value: `lead value ${i}`, agentKey: COLLEAGUE_B });
  }
  const houseRules = [
    `${MARK}: never quote a price before the audit has been read.`,
    `${MARK}: every proposal carries two options, never one.`,
  ];
  for (const content of houseRules) {
    await remember({ agentKey: AGENT, authorKey: "owner", kind: "PREFERENCE", subject: "company", content, shared: true, importance: 5 });
  }
  const sharedOnRecord = `${MARK}: the owner of this business answers WhatsApp, not email.`;
  await remember({ agentKey: COLLEAGUE_B, kind: "FACT", subject: subjectX, content: sharedOnRecord, shared: true, importance: 4 });
  const ownMemories = [`${MARK}: this lead's site was audited and scored poorly on mobile.`, `${MARK}: I write shorter openings since the last reply.`];
  await remember({ agentKey: AGENT, kind: "FACT", subject: subjectX, content: ownMemories[0], importance: 4 });
  await remember({ agentKey: AGENT, kind: "LESSON", subject: "self", content: ownMemories[1], importance: 4 });

  const recalled = await recall(AGENT, [subjectX]);
  check("recall returns no living-state line", recalled.every((memory) => !memory.line.includes("[state:")), recalled.map((m) => m.line).filter((l) => l.includes("[state:")).slice(0, 3).join(" | "));
  for (const rule of houseRules) {
    check(`the Owner's house rule is still recalled, as shared: "${rule.slice(MARK.length + 2, MARK.length + 32)}…"`, recalled.some((memory) => memory.shared && memory.line.includes(rule)));
  }
  check("an ordinary shared memory on the record is still recalled", recalled.some((memory) => memory.shared && memory.line.includes(sharedOnRecord)));
  for (const own of ownMemories) {
    check(`the agent's own memory is still recalled, as its own: "${own.slice(MARK.length + 2, MARK.length + 32)}…"`, recalled.some((memory) => !memory.shared && memory.line.includes(own)));
  }

  const regions = await composePrompt(agentRow, recalled);
  const promptText = regions.map((region) => region.text).filter(Boolean).join("\n\n");
  check("composePrompt prints no living state", !promptText.includes("[state:"));
  check("and still prints the house rules it was given", houseRules.every((rule) => regions.find((region) => region.key === "shared")?.text.includes(rule)));
  const working = regions.find((region) => region.key === "working")?.text ?? "";
  check("the working region names update_living_context exactly once", count(working, "update_living_context") === 1, `${count(working, "update_living_context")}`);

  const taskX = await newTask({ agentKey: AGENT, title: `${MARK} work lead X`, leadId: leadX.id });
  const briefX = await describeTask(taskX);
  for (let i = 1; i <= 3; i += 1) {
    check(`the brief carries record key ${i} exactly once`, count(briefX, `**check_lc_x_${i}**`) === 1, `${count(briefX, `**check_lc_x_${i}**`)}`);
  }
  const companyShown = keysIn(briefX.split("\n\nWHAT THIS IS ABOUT")[0]).company.filter((key) => key.startsWith(COMPANY_KEY_PREFIX));
  check("company keys are in the brief", companyShown.length > 0, `${companyShown.length}`);
  check("and no company key is printed twice", Array.from({ length: 30 }, (_, i) => count(briefX, `**${COMPANY_KEY_PREFIX}${pad(i + 1)}**`)).every((n) => n <= 1));
  const dossierPart = briefX.slice(briefX.indexOf("WHAT WE ALREADY KNOW ABOUT THIS COMPANY"));
  check("the brief has a dossier", briefX.includes("WHAT WE ALREADY KNOW ABOUT THIS COMPANY"));
  check("whose brief form has no Active Living Context section", !dossierPart.includes("Active Living Context"));
  check("and no pinned [State: …] note", !dossierPart.includes("[State:"));
  check("the brief no longer tells the agent to call update_living_context", !briefX.includes("update_living_context"));

  const fullX = await renderDossier(subjectX);
  check("the full dossier still has the Active Living Context section", fullX.includes("Active Living Context"));
  check("and still lists the pinned [State: …] notes", fullX.includes("[State: check_lc_x_1]"));
  check("and the record keys in its whiteboard", fullX.includes("`check_lc_x_2`"));

  // The Owner can unpin a state note. It must not come back into the brief as a
  // dated line under "What has happened" instead.
  await prisma.contextNote.updateMany({ where: { subject: subjectX, summary: { startsWith: "[State: check_lc_x_1]" } }, data: { pinned: false } });
  const unpinnedBrief = await describeTask(taskX);
  check("an unpinned state note stays out of the brief's dossier", !unpinnedBrief.slice(unpinnedBrief.indexOf("WHAT WE ALREADY KNOW")).includes("[State:"));
  check("and the brief still carries that key once", count(unpinnedBrief, "**check_lc_x_1**") === 1);
  check("while the full dossier still lists it", (await renderDossier(subjectX)).includes("[State: check_lc_x_1]"));

  // A dossier longer than the brief prints names the agent's road to the rest.
  const leadH = await newLead("H");
  for (let i = 1; i <= 15; i += 1) {
    await appendNote({ subject: `lead:${leadH.id}`, summary: `${MARK} history entry ${i}`, authorKey: COLLEAGUE_B, occurredAt: new Date(Date.now() - i * 60_000) });
  }
  const briefH = await describeTask(await newTask({ agentKey: AGENT, title: `${MARK} work lead H`, leadId: leadH.id }));
  check("a long history in the brief points at readHistory", briefH.includes("not shown. Use `readHistory` with a larger limit"), briefH.split("\n").find((line) => line.includes("older entr")));
  check("not at context.read, which no agent is granted", !briefH.includes("context.read"));

  const companyOnly = await livingContextBlock([]);
  const companyTotal = await prisma.agentMemory.count({ where: { scope: "SHARED", subject: "company", content: { startsWith: "[state:" } } });
  const companyShownAlone = keysIn(companyOnly).company.length;
  check("thirty-plus company keys show no more than twenty-five", companyShownAlone > 0 && companyShownAlone <= 25, `${companyShownAlone} of ${companyTotal}`);
  check("the most recently updated of them first", keysIn(companyOnly).company[0] === `${COMPANY_KEY_PREFIX}30`, keysIn(companyOnly).company[0]);
  check("and say how many more there are", (companyOnly ?? "").includes(`${companyTotal - keysIn(companyOnly).company.length} more not shown.`), (companyOnly ?? "").split("\n").pop());
  const noRecordBrief = await describeTask(await newTask({ agentKey: AGENT, title: `${MARK} about no record` }));
  check("a brief about no record says how many more there are", /\n\d+ more not shown\.\n/.test(`${noRecordBrief}\n`), noRecordBrief.split("\n").find((line) => line.includes("more not shown")));
  check("without naming readHistory, which a task about no record is not sent", !noRecordBrief.includes("readHistory"));

  // -------------------------------------------------------------------------
  console.log("\nRecency is the last update, not the first write");
  await prisma.agentMemory.deleteMany({ where: { subject: "company", content: { startsWith: `[state:${COMPANY_KEY_PREFIX}` } } });
  const subjectY = `lead:${leadY.id}`;
  await upsertLivingContext({ subject: subjectY, key: "check_lc_y_old", value: "first value", agentKey: COLLEAGUE_B });
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000);
  await prisma.agentMemory.updateMany({
    where: { subject: subjectY, content: { startsWith: "[state:check_lc_y_old] " } },
    data: { createdAt: twoHoursAgo, updatedAt: twoHoursAgo },
  });
  for (let i = 1; i <= 45; i += 1) {
    await upsertLivingContext({ subject: subjectY, key: `check_lc_y_${pad(i)}`, value: `y${i}`, agentKey: COLLEAGUE_B });
  }
  const beforeUpdate = await livingContextBlock([subjectY]);
  check("with 45 newer keys, the untouched old key is past the forty read", !keysIn(beforeUpdate).record.includes("check_lc_y_old"));

  const upsertFrom = Date.now();
  await upsertLivingContext({ subject: subjectY, key: "check_lc_y_old", value: "fresh value", agentKey: COLLEAGUE_C });
  const upsertTo = Date.now();
  const afterUpdate = await livingContextBlock([subjectY]);
  check("once updated, livingContextBlock shows it again", (afterUpdate ?? "").includes(`**check_lc_y_old** (${subjectY}): fresh value`));
  const listed = await listLivingContext(subjectY);
  const old = listed.find((item) => item.key === "check_lc_y_old");
  check("listLivingContext shows it", Boolean(old));
  check("first, as the most recently updated", listed[0]?.key === "check_lc_y_old", listed[0]?.key);
  const reported = old?.updatedAt.getTime() ?? 0;
  check("reporting the time of the update", reported >= upsertFrom - 5 && reported <= upsertTo + 5, old?.updatedAt.toISOString());
  check("not the time it was first written", Math.abs(reported - twoHoursAgo.getTime()) > 60 * 60_000);
  check("with the new value", old?.value.startsWith("fresh value") ?? false, old?.value);

  for (let i = 46; i <= 59; i += 1) {
    await upsertLivingContext({ subject: subjectY, key: `check_lc_y_${pad(i)}`, value: `y${i}`, agentKey: COLLEAGUE_B });
  }
  const recordKeys = await prisma.agentMemory.count({ where: { scope: "SHARED", subject: subjectY, content: { startsWith: "[state:" } } });
  check("the record now holds sixty keys", recordKeys === 60, `${recordKeys}`);

  const alone = await livingContextBlock([]);
  const beside = await livingContextBlock([subjectY]);
  const shownBeside = new Set(keysIn(beside).company);
  // The company half of the room is promised to company state whatever a
  // record holds: every company line that fits in it alone must survive sixty
  // record keys. 2,500 is under half of what the block allows for lines.
  const aloneLines = (alone ?? "").split("\n").filter((line) => /^- \*\*[^*]+\*\*:/.test(line));
  const halfRoom: string[] = [];
  for (let used = 0, i = 0; i < aloneLines.length && used + aloneLines[i].length + 1 <= 2_500; used += aloneLines[i].length + 1, i += 1) {
    halfRoom.push(keysIn(aloneLines[i]).company[0]);
  }
  check("record keys never push out the company's half of the room", halfRoom.length > 0 && halfRoom.every((key) => shownBeside.has(key)), halfRoom.filter((key) => !shownBeside.has(key)).join(", "));
  if (BASELINE_STATE_KEYS.every((key) => halfRoom.includes(key))) {
    check("the seven baseline company keys are all shown beside sixty record keys", BASELINE_STATE_KEYS.every((key) => shownBeside.has(key)), BASELINE_STATE_KEYS.filter((key) => !shownBeside.has(key)).join(", "));
  } else {
    // Only on a database whose own company state has outgrown half the block:
    // there it is newer *company* keys that decide which baseline keys show.
    console.log("  note  this database's company state outgrows half the block; the baseline assertion is covered by the line above");
  }
  check("and the newest record keys are shown beside them", keysIn(beside).record.includes("check_lc_y_old"));
  check("with a count of the rest, naming no tool to a caller that has none (a writer)", /\n\d+ more not shown\.$/.test(beside ?? ""), (beside ?? "").split("\n").pop());
  const briefY = await describeTask(await newTask({ agentKey: AGENT, title: `${MARK} work lead Y`, leadId: leadY.id }));
  check("and naming readHistory in the brief of a task about a lead", /\n\d+ more not shown — read them with `readHistory`\.\n/.test(briefY), briefY.split("\n").find((line) => line.includes("more not shown")));

  // -------------------------------------------------------------------------
  console.log("\nThe block has a ceiling");
  const subjectZ = `lead:${leadZ.id}`;
  const longValue = (i: number) => `value ${i} — ${"a long-winded description of where this stands ".repeat(10)}`.slice(0, 480);
  for (let i = 1; i <= 200; i += 1) {
    await upsertLivingContext({ subject: subjectZ, key: `check_lc_z_${pad(i, 3)}`, value: longValue(i), agentKey: COLLEAGUE_B });
  }
  const capped = (await livingContextBlock([subjectZ])) ?? "";
  check("two hundred long values render under 6,000 characters", capped.length > 0 && capped.length < 6_000, `${capped.length}`);
  const rendered = keysIn(capped);
  const companyNow = await prisma.agentMemory.count({ where: { scope: "SHARED", subject: "company", content: { startsWith: "[state:" } } });
  const hiddenMatch = /(\d+) more not shown\.$/.exec(capped);
  const expectedHidden = companyNow + 200 - rendered.company.length - rendered.record.length;
  check("and say exactly how many were not shown", Number(hiddenMatch?.[1]) === expectedHidden, `said ${hiddenMatch?.[1]}, expected ${expectedHidden}`);
  check("still showing some of the record's own keys", rendered.record.length > 0, `${rendered.record.length}`);
  check("and some of the company's", rendered.company.length > 0, `${rendered.company.length}`);

  let refused = false;
  try {
    await upsertLivingContext({ subject: subjectZ, key: "check_lc_secret", value: "the password is Hunter2000!", agentKey: COLLEAGUE_B });
  } catch (err) {
    refused = err instanceof MemoryRefused;
  }
  check("a credential-shaped value is still refused", refused);
  check("and nothing was written for it", (await prisma.agentMemory.count({ where: { subject: subjectZ, content: { startsWith: "[state:check_lc_secret]" } } })) === 0);

  await upsertLivingContext({ subject: subjectZ, key: "check_lc_z_001", value: "replaced in place", agentKey: COLLEAGUE_C });
  const zRows = await prisma.agentMemory.findMany({ where: { subject: subjectZ, content: { startsWith: "[state:check_lc_z_001] " } } });
  check("an update still replaces in place: one row per (subject, key)", zRows.length === 1, `${zRows.length}`);
  check("holding the new value", zRows[0]?.content.includes("replaced in place") ?? false);
  check("and one pinned note per (subject, key)", (await prisma.contextNote.count({ where: { subject: subjectZ, summary: { startsWith: "[State: check_lc_z_001]" } } })) === 1);

  const multiLine = await upsertLivingContext({ subject: subjectZ, key: "check_lc_z_lines", value: "keep the logo\nkeep the photography", agentKey: COLLEAGUE_C });
  check("a value with a line break in it is shown, on one line", ((await livingContextBlock([subjectZ])) ?? "").includes("**check_lc_z_lines** (" + subjectZ + "): keep the logo keep the photography"), multiLine.content);
  check("and listed in the dossier's whiteboard", (await listLivingContext(subjectZ)).some((item) => item.key === "check_lc_z_lines"));

  // -------------------------------------------------------------------------
  console.log("\nThe brief says what else is happening on the record");
  const hoursAgo = (h: number) => new Date(Date.now() - h * 60 * 60_000);
  const parent = await newTask({ agentKey: COLLEAGUE_D, title: `${MARK} parent: win lead L`, leadId: leadL.id, status: "RUNNING", startedAt: hoursAgo(1) });
  const subjectTask = await newTask({ agentKey: AGENT, title: `${MARK} subject: write to lead L`, leadId: leadL.id, status: "RUNNING", startedAt: new Date(), parentId: parent.id, origin: "AGENT" });
  await newTask({ agentKey: COLLEAGUE_C, title: `${MARK} child: check the draft`, leadId: leadL.id, status: "QUEUED", parentId: subjectTask.id, origin: "AGENT" });
  await newTask({ agentKey: COLLEAGUE_B, title: `${MARK} B: research the owner`, leadId: leadL.id, status: "RUNNING", startedAt: hoursAgo(0.25) });
  const longSummary = `Found the owner's direct line and confirmed the clinic opened a second branch in March. ${"Nothing else of note came up in the registry or on their pages. ".repeat(4)}`;
  await newTask({ agentKey: COLLEAGUE_C, title: `${MARK} C: draft the first letter`, leadId: leadL.id, status: "DONE", startedAt: hoursAgo(2.5), finishedAt: hoursAgo(2), summary: longSummary });
  await newTask({ agentKey: COLLEAGUE_D, title: `${MARK} D: rehearse the chain`, leadId: leadL.id, status: "RUNNING", startedAt: hoursAgo(0.5), rehearsal: true });
  await newTask({ agentKey: COLLEAGUE_B, title: `${MARK} E: last week's audit`, leadId: leadL.id, status: "DONE", startedAt: hoursAgo(73), finishedAt: hoursAgo(72), summary: "Audited the site." });

  const briefL = await describeTask(subjectTask);
  const otherBlock = briefL.slice(briefL.indexOf("OTHER WORK ON THIS RECORD"));
  check("the brief has the block", briefL.includes("OTHER WORK ON THIS RECORD (colleagues' reports, not verified):"));
  check("listing B, running, under its agent's name", /- Living Check Researcher \| check-livingctx B: research the owner \| RUNNING \| 15m ago \| no summary yet/.test(otherBlock), otherBlock.split("\n").find((line) => line.includes(" B: ")));
  const cLine = otherBlock.split("\n").find((line) => line.includes(" C: draft the first letter")) ?? "";
  check("listing C, done two hours ago", cLine.includes("| DONE | 2h ago |"), cLine);
  check("with its summary cut to 160 characters", cLine.endsWith(longSummary.replace(/\s+/g, " ").trim().slice(0, 160)), cLine.slice(-80));
  check("omitting the rehearsal", !otherBlock.includes(" D: rehearse"));
  check("omitting what ended three days ago", !otherBlock.includes(" E: last week"));
  check("omitting itself, its parent and its child", !otherBlock.includes("subject: write") && !otherBlock.includes("parent: win") && !otherBlock.includes("child: check"));
  check("and nothing more to count", !otherBlock.includes(" more"));

  for (let i = 1; i <= 6; i += 1) {
    await newTask({ agentKey: i % 2 ? COLLEAGUE_B : COLLEAGUE_C, title: `${MARK} extra ${i}`, leadId: leadL.id, status: "QUEUED" });
  }
  const crowded = await describeTask(subjectTask);
  const crowdedLines = crowded.slice(crowded.indexOf("OTHER WORK ON THIS RECORD")).split("\n").slice(1);
  const taskLines = crowdedLines.filter((line) => line.startsWith("- "));
  check("eight others print five lines", taskLines.length === 5, `${taskLines.length}`);
  check("and '+3 more'", crowdedLines[5] === "+3 more", crowdedLines[5]);
  check("work still in flight is listed before work that has ended", taskLines.every((line) => / \| (QUEUED|RUNNING|BLOCKED|NEEDS_APPROVAL) \| /.test(line)), taskLines.join(" / "));

  const rehearsalTask = await newTask({ agentKey: AGENT, title: `${MARK} rehearsal subject`, leadId: leadL.id, status: "RUNNING", rehearsal: true });
  const rehearsalBrief = await describeTask(rehearsalTask);
  const rehearsalBlock = rehearsalBrief.slice(rehearsalBrief.indexOf("OTHER WORK ON THIS RECORD"));
  check("a rehearsal sees the rehearsal work", rehearsalBlock.includes(" D: rehearse the chain"));
  check("and none of the real work", !rehearsalBlock.includes(" B: research") && !rehearsalBlock.includes(" C: draft") && !rehearsalBlock.includes("extra "));

  const lonely = await newTask({ agentKey: AGENT, title: `${MARK} alone on lead Q`, leadId: leadQ.id });
  check("a record nobody else is working prints no block", !(await describeTask(lonely)).includes("OTHER WORK ON THIS RECORD"));

  // -------------------------------------------------------------------------
  console.log("\nAcceptance is printed as a checklist, and only when there is one");
  const accepted = { id: `${MARK}-acc`, title: "Acceptance check", brief: "Do the thing.", origin: "OWNER", parentId: null, rehearsal: false, dueAt: null,
    leadId: null, clientId: null, projectId: null, proposalId: null, invoiceId: null } as unknown as AgentTask;
  const withList = await describeTask({ ...accepted, input: { acceptance: ["check-acc-alpha is met", "check-acc-beta is met"], tone: "plain" } } as AgentTask);
  check("the heading is printed once", count(withList, "ACCEPTANCE — say, for each, whether it is met:") === 1);
  check("each item is printed once, as a list", count(withList, "check-acc-alpha") === 1 && withList.includes("\n- check-acc-alpha is met\n- check-acc-beta is met"));
  check("the rest of the input is still dumped", withList.includes('"tone": "plain"'));
  check("without the acceptance in it", !withList.includes('"acceptance"'));
  const onlyList = await describeTask({ ...accepted, input: { acceptance: ["check-acc-gamma is met"] } } as AgentTask);
  check("an input that was only acceptance prints no empty JSON", !onlyList.includes("Additional context supplied with the task") && onlyList.includes("- check-acc-gamma is met"));
  const notAList = await describeTask({ ...accepted, input: { acceptance: "a sentence, not a list" } } as AgentTask);
  check("an acceptance that is not a list is left in the JSON, untouched", notAList.includes('"acceptance": "a sentence, not a list"') && !notAList.includes("ACCEPTANCE —"));

  const block = await livingContextBlock([]);
  const fixtureBase = { id: `${MARK}-fixture`, agentKey: AGENT, title: "Fixture: write the quarterly note", brief: "Write the quarterly note for the board.\nKeep it to one page.",
    origin: "OWNER", parentId: null, rehearsal: false, leadId: null, clientId: null, projectId: null, proposalId: null, invoiceId: null, dueAt: new Date("2026-11-02T09:00:00.000Z") };
  const fixtureTasks = {
    withInput: { ...fixtureBase, input: { audience: "board", points: ["cash", "hiring"], depth: { level: 2, note: "plain" } } },
    noInput: { ...fixtureBase, dueAt: null, input: null },
  };
  for (const name of ["withInput", "noInput"] as const) {
    const captured = FIXTURE[name].replace("{{LIVING_CONTEXT}}", block ?? "");
    const expected = captured.slice(0, captured.indexOf(TRAILER_START));
    const now = await describeTask(fixtureTasks[name] as unknown as AgentTask);
    check(`with no acceptance, the brief is the pre-change brief less its trailer (${name})`, now === expected, JSON.stringify(now.slice(-120)));
  }

  // -------------------------------------------------------------------------
  console.log("\nThe Owner's answer is kept on the record it was about");
  const question = "Which should I lead with on this clinic: the audit findings or the 48-hour mobile preview?";
  const answer = "Lead with the 48-hour preview; keep the audit for the call.";
  const blocked = await newTask({ agentKey: AGENT, title: `${MARK} first touch for W`, leadId: leadW.id, status: "BLOCKED", blockedReason: question, finishedAt: new Date() });
  const memoriesBefore = await prisma.agentMemory.count({ where: { agentKey: AGENT } });
  await recordOwnerAnswer(blocked, answer, { who: "Living Check" });
  const notes = await prisma.contextNote.findMany({ where: { sourceTaskId: blocked.id } });
  check("one note is written", notes.length === 1, `${notes.length}`);
  check("on the record the task was about", notes[0]?.subject === `lead:${leadW.id}`, notes[0]?.subject);
  check("as a DECISION", notes[0]?.kind === "DECISION", notes[0]?.kind);
  check("attributed to the Owner", notes[0]?.authorKey === "owner", notes[0]?.authorKey);
  check("saying the answer first", notes[0]?.summary.startsWith(`The Owner decided: ${answer}`) ?? false, notes[0]?.summary);
  check("with the question it answered", (notes[0]?.summary.includes(question) ?? false) && (notes[0]?.body?.includes(question) ?? false));
  check("and the name of whoever typed it", notes[0]?.body?.includes(`The Owner answered (Living Check):\n${answer}`) ?? false, notes[0]?.body ?? "");
  check("and no memory was written for the agent", (await prisma.agentMemory.count({ where: { agentKey: AGENT } })) === memoriesBefore);
  const requeued = await prisma.agentTask.findUniqueOrThrow({ where: { id: blocked.id }, select: { status: true, brief: true } });
  check("the answer still went to the task, which is queued again", requeued.status === "QUEUED" && requeued.brief.includes(answer), requeued.status);
  const nextOnW = await newTask({ agentKey: COLLEAGUE_C, title: `${MARK} follow up W`, leadId: leadW.id });
  check("the next agent on that lead reads the decision in its brief", (await describeTask(nextOnW)).includes(`The Owner decided: ${answer}`));

  const noRecord = await newTask({ agentKey: AGENT, title: `${MARK} about nothing`, status: "BLOCKED", blockedReason: "Which week?", finishedAt: new Date() });
  await recordOwnerAnswer(noRecord, "Next week.", { who: "Living Check" });
  check("an answer on a task about no record writes no note", (await prisma.contextNote.count({ where: { sourceTaskId: noRecord.id } })) === 0);

  const rehearsing = await newTask({ agentKey: AGENT, title: `${MARK} rehearsal on W`, leadId: leadW.id, status: "BLOCKED", blockedReason: "Which offer?", rehearsal: true, finishedAt: new Date() });
  await recordOwnerAnswer(rehearsing, "The first one.", { who: "Living Check" });
  check("an answer to a rehearsal writes no note", (await prisma.contextNote.count({ where: { sourceTaskId: rehearsing.id } })) === 0);

  const secretive = await newTask({ agentKey: AGENT, title: `${MARK} login for W`, leadId: leadW.id, status: "BLOCKED", blockedReason: "How do I get into their site?", finishedAt: new Date() });
  let threw = "";
  try {
    await recordOwnerAnswer(secretive, "Use admin, the password is Hunter2000!", { who: "Living Check" });
  } catch (err) {
    threw = (err as Error).message;
  }
  check("an answer carrying a credential is not filed on the record", (await prisma.contextNote.count({ where: { sourceTaskId: secretive.id } })) === 0);
  check("and the answer itself still goes through", threw === "" && (await prisma.agentTask.findUniqueOrThrow({ where: { id: secretive.id } })).status === "QUEUED", threw);
} finally {
  await reset();
  if (baselineCreated.length > 0) await prisma.agentMemory.deleteMany({ where: { id: { in: baselineCreated } } });
}

const leftovers =
  (await prisma.agent.count({ where: { key: { in: AGENTS } } })) +
  (await prisma.lead.count({ where: { contactName: { startsWith: MARK } } })) +
  (await prisma.agentMemory.count({ where: { OR: [{ content: { contains: MARK } }, { content: { startsWith: `[state:${COMPANY_KEY_PREFIX}` } }] } }));
check("nothing is left behind", leftovers === 0, `${leftovers}`);

console.log(bad ? `\n${bad} PROBLEM(S)` : "\nLiving state is said once, dated honestly and kept inside its ceiling; the brief names the work around it and what done means.");
process.exitCode = bad ? 1 : 0;
await prisma.$disconnect();
