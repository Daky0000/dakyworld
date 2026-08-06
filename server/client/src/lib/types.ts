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
  createdAt: string;
  _count?: { leads: number };
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
