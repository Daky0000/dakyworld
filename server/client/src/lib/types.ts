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
  leadImportId?: string | null;
  createdAt: string;
  _count?: { leads: number };
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

export interface ImportPlan {
  tables: PlanTable[];
  summary: string;
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
  status: "ANALYZING" | "READY" | "IMPORTED" | "FAILED";
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
  groups?: { id: string; name: string; _count?: { leads: number } }[];
}

export interface AnalyzeResponse {
  import: LeadImportRecord;
  plan: ImportPlan;
  previews: TablePreview[];
  sheets: { name: string; rows: number; columns: number }[];
  warning: string | null;
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
  };
  analyst: { configured: boolean; envManaged: boolean; key: string | null; model: string };
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
  cloudinary: { configured: boolean; envManaged: boolean; cloudName: string | null; apiKey: string | null };
  alerts: {
    configured: boolean;
    /** Which route is live. A webhook posts to one channel; a token can choose. */
    transport: "TOKEN" | "WEBHOOK" | "NONE";
    envManaged: boolean;
    webhookUrl: string | null;
    botToken: string | null;
    defaultChannel: string | null;
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
  };
  general: {
    appUrl: string | null;
    appUrlEnvManaged: boolean;
    resolvedAppUrl: string;
    timezone: string;
  };
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
  | "CUSTOM";

export type EmailStatus = "DRAFT" | "SCHEDULED" | "SENDING" | "SENT" | "FAILED" | "CANCELLED";
export type EmailKind = "MANUAL" | "TEMPLATE" | "AI_DRAFT" | "SEQUENCE" | "AUTOMATION";

export type EmailAttachment =
  | { kind?: "file"; name: string; url: string; contentType?: string }
  | { kind: "invoice"; invoiceId: string; name?: string }
  | { kind: "proposal"; proposalId: string; name?: string };

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
}

export interface EmailDraft {
  subject: string;
  body: string;
  rationale: string;
  confidence: number;
  model: string;
  variables: Record<string, string>;
  facts: string[];
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
    mustDryRun: boolean;
    permissionNote: string | null;
  }>;
}

export interface AgentList {
  agents: Agent[];
  summary: { total: number; active: number; aboveDraft: number };
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
