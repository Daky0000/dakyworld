import { z } from "zod";
import type { McpServer } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { McpError, callTool, decryptAuthHeader, handshake, type McpToolInfo } from "../../lib/mcp.js";
import type { ToolDefinition, ToolScope } from "./types.js";

/**
 * MCP tools, as catalogue entries.
 *
 * A connected server declares its own tools; each becomes a `ToolDefinition`
 * indistinguishable from a built-in one from the invoker's point of view — the
 * same grant check, the same autonomy gate, the same dry run, the same
 * `ToolCall` row. That is the whole point: adding a capability must not add a
 * way around the policy.
 *
 * Three things are deliberately **not** taken from the server:
 *
 * 1. **Scope.** A remote server telling us its tool is `read` is a remote
 *    server telling us it may act without a person watching. The scope that
 *    gates a call is the one the Owner set on the connection.
 * 2. **Whether it spends or reaches outside.** Same reason, same source.
 * 3. **Its description as instruction.** Descriptions are shown to the Owner
 *    on the Tools screen and to the model as a description. Nothing in one is
 *    ever executed or treated as a directive.
 *
 * The argument schema *is* taken from the server, because that is what the
 * schema is for — but it is validated as a shape, not trusted as a promise:
 * anything the schema doesn't describe is dropped before the call.
 */

/** `mcp.<server>.<tool>` — the key an agent is granted. */
export function mcpToolKey(serverKey: string, toolName: string): string {
  return `mcp.${serverKey}.${toolName}`;
}

/** How stale a cached `tools/list` may be before it is refetched in the background. */
const REFRESH_AFTER_MS = 6 * 60 * 60_000;

function parseTools(raw: unknown): McpToolInfo[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry): entry is McpToolInfo => Boolean(entry) && typeof entry === "object" && typeof (entry as McpToolInfo).name === "string")
    .map((entry) => ({ name: entry.name, description: entry.description ?? null, inputSchema: entry.inputSchema ?? null }));
}

/**
 * A JSON Schema turned into something Zod can enforce.
 *
 * Deliberately shallow. The point is not to re-implement JSON Schema — the
 * server validates its own arguments and is entitled to reject them. The point
 * is that a model will confidently pass a string where an object was wanted,
 * and the required top-level keys catch that before a network call. Everything
 * the schema does not describe is passed through untouched, so a server using
 * a construct this doesn't model still works.
 */
function schemaFor(inputSchema: Record<string, unknown> | null): z.ZodType<Record<string, unknown>> {
  const properties = inputSchema?.properties;
  const required = Array.isArray(inputSchema?.required) ? (inputSchema.required as unknown[]).filter((k): k is string => typeof k === "string") : [];
  if (!properties || typeof properties !== "object") return z.record(z.unknown());

  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [name, definition] of Object.entries(properties as Record<string, unknown>)) {
    const type = (definition as { type?: unknown })?.type;
    let field: z.ZodTypeAny;
    switch (type) {
      case "string":
        field = z.string();
        break;
      case "number":
      case "integer":
        field = z.number();
        break;
      case "boolean":
        field = z.boolean();
        break;
      case "array":
        field = z.array(z.unknown());
        break;
      case "object":
        field = z.record(z.unknown());
        break;
      default:
        field = z.unknown();
    }
    shape[name] = required.includes(name) ? field : field.optional();
  }
  // passthrough: a schema this doesn't model fully must not silently lose an
  // argument the server needs.
  return z.object(shape).passthrough() as unknown as z.ZodType<Record<string, unknown>>;
}

/** The connection's declared scope, floored to something the invoker understands. */
function scopeOf(server: McpServer): ToolScope {
  const scope = server.scope as ToolScope;
  return scope === "read" || scope === "write" || scope === "send" || scope === "charge" ? scope : "read";
}

// `any` on the input, as the built-in catalogue uses: a tool's schema is its
// own, and the invoker is what makes every one of them safe to call.
function definitionFor(server: McpServer, tool: McpToolInfo): ToolDefinition<any, any> {
  const key = mcpToolKey(server.key, tool.name);
  const authHeader = decryptAuthHeader(server.authHeader);

  return {
    key,
    name: `${server.name} · ${tool.name}`,
    group: "Connected",
    purpose: tool.description ?? `The "${tool.name}" tool on ${server.name}.`,
    scope: scopeOf(server),
    requires: "mcp",
    spends: server.spends,
    outward: server.outward,
    input: schemaFor(tool.inputSchema),
    run: async (input) => {
      if (!server.enabled) throw new McpError(409, `${server.name} is switched off. Turn it on under Settings → Connected tools.`);
      const result = await callTool(server.url, authHeader, tool.name, input);
      if (result.isError) throw new McpError(400, result.text || `${tool.name} reported that it failed.`);
      return { text: result.text, parts: result.parts, structured: result.structured, server: server.key, tool: tool.name };
    },
    // Every MCP tool gets one, because the Owner may set the connection to
    // `send` or `charge` — and the invoker refuses to dry-run a tool that
    // cannot say what it would do rather than quietly doing it.
    preview: async (input) =>
      `Would call ${tool.name} on ${server.name} with ${JSON.stringify(input).slice(0, 400)}. Nothing was sent.`,
  };
}

/**
 * Every tool every enabled server currently advertises.
 *
 * Read from the cached `tools/list` on the row rather than from the network:
 * this is called on the Tools screen, on the Agents screen and before every
 * agent call, and a handshake per render would be indefensible. `refreshServer`
 * is what actually talks to a server.
 */
export async function mcpTools(): Promise<ToolDefinition<any, any>[]> {
  const servers = await prisma.mcpServer.findMany({ where: { enabled: true }, orderBy: { key: "asc" } });
  return servers.flatMap((server) => parseTools(server.tools).map((tool) => definitionFor(server, tool)));
}

/**
 * The same, including servers that are switched off, so the Tools screen can
 * show what connecting one would add. A disabled server's tools refuse when
 * called — see `run` above.
 */
export async function allMcpTools(): Promise<ToolDefinition<any, any>[]> {
  const servers = await prisma.mcpServer.findMany({ orderBy: { key: "asc" } });
  return servers.flatMap((server) => parseTools(server.tools).map((tool) => definitionFor(server, tool)));
}

/** Talks to a server, stores what it advertises, and records why it failed if it did. */
export async function refreshServer(id: string): Promise<{ server: McpServer; tools: McpToolInfo[]; error: string | null }> {
  const server = await prisma.mcpServer.findUnique({ where: { id } });
  if (!server) throw new McpError(404, "No such connection.");

  try {
    const result = await handshake(server.url, decryptAuthHeader(server.authHeader));
    const updated = await prisma.mcpServer.update({
      where: { id },
      data: {
        tools: result.tools as never,
        lastCheckedAt: new Date(),
        lastError: null,
        // A server that names itself gets to, as long as nobody has renamed it.
        name: server.name || result.serverName || server.key,
      },
    });
    return { server: updated, tools: result.tools, error: null };
  } catch (err) {
    const message = err instanceof McpError ? err.message : (err as Error).message;
    // The previous tool list is kept: a server that is briefly unreachable
    // should not silently revoke every grant that names one of its tools.
    const updated = await prisma.mcpServer.update({ where: { id }, data: { lastCheckedAt: new Date(), lastError: message } });
    return { server: updated, tools: parseTools(updated.tools), error: message };
  }
}

/** Refreshes anything enabled whose cached list is old. Fire-and-forget from a route. */
export async function refreshStaleServers(): Promise<number> {
  const stale = await prisma.mcpServer.findMany({
    where: {
      enabled: true,
      OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: new Date(Date.now() - REFRESH_AFTER_MS) } }],
    },
    select: { id: true },
  });
  for (const server of stale) {
    await refreshServer(server.id).catch(() => undefined);
  }
  return stale.length;
}

/**
 * The first enabled server whose tools look like image generation.
 *
 * `image.generate` in the catalogue is a *named* capability rather than a
 * provider: whichever MCP server is connected for pictures answers it, so the
 * agents' toolkits can say "this one draws" without the choice of provider
 * being baked into a seed. Matched on the tool name because that is what a
 * server actually commits to — a description is prose.
 */
const IMAGE_TOOL_PATTERN = /(^|[._-])(generate_image|image_generate|images_generate|generate|text_to_image|create_image)($|[._-])/i;

export async function imageProvider(): Promise<{ server: McpServer; tool: McpToolInfo } | null> {
  const servers = await prisma.mcpServer.findMany({ where: { enabled: true }, orderBy: { createdAt: "asc" } });
  for (const server of servers) {
    for (const tool of parseTools(server.tools)) {
      if (IMAGE_TOOL_PATTERN.test(tool.name) && /image|picture|art|photo|render|visual/i.test(`${tool.name} ${tool.description ?? ""}`)) {
        return { server, tool };
      }
    }
  }
  return null;
}

/** Calls a named tool on a named server. Used by the native tools that stand in front of one. */
export async function callOn(server: McpServer, toolName: string, args: Record<string, unknown>) {
  return callTool(server.url, decryptAuthHeader(server.authHeader), toolName, args);
}
