import { useState, useRef, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { api, postForBlob } from "../lib/api";
import { useAuth } from "../lib/auth";
import { AdminGuard, isAdminUser } from "../components/AdminGuard";
import type {
  AnalyzeStep,
  ImportPlan,
  Lead,
  LeadGroup,
  LeadImportRecord,
  PlanTable,
  TablePreview,
  TemplateColumnDef,
  TemplateDef,
} from "../lib/types";
import {
  Badge,
  Button,
  Card,
  Drawer,
  EmptyState,
  Field,
  Modal,
  StatTile,
} from "../components/ui";

const AFRICAN_REGIONS = [
  "Ghana",
  "Nigeria",
  "Kenya",
  "South Africa",
  "Rwanda",
  "Egypt",
  "Ivory Coast",
  "Uganda",
  "Tanzania",
  "Senegal",
  "Morocco",
  "Ethiopia",
  "Cameroon",
  "Other / Pan-Africa",
];

// Built-in presets for Africon Leads templates
export const AFRICON_TEMPLATE_PRESETS = [
  {
    id: "africon-b2b",
    title: "Africon B2B Corporate Outreach",
    description: "Tailored for enterprise decision-makers, executives, and commercial sales across African markets.",
    fileName: "africon_b2b_corporate_template.csv",
    columns: [
      { header: "Full Name", label: "Full Name", field: "contactName", type: "TEXT" },
      { header: "Company Name", label: "Company Name", field: "companyName", type: "TEXT" },
      { header: "Job Title", label: "Job Title", field: "custom", type: "TEXT" },
      { header: "Official Email", label: "Official Email", field: "contactEmail", type: "EMAIL" },
      { header: "Direct Phone", label: "Direct Phone", field: "contactPhone", type: "PHONE" },
      { header: "Country", label: "Country", field: "country", type: "TEXT" },
      { header: "City", label: "City", field: "city", type: "TEXT" },
      { header: "Industry Sector", label: "Industry Sector", field: "category", type: "TEXT" },
      { header: "Website", label: "Website", field: "website", type: "URL" },
      { header: "Annual Revenue", label: "Annual Revenue", field: "custom", type: "CURRENCY" },
      { header: "Notes", label: "Notes", field: "discoveryNotes", type: "LONG_TEXT" },
    ],
    sampleRows: [
      "Kofi Mensah,Apex Capital Ltd,Managing Director,kofi.mensah@apexcapital.gh,+233 24 555 0192,Ghana,Accra,Financial Services,https://apexcapital.gh,$2.5M,Key account target for Q4 expansion",
      "Amina Bello,Sahara Trade Hub,Chief Operating Officer,amina@saharatrade.ng,+234 80 234 5678,Nigeria,Lagos,Logistics & Freight,https://saharatrade.ng,$5.1M,Expressed interest in cloud automation",
    ],
  },
  {
    id: "africon-sme",
    title: "African SME & Retail Directory",
    description: "Designed for commercial business hubs, retail stores, clinics, and service businesses.",
    fileName: "african_sme_directory_template.csv",
    columns: [
      { header: "Business Name", label: "Business Name", field: "companyName", type: "TEXT" },
      { header: "Contact Person", label: "Contact Person", field: "contactName", type: "TEXT" },
      { header: "WhatsApp Phone", label: "WhatsApp Phone", field: "contactPhone", type: "PHONE" },
      { header: "Email Address", label: "Email Address", field: "contactEmail", type: "EMAIL" },
      { header: "Market / City", label: "Market / City", field: "city", type: "TEXT" },
      { header: "Country", label: "Country", field: "country", type: "TEXT" },
      { header: "Business Category", label: "Business Category", field: "category", type: "TEXT" },
      { header: "Rating", label: "Rating", field: "rating", type: "NUMBER" },
      { header: "Physical Address", label: "Physical Address", field: "address", type: "TEXT" },
    ],
    sampleRows: [
      "Osu Health Pharmacy,Dr. Kwesi Appiah,+233 20 888 1234,info@osupharmacy.gh,Accra,Ghana,Healthcare & Pharmacy,4.8,14 Oxford Street Osu",
      "Kilimani Green Grocers,Faith Muthoni,+254 71 234 5678,faith@kilimanigreen.co.ke,Nairobi,Kenya,Retail & Grocery,4.6,Argwings Kodhek Rd",
    ],
  },
  {
    id: "africon-tech",
    title: "Africon Tech & Startup Ecosystem",
    description: "Optimized for venture-backed startups, technology firms, and digital agencies.",
    fileName: "africon_tech_startups_template.csv",
    columns: [
      { header: "Startup Name", label: "Startup Name", field: "companyName", type: "TEXT" },
      { header: "Founder / CEO", label: "Founder / CEO", field: "contactName", type: "TEXT" },
      { header: "Work Email", label: "Work Email", field: "contactEmail", type: "EMAIL" },
      { header: "Contact Number", label: "Contact Number", field: "contactPhone", type: "PHONE" },
      { header: "Tech Vertical", label: "Tech Vertical", field: "category", type: "TEXT" },
      { header: "Funding Stage", label: "Funding Stage", field: "custom", type: "TEXT" },
      { header: "Country HQ", label: "Country HQ", field: "country", type: "TEXT" },
      { header: "Website", label: "Website", field: "website", type: "URL" },
    ],
    sampleRows: [
      "PayPulse Africa,David Okafor,david@paypulse.africa,+234 81 000 9988,Fintech,Series A,Nigeria,https://paypulse.africa",
      "AgroGrow Solutions,Nadia El-Sayed,nadia@agrogrow.eg,+20 10 555 4321,Agritech,Seed,Egypt,https://agrogrow.eg",
    ],
  },
];

async function toBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

function downloadCsv(filename: string, content: string) {
  // UTF-8 BOM ensures seamless rendering across Microsoft Excel, Apple Numbers, and LibreOffice
  const blob = new Blob(["\uFEFF" + content], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function slugifyName(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "leads";
}

/** Extracts the cell value for any given column header, checking raw sheet cells first */
export function getLeadCellValue(lead: Lead, header: string): string {
  // 1. Check untouched raw cells from the imported Excel sheet
  const raw = (lead.enrichment as { raw?: Record<string, string> } | null)?.raw;
  if (raw && typeof raw === "object" && header in raw) {
    const val = raw[header];
    return val !== null && val !== undefined ? String(val) : "";
  }

  // 2. Check custom fields
  if (lead.customFields && typeof lead.customFields === "object" && header in lead.customFields) {
    const val = (lead.customFields as Record<string, unknown>)[header];
    return val !== null && val !== undefined ? String(val) : "";
  }

  // 3. Check standard scalars matching header name
  const norm = header.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (norm === "contactname" || norm === "fullname" || norm === "name" || norm === "contactperson" || norm === "person") {
    return lead.contactName || "";
  }
  if (norm === "companyname" || norm === "company" || norm === "organization" || norm === "businessname" || norm === "business") {
    return lead.companyName || "";
  }
  if (norm === "contactemail" || norm === "email" || norm === "officialemail" || norm === "workemail" || norm === "emailaddress") {
    return lead.contactEmail || "";
  }
  if (norm === "contactphone" || norm === "phone" || norm === "directphone" || norm === "telephone" || norm === "whatsapp" || norm === "whatsappphone" || norm === "contactnumber") {
    return lead.contactPhone || "";
  }
  if (norm === "country" || norm === "market" || norm === "countryhq") {
    return lead.country || "";
  }
  if (norm === "city" || norm === "marketcity") {
    return lead.city || "";
  }
  if (norm === "category" || norm === "industry" || norm === "sector" || norm === "industrysector" || norm === "businesscategory" || norm === "techvertical") {
    return lead.category || "";
  }
  if (norm === "website" || norm === "url" || norm === "web") {
    return lead.website || "";
  }
  if (norm === "address" || norm === "physicaladdress" || norm === "location") {
    return lead.address || "";
  }
  if (norm === "notes" || norm === "discoverynotes") {
    return lead.discoveryNotes || "";
  }

  return "";
}

/**
 * Exports leads to Excel/CSV with ONLY the columns that the particular sheet had.
 * Strictly excludes score, status, server metadata, and database IDs.
 */
export function exportLeadsToCsv(leadsToExport: Lead[], filename: string) {
  if (!leadsToExport.length) return;

  const headerSet = new Set<string>();
  const headers: string[] = [];

  const addHeader = (h: string) => {
    if (!h) return;
    const lower = h.toLowerCase().trim();
    // Exclude score, status, server metadata, and internal database keys
    if (
      lower === "status" ||
      lower === "score" ||
      lower === "leadscore" ||
      lower === "server" ||
      lower === "source" ||
      lower === "capturemethod" ||
      lower === "id" ||
      lower === "groupid" ||
      lower === "rehearsal" ||
      lower === "createdat" ||
      lower === "updatedat" ||
      lower === "dedupekey" ||
      lower === "externalid"
    ) {
      return;
    }
    if (!headerSet.has(h)) {
      headerSet.add(h);
      headers.push(h);
    }
  };

  // 1. Gather exact sheet column headers from raw enrichment
  for (const lead of leadsToExport) {
    const raw = (lead.enrichment as { raw?: Record<string, string> } | null)?.raw;
    if (raw && typeof raw === "object") {
      Object.keys(raw).forEach(addHeader);
    }
  }

  // 2. If no raw enrichment present (e.g. manually created lead), collect defined fields
  if (headers.length === 0) {
    for (const lead of leadsToExport) {
      if (lead.contactName) addHeader("Contact Name");
      if (lead.companyName) addHeader("Company Name");
      if (lead.contactEmail) addHeader("Official Email");
      if (lead.contactPhone) addHeader("Direct Phone");
      if (lead.country) addHeader("Country");
      if (lead.city) addHeader("City");
      if (lead.category) addHeader("Industry Sector");
      if (lead.website) addHeader("Website");
      if (lead.address) addHeader("Physical Address");
      if (lead.discoveryNotes) addHeader("Notes");
      if (lead.customFields && typeof lead.customFields === "object") {
        Object.keys(lead.customFields).forEach(addHeader);
      }
    }
  }

  // Fallback if still empty
  if (headers.length === 0) {
    headers.push("Contact Name", "Company Name", "Official Email", "Direct Phone", "Country", "City");
  }

  const headerLine = headers.map((h) => `"${h.replace(/"/g, '""')}"`).join(",");
  const rows = leadsToExport.map((lead) => {
    return headers
      .map((header) => {
        const val = getLeadCellValue(lead, header);
        return `"${val.replace(/"/g, '""')}"`;
      })
      .join(",");
  });

  const csv = [headerLine, ...rows].join("\n");
  downloadCsv(filename, csv);
}

export function AfriconLeads() {
  const [params, setParams] = useSearchParams();
  const currentTab = params.get("tab") || "leads";
  const setTab = (tab: "leads" | "import" | "templates") => {
    setParams(tab === "leads" ? {} : { tab });
  };

  const { user, can } = useAuth();
  const isAdmin = isAdminUser(user, can);

  if (!isAdmin) {
    return <AdminGuard><></></AdminGuard>;
  }

  return (
    <div className="space-y-6 pb-20">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between border-b border-line pb-5">
        <div>
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-50 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-blue">
              <span className="h-1.5 w-1.5 rounded-full bg-blue"></span>
              Admin Restricted
            </span>
            <span className="text-xs text-muted">Dakyworld OS Lead Engine</span>
          </div>
          <h1 className="mt-1.5 font-display text-2xl font-bold tracking-tight text-ink sm:text-3xl">
            Africon Leads
          </h1>
          <p className="mt-1 text-sm text-muted">
            Uploaded Excel sheet groups, full untruncated sheet data, and AI template-driven importer.
          </p>
        </div>

        <div className="flex items-center gap-2">
          {currentTab !== "import" && (
            <Button variant="accent" onClick={() => setTab("import")}>
              <span className="mr-1.5">⚡</span> Import Leads (with Template)
            </Button>
          )}
          {currentTab === "import" && (
            <Button variant="secondary" onClick={() => setTab("leads")}>
              ← Back to Leads Pipeline
            </Button>
          )}
        </div>
      </div>

      {/* Main Sub-Navigation Tabs */}
      <div className="flex border-b border-line">
        <button
          type="button"
          onClick={() => setTab("leads")}
          className={`flex items-center gap-2 border-b-2 px-4 py-2.5 text-xs font-semibold transition ${
            currentTab === "leads"
              ? "border-ink text-ink font-bold"
              : "border-transparent text-muted hover:border-line hover:text-ink"
          }`}
        >
          <span>📋 Leads Pipeline &amp; Groups</span>
        </button>
        <button
          type="button"
          onClick={() => setTab("import")}
          className={`flex items-center gap-2 border-b-2 px-4 py-2.5 text-xs font-semibold transition ${
            currentTab === "import"
              ? "border-blue text-blue font-bold"
              : "border-transparent text-muted hover:border-line hover:text-ink"
          }`}
        >
          <span>📥 Import Excel Sheet &amp; Template</span>
          <span className="rounded-full bg-blue-50 px-1.5 py-0.2 text-[10px] text-blue font-bold">AI</span>
        </button>
        <button
          type="button"
          onClick={() => setTab("templates")}
          className={`flex items-center gap-2 border-b-2 px-4 py-2.5 text-xs font-semibold transition ${
            currentTab === "templates"
              ? "border-ink text-ink font-bold"
              : "border-transparent text-muted hover:border-line hover:text-ink"
          }`}
        >
          <span>📑 Template Library</span>
        </button>
      </div>

      {currentTab === "leads" && <LeadsPipelineView onGoToImport={() => setTab("import")} />}
      {currentTab === "import" && <TemplateImportView onImportSuccess={() => setTab("leads")} />}
      {currentTab === "templates" && <TemplateLibraryView onUseTemplate={() => setTab("import")} />}
    </div>
  );
}

// ============================================================================
// TAB 1: Leads Pipeline View
// ============================================================================
function LeadsPipelineView({ onGoToImport }: { onGoToImport: () => void }) {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [selectedCountry, setSelectedCountry] = useState<string>("ALL");
  const [selectedBundle, setSelectedBundle] = useState<string>("ALL");
  const [onlyReachable, setOnlyReachable] = useState(false);
  const [drawerLead, setDrawerLead] = useState<Lead | null>(null);
  const [addLeadOpen, setAddLeadOpen] = useState(false);

  // Multi-card (group) selection state for multi-sheet workbook export
  const [selectedCardIds, setSelectedCardIds] = useState<Set<string>>(new Set());

  // Multi-row selection state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Confirmations
  const [deleteAllConfirmOpen, setDeleteAllConfirmOpen] = useState(false);
  const [deleteSelectedConfirmOpen, setDeleteSelectedConfirmOpen] = useState(false);
  const [deleteBundleConfirm, setDeleteBundleConfirm] = useState<LeadGroup | null>(null);
  const [noticeMessage, setNoticeMessage] = useState<string | null>(null);

  // Fetch all Africon Leads (guaranteed isolation from OS leads & demo leads)
  const { data: leadsResponse, isLoading } = useQuery({
    queryKey: ["leads", "africon"],
    queryFn: ({ signal }) => {
      const queryParams = new URLSearchParams();
      queryParams.set("tags", "africon");
      queryParams.set("take", "5000");
      return api.get<{ items: Lead[]; total: number } | Lead[]>(`/leads?${queryParams.toString()}`, signal);
    },
  });

  // Pure Africon leads array: strictly exclude rehearsal/demo leads and non-Africon OS leads
  const leads = useMemo(() => {
    if (!leadsResponse) return [];
    const rawList = Array.isArray(leadsResponse)
      ? leadsResponse
      : Array.isArray((leadsResponse as { items: Lead[] }).items)
      ? (leadsResponse as { items: Lead[] }).items
      : [];

    return rawList.filter((lead) => {
      if (lead.rehearsal) return false;
      if (Array.isArray(lead.tags) && lead.tags.includes("africon")) return true;
      return false;
    });
  }, [leadsResponse]);

  // Fetch only Africon Lead Groups / Uploaded Sheets
  const { data: rawGroups } = useQuery({
    queryKey: ["leads", "groups", "africon"],
    queryFn: ({ signal }) => api.get<LeadGroup[]>("/leads/groups?tags=africon", signal),
  });

  const groups = useMemo(() => (Array.isArray(rawGroups) ? rawGroups : []), [rawGroups]);

  const activeBundle = useMemo(() => {
    if (selectedBundle === "ALL" || selectedBundle === "ungrouped") return null;
    return groups.find((g) => g.id === selectedBundle) ?? null;
  }, [groups, selectedBundle]);

  // Invalidator
  const invalidateLeads = () => {
    qc.invalidateQueries({ queryKey: ["leads"] });
  };

  // Delete mutations
  const deleteSingleMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/leads/${id}`),
    onSuccess: () => {
      invalidateLeads();
      if (drawerLead) setDrawerLead(null);
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(drawerLead?.id || "");
        return next;
      });
    },
  });

  const deleteSelectedMutation = useMutation({
    mutationFn: () => api.post("/leads/bulk/delete", { ids: [...selectedIds] }),
    onSuccess: () => {
      invalidateLeads();
      setSelectedIds(new Set());
      setDeleteSelectedConfirmOpen(false);
      setNoticeMessage(`Deleted ${selectedIds.size} selected lead(s).`);
      setTimeout(() => setNoticeMessage(null), 4000);
    },
    onError: (err) => {
      alert(err instanceof Error ? err.message : "Failed to delete selected leads.");
    },
  });

  const deleteAllAfriconMutation = useMutation({
    mutationFn: () => api.delete<{ deleted: number }>("/leads/africon/delete-all"),
    onSuccess: (data) => {
      invalidateLeads();
      setSelectedIds(new Set());
      setDeleteAllConfirmOpen(false);
      setNoticeMessage(`Deleted all ${data?.deleted ?? leads.length} Africon leads. Regular OS leads remain untouched.`);
      setTimeout(() => setNoticeMessage(null), 5000);
    },
    onError: (err) => {
      alert(err instanceof Error ? err.message : "Failed to delete Africon leads.");
    },
  });

  // Combine groups modal state
  const [combineModalOpen, setCombineModalOpen] = useState(false);
  const [selectedGroupIdsForCombine, setSelectedGroupIdsForCombine] = useState<Set<string>>(new Set());
  const [combineTargetName, setCombineTargetName] = useState("Lead List");

  const combineMutation = useMutation({
    mutationFn: (payload?: { ids?: string[]; groupIds?: string[]; name?: string }) =>
      api.post<{ combined: number; group: { id: string; name: string } }>("/leads/combine-to-lead-list", payload || {}),
    onSuccess: (data) => {
      invalidateLeads();
      setSelectedIds(new Set());
      setSelectedCardIds(new Set());
      setCombineModalOpen(false);
      setNoticeMessage(`Successfully combined ${data.combined} leads into '${data.group.name}'!`);
      setTimeout(() => setNoticeMessage(null), 5000);
    },
    onError: (err) => {
      alert(err instanceof Error ? err.message : "Failed to combine leads.");
    },
  });

  // Multi-sheet Excel workbook export mutation
  const exportWorkbookMutation = useMutation({
    mutationFn: async ({ groupIds, filename }: { groupIds?: string[]; filename?: string }) => {
      const blob = await postForBlob("/leads/africon/export-workbook", { groupIds, filename });
      const count = groupIds?.length ?? groups.length;
      const defaultName =
        count === 1 && groupIds?.[0]
          ? `${slugifyName(groups.find((g) => g.id === groupIds[0])?.name || "sheet")}.xlsx`
          : `africon_workbook_${count}_sheets_${new Date().toISOString().slice(0, 10)}.xlsx`;
      const outName = filename || defaultName;
      downloadBlob(blob, outName);
      return outName;
    },
    onSuccess: (fname) => {
      setNoticeMessage(`Workbook '${fname}' exported successfully!`);
      setTimeout(() => setNoticeMessage(null), 4000);
    },
    onError: (err) => {
      alert(err instanceof Error ? err.message : "Failed to export Excel workbook.");
    },
  });

  const deleteBundleMutation = useMutation({
    mutationFn: ({ groupId, withLeads }: { groupId: string; withLeads: boolean }) =>
      api.delete(`/leads/groups/${groupId}?withLeads=${withLeads}`),
    onSuccess: () => {
      invalidateLeads();
      setDeleteBundleConfirm(null);
      setSelectedBundle("ALL");
      setNoticeMessage("Sheet group deleted successfully.");
      setTimeout(() => setNoticeMessage(null), 4000);
    },
    onError: (err) => {
      alert(err instanceof Error ? err.message : "Failed to delete group.");
    },
  });

  // Filter leads based on user UI filters
  const filteredLeads = useMemo(() => {
    return leads.filter((lead) => {
      if (selectedCountry !== "ALL" && lead.country?.toLowerCase() !== selectedCountry.toLowerCase()) return false;
      if (onlyReachable && !lead.contactEmail && !lead.contactPhone) return false;

      if (selectedBundle === "ungrouped") {
        if (lead.groupId) return false;
      } else if (selectedBundle !== "ALL") {
        if (lead.groupId !== selectedBundle) return false;
      }

      if (search.trim()) {
        const query = search.toLowerCase();
        const matchesName = lead.contactName?.toLowerCase().includes(query);
        const matchesCompany = lead.companyName?.toLowerCase().includes(query);
        const matchesEmail = lead.contactEmail?.toLowerCase().includes(query);
        const matchesPhone = lead.contactPhone?.toLowerCase().includes(query);
        const matchesCity = lead.city?.toLowerCase().includes(query);
        const matchesCategory = lead.category?.toLowerCase().includes(query);

        // Also search in raw untouched Excel sheet cells
        let matchesRaw = false;
        const raw = (lead.enrichment as { raw?: Record<string, string> } | null)?.raw;
        if (raw && typeof raw === "object") {
          matchesRaw = Object.values(raw).some((val) => String(val).toLowerCase().includes(query));
        }

        if (!matchesName && !matchesCompany && !matchesEmail && !matchesPhone && !matchesCity && !matchesCategory && !matchesRaw) {
          return false;
        }
      }
      return true;
    });
  }, [leads, search, selectedCountry, selectedBundle, onlyReachable]);

  // Dynamically determine the exact columns present in these leads
  const dynamicColumns = useMemo(() => {
    const headerSet = new Set<string>();
    const headers: string[] = [];

    const addHeader = (h: string) => {
      if (!h) return;
      const lower = h.toLowerCase().trim();
      // Exclude internal database/server metadata and score/status
      if (
        lower === "status" ||
        lower === "score" ||
        lower === "leadscore" ||
        lower === "server" ||
        lower === "source" ||
        lower === "capturemethod" ||
        lower === "id" ||
        lower === "groupid" ||
        lower === "rehearsal" ||
        lower === "createdat" ||
        lower === "updatedat"
      ) {
        return;
      }
      if (!headerSet.has(h)) {
        headerSet.add(h);
        headers.push(h);
      }
    };

    // Extract headers from raw Excel cells first (preserves original sheet headers!)
    for (const lead of filteredLeads) {
      const raw = (lead.enrichment as { raw?: Record<string, string> } | null)?.raw;
      if (raw && typeof raw === "object") {
        Object.keys(raw).forEach(addHeader);
      }
    }

    // Fallback if no raw enrichment found
    if (headers.length === 0) {
      for (const lead of filteredLeads) {
        if (lead.contactName) addHeader("Contact Name");
        if (lead.companyName) addHeader("Company Name");
        if (lead.contactEmail) addHeader("Official Email");
        if (lead.contactPhone) addHeader("Direct Phone");
        if (lead.country) addHeader("Country");
        if (lead.city) addHeader("City");
        if (lead.category) addHeader("Industry Sector");
        if (lead.website) addHeader("Website");
        if (lead.address) addHeader("Physical Address");
        if (lead.discoveryNotes) addHeader("Notes");
        if (lead.customFields && typeof lead.customFields === "object") {
          Object.keys(lead.customFields).forEach(addHeader);
        }
      }
    }

    if (headers.length === 0) {
      return ["Contact Name", "Company Name", "Official Email", "Direct Phone", "Country", "City"];
    }

    return headers;
  }, [filteredLeads]);

  // Pipeline metrics (without score or OS qualification stages)
  const stats = useMemo(() => {
    const total = leads.length;
    const reachable = leads.filter((l) => l.contactEmail || l.contactPhone).length;
    const sheetsCount = groups.length;
    const currentShown = filteredLeads.length;
    return { total, reachable, sheetsCount, currentShown };
  }, [leads, groups, filteredLeads]);

  // Multi-select handlers
  const allVisibleSelected = filteredLeads.length > 0 && filteredLeads.every((l) => selectedIds.has(l.id));

  const toggleSelectAllVisible = () => {
    if (allVisibleSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredLeads.map((l) => l.id)));
    }
  };

  const toggleSelectRow = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Export handlers
  const handleExportFiltered = () => {
    if (!filteredLeads.length) return;
    const bundleLabel = activeBundle ? `_${slugifyName(activeBundle.name)}` : "";
    exportLeadsToCsv(filteredLeads, `africon_leads${bundleLabel}_${new Date().toISOString().slice(0, 10)}.csv`);
  };

  const handleExportSelected = () => {
    const selectedList = leads.filter((l) => selectedIds.has(l.id));
    if (!selectedList.length) return;
    exportLeadsToCsv(selectedList, `africon_selected_${selectedList.length}_leads_${new Date().toISOString().slice(0, 10)}.csv`);
  };

  return (
    <div className="space-y-6">
      {/* Notice Banner */}
      {noticeMessage && (
        <div className="rounded-xl border border-blue bg-blue-50/70 p-3.5 text-xs text-ink flex items-center justify-between animate-fadeIn">
          <div className="flex items-center gap-2">
            <span className="text-base">ℹ</span>
            <span className="font-medium">{noticeMessage}</span>
          </div>
          <button
            type="button"
            onClick={() => setNoticeMessage(null)}
            className="text-xs text-muted hover:text-ink font-bold"
          >
            ✕
          </button>
        </div>
      )}

      {/* Metric Tiles (No Score, Clean Sheet Counts) */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatTile
          label="Total Imported Leads"
          value={stats.total.toLocaleString()}
          sub={`${stats.currentShown} currently displayed`}
        />
        <StatTile
          label="Uploaded Sheets / Groups"
          value={stats.sheetsCount.toLocaleString()}
          sub="Separate Excel sheet datasets"
        />
        <StatTile
          label="Captured Records"
          value={stats.total.toLocaleString()}
          sub="100% of imported data captured"
        />
        <StatTile
          label="Active Sheet / Filter"
          value={activeBundle ? activeBundle.name : "All Sheets"}
          sub={`${filteredLeads.length} leads in view`}
        />
      </div>

      {/* Multi-Card Sticky Action Bar (Appears when 1 or more group cards are selected) */}
      {selectedCardIds.size > 0 && (
        <div className="sticky top-2 z-30 flex flex-wrap items-center justify-between gap-3 rounded-2xl border-2 border-blue-600 bg-gradient-to-r from-[#0F1E36] to-[#0A1220] p-3.5 text-white shadow-2xl animate-fadeIn">
          <div className="flex items-center gap-3">
            <span className="rounded-full bg-blue-500/30 border border-blue-400 px-3 py-1 text-xs font-bold text-blue-200">
              {selectedCardIds.size} {selectedCardIds.size === 1 ? "Card" : "Cards"} Selected
            </span>
            <span className="text-xs text-white/90">
              {leads.filter((l) => l.groupId && selectedCardIds.has(l.groupId)).length} total leads
            </span>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              disabled={exportWorkbookMutation.isPending}
              onClick={() => exportWorkbookMutation.mutate({ groupIds: Array.from(selectedCardIds) })}
              className="inline-flex items-center gap-1.5 rounded-xl bg-white px-3.5 py-1.5 text-xs font-bold text-ink hover:bg-cream transition shadow-md disabled:opacity-50"
              title="Export all selected cards as a single multi-sheet Excel workbook (.xlsx)"
            >
              <span>📑</span>
              <span>
                {exportWorkbookMutation.isPending
                  ? "Building Workbook..."
                  : `Export as Multi-Sheet Workbook (.xlsx) (${selectedCardIds.size} ${selectedCardIds.size === 1 ? "sheet" : "sheets"})`}
              </span>
            </button>

            <button
              type="button"
              onClick={() => {
                setSelectedGroupIdsForCombine(new Set(selectedCardIds));
                setCombineModalOpen(true);
              }}
              className="inline-flex items-center gap-1.5 rounded-xl bg-blue-600 border border-blue-400 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-500 transition shadow-sm"
            >
              <span>📋</span> Combine into 'Lead List'
            </button>

            <button
              type="button"
              onClick={() => setSelectedCardIds(new Set())}
              className="rounded-xl px-2.5 py-1.5 text-xs text-white/70 hover:text-white transition"
            >
              ✕ Clear Selection
            </button>
          </div>
        </div>
      )}

      {/* Group Cards Section: Every group has its own card with lead count & instant sheet export */}
      <div className="space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="font-sans text-[11px] font-bold uppercase tracking-wider text-blue">
                Lead Groupings &amp; Workbooks
              </span>
              <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-bold text-blue">
                {groups.length} Groups
              </span>
            </div>
            <h2 className="font-display text-lg font-bold text-ink mt-0.5">
              Group Cards ({groups.length})
            </h2>
            <p className="text-xs text-muted">
              Select multiple cards to export as a multi-sheet Excel workbook (.xlsx), or export any card individually as its own sheet.
            </p>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={() => {
                if (groups.length > 0 && groups.every((g) => selectedCardIds.has(g.id))) {
                  setSelectedCardIds(new Set());
                } else {
                  setSelectedCardIds(new Set(groups.map((g) => g.id)));
                }
              }}
              className="inline-flex items-center gap-1.5 rounded-xl border border-line bg-white px-3 py-1.5 text-xs font-semibold text-ink hover:bg-sunken transition shadow-xs"
            >
              <span>{groups.length > 0 && groups.every((g) => selectedCardIds.has(g.id)) ? "Deselect All Cards" : "Select All Cards"}</span>
            </button>

            <button
              type="button"
              disabled={exportWorkbookMutation.isPending || groups.length === 0}
              onClick={() => exportWorkbookMutation.mutate({ groupIds: groups.map((g) => g.id) })}
              className="inline-flex items-center gap-1.5 rounded-xl border border-blue/40 bg-blue-50 px-3 py-1.5 text-xs font-semibold text-blue hover:bg-blue-100/70 transition shadow-xs disabled:opacity-50"
              title="Export all groups as a single workbook with a worksheet for each group"
            >
              <span>📑 Export All Groups as Workbook (.xlsx)</span>
            </button>
          </div>
        </div>

        {/* Group Cards Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {groups.map((group) => {
            const groupLeads = leads.filter((l) => l.groupId === group.id);
            const countInGroup = groupLeads.length;
            const reachableCount = groupLeads.filter((l) => l.contactEmail || l.contactPhone).length;
            const isCardChecked = selectedCardIds.has(group.id);
            const isActiveFilter = selectedBundle === group.id;

            return (
              <Card
                key={group.id}
                className={`relative p-5 flex flex-col justify-between transition border-2 ${
                  isCardChecked
                    ? "border-blue bg-blue-50/20 shadow-md ring-1 ring-blue/20"
                    : isActiveFilter
                    ? "border-ink bg-white shadow-xs ring-1 ring-ink/10"
                    : "border-line bg-white hover:border-ink/40 shadow-xs"
                }`}
              >
                <div>
                  {/* Top Row: Checkbox, Name, Count */}
                  <div className="flex items-start justify-between gap-2">
                    <label
                      className="flex items-start gap-2.5 cursor-pointer flex-1"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <input
                        type="checkbox"
                        checked={isCardChecked}
                        onChange={() => {
                          setSelectedCardIds((prev) => {
                            const next = new Set(prev);
                            if (next.has(group.id)) next.delete(group.id);
                            else next.add(group.id);
                            return next;
                          });
                        }}
                        className="mt-0.5 rounded border-line text-blue focus:ring-0 cursor-pointer h-4 w-4"
                      />
                      <div>
                        <h3 className="font-display text-sm font-bold text-ink leading-snug">
                          {group.name}
                        </h3>
                        {group.description && (
                          <p className="mt-0.5 text-[11px] text-muted line-clamp-2">{group.description}</p>
                        )}
                      </div>
                    </label>

                    <span className="rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-bold text-blue shrink-0">
                      {countInGroup} {countInGroup === 1 ? "lead" : "leads"}
                    </span>
                  </div>

                  {/* Middle Meta: Reachable, Status */}
                  <div className="mt-3.5 pt-3 border-t border-line/60 flex items-center justify-between text-[11px] text-muted">
                    <span>Captured: <strong className="text-ink font-semibold">{countInGroup} leads</strong></span>
                    <span>Format: <strong className="text-ink font-semibold">Sheet Tab</strong></span>
                  </div>
                </div>

                {/* Bottom Actions: Export as Sheet, View Leads, Delete */}
                <div className="mt-4 pt-3 border-t border-line flex items-center justify-between gap-1.5 flex-wrap">
                  <button
                    type="button"
                    onClick={() =>
                      exportWorkbookMutation.mutate({
                        groupIds: [group.id],
                        filename: `${slugifyName(group.name)}_${new Date().toISOString().slice(0, 10)}.xlsx`,
                      })
                    }
                    className="inline-flex items-center gap-1 rounded-lg border border-line bg-white px-2.5 py-1 text-[11px] font-semibold text-ink hover:bg-sunken transition shadow-2xs"
                    title="Export this particular group as a single-sheet Excel file (.xlsx)"
                  >
                    <span>📥 Export Sheet (.xlsx)</span>
                  </button>

                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setSelectedBundle(isActiveFilter ? "ALL" : group.id)}
                      className={`rounded-lg px-2.5 py-1 text-[11px] font-semibold transition ${
                        isActiveFilter
                          ? "bg-ink text-white"
                          : "border border-line bg-white text-muted hover:text-ink hover:bg-sunken"
                      }`}
                    >
                      {isActiveFilter ? "Viewing in Table ✓" : "View in Table"}
                    </button>

                    <button
                      type="button"
                      onClick={() => setDeleteBundleConfirm(group)}
                      className="rounded-lg p-1 text-muted hover:text-danger-text transition"
                      title="Delete this sheet group"
                    >
                      🗑
                    </button>
                  </div>
                </div>
              </Card>
            );
          })}

          {/* Ungrouped Leads Card if any exist */}
          {leads.filter((l) => !l.groupId).length > 0 && (
            <Card
              className={`p-5 flex flex-col justify-between transition border-2 ${
                selectedBundle === "ungrouped"
                  ? "border-ink bg-white shadow-xs"
                  : "border-line bg-white hover:border-ink/40 shadow-xs"
              }`}
            >
              <div>
                <div className="flex items-center justify-between gap-2">
                  <h3 className="font-display text-sm font-bold text-ink">Ungrouped Leads</h3>
                  <span className="rounded-full bg-sunken px-2.5 py-0.5 text-xs font-bold text-muted">
                    {leads.filter((l) => !l.groupId).length} leads
                  </span>
                </div>
                <p className="mt-1 text-[11px] text-muted">Leads not yet assigned to any uploaded sheet group.</p>
              </div>

              <div className="mt-4 pt-3 border-t border-line flex items-center justify-between gap-1.5">
                <button
                  type="button"
                  onClick={() =>
                    exportLeadsToCsv(
                      leads.filter((l) => !l.groupId),
                      `ungrouped_leads_${new Date().toISOString().slice(0, 10)}.csv`
                    )
                  }
                  className="inline-flex items-center gap-1 rounded-lg border border-line bg-white px-2.5 py-1 text-[11px] font-semibold text-ink hover:bg-sunken transition shadow-2xs"
                >
                  <span>📥 Export CSV</span>
                </button>

                <button
                  type="button"
                  onClick={() => setSelectedBundle(selectedBundle === "ungrouped" ? "ALL" : "ungrouped")}
                  className={`rounded-lg px-2.5 py-1 text-[11px] font-semibold transition ${
                    selectedBundle === "ungrouped"
                      ? "bg-ink text-white"
                      : "border border-line bg-white text-muted hover:text-ink hover:bg-sunken"
                  }`}
                >
                  {selectedBundle === "ungrouped" ? "Viewing in Table ✓" : "View in Table"}
                </button>
              </div>
            </Card>
          )}
        </div>
      </div>

      {/* Active Group Filter Banner (When filtered by card) */}
      {activeBundle && (
        <div className="rounded-2xl border border-blue-200 bg-blue-50/40 p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 shadow-xs">
          <div className="flex items-center gap-3">
            <span className="text-xl">📁</span>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-bold uppercase tracking-wider text-blue">Filtered by Card</span>
                <span className="rounded-full bg-blue-100 px-2 py-0.2 text-[10px] font-bold text-blue">
                  {filteredLeads.length} leads
                </span>
              </div>
              <h3 className="font-display text-base font-bold text-ink mt-0.5">{activeBundle.name}</h3>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() =>
                exportWorkbookMutation.mutate({
                  groupIds: [activeBundle.id],
                  filename: `${slugifyName(activeBundle.name)}_${new Date().toISOString().slice(0, 10)}.xlsx`,
                })
              }
              className="inline-flex items-center gap-1 rounded-xl bg-white border border-line px-3 py-1.5 text-xs font-semibold text-ink hover:bg-sunken shadow-xs transition"
            >
              <span>📥 Export Sheet (.xlsx)</span>
            </button>

            <Button variant="secondary" className="text-xs" onClick={() => setSelectedBundle("ALL")}>
              Show All Leads ({leads.length})
            </Button>
          </div>
        </div>
      )}

      {/* Selection Action Bar (Appears when rows are checked) */}
      {selectedIds.size > 0 && (
        <div className="sticky top-2 z-20 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-ink bg-ink p-3 text-white shadow-xl animate-fadeIn">
          <div className="flex items-center gap-3">
            <span className="rounded-full bg-white/20 px-2.5 py-1 text-xs font-bold text-white">
              {selectedIds.size} selected
            </span>
            <span className="text-xs text-white/80">Batch actions on chosen leads:</span>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={handleExportSelected}
              className="inline-flex items-center gap-1.5 rounded-xl bg-white px-3 py-1.5 text-xs font-semibold text-ink hover:bg-white/90 transition"
            >
              <span>📥</span> Export Selected ({selectedIds.size})
            </button>

            <button
              type="button"
              onClick={() => combineMutation.mutate({ ids: [...selectedIds], name: "Lead List" })}
              disabled={combineMutation.isPending}
              className="inline-flex items-center gap-1.5 rounded-xl bg-blue px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue/90 transition"
            >
              <span>📋</span> Combine into 'Lead List'
            </button>

            <button
              type="button"
              onClick={() => setDeleteSelectedConfirmOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-xl bg-danger-surface px-3 py-1.5 text-xs font-semibold text-danger-text hover:bg-danger-surface/80 transition"
            >
              <span>🗑</span> Delete Selected ({selectedIds.size})
            </button>

            <button
              type="button"
              onClick={() => setSelectedIds(new Set())}
              className="text-xs text-white/70 hover:text-white underline ml-1"
            >
              Deselect All
            </button>
          </div>
        </div>
      )}

      {/* Filter & Search Bar */}
      <Card className="p-4 space-y-3 shadow-xs">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="relative flex-1">
            <input
              type="text"
              placeholder="Search across all fields and uploaded Excel cells..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full rounded-xl border border-line bg-white px-3.5 py-2 text-xs placeholder:text-muted focus:border-ink focus:outline-none"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch("")}
                className="absolute right-2.5 top-2 text-xs text-muted hover:text-ink"
              >
                ✕
              </button>
            )}
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={handleExportFiltered}
              disabled={!filteredLeads.length}
              className="inline-flex items-center gap-1.5 rounded-xl border border-line bg-white px-3 py-2 text-xs font-semibold text-ink hover:bg-sunken disabled:opacity-50 transition"
              title="Export only the exact sheet columns without score or status"
            >
              <span>Export Sheet CSV</span>
            </button>

            <button
              type="button"
              onClick={() => setDeleteAllConfirmOpen(true)}
              disabled={leads.length === 0}
              className="inline-flex items-center gap-1.5 rounded-xl border border-danger-line/60 bg-white px-3 py-2 text-xs font-semibold text-danger-text hover:bg-danger-surface disabled:opacity-50 transition"
              title="Delete all leads belonging to Africon Leads page"
            >
              <span>🗑 Delete All Leads</span>
            </button>

            <Button variant="accent" onClick={() => setAddLeadOpen(true)}>
              + Add Lead
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-line/60">
          <select
            value={selectedCountry}
            onChange={(e) => setSelectedCountry(e.target.value)}
            className="rounded-lg border border-line bg-white px-2.5 py-1.5 text-[11px] text-ink focus:outline-none"
          >
            <option value="ALL">All African Markets</option>
            {AFRICAN_REGIONS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>

          <label className="flex items-center gap-1.5 ml-auto text-xs text-muted cursor-pointer">
            <input
              type="checkbox"
              checked={onlyReachable}
              onChange={(e) => setOnlyReachable(e.target.checked)}
              className="rounded border-line"
            />
            <span>Filter: Has direct Email/Phone only</span>
          </label>
        </div>
      </Card>

      {/* Untruncated Leads Table with Dynamic Sheet Columns */}
      {isLoading ? (
        <Card className="p-12 text-center text-xs text-muted">Loading Africon Leads...</Card>
      ) : filteredLeads.length === 0 ? (
        <EmptyState
          message={
            search || selectedCountry !== "ALL" || selectedBundle !== "ALL"
              ? "No leads matched your current filters. Clear filters or adjust your search query."
              : "Your Africon leads pipeline is currently empty. Use the template-driven import to upload leads."
          }
          action={
            <Button variant="accent" onClick={onGoToImport}>
              Import Leads Using Template
            </Button>
          }
        />
      ) : (
        <div className="overflow-hidden rounded-2xl border border-line bg-white shadow-xs">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-line bg-sunken/40 font-semibold text-muted">
                  <th className="w-8 px-4 py-3">
                    <input
                      type="checkbox"
                      checked={allVisibleSelected}
                      onChange={toggleSelectAllVisible}
                      className="rounded border-line"
                      title="Select / Deselect all visible"
                    />
                  </th>
                  <th className="px-4 py-3 min-w-[140px]">Sheet / Group</th>

                  {/* Render every single column that the sheet has — no fields hidden */}
                  {dynamicColumns.map((colHeader, idx) => (
                    <th key={idx} className="px-4 py-3 min-w-[140px] font-semibold text-ink whitespace-nowrap">
                      {colHeader}
                    </th>
                  ))}

                  <th className="px-4 py-3 text-right min-w-[110px]">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {filteredLeads.map((lead) => {
                  const isChecked = selectedIds.has(lead.id);
                  const leadGroupName = groups.find((g) => g.id === lead.groupId)?.name;

                  return (
                    <tr
                      key={lead.id}
                      onClick={() => setDrawerLead(lead)}
                      className={`group cursor-pointer transition ${
                        isChecked ? "bg-blue-50/40" : "hover:bg-[#F9FAFC]"
                      }`}
                    >
                      <td className="px-4 py-3.5" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={(e) => toggleSelectRow(lead.id, e as unknown as React.MouseEvent)}
                          className="rounded border-line cursor-pointer"
                        />
                      </td>

                      <td className="px-4 py-3.5 whitespace-nowrap">
                        {leadGroupName ? (
                          <span className="inline-flex items-center gap-1 rounded-md bg-sunken px-2 py-0.5 text-[10px] font-semibold text-ink">
                            <span>📁</span> {leadGroupName}
                          </span>
                        ) : (
                          <span className="text-[11px] text-muted">Ungrouped</span>
                        )}
                      </td>

                      {/* Render untruncated values for every sheet column */}
                      {dynamicColumns.map((colHeader, idx) => {
                        const cellVal = getLeadCellValue(lead, colHeader);
                        return (
                          <td key={idx} className="px-4 py-3.5 text-[11px] text-ink leading-relaxed">
                            {cellVal ? (
                              <span>{cellVal}</span>
                            ) : (
                              <span className="text-muted/50">—</span>
                            )}
                          </td>
                        );
                      })}

                      <td className="px-4 py-3.5 text-right whitespace-nowrap">
                        <div
                          className="flex items-center justify-end gap-1.5"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button
                            type="button"
                            title="Export lead with its sheet columns"
                            onClick={() =>
                              exportLeadsToCsv(
                                [lead],
                                `lead_${slugifyName(lead.contactName || lead.companyName || "contact")}_${new Date()
                                  .toISOString()
                                  .slice(0, 10)}.csv`
                              )
                            }
                            className="rounded-lg border border-line bg-white px-2 py-1 text-[11px] font-semibold text-ink hover:bg-sunken transition flex items-center gap-1"
                          >
                            <span>📥</span>
                            <span className="hidden sm:inline">Export</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => setDrawerLead(lead)}
                            className="rounded-lg border border-line bg-white px-2.5 py-1 text-[11px] font-semibold text-ink hover:bg-sunken transition"
                          >
                            Details
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              if (confirm(`Delete lead "${lead.contactName || lead.companyName}"?`)) {
                                deleteSingleMutation.mutate(lead.id);
                              }
                            }}
                            className="rounded-lg px-2 py-1 text-[11px] text-danger-text hover:bg-danger-surface transition"
                          >
                            ✕
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Untruncated Africon Lead Detail Drawer */}
      {drawerLead && (
        <AfriconLeadDrawer
          lead={drawerLead}
          groupName={groups.find((g) => g.id === drawerLead.groupId)?.name}
          onClose={() => setDrawerLead(null)}
          onDelete={() => {
            if (confirm(`Delete lead "${drawerLead.contactName || drawerLead.companyName}"?`)) {
              deleteSingleMutation.mutate(drawerLead.id);
            }
          }}
        />
      )}

      {/* Add Lead Modal */}
      {addLeadOpen && (
        <AddLeadModal
          onClose={() => setAddLeadOpen(false)}
          onSuccess={() => {
            setAddLeadOpen(false);
            invalidateLeads();
          }}
        />
      )}

      {/* Confirmation Modal: Delete All Africon Leads */}
      {deleteAllConfirmOpen && (
        <Modal open onClose={() => setDeleteAllConfirmOpen(false)} title="Delete All Africon Leads">
          <div className="space-y-4">
            <div className="rounded-xl bg-danger-surface p-3.5 text-xs text-danger-text leading-relaxed">
              <strong>Warning:</strong> This action will permanently remove all <strong>{leads.length}</strong> leads
              currently in the Africon Leads pipeline.
            </div>
            <p className="text-xs text-muted leading-relaxed">
              Your regular Dakyworld OS leads, clients, and outreach data outside of this section will <strong>NOT</strong>{" "}
              be affected or deleted.
            </p>
            <div className="flex justify-end gap-2 pt-3 border-t border-line">
              <Button variant="secondary" onClick={() => setDeleteAllConfirmOpen(false)} type="button">
                Cancel
              </Button>
              <Button
                variant="danger"
                disabled={deleteAllAfriconMutation.isPending}
                onClick={() => deleteAllAfriconMutation.mutate()}
              >
                {deleteAllAfriconMutation.isPending ? "Deleting..." : `Yes, Delete All (${leads.length})`}
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {/* Confirmation Modal: Delete Selected Leads */}
      {deleteSelectedConfirmOpen && (
        <Modal open onClose={() => setDeleteSelectedConfirmOpen(false)} title="Delete Selected Leads">
          <div className="space-y-4">
            <p className="text-xs text-muted leading-relaxed">
              Are you sure you want to delete the <strong>{selectedIds.size}</strong> selected Africon lead(s)? This
              action cannot be undone.
            </p>
            <div className="flex justify-end gap-2 pt-3 border-t border-line">
              <Button variant="secondary" onClick={() => setDeleteSelectedConfirmOpen(false)} type="button">
                Cancel
              </Button>
              <Button
                variant="danger"
                disabled={deleteSelectedMutation.isPending}
                onClick={() => deleteSelectedMutation.mutate()}
              >
                {deleteSelectedMutation.isPending ? "Deleting..." : `Delete ${selectedIds.size} Leads`}
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {/* Modal: Combine Groups into 'Lead List' */}
      {combineModalOpen && (
        <Modal
          open
          onClose={() => setCombineModalOpen(false)}
          title="Combine Africon Groups into 'Lead List'"
        >
          <div className="space-y-4">
            <p className="text-xs text-muted leading-relaxed">
              Select which uploaded sheet groups or datasets to merge into a single unified list. The leads from all chosen groups will be gathered together under 'Lead List'.
            </p>

            <div className="space-y-2 max-h-64 overflow-y-auto p-1 border border-line rounded-xl">
              <div className="flex items-center justify-between px-3 py-1.5 border-b border-line bg-sunken/40 text-xs">
                <span className="font-semibold text-ink">Available Groups ({groups.length}):</span>
                <button
                  type="button"
                  onClick={() => {
                    if (selectedGroupIdsForCombine.size === groups.length) {
                      setSelectedGroupIdsForCombine(new Set());
                    } else {
                      setSelectedGroupIdsForCombine(new Set(groups.map((g) => g.id)));
                    }
                  }}
                  className="text-xs font-semibold text-blue hover:underline"
                >
                  {selectedGroupIdsForCombine.size === groups.length ? "Deselect All" : "Select All"}
                </button>
              </div>

              {groups.map((g) => {
                const count = leads.filter((l) => l.groupId === g.id).length;
                const isChecked = selectedGroupIdsForCombine.has(g.id);
                return (
                  <label
                    key={g.id}
                    className={`flex items-center justify-between p-2.5 rounded-lg border cursor-pointer transition ${
                      isChecked ? "border-blue bg-blue-50/30" : "border-line/60 bg-white hover:bg-sunken/30"
                    }`}
                  >
                    <div className="flex items-center gap-2.5">
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => {
                          setSelectedGroupIdsForCombine((prev) => {
                            const next = new Set(prev);
                            if (next.has(g.id)) next.delete(g.id);
                            else next.add(g.id);
                            return next;
                          });
                        }}
                        className="rounded border-line text-blue"
                      />
                      <span className="text-xs font-bold text-ink">📁 {g.name}</span>
                    </div>
                    <span className="rounded-full bg-sunken px-2 py-0.5 text-[10px] font-bold text-muted">
                      {count} leads
                    </span>
                  </label>
                );
              })}
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-bold text-ink block">Target Combined List Name:</label>
              <input
                type="text"
                value={combineTargetName}
                onChange={(e) => setCombineTargetName(e.target.value)}
                placeholder="Lead List"
                className="w-full rounded-xl border border-line bg-white px-3 py-2 text-xs font-bold text-ink focus:border-ink focus:outline-none"
              />
            </div>

            <div className="rounded-xl bg-blue-50 p-3 text-xs text-blue">
              Total leads to combine: <strong>
                {leads.filter((l) => l.groupId && selectedGroupIdsForCombine.has(l.groupId)).length} leads
              </strong>
            </div>

            <div className="flex justify-end gap-2 pt-3 border-t border-line">
              <Button variant="secondary" onClick={() => setCombineModalOpen(false)} type="button">
                Cancel
              </Button>
              <Button
                variant="accent"
                disabled={combineMutation.isPending || selectedGroupIdsForCombine.size === 0}
                onClick={() =>
                  combineMutation.mutate({
                    groupIds: Array.from(selectedGroupIdsForCombine),
                    name: combineTargetName,
                  })
                }
              >
                {combineMutation.isPending
                  ? "Combining..."
                  : `Combine ${selectedGroupIdsForCombine.size} Groups into '${combineTargetName}'`}
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {/* Confirmation Modal: Delete Sheet Group */}
      {deleteBundleConfirm && (
        <Modal open onClose={() => setDeleteBundleConfirm(null)} title={`Delete Sheet Group: "${deleteBundleConfirm.name}"`}>
          <div className="space-y-4">
            <p className="text-xs text-muted leading-relaxed">
              How would you like to delete the sheet group <strong>{deleteBundleConfirm.name}</strong>?
            </p>
            <div className="space-y-2 pt-1">
              <button
                type="button"
                onClick={() => deleteBundleMutation.mutate({ groupId: deleteBundleConfirm.id, withLeads: true })}
                disabled={deleteBundleMutation.isPending}
                className="w-full text-left rounded-xl border border-danger-line/60 bg-danger-surface/40 p-3 text-xs hover:bg-danger-surface transition"
              >
                <div className="font-bold text-danger-text">Delete Sheet Group AND All Leads Inside</div>
                <div className="text-[11px] text-muted">
                  Completely removes the group and permanently deletes all leads assigned to it.
                </div>
              </button>

              <button
                type="button"
                onClick={() => deleteBundleMutation.mutate({ groupId: deleteBundleConfirm.id, withLeads: false })}
                disabled={deleteBundleMutation.isPending}
                className="w-full text-left rounded-xl border border-line bg-white p-3 text-xs hover:bg-sunken transition"
              >
                <div className="font-bold text-ink">Delete Sheet Group Only (Keep Leads)</div>
                <div className="text-[11px] text-muted">
                  Removes the group definition. Leads inside become "Ungrouped" in the Africon pipeline.
                </div>
              </button>
            </div>

            <div className="flex justify-end pt-3 border-t border-line">
              <Button variant="secondary" onClick={() => setDeleteBundleConfirm(null)} type="button">
                Cancel
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ============================================================================
// Untruncated Africon Lead Drawer (Displays all sheet fields in full)
// ============================================================================
function AfriconLeadDrawer({
  lead,
  groupName,
  onClose,
  onDelete,
}: {
  lead: Lead;
  groupName?: string;
  onClose: () => void;
  onDelete: () => void;
}) {
  // Extract all fields present for this lead
  const rawFields = useMemo(() => {
    const raw = (lead.enrichment as { raw?: Record<string, string> } | null)?.raw;
    if (raw && typeof raw === "object") {
      return Object.entries(raw);
    }

    const fields: [string, string][] = [];
    if (lead.contactName) fields.push(["Contact Name", lead.contactName]);
    if (lead.companyName) fields.push(["Company Name", lead.companyName]);
    if (lead.contactEmail) fields.push(["Official Email", lead.contactEmail]);
    if (lead.contactPhone) fields.push(["Direct Phone", lead.contactPhone]);
    if (lead.country) fields.push(["Country", lead.country]);
    if (lead.city) fields.push(["City", lead.city]);
    if (lead.category) fields.push(["Industry Sector", lead.category]);
    if (lead.website) fields.push(["Website", lead.website]);
    if (lead.address) fields.push(["Address", lead.address]);
    if (lead.discoveryNotes) fields.push(["Notes", lead.discoveryNotes]);

    if (lead.customFields && typeof lead.customFields === "object") {
      Object.entries(lead.customFields).forEach(([k, v]) => {
        if (v !== null && v !== undefined && v !== "") {
          fields.push([k, String(v)]);
        }
      });
    }
    return fields;
  }, [lead]);

  return (
    <Drawer open onClose={onClose} title={lead.contactName || lead.companyName || "Lead Details"}>
      <div className="space-y-6 pb-8">
        {/* Header Summary */}
        <div className="border-b border-line pb-4">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-lg text-ink">
              {lead.contactName || "Unnamed Lead"}
            </span>
            {groupName && (
              <span className="rounded-md bg-sunken px-2 py-0.5 text-[11px] font-semibold text-ink">
                📁 {groupName}
              </span>
            )}
          </div>
          {lead.companyName && (
            <p className="text-xs text-muted mt-0.5">🏢 {lead.companyName}</p>
          )}
        </div>

        {/* Untruncated Sheet Data Fields */}
        <div className="space-y-3">
          <h4 className="text-xs font-bold uppercase tracking-wider text-muted">
            Imported Sheet Fields ({rawFields.length})
          </h4>

          <div className="divide-y divide-line rounded-xl border border-line bg-white overflow-hidden">
            {rawFields.map(([key, val], idx) => (
              <div key={idx} className="p-3 hover:bg-sunken/20 transition">
                <span className="text-[10px] font-bold uppercase tracking-wider text-muted block mb-0.5">
                  {key}
                </span>
                <div className="text-xs font-medium text-ink break-words whitespace-pre-wrap leading-relaxed">
                  {val ? val : <span className="text-muted">—</span>}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 pt-4 border-t border-line">
          <button
            type="button"
            onClick={() =>
              exportLeadsToCsv(
                [lead],
                `lead_${slugifyName(lead.contactName || lead.companyName || "lead")}.csv`
              )
            }
            className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-xl border border-line bg-white px-3 py-2 text-xs font-semibold text-ink hover:bg-sunken shadow-xs transition"
          >
            <span>📥</span> Export Lead CSV
          </button>

          <Button variant="danger" className="text-xs" onClick={onDelete}>
            Delete Lead
          </Button>
        </div>
      </div>
    </Drawer>
  );
}

// ============================================================================
// Modal: Add Lead Hand Form
// ============================================================================
function AddLeadModal({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  const [name, setName] = useState("");
  const [company, setCompany] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [country, setCountry] = useState("Ghana");
  const [city, setCity] = useState("");
  const [category, setCategory] = useState("");
  const [notes, setNotes] = useState("");

  const addMutation = useMutation({
    mutationFn: () =>
      api.post("/leads", {
        contactName: name.trim() || company.trim(),
        companyName: company.trim() || undefined,
        contactEmail: email.trim() || undefined,
        contactPhone: phone.trim() || undefined,
        country: country.trim() || undefined,
        city: city.trim() || undefined,
        category: category.trim() || undefined,
        discoveryNotes: notes.trim() || undefined,
        source: "OTHER",
        status: "NEW",
        tags: ["africon"],
      }),
    onSuccess,
  });

  return (
    <Modal open onClose={onClose} title="Add Africon Lead Manually">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim() && !company.trim()) return;
          addMutation.mutate();
        }}
        className="space-y-3.5"
      >
        <Field label="Contact Person / Full Name">
          <input
            type="text"
            required={!company.trim()}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Samuel Annan"
            className="w-full rounded-xl border border-line px-3 py-2 text-xs focus:border-ink focus:outline-none"
          />
        </Field>

        <Field label="Company / Organization Name">
          <input
            type="text"
            required={!name.trim()}
            value={company}
            onChange={(e) => setCompany(e.target.value)}
            placeholder="e.g. Accra Logistics Hub"
            className="w-full rounded-xl border border-line px-3 py-2 text-xs focus:border-ink focus:outline-none"
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Official Email">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="lead@company.com"
              className="w-full rounded-xl border border-line px-3 py-2 text-xs focus:border-ink focus:outline-none"
            />
          </Field>
          <Field label="Phone / WhatsApp Number">
            <input
              type="text"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+233 24 000 0000"
              className="w-full rounded-xl border border-line px-3 py-2 text-xs focus:border-ink focus:outline-none"
            />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Country">
            <select
              value={country}
              onChange={(e) => setCountry(e.target.value)}
              className="w-full rounded-xl border border-line px-3 py-2 text-xs focus:border-ink focus:outline-none bg-white"
            >
              {AFRICAN_REGIONS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </Field>
          <Field label="City">
            <input
              type="text"
              value={city}
              onChange={(e) => setCity(e.target.value)}
              placeholder="e.g. Accra, Lagos, Nairobi"
              className="w-full rounded-xl border border-line px-3 py-2 text-xs focus:border-ink focus:outline-none"
            />
          </Field>
        </div>

        <Field label="Industry / Sector">
          <input
            type="text"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            placeholder="e.g. Financial Services, Manufacturing"
            className="w-full rounded-xl border border-line px-3 py-2 text-xs focus:border-ink focus:outline-none"
          />
        </Field>

        <Field label="Notes & Context">
          <textarea
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Initial discovery notes..."
            className="w-full rounded-xl border border-line px-3 py-2 text-xs focus:border-ink focus:outline-none"
          />
        </Field>

        <div className="flex justify-end gap-2 pt-3 border-t border-line">
          <Button variant="secondary" onClick={onClose} type="button">
            Cancel
          </Button>
          <Button variant="accent" type="submit" disabled={addMutation.isPending}>
            {addMutation.isPending ? "Adding..." : "Save Lead"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ============================================================================
// TAB 2: Import Leads with Lead Template View
// ============================================================================
interface FileUpload {
  name: string;
  size: number;
  dataBase64: string;
}

interface InspectedTemplate {
  fileName: string;
  columns: TemplateColumnDef[];
  rawHeaders?: string[];
}

function TemplateImportView({ onImportSuccess }: { onImportSuccess: () => void }) {
  const qc = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const templateInputRef = useRef<HTMLInputElement>(null);

  // Uploaded files state
  const [leadsFile, setLeadsFile] = useState<FileUpload | null>(null);
  const [templateFile, setTemplateFile] = useState<FileUpload | null>(null);
  const [inspectedTemplate, setInspectedTemplate] = useState<InspectedTemplate | null>(null);
  const [templateLoading, setTemplateLoading] = useState(false);

  // Grouping mode: separate lists per detected section/sheet vs single combined list
  const [groupingMode, setGroupingMode] = useState<"separate" | "combined">("combined");
  const [tableTitles, setTableTitles] = useState<Record<string, string>>({});
  const [customGroupTitle, setCustomGroupTitle] = useState<string>("");

  // Settings
  const [useAi, setUseAi] = useState(true);

  // Execution states
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisStatus, setAnalysisStatus] = useState<string | null>(null);
  const [importId, setImportId] = useState<string | null>(null);
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [previews, setPreviews] = useState<TablePreview[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [isCommitting, setIsCommitting] = useState(false);
  const [committedResult, setCommittedResult] = useState<{
    leadsCreated: number;
    groupsCreated: number;
    groupName?: string;
    mode?: "separate" | "combined";
  } | null>(null);

  // Inspect template file whenever uploaded
  const handleTemplateUpload = async (file: File) => {
    try {
      setTemplateLoading(true);
      const dataBase64 = await toBase64(file);
      const upload: FileUpload = { name: file.name, size: file.size, dataBase64 };
      setTemplateFile(upload);

      const result = await api.post<InspectedTemplate>("/imports/inspect-template", {
        dataBase64,
        fileName: file.name,
      });
      setInspectedTemplate(result);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to read template file.");
      setTemplateFile(null);
      setInspectedTemplate(null);
    } finally {
      setTemplateLoading(false);
    }
  };

  const handleApplyPresetTemplate = (preset: (typeof AFRICON_TEMPLATE_PRESETS)[number]) => {
    const csvContent = [preset.columns.map((c) => c.header).join(","), ...preset.sampleRows].join("\n");
    const dataBase64 = btoa(csvContent);
    setTemplateFile({
      name: preset.fileName,
      size: csvContent.length,
      dataBase64,
    });
    setInspectedTemplate({
      fileName: preset.fileName,
      columns: preset.columns.map((c, idx) => ({ ...c, index: idx })),
      rawHeaders: preset.columns.map((c) => c.header),
    });
  };

  const handleLeadsFileUpload = async (file: File) => {
    const dataBase64 = await toBase64(file);
    setLeadsFile({ name: file.name, size: file.size, dataBase64 });
    const cleanName = file.name.replace(/\.[^/.]+$/, "").trim();
    setCustomGroupTitle(cleanName);
    setPlan(null);
    setPreviews([]);
    setCommittedResult(null);
  };

  // Run the import analysis (Opening + Sequential Sheet Reading)
  const startAnalysis = async () => {
    if (!leadsFile) return;
    setIsAnalyzing(true);
    setAnalysisStatus("Opening file on server...");
    setWarnings([]);

    try {
      const cleanFileName = leadsFile.name.replace(/\.[^/.]+$/, "").trim() || "Uploaded Sheet";
      const targetGroupName = customGroupTitle.trim() || cleanFileName;

      // Step 1: Open import on server
      const opened = await api.post<AnalyzeStep>("/imports/analyze", {
        source: "UPLOAD",
        fileName: leadsFile.name,
        dataBase64: leadsFile.dataBase64,
        useAi,
        templateFileName: templateFile?.name,
        templateDataBase64: templateFile?.dataBase64,
        isAfricon: true,
        tags: ["africon"],
      });

      const currentImportId = opened.import.id;
      setImportId(currentImportId);

      const remainingSheets = opened.progress.remaining;
      const gatheredTables: PlanTable[] = [];
      const gatheredPreviews: TablePreview[] = [];
      const gatheredWarnings: string[] = [];

      // Step 2: Read tabs
      for (let i = 0; i < remainingSheets.length; i++) {
        const sheetName = remainingSheets[i];
        setAnalysisStatus(
          templateFile
            ? `AI structuring "${sheetName}" using template "${templateFile.name}" (${i + 1}/${remainingSheets.length})...`
            : `Analyzing sheet "${sheetName}" (${i + 1}/${remainingSheets.length})...`
        );

        const step = await api.post<AnalyzeStep>("/imports/analyze", {
          importId: currentImportId,
          sheet: sheetName,
          useAi,
          dataBase64: leadsFile.dataBase64,
          fileName: leadsFile.name,
          isAfricon: true,
          tags: ["africon"],
        });

        gatheredTables.push(...step.tables);
        gatheredPreviews.push(...step.previews);
        gatheredWarnings.push(...step.warnings);
      }

      // Preserve each detected section/table with its own sensible default title
      const updatedTables = gatheredTables.map((t, idx) => {
        let fallbackTitle = t.title?.trim();
        if (!fallbackTitle || fallbackTitle === "Imported leads" || fallbackTitle.toLowerCase() === "leads") {
          fallbackTitle = remainingSheets.length > 1
            ? `${cleanFileName} - ${t.sheet}`
            : (gatheredTables.length > 1 ? `${cleanFileName} - Section ${idx + 1}` : cleanFileName);
        } else if (remainingSheets.length > 1 && !fallbackTitle.includes(t.sheet)) {
          fallbackTitle = `${t.sheet} - ${fallbackTitle}`;
        }
        return {
          ...t,
          title: fallbackTitle,
        };
      });

      const initialTableTitles: Record<string, string> = {};
      updatedTables.forEach((t) => {
        initialTableTitles[t.id] = t.title;
      });
      setTableTitles(initialTableTitles);
      const isMultiSheet = remainingSheets.length > 1;
      setGroupingMode(isMultiSheet ? "separate" : "combined");

      setPlan({
        tables: updatedTables,
        summary: `Imported from ${leadsFile.name}${templateFile ? ` • Structured using template: ${templateFile.name}` : ""}`,
        grouping: isMultiSheet ? "table" : "sheet",
        singleListTitle: targetGroupName,
        isAfricon: true,
        tags: ["africon"],
        template: inspectedTemplate ? { fileName: inspectedTemplate.fileName, columns: inspectedTemplate.columns } : undefined,
      });
      setPreviews(gatheredPreviews);
      setWarnings(gatheredWarnings);
      setAnalysisStatus(null);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Analysis failed.");
      setAnalysisStatus(null);
    } finally {
      setIsAnalyzing(false);
    }
  };

  // Commit approved plan into database
  const commitImport = async () => {
    if (!importId || !plan) return;
    setIsCommitting(true);
    try {
      const cleanFileName = leadsFile?.name.replace(/\.[^/.]+$/, "").trim() || "Uploaded Sheet";
      const targetCombinedTitle = customGroupTitle.trim() || plan.singleListTitle || cleanFileName;
      const isMulti = plan.tables.length > 1;
      const finalGrouping = isMulti ? (groupingMode === "separate" ? "table" : "single") : "sheet";

      const tablesWithTitles = plan.tables.map((t) => ({
        ...t,
        title: tableTitles[t.id]?.trim() || t.title,
      }));

      const response = await api.post<{
        import: LeadImportRecord;
        result: { leadsCreated: number; groupsCreated: number };
      }>(`/imports/${importId}/commit`, {
        plan: {
          ...plan,
          grouping: finalGrouping,
          tables: tablesWithTitles,
          isAfricon: true,
          tags: ["africon"],
          singleListTitle: targetCombinedTitle,
        },
        dataBase64: leadsFile?.dataBase64,
        fileName: leadsFile?.name,
      });

      setCommittedResult({
        leadsCreated: response.result.leadsCreated,
        groupsCreated: response.result.groupsCreated,
        groupName: groupingMode === "separate" && isMulti ? `${response.result.groupsCreated} Separate Groups` : targetCombinedTitle,
        mode: groupingMode,
      });
      qc.invalidateQueries({ queryKey: ["leads"] });
    } catch (err) {
      alert(err instanceof Error ? err.message : "Commit failed.");
    } finally {
      setIsCommitting(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Step 1 & 2: Uploads Header */}
      {!plan && !committedResult && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {/* File 1: Leads Data File */}
          <Card className="p-5 flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between">
                <span className="font-sans text-[11px] font-bold uppercase tracking-wider text-muted">
                  Step 1 · Source Excel / CSV (Required)
                </span>
                {leadsFile && (
                  <span className="rounded-full bg-green-50 px-2 py-0.5 text-[11px] font-semibold text-green-700">
                    Ready
                  </span>
                )}
              </div>
              <h2 className="mt-1 font-display text-lg font-semibold text-ink">Upload Leads File</h2>
              <p className="mt-1 text-xs text-muted leading-relaxed">
                Choose the spreadsheet (.csv, .xlsx, or .tsv) that contains your contacts. It will be saved as a group
                under this sheet's name.
              </p>

              <div
                onClick={() => fileInputRef.current?.click()}
                className="mt-4 flex flex-col items-center justify-center rounded-2xl border-2 border-dashed border-line p-6 text-center hover:border-ink hover:bg-sunken/40 cursor-pointer transition"
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv,.xlsx,.tsv"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleLeadsFileUpload(f);
                  }}
                />
                <span className="text-2xl">📊</span>
                <span className="mt-2 text-xs font-semibold text-ink">
                  {leadsFile ? leadsFile.name : "Click to select or drop Leads file"}
                </span>
                <span className="text-[11px] text-muted">
                  {leadsFile ? `${Math.round(leadsFile.size / 1024)} KB` : "Supports Excel (.xlsx), CSV, or TSV up to 20MB"}
                </span>
              </div>
            </div>

            {leadsFile && (
              <div className="mt-4 space-y-2 pt-3 border-t border-line">
                <Field label="Sheet Group Name (Saves as proof under this name):">
                  <input
                    type="text"
                    value={customGroupTitle}
                    onChange={(e) => setCustomGroupTitle(e.target.value)}
                    placeholder="e.g. Ghana_Tech_Startups_2026"
                    className="w-full rounded-xl border border-line bg-white px-3 py-1.5 text-xs font-semibold text-ink focus:border-ink focus:outline-none"
                  />
                </Field>
                <div className="flex items-center justify-between text-xs text-muted">
                  <span className="truncate max-w-[200px]">{leadsFile.name}</span>
                  <button
                    type="button"
                    onClick={() => setLeadsFile(null)}
                    className="text-danger-text hover:underline"
                  >
                    Remove
                  </button>
                </div>
              </div>
            )}
          </Card>

          {/* File 2: Lead Template */}
          <Card className="p-5 flex flex-col justify-between border-blue/30 bg-gradient-to-b from-blue-50/20 to-transparent">
            <div>
              <div className="flex items-center justify-between">
                <span className="font-sans text-[11px] font-bold uppercase tracking-wider text-blue">
                  Step 2 · Lead Template (Optional)
                </span>
                {templateFile && (
                  <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-semibold text-blue">
                    Template Active
                  </span>
                )}
              </div>
              <h2 className="mt-1 font-display text-lg font-semibold text-ink">Upload Target Template</h2>
              <p className="mt-1 text-xs text-muted leading-relaxed">
                Add an Excel or CSV template. Our AI will automatically align, rename, and structure your imported leads
                to match this template's schema. If left blank, standard auto-mapping runs.
              </p>

              <div
                onClick={() => templateInputRef.current?.click()}
                className={`mt-4 flex flex-col items-center justify-center rounded-2xl border-2 border-dashed p-6 text-center cursor-pointer transition ${
                  templateFile
                    ? "border-blue bg-blue-50/30"
                    : "border-line hover:border-blue hover:bg-blue-50/10"
                }`}
              >
                <input
                  ref={templateInputRef}
                  type="file"
                  accept=".csv,.xlsx"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleTemplateUpload(f);
                  }}
                />
                <span className="text-2xl">{templateLoading ? "⏳" : "📑"}</span>
                <span className="mt-2 text-xs font-semibold text-ink">
                  {templateLoading
                    ? "Reading template structure..."
                    : templateFile
                    ? templateFile.name
                    : "Select or drop your Lead Template sheet"}
                </span>
                <span className="text-[11px] text-muted">Optional: Excel or CSV with target columns</span>
              </div>

              {/* Detected Template Columns Chips */}
              {inspectedTemplate && (
                <div className="mt-3.5 space-y-1.5">
                  <div className="text-[11px] font-semibold text-blue flex items-center justify-between">
                    <span>Target Columns Detected ({inspectedTemplate.columns.length}):</span>
                    <button
                      type="button"
                      onClick={() => {
                        setTemplateFile(null);
                        setInspectedTemplate(null);
                      }}
                      className="text-[10px] text-danger-text hover:underline"
                    >
                      Clear Template
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-1 max-h-24 overflow-y-auto p-1.5 bg-white rounded-xl border border-line">
                    {inspectedTemplate.columns.map((col, idx) => (
                      <span
                        key={idx}
                        className="rounded-md bg-sunken px-2 py-0.5 text-[10px] font-medium text-ink flex items-center gap-1"
                      >
                        <span className="font-semibold text-blue">{col.label || col.header}</span>
                        <span className="text-[9px] text-muted">({col.type})</span>
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Quick Template Presets */}
            <div className="mt-4 pt-3 border-t border-line">
              <span className="text-[11px] font-semibold text-muted block mb-1.5">Or use a verified Africon preset:</span>
              <div className="flex flex-wrap gap-1.5">
                {AFRICON_TEMPLATE_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => handleApplyPresetTemplate(preset)}
                    className="rounded-lg border border-line bg-white px-2 py-1 text-[10px] font-semibold text-ink hover:bg-blue-50 hover:text-blue hover:border-blue transition"
                  >
                    + {preset.title}
                  </button>
                ))}
              </div>
            </div>
          </Card>
        </div>
      )}

      {/* Analysis trigger bar */}
      {!plan && !committedResult && leadsFile && (
        <Card className="p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 bg-sunken/40">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-xs text-ink">Ready to Structure &amp; Import</span>
              {templateFile ? (
                <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-bold text-blue">
                  ✓ Matching to Template: {templateFile.name}
                </span>
              ) : (
                <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-muted">
                  Standard Import (No Template)
                </span>
              )}
            </div>
            <label className="flex items-center gap-2 text-xs text-muted cursor-pointer">
              <input
                type="checkbox"
                checked={useAi}
                onChange={(e) => setUseAi(e.target.checked)}
                className="rounded border-line"
              />
              <span>Use AI Analyst to inspect and align messy columns</span>
            </label>
          </div>

          <Button
            variant="accent"
            disabled={isAnalyzing}
            onClick={startAnalysis}
          >
            {isAnalyzing ? "Analyzing & Structuring..." : "Start Import Analysis"}
          </Button>
        </Card>
      )}

      {/* Analysis Running Progress Bar */}
      {isAnalyzing && (
        <Card className="p-8 text-center space-y-3">
          <div className="animate-spin text-2xl">⚙</div>
          <h3 className="font-display text-base font-semibold text-ink">Structuring Lead Spreadsheet</h3>
          <p className="text-xs text-muted">{analysisStatus || "Analyzing columns..."}</p>
          <div className="mx-auto max-w-xs h-1.5 overflow-hidden rounded-full bg-sunken">
            <div className="h-full bg-blue animate-pulse w-3/4"></div>
          </div>
        </Card>
      )}

      {/* Step 3: Plan Review & Interactive Column Mapping */}
      {plan && !committedResult && (
        <div className="space-y-6">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between border-b border-line pb-4">
            <div>
              <div className="flex items-center gap-2">
                <span className="rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-bold text-green-700">
                  Plan Ready
                </span>
                {templateFile && (
                  <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-bold text-blue">
                    ✓ Structured with Template
                  </span>
                )}
              </div>
              <h2 className="mt-1 font-display text-xl font-bold text-ink">Review &amp; Approve Import Plan</h2>
              <p className="text-xs text-muted">
                Inspect how columns are mapped. All data will be saved as a group under the sheet's name.
              </p>
            </div>

            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                onClick={() => {
                  setPlan(null);
                  setPreviews([]);
                }}
              >
                Cancel
              </Button>
              <Button
                variant="accent"
                disabled={isCommitting}
                onClick={commitImport}
              >
                {isCommitting
                  ? "Importing Leads..."
                  : plan.tables.length > 1
                  ? (groupingMode === "separate"
                      ? `Save as ${plan.tables.length} Separate Groups (${previews.reduce((s, p) => s + p.rowCount, 0)} Leads)`
                      : `Save as Combined Group: "${customGroupTitle.trim() || plan.singleListTitle || "Uploaded Sheet"}" (${previews.reduce((s, p) => s + p.rowCount, 0)} Leads)`)
                  : `Save as Group: "${customGroupTitle.trim() || plan.singleListTitle || "Uploaded Sheet"}" (${previews[0]?.rowCount ?? 0} Leads)`}
              </Button>
            </div>
          </div>

          {/* Grouping Strategy (when multiple tables / sections are detected) */}
          {plan.tables.length > 1 ? (
            <Card className="p-5 border-blue/40 bg-gradient-to-r from-blue-50/30 to-transparent space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <span className="font-sans text-[11px] font-bold uppercase tracking-wider text-blue">
                    Step 3 · Grouping &amp; Categorization
                  </span>
                  <h3 className="font-display text-base font-bold text-ink mt-0.5">
                    How should these ${plan.tables.length} datasets be categorized?
                  </h3>
                </div>
                <span className="rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-bold text-blue">
                  {plan.tables.length} tables / sections found
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                <button
                  type="button"
                  onClick={() => setGroupingMode("separate")}
                  className={`text-left rounded-2xl border-2 p-4 transition ${
                    groupingMode === "separate"
                      ? "border-blue bg-white shadow-xs"
                      : "border-line bg-white/70 hover:border-ink/40"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <input
                      type="radio"
                      checked={groupingMode === "separate"}
                      onChange={() => setGroupingMode("separate")}
                      className="rounded-full border-blue text-blue focus:ring-0"
                    />
                    <span className="font-bold text-ink text-sm">Save as Separate Groups ({plan.tables.length} lists)</span>
                  </div>
                  <p className="mt-2 text-xs text-muted leading-relaxed pl-6">
                    Recommended: Each section (or sheet) becomes its own independent list. You can export each list individually, or combine them together into 'Lead List' whenever you want.
                  </p>
                </button>

                <button
                  type="button"
                  onClick={() => setGroupingMode("combined")}
                  className={`text-left rounded-2xl border-2 p-4 transition ${
                    groupingMode === "combined"
                      ? "border-blue bg-white shadow-xs"
                      : "border-line bg-white/70 hover:border-ink/40"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <input
                      type="radio"
                      checked={groupingMode === "combined"}
                      onChange={() => setGroupingMode("combined")}
                      className="rounded-full border-blue text-blue focus:ring-0"
                    />
                    <span className="font-bold text-ink text-sm">Merge into One Combined Group (1 list)</span>
                  </div>
                  <p className="mt-2 text-xs text-muted leading-relaxed pl-6">
                    Merges all {plan.tables.length} datasets into a single combined list with all leads together.
                  </p>
                </button>
              </div>

              {/* Group Names Configuration */}
              {groupingMode === "separate" ? (
                <div className="mt-3 pt-3 border-t border-line/60 space-y-2">
                  <span className="text-xs font-bold text-ink block">
                    Define Group Name for Each Detected Section:
                  </span>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    {plan.tables.map((table, tIdx) => {
                      const preview = previews.find((p) => p.tableId === table.id);
                      const count = preview?.rowCount ?? (table.lastDataRow - table.firstDataRow + 1);
                      return (
                        <div key={table.id} className="rounded-xl border border-line bg-white p-3 space-y-1.5 shadow-2xs">
                          <div className="flex items-center justify-between text-xs">
                            <span className="font-semibold text-blue">Section #{tIdx + 1} ({table.sheet})</span>
                            <span className="rounded-full bg-sunken px-2 py-0.5 text-[10px] font-bold text-ink">
                              {count} leads
                            </span>
                          </div>
                          <input
                            type="text"
                            value={tableTitles[table.id] ?? table.title}
                            onChange={(e) => setTableTitles({ ...tableTitles, [table.id]: e.target.value })}
                            placeholder={`Group name for Section ${tIdx + 1}...`}
                            className="w-full rounded-lg border border-line bg-white px-2.5 py-1.5 text-xs font-bold text-ink focus:border-blue focus:outline-none"
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <div className="mt-3 pt-3 border-t border-line/60 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                  <div>
                    <span className="text-xs font-bold text-ink block">Combined Group Name:</span>
                    <p className="text-xs text-muted mt-0.5">All leads will be saved under this unified list name:</p>
                  </div>
                  <div className="w-full sm:w-72">
                    <input
                      type="text"
                      value={customGroupTitle}
                      onChange={(e) => setCustomGroupTitle(e.target.value)}
                      placeholder="Combined group name..."
                      className="w-full rounded-xl border border-line bg-white px-3 py-2 text-xs font-bold text-ink focus:border-ink focus:outline-none"
                    />
                  </div>
                </div>
              )}
            </Card>
          ) : (
            <Card className="p-4 border-blue/40 bg-blue-50/20 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div>
                <span className="font-sans text-[11px] font-bold uppercase tracking-wider text-blue">
                  Group / Sheet Proof Name
                </span>
                <p className="text-xs text-muted mt-0.5">
                  This imported file will be saved as an independent group under this name in your pipeline:
                </p>
              </div>
              <div className="w-full sm:w-72">
                <input
                  type="text"
                  value={customGroupTitle}
                  onChange={(e) => setCustomGroupTitle(e.target.value)}
                  placeholder="Sheet group name..."
                  className="w-full rounded-xl border border-line bg-white px-3 py-2 text-xs font-bold text-ink focus:border-ink focus:outline-none"
                />
              </div>
            </Card>
          )}

          {/* Warnings / Reports */}
          {warnings.length > 0 && (
            <div className="space-y-1 rounded-xl bg-blue-50/60 p-3.5 border border-blue-200 text-xs text-ink">
              <span className="font-semibold text-blue block mb-1">Import Notes &amp; Template Reports:</span>
              {warnings.map((w, idx) => (
                <div key={idx} className="flex items-start gap-1.5 text-muted">
                  <span>•</span>
                  <span>{w}</span>
                </div>
              ))}
            </div>
          )}

          {/* Table Preview and Columns Mapped */}
          {plan.tables.map((table, tIdx) => {
            const preview = previews.find((p) => p.tableId === table.id);
            return (
              <Card key={table.id} className="p-5 space-y-4">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <h3 className="font-display text-base font-bold text-ink">{table.title}</h3>
                    <p className="text-xs text-muted">
                      Sheet: <span className="font-semibold text-ink">{table.sheet}</span> · Rows{" "}
                      {table.firstDataRow + 1} to {table.lastDataRow + 1} ({table.lastDataRow - table.firstDataRow + 1} rows)
                    </p>
                  </div>
                  {preview && (
                    <div className="flex items-center gap-3 text-xs">
                      <span className="text-muted">Captured Leads: <strong className="text-ink">{preview.rowCount}</strong></span>
                      <span className="text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-full font-medium text-[11px]">100% Captured</span>
                    </div>
                  )}
                </div>

                {/* Column Mappings */}
                <div className="space-y-2">
                  <h4 className="text-xs font-semibold text-ink">Mapped Columns ({table.columns.length})</h4>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {table.columns.map((col, cIdx) => (
                      <div
                        key={cIdx}
                        className="flex flex-col justify-between rounded-xl border border-line bg-sunken/30 p-2.5 text-xs"
                      >
                        <div className="flex items-center justify-between mb-1.5">
                          <span className="font-mono text-[10px] text-muted truncate max-w-[140px]" title={col.header}>
                            Source: "{col.header || `Col ${col.index + 1}`}"
                          </span>
                          <span className="rounded bg-white px-1.5 py-0.2 text-[9px] font-bold text-blue border border-line">
                            {col.type}
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <span className="text-muted">→</span>
                          <input
                            type="text"
                            value={col.label}
                            onChange={(e) => {
                              const nextTables = [...plan.tables];
                              nextTables[tIdx].columns[cIdx].label = e.target.value;
                              setPlan({ ...plan, tables: nextTables });
                            }}
                            className="flex-1 rounded border border-line bg-white px-2 py-1 text-xs font-semibold text-ink focus:border-ink focus:outline-none"
                          />
                        </div>
                        <div className="mt-1 flex items-center justify-between text-[10px]">
                          <span className="text-muted">Field:</span>
                          <select
                            value={col.field}
                            onChange={(e) => {
                              const nextTables = [...plan.tables];
                              nextTables[tIdx].columns[cIdx].field = e.target.value;
                              setPlan({ ...plan, tables: nextTables });
                            }}
                            className="rounded border border-line bg-white px-1 py-0.5 text-[10px] text-ink"
                          >
                            <option value="contactName">contactName (Full Name)</option>
                            <option value="companyName">companyName</option>
                            <option value="contactEmail">contactEmail</option>
                            <option value="contactPhone">contactPhone</option>
                            <option value="website">website</option>
                            <option value="address">address</option>
                            <option value="city">city</option>
                            <option value="country">country</option>
                            <option value="category">category (Sector)</option>
                            <option value="discoveryNotes">discoveryNotes</option>
                            <option value="custom">custom (New Column)</option>
                            <option value="ignore">ignore (Skip)</option>
                          </select>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Sample Preview Rows */}
                {preview && preview.sample.length > 0 && (
                  <div className="space-y-1.5 pt-3 border-t border-line">
                    <h4 className="text-xs font-semibold text-ink">Sample Data Preview (First {preview.sample.length} Rows)</h4>
                    <div className="overflow-x-auto rounded-xl border border-line">
                      <table className="w-full border-collapse text-left text-[11px]">
                        <thead>
                          <tr className="bg-sunken border-b border-line text-muted">
                            {table.columns
                              .filter((c) => c.field !== "ignore")
                              .map((c, i) => (
                                <th key={i} className="px-3 py-2 font-medium">
                                  {c.label}
                                </th>
                              ))}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-line bg-white">
                          {preview.sample.map((row, rIdx) => (
                            <tr key={rIdx}>
                              {table.columns
                                .filter((c) => c.field !== "ignore")
                                .map((c, i) => (
                                  <td key={i} className="px-3 py-1.5 break-words max-w-[220px]">
                                    {row[c.label] || "—"}
                                  </td>
                                ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}

      {/* Step 4: Success Result Screen */}
      {committedResult && (
        <Card className="p-10 text-center space-y-4 max-w-lg mx-auto shadow-sm">
          <div className="text-4xl">🎉</div>
          <h2 className="font-display text-2xl font-bold text-ink">Sheet Imported Successfully!</h2>
          <p className="text-xs text-muted leading-relaxed">
            {committedResult.mode === "separate"
              ? `Your spreadsheet has been saved as ${committedResult.groupsCreated} separate lists in your Africon pipeline.`
              : `Your spreadsheet has been saved as a group under the name "${committedResult.groupName}".`}
          </p>

          <div className="grid grid-cols-2 gap-3 py-2">
            <div className="rounded-xl bg-sunken p-3 text-center">
              <span className="text-xs text-muted block">Leads Created</span>
              <strong className="text-xl text-ink font-bold">{committedResult.leadsCreated}</strong>
            </div>
            <div className="rounded-xl bg-sunken p-3 text-center">
              <span className="text-xs text-muted block">Lists Created</span>
              <strong className="text-sm text-ink font-bold truncate block">{committedResult.groupName}</strong>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-2 pt-3">
            <Button
              variant="accent"
              onClick={() => {
                onImportSuccess();
              }}
            >
              View in Leads Pipeline
            </Button>

            <Button
              variant="secondary"
              onClick={() => {
                setLeadsFile(null);
                setTemplateFile(null);
                setPlan(null);
                setPreviews([]);
                setCommittedResult(null);
              }}
            >
              Import Another File
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}

// ============================================================================
// TAB 3: Template Library & Presets View
// ============================================================================
function TemplateLibraryView({ onUseTemplate }: { onUseTemplate: () => void }) {
  const handleDownloadPreset = (preset: (typeof AFRICON_TEMPLATE_PRESETS)[number]) => {
    const csv = [preset.columns.map((c) => c.header).join(","), ...preset.sampleRows].join("\n");
    downloadCsv(preset.fileName, csv);
  };

  return (
    <div className="space-y-6">
      <div className="border-b border-line pb-4">
        <h2 className="font-display text-xl font-bold text-ink">Africon Lead Templates Library</h2>
        <p className="text-xs text-muted">
          Pre-structured spreadsheet templates designed for African business intelligence. Download any template to fill
          out, or upload your own custom template in the Import tab.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
        {AFRICON_TEMPLATE_PRESETS.map((preset) => (
          <Card key={preset.id} className="p-5 flex flex-col justify-between space-y-4">
            <div>
              <div className="flex items-center justify-between">
                <span className="text-2xl">📋</span>
                <span className="rounded-full bg-sunken px-2 py-0.5 text-[10px] font-semibold text-muted">
                  {preset.columns.length} Columns
                </span>
              </div>
              <h3 className="mt-2 font-display text-base font-bold text-ink">{preset.title}</h3>
              <p className="mt-1 text-xs text-muted leading-relaxed">{preset.description}</p>

              <div className="mt-4 space-y-1.5 border-t border-line pt-3">
                <span className="text-[11px] font-semibold text-ink block">Included Fields:</span>
                <div className="flex flex-wrap gap-1">
                  {preset.columns.map((col, idx) => (
                    <span key={idx} className="rounded bg-sunken px-1.5 py-0.5 text-[10px] text-muted">
                      {col.header}
                    </span>
                  ))}
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2 pt-3 border-t border-line">
              <Button
                variant="secondary"
                className="flex-1 text-[11px]"
                onClick={() => handleDownloadPreset(preset)}
              >
                Download CSV
              </Button>
              <Button
                variant="accent"
                className="flex-1 text-[11px]"
                onClick={() => {
                  onUseTemplate();
                }}
              >
                Use Template
              </Button>
            </div>
          </Card>
        ))}
      </div>

      {/* How it Works Banner */}
      <Card className="p-6 bg-sunken/40 space-y-3">
        <h3 className="font-display text-sm font-bold text-ink">How AI Lead Template Structuring Works</h3>
        <p className="text-xs text-muted leading-relaxed">
          1. <strong>Upload Your Leads</strong>: Drop any messy raw leads sheet (Excel or CSV).<br />
          2. <strong>Attach Your Template (Optional)</strong>: Upload your target template with your desired columns and header names.<br />
          3. <strong>Automatic Alignment</strong>: The AI reads both sheets, detects semantic matches (e.g. "Telephone" → "Direct Phone", "Turnover" → "Annual Revenue"), and shapes the output to match your template perfectly.<br />
          4. <strong>Saved as Group Proof</strong>: Every imported file is automatically grouped under that sheet's name.<br />
          5. <strong>Combine into 'Lead List'</strong>: After importing multiple datasets, combine them into one unified list named 'Lead List' whenever you're ready.<br />
          6. <strong>Clean Exports</strong>: Exported spreadsheets contain strictly the sheet's actual columns without server metadata, scores, or statuses.
        </p>
      </Card>
    </div>
  );
}
