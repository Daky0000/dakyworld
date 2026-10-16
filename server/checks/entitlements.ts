/**
 * Who gets which DakyX product, and the builder honouring it. Database only.
 *
 *   npx tsx checks/entitlements.ts
 *
 * The promise: a client on an active retainer gets every product; somebody
 * who bought one product gets that one. Until 16 Oct 2026 a retainer client
 * signing in to the builder was given Starter, because nothing that decided
 * what a person could do ever looked at a retainer and no table said which
 * people a retainer's client was. docs/cross-product-access.md.
 */
import assert from "node:assert/strict";
import type { Request } from "express";
import { prisma } from "../src/lib/prisma.js";
import {
  PRODUCT_TIERS,
  RETAINER_TIERS,
  announceClientChange,
  decideEntitlements,
  entitlementsFor,
  type EntitlementInputs,
} from "../src/services/entitlements.js";
import { resolveEntitlement } from "../src/services/websiteEntitlement.js";
import { backoffMs } from "../src/services/entitlementEvents.js";

let checks = 0;
function check(name: string, condition: unknown) { assert.ok(condition, name); checks++; }
function equal(name: string, actual: unknown, expected: unknown) { assert.deepEqual(actual, expected, name); checks++; }

const NOW = new Date("2026-10-16T12:00:00Z");
const base: EntitlementInputs = {
  user: { id: "u1", active: true, deletionScheduledFor: null },
  retainers: [],
  seat: null,
  staff: false,
  comps: [],
  now: NOW,
};
const grantsOf = (input: Partial<EntitlementInputs>) =>
  Object.fromEntries(decideEntitlements({ ...base, ...input }).map((grant) => [grant.product, `${grant.tier}/${grant.source}`]));

/* ------------------------------------------------------------ the rules -- */

equal("nobody with nothing holds anything", grantsOf({}), {});

for (const tier of ["FOUNDATION", "GROWTH", "TRANSFORMATION"] as const) {
  const grants = grantsOf({ retainers: [{ clientId: "c1", tier }] });
  equal(`a ${tier} retainer gives every product`, Object.keys(grants).sort(), ["marketing-suite", "website-builder"]);
  equal(`at the tiers RETAINER_TIERS names for ${tier}`, grants, {
    "website-builder": `${RETAINER_TIERS[tier]["website-builder"]}/retainer`,
    "marketing-suite": `${RETAINER_TIERS[tier]["marketing-suite"]}/retainer`,
  });
}
check("every retainer tier is a real tier of each product", Object.values(RETAINER_TIERS).every((tiers) =>
  Object.entries(tiers).every(([product, tier]) => PRODUCT_TIERS[product as keyof typeof PRODUCT_TIERS].includes(tier))));

equal("a builder seat alone gives the builder and nothing else", grantsOf({ seat: { tier: "CARE", validUntil: null } }), { "website-builder": "CARE/subscription" });
equal("a retainer outranks a lower seat", grantsOf({ seat: { tier: "EDITOR", validUntil: null }, retainers: [{ clientId: "c1", tier: "FOUNDATION" }] })["website-builder"], "MANAGED/retainer");
equal("two retainers: the larger one's Marketing tier", grantsOf({ retainers: [{ clientId: "a", tier: "FOUNDATION" }, { clientId: "b", tier: "TRANSFORMATION" }] })["marketing-suite"], "agency/retainer");

equal("staff get the builder from website.manage", grantsOf({ staff: true }), { "website-builder": "MANAGED/staff" });
check("but no Marketing from a permission", !("marketing-suite" in grantsOf({ staff: true })));

equal("a comp gives what it says", grantsOf({ comps: [{ productKey: "marketing-suite", tier: "pro", validUntil: null, revokedAt: null }] }), { "marketing-suite": "pro/comp" });
equal("an expired comp gives nothing", grantsOf({ comps: [{ productKey: "marketing-suite", tier: "pro", validUntil: new Date("2026-10-01"), revokedAt: null }] }), {});
equal("a revoked comp gives nothing", grantsOf({ comps: [{ productKey: "marketing-suite", tier: "pro", validUntil: null, revokedAt: new Date("2026-10-01") }] }), {});
equal("a comp naming a tier the product lacks is a typo, not a grant", grantsOf({ comps: [{ productKey: "marketing-suite", tier: "Pro Plus", validUntil: null, revokedAt: null }] }), {});
equal("a comp for an unknown product is ignored", grantsOf({ comps: [{ productKey: "crm", tier: "pro", validUntil: null, revokedAt: null }] }), {});
equal("a lower comp does not pull a retainer down", grantsOf({ retainers: [{ clientId: "c1", tier: "GROWTH" }], comps: [{ productKey: "marketing-suite", tier: "starter", validUntil: null, revokedAt: null }] })["marketing-suite"], "pro/retainer");

equal("a switched-off account holds nothing, retainer or not", grantsOf({ user: { id: "u1", active: false, deletionScheduledFor: null }, retainers: [{ clientId: "c1", tier: "TRANSFORMATION" }] }), {});
equal("nor does one waiting to be erased", grantsOf({ user: { id: "u1", active: true, deletionScheduledFor: new Date() }, retainers: [{ clientId: "c1", tier: "GROWTH" }] }), {});

const ending = decideEntitlements({ ...base, seat: { tier: "CARE", validUntil: new Date("2026-11-01T00:00:00Z") } })[0];
equal("an ending seat says when it ends", ending?.validUntil, "2026-11-01T00:00:00.000Z");

check("delivery backs off and is capped at an hour", backoffMs(1) === 30_000 && backoffMs(2) === 60_000 && backoffMs(30) === 3_600_000);

/* ------------------------------------------------- against the database -- */

const stamp = `ent-${Date.now()}`;
const created = { users: [] as string[], clients: [] as string[] };

try {
  const client = await prisma.client.create({ data: { name: `Retainer Co ${stamp}` } });
  created.clients.push(client.id);
  const person = await prisma.user.create({ data: { email: `${stamp}-a@entitlements.test`, name: "Ama" } });
  const outsider = await prisma.user.create({ data: { email: `${stamp}-b@entitlements.test`, name: "Kofi" } });
  created.users.push(person.id, outsider.id);

  const actor = (user: typeof person) => ({ dbUser: { ...user, accessRole: null }, headers: {}, permissions: new Set<string>() }) as unknown as Request;

  // Before: a member with no retainer is on Starter, as anybody with nothing is.
  await prisma.clientMember.create({ data: { clientId: client.id, userId: person.id } });
  equal("a member of a client with no retainer is on Starter", (await resolveEntitlement(actor(person) as never)).tier, "EDITOR");

  const plan = await prisma.carePlan.create({ data: { clientId: client.id, tier: "GROWTH", monthlyFee: "7000.00" } });
  const covered = await resolveEntitlement(actor(person) as never);
  equal("a member of a retainer client opens the builder at the retainer's tier", covered.tier, "MANAGED");
  equal("and is told why", covered.source, "retainer");
  equal("with no purchase id, so no dunning rule can lock a retainer client out", covered.purchaseId, null);
  equal("somebody who is not a member is not covered by a stranger's retainer", (await resolveEntitlement(actor(outsider) as never)).tier, "EDITOR");

  const full = await entitlementsFor(person.id);
  equal("entitlementsFor names both products for the member", full.grants.map((grant) => `${grant.product}:${grant.tier}`).sort(), ["marketing-suite:pro", "website-builder:MANAGED"]);
  equal("keyed on the OS user id", full.subject, person.id);

  await prisma.carePlan.update({ where: { id: plan.id }, data: { status: "PAUSED" } });
  equal("a paused retainer covers nothing", (await entitlementsFor(person.id)).grants, []);
  equal("and the builder drops back", (await resolveEntitlement(actor(person) as never)).tier, "EDITOR");
  await prisma.carePlan.update({ where: { id: plan.id }, data: { status: "CHURNED" } });
  equal("nor does a churned one", (await entitlementsFor(person.id)).grants, []);

  await prisma.productGrant.create({ data: { userId: outsider.id, productKey: "marketing-suite", tier: "starter", reason: "trial" } });
  equal("a comp reaches the person it names", (await entitlementsFor(outsider.id)).grants.map((grant) => `${grant.product}:${grant.tier}:${grant.source}`), ["marketing-suite:starter:comp"]);

  equal("an unknown subject holds nothing and is not active", await entitlementsFor("nobody-at-all-0000").then((e) => [e.active, e.grants]), [false, []]);

  // Announcements are queued only when a partner is configured, one per member.
  const before = process.env.PARTNER_MARKETING_EVENTS_URL;
  const beforeKey = process.env.PARTNER_MARKETING_API_KEY;
  process.env.PARTNER_MARKETING_EVENTS_URL = "https://marketing.example.test/api/internal/dakyx/events";
  process.env.PARTNER_MARKETING_API_KEY = "test-key";
  await announceClientChange(client.id);
  equal("a retainer change queues one event per member of its client", await prisma.entitlementEvent.count({ where: { userId: { in: created.users } } }), 1);
  delete process.env.PARTNER_MARKETING_EVENTS_URL;
  await announceClientChange(client.id);
  equal("and nothing at all with no partner configured", await prisma.entitlementEvent.count({ where: { userId: { in: created.users } } }), 1);
  if (before) process.env.PARTNER_MARKETING_EVENTS_URL = before;
  if (beforeKey) process.env.PARTNER_MARKETING_API_KEY = beforeKey; else delete process.env.PARTNER_MARKETING_API_KEY;
} finally {
  await prisma.entitlementEvent.deleteMany({ where: { userId: { in: created.users } } });
  await prisma.carePlan.deleteMany({ where: { clientId: { in: created.clients } } });
  await prisma.client.deleteMany({ where: { id: { in: created.clients } } });
  await prisma.user.deleteMany({ where: { id: { in: created.users } } });
  await prisma.$disconnect();
}

console.log(`entitlements: ${checks} checks passed`);
