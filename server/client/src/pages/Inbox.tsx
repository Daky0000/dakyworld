import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import type { AgentList, InboxMessageDetail, InboxMessageRow, InboxStatus, InboxSyncResult, MailIntent, MailThreadDetail, MailThreadRow } from "../lib/types";
import { Badge, Button, Card, Drawer, EmptyState, PageHeader, RelativeTime, StatTile, StatusDot, Table } from "../components/ui";

type Tab = "open" | "conversations" | "all";

/**
 * What arrived.
 *
 * The counterpart to the Email screen, which is the outbox. That one answers
 * "what have we sent"; this one answers **"what is still owed a reply"**, which
 * is a to-do list rather than a log — so it opens on the messages nobody has
 * dealt with, sorted by how urgent they are rather than by how new.
 *
 * Three things on this screen are deliberately visible rather than hidden:
 *
 *  - **Who a message was given to**, and when it was given to nobody, who it
 *    *would* have gone to and why not. A routing decision nobody can see is a
 *    routing decision nobody can correct.
 *  - **What the mail room did without being asked** — a stopped sequence, a
 *    suppressed address — because those happen whether or not a model ran.
 *  - **What it could not read.** A message that failed triage says so rather
 *    than sitting in the list looking ordinary, which is how a missing model
 *    key gets noticed on the day it starts mattering.
 */
export function Inbox() {
  const [tab, setTab] = useState<Tab>("open");
  const [openMessage, setOpenMessage] = useState<string | null>(null);
  const [openThread, setOpenThread] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const { data: status } = useQuery({
    queryKey: ["inbox-status"],
    queryFn: () => api.get<InboxStatus>("/inbox/status"),
    refetchInterval: 30_000,
  });

  const { data: messages, isLoading } = useQuery({
    queryKey: ["inbox", tab],
    queryFn: () => api.get<InboxMessageRow[]>(`/inbox?openOnly=${tab === "open" ? "true" : "false"}`),
    enabled: tab !== "conversations",
  });

  const { data: threads } = useQuery({
    queryKey: ["inbox-threads"],
    queryFn: () => api.get<MailThreadRow[]>("/inbox/threads"),
    enabled: tab === "conversations",
  });

  const sync = useMutation({
    mutationFn: () => api.post<InboxSyncResult>("/inbox/sync"),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["inbox"] });
      void queryClient.invalidateQueries({ queryKey: ["inbox-threads"] });
      void queryClient.invalidateQueries({ queryKey: ["inbox-status"] });
    },
  });

  const watcher = status?.watcher;

  return (
    <div>
      <PageHeader
        title="Inbox"
        subtitle="What arrived, who it belongs to, and what is still owed a reply."
        action={
          <Button onClick={() => sync.mutate()} disabled={sync.isPending || !status?.connected}>
            {sync.isPending ? "Reading…" : "Read now"}
          </Button>
        }
      />

      {status && !status.connected && (
        <Card className="mb-6 border-amber-300 bg-amber-50">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="font-medium text-ink">No mailbox is connected for reading.</p>
              <p className="text-sm text-muted">
                Sending works on its own; reading is a separate connection. It is usually the same password you already pasted in.
              </p>
            </div>
            <Link to="/settings" className="text-sm font-medium text-blue underline">
              Connect it under Settings → Email
            </Link>
          </div>
        </Card>
      )}

      {sync.error && (
        <Card className="mb-6 border-red-300 bg-red-50">
          <p className="text-sm text-red-800">{(sync.error as ApiError).message}</p>
        </Card>
      )}

      {sync.data && (
        <Card className="mb-6">
          <p className="text-sm text-ink">
            Read {sync.data.read} new message{sync.data.read === 1 ? "" : "s"}
            {sync.data.routed > 0 ? `, ${sync.data.routed} handed to an agent` : ""}.
          </p>
          {sync.data.notes.length > 0 && (
            <ul className="mt-2 space-y-1 text-sm text-muted">
              {sync.data.notes.slice(0, 8).map((note, index) => (
                <li key={index}>· {note}</li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {status && (
        <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile label="Owed a reply" value={status.open} sub={status.mailbox ?? "not connected"} />
          <StatTile label="Handed to an agent" value={status.counts.ROUTED ?? 0} sub={status.autoRoute ? "routing is on" : "routing is off"} />
          <StatTile label="Read but unrouted" value={status.waiting} sub="waiting for you" />
          <StatTile
            label="Live connection"
            value={
              <span className="flex items-center gap-2">
                <StatusDot tone={watcher?.connected ? "live" : status.connected ? "warn" : "idle"} />
                {watcher?.connected ? "Connected" : status.connected ? "Polling" : "Off"}
              </span>
            }
            sub={
              watcher?.connected ? (
                <>
                  last push <RelativeTime value={watcher.lastPushAt} />
                </>
              ) : (
                (watcher?.lastError ?? "reads on the minute")
              )
            }
          />
        </div>
      )}

      <div className="mb-4 flex gap-2">
        {(
          [
            ["open", "Owed a reply"],
            ["conversations", "Conversations"],
            ["all", "Everything"],
          ] as [Tab, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`rounded-full px-4 py-1.5 text-sm font-medium transition ${
              tab === key ? "bg-ink text-cream" : "bg-white text-muted hover:text-ink"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "conversations" ? (
        <ThreadList threads={threads ?? []} onOpen={setOpenThread} />
      ) : (
        <MessageList messages={messages ?? []} loading={isLoading} onOpen={setOpenMessage} />
      )}

      {openMessage && <MessageDrawer id={openMessage} onClose={() => setOpenMessage(null)} />}
      {openThread && <ThreadDrawer id={openThread} onClose={() => setOpenThread(null)} onOpenMessage={setOpenMessage} />}
    </div>
  );
}

/** The label a person reads, rather than the enum. */
const INTENT_LABEL: Record<MailIntent, string> = {
  INTERESTED: "Interested",
  NOT_INTERESTED: "Not interested",
  QUESTION: "A question",
  MEETING_REQUEST: "Wants to talk",
  PROPOSAL_FEEDBACK: "About a proposal",
  SUPPORT_ISSUE: "Something is wrong",
  INVOICE_QUERY: "About an invoice",
  PAYMENT_NOTICE: "Says they have paid",
  NEW_ENQUIRY: "New enquiry",
  SUPPLIER: "A supplier",
  UNSUBSCRIBE: "Asked to be removed",
  AUTO_REPLY: "Sent by a machine",
  BOUNCE: "Delivery failure",
  SPAM: "Junk",
  PERSONAL: "Not business",
  OTHER: "Unclear",
};

const WARM = new Set<MailIntent>(["INTERESTED", "NEW_ENQUIRY", "MEETING_REQUEST", "PAYMENT_NOTICE"]);
const COLD = new Set<MailIntent>(["SPAM", "AUTO_REPLY", "BOUNCE", "PERSONAL", "SUPPLIER", "NOT_INTERESTED"]);

function IntentBadge({ intent }: { intent: MailIntent | null }) {
  if (!intent) return <Badge tone="muted">Not read</Badge>;
  return <Badge tone={WARM.has(intent) ? "positive" : COLD.has(intent) ? "muted" : "default"}>{INTENT_LABEL[intent]}</Badge>;
}

function MessageList({ messages, loading, onOpen }: { messages: InboxMessageRow[]; loading: boolean; onOpen: (id: string) => void }) {
  if (loading) return <Card>Reading…</Card>;
  if (messages.length === 0) {
    return <EmptyState message="Nothing is waiting on you. Either the post is answered, or the mailbox has not been read yet." />;
  }

  return (
    <Card>
      <Table>
        <thead>
          <tr>
            <th>From</th>
            <th>What it is</th>
            <th>What they want</th>
            <th>Owner</th>
            <th>Arrived</th>
          </tr>
        </thead>
        <tbody>
          {messages.map((message) => (
            <tr key={message.id} className="cursor-pointer hover:bg-cream" onClick={() => onOpen(message.id)}>
              <td>
                <div className="font-medium text-ink">{message.from}</div>
                <div className="text-sm text-muted">{message.subject}</div>
                {(message.lead || message.client) && (
                  <div className="mt-1 text-xs text-muted">
                    {message.client ? `Client · ${message.client.company ?? message.client.name}` : null}
                    {!message.client && message.lead ? `Lead · ${message.lead.companyName ?? message.lead.contactName}` : null}
                  </div>
                )}
              </td>
              <td>
                <IntentBadge intent={message.intent} />
                {message.urgency === 1 && (
                  <div className="mt-1">
                    <Badge tone="warn">Today</Badge>
                  </div>
                )}
                {message.status === "FAILED" && (
                  <div className="mt-1">
                    <Badge tone="warn">Not read</Badge>
                  </div>
                )}
              </td>
              <td className="max-w-sm text-sm text-muted">{message.summary ?? message.snippet}</td>
              <td className="text-sm">
                {message.routedTo ? (
                  <span className="font-medium text-ink">{message.routedTo}</span>
                ) : (
                  <span className="text-muted">
                    {message.wouldGoTo?.agentKey ? `nobody yet — would be ${message.wouldGoTo.agentKey}` : "nobody"}
                  </span>
                )}
              </td>
              <td className="whitespace-nowrap text-sm text-muted">
                <RelativeTime value={message.receivedAt} />
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}

function ThreadList({ threads, onOpen }: { threads: MailThreadRow[]; onOpen: (id: string) => void }) {
  if (threads.length === 0) return <EmptyState message="No conversations yet." />;
  return (
    <Card>
      <Table>
        <thead>
          <tr>
            <th>With</th>
            <th>Subject</th>
            <th>Last</th>
            <th>Messages</th>
            <th>Waiting on</th>
          </tr>
        </thead>
        <tbody>
          {threads.map((thread) => {
            // A conversation whose last message is theirs is one we owe an
            // answer to. That is the only fact this column is stating.
            const oursNext =
              thread.lastInboundAt !== null && (thread.lastOutboundAt === null || thread.lastInboundAt > thread.lastOutboundAt);
            return (
              <tr key={thread.id} className="cursor-pointer hover:bg-cream" onClick={() => onOpen(thread.id)}>
                <td>
                  <div className="font-medium text-ink">{thread.counterpartName ?? thread.counterpartEmail}</div>
                  <div className="text-sm text-muted">{thread.counterpartEmail}</div>
                </td>
                <td className="max-w-sm">
                  <div className="text-ink">{thread.subject}</div>
                  <div className="truncate text-sm text-muted">{thread.lastSnippet}</div>
                </td>
                <td className="whitespace-nowrap text-sm text-muted">
                  <RelativeTime value={thread.lastMessageAt} />
                </td>
                <td className="text-sm text-muted">{thread.messageCount}</td>
                <td>{oursNext ? <Badge tone="warn">Us</Badge> : <Badge tone="muted">Them</Badge>}</td>
              </tr>
            );
          })}
        </tbody>
      </Table>
    </Card>
  );
}

function MessageDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [note, setNote] = useState("");
  const [agentKey, setAgentKey] = useState("");
  const [why, setWhy] = useState("");

  const { data: message } = useQuery({ queryKey: ["inbox-message", id], queryFn: () => api.get<InboxMessageDetail>(`/inbox/${id}`) });
  const { data: roster } = useQuery({ queryKey: ["agents"], queryFn: () => api.get<AgentList>("/agents") });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["inbox"] });
    void queryClient.invalidateQueries({ queryKey: ["inbox-message", id] });
    void queryClient.invalidateQueries({ queryKey: ["inbox-status"] });
  };

  const handled = useMutation({
    mutationFn: (ignored: boolean) => api.post(`/inbox/${id}/handled`, { note: note || "Dealt with.", ignored }),
    onSuccess: () => {
      refresh();
      onClose();
    },
  });

  const route = useMutation({
    mutationFn: () => api.post(`/inbox/${id}/route`, { agentKey, why }),
    onSuccess: refresh,
  });

  const reread = useMutation({ mutationFn: () => api.post(`/inbox/${id}/retriage`), onSuccess: refresh });

  return (
    <Drawer open onClose={onClose} title={message?.subject ?? "Message"}>
      {!message ? (
        <p className="text-muted">Opening…</p>
      ) : (
        <div className="space-y-6">
          <div>
            <p className="font-medium text-ink">
              {message.fromName ? `${message.fromName} <${message.fromEmail}>` : message.fromEmail}
            </p>
            <p className="text-sm text-muted">
              {new Date(message.sentAt).toLocaleString()} · to {message.toEmails.join(", ") || "—"}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <IntentBadge intent={message.intent} />
              {message.autoSubmitted && <Badge tone="muted">A machine sent this</Badge>}
              {message.confidence !== null && <span className="text-xs text-muted">{Math.round(message.confidence * 100)}% sure</span>}
              {message.handledAt && <Badge tone="positive">Closed</Badge>}
            </div>
          </div>

          {message.summary && (
            <Card>
              <p className="text-sm text-ink">{message.summary}</p>
            </Card>
          )}

          {message.triageError && (
            <Card className="border-amber-300 bg-amber-50">
              <p className="text-sm text-amber-900">This one was filed but never read: {message.triageError}</p>
            </Card>
          )}

          <div>
            <h4 className="mb-2 text-sm font-medium text-muted">What they wrote</h4>
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-lg bg-cream p-4 text-sm text-ink">{message.bodyText}</pre>
          </div>

          {message.hasAttachments && (
            <div>
              <h4 className="mb-2 text-sm font-medium text-muted">Attached</h4>
              <ul className="space-y-1 text-sm text-muted">
                {message.attachments.map((file) => (
                  <li key={file.filename}>
                    {file.filename} · {Math.round(file.size / 1024)} KB
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-xs text-muted">Files stay in the mailbox — only their names are stored here.</p>
            </div>
          )}

          <div className="grid gap-3 text-sm sm:grid-cols-2">
            {message.lead && (
              <div>
                <span className="text-muted">Lead</span>
                <div className="text-ink">{message.lead.companyName ?? message.lead.contactName}</div>
              </div>
            )}
            {message.client && (
              <div>
                <span className="text-muted">Client</span>
                <Link to={`/clients/${message.client.id}`} className="block text-blue underline">
                  {message.client.company ?? message.client.name}
                </Link>
              </div>
            )}
            {message.replyToEmail && (
              <div className="sm:col-span-2">
                <span className="text-muted">Answers an email we sent</span>
                <div className="text-ink">{message.replyToEmail.subject}</div>
              </div>
            )}
            {message.taskId && (
              <div className="sm:col-span-2">
                <span className="text-muted">Handed to</span>
                <div className="text-ink">
                  {message.routedAgentKey} ·{" "}
                  <Link to="/agents" className="text-blue underline">
                    see the task
                  </Link>
                </div>
              </div>
            )}
          </div>

          {!message.taskId && (
            <Card>
              <h4 className="mb-3 text-sm font-medium text-ink">Give it to somebody</h4>
              <select
                value={agentKey}
                onChange={(event) => setAgentKey(event.target.value)}
                className="mb-2 w-full rounded-lg border border-line px-3 py-2 text-sm"
              >
                <option value="">Choose an agent…</option>
                {(roster?.agents ?? [])
                  .filter((agent) => agent.status === "ACTIVE")
                  .map((agent) => (
                    <option key={agent.key} value={agent.key}>
                      {agent.name} — {agent.title}
                    </option>
                  ))}
              </select>
              <input
                value={why}
                onChange={(event) => setWhy(event.target.value)}
                placeholder="Why is this theirs? (goes on the task)"
                className="mb-2 w-full rounded-lg border border-line px-3 py-2 text-sm"
              />
              <Button onClick={() => route.mutate()} disabled={!agentKey || why.trim().length < 10 || route.isPending}>
                {route.isPending ? "Handing over…" : "Hand it over"}
              </Button>
              {route.error && <p className="mt-2 text-sm text-red-700">{(route.error as ApiError).message}</p>}
            </Card>
          )}

          <Card>
            <h4 className="mb-3 text-sm font-medium text-ink">Close it</h4>
            <input
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="What happened?"
              className="mb-2 w-full rounded-lg border border-line px-3 py-2 text-sm"
            />
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => handled.mutate(false)} disabled={handled.isPending}>
                Dealt with
              </Button>
              <Button variant="ghost" onClick={() => handled.mutate(true)} disabled={handled.isPending}>
                Ignore it
              </Button>
              <Button variant="ghost" onClick={() => reread.mutate()} disabled={reread.isPending}>
                {reread.isPending ? "Reading…" : "Read it again"}
              </Button>
            </div>
            {reread.error && <p className="mt-2 text-sm text-red-700">{(reread.error as ApiError).message}</p>}
          </Card>
        </div>
      )}
    </Drawer>
  );
}

function ThreadDrawer({ id, onClose, onOpenMessage }: { id: string; onClose: () => void; onOpenMessage: (id: string) => void }) {
  const { data: thread } = useQuery({ queryKey: ["inbox-thread", id], queryFn: () => api.get<MailThreadDetail>(`/inbox/threads/${id}`) });

  return (
    <Drawer open onClose={onClose} title={thread?.subject ?? "Conversation"}>
      {!thread ? (
        <p className="text-muted">Opening…</p>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-muted">
            With {thread.counterpartName ?? thread.counterpartEmail} · {thread.messageCount} messages
          </p>
          {thread.messages.map((message) => (
            <Card key={message.id} className={message.direction === "OUTBOUND" ? "border-blue/30 bg-blue/5" : ""}>
              <div className="mb-2 flex items-center justify-between gap-3">
                <span className="text-sm font-medium text-ink">
                  {message.direction === "OUTBOUND" ? "Us" : (message.fromName ?? message.fromEmail)}
                </span>
                <span className="text-xs text-muted">{new Date(message.sentAt).toLocaleString()}</span>
              </div>
              <p className="whitespace-pre-wrap text-sm text-ink">{message.bodyText.slice(0, 1200)}</p>
              {message.direction === "INBOUND" && (
                <button onClick={() => onOpenMessage(message.id)} className="mt-2 text-sm text-blue underline">
                  Open it
                </button>
              )}
            </Card>
          ))}
        </div>
      )}
    </Drawer>
  );
}
