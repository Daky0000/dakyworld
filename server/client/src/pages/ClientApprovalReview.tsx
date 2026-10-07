import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { api, ApiError } from "../lib/api";
import { setPageTitle } from "../lib/surface";
import { Button } from "../components/ui";

/**
 * The page somebody's client opens from a review link — no account, no sign-in.
 *
 * Reached from `main.tsx` before the session is even looked at: the first
 * version of this lived inside the signed-in app, so every reviewer was shown
 * the staff sign-in screen instead of the changes. Everything it needs is in
 * the token; the server (`services/websiteReviewLinks.ts`) does the rest.
 *
 * The page itself renders in a frame served by the server in an origin of its
 * own, so the reviewer sees it with its real styles and scripts while nothing
 * on it can reach this page. Pins cross by message for the same reason.
 */

type ReviewComment = {
  id: string;
  authorName: string;
  body: string;
  xPercent: number | null;
  yPercent: number | null;
  anchorLabel: string | null;
  resolved: boolean;
  createdAt: string;
};

type PublicReview = {
  site: { name: string };
  page: { title: string; path: string };
  link: {
    title: string;
    status: "PENDING" | "APPROVED" | "CHANGES_REQUESTED";
    createdAt: string;
    expiresAt: string;
    decidedAt: string | null;
    reviewerName: string | null;
    feedback: string | null;
  };
  comments: ReviewComment[];
  frames: { draft: string; live: string };
};

const NAME_KEY = "dakyx-reviewer-name";

function rememberedName(): string {
  try { return localStorage.getItem(NAME_KEY) ?? ""; } catch { return ""; }
}

function rememberName(name: string) {
  try { localStorage.setItem(NAME_KEY, name); } catch { /* private mode */ }
}

const dateFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });

export function ClientApprovalReview({ token: tokenProp }: { token?: string }) {
  const token = tokenProp ?? decodeURIComponent(window.location.pathname.split("/")[2] ?? "");
  const qc = useQueryClient();
  const frame = useRef<HTMLIFrameElement>(null);
  const [view, setView] = useState<"draft" | "live">("draft");
  const [name, setName] = useState(rememberedName);
  const [commentText, setCommentText] = useState("");
  const [pin, setPin] = useState<{ x: number; y: number; label: string } | null>(null);
  const [pinMode, setPinMode] = useState(false);
  const [decision, setDecision] = useState<"APPROVE" | "REQUEST_CHANGES" | null>(null);
  const [email, setEmail] = useState("");
  const [feedback, setFeedback] = useState("");
  const [frameReady, setFrameReady] = useState(false);

  const review = useQuery({
    queryKey: ["public-review", token],
    queryFn: ({ signal }) => api.get<PublicReview>(`/public/review/${encodeURIComponent(token)}`, signal),
    enabled: Boolean(token),
    retry: false,
  });
  const data = review.data;

  useEffect(() => {
    setPageTitle(data ? `Review: ${data.page.title}` : "Review");
  }, [data]);

  const pins = useMemo(
    () => (data?.comments ?? []).filter((comment) => comment.xPercent !== null && comment.yPercent !== null && !comment.resolved),
    [data?.comments],
  );

  const tell = useCallback((message: Record<string, unknown>) => {
    frame.current?.contentWindow?.postMessage({ source: "dakyx-review-host", ...message }, "*");
  }, []);

  // The frame is opaque: everything it says arrives as a message, checked to
  // come from that frame and nothing else.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      const message = event.data as { source?: string; type?: string; x?: number; y?: number; label?: string } | null;
      if (message?.source !== "dakyx-review") return;
      if (message.type === "ready") setFrameReady(true);
      if (message.type === "pinned" && typeof message.x === "number" && typeof message.y === "number") {
        setPin({ x: message.x, y: message.y, label: message.label ?? "" });
        setPinMode(false);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    if (!frameReady) return;
    tell({ type: "pins", pins: view === "draft" ? pins.map((comment) => ({ x: comment.xPercent, y: comment.yPercent })) : [] });
  }, [frameReady, pins, view, tell]);

  useEffect(() => { tell({ type: "pin-mode", on: pinMode }); }, [pinMode, tell]);

  const addComment = useMutation({
    mutationFn: () =>
      api.post<{ comment: ReviewComment }>(`/public/review/${encodeURIComponent(token)}/comments`, {
        name: name.trim(),
        body: commentText.trim(),
        ...(pin ? { xPercent: pin.x, yPercent: pin.y, anchorLabel: pin.label.slice(0, 120) } : {}),
      }),
    onSuccess: () => {
      rememberName(name.trim());
      setCommentText("");
      setPin(null);
      void qc.invalidateQueries({ queryKey: ["public-review", token] });
    },
  });

  const decide = useMutation({
    mutationFn: () =>
      api.post<{ status: string }>(`/public/review/${encodeURIComponent(token)}/decision`, {
        decision,
        name: name.trim(),
        email: email.trim(),
        feedback: feedback.trim() || undefined,
      }),
    onSuccess: () => {
      rememberName(name.trim());
      setDecision(null);
      void qc.invalidateQueries({ queryKey: ["public-review", token] });
    },
  });

  if (review.isLoading) {
    return (
      <main className="grid min-h-screen place-items-center bg-cream p-6">
        <p role="status" className="text-sm text-muted">Opening the changes…</p>
      </main>
    );
  }

  if (review.isError || !data) {
    const gone = review.error instanceof ApiError && review.error.status === 404;
    return (
      <main className="grid min-h-screen place-items-center bg-cream p-6">
        <div className="w-full max-w-md rounded-2xl border border-line bg-white p-8 text-center">
          <h1 className="font-display text-xl font-medium text-ink">{gone ? "This review link has ended" : "This review could not be opened"}</h1>
          <p className="mt-3 text-sm leading-relaxed text-muted">
            {gone
              ? "It has expired or been withdrawn. Ask the person who sent it for a new one."
              : "Something went wrong opening it. Check your connection and try again."}
          </p>
          {!gone && <Button className="mt-5" onClick={() => void review.refetch()}>Try again</Button>}
        </div>
      </main>
    );
  }

  const { link } = data;
  const decided = link.status !== "PENDING";
  const canSubmitDecision = name.trim().length > 0 && (decision === "APPROVE" || feedback.trim().length > 0);

  const submitComment = (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || !commentText.trim()) return;
    addComment.mutate();
  };

  const submitDecision = (event: FormEvent) => {
    event.preventDefault();
    if (canSubmitDecision) decide.mutate();
  };

  return (
    <main className="flex min-h-screen flex-col bg-cream text-ink lg:h-screen">
      <header className="flex flex-none flex-wrap items-center justify-between gap-3 border-b border-line bg-white px-4 py-3 sm:px-6">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[.08em] text-muted">{data.site.name}</p>
          <h1 className="truncate font-display text-lg font-medium tracking-[-.02em]">{link.title}</h1>
          <p className="text-xs text-muted">
            Sent {dateFormat.format(new Date(link.createdAt))}
            {!decided && <> · Link works until {dateFormat.format(new Date(link.expiresAt))}</>}
          </p>
        </div>
        <div role="group" aria-label="What to show" className="flex rounded-full border border-line bg-cream p-1 text-xs font-semibold">
          {(["draft", "live"] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={view === option}
              onClick={() => { setView(option); setFrameReady(false); setPinMode(false); }}
              className={`rounded-full px-3 py-1.5 transition ${view === option ? "bg-ink text-white" : "text-muted hover:text-ink"}`}
            >
              {option === "draft" ? "Proposed changes" : "Current page"}
            </button>
          ))}
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <section aria-label={view === "draft" ? "The page with the proposed changes" : "The page as it is now"} className="relative min-h-[60vh] flex-1 bg-white lg:min-h-0">
          {pinMode && (
            <p role="status" className="absolute left-1/2 top-3 z-10 -translate-x-1/2 rounded-full bg-ink px-4 py-2 text-xs font-semibold text-white shadow-lg">
              Click the part of the page your comment is about
            </p>
          )}
          <iframe
            ref={frame}
            key={view}
            title={view === "draft" ? "Proposed changes" : "Current page"}
            src={view === "draft" ? data.frames.draft : data.frames.live}
            className="h-full min-h-[60vh] w-full border-0 lg:min-h-0"
          />
        </section>

        <aside className="flex w-full flex-none flex-col border-t border-line bg-white lg:w-[22rem] lg:border-l lg:border-t-0">
          <div className="border-b border-line p-4 sm:p-5">
            {decided ? (
              <div role="status" className={`rounded-xl px-4 py-3 text-sm ${link.status === "APPROVED" ? "bg-positive-surface text-positive-text" : "bg-warn-surface text-warn-text"}`}>
                <p className="font-semibold">
                  {link.status === "APPROVED" ? "Approved" : "Changes requested"}
                  {link.reviewerName ? ` by ${link.reviewerName}` : ""}
                  {link.decidedAt ? ` on ${dateFormat.format(new Date(link.decidedAt))}` : ""}.
                </p>
                {link.feedback && <p className="mt-1 whitespace-pre-wrap">“{link.feedback}”</p>}
                <p className="mt-2 text-xs opacity-80">The person who sent this link has been told.</p>
              </div>
            ) : decision ? (
              <form onSubmit={submitDecision} className="space-y-3">
                <h2 className="font-display text-base font-medium">{decision === "APPROVE" ? "Approve these changes" : "Ask for changes"}</h2>
                <label className="block text-xs font-semibold text-muted">
                  Your name
                  <input className="input mt-1" value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" required maxLength={100} />
                </label>
                <label className="block text-xs font-semibold text-muted">
                  Your email <span className="font-normal">(optional)</span>
                  <input className="input mt-1" type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" maxLength={200} />
                </label>
                <label className="block text-xs font-semibold text-muted">
                  {decision === "APPROVE" ? "Anything to add? (optional)" : "What should change?"}
                  <textarea className="input mt-1 min-h-24" value={feedback} onChange={(event) => setFeedback(event.target.value)} maxLength={2000} required={decision === "REQUEST_CHANGES"} />
                </label>
                {decide.isError && <p role="alert" className="text-xs text-warn-text">{(decide.error as Error).message}</p>}
                <div className="flex gap-2">
                  <Button type="submit" variant={decision === "APPROVE" ? "accent" : "primary"} disabled={!canSubmitDecision || decide.isPending}>
                    {decide.isPending ? "Sending…" : decision === "APPROVE" ? "Approve" : "Send request"}
                  </Button>
                  <Button type="button" variant="ghost" onClick={() => setDecision(null)}>Back</Button>
                </div>
              </form>
            ) : (
              <div>
                <p className="text-sm leading-relaxed text-muted">
                  Look through the proposed changes, leave comments where something needs a second look, then tell them what you think.
                </p>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <Button variant="accent" onClick={() => setDecision("APPROVE")}>Approve</Button>
                  <Button variant="secondary" onClick={() => setDecision("REQUEST_CHANGES")}>Ask for changes</Button>
                </div>
              </div>
            )}
          </div>

          <div className="flex min-h-0 flex-1 flex-col">
            <h2 className="px-4 pt-4 font-display text-base font-medium sm:px-5">Comments ({data.comments.length})</h2>
            <ol className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3 sm:px-5">
              {data.comments.length === 0 && <li className="text-xs text-muted">No comments yet.</li>}
              {data.comments.map((comment) => {
                const pinNumber = pins.findIndex((candidate) => candidate.id === comment.id);
                return (
                  <li key={comment.id} className={`rounded-xl border border-line p-3 text-sm ${comment.resolved ? "opacity-60" : ""}`}>
                    <div className="flex items-center justify-between gap-2">
                      <strong className="text-xs">{comment.authorName}</strong>
                      <span className="text-[11px] text-muted">{dateFormat.format(new Date(comment.createdAt))}</span>
                    </div>
                    <p className="mt-1 whitespace-pre-wrap">{comment.body}</p>
                    {comment.anchorLabel && <p className="mt-1 text-[11px] text-muted">On: “{comment.anchorLabel}”</p>}
                    {pinNumber >= 0 && view === "draft" && (
                      <button type="button" className="mt-1 text-[11px] font-semibold text-blue hover:underline" onClick={() => tell({ type: "focus", y: comment.yPercent })}>
                        Show pin {pinNumber + 1} on the page
                      </button>
                    )}
                    {comment.resolved && <p className="mt-1 text-[11px] text-muted">Dealt with</p>}
                  </li>
                );
              })}
            </ol>
            <form onSubmit={submitComment} className="space-y-2 border-t border-line p-4 sm:p-5">
              <label className="block text-xs font-semibold text-muted">
                Your name
                <input className="input mt-1" value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" maxLength={100} required />
              </label>
              <label className="block text-xs font-semibold text-muted">
                Comment
                <textarea className="input mt-1 min-h-20" value={commentText} onChange={(event) => setCommentText(event.target.value)} maxLength={1000} required />
              </label>
              {pin ? (
                <p className="text-xs text-muted">
                  Pinned to “{pin.label || "that spot"}”.{" "}
                  <button type="button" className="font-semibold text-blue hover:underline" onClick={() => setPin(null)}>Remove pin</button>
                </p>
              ) : view === "draft" ? (
                <button type="button" className="text-xs font-semibold text-blue hover:underline disabled:opacity-50" disabled={!frameReady} onClick={() => setPinMode((on) => !on)}>
                  {pinMode ? "Cancel pointing" : "Point at the part of the page this is about"}
                </button>
              ) : null}
              {addComment.isError && <p role="alert" className="text-xs text-warn-text">{(addComment.error as Error).message}</p>}
              <Button type="submit" disabled={!name.trim() || !commentText.trim() || addComment.isPending}>
                {addComment.isPending ? "Posting…" : "Post comment"}
              </Button>
            </form>
          </div>
        </aside>
      </div>
    </main>
  );
}
