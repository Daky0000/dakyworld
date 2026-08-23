/**
 * Does a role actually decide anything, and only what it says?
 *
 * This is a permission system, so both failure modes are silent. Too weak and
 * a tick on the Access screen enforces nothing — somebody is shown a closed
 * door that is not locked, and the only way to find out is to give a person a
 * narrow role and watch them do the thing anyway. Too broad and a colleague
 * cannot do their job, with the symptom arriving as a 403 in a screen that
 * looks broken rather than as an answer about permissions.
 *
 * The negatives outnumber the positives, and they are the point:
 *
 *   - **Every key in the catalogue is enforced by some route.** The defect this
 *     exists for is a permission that exists only on the Access screen. Adding
 *     one to lib/permissions.ts and forgetting the `gateBy` line produces
 *     exactly that, compiles perfectly, and looks right in the UI.
 *   - **No gate names a key the catalogue does not have.** The mirror image: a
 *     route gated on a typo can never be granted to anybody, so the feature is
 *     unreachable for everyone including the Owner.
 *   - **Re-seeding never overwrites an edited system role.** The single most
 *     important line in `ensureSystemRoles`. A seeder that reinstated the
 *     shipped permissions would undo the Owner's own tightening on the next
 *     deploy, and nothing on any screen would say why access came back.
 *   - **Deny beats both grants.** A revocation that silently reverses itself
 *     weeks later, when somebody widens the role for an unrelated reason, is
 *     the kind of thing nobody notices until it is in a log.
 *   - **The Owner role ignores the ticks entirely.** What makes it impossible
 *     to produce a system nobody can administer.
 *   - **The shipped roles reproduce the access that existed before this.** A
 *     Developer who could open Proposals yesterday must still open Proposals.
 *   - **A method with no key declared is refused, not waved through.**
 *
 * A database and nothing else. No API key, no network.
 *   npx tsx checks/access.ts
 */
import type { Request, Response } from "express";
import { prisma } from "../src/lib/prisma.js";
import {
  ALL_PERMISSION_KEYS,
  PERMISSION_MODULES,
  SYSTEM_ROLES,
  isPermissionKey,
  knownPermissions,
} from "../src/lib/permissions.js";
import { effectivePermissions, ensureSystemRoles, userCan } from "../src/lib/accessRoles.js";
import { ENFORCED_PERMISSIONS, gateBy } from "../src/middleware/permissionGate.js";

// Importing the routers is what populates ENFORCED_PERMISSIONS — the gates
// register themselves as they are constructed at import time. Without this the
// coverage assertions below would pass against an empty set, which is the
// failure mode of a check that proves nothing.
import "../src/routes/leads.js";
import "../src/routes/clients.js";
import "../src/routes/projects.js";
import "../src/routes/proposals.js";
import "../src/routes/demos.js";
import "../src/routes/invoices.js";
import "../src/routes/carePlans.js";
import "../src/routes/emails.js";
import "../src/routes/inbox.js";
import "../src/routes/messages.js";
import "../src/routes/audits.js";
import "../src/routes/capture.js";
import "../src/routes/scrapers.js";
import "../src/routes/imports.js";
import "../src/routes/mcp.js";
import "../src/routes/tools.js";
import "../src/routes/costs.js";
import "../src/routes/approvals.js";
import "../src/routes/rehearsals.js";
import "../src/routes/context.js";
import "../src/routes/agents.js";
import "../src/routes/settings.js";
import "../src/routes/dashboard.js";
import "../src/routes/users.js";
import "../src/routes/access.js";

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

const EMAIL = "check-access@dakyworld.local";
const ROLE_KEY = "check-access-role";

async function reset({ recreate }: { recreate: boolean }) {
  await prisma.user.deleteMany({ where: { email: EMAIL } });
  await prisma.accessRole.deleteMany({ where: { key: ROLE_KEY } });
  if (recreate) {
    await prisma.accessRole.create({
      data: { key: ROLE_KEY, name: "Check Role", permissions: ["leads.view", "leads.edit"] },
    });
  }
}

// ---------------------------------------------------------------------------

async function main() {
  console.log("\nCatalogue and enforcement");

  const unenforced = ALL_PERMISSION_KEYS.filter((key) => !ENFORCED_PERMISSIONS.has(key));
  ok(
    "every permission in the catalogue is enforced by a route",
    unenforced.length === 0,
    unenforced.length ? `never checked anywhere: ${unenforced.join(", ")}` : undefined,
  );

  const unknown = [...ENFORCED_PERMISSIONS].filter((key) => !isPermissionKey(key));
  ok(
    "no route gates on a key the catalogue does not have",
    unknown.length === 0,
    unknown.length ? `gated but ungrantable: ${unknown.join(", ")}` : undefined,
  );

  const duplicates = ALL_PERMISSION_KEYS.filter((key, i) => ALL_PERMISSION_KEYS.indexOf(key) !== i);
  ok("no key appears in two modules", duplicates.length === 0, duplicates.join(", "));

  ok(
    "every key is namespaced by its module",
    PERMISSION_MODULES.every((module) => module.permissions.every((p) => p.key.startsWith(`${module.key}.`))),
  );

  ok("unknown keys are dropped on read", knownPermissions(["leads.view", "leads.telepathy"]).join() === "leads.view");

  // -------------------------------------------------------------------------
  console.log("\nThe shipped roles reproduce the access that existed before this");

  await ensureSystemRoles();
  const roles = await prisma.accessRole.findMany({ where: { system: true } });
  const byKey = new Map(roles.map((r) => [r.key, r]));

  ok("all six system roles exist", roles.length === SYSTEM_ROLES.length, `found ${roles.length}`);
  ok("Owner is the only superAdmin", roles.filter((r) => r.superAdmin).length === 1 && byKey.get("owner")!.superAdmin);
  ok("Client Viewer is the only external role", roles.filter((r) => r.external).length === 1 && byKey.get("client-viewer")!.external);

  const developer = byKey.get("developer")!;
  const pm = byKey.get("project-manager")!;
  const finance = byKey.get("operations-finance")!;

  // Positives: what each of these could reach before, they must still reach.
  ok("a Developer can still open Proposals", developer.permissions.includes("proposals.view"));
  ok("a Developer can still open Invoices", developer.permissions.includes("invoices.view"));
  ok("a Project Manager can still send email", pm.permissions.includes("emails.send"));
  ok("Operations & Finance can still bill a retainer", finance.permissions.includes("retainers.bill"));

  // Negatives: what each of these was refused before, it must still be refused.
  ok("a Developer still cannot reach outreach", !developer.permissions.includes("emails.view"));
  ok("a Developer still cannot reach Settings", !developer.permissions.includes("settings.view"));
  ok("a Developer still cannot reach the Agents screen", !developer.permissions.includes("agents.view"));
  ok("a Developer still cannot import leads", !developer.permissions.includes("leads.import"));
  ok("a Project Manager still cannot reach retainers", !pm.permissions.includes("retainers.view"));
  ok("nobody but the Owner administers the team", roles.every((r) => r.superAdmin || !r.permissions.includes("team.access")));
  ok("the Client Viewer role carries nothing at all", byKey.get("client-viewer")!.permissions.length === 0);

  // -------------------------------------------------------------------------
  console.log("\nRe-seeding does not undo an edit");

  // The Owner tightens Developer by hand, then a deploy happens.
  await prisma.accessRole.update({ where: { key: "developer" }, data: { permissions: ["leads.view"] } });
  await ensureSystemRoles();
  const afterRedeploy = await prisma.accessRole.findUnique({ where: { key: "developer" } });
  ok(
    "an edited system role keeps its edit across a re-seed",
    afterRedeploy!.permissions.length === 1 && afterRedeploy!.permissions[0] === "leads.view",
    `came back as ${afterRedeploy!.permissions.length} permissions`,
  );
  ok("the re-seed still refreshes the name", afterRedeploy!.name === "Developer");
  await prisma.accessRole.update({
    where: { key: "developer" },
    data: { permissions: SYSTEM_ROLES.find((r) => r.key === "developer")!.permissions },
  });

  // -------------------------------------------------------------------------
  console.log("\nResolving one person's access");

  await reset({ recreate: true });
  const role = (await prisma.accessRole.findUnique({ where: { key: ROLE_KEY } }))!;
  const user = await prisma.user.create({
    data: { email: EMAIL, name: "Access Check", accessRoleId: role.id },
    include: { accessRole: true },
  });

  ok("the role's own permissions come through", userCan(user, "leads.view"));
  ok("what the role lacks is refused", !userCan(user, "leads.delete"));

  const withExtra = { ...user, extraPermissions: ["leads.delete"] };
  ok("an extra permission is added on top of the role", userCan(withExtra, "leads.delete"));

  const withDenial = { ...user, extraPermissions: ["leads.delete"], deniedPermissions: ["leads.delete", "leads.view"] };
  ok("a denial beats an extra grant", !userCan(withDenial, "leads.delete"));
  ok("a denial beats the role itself", !userCan(withDenial, "leads.view"));

  const noRole = { ...user, accessRole: null };
  ok("no role means no permissions at all", effectivePermissions(noRole).size === 0);
  ok("an extra grant on somebody with no role still grants nothing", !userCan({ ...noRole, extraPermissions: ["leads.view"] }, "leads.view"));

  const owner = { ...user, accessRole: { ...role, superAdmin: true, permissions: [] } };
  ok("the Owner role answers yes without reading the list", userCan(owner, "settings.integrations"));
  ok("the Owner role cannot be denied a permission", userCan({ ...owner, deniedPermissions: ["settings.integrations"] }, "settings.integrations"));
  ok("the Owner role resolves to the whole catalogue", effectivePermissions(owner).size === ALL_PERMISSION_KEYS.length);

  const stale = { ...user, accessRole: { ...role, permissions: ["leads.view", "leads.telepathy"] } };
  ok("a stale key in a role is ignored", !effectivePermissions(stale).has("leads.telepathy"));
  ok("a stale key does not disturb the rest of the role", effectivePermissions(stale).has("leads.view"));

  // -------------------------------------------------------------------------
  console.log("\nBackfilling accounts that arrived without a role");

  await prisma.user.update({ where: { id: user.id }, data: { accessRoleId: null, role: "OPERATIONS_FINANCE" } });
  await ensureSystemRoles();
  const backfilled = await prisma.user.findUnique({ where: { id: user.id }, include: { accessRole: true } });
  ok("an account with no role is placed on the one matching its old enum", backfilled?.accessRole?.key === "operations-finance");

  await prisma.user.update({ where: { id: user.id }, data: { accessRoleId: role.id } });
  await ensureSystemRoles();
  const untouched = await prisma.user.findUnique({ where: { id: user.id }, include: { accessRole: true } });
  ok("an account somebody moved deliberately is left alone", untouched?.accessRole?.key === ROLE_KEY);

  // -------------------------------------------------------------------------
  console.log("\nThe gate itself");

  const gate = gateBy({
    view: "leads.view",
    create: "leads.create",
    routes: [{ path: /^\/prepare$/, permission: "leads.prepare" }],
  });

  const run = (method: string, path: string, held: string[]) =>
    new Promise<number>((resolve) => {
      let status = 0;
      const res = {
        status(code: number) {
          status = code;
          return this;
        },
        json() {
          resolve(status);
          return this;
        },
      } as unknown as Response;
      const req = {
        method,
        path,
        dbUser: user,
        permissions: new Set(held),
      } as unknown as Request;
      gate(req, res, () => resolve(200));
    });

  ok("a GET is allowed with view", (await run("GET", "/", ["leads.view"])) === 200);
  ok("a GET is refused without view", (await run("GET", "/", [])) === 403);
  ok("a POST needs create as well as view", (await run("POST", "/", ["leads.view", "leads.create"])) === 200);
  ok("a POST with view alone is refused", (await run("POST", "/", ["leads.view"])) === 403);
  ok("a POST with create but not view is refused", (await run("POST", "/", ["leads.create"])) === 403);
  ok(
    "a route override replaces the method default",
    (await run("POST", "/prepare", ["leads.view", "leads.prepare"])) === 200,
  );
  ok(
    "the override is what is demanded, not the default",
    (await run("POST", "/prepare", ["leads.view", "leads.create"])) === 403,
  );
  ok("a method the module never declared is refused", (await run("DELETE", "/1", ["leads.view"])) === 403);
  ok("an unauthenticated caller is 401 rather than 403", (await run401()) === 401);

  async function run401() {
    return new Promise<number>((resolve) => {
      let status = 0;
      const res = {
        status(code: number) {
          status = code;
          return this;
        },
        json() {
          resolve(status);
          return this;
        },
      } as unknown as Response;
      gate({ method: "GET", path: "/" } as unknown as Request, res, () => resolve(200));
    });
  }
}

main()
  .catch((err) => {
    console.error(err);
    failures.push("threw");
  })
  .finally(async () => {
    // Delete-only, and last — see rule 3 in checks/README.md.
    await reset({ recreate: false });
    await prisma.$disconnect();
    console.log(`\n${passed} passed, ${failures.length} failed`);
    if (failures.length) process.exit(1);
  });
