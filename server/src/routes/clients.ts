import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { gateBy } from "../middleware/permissionGate.js";

export const clientsRouter = Router();

clientsRouter.use(
  gateBy({
    view: "clients.view",
    create: "clients.create",
    edit: "clients.edit",
    remove: "clients.delete",
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
    await prisma.client.delete({ where: { id: req.params.id } });
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
