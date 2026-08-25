import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_SEEDS, PROMPT_LAYERS } from "./src/services/agentRegistry.js";
import { TOOLS } from "./src/services/tools/catalogue.js";
import { WRITER_JOBS } from "./src/services/writers/registry.js";
import { JOBS } from "./src/lib/models/registry.js";

/**
 * Builds "How the Workforce Runs" — the operating picture of the agent system.
 *
 * Where `build-workflow-doc.ts` describes the *business* flow (a stranger to a
 * renewed retainer) and `build-reference-doc.ts` prints every instruction in
 * full, this one describes the *machine*: what an agent is, what it may call,
 * what happens between a task being raised and a person reading the result,
 * and everything that runs on the clock without anybody asking.
 *
 * Every number in it is read out of the code it describes. Re-run after any
 * change to the roster, the catalogue, the writer registry or the model jobs.
 *
 *   npx tsx build-operations-doc.ts
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "docs", "workflow");
const OUT = process.argv[2] ?? path.join(HERE, "docs", "agent-operations.html");

const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const OUTWARD = TOOLS.filter((t) => t.outward).length;
const SPENDING = TOOLS.filter((t) => t.spends).length;
const GROUPS = [...new Set(TOOLS.map((t) => t.group))];

const TIER_LABEL: Record<string, string> = {
  BOARD: "Board",
  EXECUTIVE: "Executive",
  FUNCTIONAL: "Governance",
  OPERATIONAL: "Operational",
  SUB_AGENT: "Specialist",
};
const DEPT_LABEL: Record<string, string> = {
  EXECUTIVE: "Executive",
  REVENUE: "Revenue",
  DELIVERY: "Delivery",
  FINANCE: "Finance",
  MARKETING: "Marketing",
  TECHNOLOGY: "Technology",
  CLIENT: "Client Success",
  RISK: "Risk &amp; Quality",
  PEOPLE: "Agent Ops",
};
const REQUIRES_LABEL: Record<string, string> = {
  database: "None — our own data",
  models: "A model key",
  claude: "Anthropic key",
  apify: "Apify token",
  email: "A mailbox",
  slack: "Slack",
  stripe: "Stripe",
  cloudinary: "Cloudinary",
  google: "Google account",
  calendar: "Google + calendar scope",
  github: "GitHub token",
  webhooks: "None — self-configuring",
  mcp: "A connected MCP server",
  paystack: "Paystack",
  hubtel: "Hubtel",
  whatsapp: "WhatsApp Business",
  hubtelSms: "Hubtel SMS",
};

const toolByKey = new Map(TOOLS.map((t) => [t.key, t]));
const chip = (key: string) => {
  const t = toolByKey.get(key);
  const kind = !t ? "none" : t.spends ? "spend" : t.outward ? "out" : "";
  return `<span class="${kind}">${esc(key)}</span>`;
};

// --- Generated tables -------------------------------------------------------

function tierTable(): string {
  const note: Record<string, string> = {
    BOARD: "Sets direction. Produces a decision, never a deliverable.",
    EXECUTIVE: "Owns a function end to end and answers for its numbers.",
    FUNCTIONAL: "Governs how the work is done rather than doing it.",
    OPERATIONAL: "Runs one stage of the business, day to day.",
    SUB_AGENT: "One craft, one deliverable. The ones who make the thing.",
  };
  const rows = ["BOARD", "EXECUTIVE", "FUNCTIONAL", "OPERATIONAL", "SUB_AGENT"].map((tier) => {
    const list = AGENT_SEEDS.filter((a) => a.tier === tier);
    return `<tr>
      <td style="width:26mm"><b>${TIER_LABEL[tier]}</b></td>
      <td class="num" style="width:14mm">${list.length}</td>
      <td style="width:54mm;font-size:8.2pt;color:var(--muted)">${esc(note[tier])}</td>
      <td style="font-size:8pt">${esc(list.slice(0, 5).map((a) => a.name).join(" · "))}${list.length > 5 ? " …" : ""}</td>
    </tr>`;
  });
  return `<table><tr><th>Tier</th><th class="num">Agents</th><th>What the tier is for</th><th>Who is in it</th></tr>${rows.join("")}</table>`;
}

function deptTable(): string {
  const depts = [...new Set(AGENT_SEEDS.map((a) => a.department))];
  const rows = depts.map((d) => {
    const list = AGENT_SEEDS.filter((a) => a.department === d);
    return `<tr><td style="width:32mm"><b>${DEPT_LABEL[d] ?? d}</b></td><td class="num" style="width:14mm">${list.length}</td><td style="font-size:8pt">${esc(list.map((a) => a.name).join(" · "))}</td></tr>`;
  });
  return `<table><tr><th>Department</th><th class="num">Agents</th><th>The roster</th></tr>${rows.join("")}</table>`;
}

const LAYER_NOTE: Record<string, [string, string]> = {
  role: ["Role", "Who the agent is, and what Dakyworld is. The only layer that says &ldquo;you are&rdquo;."],
  mission: ["Mission", "The one thing it exists to produce. Matches the mission on its card."],
  scope: ["Scope", "What is inside its craft — and the instruction to hand back anything that is not."],
  dataRules: ["Data rules", "What it may treat as fact. Shared wording: observed and inferred stay apart, and nothing is invented."],
  tools: ["Tools", "That the grant is the limit. The invoker enforces it whatever this layer says."],
  policy: ["Policy", "What it may never do on its own. Usually its escalation policy, stated to the model."],
  process: ["Process", "How it works through a task. The longest layer, and the one worth editing first."],
  escalateWhen: ["Escalate when", "The conditions under which it must stop and ask rather than proceed."],
  output: ["Output", "The shape of what it hands back, so a person can tell whether it is finished."],
  memory: ["Memory", "What it may keep between tasks. Shared wording: decisions and reasons, never secrets."],
};

function layerTable(): string {
  const rows = PROMPT_LAYERS.map((layer, i) => {
    const [label, note] = LAYER_NOTE[layer] ?? [layer, ""];
    return `<tr>
      <td class="num mono" style="width:9mm;color:var(--blue);font-size:8pt">${i + 1}</td>
      <td style="width:30mm"><b>${label}</b><div class="mono" style="font-size:6.8pt;color:var(--muted)">${esc(layer)}</div></td>
      <td>${note}</td>
    </tr>`;
  });
  return `<table><tr><th></th><th>Layer</th><th>What it governs</th></tr>${rows.join("")}</table>`;
}

function groupTable(): string {
  const rows = GROUPS.map((g) => {
    const list = TOOLS.filter((t) => t.group === g);
    return `<tr>
      <td style="width:24mm"><b>${esc(g)}</b></td>
      <td class="num" style="width:12mm">${list.length}</td>
      <td class="num" style="width:16mm">${list.filter((t) => t.outward).length}</td>
      <td class="num" style="width:14mm">${list.filter((t) => t.spends).length}</td>
      <td><div class="tools">${list.map((t) => chip(t.key)).join("")}</div></td>
    </tr>`;
  });
  return `<table><tr><th>Group</th><th class="num">Tools</th><th class="num">Outward</th><th class="num">Spends</th><th>Keys</th></tr>${rows.join("")}
  <tr class="total"><td>Total</td><td class="num">${TOOLS.length}</td><td class="num">${OUTWARD}</td><td class="num">${SPENDING}</td><td></td></tr></table>`;
}

function writerTable(): string {
  const rows = (WRITER_JOBS as ReadonlyArray<{ key: string; label: string; agentKey: string; what?: string }>).map((w) => {
    const owner = AGENT_SEEDS.find((a) => a.key === w.agentKey);
    return `<tr>
      <td style="width:30mm"><b>${esc(w.label)}</b><div class="mono" style="font-size:6.8pt;color:var(--muted)">${esc(w.key)}</div></td>
      <td style="width:36mm">${esc(owner?.name ?? w.agentKey)}<div class="mono" style="font-size:6.8pt;color:var(--muted)">${esc(w.agentKey)}</div></td>
      <td style="font-size:8.2pt;color:var(--muted)">${esc(w.what ?? "")}</td>
    </tr>`;
  });
  return `<table><tr><th>What gets written</th><th>Whose instruction writes it</th><th>What editing that instruction changes</th></tr>${rows.join("")}</table>`;
}

function modelJobTable(): string {
  const rows = Object.entries(JOBS as Record<string, { name: string; blurb: string; defaultProvider: string; fallback?: string }>).map(
    ([key, job]) => `<tr>
      <td style="width:26mm"><b>${esc(job.name)}</b><div class="mono" style="font-size:6.8pt;color:var(--muted)">${esc(key)}</div></td>
      <td class="mono" style="width:30mm;font-size:7.6pt">${esc(job.defaultProvider)}${job.fallback ? ` <span style="color:var(--muted)">→ ${esc(job.fallback)}</span>` : ""}</td>
      <td style="font-size:8.2pt;color:var(--muted)">${esc(job.blurb)}</td>
    </tr>`,
  );
  return `<table><tr><th>Job</th><th>Default → fallback</th><th>What it covers</th></tr>${rows.join("")}</table>`;
}

function rosterTable(): string {
  const order = ["BOARD", "EXECUTIVE", "FUNCTIONAL", "OPERATIONAL", "SUB_AGENT"];
  const rows: string[] = [];
  for (const tier of order) {
    const list = AGENT_SEEDS.filter((s) => s.tier === tier);
    if (list.length === 0) continue;
    rows.push(
      `<tr><td colspan="3" style="border-bottom:1px solid var(--ink);padding-top:4mm"><b class="mono" style="letter-spacing:.12em;text-transform:uppercase;font-size:7.4pt;color:var(--muted)">${TIER_LABEL[tier] ?? tier}</b></td></tr>`,
    );
    for (const seed of list) {
      const boss = seed.managerKey ? AGENT_SEEDS.find((a) => a.key === seed.managerKey)?.name : null;
      rows.push(`<tr>
        <td style="width:42mm"><b>${esc(seed.name)}</b>
          <div class="mono" style="font-size:6.8pt;color:var(--muted)">${esc(seed.key)}</div>
          <div style="font-size:7.2pt;color:var(--muted)">${DEPT_LABEL[seed.department] ?? seed.department}${boss ? ` · to ${esc(boss)}` : ""}</div></td>
        <td style="width:50mm;font-size:8.2pt">${esc(seed.mission)}</td>
        <td><div class="tools">${seed.toolkit.map(chip).join("")}</div></td>
      </tr>`);
    }
  }
  return `<table><tr><th>Agent</th><th>Mission</th><th>Seeded toolkit</th></tr>${rows.join("")}</table>
  <div class="legend" style="margin-top:3mm">
    <span><span class="mono" style="border:1px solid var(--line);background:var(--cream);padding:.4mm 1.6mm;font-size:7.4pt">read only</span> runs at any level</span>
    <span><span class="mono" style="border:1px solid var(--blue-light);background:#EEF2FF;padding:.4mm 1.6mm;font-size:7.4pt">outward</span> needs level 3</span>
    <span><span class="mono" style="border:1px solid #F0C77E;background:#FEF6E7;padding:.4mm 1.6mm;font-size:7.4pt">spends</span> needs level 4</span>
  </div>`;
}

function catalogueTable(): string {
  const rows: string[] = [];
  for (const group of GROUPS) {
    rows.push(
      `<tr><td colspan="4" style="border-bottom:1px solid var(--ink);padding-top:4mm"><b class="mono" style="letter-spacing:.12em;text-transform:uppercase;font-size:7.4pt;color:var(--muted)">${esc(group)}</b></td></tr>`,
    );
    for (const tool of TOOLS.filter((t) => t.group === group)) {
      const held = AGENT_SEEDS.filter((a) => a.toolkit.includes(tool.key)).length;
      const marks = [
        tool.outward ? '<span class="out">outward</span>' : "",
        tool.spends ? '<span class="spend">spends</span>' : "",
        tool.preview ? "<span>preview</span>" : "",
      ]
        .filter(Boolean)
        .join("");
      rows.push(`<tr>
        <td style="width:32mm"><span class="mono" style="font-size:7.6pt"><b>${esc(tool.key)}</b></span></td>
        <td style="width:52mm;font-size:8.2pt">${esc(tool.purpose)}</td>
        <td style="width:26mm;font-size:7.6pt;color:var(--muted)">${REQUIRES_LABEL[tool.requires] ?? esc(tool.requires)}</td>
        <td><div class="tools">${marks || '<span class="none">read only</span>'}</div><div style="font-size:7pt;color:var(--muted);margin-top:.8mm">held by ${held}</div></td>
      </tr>`);
    }
  }
  const orphans = TOOLS.filter((t) => !AGENT_SEEDS.some((a) => a.toolkit.includes(t.key)));
  const note = orphans.length
    ? `<div class="callout warn"><h4>${orphans.length} tools sit in nobody&rsquo;s seeded toolkit</h4>
       <p>They exist, they are gated, and no agent can reach one. That is the ordinary consequence of <code>ensureAgents()</code> only ever creating: a tool added after an agent was seeded does not join its grant. It is also the list to work down the day an agent reports that something cannot be done.</p>
       <p class="mono" style="font-size:7.4pt">${orphans.map((t) => esc(t.key)).join(" · ")}</p></div>`
    : "";
  return `<table><tr><th>Key</th><th>What it does</th><th>Needs</th><th>Gate &amp; reach</th></tr>${rows.join("")}</table>${note}`;
}

// --- Assembly ---------------------------------------------------------------

const brand = JSON.parse(fs.readFileSync(path.join(SRC, "brand.json"), "utf8")) as Record<string, string>;

/**
 * The brand faces, embedded rather than linked.
 *
 * Chrome's print path finishes before a linked Google Font arrives, and the
 * first document built this way shipped with Segoe UI in every heading. A PDF
 * is the artefact, not a view of one, so the fonts have to be inside it.
 */
function fontFaces(): string {
  const faces = JSON.parse(fs.readFileSync(path.join(SRC, "fonts", "faces.json"), "utf8")) as Array<{ family: string; b64: string }>;
  if (faces.length === 0) throw new Error("No embedded fonts — run the fetch in docs/workflow/fonts first.");
  return `<style>\n${faces
    .map((f) => `@font-face{font-family:'${f.family}';font-style:normal;font-weight:400 700;font-display:block;src:url(data:font/woff2;base64,${f.b64}) format('woff2');}`)
    .join("\n")}\n</style>`;
}

const body = fs.readFileSync(path.join(SRC, "operations-body.html"), "utf8");
const head = fs.readFileSync(path.join(SRC, "operations-head.html"), "utf8");

const TOKENS: Record<string, string> = {
  __FONTS__: fontFaces(),
  __LOGO_DARK__: brand.logoDark,
  __AGENTCOUNT__: String(AGENT_SEEDS.length),
  __TOOLCOUNT__: String(TOOLS.length),
  __OUTWARD__: String(OUTWARD),
  __SPENDING__: String(SPENDING),
  __GROUPCOUNT__: String(GROUPS.length),
  __LAYERCOUNT__: String(PROMPT_LAYERS.length),
  __WRITERCOUNT__: String((WRITER_JOBS as ReadonlyArray<unknown>).length),
  __MODELJOBCOUNT__: String(Object.keys(JOBS).length),
  __BUILTDATE__: new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }),
  __TIERTABLE__: tierTable(),
  __DEPTTABLE__: deptTable(),
  __LAYERTABLE__: layerTable(),
  __GROUPTABLE__: groupTable(),
  __WRITERTABLE__: writerTable(),
  __MODELJOBTABLE__: modelJobTable(),
  __ROSTERTABLE__: rosterTable(),
  __CATALOGUETABLE__: catalogueTable(),
};

let html = head + "\n" + body + "\n</body>\n</html>\n";
for (const [token, value] of Object.entries(TOKENS)) html = html.split(token).join(value);

for (const token of Object.keys(TOKENS)) {
  if (html.includes(token)) throw new Error(`${token} was never substituted — the document would ship with a hole in it.`);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, html);
console.log(`wrote ${OUT} — ${(html.length / 1024).toFixed(0)} KB, ${AGENT_SEEDS.length} agents, ${TOOLS.length} tools`);
process.exit(0);
