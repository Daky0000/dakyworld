/**
 * What a newly hired agent knows before its first task.
 *
 * A hire arrives with a prompt, a toolkit and no memory, so its first task is
 * worked with less context than the same agent will have on its second. The two
 * facts that would help most are known at the moment of hiring and nowhere
 * afterwards: why it was employed, and who already does the nearest thing.
 *
 * The assertion that matters is not that the rows exist — it is that they come
 * back out of the **real `recall()`**, which is what actually reaches a prompt.
 * A memory written to a subject nothing recalls is the same defect as a prompt
 * nothing reads, and this codebase has paid for that one more than once.
 *
 * Database only. No key, no network. `applyHire` is the only thing that writes
 * to `Agent` for a hire, and it is driven here directly — a model can never
 * reach it, which is the whole safety story of the hiring loop.
 */
import express from "express";
import { attachUser, requireAuth } from "../src/middleware/auth.js";
import { agentsRouter } from "../src/routes/agents.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { applyHire, proposeHire } from "../src/services/agents/hiring.js";
import { recall } from "../src/services/agents/memory.js";
import { prisma } from "../src/lib/prisma.js";
import { SETTING, clearSettingsCache } from "../src/lib/settings.js";

let bad = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(ok ? `  ok    ${label}` : `  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) bad += 1;
}

const PORT = 4599;
const HIRED_KEY = "check.onboard.hired";
const ASKER_KEY = "check.onboard.asker";
const NEIGHBOUR_KEY = "check.onboard.neighbour";
const SKILL = "restore a damaged photograph";

async function reset() {
  await prisma.agentMemory.deleteMany({ where: { agentKey: { in: [HIRED_KEY, ASKER_KEY, NEIGHBOUR_KEY] } } });
  await prisma.agentTask.deleteMany({ where: { agentKey: { in: [HIRED_KEY, ASKER_KEY, NEIGHBOUR_KEY] } } });
  await prisma.agentHireRequest.deleteMany({ where: { key: HIRED_KEY } });
  await prisma.agentGap.deleteMany({ where: { skillNeeded: SKILL } });
  await prisma.agent.deleteMany({ where: { key: { in: [HIRED_KEY, ASKER_KEY, NEIGHBOUR_KEY] } } });
  // Hires-per-day is counted, and a check that leaves rows behind spends the
  // next run's budget.
  await prisma.appSetting.deleteMany({ where: { key: SETTING.AGENT_HIRE_POLICY } });
  clearSettingsCache();
}

await reset();

// The agent that ran into the wall, and a neighbour whose craft is close
// enough to be worth naming.
for (const [key, name, mission, skills] of [
  [ASKER_KEY, "Onboard Asker", "Ask for things nobody can do.", ["asking"]],
  [
    NEIGHBOUR_KEY,
    "Onboard Neighbour",
    "Retouch and restore photographs for print.",
    ["photograph retouching", "damaged photograph restoration", "print preparation"],
  ],
] as const) {
  await prisma.agent.create({
    data: {
      key,
      name,
      title: name,
      tier: "SUB_AGENT",
      department: "MARKETING",
      status: "ACTIVE",
      mission,
      skills: [...skills],
      custom: true,
    },
  });
}

const gap = await prisma.agentGap.create({
  data: {
    requestedByKey: ASKER_KEY,
    requestedByKeys: [ASKER_KEY],
    skillNeeded: SKILL,
    reason: `${ASKER_KEY}: a client sent in a torn print and nobody here could do anything with it.`,
  },
});

const proposal = await proposeHire(
  {
    key: HIRED_KEY,
    name: "Onboard Hire",
    title: "Photograph Restorer",
    department: "MARKETING",
    managerKey: NEIGHBOUR_KEY,
    mission: "Restore damaged photographs so a client can print them again.",
    deliverable: "A restored photograph, print ready.",
    rationale: "Nobody on the roster can work on a damaged print.",
    skills: ["damaged photograph restoration", "print preparation"],
    kpis: ["Photographs restored"],
    toolkit: ["image.generate"],
    escalationPolicy: "Never invents detail that was not in the original.",
    prompt: {
      role: "You are the Dakyworld Photograph Restorer.",
      mission: "Restore damaged photographs.",
      scope: "Restoration and nothing else.",
      dataRules: "Use only the original.",
      tools: "Use only the tools granted to you.",
      policy: "Never invent detail.",
      process: "Assess, restore, compare.",
      escalateWhen: "The original is unreadable.",
      output: "The restored image and what was reconstructed.",
      memory: "Retain decisions and outcomes.",
    },
  },
  { gapId: gap.id, proposedByKey: ASKER_KEY },
);

if (!proposal.requestId) {
  check("the hire was proposed", false, "no request id");
} else {
  const applied = await applyHire(proposal.requestId, { by: "check" });
  check("the hire creates the agent", applied.agentKey === HIRED_KEY, applied.agentKey);

  console.log("\nWhat it is handed on its first task");
  // Through the real recall, with no subjects — which is what a task about
  // nothing in particular passes, and the narrowest case. `self` has to come
  // back here or the induction reaches no prompt at all.
  const recalled = await recall(HIRED_KEY, []);
  const text = recalled.map((entry) => entry.line).join("\n");

  check("it recalls something at all", recalled.length > 0, `${recalled.length} memories`);
  check("it knows why it was employed", text.includes(SKILL), text.slice(0, 200));
  check("and who said so", text.includes(ASKER_KEY), text.slice(0, 200));
  check(
    "it knows whose craft is nearest",
    text.includes("Onboard Neighbour"),
    text.slice(0, 300),
  );
  // The point of naming them: a duplicate of work somebody already does is
  // what employing this agent was weighed against.
  check("and is told to ask them before assuming the work is its own", text.includes("consult"), text.slice(0, 300));

  console.log("\nWhat it is not");
  // `self` is one agent's own. Filing an induction as SHARED/company would put
  // it into all fifty prompts for ever.
  const shared = await prisma.agentMemory.count({ where: { scope: "SHARED", content: { contains: SKILL } } });
  check("the induction is not shared with the whole workforce", shared === 0, `${shared} shared`);
  const neighbourSees = await recall(NEIGHBOUR_KEY, []);
  check(
    "a colleague does not recall somebody else's induction",
    !neighbourSees.some((entry) => entry.line.includes("You were employed")),
    neighbourSees.map((entry) => entry.line).join(" | ").slice(0, 160),
  );

  console.log("\nThe toolkit came from the approved design");
  const hired = await prisma.agent.findUniqueOrThrow({ where: { key: HIRED_KEY } });
  check("it holds what was approved", hired.toolkit.includes("image.generate"), hired.toolkit.join(", "));
  // Every hire lands here whichever way it was approved. AUTO decides who
  // exists; it never decides what they may do.
  check("and lands at autonomy 1 with dry run on", hired.autonomyLevel === 1 && hired.dryRun, `${hired.autonomyLevel} / ${hired.dryRun}`);

  console.log("\nAnd the page a person reads it all back on");
  {
    // Two segments, so it sits safely below `/:key` — the same trap
    // `/escalations` carries, and the reason this is driven over real HTTP
    // rather than by calling a handler. Mounted the wrong way round it answers
    // about an agent called "onboarding".
    const app = express();
    app.use(express.json());
    app.use(attachUser);
    app.use("/api", requireAuth);
    app.use("/api/agents", agentsRouter);
    app.use(errorHandler);
    const server = app.listen(PORT, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));

    const res = await fetch(`http://127.0.0.1:${PORT}/api/agents/${HIRED_KEY}/onboarding`);
    const body = (await res.json()) as {
      agent?: { key?: string };
      hiredFor?: { skillNeeded?: string; askedBy?: string[] } | null;
      induction?: { content: string }[];
      neighbours?: { name: string }[];
      toolkit?: { key: string; ready: boolean }[];
      finished?: unknown[];
      error?: string;
    };

    check("GET /agents/:key/onboarding answers", res.status === 200, `status ${res.status} — ${body.error ?? ""}`);
    check("and it is this agent", body.agent?.key === HIRED_KEY, JSON.stringify(body.agent).slice(0, 120));
    check("it says why this one was employed", body.hiredFor?.skillNeeded === SKILL, `${body.hiredFor?.skillNeeded}`);
    check("and who asked", Boolean(body.hiredFor?.askedBy?.includes(ASKER_KEY)), body.hiredFor?.askedBy?.join(", "));
    check("the induction it will be told on every task is on the page", (body.induction?.length ?? 0) > 0, `${body.induction?.length}`);
    check("so is whose craft is nearest", Boolean(body.neighbours?.some((one) => one.name === "Onboard Neighbour")), JSON.stringify(body.neighbours).slice(0, 160));
    check("and its toolkit", Boolean(body.toolkit?.some((tool) => tool.key === "image.generate")), JSON.stringify(body.toolkit).slice(0, 160));

    // The honest answer for a new hire, and the reason this panel is its *own*
    // finished work rather than a summary of somebody else's: `onboard()`
    // refuses to guess what a colleague's job is like, and a page that filled
    // this with other agents' tasks would be that guess wearing a label.
    check("a new hire has finished nothing, and the page says so", Array.isArray(body.finished) && body.finished.length === 0, JSON.stringify(body.finished));

    // A seeded agent was never hired against a gap and simply says so. There
    // is no version of this page that is useful for one agent and forbidden
    // for another.
    const neighbour = await fetch(`http://127.0.0.1:${PORT}/api/agents/${NEIGHBOUR_KEY}/onboarding`);
    const seeded = (await neighbour.json()) as { hiredFor?: unknown; agent?: { key?: string } };
    check("an agent nobody hired still has a page", neighbour.status === 200, `status ${neighbour.status}`);
    check("and it says there was no gap behind it", seeded.hiredFor === null, JSON.stringify(seeded.hiredFor));

    const missing = await fetch(`http://127.0.0.1:${PORT}/api/agents/no-such-agent/onboarding`);
    check("an agent that does not exist is a 404", missing.status === 404, `status ${missing.status}`);

    server.close();
  }
}

await reset();
console.log(bad ? `\n${bad} PROBLEM(S)` : `\nA new agent starts knowing why it is here and who to ask.`);
process.exitCode = bad ? 1 : 0;
await prisma.$disconnect();
