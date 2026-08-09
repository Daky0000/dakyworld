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

export interface LeadStats {
  total: number;
  averageScore: number;
  pipelineValue: string;
  reachable: number;
  newThisWeek: number;
  byStatus: { status: string; _count: number }[];
  bySource: { source: string; _count: number }[];
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
  source?: { id: string; name: string; actorId: string };
  leads?: Lead[];
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
}

export interface IntegrationSettings {
  apify: {
    connected: boolean;
    envManaged: boolean;
    token: string | null;
    account: { username?: string; profile?: { name?: string }; plan?: { id?: string } } | null;
    error: string | null;
  };
}

export interface MappingPreview {
  items: {
    lead?: Record<string, unknown>;
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

export interface ImportConnections {
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

export interface DashboardData {
  revenueThisMonth: string;
  monthlyRecurringRevenue: string;
  activeCarePlanCount: number;
  outstandingInvoiceTotal: string;
  outstandingInvoiceCount: number;
  pipelineValue: string;
  openProposalCount: number;
  leadsByStatus: { status: string; _count: number }[];
}

export interface User {
  id: string;
  name: string;
  email: string;
  role: string;
}
