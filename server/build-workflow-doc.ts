import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_SEEDS } from "./src/services/agentRegistry.js";
import { TOOLS } from "./src/services/tools/catalogue.js";

/**
 * Builds the Agent Master Workflow document.
 *
 * The prose is written by hand and lives in the fragments this stitches
 * together. The two appendices are **generated from the code they describe** —
 * the agent roster from `agentRegistry.ts` and the catalogue from
 * `catalogue.ts` — because an operating standard whose reference tables have
 * drifted from the system is worse than no reference tables: somebody grants a
 * tool that no longer exists, or looks for one that was added last month and
 * concludes it cannot be done.
 *
 * Re-run it after any change to either file. `npx tsx build-workflow-doc.ts`.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = process.argv[2] ?? path.join(HERE, "docs", "workflow");
const OUT = process.argv[3] ?? path.join(HERE, "docs", "agent-master-workflow.html");

const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// --- Appendix A: the roster -------------------------------------------------

const TIER_LABEL: Record<string, string> = {
  BOARD: "Board",
  EXECUTIVE: "Executive",
  FUNCTIONAL: "Governance",
  OPERATIONAL: "Operational",
  SUB_AGENT: "Specialist",
};

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

const toolByKey = new Map(TOOLS.map((tool) => [tool.key, tool]));

/** A grant chip, coloured by what it costs to be wrong. Matches the legend. */
function chip(key: string): string {
  const tool = toolByKey.get(key);
  const kind = !tool ? "none" : tool.spends ? "spend" : tool.outward ? "out" : "";
  return `<span class="${kind}">${escape(key)}</span>`;
}

function agentTable(): string {
  const order = ["BOARD", "EXECUTIVE", "FUNCTIONAL", "OPERATIONAL", "SUB_AGENT"];
  const rows: string[] = [];

  for (const tier of order) {
    const list = AGENT_SEEDS.filter((seed) => seed.tier === tier);
    if (list.length === 0) continue;
    rows.push(
      `<tr><td colspan="3" style="border-bottom:1px solid var(--ink);padding-top:4mm"><b class="mono" style="letter-spacing:.12em;text-transform:uppercase;font-size:7.4pt;color:var(--muted)">${TIER_LABEL[tier] ?? tier}</b></td></tr>`,
    );
    for (const seed of list) {
      const reportsTo = seed.managerKey ? AGENT_SEEDS.find((a) => a.key === seed.managerKey)?.name : null;
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
  <div class="legend" style="margin-top:3mm">
    <span><span class="mono" style="border:1px solid var(--line);background:var(--cream);padding:.4mm 1.6mm;font-size:7.4pt">read only</span> runs at any level</span>
    <span><span class="mono" style="border:1px solid var(--blue-light);background:#EEF2FF;padding:.4mm 1.6mm;font-size:7.4pt">outward</span> needs level 3</span>
    <span><span class="mono" style="border:1px solid #F0C77E;background:#FEF6E7;padding:.4mm 1.6mm;font-size:7.4pt">spends</span> needs level 4</span>
  </div>`;
}

// --- Appendix B: the catalogue ----------------------------------------------

const REQUIRES_LABEL: Record<string, string> = {
  database: "None — the app's own data",
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
};

function toolTable(): string {
  const groups = [...new Set(TOOLS.map((tool) => tool.group))];
  const rows: string[] = [];

  for (const group of groups) {
    rows.push(
      `<tr><td colspan="4" style="border-bottom:1px solid var(--ink);padding-top:4mm"><b class="mono" style="letter-spacing:.12em;text-transform:uppercase;font-size:7.4pt;color:var(--muted)">${escape(group)}</b></td></tr>`,
    );
    for (const tool of TOOLS.filter((t) => t.group === group)) {
      const marks = [
        tool.outward ? '<span class="out">outward</span>' : "",
        tool.spends ? '<span class="spend">spends</span>' : "",
        tool.preview ? '<span>preview</span>' : "",
      ]
        .filter(Boolean)
        .join("");
      rows.push(
        `<tr>
          <td style="width:34mm"><span class="mono" style="font-size:7.6pt"><b>${escape(tool.key)}</b></span></td>
          <td style="width:56mm;font-size:8.2pt">${escape(tool.purpose)}</td>
          <td style="width:32mm;font-size:7.6pt;color:var(--muted)">${escape(REQUIRES_LABEL[tool.requires] ?? tool.requires)}</td>
          <td><div class="tools">${marks || '<span class="none">read only</span>'}</div></td>
        </tr>`,
      );
    }
  }

  const outward = TOOLS.filter((t) => t.outward).length;
  const spending = TOOLS.filter((t) => t.spends).length;

  return `<table>
    <tr><th>Key</th><th>What it does</th><th>Needs</th><th>Gate</th></tr>
    ${rows.join("\n")}
  </table>
  <p style="font-size:8.4pt;color:var(--muted)"><b>${TOOLS.length}</b> tools in code. <b>${outward}</b> reach outside the company; <b>${spending}</b> spend money. Connected MCP servers add more, under the same gates.</p>`;
}

// --- The master flow diagram ------------------------------------------------

/**
 * Nine stages as one column of bands. Drawn in HTML rather than SVG because it
 * has to reflow if a stage name changes, and because print CSS gives crisper
 * type than an SVG scaled into a PDF.
 */
function masterFlow(): string {
  const stages: Array<{ n: string; name: string; owner: string; from: string; to: string; auto: string }> = [
    { n: "1", name: "Acquisition", owner: "Lead Lifecycle · Integration Architect", from: "A business nobody has heard of", to: "Lead at NEW, scored, de-duplicated", auto: "Scheduled capture · webhook intake" },
    { n: "2", name: "Qualification", owner: "Lead Lifecycle · Sales Director", from: "Lead at NEW", to: "QUALIFIED or DISQUALIFIED, with the reason", auto: "Audit runs on every new lead" },
    { n: "3", name: "Outreach", owner: "Outbound Communications", from: "Lead at QUALIFIED", to: "A reply, or the series ends", auto: "Enrol · send in window · stop on reply" },
    { n: "4", name: "Consultation & proposal", owner: "Sales Director · Commercial Ops", from: "A reply asking to talk", to: "Proposal WON or LOST", auto: "Follow-up series after SENT" },
    { n: "5", name: "Onboarding", owner: "Commercial Ops · Delivery Director", from: "Proposal WON", to: "Project at PLANNING, tasks assigned", auto: "Welcome email on project open" },
    { n: "6", name: "Delivery", owner: "The nine specialists", from: "Tasks at TODO", to: "Every task DONE, QA signed off", auto: "Routing by craft" },
    { n: "7", name: "Handover", owner: "Client Communications", from: "QA sign-off", to: "Project DELIVERED", auto: "Testimonial & care-plan series" },
    { n: "8", name: "Invoicing", owner: "Finance Controller", from: "Milestone or delivery", to: "Invoice PAID", auto: "Overdue reminders escalate" },
    { n: "9", name: "The retainer", owner: "Recurring Revenue · Client Success", from: "Care plan ACTIVE", to: "Renews — or churn is caught early", auto: "Billing at 06:00 on the billing day" },
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

  return `<style>
    .flow { border: 1px solid var(--line); }
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
  </style>
  <div class="flow">
    <div class="fl-head"><span></span><span>Stage &amp; owner</span><span>What goes in, what comes out</span><span>Runs without asking</span></div>
    ${bands}
  </div>
  <p style="font-size:8.4pt;color:var(--muted);margin-top:4mm">Read the right-hand column first. It is the part that happens whether or not anybody opens the app, and it is therefore the part worth being certain about before an autonomy level is raised.</p>`;
}

// --- Assemble ---------------------------------------------------------------

const brand = JSON.parse(fs.readFileSync(path.join(SRC, "brand.json"), "utf8")) as Record<string, string>;

/**
 * The brand faces, embedded.
 *
 * Linking Google Fonts works in a browser and does not work here: Chrome's
 * print path finished before the webfonts arrived, and the first PDF shipped
 * with Segoe UI baked into every heading. A PDF is the artefact, not a view of
 * one, so the fonts have to be inside it.
 *
 * These are the latin and latin-ext subsets of the variable files — one file
 * per family per subset, declared across the whole weight range, because
 * Google serves the same variable file for 400, 500 and 700 and embedding it
 * once per weight would triple the document for nothing.
 */
function fontFaces(): string {
  const faces = JSON.parse(fs.readFileSync(path.join(SRC, "fonts", "faces.json"), "utf8")) as Array<{
    family: string;
    b64: string;
  }>;
  if (faces.length === 0) throw new Error("No embedded fonts — run the fetch in docs/workflow/fonts first.");
  return `<style>
${faces
    .map(
      (face) => `@font-face{font-family:'${face.family}';font-style:normal;font-weight:400 700;font-display:block;src:url(data:font/woff2;base64,${face.b64}) format('woff2');}`,
    )
    .join("\n")}
</style>`;
}

const fragments = ["head", "body-1", "body-2", "body-3", "body-4", "body-5", "body-6"].map((name) =>
  fs.readFileSync(path.join(SRC, `workflow-${name}.html`), "utf8"),
);
const orgchart = fs.readFileSync(path.join(SRC, "orgchart.html"), "utf8");

let html = fragments.join("\n") + "\n</body>\n</html>\n";
html = html
  .replace("__FONTS__", fontFaces())
  .replace("__LOGO_DARK__", brand.logoDark)
  .replace("__ORGCHART__", orgchart)
  .replace("__MASTERFLOW__", masterFlow())
  .replace("__AGENTTABLE__", agentTable())
  .replace("__TOOLTABLE__", toolTable());

for (const token of ["__FONTS__", "__LOGO_DARK__", "__ORGCHART__", "__MASTERFLOW__", "__AGENTTABLE__", "__TOOLTABLE__"]) {
  if (html.includes(token)) throw new Error(`${token} was never substituted — the document would ship with a hole in it.`);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, html);
console.log(`wrote ${OUT} — ${(html.length / 1024).toFixed(0)} KB, ${AGENT_SEEDS.length} agents, ${TOOLS.length} tools`);
process.exit(0);
