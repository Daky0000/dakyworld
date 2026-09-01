export interface Client {
  id: string;
  name: string;
  company?: string | null;
  email?: string | null;
  phone?: string | null;
  sector?: string | null;
  lifetimeValue: string;
  createdAt: string;
  _count?: { projects: number; invoices: number; carePlans: number };
}

export interface LeadGroup {
  id: string;
  name: string;
  slug: string;
  description?: string | null;
  autoCreated: boolean;
  /** "Contacts!5-210" for a group that came out of a spreadsheet. */
  sourceLabel?: string | null;
  /** LeadTag slugs. What the batch is, as opposed to what the businesses in it are. */
  tags: string[];
  leadImportId?: string | null;
  createdAt: string;
  _count?: { leads: number };
}

/**
 * One list as the leads screen renders it — `GET /api/leads/grouped`.
 *
 * `total` is the list's true match count under the current filters; `leads` is
 * only the preview the server was asked for. The two are deliberately separate
 * because the page used to conflate them: it bucketed a flat page of rows in
 * the browser, so a block's header counted what had been fetched rather than
 * what was in the list.
 */
export interface LeadGroupBlock {
  /** A real group id, or "none" for the leads that are in no list. */
  id: string;
  name: string;
  slug: string | null;
  description: string | null;
  tags: string[];
  autoCreated: boolean;
  sourceLabel: string | null;
  createdAt: string | null;
  /** Every lead in this list that matches, not just the ones below. */
  total: number;
  /** How many of those carry an email address. Counted over the list, not the preview. */
  withEmail: number;
  leads: Lead[];
}

export interface GroupedLeads {
  groups: LeadGroupBlock[];
  totalGroups: number;
  totalLeads: number;
  perGroup: number;
  skipGroups: number;
}

// --- Tags ------------------------------------------------------------------

/** The palette. Lime is missing on purpose — it is the action colour. */
export type TagColour = "blue" | "cyan" | "ink" | "amber" | "emerald" | "red";

/**
 * One tag in the registry.
 *
 * `slug` is the identity every lead and list holds and never changes; `label`
 * is what a person reads and can be renamed freely. See
 * server/src/services/leadTags.ts.
 */
export interface LeadTag {
  id: string;
  slug: string;
  label: string;
  colour: TagColour | null;
  description: string | null;
  /** True when a scrape, an import or a webhook coined it rather than the Owner. */
  autoCreated: boolean;
  lastUsedAt: string | null;
  /** How many leads carry it. */
  leads: number;
  /** How many lead lists carry it. */
  groups: number;
}

export interface LeadTagList {
  tags: LeadTag[];
  colours: TagColour[];
}

// --- Columns ---------------------------------------------------------------

export type LeadFieldType =
  | "TEXT"
  | "LONG_TEXT"
  | "NUMBER"
  | "CURRENCY"
  | "DATE"
  | "BOOLEAN"
  | "EMAIL"
  | "PHONE"
  | "URL"
  | "SELECT";

/** One column of the leads table. `id` is null for the built-in defaults. */
export interface LeadFieldDef {
  id: string | null;
  key: string;
  label: string;
  type: LeadFieldType;
  builtin: boolean;
  hidden: boolean;
  position: number;
  width: number | null;
  meta?: unknown;
}

export interface BuiltinFieldDef {
  key: string;
  label: string;
  type: LeadFieldType;
  writable: boolean;
  visible: boolean;
  hint: string;
}

export interface LeadFieldSet {
  /** Which set is in force: this group's own, the saved default, or the shipped default. */
  scope: "group" | "default" | "builtin";
  groupId: string | null;
  fields: LeadFieldDef[];
  builtins: BuiltinFieldDef[];
}

export interface Lead {
  id: string;
  contactName: string;
  contactEmail?: string | null;
  contactPhone?: string | null;
  companyName?: string | null;
  source: string;
  /** The route in — a scrape, a spreadsheet, typed by hand. Set by the system. */
  captureMethod: CaptureMethod;
  status: string;
  leadScore: number;
  estimatedDealSize?: string | null;
  discoveryNotes?: string | null;
  discoveryCallAt?: string | null;
  winLossReason?: string | null;
  createdAt: string;
  updatedAt?: string;
  client?: Client | null;

  // Filled by the scrapers.
  website?: string | null;
  address?: string | null;
  city?: string | null;
  region?: string | null;
  country?: string | null;
  category?: string | null;
  rating?: string | null;
  reviewsCount?: number | null;
  latitude?: number | null;
  longitude?: number | null;
  socialLinks?: Record<string, string> | null;
  tags?: string[];
  externalId?: string | null;
  enrichment?: Record<string, unknown> | null;
  /** Values for columns that aren't Lead scalars, keyed by LeadFieldDef.key. */
  customFields?: Record<string, unknown> | null;

  /** The last time somebody went and looked at this business. See LeadResearch. */
  research?: LeadResearch | null;
  /** True when nobody has looked, or the last look is old enough to redo. */
  researchStale?: boolean;
  /** Pages built for this prospect. */
  demos?: Demo[];
  /** The most recent website reviews, newest first. Never the report itself. */
  websiteAudits?: WebsiteAuditSummary[];
  /** Whether there is anything worth writing to them about. Null until looked at. */
  caseStrength?: CaseStrength | null;

  groupId?: string | null;
  group?: LeadGroup | null;
  scraperSourceId?: string | null;
  scraperSource?: { id: string; name: string; actorId?: string } | null;
  scraperRun?: { id: string; startedAt: string; trigger: string } | null;
  proposals?: { id: string; status: string }[];
  communications?: Communication[];
}

export interface Communication {
  id: string;
  type: string;
  summary: string;
  outcome?: string | null;
  occurredAt: string;
  loggedBy?: { id: string; name: string } | null;
}

/**
 * How a lead got into the system. PDF, DOCUMENT and API have no importer
 * behind them yet — the tag is ready for when one arrives.
 */
export type CaptureMethod =
  | "MANUAL"
  | "APIFY"
  | "EXCEL"
  | "CSV"
  | "GOOGLE_SHEET"
  | "PDF"
  | "DOCUMENT"
  | "API"
  | "OTHER";

export interface LeadStats {
  total: number;
  averageScore: number;
  pipelineValue: string;
  reachable: number;
  newThisWeek: number;
  byStatus: { status: string; _count: number }[];
  bySource: { source: string; _count: number }[];
  /** Counted ignoring the method filter, so the chips still show what's there. */
  byMethod: { captureMethod: CaptureMethod; _count: number }[];
  cities: { city: string | null; _count: number }[];
  categories: { category: string | null; _count: number }[];
  groups: LeadGroup[];
}

// --- Lead sourcing (Apify) -------------------------------------------------

export interface ScraperRun {
  id: string;
  sourceId: string;
  apifyRunId?: string | null;
  datasetId?: string | null;
  status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "ABORTED" | "TIMED_OUT";
  trigger: "MANUAL" | "SCHEDULED";
  startedAt: string;
  finishedAt?: string | null;
  itemsFetched: number;
  leadsCreated: number;
  leadsUpdated: number;
  duplicates: number;
  filtered: number;
  error?: string | null;
  /** What Apify billed. Null while the run is still going. */
  costUsd?: number | null;
  /** What it was expected to cost when it started, for comparison. */
  estimateUsd?: number | null;
  /** Why rows didn't become leads. The answer to "40 items, 0 leads". */
  diagnostics?: RunDiagnostics | null;
  source?: { id: string; name: string; actorId: string };
  leads?: Lead[];
}

export interface RunDiagnostics {
  /** What each row was recognised as: `{ "INSTAGRAM": 12 }`. */
  shapes: Record<string, number>;
  dropped: Array<{ reason: string; count: number; sample: Record<string, unknown> | null }>;
}

// --- What a capture costs ---------------------------------------------------

export interface CostLine {
  label: string;
  unitUsd: number;
  units: number;
  totalUsd: number;
  /** An extra switched on by the input, rather than the base charge. */
  addOn: boolean;
}

export interface CostEstimate {
  actorId: string;
  model: string;
  /** Null when Apify wouldn't price the actor. */
  totalUsd: number | null;
  perResultUsd: number | null;
  results: number;
  minChargeUsd: number | null;
  lines: CostLine[];
  /** Paid switches that are on and buy nothing this app reads. */
  waste: string[];
  caveats: string[];
}

export interface CaptureEstimate {
  tasks: Array<{ kind: string; label: string; actorId: string; count: number; estimate: CostEstimate }>;
  totalUsd: number | null;
  /** True when at least one actor couldn't be priced, so the total is partial. */
  partial: boolean;
}

export interface ScraperSource {
  id: string;
  name: string;
  actorId: string;
  description?: string | null;
  input: Record<string, unknown>;
  fieldMap?: Record<string, string> | null;
  preset: "AUTO" | "GOOGLE_MAPS" | "GENERIC_CONTACT" | "CUSTOM";
  leadSource: string;
  groupName?: string | null;
  /**
   * The list this source fills, once it has filled one.
   *
   * A source used to open a new list on every run, because every shipped
   * batch name ended in `{{date}}`. Null means the next run resolves one — it
   * adopts a list already carrying `groupName` before creating one.
   */
  leadGroupId?: string | null;
  enabled: boolean;
  maxItems: number;
  minScore: number;
  autoQualify: boolean;
  qualifyScore: number;
  scheduleEnabled: boolean;
  scheduleTimes: string[];
  timezone: string;
  lastRunAt?: string | null;
  nextRunAt?: string | null;
  createdAt: string;
  _count?: { leads: number };
  runs?: ScraperRun[];
}

export interface ScraperTemplate {
  id: string;
  name: string;
  actorId: string;
  headline: string;
  description: string;
  preset: ScraperSource["preset"];
  leadSource: string;
  groupName: string;
  maxItems: number;
  minScore: number;
  input: Record<string, unknown>;
  editFirst: string[];
}

export interface ApifyActorSummary {
  id: string;
  name: string;
  username: string;
  title?: string;
  description?: string;
  fullName: string;
  stats?: { totalRuns?: number };
  pictureUrl?: string;
  pricingModel?: string | null;
}

/** One actor this install depends on — see GET /api/scrapers/actors. */
export interface ActorHealth {
  actorId: string;
  reachable: boolean;
  title: string | null;
  pricingModel: string | null;
  proxyField: string | null;
  proxyRequired: boolean;
  inTemplates: boolean;
  usedBy: { id: string; name: string; enabled: boolean; unknownKeys: string[] }[];
}

export interface ActorHealthReport {
  actors: ActorHealth[];
  unreachable: number;
  withUnknownKeys: number;
}

export interface ScraperOverview {
  connected: boolean;
  sourceCount: number;
  enabledCount: number;
  scheduledCount: number;
  runningCount: number;
  nextRun: { id: string; name: string; at: string } | null;
  capturedThisWeek: number;
  capturedTotal: number;
  lastRun: (ScraperRun & { source?: { name: string } }) | null;
  /** Null when Apify isn't connected, or wouldn't say. */
  spend: {
    spentUsd: number;
    includedUsd: number | null;
    budgetUsd: number | null;
    cycleEnd: string | null;
    blocked: boolean;
  } | null;
  concurrency: { running: number; limit: number };
}

export interface MappingPreview {
  items: {
    lead?: Record<string, unknown>;
    /** What the mapper recognised the row as — the first thing worth knowing. */
    shape?: string;
    readAs?: string;
    score?: number;
    dedupeKey?: string | null;
    wouldSave?: boolean;
    skipped?: string | null;
    raw: Record<string, unknown>;
  }[];
}

// --- Spreadsheet imports ---------------------------------------------------

export interface PlanColumn {
  /** 0-based column index in the sheet. */
  index: number;
  header: string;
  label: string;
  /** A Lead field key, or "custom" to keep it as its own column, or "ignore". */
  field: string;
  key?: string;
  type: LeadFieldType;
}

export interface PlanTable {
  id: string;
  sheet: string;
  title: string;
  headerRow: number | null;
  firstDataRow: number;
  lastDataRow: number;
  startColumn: number;
  endColumn: number;
  columns: PlanColumn[];
  leadSource: string;
  status: string;
  confidence: number;
  notes: string;
  include: boolean;
}

/**
 * How the detected tables become lead lists. `"sheet"` — the default — puts
 * everything found on one worksheet into one list; `"table"` gives every
 * detected table a list of its own.
 */
export type PlanGrouping = "sheet" | "table";

export interface ImportPlan {
  tables: PlanTable[];
  summary: string;
  /** Absent means "sheet". */
  grouping?: PlanGrouping;
}

export interface TablePreview {
  tableId: string;
  columns: { key: string; label: string; field: string; type: string; builtin: boolean }[];
  sample: Record<string, string>[];
  rowCount: number;
  skipped: number;
  reachable: number;
}

export interface LeadImportRecord {
  id: string;
  source: "UPLOAD" | "GOOGLE_SHEET" | "GOOGLE_DRIVE_FILE";
  status: "ANALYZING" | "READY" | "IMPORTING" | "IMPORTED" | "FAILED";
  fileName?: string | null;
  driveFileId?: string | null;
  sheetNames: string[];
  analyzedBy?: string | null;
  notes?: string | null;
  error?: string | null;
  tablesFound: number;
  groupsCreated: number;
  leadsCreated: number;
  leadsUpdated: number;
  rowsSkipped: number;
  createdAt: string;
  importedAt?: string | null;
  groups?: { id: string; name: string; _count?: { leads: number } }[];
}

/** How far through the tabs an import has got. */
export interface AnalyzeProgress {
  total: number;
  done: string[];
  /** Still to read, in the order they will be read — the next one is first. */
  remaining: string[];
  finished: boolean;
}

/**
 * One tab's worth of analysis.
 *
 * A workbook is read a tab at a time: the first call opens the import and
 * names the tabs without reading any of them, and each call after it reads
 * exactly one. So this is a *delta* — the tables found on `sheet` — and the
 * screen accumulates them. Handing back the whole plan every time is what made
 * a 39-tab file impossible.
 */
export interface AnalyzeStep {
  import: LeadImportRecord;
  /** Null on the opening call, which reads nothing. */
  sheet: string | null;
  tables: PlanTable[];
  previews: TablePreview[];
  /** Boundaries the analyst got structurally wrong and the server put right. */
  repairs: string[];
  /** Who read this tab — "rules", or the model that answered. */
  analyzedBy: string | null;
  /** Anything the Owner needs to know about this tab, in their own words. */
  warnings: string[];
  progress: AnalyzeProgress;
}

/** The whole reading of a file, assembled from the steps above. */
export interface AnalyzeResponse {
  import: LeadImportRecord;
  plan: ImportPlan;
  previews: TablePreview[];
  sheets: { name: string; rows: number; columns: number }[];
  warning: string | null;
  repairs?: string[];
}

export type ProxyMode = "NONE" | "AUTO" | "DATACENTER" | "RESIDENTIAL";
export type NotifyMode = "OFF" | "FAILURES" | "ALL";

/** How lead capture behaves for every source — Settings → Lead capture. */
export interface CaptureConfig {
  maxItems: number;
  minScore: number;
  autoQualify: boolean;
  qualifyScore: number;
  timezone: string;
  runTimeoutSecs: number;
  /** 0 means "whatever the actor asks for". */
  memoryMbytes: number;
  proxyMode: ProxyMode;
  proxyCountry: string | null;
  monthlyBudgetUsd: number | null;
  /** Per run, enforced by Apify on pay-per-event actors. */
  maxRunChargeUsd: number | null;
  maxConcurrentRuns: number;
  location: string;
  countryCode: string;
  language: string;
  notify: NotifyMode;
  notifyEmail: string | null;
  retentionDays: number;
}

/** SMTP, or the Hostinger mailbox over its own MCP server. */
export type MailTransport = "SMTP" | "HOSTINGER";

/** What the Hostinger MCP server answered when it was last asked. */
export interface McpProbe {
  ok: boolean;
  /** The tool a send goes through. */
  tool: string | null;
  tools: string[];
  error: string | null;
}

export interface HostingerMailStatus {
  configured: boolean;
  envManaged: boolean;
  token: string | null;
  mailboxId: string | null;
  mailboxAddress: string | null;
  /** Every mailbox the token can send from — one of them is the sender. */
  mailboxes: Array<{ resourceId: string; address: string }>;
  error: string | null;
  mcp: McpProbe | null;
}

/** Everything the Owner configures at runtime — see the Settings page. */
// --- AI models -------------------------------------------------------------

export type ProviderKey = "anthropic" | "openai" | "gemini" | "perplexity" | "nvidia";

/** What is being asked for, in the app's own words rather than a vendor's. */
export type ModelJob =
  | "text"
  | "spreadsheet"
  | "organise"
  | "triage"
  | "image"
  | "html"
  | "factcheck"
  | "research"
  | "humanise"
  | "vision";

export interface ModelProvider {
  key: ProviderKey;
  /** What the Owner calls it. "ChatGPT", not "OpenAI's API". */
  name: string;
  vendor: string;
  purpose: string;
  configured: boolean;
  envManaged: boolean;
  /** Masked. Never the key itself. */
  keyPreview: string | null;
  model: string;
  defaultModel: string;
  models: string[];
  /** The cheap model this vendor offers, used by jobs on the economy tier. */
  economyModel: string;
  console: string;
  keyHint: string;
  /** The jobs this vendor can be routed to. */
  jobs: ModelJob[];
  /** The jobs currently routed here. */
  serving: ModelJob[];
}

/**
 * Who serves one job right now.
 *
 * `chosen` and `serving` differ when the vendor picked for a job has no key
 * yet — every job falls back to Claude, and `note` is the sentence saying so.
 */
export interface ModelRoute {
  job: ModelJob;
  chosen: ProviderKey;
  serving: ProviderKey;
  /** The model that will really serve this job — tier and override applied. */
  model: string;
  /** What the job costs by default. `economy` jobs ship on the cheap model. */
  tier: "economy" | "standard";
  /** The Owner's own model choice for this job, when they have made one. */
  modelOverride: string | null;
  ready: boolean;
  note: string | null;
}

export interface ModelJobInfo {
  job: ModelJob;
  /** A heading. Title case. */
  name: string;
  /** The same job inside a sentence — "Claude is covering **fact-checking**". */
  phrase: string;
  blurb: string;
  defaultProvider: ProviderKey;
  fallback: ProviderKey;
}

export interface ModelSettings {
  providers: ModelProvider[];
  routing: ModelRoute[];
  jobs: ModelJobInfo[];
}

/**
 * WhatsApp, and the two addresses Hubtel posts SMS replies back to.
 *
 * `verifyToken` and `inboundToken` are deliberately in the clear where every
 * other credential here is masked. They are not credentials — they are shared
 * strings that have to be typed into somebody else's dashboard, and a masked
 * one cannot be.
 */
export interface MessagingSettings {
  whatsapp: {
    configured: boolean;
    envManaged: boolean;
    token: string | null;
    phoneNumberId: string | null;
    businessId: string | null;
    appSecret: string | null;
    verifyToken: string | null;
    callbackUrl: string;
    /** False when no app secret is set, which means replies are stored and not acted on. */
    inboundTrusted: boolean;
    number: { displayNumber: string | null; verifiedName: string | null; qualityRating: string | null; messagingLimit: string | null } | null;
    numberError: string | null;
    approvedTemplates: number;
  };
  sms: {
    inboundToken: string | null;
    inboundUrl: string | null;
    statusUrl: string | null;
    inboundTrusted: boolean;
  };
  countryCode: string;
}

export interface AppSettings {
  apify: {
    connected: boolean;
    envManaged: boolean;
    token: string | null;
    account: {
      username?: string;
      profile?: { name?: string };
      plan?: { id?: string; monthlyUsageCreditsUsd?: number };
    } | null;
    error: string | null;
    usage: { spentUsd: number; includedUsd: number | null; cycleStart: string | null; cycleEnd: string | null } | null;
  };
  capture: {
    config: CaptureConfig;
    defaults: CaptureConfig;
    envManaged: { monthlyBudgetUsd: boolean; maxConcurrentRuns: boolean; timezone: boolean };
    /** Which pre-defined actor runs which kind of capture. */
    tasks: CaptureTaskInfo[];
    /** What an agent may start on its own, and how far it may go. */
    capabilities: CaptureCapability[];
    /** How many capture runs one agent task may start. */
    maxRunsPerTask: number;
  };
  analyst: {
    configured: boolean;
    envManaged: boolean;
    key: string | null;
    /**
     * Who reads an imported sheet right now — NVIDIA by default, Claude
     * standing in behind it. Same shape as a row on the AI models screen.
     */
    reading: ModelRoute;
  };
  models: ModelSettings;
  google: {
    configured: boolean;
    connected: boolean;
    envManaged: boolean;
    clientId: string | null;
    account: string | null;
    /** Paste into the Google OAuth client's authorised redirect URIs. */
    redirectUri: string;
  };
  stripe: {
    configured: boolean;
    envManaged: boolean;
    key: string | null;
    livemode: boolean | null;
    webhookConfigured: boolean;
    webhookUrl: string;
  };
  /** Paystack — the hosted payment page. The Ghanaian rail Stripe cannot serve. */
  paystack: {
    configured: boolean;
    envManaged: boolean;
    key: string | null;
    livemode: boolean | null;
    /** Paste this into Paystack's dashboard, or an invoice is never marked paid. */
    webhookUrl: string;
  };
  /** Hubtel — mobile money, and SMS on a separate credential pair. */
  hubtel: {
    configured: boolean;
    envManaged: boolean;
    clientId: string | null;
    merchantId: string | null;
    callbackUrl: string;
    sms: { configured: boolean; envManaged: boolean; smsId: string | null; sender: string | null };
  };
  /** Which repositories agents may write to. Empty means none, deliberately. */
  agentRepos: { envManaged: boolean; repos: string; writable: boolean };
  cloudinary: { configured: boolean; envManaged: boolean; cloudName: string | null; apiKey: string | null };
  alerts: {
    configured: boolean;
    /** Which route is live. A webhook posts to one channel; a token can choose. */
    transport: "TOKEN" | "WEBHOOK" | "NONE";
    envManaged: boolean;
    webhookUrl: string | null;
    botToken: string | null;
    defaultChannel: string | null;
    /**
     * The inbound half — whether Slack can talk *back*. Reported separately
     * from `configured` because they are genuinely different states: Slack can
     * be perfectly able to deliver an alert and unable to return a decision,
     * and the symptom of that is a hiring card whose buttons do nothing.
     */
    signingSecret: string | null;
    canReceive: boolean;
    signingSecretEnvManaged: boolean;
    /** Slack user ids allowed to decide a hire. Empty means anyone in the channel. */
    approvers: string[];
  };
  developer: { configured: boolean; envManaged: boolean; token: string | null; owner: string | null };
  calendar: {
    connected: boolean;
    /** False when the Google connection predates calendar access and needs redoing. */
    scoped: boolean;
    configured: boolean;
    calendarId: string;
    calendars: Array<{ id: string; name: string; primary: boolean }>;
  };
  webhooks: {
    configured: boolean;
    envManaged: boolean;
    secret: string;
    /** What the website contact form should post to. */
    formUrl: string;
    baseUrl: string;
    leadSource: string;
  };
  email: {
    /** Which of the two paths actually sends. */
    transport: MailTransport;
    /** Whether the live transport can send — not whether the other one could. */
    configured: boolean;
    envManaged: boolean;
    transportEnvManaged: boolean;
    host: string | null;
    port: number;
    secure: boolean;
    user: string | null;
    smtpConfigured: boolean;
    hostinger: HostingerMailStatus;
    fromName: string | null;
    fromEmail: string | null;
    replyTo: string | null;
    signature: string | null;
    /** Whether the same mailbox can be read. A different question from sending. */
    inbox: InboxSettings;
  };
  system: SystemSettings;
  general: {
    appUrl: string | null;
    appUrlEnvManaged: boolean;
    resolvedAppUrl: string;
    timezone: string;
  };
  messaging: MessagingSettings;

}

/** The four brand images. Keys match server/src/services/systemProfile.ts. */
export type BrandSlot = "logoLight" | "logoDark" | "mark" | "favicon";

/**
 * The company's own details — the name, address, phone number and artwork that
 * every email, PDF, proposal and public page is stamped with.
 *
 * One record, read by every renderer, so changing the phone number here
 * changes it on the letterhead, in the email footer, in the Word cut of a
 * proposal and in what the AI drafter is told. See the server's
 * services/systemProfile.ts for the list of surfaces.
 */
export interface CompanyProfile {
  name: string;
  displayName: string;
  legalName: string;
  tagline: string;
  footerLine: string;
  promise: string;
  positioning: string;
  location: string;
  addressLines: string[];
  email: string;
  phone: string;
  phoneAlt: string;
  web: string;
  social: { linkedin: string; x: string; instagram: string; facebook: string; youtube: string };
  currency: string;
  registrationNumber: string;
  vatNumber: string;
}

export interface SystemSettings {
  profile: CompanyProfile;
  /** What each field falls back to when it is left blank. */
  defaults: CompanyProfile;
  brand: Array<{ slot: BrandSlot; label: string; what: string; uploaded: boolean }>;
  /** The uploaded artwork as data URLs, for the previews on the panel. */
  images: Record<BrandSlot, string | null>;
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  webViewLink?: string;
  size?: string;
  owners?: { displayName?: string }[];
}

// --- The proposal writer ---------------------------------------------------

export type AuditSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "GOOD";
export type AuditArea = "WEBSITE" | "EMAIL" | "SECURITY" | "PRESENCE" | "BRAND" | "OPERATIONS";

/** One observed fact about a company, with the evidence it came from. */
export interface AuditFinding {
  id: string;
  area: AuditArea;
  severity: AuditSeverity;
  observed: string;
  evidence: string;
  service: string | null;
}

export interface CompanyAudit {
  ranAt: string;
  site: {
    requested: string;
    finalUrl: string | null;
    reachable: boolean;
    status: number | null;
    responseMs: number | null;
    https: boolean;
    platform: string | null;
    server: string | null;
  } | null;
  domain: { name: string; hasMx: boolean; mailProvider: string | null; hasSpf: boolean; hasDmarc: boolean } | null;
  findings: AuditFinding[];
  /** What was examined — so "not found" can be told from "not looked at". */
  checked: string[];
  notes: string[];
}

/** The argued document. Null on proposals written by hand. */
export interface ProposalBody {
  headline: string;
  situation: string;
  findings: { observed: string; evidence: string; costsThem: string; fix: string; service: string }[];
  scope: { phase: string; deliverables: string[]; outcome: string }[];
  investment: {
    lineItems: { description: string; amount: number; firm: boolean; billing: "ONE_OFF" | "MONTHLY" }[];
    total: number;
    totalIsFirm: boolean;
    recurring: number;
    basis: string;
  };
  timeline: string;
  whyUs: string;
  assumptions: string[];
  nextStep: string;
}

export interface ProposalDraft extends ProposalBody {
  title: string;
  serviceType: string;
  confidence: number;
  /** What the writer wanted to know and couldn't — questions for the call. */
  thinFacts: string[];
}

export interface ProposalDraftResponse {
  draft: ProposalDraft;
  audit: CompanyAudit;
  subject: {
    kind: "lead" | "client";
    leadId: string | null;
    clientId: string | null;
    companyName: string;
    contactName: string | null;
    contactEmail: string | null;
    cold: boolean;
  };
  /** Everything the writer was shown, so its reasoning can be checked. */
  facts: string[];
  model: string;
  usage: { inputTokens: number; outputTokens: number };
}

export interface Proposal {
  id: string;
  title: string;
  serviceType: string;
  scopeSummary: string;
  priceAmount: string;
  priceTier?: string | null;
  currency: string;
  status: string;
  sentAt?: string | null;
  pdfUrl?: string | null;
  createdAt: string;
  client?: Client | null;
  lead?: Lead | null;
  body?: ProposalBody | null;
  audit?: CompanyAudit | null;
  generatedBy?: string | null;
  confidence?: number | null;
}

export interface Project {
  id: string;
  name: string;
  serviceType: string;
  scopeSummary: string;
  status: string;
  startDate?: string | null;
  endDate?: string | null;
  budgetAmount?: string | null;
  actualHours: string;
  client: Client;
  assignments?: { user: { id: string; name: string } }[];
  _count?: { tasks: number; milestones: number };
}

export interface Task {
  id: string;
  title: string;
  status: string;
  dueDate?: string | null;
  assignee?: { id: string; name: string } | null;
}

export interface Milestone {
  id: string;
  title: string;
  dueDate?: string | null;
  completedAt?: string | null;
}

export interface InvoiceLineItem {
  id: string;
  description: string;
  quantity: string;
  unitPrice: string;
  amount: string;
}

export interface Invoice {
  id: string;
  invoiceNumber: string;
  currency: string;
  amountTotal: string;
  status: string;
  issueDate: string;
  dueDate: string;
  paidAt?: string | null;
  pdfUrl?: string | null;
  client: Client;
  lineItems: InvoiceLineItem[];
}

// --- Care plans ------------------------------------------------------------

export type CarePlanTier = "SME_ESSENTIALS" | "GROWTH" | "ENTERPRISE_CONCIERGE";
export type CarePlanStatus = "ACTIVE" | "PAUSED" | "CHURNED";

/** One billed month. `settledAt` is null until its hours have been counted. */
export interface CarePlanCycle {
  id: string;
  periodStart: string;
  periodEnd: string;
  monthlyFee: string;
  includedHours?: string | null;
  hoursUsed?: string | null;
  overageHours?: string | null;
  overageAmount?: string | null;
  settledAt?: string | null;
  invoice?: {
    id: string;
    invoiceNumber: string;
    status: string;
    amountTotal: string;
    currency: string;
    pdfUrl?: string | null;
  } | null;
}

/** Hours in the period running right now — computed, never stored. */
export interface CarePlanUsage {
  periodStart: string;
  periodEnd: string;
  hoursUsed: number;
  includedHours: number | null;
  hoursRemaining: number | null;
}

export interface CarePlan {
  id: string;
  tier: CarePlanTier;
  status: CarePlanStatus;
  monthlyFee: string;
  currency: string;
  billingDay: number;
  timezone: string;
  autoInvoice: boolean;
  dueDays: number;
  nextBillingAt?: string | null;
  lastBilledAt?: string | null;
  includedHours?: string | null;
  overageHourlyRate?: string | null;
  reviewEveryMonths: number;
  nextReviewAt?: string | null;
  lastReviewAt?: string | null;
  startedAt: string;
  pausedAt?: string | null;
  churnedAt?: string | null;
  churnReason?: string | null;
  notes?: string | null;
  client: { id: string; name: string; company?: string | null; email?: string | null };
  project?: { id: string; name: string; status: string } | null;
  projectId?: string | null;
  usage?: CarePlanUsage;
  cycles?: CarePlanCycle[];
  _count?: { invoices: number; cycles: number };
}

export type BillOutcome =
  | { billed: true; invoiceId: string; invoiceNumber: string; periodStart: string; amountTotal: number }
  | { billed: false; reason: "already-billed" | "not-active" | "not-due"; periodStart?: string };

// --- Email -----------------------------------------------------------------

export type EmailPurpose =
  | "COLD_OUTREACH"
  | "FOLLOW_UP"
  | "MEETING_REQUEST"
  | "PROPOSAL_COVER"
  | "DELIVERABLE_HANDOVER"
  | "PROJECT_UPDATE"
  | "INVOICE_DELIVERY"
  | "INVOICE_REMINDER"
  | "CARE_PLAN_REVIEW"
  | "ONBOARDING"
  | "REACTIVATION"
  | "THANK_YOU"
  | "ANNOUNCEMENT"
  | "DEMO_READY"
  | "CUSTOM";

export type EmailStatus = "DRAFT" | "SCHEDULED" | "SENDING" | "SENT" | "FAILED" | "CANCELLED";
export type EmailKind = "MANUAL" | "TEMPLATE" | "AI_DRAFT" | "SEQUENCE" | "AUTOMATION";

/**
 * Four kinds, and the difference is when the bytes exist: `stored` is a real
 * uploaded file, `file` is a URL fetched at send, and the two document kinds
 * are rendered fresh at send so what a client receives is the document as it
 * stands then. See the server's services/emailSender.ts.
 */
export type EmailAttachment =
  | { kind: "stored"; fileId: string; name: string; contentType?: string; size?: number }
  | { kind?: "file"; name: string; url: string; contentType?: string }
  | { kind: "invoice"; invoiceId: string; name?: string }
  | { kind: "proposal"; proposalId: string; name?: string };

/** What the upload endpoint answers with. */
export interface StoredFile {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  createdAt: string;
}

/** One attachment as the preview describes it — enough to draw a chip. */
export interface PreviewAttachment {
  kind: "stored" | "file" | "invoice" | "proposal";
  name: string;
  contentType: string | null;
  size: number | null;
  fileId?: string | null;
  url?: string | null;
  note?: string | null;
  /** True when the file it names is gone and the send will skip it. */
  missing: boolean;
}

/**
 * The email as it will actually land: full letterhead, placeholders filled,
 * signature appended, opt-out present exactly when it would be.
 */
export interface EmailPreview {
  subject: string;
  html: string;
  text: string;
  toEmail: string;
  toName: string | null;
  from: { name: string; email: string; replyTo: string | null };
  variables: Record<string, string>;
  /** Placeholders nothing fills — the reason to look before sending. */
  unresolved: string[];
  attachments: PreviewAttachment[];
  suppressed: string | null;
  /** True when this is the stored record of a sent email rather than a re-render. */
  historical: boolean;
}

export interface EmailMessage {
  id: string;
  subject: string;
  bodyHtml: string;
  bodyText: string;
  toEmail: string;
  toName?: string | null;
  cc: string[];
  bcc: string[];
  status: EmailStatus;
  kind: EmailKind;
  purpose: EmailPurpose;
  scheduledFor?: string | null;
  sentAt?: string | null;
  failedAt?: string | null;
  error?: string | null;
  attempts: number;
  attachments: EmailAttachment[];
  createdAt: string;
  lead?: { id: string; contactName: string; companyName?: string | null } | null;
  client?: { id: string; name: string } | null;
  invoice?: { id: string; invoiceNumber: string } | null;
  proposal?: { id: string; title: string } | null;
  template?: { id: string; name: string } | null;
  step?: { position: number; sequence: { id: string; name: string } } | null;
}

/** What the drafter sees — shown in the composer so the writer sees it too. */
export interface EmailContext {
  kind: "lead" | "client" | "address";
  email: string | null;
  name: string | null;
  facts: string[];
  variables: Record<string, string>;
  suppressed: string | null;
  leadId?: string;
  clientId?: string;
  /** When somebody last went and looked at this business. Null means nobody has. */
  preparedAt?: string | null;
  /** What the looking could not establish. */
  prepNotes?: string[];
}

export type DemoStatus = "DRAFT" | "READY" | "SENT" | "ACCEPTED" | "DECLINED" | "ARCHIVED";

/** A landing page built for one prospect, hosted at /demos/<slug>. */
export interface Demo {
  id: string;
  slug: string;
  title: string;
  businessName: string;
  status: DemoStatus;
  version: number;
  views: number;
  lastViewedAt?: string | null;
  sentAt?: string | null;
  builtBy?: string | null;
  buildCostUsd?: string | number;
  createdAt: string;
  updatedAt: string;
  /** The public address, assembled server-side so there is one spelling of it. */
  url: string;
  lead?: { id: string; contactName: string; companyName?: string | null; contactEmail?: string | null; website?: string | null } | null;
  /** The design direction it was built to, and where that came from. */
  references?: {
    direction: string;
    references: { name: string; source: string; url: string; whyItFits: string }[];
    avoid: string[];
    chosenBy: string;
    fromLiveSources: boolean;
    note?: string | null;
  } | null;
  brief?: { headline?: string; sections?: string[]; usedFacts?: string[] } | null;
}

// --- The website audit team -------------------------------------------------

export type AuditDiscipline = "UX" | "SPEED_SEO" | "CONTENT" | "SECURITY";

export const AUDIT_DISCIPLINE_NAMES: Record<AuditDiscipline, string> = {
  UX: "UI/UX",
  SPEED_SEO: "Speed & SEO",
  CONTENT: "Content",
  SECURITY: "Security",
};

export interface AuditFindingDetail {
  id: string;
  discipline: AuditDiscipline;
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "GOOD";
  title: string;
  observed: string;
  evidence: string;
  impact: string;
  /** The same point with no technical vocabulary. What an email should use. */
  plainly: string;
  recommendation?: string | null;
  /** The numbered box on the marked-up screenshot, when there is one. */
  marker?: number | null;
}

export interface AuditDisciplineReport {
  discipline: AuditDiscipline;
  /** The agent that owns this section. */
  reviewer: string;
  /** The model that answered, or "checked directly" when no model was involved. */
  reviewedBy: string;
  score: number;
  /** False when the reviewer could not run. An unscored section shows a dash. */
  scored: boolean;
  headline: string;
  summary: string;
  findings: AuditFindingDetail[];
  checked: string[];
  notes: string[];
}

export interface WebsiteAuditReport {
  businessName: string;
  website?: string | null;
  ranAt: string;
  overallScore: number;
  /**
   * Whether enough of the site was examined to show `overallScore` at all.
   * Absent on rows written before the coverage gate — see `auditScored`.
   */
  scored?: boolean;
  verdict: string;
  disciplines: AuditDisciplineReport[];
  synthesis?: {
    executiveSummary: string;
    theOneThing: string;
    worthFixing: { problem: string; costsThem: string; whyWorthPaying: string };
    priority: { findingId: string; why: string }[];
    whatIsWorking: string[];
    emailBrief: { openOn: string; consequence: string; ask: "DEMO" | "FIX" | "NOTHING"; whyThatAsk: string; doNotSay: string[] };
  } | null;
  screenshots: { view: "desktop" | "mobile"; width: number; height: number; cropped: boolean; takenAt: string; annotatedBase64?: string | null }[];
  notes: string[];
  costUsd: number;
}

/** What a list or a drawer shows. Never the report or the Markdown — both are large. */
export interface WebsiteAuditSummary {
  id: string;
  leadId?: string | null;
  businessName?: string;
  website?: string | null;
  ranAt: string;
  overallScore: number;
  verdict: string;
  pdfFileId?: string | null;
  markdownFileId?: string | null;
  screenshots?: { view: "desktop" | "mobile"; annotated: boolean; fileId: string }[] | null;
  costUsd?: string | number;
}

/** The whole row, from `GET /audits/:id`. */
export interface WebsiteAudit extends WebsiteAuditSummary {
  report: WebsiteAuditReport;
  markdown: string;
}

/**
 * Whether the scan found anything worth writing about. WEAK and NONE mean the
 * business is doing fine — writing to them anyway is how a name gets burnt.
 */
export type CaseStrength = "STRONG" | "MODERATE" | "WEAK" | "NONE";

/** One thing a model saw in a picture of a homepage. */
export interface HomepageObservation {
  observed: string;
  soWhat: string;
  /** The same point with no web vocabulary in it — the version worth sending. */
  plainly?: string;
  where: string;
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "GOOD";
}

export interface HomepageLook {
  firstImpression: string;
  offerClear: boolean;
  contactClear: boolean;
  looksDated?: string | null;
  /** Whether the page looks like it belongs to a business of this kind and size. */
  fitsTheBusiness?: boolean;
  fitNote?: string;
  speed?: string | null;
  observations: HomepageObservation[];
  /** The case for spending money, in the owner's own terms. */
  worthFixing?: { problem: string; costsThem: string; whyWorthPaying: string } | null;
  theOneThing: string;
  /** What the page states about the business, as opposed to how it looks. */
  states?: { trade: string | null; town: string | null; services: string[]; phone: string | null };
  lookedBy: string;
}

export interface Screenshot {
  requested: string;
  finalUrl?: string | null;
  takenAt: string;
  viewportWidth: number;
  width: number;
  height: number;
  cropped: boolean;
  imageUrl: string;
  bytes: number;
  costUsd?: number | null;
}

/**
 * What was found by going and looking at a business, rather than by being
 * handed a scraped row. Written by services/leadPrep.ts.
 */
export interface LeadResearch {
  id: string;
  leadId: string;
  ranAt: string;
  filled?: Record<string, { value: string; source: string }> | null;
  research?: {
    discoveryNote: string;
    couldNotFind: string[];
    researchedBy: string;
    searchedLiveSources: boolean;
    sources: { title: string; url: string; date?: string | null }[];
    proposedContact?: { email: string | null; phone: string | null; source: string } | null;
  } | null;
  audit?: {
    site?: { finalUrl?: string | null; reachable: boolean; platform?: string | null; https: boolean } | null;
    findings: { id: string; area: string; severity: string; observed: string; evidence: string }[];
    checked: string[];
  } | null;
  shot?: Screenshot | null;
  look?: HomepageLook | null;
  facts: string[];
  notes: string[];
  costUsd: string | number;
}

/** What the composer gets back from POST /emails/draft. */
/** One item of the playbook's pre-send checklist, as the server ran it. */
export interface PreSendCheck {
  id: string;
  label: string;
  severity: "BLOCK" | "WARN";
  passed: boolean;
  detail: string;
}

/**
 * The checklist as a whole. Named rather than left inline because the message
 * drafter returns exactly the same shape — the playbook is one doctrine across
 * email, WhatsApp and SMS, and two names for its report would be the first
 * step towards two doctrines.
 */
export interface PreSendReport {
  checks: PreSendCheck[];
  sendable: boolean;
  blocking: PreSendCheck[];
  warnings: PreSendCheck[];
  humanMustConfirm: string[];
}

export interface EmailDraft {
  subject: string;
  body: string;
  rationale: string;
  confidence: number;
  /** Which of the playbook's eighteen scenarios this is, when the findings chose one. */
  scenario?: {
    key: string;
    number: number;
    name: string;
    contact: string;
    /** Shows how small the ask should be. Not the question to write. */
    exampleAsk: string;
    guard: string | null;
    matched: string[];
    alsoAvailable: { key: string; name: string; matched: string[] }[];
  } | null;
  /** The scenarios a person can pick, which need evidence no check can supply. */
  pickableScenarios?: { key: string; number: number; name: string }[];
  /** The pre-send checklist. `sendable` is false when something blocking failed. */
  checks?: {
    checks: PreSendCheck[];
    sendable: boolean;
    blocking: PreSendCheck[];
    warnings: PreSendCheck[];
    humanMustConfirm: string[];
  } | null;
  model: string;
  variables: Record<string, string>;
  facts: string[];
  /** The draft as written, before the plain-English pass. Null when it did not run. */
  beforePolish?: { subject: string; body: string } | null;
  polish?: {
    polishedBy: string;
    changes: string[];
    servesPurpose: boolean;
    concerns: string[];
    /** Anything the polish put in that the draft did not say. Should be empty. */
    added: string[];
  } | null;
  polishError?: string | null;
  /** Present when this request went and looked at the business first. */
  prep?: {
    ranAt: string;
    ranNow: boolean;
    researchedBy?: string | null;
    searchedLiveSources: boolean;
    filled: Record<string, { value: string; source: string }>;
    proposedContact?: { email: string | null; phone: string | null; source: string } | null;
    look?: HomepageLook | null;
    shot?: Screenshot | null;
    notes: string[];
    strength: CaseStrength;
    costUsd: number;
  } | null;
  prepError?: string | null;
  preparedAt?: string | null;
  /** Whether there was anything here worth writing about at all. */
  strength?: CaseStrength | null;
  /**
   * The demo page, for a business with no website of its own — where the page
   * is the argument and the ask rather than an optional extra.
   */
  demo?: { url: string | null; demoId: string | null; built: boolean; note: string | null; costUsd: number } | null;
  /** The website review this letter will carry, when several faults were found. */
  willAttachReport?: { kind: "audit"; auditId: string; name?: string } | null;
}

/**
 * What the workforce is told this company sells, read from dakyworld.com.
 *
 * There is no editable copy of this in the app on purpose — the website is the
 * source. See `server/src/services/context/business.ts`.
 */
export interface BusinessContext {
  offer: {
    positioning: string;
    summary: string[];
    doesNotDo: string[];
    proofPoints: string[];
    services: { id: string; name: string; what: string; fixes: string[]; anchorPrice: number | null; billing: "ONE_OFF" | "MONTHLY"; priceNote: string }[];
    plans: { tier: string; monthly: number | null; discountedMonthly: number | null; discountNote: string; for: string }[];
    projects: { name: string; from: number | null; what: string }[];
    offers: string[];
  };
  /** Whether this came from the website, or from the catalogue the app ships with. */
  from: "website" | "shipped";
  syncedAt: string | null;
  pages: string[];
  readBy: string | null;
  /** The two blocks as they appear in an agent's prompt. */
  brand: string;
  catalogue: string;
  shippedPages: string[];
}

export interface EmailTemplate {
  id: string;
  name: string;
  slug: string;
  purpose: EmailPurpose;
  description?: string | null;
  subject: string;
  bodyHtml: string;
  aiBrief?: string | null;
  builtin: boolean;
  active: boolean;
  usageCount: number;
}

export type SequenceTrigger =
  | "MANUAL"
  | "LEAD_CREATED"
  | "LEAD_STATUS_CHANGED"
  | "PROPOSAL_SENT"
  | "PROJECT_COMPLETED"
  | "INVOICE_OVERDUE"
  | "CARE_PLAN_REVIEW_DUE";

export interface SequenceStep {
  id?: string;
  position: number;
  delayDays: number;
  templateId?: string | null;
  subject?: string | null;
  bodyHtml?: string | null;
  useAi: boolean;
  aiBrief?: string | null;
  purpose: EmailPurpose;
  template?: { id: string; name: string } | null;
}

export interface EmailSequence {
  id: string;
  name: string;
  description?: string | null;
  trigger: SequenceTrigger;
  triggerFilter?: Record<string, unknown> | null;
  active: boolean;
  stopOnReply: boolean;
  requireApproval: boolean;
  sendWindowStart: number;
  sendWindowEnd: number;
  weekdaysOnly: boolean;
  timezone: string;
  steps: SequenceStep[];
  activeEnrollments?: number;
  _count?: { enrollments: number };
}

export interface EmailEnrollment {
  id: string;
  status: "ACTIVE" | "COMPLETED" | "STOPPED";
  toEmail: string;
  nextPosition: number;
  nextSendAt?: string | null;
  stopReason?: string | null;
  startedAt: string;
  lead?: { id: string; contactName: string; companyName?: string | null } | null;
  client?: { id: string; name: string } | null;
  _count?: { messages: number };
}

export interface EmailSuppression {
  id: string;
  email: string;
  reason: string;
  source: string;
  createdAt: string;
}

export interface EmailStatusSummary {
  connected: boolean;
  drafterReady: boolean;
  drafts: number;
  scheduled: number;
  sent: number;
  failed: number;
  activeSequences: number;
  activeEnrollments: number;
  suppressed: number;
}

export interface DashboardData {
  revenueThisMonth: string;
  monthlyRecurringRevenue: string;
  activeCarePlanCount: number;
  outstandingInvoiceTotal: string;
  outstandingInvoiceCount: number;
  pipelineValue: string;
  openProposalCount: number;
  leadsByStatus: { status: string; _count: number }[];
  /** Retainer health, so churn and an overdue review are visible without a click. */
  carePlans: {
    active: number;
    paused: number;
    churnedThisQuarter: number;
    billingWithin7Days: number;
    reviewsDue: number;
    draftInvoices: number;
    nextBilling: { id: string; client: string; at: string; amount: string; currency: string } | null;
  };
}

export interface User {
  id: string;
  name: string;
  email: string;
  role: string;
}

// --- Agent workforce -------------------------------------------------------
// Shadows the Agent model in server/prisma/schema.prisma. Only what the
// workforce screen renders is typed here, deliberately — the server owns the
// rest and a half-copied model is worse than none.

export type AgentTier = "BOARD" | "EXECUTIVE" | "FUNCTIONAL" | "OPERATIONAL" | "SUB_AGENT";
export type AgentStatus = "DRAFT" | "ACTIVE" | "PAUSED" | "RETIRED";

export interface Agent {
  id: string;
  key: string;
  name: string;
  title: string;
  tier: AgentTier;
  department: string;
  managerKey: string | null;
  managerName: string | null;
  status: AgentStatus;
  mission: string;
  responsibilities: string[];
  kpis: string[];
  autonomyLevel: number;
  dryRun: boolean;
  toolkit: string[];
  /** What this one is good at, in a client's words. Empty on the management tier. */
  skills: string[];
  /** One glyph for the roster. */
  avatar: string | null;
  /** True for an agent the Owner created rather than one the seed shipped. */
  custom: boolean;
  /** Set when the Owner has rewritten a seeded agent's wording. Null means it is as shipped. */
  promptEditedAt?: string | null;
  /** Prose written here that replaces the ten layers. Null means the layers are still the instruction. */
  promptText?: string | null;
  /** What it has on right now. Present on the roster. */
  work?: AgentWorkload;
  /**
   * How many tasks it may start in a day, a week and a month.
   *
   * Null is no ceiling; **0 is a ceiling of none** — the way to stop an agent
   * taking work without retiring it. A budget says how much may be spent and
   * nothing about how often, which is the gap these close.
   */
  maxTasksPerDay: number | null;
  maxTasksPerWeek: number | null;
  maxTasksPerMonth: number | null;
  escalationPolicy: string | null;
  prompt: Record<string, string>;
}

export interface AgentDetail extends Agent {
  reports: Array<{ key: string; name: string; title: string }>;
  /** Every catalogue tool, with whether this agent may call it and why not. */
  tools: Array<{
    key: string;
    name: string;
    group: string;
    purpose: string;
    scope: "read" | "write" | "send" | "charge";
    spends: boolean;
    outward: boolean;
    granted: boolean;
    ready: boolean;
    blockedReason: string | null;
    /** False when the call would be refused outright, not merely held at a preview. */
    allowed: boolean;
    mustDryRun: boolean;
    permissionNote: string | null;
  }>;
  work: { running: number; queued: number; waiting: number; done: number; failed: number };
  memories: number;
  /** How many memories the whole company holds — every agent is shown these. */
  sharedMemories: number;
  /** The ten prompt layers in order, so the editor doesn't keep its own copy. */
  promptLayers: string[];
  /** True when there is shipped wording to reset to. */
  resettable: boolean;
  /**
   * What it has started in each period, against its ceiling.
   *
   * Returned whether or not a ceiling is set: "12 today, no limit" is the
   * number somebody needs in order to decide what the limit should be.
   */
  pace: Array<{ period: "DAY" | "WEEK" | "MONTH"; started: number; limit: number | null }>;
  /** True when it is mid-task, so an edit lands after the one it is on. */
  busy: boolean;
}

/** The shipped wording for a seeded agent, for comparing against an edit. */
/** One labelled block of the prompt an agent actually receives. */
export interface PromptRegion {
  key: "instruction" | "skills" | "brand" | "contact" | "voice" | "shared" | "own" | "method" | "working";
  label: string;
  /** Where the words come from, for somebody deciding whether they can change them. */
  source: string;
  /** True only for the part a person authored. The rest is assembled at run time. */
  editable: boolean;
  text: string;
}

/**
 * The prompt as the model gets it.
 *
 * The screen used to draw the ten stored layers, which is what the database
 * holds and not what the agent is told — most of the prompt was assembled
 * elsewhere and never shown. This is the assembled thing, from the same
 * function the runner calls.
 */
export interface CompiledPrompt {
  regions: PromptRegion[];
  /** The whole thing, joined. What a copy button would copy. */
  text: string;
  /** Just the authored part, which is what an edit starts from. */
  instruction: string;
  /** True when prose written here has replaced the ten shipped sections. */
  overridden: boolean;
  layers: string[];
  prompt: Record<string, string>;
  resettable: boolean;
  approxTokens: number;
  /**
   * The deliverables this agent's wording writes outside its own tasks — the
   * cold email, the proposal, an audit section. Empty for most of the roster.
   */
  writes?: WriterJobStatus[];
}

/** The prompt that writes one deliverable, as the model receives it. */
export interface WriterBrief {
  job: string;
  label: string;
  what: string;
  where: string;
  outward: boolean;
  /** What would be sent right now — the founder's wording, or the shipped default. */
  text: string;
  source: "override" | "agent" | "shipped";
  explains: string;
  /** The wording Dakyworld ships, so "put it back" needs no second call. */
  shipped: string;
  edited: boolean;
}

/** A pasted instruction, filed into the ten sections by a model. */
export interface OrganisedPrompt {
  layers: Record<string, string>;
  /** Anything it could not confidently place, quoted. Normally empty. */
  unplaced: string[];
  summary: string;
  organisedBy: string;
  note: string | null;
  costUsd: number;
}

/** One thing an agent's instruction writes, and whether it is doing so yet. */
export interface WriterJobStatus {
  job: string;
  label: string;
  what: string;
  /** True when somebody outside Dakyworld reads it. */
  outward: boolean;
  /** The file that composes the call, for anyone reading the server. */
  where: string;
  source: "override" | "agent" | "shipped";
  /** True when this agent's own wording is what writes it today. */
  active: boolean;
  explains: string;
}

export interface ShippedPrompt {
  layers: string[];
  prompt: Record<string, string>;
  name: string;
  title: string;
  mission: string;
  skills: string[];
  kpis: string[];
  escalationPolicy: string;
}

export interface AgentList {
  agents: Agent[];
  summary: { total: number; active: number; aboveDraft: number; specialists: number; working: number; waiting: number };
}

// --- The runtime -----------------------------------------------------------

export type AgentTaskStatus = "QUEUED" | "RUNNING" | "NEEDS_APPROVAL" | "BLOCKED" | "DONE" | "FAILED" | "CANCELLED";
export type AgentTaskOrigin = "OWNER" | "SCHEDULE" | "EVENT" | "AGENT";
/**
 * Every kind of step a task's timeline can hold.
 *
 * Kept in step with `AgentStepKind` in schema.prisma. Six of these were added
 * server-side over August and never reached this union, so a CONSULTED or
 * HANDED_OFF step rendered with the fallback glyph — the two kinds that are
 * one agent reaching another, which is the most interesting thing a timeline
 * ever shows, drawn as an anonymous dot.
 */
export type AgentStepKind =
  | "STARTED"
  | "THOUGHT"
  | "TOOL_CALL"
  | "PREPARED"
  | "REFUSED"
  | "DELEGATED"
  | "CONSULTED"
  | "HANDED_OFF"
  | "GAP_RAISED"
  | "REMEMBERED"
  | "NOTED"
  | "BLOCKED"
  | "FINISHED"
  | "FAILED"
  | "INTERRUPTED"
  | "RESUMED"
  | "SERVING";

/** How much work an agent has on. Shown on its card, so the roster is live. */
export interface AgentWorkload {
  running: number;
  queued: number;
  waiting: number;
}

export interface AgentTask {
  id: string;
  title: string;
  status: AgentTaskStatus;
  priority: number;
  origin: AgentTaskOrigin;
  summary: string | null;
  blockedReason: string | null;
  error: string | null;
  costUsd: number;
  toolCalls: number;
  /** How many calls were prepared rather than carried out. */
  dryRunCalls: number;
  startedAt: string | null;
  finishedAt: string | null;
  scheduledFor: string | null;
  dueAt: string | null;
  createdAt: string;
  /**
   * Waiting on a clock rather than on a runner.
   *
   * A paused task is QUEUED — it was put down because a model provider was
   * rate-limiting, busy or unreachable, and it starts itself again. Worth its
   * own field rather than left to each screen to derive: "queued" and "paused
   * until 14:35 because the free tier is used up" are the same status and
   * completely different news.
   */
  paused: boolean;
  pausedUntil: string | null;
  pausedBecause: string | null;
  /** How many times this run has been put down for something outside it. */
  pauses: number;
  agent: { key: string; name: string; title: string; avatar: string | null };
  steps: number;
  delegated: number;
}

/** One entry in a task's timeline, written as it happened. */
export interface AgentTaskStep {
  id: string;
  seq: number;
  kind: AgentStepKind;
  message: string;
  tool: string | null;
  ok: boolean | null;
  dryRun: boolean | null;
  data: unknown;
  createdAt: string;
}

export interface AgentTaskDetail extends Omit<AgentTask, "steps"> {
  /**
   * Where a resumed run would carry on from, when there is a checkpoint.
   * Null means it would start from the brief.
   */
  resumesFrom?: { steps: number; savedAt: string } | null;
  /** Last sign of life from the process working on it. */
  heartbeatAt?: string | null;
  /** Somebody has asked it to stop and it has not got there yet. */
  stopRequested?: boolean;
  brief: string;
  input: unknown;
  result: unknown;
  attempts: number;
  steps: AgentTaskStep[];
  parent: { id: string; title: string; agent: { name: string } } | null;
  children: Array<{ id: string; title: string; status: AgentTaskStatus; agent: { key: string; name: string } }>;
  about: {
    lead: { id: string; contactName: string; companyName: string | null } | null;
    client: { id: string; name: string } | null;
    project: { id: string; name: string } | null;
    proposal: { id: string; title: string } | null;
    invoice: { id: string; invoiceNumber: string } | null;
  };
}

/** An agent's board, split the way a person reads it. */
export interface AgentWork {
  running: AgentTask[];
  queued: AgentTask[];
  waiting: AgentTask[];
  finished: AgentTask[];
  summary: { running: number; queued: number; waiting: number; done: number; spendUsd: number };
}

export type AgentMemoryKind = "DECISION" | "OUTCOME" | "FACT" | "LESSON" | "PREFERENCE";

/**
 * `AGENT` is one agent's own and only it is shown them. `SHARED` belongs to the
 * company and every agent is shown them.
 */
export type AgentMemoryScope = "AGENT" | "SHARED";

export interface AgentMemory {
  id: string;
  kind: AgentMemoryKind;
  scope: AgentMemoryScope;
  /** Null on a shared memory — it belongs to the company, not to an agent. */
  agentKey: string | null;
  /** Who concluded it. `owner` when a person typed it. */
  authorKey: string | null;
  /** `lead:abc`, `client:xyz`, `self` for a standing lesson, `company` for a house rule. */
  subject: string;
  content: string;
  importance: number;
  sourceTaskId: string | null;
  useCount: number;
  lastUsedAt: string | null;
  expiresAt?: string | null;
  createdAt: string;
}

export interface AgentMemoryList {
  memories: AgentMemory[];
  summary: { total: number; subjects: number; neverUsed: number };
}

export interface SharedMemoryList {
  memories: AgentMemory[];
  summary: { total: number; standing: number; subjects: number; neverUsed: number };
}

/** One agent's row on the "who may call this tool" screen. */
export interface ToolGrantee {
  key: string;
  name: string;
  title: string;
  tier: AgentTier;
  department: string;
  status: AgentStatus;
  granted: boolean;
  /** False when the call would be refused outright, not merely held at a preview. */
  allowed: boolean;
  mustDryRun: boolean;
  permissionNote: string | null;
}

export interface ToolAgents {
  tool: { key: string; name: string; group: string; purpose: string; scope: string; spends: boolean; outward: boolean };
  agents: ToolGrantee[];
}

// --- Connected tools (MCP) -------------------------------------------------

/**
 * An MCP server this app has been pointed at.
 *
 * How a capability gets added without a deploy. The server declares its own
 * tools; each becomes a grantable catalogue entry under `mcp.<key>.<tool>`,
 * called through the same invoker, gate and audit trail as a built-in one.
 * `scope`, `spends` and `outward` are the Owner's settings, never the
 * server's own claims about itself.
 */
export interface McpServerRow {
  id: string;
  key: string;
  name: string;
  purpose: string | null;
  url: string;
  hasAuth: boolean;
  authHint: string | null;
  enabled: boolean;
  scope: "read" | "write" | "send" | "charge";
  spends: boolean;
  outward: boolean;
  tools: Array<{ name: string; description: string | null }>;
  toolCount: number;
  lastCheckedAt: string | null;
  lastError: string | null;
  createdAt: string;
}

export interface McpServerList {
  servers: McpServerRow[];
  summary: { total: number; enabled: number; tools: number; failing: number };
}

// --- Quick capture ---------------------------------------------------------

export type CaptureTargetKind = "WEBSITE" | "MAPS_SEARCH" | "LINKEDIN_COMPANY" | "FACEBOOK_PAGE" | "INSTAGRAM";

export interface CaptureTarget {
  kind: CaptureTargetKind;
  value: string;
  why: string;
}

export interface CaptureIntent {
  targets: CaptureTarget[];
  wants: string[];
  question: string;
  summary: string;
  /** True when the classifier resolved it without a model call — i.e. it cost nothing. */
  free: boolean;
}

export interface CaptureRunResult {
  started: Array<{ kind: string; runId: string; count: number }>;
  failed: Array<{ kind: string; reason: string }>;
}

/** One kind of capture and the pre-defined actor behind it. */
export interface CaptureTaskInfo {
  kind: CaptureTargetKind;
  label: string;
  family: "Website" | "Social media" | "Directories";
  /** What this task takes, in plain words. */
  takes: string;
  example: string;
  defaultActorId: string;
  actorId: string;
  /** True when this task has been pointed at an actor other than the shipped one. */
  overridden: boolean;
  input: Record<string, unknown>;
}

/**
 * What an agent is allowed to do with one capture task.
 *
 * Separate from `CaptureTaskInfo` because the two are separate decisions: that
 * one says which actor runs the task, this one says whether the workforce may
 * start it and how big one call may be. Switching a capability off leaves
 * Quick capture — which a person drives — working exactly as before.
 */
export interface CaptureCapability {
  kind: CaptureTargetKind;
  label: string;
  /** What an agent is told this is for. */
  purpose: string;
  /** What an agent is told to use instead. */
  notFor: string;
  actorId: string;
  enabled: boolean;
  maxTargets: number;
  maxResults: number;
  waitSecs: number;
  /** Hours a capture stays current enough to reuse. 0 for a task that is never reused. */
  cacheHours: number;
  /** True only for a task whose targets are named, so a recent capture can be found again. */
  cacheable: boolean;
  /** True when a limit here has been changed from the shipped one. */
  overridden: boolean;
}

/** The answer to "would this value run as this task?", before anything is charged. */
export interface CaptureCheck {
  value: string;
  problem: string | null;
  suggestion: CaptureTargetKind | null;
}

// --- Tools -----------------------------------------------------------------

export type ToolState = "READY" | "NEEDS_KEY" | "PLANNED";

export interface ToolStatus {
  key: string;
  name: string;
  purpose: string;
  settingsTab: string | null;
  needs: string | null;
  state: ToolState;
  scopes: string[];
  spends: boolean;
  /** A faster way to satisfy this tool than its settings tab, when one exists. */
  shortcut?: { label: string; to: string } | null;
  /** Catalogue keys an agent can be granted against this integration. */
  tools: string[];
  outwardTools: number;
}

export interface ToolsResponse {
  tools: ToolStatus[];
  summary: { ready: number; needsKey: number; planned: number; callable: number; total: number };
}

/** One callable tool, as the catalogue describes it. */
export interface CatalogueTool {
  key: string;
  name: string;
  group: string;
  purpose: string;
  scope: "read" | "write" | "send" | "charge";
  requires: string;
  spends: boolean;
  /** True when a call is visible to somebody outside the company. */
  outward: boolean;
  canPreview: boolean;
  ready: boolean;
  blockedReason: string | null;
  /** Present only when the catalogue was asked about one agent. */
  granted?: boolean;
  mustDryRun?: boolean;
  permissionNote?: string | null;
}

export interface CatalogueResponse {
  tools: CatalogueTool[];
  groups: string[];
  summary: { total: number; ready: number; outward: number; spending: number };
}

export interface ToolCallResult {
  tool: string;
  ok: boolean;
  output: unknown;
  dryRun: boolean;
  /** Set on a dry run: what would have happened. */
  wouldDo?: string;
  error?: string;
  refusedReason?: string;
  costUsd: number;
  durationMs: number;
}

export interface ToolCallRecord {
  id: string;
  tool: string;
  agentKey: string | null;
  ok: boolean;
  dryRun: boolean;
  error: string | null;
  refusedReason: string | null;
  costUsd: string | number;
  durationMs: number | null;
  createdAt: string;
}

export interface ToolCallsResponse {
  calls: ToolCallRecord[];
  lastThirtyDays: { calls: number; spendUsd: string | number };
}

// --- Approvals -------------------------------------------------------------

export type ActionRequestStatus = "PENDING" | "APPROVED" | "EXECUTED" | "FAILED" | "DECLINED" | "EXPIRED";

/**
 * One action an agent prepared and could not carry out alone.
 *
 * `why`, `gain` and `risk` are required fields on the tool call itself for
 * anything outward-facing, so every card arrives with the agent's case already
 * made rather than with a preview nobody can weigh up.
 */
export interface ActionRequestRow {
  id: string;
  agentKey: string;
  agent: { key: string; name: string; title: string; avatar: string | null };
  taskId: string | null;
  taskTitle: string | null;
  /** The lead or client the work was about, where there was one. */
  about: { kind: "lead" | "client"; id: string; name: string } | null;
  tool: string;
  toolName: string;
  wouldDo: string;
  heldBecause: string | null;
  why: string;
  gain: string;
  risk: string;
  status: ActionRequestStatus;
  spends: boolean;
  outward: boolean;
  decisionNote: string | null;
  decidedAt: string | null;
  error: string | null;
  expiresAt: string;
  /** True when it sat unanswered long enough that it can no longer be carried out. */
  expired: boolean;
  createdAt: string;
  /** What it actually cost, once carried out. "0.0000" until then. */
  costUsd: string;
}

// ---------------------------------------------------------------------------
// WhatsApp and SMS
// ---------------------------------------------------------------------------
//
// Parallel to the email types rather than folded into them, for the same
// reason the server models are: no subject, no HTML, no attachments, and a
// 24-hour window that decides whether a written message can be sent at all.

export type MessageChannel = "WHATSAPP" | "SMS";
export type MessageRoute = "API" | "LINK";
export type MessageStatus =
  | "DRAFT"
  | "SCHEDULED"
  | "READY"
  | "SENDING"
  | "SENT"
  | "DELIVERED"
  | "READ"
  | "FAILED"
  | "CANCELLED";

export interface MessageRow {
  id: string;
  channel: MessageChannel;
  direction: "OUTBOUND" | "INBOUND";
  status: MessageStatus;
  route: MessageRoute;
  toPhone: string;
  /** `+233 24 123 4567` — formatted by the server, never re-derived here. */
  display: string;
  toName: string | null;
  body: string;
  purpose: EmailPurpose;
  templateName: string | null;
  segments: number | null;
  scheduledFor: string | null;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  error: string | null;
  lead?: { id: string; contactName: string; companyName: string | null } | null;
  client?: { id: string; name: string } | null;
  createdAt: string;
}

export interface MessageThreadRow {
  id: string;
  channel: MessageChannel;
  phone: string;
  display: string;
  name: string | null;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  lastInboundText: string | null;
  unreadCount: number;
  /** True when a written WhatsApp would be delivered right now. */
  windowOpen: boolean;
  windowMinutesLeft: number | null;
  lead?: { id: string; contactName: string; companyName: string | null; status: string } | null;
  client?: { id: string; name: string } | null;
  _count?: { messages: number };
}

export interface MessageThreadDetail extends MessageThreadRow {
  messages: MessageRow[];
  suppressed: string | null;
}

/** A lead with a number and no email — the group this whole module exists for. */
export interface PhoneOnlyLead {
  id: string;
  contactName: string;
  companyName: string | null;
  contactPhone: string | null;
  city: string | null;
  category: string | null;
  website: string | null;
  leadScore: number;
  status: string;
  tags: string[];
  createdAt: string;
  phone: { e164: string; display: string; mobile: boolean; country: string | null } | null;
  /** A sentence when they cannot be reached, null when they can. */
  unreachable: string | null;
  contacted: boolean;
  replied: boolean;
  unread: number;
}

export interface MessagingStatus {
  whatsapp: boolean;
  whatsappTemplates: boolean;
  sms: boolean;
  drafterReady: boolean;
  drafts: number;
  scheduled: number;
  ready: number;
  sent: number;
  failed: number;
  threads: number;
  unread: number;
  suppressed: number;
  quality: { displayNumber: string | null; verifiedName: string | null; qualityRating: string | null; messagingLimit: string | null } | null;
  qualityError: string | null;
  defaultCallingCode: string;
}

export interface WhatsAppTemplateRow {
  id: string;
  name: string;
  language: string;
  category: string;
  status: string;
  rejectionReason: string | null;
  body: string;
  header: string | null;
  footer: string | null;
  variableCount: number;
  variableHints: string[];
  syncedAt: string | null;
}

export interface StarterTemplate {
  label: string;
  name: string;
  category: "MARKETING" | "UTILITY";
  purpose: string;
  body: string;
  footer: string;
  examples: string[];
  variables: string[];
}

export interface SmsCost {
  encoding: "GSM-7" | "UCS-2";
  characters: number;
  segments: number;
  /** The character that forced UCS-2 — nearly always an emoji or a curly quote. */
  forcedBy: string | null;
}

export interface Reachability {
  email: string | null;
  phone: { e164: string; display: string; mobile: boolean; country: string | null } | null;
  channel: "EMAIL" | "WHATSAPP" | "SMS" | null;
  why: string;
}

export interface MessageDraftResponse {
  body: string;
  rationale: string;
  confidence: number;
  model: string;
  channel: MessageChannel;
  cost?: SmsCost | null;
  checks: PreSendReport;
  facts: string[];
  recipient: { name: string | null; phone: string | null; email: string | null };
  caseStrength: CaseStrength | null;
  lookedNow: boolean;
  prepError: string | null;
  scenario: { key: string; number: number; name: string; exampleAsk: string; guard: string | null; matched: string[]; alsoAvailable: string[] } | null;
  pickableScenarios: { key: string; number: number; name: string }[];
}

export interface MessageSuppressionRow {
  id: string;
  phone: string;
  display: string;
  reason: string;
  source: string;
  createdAt: string;
}

// --- The mail room ----------------------------------------------------------
//
// What arrived, as opposed to what was sent. `EmailRow` above is the outbox.

export type MailTriageStatus = "NEW" | "TRIAGED" | "ROUTED" | "HANDLED" | "IGNORED" | "FAILED";

export type MailIntent =
  | "INTERESTED"
  | "NOT_INTERESTED"
  | "QUESTION"
  | "MEETING_REQUEST"
  | "PROPOSAL_FEEDBACK"
  | "SUPPORT_ISSUE"
  | "INVOICE_QUERY"
  | "PAYMENT_NOTICE"
  | "NEW_ENQUIRY"
  | "SUPPLIER"
  | "UNSUBSCRIBE"
  | "AUTO_REPLY"
  | "BOUNCE"
  | "SPAM"
  | "PERSONAL"
  | "OTHER";

export interface InboxMessageRow {
  id: string;
  from: string;
  fromEmail: string;
  subject: string;
  receivedAt: string;
  direction: "INBOUND" | "OUTBOUND";
  intent: MailIntent | null;
  summary: string | null;
  urgency: number | null;
  needsReply: boolean;
  status: MailTriageStatus;
  routedTo: string | null;
  taskId: string | null;
  leadId: string | null;
  clientId: string | null;
  snippet: string;
  threadId: string;
  lead?: { id: string; contactName: string; companyName: string | null } | null;
  client?: { id: string; name: string; company: string | null } | null;
  /** Who it would go to, for a message that was read but handed to nobody. */
  wouldGoTo?: { agentKey: string | null; because: string } | null;
}

/** One message in full, as the drawer shows it. */
export interface InboxMessageDetail {
  id: string;
  messageId: string | null;
  folder: "INBOX" | "SENT";
  direction: "INBOUND" | "OUTBOUND";
  fromEmail: string;
  fromName: string | null;
  toEmails: string[];
  ccEmails: string[];
  subject: string;
  bodyText: string;
  bodyHtml: string | null;
  snippet: string;
  sentAt: string;
  receivedAt: string;
  attachments: { filename: string; contentType: string; size: number }[];
  hasAttachments: boolean;
  autoSubmitted: boolean;
  triage: MailTriageStatus;
  intent: MailIntent | null;
  summary: string | null;
  urgency: number | null;
  needsReply: boolean;
  confidence: number | null;
  triagedAt: string | null;
  triageError: string | null;
  routedAgentKey: string | null;
  taskId: string | null;
  routedAt: string | null;
  handledAt: string | null;
  handledNote: string | null;
  threadId: string;
  thread: { id: string; subject: string; counterpartEmail: string; messageCount: number };
  lead?: { id: string; contactName: string; companyName: string | null; status: string } | null;
  client?: { id: string; name: string; company: string | null } | null;
  replyToEmail?: { id: string; subject: string; sentAt: string | null; purpose: string } | null;
  handledBy?: { id: string; name: string } | null;
}

export interface MailThreadRow {
  id: string;
  threadKey: string;
  subject: string;
  counterpartEmail: string;
  counterpartName: string | null;
  participants: string[];
  lastMessageAt: string;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  lastSnippet: string | null;
  messageCount: number;
  unreadCount: number;
  lead?: { id: string; contactName: string; companyName: string | null } | null;
  client?: { id: string; name: string; company: string | null } | null;
}

export interface MailThreadDetail extends MailThreadRow {
  messages: InboxMessageDetail[];
}

export interface InboxStatus {
  connected: boolean;
  mailbox: string | null;
  host: string | null;
  triage: boolean;
  autoRoute: boolean;
  watcher: { connected: boolean; connectedAt: string | null; lastPushAt: string | null; lastError: string | null; reading: boolean };
  folders: { folder: "INBOX" | "SENT"; lastSyncAt: string | null; lastError: string | null; messagesSeen: number }[];
  counts: Partial<Record<MailTriageStatus, number>>;
  /** Still owed a reply — machine mail excluded. */
  open: number;
  /** Read, owed a reply, and handed to nobody. */
  waiting: number;
}

export interface InboxSyncResult {
  mailbox: string;
  read: number;
  routed: number;
  notes: string[];
  folders: { folder: "INBOX" | "SENT"; path: string | null; read: number; skipped: number; routed: number; more: boolean; error: string | null }[];
}

/** What Settings knows about reading the mailbox. */
export interface InboxSettings {
  configured: boolean;
  paused: boolean;
  envManaged: boolean;
  host: string | null;
  port: number;
  secure: boolean;
  user: string | null;
  sentFolder: string | null;
  backfillDays: number;
  triage: boolean;
  autoRoute: boolean;
  ownDomains: string | null;
  watcher: { connected: boolean; connectedAt: string | null; lastPushAt: string | null; lastError: string | null; reading: boolean };
  folders: { folder: "INBOX" | "SENT"; lastSyncAt: string | null; lastError: string | null; messagesSeen: number }[];
}

export interface InboxSuggestion {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  canReusePassword: boolean;
  from: "smtp" | null;
}

// --- The rehearsal room -----------------------------------------------------

export type RehearsalStatus = "RUNNING" | "SETTLED" | "STOPPED";

export interface RehearsalScenario {
  key: string;
  name: string;
  purpose: string;
  exercises: string[];
  reach: "narrow" | "wide";
  startAgent: string;
  startAgentName: string;
  startAgentTitle: string | null;
  available: boolean;
  /** How many drafts starting this would switch on — and put back when it ends. */
  wouldWake: number;
  wouldWakeNames: string[];
  unavailableBecause: string | null;
}

export interface RehearsalScenarioList {
  guarantee: string;
  scenarios: RehearsalScenario[];
}

export interface RehearsalSummary {
  id: string;
  website: string;
  host: string;
  businessName: string | null;
  scenario: string;
  scenarioName: string;
  status: RehearsalStatus;
  startedAt: string;
  finishedAt: string | null;
  costUsd: number;
  taskCount: number;
  toolCalls: number;
  preparedCalls: number;
}

export interface RehearsalStep {
  id: string;
  at: string;
  agentKey: string;
  agentName: string;
  taskId: string;
  taskTitle: string;
  kind: AgentStepKind;
  message: string;
  tool: string | null;
  ok: boolean | null;
  dryRun: boolean | null;
  data: unknown;
}

export interface RehearsalDetail {
  id: string;
  website: string;
  host: string;
  businessName: string | null;
  scenario: string;
  scenarioName: string;
  note: string | null;
  status: RehearsalStatus;
  /** What it is doing right now, in words. Derived from the tasks, never stored. */
  movement: string;
  startedAt: string;
  finishedAt: string | null;
  lead: { id: string; companyName: string | null; website: string | null; leadScore: number; status: string; tags: string[] } | null;
  /** Agents this run switched on, and puts back when it ends. */
  woke: string[];
  /** What it may spend before it stops itself. Null is the shipped default; 0 is no ceiling. */
  budgetUsd: number | null;
  spend: {
    costUsd: number;
    toolCalls: number;
    preparedCalls: number;
    refusedCalls: number;
    modelCalls: number;
    inputTokens: number;
    outputTokens: number;
    /** Prompt-cache reads, billed at a tenth of the input rate. */
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
  agents: Array<{
    key: string;
    name: string;
    title: string;
    tasks: Array<{ id: string; title: string; status: AgentTaskStatus; summary: string | null; blockedReason: string | null; error: string | null }>;
    status: AgentTaskStatus;
    costUsd: number;
    toolCalls: number;
    preparedCalls: number;
    steps: number;
  }>;
  edges: Array<{ from: string; to: string; kind: AgentStepKind; label: string; at: string }>;
  timeline: RehearsalStep[];
  prepared: Array<{
    id: string;
    agentKey: string;
    tool: string;
    /** True when this would have reached outside the company — the half a rehearsal holds on purpose. */
    outward: boolean;
    wouldDo: string;
    heldBecause: string | null;
    status: string;
    why: string;
    gain: string;
    risk: string;
    input: unknown;
    createdAt: string;
    costUsd: number;
  }>;
  produced: {
    audits: Array<{ id: string; ranAt: string; overallScore: number; verdict: string; pdfFileId: string | null; markdownFileId: string | null }>;
    demos: Array<{ id: string; slug: string; title: string; status: string; version: number }>;
    proposals: Array<{ id: string; title: string; status: string; price: string; currency: string }>;
    emails: Array<{ id: string; subject: string; status: string; purpose: string; toEmail: string }>;
    research: { ranAt: string; costUsd: string } | null;
    notes: number;
    memories: number;
  };
}

// --- What the workforce spends ---------------------------------------------

export interface SpendSummary {
  windowDays: number;
  since: string;
  until: string;
  modelUsd: number;
  toolUsd: number;
  totalUsd: number;
  modelCalls: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Null when nothing was sent at all — "no cache hits" and "no calls" differ. */
  cacheHitRate: number | null;
  failedCalls: number;
  failedUsd: number;
  refusedCalls: number;
  dryRunCalls: number;
}

export interface SpendRow {
  key: string;
  calls: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  failed: number;
}

export interface DaySpend {
  day: string;
  modelUsd: number;
  toolUsd: number;
}

export interface Outcome {
  key: string;
  label: string;
  /** What makes one of these count. Shown, because a ratio without it is a rumour. */
  countedAs: string;
  count: number;
  /** Null when nothing of this kind happened in the window. Never rendered as zero. */
  costEachUsd: number | null;
}

export interface CostReport {
  summary: SpendSummary;
  byPurpose: SpendRow[];
  byAgent: SpendRow[];
  byModel: SpendRow[];
  byTool: SpendRow[];
  daily: DaySpend[];
  outcomes: { totalUsd: number; outcomes: Outcome[] };
}

export interface LlmCallRow {
  id: string;
  purpose: string;
  model: string;
  agentKey: string | null;
  taskId: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: string;
  durationMs: number | null;
  effort: string | null;
  ok: boolean;
  error: string | null;
  createdAt: string;
}

export type BudgetScope = "GLOBAL" | "AGENT" | "TOOL";
export type BudgetPeriod = "DAY" | "MONTH";
export type BudgetAction = "none" | "warn" | "downgrade" | "approve" | "pause";

export interface BudgetRow {
  id: string;
  scopeType: BudgetScope;
  /** Empty for GLOBAL. The agent key or tool key otherwise. */
  scopeId: string;
  period: BudgetPeriod;
  /** Strings, because Prisma serialises Decimal that way. Null means unset. */
  softLimitUsd: string | null;
  hardLimitUsd: string | null;
  enabled: boolean;
  note: string | null;
  /** What this scope has spent so far this period. */
  spentUsd: number;
  action: BudgetAction;
  /** Spend ÷ hard limit. Null when there is no hard limit to divide by. */
  fraction: number | null;
}

// --- Website editor ---------------------------------------------------------

export type SiteSummary = {
  id: string;
  name: string;
  slug: string;
  publicUrl: string;
  /** `owner/name`, or null when nothing has been connected to publish to. */
  repo: string | null;
  branch: string;
  client: { id: string; name: string } | null;
  pageCount: number;
  draftCount: number;
};

export type SitePageStatus = "LIVE" | "HIDDEN";

export type SitePageRow = {
  id: string;
  title: string;
  path: string;
  filePath: string;
  status: SitePageStatus;
  url: string;
  hasDraft: boolean;
  draftSavedAt: string | null;
  draftSavedBy: { id: string; name: string } | null;
  lastPublishedAt: string | null;
};

export type FieldKind = "text" | "richtext" | "link" | "button" | "image";

/** One thing on a page somebody can change. Offsets stay on the server. */
export type SiteFieldRow = {
  id: string;
  kind: FieldKind;
  label: string;
  tag: string;
  value: string;
  preview: string;
  href?: string;
  alt?: string;
  note?: string;
  decorative?: boolean;
  /** The element's own inline style, when it has one. */
  style?: string;
  // Buttons only.
  /** The style class it wears — `btn-primary`. */
  variant?: string;
  /** The prefix a style has to start with, and the word a label is made from. */
  variantStem?: string;
  /** Every style this page already uses for this kind of button. */
  variants?: string[];
  /** Whether it opens in a new tab. Absent on a `<button>`, which goes nowhere. */
  newTab?: boolean;
};

export type SiteSectionRow = {
  id: string;
  label: string;
  kind: "meta" | "header" | "section" | "footer";
  fields: SiteFieldRow[];
};

/** What the editor sends back: only the parts of a field that changed. */
export type FieldEdit = { value?: string; href?: string; alt?: string; style?: string; variant?: string | null; newTab?: boolean };

export type SitePageDetail = {
  site: { id: string; name: string; publicUrl: string; repo: string | null };
  /** Where a link on this page can go without leaving the site. */
  links: Array<{ path: string; title: string }>;
  page: {
    id: string;
    title: string;
    path: string;
    filePath: string;
    status: SitePageStatus;
    url: string;
    lastPublishedAt: string | null;
  };
  /** Which of the two sources answered — the repository, or the live site. */
  readFrom: "repository" | "live site";
  sections: SiteSectionRow[];
  draft: {
    values: Record<string, FieldEdit>;
    /**
     * The number every save has to quote back. See the server's draft route:
     * without it a second editor's save silently overwrites the first's.
     */
    revision: number;
    savedAt: string | null;
    savedBy: { id: string; name: string } | null;
  };
  problems: FieldProblem[];
};

export type FieldProblem = { id: string; label: string; reason: string };

export type DraftSaveResult = {
  savedAt: string | null;
  /** The revision after this save. The editor holds it and quotes it on the next one. */
  revision: number;
  changed: number;
  unknown: string[];
  problems: FieldProblem[];
};

/**
 * A 409 from the draft route: somebody else saved while this editor was open.
 *
 * Nothing has been overwritten either way — this is the material for the choice,
 * not a report of a loss.
 */
export type DraftConflict = {
  error: string;
  revision: number;
  savedAt: string | null;
  savedBy: { id: string; name: string } | null;
  fields: Array<{
    id: string;
    label: string;
    kind: FieldKind;
    yours: FieldEdit | null;
    theirs: FieldEdit | null;
    /** Both changed it and disagreed. The only rows that actually need a decision. */
    contested: boolean;
  }>;
};

/** One line of "Main heading: 'Build once' → 'Built to last'". */
export type FieldChangeSummary = {
  id: string;
  label: string;
  kind: FieldKind;
  part: "words" | "destination" | "picture" | "description" | "styling";
  from: string;
  to: string;
};

export type ChangeCategories = { text: boolean; links: boolean; images: boolean; styles: boolean; seo: boolean };

export type PublishResult = {
  version: number;
  changed: number;
  summary: FieldChangeSummary[];
  touched: ChangeCategories;
  commit: { sha: string; url: string };
  url: string;
  note: string;
};

export type SitePageVersionRow = {
  id: string;
  number: number;
  commitSha: string | null;
  commitUrl: string | null;
  createdAt: string;
  changed: number;
  summary: FieldChangeSummary[];
  touched: ChangeCategories;
  publishedBy: { id: string; name: string } | null;
};

/** What rolling back to a version would actually do, asked before the button is offered. */
export type RollbackDiff = {
  version: { id: string; number: number; createdAt: string; publishedBy: { id: string; name: string } | null; commitUrl: string | null };
  /** The page is already exactly this version. Nothing to do. */
  identical: boolean;
  differenceCount: number;
  differences: Array<{ id: string; label: string; now: string; after: string }>;
  /** Differs in markup, reads exactly the same. Counted, never listed. */
  invisibleCount: number;
  summary: FieldChangeSummary[];
  readFrom: "repository" | "live site";
  warning: string;
};

/** The Website Builder's front page. All of it is counted in the database. */
export type WebsiteOverviewData = {
  counts: {
    sites: number;
    pages: number;
    /** Pages carrying unpublished changes. */
    drafts: number;
    /** Files the site's own sitemap does not list — an archive, the 404. */
    hidden: number;
    /** Sites with no repository, which therefore cannot publish. */
    unconnected: number;
  };
  recent: Array<{
    id: string;
    number: number;
    createdAt: string;
    commitUrl: string | null;
    publishedBy: { id: string; name: string } | null;
    page: { id: string; title: string; path: string };
    site: { id: string; name: string };
    changed: number;
  }>;
};
