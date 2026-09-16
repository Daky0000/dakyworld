/**
 * The fence between an agent and somebody else's code.
 *
 * The shared GitHub token can reach every repository its account can see, so
 * the writable-repositories list is the only thing deciding what an agent may
 * write to. It had no check at all, which is a strange thing to be true of the
 * one list standing between a bug and a stranger's repository.
 *
 * The rule it now enforces, and the reason for each half:
 *
 *  - **An entry must name an owner.** A bare `laluxury` used to match a
 *    repository called `laluxury` belonging to *anybody* — and a repository
 *    name is not unique in the world, which is exactly what a fork is.
 *  - **A bare entry is ignored, not reinterpreted.** Quietly widening it to
 *    "whatever the default owner is" is how the old behaviour happened; the
 *    list says what it says.
 *  - **Empty allows nothing**, deliberately, so the default is closed.
 *  - **The refusal names the form to use**, because the fix is a rewrite of the
 *    entry and a message that does not say so sends somebody to the docs.
 *  - **`bareEntries` reports what stopped matching**, which is what lets the
 *    Developer screen say so beside the field rather than only in a boot log.
 *
 * Database only:
 *   set -a; . ./.env; set +a
 *   npx tsx checks/githubAllowlist.ts
 */
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma.js";
import { SETTING, clearSettingsCache, deleteSetting, setSetting } from "../src/lib/settings.js";
import { RepoNotAllowedError, allowedRepos, bareEntries, repoAllowed } from "../src/lib/github.js";

let checks = 0;
function check(name: string, condition: unknown) {
  assert.ok(condition, name);
  checks += 1;
}
function equal(name: string, actual: unknown, expected: unknown) {
  assert.deepEqual(actual, expected, name);
  checks += 1;
}

async function listIs(value: string) {
  await setSetting(SETTING.GITHUB_ALLOWED_REPOS, value);
  clearSettingsCache();
}

async function reset() {
  await deleteSetting(SETTING.GITHUB_ALLOWED_REPOS).catch(() => {});
  await deleteSetting(SETTING.GITHUB_OWNER).catch(() => {});
  clearSettingsCache();
}

async function main() {
  if (process.env.GITHUB_ALLOWED_REPOS) {
    throw new Error("GITHUB_ALLOWED_REPOS is set in the environment, which overrides the setting this check writes. Unset it.");
  }
  await reset();

  // A default owner is set throughout, because it is what makes a bare entry
  // *look* like it should work — `fullName` uses it to expand the repository
  // being asked about. That expansion is not the bug; matching the expanded
  // name against a half-written entry was.
  await setSetting(SETTING.GITHUB_OWNER, "Daky0000");
  clearSettingsCache();

  await listIs("");
  equal("an empty list parses to nothing", await allowedRepos(), []);
  equal("and allows nothing, so the default is closed", await repoAllowed("Daky0000/dakyworld"), false);

  await listIs("Daky0000/dakyworld");
  equal("a fully named repository is allowed", await repoAllowed("Daky0000/dakyworld"), true);
  equal("and the same name under another owner is not", await repoAllowed("someoneelse/dakyworld"), false);
  equal("asking by bare name still resolves through the default owner", await repoAllowed("dakyworld"), true);

  await listIs("laluxury");
  equal("an entry naming no owner matches nothing at all", await repoAllowed("Daky0000/laluxury"), false);
  equal("not even under the default owner, which is the widening that was removed", await repoAllowed("laluxury"), false);
  equal("and certainly not somebody else's fork of that name", await repoAllowed("stranger/laluxury"), false);

  await listIs("*");
  equal("a star opens everything the token can see", await repoAllowed("anyone/anything"), true);

  await listIs("Daky0000/dakyworld, laluxury\nAcme/site");
  equal("the bare one is reported", bareEntries(await allowedRepos()), ["laluxury"]);
  equal("a fully named entry is not reported", bareEntries(["daky0000/dakyworld"]), []);
  equal("and a star is not reported either, because it is not a mistake", bareEntries(["*"]), []);
  equal("the entries either side of it still work", await repoAllowed("Acme/site"), true);

  const refusal = new RepoNotAllowedError("laluxury");
  check("the refusal names the owner/name form somebody has to write", /owner\/laluxury/.test(refusal.message));
  check("and says an entry naming no owner matches nothing", /matches nothing/.test(refusal.message));

  await reset();
  console.log(`githubAllowlist: ${checks} checks — an entry must name an owner, a bare one is ignored rather than widened, and what stopped matching is reportable.`);
  await prisma.$disconnect();
}

void main().catch(async (err) => {
  console.error(err);
  await reset().catch(() => {});
  await prisma.$disconnect();
  process.exitCode = 1;
});
