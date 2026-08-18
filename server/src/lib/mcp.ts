import { decryptSecret, encryptSecret } from "./secrets.js";

/**
 * Talking to an MCP server.
 *
 * The tool catalogue is code on purpose — what a tool *does* is behaviour, and
 * behaviour editable at runtime is behaviour nobody can review. That rule is
 * worth keeping and it makes one thing impossible: adding a capability without
 * a deploy. MCP is the way out that does not break it. The Owner connects a
 * server; the server declares its own tools, with their own JSON Schemas; each
 * becomes a grantable catalogue entry. What is configurable is *which servers
 * we trust and which agents may call them* — a permission, which is exactly
 * the kind of thing that should be configuration.
 *
 * **No SDK.** MCP over Streamable HTTP is JSON-RPC 2.0 posted to one URL, with
 * a reply that is either JSON or a one-message SSE stream. That is eighty
 * lines, and it is eighty lines that cannot break on a transitive dependency
 * bump in a deploy nobody is watching. `initialize` → `notifications/initialized`
 * → `tools/list` → `tools/call` is the whole protocol surface this app needs.
 *
 * **Everything here is remote and hostile until proved otherwise.** A tool
 * description is text a third party wrote; it is shown to the Owner and never
 * acted on. A declared scope from the server is ignored entirely — the scope
 * that gates a call is the one the Owner set on the connection, which is why
 * a server cannot talk its way past the autonomy gate.
 */

export class McpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "McpError";
  }
}

/** What `tools/list` gives back, trimmed to what this app stores and shows. */
export interface McpToolInfo {
  name: string;
  description: string | null;
  /** The server's own JSON Schema for its arguments. Passed through untouched. */
  inputSchema: Record<string, unknown> | null;
}

export interface McpHandshake {
  serverName: string | null;
  serverVersion: string | null;
  protocolVersion: string | null;
  tools: McpToolInfo[];
}

/** The version this client speaks. Servers negotiate down from theirs. */
const PROTOCOL_VERSION = "2025-06-18";
const TIMEOUT_MS = 30_000;

interface RpcResponse {
  jsonrpc?: string;
  id?: number | string;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

interface Session {
  url: string;
  authHeader: string | null;
  /** Handed back by `initialize` and echoed on every later request. */
  sessionId: string | null;
  protocolVersion: string;
}

function headers(session: Session, extra: Record<string, string> = {}): Record<string, string> {
  return {
    "Content-Type": "application/json",
    // Both, because a server may answer either way and the choice is its own.
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": session.protocolVersion,
    ...(session.sessionId ? { "Mcp-Session-Id": session.sessionId } : {}),
    ...(session.authHeader ? { Authorization: session.authHeader } : {}),
    ...extra,
  };
}

/**
 * The body of an SSE reply, unwrapped.
 *
 * A Streamable HTTP server may answer a request with `text/event-stream`
 * carrying exactly one `data:` line — the response — or with plain JSON. This
 * reads the first complete JSON payload out of either, which is all a
 * request/response call needs. Server-initiated streams are not something this
 * app subscribes to.
 */
async function readBody(response: Response): Promise<RpcResponse | null> {
  const text = await response.text();
  const contentType = response.headers.get("content-type") ?? "";

  if (!contentType.includes("text/event-stream")) {
    if (!text.trim()) return null;
    try {
      return JSON.parse(text) as RpcResponse;
    } catch {
      throw new McpError(502, `That server answered with something that isn't JSON: ${text.slice(0, 160)}`);
    }
  }

  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      return JSON.parse(payload) as RpcResponse;
    } catch {
      // A stream can carry keep-alives and comments; skip what won't parse.
    }
  }
  return null;
}

async function rpc(session: Session, method: string, params?: unknown, id: number | null = 1): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(session.url, {
      method: "POST",
      headers: headers(session),
      body: JSON.stringify(id === null ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id, method, params }),
      signal: controller.signal,
    });
  } catch (err) {
    const reason = (err as Error).name === "AbortError" ? `it didn't answer within ${TIMEOUT_MS / 1000}s` : (err as Error).message;
    throw new McpError(504, `Couldn't reach that server — ${reason}.`);
  } finally {
    clearTimeout(timer);
  }

  // A notification has no id and expects no body; 202 is the correct answer.
  if (id === null) return null;

  if (response.status === 401 || response.status === 403) {
    throw new McpError(401, "That server rejected the credential. Check the authorisation header.");
  }
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 200);
    throw new McpError(response.status, `That server answered ${response.status}${detail ? ` — ${detail}` : ""}.`);
  }

  const body = await readBody(response);
  if (!body) throw new McpError(502, "That server answered with an empty body.");
  if (body.error) {
    throw new McpError(400, body.error.message ?? "The server refused the call without saying why.");
  }
  return body.result;
}

/**
 * Opens a session and lists what the server offers.
 *
 * Called when a connection is saved, when the Owner presses Refresh, and
 * whenever the cached tool list is old — never on the path of an agent's call,
 * because a handshake per call would double the latency of every one.
 */
export async function handshake(url: string, authHeader: string | null): Promise<McpHandshake> {
  const session: Session = { url, authHeader, sessionId: null, protocolVersion: PROTOCOL_VERSION };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let initResponse: Response;
  try {
    initResponse = await fetch(url, {
      method: "POST",
      headers: headers(session),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "dakyworld-os", version: "1.0.0" },
        },
      }),
      signal: controller.signal,
    });
  } catch (err) {
    const reason = (err as Error).name === "AbortError" ? `it didn't answer within ${TIMEOUT_MS / 1000}s` : (err as Error).message;
    throw new McpError(504, `Couldn't reach that server — ${reason}.`);
  } finally {
    clearTimeout(timer);
  }

  if (initResponse.status === 401 || initResponse.status === 403) {
    throw new McpError(401, "That server rejected the credential. Check the authorisation header.");
  }
  if (!initResponse.ok) {
    const detail = (await initResponse.text()).slice(0, 200);
    throw new McpError(
      initResponse.status,
      `That server answered ${initResponse.status} to the handshake${detail ? ` — ${detail}` : ""}. Check the URL points at the MCP endpoint itself.`,
    );
  }

  session.sessionId = initResponse.headers.get("mcp-session-id");
  const initBody = await readBody(initResponse);
  if (initBody?.error) throw new McpError(400, initBody.error.message ?? "The server refused the handshake.");

  const result = (initBody?.result ?? {}) as {
    protocolVersion?: string;
    serverInfo?: { name?: string; version?: string };
  };
  if (result.protocolVersion) session.protocolVersion = result.protocolVersion;

  // The spec requires this before any other request. Servers that don't care
  // ignore it; the ones that do will refuse tools/list without it.
  await rpc(session, "notifications/initialized", {}, null).catch(() => undefined);

  const listed = (await rpc(session, "tools/list", {}, 2)) as { tools?: unknown[] } | null;
  const tools = Array.isArray(listed?.tools) ? listed.tools.map(toToolInfo).filter((tool): tool is McpToolInfo => tool !== null) : [];

  return {
    serverName: result.serverInfo?.name ?? null,
    serverVersion: result.serverInfo?.version ?? null,
    protocolVersion: session.protocolVersion,
    tools,
  };
}

function toToolInfo(raw: unknown): McpToolInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const tool = raw as { name?: unknown; description?: unknown; inputSchema?: unknown };
  if (typeof tool.name !== "string" || !tool.name) return null;
  return {
    name: tool.name,
    // Text a third party wrote. Shown to the Owner, never followed.
    description: typeof tool.description === "string" ? tool.description.slice(0, 600) : null,
    inputSchema: tool.inputSchema && typeof tool.inputSchema === "object" ? (tool.inputSchema as Record<string, unknown>) : null,
  };
}

/** What a tool call gives back, flattened out of MCP's content-block shape. */
export interface McpCallResult {
  /** Every text block, joined. Usually the whole answer. */
  text: string;
  /** Anything that wasn't text — images, audio, embedded resources. */
  parts: Array<{ type: string; mimeType?: string; uri?: string; name?: string }>;
  /** The server's own structured result, when it returned one. */
  structured: unknown;
  /** True when the server reported the call itself failed. */
  isError: boolean;
}

/**
 * Calls one tool. A fresh session per call — MCP sessions are cheap, this app
 * makes tool calls in ones rather than in bursts, and a pooled session that
 * has silently expired fails in a way that is much harder to read than one
 * extra round trip.
 */
export async function callTool(
  url: string,
  authHeader: string | null,
  name: string,
  args: Record<string, unknown>,
): Promise<McpCallResult> {
  const session: Session = { url, authHeader, sessionId: null, protocolVersion: PROTOCOL_VERSION };

  const initResponse = await fetch(session.url, {
    method: "POST",
    headers: headers(session),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "dakyworld-os", version: "1.0.0" } },
    }),
  }).catch((err: Error) => {
    throw new McpError(504, `Couldn't reach that server — ${err.message}.`);
  });
  if (!initResponse.ok) throw new McpError(initResponse.status, `That server answered ${initResponse.status} to the handshake.`);
  session.sessionId = initResponse.headers.get("mcp-session-id");
  const initBody = await readBody(initResponse);
  const negotiated = (initBody?.result as { protocolVersion?: string } | undefined)?.protocolVersion;
  if (negotiated) session.protocolVersion = negotiated;
  await rpc(session, "notifications/initialized", {}, null).catch(() => undefined);

  const result = (await rpc(session, "tools/call", { name, arguments: args }, 2)) as {
    content?: unknown[];
    structuredContent?: unknown;
    isError?: boolean;
  } | null;

  const text: string[] = [];
  const parts: McpCallResult["parts"] = [];
  for (const block of Array.isArray(result?.content) ? result.content : []) {
    if (!block || typeof block !== "object") continue;
    const entry = block as { type?: string; text?: string; mimeType?: string; uri?: string; name?: string; resource?: { uri?: string } };
    if (entry.type === "text" && typeof entry.text === "string") {
      text.push(entry.text);
      continue;
    }
    parts.push({
      type: entry.type ?? "unknown",
      mimeType: entry.mimeType,
      uri: entry.uri ?? entry.resource?.uri,
      name: entry.name,
    });
  }

  return {
    text: text.join("\n").slice(0, 20_000),
    parts,
    structured: result?.structuredContent ?? null,
    isError: result?.isError === true,
  };
}

/** Stored encrypted, like every other credential. See lib/secrets.ts. */
export function encryptAuthHeader(value: string): string {
  return encryptSecret(value);
}

export function decryptAuthHeader(value: string | null): string | null {
  if (!value) return null;
  try {
    return decryptSecret(value);
  } catch {
    // Rotating APP_SECRET makes every stored credential unreadable; saying so
    // beats a 401 from a server that is perfectly fine.
    console.error("[mcp] a stored authorisation header could not be decrypted — has APP_SECRET changed?");
    return null;
  }
}
