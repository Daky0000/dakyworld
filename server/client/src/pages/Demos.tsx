import { useEffect, useMemo, useState } from "react";
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
  PageHeader,
  RelativeTime,
  StatGrid,
  StatTile,
} from "../components/ui";

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

export function Demos() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<DemoStatus | "">("");
  const [search, setSearch] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingDemo, setEditingDemo] = useState<Demo | null>(null);
  const [composerTarget, setComposerTarget] = useState<ComposerTarget | null>(null);
  const [editingSlugId, setEditingSlugId] = useState<string | null>(null);
  const [slugDraft, setSlugDraft] = useState("");
  const [slugError, setSlugError] = useState<string | null>(null);
  const [openingBuilderId, setOpeningBuilderId] = useState<string | null>(null);

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
    queryFn: () => api.get<{ demos: Demo[]; base: string }>(`/demos${filter ? `?status=${filter}` : ""}`),
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

  const openShareEmail = (demo: Demo, attachHtml: boolean) => {
    const recipientName =
      demo.lead?.contactName ?? demo.client?.name ?? demo.recipientName ?? demo.businessName;
    const greeting = recipientName && recipientName !== demo.businessName ? `Hi ${recipientName.split(" ")[0]},` : "Hello,";
    const defaultBody = attachHtml
      ? `${greeting}\n\nI have put together an interactive preview for ${demo.businessName}. You can open it directly in your browser at any time using this link:\n\n${demo.url}\n\nI have also attached the standalone HTML file (${demo.slug}.html) to this email in case you would like to keep a copy offline.\n\nLet me know what you think.`
      : `${greeting}\n\nI have put together an interactive preview for ${demo.businessName}. You can explore it live in your browser here:\n\n${demo.url}\n\nTake a look on your phone or desktop when you have a moment, and let me know what you think.`;

    setComposerTarget({
      leadId: demo.lead?.id ?? undefined,
      clientId: demo.client?.id ?? undefined,
      toEmail: demo.lead?.contactEmail ?? demo.client?.email ?? demo.recipientEmail ?? undefined,
      toName: recipientName,
      purpose: "DEMO_READY",
      initialSubject: `${demo.businessName} — interactive website preview`,
      initialBody: defaultBody,
      initialBrief: `Share the live demo preview link (${demo.url}) for ${demo.businessName}${
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

    for (const d of demos) {
      if (d.views > 0) opened++;
      if (d.status === "ACCEPTED") accepted++;
      totalViews += d.views;
    }

    const openRate = demos.length > 0 ? Math.round((opened / demos.length) * 100) : 0;

    return {
      total: demos.length,
      opened,
      accepted,
      totalViews,
      openRate,
    };
  }, [demos]);

  // Search filter
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return demos;
    return demos.filter(
      (d) =>
        d.businessName.toLowerCase().includes(q) ||
        d.title.toLowerCase().includes(q) ||
        d.slug.toLowerCase().includes(q) ||
        (d.lead?.contactName && d.lead.contactName.toLowerCase().includes(q)) ||
        (d.client?.name && d.client.name.toLowerCase().includes(q)) ||
        (d.recipientEmail && d.recipientEmail.toLowerCase().includes(q)),
    );
  }, [demos, search]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Demos & Previews"
        subtitle="Landing pages built or imported for prospects and clients. Each one lives at a dedicated public URL you can share or attach to an email."
        action={
          <Button
            onClick={() => {
              setEditingDemo(null);
              setDrawerOpen(true);
            }}
          >
            + Import HTML Demo
          </Button>
        }
      />

      {/* Metrics Seam Grid */}
      <StatGrid columns={4}>
        <StatTile label="Total Demos Built" value={stats.total} sub="Unlisted prospect & client previews" />
        <StatTile label="Opened by Recipient" value={stats.opened} sub={`${stats.openRate}% view engagement rate`} />
        <StatTile label="Total Views Recorded" value={stats.totalViews} sub="Live link interaction counts" />
        <StatTile
          label="Accepted"
          value={stats.accepted}
          sub={stats.accepted > 0 ? "Converted to client proposal" : "None converted yet"}
        />
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
        <Loading label="Loading demos" rows={4} />
      ) : filtered.length === 0 ? (
        <EmptyState
          message={
            demos.length === 0
              ? "Nothing built or imported yet. Import an HTML file to get an instant public URL you can send to a client or attach to an email."
              : "No demos match your search criteria."
          }
          action={
            demos.length === 0 ? (
              <Button
                onClick={() => {
                  setEditingDemo(null);
                  setDrawerOpen(true);
                }}
              >
                + Import HTML Demo
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="space-y-3.5">
          {filtered.map((demo) => {
            const isEditingSlug = editingSlugId === demo.id;
            const isImported = demo.builtBy === "Imported HTML" || Boolean(demo.brief?.imported);

            return (
              <Card key={demo.id} interactive className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-display text-base font-medium text-ink">{demo.businessName}</h3>
                      <Badge tone={STATUS_TONE[demo.status]}>{STATUS_LABEL[demo.status]}</Badge>
                      {isImported && <Badge tone="info">Imported HTML</Badge>}
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
                      {isEditingSlug ? (
                        <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-line bg-sunken px-2.5 py-1">
                          <span className="font-mono text-xs text-muted">{baseUrl}/demos/</span>
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
                      ) : (
                        <>
                          <a
                            href={demo.url}
                            target="_blank"
                            rel="noreferrer"
                            className="max-w-md truncate font-mono text-xs text-blue underline-offset-2 hover:underline"
                          >
                            {demo.url}
                          </a>
                          <CopyButton text={demo.url} label="Copy URL" />
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
                      )}
                    </div>
                  </div>

                  <div className="shrink-0 text-right text-xs text-muted">
                    <div className={`font-mono ${demo.views > 0 ? "font-bold text-ink" : "text-muted"}`}>
                      {demo.views > 0 ? `Opened ${demo.views} time${demo.views === 1 ? "" : "s"}` : "Not yet opened"}
                    </div>
                    {demo.lastViewedAt && (
                      <div className="mt-0.5">
                        last viewed <RelativeTime value={demo.lastViewedAt} />
                      </div>
                    )}
                    {demo.sentAt && (
                      <div className="mt-0.5">
                        sent <RelativeTime value={demo.sentAt} />
                      </div>
                    )}
                  </div>
                </div>

                <div className="mt-3.5 flex flex-wrap items-center gap-2 border-t border-line/60 pt-3">
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

                  <Button size="sm" variant="secondary" onClick={() => openShareEmail(demo, false)}>
                    Send Link via Email
                  </Button>

                  <Button size="sm" variant="secondary" onClick={() => openShareEmail(demo, true)}>
                    Attach HTML to Email
                  </Button>

                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setEditingDemo(demo);
                      setDrawerOpen(true);
                    }}
                  >
                    Replace .html / Settings
                  </Button>

                  <span className="flex-1" />

                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => {
                      if (confirm(`Delete the demo for ${demo.businessName}? The link stops working immediately.`)) {
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
        onClose={() => {
          setDrawerOpen(false);
          setEditingDemo(null);
        }}
        onOpenBuilder={(demo) => {
          setDrawerOpen(false);
          setEditingDemo(null);
          void openInWebsiteBuilder(demo, "visual");
        }}
        onShareEmail={(demo, attachHtml) => {
          setDrawerOpen(false);
          setEditingDemo(null);
          openShareEmail(demo, attachHtml);
        }}
      />

      <EmailComposer
        target={composerTarget}
        open={Boolean(composerTarget)}
        onClose={() => setComposerTarget(null)}
      />
    </div>
  );
}

function ImportDemoDrawer({
  open,
  editingDemo,
  baseUrl,
  onClose,
  onOpenBuilder,
  onShareEmail,
}: {
  open: boolean;
  editingDemo: Demo | null;
  baseUrl: string;
  onClose: () => void;
  onOpenBuilder: (demo: Demo) => void;
  onShareEmail: (demo: Demo, attachHtml: boolean) => void;
}) {
  const qc = useQueryClient();
  const [sourceTab, setSourceTab] = useState<"file" | "paste">("file");
  const [dragging, setDragging] = useState(false);
  const [fileName, setFileName] = useState<string>("");
  const [fileSize, setFileSize] = useState<number | null>(null);
  const [dataBase64, setDataBase64] = useState<string>("");
  const [rawHtml, setRawHtml] = useState<string>("");

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

  const { data: clients } = useQuery({
    queryKey: ["clients"],
    queryFn: () => api.get<Client[]>("/clients"),
    enabled: open && linkKind === "client",
  });

  const { data: leadsData } = useQuery({
    queryKey: ["leads-brief-demo"],
    queryFn: () => api.get<{ items: Lead[] }>("/leads?take=100"),
    enabled: open && linkKind === "lead",
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

    if (editingDemo) {
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

  const handleFile = async (file: File) => {
    setError(null);
    if (!/\.html?$/i.test(file.name) && file.type && !file.type.includes("html") && !file.type.includes("text")) {
      setError("Please select an .html or .htm file.");
      return;
    }
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

      setFileName(file.name);
      setFileSize(file.size);
      setDataBase64(b64);

      const meta = parseHtmlClientMetadata(text, file.name);
      if (!businessName.trim()) setBusinessName(meta.businessName);
      if (!title.trim()) setTitle(meta.title);
      if (!slugTouched && !slug.trim()) setSlug(meta.suggestedSlug);
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

      if (sourceTab === "file" && dataBase64) {
        payload.fileName = fileName;
        payload.dataBase64 = dataBase64;
      } else if (sourceTab === "paste" && rawHtml.trim()) {
        payload.html = rawHtml.trim();
      } else if (!editingDemo) {
        throw new Error("Please upload an .html file or paste HTML markup first.");
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
      void qc.invalidateQueries({ queryKey: ["demos"] });
    },
    onError: (err) => {
      setError((err as Error).message);
    },
  });

  const previewSlug = slugifyClient(slug || businessName || "your-demo-name") || "your-demo-name";
  const previewUrl = `${baseUrl}/demos/${previewSlug}`;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={editingDemo ? `Update Demo — ${editingDemo.businessName}` : "Import HTML File as Demo"}
      subtitle={
        editingDemo
          ? "Upload a new .html file version or adjust its public URL and recipient settings."
          : "Turn any standalone .html file into a hosted public demo URL you can send to a client or attach to an email."
      }
    >
      {savedDemo ? (
        <div className="space-y-5">
          <div className="rounded-2xl border border-info-line bg-info-surface p-5">
            <div className="mb-1 flex items-center gap-2">
              <Badge tone="positive">Live &amp; Ready</Badge>
              <span className="font-sans text-[11px] uppercase tracking-[.06em] text-muted">
                {editingDemo ? `Updated to v${savedDemo.version}` : "Public Demo Created"}
              </span>
            </div>
            <h3 className="mt-2 font-display text-lg font-medium text-ink">{savedDemo.businessName}</h3>
            <p className="text-xs text-muted">{savedDemo.title}</p>

            <div className="mt-4 rounded-xl border border-line bg-white p-3">
              <div className="font-sans text-[10px] uppercase tracking-[.06em] text-muted">Shareable Public URL</div>
              <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
                <a
                  href={savedDemo.url}
                  target="_blank"
                  rel="noreferrer"
                  className="break-all font-mono text-xs font-medium text-blue underline underline-offset-2"
                >
                  {savedDemo.url}
                </a>
                <CopyButton text={savedDemo.url} label="Copy URL" />
              </div>
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              <Button onClick={() => onOpenBuilder(savedDemo)}>Edit in Website Builder</Button>
              <a href={savedDemo.url} target="_blank" rel="noreferrer">
                <Button variant="secondary">Open Live Preview</Button>
              </a>
              <a href={`/api/demos/${savedDemo.id}/download`} download={`${savedDemo.slug}.html`}>
                <Button variant="secondary">Download .html</Button>
              </a>
              <Button variant="secondary" onClick={() => onShareEmail(savedDemo, false)}>
                Send URL via Email
              </Button>
              <Button variant="secondary" onClick={() => onShareEmail(savedDemo, true)}>
                Attach .html File to Email
              </Button>
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
                  accept=".html,.htm,text/html"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void handleFile(file);
                    e.target.value = "";
                  }}
                />
                {fileName ? (
                  <>
                    <Badge tone="positive">Selected File</Badge>
                    <span className="mt-2 font-mono text-sm font-medium text-ink">{fileName}</span>
                    {fileSize !== null && (
                      <span className="mt-0.5 text-xs text-muted">{Math.max(1, Math.round(fileSize / 1024))} KB</span>
                    )}
                    <span className="mt-2 text-xs text-blue underline">Click or drop another .html file to replace</span>
                  </>
                ) : (
                  <>
                    <span className="text-sm font-medium text-ink">
                      Drop your <code className="font-mono text-xs">.html</code> file here, or{" "}
                      <span className="text-blue underline underline-offset-2">browse</span>
                    </span>
                    <span className="mt-1 text-xs text-muted">
                      Supports standalone HTML files with inline CSS/JS, Tailwind CDN, fonts, and external images (up to 10 MB)
                    </span>
                  </>
                )}
              </label>
            </div>
          ) : (
            <Field label="Raw HTML Markup" hint="Paste a complete <!DOCTYPE html> document or HTML snippet." full>
              <textarea
                rows={8}
                className="input font-mono text-xs"
                placeholder="<!DOCTYPE html><html>..."
                value={rawHtml}
                onChange={(e) => {
                  const val = e.target.value;
                  setRawHtml(val);
                  if (val.trim().length > 20) {
                    const meta = parseHtmlClientMetadata(val);
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
                {baseUrl}/demos/
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
                Show Dakyworld preview bar at the top of the page (
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
            <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
              {saveMutation.isPending
                ? "Saving Demo…"
                : editingDemo
                  ? "Save Changes"
                  : "Import & Generate Public URL"}
            </Button>
          </div>
        </div>
      )}
    </Drawer>
  );
}

