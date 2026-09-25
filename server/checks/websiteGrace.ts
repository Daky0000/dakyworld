/**
 * What a subscription that is ending, or behind on payment, still entitles.
 * No database.
 *
 *   npx tsx checks/websiteGrace.ts
 *
 * Every assertion here stands for a way a paying customer lost something they
 * had paid for, and the reason there is a check at all is that the last one was
 * a regex. `checks/websiteEntitlement.ts` asserted that the string
 * `row.endsAt || row.endsAt.getTime() > now.getTime()` appeared in the source —
 * and it did, in a function the database never reached, because the query above
 * it filtered the row out by `status` first. The test passed for the whole time
 * the feature was dead.
 *
 * So: the decision is a pure function and this exercises it with dates.
 */
import assert from "node:assert/strict";
import { stillEntitled, type EntitlingRow } from "../src/services/websiteEntitlement.js";

let checks = 0;
function check(name: string, condition: unknown) {
  assert.ok(condition, name);
  checks += 1;
}

const NOW = new Date("2026-09-25T12:00:00Z");
const inDays = (days: number) => new Date(NOW.getTime() + days * 86_400_000);

const row = (billingState: string, nextBillingAt: Date | null): EntitlingRow => ({ billingState, nextBillingAt });

/* --------------------------------------------------- a healthy subscription -- */

check("an active subscription is entitled", stillEntitled(row("ACTIVE", inDays(12)), NOW));
check(
  "a subscription that has paid but not started recurring billing is entitled",
  stillEntitled(row("NONE", null), NOW),
);
check(
  "a subscription still being created at the processor is entitled",
  stillEntitled(row("CREATING", null), NOW),
);
check(
  "a subscription whose provider state is uncertain is entitled — our doubt is not their problem",
  stillEntitled(row("UNCERTAIN", null), NOW),
);

/* ------------------------------------------------------------- cancellation -- */

check(
  "a cancelled subscription keeps its tier until the date it is paid up to",
  stillEntitled(row("CANCELLED", inDays(9)), NOW),
);
check(
  "...and stops once that date has passed",
  !stillEntitled(row("CANCELLED", inDays(-1)), NOW),
);
check(
  "a cancelled subscription with no paid-up date left is not entitled forever",
  !stillEntitled(row("CANCELLED", null), NOW),
);
check(
  "a subscription set not to renew is treated the same as a cancelled one",
  stillEntitled(row("NON_RENEWING", inDays(3)), NOW),
);
check(
  "...including when its date has passed",
  !stillEntitled(row("NON_RENEWING", inDays(-3)), NOW),
);
check(
  "a cancellation still in flight keeps serving a period already paid for",
  stillEntitled(row("CANCELLING", inDays(5)), NOW),
);
check(
  "a cancellation the processor would not confirm does not serve a period that has run out",
  !stillEntitled(row("CANCEL_UNCERTAIN", inDays(-5)), NOW),
);

/* ---------------------------------------------------------------- past due -- */

// The important one, and the least obvious. A declined card must not quietly
// demote somebody to the lowest tier: they keep the plan, and what they lose is
// the ability to edit — which `editingLockedForNonPayment` decides, and which
// needs this row to be found at all. Downgrading here instead would hand a
// Business customer the Starter product with no explanation.
check(
  "a past-due subscription keeps its tier so it can be told why editing stopped",
  stillEntitled(row("PAST_DUE", inDays(-30)), NOW),
);
check(
  "...however long it has been past due",
  stillEntitled(row("PAST_DUE", inDays(-400)), NOW),
);

/* -------------------------------------------------------- the exact boundary -- */

check(
  "a paid-up date one second away still serves",
  stillEntitled(row("CANCELLED", new Date(NOW.getTime() + 1000)), NOW),
);
check(
  "a paid-up date exactly now does not",
  !stillEntitled(row("CANCELLED", new Date(NOW.getTime())), NOW),
);

/* ------------------------ the query has to be able to see the row at all -- */

// The decision above is unreachable if the database filters the row out first,
// which is precisely what happened. `status` is written to CANCELLED and
// FAILED by the billing machine, so selecting on a list of healthy statuses
// hid every subscription this file exists to judge. The gate is now "money has
// been taken at least once".
import { readFileSync } from "node:fs";
const entitlement = readFileSync(new URL("../src/services/websiteEntitlement.ts", import.meta.url), "utf8");
check(
  "the subscription query does not filter on a list of healthy statuses",
  !/status:\s*\{\s*in:\s*\[/.test(entitlement),
);
check(
  "it selects rows that have actually been paid for instead",
  /setupPaidAt:\s*\{\s*not:\s*null\s*\}/.test(entitlement),
);

const commerce = readFileSync(new URL("../src/services/websiteCommerce.ts", import.meta.url), "utf8");
check(
  "cancelling does not clear the date the customer is paid up to",
  !/billingState:\s*"CANCELLED",\s*nextBillingAt:\s*null/.test(commerce),
);

console.log(`websiteGrace: ${checks} checks passed`);
