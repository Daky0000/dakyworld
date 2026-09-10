/**
 * What a customer is offered, and what they are not. No database, no browser.
 *
 *   npx tsx checks/websiteClientWorkspace.ts
 *
 * The permission boundary is checked elsewhere and thoroughly — this is the
 * surface. A client who is *refused* Leads and *offered* it anyway has been told
 * they are a guest in somebody else's system, which is the thing the separate
 * workspace exists to stop.
 */
import assert from "node:assert/strict";
import { CLIENT_NAV, CLIENT_HOME, withinClientWorkspace } from "../client/src/lib/clientWorkspace.js";
import { websiteRequestAction } from "../src/services/websiteAccess.js";

let checks = 0;
function check(name: string, condition: unknown) { assert.ok(condition, name); checks++; }
function equal(name: string, actual: unknown, expected: unknown) { assert.deepEqual(actual, expected, name); checks++; }

check("a client is offered something", CLIENT_NAV.length > 0);
check("and nothing that leaves the website product", CLIENT_NAV.every((item) => withinClientWorkspace(item.to)));
check("the way in is inside it too", withinClientWorkspace(CLIENT_HOME));
check("no destination is the operations dashboard", !CLIENT_NAV.some((item) => item.to === "/"));

for (const internal of ["/leads", "/agents", "/costs", "/invoices", "/settings", "/team", "/approvals", "/clients"]) {
  check(`${internal} is not offered to a client`, !CLIENT_NAV.some((item) => item.to === internal));
}
check("the OS's own Team screen is not what the client's Team tab points at", CLIENT_NAV.find((item) => item.label === "Team")?.to === "/website/team");

// Every screen a client is offered has to be one the API will actually answer
// for them. A tab leading to a 403 is worse than no tab.
const routeFor: Record<string, string> = {
  "/website/sites": "/sites",
  "/website/assets": "/sites/one/assets",
  "/website/team": "/sites/one/members",
  "/website/audit": "/sites/one/audit",
};
for (const item of CLIENT_NAV) {
  const path = routeFor[item.to];
  check(`${item.label} maps to a known API route`, path !== undefined);
  if (path && path !== "/sites") {
    const action = websiteRequestAction("GET", path);
    check(`${item.label} reads as a view or members action, not a write`, action === "view" || action === "members");
  }
}

equal("the label a client reads for their pages is not 'Sites'", CLIENT_NAV[0]!.label, "Pages");

console.log(`websiteClientWorkspace: ${checks} checks — a client is offered their website and nothing else`);
