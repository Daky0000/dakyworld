import { SETTING, getSetting } from "./settings.js";
import type { Attachment, SendArgs } from "./mailer.js";

/**
 * Hostinger Mail, over the MCP server the mailbox already ships with.
 *
 * **Why this exists next to SMTP.** SMTP needs a host, a port, a username, a
 * mailbox password and the right TLS mode — five things to get right, and the
 * failure mode of getting one wrong is silence at 8am. Hostinger's Agentic Mail
 * gives the same mailbox an MCP endpoint and one API token, so connecting it is
 * paste-a-token and nothing else. The from-address isn't asked for either: the
 * token is scoped to mailboxes, so the app asks Hostinger which ones and uses
 * the address it is told.
 *
 * **MCP first, the Mail API as the floor.** `mcp.mail.hostinger.com` is the
 * agent surface and the one the Owner asked for, but its tool names are only
 * discoverable with a live token, so nothing here is hard-coded against a
 * guess: the client handshakes, reads `tools/list`, picks the send tool and
 * fills its arguments from the schema the server itself published. When that
 * discovery cannot be completed the same token sends through the documented
 * REST endpoint instead, and the Settings screen says which path is live rather
 * than quietly pretending.
 *
 * **A failed MCP call only falls back when nothing can have been sent.** A
 * handshake that never completed, a tool that isn't there, an argument the
 * schema rejected — those are safe to retry another way. A timeout in the
 * middle of a send is not, because the mail may already be gone, and two copies
 * of a proposal is worse than one error on the screen.
 *
 * Two things SMTP does that this path cannot, both deliberate and both said out
 * loud in Settings: a `Reply-To` different from the mailbox (the API takes no
 * custom headers) and the `List-Unsubscribe` header (the opt-out link in the
 * body of every cold email is unaffected — see services/emailRender.ts).
 */

// Overridable so the client can be exercised against a stand-in server, and so
// a moved endpoint is an environment variable rather than a code change.
const MCP_URL = process.env.HOSTINGER_MCP_URL?.trim() || "https://mcp.mail.hostinger.com/mcp";
const API_BASE = (process.env.HOSTINGER_MAIL_API?.trim() || "https://api.mail.hostinger.com").replace(/\/$/, "");
/** The revision of the MCP spec this client speaks. */
const PROTOCOL_VERSION = "2025-06-18";
const REQUEST_TIMEOUT_MS = 30_000;
/** Nothing is worth base64-ing into a JSON body past this. */
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export class HostingerMailError extends Error {
  status: number;
  /**
   * True only when the failure happened before anything could have left the
   * mailbox, so another transport may safely try the same message.
   */
  safeToRetry: boolean;

  constructor(status: number, message: string, safeToRetry = false) {
    super(message);
    this.name = "HostingerMailError";
    this.status = status;
    this.safeToRetry = safeToRetry;
  }
}

const BAD_TOKEN =
  "Hostinger rejected that API token. Create a new one in hPanel → Emails → your domain → Agentic mail → API, and scope it to the mailbox you send from.";

// --- Stored configuration ----------------------------------------------------

export interface HostingerMailbox {
  /** Hostinger's own id for the mailbox, `AC…`. */
  resourceId: string;
  address: string;
}

export interface HostingerConfig {
  token: string;
  mailbox: HostingerMailbox;
  fromName: string;
}

export async function readHostingerConfig(): Promise<HostingerConfig | null> {
  const [token, resourceId, address, fromName] = await Promise.all([
    getSetting(SETTING.HOSTINGER_MAIL_TOKEN),
    getSetting(SETTING.HOSTINGER_MAILBOX_ID),
    getSetting(SETTING.HOSTINGER_MAILBOX_ADDRESS),
    getSetting(SETTING.MAIL_FROM_NAME),
  ]);

  // The address is what a recipient sees and the resource id is what the API
  // addresses; without both, a send would either be anonymous or unroutable.
  if (!token || !resourceId || !address) return null;
  return { token, mailbox: { resourceId, address }, fromName: fromName ?? "Dakyworld" };
}

export async function hostingerConfigured(): Promise<boolean> {
  return (await readHostingerConfig()) !== null;
}

// --- The documented REST API -------------------------------------------------

interface ApiOptions {
  method?: "GET" | "POST";
  body?: unknown;
}

async function api<T>(token: string, path: string, options: ApiOptions = {}): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method: options.method ?? "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw new HostingerMailError(504, "Hostinger Mail did not respond in time.");
    throw new HostingerMailError(502, `Could not reach Hostinger Mail: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 401 || response.status === 403) throw new HostingerMailError(400, BAD_TOKEN);
  if (!response.ok) {
    const detail = await describeApiError(response);
    throw new HostingerMailError(
      response.status >= 500 ? 502 : 400,
      detail ?? `Hostinger Mail returned ${response.status} ${response.statusText}.`,
    );
  }

  if (response.status === 204) return null;
  return (await response.json().catch(() => null)) as T | null;
}

/** Hostinger answers a rejected body with `message` and a per-field `errors` map. */
async function describeApiError(response: Response): Promise<string | null> {
  const body = (await response.json().catch(() => null)) as
    | { message?: string; errors?: Record<string, string[]> }
    | null;
  if (!body) return null;
  const fields = Object.values(body.errors ?? {}).flat();
  if (fields.length) return fields.join(" ");
  return body.message ?? null;
}

/**
 * The mailboxes this token may send from. Doubles as the check that the token
 * is real, which is why connecting runs it before storing anything.
 */
export async function fetchMailboxes(token: string): Promise<HostingerMailbox[]> {
  const payload = await api<{ data?: { mailboxes?: HostingerMailbox[] } }>(token, "/api/v1/me");
  const mailboxes = (payload?.data?.mailboxes ?? []).filter((box) => box?.resourceId && box?.address);
  if (!mailboxes.length) {
    throw new HostingerMailError(
      400,
      "That token is valid but has no mailboxes attached to it. In hPanel, give the token access to the mailbox you send from.",
    );
  }
  return mailboxes;
}

// --- MCP over streamable HTTP ------------------------------------------------

interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  pattern?: string;
}

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: JsonSchema;
}

interface McpSession {
  sessionId: string | null;
  tools: McpTool[];
  sendTool: McpTool | null;
}

interface RpcAnswer {
  result?: any;
  error?: { code: number; message: string };
}

let nextId = 1;

/**
 * One JSON-RPC exchange. The transport is "streamable HTTP": the server may
 * answer with a JSON body or with an SSE stream that it holds open afterwards,
 * so the reply is read event by event and the stream dropped as soon as the
 * answer to *this* request has arrived.
 */
async function rpc(
  token: string,
  message: Record<string, unknown>,
  sessionId: string | null,
  /**
   * Whether a failure of *this* call leaves the mailbox untouched. False for a
   * send, where a dropped connection is not proof that nothing went out — the
   * three rejections that are always safe (401, 403, 404) say so themselves.
   */
  safeToRetry = true,
): Promise<{ answer: RpcAnswer | null; sessionId: string | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(MCP_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": PROTOCOL_VERSION,
        ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
      },
      body: JSON.stringify(message),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if ((err as Error).name === "AbortError") throw new HostingerMailError(504, "The Hostinger MCP server did not respond in time.");
    throw new HostingerMailError(502, `Could not reach the Hostinger MCP server: ${(err as Error).message}`);
  }

  const returnedSession = response.headers.get("mcp-session-id") ?? sessionId;

  try {
    if (response.status === 401 || response.status === 403) throw new HostingerMailError(400, BAD_TOKEN, true);
    // A session the server has forgotten. Worth one clean reconnect.
    if (response.status === 404) throw new HostingerMailError(409, "The Hostinger MCP session had expired.", true);
    if (!response.ok) {
      throw new HostingerMailError(
        response.status >= 500 ? 502 : 400,
        `The Hostinger MCP server returned ${response.status} ${response.statusText}.`,
        safeToRetry,
      );
    }

    // 202 is the acknowledgement of a notification: nothing to read.
    if (response.status === 202 || message.id === undefined) {
      await response.body?.cancel().catch(() => {});
      return { answer: null, sessionId: returnedSession };
    }

    const contentType = response.headers.get("content-type") ?? "";
    const answer = contentType.includes("text/event-stream")
      ? await readEventStream(response, message.id as number, safeToRetry)
      : ((await response.json().catch(() => null)) as RpcAnswer | null);

    return { answer, sessionId: returnedSession };
  } finally {
    clearTimeout(timer);
  }
}

/** Pulls SSE events until the one carrying this request's answer shows up. */
async function readEventStream(response: Response, id: number, safeToRetry: boolean): Promise<RpcAnswer | null> {
  const body = response.body;
  if (!body) return null;

  const reader = body.getReader();
  const decoder = new TextDecoder();
  const boundary = /\r?\n\r?\n/;
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let split = boundary.exec(buffer);
      while (split) {
        const event = buffer.slice(0, split.index);
        buffer = buffer.slice(split.index + split[0].length);

        const data = event
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("");

        if (data) {
          const parsed = JSON.parse(data) as RpcAnswer & { id?: number };
          // Servers are free to push logs and progress down the same stream;
          // only the frame carrying our id is the answer.
          if (parsed?.id === id) return parsed;
        }
        split = boundary.exec(buffer);
      }
    }
  } catch (err) {
    if ((err as Error).name === "AbortError") throw new HostingerMailError(504, "The Hostinger MCP server stopped responding mid-call.");
    throw new HostingerMailError(502, `The Hostinger MCP stream could not be read: ${(err as Error).message}`);
  } finally {
    await reader.cancel().catch(() => {});
  }

  throw new HostingerMailError(502, "The Hostinger MCP server closed the connection without answering.", safeToRetry);
}

function unwrap(answer: RpcAnswer | null, what: string, safeToRetry: boolean): any {
  if (!answer) throw new HostingerMailError(502, `The Hostinger MCP server sent no answer to ${what}.`, safeToRetry);
  if (answer.error) throw new HostingerMailError(400, `The Hostinger MCP server refused ${what}: ${answer.error.message}`, safeToRetry);
  return answer.result;
}

/** Handshake, then ask what the mailbox can actually do. */
async function connect(token: string): Promise<McpSession> {
  const opened = await rpc(token, {
    jsonrpc: "2.0",
    id: nextId++,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "dakyworld-os", version: "1.0.0" },
    },
  }, null);
  unwrap(opened.answer, "the handshake", true);

  const sessionId = opened.sessionId;
  // Required by the spec before any other call; the server answers 202.
  await rpc(token, { jsonrpc: "2.0", method: "notifications/initialized" }, sessionId);

  const listed = await rpc(token, { jsonrpc: "2.0", id: nextId++, method: "tools/list", params: {} }, sessionId);
  const tools = (unwrap(listed.answer, "the tool list", true)?.tools ?? []) as McpTool[];

  return { sessionId, tools, sendTool: chooseSendTool(tools) };
}

// One session per process, reused until it goes stale. Re-handshaking for every
// email would triple the requests for no gain.
const SESSION_TTL_MS = 10 * 60_000;
let session: { token: string; at: number; value: McpSession } | null = null;

async function currentSession(token: string, force = false): Promise<McpSession> {
  if (!force && session && session.token === token && Date.now() - session.at < SESSION_TTL_MS) return session.value;
  const value = await connect(token);
  session = { token, at: Date.now(), value };
  return value;
}

export function clearHostingerSession() {
  session = null;
}

const norm = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");

/** The names a send tool plausibly goes by, best first. */
const SEND_TOOL_NAMES = ["sendemail", "sendmail", "sendmessage", "emailsend", "mailsend", "messagesend", "send"];

function chooseSendTool(tools: McpTool[]): McpTool | null {
  for (const wanted of SEND_TOOL_NAMES) {
    const exact = tools.find((tool) => norm(tool.name) === wanted);
    if (exact) return exact;
  }
  // Anything that sends but isn't a webhook tester or a draft-saver.
  return (
    tools.find((tool) => /send/.test(norm(tool.name)) && !/(webhook|test|draft|schedule)/.test(norm(tool.name))) ?? null
  );
}

// --- Filling a tool call from its own schema ---------------------------------

/** First property whose name matches one of these, exact match before substring. */
function propertyFor(schema: JsonSchema | undefined, aliases: string[]): [string, JsonSchema] | null {
  const properties = Object.entries(schema?.properties ?? {});
  if (!properties.length) return null;

  for (const alias of aliases) {
    const exact = properties.find(([name]) => norm(name) === alias);
    if (exact) return exact;
  }
  for (const alias of aliases) {
    const loose = properties.find(([name]) => norm(name).includes(alias));
    if (loose) return loose;
  }
  return null;
}

function isArraySchema(schema: JsonSchema): boolean {
  return schema.type === "array" || (Array.isArray(schema.type) && schema.type.includes("array"));
}

/** Writes a value into `args` in whichever shape the published schema asked for. */
function put(args: Record<string, unknown>, schema: JsonSchema | undefined, aliases: string[], value: string | string[]): boolean {
  const found = propertyFor(schema, aliases);
  if (!found) return false;
  const [name, propertySchema] = found;
  const list = Array.isArray(value) ? value : [value];
  if (!list.length) return false;
  args[name] = isArraySchema(propertySchema) ? list : list.join(", ");
  return true;
}

interface OutgoingMail {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string;
  html: string;
  displayName: string;
  attachments: Array<{ filename: string; content: string; contentType?: string; cid?: string }>;
}

function buildToolArguments(tool: McpTool, mail: OutgoingMail, mailbox: HostingerMailbox, useResourceId: boolean): Record<string, unknown> {
  const schema = tool.inputSchema;
  const args: Record<string, unknown> = {};

  put(args, schema, ["to", "recipients", "recipient", "toaddresses", "toemail", "toemails"], mail.to);
  if (mail.cc.length) put(args, schema, ["cc", "ccaddresses", "ccemails"], mail.cc);
  if (mail.bcc.length) put(args, schema, ["bcc", "bccaddresses", "bccemails"], mail.bcc);
  put(args, schema, ["subject", "title"], mail.subject);
  put(args, schema, ["html", "htmlbody", "bodyhtml", "htmlcontent"], mail.html);
  put(args, schema, ["text", "textbody", "bodytext", "plaintext", "body", "content"], mail.text);
  put(args, schema, ["displayname", "fromname", "sendername"], mail.displayName);

  // Which mailbox is sending. A property named for a resource id gets the id, a
  // property named for an address gets the address, and anything ambiguous
  // starts as the address — see sendOverMcp for the one retry that resolves it.
  const mailboxProperty = propertyFor(schema, [
    "mailboxresourceid",
    "mailboxid",
    "accountid",
    "fromaddress",
    "fromemail",
    "from",
    "sender",
    "mailbox",
    "account",
  ]);
  if (mailboxProperty) {
    const [name, propertySchema] = mailboxProperty;
    const wantsId = /resource|id$/.test(norm(name)) || /^\^AC/.test(propertySchema.pattern ?? "");
    args[name] = wantsId || useResourceId ? mailbox.resourceId : mailbox.address;
  }

  if (mail.attachments.length) {
    const attachmentProperty = propertyFor(schema, ["attachments", "files"]);
    if (attachmentProperty) args[attachmentProperty[0]] = mail.attachments;
  }

  // A required field this mapping could not fill means the schema is not the
  // one assumed here; better to say so and let the REST path carry the message.
  const missing = (schema?.required ?? []).filter((name) => args[name] === undefined);
  if (missing.length) {
    throw new HostingerMailError(
      502,
      `The Hostinger MCP tool "${tool.name}" wants ${missing.join(", ")}, which this app does not know how to supply.`,
      true,
    );
  }

  return args;
}

/** Free text out of an MCP tool result, which is where servers put their errors. */
function resultText(result: any): string {
  if (!result) return "";
  const parts = Array.isArray(result.content) ? result.content : [];
  return parts
    .map((part: any) => (typeof part?.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join(" ")
    .trim();
}

const LOOKS_LIKE_BAD_ARGUMENTS = /invalid|required|unknown|unsupported|validation|not found|missing|malformed|expected/i;

async function callSendTool(
  token: string,
  active: McpSession,
  tool: McpTool,
  mail: OutgoingMail,
  mailbox: HostingerMailbox,
  useResourceId: boolean,
): Promise<{ text: string }> {
  const args = buildToolArguments(tool, mail, mailbox, useResourceId);
  const called = await rpc(
    token,
    { jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name: tool.name, arguments: args } },
    active.sessionId,
    false,
  );

  // From here on the message may already be gone, so a transport failure is not
  // safe to retry anywhere else — unwrap() defaults to that.
  const result = unwrap(called.answer, `sending through "${tool.name}"`, false);
  const text = resultText(result);
  if (result?.isError) {
    throw new HostingerMailError(
      400,
      `The Hostinger MCP server could not send that: ${text || "no reason given"}`,
      LOOKS_LIKE_BAD_ARGUMENTS.test(text),
    );
  }
  return { text };
}

async function sendOverMcp(config: HostingerConfig, mail: OutgoingMail): Promise<{ tool: string }> {
  let active = await currentSession(config.token);
  if (!active.sendTool) {
    throw new HostingerMailError(
      502,
      `The Hostinger MCP server offers no send tool (it published: ${active.tools.map((tool) => tool.name).join(", ") || "nothing"}).`,
      true,
    );
  }

  try {
    await callSendTool(config.token, active, active.sendTool, mail, config.mailbox, false);
    return { tool: active.sendTool.name };
  } catch (err) {
    if (!(err instanceof HostingerMailError) || !err.safeToRetry) throw err;

    // A stale session and an ambiguous mailbox argument are the two failures
    // worth one more attempt: reconnect, and address the mailbox by its id.
    if (err.status === 409) {
      active = await currentSession(config.token, true);
      if (!active.sendTool) throw err;
    }
    await callSendTool(config.token, active, active.sendTool, mail, config.mailbox, true);
    return { tool: active.sendTool.name };
  }
}

// --- What the Settings screen shows ------------------------------------------

export interface McpProbe {
  ok: boolean;
  /** The tool sending will go through. */
  tool: string | null;
  tools: string[];
  error: string | null;
}

export async function probeMcp(token: string): Promise<McpProbe> {
  try {
    const active = await currentSession(token, true);
    return {
      ok: Boolean(active.sendTool),
      tool: active.sendTool?.name ?? null,
      tools: active.tools.map((tool) => tool.name),
      error: active.sendTool ? null : "The MCP server connected but published no tool that sends mail.",
    };
  } catch (err) {
    return { ok: false, tool: null, tools: [], error: (err as Error).message };
  }
}

// --- Sending -----------------------------------------------------------------

/** Everything the API takes has to be base64 in a JSON body, including linked files. */
async function encodeAttachments(attachments: Attachment[]): Promise<OutgoingMail["attachments"]> {
  const encoded: OutgoingMail["attachments"] = [];

  for (const attachment of attachments) {
    let buffer: Buffer | null = attachment.content ?? null;

    if (!buffer && attachment.path) {
      const response = await fetch(attachment.path).catch((err: Error) => {
        throw new HostingerMailError(502, `Could not fetch the attachment ${attachment.filename}: ${err.message}`, true);
      });
      if (!response.ok) {
        throw new HostingerMailError(502, `Could not fetch the attachment ${attachment.filename} (${response.status}).`, true);
      }
      buffer = Buffer.from(await response.arrayBuffer());
    }

    if (!buffer) continue;
    if (buffer.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new HostingerMailError(400, `${attachment.filename} is too large to send as an attachment.`, true);
    }
    encoded.push({
      filename: attachment.filename,
      content: buffer.toString("base64"),
      ...(attachment.contentType ? { contentType: attachment.contentType } : {}),
      // Inline artwork: the API links it to `<img src="cid:…">` the same way
      // nodemailer does, so the letterhead survives both transports.
      ...(attachment.cid ? { cid: attachment.cid } : {}),
    });
  }

  return encoded;
}

export interface HostingerSendResult {
  messageId: string | null;
  accepted: string[];
  /** Which path carried it, for the log line and the Settings screen. */
  via: "mcp" | "api";
  tool: string | null;
}

export async function sendViaHostinger(args: SendArgs): Promise<HostingerSendResult> {
  const config = await readHostingerConfig();
  if (!config) {
    throw new HostingerMailError(503, "Hostinger Mail isn't connected yet — paste the API token under Settings → Email.");
  }

  const mail: OutgoingMail = {
    to: [args.to],
    cc: args.cc ?? [],
    bcc: args.bcc ?? [],
    subject: args.subject,
    text: args.text,
    html: args.html,
    displayName: config.fromName,
    attachments: await encodeAttachments(args.attachments ?? []),
  };

  let mcpFailure: HostingerMailError | null = null;
  try {
    const { tool } = await sendOverMcp(config, mail);
    // Neither path returns a Message-ID — Hostinger answers a send with no body
    // — so nothing is invented here. Threading falls back to subject matching.
    return { messageId: null, accepted: [args.to, ...mail.cc, ...mail.bcc], via: "mcp", tool };
  } catch (err) {
    if (!(err instanceof HostingerMailError) || !err.safeToRetry) throw err;
    mcpFailure = err;
  }

  try {
    await api(config.token, `/api/v1/mailboxes/${encodeURIComponent(config.mailbox.resourceId)}/send`, {
      method: "POST",
      body: {
        to: mail.to,
        ...(mail.cc.length ? { cc: mail.cc } : {}),
        ...(mail.bcc.length ? { bcc: mail.bcc } : {}),
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
        displayName: mail.displayName,
        ...(mail.attachments.length ? { attachments: mail.attachments } : {}),
      },
    });
    return { messageId: null, accepted: [args.to, ...mail.cc, ...mail.bcc], via: "api", tool: null };
  } catch (err) {
    // Both paths failed. The MCP reason is the more useful one to lead with,
    // because it is the one the Owner chose and the one they can act on.
    const detail = err instanceof HostingerMailError ? err.message : (err as Error).message;
    throw new HostingerMailError(
      err instanceof HostingerMailError ? err.status : 502,
      `${mcpFailure.message} The Mail API then failed too: ${detail}`,
    );
  }
}
