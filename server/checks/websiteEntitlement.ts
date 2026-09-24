/**
 * The rules that decide what a paying customer may do. No database.
 *
 *   npx tsx checks/websiteEntitlement.ts
 *
 * Every assertion here stands for a way the product used to give itself away:
 * a header that chose your plan, an email address that chose your plan, a
 * counter that forgot what you had used, a price that rose on our screens and
 * nowhere else. They are cheap to assert and were expensive to miss.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

let checks = 0;
function check(name: string, condition: unknown) {
  assert.ok(condition, name);
  checks += 1;
}
function equal(name: string, actual: unknown, expected: unknown) {
  assert.deepEqual(actual, expected, name);
  checks += 1;
}

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

/* ------------------------------------------- entitlement is not a header -- */

const entitlement = source("../src/services/websiteEntitlement.ts");

check(
  "the test-user header is read only where test switching is allowed",
  /TEST_SWITCHING_ALLOWED &&\s*typeof req\.headers\["x-dw-test-user"\]/.test(entitlement),
);
check(
  "test switching is off in production and off on a deployment",
  /export const TEST_SWITCHING_ALLOWED = !IS_PRODUCTION && !DEPLOYED/.test(entitlement),
);
check(
  "the deployment test covers the platforms this could run on",
  ["RAILWAY_ENVIRONMENT", "RENDER", "FLY_APP_NAME", "VERCEL", "KUBERNETES_SERVICE_HOST"].every((name) =>
    entitlement.includes(name),
  ),
);
check(
  "a tier is never guessed from the shape of an email address",
  !/includes\("dan"\)|includes\("owner"\)|endsWith\("@dakyworld/.test(entitlement),
);
check(
  "staff get the full product from a permission rather than an address",
  entitlement.includes('const STAFF_PERMISSION = "website.manage"'),
);
check(
  "an account with no subscription gets the lowest tier, not the highest",
  /const DEFAULT_TIER: WebsitePlanTier = "EDITOR"/.test(entitlement),
);
check(
  "a cancelled subscription keeps serving until the paid period ends",
  /row\.endsAt \|\| row\.endsAt\.getTime\(\) > now\.getTime\(\)/.test(entitlement),
);

/* -------------------------------------------- usage survives a restart --- */

check("usage is read from the database", /prisma\.websiteUsage\.findUnique/.test(entitlement));
check("usage is incremented atomically", /increment: by/.test(entitlement));
check(
  "the usage period is UTC, so a customer's month does not depend on the server's timezone",
  /now\.toISOString\(\)\.slice\(0, 7\)/.test(entitlement),
);

const tiers = source("../src/services/websiteTierPlans.ts");
check(
  "no counter is kept in a module-level Map any more",
  !/const runtimeSubscriptions = new Map/.test(tiers),
);
check(
  "the local switch route refuses to run where anything is deployed",
  /if \(!TEST_SWITCHING_ALLOWED\) \{[\s\S]{0,200}throw new WebsiteError\(\s*403/.test(tiers),
);
check(
  "the seeded test accounts are never created on a deployment",
  /if \(IS_PRODUCTION \|\| DEPLOYED_ENVIRONMENT\) \{\s*return \{ users: \[\] \};/.test(tiers),
);

/* --------------------------------------- the price rises at the processor - */

check(
  "the reversion moves the subscription onto a new plan at Paystack",
  /moveSubscriptionToPlan\(\{/.test(tiers),
);
check(
  "a reversion that could not reach the processor is not recorded as done",
  /continue;[\s\S]{0,80}\}\s*\}\s*\n\s*await prisma\.websitePurchase\.update/.test(tiers) ||
    tiers.includes("// Leave `standardPriceAppliedAt` unset so the next tick tries again,"),
);
check(
  "the price a customer was sold at wins over today's price list",
  /purchase\.standardMonthlyPrice \?\? price\.standardMonthlyPrice/.test(tiers),
);

const paystack = source("../src/lib/paystack.ts");
check(
  "moving a plan disables the old subscription before creating the new one",
  paystack.indexOf("/subscription/disable") < paystack.indexOf("const planCode = await createSubscriptionPlan"),
);

/* ------------------------------------------------ buying, without a human - */

const commerce = source("../src/services/websiteCommerce.ts");
check("a purchase creates the buyer's account", /ensureCustomerAccount\(\{/.test(commerce));
check("the purchase row is linked to that account", /userId: account\.user\.id/.test(commerce));
check("the set-password link is sent after the payment is raised", commerce.indexOf("raisePayment") < commerce.indexOf("sendSetPasswordLink"));
check("a subscription can be cancelled", /export async function cancelWebsiteSubscription/.test(commerce));

const payments = source("../src/services/payments.ts");
check(
  "recurring billing starts on payment rather than waiting for somebody to press a button",
  /updatePurchaseStatus\(purchase\.id, "ACTIVE"\)/.test(payments),
);

const accounts = source("../src/services/accountAccess.ts");
check("only the hash of a link's token is stored", /tokenHash: hashToken\(token\)/.test(accounts));
check("a token is claimed before it is acted on", /where: \{ id: row\.id, usedAt: null \}/.test(accounts));
check(
  "a reset never says whether the address is known",
  /if \(!user \|\| !user\.active\) return;/.test(accounts),
);
check("setting a password ends every other session", /prisma\.session\.deleteMany/.test(accounts));

/* ---------------------------------------------------------- the hosting -- */

const hosting = source("../src/services/websiteHosting.ts");
check(
  "a custom domain is served only once it has been verified",
  /customDomainVerifiedAt: \{ not: null \}/.test(hosting),
);
check("ownership is proved by a TXT record", /dns\.resolveTxt/.test(hosting));
check(
  "an unpublished hosted address says so rather than 404ing",
  hosting.includes("NOT_PUBLISHED_HTML"),
);

const index = source("../src/index.ts");
check(
  "hosted customer sites are served before this app's own security headers",
  index.indexOf("publicSiteHosting()") < index.indexOf("app.use(securityHeaders)"),
);

const website = source("../src/routes/website.ts");
check("publishing writes the copy the hosting serves", /publishedHtml: plan\.html/.test(website));
check("imports are rate limited", /websiteImportLimit/.test(website));

/* ------------------------------------------------------ leaving cleanly --- */

const selfService = source("../src/services/websiteSubscriberSelfService.ts");
check("a customer can export their site", /"\/sites\/:id\/export"/.test(selfService));
check("a customer can delete their site", /"\/sites\/:id\/erase"/.test(selfService));
check(
  "deleting refuses while the subscription is still being paid for",
  /Cancel the subscription first/.test(selfService),
);

const dunning = source("../src/services/websiteDunning.ts");
equal("editing pauses after three declined payments", /DUNNING_ATTEMPTS_BEFORE_LOCK = (\d)/.exec(dunning)?.[1], "3");
check(
  "a declined payment never takes the published website down",
  /Your website stays online exactly as it is/.test(dunning),
);

/* --------------------------------------------- connecting, either way ---- */

const connect = source("../client/src/components/ConnectWebsite.tsx");
check("the connect dialog offers both routes before asking for anything", /setRoute\("hosted"\)/.test(connect) && /setRoute\("github"\)/.test(connect));
check("each route links to its own half of the guide", /#hosted/.test(connect) && /#github/.test(connect));
check("a repository is only asked for on the repository route", /route === "github" && repository\.trim\(\)/.test(connect));

const setup = source("../src/services/websiteSetupAssistance.ts");
check("setup help is charged in the customer's own currency", /SETUP_ASSISTANCE\[currency\]/.test(setup));
check(
  "a request stands even when no payment link could be raised",
  /could not raise a payment link/.test(setup),
);
check("the request says which route the customer was on", /ROUTE_LABEL\[input\.route\]/.test(setup));

const pricing = source("../src/services/websitePricing.ts");
check("setup help is GHS 120 in Ghana", /GHS: \{ amount: 120/.test(pricing));
check("setup help is $10 elsewhere", /USD: \{ amount: 10/.test(pricing));

const guide = readFileSync(new URL("../../website-builder-setup.html", import.meta.url), "utf8");
check("the guide has a section for the hosted route", /id="hosted"/.test(guide));
check("the guide has a section for the repository route", /id="github"/.test(guide));
check("the guide prices the setup help the same as the code does", /GHS 120/.test(guide) && /\$10/.test(guide));

/* ------------------------------------------------------- the boundary ----- */

const boundary = source("../client/src/components/ErrorBoundary.tsx");
check("a render crash shows a message with a reference", /reference/.test(boundary));
const main = source("../client/src/main.tsx");
check("the boundary wraps the whole app", /<ErrorBoundary label="app">/.test(main));

console.log(
  `websiteEntitlement: ${checks} checks — entitlement from the subscription rather than a header, usage that survives a restart, a price that rises at the processor, buying and leaving without a human, and hosting that serves a site with no repository`,
);
