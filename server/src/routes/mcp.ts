import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { McpError, encryptAuthHeader, handshake } from "../lib/mcp.js";
import { maskSecret } from "../lib/secrets.js";
import { refreshServer } from "../services/tools/mcpTools.js";
import { clearReadinessCache } from "../services/tools/readiness.js";
import { gateBy } from "../middleware/permissionGate.js";

/**
 * Connected tools — the MCP servers this app has been pointed at.
 *
 * This is how a capability gets added without a deploy, and the reason it does
 * not weaken anything: a server contributes *tools*, and a tool is still only
 * callable by an agent that has been granted it, at an autonomy level that
 * allows it, with every call recorded. What the Owner decides here is which
 * servers are trusted and how far — the scope, whether calls spend money,
 * whether they reach outside the company — and those three are read from this
 * row rather than from anything the server says about itself.
 *
 * `enabled` is off on create on purpose. Connecting a server and letting
 * agents call it are two decisions, and running them together means the first
 * one silently makes the second.
 */
export const mcpRouter = Router();

mcpRouter.use(gateBy({ view: "settings.mcp", create: "settings.mcp", edit: "settings.mcp", remove: "settings.mcp" }));


/** Never the credential, only its shape — the same contract every other integration keeps. */
function describe(server: {
  id: string;
  key: string;
  name: string;
  purpose: string | null;
  url: string;
  authHeader: string | null;
  enabled: boolean;
  scope: string;
  spends: boolean;
  outward: boolean;
  tools: unknown;
  lastCheckedAt: Date | null;
  lastError: string | null;
  createdAt: Date;
}) {
  const tools = Array.isArray(server.tools) ? server.tools : [];
  return {
    id: server.id,
    key: server.key,
    name: server.name,
    purpose: server.purpose,
    url: server.url,
    hasAuth: Boolean(server.authHeader),
    authHint: server.authHeader ? maskSecret(server.authHeader) : null,
    enabled: server.enabled,
    scope: server.scope,
    spends: server.spends,
    outward: server.outward,
    tools: tools as Array<{ name: string; description: string | null }>,
    toolCount: tools.length,
    lastCheckedAt: server.lastCheckedAt,
    lastError: server.lastError,
    createdAt: server.createdAt,
  };
}

mcpRouter.get("/", async (_req, res, next) => {
  try {
    const servers = await prisma.mcpServer.findMany({ orderBy: { createdAt: "asc" } });
    res.json({
      servers: servers.map(describe),
      summary: {
        total: servers.length,
        enabled: servers.filter((server) => server.enabled).length,
        tools: servers.filter((server) => server.enabled).reduce((count, server) => count + (Array.isArray(server.tools) ? server.tools.length : 0), 0),
        failing: servers.filter((server) => server.lastError).length,
      },
    });
  } catch (err) {
    next(err);
  }
});

const serverInput = z.object({
  /**
   * Appears in every tool key this server contributes, so it is fixed once and
   * never edited — renaming it would silently revoke every grant naming it.
   */
  key: z
    .string()
    .min(2)
    .max(32)
    .regex(/^[a-z][a-z0-9-]*$/, "Lowercase letters, numbers and hyphens, starting with a letter."),
  name: z.string().min(1).max(80),
  purpose: z.string().max(400).nullish(),
  url: z.string().url("That isn't a valid URL"),
  /** Sent verbatim as the Authorization header — include the scheme, e.g. `Bearer sk-…`. */
  authHeader: z.string().max(4000).nullish(),
  enabled: z.boolean().default(false),
  scope: z.enum(["read", "write", "send", "charge"]).default("read"),
  spends: z.boolean().default(false),
  outward: z.boolean().default(false),
});

/**
 * Tries the connection before storing it.
 *
 * A server that cannot be reached is still saved — the URL may be right and
 * the service briefly down — but it is saved with the reason recorded and
 * reported back, rather than sitting there looking connected.
 */
mcpRouter.post("/", async (req, res, next) => {
  try {
    const input = serverInput.parse(req.body);
    if (await prisma.mcpServer.findUnique({ where: { key: input.key } })) {
      return res.status(409).json({ error: `There is already a connection called ${input.key}.` });
    }

    let tools: unknown[] = [];
    let lastError: string | null = null;
    let discoveredName: string | null = null;
    try {
      const result = await handshake(input.url, input.authHeader ?? null);
      tools = result.tools;
      discoveredName = result.serverName;
    } catch (err) {
      lastError = err instanceof McpError ? err.message : (err as Error).message;
    }

    const server = await prisma.mcpServer.create({
      data: {
        key: input.key,
        name: input.name || discoveredName || input.key,
        purpose: input.purpose ?? null,
        url: input.url,
        authHeader: input.authHeader ? encryptAuthHeader(input.authHeader) : null,
        // A server that failed its handshake is never switched on by the same
        // request that created it: nothing should be granted to a connection
        // nobody has seen answer.
        enabled: input.enabled && !lastError,
        scope: input.scope,
        spends: input.spends,
        outward: input.outward,
        tools: tools as never,
        lastCheckedAt: new Date(),
        lastError,
      },
    });
    clearReadinessCache();
    res.status(201).json({ server: describe(server), error: lastError });
  } catch (err) {
    next(err);
  }
});

/** Everything but the key, which is immutable for the reason above. */
const patchInput = serverInput.partial().omit({ key: true });

mcpRouter.patch("/:id", async (req, res, next) => {
  try {
    const input = patchInput.parse(req.body);
    const existing = await prisma.mcpServer.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: "No such connection." });

    const server = await prisma.mcpServer.update({
      where: { id: req.params.id },
      data: {
        ...input,
        purpose: input.purpose === undefined ? undefined : (input.purpose ?? null),
        // An empty string clears the credential; absent leaves it alone. A
        // pasted value replaces it — there is no way to read one back.
        authHeader:
          input.authHeader === undefined ? undefined : input.authHeader ? encryptAuthHeader(input.authHeader) : null,
      },
    });
    clearReadinessCache();

    // Anything that changes how we talk to it is worth re-checking now rather
    // than at the moment an agent needs it.
    if (input.url !== undefined || input.authHeader !== undefined || input.enabled === true) {
      const refreshed = await refreshServer(server.id);
      return res.json({ server: describe(refreshed.server), error: refreshed.error });
    }
    res.json({ server: describe(server), error: server.lastError });
  } catch (err) {
    next(err);
  }
});

/** Asks the server what it offers, now. */
mcpRouter.post("/:id/refresh", async (req, res, next) => {
  try {
    const result = await refreshServer(req.params.id);
    res.json({ server: describe(result.server), error: result.error });
  } catch (err) {
    if (err instanceof McpError) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

/**
 * Removes a connection, and says how many grants it takes with it.
 *
 * The grants themselves are cleaned up here rather than left dangling: an
 * agent listing a tool that no longer exists looks equipped and is not, which
 * is the same reason the Agents route drops unknown keys on save.
 */
mcpRouter.delete("/:id", async (req, res, next) => {
  try {
    const server = await prisma.mcpServer.findUnique({ where: { id: req.params.id } });
    if (!server) return res.status(404).json({ error: "No such connection." });

    // Every agent, filtered in memory: the roster is small, and a Postgres
    // array predicate cannot express "has any key with this prefix".
    const prefix = `mcp.${server.key}.`;
    const agents = await prisma.agent.findMany({ select: { id: true, toolkit: true } });
    let revoked = 0;
    for (const agent of agents) {
      const kept = agent.toolkit.filter((key) => !key.startsWith(prefix));
      if (kept.length === agent.toolkit.length) continue;
      revoked += agent.toolkit.length - kept.length;
      await prisma.agent.update({ where: { id: agent.id }, data: { toolkit: kept } });
    }

    await prisma.mcpServer.delete({ where: { id: server.id } });
    clearReadinessCache();
    res.json({ deleted: true, revokedGrants: revoked });
  } catch (err) {
    next(err);
  }
});
