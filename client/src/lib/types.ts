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

export interface Lead {
  id: string;
  contactName: string;
  contactEmail?: string | null;
  companyName?: string | null;
  source: string;
  status: string;
  leadScore: number;
  estimatedDealSize?: string | null;
  discoveryNotes?: string | null;
  createdAt: string;
  client?: Client | null;
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
