/**
 * A free model that is not there for this account is left out of the ladders
 * for a while (`liveFreeLadder` in `lib/models/registry.ts`).
 *
 * A model can be listed by the vendor and still answer "not found for
 * account". On the live workforce that was one wasted call on every run of
 * every agent. What this holds still:
 *
 *  - a 404 or a 410 says the model is gone; a busy, slow or rate-limited one
 *    does not;
 *  - a model marked gone is left out of every ladder it is on, in order, and
 *    comes back when its time is up;
 *  - a ladder is never emptied by this — an empty ladder means "free models
 *    off" to everything that reads one, which is a different instruction;
 *  - the configured ladder, which the Settings screen shows, is untouched.
 *
 * No database, no network: every stored setting reads as unset.
 *   npx tsx checks/freeModelGone.ts
 */
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

delete process.env.NVIDIA_FREE_MODELS;
const { prisma } = await import("../src/lib/prisma.js");
Object.defineProperty(prisma, "appSetting", { value: { findUnique: async () => null, findMany: async () => [] } });

const { FREE_LADDER_BY_JOB, FREE_MODEL_GONE_MS, clearFreeModelsGone, freeLadderFor, freeModelsGone, liveFreeLadder, markFreeModelGone, nvidiaAttempts, saysModelIsGone } = await import(
  "../src/lib/models/registry.js"
);

console.log("\nWhat says a model is gone");
check("a 404 does", saysModelIsGone(404));
check("a 410 does", saysModelIsGone(410));
check("a rate limit does not", !saysModelIsGone(429));
check("nor a gateway timeout", !saysModelIsGone(504));
check("nor a refused key", !saysModelIsGone(401) && !saysModelIsGone(403));
check("nor a refused request", !saysModelIsGone(400));

console.log("\nLeft out, and only for a while");
{
  const shipped = [...FREE_LADDER_BY_JOB.agent];
  check("the agent ladder ships with three rungs", shipped.length === 3, shipped.join(", "));
  check("with nothing marked, the live ladder is the configured one", (await liveFreeLadder("agent")).join() === shipped.join());

  const dead = shipped[2];
  markFreeModelGone(dead, "Function 'x': Not found for account 'y'");
  const live = await liveFreeLadder("agent");
  check("a model marked gone is left out", !live.includes(dead) && live.length === 2, live.join(", "));
  check("the rest keep their order", live.join() === shipped.filter((id) => id !== dead).join(), live.join(", "));
  check("the configured ladder still shows it", (await freeLadderFor("agent")).includes(dead));
  check("an attempt climbs the live ladder", (await nvidiaAttempts("agent")).join() === live.join());
  check("it is reported as left out", freeModelsGone().some((entry) => entry.id === dead));

  const others = Object.entries(FREE_LADDER_BY_JOB).filter(([job, ladder]) => job !== "agent" && (ladder as readonly string[]).includes(dead));
  let everywhere = true;
  for (const [job] of others) if ((await liveFreeLadder(job as never)).includes(dead)) everywhere = false;
  check(`and it is left out of every other ladder it is on (${others.length})`, everywhere);

  for (const id of shipped) markFreeModelGone(id, "gone");
  const all = await liveFreeLadder("agent");
  check("a ladder is never emptied by this", all.join() === shipped.join(), all.join(", "));

  clearFreeModelsGone();
  markFreeModelGone(dead, "gone");
  const realNow = Date.now;
  Date.now = () => realNow() + FREE_MODEL_GONE_MS + 1_000;
  const later = await liveFreeLadder("agent");
  Date.now = realNow;
  check("after its time is up it is asked again", later.includes(dead), later.join(", "));
  clearFreeModelsGone();
  check("clearing leaves nothing out", freeModelsGone().length === 0);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const name of failures) console.log(`  - ${name}`);
  process.exit(1);
}
process.exit(0);
