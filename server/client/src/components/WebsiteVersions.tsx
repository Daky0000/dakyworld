import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import type { FieldChangeSummary, RollbackDiff, SitePageVersionRow } from "../lib/types";
import { Badge, Button, EmptyState, RelativeTime } from "./ui";

/**
 * Everything that has been published from this page, and two ways back.
 *
 * The routes behind this have existed since the editor shipped and nothing in
 * the client ever called them: a page's whole publishing history was reachable
 * only with `curl`. So a bad publish had no undo at all — somebody had to open
 * the repository and revert a commit by hand, which is exactly the thing this
 * product exists to stop a client needing to do.
 *
 * **Two ways back, and the difference matters.**
 *
 * *Restore as draft* puts the old words in the editor and stops. It is the right
 * answer nearly every time, because a page usually moved on for reasons that
 * have nothing to do with the edit being undone, and a restore that published
 * itself would take those with it.
 *
 * *Publish this version* writes the whole stored file back over the page as it
 * stands. It is the emergency: something went out that should not have, and the
 * point is to be back where you were now rather than after a review. Because it
 * is a whole-file write it can undo a developer's work committed since, so it is
 * never one click — the diff is fetched first and says, in a sentence, what it
 * would overwrite.
 */

function summaryLine(entry: FieldChangeSummary): string {
  const what =
    entry.part === "words"
      ? ""
      : entry.part === "destination"
        ? " (link)"
        : entry.part === "picture"
          ? " (picture)"
          : entry.part === "description"
            ? " (description)"
            : " (styling)";
  return `${entry.label}${what}: “${entry.from}” → “${entry.to}”`;
}

function TouchedBadges({ touched }: { touched: SitePageVersionRow["touched"] }) {
  const marks = [
    touched.seo && "Search listing",
    touched.text && "Words",
    touched.links && "Links",
    touched.images && "Pictures",
    touched.styles && "Styling",
  ].filter(Boolean) as string[];
  if (!marks.length) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {marks.map((mark) => (
        <Badge key={mark} tone={mark === "Search listing" ? "warn" : "muted"}>
          {mark}
        </Badge>
      ))}
    </span>
  );
}

export function WebsiteVersions({ pageId, onClose, onRestored }: { pageId: string; onClose: () => void; onRestored: () => void }) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const [failure, setFailure] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  /** The version somebody has asked to put back on the site, and what that would do. */
  const [confirming, setConfirming] = useState<{ version: SitePageVersionRow; diff: RollbackDiff } | null>(null);

  const versions = useQuery({
    queryKey: ["website", "versions", pageId],
    queryFn: () => api.get<SitePageVersionRow[]>(`/website/pages/${pageId}/versions`),
  });

  const restore = useMutation({
    mutationFn: (versionId: string) =>
      api.post<{ restored: number; dropped: string[]; empty: boolean }>(`/website/pages/${pageId}/versions/${versionId}/restore`),
    onError: (err) => setFailure(err instanceof ApiError ? err.message : "That version could not be restored."),
    onSuccess: (result) => {
      setFailure(null);
      setNote(
        result.empty
          ? "Nothing was restored — the page already says everything that version said."
          : `${result.restored} change${result.restored === 1 ? "" : "s"} put back as a draft.${
              result.dropped.length ? ` ${result.dropped.length} could not be, because that part of the page has moved.` : ""
            }`,
      );
      onRestored();
    },
  });

  const askRollback = useMutation({
    mutationFn: (version: SitePageVersionRow) =>
      api
        .get<RollbackDiff>(`/website/pages/${pageId}/versions/${version.id}/diff`)
        .then((diff) => ({ version, diff })),
    onError: (err) => setFailure(err instanceof ApiError ? err.message : "That version could not be read."),
    onSuccess: (result) => {
      setFailure(null);
      setConfirming(result);
    },
  });

  const rollback = useMutation({
    mutationFn: (versionId: string) =>
      api.post<{ version: number; restoredFrom: number; note: string }>(`/website/pages/${pageId}/versions/${versionId}/publish`),
    onError: (err) => setFailure(err instanceof ApiError ? err.message : "That version could not be published."),
    onSuccess: (result) => {
      setFailure(null);
      setConfirming(null);
      setNote(`Version ${result.restoredFrom} is back on the site, published as version ${result.version}. ${result.note}`);
      void qc.invalidateQueries({ queryKey: ["website"] });
      onRestored();
    },
  });

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-ink/30">
      <div className="flex h-full w-full max-w-xl flex-col overflow-hidden border-l border-line bg-white">
        <div className="flex flex-none items-center justify-between border-b border-line px-5 py-4">
          <div>
            <h2 className="font-display text-base tracking-[-.02em]">Published versions</h2>
            <p className="mt-0.5 text-xs text-muted">Everything that has gone out from this page, most recent first.</p>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>

        {failure && <p className="flex-none border-b border-line bg-red-50 px-5 py-3 text-sm text-red-800">{failure}</p>}
        {note && <p className="flex-none border-b border-line bg-blue/[.06] px-5 py-3 text-sm text-ink">{note}</p>}

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {versions.isLoading ? (
            <div className="text-sm text-muted">Loading…</div>
          ) : (versions.data?.length ?? 0) === 0 ? (
            <EmptyState message="Nothing has been published from this page yet. When it is, every publish will be listed here and can be put back." />
          ) : (
            <ul className="space-y-3">
              {versions.data!.map((version) => (
                <li key={version.id} className="rounded-xl border border-line p-3.5">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="font-display text-sm tracking-[-.02em]">Version {version.number}</span>
                    <span className="text-xs text-muted">
                      {version.publishedBy?.name ? `${version.publishedBy.name} · ` : ""}
                      <RelativeTime value={version.createdAt} />
                    </span>
                    {version.commitUrl && (
                      <a
                        href={version.commitUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs text-muted underline-offset-2 hover:text-ink hover:underline"
                      >
                        commit
                      </a>
                    )}
                    <span className="ml-auto">
                      <TouchedBadges touched={version.touched} />
                    </span>
                  </div>

                  {version.summary.length > 0 ? (
                    <ul className="mt-2 space-y-1 text-xs text-muted">
                      {version.summary.slice(0, 6).map((entry, index) => (
                        <li key={`${entry.id}-${entry.part}-${index}`} className="break-words">
                          {summaryLine(entry)}
                        </li>
                      ))}
                      {version.summary.length > 6 && (
                        <li className="text-ink/50">and {version.summary.length - 6} more</li>
                      )}
                    </ul>
                  ) : (
                    <p className="mt-2 text-xs text-muted">
                      {version.changed} field{version.changed === 1 ? "" : "s"} changed.
                    </p>
                  )}

                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button variant="secondary" size="sm" disabled={restore.isPending} onClick={() => restore.mutate(version.id)}>
                      Restore as draft
                    </Button>
                    {can("website.publish") && (
                      <Button variant="ghost" size="sm" disabled={askRollback.isPending} onClick={() => askRollback.mutate(version)}>
                        Publish this version
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {confirming && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-ink/40 p-6">
          <div className="flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-line bg-white shadow-xl">
            <div className="flex-none border-b border-line px-6 py-4">
              <h3 className="font-display text-base tracking-[-.02em]">Put version {confirming.version.number} back on the site?</h3>
              {/* The server's own sentence, not a paraphrase. It is the whole
                  reason this dialog exists. */}
              <p className="mt-1 text-xs text-amber-800">{confirming.diff.warning}</p>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
              {confirming.diff.identical ? (
                <p className="text-sm text-ink">The page already says exactly this. There is nothing to publish.</p>
              ) : (
                <>
                  <p className="mb-3 text-sm text-ink">
                    {confirming.diff.differenceCount === 0
                      ? "Nothing you can see on the live page would change."
                      : `${confirming.diff.differenceCount} thing${confirming.diff.differenceCount === 1 ? "" : "s"} on the live page would change back.`}{" "}
                    Read from the {confirming.diff.readFrom}.
                  </p>
                  {/* Both halves are true and neither alone is: the file is not
                      identical, and none of what differs is readable. Saying only
                      the first sends somebody hunting for a change that has no
                      appearance. */}
                  {confirming.diff.invisibleCount > 0 && (
                    <p className="mb-3 text-xs text-muted">
                      {confirming.diff.invisibleCount} other field
                      {confirming.diff.invisibleCount === 1 ? "" : "s"} differ in the markup but read exactly the same — usually the gap
                      between the file in the repository and what the live site serves.
                    </p>
                  )}
                  <ul className="space-y-2">
                    {confirming.diff.differences.map((entry) => (
                      <li key={entry.id} className="rounded-lg border border-line p-2.5 text-xs">
                        <div className="mb-1 font-bold uppercase tracking-[.08em] text-muted">{entry.label}</div>
                        <div className="break-words text-muted">
                          <span className="line-through">{entry.now}</span>
                        </div>
                        <div className="break-words text-ink">{entry.after}</div>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>

            <div className="flex flex-none items-center justify-end gap-2 border-t border-line px-6 py-3">
              <Button variant="ghost" size="sm" onClick={() => setConfirming(null)}>
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={confirming.diff.identical || rollback.isPending}
                onClick={() => rollback.mutate(confirming.version.id)}
              >
                {rollback.isPending ? "Publishing…" : `Publish version ${confirming.version.number}`}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
