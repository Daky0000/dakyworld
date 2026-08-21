/**
 * Does a spending ceiling do what it says, and only what it says?
 *
 * A budget is the one feature here that works by *stopping* things, which makes
 * both of its failure modes expensive and neither of them loud. Set too weakly
 * it is decoration and the runaway it exists to catch happens anyway. Set too
 * broadly it silently stops a working business, and the symptom — agents doing
 * nothing — looks exactly like a bug in the agents.
 *
 * So the negatives here outnumber the positives, and they are the point:
 *
 *   - **Nothing is enforced until a ceiling exists.** The shipped state is no
 *     budgets and no behaviour change. A default ceiling would stop a business
 *     on the day it deployed.
 *   - **Zero is a ceiling, not an absence.** "Stop all spend on this scope" is
 *     the obvious way to type it, and the usual `> 0` guard reads it as unset —
 *     the same trap `Rehearsal.budgetUsd` carries a comment about.
 *   - **A read is never held.** Only a tool that *spends* is gated. A blanket
 *     hold blinds every agent without saving a penny, which is the mistake
 *     `rehearsals/policy.ts` argues out at length.
 *   - **An unbudgeted agent still really works.** The check that catches this
 *     whole feature being wired up too broadly.
 *   - **A hard ceiling outranks an approval.** Approving a letter is a decision
 *     about the letter, not a decision to go over budget.
 *
 * A database and nothing else. No API key, no network.
 *   npx tsx checks/budgets.ts
 */
import { prisma } from "../src/lib/prisma.js";
import { check, forgetBudgets, periodStart, removeBudget, setBudget, spentIn, stateFor, stricter } from "../src/services/budgets.js";
import { permissionFor } from "../src/services/tools/invoke.js";
import { findTool } from "../src/services/tools/catalogue.js";

const failures: string[] = [];
let passed = 0;

function ok(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed += 1;
    console.log(`  ok    ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const AGENT = "check-budget-agent";
const POOR_AGENT = "check-budget-poor";
const PURPOSE = "check.budgets";

/**
 * A tool that spends, and one that does not, both taken from the real
 * catalogue — inventing a fake tool here would test a fake gate.
 */
const SPENDING_TOOL = "capture.run";
const READ_TOOL = "lead.read";

async function reset() {
  await prisma.llmCall.deleteMany({ where: { purpose: { startsWith: PURPOSE } } });
  await prisma.budget.deleteMany({ where: { scopeId: { in: [AGENT, POOR_AGENT, SPENDING_TOOL, ""] } } });
  await prisma.agent.deleteMany({ where: { key: { in: [AGENT, POOR_AGENT] } } });
  forgetBudgets();
}

/** Two agents at full autonomy, so nothing but a budget can hold them back. */
async function seedAgents() {
  for (const key of [AGENT, POOR_AGENT]) {
    await prisma.agent.create({
      data: {
        key,
        name: key,
        title: "A check",
        tier: "SUB_AGENT",
        department: "TECHNOLOGY",
        status: "ACTIVE",
        // 5 clears both EXECUTE_LEVEL and SPEND_LEVEL, and dry run is off, so a
        // hold in the results below can only have come from a budget.
        autonomyLevel: 5,
        dryRun: false,
        mission: "Being checked.",
        toolkit: [SPENDING_TOOL, READ_TOOL],
      },
    });
  }
}

/** Spend attributed to an agent, inside the current month and day. */
async function spend(agentKey: string, costUsd: number) {
  await prisma.llmCall.create({
    data: {
      purpose: PURPOSE,
      model: "claude-opus-5",
      agentKey,
      inputTokens: 10,
      outputTokens: 1,
      costUsd: costUsd.toFixed(6),
      durationMs: 1,
      ok: true,
    },
  });
  forgetBudgets();
}

async function main() {
  await reset();
  await seedAgents();

  const spendingTool = findTool(SPENDING_TOOL);
  const readTool = findTool(READ_TOOL);
  if (!spendingTool || !readTool) throw new Error("The catalogue no longer has the tools this check is built on.");
  ok("the spending tool really spends", spendingTool.spends === true);
  ok("the read tool really does not", readTool.spends === false);

  console.log("\nNothing is enforced until a ceiling exists");
  ok("no budget means no state", (await stateFor({ scopeType: "AGENT", scopeId: AGENT }, "MONTH")) === null);
  ok("no budget means no action", (await check([{ scopeType: "AGENT", scopeId: AGENT }])).action === "none");

  // The one that catches this being wired up too broadly. An agent nobody has
  // budgeted must be exactly as free as it was before this feature existed.
  const before = await permissionFor(spendingTool, { agentKey: AGENT, userId: null, dryRun: false });
  ok("an unbudgeted agent may still really spend", before.allowed && !before.mustDryRun, JSON.stringify(before));

  console.log("\nThe four thresholds");
  await setBudget({ scopeType: "AGENT", scopeId: AGENT, period: "MONTH", hardLimitUsd: 100 });

  await spend(AGENT, 10);
  ok("under half is nothing at all", (await stateFor({ scopeType: "AGENT", scopeId: AGENT }, "MONTH"))?.action === "none");

  await spend(AGENT, 45); // 55
  ok("half warns", (await stateFor({ scopeType: "AGENT", scopeId: AGENT }, "MONTH"))?.action === "warn");

  await spend(AGENT, 22); // 77
  ok("three quarters downgrades", (await stateFor({ scopeType: "AGENT", scopeId: AGENT }, "MONTH"))?.action === "downgrade");

  await spend(AGENT, 15); // 92
  ok("ninety per cent asks", (await stateFor({ scopeType: "AGENT", scopeId: AGENT }, "MONTH"))?.action === "approve");

  await spend(AGENT, 10); // 102
  const paused = await stateFor({ scopeType: "AGENT", scopeId: AGENT }, "MONTH");
  ok("the ceiling pauses", paused?.action === "pause");
  ok("and says what it spent and what it was allowed", Boolean(paused?.note?.includes("102.00") && paused?.note?.includes("100.00")), paused?.note ?? "");

  console.log("\nWhat a ceiling does to the tool gate");
  const held = await permissionFor(spendingTool, { agentKey: AGENT, userId: null, dryRun: false });
  ok("a spending tool is refused outright", !held.allowed, JSON.stringify(held));
  ok("the refusal names the ceiling", Boolean(held.reason?.includes("ceiling")), held.reason ?? "");

  // The one that keeps this from blinding the workforce. A read costs nothing,
  // and holding it saves nothing and stops the agent establishing anything.
  const stillReads = await permissionFor(readTool, { agentKey: AGENT, userId: null, dryRun: false });
  ok("a read is untouched by a spending ceiling", stillReads.allowed && !stillReads.mustDryRun, JSON.stringify(stillReads));

  // Approving a letter is a decision about the letter, not a decision to go
  // over budget — and the sentence that comes back says how to fix it.
  const approved = await permissionFor(spendingTool, { agentKey: AGENT, userId: null, dryRun: false, approvedRequestId: "check-approval" });
  ok("an approval does not lift a hard ceiling", !approved.allowed, JSON.stringify(approved));

  // A person driving the tool directly is making the decision themselves, the
  // same reason `asOwner` skips every other check.
  const owner = await permissionFor(spendingTool, { agentKey: null, userId: "check", dryRun: false, asOwner: true });
  ok("a person is not stopped by an agent's ceiling", owner.allowed && !owner.mustDryRun);

  console.log("\nAt ninety per cent it prepares instead of refusing");
  await prisma.llmCall.deleteMany({ where: { purpose: { startsWith: PURPOSE }, agentKey: AGENT } });
  await spend(AGENT, 92);
  const prepares = await permissionFor(spendingTool, { agentKey: AGENT, userId: null, dryRun: false });
  ok("it is allowed but held at a preview", prepares.allowed && prepares.mustDryRun, JSON.stringify(prepares));
  // At this level an approval must go through, or a card could be raised and
  // never carried out and the queue would fill with re-asks.
  const carriedOut = await permissionFor(spendingTool, { agentKey: AGENT, userId: null, dryRun: false, approvedRequestId: "check-approval" });
  ok("an approval at this level does carry out", carriedOut.allowed && !carriedOut.mustDryRun, JSON.stringify(carriedOut));

  console.log("\nZero is a ceiling, not an absence");
  await setBudget({ scopeType: "AGENT", scopeId: POOR_AGENT, period: "MONTH", hardLimitUsd: 0 });
  const zero = await stateFor({ scopeType: "AGENT", scopeId: POOR_AGENT }, "MONTH");
  ok("a zero ceiling pauses with nothing spent", zero?.action === "pause", JSON.stringify(zero));
  const zeroHeld = await permissionFor(spendingTool, { agentKey: POOR_AGENT, userId: null, dryRun: false });
  ok("and the gate refuses on it", !zeroHeld.allowed);

  console.log("\nA soft limit warns and never stops");
  await setBudget({ scopeType: "AGENT", scopeId: POOR_AGENT, period: "MONTH", softLimitUsd: 1, hardLimitUsd: null });
  await spend(POOR_AGENT, 5);
  const soft = await stateFor({ scopeType: "AGENT", scopeId: POOR_AGENT }, "MONTH");
  ok("a soft limit alone warns", soft?.action === "warn", JSON.stringify(soft));
  ok("a soft limit has no fraction to report", soft?.fraction === null);
  const softGate = await permissionFor(spendingTool, { agentKey: POOR_AGENT, userId: null, dryRun: false });
  ok("a warning does not hold anything", softGate.allowed && !softGate.mustDryRun);

  console.log("\nSeveral ceilings at once");
  await setBudget({ scopeType: "GLOBAL", period: "MONTH", hardLimitUsd: 1_000_000 });
  const both = await check([{ scopeType: "GLOBAL", scopeId: "" }, { scopeType: "AGENT", scopeId: POOR_AGENT }]);
  ok("the strictest of them wins", both.action === "warn", JSON.stringify(both.action));
  ok("the sentence comes from the one causing it", both.note?.includes(POOR_AGENT) === true, both.note ?? "");
  ok("stricter() orders the actions", stricter("warn", "pause") === "pause" && stricter("downgrade", "none") === "downgrade");

  console.log("\nScopes and periods count the right things");
  // A tool ceiling counts what the tool charged, never the model calls its
  // handler made — those are the agent's and the feature's, and counting them
  // here would bill one dollar twice.
  const toolSpend = await spentIn({ scopeType: "TOOL", scopeId: SPENDING_TOOL }, "MONTH");
  const agentSpend = await spentIn({ scopeType: "AGENT", scopeId: POOR_AGENT }, "MONTH");
  ok("a tool scope does not pick up model spend", toolSpend === 0 && agentSpend > 0, `${toolSpend} / ${agentSpend}`);

  const startOfDay = periodStart("DAY");
  const startOfMonth = periodStart("MONTH");
  ok("a day starts at midnight UTC", startOfDay.getUTCHours() === 0 && startOfDay.getUTCMinutes() === 0);
  ok("a month starts on the first", startOfMonth.getUTCDate() === 1);
  ok("the month contains the day", startOfMonth <= startOfDay);

  console.log("\nDisabling is not deleting");
  await setBudget({ scopeType: "AGENT", scopeId: POOR_AGENT, period: "MONTH", softLimitUsd: 1, enabled: false });
  ok("a disabled budget does nothing", (await stateFor({ scopeType: "AGENT", scopeId: POOR_AGENT }, "MONTH")) === null);
  ok("but the row is still there", (await prisma.budget.count({ where: { scopeId: POOR_AGENT } })) === 1);

  const global = await prisma.budget.findFirst({ where: { scopeType: "GLOBAL" } });
  if (global) await removeBudget(global.id);
  ok("deleting one leaves no state behind", (await stateFor({ scopeType: "GLOBAL", scopeId: "" }, "MONTH")) === null);

  // Rule 3: everything created, gone — including the disabled budget and the
  // refused-path rows, which a cleanup list naming only the successes forgets.
  // The delete is the last thing that happens.
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
