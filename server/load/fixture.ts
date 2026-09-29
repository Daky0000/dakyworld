import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { prisma } from "../src/lib/prisma.js";

const url = new URL(process.env.DATABASE_URL ?? "");
assert.ok(["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname.includes("capacity_load"), "Use a dedicated local capacity_load database");
const count = Number(process.env.LOAD_USERS ?? 5000);
assert.ok(Number.isInteger(count) && count >= 1 && count <= 10_000);
const prefix = `load-${Date.now()}`;
const role = await prisma.accessRole.create({ data: { key: prefix, name: "Load-test customer", external: true } });
const product = await prisma.product.create({ data: { key: prefix, name: "Load-test plan", monthlyPrice: 0 } });
const client = await prisma.client.create({ data: { name: "Isolated load-test fixtures" } });
const users = Array.from({ length: count }, (_, i) => ({ id: `${prefix}-u${i}`, email: `${prefix}-${i}@example.invalid`, name: `User ${i}`, accessRoleId: role.id }));
const sites = users.map((user, i) => ({ id: `${prefix}-s${i}`, name: `Site ${i}`, slug: `${prefix}-${i}`, publicUrl: `https://${prefix}-${i}.example.invalid`, sourceKind: "html", settings: { aiEnabled: true } }));
const html = "<!doctype html><html><head><title>Load fixture</title></head><body><h1>Welcome</h1><p>Sample content for an isolated editor load test.</p></body></html>";
const fixtures = users.map((user, i) => ({ userId: user.id, siteId: sites[i]!.id, pageId: `${prefix}-p${i}`, token: randomBytes(32).toString("base64url") }));
for (let offset = 0; offset < count; offset += 250) {
  const batch = fixtures.slice(offset, offset + 250);
  await prisma.$transaction(async tx => {
    await tx.user.createMany({ data: users.slice(offset, offset + 250) });
    await tx.site.createMany({ data: sites.slice(offset, offset + 250) });
    await tx.siteMember.createMany({ data: batch.map(item => ({ siteId: item.siteId, userId: item.userId, role: "MANAGER" })) });
    await tx.sitePage.createMany({ data: batch.map(item => ({ id: item.pageId, siteId: item.siteId, path: "/", filePath: "index.html", title: "Home", sourceHtml: html, publishedHtml: html })) });
    await tx.session.createMany({ data: batch.map(item => ({ userId: item.userId, tokenHash: createHash("sha256").update(item.token).digest("hex"), expiresAt: new Date(Date.now() + 86_400_000) })) });
    await tx.websitePurchase.createMany({ data: batch.map(item => ({ userId: item.userId, clientId: client.id, productId: product.id,
      tier: "MANAGED", businessName: "Load fixture", contactName: "Load user", email: users.find(user => user.id === item.userId)!.email,
      websiteUrl: "https://example.invalid", compatibilityStatus: "compatible", monthlyPrice: 0, setupPrice: 0,
      setupPaidAt: new Date(), activatedAt: new Date(), billingState: "ACTIVE" })) });
  }, { timeout: 30_000 });
}
await mkdir("tmp", { recursive: true });
await writeFile("tmp/capacity-load-users.json", JSON.stringify(fixtures));
console.log(`Seeded ${count} isolated customers, sites, pages, and sessions. Credentials saved only in ignored tmp/.`);
await prisma.$disconnect();
