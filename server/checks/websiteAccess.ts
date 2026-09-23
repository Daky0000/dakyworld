/**
 * npx tsx checks/websiteAccess.ts                 (no database: policy + real HTTP gate)
 * npx tsx checks/websiteAccess.ts --database      (isolated local DB: sessions + membership API)
 * Database mode refuses remote and non-test databases and removes only this run's IDs.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import express, { type Request } from "express";
import {
  assertWebsiteMemberChange, createWebsiteAccessGate, registerWebsiteMembership,
  SITE_MEMBER_ROLES, websiteCapabilities, websiteSiteFilter, websiteRequestAction,
  type WebsitePrincipal, type WebsiteMemberRole,
} from "../src/services/websiteAccess.js";
import { WebsiteError } from "../src/services/website/site.js";

let passed = 0;
function check(name: string, test: () => void) { test(); passed++; console.log(`  ok  ${name}`); }
const principal = (extra: Partial<WebsitePrincipal> = {}): WebsitePrincipal => ({ id: "customer", active: true, external: true, superAdmin: false, permissions: new Set(), deniedPermissions: [], ...extra });
const allGlobal = new Set(["website.view", "website.edit", "website.publish", "website.manage"]);
const expected: Record<WebsiteMemberRole, string[]> = {
  VIEWER: ["view"], EDITOR: ["view", "edit"], REVIEWER: ["view", "review"],
  PUBLISHER: ["view", "review", "publish"], MANAGER: ["view", "edit", "review", "publish", "manage", "members", "source"],
  DEVELOPER: ["view", "edit", "review", "publish", "manage", "source"],
};
for (const role of SITE_MEMBER_ROLES) check(`${role} grants exactly its site capabilities`, () => assert.deepEqual(Object.entries(websiteCapabilities(principal(), role)).filter(([, value]) => value).map(([key]) => key), expected[role]));
check("external accounts ignore every global permission, including superAdmin", () => assert.equal(Object.values(websiteCapabilities(principal({ permissions: allGlobal, superAdmin: true }), null)).some(Boolean), false));
check("external membership does not inherit global publish", () => assert.equal(websiteCapabilities(principal({ permissions: allGlobal }), "EDITOR").publish, false));
check("inactive memberships grant nothing", () => assert.equal(Object.values(websiteCapabilities(principal({ active: false }), "MANAGER")).some(Boolean), false));
check("internal explicit deny defeats site role", () => assert.equal(websiteCapabilities(principal({ external: false, deniedPermissions: ["website.publish"] }), "MANAGER").publish, false));
check("internal view denial removes all site capabilities", () => assert.equal(Object.values(websiteCapabilities(principal({ external: false, deniedPermissions: ["website.view"] }), "MANAGER")).some(Boolean), false));
check("existing staff retain exactly their global rights", () => assert.equal(websiteCapabilities(principal({ external: false, permissions: new Set(["website.view", "website.edit"]) }), null).publish, false));
check("the last active manager cannot be removed", () => assert.throws(() => assertWebsiteMemberChange({ capabilities: websiteCapabilities(principal(), "MANAGER"), previousRole: "MANAGER", nextRole: null, targetActive: true, activeManagerCount: 1 }), /another active manager/));
check("the last active manager cannot be demoted", () => assert.throws(() => assertWebsiteMemberChange({ capabilities: websiteCapabilities(principal(), "MANAGER"), previousRole: "MANAGER", nextRole: "VIEWER", targetActive: true, activeManagerCount: 1 }), /another active manager/));
check("a manager can hand over when a second active manager exists", () => assert.doesNotThrow(() => assertWebsiteMemberChange({ capabilities: websiteCapabilities(principal(), "MANAGER"), previousRole: "MANAGER", nextRole: "EDITOR", targetActive: true, activeManagerCount: 2 })));
check("developers cannot change members", () => assert.throws(() => assertWebsiteMemberChange({ capabilities: websiteCapabilities(principal(), "DEVELOPER"), previousRole: null, nextRole: "VIEWER", targetActive: true, activeManagerCount: 2 }), /Only a website manager/));
check("global management without publish cannot grant manager", () => assert.throws(() => assertWebsiteMemberChange({ capabilities: websiteCapabilities(principal({ external: false, permissions: new Set(["website.view", "website.manage"]) }), null), previousRole: null, nextRole: "MANAGER", targetActive: true, activeManagerCount: 0 }), /beyond your own/));
check("unknown writes fail closed", () => assert.equal(websiteRequestAction("POST", "/pages/one/new-dangerous-operation"), null));
check("version rollback requires publish", () => assert.equal(websiteRequestAction("POST", "/pages/one/versions/two/publish"), "publish"));
check("version restoration requires edit", () => assert.equal(websiteRequestAction("POST", "/pages/one/versions/two/restore"), "edit"));
check("AI assistance requires edit", () => assert.equal(websiteRequestAction("POST", "/pages/one/assistant"), "edit"));
check("builder agent planning requires edit", () => assert.equal(websiteRequestAction("POST", "/sites/one/agent/plan"), "edit"));
check("builder agent apply requires edit", () => assert.equal(websiteRequestAction("POST", "/sites/one/agent/apply"), "edit"));
check("design settings are visible without repository settings access", () => assert.equal(websiteRequestAction("GET", "/sites/one/design"), "view"));

async function httpGateChecks() {
  const roles = new Map<string, WebsiteMemberRole>(SITE_MEMBER_ROLES.map(role => [role, role]));
  const app = express();
  let acceptedWrites = 0;
  app.use((req, _res, next) => {
    const id = req.headers["x-test-user"];
    if (typeof id === "string") {
      req.dbUser = { id, active: id !== "inactive", deniedPermissions: [], accessRole: { external: id !== "staff", superAdmin: false } } as unknown as Request["dbUser"];
      req.permissions = id === "staff" || id === "stranger" ? allGlobal : new Set();
    }
    next();
  });
  app.use(createWebsiteAccessGate({ memberRole: async (siteId, userId) => siteId === "own" ? roles.get(userId) ?? null : null, pageSite: async pageId => pageId === "ownpage" ? "own" : pageId === "foreignpage" ? "foreign" : null, hasMembership: async userId => roles.has(userId) }));
  app.all("*", (req, res) => { if (req.method !== "GET") acceptedWrites++; res.json({ filter: websiteSiteFilter(req) }); });
  app.use((error: unknown, _req: Request, res: express.Response, _next: express.NextFunction) => { res.status(error instanceof WebsiteError ? error.status : 500).json({ error: (error as Error).message }); });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (user: string | null, path: string, method = "GET") => fetch(`${base}${path}`, { method, headers: user ? { "x-test-user": user } : {} });
  const status = async (name: string, user: string | null, path: string, method: string, expectedStatus: number) => { const response = await request(user, path, method); await response.text(); check(name, () => assert.equal(response.status, expectedStatus)); };
  try {
    await status("unauthenticated editor access is refused", null, "/sites/own/pages", "GET", 401);
    await status("inactive account is refused", "inactive", "/sites/own/pages", "GET", 401);
    await status("member can open own site", "VIEWER", "/sites/own/pages", "GET", 200);
    await status("member cannot open another site", "MANAGER", "/sites/foreign/pages", "GET", 404);
    await status("page ID cannot cross site boundary", "MANAGER", "/pages/foreignpage", "GET", 404);
    await status("global permissions do not open customer access", "stranger", "/pages/ownpage", "GET", 404);
    await status("viewer cannot save a draft", "VIEWER", "/pages/ownpage/draft", "PUT", 403);
    await status("viewer cannot delete a draft", "VIEWER", "/pages/ownpage/draft", "DELETE", 403);
    await status("editor cannot publish", "EDITOR", "/pages/ownpage/publish", "POST", 403);
    await status("publisher cannot edit", "PUBLISHER", "/pages/ownpage/draft", "PUT", 403);
    await status("reviewer cannot publish a rollback", "REVIEWER", "/pages/ownpage/versions/v1/publish", "POST", 403);
    await status("editor cannot read repository configuration", "EDITOR", "/sites/own/config", "GET", 403);
    await status("viewer cannot upload assets", "VIEWER", "/sites/own/assets", "POST", 403);
    await status("viewer cannot ask paid AI to edit", "VIEWER", "/pages/ownpage/assistant", "POST", 403);
    await status("viewer cannot list member emails", "VIEWER", "/sites/own/members", "GET", 403);
    await status("developer cannot add members", "DEVELOPER", "/sites/own/members", "POST", 403);
    await status("manager cannot mutate members in another site", "MANAGER", "/sites/foreign/members/someone", "DELETE", 404);
    await status("customer manager cannot connect a global site", "MANAGER", "/sites", "POST", 403);
    await status("unknown operations fail closed", "MANAGER", "/pages/ownpage/escalate", "POST", 403);
    check("refused operations reach no mutation handler", () => assert.equal(acceptedWrites, 0));
    await status("editor can save a draft", "EDITOR", "/pages/ownpage/draft", "PUT", 200);
    await status("editor can request assistance", "EDITOR", "/pages/ownpage/assistant", "POST", 200);
    await status("viewer can read design settings", "VIEWER", "/sites/own/design", "GET", 200);
    await status("publisher can publish a reviewed draft", "PUBLISHER", "/pages/ownpage/publish", "POST", 200);
    await status("manager can change members", "MANAGER", "/sites/own/members", "POST", 200);
    await status("developer can read source project", "DEVELOPER", "/sites/own/source", "GET", 200);
    await status("staff manager can connect a site", "staff", "/sites", "POST", 200);
    const body = await (await request("VIEWER", "/sites")).json() as { filter: unknown };
    check("customer collection queries always carry membership filtering", () => assert.deepEqual(body.filter, { members: { some: { userId: "VIEWER" } } }));
    roles.delete("VIEWER");
    await status("membership revocation takes effect on the next request", "VIEWER", "/pages/ownpage", "GET", 404);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

async function databaseChecks() {
  const url = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/invalid");
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !/(test|check|editor)/i.test(url.pathname)) throw new Error("Database checks require an isolated local test/editor database.");
  process.env.DEV_NO_AUTH = "false";
  const { prisma } = await import("../src/lib/prisma.js");
  const { attachUser, requireAuth, scopeExternal, DEV_NO_AUTH } = await import("../src/middleware/auth.js");
  const { createSession } = await import("../src/lib/session.js");
  const { websiteRouter } = await import("../src/routes/website.js");
  const { authRouter } = await import("../src/routes/auth.js");
  assert.equal(DEV_NO_AUTH, false, "Database permission checks must authenticate actual sessions");
  const mark = `membershipcheck-${randomUUID()}`;
  const siteIds: string[] = [], userIds: string[] = [], roleIds: string[] = [];
  let server: ReturnType<typeof express.application.listen> | undefined;
  try {
    const external = await prisma.accessRole.create({ data: { key: mark, name: mark, external: true, permissions: [...allGlobal] } }); roleIds.push(external.id);
    const people = await Promise.all(["manager", "second", "viewer", "editor", "publisher", "stranger", "newcomer"].map(async name => { const user = await prisma.user.create({ data: { email: `${mark}-${name}@example.test`, name, accessRoleId: external.id } }); userIds.push(user.id); return { ...user, token: await createSession(user.id) }; }));
    const [manager, second, viewer, editor, publisher, stranger, newcomer] = people;
    const [own, foreign] = await Promise.all(["own", "foreign"].map(async name => { const site = await prisma.site.create({ data: { slug: `${mark}-${name}`, name, publicUrl: "https://example.test" } }); siteIds.push(site.id); return site; }));
    for (const [person, role] of [[manager, "MANAGER"], [second, "MANAGER"], [viewer, "VIEWER"], [editor, "EDITOR"], [publisher, "PUBLISHER"]] as const) await prisma.siteMember.create({ data: { siteId: own.id, userId: person.id, role } });
    const foreignMember = await prisma.siteMember.create({ data: { siteId: foreign.id, userId: stranger.id, role: "MANAGER" } });
    const [ownPage, foreignPage] = await Promise.all([own, foreign].map(site => prisma.sitePage.create({ data: { siteId: site.id, title: site.name, path: "/", filePath: "index.html", sourceHtml: `<h1>${site.name}</h1>` } })));
    await prisma.sitePageVersion.createMany({ data: [ownPage, foreignPage].map(page => ({ pageId: page.id, number: 1, html: `<h1>${page.title}</h1>` })) });
    const app = express(); app.use(express.json()); app.use("/api", attachUser, requireAuth, scopeExternal);
    app.use("/api/website", websiteRouter); app.use("/api/auth", authRouter); app.get("/api/leads", (_req, res) => { res.json([]); });
    app.use((error: unknown, _req: Request, res: express.Response, _next: express.NextFunction) => { res.status(error instanceof WebsiteError ? error.status : 500).json({ error: (error as Error).message }); });
    server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server!.once("listening", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const request = (person: typeof manager, path: string, method = "GET", body?: unknown) => fetch(`${base}/api${path}`, { method, headers: { Cookie: `dw_session=${person.token}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    let response = await request(manager, "/leads"); check("real external session still cannot enter the internal OS", () => assert.equal(response.status, 403)); await response.text();
    response = await request(viewer, "/auth/me"); const me = await response.json() as { external: boolean }; check("auth identifies an external account for client navigation", () => assert.equal(me.external, true));
    response = await request(viewer, "/website/sites"); const list = await response.json() as Array<{ id: string; capabilities: { view: boolean; edit: boolean } }>; check("real session lists only its own site", () => assert.deepEqual(list.map(site => site.id), [own.id]));
    check("site list carries per-site viewer capabilities", () => { assert.equal(list[0].capabilities.view, true); assert.equal(list[0].capabilities.edit, false); });
    response = await request(viewer, "/website/overview"); const overview = await response.json() as { counts: { sites: number; pages: number }; recent: Array<{ page: { id: string } }> }; check("overview aggregates and activity cannot reveal foreign sites", () => { assert.equal(overview.counts.sites, 1); assert.equal(overview.counts.pages, 1); assert.deepEqual(overview.recent.map(item => item.page.id), [ownPage.id]); });
    response = await request(viewer, `/website/sites/${own.id}/pages`); const pages = await response.json() as { pages: Array<{ id: string }> }; check("real website page list resolves membership", () => assert.deepEqual(pages.pages.map(page => page.id), [ownPage.id]));
    response = await request(viewer, `/website/pages/${foreignPage.id}`); check("actual editor page endpoint refuses another website", () => assert.equal(response.status, 404)); await response.text();
    response = await request(viewer, `/website/pages/${ownPage.id}/draft`, "PUT", { values: {}, ifRevision: 0 }); check("actual draft endpoint refuses viewer writes", () => assert.equal(response.status, 403)); await response.text();
    response = await request(manager, `/website/sites/${foreign.id}/pages`); check("real session cannot read a foreign site", () => assert.equal(response.status, 404)); await response.text();
    response = await request(viewer, `/website/sites/${own.id}/members`, "POST", { userId: newcomer.id, role: "MANAGER" }); check("viewer cannot add a manager through HTTP", () => assert.equal(response.status, 403)); await response.text();
    check("refused manager grant leaves no row", () => assert.equal(false, false));
    assert.equal(await prisma.siteMember.count({ where: { siteId: own.id, userId: newcomer.id } }), 0);
    response = await request(manager, `/website/sites/${own.id}`, "PATCH", { repoOwner: "another-tenant", repoName: "private" }); check("site manager cannot repoint shared GitHub credentials", () => assert.equal(response.status, 403)); await response.text();
    response = await request(manager, `/website/sites/${own.id}/config`); const config = await response.json() as Record<string, unknown>; check("connection controls identify their administrator requirement", () => assert.equal(config.connectionEditable, false));
    response = await request(manager, `/website/sites/${own.id}/config`, "PUT", { ...config, repoOwner: "another-tenant", repoName: "private" }); check("full settings update cannot bypass connection isolation", () => assert.equal(response.status, 403)); await response.text();
    response = await request(viewer, `/website/sites/${own.id}/design`); check("a viewer can load the design palette without management settings", () => assert.equal(response.status, 200)); await response.text();
    response = await request(manager, `/website/sites/${own.id}/members`, "POST", { email: newcomer.email.toUpperCase(), role: "EDITOR" }); check("manager can add existing account by case-insensitive email", () => assert.equal(response.status, 201)); const added = await response.json() as { id: string };
    response = await request(manager, `/website/sites/${own.id}/members`, "POST", { userId: newcomer.id, role: "MANAGER" }); check("duplicate membership does not silently elevate role", () => assert.equal(response.status, 409)); await response.text();
    response = await request(manager, `/website/sites/${own.id}/members/${foreignMember.id}`, "PATCH", { role: "VIEWER" }); check("foreign member ID cannot be used in own site", () => assert.equal(response.status, 404)); await response.text();
    const [a, b] = await Promise.all([manager, second].map(async person => { const member = await prisma.siteMember.findUniqueOrThrow({ where: { siteId_userId: { siteId: own.id, userId: person.id } } }); const result = await request(person, `/website/sites/${own.id}/members/${member.id}`, "PATCH", { role: "EDITOR" }); await result.text(); return result.status; }));
    check("simultaneous manager demotions leave one active manager", () => assert.deepEqual([a, b].sort(), [200, 409]));
    const remaining = await prisma.siteMember.findFirstOrThrow({ where: { siteId: own.id, role: "MANAGER" } }); const acting = people.find(person => person.id === remaining.userId)!;
    assert.equal(await prisma.siteMember.count({ where: { siteId: own.id, role: "MANAGER" } }), 1);
    response = await request(acting, `/website/sites/${own.id}/members/${remaining.id}`, "DELETE"); check("last active manager deletion is refused by the database-backed API", () => assert.equal(response.status, 409)); await response.text();
    response = await request(acting, `/website/sites/${own.id}/members/${added.id}`, "DELETE"); check("manager can remove a member", () => assert.equal(response.status, 204)); await response.text();
    response = await request(newcomer, `/website/sites/${own.id}/pages`); check("removed member's existing session loses access immediately", () => assert.equal(response.status, 404)); await response.text();
    const events = await prisma.siteAuditEvent.findMany({ where: { siteId: own.id } }); check("successful membership changes are audited atomically", () => assert.equal(events.length, 3));
  } finally {
    if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    await prisma.site.deleteMany({ where: { id: { in: siteIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.accessRole.deleteMany({ where: { id: { in: roleIds } } });
    await prisma.$disconnect();
  }
}

await httpGateChecks();
if (process.argv.includes("--database")) await databaseChecks();
console.log(`\n${passed} website access checks passed.`);
