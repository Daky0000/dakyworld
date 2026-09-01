import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import type {
  MessageRow,
  MessageStatus,
  MessageSuppressionRow,
  MessageThreadDetail,
  MessageThreadRow,
  MessagingStatus,
  PhoneOnlyLead,
  StarterTemplate,
  WhatsAppTemplateRow,
} from "../lib/types";
import { Badge, Button, Card, Drawer, EmptyState, PageHeader, RelativeTime, StatTile, StatusDot, Table } from "../components/ui";
import { MessageComposer, type MessageTarget } from "../components/MessageComposer";

type Tab = "reach" | "conversations" | "outbox" | "templates" | "suppression";

/**
 * WhatsApp and SMS.
 *
 * Unlike Email, this screen leads with **who cannot be emailed**. That is the
 * whole reason the module exists: a Google Maps scrape returns a phone number
 * nearly every time and an email address rarely, so the largest group of leads
 * in the database was one nothing could act on. "Reach" is that list, and it
 * is the default tab.
 *
 * The second difference is the 24-hour window. Email has an inbox of its own
 * now (see pages/Inbox.tsx) and neither channel is send-only any more, but a
 * WhatsApp reply does something no email reply does: it opens a window in which
 * a message you wrote can be delivered at all, and that window is a day long.
 * A reply nobody sees is still the most expensive thing on this screen.
 */
export function Messages() {
  const [tab, setTab] = useState<Tab>("reach");
  const [composing, setComposing] = useState<MessageTarget | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);

  const { data: status } = useQuery({ queryKey: ["messaging-status"], queryFn: () => api.get<MessagingStatus>("/messages/status") });

  const compose = (target: MessageTarget) => {
    setComposing(target);
    setComposerOpen(true);
  };

  const nothingConnected = status && !status.whatsapp && !status.sms;

  return (
    <div>
      <PageHeader
        title="WhatsApp & SMS"
        subtitle="For the leads with a number and no email — which is most of them."
        action={<Button onClick={() => compose({})}>New message</Button>}
      />

      {nothingConnected && (
        <Card className="mb-6 border-warn-line bg-warn-surface">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="font-medium">Neither channel is connected yet.</div>
              <p className="mt-1 text-sm text-muted">
                Messages can still be written and opened in your own WhatsApp by hand — nothing here needs an account to be useful today.
              </p>
            </div>
            <Link to="/settings">
              <Button variant="secondary">Connect WhatsApp</Button>
            </Link>
          </div>
        </Card>
      )}

      {/* Meta's read on how recipients are reacting. Nowhere else shows it, and
          a number that reaches RED stops being able to start conversations. */}
      {status?.quality?.qualityRating && status.quality.qualityRating !== "GREEN" && (
        <Card className={`mb-6 ${status.quality.qualityRating === "RED" ? "border-danger-line bg-danger-surface" : "border-warn-line bg-warn-surface"}`}>
          <div className="font-medium">WhatsApp rates this number {status.quality.qualityRating.toLowerCase()}.</div>
          <p className="mt-1 text-sm text-muted">
            That happens when recipients block or report messages. It cuts how many conversations the number may start each day, and at red it
            stops being able to start any. Send fewer, to better-matched people, and make the opt-out obvious.
          </p>
        </Card>
      )}

      {status && (
        <div className="mb-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <StatTile label="Unanswered replies" value={status.unread} sub={status.unread > 0 ? "Someone is waiting" : "Nothing waiting"} />
          <StatTile label="Sent" value={status.sent} sub="All time" />
          <StatTile label="Waiting to send" value={status.scheduled + status.ready} sub={status.ready > 0 ? `${status.ready} to send by hand` : "Nothing queued"} />
          <StatTile label="Conversations" value={status.threads} sub={`${status.suppressed} opted out`} />
          <StatTile
            label="Failed"
            value={status.failed}
            sub={status.failed > 0 ? "Look at these" : status.whatsapp ? "WhatsApp connected" : status.sms ? "SMS only" : "Nothing connected"}
          />
        </div>
      )}

      <div className="mb-6 flex flex-wrap gap-1 border-b border-line">
        {(
          [
            ["reach", "Who to reach"],
            ["conversations", status?.unread ? `Conversations (${status.unread})` : "Conversations"],
            ["outbox", "Outbox"],
            ["templates", "Templates"],
            ["suppression", "Opted out"],
          ] as [Tab, string][]
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setTab(value)}
            className={`-mb-px border-b-2 px-4 py-2 font-mono text-[10px] uppercase tracking-[.14em] transition ${
              tab === value ? "border-ink text-ink" : "border-transparent text-muted hover:text-ink"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "reach" && <Reach onCompose={compose} />}
      {tab === "conversations" && <Conversations onCompose={compose} />}
      {tab === "outbox" && <Outbox />}
      {tab === "templates" && <Templates />}
      {tab === "suppression" && <Suppression />}

      <MessageComposer target={composing} open={composerOpen} onClose={() => setComposerOpen(false)} />
    </div>
  );
}

// --- Who to reach ----------------------------------------------------------

/**
 * Leads with a number and no email.
 *
 * The list is ordered by lead score, so the best of the previously-unreachable
 * come first. Each row says plainly whether the number can actually carry a
 * message: "could not be read", "that is a landline" and "they opted out" are
 * three different problems and only one of them is fixable by trying again.
 */
function Reach({ onCompose }: { onCompose: (target: MessageTarget) => void }) {
  const [status, setStatus] = useState("");
  const { data: leads, isLoading } = useQuery({
    queryKey: ["phone-only", status],
    queryFn: () => api.get<PhoneOnlyLead[]>(`/messages/phone-only${status ? `?status=${status}` : ""}`),
  });

  if (isLoading) return <div className="text-sm text-muted">Looking…</div>;
  if (!leads?.length) {
    return (
      <EmptyState message="Every lead on file has an email address. Nothing here needs a phone channel — which is a good problem." />
    );
  }

  const reachable = leads.filter((lead) => !lead.unreachable);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">
          <span className="font-medium text-ink">{reachable.length}</span> of {leads.length} can be reached on their number. Until this module
          they could not be reached at all.
        </p>
        <select className="filter-select" value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="">Any stage</option>
          <option value="NEW">New</option>
          <option value="CONTACTED">Contacted</option>
          <option value="QUALIFIED">Qualified</option>
        </select>
      </div>

      <Table>
        <thead>
          <tr className="border-b border-line font-mono text-[10px] uppercase tracking-[.12em] text-muted">
            <th className="px-4 py-3 font-normal">Business</th>
            <th className="px-4 py-3 font-normal">Number</th>
            <th className="px-4 py-3 font-normal">Score</th>
            <th className="px-4 py-3 font-normal">Where it stands</th>
            <th className="px-4 py-3" />
          </tr>
        </thead>
        <tbody>
          {leads.map((lead) => (
            <tr key={lead.id} className="border-b border-line/60 last:border-0">
              <td className="px-4 py-3">
                <div className="font-medium">{lead.companyName ?? lead.contactName}</div>
                <div className="text-xs text-muted">
                  {[lead.category, lead.city].filter(Boolean).join(" · ") || "No details yet"}
                  {!lead.website && " · no website"}
                </div>
              </td>
              <td className="px-4 py-3 font-mono text-[12px]">{lead.phone?.display ?? lead.contactPhone}</td>
              <td className="px-4 py-3 font-mono text-[12px]">{lead.leadScore}</td>
              <td className="px-4 py-3 text-xs">
                {lead.unreachable ? (
                  <span className="text-warn-text">{lead.unreachable}</span>
                ) : lead.replied ? (
                  <Badge tone="positive">They replied{lead.unread ? ` · ${lead.unread} unread` : ""}</Badge>
                ) : lead.contacted ? (
                  <Badge tone="muted">Messaged, no reply</Badge>
                ) : (
                  <span className="text-muted">Not contacted</span>
                )}
              </td>
              <td className="px-4 py-3 text-right">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={Boolean(lead.unreachable)}
                  onClick={() => onCompose({ leadId: lead.id, toName: lead.contactName, channel: "WHATSAPP", purpose: "COLD_OUTREACH" })}
                >
                  Write
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}

// --- Conversations ---------------------------------------------------------

function Conversations({ onCompose }: { onCompose: (target: MessageTarget) => void }) {
  const [openThread, setOpenThread] = useState<string | null>(null);
  const { data: threads, isLoading } = useQuery({
    queryKey: ["message-threads"],
    queryFn: () => api.get<MessageThreadRow[]>("/messages/threads"),
    // A reply lands over a webhook while this screen is open, and the whole
    // value of the 24-hour window is acting inside it.
    refetchInterval: 60_000,
  });

  if (isLoading) return <div className="text-sm text-muted">Loading…</div>;
  if (!threads?.length) return <EmptyState message="No conversations yet. Send a first message from “Who to reach”." />;

  return (
    <>
      <div className="space-y-2">
        {threads.map((thread) => (
          <button
            key={thread.id}
            type="button"
            onClick={() => setOpenThread(thread.id)}
            className={`flex w-full items-center gap-4 rounded-2xl border bg-white px-4 py-3 text-left transition hover:border-ink/30 ${
              thread.unreadCount > 0 ? "border-blue/50" : "border-line"
            }`}
          >
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{thread.lead?.companyName ?? thread.lead?.contactName ?? thread.name ?? thread.display}</span>
                <Badge tone="muted">{thread.channel === "WHATSAPP" ? "WhatsApp" : "SMS"}</Badge>
                {thread.unreadCount > 0 && <Badge tone="positive">{thread.unreadCount} new</Badge>}
                {thread.windowOpen && thread.channel === "WHATSAPP" && (
                  <span className="font-mono text-[10px] uppercase tracking-[.1em] text-positive-text">
                    open · {thread.windowMinutesLeft}m
                  </span>
                )}
              </div>
              <div className="mt-0.5 truncate text-xs text-muted">{thread.lastInboundText ?? "No reply yet"}</div>
            </div>
            <div className="shrink-0 text-right text-[11px] text-muted">
              <RelativeTime value={thread.lastInboundAt ?? thread.lastOutboundAt} />
            </div>
          </button>
        ))}
      </div>
      <ThreadDrawer id={openThread} onClose={() => setOpenThread(null)} onCompose={onCompose} />
    </>
  );
}

function ThreadDrawer({ id, onClose, onCompose }: { id: string | null; onClose: () => void; onCompose: (target: MessageTarget) => void }) {
  const qc = useQueryClient();
  const { data: thread } = useQuery({
    queryKey: ["message-thread", id],
    enabled: Boolean(id),
    queryFn: () => api.get<MessageThreadDetail>(`/messages/threads/${id}`),
  });

  const markRead = useMutation({
    mutationFn: () => api.post(`/messages/threads/${id}/read`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["message-threads"] });
      void qc.invalidateQueries({ queryKey: ["messaging-status"] });
    },
  });

  return (
    <Drawer
      open={Boolean(id)}
      onClose={onClose}
      title={thread?.lead?.companyName ?? thread?.name ?? thread?.display ?? "Conversation"}
      subtitle={thread ? `${thread.channel === "WHATSAPP" ? "WhatsApp" : "SMS"} · ${thread.display}` : undefined}
      footer={
        thread && (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs text-muted">
              {thread.suppressed
                ? `They asked not to be contacted — ${thread.suppressed}`
                : thread.channel === "SMS"
                  ? "A text costs money per 160 characters."
                  : thread.windowOpen
                    ? `You can write freely for another ${thread.windowMinutesLeft} minutes.`
                    : "Outside the window — only an approved template, or send by hand."}
            </div>
            <div className="flex gap-2">
              {thread.unreadCount > 0 && (
                <Button variant="secondary" onClick={() => markRead.mutate()}>
                  Mark read
                </Button>
              )}
              <Button
                disabled={Boolean(thread.suppressed)}
                onClick={() =>
                  onCompose({
                    leadId: thread.lead?.id ?? null,
                    clientId: thread.client?.id ?? null,
                    threadId: thread.id,
                    toPhone: thread.phone,
                    toName: thread.name,
                    channel: thread.channel,
                    purpose: "FOLLOW_UP",
                  })
                }
              >
                Reply
              </Button>
            </div>
          </div>
        )
      }
    >
      {thread && (
        <div className="space-y-3">
          {thread.messages.map((message) => (
            <div key={message.id} className={`flex ${message.direction === "INBOUND" ? "justify-start" : "justify-end"}`}>
              <div
                className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                  message.direction === "INBOUND" ? "bg-white border border-line" : "bg-ink text-white"
                }`}
              >
                <div className="whitespace-pre-wrap">{message.body}</div>
                <div className={`mt-1.5 font-mono text-[10px] uppercase tracking-[.1em] ${message.direction === "INBOUND" ? "text-muted" : "text-white/45"}`}>
                  {message.direction === "INBOUND" ? "Them" : STATUS_LABEL[message.status] ?? message.status.toLowerCase()}
                  {" · "}
                  <RelativeTime value={message.sentAt ?? message.createdAt} />
                  {message.templateName ? ` · template ${message.templateName}` : ""}
                </div>
                {message.error && <div className="mt-1 text-[11px] text-danger-light">{message.error}</div>}
              </div>
            </div>
          ))}
        </div>
      )}
    </Drawer>
  );
}

// --- Outbox ----------------------------------------------------------------

const STATUS_TONE: Record<string, "live" | "ok" | "warn" | "bad" | "idle"> = {
  SENT: "ok",
  DELIVERED: "ok",
  READ: "ok",
  SCHEDULED: "warn",
  READY: "warn",
  SENDING: "live",
  DRAFT: "idle",
  FAILED: "bad",
  CANCELLED: "idle",
};

const STATUS_LABEL: Record<string, string> = {
  READY: "waiting for you to send it",
  SENT: "sent",
  DELIVERED: "delivered",
  READ: "read",
  FAILED: "failed",
  SCHEDULED: "scheduled",
  DRAFT: "draft",
  CANCELLED: "cancelled",
};

function Outbox() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<MessageStatus | "">("");
  const { data: messages, isLoading } = useQuery({
    queryKey: ["messages", filter],
    queryFn: () => api.get<MessageRow[]>(`/messages${filter ? `?status=${filter}` : ""}`),
  });

  const send = useMutation({
    mutationFn: (id: string) => api.post<{ sent: boolean; reason?: string; link?: string }>(`/messages/${id}/send`),
    onSuccess: (result) => {
      void qc.invalidateQueries({ queryKey: ["messages"] });
      if (result.link) window.open(result.link, "_blank", "noopener");
    },
  });

  const markSent = useMutation({
    mutationFn: (id: string) => api.post(`/messages/${id}/mark-sent`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["messages"] }),
  });

  if (isLoading) return <div className="text-sm text-muted">Loading…</div>;

  return (
    <div className="space-y-4">
      <select className="filter-select" value={filter} onChange={(event) => setFilter(event.target.value as MessageStatus | "")}>
        <option value="">Everything</option>
        <option value="READY">To send by hand</option>
        <option value="SCHEDULED">Scheduled</option>
        <option value="SENT">Sent</option>
        <option value="FAILED">Failed</option>
      </select>

      {!messages?.length ? (
        <EmptyState message="Nothing here yet." />
      ) : (
        <div className="space-y-2">
          {messages.map((message) => (
            <div key={message.id} className="rounded-2xl border border-line bg-white px-4 py-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <StatusDot tone={STATUS_TONE[message.status] ?? "idle"} />
                    <span className="font-medium">{message.lead?.companyName ?? message.lead?.contactName ?? message.toName ?? message.display}</span>
                    <Badge tone="muted">{message.channel === "WHATSAPP" ? "WhatsApp" : "SMS"}</Badge>
                    <span className="font-mono text-[11px] text-muted">{message.display}</span>
                    {message.segments && message.segments > 1 && <Badge tone="warn">{message.segments} segments</Badge>}
                  </div>
                  <p className="mt-1.5 line-clamp-2 text-sm text-ink">{message.body}</p>
                  {message.error && <p className="mt-1 text-xs text-danger-text">{message.error}</p>}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="font-mono text-[10px] uppercase tracking-[.1em] text-muted">
                    {STATUS_LABEL[message.status] ?? message.status.toLowerCase()}
                  </span>
                  {message.status === "READY" && (
                    <>
                      <Button size="sm" variant="accent" onClick={() => send.mutate(message.id)}>
                        Open
                      </Button>
                      <Button size="sm" variant="secondary" onClick={() => markSent.mutate(message.id)}>
                        I sent it
                      </Button>
                    </>
                  )}
                  {(message.status === "DRAFT" || message.status === "FAILED") && (
                    <Button size="sm" variant="secondary" onClick={() => send.mutate(message.id)}>
                      Send
                    </Button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// --- Templates -------------------------------------------------------------

/**
 * The templates Meta has approved.
 *
 * The panel that explains the constraint rather than hiding it: a first
 * WhatsApp to somebody who has never written to us is *always* a template, and
 * a template is always reviewed by Meta first. The starters are one-click
 * submissions written to the playbook, so the wait starts today rather than
 * after somebody works out what Meta will accept.
 */
function Templates() {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<string | null>(null);

  const { data } = useQuery({
    queryKey: ["whatsapp-templates"],
    queryFn: () => api.get<{ templates: WhatsAppTemplateRow[]; starters: StarterTemplate[]; configured: boolean }>("/messages/templates"),
  });

  const sync = useMutation({
    mutationFn: () => api.post<{ synced: number; approved: number }>("/messages/templates/sync"),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["whatsapp-templates"] }),
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
  });

  const submit = useMutation({
    mutationFn: (starter: StarterTemplate) =>
      api.post("/messages/templates", {
        name: starter.name,
        category: starter.category,
        body: starter.body,
        footer: starter.footer,
        examples: starter.examples,
      }),
    onSuccess: () => {
      setSubmitting(null);
      setError(null);
      void qc.invalidateQueries({ queryKey: ["whatsapp-templates"] });
    },
    onError: (err) => {
      setSubmitting(null);
      setError(err instanceof ApiError ? err.message : String(err));
    },
  });

  const existing = new Set((data?.templates ?? []).map((template) => template.name));

  return (
    <div className="space-y-6">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-2xl">
            <div className="font-medium">A first WhatsApp is always a template.</div>
            <p className="mt-1 text-sm text-muted">
              WhatsApp lets a business write freely only within 24 hours of the other person's last message. A lead who has never written to us
              has never opened that window, so a cold approach can only go out as a template Meta approved beforehand — usually minutes, sometimes
              a day. Until one is approved, send by hand from your own WhatsApp instead; it needs no approval and arrives from a person.
            </p>
          </div>
          <Button variant="secondary" onClick={() => sync.mutate()} disabled={!data?.configured || sync.isPending}>
            {sync.isPending ? "Syncing…" : "Sync from Meta"}
          </Button>
        </div>
      </Card>

      {error && <div className="rounded-xl border border-danger-line bg-danger-surface px-3.5 py-2.5 text-sm text-danger-text">{error}</div>}

      {data?.templates.length ? (
        <div className="space-y-2">
          {data.templates.map((template) => (
            <div key={template.id} className="rounded-2xl border border-line bg-white px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-sm">{template.name}</span>
                <Badge tone={template.status === "APPROVED" ? "positive" : template.status === "REJECTED" ? "warn" : "muted"}>
                  {template.status.toLowerCase()}
                </Badge>
                <Badge tone="muted">{template.category.toLowerCase()}</Badge>
                <span className="text-[11px] text-muted">{template.language}</span>
              </div>
              <p className="mt-2 whitespace-pre-wrap text-sm text-ink">{template.body}</p>
              {template.rejectionReason && (
                <p className="mt-2 text-xs text-warn-text">Meta's reason: {template.rejectionReason}</p>
              )}
            </div>
          ))}
        </div>
      ) : (
        <EmptyState message="No templates yet. Submit one of the starters below — Meta reviews it, and until it comes back you can still send by hand." />
      )}

      <div>
        <div className="mb-3 font-mono text-[10px] uppercase tracking-[.14em] text-muted">Ready to submit</div>
        <div className="grid gap-3 md:grid-cols-2">
          {(data?.starters ?? []).map((starter) => (
            <div key={starter.name} className="rounded-2xl border border-line bg-white p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="font-medium">{starter.label}</div>
                <Badge tone="muted">{starter.category.toLowerCase()}</Badge>
              </div>
              <p className="mt-2 whitespace-pre-wrap text-sm text-muted">{starter.body}</p>
              <p className="mt-2 text-xs text-muted">{starter.footer}</p>
              <div className="mt-3 flex items-center justify-between gap-3">
                <div className="text-[11px] text-muted">{starter.variables.join(" · ")}</div>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!data?.configured || existing.has(starter.name) || submitting === starter.name}
                  onClick={() => {
                    setSubmitting(starter.name);
                    submit.mutate(starter);
                  }}
                >
                  {existing.has(starter.name) ? "Submitted" : submitting === starter.name ? "Submitting…" : "Submit to Meta"}
                </Button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// --- Opted out -------------------------------------------------------------

function Suppression() {
  const qc = useQueryClient();
  const { data: rows } = useQuery({ queryKey: ["message-suppression"], queryFn: () => api.get<MessageSuppressionRow[]>("/messages/suppression") });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/messages/suppression/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["message-suppression"] }),
  });

  if (!rows?.length) return <EmptyState message="Nobody has asked to be left alone. Anyone who replies STOP lands here automatically, on both channels at once." />;

  return (
    <Table>
      <thead>
        <tr className="border-b border-line font-mono text-[10px] uppercase tracking-[.12em] text-muted">
          <th className="px-4 py-3 font-normal">Number</th>
          <th className="px-4 py-3 font-normal">Why</th>
          <th className="px-4 py-3 font-normal">When</th>
          <th className="px-4 py-3" />
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id} className="border-b border-line/60 last:border-0">
            <td className="px-4 py-3 font-mono text-[12px]">{row.display}</td>
            <td className="px-4 py-3 text-sm">{row.reason}</td>
            <td className="px-4 py-3 text-xs text-muted">
              <RelativeTime value={row.createdAt} />
            </td>
            <td className="px-4 py-3 text-right">
              <Button size="sm" variant="ghost" onClick={() => remove.mutate(row.id)} title="Only if they have asked to hear from you again.">
                Remove
              </Button>
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
