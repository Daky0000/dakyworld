import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import type { Client, Demo, DemoStatus, Lead } from "../lib/types";
import { EmailComposer, type ComposerTarget } from "../components/EmailComposer";
import {
  Badge,
  Button,
  Card,
  CopyButton,
  Drawer,
  EmptyState,
  Field,
  Loading,
  Modal,
  PageHeader,
  RelativeTime,
  StatGrid,
  StatTile,
} from "../components/ui";
import { DemoAnalyticsModal } from "../components/DemoAnalyticsModal";
import { BrokenFilesBadge } from "../components/DemoBrokenFiles";
import { IconBarChart, IconClock, IconFlame, IconGlobe, IconMail } from "../components/WebsiteIcons";
import { compileClaudeDynamicTemplate } from "../../../src/shared/templateCompiler";
import { getFilesFromDataTransfer } from "../lib/folderZip";
import {
  type FolderFile,
  MAX_DEMO_FOLDER_BYTES,
  htmlPagesIn,
  localFilesNamedInBrowser,
  pageInZip,
  relativeToFolder,
  zipPageWithFiles,
} from "../lib/demoFolder";

function formatDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return "0s";
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

const STATUS_LABEL: Record<DemoStatus, string> = {
  DRAFT: "Draft",
  READY: "Ready to send",
  SENT: "Link sent",
  ACCEPTED: "Accepted",
  DECLINED: "Declined",
  ARCHIVED: "Archived",
};

const STATUS_TONE: Record<DemoStatus, "default" | "positive" | "muted" | "warn" | "info"> = {
  DRAFT: "muted",
  READY: "info",
  SENT: "default",
  ACCEPTED: "positive",
  DECLINED: "warn",
  ARCHIVED: "muted",
};

const STATUSES: DemoStatus[] = ["DRAFT", "READY", "SENT", "ACCEPTED", "DECLINED", "ARCHIVED"];

function slugifyClient(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function parseHtmlClientMetadata(html: string, fileName?: string) {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const strip = (s?: string) =>
    (s ?? "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  const rawTitle = strip(titleMatch?.[1]);
  const rawH1 = strip(h1Match?.[1]);
  const fromFile = fileName
    ? fileName
        .replace(/\.html?$/i, "")
        .replace(/[-_]+/g, " ")
        .trim()
    : "";

  const firstSegment = rawTitle ? rawTitle.split(/\s+[—–|\-:]\s+/)[0]?.trim() : "";
  const businessName = (firstSegment || rawH1 || fromFile || "Custom Demo").slice(0, 120);
  const title = (rawTitle || rawH1 || `${businessName} — Interactive Demo`).slice(0, 160);
  return { businessName, title, suggestedSlug: slugifyClient(businessName || fromFile || "demo") };
}

async function gunzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream !== "undefined") {
    const ds = new DecompressionStream("gzip");
    const writer = ds.writable.getWriter();
    void writer.write(bytes as any);
    void writer.close();
    const output: Uint8Array[] = [];
    const reader = ds.readable.getReader();
    let totalLen = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        output.push(value as Uint8Array);
        totalLen += value.length;
      }
    }
    const result = new Uint8Array(totalLen);
    let offset = 0;
    for (const chunk of output) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }
  return bytes;
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  const len = bytes.byteLength;
  const chunkSize = 8192;
  for (let i = 0; i < len; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, len));
    binary += String.fromCharCode.apply(null, Array.from(chunk));
  }
  return btoa(binary);
}

export async function unpackClaudeArtifactBundleInBrowser(rawHtml: string): Promise<{ html: string; unpacked: boolean }> {
  if (!rawHtml.includes('type="__bundler/manifest"') || !rawHtml.includes('type="__bundler/template"')) {
    return { html: rawHtml, unpacked: false };
  }

  const manifestMatch = /<script\b[^>]*\btype=["']__bundler\/manifest["'][^>]*>([\s\S]*?)<\/script>/i.exec(rawHtml);
  const templateMatch = /<script\b[^>]*\btype=["']__bundler\/template["'][^>]*>([\s\S]*?)<\/script>/i.exec(rawHtml);
  if (!manifestMatch || !templateMatch) {
    return { html: rawHtml, unpacked: false };
  }

  try {
    const manifest = JSON.parse(manifestMatch[1]);
    let template: string = JSON.parse(templateMatch[1]);

    const extResMatch = /<script\b[^>]*\btype=["']__bundler\/ext_resources["'][^>]*>([\s\S]*?)<\/script>/i.exec(rawHtml);
    const extResources: Array<{ id: string; uuid: string }> = extResMatch ? JSON.parse(extResMatch[1]) : [];

    const assetMap: Record<string, { mime: string; dataUrl: string; text: string | null }> = {};
    for (const [uuid, entry] of Object.entries(manifest as Record<string, { mime: string; data: string; compressed?: boolean }>)) {
      let rawBytes = base64ToUint8Array(entry.data);
      if (entry.compressed) {
        try {
          rawBytes = await gunzipBytes(rawBytes);
        } catch {}
      }
      const b64 = uint8ArrayToBase64(rawBytes);
      const dataUrl = `data:${entry.mime};base64,${b64}`;
      const isText = entry.mime.startsWith("text/") || entry.mime.includes("javascript") || entry.mime.includes("json");
      assetMap[uuid] = {
        mime: entry.mime,
        dataUrl,
        text: isText ? new TextDecoder().decode(rawBytes) : null,
      };
    }

    const resourceMap: Record<string, string> = {};
    for (const entry of extResources) {
      if (assetMap[entry.uuid]) {
        resourceMap[entry.id] = assetMap[entry.uuid].dataUrl;
      }
    }

    const scriptUuids = new Set<string>();
    const headScripts: string[] = [];

    const reactEntry = extResources.find(
      (e) => e.id.includes("react.production") || e.id.endsWith("/react.js") || e.id.includes("react@")
    );
    if (reactEntry && assetMap[reactEntry.uuid]?.text) {
      headScripts.push(`<script>${assetMap[reactEntry.uuid].text}</script>`);
      scriptUuids.add(reactEntry.uuid);
    }

    const reactDomEntry = extResources.find(
      (e) => e.id.includes("react-dom.production") || e.id.endsWith("/react-dom.js") || e.id.includes("react-dom@")
    );
    if (reactDomEntry && assetMap[reactDomEntry.uuid]?.text) {
      headScripts.push(`<script>${assetMap[reactDomEntry.uuid].text}</script>`);
      scriptUuids.add(reactDomEntry.uuid);
    }

    for (const entry of extResources) {
      if (!scriptUuids.has(entry.uuid)) {
        const asset = assetMap[entry.uuid];
        if (asset?.text && (asset.mime.includes("javascript") || entry.id.endsWith(".js"))) {
          headScripts.push(`<script>${asset.text}</script>`);
          scriptUuids.add(entry.uuid);
        }
      }
    }

    // Inline JS scripts directly in place
    template = template.replace(
      /<script\b([^>]*?)\bsrc\s*=\s*["']([0-9a-f-]{36})["']([^>]*?)>\s*<\/script>/gi,
      (match, before, uuid, after) => {
        const asset = assetMap[uuid];
        if (asset?.text) {
          scriptUuids.add(uuid);
          return `<script${before}${after}>${asset.text}</script>`;
        }
        return match;
      }
    );

    // Replace all remaining asset UUIDs in template with data URLs (images, fonts, stylesheets)
    for (const [uuid, asset] of Object.entries(assetMap)) {
      if (!scriptUuids.has(uuid)) {
        template = template.split(uuid).join(asset.dataUrl);
      }
    }

    template = template.replace(/\s+integrity="[^"]*"/gi, "").replace(/\s+crossorigin="[^"]*"/gi, "");

    const resourceScript =
      Object.keys(resourceMap).length > 0
        ? `<script>window.__resources = ${JSON.stringify(resourceMap).replace(/<\//g, "<\\/")};</script>`
        : "";

    const injection = [resourceScript, ...headScripts].filter(Boolean).join("\n");
    if (injection) {
      const headOpen = /<head\b[^>]*>/i.exec(template);
      if (headOpen) {
        const idx = headOpen.index + headOpen[0].length;
        template = template.slice(0, idx) + "\n" + injection + "\n" + template.slice(idx);
      } else if (template.includes("</head>")) {
        template = template.replace("</head>", `${injection}\n</head>`);
      } else {
        template = `${injection}\n${template}`;
      }
    }

    // Compile dynamic templates if present
    template = compileClaudeDynamicTemplate(template);

    return { html: template, unpacked: true };
  } catch (err) {
    console.warn("Client bundle unpacking note:", err);
    return { html: rawHtml, unpacked: false };
  }
}

function isProposalDemo(demo: Demo | null | undefined): boolean {
  if (!demo) return false;
  return Boolean(
    demo.brief?.isProposal ||
    demo.brief?.proposalFormat ||
    demo.title.toLowerCase().includes("proposal") ||
    demo.slug.toLowerCase().includes("proposal") ||
    demo.businessName.toLowerCase().includes("proposal")
  );
}

export function Demos() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [mainTab, setMainTab] = useState<"demos" | "proposals">("demos");
  const [isProposalDrawer, setIsProposalDrawer] = useState(false);
  const [filter, setFilter] = useState<DemoStatus | "">("");
  const [search, setSearch] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingDemo, setEditingDemo] = useState<Demo | null>(null);
  const [composerTarget, setComposerTarget] = useState<ComposerTarget | null>(null);
  const [editingSlugId, setEditingSlugId] = useState<string | null>(null);
  const [slugDraft, setSlugDraft] = useState("");
  const [slugError, setSlugError] = useState<string | null>(null);
  const [openingBuilderId, setOpeningBuilderId] = useState<string | null>(null);
  const [analyticsDemo, setAnalyticsDemo] = useState<Demo | null>(null);
  const [sendToLeadDemo, setSendToLeadDemo] = useState<Demo | null>(null);

  const { data: leadsData } = useQuery({
    queryKey: ["leads-all-brief"],
    queryFn: ({ signal }) => api.get<{ items: Lead[] }>("/leads?take=200", signal),
  });

  const openInWebsiteBuilder = async (demo: Demo, mode: "visual" | "edit" = "visual") => {
    try {
      setOpeningBuilderId(demo.id);
      const res = await api.post<{ pageId: string; siteId: string; editorUrl: string }>(`/demos/${demo.id}/open-editor`);
      navigate(`/website/pages/${res.pageId}?demoId=${demo.id}&mode=${mode}`);
    } catch (err) {
      alert((err as Error).message || "Could not open Website Builder for this demo.");
    } finally {
      setOpeningBuilderId(null);
    }
  };

  const { data, isLoading } = useQuery({
    queryKey: ["demos", filter],
    queryFn: ({ signal }) => api.get<{ demos: Demo[]; base: string }>(`/demos${filter ? `?status=${filter}` : ""}`, signal),
  });

  const update = useMutation({
    mutationFn: ({ id, ...patch }: { id: string; status?: DemoStatus; slug?: string }) =>
      api.patch<Demo>(`/demos/${id}`, patch),
    onSuccess: () => {
      setEditingSlugId(null);
      setSlugError(null);
      void qc.invalidateQueries({ queryKey: ["demos"] });
    },
    onError: (err) => {
      setSlugError((err as Error).message);
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/demos/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["demos"] }),
  });

  const demos = data?.demos ?? [];
  const baseUrl = (data?.base ?? window.location.origin).replace(/\/$/, "");

  const openShareEmail = async (demo: Demo, attachHtml: boolean, overrideLeadId?: string) => {
    const isProposal = isProposalDemo(demo) || mainTab === "proposals";
    let lead = overrideLeadId
      ? (leadsData?.items ?? []).find((l) => l.id === overrideLeadId)
      : (demo.lead ?? (demo.leadId ? (leadsData?.items ?? []).find((l) => l.id === demo.leadId) : null));

    if (overrideLeadId && overrideLeadId !== demo.leadId) {
      try {
        await api.patch(`/demos/${demo.id}`, { leadId: overrideLeadId });
        void qc.invalidateQueries({ queryKey: ["demos"] });
      } catch (err) {
        console.warn("Could not patch leadId on demo:", err);
      }
    }

    const recipientName =
      lead?.contactName ?? demo.lead?.contactName ?? demo.client?.name ?? demo.recipientName ?? demo.businessName;
    const greeting = recipientName && recipientName !== demo.businessName ? `Hi ${recipientName.split(" ")[0]},` : "Hello,";
    const effectiveUrl = (isProposal && demo.url.includes("/demos/"))
      ? demo.url.replace("/demos/", "/proposals/")
      : demo.url;

    const defaultBody = isProposal
      ? `${greeting}\n\nGood day. Following up on our recent communications, I have put together the commercial proposal and scope of work for ${lead?.companyName || demo.businessName}.\n\nYou can review the interactive proposal, scope of work, and investment breakdown at this private link:\n\n${effectiveUrl}\n\nPlease take a look when you have a moment, and let me know if you would like to schedule a brief call to align on timeline and next steps.\n\nBest regards,`
      : (attachHtml
        ? `${greeting}\n\nI have put together an interactive preview for ${demo.businessName}. You can open it directly in your browser at any time using this link:\n\n${effectiveUrl}\n\nI have also attached the standalone HTML file (${demo.slug}.html) to this email in case you would like to keep a copy offline.\n\nLet me know what you think.`
        : `${greeting}\n\nI have put together an interactive preview for ${demo.businessName}. You can explore it live in your browser here:\n\n${effectiveUrl}\n\nTake a look on your phone or desktop when you have a moment, and let me know what you think.`);

    setComposerTarget({
      leadId: lead?.id ?? demo.lead?.id ?? undefined,
      clientId: demo.client?.id ?? undefined,
      toEmail: lead?.contactEmail ?? demo.lead?.contactEmail ?? demo.client?.email ?? demo.recipientEmail ?? undefined,
      toName: recipientName,
      purpose: isProposal ? "PROPOSAL_COVER" : "DEMO_READY",
      initialSubject: isProposal
        ? `${lead?.companyName || demo.businessName} — Commercial Web & Digital Growth Proposal`
        : `${demo.businessName} — interactive website preview`,
      initialBody: defaultBody,
      initialBrief: isProposal
        ? `Send commercial proposal link (${effectiveUrl}) to ${lead?.companyName || demo.businessName}.`
        : `Share the live demo preview link (${effectiveUrl}) for ${demo.businessName}${
            attachHtml ? " and mention that the HTML file is also attached" : ""
          }.`,
      attachments: attachHtml ? [{ kind: "demo", demoId: demo.id, name: `${demo.slug}.html` }] : [],
    });
  };

  // Summary Metrics
  const stats = useMemo(() => {
    let opened = 0;
    let accepted = 0;
    let totalViews = 0;

    const list = demos.filter((d) => (mainTab === "proposals" ? isProposalDemo(d) : !isProposalDemo(d)));

    for (const d of list) {
      if (d.views > 0) opened++;
      if (d.status === "ACCEPTED") accepted++;
      totalViews += d.views;
    }

    const openRate = list.length > 0 ? Math.round((opened / list.length) * 100) : 0;

    return {
      total: list.length,
      opened,
      unopened: list.length - opened,
      accepted,
      totalViews,
      openRate,
    };
  }, [demos, mainTab]);

  // Search filter scoped to active mainTab
  const filtered = useMemo(() => {
    const list = demos.filter((d) => (mainTab === "proposals" ? isProposalDemo(d) : !isProposalDemo(d)));
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (d) =>
        d.businessName.toLowerCase().includes(q) ||
        d.title.toLowerCase().includes(q) ||
        d.slug.toLowerCase().includes(q) ||
        (d.lead?.contactName && d.lead.contactName.toLowerCase().includes(q)) ||
        (d.client?.name && d.client.name.toLowerCase().includes(q)) ||
        (d.recipientEmail && d.recipientEmail.toLowerCase().includes(q)),
    );
  }, [demos, search, mainTab]);

  const totalWebsiteDemosCount = useMemo(() => demos.filter((d) => !isProposalDemo(d)).length, [demos]);
  const totalProposalsCount = useMemo(() => demos.filter((d) => isProposalDemo(d)).length, [demos]);

  return (
    <div className="space-y-6">
      <PageHeader
        title={mainTab === "proposals" ? "Proposals & Pitch Decks" : "Demos & Previews"}
        subtitle={
          mainTab === "proposals"
            ? "Interactive HTML proposals and PDF decks uploaded for prospects. Each gets a dedicated live link with client open detection and section reading heatmaps."
            : "Landing pages built or imported for prospects and clients. Each one lives at a dedicated public URL you can share or attach to an email."
        }
        action={
          mainTab === "proposals" ? (
            <Button
              onClick={() => {
                setEditingDemo(null);
                setIsProposalDrawer(true);
                setDrawerOpen(true);
              }}
            >
              + Import Proposal (HTML or PDF)
            </Button>
          ) : (
            <Button
              onClick={() => {
                setEditingDemo(null);
                setIsProposalDrawer(false);
                setDrawerOpen(true);
              }}
            >
              + Import HTML Demo
            </Button>
          )
        }
      />

      {/* Top-Level Switcher: Website Demos vs Client Proposals */}
      <div className="flex border-b border-line gap-6 text-sm font-semibold">
        <button
          type="button"
          onClick={() => setMainTab("demos")}
          className={`flex items-center gap-2 pb-3.5 transition border-b-2 -mb-px ${
            mainTab === "demos"
              ? "border-blue text-blue font-bold"
              : "border-transparent text-muted hover:text-ink"
          }`}
        >
          <IconGlobe size={16} />
          <span>Website Demos</span>
          <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
            mainTab === "demos" ? "bg-blue/10 text-blue" : "bg-surface text-muted"
          }`}>
            {totalWebsiteDemosCount}
          </span>
        </button>

        <button
          type="button"
          onClick={() => setMainTab("proposals")}
          className={`flex items-center gap-2 pb-3.5 transition border-b-2 -mb-px ${
            mainTab === "proposals"
              ? "border-blue text-blue font-bold"
              : "border-transparent text-muted hover:text-ink"
          }`}
        >
          <IconClock size={16} />
          <span>Proposals</span>
          <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
            mainTab === "proposals" ? "bg-blue text-white" : "bg-surface text-muted"
          }`}>
            {totalProposalsCount}
          </span>
        </button>
      </div>

      {/* Metrics Seam Grid */}
      <StatGrid columns={4}>
        {mainTab === "proposals" ? (
          <>
            <StatTile label="Total Proposals" value={stats.total} sub="Uploaded client proposals &amp; decks" />
            <StatTile label="Opened by Client" value={stats.opened} sub={`${stats.openRate}% proposal view rate`} />
            <StatTile label="Unopened Proposals" value={stats.unopened} sub={stats.unopened > 0 ? "Awaiting client review" : "All sent proposals opened"} />
            <StatTile label="Total Link Opens" value={stats.totalViews} sub="Combined reading interaction count" />
          </>
        ) : (
          <>
            <StatTile label="Total Demos Built" value={stats.total} sub="Unlisted prospect &amp; client previews" />
            <StatTile label="Opened by Recipient" value={stats.opened} sub={`${stats.openRate}% view engagement rate`} />
            <StatTile label="Total Views Recorded" value={stats.totalViews} sub="Live link interaction counts" />
            <StatTile
              label="Accepted"
              value={stats.accepted}
              sub={stats.accepted > 0 ? "Converted to client proposal" : "None converted yet"}
            />
          </>
        )}
      </StatGrid>

      {/* Search and Status Filters */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-4">
        <div className="flex max-w-sm flex-1 items-center gap-2">
          <input
            type="search"
            placeholder="Search by business, slug, client, or contact…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-xl border border-line bg-white px-3.5 py-1.5 text-xs text-ink outline-none transition focus:border-blue focus:ring-2 focus:ring-blue/15"
          />
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => setFilter("")}
            className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
              filter === ""
                ? "bg-ink text-white"
                : "border border-line bg-white text-muted hover:border-ink/40 hover:text-ink"
            }`}
          >
            All Demos
          </button>
          {STATUSES.map((status) => (
            <button
              key={status}
              type="button"
              onClick={() => setFilter(status)}
              className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
                filter === status
                  ? "bg-ink text-white"
                  : "border border-line bg-white text-muted hover:border-ink/40 hover:text-ink"
              }`}
            >
              {STATUS_LABEL[status]}
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <Loading label={mainTab === "proposals" ? "Loading proposals" : "Loading demos"} rows={4} />
      ) : filtered.length === 0 ? (
        <EmptyState
          message={
            (mainTab === "proposals" ? totalProposalsCount : totalWebsiteDemosCount) === 0
              ? mainTab === "proposals"
                ? "No proposals uploaded yet. Upload an HTML proposal or PDF document to generate an interactive client link with open tracking and reading time insights."
                : "Nothing built or imported yet. Import an HTML file to get an instant public URL you can send to a client or attach to an email."
              : "No records match your search criteria."
          }
          action={
            (mainTab === "proposals" ? totalProposalsCount : totalWebsiteDemosCount) === 0 ? (
              <Button
                onClick={() => {
                  setEditingDemo(null);
                  setIsProposalDrawer(mainTab === "proposals");
                  setDrawerOpen(true);
                }}
              >
                {mainTab === "proposals" ? "+ Import Proposal (HTML or PDF)" : "+ Import HTML Demo"}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="space-y-3.5">
          {filtered.map((demo) => {
            const isEditingSlug = editingSlugId === demo.id;
            const isProposal = isProposalDemo(demo);
            const isImported = demo.builtBy === "Imported HTML" || Boolean(demo.brief?.imported);
            const proposalFormat = demo.brief?.proposalFormat || (demo.title.toLowerCase().includes("pdf") ? "pdf" : "html");

            return (
              <Card key={demo.id} interactive className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-display text-base font-medium text-ink">{demo.businessName}</h3>
                      <Badge tone={STATUS_TONE[demo.status]}>{STATUS_LABEL[demo.status]}</Badge>
                      {isProposal ? (
                        <Badge tone="info">{proposalFormat === "pdf" ? "Proposal (PDF)" : "Proposal (HTML)"}</Badge>
                      ) : isImported ? (
                        <Badge tone="info">Imported HTML</Badge>
                      ) : null}
                      {demo.views > 0 ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 border border-emerald-200 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">
                          ✓ Opened {demo.views} time{demo.views > 1 ? "s" : ""}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 border border-amber-200 px-2 py-0.5 text-[11px] font-semibold text-amber-700">
                          ⏳ Not yet opened
                        </span>
                      )}
                      {demo.version > 1 && <Badge tone="muted">v{demo.version}</Badge>}
                    </div>

                    <p className="mt-1 text-xs text-muted">
                      {demo.title}
                      {demo.builtBy && !isImported && (
                        <>
                          {" "}
                          · built by <span className="font-medium text-ink">{demo.builtBy}</span>
                        </>
                      )}
                      {demo.lead && (
                        <>
                          {" · Lead: "}
                          <Link to={`/leads?lead=${demo.lead.id}`} className="text-blue hover:underline">
                            {demo.lead.contactName}
                          </Link>
                        </>
                      )}
                      {demo.client && (
                        <>
                          {" · Client: "}
                          <Link to={`/clients?client=${demo.client.id}`} className="text-blue hover:underline">
                            {demo.client.name}
                          </Link>
                        </>
                      )}
                      {!demo.lead && !demo.client && demo.recipientEmail && (
                        <>
                          {" · For: "}
                          <span className="font-medium text-ink">{demo.recipientEmail}</span>
                        </>
                      )}
                    </p>

                    {/* Public URL & Inline Slug Editor */}
                    <div className="mt-2.5 flex flex-wrap items-center gap-2">
                      {(() => {
                        const isProposalItem = isProposalDemo(demo) || mainTab === "proposals";
                        const pathPrefix = isProposalItem ? "proposals" : "demos";
                        const effectiveUrl = (isProposalItem && demo.url.includes("/demos/"))
                          ? demo.url.replace("/demos/", "/proposals/")
                          : demo.url;

                        if (isEditingSlug) {
                          return (
                            <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-line bg-sunken px-2.5 py-1">
                              <span className="font-mono text-xs text-muted">{baseUrl}/{pathPrefix}/</span>
                              <input
                                type="text"
                                value={slugDraft}
                                onChange={(e) => setSlugDraft(slugifyClient(e.target.value))}
                                className="w-44 rounded border border-line bg-white px-2 py-0.5 font-mono text-xs text-ink outline-none focus:border-blue"
                                placeholder="custom-slug"
                                autoFocus
                              />
                              <Button
                                size="sm"
                                disabled={!slugDraft.trim() || update.isPending}
                                onClick={() => update.mutate({ id: demo.id, slug: slugDraft.trim() })}
                              >
                                {update.isPending ? "Saving…" : "Save URL"}
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => {
                                  setEditingSlugId(null);
                                  setSlugError(null);
                                }}
                              >
                                Cancel
                              </Button>
                              {slugError && <span className="text-xs text-danger-text">{slugError}</span>}
                            </div>
                          );
                        }

                        return (
                          <>
                            <a
                              href={effectiveUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="max-w-md truncate font-mono text-xs text-blue underline-offset-2 hover:underline"
                            >
                              {effectiveUrl}
                            </a>
                            <CopyButton text={effectiveUrl} label={isProposalItem ? "Copy Proposal Link" : "Copy URL"} />
                            <button
                              type="button"
                              onClick={() => {
                                setEditingSlugId(demo.id);
                                setSlugDraft(demo.slug);
                                setSlugError(null);
                              }}
                              className="font-sans text-[11px] uppercase tracking-[.06em] text-muted transition hover:text-ink"
                            >
                              Customize URL
                            </button>
                          </>
                        );
                      })()}
                    </div>
                  </div>

                  <div className="shrink-0 text-right text-xs text-muted">
                    <div className={`font-mono ${demo.views > 0 ? "font-bold text-ink" : "text-muted"}`}>
                      {demo.views > 0 ? `Opened ${demo.views} time${demo.views === 1 ? "" : "s"}` : "Not yet opened"}
                    </div>
                    {demo.analytics && demo.views > 0 && (
                      <div className="mt-1 flex flex-wrap items-center justify-end gap-1.5 text-[11px]">
                        {demo.analytics.topCountry && (
                          <span className="inline-flex items-center gap-1 rounded-md border border-line/60 bg-surface px-1.5 py-0.5 font-medium text-ink">
                            <IconGlobe size={11} className="text-muted" />
                            <span>{demo.analytics.topCountry.name}</span>
                          </span>
                        )}
                        {demo.analytics.avgDurationSeconds > 0 && (
                          <span className="inline-flex items-center gap-1 rounded-md border border-line/60 bg-surface px-1.5 py-0.5 font-mono text-ink">
                            <IconClock size={11} className="text-muted" />
                            <span>{formatDuration(demo.analytics.avgDurationSeconds)}</span>
                          </span>
                        )}
                        {demo.analytics.totalClicks > 0 && (
                          <span className="inline-flex items-center gap-1 rounded-md bg-rose-50 px-1.5 py-0.5 font-bold text-rose-700">
                            <IconFlame size={11} />
                            <span>{demo.analytics.totalClicks} click{demo.analytics.totalClicks === 1 ? "" : "s"}</span>
                          </span>
                        )}
                      </div>
                    )}
                    {demo.lastViewedAt && (
                      <div className="mt-0.5">
                        last viewed <RelativeTime value={demo.lastViewedAt} />
                      </div>
                    )}
                    <BrokenFilesBadge files={demo.analytics?.brokenFiles} onOpen={() => setAnalyticsDemo(demo)} />
                    {demo.sentAt && (
                      <div className="mt-0.5">
                        sent <RelativeTime value={demo.sentAt} />
                      </div>
                    )}
                  </div>
                </div>

                <div className="mt-3.5 flex flex-wrap items-center gap-2 border-t border-line/60 pt-3">
                  {isProposal ? (
                    <>
                      <Button
                        size="sm"
                        variant="primary"
                        onClick={() => {
                          if (demo.lead || demo.leadId) {
                            void openShareEmail(demo, false);
                          } else {
                            setSendToLeadDemo(demo);
                          }
                        }}
                        className="gap-1.5 font-semibold"
                      >
                        <IconMail size={13} />
                        <span>
                          {demo.lead?.companyName || demo.lead?.contactName
                            ? `Send to ${demo.lead.companyName || demo.lead.contactName}`
                            : "Send to Lead"}
                        </span>
                      </Button>

                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => setSendToLeadDemo(demo)}
                        className="gap-1.5"
                      >
                        <span>{demo.lead || demo.leadId ? "Change Lead" : "Link Lead"}</span>
                      </Button>

                      <Button
                        size="sm"
                        variant={demo.views > 0 ? "secondary" : "ghost"}
                        onClick={() => setAnalyticsDemo(demo)}
                        className="gap-1.5 font-semibold"
                      >
                        <IconClock size={13} />
                        <span>Reading Heatmap &amp; Analytics</span>
                        {demo.views > 0 && (
                          <span className="ml-1 rounded-full bg-blue/15 px-1.5 py-0.2 text-[10px] font-bold text-blue">
                            {demo.views}
                          </span>
                        )}
                      </Button>

                      <select
                        value={demo.status}
                        onChange={(event) => update.mutate({ id: demo.id, status: event.target.value as DemoStatus })}
                        className="rounded-full border border-line bg-white px-2.5 py-1 font-sans text-[11px] uppercase tracking-[.06em] text-ink outline-none focus:border-blue"
                      >
                        {STATUSES.map((status) => (
                          <option key={status} value={status}>
                            {STATUS_LABEL[status]}
                          </option>
                        ))}
                      </select>

                      <a
                        href={demo.url.includes("/demos/") ? demo.url.replace("/demos/", "/proposals/") : demo.url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <Button size="sm" variant="secondary">
                          Open Live Proposal
                        </Button>
                      </a>

                      <a
                        href={`/api/demos/${demo.id}/download`}
                        download={`${demo.slug}.${proposalFormat === "pdf" ? "pdf" : "html"}`}
                      >
                        <Button size="sm" variant="secondary">
                          Download {proposalFormat === "pdf" ? ".pdf" : ".html"}
                        </Button>
                      </a>

                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setEditingDemo(demo);
                          setIsProposalDrawer(true);
                          setDrawerOpen(true);
                        }}
                      >
                        Settings / Replace
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button
                        size="sm"
                        variant={demo.views > 0 ? "primary" : "secondary"}
                        onClick={() => setAnalyticsDemo(demo)}
                        className="gap-1.5 font-semibold"
                      >
                        <IconBarChart size={13} />
                        <span>Analytics &amp; Heatmap</span>
                        {demo.views > 0 && (
                          <span className="ml-1 rounded-full bg-black/10 px-1.5 py-0.2 text-[10px] font-bold">
                            {demo.views}
                          </span>
                        )}
                      </Button>

                      <select
                        value={demo.status}
                        onChange={(event) => update.mutate({ id: demo.id, status: event.target.value as DemoStatus })}
                        className="rounded-full border border-line bg-white px-2.5 py-1 font-sans text-[11px] uppercase tracking-[.06em] text-ink outline-none focus:border-blue"
                      >
                        {STATUSES.map((status) => (
                          <option key={status} value={status}>
                            {STATUS_LABEL[status]}
                          </option>
                        ))}
                      </select>

                      <Button
                        size="sm"
                        disabled={openingBuilderId === demo.id}
                        onClick={() => void openInWebsiteBuilder(demo, "visual")}
                      >
                        {openingBuilderId === demo.id ? "Opening Builder…" : "Edit in Website Builder"}
                      </Button>

                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={openingBuilderId === demo.id}
                        onClick={() => void openInWebsiteBuilder(demo, "edit")}
                      >
                        Edit Form Fields
                      </Button>

                      <a href={demo.url} target="_blank" rel="noreferrer">
                        <Button size="sm" variant="secondary">
                          Open Preview
                        </Button>
                      </a>

                      <a href={`/api/demos/${demo.id}/download`} download={`${demo.slug}.html`}>
                        <Button size="sm" variant="secondary">
                          Download .html
                        </Button>
                      </a>

                      <Button size="sm" variant="secondary" onClick={() => void openShareEmail(demo, false)}>
                        Send Link via Email
                      </Button>

                      <Button size="sm" variant="secondary" onClick={() => void openShareEmail(demo, true)}>
                        Attach HTML to Email
                      </Button>

                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setEditingDemo(demo);
                          setIsProposalDrawer(false);
                          setDrawerOpen(true);
                        }}
                      >
                        Replace .html / Settings
                      </Button>
                    </>
                  )}

                  <span className="flex-1" />

                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => {
                      if (confirm(`Delete ${isProposal ? "proposal" : "demo"} for ${demo.businessName}? The link stops working immediately.`)) {
                        remove.mutate(demo.id);
                      }
                    }}
                  >
                    Delete
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <ImportDemoDrawer
        open={drawerOpen}
        editingDemo={editingDemo}
        baseUrl={baseUrl}
        isProposalMode={isProposalDrawer}
        onClose={() => {
          setDrawerOpen(false);
          setEditingDemo(null);
          setIsProposalDrawer(false);
        }}
        onOpenBuilder={(demo) => {
          setDrawerOpen(false);
          setEditingDemo(null);
          void openInWebsiteBuilder(demo, "visual");
        }}
        onShareEmail={(demo, attachHtml, overrideLeadId) => {
          setDrawerOpen(false);
          setEditingDemo(null);
          void openShareEmail(demo, attachHtml, overrideLeadId);
        }}
      />

      <SendProposalToLeadModal
        demo={sendToLeadDemo}
        leads={leadsData?.items ?? []}
        open={Boolean(sendToLeadDemo)}
        onClose={() => setSendToLeadDemo(null)}
        onSend={(demo, leadId) => {
          setSendToLeadDemo(null);
          void openShareEmail(demo, false, leadId);
        }}
      />

      <EmailComposer
        target={composerTarget}
        open={Boolean(composerTarget)}
        onClose={() => setComposerTarget(null)}
      />

      <DemoAnalyticsModal
        demo={analyticsDemo}
        open={Boolean(analyticsDemo)}
        onClose={() => setAnalyticsDemo(null)}
      />
    </div>
  );
}

function SendProposalToLeadModal({
  demo,
  leads,
  open,
  onClose,
  onSend,
}: {
  demo: Demo | null;
  leads: Lead[];
  open: boolean;
  onClose: () => void;
  onSend: (demo: Demo, leadId: string) => void;
}) {
  const [selectedLeadId, setSelectedLeadId] = useState<string>("");

  useEffect(() => {
    if (demo) {
      setSelectedLeadId(demo.leadId || demo.lead?.id || "");
    }
  }, [demo]);

  if (!demo) return null;

  const targetLeadId = selectedLeadId || demo.leadId || demo.lead?.id || "";
  const lead = leads.find((l) => l.id === targetLeadId);
  const fallbackLead = demo.lead;
  const proposalUrl = demo.url.includes("/demos/")
    ? demo.url.replace("/demos/", "/proposals/")
    : demo.url;

  return (
    <Modal open={open} onClose={onClose} title="Send Proposal to a Pipeline Lead">
      <div className="space-y-4">
        <p className="text-xs text-muted leading-relaxed">
          Select a lead from your pipeline to deliver this proposal to. DakyXTech OS will automatically link the lead, generate their tailored cover email, attach the tracked reading link, and record their dwell time per section.
        </p>

        <div className="rounded-xl border border-line bg-surface/50 p-3.5">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">Proposal Document</div>
          <div className="mt-1 font-display text-sm font-semibold text-ink">{demo.businessName}</div>
          <div className="mt-0.5 font-mono text-xs text-blue truncate">{proposalUrl}</div>
        </div>

        <div>
          <label className="block text-xs font-semibold uppercase tracking-wider text-muted mb-1.5">
            Select Recipient Lead
          </label>
          <select
            value={selectedLeadId}
            onChange={(e) => setSelectedLeadId(e.target.value)}
            className="w-full rounded-xl border border-line bg-white px-3.5 py-2.5 text-xs text-ink outline-none transition focus:border-blue focus:ring-2 focus:ring-blue/15"
          >
            <option value="">-- Choose a lead from CRM pipeline --</option>
            {leads.map((l) => (
              <option key={l.id} value={l.id}>
                {l.companyName ? `${l.companyName} (${l.contactName || "No contact"})` : (l.contactName || "Untitled Lead")} {l.contactEmail ? `— ${l.contactEmail}` : ""}
              </option>
            ))}
          </select>
        </div>

        {(lead || fallbackLead) && (
          <div className="rounded-xl border border-blue/20 bg-blue/5 p-3.5 space-y-1.5 text-xs">
            <div className="font-semibold text-ink flex items-center justify-between">
              <span>{lead?.companyName || fallbackLead?.companyName || lead?.contactName || fallbackLead?.contactName}</span>
              {lead?.status && <Badge tone="info">{lead.status}</Badge>}
            </div>
            {(lead?.contactName || fallbackLead?.contactName) && (
              <div className="text-muted">Contact: {lead?.contactName || fallbackLead?.contactName}</div>
            )}
            <div className="text-muted">
              Email: {lead?.contactEmail || fallbackLead?.contactEmail || <span className="italic text-warn-text">No email on file</span>}
            </div>
            {lead?.contactPhone && <div className="text-muted">Phone: {lead.contactPhone}</div>}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 border-t border-line pt-3">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={!selectedLeadId}
            onClick={() => {
              if (selectedLeadId) {
                onSend(demo, selectedLeadId);
              }
            }}
            className="gap-1.5 font-semibold"
          >
            <IconMail size={13} />
            <span>Open Email Composer &amp; Send</span>
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function ImportDemoDrawer({
  open,
  editingDemo,
  baseUrl,
  isProposalMode,
  onClose,
  onOpenBuilder,
  onShareEmail,
}: {
  open: boolean;
  editingDemo: Demo | null;
  baseUrl: string;
  isProposalMode?: boolean;
  onClose: () => void;
  onOpenBuilder: (demo: Demo) => void;
  onShareEmail: (demo: Demo, attachHtml: boolean, overrideLeadId?: string) => void;
}) {
  const qc = useQueryClient();
  const [sourceTab, setSourceTab] = useState<"file" | "paste">("file");
  const [dragging, setDragging] = useState(false);
  const [isPdf, setIsPdf] = useState(false);
  const [fileName, setFileName] = useState<string>("");
  const [fileSize, setFileSize] = useState<number | null>(null);
  const [dataBase64, setDataBase64] = useState<string>("");
  const [rawHtml, setRawHtml] = useState<string>("");
  // A folder (zipped here) or a ZIP brings the page's pictures with it.
  const [folder, setFolder] = useState<{ name: string; files: FolderFile[]; pages: string[] } | null>(null);
  const [entry, setEntry] = useState<string | null>(null);
  const [folderPage, setFolderPage] = useState<string | null>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const [packageNote, setPackageNote] = useState<string | null>(null);
  const [packaging, setPackaging] = useState(false);
  // Files a lone HTML file names beside it, which it cannot bring.
  const [localFiles, setLocalFiles] = useState<string[]>([]);

  const [businessName, setBusinessName] = useState("");
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);

  const [linkKind, setLinkKind] = useState<"none" | "client" | "lead" | "email">("none");
  const [clientId, setClientId] = useState("");
  const [leadId, setLeadId] = useState("");
  const [recipientEmail, setRecipientEmail] = useState("");
  const [recipientName, setRecipientName] = useState("");

  const [includeBanner, setIncludeBanner] = useState(false);
  const [makeFormsInert, setMakeFormsInert] = useState(true);
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [savedDemo, setSavedDemo] = useState<Demo | null>(null);
  const [postImportLeadId, setPostImportLeadId] = useState<string>("");

  const { data: clients } = useQuery({
    queryKey: ["clients"],
    queryFn: ({ signal }) => api.get<Client[]>("/clients", signal),
    enabled: open && linkKind === "client",
  });

  const { data: leadsData } = useQuery({
    queryKey: ["leads-all-brief"],
    queryFn: ({ signal }) => api.get<{ items: Lead[] }>("/leads?take=200", signal),
    enabled: open,
  });

  useEffect(() => {
    if (!open) return;
    setError(null);
    setSavedDemo(null);
    setFileName("");
    setFileSize(null);
    setDataBase64("");
    setRawHtml("");
    setSourceTab("file");
    setFolder(null);
    setEntry(null);
    setFolderPage(null);
    setPackageNote(null);
    setLocalFiles([]);

    if (editingDemo) {
      setPostImportLeadId(editingDemo.lead?.id || editingDemo.leadId || "");
      setBusinessName(editingDemo.businessName);
      setTitle(editingDemo.title);
      setSlug(editingDemo.slug);
      setSlugTouched(true);
      if (editingDemo.client?.id) {
        setLinkKind("client");
        setClientId(editingDemo.client.id);
      } else if (editingDemo.lead?.id) {
        setLinkKind("lead");
        setLeadId(editingDemo.lead.id);
      } else if (editingDemo.recipientEmail) {
        setLinkKind("email");
        setRecipientEmail(editingDemo.recipientEmail);
        setRecipientName(editingDemo.recipientName ?? "");
      } else {
        setLinkKind("none");
      }
      setIncludeBanner(Boolean(editingDemo.brief?.includeBanner));
      setNotes(editingDemo.brief?.notes ?? "");
      void api
        .get<{ html?: string }>(`/demos/${editingDemo.id}`)
        .then((res) => {
          if (res.html) setRawHtml(res.html);
        })
        .catch(() => undefined);
    } else {
      setPostImportLeadId("");
      setBusinessName("");
      setTitle("");
      setSlug("");
      setSlugTouched(false);
      setLinkKind("none");
      setClientId("");
      setLeadId("");
      setRecipientEmail("");
      setRecipientName("");
      setIncludeBanner(false);
      setMakeFormsInert(true);
      setNotes("");
    }
  }, [open, editingDemo]);

  const fillFromPage = (html: string, name: string) => {
    const meta = parseHtmlClientMetadata(html, name);
    if (!businessName.trim()) setBusinessName(meta.businessName);
    if (!title.trim()) setTitle(meta.title);
    if (!slugTouched && !slug.trim()) setSlug(meta.suggestedSlug);
  };

  /** Zips one page of a chosen folder with the files it uses. */
  const packFolderPage = async (chosen: { name: string; files: FolderFile[] }, page: string) => {
    setPackaging(true);
    setError(null);
    try {
      const zipped = await zipPageWithFiles(chosen.files, page, chosen.name);
      setDataBase64(zipped.base64);
      setFileName(zipped.filename);
      setFileSize(zipped.totalBytes);
      setEntry(zipped.entry);
      setFolderPage(page);
      setPackageNote(`${page} and the ${zipped.fileCount - 1} file${zipped.fileCount === 2 ? "" : "s"} it uses`);
      fillFromPage(zipped.html, page);
    } catch (err) {
      setDataBase64("");
      setError((err as Error).message);
    } finally {
      setPackaging(false);
    }
  };

  /** `prefer` is the lone file picked before, so its folder opens on that page. */
  const handleFolder = async (entries: FolderFile[], name: string, prefer?: string) => {
    setError(null);
    setLocalFiles([]);
    const files = relativeToFolder(entries);
    const pages = htmlPagesIn(files);
    if (!pages.length) {
      setError("That folder has no .html page in it.");
      return;
    }
    const chosen = { name, files, pages };
    setFolder(chosen);
    const preferred = prefer
      ? pages.find((page) => page === prefer) ?? pages.find((page) => page.split("/").pop() === prefer)
      : undefined;
    await packFolderPage(chosen, preferred ?? pages[0]!);
  };

  const handleZip = async (file: File) => {
    if (file.size > MAX_DEMO_FOLDER_BYTES) {
      setError(`That ZIP is ${(file.size / 1024 / 1024).toFixed(0)} MB; the limit is 2 GB.`);
      return;
    }
    setPackaging(true);
    try {
      const page = await pageInZip(file);
      if (!page) throw new Error("That ZIP has no .html page in it.");
      const b64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("Could not read file."));
        reader.onload = () => resolve(String(reader.result));
        reader.readAsDataURL(file);
      });
      setFolder(null);
      setLocalFiles([]);
      setEntry(page.path);
      setFileName(file.name);
      setFileSize(file.size);
      setDataBase64(b64);
      setPackageNote(page.pages > 1 ? `${page.path} is the demo; ${page.pages - 1} other page${page.pages === 2 ? " is" : "s are"} left out` : page.path);
      fillFromPage(page.html, page.path);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPackaging(false);
    }
  };

  const handleFile = async (file: File) => {
    setError(null);
    if (/\.zip$/i.test(file.name) || file.type === "application/zip" || file.type === "application/x-zip-compressed") {
      setIsPdf(false);
      await handleZip(file);
      return;
    }
    if (/\.pdf$/i.test(file.name) || file.type === "application/pdf") {
      if (file.size > 30 * 1024 * 1024) {
        setError("PDF document exceeds the 30 MB limit.");
        return;
      }
      setFolder(null);
      setEntry(null);
      setPackageNote(null);
      setPackaging(true);
      try {
        const b64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onerror = () => reject(new Error("Could not read PDF file."));
          reader.onload = () => resolve(String(reader.result));
          reader.readAsDataURL(file);
        });

        const safeName = file.name.replace(/\.pdf$/i, "").replace(/[-_]/g, " ");
        const pdfViewerHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${safeName} | Proposal</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@500;600;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: #091428;
    color: #F8FAFC;
    font-family: 'Inter', system-ui, -apple-system, sans-serif;
    min-height: 100vh;
    padding-bottom: 60px;
  }
  .pdf-toolbar {
    position: sticky;
    top: 0;
    z-index: 100;
    background: rgba(9, 24, 51, 0.95);
    backdrop-filter: blur(12px);
    border-bottom: 1px solid rgba(143, 178, 255, 0.2);
    padding: 10px 20px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
  }
  .pdf-brand {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .pdf-brand .logo {
    font-family: 'Outfit', sans-serif;
    font-weight: 700;
    font-size: 15px;
    color: #FFFFFF;
  }
  .pdf-brand .badge {
    background: rgba(37, 99, 235, 0.2);
    border: 1px solid rgba(37, 99, 235, 0.4);
    color: #8FB2FF;
    font-size: 11px;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 9999px;
  }
  .pdf-actions {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .page-nav-select {
    background: #0F1B2E;
    border: 1px solid rgba(143, 178, 255, 0.25);
    color: #FFFFFF;
    font-size: 12px;
    padding: 6px 12px;
    border-radius: 6px;
    outline: none;
    cursor: pointer;
  }
  .download-btn {
    background: #2563EB;
    color: #FFFFFF;
    font-size: 12px;
    font-weight: 600;
    padding: 6px 14px;
    border-radius: 6px;
    text-decoration: none;
    transition: background 0.15s;
    white-space: nowrap;
  }
  .download-btn:hover { background: #1D4ED8; }
  .pdf-pages-container {
    max-width: 880px;
    margin: 24px auto;
    padding: 0 16px;
    display: flex;
    flex-direction: column;
    gap: 24px;
  }
  .pdf-page-section {
    background: #FFFFFF;
    border-radius: 10px;
    overflow: hidden;
    box-shadow: 0 10px 30px rgba(0,0,0,0.4);
    border: 1px solid rgba(255, 255, 255, 0.1);
  }
  .pdf-page-header {
    background: #0F172A;
    color: #94A3B8;
    padding: 8px 16px;
    font-size: 11px;
    font-weight: 600;
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-bottom: 1px solid #1E293B;
  }
  .pdf-page-canvas-wrapper {
    display: flex;
    justify-content: center;
    background: #525659;
    padding: 8px;
  }
  canvas {
    max-width: 100%;
    height: auto !important;
    display: block;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
  }
  .fallback-iframe {
    width: 100%;
    height: 85vh;
    border: none;
    border-radius: 10px;
  }
</style>
</head>
<body>
  <header class="pdf-toolbar">
    <div class="pdf-brand">
      <span class="logo">DakyXTech</span>
      <span class="badge">Proposal Document</span>
      <span style="font-size: 12px; color: #CBD5E1; font-weight: 500;">${safeName}</span>
    </div>
    <div class="pdf-actions">
      <select id="page-jump-select" class="page-nav-select" onchange="var el = document.getElementById(this.value); if(el) el.scrollIntoView({behavior:'smooth'});">
        <option value="">Jump to page…</option>
      </select>
      <a href="${b64}" download="${file.name}" class="download-btn">⬇ Download PDF</a>
    </div>
  </header>

  <main class="pdf-pages-container" id="pdf-pages-container">
    <div id="pdf-loading" style="text-align: center; padding: 48px; color: #94A3B8; font-size: 13px;">
      Rendering proposal pages…
    </div>
  </main>

  <script>
    (async function initPdfRenderer() {
      var container = document.getElementById("pdf-pages-container");
      var select = document.getElementById("page-jump-select");
      var rawData = "${b64}";
      try {
        if (!window.pdfjsLib) throw new Error("No PDF.js");
        pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
        var b64Payload = rawData.indexOf(",") > -1 ? rawData.split(",")[1] : rawData;
        var binary = atob(b64Payload);
        var bytes = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        var doc = await pdfjsLib.getDocument({ data: bytes }).promise;
        container.innerHTML = "";
        for (var p = 1; p <= doc.numPages; p++) {
          var page = await doc.getPage(p);
          var vp = page.getViewport({ scale: 1.5 });
          var sec = document.createElement("section");
          sec.className = "pdf-page-section";
          sec.id = "page-" + p;
          sec.setAttribute("data-section-id", "page-" + p);
          sec.setAttribute("data-section-title", "Page " + p + " of " + doc.numPages);
          var hdr = document.createElement("div");
          hdr.className = "pdf-page-header";
          hdr.innerHTML = "<span>📄 Page " + p + " of " + doc.numPages + "</span><span style='font-size:10px;color:#64748B;'>Scroll to read</span>";
          var wrap = document.createElement("div");
          wrap.className = "pdf-page-canvas-wrapper";
          var canvas = document.createElement("canvas");
          canvas.height = vp.height;
          canvas.width = vp.width;
          wrap.appendChild(canvas);
          sec.appendChild(hdr);
          sec.appendChild(wrap);
          container.appendChild(sec);
          await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
          var opt = document.createElement("option");
          opt.value = "page-" + p;
          opt.textContent = "Page " + p + " of " + doc.numPages;
          select.appendChild(opt);
        }
      } catch (err) {
        container.innerHTML = '<iframe class="fallback-iframe" src="' + rawData + '#toolbar=1" title="${safeName}"></iframe>';
      }
    })();
  </script>
</body>
</html>`;

        const encoded = encodeURIComponent(pdfViewerHtml);
        const resolvedB64 = `data:text/html;charset=utf-8;base64,${btoa(unescape(encoded))}`;

        setIsPdf(true);
        setFileName(file.name);
        setFileSize(file.size);
        setDataBase64(resolvedB64);
        setLocalFiles([]);
        if (!businessName.trim()) setBusinessName(safeName);
        if (!title.trim()) setTitle(`${safeName} Proposal`);
        if (!slugTouched && !slug.trim()) setSlug(slugifyClient(safeName));
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setPackaging(false);
      }
      return;
    }

    setIsPdf(false);
    if (!/\.html?$/i.test(file.name) && file.type && !file.type.includes("html") && !file.type.includes("text")) {
      setError("Please select an .html, .htm, or .pdf file, a ZIP, or the page's folder.");
      return;
    }
    setFolder(null);
    setEntry(null);
    setPackageNote(null);
    if (file.size > 10 * 1024 * 1024) {
      setError("HTML file exceeds the 10 MB limit.");
      return;
    }

    try {
      const [b64, text] = await Promise.all([
        new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onerror = () => reject(new Error("Could not read file."));
          reader.onload = () => resolve(String(reader.result));
          reader.readAsDataURL(file);
        }),
        new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onerror = () => reject(new Error("Could not read file text."));
          reader.onload = () => resolve(String(reader.result));
          reader.readAsText(file);
        }),
      ]);

      let resolvedText = text;
      let resolvedB64 = b64;
      try {
        const unpacked = await unpackClaudeArtifactBundleInBrowser(text);
        if (unpacked.unpacked) {
          resolvedText = unpacked.html;
          const encoded = encodeURIComponent(resolvedText);
          resolvedB64 = `data:text/html;charset=utf-8;base64,${btoa(unescape(encoded))}`;
        }
      } catch (e) {
        console.warn("Client bundle unpacking note:", e);
      }

      setFileName(file.name);
      setFileSize(file.size);
      setDataBase64(resolvedB64);
      setLocalFiles(localFilesNamedInBrowser(resolvedText));
      fillFromPage(resolvedText, file.name);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const saveMutation = useMutation({
    mutationFn: async () => {
      setError(null);
      const payload: Record<string, unknown> = {
        businessName: businessName.trim() || undefined,
        title: title.trim() || undefined,
        slug: slug.trim() || undefined,
        leadId: linkKind === "lead" && leadId ? leadId : null,
        clientId: linkKind === "client" && clientId ? clientId : null,
        recipientEmail: linkKind === "email" && recipientEmail.trim() ? recipientEmail.trim() : null,
        recipientName: linkKind === "email" && recipientName.trim() ? recipientName.trim() : null,
        includeBanner,
        makeFormsInert,
        notes: notes.trim() || null,
      };

      if (isProposalMode || isPdf || isProposalDemo(editingDemo)) {
        payload.isProposal = true;
        payload.proposalFormat = isPdf ? "pdf" : "html";
      }

      if (sourceTab === "file" && dataBase64) {
        payload.fileName = fileName;
        payload.filename = fileName;
        payload.dataBase64 = dataBase64;
        if (entry) payload.entry = entry;
      } else if (sourceTab === "paste" && rawHtml.trim()) {
        payload.html = rawHtml.trim();
      } else if (!editingDemo) {
        throw new Error("Please upload an .html or .pdf file or paste HTML markup first.");
      }

      if (editingDemo) {
        return api.patch<Demo>(`/demos/${editingDemo.id}`, payload);
      }
      return api.post<Demo>("/demos/import", {
        ...payload,
        status: "READY",
      });
    },
    onSuccess: (demo) => {
      setSavedDemo(demo);
      setPostImportLeadId(leadId || (demo as any).leadId || "");
      void qc.invalidateQueries({ queryKey: ["demos"] });
    },
    onError: (err) => {
      setError((err as Error).message);
    },
  });

  const previewSlug = slugifyClient(slug || businessName || "your-demo-name") || "your-demo-name";
  const isProposalItem = isProposalMode || isPdf || (editingDemo && isProposalDemo(editingDemo));
  const previewUrl = `${baseUrl}/${isProposalItem ? "proposals" : "demos"}/${previewSlug}`;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={
        isProposalMode
          ? editingDemo
            ? `Update Proposal — ${editingDemo.businessName}`
            : "Import Proposal or Pitch Deck (HTML or PDF)"
          : editingDemo
            ? `Update Demo — ${editingDemo.businessName}`
            : "Import HTML File as Demo"
      }
      subtitle={
        isProposalMode
          ? "Upload an interactive HTML proposal or PDF presentation. Each proposal gets a dedicated hosted link with open tracking and reading time heatmaps."
          : editingDemo
            ? "Upload a new version (the page's folder brings its pictures) or adjust its public URL and recipient settings."
            : "Turn an .html page, or its whole folder with the pictures, into a hosted public demo URL you can send to a client or attach to an email."
      }
    >
      {savedDemo ? (
        <div className="space-y-5">
          <div className="rounded-2xl border border-info-line bg-info-surface p-5">
            <div className="mb-1 flex items-center gap-2">
              <Badge tone="positive">Live &amp; Ready</Badge>
              <span className="font-sans text-[11px] uppercase tracking-[.06em] text-muted">
                {editingDemo ? `Updated to v${savedDemo.version}` : isProposalItem ? "Proposal Imported" : "Public Demo Created"}
              </span>
            </div>
            <h3 className="mt-2 font-display text-lg font-medium text-ink">{savedDemo.businessName}</h3>
            <p className="text-xs text-muted">{savedDemo.title}</p>
            {/* What the import changed or could not bring: forms made inert, and
                files the page names that were never uploaded with it. */}
            {(savedDemo as Demo & { notes?: string[] }).notes?.length ? (
              <ul role="status" className="mt-3 list-disc space-y-1 rounded-xl border border-warn-line bg-warn-surface py-2 pl-7 pr-3 text-xs text-warn-text">
                {(savedDemo as Demo & { notes?: string[] }).notes!.map((note) => <li key={note}>{note}</li>)}
              </ul>
            ) : null}

            <div className="mt-4 rounded-xl border border-line bg-white p-3">
              <div className="font-sans text-[10px] uppercase tracking-[.06em] text-muted">
                {isProposalItem ? "Shareable Proposal URL" : "Shareable Public URL"}
              </div>
              <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
                <a
                  href={isProposalItem && savedDemo.url.includes("/demos/") ? savedDemo.url.replace("/demos/", "/proposals/") : savedDemo.url}
                  target="_blank"
                  rel="noreferrer"
                  className="break-all font-mono text-xs font-medium text-blue underline underline-offset-2"
                >
                  {isProposalItem && savedDemo.url.includes("/demos/") ? savedDemo.url.replace("/demos/", "/proposals/") : savedDemo.url}
                </a>
                <CopyButton
                  text={isProposalItem && savedDemo.url.includes("/demos/") ? savedDemo.url.replace("/demos/", "/proposals/") : savedDemo.url}
                  label="Copy URL"
                />
              </div>
            </div>

            {/* Direct Send to Lead Dispatch */}
            <div className="mt-4 rounded-xl border border-blue/40 bg-blue/5 p-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-sans text-xs font-bold uppercase tracking-[.06em] text-blue">
                      Send to a Pipeline Lead
                    </span>
                    <Badge tone="info">CRM Dispatch</Badge>
                  </div>
                  <p className="mt-1 text-xs text-muted">
                    Pick a lead from your pipeline CRM to link this {isProposalItem ? "proposal" : "demo"} and immediately compose an email with the tracked link.
                  </p>
                </div>
              </div>

              <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
                <select
                  value={postImportLeadId}
                  onChange={(e) => setPostImportLeadId(e.target.value)}
                  className="flex-1 rounded-lg border border-line bg-white px-3 py-2 text-xs font-medium text-ink outline-none focus:border-blue"
                >
                  <option value="">-- Choose Lead from Pipeline CRM --</option>
                  {(leadsData?.items ?? []).map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.companyName ? `${l.companyName} (${l.contactName || "No contact"})` : (l.contactName || "Untitled Lead")} {l.contactEmail ? `— ${l.contactEmail}` : ""}
                    </option>
                  ))}
                </select>

                <Button
                  variant="primary"
                  className="gap-1.5 whitespace-nowrap"
                  disabled={!postImportLeadId && !savedDemo.leadId}
                  onClick={() => {
                    const chosen = postImportLeadId || savedDemo.leadId || undefined;
                    onShareEmail(savedDemo, false, chosen);
                  }}
                >
                  <IconMail size={14} />
                  <span>Send Proposal to Lead</span>
                </Button>
              </div>

              {postImportLeadId && (() => {
                const chosenLead = (leadsData?.items ?? []).find((l) => l.id === postImportLeadId);
                if (!chosenLead) return null;
                return (
                  <div className="mt-2.5 flex flex-wrap items-center gap-3 rounded-lg bg-white/80 px-3 py-1.5 text-[11px] text-ink border border-line/50">
                    <span><strong>Recipient:</strong> {chosenLead.companyName || chosenLead.contactName}</span>
                    {chosenLead.contactEmail && <span><strong>Email:</strong> {chosenLead.contactEmail}</span>}
                    {chosenLead.status && <Badge tone="info">{chosenLead.status}</Badge>}
                  </div>
                );
              })()}
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              {isProposalItem ? (
                <>
                  <a
                    href={savedDemo.url.includes("/demos/") ? savedDemo.url.replace("/demos/", "/proposals/") : savedDemo.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <Button variant="secondary">Open Live Proposal</Button>
                  </a>
                  <a href={`/api/demos/${savedDemo.id}/download`} download={`${savedDemo.slug}.${isPdf ? "pdf" : "html"}`}>
                    <Button variant="secondary">Download {isPdf ? ".pdf" : ".html"}</Button>
                  </a>
                  <Button variant="secondary" onClick={() => onShareEmail(savedDemo, false, postImportLeadId || savedDemo.leadId || undefined)}>
                    Compose Email
                  </Button>
                </>
              ) : (
                <>
                  <Button onClick={() => onOpenBuilder(savedDemo)}>Edit in Website Builder</Button>
                  <a href={savedDemo.url} target="_blank" rel="noreferrer">
                    <Button variant="secondary">Open Live Preview</Button>
                  </a>
                  <a href={`/api/demos/${savedDemo.id}/download`} download={`${savedDemo.slug}.html`}>
                    <Button variant="secondary">Download .html</Button>
                  </a>
                  <Button variant="secondary" onClick={() => onShareEmail(savedDemo, false, postImportLeadId || savedDemo.leadId || undefined)}>
                    Send URL via Email
                  </Button>
                  <Button variant="secondary" onClick={() => onShareEmail(savedDemo, true, postImportLeadId || savedDemo.leadId || undefined)}>
                    Attach .html File to Email
                  </Button>
                </>
              )}
            </div>
          </div>

          <div className="flex justify-end gap-2 border-t border-line pt-4">
            <Button
              variant="ghost"
              onClick={() => {
                setSavedDemo(null);
              }}
            >
              Make Another Edit
            </Button>
            <Button onClick={onClose}>Done</Button>
          </div>
        </div>
      ) : (
        <div className="space-y-5">
          {/* Source Toggle: Upload .html File vs Paste HTML */}
          <div className="flex gap-2 border-b border-line pb-3">
            <button
              type="button"
              onClick={() => setSourceTab("file")}
              className={`rounded-full px-3.5 py-1 text-xs font-semibold transition ${
                sourceTab === "file"
                  ? "bg-ink text-white"
                  : "border border-line bg-white text-muted hover:border-ink/40 hover:text-ink"
              }`}
            >
              Upload .html File
            </button>
            <button
              type="button"
              onClick={() => setSourceTab("paste")}
              className={`rounded-full px-3.5 py-1 text-xs font-semibold transition ${
                sourceTab === "paste"
                  ? "bg-ink text-white"
                  : "border border-line bg-white text-muted hover:border-ink/40 hover:text-ink"
              }`}
            >
              Paste HTML Code
            </button>
          </div>

          {sourceTab === "file" ? (
            <div>
              <label
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragging(false);
                  const dropped = e.dataTransfer.items?.[0]?.webkitGetAsEntry?.();
                  if (dropped?.isDirectory) {
                    const name = dropped.name;
                    setPackaging(true);
                    void getFilesFromDataTransfer(e.dataTransfer.items)
                      .then((entries) => handleFolder(entries, name))
                      .catch((err) => setError((err as Error).message))
                      .finally(() => setPackaging(false));
                    return;
                  }
                  const file = e.dataTransfer.files?.[0];
                  if (file) void handleFile(file);
                }}
                className={`flex cursor-pointer flex-col items-center justify-center rounded-2xl border border-dashed px-4 py-7 text-center transition ${
                  dragging
                    ? "border-blue bg-blue/[.06] text-ink"
                    : fileName
                      ? "border-info-line bg-info-surface text-ink"
                      : "border-line-strong bg-white text-muted hover:border-ink/40 hover:text-ink"
                }`}
              >
                <input
                  type="file"
                  accept={isProposalMode ? ".html,.htm,.pdf,.zip,text/html,application/pdf,application/zip" : ".html,.htm,.zip,text/html,application/zip"}
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void handleFile(file);
                    e.target.value = "";
                  }}
                />
                {packaging ? (
                  <span className="text-sm font-medium text-ink">Processing document…</span>
                ) : fileName ? (
                  <>
                    <Badge tone="positive">{isPdf ? "Selected PDF Proposal" : packageNote ? "Selected Page and Files" : "Selected File"}</Badge>
                    <span className="mt-2 font-mono text-sm font-medium text-ink">{packageNote ?? fileName}</span>
                    {fileSize !== null && (
                      <span className="mt-0.5 text-xs text-muted">
                        {fileSize >= 1024 * 1024 ? `${(fileSize / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(fileSize / 1024))} KB`}
                      </span>
                    )}
                    <span className="mt-2 text-xs text-blue underline">Click or drop another file, PDF or folder to replace</span>
                  </>
                ) : (
                  <>
                    <span className="text-sm font-medium text-ink">
                      {isProposalMode ? "Drop an HTML or PDF proposal here, or " : "Drop the page's folder, a ZIP or an .html file here, or "}
                      <span className="text-blue underline underline-offset-2">browse</span>
                    </span>
                    <span className="mt-1 text-xs text-muted">
                      {isProposalMode
                        ? "Supports responsive HTML proposals with section tracking, pitch decks, and PDF documents"
                        : "A page whose pictures sit beside it (images/…) needs its folder or a ZIP, or they show broken"}
                    </span>
                  </>
                )}
              </label>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                <label className="cursor-pointer rounded-lg border border-line bg-white px-3 py-1.5 font-medium text-ink hover:border-ink/40">
                  Choose the page's folder
                  <input
                    ref={folderInput}
                    type="file"
                    className="hidden"
                    {...({ webkitdirectory: "", directory: "", multiple: true } as Record<string, string | boolean>)}
                    onChange={(e) => {
                      const list = Array.from(e.target.files ?? []);
                      e.target.value = "";
                      if (!list.length) return;
                      const entries = list.map((file) => ({ file, path: file.webkitRelativePath || file.name }));
                      void handleFolder(entries, entries[0]!.path.split("/")[0] || "demo", localFiles.length ? fileName : undefined);
                    }}
                  />
                </label>
                {folder && folder.pages.length > 1 && (
                  <label className="flex items-center gap-1.5 text-muted">
                    Page
                    <select
                      className="input py-1 text-xs"
                      value={folderPage ?? folder.pages[0]}
                      disabled={packaging}
                      onChange={(e) => void packFolderPage(folder, e.target.value)}
                    >
                      {folder.pages.map((page) => (
                        <option key={page} value={page}>{page}</option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
              {localFiles.length > 0 && (
                <div role="alert" className="mt-2 rounded-xl border border-warn-line bg-warn-surface p-3 text-xs text-warn-text">
                  <p className="font-semibold">
                    {localFiles.length === 1 ? "1 picture" : `${localFiles.length} pictures`} will be broken if you import only this file.
                  </p>
                  <p className="mt-1">
                    {fileName} shows {localFiles.slice(0, 2).join(", ")}
                    {localFiles.length > 2 ? ` and ${localFiles.length - 2} more` : ""} from the folder it sits in. A browser
                    never lets a website read the files beside one you pick, so choose that folder and they come with it.
                    Your browser will ask whether to upload the folder: say Upload.
                  </p>
                  <Button className="mt-2" onClick={() => folderInput.current?.click()}>
                    Choose the folder {fileName} is in
                  </Button>
                </div>
              )}
            </div>
          ) : (
            <Field label="Raw HTML Markup" hint="Paste a complete <!DOCTYPE html> document or HTML snippet." full>
              <textarea
                rows={8}
                className="input font-mono text-xs"
                placeholder="<!DOCTYPE html><html>..."
                value={rawHtml}
                onChange={async (e) => {
                  const val = e.target.value;
                  setRawHtml(val);
                  if (val.trim().length > 20) {
                    let textToParse = val;
                    if (val.includes('type="__bundler/manifest"')) {
                      try {
                        const unpacked = await unpackClaudeArtifactBundleInBrowser(val);
                        if (unpacked.unpacked) {
                          textToParse = unpacked.html;
                          setRawHtml(unpacked.html);
                        }
                      } catch (err) {
                        console.warn("Client unpack note:", err);
                      }
                    }
                    const meta = parseHtmlClientMetadata(textToParse);
                    if (!businessName.trim()) setBusinessName(meta.businessName);
                    if (!title.trim()) setTitle(meta.title);
                    if (!slugTouched && !slug.trim()) setSlug(meta.suggestedSlug);
                  }
                }}
              />
            </Field>
          )}

          {/* Business Name, Page Title, and Custom Public URL Slug */}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Business or Project Name" hint="Auto-extracted from HTML if left blank">
              <input
                className="input"
                placeholder="e.g. Accra Dental Centre"
                value={businessName}
                onChange={(e) => {
                  const val = e.target.value;
                  setBusinessName(val);
                  if (!slugTouched) setSlug(slugifyClient(val));
                }}
              />
            </Field>

            <Field label="Demo Title" hint="Shown in browser tab and demo list">
              <input
                className="input"
                placeholder="e.g. Accra Dental Centre — Interactive Concept"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </Field>
          </div>

          <Field
            label="Custom Public URL Slug"
            hint={`Your live shareable URL will be: ${previewUrl}`}
            full
          >
            <div className="flex items-center gap-2">
              <span className="shrink-0 rounded-xl border border-line bg-sunken px-3 py-2 font-mono text-xs text-muted">
                {baseUrl}/{isProposalMode || isPdf ? "proposals" : "demos"}/
              </span>
              <input
                className="input font-mono text-xs"
                placeholder="accra-dental-centre"
                value={slug}
                onChange={(e) => {
                  setSlugTouched(true);
                  setSlug(slugifyClient(e.target.value));
                }}
              />
            </div>
          </Field>

          {/* Optional Recipient Linking */}
          <div className="rounded-2xl border border-line bg-white p-4">
            <div className="mb-2 font-sans text-[11px] uppercase tracking-[.06em] text-muted">
              Who is this demo for? (Optional)
            </div>
            <div className="mb-3 flex flex-wrap gap-1.5">
              {(
                [
                  { key: "none", label: "General / Shareable Link" },
                  { key: "client", label: "Existing Client" },
                  { key: "lead", label: "Pipeline Lead" },
                  { key: "email", label: "Direct Email Address" },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.key}
                  type="button"
                  onClick={() => setLinkKind(opt.key)}
                  className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                    linkKind === opt.key
                      ? "bg-ink text-white"
                      : "border border-line bg-sunken text-muted hover:text-ink"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            {linkKind === "client" && (
              <Field label="Select Client" full>
                <select
                  className="input"
                  value={clientId}
                  onChange={(e) => {
                    const id = e.target.value;
                    setClientId(id);
                    const picked = (clients ?? []).find((c) => c.id === id);
                    if (picked && !businessName.trim()) {
                      setBusinessName(picked.company || picked.name);
                      if (!slugTouched) setSlug(slugifyClient(picked.company || picked.name));
                    }
                  }}
                >
                  <option value="">Choose a client…</option>
                  {(clients ?? []).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} {c.company ? `(${c.company})` : ""} {c.email ? `· ${c.email}` : ""}
                    </option>
                  ))}
                </select>
              </Field>
            )}

            {linkKind === "lead" && (
              <Field label="Select Lead" full>
                <select
                  className="input"
                  value={leadId}
                  onChange={(e) => {
                    const id = e.target.value;
                    setLeadId(id);
                    const picked = (leadsData?.items ?? []).find((l) => l.id === id);
                    if (picked && !businessName.trim()) {
                      setBusinessName(picked.companyName || picked.contactName);
                      if (!slugTouched) setSlug(slugifyClient(picked.companyName || picked.contactName));
                    }
                  }}
                >
                  <option value="">Choose a lead…</option>
                  {(leadsData?.items ?? []).map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.companyName || l.contactName} ({l.contactName}) {l.contactEmail ? `· ${l.contactEmail}` : ""}
                    </option>
                  ))}
                </select>
              </Field>
            )}

            {linkKind === "email" && (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Recipient Email">
                  <input
                    type="email"
                    className="input"
                    placeholder="client@company.com"
                    value={recipientEmail}
                    onChange={(e) => setRecipientEmail(e.target.value)}
                  />
                </Field>
                <Field label="Recipient Name">
                  <input
                    className="input"
                    placeholder="Ama Mensah"
                    value={recipientName}
                    onChange={(e) => setRecipientName(e.target.value)}
                  />
                </Field>
              </div>
            )}
          </div>

          {/* Display & Safety Options */}
          <div className="space-y-2 rounded-2xl border border-line bg-sunken p-4 text-xs">
            <label className="flex cursor-pointer items-center gap-2.5 text-ink">
              <input
                type="checkbox"
                checked={includeBanner}
                onChange={(e) => setIncludeBanner(e.target.checked)}
                className="rounded border-line"
              />
              <span>
                Show DakyXTech preview bar at the top of the page (
                <span className="text-muted">&ldquo;Preview concept built for {businessName || "Client"}&rdquo;</span>)
              </span>
            </label>

            <label className="flex cursor-pointer items-center gap-2.5 text-ink">
              <input
                type="checkbox"
                checked={makeFormsInert}
                onChange={(e) => setMakeFormsInert(e.target.checked)}
                className="rounded border-line"
              />
              <span>
                Keep <code className="font-mono">&lt;form&gt;</code> elements inert in preview so visitors cannot submit dummy forms
              </span>
            </label>
          </div>

          {error && (
            <p className="rounded-xl border border-danger-line bg-danger-surface px-3.5 py-2.5 text-xs text-danger-text">
              {error}
            </p>
          )}

          <div className="flex items-center justify-end gap-2 border-t border-line pt-4">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            {/* Not blocked: a page whose pictures are elsewhere on purpose may
                still go in. But the button says what it will do. */}
            <Button
              variant={sourceTab === "file" && localFiles.length > 0 ? "secondary" : undefined}
              onClick={() => saveMutation.mutate()}
              disabled={saveMutation.isPending || packaging}
            >
              {saveMutation.isPending
                ? isProposalMode ? "Saving Proposal…" : "Saving Demo…"
                : sourceTab === "file" && localFiles.length > 0
                  ? `${editingDemo ? "Save" : "Import"} without its ${localFiles.length} picture${localFiles.length === 1 ? "" : "s"}`
                  : editingDemo
                    ? "Save Changes"
                    : isProposalMode ? "Import & Generate Proposal Link" : "Import & Generate Public URL"}
            </Button>
          </div>
        </div>
      )}
    </Drawer>
  );
}

