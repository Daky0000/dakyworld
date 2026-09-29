import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../lib/api";
import { Button } from "./ui";
import { IconCheck, IconRefresh, IconSearch, IconSparkles } from "./WebsiteIcons";

export type ContentMatchOccurrence = {
  pageId: string;
  pageTitle: string;
  pagePath: string;
  fieldId: string;
  fieldLabel: string;
  currentValue: string;
  proposedValue: string;
  matchCount: number;
};

export type FindReplaceSearchResult = {
  query: string;
  replacement: string;
  totalMatches: number;
  affectedPages: number;
  occurrences: ContentMatchOccurrence[];
  summary: string;
};

export type GlobalToken = {
  key: string;
  label: string;
  value: string;
  description?: string;
};

export function WebsiteFindReplaceModal({
  siteId,
  onClose,
  onApplied,
}: {
  siteId: string;
  onClose: () => void;
  onApplied: () => void;
}) {
  const qc = useQueryClient();
  const [activeTab, setActiveTab] = useState<"findReplace" | "tokens">("findReplace");

  // Find & Replace State
  const [searchQuery, setSearchQuery] = useState("");
  const [replacementText, setReplacementText] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [selectedMatches, setSelectedMatches] = useState<Record<string, boolean>>({});
  const [searchResult, setSearchResult] = useState<FindReplaceSearchResult | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  // Global Tokens State
  const tokensQuery = useQuery({
    queryKey: ["website", "global-content", siteId],
    queryFn: ({ signal }) => api.get<{ tokens: GlobalToken[] }>(`/website/sites/${siteId}/global-content`, signal),
  });
  const [editedTokens, setEditedTokens] = useState<GlobalToken[]>([]);

  // Initialize tokens when query loads
  useState(() => {
    if (tokensQuery.data?.tokens) {
      setEditedTokens(tokensQuery.data.tokens);
    }
  });

  const searchMutation = useMutation({
    mutationFn: () =>
      api.post<FindReplaceSearchResult>(`/website/sites/${siteId}/find-replace/search`, {
        query: searchQuery.trim(),
        replacement: replacementText,
        caseSensitive,
      }),
    onSuccess: (res) => {
      setSearchResult(res);
      const initialSelected: Record<string, boolean> = {};
      for (const occ of res.occurrences) {
        initialSelected[`${occ.pageId}:${occ.fieldId}`] = true;
      }
      setSelectedMatches(initialSelected);
      setStatusMessage(null);
    },
  });

  const applyMutation = useMutation({
    mutationFn: () => {
      const selectedOccurrences = Object.entries(selectedMatches)
        .filter(([, checked]) => checked)
        .map(([key]) => {
          const [pageId, fieldId] = key.split(":");
          return { pageId, fieldId };
        });

      return api.post(`/website/sites/${siteId}/find-replace/apply`, {
        query: searchQuery.trim(),
        replacement: replacementText,
        caseSensitive,
        selectedOccurrences,
      });
    },
    onSuccess: (res: any) => {
      setStatusMessage(`✓ Replaced ${res.modifiedOccurrences} occurrence(s) across ${res.modifiedPages} page(s).`);
      setSearchResult(null);
      void qc.invalidateQueries({ queryKey: ["website"] });
      onApplied();
    },
  });

  const saveTokensMutation = useMutation({
    mutationFn: (tokensToSave: GlobalToken[]) =>
      api.put(`/website/sites/${siteId}/global-content`, { tokens: tokensToSave }),
    onSuccess: () => {
      setStatusMessage("✓ Global tokens updated and synced across all pages.");
      void qc.invalidateQueries({ queryKey: ["website"] });
      void tokensQuery.refetch();
      onApplied();
    },
  });

  const tokens = editedTokens.length > 0 ? editedTokens : tokensQuery.data?.tokens || [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/50 p-4 backdrop-blur-2xs">
      <div className="flex max-h-[88vh] w-full max-w-3xl flex-col rounded-2xl bg-white shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-line p-5">
          <div>
            <h2 className="font-display text-lg font-bold text-ink">
              Multi-Page Content & Global Tokens
            </h2>
            <p className="mt-0.5 text-xs text-muted">
              Batch edit content across every page or manage site-wide synchronized data.
            </p>
          </div>

          <div className="inline-flex rounded-xl border border-line bg-sunken/40 p-0.5 text-xs">
            <button
              type="button"
              onClick={() => setActiveTab("findReplace")}
              className={`rounded-lg px-3 py-1 font-semibold transition ${
                activeTab === "findReplace" ? "bg-ink text-white" : "text-muted hover:text-ink"
              }`}
            >
              Find & Replace All
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("tokens")}
              className={`rounded-lg px-3 py-1 font-semibold transition ${
                activeTab === "tokens" ? "bg-ink text-white" : "text-muted hover:text-ink"
              }`}
            >
              Global Content Tokens
            </button>
          </div>
        </div>

        {/* Status Toast */}
        {statusMessage && (
          <div className="border-b border-emerald-200 bg-emerald-50 px-5 py-2.5 text-xs font-semibold text-emerald-800">
            {statusMessage}
          </div>
        )}

        {/* Content */}
        <div className="min-h-0 flex-1 overflow-y-auto p-5 text-xs">
          {activeTab === "findReplace" ? (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="block font-semibold text-ink mb-1">Search Term</label>
                  <input
                    type="text"
                    placeholder="e.g. +1 (555) 019-2834 or Summer Sale"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full rounded-xl border border-line px-3 py-2 text-xs outline-none focus:border-blue"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-ink mb-1">Replacement Text</label>
                  <input
                    type="text"
                    placeholder="e.g. +1 (555) 999-0000 or Autumn Sale"
                    value={replacementText}
                    onChange={(e) => setReplacementText(e.target.value)}
                    className="w-full rounded-xl border border-line px-3 py-2 text-xs outline-none focus:border-blue"
                  />
                </div>
              </div>

              <div className="flex items-center justify-between">
                <label className="flex items-center gap-2 cursor-pointer text-muted select-none">
                  <input
                    type="checkbox"
                    checked={caseSensitive}
                    onChange={(e) => setCaseSensitive(e.target.checked)}
                    className="rounded border-line"
                  />
                  <span>Match case exactly</span>
                </label>

                <Button
                  size="sm"
                  disabled={!searchQuery.trim() || searchMutation.isPending}
                  onClick={() => searchMutation.mutate()}
                >
                  <span className="inline-flex items-center gap-1.5">
                    <IconSearch size={13} />
                    <span>{searchMutation.isPending ? "Searching…" : "Search All Pages"}</span>
                  </span>
                </Button>
              </div>

              {/* Search Results Preview */}
              {searchResult && (
                <div className="mt-4 rounded-xl border border-line bg-sunken/30 p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-ink">{searchResult.summary}</span>
                    <button
                      type="button"
                      onClick={() => {
                        const allSelected = Object.values(selectedMatches).every(Boolean);
                        const next: Record<string, boolean> = {};
                        for (const occ of searchResult.occurrences) {
                          next[`${occ.pageId}:${occ.fieldId}`] = !allSelected;
                        }
                        setSelectedMatches(next);
                      }}
                      className="text-blue hover:underline"
                    >
                      {Object.values(selectedMatches).every(Boolean) ? "Deselect All" : "Select All"}
                    </button>
                  </div>

                  <div className="max-h-60 overflow-y-auto space-y-2">
                    {searchResult.occurrences.map((occ) => {
                      const matchKey = `${occ.pageId}:${occ.fieldId}`;
                      const isChecked = Boolean(selectedMatches[matchKey]);
                      return (
                        <div
                          key={matchKey}
                          className="flex items-start gap-2.5 rounded-lg border border-line bg-white p-2.5"
                        >
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={(e) =>
                              setSelectedMatches({
                                ...selectedMatches,
                                [matchKey]: e.target.checked,
                              })
                            }
                            className="mt-0.5 rounded border-line"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5 font-semibold text-ink">
                              <span>{occ.pageTitle}</span>
                              <span className="text-muted">· {occ.fieldLabel}</span>
                            </div>
                            <div className="mt-1 grid gap-2 sm:grid-cols-2 text-[11px]">
                              <div className="rounded bg-sunken px-2 py-1 text-muted line-through">
                                {occ.currentValue}
                              </div>
                              <div className="rounded bg-blue/10 px-2 py-1 text-blue font-medium">
                                {occ.proposedValue}
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              <p className="text-muted">
                Global tokens allow business owners to update contact info, addresses, and hours in one place, syncing across all pages automatically.
              </p>

              <div className="space-y-3">
                {tokens.map((token, index) => (
                  <div
                    key={token.key}
                    className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-white p-3"
                  >
                    <div className="w-36">
                      <span className="font-semibold text-ink">{token.label}</span>
                      <span className="block font-mono text-[10px] text-muted">
                        {"{{" + token.key + "}}"}
                      </span>
                    </div>
                    <div className="flex-1 min-w-[200px]">
                      <input
                        type="text"
                        value={token.value}
                        onChange={(e) => {
                          const next = [...tokens];
                          next[index] = { ...next[index], value: e.target.value };
                          setEditedTokens(next);
                        }}
                        className="w-full rounded-lg border border-line px-2.5 py-1.5 text-xs outline-none focus:border-blue"
                      />
                    </div>
                  </div>
                ))}
              </div>

              <div className="flex justify-end pt-2">
                <Button
                  size="sm"
                  disabled={saveTokensMutation.isPending}
                  onClick={() => saveTokensMutation.mutate(tokens)}
                >
                  <span className="inline-flex items-center gap-1.5">
                    <IconRefresh size={13} />
                    <span>{saveTokensMutation.isPending ? "Syncing…" : "Sync Tokens Site-Wide"}</span>
                  </span>
                </Button>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-line p-4">
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>

          {activeTab === "findReplace" && searchResult && (
            <Button
              variant="accent"
              disabled={
                applyMutation.isPending ||
                !Object.values(selectedMatches).some(Boolean)
              }
              onClick={() => applyMutation.mutate()}
            >
              {applyMutation.isPending ? "Applying…" : "Apply to Selected Pages"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
