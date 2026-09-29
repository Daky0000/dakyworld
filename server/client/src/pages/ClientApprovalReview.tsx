import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../lib/api";
import { Button } from "../components/ui";
import {
  IconCheck,
  IconEye,
  IconMessageCircle,
  IconShieldCheck,
  IconSparkles,
} from "../components/WebsiteIcons";

export type VisualComment = {
  id: string;
  authorName: string;
  authorEmail?: string;
  content: string;
  selectorOrFieldId?: string;
  xPercent?: number;
  yPercent?: number;
  resolved: boolean;
  createdAt: string;
};

export type PublicReviewData = {
  ok: boolean;
  site: {
    id: string;
    name: string;
    slug: string;
    publicUrl: string;
  };
  page: {
    id: string;
    title: string;
    path: string;
  };
  approval: {
    id: string;
    token: string;
    title: string;
    pageTitle: string;
    status: "PENDING" | "APPROVED" | "CHANGES_REQUESTED";
    versionNumber: number;
    createdAt: string;
  };
  draftHtml: string;
  liveHtml: string;
  comments: VisualComment[];
  tokens: Array<{ key: string; label: string; value: string }>;
};

export function ClientApprovalReview() {
  const { token } = useParams<{ token: string }>();
  const qc = useQueryClient();

  const [viewMode, setViewMode] = useState<"draft" | "live" | "split">("draft");
  const [showComments, setShowComments] = useState(false);
  const [actionModal, setActionModal] = useState<"APPROVE" | "REQUEST_CHANGES" | null>(null);
  const [authorName, setAuthorName] = useState("");
  const [authorEmail, setAuthorEmail] = useState("");
  const [actionNotes, setActionNotes] = useState("");
  const [newCommentText, setNewCommentText] = useState("");
  const [selectedPin, setSelectedPin] = useState<{ x: number; y: number } | null>(null);

  const reviewQuery = useQuery({
    queryKey: ["public", "review", token],
    queryFn: ({ signal }) => api.get<PublicReviewData>(`/public/review/${token}`, signal),
    enabled: Boolean(token),
  });

  const submitAction = useMutation({
    mutationFn: (action: "APPROVE" | "REQUEST_CHANGES") =>
      api.post(`/public/review/${token}/action`, {
        action,
        authorName: authorName.trim() || "Reviewer",
        authorEmail: authorEmail.trim() || undefined,
        notes: actionNotes.trim() || undefined,
      }),
    onSuccess: () => {
      setActionModal(null);
      void qc.invalidateQueries({ queryKey: ["public", "review", token] });
    },
  });

  const addComment = useMutation({
    mutationFn: () =>
      api.post(`/public/review/${token}/comments`, {
        authorName: authorName.trim() || "Reviewer",
        authorEmail: authorEmail.trim() || undefined,
        content: newCommentText.trim(),
        xPercent: selectedPin?.x,
        yPercent: selectedPin?.y,
      }),
    onSuccess: () => {
      setNewCommentText("");
      setSelectedPin(null);
      void qc.invalidateQueries({ queryKey: ["public", "review", token] });
    },
  });

  const data = reviewQuery.data;

  if (reviewQuery.isLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-sunken/40">
        <div className="text-center">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-ink border-t-transparent mx-auto" />
          <p className="mt-3 text-sm text-muted">Loading review draft…</p>
        </div>
      </div>
    );
  }

  if (reviewQuery.isError || !data) {
    return (
      <div className="flex h-screen items-center justify-center bg-sunken/40 p-4">
        <div className="max-w-md rounded-2xl border border-line bg-white p-6 text-center shadow-lg">
          <h2 className="text-lg font-bold text-ink">Review Link Not Found</h2>
          <p className="mt-2 text-xs text-muted">
            This review link may have expired, or changes have already been published.
          </p>
        </div>
      </div>
    );
  }

  const { approval, page, site, comments } = data;
  const isApproved = approval.status === "APPROVED";
  const isChangesRequested = approval.status === "CHANGES_REQUESTED";

  return (
    <div className="flex h-screen flex-col bg-sunken/40 font-sans">
      {/* Top Header Bar */}
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-white px-6 py-3.5 shadow-xs">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-ink text-white font-display text-sm font-bold">
            D
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="font-display text-sm font-bold text-ink">{page.title}</h1>
              <span className="text-xs text-muted">· {site.name}</span>
              <span
                className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                  isApproved
                    ? "bg-emerald-100 text-emerald-800"
                    : isChangesRequested
                      ? "bg-amber-100 text-amber-800"
                      : "bg-blue/10 text-blue"
                }`}
              >
                {isApproved
                  ? "✓ Approved"
                  : isChangesRequested
                    ? "Changes Requested"
                    : "Pending Sign-off"}
              </span>
            </div>
            <p className="text-[11px] text-muted">
              Client Review · Version {approval.versionNumber} · Safe Publish Verified
            </p>
          </div>
        </div>

        {/* View Switcher & Action CTAs */}
        <div className="flex items-center gap-2.5">
          <div className="inline-flex rounded-xl border border-line bg-sunken/40 p-0.5">
            <button
              type="button"
              onClick={() => setViewMode("draft")}
              className={`rounded-lg px-2.5 py-1 text-xs font-semibold transition ${
                viewMode === "draft" ? "bg-ink text-white" : "text-muted hover:text-ink"
              }`}
            >
              Proposed Draft
            </button>
            <button
              type="button"
              onClick={() => setViewMode("live")}
              className={`rounded-lg px-2.5 py-1 text-xs font-semibold transition ${
                viewMode === "live" ? "bg-ink text-white" : "text-muted hover:text-ink"
              }`}
            >
              Live on Site
            </button>
            <button
              type="button"
              onClick={() => setViewMode("split")}
              className={`rounded-lg px-2.5 py-1 text-xs font-semibold transition ${
                viewMode === "split" ? "bg-ink text-white" : "text-muted hover:text-ink"
              }`}
            >
              Side-by-Side
            </button>
          </div>

          <button
            type="button"
            onClick={() => setShowComments(!showComments)}
            className={`inline-flex items-center gap-1.5 rounded-xl border border-line px-3 py-1.5 text-xs font-semibold transition ${
              showComments ? "bg-ink text-white" : "bg-white text-ink hover:bg-sunken"
            }`}
          >
            <IconMessageCircle size={14} />
            <span>Comments ({comments.length})</span>
          </button>

          <Button
            variant="secondary"
            size="sm"
            onClick={() => setActionModal("REQUEST_CHANGES")}
          >
            Request Changes
          </Button>

          <Button
            variant="accent"
            size="sm"
            onClick={() => setActionModal("APPROVE")}
          >
            <span className="inline-flex items-center gap-1.5">
              <IconCheck size={14} />
              <span>Approve Draft</span>
            </span>
          </Button>
        </div>
      </header>

      {/* Main Canvas Viewport */}
      <div className="relative flex flex-1 overflow-hidden">
        {/* Frame Container */}
        <div className="flex-1 overflow-auto p-4 flex gap-4 justify-center items-start">
          {viewMode === "split" ? (
            <>
              <div className="flex-1 flex flex-col h-[calc(100vh-100px)] rounded-2xl border border-line bg-white shadow-md overflow-hidden">
                <div className="border-b border-line bg-sunken/40 px-3 py-1.5 text-xs font-bold text-muted">
                  Current Live Version
                </div>
                <iframe
                  title="Current Live Page"
                  srcDoc={data.liveHtml}
                  className="flex-1 w-full border-0"
                  sandbox="allow-scripts"
                />
              </div>
              <div className="flex-1 flex flex-col h-[calc(100vh-100px)] rounded-2xl border border-blue/40 bg-white shadow-md overflow-hidden">
                <div className="border-b border-blue/20 bg-blue/5 px-3 py-1.5 text-xs font-bold text-blue">
                  Proposed Draft (Changes Staged)
                </div>
                <iframe
                  title="Proposed Draft"
                  srcDoc={data.draftHtml}
                  className="flex-1 w-full border-0"
                  sandbox="allow-scripts"
                />
              </div>
            </>
          ) : (
            <div className="relative w-full max-w-5xl h-[calc(100vh-100px)] rounded-2xl border border-line bg-white shadow-lg overflow-hidden flex flex-col">
              <div className="border-b border-line bg-sunken/30 px-3 py-1.5 text-xs font-semibold text-muted flex items-center justify-between">
                <span>{viewMode === "draft" ? "Proposed Draft Preview" : "Live Page Preview"}</span>
                <span className="text-[11px] text-muted">Click anywhere to drop a feedback pin</span>
              </div>
              <div
                className="relative flex-1 w-full"
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  const x = Math.round(((e.clientX - rect.left) / rect.width) * 100);
                  const y = Math.round(((e.clientY - rect.top) / rect.height) * 100);
                  setSelectedPin({ x, y });
                  setShowComments(true);
                }}
              >
                <iframe
                  title="Page Preview"
                  srcDoc={viewMode === "draft" ? data.draftHtml : data.liveHtml}
                  className="w-full h-full border-0 pointer-events-none"
                  sandbox="allow-scripts"
                />

                {/* Render Visual Comment Pins */}
                {comments.map((c, i) => (
                  c.xPercent !== undefined && c.yPercent !== undefined && (
                    <div
                      key={c.id}
                      style={{ left: `${c.xPercent}%`, top: `${c.yPercent}%` }}
                      className="absolute -translate-x-1/2 -translate-y-1/2 flex h-6 w-6 items-center justify-center rounded-full bg-blue text-white text-[11px] font-bold shadow-lg ring-2 ring-white cursor-pointer hover:scale-110 transition"
                      title={`${c.authorName}: ${c.content}`}
                    >
                      {i + 1}
                    </div>
                  )
                ))}

                {/* Active dropped pin */}
                {selectedPin && (
                  <div
                    style={{ left: `${selectedPin.x}%`, top: `${selectedPin.y}%` }}
                    className="absolute -translate-x-1/2 -translate-y-1/2 flex h-7 w-7 items-center justify-center rounded-full bg-emerald-600 text-white text-xs font-bold shadow-xl ring-2 ring-white animate-pulse"
                  >
                    +
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Visual Comments Sidebar Drawer */}
        {showComments && (
          <aside className="w-80 border-l border-line bg-white flex flex-col shadow-xl z-20">
            <div className="flex items-center justify-between border-b border-line px-4 py-3">
              <h3 className="font-display text-sm font-bold text-ink">Visual Feedback Pins</h3>
              <button
                type="button"
                onClick={() => setShowComments(false)}
                className="text-muted hover:text-ink text-xs"
              >
                Close
              </button>
            </div>

            {/* Comment List */}
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {comments.length === 0 && !selectedPin ? (
                <div className="py-8 text-center text-xs text-muted">
                  <IconMessageCircle size={28} className="mx-auto text-muted/50 mb-2" />
                  <p>No comments pinned yet.</p>
                  <p className="mt-1 text-[11px]">Click anywhere on the preview to pin a comment.</p>
                </div>
              ) : (
                comments.map((comment, idx) => (
                  <div key={comment.id} className="rounded-xl border border-line bg-sunken/30 p-3 text-xs">
                    <div className="flex items-center justify-between gap-1 mb-1">
                      <span className="font-semibold text-ink">#{idx + 1} {comment.authorName}</span>
                      <span className="text-[10px] text-muted">
                        {new Date(comment.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                      </span>
                    </div>
                    <p className="text-ink/90 whitespace-pre-wrap">{comment.content}</p>
                  </div>
                ))
              )}

              {/* Pin creation form */}
              {selectedPin && (
                <div className="rounded-xl border border-blue/40 bg-blue/5 p-3 space-y-2 text-xs">
                  <span className="font-bold text-blue">Pin dropped at ({selectedPin.x}%, {selectedPin.y}%)</span>
                  <input
                    type="text"
                    placeholder="Your name"
                    value={authorName}
                    onChange={(e) => setAuthorName(e.target.value)}
                    className="w-full rounded-lg border border-line bg-white px-2 py-1 text-xs outline-none"
                  />
                  <textarea
                    rows={3}
                    placeholder="Leave feedback or requested change here…"
                    value={newCommentText}
                    onChange={(e) => setNewCommentText(e.target.value)}
                    className="w-full rounded-lg border border-line bg-white p-2 text-xs outline-none"
                  />
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setSelectedPin(null)}
                      className="px-2 py-1 text-xs text-muted hover:text-ink"
                    >
                      Cancel
                    </button>
                    <Button
                      size="sm"
                      disabled={!newCommentText.trim() || addComment.isPending}
                      onClick={() => addComment.mutate()}
                    >
                      Post Pin
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </aside>
        )}
      </div>

      {/* Approve / Request Changes Action Modal */}
      {actionModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/50 p-4 backdrop-blur-2xs">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl space-y-4">
            <div>
              <h3 className="font-display text-lg font-bold text-ink">
                {actionModal === "APPROVE" ? "Approve This Page Draft" : "Request Changes"}
              </h3>
              <p className="mt-1 text-xs text-muted">
                {actionModal === "APPROVE"
                  ? "Your approval will notify the development team that this page is cleared for publishing."
                  : "Submit feedback notes to notify the team what adjustments are needed."}
              </p>
            </div>

            <div className="space-y-3 text-xs">
              <div>
                <label className="block font-semibold text-ink mb-1">Your Name</label>
                <input
                  type="text"
                  placeholder="e.g. Sarah Jenkins"
                  value={authorName}
                  onChange={(e) => setAuthorName(e.target.value)}
                  className="w-full rounded-lg border border-line px-3 py-1.5 text-xs outline-none focus:border-blue"
                />
              </div>
              <div>
                <label className="block font-semibold text-ink mb-1">Your Email (Optional)</label>
                <input
                  type="email"
                  placeholder="sarah@example.com"
                  value={authorEmail}
                  onChange={(e) => setAuthorEmail(e.target.value)}
                  className="w-full rounded-lg border border-line px-3 py-1.5 text-xs outline-none focus:border-blue"
                />
              </div>
              <div>
                <label className="block font-semibold text-ink mb-1">
                  {actionModal === "APPROVE" ? "Sign-off Notes (Optional)" : "Required Changes"}
                </label>
                <textarea
                  rows={3}
                  placeholder={
                    actionModal === "APPROVE"
                      ? "Looks wonderful! Ready to go live."
                      : "Please change the header button text to 'Book Consultation' and update phone number."
                  }
                  value={actionNotes}
                  onChange={(e) => setActionNotes(e.target.value)}
                  className="w-full rounded-lg border border-line p-2 text-xs outline-none focus:border-blue"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-line">
              <Button
                variant="ghost"
                onClick={() => setActionModal(null)}
                disabled={submitAction.isPending}
              >
                Cancel
              </Button>
              <Button
                variant={actionModal === "APPROVE" ? "accent" : "secondary"}
                disabled={submitAction.isPending}
                onClick={() => submitAction.mutate(actionModal)}
              >
                {submitAction.isPending
                  ? "Submitting…"
                  : actionModal === "APPROVE"
                    ? "Confirm Approval"
                    : "Send Change Request"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
