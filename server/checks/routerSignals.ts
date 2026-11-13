/**
 * The router under one orchestrator: it grades the task, not the rank, and it
 * learns from how its gradings ended (`services/agents/complexity.ts`).
 *
 * The roster's rules gave three points for being an executive and took one off
 * for being a sub-task, before a word of the brief was read. Under one agent
 * that sent a status check to the top model and the proposal a sub-task
 * exists to write to the small one. What this holds still:
 *
 *  1. **The roster is untouched**: the same facts without `oneAgent` score
 *     exactly as they did.
 *  2. **Rank no longer decides**: an executive skill's lookup is not high
 *     strength, and a sub-task is not marked down for being one.
 *  3. **The work is read**: several steps in order, work built on earlier
 *     pieces, and a call that sends or charges each count — and our own
 *     hand-over block is never counted as steps of the task.
 *  4. **It learns, upward only**: a skill whose recent tasks at a strength
 *     keep ending short starts its next one a step up; too little evidence,
 *     or endings that were not the model's doing, change nothing; and high
 *     strength has nowhere to go.
 *
 * No database: settings read as unset, and the history is handed in.
 *   npx tsx checks/routerSignals.ts
 */
import type { Agent, AgentTask } from "@prisma/client";

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

delete process.env.AGENTS_MODE;
const { prisma } = await import("../src/lib/prisma.js");
Object.defineProperty(prisma, "appSetting", { value: { findUnique: async () => null, findMany: async () => [] } });
Object.defineProperty(prisma, "budget", { value: { findMany: async () => [], count: async () => 0 } });

const { OUTCOME_MIN, OUTCOME_SHORT, levelForScore, outcomesSayHarder, partsIn, routeTask, scoreTask } = await import("../src/services/agents/complexity.js");
type TaskFacts = import("../src/services/agents/complexity.js").TaskFacts;
type Outcomes = import("../src/services/agents/complexity.js").Outcomes;

const NO_LINKS = { lead: false, client: false, project: false, proposal: false, invoice: false };
const MIDDLING = "The client has asked for a fortnightly note about the work in progress on their account, covering what was done and what is next. ".repeat(5);

function facts(over: Partial<TaskFacts>): TaskFacts {
  return { title: "A task", brief: MIDDLING, inputChars: 0, origin: "OWNER", agentKey: "check.router", agentTier: "OPERATIONAL", toolkit: [], likely: [], linked: NO_LINKS, ...over };
}
const strength = (over: Partial<TaskFacts>) => levelForScore(scoreTask(facts(over)).score);

// --- 1. The roster is untouched --------------------------------------------------
console.log("\nThe roster scores as it always did");
{
  const exec = scoreTask(facts({ agentTier: "EXECUTIVE" }));
  check("an executive is still worth three there", exec.score === 3 && exec.reasons.some((reason) => reason.includes("executive agent")), `${exec.score}: ${exec.reasons.join("; ")}`);
  const slice = scoreTask(facts({ agentTier: "SUB_AGENT", origin: "AGENT" }));
  check("and a delegated slice to a specialist is two down", slice.score === -2, `${slice.score}: ${slice.reasons.join("; ")}`);
  const steps = scoreTask(facts({ brief: `${MIDDLING}\n1. Read the record\n2. Compare the two quotes\n3. Write the note\n4. File it` }));
  check("the new signals are not read on the roster", !steps.reasons.some((reason) => reason.includes("steps in order")), steps.reasons.join("; "));
}

// --- 2. Rank no longer decides -----------------------------------------------------
console.log("\nUnder one orchestrator, the task is graded");
{
  const lookup = { title: "Was invoice 42 paid?", brief: "Check whether invoice 42 has been paid and say yes or no." };
  const asExec = scoreTask(facts({ ...lookup, agentTier: "EXECUTIVE", oneAgent: true }));
  check("an executive skill's status check is not high strength", levelForScore(asExec.score) !== "complex", `${asExec.score}: ${asExec.reasons.join("; ")}`);
  check("on the roster the same check scored higher", scoreTask(facts({ ...lookup, agentTier: "EXECUTIVE" })).score > asExec.score);
  check("a decision still counts for something", asExec.reasons.some((reason) => reason.includes("decision")), asExec.reasons.join("; "));

  const child = scoreTask(facts({ agentTier: "SUB_AGENT", origin: "AGENT", oneAgent: true }));
  check("a sub-task is not marked down for being one", child.score === 0 && !child.reasons.some((reason) => reason.includes("slice")), `${child.score}: ${child.reasons.join("; ")}`);

  const proposal = {
    agentTier: "SUB_AGENT" as const,
    origin: "AGENT" as const,
    title: "Draft the proposal",
    brief: "Draft a proposal for the five page rebuild with a booking form, with two priced options, from the scope notes on the record.",
    toolkit: [{ key: "proposal.draft", scope: "write" }],
    likely: ["proposal.draft"],
    linked: { ...NO_LINKS, lead: true },
  };
  check("a proposal raised as a sub-task was low strength on the roster", strength(proposal) === "simple", String(scoreTask(facts(proposal)).score));
  check("and is medium under one orchestrator", strength({ ...proposal, oneAgent: true }) === "standard", String(scoreTask(facts({ ...proposal, oneAgent: true })).score));

  const phone = { agentTier: "SUB_AGENT" as const, origin: "AGENT" as const, title: "Phone number", brief: "Look up the phone number on the lead.", toolkit: [{ key: "lead.read", scope: "read" }], likely: ["lead.read"], oneAgent: true };
  check("a lookup is still low strength", strength(phone) === "simple", String(scoreTask(facts(phone)).score));

  const strategy = { agentTier: "EXECUTIVE" as const, title: "Next quarter", brief: `${MIDDLING} Decide the strategy for next quarter and analyse what we should stop doing.`, oneAgent: true };
  check("a strategy decision is still high strength", strength(strategy) === "complex", String(scoreTask(facts(strategy)).score));
}

// --- 3. The work is read -------------------------------------------------------------
console.log("\nWhat the work is");
{
  check("one sentence is one piece", partsIn("Write the note.") === 1);
  check("a numbered list is counted", partsIn("Do this:\n1. Read\n2. Compare\n3. Write\n4. File") === 4);
  check("so are bullets", partsIn("- read\n- compare\n- write") === 3);
  check("and steps strung with words", partsIn("Audit the site, then write the letter, and finally say what was sent.") === 3);
  check("our own hand-over block is not the task's steps", partsIn("Write the letter.\n\nEARLIER WORK THIS TASK WAITED FOR — it has ended:\n\n- s1 \"Audit\": DONE\n- s2 \"Research\": DONE\n- s3 \"Shots\": DONE") === 1);

  const base = scoreTask(facts({ oneAgent: true })).score;
  const stepped = scoreTask(facts({ oneAgent: true, brief: `${MIDDLING}\n1. Read the record\n2. Draft the note\n3. Send it to the manager` }));
  check("three steps in order add a point", stepped.score === base + 1 && stepped.reasons.some((reason) => reason.includes("3 steps")), `${stepped.score}: ${stepped.reasons.join("; ")}`);
  const two = scoreTask(facts({ oneAgent: true, brief: `${MIDDLING} Read the record, then write the note.` }));
  check("two do not", two.score === base, `${two.score}: ${two.reasons.join("; ")}`);

  const built = scoreTask(facts({ oneAgent: true, builtOn: 2 }));
  check("work built on earlier pieces adds a point", built.score === base + 1 && built.reasons.some((reason) => reason.includes("builds on 2")), built.reasons.join("; "));

  const sends = scoreTask(facts({ oneAgent: true, toolkit: [{ key: "invoice.send", scope: "send" }], likely: ["invoice.send"] }));
  check("a call that sends or charges adds a point", sends.score === base + 1 && sends.reasons.some((reason) => reason.includes("sends or charges")), sends.reasons.join("; "));
  const reads = scoreTask(facts({ oneAgent: true, toolkit: [{ key: "lead.read", scope: "read" }], likely: ["lead.read"] }));
  check("a call that only reads does not", !reads.reasons.some((reason) => reason.includes("sends or charges")), reads.reasons.join("; "));
  const writer = scoreTask(facts({ oneAgent: true, agentKey: "outreach.writer", toolkit: [{ key: "email.send", scope: "send" }], likely: ["email.send"] }));
  check("and it is not counted twice for a skill that already writes for outsiders", writer.reasons.filter((reason) => /outside|sends or charges/.test(reason)).length === 1, writer.reasons.join("; "));
}

// --- 4. It learns ----------------------------------------------------------------------
console.log("\nLearning from how the last gradings ended");
{
  check("too few tasks is not evidence", !outcomesSayHarder({ of: OUTCOME_MIN - 1, short: OUTCOME_MIN - 1 }));
  check("a couple of bad endings is not enough", !outcomesSayHarder({ of: 8, short: OUTCOME_SHORT - 1 }));
  check("enough of both is", outcomesSayHarder({ of: OUTCOME_MIN, short: OUTCOME_SHORT }));

  const agent = { key: "check.router", name: "Check Router", title: "Fixture", tier: "OPERATIONAL" } as unknown as Agent;
  const task = { id: "check-task", title: "A task", brief: MIDDLING, input: null, origin: "OWNER", level: null, levelOverride: null, leadId: null, clientId: null, projectId: null, proposalId: null, invoiceId: null } as unknown as AgentTask;
  const asked: Array<{ key: string; level: string; except?: string }> = [];
  const route = (outcomes: Outcomes | Error, over: Partial<AgentTask> = {}) =>
    routeTask({
      agent,
      task: { ...task, ...over } as AgentTask,
      toolkit: [],
      likely: [],
      resuming: false,
      previousStatus: null,
      mode: "rules",
      oneAgent: true,
      outcomes: async (key, level, except) => {
        asked.push({ key, level, except });
        if (outcomes instanceof Error) throw outcomes;
        return outcomes;
      },
    });

  const calm = await route({ of: 8, short: 0 });
  check("with a clean history the rules' answer stands", calm.level === "standard" && calm.decidedBy === "rules", `${calm.level} ${calm.decidedBy}`);
  check("the history is asked about this skill at this strength, without this task", asked[0]?.key === "check.router" && asked[0]?.level === "standard" && asked[0]?.except === "check-task", JSON.stringify(asked[0]));

  const learned = await route({ of: 8, short: 3 });
  check("three of the last eight ending short starts the next a step up", learned.level === "complex", String(learned.level));
  check("and the timeline says why", Boolean(learned.sentence?.includes("3 of this skill's last 8 medium-strength tasks ended short")), learned.sentence ?? "");
  check("with the reason among the reasons", learned.reasons.some((reason) => reason.includes("one step up")), learned.reasons.join("; "));
  check("the effort goes with the level", learned.effort !== calm.effort, `${learned.effort} vs ${calm.effort}`);

  const thin = await route({ of: 4, short: 4 });
  check("four tasks, all short, is still too little to act on", thin.level === "standard", String(thin.level));

  const broken = await route(new Error("the database is away"));
  check("a history that cannot be read changes nothing", broken.level === "standard", String(broken.level));

  const before = asked.length;
  const chosen = await route({ of: 8, short: 8 }, { levelOverride: "SIMPLE" });
  check("the Owner's own choice is not overruled by it", chosen.level === "simple" && asked.length === before, `${chosen.level}, asked ${asked.length - before}`);

  const top = await route({ of: 8, short: 8 }, { brief: `${MIDDLING} Decide the strategy and analyse the plan, then compare the options, and finally prioritise them.`.repeat(4) });
  check("high strength has nowhere further to go, so nothing is asked", top.level === "complex" && !top.sentence?.includes("ended short"), `${top.level}: ${top.sentence}`);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const name of failures) console.log(`  - ${name}`);
  process.exit(1);
}
process.exit(0);
