/**
 * What an agent is told about its own tools, and how many colleagues it may ask.
 *
 * Two small things that both change what reaches a model, and both have a
 * failure mode where the feature looks fine and does nothing:
 *
 *  - **The likely-tools line** could rank perfectly and be appended to a brief
 *    nothing reads, or — much worse — quietly filter the tool array, which a
 *    passing "the ranking is correct" test would never notice. A tool the
 *    model cannot see is a tool it cannot use.
 *  - **The consult limit** could be read from a setting that parses wrong and
 *    silently fall back to the shipped number, which is indistinguishable from
 *    working right up until somebody sets it to zero and gets three.
 *
 * Database only. No key, no network.
 */
import { consultLimitFor, likelyToolsLine, remainingConsults, sharesOf, toolsFor, type Counters } from "../src/services/agents/runner.js";
import { SETTING, clearSettingsCache, setSetting } from "../src/lib/settings.js";
import { prisma } from "../src/lib/prisma.js";

function freshCounters(): Counters {
  return { toolCalls: 0, dryRun: 0, refused: 0, escalated: null, delegated: 0, consulted: 0, consultedBy: { low: 0, medium: 0, high: 0 }, handedOff: 0, gapsRaised: 0 };
}

let bad = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(ok ? `  ok    ${label}` : `  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) bad += 1;
}

console.log("\nThe line that goes on a brief");
{
  const line = likelyToolsLine([
    { key: "lead.read", name: "Read leads", purpose: "List or look up leads." },
    { key: "email.draft", name: "Draft an email", purpose: "Write an email into the outbox." },
  ]);
  check("it names the catalogue key, which is what the agent calls", line.includes("`lead.read`"), line);
  check("it carries the purpose, so the suggestion can be judged", line.includes("List or look up leads."));
  // The sentence that stops a guess reading as a restriction. Without it a
  // model reasonably concludes the three named tools are the three it has.
  check(
    "it says the whole toolkit is still available",
    line.includes("Your whole toolkit is available"),
    line,
  );
  check("nothing at all when there is nothing to say", likelyToolsLine([]) === "");
}

console.log("\nRanking never becomes filtering");
{
  // The property that matters is not "the ranking is good" — it is that the
  // ranking cannot cost an agent a tool. Asserted against the real toolsFor by
  // running a task's worth of it, below, but stated here too because this is
  // the invariant somebody will break while making the ranking cleverer.
  const AGENT_KEY = "check.brief.agent";
  await prisma.agent.deleteMany({ where: { key: AGENT_KEY } });
  const toolkit = ["lead.read", "email.draft", "client.read", "projects.read", "analytics.read"];
  await prisma.agent.create({
    data: {
      key: AGENT_KEY,
      name: "Brief Check",
      title: "Brief Check",
      tier: "SUB_AGENT",
      department: "TECHNOLOGY",
      status: "ACTIVE",
      mission: "Exists for one test run.",
      toolkit,
      custom: true,
    },
  });

  const task = await prisma.agentTask.create({
    data: { agentKey: AGENT_KEY, title: "Look up a lead", brief: "Read the lead and say what it is.", priority: 2 },
  });

  const agent = await prisma.agent.findUniqueOrThrow({ where: { key: AGENT_KEY } });
  const granted = await toolsFor(agent, task, freshCounters());
  check(
    "every granted tool is still handed over",
    toolkit.every((key) => granted.tools.some((tool) => tool.name === key.replace(/\./g, "__"))),
    granted.tools.map((tool) => tool.name).join(", "),
  );
  check("the ranking names at most three", granted.likely.length <= 3, `${granted.likely.length}`);
  check(
    "a brief about reading a lead puts lead.read in the ranking",
    granted.likely.some((tool) => tool.key === "lead.read"),
    granted.likely.map((tool) => tool.key).join(", ") || "nothing ranked",
  );

  // Off means off: a sentence disappears and nothing else changes.
  await setSetting(SETTING.ENABLE_TOOL_RELEVANCE, "false");
  clearSettingsCache();
  const off = await toolsFor(agent, task, freshCounters());
  check("switching it off removes the ranking", off.likely.length === 0);
  check("and takes away no tools", off.tools.length === granted.tools.length, `${off.tools.length} vs ${granted.tools.length}`);
  await prisma.appSetting.deleteMany({ where: { key: SETTING.ENABLE_TOOL_RELEVANCE } });
  clearSettingsCache();

  // Zero overlap is not a recommendation. A brief with nothing in common with
  // any tool must produce no line at all rather than three arbitrary ones.
  const unrelated = await prisma.agentTask.create({
    data: { agentKey: AGENT_KEY, title: "zzzz", brief: "zzzz qqqq", priority: 2 },
  });
  const none = await toolsFor(agent, unrelated, freshCounters());
  check("a brief matching nothing recommends nothing", none.likely.length === 0, none.likely.map((t) => t.key).join(", "));

  await prisma.agentTask.deleteMany({ where: { agentKey: AGENT_KEY } });
  await prisma.agent.deleteMany({ where: { key: AGENT_KEY } });
}

console.log("\nThe consult ceiling");
{
  const at = (priority: number) => consultLimitFor({ priority });

  await prisma.appSetting.deleteMany({ where: { key: SETTING.CONSULT_PRIORITY_LIMITS } });
  clearSettingsCache();
  check("an urgent task may ask more", (await at(1)) === 5, `${await at(1)}`);
  check("a normal task is where it has always been", (await at(2)) === 3, `${await at(2)}`);
  check("a whenever-task may ask fewer", (await at(3)) === 2, `${await at(3)}`);

  await setSetting(SETTING.CONSULT_PRIORITY_LIMITS, JSON.stringify({ "2": 7 }));
  clearSettingsCache();
  check("an override is read", (await at(2)) === 7, `${await at(2)}`);
  check("and the priorities it does not mention keep their defaults", (await at(1)) === 5, `${await at(1)}`);

  // Zero is a limit, not an absence. The usual `> 0` guard reads it as unset
  // and hands back the default, which is the trap Rehearsal.budgetUsd carries
  // a comment about — and here it would mean consulting somebody deliberately
  // switched off carries on happening.
  await setSetting(SETTING.CONSULT_PRIORITY_LIMITS, JSON.stringify({ "3": 0 }));
  clearSettingsCache();
  check("zero means no consults, not 'unset'", (await at(3)) === 0, `${await at(3)}`);

  // A hand-edited setting must not stop the workforce consulting at all.
  await setSetting(SETTING.CONSULT_PRIORITY_LIMITS, "{not json");
  clearSettingsCache();
  check("an unreadable setting falls back to the shipped limits", (await at(2)) === 3, `${await at(2)}`);

  await prisma.appSetting.deleteMany({ where: { key: SETTING.CONSULT_PRIORITY_LIMITS } });
  clearSettingsCache();
}

console.log("\nThe ceiling split by how decisive a question is");
{
  // The property that matters, and the one an obvious implementation of this
  // gets wrong: an agent declares its own question's priority, so if declaring
  // one could *raise* a ceiling then every agent would learn to mark every
  // question urgent and the cap would be advisory. The shares are shares of the
  // task's own allowance, and `high` is the whole of it — never more.
  for (const limit of [0, 1, 2, 3, 5, 7]) {
    const shares = sharesOf(limit);
    check(
      `a limit of ${limit} is never exceeded by any single share`,
      shares.low <= limit && shares.medium <= limit && shares.high <= limit,
      JSON.stringify(shares),
    );
  }
  check("no consults at all means no share of anything", JSON.stringify(sharesOf(0)) === JSON.stringify({ low: 0, medium: 0, high: 0 }));
  // A floor of one: splitting a working cap of two would otherwise tell an
  // agent its low budget is zero — a cap turned into a refusal by arithmetic.
  check("a small allowance still leaves room for one of each", sharesOf(2).low >= 1 && sharesOf(2).medium >= 1, JSON.stringify(sharesOf(2)));
  check("and high can always spend all of it", sharesOf(2).high === 2 && sharesOf(5).high === 5);

  const spent = (low: number, medium: number, high: number): Counters => ({
    ...freshCounters(),
    consulted: low + medium + high,
    consultedBy: { low, medium, high },
  });

  const fresh = remainingConsults(freshCounters(), 3);
  check("a fresh task has its whole allowance", fresh.total === 3, `${fresh.total}`);

  // The total is what is enforced. A share cannot let an agent past it, which
  // is the other half of the same property.
  const nearlyDone = remainingConsults(spent(0, 0, 3), 3);
  check("spending it all on high questions leaves nothing", nearlyDone.total === 0, `${nearlyDone.total}`);
  check("and no share survives the total running out", nearlyDone.byPriority.low === 0 && nearlyDone.byPriority.medium === 0, JSON.stringify(nearlyDone.byPriority));

  // The thing the split is for: a task that spent its budget on nice-to-know
  // questions has none left for them, and still has its decisive ones.
  //
  // Two low questions, not one — at a limit of three the low share is two, so
  // spending one leaves one and proves nothing. The number is read from
  // `sharesOf` rather than written down here, or this becomes a test of the
  // arithmetic rather than of the property.
  const lowShare = sharesOf(3).low;
  const chatty = remainingConsults(spent(lowShare, 0, 0), 3);
  check("spending the low share exhausts low", chatty.byPriority.low === 0, JSON.stringify(chatty.byPriority));
  check(
    "and leaves the decisive questions available",
    chatty.byPriority.high > 0 && chatty.total === 3 - lowShare,
    JSON.stringify(chatty),
  );

  // Never negative, whatever a checkpoint written by an older deploy holds.
  const overspent = remainingConsults(spent(9, 9, 9), 3);
  check("an over-counted task reports nothing left rather than a negative", overspent.total === 0 && overspent.byPriority.high === 0, JSON.stringify(overspent));
}

console.log(bad ? `\n${bad} PROBLEM(S)` : `\nThe brief says what it should and the ceiling is the ceiling.`);
process.exitCode = bad ? 1 : 0;
await prisma.$disconnect();
