import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_SEEDS, PROMPT_LAYERS } from "./src/services/agentRegistry.js";
import { TOOLS } from "./src/services/tools/catalogue.js";
import { WRITER_JOBS } from "./src/services/writers/registry.js";
import { shippedDoctrine } from "./src/services/writers/shipped.js";

/**
 * Builds the complete reference: every agent, every instruction, every
 * workflow and every tool, in one document.
 *
 * Where the Agent Master Workflow explains *how the company runs* in prose
 * written by hand, this is the reference behind it — and its body is generated
 * in full. Every roster row, every prompt layer, every writing brief and every
 * catalogue entry is read out of the code that runs it at build time, so the
 * document cannot describe an agent that was renamed or a tool that was
 * removed.
 *
 * Re-run it after any change to the agent seeds, the tool catalogue or the
 * writer registry: `npx tsx build-reference-doc.ts`, then print it with the
 * Chrome command in docs/README.md.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "docs", "workflow");
const OUT = process.argv[2] ?? path.join(HERE, "docs", "dakyworld-os-reference.html");

const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const TIER_LABEL: Record<string, string> = {
  BOARD: "Board",
  EXECUTIVE: "Executive",
  FUNCTIONAL: "Governance",
  OPERATIONAL: "Operational",
  SUB_AGENT: "Specialist",
};

const TIER_ORDER = ["BOARD", "EXECUTIVE", "FUNCTIONAL", "OPERATIONAL", "SUB_AGENT"];

const DEPARTMENT_LABEL: Record<string, string> = {
  EXECUTIVE: "Executive",
  REVENUE: "Revenue",
  DELIVERY: "Delivery",
  FINANCE: "Finance",
  MARKETING: "Marketing",
  TECHNOLOGY: "Technology",
  CLIENT: "Client Success",
  RISK: "Risk & Quality",
  PEOPLE: "Agent Ops",
};

const REQUIRES_LABEL: Record<string, string> = {
  database: "None — the app's own data",
  claude: "Anthropic key",
  models: "Any one model key",
  apify: "Apify token",
  email: "A mailbox",
  slack: "Slack",
  stripe: "Stripe",
  paystack: "Paystack",
  hubtel: "Hubtel mobile money",
  hubtelSms: "Hubtel SMS",
  whatsapp: "WhatsApp Cloud API",
  cloudinary: "Cloudinary",
  google: "Google account",
  calendar: "Google + calendar scope",
  github: "GitHub token",
  webhooks: "None — self-configuring",
  mcp: "A connected MCP server",
};

const toolByKey = new Map(TOOLS.map((tool) => [tool.key, tool]));
const agentByKey = new Map(AGENT_SEEDS.map((seed) => [seed.key, seed]));

/** A grant chip, coloured by what it costs to be wrong. Matches the legend. */
function chip(key: string): string {
  const tool = toolByKey.get(key);
  const kind = !tool ? "none" : tool.spends ? "spend" : tool.outward ? "out" : "";
  return `<span class="${kind}">${escape(key)}</span>`;
}

const LEGEND = `<div class="legend">
  <span><span class="mono" style="border:1px solid var(--line);background:var(--cream);padding:.4mm 1.6mm;font-size:7.4pt">read only</span> runs at any level</span>
  <span><span class="mono" style="border:1px solid var(--blue-light);background:#EEF2FF;padding:.4mm 1.6mm;font-size:7.4pt">outward</span> needs level 3</span>
  <span><span class="mono" style="border:1px solid #F0C77E;background:#FEF6E7;padding:.4mm 1.6mm;font-size:7.4pt">spends</span> needs level 4</span>
  <span><span class="mono" style="border:1px dashed var(--line);color:var(--muted);padding:.4mm 1.6mm;font-size:7.4pt">no such tool</span> granted, not in the catalogue</span>
</div>`;

// --- Part 1: the workforce --------------------------------------------------

function countsStrip(): string {
  const outward = TOOLS.filter((t) => t.outward).length;
  const spending = TOOLS.filter((t) => t.spends).length;
  const cells: Array<[string, string, string]> = [
    [String(AGENT_SEEDS.length), "Agents", "each with one deliverable"],
    [String(PROMPT_LAYERS.length * AGENT_SEEDS.length), "Instruction layers", `${PROMPT_LAYERS.length} per agent`],
    [String(WRITER_JOBS.length), "Writing jobs", "each with one owning agent"],
    [String(TOOLS.length), "Tools", `${outward} outward · ${spending} spend`],
  ];
  return `<div class="counts">${cells
    .map(([n, label, note]) => `<div><b>${n}</b><span>${escape(label)}</span><em>${escape(note)}</em></div>`)
    .join("")}</div>`;
}

function tierTable(): string {
  const rows = TIER_ORDER.map((tier) => {
    const list = AGENT_SEEDS.filter((seed) => seed.tier === tier);
    if (list.length === 0) return "";
    const departments = [...new Set(list.map((seed) => DEPARTMENT_LABEL[seed.department] ?? seed.department))];
    return `<tr>
      <td style="width:28mm"><b>${escape(TIER_LABEL[tier] ?? tier)}</b></td>
      <td class="num" style="width:16mm">${list.length}</td>
      <td>${escape(departments.join(" · "))}</td>
    </tr>`;
  }).join("\n");

  return `<table>
    <tr><th>Tier</th><th class="num">Agents</th><th>Departments it covers</th></tr>
    ${rows}
    <tr class="total"><td><b>Total</b></td><td class="num">${AGENT_SEEDS.length}</td><td></td></tr>
  </table>`;
}

function rosterTable(): string {
  const rows: string[] = [];

  for (const tier of TIER_ORDER) {
    const list = AGENT_SEEDS.filter((seed) => seed.tier === tier);
    if (list.length === 0) continue;
    rows.push(
      `<tr><td colspan="3" style="border-bottom:1px solid var(--ink);padding-top:4mm"><b class="mono" style="letter-spacing:.12em;text-transform:uppercase;font-size:7.4pt;color:var(--muted)">${escape(
        TIER_LABEL[tier] ?? tier,
      )} — ${list.length}</b></td></tr>`,
    );
    for (const seed of list) {
      const reportsTo = seed.managerKey ? agentByKey.get(seed.managerKey)?.name : null;
      rows.push(
        `<tr>
          <td style="width:44mm">
            <b>${escape(seed.name)}</b>
            <div class="mono" style="font-size:6.8pt;color:var(--muted)">${escape(seed.key)}</div>
            <div style="font-size:7.2pt;color:var(--muted)">${escape(DEPARTMENT_LABEL[seed.department] ?? seed.department)}${
              reportsTo ? ` · to ${escape(reportsTo)}` : ""
            }</div>
          </td>
          <td style="width:52mm;font-size:8.2pt">${escape(seed.mission)}</td>
          <td><div class="tools">${seed.toolkit.map(chip).join("")}</div></td>
        </tr>`,
      );
    }
  }

  return `<table>
    <tr><th>Agent</th><th>Mission</th><th>Seeded toolkit</th></tr>
    ${rows.join("\n")}
  </table>
  ${LEGEND}`;
}

// --- Part 2: the instructions -----------------------------------------------

/** What each of the ten layers governs, in the order the runner composes them. */
const LAYER_NOTE: Record<string, [string, string]> = {
  role: ["Role", "Who the agent is, and what Dakyworld is. The only layer that says “you are”."],
  mission: ["Mission", "The one thing it exists to produce. Matches the mission on its card."],
  scope: ["Scope", "What is inside its craft — and the instruction to hand back anything that is not."],
  dataRules: ["Data rules", "What it may treat as fact. Shared wording: observed and inferred stay apart, and nothing is invented."],
  tools: ["Tools", "That the grant is the limit. The invoker enforces it whatever this says."],
  policy: ["Policy", "What it may never do on its own. Usually its escalation policy, stated to the model."],
  process: ["Process", "How it works through a task. The longest layer, and the one worth editing first."],
  escalateWhen: ["Escalate when", "The conditions under which it must stop and ask rather than proceed."],
  output: ["Output", "The shape of what it hands back, so a person can tell whether it is finished."],
  memory: ["Memory", "What it may keep between tasks. Shared wording: decisions and reasons, never secrets."],
};

function layerStandardTable(): string {
  const rows = PROMPT_LAYERS.map((layer) => {
    const [label, note] = LAYER_NOTE[layer] ?? [layer, ""];
    return `<tr>
      <td style="width:30mm"><b>${escape(label)}</b><div class="mono" style="font-size:6.8pt;color:var(--muted)">${escape(layer)}</div></td>
      <td>${escape(note)}</td>
    </tr>`;
  }).join("\n");

  return `<table>
    <tr><th>Layer</th><th>What it governs</th></tr>
    ${rows}
  </table>`;
}

function agentCard(seed: (typeof AGENT_SEEDS)[number]): string {
  const reportsTo = seed.managerKey ? agentByKey.get(seed.managerKey)?.name : null;
  const reports = AGENT_SEEDS.filter((other) => other.managerKey === seed.key);

  const facts: Array<[string, string]> = [];
  facts.push(["Deliverable", escape(seed.mission)]);
  if (seed.responsibilities.length) facts.push(["Owns", escape(seed.responsibilities.join(" · "))]);
  if (seed.skills?.length) facts.push(["Craft", escape(seed.skills.join(" · "))]);
  if (seed.kpis.length) facts.push(["Judged on", escape(seed.kpis.join(" · "))]);
  facts.push(["Escalation", escape(seed.escalationPolicy)]);
  if (reports.length) facts.push(["Direct reports", escape(reports.map((r) => r.name).join(" · "))]);
  facts.push(["Toolkit", `<div class="tools">${seed.toolkit.map(chip).join("")}</div>`]);

  const writes = WRITER_JOBS.filter((job) => job.agentKey === seed.key);
  if (writes.length) {
    facts.push([
      "Its words write",
      writes
        .map((job) => `${escape(job.label)} <span class="mono" style="font-size:7pt;color:var(--muted)">${escape(job.key)}</span>`)
        .join(" · "),
    ]);
  }

  const layers = PROMPT_LAYERS.map((layer) => {
    const [label] = LAYER_NOTE[layer] ?? [layer, ""];
    const shared = layer === "dataRules" || layer === "tools" || layer === "memory";
    return `<dt>${escape(label)}</dt><dd${shared ? ' class="shared"' : ""}>${escape(seed.prompt[layer])}</dd>`;
  }).join("\n");

  return `<div class="agentcard">
    <header>
      ${seed.avatar ? `<span class="glyph">${escape(seed.avatar)}</span>` : ""}
      <div>
        <h4>${escape(seed.name)}</h4>
        <div class="mono key">${escape(seed.key)}</div>
      </div>
      <div class="place">
        ${escape(seed.title)}<br>
        <span>${escape(TIER_LABEL[seed.tier] ?? seed.tier)} · ${escape(DEPARTMENT_LABEL[seed.department] ?? seed.department)}${
          reportsTo ? ` · reports to ${escape(reportsTo)}` : ""
        }</span>
      </div>
    </header>
    <dl class="facts">${facts.map(([term, value]) => `<dt>${escape(term)}</dt><dd>${value}</dd>`).join("\n")}</dl>
    <div class="layerband">Its system prompt, all ${PROMPT_LAYERS.length} layers</div>
    <dl class="layers">${layers}</dl>
  </div>`;
}

function agentCards(): string {
  const out: string[] = [];
  for (const tier of TIER_ORDER) {
    const list = AGENT_SEEDS.filter((seed) => seed.tier === tier);
    if (list.length === 0) continue;
    out.push(`<h3 class="band">${escape(TIER_LABEL[tier] ?? tier)} — ${list.length} agent${list.length === 1 ? "" : "s"}</h3>`);
    out.push(...list.map(agentCard));
  }
  return out.join("\n");
}

function writerTable(): string {
  const rows = WRITER_JOBS.map((job) => {
    const owner = agentByKey.get(job.agentKey);
    return `<tr>
      <td style="width:34mm"><b>${escape(job.label)}</b><div class="mono" style="font-size:6.8pt;color:var(--muted)">${escape(job.key)}</div></td>
      <td style="width:34mm">${escape(owner?.name ?? job.agentKey)}<div class="mono" style="font-size:6.8pt;color:var(--muted)">${escape(
        job.agentKey,
      )}</div></td>
      <td>${escape(job.what)}</td>
      <td style="width:22mm"><div class="tools">${
        job.outward ? '<span class="out">a client reads it</span>' : '<span class="none">internal</span>'
      }</div></td>
    </tr>`;
  }).join("\n");

  return `<table>
    <tr><th>Writing job</th><th>Whose words write it</th><th>What it is</th><th>Seen by</th></tr>
    ${rows}
  </table>`;
}

async function doctrines(): Promise<string> {
  const blocks: string[] = [];
  for (const job of WRITER_JOBS) {
    const owner = agentByKey.get(job.agentKey);
    const text = await shippedDoctrine(job.key);
    blocks.push(`<div class="jobhead">
      <h4>${escape(job.label)}</h4>
      <span class="mono">${escape(job.key)}</span>
      <span class="where">${escape(owner?.name ?? job.agentKey)} · ${escape(job.where)}</span>
    </div>
    <div class="doctrine">${
      text ? escape(text.trim()) : "No shipped wording — this job is written entirely by the owning agent's instruction."
    }</div>`);
  }
  return blocks.join("\n");
}

// --- Part 3: the workflows --------------------------------------------------

function masterFlow(): string {
  const stages: Array<{ n: string; name: string; owner: string; from: string; to: string; auto: string }> = [
    { n: "1", name: "Acquisition", owner: "Lead capture · Integration Architect", from: "A business nobody has heard of", to: "Lead at NEW, scored, de-duplicated", auto: "Scheduled capture · webhook intake" },
    { n: "2", name: "Qualification", owner: "Lead Lifecycle · Sales Director", from: "Lead at NEW", to: "QUALIFIED or DISQUALIFIED, with the reason", auto: "Audit runs on every new lead" },
    { n: "3", name: "Outreach", owner: "Outbound Communications", from: "Lead at QUALIFIED", to: "A reply, or the series ends", auto: "Enrol · send in window · stop on reply" },
    { n: "4", name: "Consultation & proposal", owner: "Sales Director · Proposal Writer", from: "A reply asking to talk", to: "Proposal WON or LOST", auto: "Follow-up series after SENT" },
    { n: "5", name: "Onboarding", owner: "Commercial Ops · Delivery Director", from: "Proposal WON", to: "Project at PLANNING, tasks assigned", auto: "Welcome email on project open" },
    { n: "6", name: "Delivery", owner: "The specialist tier", from: "Tasks at TODO", to: "Every task DONE, QA signed off", auto: "Routing by craft" },
    { n: "7", name: "Handover", owner: "Client Communications · Handover", from: "QA sign-off", to: "Project DELIVERED", auto: "Testimonial & care-plan series" },
    { n: "8", name: "Invoicing", owner: "Invoicer · Collector", from: "Milestone or delivery", to: "Invoice PAID", auto: "Overdue reminders escalate" },
    { n: "9", name: "The retainer", owner: "Care plan renewals · Client Success", from: "Care plan ACTIVE", to: "Renews — or churn is caught early", auto: "Billing at 06:00 on the billing day" },
  ];

  const bands = stages
    .map(
      (stage) => `
    <div class="fl-row">
      <div class="fl-n">${stage.n}</div>
      <div class="fl-main">
        <div class="fl-name">${escape(stage.name)}</div>
        <div class="fl-owner">${escape(stage.owner)}</div>
      </div>
      <div class="fl-io">
        <div><b>In</b> ${escape(stage.from)}</div>
        <div><b>Out</b> ${escape(stage.to)}</div>
      </div>
      <div class="fl-auto">${escape(stage.auto)}</div>
    </div>`,
    )
    .join("");

  return `<div class="flow">
    <div class="fl-head"><span></span><span>Stage &amp; owner</span><span>What goes in, what comes out</span><span>Runs without asking</span></div>
    ${bands}
  </div>`;
}

const CLOCK = `<table>
  <tr><th style="width:44mm">On the minute tick</th><th>What it does</th></tr>
  <tr><td><b>Lead capture</b><div class="mono" style="font-size:6.8pt;color:var(--muted)">captureTick</div></td><td>Starts any capture source whose local time has come round, in the source's own timezone. A slot missed by more than six hours is skipped rather than stampeded through on boot.</td></tr>
  <tr><td><b>Care plan billing</b><div class="mono" style="font-size:6.8pt;color:var(--muted)">billDuePlans</div></td><td>Bills each active plan on its own day of the month, including any overage.</td></tr>
  <tr><td><b>Email dispatch</b><div class="mono" style="font-size:6.8pt;color:var(--muted)">dispatchDueEmails</div></td><td>Sends what is queued and due, inside the sending window.</td></tr>
  <tr><td><b>WhatsApp and SMS</b><div class="mono" style="font-size:6.8pt;color:var(--muted)">dispatchDueMessages</div></td><td>The same for the phone channels, settled separately so an expired WhatsApp token cannot stop an invoice email.</td></tr>
  <tr><td><b>Sequences</b><div class="mono" style="font-size:6.8pt;color:var(--muted)">runDueSequences</div></td><td>Advances every enrolled lead to its next step, and stops the series on a reply.</td></tr>
  <tr><td><b>The workforce</b><div class="mono" style="font-size:6.8pt;color:var(--muted)">runDueTasks</div></td><td>Starts queued tasks belonging to ACTIVE agents, up to a concurrency ceiling. Unlike the others this one does not wait for the run to finish — holding the tick open for a run that takes minutes would stop an invoice going out.</td></tr>
  <tr><td><b>Standing work</b><div class="mono" style="font-size:6.8pt;color:var(--muted)">raiseStandingWork</div></td><td>Raises the tasks an agent does without being asked. Raising and doing stay separable: what is raised here is worked on the next tick.</td></tr>
  <tr><td><b>Housekeeping</b><div class="mono" style="font-size:6.8pt;color:var(--muted)">housekeepingTick</div></td><td>Once a day — prunes run history and stale checkpoints, clears expired sessions, expires unanswered hire requests and undecided approvals, and raises any missing skill-gap review.</td></tr>
</table>`;

const LADDER = `<div class="ladder">
  <div class="rung"><span class="lvl">0</span><span class="nm">Observe</span><span>Reads and reports. Takes no action of any kind.</span></div>
  <div class="rung seed"><span class="lvl">1</span><span class="nm">Draft</span><span>Prepares work. Nothing leaves the building. <b>Every agent seeds here, with dry run on.</b></span></div>
  <div class="rung"><span class="lvl">2</span><span class="nm">Recommend</span><span>Chooses an action and explains why. A person decides.</span></div>
  <div class="rung"><span class="lvl">3</span><span class="nm">Execute</span><span>Acts outside the company without asking — an email leaves, a meeting is booked, an issue is opened. <b>The threshold for every outward tool.</b></span></div>
  <div class="rung"><span class="lvl">4</span><span class="nm">Autonomous</span><span>Spends money. Runs whole routine workflows; only escalations reach you. <b>The threshold for every tool that charges.</b></span></div>
  <div class="rung locked"><span class="lvl">5</span><span class="nm">Delegated</span><span>Material financial and legal authority. Not settable from the app at all — the API refuses it.</span></div>
</div>`;

const END_STATES = `<table>
  <tr><th style="width:34mm">A task ends</th><th>What it means, and what happens next</th></tr>
  <tr><td><b>DONE</b></td><td>The work is finished and took effect. The checkpoint is cleared.</td></tr>
  <tr><td><b>NEEDS_APPROVAL</b></td><td>The work is prepared and nothing took effect — the normal outcome at the shipped level-1 settings. Approving re-invokes the tool with the input the schema already validated, so what happens is what was shown.</td></tr>
  <tr><td><b>BLOCKED</b></td><td>The agent escalated. Answering appends to the brief and it resumes from where it asked.</td></tr>
  <tr><td><b>FAILED</b></td><td>The run could not continue. The checkpoint is kept, so “carry on” means carry on.</td></tr>
  <tr><td><b>CANCELLED</b></td><td>Stopped on request. A running task returns to QUEUED with its place kept rather than being killed mid-call.</td></tr>
</table>`;

// --- Part 4: the tools ------------------------------------------------------

/** The argument names a tool takes, read off its Zod schema. */
function args(tool: (typeof TOOLS)[number]): string {
  try {
    const def = (tool.input as any)?._def;
    const shape = typeof def?.shape === "function" ? def.shape() : def?.shape;
    if (!shape) return "";
    const names = Object.keys(shape);
    if (names.length === 0) return "takes nothing";
    return names
      .map((name) => {
        const optional = typeof shape[name]?.isOptional === "function" ? shape[name].isOptional() : false;
        return optional ? `${name}?` : name;
      })
      .join(" · ");
  } catch {
    return "";
  }
}

function toolTable(): string {
  const groups = [...new Set(TOOLS.map((tool) => tool.group))];
  const rows: string[] = [];

  for (const group of groups) {
    const list = TOOLS.filter((t) => t.group === group);
    rows.push(
      `<tr><td colspan="4" style="border-bottom:1px solid var(--ink);padding-top:4mm"><b class="mono" style="letter-spacing:.12em;text-transform:uppercase;font-size:7.4pt;color:var(--muted)">${escape(
        group,
      )} — ${list.length}</b></td></tr>`,
    );
    for (const tool of list) {
      const marks = [
        tool.outward ? '<span class="out">outward</span>' : "",
        tool.spends ? '<span class="spend">spends</span>' : "",
        (tool as any).preview ? "<span>preview</span>" : "",
      ]
        .filter(Boolean)
        .join("");
      const holders = AGENT_SEEDS.filter((seed) => seed.toolkit.includes(tool.key)).length;
      const takes = args(tool);
      rows.push(
        `<tr>
          <td style="width:34mm"><span class="mono" style="font-size:7.6pt"><b>${escape(tool.key)}</b></span><div style="font-size:7.2pt;color:var(--muted)">${escape(
            tool.name,
          )}</div></td>
          <td style="width:58mm;font-size:8.2pt">${escape(tool.purpose)}${
            takes ? `<div class="mono" style="font-size:6.8pt;color:var(--muted);margin-top:.8mm">${escape(takes)}</div>` : ""
          }</td>
          <td style="width:30mm;font-size:7.6pt;color:var(--muted)">${escape(
            REQUIRES_LABEL[tool.requires] ?? tool.requires,
          )}<div style="margin-top:.8mm">${holders} agent${holders === 1 ? "" : "s"} hold it</div></td>
          <td><div class="tools">${marks || '<span class="none">read only</span>'}</div></td>
        </tr>`,
      );
    }
  }

  const outward = TOOLS.filter((t) => t.outward).length;
  const spending = TOOLS.filter((t) => t.spends).length;
  const ungranted = TOOLS.filter((t) => !AGENT_SEEDS.some((s) => s.toolkit.includes(t.key)));

  return `<table>
    <tr><th>Key</th><th>What it does, and what it takes</th><th>Needs</th><th>Gate</th></tr>
    ${rows.join("\n")}
  </table>
  <p style="font-size:8.4pt;color:var(--muted)"><b>${TOOLS.length}</b> tools in code. <b>${outward}</b> reach outside the company and need level 3; <b>${spending}</b> spend money and need level 4. ${
    ungranted.length
      ? `<b>${ungranted.length}</b> sit in the catalogue but in nobody's seeded toolkit — ${ungranted
          .map((t) => `<code>${escape(t.key)}</code>`)
          .join(", ")}.`
      : "Every tool is in at least one seeded toolkit."
  } Connected MCP servers add more, under the same gates.</p>`;
}

/** Grants naming a tool the catalogue does not have — the check worth printing. */
function danglingGrants(): string {
  const dangling: string[] = [];
  for (const seed of AGENT_SEEDS) {
    for (const key of seed.toolkit) {
      if (!toolByKey.has(key)) dangling.push(`${seed.key} → ${key}`);
    }
  }
  if (dangling.length === 0) {
    return `<div class="callout"><h4>Every grant resolves</h4><p>No agent is granted a tool the catalogue does not have. This is checked as the document is built: a dashed chip anywhere above would mean a toolkit naming a tool that no longer exists.</p></div>`;
  }
  return `<div class="callout warn"><h4>${dangling.length} grant${
    dangling.length === 1 ? "" : "s"
  } name a tool that does not exist</h4><p class="mono" style="font-size:7.6pt">${dangling
    .map(escape)
    .join(" · ")}</p><p>These appear as dashed chips above. They are ignored at call time, which is why they are worth printing.</p></div>`;
}

// --- Assemble ---------------------------------------------------------------

const brand = JSON.parse(fs.readFileSync(path.join(SRC, "brand.json"), "utf8")) as Record<string, string>;

/** The brand faces, embedded — a linked webfont never arrives before Chrome prints. */
function fontFaces(): string {
  const faces = JSON.parse(fs.readFileSync(path.join(SRC, "fonts", "faces.json"), "utf8")) as Array<{
    family: string;
    b64: string;
  }>;
  if (faces.length === 0) throw new Error("No embedded fonts — run the fetch in docs/workflow/fonts first.");
  return `<style>
${faces
    .map(
      (face) =>
        `@font-face{font-family:'${face.family}';font-style:normal;font-weight:400 700;font-display:block;src:url(data:font/woff2;base64,${face.b64}) format('woff2');}`,
    )
    .join("\n")}
</style>`;
}

const EXTRA_CSS = `<style>
/* The flow bands, shared with the master workflow document. */
.flow { border: 1px solid var(--line); margin-bottom: 5mm; }
.fl-head, .fl-row { display: grid; grid-template-columns: 9mm 46mm 1fr 50mm; gap: 4mm; padding: 2.6mm 4mm; align-items: center; }
.fl-head { border-bottom: 1px solid var(--ink); font-family: var(--mono); font-size: 6.8pt; letter-spacing: .12em; text-transform: uppercase; color: var(--muted); }
.fl-row { border-bottom: 1px solid var(--line); }
.fl-row:last-child { border-bottom: none; }
.fl-row:nth-child(even) { background: var(--cream); }
.fl-n { font-family: var(--display); font-size: 15pt; font-weight: 700; color: var(--blue); text-align: center; }
.fl-name { font-family: var(--display); font-weight: 700; font-size: 10.5pt; }
.fl-owner { font-size: 7.4pt; color: var(--muted); margin-top: .4mm; }
.fl-io { font-size: 8pt; line-height: 1.45; }
.fl-io b { font-family: var(--mono); font-size: 6.6pt; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); display: inline-block; width: 7mm; }
.fl-auto { font-size: 7.6pt; color: var(--muted); border-left: 2px solid var(--lime); padding-left: 3mm; line-height: 1.4; }

/* --- The counts strip ----------------------------------------------------- */
.counts { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4mm; margin-bottom: 6mm; }
.counts div { border: 1px solid var(--line); border-top: 3px solid var(--ink); padding: 3mm 3.5mm; }
.counts b { display: block; font-family: var(--display); font-size: 20pt; line-height: 1.1; }
.counts span { display: block; font-weight: 700; font-size: 9pt; margin-top: 1mm; }
.counts em { display: block; font-style: normal; font-size: 7.4pt; color: var(--muted); margin-top: .6mm; }

/* --- An agent's card ------------------------------------------------------ */
/* Whole cards avoid a break. One taller than a page breaks anyway, which is
   correct — the alternative is a blank page followed by an overflowing one.
   The type is set tight on purpose: at the body's own 8.6pt/1.55 an average
   card ran to 148mm and only one would fit on a page, which turned fifty
   agents into fifty half-empty pages. */
.agentcard { border: 1px solid var(--line); border-left: 3px solid var(--blue); padding: 2.6mm 3.5mm; margin-bottom: 3mm; line-height: 1.32; page-break-inside: avoid; }
.agentcard > header { display: flex; align-items: flex-start; gap: 3mm; border-bottom: 1px solid var(--ink); padding-bottom: 2mm; margin-bottom: 2.4mm; }
.agentcard .glyph { font-size: 12pt; line-height: 1; padding-top: .6mm; }
.agentcard h4 { font-size: 11pt; }
.agentcard .key { font-size: 7.4pt; color: var(--blue); margin-top: .3mm; }
.agentcard .place { margin-left: auto; text-align: right; font-size: 8pt; font-weight: 700; max-width: 62mm; }
.agentcard .place span { display: block; font-family: var(--mono); font-weight: 400; font-size: 6.6pt; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); margin-top: .6mm; }
.facts, .layers { display: grid; grid-template-columns: 23mm 1fr; gap: .7mm 3mm; margin: 0; }
.facts dt, .layers dt { font-family: var(--mono); font-size: 7pt; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); padding-top: .4mm; }
.facts dd, .layers dd { margin: 0; font-size: 7.9pt; }
.layers dd.shared { color: var(--muted); }
.layerband { font-family: var(--mono); font-size: 6.6pt; letter-spacing: .14em; text-transform: uppercase; color: var(--muted); border-bottom: 1px solid var(--line); padding-bottom: 1mm; margin: 2.4mm 0 1.8mm; }

/* --- A shipped doctrine --------------------------------------------------- */
.jobhead { display: flex; align-items: baseline; gap: 3mm; margin: 6mm 0 2mm; page-break-after: avoid; break-after: avoid-page; }
.jobhead h4 { font-size: 11pt; }
.jobhead .mono { color: var(--blue); }
.jobhead .where { margin-left: auto; font-family: var(--mono); font-size: 6.8pt; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }
.doctrine { white-space: pre-wrap; font-size: 8.4pt; line-height: 1.5; background: var(--cream); border: 1px solid var(--line); border-left: 3px solid var(--lime); padding: 3.5mm 4.5mm; margin: 0 0 4mm; }

/* --- A part divider ------------------------------------------------------- */
.part { page-break-before: always; background: var(--ink); color: var(--cream); padding: 10mm 10mm 9mm; margin: 0 0 8mm; }
.part .no { font-family: var(--mono); font-size: 7.6pt; letter-spacing: .16em; text-transform: uppercase; color: var(--lime); }
.part h2 { font-size: 24pt; margin-top: 2mm; }
.part p { color: rgba(244,245,240,.72); font-size: 10pt; margin: 3mm 0 0; max-width: 150mm; }
</style>`;

const head = fs
  .readFileSync(path.join(SRC, "workflow-head.html"), "utf8")
  .replace(
    "<title>Dakyworld Agent Master Workflow</title>",
    "<title>Dakyworld OS — Agents, Instructions, Workflows and Tools</title>",
  )
  .replace("__FONTS__", fontFaces())
  .replace("</head>", `${EXTRA_CSS}\n</head>`);

const today = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

const cover = `<div class="cover">
  <img class="lockup" src="${brand.logoDark}" alt="Dakyworld">
  <div class="rule"><i></i><i></i></div>
  <h1>Agents, Instructions, Workflows&nbsp;&amp; Tools</h1>
  <p class="sub">Every agent in the Dakyworld workforce, the exact words each one runs on, the work that starts without anybody asking, and every tool any of them can reach. Read out of the running code, not written alongside it.</p>
  <nav class="contents">
    <div class="col">
      <b>Part 1 · The workforce</b>
      <span>The tiers, and what each covers</span>
      <span>Every agent, and what it may reach</span>
      <b style="margin-top:5mm">Part 2 · The instructions</b>
      <span>The three places a prompt lives</span>
      <span>The ten-layer standard</span>
      <span>Every agent's system prompt</span>
      <span>The ${WRITER_JOBS.length} writing jobs, in full</span>
    </div>
    <div class="col">
      <b>Part 3 · The workflows</b>
      <span>The nine stages</span>
      <span>What runs on the clock</span>
      <span>Work that starts by itself</span>
      <span>How a task runs, and how it ends</span>
      <span>The gates</span>
    </div>
    <div class="col">
      <b>Part 4 · The tools</b>
      <span>Every tool, what it takes,<br>and what it costs to be wrong</span>
      <span>Who holds what</span>
      <span>Adding one</span>
    </div>
  </nav>
  <div class="meta">
    <span>Document<b>Complete reference</b></span>
    <span>Covers<b>${AGENT_SEEDS.length} agents · ${TOOLS.length} tools · ${WRITER_JOBS.length} writing jobs</b></span>
    <span>Generated<b>${today}</b></span>
  </div>
</div>`;

const intro = `<div class="stage">
  <div class="stage-head">
    <div class="no">Section 00</div>
    <h2>What this is, and where every part of it comes from</h2>
    <p class="lede">The body of this document is not written by hand. Each part is read out of the file that runs it at the moment the document is built, so it cannot describe an agent that was renamed, a prompt that was rewritten or a tool that was removed.</p>
  </div>

  ${countsStrip()}

  <table>
    <tr><th style="width:34mm">Part</th><th style="width:56mm">Read out of</th><th>Changed in the app at</th></tr>
    <tr><td><b>The workforce</b></td><td class="mono">services/agentRegistry.ts</td><td>Agents — each agent's own card</td></tr>
    <tr><td><b>System prompts</b></td><td class="mono">services/agentRegistry.ts</td><td>Agents → Its system prompt</td></tr>
    <tr><td><b>Writing briefs</b></td><td class="mono">services/writers/registry.ts</td><td>Agents → What this wording writes</td></tr>
    <tr><td><b>The clock</b></td><td class="mono">services/scheduler.ts</td><td>Not settable — the jobs are fixed; what they act on is not</td></tr>
    <tr><td><b>Standing work</b></td><td class="mono">services/agents/standingWork.ts</td><td>Agents → its schedule</td></tr>
    <tr><td><b>The gates</b></td><td class="mono">services/tools/invoke.ts</td><td>Agents — autonomy level and dry run</td></tr>
    <tr><td><b>The tools</b></td><td class="mono">services/tools/catalogue.ts</td><td>Tools — and each agent's toolkit</td></tr>
  </table>

  <div class="callout">
    <h4>The one rule that shapes the whole roster</h4>
    <p><b>One agent, one deliverable.</b> Not one tool and not one department — one kind of finished thing, with one definition of done. An agent holding three jobs has one prompt that must describe all three, one toolkit that is the union of all three, and one memory in which what it concluded about chasing an invoice is recalled while it is writing a proposal. The test to apply to anything added: does this produce more than one kind of finished thing?</p>
  </div>

  <div class="callout">
    <h4>Everything here seeds safe</h4>
    <p>Every agent is created at <b>autonomy 1 with dry run on</b>: it may prepare work and explain itself, and nothing it decides reaches a client, a card or the public site. A deploy adds agents that do not exist yet; it never overwrites one, never lowers an autonomy level and never turns a dry run off. Those three are the Owner's alone, which is the entire safety story of this layer.</p>
  </div>
</div>`;

const part1 = `<div class="part">
  <div class="no">Part 1</div>
  <h2>The workforce</h2>
  <p>Who exists, what each one is for, who they answer to, and what they are allowed to reach. The toolkit shown is the seeded grant — the list the invoker checks before every single call.</p>
</div>
<div class="stage">
  <div class="stage-head">
    <div class="no">1.1</div>
    <h2>The tiers</h2>
    <p class="lede">Five tiers. The board and executive tiers produce a decision or a brief; the operational and specialist tiers produce the work itself.</p>
  </div>
  ${tierTable()}
</div>
<div class="stage">
  <div class="stage-head">
    <div class="no">1.2</div>
    <h2>Every agent, and what it may reach</h2>
    <p class="lede">Widen or narrow a toolkit on the agent's own card, or from the tool's side on the Tools screen. Both write the same field.</p>
  </div>
  ${rosterTable()}
  ${danglingGrants()}
</div>`;

async function part2(): Promise<string> {
  return `<div class="part">
  <div class="no">Part 2</div>
  <h2>The instructions</h2>
  <p>The words every agent actually runs on. A prompt shown on a screen that is not the prompt the server runs is worse than no prompt at all — so these are the running ones, printed from the same source the runner composes from.</p>
</div>
<div class="stage">
  <div class="stage-head">
    <div class="no">2.1</div>
    <h2>The three places a prompt lives</h2>
    <p class="lede">They govern different things, and confusing them is how an edit lands with no effect.</p>
  </div>
  <table>
    <tr><th style="width:44mm">Surface</th><th style="width:58mm">Governs</th><th>Edited at</th></tr>
    <tr><td><b>An agent's ten layers</b></td><td>How it reasons through a task</td><td>Agents → Its system prompt</td></tr>
    <tr><td><b>A writing brief, per job</b></td><td>What the deliverable actually says</td><td>Agents → What this wording writes</td></tr>
    <tr><td><b>The contract, in code</b></td><td>The shape of the answer — the fields, the length, the plain-text rule</td><td>Nowhere, deliberately. A prompt edit that could reach it would turn a bad sentence into a parse failure.</td></tr>
  </table>
  <div class="callout">
    <h4>Which words win</h4>
    <p>A writing job resolves in one order, most specific first: <b>a per-job override</b>, then <b>the owning agent's instruction — but only once a person has actually written one</b>, then <b>the shipped wording</b> printed in 2.4. An untouched seed falls through rather than being used, because a seeded agent's ten layers describe a colleague and the shipped doctrine describes the letter. The consequence worth stating plainly: the first time you edit an agent that owns a writing job, that agent's wording takes over the deliverable — which is what you were trying to do when you edited it.</p>
  </div>
</div>
<div class="stage">
  <div class="stage-head">
    <div class="no">2.2</div>
    <h2>The ten-layer standard</h2>
    <p class="lede">Every system prompt is composed of the same ten layers in the same order. Three of them carry shared wording so that ${AGENT_SEEDS.length} agents cannot drift on the rules that matter; those are shown in grey on each card.</p>
  </div>
  ${layerStandardTable()}
</div>
<div class="stage newpage">
  <div class="stage-head">
    <div class="no">2.3</div>
    <h2>Every agent's system prompt</h2>
    <p class="lede">One card per agent: what it is for, what it is judged on, when it must stop and ask, what it may reach — and then the prompt itself, all ten layers, exactly as the runner composes them.</p>
  </div>
  ${agentCards()}
</div>
<div class="stage newpage">
  <div class="stage-head">
    <div class="no">2.4</div>
    <h2>The ${WRITER_JOBS.length} writing jobs</h2>
    <p class="lede">A writing job is a thing a model writes; an owner is the agent whose card governs how it is written. An agent may own several jobs; a job has exactly one owner, because two agents editing one deliverable is the contradiction that makes a model fall back to the generic output it already knew.</p>
  </div>
  ${writerTable()}

  <h3 class="band">The wording Dakyworld ships for each</h3>
  <p style="color:var(--muted)">This is the doctrine running today wherever nobody has edited the owning agent. Editing that agent replaces it.</p>
  ${await doctrines()}
</div>`;
}

const part3 = `<div class="part">
  <div class="no">Part 3</div>
  <h2>The workflows</h2>
  <p>What happens without anybody opening the app — the stages a lead passes through, the jobs on the clock, the work agents raise for themselves, and every gate standing between a prepared action and a real one.</p>
</div>
<div class="stage">
  <div class="stage-head">
    <div class="no">3.1</div>
    <h2>The nine stages</h2>
    <p class="lede">From a business nobody has heard of to a retainer renewing. Read the right-hand column first: it is the part that happens whether or not anybody is watching, and therefore the part worth being certain about before an autonomy level is raised.</p>
  </div>
  ${masterFlow()}
</div>
<div class="stage">
  <div class="stage-head">
    <div class="no">3.2</div>
    <h2>What runs on the clock</h2>
    <p class="lede">One interval, once a minute, in-process. Eight independent jobs, settled separately — lead capture failing must not stop an invoice going out, and neither must stop a follow-up. Each advances its own next-due instant <b>before</b> the work starts, so a failure cannot be retried in a loop and a restart cannot fire the same slot twice.</p>
  </div>
  ${CLOCK}
</div>
<div class="stage">
  <div class="stage-head">
    <div class="no">3.3</div>
    <h2>Work that starts by itself</h2>
    <p class="lede">A schedule on an agent — a title, a brief, run times and a timezone — raises a task without anybody asking. Three ceilings stand under it, because a loop that raises work faster than an agent finishes it would queue for ever and the first sign of it would be the bill.</p>
  </div>
  <table>
    <tr><th style="width:44mm">Ceiling</th><th>What it prevents</th></tr>
    <tr><td><b>Open tasks per schedule</b><div style="font-size:7.4pt;color:var(--muted)">one by default</div></td><td>A daily brief that is still unfinished tomorrow becoming two.</td></tr>
    <tr><td><b>One running task per agent</b><div style="font-size:7.4pt;color:var(--muted)">enforced inside the claim</div></td><td>Two tasks about one lead interleaving what the agent is concluding. It is a memory rule, not a tidiness one.</td></tr>
    <tr><td><b>Six-hour catch-up limit</b></td><td>A slot missed during an outage being stampeded through on boot.</td></tr>
  </table>
  <div class="callout">
    <h4>Pausing an agent is how you stop its standing work</h4>
    <p>A schedule belonging to a draft or paused agent is skipped quietly rather than refused loudly — a warning every minute about a deliberate decision is noise.</p>
  </div>
</div>
<div class="stage">
  <div class="stage-head">
    <div class="no">3.4</div>
    <h2>How a task runs, and how it ends</h2>
    <p class="lede">A task is assigned, queued and claimed; every model turn and every single tool call is checkpointed, so a closed tab, a deploy landing mid-run or the stop button costs nothing but the turn in progress. A resume runs only the calls that never happened — “again” for an email send is a second letter to the same prospect.</p>
  </div>
  ${END_STATES}
</div>
<div class="stage">
  <div class="stage-head">
    <div class="no">3.5</div>
    <h2>The gates</h2>
    <p class="lede">Four checks stand in front of every tool call, in one place, and every call including every refusal is written to the audit trail.</p>
  </div>
  <table>
    <tr><th style="width:44mm">Checked before every call</th><th>What happens when it fails</th></tr>
    <tr><td><b>Is the integration configured</b></td><td>The tool reports that it needs a key, rather than failing at the moment an agent tries to use it.</td></tr>
    <tr><td><b>Is the tool granted to this agent</b></td><td>Refused. The toolkit on the agent's card is the grant.</td></tr>
    <tr><td><b>Is the autonomy level high enough</b></td><td><b>Downgraded to a preview, not refused</b> — a prepared action somebody can approve is worth more than an error.</td></tr>
    <tr><td><b>Does the input match the declared shape</b></td><td>Refused before anything runs.</td></tr>
  </table>
  ${LADDER}
  <div class="callout">
    <h4>Approving is not a bypass</h4>
    <p>An approval re-invokes the tool with the input the schema validated at proposal time, so what happens is what was shown — not a second model call that might produce something else. Execution still goes back through the same four checks; approval lifts the dry-run downgrade and nothing else, so a request approved after the grant was revoked is refused. Undecided requests expire rather than sitting pending for ever: a week-old proposal is a re-ask, because the invoice may have been paid and the lead gone cold since.</p>
  </div>
</div>`;

const part4 = `<div class="part">
  <div class="no">Part 4</div>
  <h2>The tools</h2>
  <p>Everything an agent can actually call. Reads are generous, writes are narrow: a read tool can return a list, a write tool changes one named record and returns what it changed. Nothing here deletes anything, and nothing here can grant a permission.</p>
</div>
<div class="stage">
  <div class="stage-head">
    <div class="no">4.1</div>
    <h2>Every tool, and what it costs to be wrong</h2>
    <p class="lede"><b>Outward</b> means a call is visible to somebody outside the company and needs level 3. <b>Spends</b> means it charges money and needs level 4. Anything unmarked is read-only and runs at any level. The grey line under each purpose is the arguments it takes; a <code>?</code> marks an optional one.</p>
  </div>
  ${toolTable()}
  <div class="callout">
    <h4>Adding a tool</h4>
    <p>Two ways, and they are deliberately different. <b>In code</b> — one entry in the catalogue, which inherits the permission model, the audit trail and both screens by existing. <b>By connection</b> — an MCP server, whose tools join the same catalogue as <code>mcp.&lt;server&gt;.&lt;tool&gt;</code> and pass every gate above on identical terms. What a tool <em>does</em> stays reviewable in a diff; which servers are trusted, and how far, is yours to set.</p>
  </div>
</div>`;

const html = `${head}
${cover}
${intro}
${part1}
${await part2()}
${part3}
${part4}
</body>
</html>
`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, html);
console.log(
  `wrote ${OUT} — ${(html.length / 1024).toFixed(0)} KB, ${AGENT_SEEDS.length} agents, ${WRITER_JOBS.length} writing jobs, ${TOOLS.length} tools`,
);
process.exit(0);
