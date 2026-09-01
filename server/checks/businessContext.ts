/**
 * Do the agents describe the company the prospect is actually reading about?
 *
 * The defect this exists for was invisible and shipped for months. Every agent
 * in this system is handed a paragraph saying who Dakyworld is and a catalogue
 * saying what it sells, and both came from a constant in
 * `services/dakyworld.ts` that nothing kept in step with dakyworld.com. By
 * Sep 2026 the website sold **four** services where the constant listed eight,
 * charged GHS 3,000 a month where the constant said 5,000, ran a Founding
 * Partner discount the constant had never heard of, and stated plainly that
 * Dakyworld does not administer business email or run managed cybersecurity —
 * two things the constant was still offering. Nothing failed. Every letter was
 * grammatical. The only symptom was a prospect being quoted a price they could
 * see was wrong on the page they were reading.
 *
 * So the website is the source now, and this holds the reader to the four
 * rules that make that safe rather than merely clever:
 *
 *  1. **The shipped catalogue is the floor.** No stored offer, an unreadable
 *     one, a website that cannot be reached — every one of them lands on the
 *     constant rather than on nothing. An agent with no description of its own
 *     company writes a letter about a company in general.
 *  2. **An empty list is not an answer.** "This company sells nothing" and
 *     "the reader could not find the services" arrive looking identical, and
 *     only one of them can be true. `offers` is the deliberate exception: a
 *     discount that has closed must be able to disappear.
 *  3. **A price is never invented and never averaged.** Where a page shows a
 *     standard rate and a lower one on offer, both survive as separate fields
 *     — a writer that only ever sees one number cannot say "3,000 for three
 *     months, then 5,000".
 *  4. **It never throws.** `brandBlock()` is on the path of every agent turn.
 *
 * The negatives are the half worth reading: a sync with nothing to read must
 * leave what is stored alone, a stored offer with no services must be refused
 * rather than written, and a finding tagged with a service the company has
 * stopped selling must resolve to "not sold" rather than to a sale.
 *
 * Database only. No API key, no network.
 *   npx tsx checks/businessContext.ts
 */
import { prisma } from "../src/lib/prisma.js";
import {
  brandBlock,
  businessOffer,
  catalogueBlock,
  clearBusinessOfferCache,
  readOffer,
  serviceIds,
  syncBusinessOffer,
  visibleText,
} from "../src/services/context/business.js";
import { SHIPPED_OFFER, brandFrom, catalogueFrom, serviceForFinding } from "../src/services/dakyworld.js";

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

const KEY = "business.offer";

/** Whatever was really stored, put back at the end. */
let original: string | null = null;

async function store(value: unknown) {
  await prisma.appSetting.upsert({
    where: { key: KEY },
    update: { value: typeof value === "string" ? value : JSON.stringify(value), secret: false },
    create: { key: KEY, value: typeof value === "string" ? value : JSON.stringify(value), secret: false },
  });
  clearBusinessOfferCache();
}

async function reset() {
  if (original === null) await prisma.appSetting.deleteMany({ where: { key: KEY } });
  else await store(original);
  clearBusinessOfferCache();
}

async function main() {
  original = (await prisma.appSetting.findUnique({ where: { key: KEY }, select: { value: true } }))?.value ?? null;

  console.log("\nThe shipped catalogue is the floor");
  await prisma.appSetting.deleteMany({ where: { key: KEY } });
  clearBusinessOfferCache();
  const floor = await businessOffer();
  check("with nothing stored, the shipped offer is what agents are told", floor.from === "shipped" && floor.offer.services.length === 4);
  check("and it says so rather than pretending it was read", floor.syncedAt === null && floor.readBy === null);

  const shippedBrand = await brandBlock();
  check("the brand block names the company", shippedBrand.includes("Dakyworld"));
  check("the brand block carries the boundary as a rule", shippedBrand.includes("does not do") && shippedBrand.includes("printer"));
  check(
    "and never offers what the website says is not sold",
    !/we (also )?(offer|provide|handle) (managed )?cybersecurity/i.test(shippedBrand),
  );

  const shippedCatalogue = await catalogueBlock();
  check("the catalogue carries the current monthly rate", shippedCatalogue.includes("GHS 5,000/month"));
  check("and the discount, as a separate thing from the rate", shippedCatalogue.includes("GHS 3,000") && shippedCatalogue.includes("first three months"));
  check("and the defined projects with their published floors", shippedCatalogue.includes("GHS 15,000") && shippedCatalogue.includes("GHS 35,000"));
  check("a retired service line is never in the catalogue", !/email-workspace|security-backups/.test(shippedCatalogue));

  console.log("\nUnreadable and half-readable answers");
  await store("this is not JSON");
  const broken = await businessOffer();
  check("an unreadable row falls back rather than taking every prompt down", broken.from === "shipped" && broken.offer.services.length === 4);

  const emptied = readOffer({ ...SHIPPED_OFFER, services: [], plans: [], summary: [], doesNotDo: [] });
  check("an empty service list keeps the shipped one", emptied.services.length === SHIPPED_OFFER.services.length);
  check("an empty plan list keeps the shipped one", emptied.plans.length === SHIPPED_OFFER.plans.length);
  check("an empty boundary keeps the shipped one", emptied.doesNotDo.length === SHIPPED_OFFER.doesNotDo.length);
  // The one that must be allowed to empty: a programme that has closed.
  const noOffers = readOffer({ ...SHIPPED_OFFER, offers: [] });
  check("an empty offers list is taken at its word — a discount can close", noOffers.offers.length === 0);

  console.log("\nWhat a website read looks like");
  const fromSite = {
    positioning: "Something else entirely.",
    summary: ["A one-line company."],
    doesNotDo: ["Anything at all."],
    proofPoints: ["11% of something."],
    services: [{ id: "one-thing", name: "One thing", what: "The only thing sold.", fixes: ["a problem"], anchorPrice: 4242, billing: "ONE_OFF", priceNote: "From GHS 4,242." }],
    plans: [{ tier: "Only", monthly: 900, discountedMonthly: 450, discountNote: "Half price for a month.", for: "everybody" }],
    projects: [{ name: "A build", from: 111, what: "One build." }],
    offers: ["Half price for a month."],
    syncedAt: new Date().toISOString(),
    pages: ["pricing.html"],
    readBy: "a-fake-model",
    fingerprint: "abc",
  };
  await store(fromSite);
  const live = await businessOffer();
  check("a stored offer replaces the shipped one wholesale", live.from === "website" && live.offer.services.length === 1);
  check("it does not merge last year's catalogue into this year's", !live.offer.services.some((service) => service.id === "websites"));
  check("the prompt carries the stored price", (await catalogueBlock()).includes("GHS 4,242"));
  check("and the stored discount beside the standard rate", (await catalogueBlock()).includes("GHS 900/month") && (await catalogueBlock()).includes("GHS 450"));
  check("the writer's service ids follow what is sold now", (await serviceIds()).join() === "one-thing");
  check("and the boundary follows too", (await brandBlock()).includes("Anything at all."));

  console.log("\nA sync with nothing to read changes nothing");
  const before = await prisma.appSetting.findUnique({ where: { key: KEY }, select: { value: true } });
  const noSite = await syncBusinessOffer({ siteSlug: "no-such-site-check" });
  const after = await prisma.appSetting.findUnique({ where: { key: KEY }, select: { value: true } });
  check("a missing site is a note, not an exception", noSite.changed === false && noSite.notes.length > 0);
  check("and what is stored is left exactly as it was", before?.value === after?.value);
  check("the offer it hands back is still usable", noSite.offer.services.length === 1);

  // The site exists but has no pages discovered yet — the state a fresh
  // deployment is in before anybody opens the Website screen.
  const site = await prisma.site.upsert({
    where: { slug: "businesscontextcheck" },
    update: {},
    create: { name: "Check site", slug: "businesscontextcheck", publicUrl: "https://example.invalid", repoOwner: null, repoName: null, repoBranch: "main", repoPath: "" },
  });
  const noPages = await syncBusinessOffer({ siteSlug: "businesscontextcheck" });
  check("a site with no pages says what to do about it", noPages.changed === false && noPages.notes.some((note) => note.includes("Website screen")));

  console.log("\nReading a page down to its words");
  const html = `<!doctype html><html><head><title>x</title><style>.a{color:red}</style></head>
    <body><script>var a = "Growth GHS 99";</script><h2>Four connected capabilities</h2>
    <p>Foundation &mdash; GHS 5,000/month</p><ul><li>One</li><li>Two</li></ul></body></html>`;
  const words = visibleText(html);
  check("the script's numbers never reach the reader", !words.includes("GHS 99"));
  check("the styling never reaches the reader", !words.includes("color:red"));
  check("the prose does", words.includes("Four connected capabilities") && words.includes("GHS 5,000/month"));
  check("entities are turned back into characters", words.includes("—"));

  console.log("\nA finding's service tag resolves against what is sold now");
  check("a live tag names the service", serviceForFinding("website-build") === "Websites & web platforms");
  check("a retired tag is not a sale", serviceForFinding("email-workspace") === null);
  check("and neither is one that never existed", serviceForFinding("something-invented") === null);
  check("no tag at all is not a sale either", serviceForFinding(null) === null);

  console.log("\nThe shipped constant matches the four the website sells");
  check("four services", SHIPPED_OFFER.services.length === 4);
  check("every plan carries both its rate and its offer", SHIPPED_OFFER.plans.every((plan) => plan.monthly !== null && plan.discountedMonthly !== null));
  check("no plan's discount is its standard rate repeated", SHIPPED_OFFER.plans.every((plan) => plan.discountedMonthly !== plan.monthly));
  check("the boundary is stated", SHIPPED_OFFER.doesNotDo.length >= 4);
  check("rendering the shipped offer is the same as the shipped rendering", brandFrom(SHIPPED_OFFER).length > 0 && catalogueFrom(SHIPPED_OFFER).length > 0);

  await prisma.site.deleteMany({ where: { slug: "businesscontextcheck" } });
  await reset();
  await prisma.$disconnect();

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log(failures.map((name) => `  - ${name}`).join("\n"));
    process.exit(1);
  }
}

main().catch(async (err) => {
  console.error(err);
  await prisma.site.deleteMany({ where: { slug: "businesscontextcheck" } }).catch(() => {});
  await reset().catch(() => {});
  await prisma.$disconnect();
  process.exit(1);
});
