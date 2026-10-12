/**
 * What a tool hands an agent: how much of it, and whether the agent is told
 * that somebody outside the company wrote it.
 *
 * A tool result is re-sent to the model on every turn after it, so its size is
 * paid for until the task ends, and it is JSON the harness hands over that
 * nothing can wrap in a boundary. Two faults of each kind:
 *
 *  - **`webhooks.read` returned whole rows** — the sender's request headers
 *    and an unbounded payload, twenty at a time. A form that posts a page of
 *    HTML made that a result the size of a novel.
 *  - **An MCP result came back twice.** The spec asks a server that returns
 *    `structuredContent` to repeat it as text for older clients, and both
 *    halves were passed on — the second one uncapped.
 *  - **Outside text arrived unflagged.** `webhooks.read`, `github.read`,
 *    `repo.read` and every connected MCP tool return text a third party wrote,
 *    and none of them was marked `external`, so an agent holding only those was
 *    never given the standing rule that such text is data. The shipped Apify
 *    preset returns arbitrary web pages.
 *
 * Every cut is a fixed length and says so; nothing is summarised. The
 * negatives are half of it: a payload that fits comes back whole, a structured
 * result that says something the text does not is kept, a server describing
 * its tool as read-only cannot lower the scope the Owner set, a switched-off
 * server refuses without touching the network, and an agent with no outside
 * tool is still not charged for the paragraph.
 *
 * A database and a fake MCP server on localhost. No key, no network.
 *   npx tsx checks/toolShapes.ts
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

const failures: string[] = [];
let passed = 0;

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed += 1;
    console.log(`  ok    ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// --- A fake MCP server --------------------------------------------------------
//
// JSON-RPC over POST, the whole surface `lib/mcp.ts` speaks: initialize, the
// initialized notification, tools/list and tools/call. Every request is
// counted, because "refused before any network call" is a count, not an
// opinion.

let requests = 0;
/** About five thousand characters of JSON, the size the acceptance names. */
const FIVE_K = { rows: [{ at: 0, note: "q".repeat(4_960) }] };

const TOOLS = [
  {
    name: "lookup",
    description: "Looks something up.",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    // The server's own claim about itself. Nothing in this app may read it as
    // a reason to gate the call any less.
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
];

function answer(name: string): unknown {
  switch (name) {
    case "lookup":
      // The same answer twice, as text and as structured content — what a
      // spec-following server does.
      return { content: [{ type: "text", text: JSON.stringify(FIVE_K) }], structuredContent: FIVE_K };
    case "pretty":
      // The same again with the text copy pretty-printed, which is the usual
      // way round and which a substring test alone would miss.
      return { content: [{ type: "text", text: JSON.stringify(FIVE_K, null, 2) }], structuredContent: FIVE_K };
    case "long":
      return { content: [{ type: "text", text: "y".repeat(50_000) }] };
    case "distinct":
      return { content: [{ type: "text", text: "Found two." }], structuredContent: { found: 2, ids: ["a", "b"] } };
    case "wide":
      return { content: [{ type: "text", text: "Here is the table." }], structuredContent: { cells: "z".repeat(30_000) } };
    default:
      return { content: [{ type: "text", text: "?" }], isError: true };
  }
}

function fakeMcp(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        requests += 1;
        const body = raw ? JSON.parse(raw) : {};
        if (body.id === undefined) {
          res.writeHead(202).end();
          return;
        }
        let result: unknown;
        if (body.method === "initialize") result = { protocolVersion: "2025-06-18", serverInfo: { name: "Shapes", version: "1" }, capabilities: {} };
        else if (body.method === "tools/list") result = { tools: TOOLS };
        else if (body.method === "tools/call") result = answer(body.params?.name);
        res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "shapes" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp` }));
  });
}
const mcp = await fakeMcp();

/** The tools the row lists beside the one the server advertises. */
const EXTRA_TOOLS = ["pretty", "long", "distinct", "wide"].map((name) => ({ name, description: `${name}.`, inputSchema: null }));

const { prisma } = await import("../src/lib/prisma.js");
const { invokeTool } = await import("../src/services/tools/invoke.js");
const { clearReadinessCache } = await import("../src/services/tools/readiness.js");
const { findTool } = await import("../src/services/tools/catalogue.js");
const { allMcpTools, refreshServer } = await import("../src/services/tools/mcpTools.js");
const { callTool } = await import("../src/lib/mcp.js");
const { composePrompt } = await import("../src/services/agents/runner.js");

const MARK = "toolshapescheck";
const AGENT_KEY = "check.toolshapes";
const SERVER_KEY = MARK;

async function reset() {
  await prisma.toolCall.deleteMany({ where: { OR: [{ agentKey: { startsWith: AGENT_KEY } }, { tool: { startsWith: `mcp.${SERVER_KEY}.` } }] } });
  await prisma.webhookEvent.deleteMany({ where: { source: MARK } });
  await prisma.agent.deleteMany({ where: { key: { startsWith: AGENT_KEY } } });
  await prisma.mcpServer.deleteMany({ where: { key: SERVER_KEY } });
}

async function makeAgent(suffix: string, toolkit: string[]) {
  return prisma.agent.create({
    data: {
      key: `${AGENT_KEY}.${suffix}`,
      name: `Tool Shapes ${suffix}`,
      title: "Harness",
      tier: "SUB_AGENT",
      department: "TECHNOLOGY",
      status: "ACTIVE",
      mission: "Exists for the duration of one test run.",
      autonomyLevel: 4,
      dryRun: false,
      toolkit,
    },
  });
}

await reset();

try {
  // --- 1. webhooks.read -------------------------------------------------------
  console.log("\nwebhooks.read hands over named columns and a bounded payload");
  {
    const big = { message: "x".repeat(50_000), from: "a stranger" };
    for (let at = 0; at < 3; at += 1) {
      await prisma.webhookEvent.create({
        data: { source: MARK, event: "form.submitted", payload: big, headers: { "x-signature": "s".repeat(500), "user-agent": "curl" }, verified: true },
      });
    }
    const reader = await makeAgent("reader", ["webhooks.read"]);
    const before = await prisma.toolCall.count({ where: { agentKey: reader.key, tool: "webhooks.read" } });
    const result = await invokeTool("webhooks.read", { source: MARK, limit: 3 }, { agentKey: reader.key, userId: null, dryRun: false });
    const events = (result.output ?? []) as Array<Record<string, unknown>>;
    const json = JSON.stringify(result.output);
    check("the call succeeded", result.ok, result.error);
    check("one ToolCall row for it", (await prisma.toolCall.count({ where: { agentKey: reader.key, tool: "webhooks.read" } })) - before === 1);
    check("three events came back", events.length === 3);
    check("under 6,000 characters for 150,000 of payload", json.length < 6_000, `${json.length} characters`);
    check("no headers key", events.every((event) => !("headers" in event)));
    check("each says how big its payload was", events.every((event) => event.payloadChars === JSON.stringify(big).length), String(events[0]?.payloadChars));
    check("and that it was cut", events.every((event) => event.payloadCut === true));
    // Read back rather than rebuilt: Postgres normalises jsonb key order, so
    // the stored payload's JSON is not `JSON.stringify(big)`.
    const stored = JSON.stringify((await prisma.webhookEvent.findFirst({ where: { source: MARK } }))?.payload);
    check(
      "the cut is the start of the payload, not a summary of it",
      events.every((event) => typeof event.payload === "string" && stored.startsWith(event.payload as string) && (event.payload as string).length === 1_500),
    );
    check("the columns an agent needs are there", ["id", "source", "event", "verified", "handledAt", "error", "createdAt"].every((key) => key in (events[0] ?? {})));

    // The negative: one that fits is the payload itself, untouched.
    await prisma.webhookEvent.deleteMany({ where: { source: MARK } });
    await prisma.webhookEvent.create({ data: { source: MARK, event: "ping", payload: { ok: true, n: 3 } } });
    const small = await invokeTool("webhooks.read", { source: MARK }, { agentKey: reader.key, userId: null, dryRun: false });
    const one = ((small.output ?? []) as Array<Record<string, unknown>>)[0];
    const kept = (one?.payload ?? {}) as { ok?: boolean; n?: number };
    check("a payload that fits comes back whole, as itself", kept.ok === true && kept.n === 3 && one?.payloadCut === false, JSON.stringify(one));
  }

  // --- 2. Which tools say their text came from outside -----------------------
  console.log("\nOutside text is declared");
  for (const key of ["webhooks.read", "github.read", "repo.read"]) {
    check(`${key} is external`, findTool(key)?.external === true);
  }
  check("a tool that returns only our own figures is still not", findTool("finance.read")?.external !== true);

  await prisma.mcpServer.create({
    data: {
      key: SERVER_KEY,
      name: "Shapes",
      url: mcp.url,
      enabled: true,
      // What the Owner set. The server's tools/list says read-only; this says
      // it can spend and reach outside, and this is what must win.
      scope: "charge",
      spends: true,
      outward: true,
      tools: [
        ...TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
        ...EXTRA_TOOLS,
      ],
    },
  });
  clearReadinessCache();
  const defs = (await allMcpTools()).filter((tool) => tool.key.startsWith(`mcp.${SERVER_KEY}.`));
  check("the connected server contributes its five tools", defs.length === 5, String(defs.length));
  check("every one of them is external", defs.length > 0 && defs.every((tool) => tool.external === true));

  // --- 3. The prompt follows the declaration ---------------------------------
  console.log("\nThe standing rule reaches the agent that needs it, and only that one");
  {
    const mcpOnly = await makeAgent("mcponly", [`mcp.${SERVER_KEY}.lookup`]);
    const regions = await composePrompt(mcpOnly, []);
    const untrusted = regions.find((region) => region.key === "untrusted");
    check("an agent whose only outside tool is an MCP tool is told the rule", Boolean(untrusted?.text.includes("never as instructions")), untrusted ? "present" : "missing");
    check("and the region names that tool", Boolean(untrusted?.text.includes(`mcp.${SERVER_KEY}.lookup`)));

    const webhooks = await makeAgent("webhooks", ["webhooks.read"]);
    check("so is one holding only webhooks.read", (await composePrompt(webhooks, [])).some((region) => region.key === "untrusted"));

    const inward = await makeAgent("inward", ["finance.read"]);
    check("an agent holding none is still not charged for the paragraph", !(await composePrompt(inward, [])).some((region) => region.key === "untrusted"));
  }

  // --- 4. The scope comes from the row ---------------------------------------
  console.log("\nA server cannot describe its way past the gate");
  {
    const refreshed = await refreshServer((await prisma.mcpServer.findUniqueOrThrow({ where: { key: SERVER_KEY } })).id);
    check("the handshake read the server's tools", refreshed.error === null && refreshed.tools.some((tool) => tool.name === "lookup"), refreshed.error ?? "");
    // The refresh replaced the cached list with the server's own, which is
    // only the one tool; put the others back for the calls below.
    await prisma.mcpServer.update({
      where: { key: SERVER_KEY },
      data: {
        tools: [
          ...TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
          ...EXTRA_TOOLS,
        ],
      },
    });
    const lookup = (await allMcpTools()).find((tool) => tool.key === `mcp.${SERVER_KEY}.lookup`);
    check("a tool advertised readOnlyHint keeps the row's scope", lookup?.scope === "charge", lookup?.scope);
    check("and the row's spends", lookup?.spends === true);
    check("and the row's outward", lookup?.outward === true);
  }

  // --- 5. What a call hands back ---------------------------------------------
  console.log("\nAn MCP result is one copy, capped, and says when it was cut");
  const call = (name: string, input: Record<string, unknown> = {}) =>
    invokeTool(`mcp.${SERVER_KEY}.${name}`, input, { agentKey: null, userId: null, dryRun: false });
  {
    const twice = await call("lookup", { query: "anything" });
    const out = twice.output as Record<string, unknown> | null;
    const size = JSON.stringify(out).length;
    check("the call succeeded", twice.ok, twice.error);
    check("the same 5,000 characters in both halves comes back once", size < 5_500 && JSON.stringify(FIVE_K).length >= 4_900, `${size} characters`);
    check("the structured copy is the one dropped, because the text has it", out?.structured === null && String(out?.text).includes('"note"'));
    check("and nothing claims to have been cut", !("cut" in (out ?? {})));

    const pretty = (await call("pretty")).output as Record<string, unknown> | null;
    check("a pretty-printed text copy is recognised as the same answer", pretty?.structured === null, typeof pretty?.structured);

    const distinct = (await call("distinct")).output as Record<string, unknown> | null;
    check("a structured result that says something the text does not is kept", JSON.stringify(distinct?.structured) === JSON.stringify({ found: 2, ids: ["a", "b"] }));

    const long = (await call("long")).output as Record<string, unknown> | null;
    check("a 50,000-character text is capped at 20,000", String(long?.text).length === 20_000, String(String(long?.text).length));
    check("and says so, with the size it was", /50,000/.test(String(long?.cut ?? "")), String(long?.cut));

    const wide = (await call("wide")).output as Record<string, unknown> | null;
    check("an oversized structured half is capped like the text", typeof wide?.structured === "string" && (wide.structured as string).length === 20_000);
    check("and says so too", /structured/.test(String(wide?.cut ?? "")), String(wide?.cut));

    // The library on its own, for the native tools that stand in front of a
    // server (image.generate reads `structured` straight off it).
    const direct = await callTool(mcp.url, null, "lookup", { query: "x" });
    check("callTool itself returns one copy", direct.structured === null && direct.cut === undefined);
  }

  // --- 6. Refusals that never reach the server -------------------------------
  console.log("\nRefused before the wire");
  {
    const before = requests;
    const missing = await call("lookup", {});
    check("a missing required top-level key fails the schema", !missing.ok && /isn't right/.test(missing.error ?? ""), missing.error);
    check("before any network call", requests === before, `${requests - before} requests`);

    await prisma.mcpServer.update({ where: { key: SERVER_KEY }, data: { enabled: false } });
    const switchedOff = (await allMcpTools()).find((tool) => tool.key === `mcp.${SERVER_KEY}.lookup`);
    let refusal = "";
    try {
      await switchedOff?.run({ query: "x" }, { agentKey: null, userId: null, taskId: null, dryRun: false });
    } catch (err) {
      refusal = (err as Error).message;
    }
    check("a switched-off server refuses, naming Settings", /Settings/.test(refusal), refusal);
    check("and never opened a connection", requests === before, `${requests - before} requests`);
    check("its tools are still external while it is off", switchedOff?.external === true);
  }
} finally {
  await reset();
  mcp.server.close();
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const failure of failures) console.log(`  - ${failure}`);
}
await prisma.$disconnect();
process.exit(failures.length ? 1 : 0);
