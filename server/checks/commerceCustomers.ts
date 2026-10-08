/**
 * The Customers screen can suspend an account, change its email and sign it
 * out everywhere. Those buttons must only ever reach customers.
 *
 * `customerForWrite` in routes/commerce.ts is the one gate every one of those
 * writes goes through. This proves it refuses a colleague, an Owner, an account
 * with no role and nothing bought, and the person asking — and lets a real
 * customer through. Needs only Postgres.
 *
 *   npx tsx checks/commerceCustomers.ts
 */
import { prisma } from "../src/lib/prisma.js";
import { customerForWrite } from "../src/routes/commerce.js";

const failures: string[] = [];
let passed = 0;
function check(name: string, ok: boolean): void {
  if (ok) { passed += 1; console.log(`  ok    ${name}`); }
  else { failures.push(name); console.log(`  FAIL  ${name}`); }
}

const PREFIX = "check-commerce-";
const KEYS = { external: `${PREFIX}external`, staff: `${PREFIX}staff`, owner: `${PREFIX}owner` };
const EMAILS = { customer: `${PREFIX}customer@dakyx.local`, staff: `${PREFIX}staff@dakyx.local`, owner: `${PREFIX}owner@dakyx.local`, bare: `${PREFIX}bare@dakyx.local` };

async function cleanup() {
  await prisma.user.deleteMany({ where: { email: { in: Object.values(EMAILS) } } });
  await prisma.accessRole.deleteMany({ where: { key: { in: Object.values(KEYS) } } });
}

async function refused(id: string, actor: string | undefined): Promise<boolean> {
  try {
    await customerForWrite(id, actor);
    return false;
  } catch (error) {
    return typeof (error as { status?: number }).status === "number";
  }
}

async function main() {
  await cleanup();
  const external = await prisma.accessRole.create({ data: { key: KEYS.external, name: "Check customer", external: true, permissions: [] } });
  const staff = await prisma.accessRole.create({ data: { key: KEYS.staff, name: "Check staff", permissions: ["website.manage"] } });
  // An Owner is the role with superAdmin. Marked external as well on purpose:
  // even an account that looks like a customer must not be touched if it is an Owner.
  const owner = await prisma.accessRole.create({ data: { key: KEYS.owner, name: "Check owner", superAdmin: true, external: true, permissions: [] } });

  const customer = await prisma.user.create({ data: { email: EMAILS.customer, name: "Customer", accessRoleId: external.id } });
  const colleague = await prisma.user.create({ data: { email: EMAILS.staff, name: "Colleague", accessRoleId: staff.id } });
  const boss = await prisma.user.create({ data: { email: EMAILS.owner, name: "Owner", accessRoleId: owner.id } });
  const bare = await prisma.user.create({ data: { email: EMAILS.bare, name: "Bare", accessRoleId: null } });

  console.log("\nWho the Customers screen may change");
  let allowed = false;
  try { allowed = (await customerForWrite(customer.id, colleague.id)).id === customer.id; } catch { allowed = false; }
  check("a customer account can be managed by a colleague", allowed);
  check("a colleague's account is refused", await refused(colleague.id, customer.id));
  check("an Owner account is refused, even one marked external", await refused(boss.id, colleague.id));
  check("an account with no role and nothing bought is refused", await refused(bare.id, colleague.id));
  check("nobody can act on their own account from here", await refused(customer.id, customer.id));
  check("an account that does not exist is refused", await refused("no-such-user", colleague.id));
}

main()
  .catch((error) => { console.error(error); failures.push("threw"); })
  .finally(async () => {
    await cleanup();
    await prisma.$disconnect();
    console.log(`\n${passed} passed, ${failures.length} failed`);
    if (failures.length) process.exit(1);
  });
