/**
 * What the AUTO hiring policy may decide without a person, and what it may not.
 *
 * 07 has said since the hiring loop shipped that **AUTO decides who exists; it
 * never decides what they may do**. Autonomy 1 and dry run were the whole of
 * that promise, and they hold a *call*, not a *grant*. Under AUTO the toolkit
 * was whatever the Agent Creator — a model — wrote into the design, so a design
 * asking for `email.send` produced an agent holding `email.send` with no person
 * ever having said this agent may write to anybody. Every later decision about
 * it (commissioning, an autonomy raise, approving its first letter) then rested
 * on a grant nobody had made.
 *
 * Now AUTO hires only an agent whose tools just read, and the ordinary reads at
 * that. Anything more is filed as ASK for the Owner. Asserted both ways, and
 * the negatives are the half that matters:
 *
 *  - AUTO with a read-only toolkit still hires, at autonomy 1 with dry run on.
 *  - AUTO with one outward tool creates **nothing**, files the request as ASK,
 *    names the tool, and tells the proposing agent it was not hired.
 *  - The post, the money, the hiring tools, a connected server's tools and any
 *    read that spends are each refused by `autoMayGrant`; every tool in the
 *    catalogue that writes, sends or charges is refused, walked in full.
 *  - `applyHire` itself refuses an automatic decision on such a design and
 *    leaves it PENDING, so the rule holds where the row is written as well as
 *    where the design is filed.
 *  - **ASK is unchanged**: a proposal creates nothing whatever it asks for, and
 *    its reply is the reply it always was.
 *  - A person approving what AUTO referred gets the toolkit they approved.
 *
 * Database only. No key, no network: Slack's env is cleared, so no card is
 * posted and the proposal reports that nobody was notified.
 */
import { applyHire, autoMayGrant, proposeHire, setHirePolicy, type HireDesign } from "../src/services/agents/hiring.js";
import { listAllTools } from "../src/services/tools/catalogue.js";
import { prisma } from "../src/lib/prisma.js";
import { SETTING, clearSettingsCache } from "../src/lib/settings.js";

for (const name of ["SLACK_BOT_TOKEN", "SLACK_WEBHOOK_URL"]) delete process.env[name];

let bad = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(ok ? `  ok    ${label}` : `  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) bad += 1;
}

const MANAGER_KEY = "check.hireauto.manager";
const READER_KEY = "check.hireauto.reader";
const SENDER_KEY = "check.hireauto.sender";
const ASK_READER_KEY = "check.hireauto.askreader";
const ASK_SENDER_KEY = "check.hireauto.asksender";
const HIRE_KEYS = [READER_KEY, SENDER_KEY, ASK_READER_KEY, ASK_SENDER_KEY];
const ALL_KEYS = [MANAGER_KEY, ...HIRE_KEYS];

const policyFound = await prisma.appSetting.findUnique({ where: { key: SETTING.AGENT_HIRE_POLICY } });

/** Delete-only, so the last call cannot re-create what it is there to remove. */
async function clear() {
  await prisma.agentMemory.deleteMany({ where: { agentKey: { in: ALL_KEYS } } });
  await prisma.agentTask.deleteMany({ where: { agentKey: { in: ALL_KEYS } } });
  // Every request this file files, the ones it expects to be referred
  // included: PENDING rows count against the next run's proposal limit.
  await prisma.agentHireRequest.deleteMany({ where: { key: { in: HIRE_KEYS } } });
  await prisma.agent.deleteMany({ where: { key: { in: ALL_KEYS } } });
}

await clear();
await prisma.agent.create({
  data: {
    key: MANAGER_KEY,
    name: "Hire Auto Manager",
    title: "Hire Auto Manager",
    tier: "SUB_AGENT",
    department: "TECHNOLOGY",
    status: "ACTIVE",
    mission: "Exists for the length of this check.",
    custom: true,
  },
});

function design(key: string, toolkit: string[]): HireDesign {
  return {
    key,
    name: `Check ${key.split(".").pop()}`,
    title: "Hiring Policy Check",
    department: "TECHNOLOGY",
    managerKey: MANAGER_KEY,
    mission: "Count the pebbles in the car park for the length of one check.",
    deliverable: "A count of pebbles, and nothing else.",
    rationale: "Nobody on the roster counts pebbles; this design exists only to exercise the policy.",
    skills: ["pebble counting"],
    kpis: ["Pebbles counted"],
    toolkit,
    escalationPolicy: "Escalates anything that is not a pebble.",
    avatar: null,
    prompt: { role: "You count pebbles.", mission: "Count pebbles.", output: "The count." },
  };
}
const agentRow = (key: string) => prisma.agent.findUnique({ where: { key }, select: { toolkit: true, autonomyLevel: true, dryRun: true } });

try {
  const catalogue = await listAllTools();
  const tool = (key: string) => catalogue.find((entry) => entry.key === key);

  console.log("\nWhat AUTO may grant on its own");
  for (const key of ["lead.read", "audit.read", "client.read"]) {
    const found = tool(key);
    check(`${key} — an ordinary read — may be granted`, Boolean(found && autoMayGrant(found)), found ? "refused" : "not in the catalogue");
  }
  const refusedReads: [string, string][] = [
    ["inbox.read", "other people's letters"],
    ["webhooks.read", "what other systems posted to us — inbound WhatsApp and form messages among it"],
    ["finance.read", "the money"],
    ["payment.status", "the money, and it marks an invoice paid"],
    ["analytics.read", "filed under Money"],
    ["agent.roster", "a hiring tool, so a hire made without a person cannot go on to hire"],
    ["site.look", "a read that spends"],
    ["content.factcheck", "a read that spends"],
  ];
  for (const [key, why] of refusedReads) {
    const found = tool(key);
    check(`${key} is refused — ${why}`, Boolean(found) && !autoMayGrant(found!), found ? "granted" : "not in the catalogue");
  }
  // A connected server's tool is whatever its server does; its scope is only
  // what somebody typed on the connection.
  check(
    "a connected server's tool is refused even when it says it reads",
    !autoMayGrant({ key: "mcp.someserver.lookup", scope: "read", spends: false, outward: false, group: "Connected" }),
  );
  const unscoped = catalogue.filter((entry) => entry.scope !== "read" && autoMayGrant(entry)).map((entry) => entry.key);
  check(`no tool that writes, sends or charges may be granted — walked all ${catalogue.length}`, unscoped.length === 0, unscoped.join(", "));
  const loud = catalogue.filter((entry) => (entry.spends || entry.outward) && autoMayGrant(entry)).map((entry) => entry.key);
  check("no tool that spends or leaves the building may be granted", loud.length === 0, loud.join(", "));

  console.log("\nAUTO with a toolkit that only reads still hires");
  await setHirePolicy("AUTO", "checks/hiringAuto");
  {
    const outcome = await proposeHire(design(READER_KEY, ["lead.read", "audit.read"]), { proposedByKey: MANAGER_KEY });
    check("it is hired there and then", outcome.status === "APPROVED" && outcome.createdAgentKey === READER_KEY, `${outcome.status} / ${outcome.createdAgentKey}`);
    check("nothing was referred", outcome.beyondAuto.length === 0, outcome.beyondAuto.join(", "));
    const row = await agentRow(READER_KEY);
    check("with the toolkit it asked for", row?.toolkit.join("|") === "lead.read|audit.read", row?.toolkit.join(", "));
    check("at autonomy 1 with dry run on", row?.autonomyLevel === 1 && row?.dryRun === true, `${row?.autonomyLevel} / ${row?.dryRun}`);
  }

  console.log("\nAUTO with one tool beyond reading creates nothing");
  {
    const agentsBefore = await prisma.agent.count();
    const outcome = await proposeHire(design(SENDER_KEY, ["lead.read", "email.send"]), { proposedByKey: MANAGER_KEY });
    check("no agent exists", (await agentRow(SENDER_KEY)) === null);
    check("the roster did not grow", (await prisma.agent.count()) === agentsBefore, `${agentsBefore} → ${await prisma.agent.count()}`);
    check("the request waits on a person", outcome.status === "PENDING" && outcome.createdAgentKey === null, `${outcome.status} / ${outcome.createdAgentKey}`);
    check("and is filed as ASK, so it carries Approve and Decline rather than an Undo", outcome.policy === "ASK", outcome.policy);
    const stored = await prisma.agentHireRequest.findUnique({ where: { id: outcome.requestId }, select: { policy: true, status: true, toolkit: true } });
    check("stored that way too", stored?.policy === "ASK" && stored?.status === "PENDING", `${stored?.policy} / ${stored?.status}`);
    check("the tool that referred it is named", outcome.beyondAuto.join("|") === "email.send", outcome.beyondAuto.join(", "));
    check(
      "and the proposing agent is told it was not hired, and why",
      outcome.message.includes("Not hired") && outcome.message.includes("email.send"),
      outcome.message.slice(0, 200),
    );
    check("the design keeps the tool it asked for, for the person to decide on", stored?.toolkit.includes("email.send") === true, stored?.toolkit.join(", "));

    // The preview the approver reads when the Agent Creator's own call is
    // held must say the same thing the proposal does.
    const hireTool = tool("agent.hire");
    const preview = hireTool?.preview
      ? await hireTool.preview(design("check.hireauto.preview", ["lead.read", "email.send"]), { agentKey: MANAGER_KEY, userId: null, taskId: null, dryRun: true })
      : "";
    check("the agent.hire preview says it would go to the Owner", preview.includes("would go to the Owner") && preview.includes("email.send"), preview.slice(-220));
    const readPreview = hireTool?.preview
      ? await hireTool.preview(design("check.hireauto.preview", ["lead.read"]), { agentKey: MANAGER_KEY, userId: null, taskId: null, dryRun: true })
      : "";
    check("and for a reader that it would be created", readPreview.includes("create the agent immediately"), readPreview.slice(-160));

    // The rule held where an agent is made, not only where a design is filed:
    // an automatic decision that reaches `applyHire` by any road grants
    // nothing beyond reading.
    let refusedAtApply = "";
    try {
      await applyHire(outcome.requestId, { by: "checks/hiringAuto, standing in for the AUTO policy", automatic: true });
    } catch (err) {
      refusedAtApply = (err as Error).message;
    }
    check("applyHire itself refuses an automatic decision on it", refusedAtApply.includes("email.send"), refusedAtApply || "it was created");
    check("and that refusal creates nothing", (await agentRow(SENDER_KEY)) === null);
    const stillWaiting = await prisma.agentHireRequest.findUnique({ where: { id: outcome.requestId }, select: { status: true } });
    check("and leaves the request waiting on a person", stillWaiting?.status === "PENDING", stillWaiting?.status);

    console.log("\nA person approving what AUTO referred decides the grant");
    const applied = await applyHire(outcome.requestId, { by: "checks/hiringAuto, standing in for the Owner" });
    const row = await agentRow(applied.agentKey);
    check("the agent exists once a person approves", applied.agentKey === SENDER_KEY && row !== null, applied.agentKey);
    check("holding what the person approved", row?.toolkit.includes("email.send") === true, row?.toolkit.join(", "));
    check("still at autonomy 1 with dry run on", row?.autonomyLevel === 1 && row?.dryRun === true, `${row?.autonomyLevel} / ${row?.dryRun}`);
  }

  console.log("\nASK is unchanged");
  await setHirePolicy("ASK", "checks/hiringAuto");
  for (const [key, toolkit] of [
    [ASK_READER_KEY, ["lead.read"]],
    [ASK_SENDER_KEY, ["lead.read", "email.send"]],
  ] as const) {
    const agentsBefore = await prisma.agent.count();
    const outcome = await proposeHire(design(key, [...toolkit]), { proposedByKey: MANAGER_KEY });
    const label = toolkit.join(" + ");
    check(`${label}: a proposal under ASK creates nothing`, (await agentRow(key)) === null && (await prisma.agent.count()) === agentsBefore);
    check(`${label}: it waits on a person, as ASK`, outcome.status === "PENDING" && outcome.policy === "ASK", `${outcome.status} / ${outcome.policy}`);
    check(`${label}: nothing is said about AUTO`, outcome.beyondAuto.length === 0 && !outcome.message.includes("Not hired"), outcome.message.slice(0, 160));
    check(
      `${label}: the reply is the one ASK always gave`,
      outcome.message ===
        "Proposed, and recorded in the app under Agents. Slack is not connected, so nobody has been notified — say in your summary that a person needs to look at it.",
      outcome.message.slice(0, 160),
    );
  }
} finally {
  await clear();
  await prisma.appSetting.deleteMany({ where: { key: SETTING.AGENT_HIRE_POLICY } });
  if (policyFound) {
    await prisma.appSetting.create({ data: { key: policyFound.key, value: policyFound.value, secret: policyFound.secret } });
  }
  clearSettingsCache();
}

await prisma.$disconnect();
console.log(bad === 0 ? "\nAll good.\n" : `\n${bad} problem(s).\n`);
process.exit(bad === 0 ? 0 : 1);
