import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, apiUrl } from "../lib/api";
import { Badge, Button } from "./ui";
import type { SharedElementOnPage, SharedReview } from "../lib/types";

/**
 * What the person editing needs to know before they type: this is not one page.
 *
 * The whole risk of shared elements is somebody changing a heading believing
 * they are changing this page, and changing eight. So the scope is stated above
 * the content controls rather than beside them, in pages rather than in jargon,
 * and the choice between "everywhere" and "only here" is made *before* the edit
 * — choosing "only this page" detaches this copy first and then lets them edit
 * it, which is the thing they meant and not a thing they have to know to ask for.
 */
export function SharedElementPanel({
  element,
  pageTitle,
  readOnly,
  onChanged,
  onReview,
}: {
  element: SharedElementOnPage;
  pageTitle: string;
  readOnly: boolean;
  /** The page must be re-read: detaching moves values into its own draft. */
  onChanged: () => void;
  onReview: (sharedElementId: string) => void;
}) {
  const [failure, setFailure] = useState<string | null>(null);

  const act = useMutation({
    mutationFn: (action: "detach" | "relink") => api.post(`/website/shared/${element.id}/instances/${element.instanceId}/${action}`),
    onSuccess: () => {
      setFailure(null);
      onChanged();
    },
    onError: (error) => setFailure(error instanceof ApiError ? error.message : "That could not be changed just now."),
  });

  const linked = element.state === "LINKED";

  return (
    <div className={`border-b border-line px-4 py-3 ${linked ? "bg-blue/[.03]" : ""}`}>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="font-sans text-[11px] font-bold uppercase tracking-[.06em] text-muted">{linked ? "Shared element" : "Local element"}</span>
        {linked ? <Badge tone="info">{element.linkedPages} pages</Badge> : <Badge>Detached</Badge>}
      </div>
      <div className="truncate text-[13px] font-semibold text-ink">{element.name}</div>

      {linked ? (
        <>
          <p className="mt-1 text-[11px] leading-relaxed text-muted">
            Changes here appear on all {element.linkedPages} pages that use it.
          </p>

          <fieldset className="mt-2.5" disabled={readOnly || act.isPending}>
            <legend className="mb-1.5 text-[11px] uppercase tracking-[.08em] text-muted">Apply changes to</legend>
            <label className="flex items-start gap-2 text-[12px] text-ink">
              <input type="radio" name={`scope-${element.instanceId}`} checked readOnly className="mt-0.5 accent-blue" />
              <span>All {element.linkedPages} linked pages</span>
            </label>
            <label className="mt-1.5 flex items-start gap-2 text-[12px] text-ink">
              <input
                type="radio"
                name={`scope-${element.instanceId}`}
                checked={false}
                onChange={() => {
                  if (window.confirm(`Make this copy of ${element.name} independent?\n\n${pageTitle} will keep exactly what it shows now, but later changes to ${element.name} will no longer reach it.`)) {
                    act.mutate("detach");
                  }
                }}
                className="mt-0.5 accent-blue"
              />
              <span>
                Only this page
                <span className="block text-[11px] leading-relaxed text-muted">Makes this copy independent first. Nothing on the page changes.</span>
              </span>
            </label>
          </fieldset>

          {element.mismatched.length > 0 && (
            <p role="alert" className="mt-2 rounded-xl bg-warn-surface px-2.5 py-2 text-[11px] leading-relaxed text-warn-text">
              This page's copy has a different shape from the shared element, so {element.mismatched.length} part
              {element.mismatched.length === 1 ? "" : "s"} of a shared change cannot be placed on it. Publishing is blocked until that is
              resolved — detach this page, or make the two match.
            </p>
          )}

          {element.pendingSlots > 0 && (
            <div className="mt-2.5 flex items-center justify-between gap-2">
              <span className="text-[11px] text-muted">
                {element.pendingSlots} unpublished change{element.pendingSlots === 1 ? "" : "s"}
              </span>
              <button type="button" onClick={() => onReview(element.id)} className="text-[11px] font-semibold text-blue underline-offset-2 hover:underline">
                Review and publish
              </button>
            </div>
          )}
        </>
      ) : (
        <>
          <p className="mt-1 text-[11px] leading-relaxed text-muted">
            {pageTitle} only. It keeps its own design and words, and changes to {element.name} no longer reach it.
          </p>
          <button
            type="button"
            disabled={readOnly || act.isPending}
            onClick={() => {
              if (window.confirm(`Put this page back under ${element.name}?\n\nThis page will take the shared version, and any local changes to that part of the page will go.`)) {
                act.mutate("relink");
              }
            }}
            className="mt-2 rounded-xl border border-line px-2.5 py-1.5 text-[11px] font-semibold text-ink transition hover:border-blue hover:text-blue disabled:opacity-50"
          >
            Re-link to {element.name}
          </button>
        </>
      )}

      {failure && <p role="alert" className="mt-2 text-[11px] text-danger-text">{failure}</p>}
    </div>
  );
}

/**
 * Everything a shared change would do, before it does any of it.
 *
 * The list is the point: a shared publish writes several files at once, and the
 * only honest way to authorise that is to see which pages and what changes. A
 * page that cannot receive it blocks the whole thing rather than being skipped
 * — six pages of seven agreeing is the failure this feature exists to prevent.
 */
export function SharedPublishReview({ sharedElementId, onClose, onPublished }: { sharedElementId: string; onClose: () => void; onPublished: () => void }) {
  const qc = useQueryClient();
  const [failure, setFailure] = useState<string | null>(null);
  const [previewPageId, setPreviewPageId] = useState<string | null>(null);

  const review = useQuery({
    queryKey: ["website", "shared", sharedElementId, "review"],
    queryFn: () => api.get<SharedReview>(`/website/shared/${sharedElementId}/review`),
  });

  const publish = useMutation({
    mutationFn: () =>
      api.post<{ commit: { url: string }; pages: Array<{ title: string }>; note: string }>(`/website/shared/${sharedElementId}/publish`, {
        ifRevision: review.data!.revision,
        pages: Object.fromEntries(review.data!.pages.map((page) => [page.pageId, page.sourceHash])),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["website"] });
      onPublished();
    },
    onError: (error) => setFailure(error instanceof ApiError ? error.message : "That publish did not finish."),
  });

  const discard = useMutation({
    mutationFn: () => api.delete(`/website/shared/${sharedElementId}/draft`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["website"] });
      onPublished();
    },
  });

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-ink/40 p-6" role="dialog" aria-modal="true" aria-label="Shared change review">
      <div className="w-full max-w-3xl rounded-2xl border border-line bg-white p-5 shadow-xl shadow-ink/10">
        {review.isLoading && <p className="text-sm text-muted">Working out what this would change…</p>}
        {review.isError && <p className="text-sm text-warn-text">{review.error instanceof ApiError ? review.error.message : "That change could not be reviewed."}</p>}

        {review.data && (
          <>
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <h2 className="font-display text-lg tracking-[-.02em]">{review.data.name}</h2>
                <p className="text-xs text-muted">
                  One change to {review.data.pages.length} page{review.data.pages.length === 1 ? "" : "s"}, published together or not at all.
                </p>
              </div>
              <button type="button" onClick={onClose} className="text-xs text-muted hover:text-ink">
                Close
              </button>
            </div>

            {!review.data.publishable && review.data.reason && (
              <p role="alert" className="mb-3 rounded-xl border border-warn-line bg-warn-surface px-3 py-2 text-xs leading-relaxed text-warn-text">
                {review.data.reason}
              </p>
            )}

            <ul className="space-y-2">
              {review.data.pages.map((page) => (
                <li key={page.pageId} className={`rounded-xl border p-3 ${page.blocked ? "border-warn-line bg-warn-surface/40" : "border-line"}`}>
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-ink">{page.title}</span>
                      <span className="font-mono text-[11px] text-muted">{page.path}</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setPreviewPageId(previewPageId === page.pageId ? null : page.pageId)}
                      className={`rounded-[10px] px-2 py-0.5 text-xs transition border ${previewPageId === page.pageId ? "bg-ink text-white border-ink" : "bg-white text-muted hover:text-ink border-line"}`}
                    >
                      {previewPageId === page.pageId ? "Hide preview" : "Preview"}
                    </button>
                  </div>
                  {page.blocked ? (
                    <p className="mt-1 text-xs text-warn-text">{page.blocked}</p>
                  ) : page.summary.length ? (
                    <ul className="mt-1.5 space-y-0.5 text-xs text-muted">
                      {page.summary.slice(0, 4).map((entry, index) => (
                        <li key={`${entry.id}-${index}`} className="break-words">
                          {entry.label}: “{entry.from}” → “{entry.to}”
                        </li>
                      ))}
                      {page.summary.length > 4 && <li>and {page.summary.length - 4} more</li>}
                    </ul>
                  ) : (
                    <p className="mt-1 text-xs text-muted">Already says all of this.</p>
                  )}
                  {previewPageId === page.pageId && (
                    <div className="mt-3 overflow-hidden rounded-xl border border-line bg-sunken">
                      <div className="flex items-center justify-between border-b border-line bg-white px-3 py-1.5 text-xs text-muted">
                        <span>Live Preview: {page.title}</span>
                        <span className="font-mono text-[11px]">{page.path}</span>
                      </div>
                      <iframe
                        src={apiUrl(`/website/pages/${page.pageId}/preview`)}
                        title={`Preview of ${page.title}`}
                        className="h-64 w-full bg-white"
                      />
                    </div>
                  )}
                </li>
              ))}
            </ul>

            {review.data.detached.length > 0 && (
              <p className="mt-3 text-xs text-muted">
                {review.data.detached.length} page{review.data.detached.length === 1 ? " is" : "s are"} detached from this element and will not be
                changed.
              </p>
            )}

            {failure && <p role="alert" className="mt-3 rounded-xl border border-warn-line bg-warn-surface px-3 py-2 text-xs text-warn-text">{failure}</p>}

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <Button variant="accent" size="sm" disabled={!review.data.publishable || publish.isPending} onClick={() => publish.mutate()}>
                {publish.isPending ? "Publishing…" : `Publish to ${review.data.pages.length} page${review.data.pages.length === 1 ? "" : "s"}`}
              </Button>
              <Button variant="ghost" size="sm" disabled={discard.isPending} onClick={() => {
                if (window.confirm(`Throw away the unpublished changes to ${review.data!.name}? They will go from every page at once.`)) discard.mutate();
              }}>
                Discard the change
              </Button>
              <button type="button" onClick={() => void review.refetch()} className="text-xs text-muted underline-offset-2 hover:text-ink hover:underline">
                Check again
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Making something shared, on purpose.
 *
 * Detection is never going to be perfect, so any suitable element can be made
 * shared by hand — and this explicit decision outranks whatever detection later
 * thinks. The pages offered are the ones that actually hold the same thing; a
 * list of every page on the site would invite somebody to link a call to action
 * to a page that has none, and the server would refuse it anyway.
 */
export function MakeSharedPanel({
  siteId,
  pageId,
  fieldId,
  fieldLabel,
  readOnly,
  onCreated,
}: {
  siteId: string;
  pageId: string;
  fieldId: string;
  fieldLabel: string;
  readOnly: boolean;
  onCreated: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(fieldLabel);
  const [chosen, setChosen] = useState<Set<string> | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  type Suggestions = {
    candidates: Array<{ key: string; name: string; confidence: string; reason: string; instances: Array<{ pageId: string; fieldId: string; title: string }> }>;
  };
  const suggestions = useQuery({
    queryKey: ["website", "shared", siteId, "suggestions"],
    enabled: open,
    queryFn: () => api.get<Suggestions>(`/website/sites/${siteId}/shared/suggestions`),
  });

  const match = suggestions.data?.candidates.find((candidate) =>
    candidate.instances.some((instance) => instance.pageId === pageId && instance.fieldId === fieldId),
  );
  const others = match?.instances.filter((instance) => instance.pageId !== pageId) ?? [];
  const selected = chosen ?? new Set(others.map((instance) => instance.pageId));

  const create = useMutation({
    mutationFn: () =>
      api.post(`/website/sites/${siteId}/shared`, {
        name: name.trim(),
        pageId,
        fieldId,
        instances: others.filter((instance) => selected.has(instance.pageId)).map((instance) => ({ pageId: instance.pageId, fieldId: instance.fieldId })),
      }),
    onSuccess: () => {
      setOpen(false);
      onCreated();
    },
    onError: (error) => setFailure(error instanceof ApiError ? error.message : "That could not be made shared just now."),
  });

  if (!open) {
    return (
      <div className="border-b border-line px-4 py-2.5">
        <button
          type="button"
          disabled={readOnly}
          onClick={() => setOpen(true)}
          className="text-[11px] text-muted underline-offset-2 transition hover:text-blue hover:underline disabled:opacity-50"
        >
          Make this a shared element…
        </button>
      </div>
    );
  }

  return (
    <div className="border-b border-line bg-blue/[.03] px-4 py-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-sans text-[11px] font-bold uppercase tracking-[.06em] text-muted">Make shared</span>
        <button type="button" onClick={() => setOpen(false)} className="text-[11px] text-muted hover:text-ink">
          Cancel
        </button>
      </div>

      <label className="block">
        <span className="mb-1 block text-[11px] text-muted">Name it</span>
        <input
          className="h-8 w-full rounded-xl border border-line bg-white px-2 text-[12px] text-ink outline-none focus:border-blue"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </label>

      {suggestions.isLoading && <p className="mt-2 text-[11px] text-muted">Looking for the same thing on other pages…</p>}
      {suggestions.data && others.length === 0 && (
        <p className="mt-2 text-[11px] leading-relaxed text-muted">
          No other page holds this same block, so there is nothing to share it with yet. A shared element needs at least two pages.
        </p>
      )}

      {others.length > 0 && (
        <>
          <p className="mt-2.5 text-[11px] text-muted">{match?.reason}</p>
          <div className="mt-1.5 space-y-1">
            {others.map((instance) => (
              <label key={instance.pageId} className="flex items-center gap-2 text-[12px] text-ink">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 accent-blue"
                  checked={selected.has(instance.pageId)}
                  onChange={(event) => {
                    const next = new Set(selected);
                    if (event.target.checked) next.add(instance.pageId);
                    else next.delete(instance.pageId);
                    setChosen(next);
                  }}
                />
                <span className="truncate">{instance.title}</span>
              </label>
            ))}
          </div>
        </>
      )}

      {failure && <p role="alert" className="mt-2 text-[11px] text-danger-text">{failure}</p>}

      <button
        type="button"
        disabled={readOnly || create.isPending || !name.trim() || selected.size === 0}
        onClick={() => create.mutate()}
        className="mt-3 w-full rounded-xl bg-ink py-1.5 text-[11px] font-semibold text-cream transition hover:bg-ink/90 disabled:opacity-40"
      >
        {create.isPending ? "Linking…" : `Share across ${selected.size + 1} pages`}
      </button>
    </div>
  );
}
