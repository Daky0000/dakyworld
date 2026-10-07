import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { setPageTitle } from "../lib/surface";
import { useWebsiteSites } from "../components/WebsiteGuard";
import { Button, EmptyState, PageHeader, RelativeTime } from "../components/ui";

/**
 * Messages people sent through the forms on a website DakyX hosts
 * (server: services/websiteForms.ts). Each one also arrives by email to the
 * site's managers; this is where they are kept, read and answered from.
 */
type Message = {
  id: string;
  pagePath: string;
  formName: string | null;
  fields: Record<string, string>;
  email: string | null;
  spam: boolean;
  readAt: string | null;
  createdAt: string;
};
type Inbox = { messages: Message[]; nextCursor: string | null; unread: number; spam: number };

const message = (error: unknown) => (error instanceof ApiError || error instanceof Error ? error.message : "Something went wrong.");

/** The line a person would recognise the message by. */
function summary(entry: Message): { who: string; what: string } {
  const values = Object.entries(entry.fields);
  const name = values.find(([key]) => /name/i.test(key))?.[1];
  const body = values.find(([key]) => /message|comment|enquiry|inquiry|details|note/i.test(key))?.[1] ?? values.find(([, value]) => value.length > 30)?.[1] ?? values[0]?.[1] ?? "";
  return { who: name || entry.email || "Someone", what: body.replace(/\s+/g, " ").slice(0, 140) };
}

export function WebsiteInbox() {
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const sites = useWebsiteSites();
  const managed = useMemo(() => (sites.data ?? []).filter((site) => site.capabilities?.manage), [sites.data]);
  const siteId = managed.some((site) => site.id === params.get("site")) ? params.get("site")! : managed[0]?.id;
  const site = managed.find((item) => item.id === siteId);
  const [box, setBox] = useState<"inbox" | "spam">("inbox");
  const [open, setOpen] = useState<string | null>(params.get("message"));
  useEffect(() => setPageTitle("Form inbox"), []);

  const inbox = useQuery({
    queryKey: ["website", "forms", siteId, box],
    enabled: Boolean(siteId),
    queryFn: ({ signal }) => api.get<Inbox>(`/website/sites/${encodeURIComponent(siteId!)}/forms?box=${box}`, signal),
    refetchInterval: 60_000,
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: ["website", "forms", siteId] });
  const change = useMutation({
    mutationFn: ({ id, ...body }: { id: string; read?: boolean; spam?: boolean }) => api.patch(`/website/sites/${encodeURIComponent(siteId!)}/forms/${encodeURIComponent(id)}`, body),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/website/sites/${encodeURIComponent(siteId!)}/forms/${encodeURIComponent(id)}`),
    onSuccess: () => { setOpen(null); refresh(); },
  });

  // Opening an unread message reads it.
  useEffect(() => {
    const entry = inbox.data?.messages.find((item) => item.id === open);
    if (entry && !entry.readAt && !entry.spam) change.mutate({ id: entry.id, read: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, inbox.data]);

  if (sites.isLoading) return <p className="text-sm text-muted" role="status">Loading…</p>;
  if (!managed.length) {
    return (
      <div>
        <PageHeader title="Form inbox" subtitle="Messages from the forms on your website." />
        <EmptyState message="Only a website's managers can read its messages. Ask a manager to give you that role if you need to." />
      </div>
    );
  }

  return (
    <div className="max-w-4xl">
      <PageHeader
        title="Form inbox"
        eyebrow={site?.name}
        subtitle="When somebody fills in a form on your website, the message arrives here and by email to the website's managers."
      />
      {managed.length > 1 && (
        <label className="mb-5 block max-w-sm text-xs text-muted">
          Website
          <select className="input mt-1" value={siteId} onChange={(event) => { setParams({ site: event.target.value }); setOpen(null); }}>
            {managed.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
      )}
      <div role="tablist" aria-label="Messages" className="mb-4 flex gap-2">
        {(["inbox", "spam"] as const).map((key) => (
          <button
            key={key}
            role="tab"
            aria-selected={box === key}
            type="button"
            onClick={() => { setBox(key); setOpen(null); }}
            className={`rounded-full border px-3 py-1.5 text-xs font-semibold ${box === key ? "border-ink bg-ink text-cream" : "border-line text-muted hover:text-ink"}`}
          >
            {key === "inbox" ? `Inbox${inbox.data?.unread ? ` · ${inbox.data.unread} new` : ""}` : `Spam${inbox.data?.spam ? ` · ${inbox.data.spam}` : ""}`}
          </button>
        ))}
      </div>

      {inbox.isLoading && <p className="text-sm text-muted" role="status">Loading messages…</p>}
      {inbox.error && <p role="alert" className="rounded-xl border border-danger-line bg-danger-surface p-3 text-sm text-danger-text">{message(inbox.error)}</p>}
      {inbox.data && inbox.data.messages.length === 0 && (
        <EmptyState
          message={
            box === "spam"
              ? "Nothing in spam. Messages a robot filled in land here instead of in your inbox, and are not emailed to you."
              : site?.hosted
                ? "No messages yet. A contact or booking form on your website sends its messages here once the page is published."
                : "No messages yet. This website is not hosted by DakyX, so its forms send wherever its developer set them up; the inbox collects forms on websites DakyX hosts."
          }
        />
      )}
      {inbox.data && inbox.data.messages.length > 0 && (
        <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-white">
          {inbox.data.messages.map((entry) => {
            const { who, what } = summary(entry);
            const expanded = open === entry.id;
            return (
              <li key={entry.id}>
                <button
                  type="button"
                  aria-expanded={expanded}
                  onClick={() => setOpen(expanded ? null : entry.id)}
                  className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-sunken"
                >
                  <span aria-hidden className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${entry.readAt || entry.spam ? "bg-transparent" : "bg-blue"}`} />
                  <span className="min-w-0 flex-1">
                    <span className={`block truncate text-sm ${entry.readAt ? "text-ink" : "font-semibold text-ink"}`}>{who}</span>
                    <span className="block truncate text-xs text-muted">{what}</span>
                  </span>
                  <span className="shrink-0 text-xs text-muted"><RelativeTime value={entry.createdAt} /></span>
                  {!entry.readAt && !entry.spam && <span className="sr-only">Unread.</span>}
                </button>
                {expanded && (
                  <div className="border-t border-line bg-sunken/40 px-4 py-4">
                    <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[160px_1fr]">
                      {Object.entries(entry.fields).map(([key, value]) => (
                        <div key={key} className="contents">
                          <dt className="text-xs text-muted">{key}</dt>
                          <dd className="whitespace-pre-wrap break-words text-ink">{value || "—"}</dd>
                        </div>
                      ))}
                    </dl>
                    <p className="mt-3 text-xs text-muted">
                      Sent from {entry.pagePath}{entry.formName ? ` · form “${entry.formName}”` : ""}
                    </p>
                    <div className="mt-4 flex flex-wrap gap-2">
                      {entry.email && (
                        <a
                          className="inline-flex h-9 items-center rounded-xl bg-ink px-3 text-xs font-semibold text-white hover:bg-ink/85"
                          href={`mailto:${entry.email}?subject=${encodeURIComponent(`Re: your message to ${site?.name ?? "us"}`)}`}
                        >
                          Reply by email
                        </a>
                      )}
                      {!entry.spam && entry.readAt && (
                        <Button size="sm" variant="secondary" disabled={change.isPending} onClick={() => change.mutate({ id: entry.id, read: false })}>Mark as unread</Button>
                      )}
                      <Button size="sm" variant="secondary" disabled={change.isPending} onClick={() => { change.mutate({ id: entry.id, spam: !entry.spam }); setOpen(null); }}>
                        {entry.spam ? "Not spam" : "Spam"}
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={remove.isPending}
                        onClick={() => { if (window.confirm("Delete this message? It cannot be brought back.")) remove.mutate(entry.id); }}
                      >
                        Delete
                      </Button>
                    </div>
                    {(change.error || remove.error) && <p role="alert" className="mt-2 text-xs text-danger-text">{message(change.error ?? remove.error)}</p>}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
