import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import type { FieldEdit } from "../lib/types";
import { Button } from "./ui";

type Proposal = {
  explanation: string;
  values: Record<string, FieldEdit>;
  changes: Array<{ fieldId: string; label: string; property: string; before: string; after: string }>;
  costUsd: number;
  model: string;
  note: string | null;
};
const LABELS: Record<string, string> = { value: "Content", href: "Link destination", alt: "Image description", style: "Appearance", variant: "Button style", newTab: "Open in new tab" };
const INPUT = "w-full rounded-xl border border-line bg-white px-3 py-2 text-sm text-ink outline-none focus:border-blue focus:ring-2 focus:ring-blue/20";

/** Proposals become one ordinary, undoable local edit through onApply. */
export function WebsiteAssistant({ pageId, selectedFieldId, fieldLabel, values, onApply, onClose }: {
  pageId: string;
  selectedFieldId: string | null;
  fieldLabel?: string | null;
  values: Record<string, FieldEdit>;
  onApply: (changes: Record<string, FieldEdit>) => void;
  onClose: () => void;
}) {
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [previewPending, setPreviewPending] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [selectionOnly, setSelectionOnly] = useState(Boolean(selectedFieldId));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [proposedAgainst, setProposedAgainst] = useState("");
  const [included, setIncluded] = useState<Set<string>>(new Set());
  const panel = useRef<HTMLDivElement>(null);
  const promptInput = useRef<HTMLTextAreaElement>(null);
  const mounted = useRef(true);
  const requestId = useRef(0);
  const close = useRef(onClose);
  close.current = onClose;
  const fingerprint = JSON.stringify([pageId, Object.keys(values).sort().map(id => [id, Object.entries(values[id]).sort(([a], [b]) => a.localeCompare(b))])]);
  const stale = proposal !== null && proposedAgainst !== fingerprint;
  const groups = useMemo(() => {
    const result = new Map<string, Proposal["changes"]>();
    for (const change of proposal?.changes ?? []) result.set(change.fieldId, [...(result.get(change.fieldId) ?? []), change]);
    return [...result];
  }, [proposal]);

  useEffect(() => {
    mounted.current = true;
    const previous = document.activeElement;
    promptInput.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close.current(); }
      if (event.key !== "Tab") return;
      const focusable = Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not([disabled]), textarea:not([disabled]), input:not([disabled]), a[href]') ?? []);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      mounted.current = false;
      requestId.current += 1;
      document.removeEventListener("keydown", onKey, true);
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);

  useEffect(() => {
    setProposal(null);
    setSelectionOnly(Boolean(selectedFieldId));
    setError(null);
    setPending(false);
    requestId.current += 1;
  }, [pageId, selectedFieldId]);

  async function suggest() {
    if (pending || prompt.trim().length < 3) return;
    const id = ++requestId.current;
    setPending(true);
    setError(null);
    setProposal(null);
    try {
      const result = await api.post<Proposal>(`/website/pages/${encodeURIComponent(pageId)}/assistant`, {
        prompt: prompt.trim(), selectedFieldId: selectionOnly ? selectedFieldId : null, values,
      });
      if (!mounted.current || id !== requestId.current) return;
      setProposal(result);
      setProposedAgainst(fingerprint);
      setIncluded(new Set(Object.keys(result.values)));
    } catch (caught) {
      if (mounted.current && id === requestId.current) setError(caught instanceof Error ? caught.message : "The assistant could not prepare a suggestion. Please try again.");
    } finally {
      if (mounted.current && id === requestId.current) setPending(false);
    }
  }

  useEffect(() => setPreviewHtml(null), [proposal, included, fingerprint]);
  async function previewProposal() {
    if (!proposal || stale || !included.size) return;
    setPreviewPending(true); setError(null);
    const merged = { ...values };
    for (const [id, patch] of Object.entries(proposal.values)) if (included.has(id)) merged[id] = { ...merged[id], ...patch };
    try {
      const result = await api.post<{ html: string }>(`/website/pages/${encodeURIComponent(pageId)}/assistant/preview`, { values: merged, selectedFieldId: selectionOnly ? selectedFieldId : null });
      if (mounted.current) setPreviewHtml(result.html);
    } catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : "Preview failed."); }
    finally { if (mounted.current) setPreviewPending(false); }
  }

  function apply() {
    if (!proposal || stale || !included.size) return;
    onApply(Object.fromEntries(Object.entries(proposal.values).filter(([id]) => included.has(id))));
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-ink/30" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={panel} role="dialog" aria-modal="true" aria-labelledby="website-assistant-title" className="flex h-full w-full max-w-lg flex-col overflow-hidden border-l border-line bg-white shadow-2xl">
        <div className="flex flex-none items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div>
            <h2 id="website-assistant-title" className="font-display text-lg tracking-[-.02em]">Design assistant</h2>
            <p className="mt-1 text-xs text-muted">Describe a change, review it, then add it to your draft.</p>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
          <form onSubmit={event => { event.preventDefault(); void suggest(); }}>
            <label htmlFor="website-assistant-prompt" className="mb-2 block text-sm font-semibold">What would you like to change?</label>
            <textarea ref={promptInput} id="website-assistant-prompt" value={prompt} onChange={event => setPrompt(event.target.value)} maxLength={3000} rows={4} disabled={pending} className={`${INPUT} resize-y`} placeholder="Make this heading larger, add more breathing room, and use a warmer colour…" />
            <div className="mt-2 flex flex-wrap gap-1.5">
              {["Improve spacing and readability", "Make the heading more concise", "Give the buttons a softer style"].map(example => <button key={example} type="button" disabled={pending} onClick={() => { setPrompt(example); promptInput.current?.focus(); }} className="rounded-full border border-line px-2.5 py-1 text-[11px] text-muted hover:border-ink/30 hover:text-ink disabled:opacity-50">{example}</button>)}
            </div>
            {selectedFieldId ? (
              <label className="mt-4 flex items-start gap-2.5 text-sm">
                <input type="checkbox" className="mt-0.5 accent-ink" checked={selectionOnly} onChange={event => setSelectionOnly(event.target.checked)} disabled={pending} />
                <span>Only change <strong>{fieldLabel || "the selected element"}</strong><span className="mt-0.5 block text-xs text-muted">Uncheck to include the whole page.</span></span>
              </label>
            ) : <p className="mt-4 text-xs text-muted">Suggestions can use any editable element on this page.</p>}
            <div className="mt-4"><Button type="submit" disabled={pending || prompt.trim().length < 3}>{pending ? "Preparing suggestions…" : proposal ? "Suggest again" : "Suggest changes"}</Button></div>
          </form>

          <div aria-live="polite" className="mt-5">
            {pending && <p className="rounded-xl bg-cream px-4 py-3 text-sm text-muted" role="status">Reading the current page and your draft. This can take a moment.</p>}
            {error && <p role="alert" className="rounded-xl border border-danger-line bg-danger-surface px-4 py-3 text-sm text-danger-text">{error}</p>}
            {proposal && <p className="rounded-xl border border-line bg-cream px-4 py-3 text-sm text-ink">{proposal.explanation}</p>}
            {stale && <p role="alert" className="mt-3 rounded-xl border border-warn-line bg-warn-surface px-4 py-3 text-sm text-warn-text">Your draft changed while these suggestions were being prepared. Ask again to use the latest changes.</p>}
          </div>

          {groups.length > 0 && <div className="mt-5 space-y-3">
            <h3 className="font-display text-base">Review changes</h3>
            {groups.map(([id, changes]) => <section key={id} className={`overflow-hidden rounded-xl border ${included.has(id) ? "border-line" : "border-dashed border-line opacity-60"}`}>
              <label className="flex items-center gap-2.5 border-b border-line bg-cream px-3 py-2.5 text-sm font-semibold">
                <input type="checkbox" className="accent-ink" checked={included.has(id)} onChange={event => setIncluded(current => { const next = new Set(current); if (event.target.checked) next.add(id); else next.delete(id); return next; })} />
                {changes[0].label}
              </label>
              {changes.map(change => <div key={change.property} className="px-3 py-3">
                <div className="mb-2 text-xs font-semibold text-muted">{LABELS[change.property] ?? change.property}</div>
                <div className="space-y-2 text-xs">
                  <div><span className="font-semibold text-muted">Before</span><p className="mt-1 whitespace-pre-wrap break-words rounded-lg bg-sunken p-2 text-muted">{change.before || "Not set"}</p></div>
                  <div><span className="font-semibold text-positive-text">After</span><p className="mt-1 whitespace-pre-wrap break-words rounded-lg bg-positive-surface p-2 text-ink">{change.after || "Not set"}</p></div>
                </div>
              </div>)}
            </section>)}
          </div>}
          {proposal && groups.length > 0 && <section className="mt-4"><Button disabled={stale || previewPending || !included.size} onClick={() => void previewProposal()}>{previewPending ? "Loading preview?" : "Preview selected changes"}</Button>{previewHtml && <><p className="my-2 text-xs text-muted">Static preview. Interactive scripts are paused. Nothing has been saved.</p><iframe title="Proposed page preview" sandbox="" srcDoc={previewHtml} className="mt-3 h-96 w-full border border-line bg-white" /></>}</section>}
          {proposal && !groups.length && <p className="mt-3 text-sm text-muted">No changes were proposed. Refine your request or adjust the page with the visual controls.</p>}
          {proposal?.note && <p className="mt-4 text-xs text-muted">{proposal.note}</p>}
          {proposal && <p className="mt-4 text-[11px] text-muted">Suggestion cost: {proposal.costUsd > 0 ? `$${proposal.costUsd.toFixed(4)}` : "$0.00"}</p>}
        </div>
        <div className="flex flex-none items-center justify-between gap-4 border-t border-line bg-white px-5 py-4">
          <p className="max-w-[230px] text-xs text-muted">Applied changes appear on your canvas. You can undo them before publishing.</p>
          <Button variant="accent" disabled={!proposal || stale || !included.size || pending} onClick={apply}>Apply {included.size || ""}{included.size === 1 ? " change" : " changes"}</Button>
        </div>
      </div>
    </div>
  );
}
