/**
 * Every feature in this system that can be given to somebody, or withheld.
 *
 * This list is code rather than data, and that is deliberate. A permission is
 * only real if a route checks it — a row in a table that no `requirePermission`
 * ever names is a promise the system does not keep, and the Access screen would
 * happily show it as a tickable feature. So the catalogue lives here, next to
 * the routers that enforce it, and the database stores only *which* of these
 * keys a role or a person has been given.
 *
 * The consequence worth remembering: **adding a feature means adding a key here
 * and a `requirePermission` on the route.** Skipping the second half ships a
 * screen nobody can be locked out of. `checks/access.ts` fails the build if a
 * key here is never enforced anywhere, which is what stops that drifting.
 *
 * Keys are `module.action` and are permanent. Renaming one silently revokes it
 * from every role that had it, because roles store the string. If a key has to
 * change, add the new one, grant it alongside, and remove the old one in a
 * later migration.
 */

/** A single thing somebody can be allowed to do. */
export type Permission = {
  key: string;
  /** How it reads on the Access screen. Sentence case, names the action. */
  label: string;
  /** The consequence of granting it, in one line. Shown under the label. */
  description: string;
  /**
   * Spends real money when used — an Apify run, a model call, a scrape.
   * Surfaced with a marker on the Access screen so granting it is a decision
   * rather than a reflex.
   */
  spends?: boolean;
  /**
   * Reaches somebody outside the company under Dakyworld's name — an email
   * that sends, an invoice that goes out, a page a stranger can open.
   */
  external?: boolean;
};

export type PermissionModule = {
  key: string;
  /** The name of the module as the nav shows it. */
  label: string;
  description: string;
  permissions: Permission[];
};

export const PERMISSION_MODULES: PermissionModule[] = [
  {
    key: "dashboard",
    label: "Dashboard",
    description: "The landing screen and its summary figures.",
    permissions: [
      { key: "dashboard.view", label: "See the dashboard", description: "Pipeline totals, recent activity and this month's figures." },
    ],
  },
  {
    key: "leads",
    label: "Leads",
    description: "The list of businesses to approach, and how they get into it.",
    permissions: [
      { key: "leads.view", label: "See leads", description: "Read the lead list and open any lead." },
      { key: "leads.create", label: "Add a lead", description: "Create leads by hand or through quick capture." },
      { key: "leads.edit", label: "Edit a lead", description: "Change details, status, score and notes." },
      { key: "leads.delete", label: "Delete a lead", description: "Remove leads permanently, including their research." },
      { key: "leads.tags", label: "Manage tags and columns", description: "Edit the tag registry and custom lead fields for everyone." },
      { key: "leads.prepare", label: "Prepare a lead", description: "Run research, the audit and the screenshot before writing.", spends: true },
      { key: "leads.import", label: "Import leads", description: "Bring in a spreadsheet or a Google Sheet and map its columns.", spends: true },
      { key: "leads.sources", label: "Configure capture", description: "Set up and run the scrapers that find new leads.", spends: true },
      { key: "leads.audit", label: "Run a website audit", description: "Put the four-reviewer audit team on a lead's website.", spends: true },
    ],
  },
  {
    key: "proposals",
    label: "Proposals",
    description: "What gets sent to a lead who is interested.",
    permissions: [
      { key: "proposals.view", label: "See proposals", description: "Read the proposal list and open any one of them." },
      { key: "proposals.create", label: "Create a proposal", description: "Start a new proposal against a lead or client." },
      { key: "proposals.edit", label: "Edit a proposal", description: "Change scope, pricing and terms before it goes out." },
      { key: "proposals.write", label: "Write one with a model", description: "Have the proposal writer draft it.", spends: true },
      { key: "proposals.send", label: "Send a proposal", description: "Deliver it to the client under the company's name.", external: true },
      { key: "proposals.delete", label: "Delete a proposal", description: "Remove a proposal permanently." },
    ],
  },
  {
    key: "demos",
    label: "Demos",
    description: "The free landing page offered in cold outreach.",
    permissions: [
      { key: "demos.view", label: "See demos", description: "Read the list of demo pages that have been built." },
      { key: "demos.create", label: "Build a demo", description: "Generate a demo page for a lead.", spends: true },
      { key: "demos.publish", label: "Publish a demo", description: "Put a page carrying somebody else's name on the public internet.", external: true },
      { key: "demos.delete", label: "Delete a demo", description: "Take a demo page down and remove it." },
    ],
  },
  {
    key: "projects",
    label: "Projects",
    description: "Work that has been won and is being delivered.",
    permissions: [
      { key: "projects.view", label: "See projects", description: "Read the project list, milestones and tasks." },
      { key: "projects.create", label: "Create a project", description: "Open a new project against a client." },
      { key: "projects.edit", label: "Edit a project", description: "Change scope, milestones, tasks and status." },
      { key: "projects.assign", label: "Assign work", description: "Put team members on projects and tasks." },
      { key: "projects.time", label: "Log time", description: "Record time entries against a project." },
      { key: "projects.delete", label: "Delete a project", description: "Remove a project and everything under it." },
    ],
  },
  {
    key: "clients",
    label: "Clients",
    description: "The businesses currently being worked for.",
    permissions: [
      { key: "clients.view", label: "See clients", description: "Read the client list and any client record." },
      { key: "clients.create", label: "Add a client", description: "Create a new client record." },
      { key: "clients.edit", label: "Edit a client", description: "Change contact details, sector and account notes." },
      { key: "clients.delete", label: "Delete a client", description: "Remove a client permanently." },
    ],
  },
  {
    key: "website",
    label: "Edit website",
    description: "The words, pictures and links on the websites this system publishes.",
    permissions: [
      { key: "website.view", label: "See the website", description: "Open a site, read its pages and preview unpublished edits." },
      { key: "website.edit", label: "Edit a page", description: "Change the copy, links and images on a page and save it as a draft." },
      // Publishing is the only action here that a stranger ever sees, and it
      // changes a page on a domain the company's name is on. It is separable
      // from editing on purpose: somebody can be trusted to write the words
      // without being the person who decides they go live.
      { key: "website.publish", label: "Publish a page", description: "Commit a page to its repository and put the change on the public site.", external: true },
      { key: "website.manage", label: "Manage sites and pages", description: "Connect a repository, rescan for pages, and decide which pages are editable." },
    ],
  },
  {
    key: "invoices",
    label: "Invoices",
    description: "What clients are asked to pay.",
    permissions: [
      { key: "invoices.view", label: "See invoices", description: "Read invoices and their payment status." },
      { key: "invoices.create", label: "Raise an invoice", description: "Create an invoice against a client or project." },
      { key: "invoices.edit", label: "Edit an invoice", description: "Change line items, amounts and due dates." },
      { key: "invoices.send", label: "Send an invoice", description: "Ask a client for money under the company's name.", external: true },
      { key: "invoices.delete", label: "Delete an invoice", description: "Remove an invoice permanently." },
    ],
  },
  {
    key: "retainers",
    label: "Retainers",
    description: "Care plans and the recurring money they move.",
    permissions: [
      { key: "retainers.view", label: "See retainers", description: "Read care plans and their billing cycles." },
      { key: "retainers.create", label: "Create a retainer", description: "Put a client on a recurring plan." },
      { key: "retainers.edit", label: "Edit a retainer", description: "Change the plan, its price or its cadence." },
      { key: "retainers.bill", label: "Run billing", description: "Close a cycle and raise the invoice for it.", external: true },
      { key: "retainers.delete", label: "Delete a retainer", description: "End a plan and remove it." },
    ],
  },
  {
    key: "emails",
    label: "Outreach — Email",
    description: "Cold email, follow-ups and the sequences that send them.",
    permissions: [
      { key: "emails.view", label: "See email", description: "Read drafts, sent mail and sequence state." },
      { key: "emails.draft", label: "Draft an email", description: "Have a model write or polish an outreach email.", spends: true },
      { key: "emails.send", label: "Send an email", description: "Put a message in a stranger's inbox under the company's name.", external: true },
      { key: "emails.sequences", label: "Manage sequences", description: "Build and enrol leads into multi-touch follow-up sequences.", external: true },
      { key: "emails.templates", label: "Manage templates", description: "Edit the saved email templates everyone writes from." },
      { key: "emails.delete", label: "Delete email", description: "Remove drafts and sent records." },
    ],
  },
  {
    key: "inbox",
    label: "Outreach — Inbox",
    description:
      "Replies that come back, and who deals with them. Answering one is a send, so it is governed by \"Send an email\" rather than by anything here.",
    permissions: [
      { key: "inbox.view", label: "See the inbox", description: "Read incoming mail and how it was classified." },
      { key: "inbox.assign", label: "Assign a reply", description: "Make an incoming message somebody's job." },
      { key: "inbox.sync", label: "Sync the mailbox", description: "Pull new mail from the IMAP server on demand." },
    ],
  },
  {
    key: "messages",
    label: "Outreach — WhatsApp & SMS",
    description: "The phone channels, for leads with a number and no address.",
    permissions: [
      { key: "messages.view", label: "See messages", description: "Read message threads and their delivery state." },
      { key: "messages.draft", label: "Draft a message", description: "Have a model write a WhatsApp or SMS opener.", spends: true },
      { key: "messages.send", label: "Send a message", description: "Send to a real phone number under the company's name.", external: true, spends: true },
      { key: "messages.settings", label: "Configure channels", description: "Change the WhatsApp and SMS provider settings." },
    ],
  },
  {
    key: "agents",
    label: "Agents",
    description: "The AI workforce — what it is told, what it may do, what it costs.",
    permissions: [
      { key: "agents.view", label: "See the workforce", description: "Read the agent roster and what each one is for." },
      { key: "agents.edit", label: "Edit an agent", description: "Change an agent's brief, playbook and writing instructions." },
      { key: "agents.run", label: "Run an agent", description: "Put an agent to work on a task.", spends: true },
      { key: "agents.hire", label: "Hire an agent", description: "Create a new agent through the Agent Creator." },
      { key: "agents.autonomy", label: "Set autonomy", description: "Decide how far an agent may act on a client without being asked." },
      { key: "agents.memory", label: "Manage memory", description: "Read and edit the shared memory agents write to." },
      { key: "agents.tools", label: "Manage tools", description: "Decide which tools the workforce may call." },
      { key: "agents.approvals.view", label: "See approvals", description: "Read the queue of work waiting on a human decision." },
      { key: "agents.approvals.decide", label: "Approve or reject", description: "Release work that reaches a client, or stop it.", external: true },
      { key: "agents.rehearsals.view", label: "See rehearsals", description: "Read past rehearsal runs and what the floor produced." },
      { key: "agents.rehearsals.run", label: "Run a rehearsal", description: "Point the whole workforce at one website and watch it.", spends: true },
      { key: "agents.costs", label: "See costs", description: "What the workforce spends, by model, job and agent." },
      { key: "agents.budgets", label: "Set budgets", description: "Change the spend ceilings that stop the workforce." },
    ],
  },
  {
    key: "settings",
    label: "Settings",
    description: "How the system itself is wired up.",
    permissions: [
      { key: "settings.view", label: "Open settings", description: "See the settings screen at all. Required for everything below." },
      { key: "settings.company", label: "Company details", description: "The one record carrying the company's name, address and bank details." },
      { key: "settings.integrations", label: "Integrations", description: "API keys and connections — mail, Slack, GitHub, Apify, payments." },
      { key: "settings.models", label: "Model routing", description: "Which vendor and model serves each job." },
      { key: "settings.mcp", label: "MCP servers", description: "Add and remove the servers that give the workforce new tools." },
      { key: "settings.templates", label: "Brand artwork", description: "The logo and mark stamped on invoices, proposals and letterheads." },
      { key: "settings.payments", label: "Payments", description: "Paystack and Hubtel configuration, and what happens on a webhook." },
    ],
  },
  {
    key: "team",
    label: "Team & Access",
    description: "Who has an account, and what they are allowed to do.",
    permissions: [
      { key: "team.view", label: "See the team", description: "Read the list of accounts, their roles and their status." },
      { key: "team.invite", label: "Add a person", description: "Create an account for somebody new." },
      { key: "team.edit", label: "Edit a person", description: "Change a name, skills and weekly capacity." },
      { key: "team.access", label: "Assign access", description: "Give somebody a role, and add or remove individual features for them." },
      { key: "team.roles", label: "Manage roles", description: "Create roles and decide which features each one carries." },
      { key: "team.password", label: "Reset a password", description: "Set somebody else's password, ending every session they hold." },
      { key: "team.twofactor", label: "Reset two-factor", description: "Clear somebody's second factor when their phone is gone." },
      { key: "team.deactivate", label: "Deactivate an account", description: "Switch an account off so it can no longer sign in." },
    ],
  },
];

/** Every key in the catalogue, flattened. */
export const ALL_PERMISSIONS: Permission[] = PERMISSION_MODULES.flatMap((m) => m.permissions);

export const ALL_PERMISSION_KEYS: string[] = ALL_PERMISSIONS.map((p) => p.key);

const KEY_SET = new Set(ALL_PERMISSION_KEYS);

/** True when a string is a permission this build actually enforces. */
export function isPermissionKey(key: string): boolean {
  return KEY_SET.has(key);
}

/**
 * Drops anything that is no longer in the catalogue.
 *
 * Roles store keys as strings, so a permission removed from a release leaves
 * orphans in every role that had it. Filtering on read means those disappear
 * quietly instead of showing up as blank rows on the Access screen — and means
 * a key can never be resurrected by re-adding it to the catalogue later with a
 * different meaning while stale grants still sit in the table.
 */
export function knownPermissions(keys: readonly string[]): string[] {
  return keys.filter((key) => KEY_SET.has(key));
}

export function permissionByKey(key: string): Permission | undefined {
  return ALL_PERMISSIONS.find((p) => p.key === key);
}

/** Every key belonging to one module, for the "select all" control on the Access screen. */
export function moduleKeys(moduleKey: string): string[] {
  return PERMISSION_MODULES.find((m) => m.key === moduleKey)?.permissions.map((p) => p.key) ?? [];
}

// ---------------------------------------------------------------------------
// The roles this system starts with
// ---------------------------------------------------------------------------

export type SystemRoleSeed = {
  key: string;
  name: string;
  description: string;
  /** Answers every permission check without consulting the list. Owner only. */
  superAdmin?: boolean;
  /**
   * Somebody outside the company. Held to the same closed door the old
   * `CLIENT_VIEWER` enum value was, on top of whatever permissions they carry —
   * see `scopeExternal` in middleware/auth.ts.
   */
  external?: boolean;
  permissions: string[];
  sortOrder: number;
};

/**
 * What every member of the team could already do before roles became editable.
 *
 * This exists so that turning permissions on changes nothing on the day it
 * deploys. Before this, access was `requireRole("OWNER", …)` scattered across
 * twenty routers; these six sets reproduce those rules exactly, so a Developer
 * who could reach Proposals yesterday can still reach Proposals today.
 *
 * They are a **starting point, not the design.** Several of these grants are
 * generous because the old system had no way to be otherwise — a Developer
 * could draft a proposal with a model and publish a demo page under a
 * stranger's name purely because those routers had no `requireRole` line on
 * them. Those are exactly the grants worth reviewing on the Access screen now
 * that reviewing them is possible.
 */

/** Reachable by any signed-in member of the team before this change — no router gated it. */
const OPEN_TO_EVERYONE = [
  "dashboard.view",
  "leads.view",
  "leads.create",
  "leads.edit",
  "leads.delete",
  "leads.tags",
  "leads.audit",
  "proposals.view",
  "proposals.create",
  "proposals.edit",
  "proposals.write",
  "proposals.send",
  "proposals.delete",
  "demos.view",
  "demos.create",
  "demos.publish",
  "demos.delete",
  "projects.view",
  "projects.create",
  "projects.edit",
  "projects.assign",
  "projects.time",
  "projects.delete",
  "clients.view",
  "clients.create",
  "clients.edit",
  "clients.delete",
  "invoices.view",
  "invoices.create",
  "invoices.edit",
  "invoices.send",
  "invoices.delete",
];

/** What `requireRole("OWNER", "OPERATIONS_FINANCE", "PROJECT_MANAGER")` guarded: the three outreach routers. */
const OUTREACH = [
  "emails.view",
  "emails.draft",
  "emails.send",
  "emails.sequences",
  "emails.templates",
  "emails.delete",
  "inbox.view",
  "inbox.assign",
  "inbox.sync",
  "messages.view",
  "messages.draft",
  "messages.send",
  "messages.settings",
];

/** What `requireRole("OWNER", "OPERATIONS_FINANCE")` guarded on the care plan router. */
const RETAINERS = ["retainers.view", "retainers.create", "retainers.edit", "retainers.bill", "retainers.delete"];

export const SYSTEM_ROLES: SystemRoleSeed[] = [
  {
    key: "owner",
    name: "Owner",
    description: "Runs the business. Every feature, including this screen. Cannot be edited or deleted.",
    superAdmin: true,
    permissions: [],
    sortOrder: 10,
  },
  {
    key: "operations-finance",
    name: "Operations & Finance",
    description: "Money and outreach: retainers, invoicing, email and the phone channels.",
    permissions: [...OPEN_TO_EVERYONE, ...OUTREACH, ...RETAINERS],
    sortOrder: 20,
  },
  {
    key: "project-manager",
    name: "Project Manager",
    description: "Delivery and client contact, but not the recurring money.",
    permissions: [...OPEN_TO_EVERYONE, ...OUTREACH],
    sortOrder: 30,
  },
  {
    key: "developer",
    name: "Developer",
    description: "Builds the work. Leads, projects and clients — no outreach, no settings.",
    permissions: [...OPEN_TO_EVERYONE],
    sortOrder: 40,
  },
  {
    key: "designer",
    name: "Designer",
    description: "Designs the work. The same reach as a Developer.",
    permissions: [...OPEN_TO_EVERYONE],
    sortOrder: 50,
  },
  {
    key: "client-viewer",
    name: "Client Viewer",
    description:
      "Somebody outside the company. Can sign in and see their own account, and nothing else, until a client portal exists to scope them to.",
    external: true,
    permissions: [],
    sortOrder: 60,
  },
];

/**
 * The old `Role` enum value each seeded role corresponds to.
 *
 * `User.role` is kept in step with this so that anything still reading the enum
 * — and the old rows in the database — stay meaningful. A role somebody creates
 * has no enum value; those users sit on `DEVELOPER`, which grants nothing on
 * its own now that every check reads permissions instead.
 */
export const SYSTEM_ROLE_TO_ENUM: Record<string, string> = {
  owner: "OWNER",
  "operations-finance": "OPERATIONS_FINANCE",
  "project-manager": "PROJECT_MANAGER",
  developer: "DEVELOPER",
  designer: "DESIGNER",
  "client-viewer": "CLIENT_VIEWER",
};

/** The reverse, for backfilling existing accounts onto a role. */
export const ENUM_TO_SYSTEM_ROLE: Record<string, string> = Object.fromEntries(
  Object.entries(SYSTEM_ROLE_TO_ENUM).map(([key, value]) => [value, key]),
);

/**
 * Roles that are created once, on the first boot that has this code, and then
 * belong entirely to whoever runs the system.
 *
 * The difference from `SYSTEM_ROLES` is the whole point of the category. A
 * system role is furniture: it cannot be deleted, it keeps its shipped name,
 * and it is referred to by key in this codebase. A starter role is a **head
 * start** — an ordinary row that happens to arrive with sensible ticks already
 * on it, which can then be renamed, narrowed, widened or thrown away like any
 * role somebody typed in themselves.
 *
 * This is not a contradiction of the rule that a role created on the Access
 * screen starts empty. That rule exists because naming a role is not the same
 * as deciding what it can reach, and nobody has decided yet at the moment the
 * name is typed. Here somebody *has* decided, in this file, deliberately.
 *
 * Seeded once and never re-applied — see `SETTING.ACCESS_STARTER_ROLES`.
 * Deleting a starter role has to mean deleted.
 */
export const STARTER_ROLES: SystemRoleSeed[] = [
  {
    key: "lead",
    name: "Lead",
    description:
      "Runs the lead pipeline end to end — finding them, importing them, preparing them and auditing their sites. Includes the four features that spend money on leads.",
    /**
     * Every permission in the Leads module, read from the catalogue rather than
     * listed here.
     *
     * Listing them would be a second copy of the module that has to be
     * remembered: a lead permission added in six months would appear on the
     * Access screen, be enforced by the gate, and silently *not* be part of the
     * role whose entire definition is "all of them". Deriving it means the role
     * means what its description says on the day somebody reads it.
     *
     * `dashboard.view` joins them because the dashboard is mostly a read-out of
     * this person's own work — pipeline value and leads by status — and a role
     * that lands on a screen it cannot open makes a poor first impression.
     * Untick it if you disagree; nothing else depends on it.
     */
    permissions: [...moduleKeys("leads"), "dashboard.view"],
    sortOrder: 35,
  },
];
