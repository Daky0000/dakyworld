import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { api } from "../lib/api";
import { Button } from "./ui";

/**
 * Sending a draft to the person a website is built for, and seeing what they
 * said — the editor's half of `services/websiteReviewLinks.ts`.
 *
 * The link is shown once, when it is made: only its hash is stored, so a lost
 * link is replaced by sending a new one, never recovered. A WhatsApp button sits
 * beside Copy because that is how most of these links will actually travel.
 */

export type ReviewLinkView = {
  id: string;
  title: string;
  status: "PENDING" | "APPROVED" | "CHANGES_REQUESTED" | "WITHDRAWN";
  expired: boolean;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  reviewerName: string | null;
  reviewerEmail: string | null;
  feedback: string | null;
  stale: boolean;
  commentCount: number;
};

type ReviewCommentView = {
  id: string;
  authorName: string;
  body: string;
  anchorLabel: string | null;
  resolved: boolean;
  createdAt: string;
};

const dateFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });

export function reviewStatusLabel(link: Pick<ReviewLinkView, "status" | "expired" | "stale">): { text: string; tone: "positive" | "warn" | "muted" | "info" } {
  if (link.status === "APPROVED") return { text: link.stale ? "Approved an earlier draft" : "Approved", tone: link.stale ? "warn" : "positive" };
  if (link.status === "CHANGES_REQUESTED") return { text: "Changes requested", tone: "warn" };
  if (link.status === "WITHDRAWN") return { text: "Withdrawn", tone: "muted" };
  if (link.expired) return { text: "Expired", tone: "muted" };
  return { text: "Waiting for an answer", tone: "info" };
}

const TONE: Record<"positive" | "warn" | "muted" | "info", string> = {
  positive: "bg-positive-surface text-positive-text",
  warn: "bg-warn-surface text-warn-text",
  muted: "bg-sunken text-muted",
  info: "bg-info-surface text-info-text",
};

export function useReviewLinks(pageId: string) {
  return useQuery({
    queryKey: ["website", "review-links", pageId],
    queryFn: ({ signal }) => api.get<{ links: ReviewLinkView[] }>(`/website/pages/${pageId}/review-links`, signal),
    refetchInterval: 60_000,
  });
}

export function WebsiteReviewLinks({ pageId, hasDraft, canEdit }: { pageId: string; hasDraft: boolean; canEdit: boolean }) {
  const qc = useQueryClient();
  const links = useReviewLinks(pageId);
  const [reviewerName, setReviewerName] = useState("");
  const [reviewerEmail, setReviewerEmail] = useState("");
  const [days, setDays] = useState(14);
  const [made, setMade] = useState<{ url: string; emailed: boolean } | null>(null);
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => api.post<{ link: ReviewLinkView; url: string; emailed: boolean }>(`/website/pages/${pageId}/review-links`, {
      expiresInDays: days,
      ...(reviewerName.trim() ? { reviewerName: reviewerName.trim() } : {}),
      ...(reviewerEmail.trim() ? { reviewerEmail: reviewerEmail.trim() } : {}),
    }),
    onSuccess: (result) => {
      setMade({ url: result.url, emailed: result.emailed });
      void qc.invalidateQueries({ queryKey: ["website", "review-links", pageId] });
    },
  });

  const withdraw = useMutation({
    mutationFn: (linkId: string) => api.post(`/website/pages/${pageId}/review-links/${linkId}/withdraw`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["website", "review-links", pageId] }),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setMade(null);
    create.mutate();
  };

  const copy = async (url: string) => {
    try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 2500); } catch { /* the field is selectable */ }
  };

  return (
    <div className="space-y-5" data-tour="review-links">
      {canEdit && (
        <form onSubmit={submit} className="rounded-xl border border-line bg-white p-4">
          <h3 className="font-display text-base font-medium text-ink">Send these changes for approval</h3>
          <p className="mt-1 text-xs leading-relaxed text-muted">
            The person you send it to sees the page with your unpublished changes, can leave comments on it and approve it or ask for
            changes — without an account. Nothing is published until you publish it.
          </p>
          {!hasDraft ? (
            <p className="mt-3 rounded-lg bg-sunken px-3 py-2 text-xs text-muted">There are no unpublished changes on this page yet. Make your changes first, then send them.</p>
          ) : (
            <>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <label className="text-xs font-semibold text-muted">
                  Their name <span className="font-normal">(optional)</span>
                  <input className="input mt-1" value={reviewerName} onChange={(event) => setReviewerName(event.target.value)} maxLength={100} />
                </label>
                <label className="text-xs font-semibold text-muted">
                  Their email <span className="font-normal">(optional — we email the link)</span>
                  <input className="input mt-1" type="email" value={reviewerEmail} onChange={(event) => setReviewerEmail(event.target.value)} maxLength={200} />
                </label>
              </div>
              <label className="mt-3 block text-xs font-semibold text-muted">
                Link works for
                <select className="input mt-1 max-w-[12rem]" value={days} onChange={(event) => setDays(Number(event.target.value))}>
                  {[3, 7, 14, 30].map((value) => <option key={value} value={value}>{value} days</option>)}
                </select>
              </label>
              {create.isError && <p role="alert" className="mt-2 text-xs text-warn-text">{(create.error as Error).message}</p>}
              <Button type="submit" className="mt-3" disabled={create.isPending}>{create.isPending ? "Making the link…" : "Make a review link"}</Button>
            </>
          )}
          {made && (
            <div role="status" className="mt-4 rounded-xl border border-info-line bg-info-surface p-3">
              <p className="text-xs font-semibold text-info-text">
                {made.emailed ? "Emailed, and here is the link to share another way:" : "Here is the link. It is only shown now — copy it before you close this."}
              </p>
              <input className="input mt-2 font-mono text-xs" readOnly value={made.url} onFocus={(event) => event.currentTarget.select()} aria-label="Review link" />
              <div className="mt-2 flex flex-wrap gap-2">
                <Button type="button" size="sm" onClick={() => void copy(made.url)}>{copied ? "Copied" : "Copy link"}</Button>
                <a
                  className="inline-flex items-center rounded-full border border-line bg-white px-3 py-1.5 text-xs font-semibold text-ink hover:border-line-strong"
                  href={`https://wa.me/?text=${encodeURIComponent(`Please take a look at the changes to the website and approve them or tell me what to change: ${made.url}`)}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Share on WhatsApp
                </a>
              </div>
            </div>
          )}
        </form>
      )}

      <section>
        <h3 className="font-display text-base font-medium text-ink">Sent for approval</h3>
        {links.isLoading && <p className="mt-2 text-xs text-muted">Loading…</p>}
        {links.data && links.data.links.length === 0 && <p className="mt-2 text-xs text-muted">Nothing has been sent for approval from this page yet.</p>}
        <ul className="mt-2 space-y-2">
          {links.data?.links.map((link) => {
            const status = reviewStatusLabel(link);
            return (
              <li key={link.id} className="rounded-xl border border-line bg-white p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-semibold text-ink">{link.title}</p>
                    <p className="text-[11px] text-muted">Sent {dateFormat.format(new Date(link.createdAt))}{link.status === "PENDING" && !link.expired ? ` · until ${dateFormat.format(new Date(link.expiresAt))}` : ""}</p>
                  </div>
                  <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${TONE[status.tone]}`}>{status.text}</span>
                </div>
                {link.reviewerName && link.decidedAt && (
                  <p className="mt-2 text-xs text-ink">
                    {link.reviewerName} answered on {dateFormat.format(new Date(link.decidedAt))}{link.feedback ? ":" : "."}
                    {link.feedback && <span className="mt-1 block whitespace-pre-wrap text-muted">“{link.feedback}”</span>}
                  </p>
                )}
                {link.stale && link.status !== "WITHDRAWN" && (
                  <p className="mt-2 text-[11px] text-warn-text">The draft has changed since this was sent, so their answer is about earlier words.</p>
                )}
                <div className="mt-2 flex flex-wrap gap-3 text-xs">
                  {link.commentCount > 0 && (
                    <button type="button" className="font-semibold text-blue hover:underline" onClick={() => setOpen(open === link.id ? null : link.id)}>
                      {open === link.id ? "Hide" : "Show"} {link.commentCount} comment{link.commentCount === 1 ? "" : "s"}
                    </button>
                  )}
                  {canEdit && link.status === "PENDING" && !link.expired && (
                    <button type="button" className="text-muted hover:text-ink hover:underline" disabled={withdraw.isPending} onClick={() => { if (window.confirm("Withdraw this link? It will stop working straight away.")) withdraw.mutate(link.id); }}>
                      Withdraw
                    </button>
                  )}
                </div>
                {open === link.id && <ReviewComments pageId={pageId} linkId={link.id} canEdit={canEdit} />}
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}

function ReviewComments({ pageId, linkId, canEdit }: { pageId: string; linkId: string; canEdit: boolean }) {
  const qc = useQueryClient();
  const comments = useQuery({
    queryKey: ["website", "review-comments", linkId],
    queryFn: ({ signal }) => api.get<{ comments: ReviewCommentView[] }>(`/website/pages/${pageId}/review-links/${linkId}/comments`, signal),
  });
  const resolve = useMutation({
    mutationFn: ({ id, resolved }: { id: string; resolved: boolean }) => api.post(`/website/pages/${pageId}/review-links/${linkId}/comments/${id}/resolve`, { resolved }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["website", "review-comments", linkId] }),
  });
  if (comments.isLoading) return <p className="mt-2 text-xs text-muted">Loading comments…</p>;
  return (
    <ol className="mt-2 space-y-2 border-t border-line pt-2">
      {comments.data?.comments.map((comment) => (
        <li key={comment.id} className={`text-xs ${comment.resolved ? "opacity-60" : ""}`}>
          <p><strong>{comment.authorName}</strong> <span className="text-muted">· {dateFormat.format(new Date(comment.createdAt))}</span></p>
          <p className="mt-0.5 whitespace-pre-wrap text-ink">{comment.body}</p>
          {comment.anchorLabel && <p className="text-muted">On: “{comment.anchorLabel}”</p>}
          {canEdit && (
            <button type="button" className="mt-0.5 font-semibold text-blue hover:underline" onClick={() => resolve.mutate({ id: comment.id, resolved: !comment.resolved })}>
              {comment.resolved ? "Mark as not done" : "Mark as dealt with"}
            </button>
          )}
        </li>
      ))}
    </ol>
  );
}
