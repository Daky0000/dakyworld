import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_SEEDS, PROMPT_LAYERS } from "./src/services/agentRegistry.js";
import { TOOLS } from "./src/services/tools/catalogue.js";

/**
 * Builds the two fragments that turn the three standing documents into one
 * volume: the front matter (cover, contents, the scenario index) and Book
 * Three, "What runs now".
 *
 * Book Three exists because the other three documents were built on 18, 21 and
 * 25 August 2026 and the workforce changed after that date in ways a reader
 * acts on — the prompt regions, the free-model ladder, boundaries by subject,
 * pace ceilings, the autonomy record and the escalation digest. Their
 * generated tables are rebuilt from the code every time; their prose is not,
 * and prose that describes a mechanism which has since changed is worse than a
 * missing page, because nothing about it looks wrong.
 *
 * The front matter carries page-number tokens of the form `{{P:key}}`. They
 * are deliberately *not* filled here: a page number is a fact about the
 * printed PDFs, which do not exist yet at this point. `build-system-volume.py`
 * prints every book, finds each section, fills the tokens and merges.
 *
 *   npx tsx build-system-doc.ts
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "docs", "workflow");
const OUT_FRONT = path.join(HERE, "docs", "agent-system-front.html");
const OUT_CURRENT = path.join(HERE, "docs", "agent-system-current.html");

const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const OUTWARD = TOOLS.filter((t) => t.outward).length;
const SPENDING = TOOLS.filter((t) => t.spends).length;

/**
 * The regions of an assembled prompt, in the order `composePrompt()` pushes
 * them. Kept as data here rather than imported because the function that owns
 * them needs a live agent, a task and a database to run at all — and a build
 * step that needs a database is a build step that fails on a laptop.
 *
 * The `editable` column is the one a reader acts on: everything false is
 * assembled from live state, and a copy of it edited by hand is either
 * overwritten on the next run or quietly diverges from what the rest of the
 * roster is told.
 */
const REGIONS: Array<{ label: string; source: string; editable: boolean; when: string }> = [
  { label: "Its instructions", source: "The agent's own text, or the ten shipped sections run together in order.", editable: true, when: "Always" },
  { label: "What it is relied on for", source: "The skills on this agent, edited on the same screen.", editable: false, when: "When it has any" },
  { label: "Who Dakyworld is", source: "services/dakyworld.ts — the same for every agent.", editable: false, when: "Always" },
  { label: "The company's details", source: "Settings → System. Change it there and every agent and document follows.", editable: false, when: "Always" },
  { label: "How it writes", source: "services/dakyworld.ts — the brand voice.", editable: false, when: "Agents that write for outside" },
  { label: "What Dakyworld holds", source: "Shared memory, recalled for this task's subjects. Every agent is shown these.", editable: false, when: "When anything was recalled" },
  { label: "What it already knows", source: "Its own memory, recalled for this task's subjects.", editable: false, when: "When anything was recalled" },
  { label: "How it does the work", source: "services/agents/runner.ts — the same four passes for every agent, seeded or hired.", editable: false, when: "Working runs only" },
  { label: "How it works here", source: "Generated from live state — tool etiquette, dry run, and the size of the roster.", editable: false, when: "Always" },
];

function regionTable(): string {
  const rows = REGIONS.map(
    (r, i) => `<tr>
      <td class="mono" style="color:var(--muted)">${String(i + 1).padStart(2, "0")}</td>
      <td><b>${esc(r.label)}</b></td>
      <td>${esc(r.source)}</td>
      <td>${esc(r.when)}</td>
      <td>${r.editable ? '<span class="badge ok">a person&rsquo;s own</span>' : '<span class="badge">live state</span>'}</td>
    </tr>`,
  ).join("");
  return `<table class="tight"><thead><tr><th style="width:8mm"></th><th style="width:38mm">Region</th><th>Where the words come from</th><th style="width:38mm">Present</th><th style="width:26mm">Authored by</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/**
 * The headings the ten layers are joined under, straight out of the registry's
 * layer order so a layer added later cannot go missing from the table.
 */
const LAYER_HEADINGS: Record<string, string> = {
  role: "Who you are",
  mission: "What you are for",
  scope: "What is yours and what is not",
  dataRules: "What you may treat as fact",
  tools: "How you use what you have been given",
  policy: "The rules you work under",
  process: "How this job is done well",
  escalateWhen: "When to stop and ask",
  output: "What you produce",
  memory: "What to keep",
};

function headingTable(): string {
  const rows = PROMPT_LAYERS.map((layer, i) => {
    const heading = LAYER_HEADINGS[layer as string];
    if (!heading) throw new Error(`No heading written for the "${layer}" layer — the table would ship a hole.`);
    return `<tr>
      <td class="mono" style="width:8mm;color:var(--muted)">${String(i + 1).padStart(2, "0")}</td>
      <td style="width:62mm"><b>${esc(heading)}</b></td>
      <td class="mono" style="color:var(--muted)">${esc(String(layer))}</td>
    </tr>`;
  }).join("");
  return `<table class="tight"><thead><tr><th></th><th>The heading the layer is joined under</th><th>The layer it is</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/** The consult ceiling by priority, as `CONSULT_LIMITS` in the runner has it. */
function consultTable(): string {
  const rows: Array<[string, string, string]> = [
    ["1 · Urgent", "5", "Getting this wrong is expensive, and it is the task somebody marked urgent for exactly that reason."],
    ["2 · Normal", "3", "A hard question being worked properly. The shipped default for everything unmarked."],
    ["3 · Low", "2", "Ask once, decide, and get on with it."],
    ["Anything else", "3", "A priority not in the table falls back to the ordinary ceiling rather than to none."],
  ];
  return `<table><thead><tr><th style="width:34mm">Task priority</th><th class="num" style="width:22mm">Colleagues</th><th>Why</th></tr></thead><tbody>${rows
    .map(([p, n, why]) => `<tr><td><b>${esc(p)}</b></td><td class="num">${n}</td><td>${esc(why)}</td></tr>`)
    .join("")}</tbody></table>`;
}

// --- Assembly ---------------------------------------------------------------

const brand = JSON.parse(fs.readFileSync(path.join(SRC, "brand.json"), "utf8")) as Record<string, string>;

/** The brand faces, embedded rather than linked — see the operations builder. */
function fontFaces(): string {
  const faces = JSON.parse(fs.readFileSync(path.join(SRC, "fonts", "faces.json"), "utf8")) as Array<{ family: string; b64: string }>;
  if (faces.length === 0) throw new Error("No embedded fonts — run the fetch in docs/workflow/fonts first.");
  return `<style>\n${faces
    .map((f) => `@font-face{font-family:'${f.family}';font-style:normal;font-weight:400 700;font-display:block;src:url(data:font/woff2;base64,${f.b64}) format('woff2');}`)
    .join("\n")}\n</style>`;
}

const head = fs.readFileSync(path.join(SRC, "operations-head.html"), "utf8");

const TOKENS: Record<string, string> = {
  __FONTS__: fontFaces(),
  __LOGO_DARK__: brand.logoDark,
  __AGENTCOUNT__: String(AGENT_SEEDS.length),
  __TOOLCOUNT__: String(TOOLS.length),
  __OUTWARD__: String(OUTWARD),
  __SPENDING__: String(SPENDING),
  __LAYERCOUNT__: String(PROMPT_LAYERS.length),
  __REGIONCOUNT__: String(REGIONS.length),
  __BUILTDATE__: new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }),
  __REGIONTABLE__: regionTable(),
  __HEADINGTABLE__: headingTable(),
  __CONSULTTABLE__: consultTable(),
};

function build(bodyFile: string, out: string, title: string): void {
  const body = fs.readFileSync(path.join(SRC, bodyFile), "utf8");
  let html = head.replace("<title>How the Workforce Runs</title>", `<title>${title}</title>`) + "\n" + body + "\n</body>\n</html>\n";
  for (const [token, value] of Object.entries(TOKENS)) html = html.split(token).join(value);

  // A token that survived is a hole in a printed page nobody will read twice.
  for (const token of Object.keys(TOKENS)) {
    if (html.includes(token)) throw new Error(`${token} was never substituted in ${bodyFile}.`);
  }

  fs.writeFileSync(out, html);
  console.log(`wrote ${out} — ${(html.length / 1024).toFixed(0)} KB`);
}

build("system-front-body.html", OUT_FRONT, "The Dakyworld OS Agent System");
build("system-current-body.html", OUT_CURRENT, "What Runs Now");
console.log(`${AGENT_SEEDS.length} agents, ${TOOLS.length} tools, ${PROMPT_LAYERS.length} layers, ${REGIONS.length} prompt regions`);
process.exit(0);
