/**
 * What a task costs, and what happens to it when a vendor is having a bad day.
 *
 * Three defects lived here at once and all three had the same shape: something
 * outside the task went wrong, and the task was charged for it.
 *
 *  - **A rate limit read as an empty account.** `planFor` consults its list of
 *    answerable phrases before it looks at the status, which is right for the
 *    503 that means "no key" and wrong for a 429, because the message carries
 *    up to 300 characters of the vendor's own prose. OpenRouter answers a
 *    free-tier day limit with "Add 10 credits to unlock…" and Google answers
 *    one with "Quota exceeded for quota metric" — so the two likeliest failures
 *    in this deployment matched "credit" and "quota", blocked the task, posted
 *    an escalation card and waited for a person. For a limit that clears by
 *    itself in five minutes.
 *  - **A failed run recorded as free.** `finishTask` summed tokens from the
 *    ledger and took the money from its caller, and both `catch` paths passed a
 *    literal zero — so the same row said thirty thousand tokens and no dollars.
 *    The success paths were wrong more quietly: they passed the agent loop's
 *    own tally, which never sees a model call made inside a tool handler, which
 *    is most of the writing this company does. `AgentTask.costUsd` is what the
 *    Agents screen totals for the month and what `rehearsals/run.ts` sums to
 *    decide whether a rehearsal is over budget, so understating it is a ceiling
 *    that does not hold.
 *  - **An unreachable colleague charged as an opinion.** A consult whose model
 *    call failed still spent one of the task's three, and still wrote its error
 *    string to the timeline under `answer` — where `priorConsult` handed it
 *    back on every later ask, so that colleague stayed unreachable for the life
 *    of the task however well the vendor recovered.
 *
 * Database only. The consult section deliberately disconnects every vendor
 * first, which is both how the failure is produced and what guarantees nothing
 * here reaches the network on a machine with real keys pasted into it.
 */
import { AnalystError } from "../src/lib/claude.js";
import { planFor } from "../src/services/agents/retry.js";
import { backfillTaskCosts, runTask, spendOn, workflowTools } from "../src/services/agents/runner.js";
import { reconcileCounters } from "../src/services/agents/checkpoint-journal.js";
import { clearSettingsCache, SETTING } from "../src/lib/settings.js";
import { prisma } from "../src/lib/prisma.js";

let bad = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(ok ? `  ok    ${label}` : `  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) bad += 1;
}

const AGENT_KEY = "check.spend.agent";
const COLLEAGUE_KEY = "check.spend.colleague";
const ENDING_KEY = "check.spend.paused";

console.log("\nA rate limit is a clock, not a question");
{
  // Verbatim shapes. `describeRejection` puts the vendor's own body into the
  // message and `call.ts` prefixes the whole chain, so this is what actually
  // arrives at `planFor` rather than a tidied version of it.
  const openrouter = new AnalystError(
    429,
    "Answering could not be done. deepseek/deepseek-r1:free rate-limited; qwen/qwen3:free rate-limited. " +
      "Last error: OpenRouter returned 429: Rate limit exceeded: free-models-per-day. " +
      "Add 10 credits to unlock 1000 free model requests per day",
  );
  const gemini = new AnalystError(
    429,
    "Answering could not be done. Gemini rate-limited. Last error: Gemini returned 429: " +
      "Quota exceeded for quota metric 'Generate requests per minute'",
  );

  check("an OpenRouter free-tier day limit waits", planFor(openrouter, 0).remedy === "wait", planFor(openrouter, 0).remedy);
  check("a Gemini quota 429 waits", planFor(gemini, 0).remedy === "wait", planFor(gemini, 0).remedy);
  check("and it waits five minutes first", planFor(openrouter, 0).waitMinutes === 5, `${planFor(openrouter, 0).waitMinutes}`);
  check(
    "the sentence calls it a rate limit rather than an empty account",
    planFor(openrouter, 0).reason.includes("rate-limiting"),
    planFor(openrouter, 0).reason.slice(0, 80),
  );

  // The controls, and they matter more than the four above. Taking 429 out of
  // the phrase sweep must not cost the two cases the sweep was written for, or
  // this has traded one silent failure for another.
  const noKey = new AnalystError(503, "No model is connected. Add a key under Settings → AI models.");
  const noCredit = new AnalystError(400, "OpenAI would not accept that key. It said: insufficient_quota");
  check("no key at all still asks a person", planFor(noKey, 0).remedy === "ask", planFor(noKey, 0).remedy);
  check("a genuinely empty account still asks", planFor(noCredit, 0).remedy === "ask", planFor(noCredit, 0).remedy);
  check("and a broken run still fails", planFor(new TypeError("x.map is not a function"), 0).remedy === "fail");

  // Waiting still ends somewhere. A vendor down all afternoon is a question,
  // not a task that polls it for ever.
  check("a rate limit that never clears ends as a question", planFor(openrouter, 6).remedy === "ask", planFor(openrouter, 6).remedy);
}

async function reset() {
  await prisma.llmCall.deleteMany({ where: { agentKey: { in: [AGENT_KEY, COLLEAGUE_KEY, ENDING_KEY] } } });
  await prisma.toolCall.deleteMany({ where: { agentKey: { in: [AGENT_KEY, COLLEAGUE_KEY, ENDING_KEY] } } });
  await prisma.agentTaskStep.deleteMany({ where: { task: { agentKey: { in: [AGENT_KEY, ENDING_KEY] } } } });
  await prisma.agentTaskTransition.deleteMany({ where: { task: { agentKey: { in: [AGENT_KEY, ENDING_KEY] } } } });
  await prisma.agentTask.deleteMany({ where: { agentKey: { in: [AGENT_KEY, ENDING_KEY] } } });
  await prisma.agent.deleteMany({ where: { key: { in: [AGENT_KEY, COLLEAGUE_KEY, ENDING_KEY] } } });
}

const seed = (key: string, name: string) =>
  prisma.agent.create({
    data: {
      key,
      name,
      title: name,
      tier: "SUB_AGENT",
      department: "TECHNOLOGY",
      status: "ACTIVE",
      mission: "Exists for one test run.",
      custom: true,
    },
  });

await reset();
await seed(AGENT_KEY, "Spend Check");
const task = await prisma.agentTask.create({
  data: { agentKey: AGENT_KEY, title: "spend", brief: "spend", status: "RUNNING" },
});

console.log("\nWhat a task cost is read from the ledgers");
{
  check("a task with nothing on the ledgers has spent nothing", (await spendOn(task.id)) === 0);

  // One turn the agent loop itself took, and one made by a writer several
  // frames below it. The loop's own tally only ever saw the first.
  for (const [purpose, cost] of [
    [`agent.${AGENT_KEY}`, "1.500000"],
    ["email.draft", "0.250000"],
  ] as const) {
    await prisma.llmCall.create({
      data: {
        purpose,
        model: "check",
        taskId: task.id,
        agentKey: AGENT_KEY,
        inputTokens: 400,
        outputTokens: 200,
        costUsd: cost,
        durationMs: 10,
        ok: true,
      },
    });
  }
  check("both model calls count, whoever made them", (await spendOn(task.id)) === 1.75, `${await spendOn(task.id)}`);

  // A paid tool is money too, and it is not a model call at all.
  await prisma.toolCall.create({
    data: { tool: "capture.run", taskId: task.id, agentKey: AGENT_KEY, ok: true, costUsd: "0.400000", durationMs: 10 },
  });
  check("and what the paid tools charged", (await spendOn(task.id)) === 2.15, `${await spendOn(task.id)}`);

  // A failed call is spend. The tokens burned before the timeout are billed
  // whether or not an answer came back, which is the whole reason the two
  // `catch` paths writing a zero were wrong rather than merely imprecise.
  await prisma.llmCall.create({
    data: {
      purpose: "consult.someone",
      model: "check",
      taskId: task.id,
      agentKey: AGENT_KEY,
      inputTokens: 900,
      outputTokens: 0,
      costUsd: "0.050000",
      durationMs: 10,
      ok: false,
      error: "timed out",
    },
  });
  check("a failed model call is still money", (await spendOn(task.id)) === 2.2, `${await spendOn(task.id)}`);

  // Somebody else's spend must never land on this bill.
  const other = await prisma.agentTask.create({
    data: { agentKey: AGENT_KEY, title: "other", brief: "other", status: "QUEUED" },
  });
  await prisma.llmCall.create({
    data: {
      purpose: "other",
      model: "check",
      taskId: other.id,
      agentKey: AGENT_KEY,
      inputTokens: 1,
      outputTokens: 1,
      costUsd: "9.000000",
      durationMs: 1,
      ok: true,
    },
  });
  check("another task's spend stays on that task", (await spendOn(task.id)) === 2.2, `${await spendOn(task.id)}`);
  check("and is counted against it", (await spendOn(other.id)) === 9, `${await spendOn(other.id)}`);
}

console.log("\nAnd the ending writes it down");
{
  // The one ending that needs no model at all: a task whose agent is paused is
  // claimed, found unable to work, and finished BLOCKED. It goes through the
  // same `finishTask` every other ending does, so it is the cheapest honest way
  // to assert what actually lands on the row.
  //
  // Before the fix this branch passed no cost at all and the two `catch` paths
  // passed a literal zero — so a task that had spent real money finished
  // saying it had spent none, beside token counts read from the very ledger the
  // money was sitting on.
  //
  // Its own agent, because the claim refuses a task whose agent already holds a
  // RUNNING one — which the spend fixture above is — and being refused there
  // would have this section assert nothing while reading green.
  const paused = await seed(ENDING_KEY, "Paused Check");
  await prisma.agent.update({ where: { key: paused.key }, data: { status: "PAUSED" } });
  const ending = await prisma.agentTask.create({
    data: { agentKey: ENDING_KEY, title: "ending", brief: "ending", status: "QUEUED" },
  });
  await prisma.llmCall.create({
    data: {
      purpose: `agent.${ENDING_KEY}`,
      model: "check",
      taskId: ending.id,
      agentKey: ENDING_KEY,
      inputTokens: 12_000,
      outputTokens: 3_000,
      costUsd: "3.125000",
      durationMs: 10,
      ok: true,
    },
  });

  const outcome = await runTask(ending.id);
  const row = await prisma.agentTask.findUniqueOrThrow({ where: { id: ending.id } });
  check("a paused agent blocks its task", outcome.status === "BLOCKED", outcome.status);
  check("and the row records what the ledger says", Number(row.costUsd) === 3.125, `${row.costUsd}`);
  check("with the tokens that go with it", row.inputTokens === 12_000 && row.outputTokens === 3_000, `${row.inputTokens}/${row.outputTokens}`);
}


console.log("\nA colleague nobody could reach is not an opinion");
{
  // Every vendor disconnected, in the database as well as in the environment.
  // A dev database holds whatever keys were pasted while testing and
  // `getSetting` falls back to those rows, so removing the variable alone would
  // let this section reach a real vendor — which is both a check that stops
  // being deterministic and one that spends the Owner's money.
  const VENDOR_SETTINGS = [
    SETTING.ANTHROPIC_KEY,
    SETTING.OPENROUTER_KEY,
    SETTING.OPENAI_KEY,
    SETTING.GEMINI_KEY,
    SETTING.PERPLEXITY_KEY,
    SETTING.MODEL_ROUTES,
  ];
  const savedKeys = await prisma.appSetting.findMany({ where: { key: { in: VENDOR_SETTINGS } } });
  const savedEnv = { ...process.env };
  await prisma.appSetting.deleteMany({ where: { key: { in: VENDOR_SETTINGS } } });
  for (const name of ["ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "PERPLEXITY_API_KEY"]) {
    delete process.env[name];
  }
  clearSettingsCache();

  try {
    await seed(COLLEAGUE_KEY, "Unreachable Colleague");
    const asker = await prisma.agent.findUniqueOrThrow({ where: { key: AGENT_KEY } });
    const row = await prisma.agentTask.findUniqueOrThrow({ where: { id: task.id } });

    const counters = {
      toolCalls: 0,
      dryRun: 0,
      refused: 0,
      escalated: null,
      delegated: 0,
      consulted: 0,
      consultedBy: { low: 0, medium: 0, high: 0 },
      handedOff: 0,
      gapsRaised: 0,
    };
    const consult = workflowTools(asker, row, counters).find((tool) => tool.name === "consult");
    if (!consult) throw new Error("`consult` is not among the workflow tools");

    const question = "Is this lead worth a second letter?";
    const first = await consult.run({ agentKey: COLLEAGUE_KEY, question, priority: "high" });

    check("an unreachable colleague comes back as an error", first.isError === true, JSON.stringify(first).slice(0, 100));
    check("it says nobody answered", String(first.content).includes("Nobody answered"), String(first.content).slice(0, 100));
    check("and it spent no consult", counters.consulted === 0, `${counters.consulted}`);
    check("nor any of the high-priority share", counters.consultedBy.high === 0, `${counters.consultedBy.high}`);

    // Still written down, because the timeline should show that the question
    // was put — but written as a failure, which is what keeps `priorConsult`
    // from ever handing it back as somebody's opinion.
    const written = await prisma.agentTaskStep.findFirst({
      where: { taskId: task.id, kind: "CONSULTED" },
      orderBy: { seq: "desc" },
    });
    check("the attempt is on the timeline", written !== null);
    check("recorded as a failure", written?.ok === false, `${written?.ok}`);
    const data = (written?.data ?? {}) as Record<string, unknown>;
    check("with no answer on it", data.answer === undefined, JSON.stringify(data).slice(0, 100));

    // The half this was worst for. Before the fix the second ask was answered
    // from the timeline with the first one's error text, at no cost and with no
    // model call — so an outage during one consult made that colleague
    // permanently unreachable on that task.
    const second = await consult.run({ agentKey: COLLEAGUE_KEY, question, priority: "high" });
    check("asking again is a fresh attempt", String(second.content).includes("Nobody answered"), String(second.content).slice(0, 100));
    check(
      "not the first failure handed back as their answer",
      !String(second.content).includes("earlier answer"),
      String(second.content).slice(0, 100),
    );
    check("and it still cost nothing", counters.consulted === 0, `${counters.consulted}`);
    check("so the whole allowance is still there", counters.consultedBy.high === 0, `${counters.consultedBy.high}`);

    // The control. A consult that *was* answered must still be charged for and
    // must still be cached, or this has bought the outage case by breaking the
    // feature. Written straight to the timeline, since nothing here can make a
    // model answer.
    await prisma.agentTaskStep.create({
      data: {
        taskId: task.id,
        seq: 900,
        kind: "CONSULTED",
        message: "Asked Unreachable Colleague",
        ok: true,
        data: { agentKey: COLLEAGUE_KEY, question, answer: "Yes — they replied to the first one.", priority: "high" },
      },
    });
    const third = await consult.run({ agentKey: COLLEAGUE_KEY, question, priority: "high" });
    check("a real answer is still cached", String(third.content).includes("already asked"), String(third.content).slice(0, 100));
    check("and it is their words that come back", String(third.content).includes("replied to the first one"), String(third.content).slice(0, 100));
    check("a cached answer is free too", counters.consulted === 0, `${counters.consulted}`);

    // The back door. `reconcileCounters` puts a resumed run's tallies back in
    // step from the timeline, so a `CONSULTED` step written for a colleague
    // nobody reached would charge the allowance on the next resume — the same
    // defect, arriving through the reconciliation instead of through the tool.
    const resumed = await reconcileCounters(task.id, {
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
    check("a resume counts the consult that was answered", resumed.counters.consulted === 1, `${resumed.counters.consulted}`);
    check("and not the two nobody answered", resumed.counters.consultedBy.medium === 1, `${resumed.counters.consultedBy.medium}`);
  } finally {
    await prisma.appSetting.deleteMany({ where: { key: { in: VENDOR_SETTINGS } } });
    for (const saved of savedKeys) {
      await prisma.appSetting.create({ data: { key: saved.key, value: saved.value, secret: saved.secret } });
    }
    process.env = savedEnv;
    clearSettingsCache();
  }
}

console.log("\nAnd the rows already written are put right");
{
  // Runs once and only upward, so the two negatives are the assertions worth
  // having: a task with nothing on either ledger is left alone rather than
  // being invented a zero, and a figure already higher than the ledgers know
  // about is a fact from somewhere this cannot see and is not lowered.
  await prisma.appSetting.deleteMany({ where: { key: SETTING.AGENT_COST_BACKFILL } });
  clearSettingsCache();

  const understated = await prisma.agentTask.create({
    data: { agentKey: AGENT_KEY, title: "understated", brief: "b", status: "FAILED", costUsd: "0" },
  });
  const overstated = await prisma.agentTask.create({
    data: { agentKey: AGENT_KEY, title: "overstated", brief: "b", status: "DONE", costUsd: "5.000000" },
  });
  const evidenceless = await prisma.agentTask.create({
    data: { agentKey: AGENT_KEY, title: "no evidence", brief: "b", status: "DONE", costUsd: "0.750000" },
  });
  for (const [id, cost] of [
    [understated.id, "2.000000"],
    [overstated.id, "1.000000"],
  ] as const) {
    await prisma.llmCall.create({
      data: { purpose: "backfill", model: "check", taskId: id, agentKey: AGENT_KEY, inputTokens: 1, outputTokens: 1, costUsd: cost, durationMs: 1, ok: true },
    });
  }
  await prisma.toolCall.create({
    data: { tool: "capture.run", taskId: understated.id, agentKey: AGENT_KEY, ok: true, costUsd: "0.500000", durationMs: 1 },
  });

  const result = await backfillTaskCosts();
  const read = async (id: string) => Number((await prisma.agentTask.findUniqueOrThrow({ where: { id } })).costUsd);
  check("a task recorded as free is put right", (await read(understated.id)) === 2.5, `${await read(understated.id)}`);
  check("a task already ahead of the ledgers is left alone", (await read(overstated.id)) === 5, `${await read(overstated.id)}`);
  check("and one with no evidence either way is untouched", (await read(evidenceless.id)) === 0.75, `${await read(evidenceless.id)}`);
  check("it says what it moved", (result?.corrected ?? 0) >= 1, JSON.stringify(result));

  // Once ever. A row corrected here and then legitimately re-run later must
  // not be corrected back on the next boot.
  await prisma.agentTask.update({ where: { id: understated.id }, data: { costUsd: "9.000000" } });
  check("a second boot does nothing", (await backfillTaskCosts()) === null);
  check("and leaves the later figure standing", (await read(understated.id)) === 9, `${await read(understated.id)}`);

  await prisma.appSetting.deleteMany({ where: { key: SETTING.AGENT_COST_BACKFILL } });
  clearSettingsCache();
}

await reset();
await prisma.appSetting.deleteMany({ where: { key: SETTING.AGENT_COST_BACKFILL } });
await prisma.$disconnect();

console.log(bad === 0 ? "\nAll good.\n" : `\n${bad} problem(s).\n`);
process.exit(bad === 0 ? 0 : 1);
