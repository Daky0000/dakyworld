import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { gateBy } from "../middleware/permissionGate.js";
import { PUBLIC_USER } from "../lib/userSelect.js";
import { ensureCustomerAccount, sendSetPasswordLink } from "../services/accountAccess.js";
import { PRODUCT_KEYS, PRODUCT_TIERS, announceEntitlementChange, announceSoon, entitlementsFor, type ProductKey } from "../services/entitlements.js";

export const clientsRouter = Router();

clientsRouter.use(
  gateBy({
    view: "clients.view",
    create: "clients.create",
    edit: "clients.edit",
    remove: "clients.delete",
    // Who belongs to a client decides what its retainer reaches, and a comp is
    // a product given away: both are edits of the client, not new clients.
    routes: [
      { method: ["POST", "DELETE", "PATCH"], path: /^\/[^/]+\/members(?:\/|$)/, permission: "clients.edit" },
      { method: ["POST", "DELETE"], path: /^\/[^/]+\/grants(?:\/|$)/, permission: "clients.edit" },
    ],
  }),
);

const clientInput = z.object({
  name: z.string().min(1),
  company: z.string().optional().nullable(),
  email: z.string().email().optional().nullable(),
  phone: z.string().optional().nullable(),
  address: z.string().optional().nullable(),
  sector: z.string().optional().nullable(),
  firstContactAt: z.coerce.date().optional().nullable(),
  creditTerms: z.string().optional().nullable(),
});

clientsRouter.get("/", async (_req, res, next) => {
  try {
    const clients = await prisma.client.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        _count: { select: { projects: true, invoices: true, carePlans: true } },
      },
    });
    res.json(clients);
  } catch (err) {
    next(err);
  }
});

clientsRouter.get("/:id", async (req, res, next) => {
  try {
    const client = await prisma.client.findUnique({
      where: { id: req.params.id },
      include: {
        contacts: true,
        projects: true,
        proposals: true,
        invoices: { orderBy: { issueDate: "desc" } },
        carePlans: true,
        communications: { orderBy: { occurredAt: "desc" }, take: 20 },
      },
    });
    if (!client) return res.status(404).json({ error: "Client not found" });
    res.json(client);
  } catch (err) {
    next(err);
  }
});

clientsRouter.post("/", async (req, res, next) => {
  try {
    const data = clientInput.parse(req.body);
    const client = await prisma.client.create({ data });
    res.status(201).json(client);
  } catch (err) {
    next(err);
  }
});

clientsRouter.patch("/:id", async (req, res, next) => {
  try {
    const data = clientInput.partial().parse(req.body);
    const client = await prisma.client.update({ where: { id: req.params.id }, data });
    res.json(client);
  } catch (err) {
    next(err);
  }
});

clientsRouter.delete("/:id", async (req, res, next) => {
  try {
    // The members go with the client (cascade), and so does what its retainer gave them.
    const members = await prisma.clientMember.findMany({ where: { clientId: req.params.id }, select: { userId: true } });
    await prisma.client.delete({ where: { id: req.params.id } });
    announceSoon(() => announceEntitlementChange(members.map((member) => member.userId)));
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// Nested: contacts for a client
const contactInput = z.object({
  name: z.string().min(1),
  title: z.string().optional().nullable(),
  email: z.string().email().optional().nullable(),
  phone: z.string().optional().nullable(),
  decisionRole: z.string().optional().nullable(),
  isPrimary: z.boolean().default(false),
  notes: z.string().optional().nullable(),
});

clientsRouter.post("/:id/contacts", async (req, res, next) => {
  try {
    const data = contactInput.parse(req.body);
    const contact = await prisma.contact.create({ data: { ...data, clientId: req.params.id } });
    res.status(201).json(contact);
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------ people with access ----- */
//
// Who belongs to this client, and so what its retainer reaches: every product,
// in every DakyX app (services/entitlements.ts). Staff set this by hand. It is
// never inferred from an email domain. docs/cross-product-access.md.

clientsRouter.get("/:id/members", async (req, res, next) => {
  try {
    const members = await prisma.clientMember.findMany({
      where: { clientId: req.params.id },
      orderBy: { createdAt: "asc" },
      include: { user: { select: PUBLIC_USER } },
    });
    const withAccess = await Promise.all(members.map(async (member) => {
      const [entitlements, comps] = await Promise.all([
        entitlementsFor(member.userId),
        prisma.productGrant.findMany({ where: { userId: member.userId, revokedAt: null }, orderBy: { createdAt: "desc" } }),
      ]);
      return { ...member, grants: entitlements.grants, comps };
    }));
    res.json({ members: withAccess, productTiers: PRODUCT_TIERS });
  } catch (err) {
    next(err);
  }
});

const memberInput = z.object({
  email: z.string().email(),
  name: z.string().trim().max(120).optional(),
  role: z.enum(["OWNER", "MEMBER"]).default("MEMBER"),
});

clientsRouter.post("/:id/members", async (req, res, next) => {
  try {
    const data = memberInput.parse(req.body);
    const client = await prisma.client.findUnique({ where: { id: req.params.id }, select: { id: true, name: true } });
    if (!client) return res.status(404).json({ error: "Client not found" });
    // Staff-only, so saying whether the address already had an account is not a leak.
    const { user, created } = await ensureCustomerAccount({ email: data.email, name: data.name || data.email.split("@")[0]!, businessName: client.name });
    if (!user.active) return res.status(409).json({ error: "That account is switched off. Switch it back on from Team before adding it to a client." });
    const member = await prisma.clientMember.upsert({
      where: { clientId_userId: { clientId: client.id, userId: user.id } },
      create: { clientId: client.id, userId: user.id, role: data.role, addedById: req.dbUser?.id ?? null },
      update: { role: data.role },
      include: { user: { select: PUBLIC_USER } },
    });
    if (created) await sendSetPasswordLink({ id: user.id, email: user.email, name: user.name }, "invite");
    announceSoon(() => announceEntitlementChange([user.id]));
    res.status(201).json({ ...member, created });
  } catch (err) {
    next(err);
  }
});

clientsRouter.delete("/:id/members/:userId", async (req, res, next) => {
  try {
    const removed = await prisma.clientMember.deleteMany({ where: { clientId: req.params.id, userId: req.params.userId } });
    if (!removed.count) return res.status(404).json({ error: "That person is not on this client." });
    announceSoon(() => announceEntitlementChange([req.params.userId!]));
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

/* --------------------------------------------------------- comps ---------- */

const grantInput = z.object({
  userId: z.string().min(1),
  productKey: z.enum(PRODUCT_KEYS),
  tier: z.string().min(1),
  reason: z.string().trim().min(3).max(300),
  validUntil: z.coerce.date().optional().nullable(),
});

clientsRouter.post("/:id/grants", async (req, res, next) => {
  try {
    const data = grantInput.parse(req.body);
    if (!PRODUCT_TIERS[data.productKey as ProductKey].includes(data.tier)) {
      return res.status(400).json({ error: `${data.productKey} has no tier called "${data.tier}". It has ${PRODUCT_TIERS[data.productKey as ProductKey].join(", ")}.` });
    }
    // A comp is given in a client's context, to somebody who belongs to it.
    const member = await prisma.clientMember.findUnique({ where: { clientId_userId: { clientId: req.params.id!, userId: data.userId } } });
    if (!member) return res.status(404).json({ error: "Add this person to the client first." });
    const grant = await prisma.productGrant.create({
      data: { userId: data.userId, productKey: data.productKey, tier: data.tier, reason: data.reason, validUntil: data.validUntil ?? null, grantedById: req.dbUser?.id ?? null },
    });
    announceSoon(() => announceEntitlementChange([data.userId]));
    res.status(201).json(grant);
  } catch (err) {
    next(err);
  }
});

clientsRouter.delete("/:id/grants/:grantId", async (req, res, next) => {
  try {
    const grant = await prisma.productGrant.findUnique({ where: { id: req.params.grantId } });
    if (!grant) return res.status(404).json({ error: "Grant not found" });
    const member = await prisma.clientMember.findUnique({ where: { clientId_userId: { clientId: req.params.id!, userId: grant.userId } } });
    if (!member) return res.status(404).json({ error: "Grant not found" });
    // Revoked, not deleted: "who gave this away, and when did it stop" gets asked.
    await prisma.productGrant.update({ where: { id: grant.id }, data: { revokedAt: new Date() } });
    announceSoon(() => announceEntitlementChange([grant.userId]));
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

