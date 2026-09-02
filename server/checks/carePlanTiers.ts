/**
 * Do the care plans cost what the website says they cost?
 *
 * The defect was silent and lived in the tier picker. The care plan editor
 * carried three hard-coded fees — 5,000 / 12,500 / 25,000 — under three names
 * dakyworld.com had stopped using, and the picker deliberately did *not*
 * reprice a plan that already existed. So two things were true at once: a new
 * plan was priced from last year's list, and moving a client from one tier to
 * another renamed their plan while going on invoicing the old fee. Nothing
 * threw. The only symptom was an invoice that disagreed with the pricing page
 * the client had read.
 *
 * Five claims, and each of them was false before this pass:
 *
 *  1. The catalogue is the website's, not a constant's — publish a new price
 *     and the picker offers it, with no deploy and nobody retyping a number.
 *  2. Changing the tier changes the fee. That is the whole ask.
 *  3. Except where a fee was actually agreed: an explicit number always wins,
 *     which is the guard the old "don't reprice when editing" rule was really
 *     protecting, kept without the bug it caused.
 *  4. The Founding Partner rate ends by itself. A discount nobody remembers to
 *     end is a permanent discount, so the step-up happens in the code that
 *     raises the invoice rather than on a reminder somebody has to act on.
 *  5. It steps up exactly once, however many times billing is retried.
 *
 * The negatives are the half worth reading: a plan whose tier did not move must
 * not be repriced by editing its billing day, a closed discount must stop being
 * offered rather than live on as a price nobody can buy, and a plan the site
 * sells that this database has no tier for must be reported rather than dropped.
 *
 * Database only. No API key, no network.
 *   npx tsx checks/carePlanTiers.ts
 */
import { prisma } from "../src/lib/prisma.js";
import { clearBusinessOfferCache } from "../src/services/context/business.js";
import { SHIPPED_OFFER } from "../src/services/dakyworld.js";
import { carePlanCatalogue, foundingRateEnd, pricedFieldsFor, priceForTier, TIER_LABEL } from "../src/services/carePlanCatalogue.js";
import { billPeriod } from "../src/services/carePlanBilling.js";

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

const OFFER_KEY = "business.offer";
const CLIENT_ID = "check-careplan-tiers-client";

/** Whatever was really stored, put back at the end. */
let original: string | null = null;

async function storeOffer(offer: unknown) {
  await prisma.appSetting.upsert({
    where: { key: OFFER_KEY },
    update: { value: JSON.stringify(offer), secret: false },
    create: { key: OFFER_KEY, value: JSON.stringify(offer), secret: false },
  });
  clearBusinessOfferCache();
}

async function resetOffer() {
  if (original === null) await prisma.appSetting.deleteMany({ where: { key: OFFER_KEY } });
  else await prisma.appSetting.upsert({ where: { key: OFFER_KEY }, update: { value: original }, create: { key: OFFER_KEY, value: original, secret: false } });
  clearBusinessOfferCache();
}

async function cleanUp() {
  const plans = await prisma.carePlan.findMany({ where: { clientId: CLIENT_ID }, select: { id: true } });
  const ids = plans.map((plan) => plan.id);
  await prisma.carePlanCycle.deleteMany({ where: { carePlanId: { in: ids } } });
  await prisma.invoice.updateMany({ where: { carePlanId: { in: ids } }, data: { carePlanId: null } });
  await prisma.invoiceLineItem.deleteMany({ where: { invoice: { clientId: CLIENT_ID } } });
  await prisma.invoice.deleteMany({ where: { clientId: CLIENT_ID } });
  await prisma.carePlan.deleteMany({ where: { clientId: CLIENT_ID } });
  await prisma.client.deleteMany({ where: { id: CLIENT_ID } });
}

/** A period start far enough back that nothing else in the database owns it. */
function periodOf(year: number, month: number): Date {
  return new Date(Date.UTC(year, month, 1, 0, 0, 0));
}

async function main() {
  original = (await prisma.appSetting.findUnique({ where: { key: OFFER_KEY }, select: { value: true } }))?.value ?? null;
  await cleanUp();

  // ---------------------------------------------------------------------
  console.log("\nThe tiers are the ones the website sells");
  await prisma.appSetting.deleteMany({ where: { key: OFFER_KEY } });
  clearBusinessOfferCache();

  const shipped = await carePlanCatalogue();
  check("three tiers, in the order the pricing page lists them", shipped.tiers.map((tier) => tier.tier).join(",") === "FOUNDATION,GROWTH,TRANSFORMATION");
  check("named as the site names them", shipped.tiers.map((tier) => tier.label).join(", ") === "Foundation, Growth, Transformation");
  check("with nothing stored, the shipped prices are the floor and say so", shipped.source === "shipped" && shipped.syncedAt === null);
  check("every tier carries a published standard rate", shipped.tiers.every((tier) => tier.standardMonthly !== null));
  check(
    "and a Founding Partner rate that is genuinely lower",
    shipped.tiers.every((tier) => tier.foundingMonthly !== null && tier.foundingMonthly < (tier.standardMonthly as number)),
  );
  check("the site's own numbers, not a rounded retelling", JSON.stringify(shipped.tiers.map((tier) => [tier.foundingMonthly, tier.standardMonthly])) === "[[3000,5000],[7000,12500],[15000,25000]]");
  check("Transformation is priced 'from', because the site prices it that way", shipped.tiers[2].fromPrice === true);
  check("Foundation is not", shipped.tiers[0].fromPrice === false);
  check("nothing the site sells is left unaccounted for", shipped.unmatched.length === 0);

  // ---------------------------------------------------------------------
  console.log("\nA price published on the site reaches the picker");
  await storeOffer({
    ...SHIPPED_OFFER,
    syncedAt: new Date().toISOString(),
    plans: [
      { tier: "Foundation", monthly: 6000, discountedMonthly: 3500, discountNote: "GHS 3,500 for the first three months.", for: "Small teams." },
      { tier: "Growth", monthly: 14000, discountedMonthly: 8000, discountNote: "GHS 8,000 for the first three months.", for: "Growing businesses." },
      { tier: "Transformation", monthly: 30000, discountedMonthly: 18000, discountNote: "From GHS 18,000 for the first three months.", for: "Institutions." },
    ],
  });

  const live = await carePlanCatalogue();
  check("the stored answer wins over the constant", live.source === "website" && live.tiers[1].standardMonthly === 14000);
  check("and its discount comes with it", live.tiers[1].foundingMonthly === 8000);
  check("a tier is priced at the rate asked for", (await priceForTier("GROWTH", "STANDARD"))?.monthlyFee === 14000);
  check("and at the other one", (await priceForTier("GROWTH", "FOUNDING"))?.monthlyFee === 8000);

  const founding = await priceForTier("FOUNDATION", "FOUNDING");
  check("a founding rate carries the rate waiting behind it", founding?.standardMonthlyFee === 6000);
  check("and a date for when it takes over", founding?.foundingRateUntil !== null && founding?.foundingRateUntil !== undefined);
  check(
    "three months out, as the site says in four places",
    Math.abs((founding?.foundingRateUntil as Date).getTime() - foundingRateEnd(new Date()).getTime()) < 60_000,
  );
  const standard = await priceForTier("FOUNDATION", "STANDARD");
  check("a standard rate has nothing to step up to", standard?.standardMonthlyFee === null && standard?.foundingRateUntil === null);

  // ---------------------------------------------------------------------
  console.log("\nA discount that has closed stops being offered");
  await storeOffer({
    ...SHIPPED_OFFER,
    syncedAt: new Date().toISOString(),
    plans: [
      { tier: "Foundation", monthly: 5000, discountedMonthly: null, discountNote: "", for: "Small teams." },
      { tier: "Growth", monthly: 12500, discountedMonthly: 12500, discountNote: "", for: "Growing businesses." },
      { tier: "Transformation", monthly: 25000, discountedMonthly: null, discountNote: "", for: "Institutions." },
    ],
  });
  const closed = await carePlanCatalogue();
  check("no discounted rate means no discount", closed.tiers[0].foundingMonthly === null);
  check("a discount equal to the standard rate is not a discount", closed.tiers[1].foundingMonthly === null);
  const asked = await priceForTier("GROWTH", "FOUNDING");
  check("asking for a closed rate prices at the standard one", asked?.monthlyFee === 12500 && asked?.rate === "STANDARD");
  check("and does not invent a step-up", asked?.standardMonthlyFee === null && asked?.foundingRateUntil === null);

  // ---------------------------------------------------------------------
  console.log("\nA plan the site sells with no tier here is reported, not dropped");
  await storeOffer({
    ...SHIPPED_OFFER,
    syncedAt: new Date().toISOString(),
    plans: [...SHIPPED_OFFER.plans, { tier: "Enterprise", monthly: 60000, discountedMonthly: null, discountNote: "", for: "Very large." }],
  });
  const extra = await carePlanCatalogue();
  check("the fourth plan is named", extra.unmatched.join(",") === "Enterprise");
  check("and the three that do have a tier are unaffected", extra.tiers.length === 3 && extra.tiers[0].standardMonthly === 5000);

  // ---------------------------------------------------------------------
  console.log("\nA tier the site could not be read for still has a price");
  await storeOffer({ ...SHIPPED_OFFER, syncedAt: new Date().toISOString(), plans: [{ tier: "Growth", monthly: 14000, discountedMonthly: 8000, discountNote: "", for: "" }] });
  const partial = await carePlanCatalogue();
  check("the tier that was read uses the site's price", partial.tiers[1].standardMonthly === 14000);
  check("the two that were not fall back to the shipped ones", partial.tiers[0].standardMonthly === 5000 && partial.tiers[2].standardMonthly === 25000);
  check("no tier is missing from the picker", partial.tiers.length === 3);

  await resetOffer();

  // ---------------------------------------------------------------------
  // ---------------------------------------------------------------------
  console.log("\nThe tier decides the fee");
  // Back on the shipped floor: Foundation 3,000/5,000, Growth 7,000/12,500,
  // Transformation 15,000/25,000.
  const onStandard = { tier: "FOUNDATION" as const, standardMonthlyFee: null, foundingRateUntil: null };

  const created = await pricedFieldsFor({ tier: "GROWTH" }, null);
  check("a new plan is priced from the website", created?.monthlyFee === 12500);
  check("at the standard rate unless the founding one is asked for", created?.standardMonthlyFee === null);
  check("and gets the tier's capacity allocation", created?.includedHours === 12);

  const moved = await pricedFieldsFor({ tier: "GROWTH" }, onStandard);
  check("moving an existing plan up a tier moves its fee", moved?.monthlyFee === 12500);
  check("and its capacity", moved?.includedHours === 12);

  const movedDown = await pricedFieldsFor({ tier: "FOUNDATION" }, { ...onStandard, tier: "TRANSFORMATION" });
  check("moving down a tier moves the fee down", movedDown?.monthlyFee === 5000);

  // ---------------------------------------------------------------------
  console.log("\nExcept where somebody actually agreed a number");
  const negotiated = await pricedFieldsFor({ tier: "GROWTH", monthlyFee: 9000 }, onStandard);
  check("a fee sent with the tier wins over the published one", Object.keys(negotiated ?? {}).length === 0);

  const createdWithFee = await pricedFieldsFor({ tier: "GROWTH", monthlyFee: 9000 }, null);
  check("and wins on a new plan too", Object.keys(createdWithFee ?? {}).length === 0);

  const untouched = await pricedFieldsFor({ tier: "FOUNDATION", includedHours: 8 }, onStandard);
  check("editing a plan without moving its tier never reprices it", Object.keys(untouched ?? {}).length === 0);

  const hoursKept = await pricedFieldsFor({ tier: "GROWTH", includedHours: 20 }, onStandard);
  check("a tier change reprices but keeps hours somebody typed", hoursKept?.monthlyFee === 12500 && hoursKept?.includedHours === 20);

  // ---------------------------------------------------------------------
  console.log("\nA rate can move without the tier moving");
  const toFounding = await pricedFieldsFor({ rate: "FOUNDING" }, onStandard);
  check("asking for the founding rate applies it", toFounding?.monthlyFee === 3000);
  check("with the standard rate waiting behind it", toFounding?.standardMonthlyFee === 5000);
  check("and a date for the step-up", toFounding?.foundingRateUntil instanceof Date);

  const clockRunning = new Date("2026-12-01T00:00:00.000Z");
  const midDiscount = { tier: "FOUNDATION" as const, standardMonthlyFee: 5000, foundingRateUntil: clockRunning };

  const upgraded = await pricedFieldsFor({ tier: "GROWTH" }, midDiscount);
  check("a plan mid-discount stays on the founding rate when it moves tier", upgraded?.monthlyFee === 7000);
  check("with the new tier's standard rate behind it", upgraded?.standardMonthlyFee === 12500);
  check("and the three months are not restarted by the move", (upgraded?.foundingRateUntil as Date).getTime() === clockRunning.getTime());

  const offFounding = await pricedFieldsFor({ rate: "STANDARD" }, midDiscount);
  check("stepping off the founding rate by hand charges the standard one", offFounding?.monthlyFee === 5000);
  check("and leaves nothing to step up to", offFounding?.standardMonthlyFee === null && offFounding?.foundingRateUntil === null);

  // ---------------------------------------------------------------------
  console.log("\nAn unpriced tier is refused rather than guessed at");
  await storeOffer({
    ...SHIPPED_OFFER,
    syncedAt: new Date().toISOString(),
    plans: [{ tier: "Growth", monthly: null, discountedMonthly: null, discountNote: "", for: "Priced on scope." }],
  });
  // Only Growth is unpriced: the other two are not in the stored answer at all,
  // so they fall back to the shipped prices rather than to nothing.
  check("a tier the site publishes no price for returns null", (await pricedFieldsFor({ tier: "GROWTH" }, null)) === null);
  check("and a tier that still has one is unaffected", (await pricedFieldsFor({ tier: "FOUNDATION" }, null))?.monthlyFee === 5000);
  await resetOffer();

  console.log("\nThe Founding Partner rate ends by itself");
  await prisma.client.create({ data: { id: CLIENT_ID, name: "Care plan tier check", email: "tiers@check.local" } });

  const stepping = await prisma.carePlan.create({
    data: {
      clientId: CLIENT_ID,
      tier: "GROWTH",
      monthlyFee: 7000,
      standardMonthlyFee: 12500,
      // Already past, so the very next period billed is the first standard one.
      foundingRateUntil: periodOf(2026, 0),
      includedHours: 12,
      billingDay: 1,
      status: "ACTIVE",
      startedAt: periodOf(2025, 9),
    },
  });

  const stepped = await billPeriod(stepping.id, periodOf(2026, 1));
  check("the period bills", stepped.billed === true);
  check("at the standard rate, not the founding one", stepped.billed === true && stepped.amountTotal === 12500);

  const afterStep = await prisma.carePlan.findUnique({ where: { id: stepping.id } });
  check("the plan is moved onto the standard rate", Number(afterStep?.monthlyFee) === 12500);
  check("and the founding fields are cleared, so it cannot step up twice", afterStep?.standardMonthlyFee === null && afterStep?.foundingRateUntil === null);

  const steppedCycle = await prisma.carePlanCycle.findFirst({ where: { carePlanId: stepping.id } });
  check("the cycle records the fee that was actually charged", Number(steppedCycle?.monthlyFee) === 12500);

  const steppedLine = await prisma.invoiceLineItem.findFirst({ where: { invoice: { carePlanId: stepping.id } } });
  check("the invoice names the tier the website names", steppedLine?.description.startsWith(`${TIER_LABEL.GROWTH} monthly partnership`) === true);
  check("and does not claim a rate it did not charge", steppedLine?.description.includes("Founding Partner") === false);

  // Billing the same period again must be refused by the cycle's unique key —
  // if it were not, the step-up would already have happened and the second run
  // would look identical to the first while charging twice.
  const again = await billPeriod(stepping.id, periodOf(2026, 1));
  check("billing the same period again does nothing", again.billed === false && again.reason === "already-billed");
  check("and one invoice exists, not two", (await prisma.invoice.count({ where: { carePlanId: stepping.id } })) === 1);

  // ---------------------------------------------------------------------
  console.log("\nA plan still inside its founding period bills the founding rate");
  const inside = await prisma.carePlan.create({
    data: {
      clientId: CLIENT_ID,
      tier: "FOUNDATION",
      monthlyFee: 3000,
      standardMonthlyFee: 5000,
      foundingRateUntil: periodOf(2027, 6),
      includedHours: 6,
      billingDay: 1,
      status: "ACTIVE",
      startedAt: periodOf(2026, 0),
    },
  });

  const discounted = await billPeriod(inside.id, periodOf(2026, 1));
  check("it bills the discounted fee", discounted.billed === true && discounted.amountTotal === 3000);

  const insideAfter = await prisma.carePlan.findUnique({ where: { id: inside.id } });
  check("nothing steps up early", Number(insideAfter?.monthlyFee) === 3000 && insideAfter?.standardMonthlyFee !== null);

  const insideLine = await prisma.invoiceLineItem.findFirst({ where: { invoice: { carePlanId: inside.id } } });
  check(
    "and the invoice says which rate it is, so the rise is not a surprise",
    insideLine?.description.includes("(Founding Partner rate)") === true,
  );

  // ---------------------------------------------------------------------
  console.log("\nA plan with no founding rate is untouched by any of this");
  const plain = await prisma.carePlan.create({
    data: { clientId: CLIENT_ID, tier: "TRANSFORMATION", monthlyFee: 25000, includedHours: 25, billingDay: 1, status: "ACTIVE", startedAt: periodOf(2026, 0) },
  });
  const plainBill = await billPeriod(plain.id, periodOf(2026, 1));
  check("it bills its own fee", plainBill.billed === true && plainBill.amountTotal === 25000);
  const plainAfter = await prisma.carePlan.findUnique({ where: { id: plain.id } });
  check("and no step-up is invented for it", plainAfter?.standardMonthlyFee === null && plainAfter?.foundingRateUntil === null);

  await cleanUp();
  await resetOffer();
  await prisma.$disconnect();

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log(failures.map((name) => `  - ${name}`).join("\n"));
    process.exit(1);
  }
}

main().catch(async (err) => {
  console.error(err);
  await cleanUp().catch(() => {});
  await resetOffer().catch(() => {});
  await prisma.$disconnect();
  process.exit(1);
});
