import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { EmailMessage, EmailStatusSummary, EmailSuppression, EmailTemplate } from "../lib/types";
import { Badge, Button, Card, EmptyState, PageHeader, RelativeTime, StatTile, StatusDot } from "../components/ui";
import { EmailComposer, PURPOSES, type ComposerTarget } from "../components/EmailComposer";
import { Sequences } from "../components/Sequences";

type Tab = "outbox" | "templates" | "sequences" | "suppression";

/**
 * The outbox, and everything that feeds it.
 *
 * Deliberately not styled as an inbox: this app sends, it does not read a
 * mailbox. What it shows is what went out, what is queued, and what failed —
 * the three questions that matter when an email did or didn't reach a client.
 */
export function Emails() {
  const [tab, setTab] = useState<Tab>("outbox");
  const [composing, setComposing] = useState<ComposerTarget | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);

  const { data: status } = useQuery({ queryKey: ["email-status"], queryFn: () => api.get<EmailStatusSummary>("/emails/status") });

  const openComposer = (target: ComposerTarget) => {
    setComposing(target);
    setComposerOpen(true);
  };

  return (
    <div>
      <PageHeader
        title="Email"
        subtitle="Write to a lead or a client, send the deliverable, and let the follow-ups send themselves."
        action={<Button onClick={() => openComposer({})}>New email</Button>}
      />

      {status && !status.connected && (
        <Card className="mb-6 border-amber-300 bg-amber-50">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="font-medium">No mailbox connected yet.</div>
              <p className="mt-1 text-sm text-ink/60">
                Drafts and sequences can be written now, but nothing will leave until an address is connected.
              </p>
            </div>
            <Link to="/settings">
              <Button variant="secondary">Connect a mailbox</Button>
            </Link>
          </div>
        </Card>
      )}

      {status && (
        <div className="mb-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <StatTile label="Sent" value={status.sent} sub="All time" />
          <StatTile label="Waiting to send" value={status.scheduled} sub={status.scheduled > 0 ? "Queued for later" : "Nothing queued"} />
          <StatTile label="Drafts" value={status.drafts} sub={status.drafts > 0 ? "Written, not sent" : "None open"} />
          <StatTile label="In a sequence" value={status.activeEnrollments} sub={`${status.activeSequences} sequence${status.activeSequences === 1 ? "" : "s"} running`} />
          <StatTile
            label="Failed"
            value={status.failed}
            sub={status.failed > 0 ? "Look at these" : status.drafterReady ? "AI drafting ready" : "No AI key set"}
          />
        </div>
      )}

      <div className="mb-6 flex flex-wrap gap-1 border-b border-ink/10">
        {(
          [
            ["outbox", "Outbox"],
            ["templates", "Templates"],
            ["sequences", "Sequences"],
            ["suppression", "Unsubscribed"],
          ] as [Tab, string][]
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setTab(value)}
            className={`-mb-px border-b-2 px-4 py-2 font-mono text-[10px] uppercase tracking-[.14em] transition ${
              tab === value ? "border-ink text-ink" : "border-transparent text-ink/45 hover:text-ink"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "outbox" && <Outbox onOpen={openComposer} />}
      {tab === "templates" && <Templates />}
      {tab === "sequences" && <Sequences />}
      {tab === "suppression" && <Suppression />}

      <EmailComposer target={composing} open={composerOpen} onClose={() => setComposerOpen(false)} />
    </div>
  );
}

// --- Outbox ----------------------------------------------------------------

const STATUS_TONE: Record<string, "live" | "ok" | "warn" | "bad" | "idle"> = {
  SENT: "ok",
  SCHEDULED: "warn",
  SENDING: "live",
  DRAFT: "idle",
  FAILED: "bad",
  CANCELLED: "idle",
};

function Outbox({ onOpen }: { onOpen: (target: ComposerTarget) => void }) {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<string>("");
  const [search, setSearch] = useState("");

  const { data: messages, isLoading } = useQuery({
    queryKey: ["emails", filter, search],
    queryFn: () =>
      api.get<EmailMessage[]>(
        `/emails?${new URLSearchParams({ ...(filter ? { status: filter } : {}), ...(search.trim() ? { q: search.trim() } : {}) }).toString()}`,
      ),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["emails"] });
    qc.invalidateQueries({ queryKey: ["email-status"] });
  };
  const send = useMutation({ mutationFn: (id: string) => api.post(`/emails/${id}/send`), onSuccess: refresh });
  const cancel = useMutation({ mutationFn: (id: string) => api.post(`/emails/${id}/cancel`), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (id: string) => api.delete(`/emails/${id}`), onSuccess: refresh });

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <input className="control w-56" placeholder="Search subject or address" value={search} onChange={(event) => setSearch(event.target.value)} />
        {["", "DRAFT", "SCHEDULED", "SENT", "FAILED"].map((value) => (
          <button
            key={value || "all"}
            type="button"
            onClick={() => setFilter(value)}
            className={`border px-2.5 py-1 font-mono text-[10px] uppercase tracking-[.1em] transition ${
              filter === value ? "border-ink bg-ink text-cream" : "border-ink/15 text-ink/55 hover:border-ink/40"
            }`}
          >
            {value || "All"}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="text-sm text-ink/50">Loading…</div>
      ) : !messages || messages.length === 0 ? (
        <EmptyState message="Nothing here yet." action={<Button onClick={() => onOpen({})}>Write one</Button>} />
      ) : (
        <div className="space-y-2">
          {messages.map((message) => (
            <Card key={message.id} className="!p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusDot tone={STATUS_TONE[message.status] ?? "idle"} />
                    <span className="font-medium">{message.subject}</span>
                    <Badge tone={message.status === "SENT" ? "positive" : "muted"}>{message.status}</Badge>
                    {message.kind === "AI_DRAFT" && <Badge tone="muted">AI</Badge>}
                    {message.step && <Badge tone="muted">{message.step.sequence.name} · step {message.step.position + 1}</Badge>}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 text-sm text-ink/55">
                    <span>
                      to {message.toName ? `${message.toName} · ` : ""}
                      {message.toEmail}
                    </span>
                    <span className="text-ink/35">
                      {message.status === "SENT" ? (
                        <RelativeTime value={message.sentAt} />
                      ) : message.status === "SCHEDULED" ? (
                        <>
                          sends <RelativeTime value={message.scheduledFor} />
                        </>
                      ) : (
                        <RelativeTime value={message.createdAt} />
                      )}
                    </span>
                    {message.attachments.length > 0 && <span className="text-ink/35">{message.attachments.length} attached</span>}
                  </div>
                  {message.error && <div className="mt-2 text-xs text-red-600">{message.error}</div>}
                  <p className="mt-2 line-clamp-2 text-sm text-ink/45">{message.bodyText.slice(0, 200)}</p>
                </div>

                <div className="flex shrink-0 flex-wrap gap-2">
                  {(message.status === "DRAFT" || message.status === "FAILED") && (
                    <>
                      <Button variant="secondary" size="sm" onClick={() => onOpen({ message, leadId: message.lead?.id, clientId: message.client?.id })}>
                        Open
                      </Button>
                      <Button size="sm" onClick={() => send.mutate(message.id)} disabled={send.isPending}>
                        Send
                      </Button>
                    </>
                  )}
                  {message.status === "SCHEDULED" && (
                    <>
                      <Button variant="secondary" size="sm" onClick={() => send.mutate(message.id)}>
                        Send now
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => cancel.mutate(message.id)}>
                        Cancel
                      </Button>
                    </>
                  )}
                  {message.status !== "SENT" && message.status !== "SENDING" && (
                    <Button variant="ghost" size="sm" onClick={() => remove.mutate(message.id)}>
                      Delete
                    </Button>
                  )}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

// --- Templates -------------------------------------------------------------

function Templates() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<EmailTemplate | null>(null);
  const { data } = useQuery({ queryKey: ["email-templates"], queryFn: () => api.get<{ templates: EmailTemplate[] }>("/emails/templates/all") });

  const save = useMutation({
    mutationFn: (template: EmailTemplate) =>
      template.id
        ? api.patch(`/emails/templates/${template.id}`, {
            name: template.name,
            purpose: template.purpose,
            description: template.description,
            subject: template.subject,
            bodyHtml: template.bodyHtml,
            aiBrief: template.aiBrief,
            active: template.active,
          })
        : api.post("/emails/templates", template),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["email-templates"] });
      setEditing(null);
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/emails/templates/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["email-templates"] }),
  });

  const templates = data?.templates ?? [];

  return (
    <div>
      <div className="mb-4 flex items-center justify-between gap-4">
        <p className="max-w-2xl text-sm text-ink/55">
          The letters worth writing down. These ship with the app and can be edited freely — an edit is never overwritten by a deploy.
        </p>
        <Button
          variant="secondary"
          onClick={() =>
            setEditing({
              id: "",
              name: "",
              slug: "",
              purpose: "CUSTOM",
              subject: "",
              bodyHtml: "",
              builtin: false,
              active: true,
              usageCount: 0,
            })
          }
        >
          New template
        </Button>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        {templates.map((template) => (
          <Card key={template.id} className="!p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{template.name}</span>
                  {template.builtin && <Badge tone="muted">Built in</Badge>}
                  {!template.active && <Badge tone="muted">Off</Badge>}
                </div>
                {template.description && <p className="mt-1 text-xs text-ink/50">{template.description}</p>}
                <p className="mt-2 font-mono text-[11px] text-ink/40">{template.subject}</p>
              </div>
              <div className="flex shrink-0 gap-1">
                <Button variant="ghost" size="sm" onClick={() => setEditing(template)}>
                  Edit
                </Button>
                {!template.builtin && (
                  <Button variant="ghost" size="sm" onClick={() => remove.mutate(template.id)}>
                    Delete
                  </Button>
                )}
              </div>
            </div>
            {template.usageCount > 0 && <div className="mt-2 text-[11px] text-ink/35">Used {template.usageCount}×</div>}
          </Card>
        ))}
      </div>

      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
          <div className="absolute inset-0 bg-ink/40 backdrop-blur-sm" onClick={() => setEditing(null)} aria-hidden />
          <div className="relative max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-line bg-cream p-6">
            <h3 className="mb-4 font-display text-xl">{editing.id ? "Edit template" : "New template"}</h3>
            <div className="space-y-3">
              <input className="input" placeholder="Name" value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.target.value })} />
              <select className="input" value={editing.purpose} onChange={(event) => setEditing({ ...editing, purpose: event.target.value as EmailTemplate["purpose"] })}>
                {PURPOSES.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <input
                className="input"
                placeholder="When to use it"
                value={editing.description ?? ""}
                onChange={(event) => setEditing({ ...editing, description: event.target.value })}
              />
              <input className="input" placeholder="Subject" value={editing.subject} onChange={(event) => setEditing({ ...editing, subject: event.target.value })} />
              <textarea
                rows={12}
                className="input leading-relaxed"
                placeholder="Body — use {{first_name}}, {{company}}, {{city}}…"
                value={editing.bodyHtml}
                onChange={(event) => setEditing({ ...editing, bodyHtml: event.target.value })}
              />
              <textarea
                rows={2}
                className="input"
                placeholder="Steer for the AI when this template is a starting point (optional)"
                value={editing.aiBrief ?? ""}
                onChange={(event) => setEditing({ ...editing, aiBrief: event.target.value })}
              />
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setEditing(null)}>
                Cancel
              </Button>
              <Button onClick={() => save.mutate(editing)} disabled={!editing.name || !editing.subject || !editing.bodyHtml}>
                Save
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// --- Suppression -----------------------------------------------------------

function Suppression() {
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const { data } = useQuery({ queryKey: ["email-suppression"], queryFn: () => api.get<EmailSuppression[]>("/emails/suppression/all") });

  const add = useMutation({
    mutationFn: () => api.post("/emails/suppression", { email, reason: "Added by hand" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["email-suppression"] });
      setEmail("");
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/emails/suppression/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["email-suppression"] }),
  });

  return (
    <div>
      <p className="mb-4 max-w-2xl text-sm text-ink/55">
        Addresses that will never be written to again — checked before every send, sequences included. Unsubscribes land here on their
        own; anyone who asks to be left alone by phone or in person should be added by hand.
      </p>

      <div className="mb-6 flex gap-2">
        <input className="input max-w-sm" placeholder="name@company.com" value={email} onChange={(event) => setEmail(event.target.value)} />
        <Button variant="secondary" onClick={() => add.mutate()} disabled={!/^\S+@\S+\.\S+$/.test(email)}>
          Add
        </Button>
      </div>

      {!data || data.length === 0 ? (
        <EmptyState message="Nobody has unsubscribed." />
      ) : (
        <div className="rounded-2xl border border-line bg-white">
          {data.map((row) => (
            <div key={row.id} className="flex items-center justify-between border-b border-ink/5 px-4 py-2.5 text-sm last:border-0">
              <span>
                {row.email}
                <span className="ml-3 text-xs text-ink/40">
                  {row.reason} · <RelativeTime value={row.createdAt} />
                </span>
              </span>
              <Button variant="ghost" size="sm" onClick={() => remove.mutate(row.id)}>
                Remove
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
