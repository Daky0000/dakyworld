/**
 * The roster, checked against itself, the catalogue and the writer registry.
 *
 * Three of these assertions exist because of a defect that had already
 * happened, and each one fails on the commit before it was fixed:
 *
 *  - **A tool in nobody's toolkit.** Eleven of them, `email.send` among them.
 *    The grant is checked in `invoke.ts` before the autonomy level and before
 *    the approval bypass, so an ungranted tool cannot be called, cannot be
 *    prepared, and cannot have a card approved for it. The workforce could
 *    write a letter and nothing anywhere could send it, while the Tools screen
 *    listed the tool and the document described the flow.
 *  - **A writing job whose file does not read the registry.** This codebase's
 *    oldest defect: the prompt being edited is not the prompt being run. A job
 *    can be registered, shown on the Agents screen with an owner beside it, and
 *    still be written by a template literal three files away.
 *  - **A job with no shipped wording.** The editor then opens empty and the
 *    first keystroke silently replaces a doctrine nobody could read.
 *
 * Nothing here needs a key or a network. It reads the seeds, the catalogue and
 * the source files, and it uses the database only for the two assertions that
 * genuinely need one.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_SEEDS, ensureAgents, reconcileSeedToolkits } from "../src/services/agentRegistry.js";
import { listAllTools } from "../src/services/tools/catalogue.js";
import { WRITER_JOBS } from "../src/services/writers/registry.js";
import { jobsWithShippedWording, shippedDoctrine } from "../src/services/writers/shipped.js";
import { resolveBrief } from "../src/services/writers/brief.js";
import { prisma } from "../src/lib/prisma.js";
import { SETTING, clearSettingsCache } from "../src/lib/settings.js";

const src = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

let bad = 0;
function check(ok: boolean, label: string) {
  if (ok) return;
  console.log(`  FAIL  ${label}`);
  bad += 1;
}

/**
 * Tools that exist, are gated, and are deliberately in nobody's seeded toolkit.
 *
 * A list rather than a silence. Every entry is a decision somebody made and can
 * defend; anything that falls out of a seed without landing here fails the run.
 */
const UNHELD_BY_DESIGN: Record<string, string> = {
  "calendar.write": "Google's calendar scopes need the connection redone rather than topped up. Grant it when that is done.",
  "whatsapp.send": "The writers hold `whatsapp.link`, which prepares a message a person sends from their own phone. Sending as a brand is a separate decision.",
};

console.log(`${AGENT_SEEDS.length} agents in the roster.\n`);

// --- 1. The roster against itself -----------------------------------------
const keys = AGENT_SEEDS.map((seed) => seed.key);
check(new Set(keys).size === keys.length, "every key is unique");

const known = new Set(keys);
for (const seed of AGENT_SEEDS) {
  // A managerKey pointing at nobody silently breaks `delegate` — an agent may
  // only hand work down to a direct report, so the tool refuses and the agent
  // has no way to find out why.
  if (seed.managerKey) check(known.has(seed.managerKey), `${seed.key}: manager ${seed.managerKey} exists`);
  check(Boolean(seed.mission?.trim()), `${seed.key}: has a mission`);
  if (seed.tier === "SUB_AGENT") check((seed.skills?.length ?? 0) > 0, `${seed.key}: a specialist names its skills`);
}

// --- 2 & 3. The roster against the catalogue -------------------------------
const catalogue = await listAllTools();
const toolKeys = new Set(catalogue.map((tool) => tool.key));

const holders = new Map<string, string[]>();
for (const seed of AGENT_SEEDS) {
  for (const tool of seed.toolkit) {
    check(toolKeys.has(tool), `${seed.key}: ${tool} is a real tool`);
    holders.set(tool, [...(holders.get(tool) ?? []), seed.key]);
  }
}

const orphans: string[] = [];
for (const tool of catalogue) {
  const held = holders.get(tool.key)?.length ?? 0;
  if (held > 0) continue;
  if (UNHELD_BY_DESIGN[tool.key]) continue;
  orphans.push(tool.key);
}
check(
  orphans.length === 0,
  `every tool is in somebody's toolkit — ${orphans.join(", ")} ${orphans.length === 1 ? "is" : "are"} in nobody's. ` +
    `Grant it, or add it to UNHELD_BY_DESIGN with the reason.`,
);
for (const [key, why] of Object.entries(UNHELD_BY_DESIGN)) {
  // A tool granted since somebody wrote it off is a stale exemption, and the
  // next person reads it as a live decision.
  check(!holders.has(key), `${key} is exempt but now held by ${holders.get(key)?.join(", ")} — drop it from UNHELD_BY_DESIGN`);
  check(toolKeys.has(key), `${key} is exempt but is not a tool any more — drop it from UNHELD_BY_DESIGN (${why})`);
}

// --- 4 & 5. The writer registry --------------------------------------------
const wired = new Set(jobsWithShippedWording());
for (const job of WRITER_JOBS) {
  check(known.has(job.agentKey), `${job.key}: owner ${job.agentKey} is on the roster`);
  check(wired.has(job.key), `${job.key}: has shipped wording — otherwise the editor opens empty`);

  const shipped = await shippedDoctrine(job.key);
  check(shipped.trim().length > 0, `${job.key}: its shipped wording actually loads`);

  // The one that catches the oldest defect in this codebase. A job can be
  // registered, shown with an owner beside it, and still be written by a
  // string constant the registry never touches.
  let source: string;
  try {
    source = readFileSync(join(src, job.where), "utf8");
  } catch {
    check(false, `${job.key}: ${job.where} does not exist`);
    continue;
  }
  const reads = source.includes("writerSystem(") || source.includes("resolveBrief(");
  // Named literally, or dispatched by the registry's own mapping. The four
  // email jobs go through `emailJobFor(purpose)` rather than appearing as
  // literals, which is the registry deciding — exactly what this is checking
  // for. Anything else that resolves a job it does not name is a writer
  // choosing its own doctrine, which is the defect.
  const named = source.includes(`"${job.key}"`) || source.includes("emailJobFor(");
  check(named && reads, `${job.key}: ${job.where} names the job and resolves it through the registry`);
}

/**
 * The property all of the above is a proxy for: does editing the owning agent
 * actually change the deliverable?
 *
 * Asserted rather than inferred. `resolveBrief` falls through an untouched seed
 * on purpose — a seeded agent's ten layers describe a colleague, not a letter —
 * so the test is that an *authored* instruction takes over, which is what the
 * founder is doing when they edit a card.
 */
const owners = [...new Set(WRITER_JOBS.map((job) => job.agentKey))];
const restore: { key: string; promptText: string | null; promptEditedAt: Date | null }[] = [];
for (const key of owners) {
  const before = await prisma.agent.findUnique({ where: { key }, select: { promptText: true, promptEditedAt: true } });
  if (!before) continue;
  restore.push({ key, ...before });
  await prisma.agent.update({
    where: { key },
    data: { promptText: `Written by checks/roster.ts for ${key}.`, promptEditedAt: new Date() },
  });
}
for (const job of WRITER_JOBS) {
  const brief = await resolveBrief(job.key, "the wording Dakyworld ships");
  check(
    brief.source === "agent",
    `${job.key}: ${job.agentKey}'s own instruction takes over the deliverable — it resolved to "${brief.source}"`,
  );
}
// Put every one of them back before anything else runs, including on the way
// out of a failing assertion above: a check that leaves an authored prompt
// behind has quietly rewritten the workforce it was inspecting.
for (const row of restore) {
  await prisma.agent.update({ where: { key: row.key }, data: { promptText: row.promptText, promptEditedAt: row.promptEditedAt } });
}

const owned = new Map<string, string[]>();
for (const job of WRITER_JOBS) owned.set(job.key, [...(owned.get(job.key) ?? []), job.agentKey]);
for (const [key, agents] of owned) {
  // An agent may own several jobs; a job has exactly one owner. Two owners for
  // one deliverable is the contradiction that makes a model fall back to the
  // generic output it already knew.
  check(agents.length === 1, `${key}: has one owner, not ${agents.length}`);
}

// --- 6. The reconcile, against a database ----------------------------------
console.log(`\nSeeding into the local database…`);
console.log(`  added ${await ensureAgents()}`);

// A fresh database is created *from* the seeds, so it already holds everything
// and a reconcile over it proves nothing. The case that matters is the live
// one: a row created before a tool was added to its seed. So one is made.
const SUBJECT = "billing.collector";
const before = await prisma.agent.findUniqueOrThrow({ where: { key: SUBJECT }, select: { toolkit: true } });
// The offered-set is half of the state this section destroys, and putting the
// toolkit back without it left the subject permanently behind: reconcile skips
// anything already marked offered, so a row restored to a toolkit that predates
// a tool never gets that tool again — on this machine or on any database this
// check is pointed at. Snapshotted here and written back at the end.
const offeredBefore = await prisma.appSetting.findUnique({ where: { key: SETTING.AGENT_TOOLKIT_OFFERED } });
const stripped = before.toolkit.filter((tool) => tool !== "email.send" && tool !== "payment.link");
await prisma.agent.update({ where: { key: SUBJECT }, data: { toolkit: stripped } });
await prisma.appSetting.deleteMany({ where: { key: SETTING.AGENT_TOOLKIT_OFFERED } });

const first = await reconcileSeedToolkits();
for (const grant of first.granted) console.log(`  granted ${grant.name}: ${grant.tools.join(", ")}`);
const caught = first.granted.find((grant) => grant.key === SUBJECT);
check(
  Boolean(caught?.tools.includes("email.send") && caught?.tools.includes("payment.link")),
  `an agent seeded before a tool existed is granted it — ${SUBJECT} got ${caught?.tools.join(", ") ?? "nothing"}`,
);

// The property that makes this safe to run on every boot. A pass that granted
// on every deploy would undo an untick for ever, and the untick is the Owner's.
const second = await reconcileSeedToolkits();
check(second.granted.length === 0, `a second reconcile grants nothing — it granted to ${second.granted.map((g) => g.key).join(", ")}`);

// Every seed's toolkit is now genuinely on its row, which is the whole point.
//
// Read here, straight after the reconcile, rather than at the end of the
// section. The untick below deliberately takes a tool away and the restore
// after it deliberately puts the subject back the way it was found — so an
// assertion made after either of those is measuring what this check just did
// to the row rather than what the reconcile achieved, and it failed on every
// database where the subject happened to be behind, which is the exact state
// this section exists to simulate.
const rows = await prisma.agent.findMany({ select: { key: true, toolkit: true } });
const stored = new Map(rows.map((row) => [row.key, new Set(row.toolkit)]));
for (const seed of AGENT_SEEDS) {
  const held = stored.get(seed.key);
  if (!held) continue;
  const missing = seed.toolkit.filter((tool) => !held.has(tool));
  check(missing.length === 0, `${seed.key}: holds everything its seed names — missing ${missing.join(", ")}`);
}

// And the rule that makes it safe to run on every boot for ever: a grant the
// Owner takes away after being offered it stays taken away. Without this the
// pass would undo an untick on every deploy, silently, and the untick is the
// Owner's decision rather than ours.
const unticked = await prisma.agent.findUniqueOrThrow({ where: { key: SUBJECT }, select: { toolkit: true } });
await prisma.agent.update({
  where: { key: SUBJECT },
  data: { toolkit: unticked.toolkit.filter((tool) => tool !== "payment.momo") },
});
const third = await reconcileSeedToolkits();
check(
  !third.granted.some((grant) => grant.key === SUBJECT),
  `a tool the Owner unticks after it was offered is not re-granted — ${SUBJECT} was handed back ${third.granted.find((g) => g.key === SUBJECT)?.tools.join(", ")}`,
);
// Put both halves back: the toolkit, and the ledger that decides whether a
// later boot would ever offer those tools again.
//
// Restored as **what was found, plus what the seed names**, and the second half
// is not tidiness. A plain restore is what put this database wrong in the first
// place: the section above deletes the offered-ledger, lets reconcile grant, and
// then writes the old toolkit back — so the row lost the tools while the ledger
// went on saying they had been offered, and reconcile never offered them again
// on any boot afterwards. `billing.collector` sat without `email.send` for as
// long as that lasted: a payment chaser that could not write to anybody, caused
// by the check that exists to prove it can.
//
// A union rather than an overwrite, because a tool the Owner ticked on by hand
// is not this check's to take away.
const seedToolkit = AGENT_SEEDS.find((seed) => seed.key === SUBJECT)?.toolkit ?? [];
await prisma.agent.update({
  where: { key: SUBJECT },
  data: { toolkit: [...new Set([...before.toolkit, ...seedToolkit])] },
});
await prisma.appSetting.deleteMany({ where: { key: SETTING.AGENT_TOOLKIT_OFFERED } });
if (offeredBefore) {
  await prisma.appSetting.create({
    data: { key: offeredBefore.key, value: offeredBefore.value, secret: offeredBefore.secret },
  });
}
clearSettingsCache();

// --- 7. Work that exists and cannot start ----------------------------------
const stalled = await prisma.agentTask.groupBy({
  by: ["agentKey"],
  where: { status: "QUEUED", agent: { status: { not: "ACTIVE" } } },
  _count: true,
});
if (stalled.length > 0) {
  const total = stalled.reduce((sum, row) => sum + row._count, 0);
  console.log(`\n${total} queued task(s) belong to agents that are not Active: ${stalled.map((row) => row.agentKey).join(", ")}`);
}

// A mission joining two deliverables with an "and" is worth an eye rather than
// a hard failure — some are one job described in two clauses.
const suspicious = AGENT_SEEDS.filter((seed) => /\band\b/.test(seed.mission) && seed.mission.split(",").length > 3);
if (suspicious.length) console.log(`\nWorth re-reading (long missions): ${suspicious.map((seed) => seed.key).join(", ")}`);

console.log(bad ? `\n${bad} PROBLEM(S)` : `\nRoster, catalogue and writers agree.`);
process.exitCode = bad ? 1 : 0;
await prisma.$disconnect();
