/**
 * The switch that stands in for integrations nobody has connected.
 *
 * `checks/README.md` states the rule this feature sits closest to breaking: a
 * stub is a different far end, **not** a way past the credential check, because
 * making `toolReadiness()` answer "configured" when nothing is means an agent
 * calls `email.send`, receives a fake success, and reports the letter as sent.
 * `DEV_MODE` deliberately does the thing that rule forbids, so everything that
 * keeps it safe is asserted here rather than described in a comment:
 *
 *  - **It is off unless a developer switched it on**, and refused outright on
 *    anything that looks like a deployment. Two independent signals have to
 *    agree, the same guard `DEV_NO_AUTH` uses, and a missing `NODE_ENV` fails
 *    closed rather than open.
 *  - **A configured integration is never stood in for.** The real check runs
 *    first and only a "no" is replaced, so a machine with a working mailer goes
 *    on sending real email.
 *  - **The stand-in says nothing left the building.** That is the whole
 *    mitigation for the failure the README names: an agent reading this result
 *    is told in words that nobody received anything.
 *
 * No database, no key, no network. The module is re-imported per scenario with
 * the environment set beforehand, because the guard is a module constant — read
 * at import, exactly as `middleware/auth.ts` reads its own.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

let bad = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(ok ? `  ok    ${label}` : `  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) bad += 1;
}

const HERE = dirname(fileURLToPath(import.meta.url));
// A `file://` URL, not a path. On Windows a dynamic import of "c:\..." is
// refused outright by the ESM loader — the drive letter reads as a protocol.
const MODULE = pathToFileURL(join(HERE, "../src/services/tools/devMode.ts")).href;

/**
 * A fresh copy of the module with this environment.
 *
 * The cache-busting query is the point: `DEV_MODE` is resolved once at import,
 * so a second `import()` of the same specifier would hand back the first
 * scenario's answer and every assertion below would be about nothing.
 */
let load = 0;
async function withEnv(env: Record<string, string | undefined>) {
  const before: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    before[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const mod = (await import(`${MODULE}?scenario=${(load += 1)}`)) as typeof import("../src/services/tools/devMode.js");
  for (const [key, value] of Object.entries(before)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return mod;
}

/** Every platform variable, cleared — a developer's laptop sets none of them. */
const LAPTOP = {
  RAILWAY_ENVIRONMENT: undefined,
  RAILWAY_PROJECT_ID: undefined,
  RAILWAY_SERVICE_ID: undefined,
  RENDER: undefined,
  FLY_APP_NAME: undefined,
  DYNO: undefined,
  VERCEL: undefined,
  KUBERNETES_SERVICE_HOST: undefined,
  NODE_ENV: undefined,
};

console.log("\nOff unless somebody switched it on");
{
  const unset = await withEnv({ ...LAPTOP, DEV_MODE: undefined });
  check("unset is off", !unset.DEV_MODE);
  check("and nothing is being ignored", !unset.DEV_MODE_REFUSED);

  const off = await withEnv({ ...LAPTOP, DEV_MODE: "false" });
  check('"false" is off', !off.DEV_MODE);

  // Only the exact string. A variable set to "1" or "yes" reading as on is how
  // somebody switches this on without meaning to.
  const one = await withEnv({ ...LAPTOP, DEV_MODE: "1" });
  check('"1" is off, because only "true" is on', !one.DEV_MODE);

  const on = await withEnv({ ...LAPTOP, DEV_MODE: "true" });
  check('"true" on a laptop is on', on.DEV_MODE);
}

console.log("\nNever on a deployment, and it says so");
{
  // Each platform signal alone has to be enough. A deployment that sets only
  // one of them must not be the one this is honoured on.
  for (const signal of ["RAILWAY_ENVIRONMENT", "RENDER", "FLY_APP_NAME", "DYNO", "VERCEL", "KUBERNETES_SERVICE_HOST"]) {
    const mod = await withEnv({ ...LAPTOP, DEV_MODE: "true", [signal]: "yes" });
    check(`${signal} alone refuses it`, !mod.DEV_MODE);
    // Said loudly at boot rather than silently dropped: a variable that is set
    // and ignored is one somebody believes is doing something.
    check(`and reports that it was ignored`, mod.DEV_MODE_REFUSED);
  }

  const prod = await withEnv({ ...LAPTOP, DEV_MODE: "true", NODE_ENV: "production" });
  check("production alone refuses it", !prod.DEV_MODE);
  check("and reports that it was ignored", prod.DEV_MODE_REFUSED);
}

console.log("\nWhat a stand-in returns");
{
  const mod = await withEnv({ ...LAPTOP, DEV_MODE: "true" });

  const email = mod.devToolMock("email");
  check("a stand-in exists for the mailer", email.readiness.length > 0);
  // The mitigation for the failure `checks/README.md` names. An agent reading
  // this must be told in words that nobody received anything.
  check("and its output says nothing was sent", email.output.sent === false, JSON.stringify(email.output));
  check("and marks itself as a stand-in", email.output.devMode === true, JSON.stringify(email.output));
  check("and says so in a sentence an agent will read", String(email.output.note ?? "").includes("nobody received"), String(email.output.note));

  // A requirement with no file must still be stood in for, or a newly added
  // integration silently goes back to refusing while the switch is on — which
  // reads as the switch being broken.
  const unknown = mod.devToolMock("webhooks");
  check("a requirement with no file gets a generic stand-in", unknown.output.devMode === true, JSON.stringify(unknown.output));
  check("named after what it stands in for", unknown.readiness.includes("webhooks"), unknown.readiness);
}

console.log("\nEvery stand-in on file is usable");
{
  // A malformed JSON file is dropped by the loader and falls to the generic
  // mock, which is a silent downgrade — so the files are read directly here.
  const dir = join(HERE, "../src/services/tools/dev-tools");
  const files = readdirSync(dir).filter((name) => name.endsWith(".json"));
  check("there are stand-ins on file", files.length > 0, `${files.length}`);
  for (const file of files) {
    let ok = false;
    let why = "";
    try {
      const parsed = JSON.parse(readFileSync(join(dir, file), "utf8")) as { readiness?: unknown; output?: unknown };
      ok = typeof parsed.readiness === "string" && parsed.readiness.length > 0 && typeof parsed.output === "object" && parsed.output !== null;
      why = JSON.stringify(parsed).slice(0, 100);
    } catch (err) {
      why = (err as Error).message;
    }
    check(`${file} parses and has both halves`, ok, why);
  }
  // Every one of them has to say it is a stand-in. A mock output that looks
  // like a real one is the whole failure mode.
  for (const file of files) {
    const parsed = JSON.parse(readFileSync(join(dir, file), "utf8")) as { output: Record<string, unknown> };
    check(`${file} marks its output as a stand-in`, parsed.output.devMode === true, JSON.stringify(parsed.output).slice(0, 100));
  }
}

console.log(bad ? `\n${bad} PROBLEM(S)` : `\nDEV_MODE is off, refused on a deployment, and honest about what it faked.`);
process.exitCode = bad ? 1 : 0;
