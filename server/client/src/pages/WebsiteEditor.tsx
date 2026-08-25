import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { api, ApiError, apiUrl } from "../lib/api";
import { useAuth } from "../lib/auth";
import type { DraftSaveResult, FieldEdit, PublishResult, SiteFieldRow, SitePageDetail } from "../lib/types";
import { Badge, Button, RelativeTime } from "../components/ui";
import { StylePanel } from "../components/StylePanel";

/**
 * One page, as a list of things that can be changed.
 *
 * The design of the page is not editable here and that is the point. What a
 * client gets is every heading, paragraph, button, link and picture with a plain
 * label on it — "Main heading", not "h1" — grouped under the section it appears
 * in, with the section named after its own heading. Nobody has to know what a
 * `<div>` is, and nobody can break the layout by editing one.
 *
 * Saving and publishing are deliberately two different actions. Saving is
 * private and automatic; publishing commits the page and changes what the world
 * sees, so it is a button somebody presses on purpose.
 */

const DEVICES = [
  { key: "desktop", label: "Desktop", width: "100%" },
  { key: "tablet", label: "Tablet", width: "820px" },
  { key: "mobile", label: "Phone", width: "390px" },
] as const;

type Device = (typeof DEVICES)[number]["key"];

/**
 * Three ways to work on a page, and they answer different questions.
 *
 * **Visual** is point at the thing you mean. **List** is the form — every
 * field on the page under the section it belongs to, which is the only view
 * that can answer "did I miss anything" and the only one that reaches a field
 * with nothing visible to click (the page title, the description). **Preview**
 * is the page as it will be, with no editor furniture on it at all.
 */
type Mode = "visual" | "edit" | "preview";

const MODES: { key: Mode; label: string }[] = [
  { key: "visual", label: "Visual" },
  { key: "edit", label: "List" },
  { key: "preview", label: "Preview" },
];

const INPUT =
  "w-full rounded-xl border border-line bg-white px-3 py-2 text-sm text-ink outline-none focus:border-blue focus:ring-2 focus:ring-blue/20";

/**
 * A field with formatting inside it.
 *
 * Uncontrolled on purpose: React writing `innerHTML` on every keystroke moves
 * the caret to the end of the box, which makes a paragraph impossible to edit in
 * the middle. The DOM owns the content while it is being typed in, and the
 * component is remounted by its key when the page reloads underneath it.
 */
function RichText({ html, onChange }: { html: string; onChange: (next: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (ref.current && ref.current.innerHTML !== html) ref.current.innerHTML = html;
    // Once, on mount. See the note above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={ref}
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-multiline="true"
      className={`${INPUT} min-h-[44px] whitespace-pre-wrap`}
      onInput={() => onChange(ref.current?.innerHTML ?? "")}
      onPaste={(event) => {
        // Pasting out of a word processor brings its markup with it. The words
        // are what somebody meant to paste.
        event.preventDefault();
        const text = event.clipboardData.getData("text/plain");
        document.execCommand("insertText", false, text);
      }}
      onKeyDown={(event) => {
        // These are lines within an element, not new paragraphs — the browser's
        // default here is a `<div>`, which would put a block inside a heading.
        if (event.key === "Enter") {
          event.preventDefault();
          document.execCommand("insertLineBreak");
        }
      }}
    />
  );
}

function FieldRow({
  field,
  edit,
  problem,
  publicUrl,
  onChange,
  readOnly,
  bare,
}: {
  field: SiteFieldRow;
  edit: FieldEdit | undefined;
  problem: string | undefined;
  publicUrl: string;
  onChange: (next: FieldEdit) => void;
  readOnly: boolean;
  /** Inside the visual panel, where the card's own border and title are noise. */
  bare?: boolean;
}) {
  const value = edit?.value ?? field.value;
  const href = edit?.href ?? field.href ?? "";
  const alt = edit?.alt ?? field.alt ?? "";
  const changed = edit !== undefined && Object.keys(edit).length > 0;

  const imageSrc = useMemo(() => {
    if (field.kind !== "image") return null;
    try {
      return new URL(value, `${publicUrl.replace(/\/+$/, "")}/`).toString();
    } catch {
      return null;
    }
  }, [field.kind, value, publicUrl]);

  return (
    <div
      className={
        bare
          ? ""
          : `rounded-2xl border p-4 ${problem ? "border-amber-300 bg-amber-50/40" : changed ? "border-blue/40 bg-blue/[.02]" : "border-line bg-white"}`
      }
    >
      {!bare && (
        <div className="mb-2 flex items-center justify-between gap-3">
          <span className="text-[11px] font-bold uppercase tracking-[.1em] text-muted">{field.label}</span>
          {changed && <Badge tone="warn">Changed</Badge>}
        </div>
      )}
      {bare && changed && (
        <div className="mb-2">
          <Badge tone="warn">Changed</Badge>
        </div>
      )}

      {field.kind === "richtext" && (
        <RichText html={value} onChange={(next) => onChange({ ...edit, value: next })} />
      )}

      {field.kind === "text" && (
        <textarea
          className={`${INPUT} resize-y`}
          rows={value.length > 90 ? 3 : 1}
          value={value}
          readOnly={readOnly}
          onChange={(event) => onChange({ ...edit, value: event.target.value })}
        />
      )}

      {field.kind === "link" && (
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-xs text-muted">Words on the link</span>
            <input
              className={INPUT}
              value={value}
              readOnly={readOnly || !field.value}
              placeholder={field.value ? "" : "This link has no words of its own"}
              onChange={(event) => onChange({ ...edit, value: event.target.value })}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-muted">Where it goes</span>
            <input
              className={`${INPUT} font-mono text-xs`}
              value={href}
              readOnly={readOnly}
              onChange={(event) => onChange({ ...edit, href: event.target.value })}
            />
          </label>
        </div>
      )}

      {field.kind === "image" && (
        <div className="flex flex-wrap items-start gap-4">
          {imageSrc && (
            <img
              src={imageSrc}
              alt=""
              className="h-16 w-16 rounded-lg border border-line bg-cream object-contain p-1"
              onError={(event) => ((event.target as HTMLImageElement).style.visibility = "hidden")}
            />
          )}
          <div className="min-w-[240px] flex-1 space-y-2">
            <label className="block">
              <span className="mb-1 block text-xs text-muted">Picture file</span>
              <input
                className={`${INPUT} font-mono text-xs`}
                value={value}
                readOnly={readOnly}
                onChange={(event) => onChange({ ...edit, value: event.target.value })}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-muted">
                Description, for somebody who cannot see it
              </span>
              <input
                className={INPUT}
                value={alt}
                readOnly={readOnly}
                placeholder={field.decorative ? "Marked as decoration" : ""}
                onChange={(event) => onChange({ ...edit, alt: event.target.value })}
              />
            </label>
          </div>
        </div>
      )}

      {field.note && <p className="mt-2 text-xs text-muted">{field.note}</p>}
      {problem && <p className="mt-2 text-xs font-semibold text-amber-800">{problem}</p>}
    </div>
  );
}

/**
 * Point at the thing you mean.
 *
 * The preview already renders the page with the unpublished draft in it; all
 * this adds is that the server marks every editable element on the way out
 * (`?pick=1`), the frame posts up which one was clicked, and the panel beside
 * it edits that one. No drag and drop, nothing moves, nothing is added or
 * deleted — the file is somebody's hand-written HTML and the whole module is a
 * splice at recorded offsets. What changes is only ever what a person selected.
 *
 * The ids come from the server's own parse rather than being worked out in the
 * browser, because they are positional; a second implementation on this side
 * would have to agree with the first for ever, and the day it stopped agreeing
 * an edit would land in the wrong element.
 */
function VisualEditor({
  pageId,
  previewToken,
  device,
  onDevice,
  frame,
  fields,
  picked,
  pickedId,
  onPick,
  edits,
  problems,
  publicUrl,
  readOnly,
  loadToken,
  onChange,
}: {
  pageId: string;
  previewToken: number;
  device: Device;
  onDevice: (device: Device) => void;
  frame: React.MutableRefObject<HTMLIFrameElement | null>;
  fields: SiteFieldRow[];
  picked: SiteFieldRow | null;
  pickedId: string | null;
  onPick: (id: string | null) => void;
  edits: Record<string, FieldEdit>;
  problems: Map<string, string>;
  publicUrl: string;
  readOnly: boolean;
  loadToken: number;
  onChange: (fieldId: string, next: FieldEdit) => void;
}) {
  // The frame is same-origin but talked to by message anyway: it is the only
  // channel that keeps working if the preview is ever served from the site's
  // own origin instead, which is where this is heading for client sites.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { source?: string; type?: string; id?: string | null };
      if (data?.source !== "dakyworld-preview") return;
      if (data.type === "select") onPick(data.id ?? null);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onPick]);

  const tell = (id: string | null) => {
    frame.current?.contentWindow?.postMessage({ source: "dakyworld-editor", type: "select", id }, "*");
  };

  const edit = pickedId ? (edits[pickedId] ?? {}) : {};
  const style = edit.style ?? picked?.style ?? "";

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_320px]">
      <div>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {DEVICES.map((option) => (
            <button
              key={option.key}
              type="button"
              onClick={() => onDevice(option.key)}
              className={`border px-3 py-1.5 font-mono text-[10px] uppercase tracking-[.12em] ${
                device === option.key ? "border-ink bg-ink text-cream" : "border-ink/20 text-ink/60 hover:border-ink/40"
              }`}
            >
              {option.label}
            </button>
          ))}
          <span className="ml-1 text-xs text-muted">
            {picked ? `Editing the ${picked.label.toLowerCase()}.` : "Click anything on the page to edit it."}
          </span>
        </div>

        <div className="flex justify-center overflow-hidden rounded-2xl border border-line bg-cream p-4">
          <iframe
            ref={frame}
            key={`${previewToken}-${device}`}
            title="Page"
            src={apiUrl(`/website/pages/${pageId}/preview?pick=1&v=${previewToken}`)}
            style={{ width: DEVICES.find((option) => option.key === device)!.width }}
            className="h-[72vh] rounded-xl border border-line bg-white"
          />
        </div>
      </div>

      <aside className="xl:sticky xl:top-6 xl:self-start">
        <div className="rounded-2xl border border-line bg-white p-4">
          {!picked ? (
            <div className="py-6 text-center">
              <p className="text-sm font-semibold text-ink">Nothing selected</p>
              <p className="mt-1 text-xs text-muted">
                Click a heading, a paragraph, a button or a picture in the page. Its words and its look appear here.
              </p>
              <p className="mt-4 text-[11px] text-muted">
                {fields.length} editable {fields.length === 1 ? "thing" : "things"} on this page.
              </p>
            </div>
          ) : (
            <>
              <div className="mb-3 flex items-start justify-between gap-2 border-b border-line pb-3">
                <div className="min-w-0">
                  <div className="font-mono text-[10px] uppercase tracking-[.12em] text-ink/40">{picked.tag}</div>
                  <h3 className="truncate font-display text-base tracking-[-.02em]">{picked.label}</h3>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    onPick(null);
                    tell(null);
                  }}
                  className="shrink-0 text-[11px] text-muted transition hover:text-ink"
                >
                  Clear
                </button>
              </div>

              <FieldRow
                key={`${loadToken}:${picked.id}`}
                field={picked}
                edit={edits[picked.id]}
                problem={problems.get(picked.id)}
                publicUrl={publicUrl}
                readOnly={readOnly}
                onChange={(next) => onChange(picked.id, next)}
                bare
              />

              <div className="mt-4 border-t border-line pt-4">
                <div className="mb-3 font-mono text-[10px] uppercase tracking-[.14em] text-ink/40">Look</div>
                <StylePanel
                  style={style}
                  readOnly={readOnly}
                  onChange={(next) => onChange(picked.id, { ...edits[picked.id], style: next })}
                  onReset={() => onChange(picked.id, { ...edits[picked.id], style: "" })}
                />
              </div>
            </>
          )}
        </div>

        {/* The list of everything, so a field with nothing visible to click —
            and anything scrolled far off screen — is still reachable. */}
        <details className="mt-3 rounded-2xl border border-line bg-white p-4">
          <summary className="cursor-pointer text-[11px] font-bold uppercase tracking-[.1em] text-muted">
            Everything on this page
          </summary>
          <ul className="mt-3 max-h-72 space-y-0.5 overflow-y-auto">
            {fields.map((field) => (
              <li key={field.id}>
                <button
                  type="button"
                  onClick={() => {
                    onPick(field.id);
                    tell(field.id);
                  }}
                  className={`flex w-full items-baseline gap-2 rounded-lg px-2 py-1.5 text-left text-xs ${
                    field.id === pickedId ? "bg-ink text-cream" : "text-ink hover:bg-ink/[.04]"
                  }`}
                >
                  <span className={`shrink-0 font-mono text-[9px] uppercase ${field.id === pickedId ? "text-cream/60" : "text-muted"}`}>
                    {field.tag}
                  </span>
                  <span className="truncate">{field.preview || field.label}</span>
                  {edits[field.id] && <span className="ml-auto shrink-0 text-[9px]">●</span>}
                </button>
              </li>
            ))}
          </ul>
        </details>
      </aside>
    </div>
  );
}

export function WebsiteEditor() {
  const { pageId = "" } = useParams();
  const qc = useQueryClient();
  const { can } = useAuth();

  const [edits, setEdits] = useState<Record<string, FieldEdit>>({});
  const [sectionId, setSectionId] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("visual");
  /** The field the person clicked in the preview. */
  const [pickedId, setPickedId] = useState<string | null>(null);
  const frame = useRef<HTMLIFrameElement | null>(null);
  const [device, setDevice] = useState<Device>("desktop");
  const [previewToken, setPreviewToken] = useState(0);
  const [published, setPublished] = useState<PublishResult | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  /** Bumped when the server's copy replaces local state, to remount the uncontrolled fields. */
  const [loadToken, setLoadToken] = useState(0);
  const dirty = useRef(false);

  const page = useQuery({
    queryKey: ["website", "page", pageId],
    queryFn: () => api.get<SitePageDetail>(`/website/pages/${pageId}`),
  });

  // The draft on the server is the starting point, and it is authoritative
  // whenever the page is loaded — including after a publish, which clears it.
  useEffect(() => {
    if (!page.data) return;
    setEdits(page.data.draft.values);
    setLoadToken((token) => token + 1);
    dirty.current = false;
    setSectionId((current) => current ?? page.data.sections[0]?.id ?? null);
  }, [page.data]);

  const save = useMutation({
    mutationFn: (values: Record<string, FieldEdit>) => api.put<DraftSaveResult>(`/website/pages/${pageId}/draft`, { values }),
    onSuccess: () => {
      dirty.current = false;
      setPreviewToken((token) => token + 1);
      void qc.invalidateQueries({ queryKey: ["website", "sites"] });
    },
  });

  const saveNow = useCallback(
    (values: Record<string, FieldEdit>) => {
      save.mutate(values);
    },
    [save],
  );

  // Autosave. Long enough not to write on every keystroke, short enough that
  // leaving the screen almost never loses anything — and the guard below covers
  // the case where it does.
  useEffect(() => {
    if (!dirty.current) return;
    const timer = setTimeout(() => saveNow(edits), 1200);
    return () => clearTimeout(timer);
  }, [edits, saveNow]);

  useEffect(() => {
    const onLeave = (event: BeforeUnloadEvent) => {
      if (!dirty.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onLeave);
    return () => window.removeEventListener("beforeunload", onLeave);
  }, []);

  const discard = useMutation({
    mutationFn: () => api.delete(`/website/pages/${pageId}/draft`),
    onSuccess: () => {
      setEdits({});
      dirty.current = false;
      setPreviewToken((token) => token + 1);
      void qc.invalidateQueries({ queryKey: ["website"] });
    },
  });

  const publish = useMutation({
    mutationFn: () => api.post<PublishResult>(`/website/pages/${pageId}/publish`),
    onSuccess: (result) => {
      setFailure(null);
      setPublished(result);
      setEdits({});
      dirty.current = false;
      void qc.invalidateQueries({ queryKey: ["website"] });
    },
    onError: (err) => {
      setPublished(null);
      setFailure(err instanceof ApiError ? err.message : "The publish did not finish.");
      // The page may have moved under the draft; reload so the editor shows it
      // as it now is rather than as it was when this screen opened.
      void qc.invalidateQueries({ queryKey: ["website", "page", pageId] });
    },
  });

  const change = (fieldId: string, next: FieldEdit) => {
    dirty.current = true;
    setPublished(null);
    setEdits((current) => ({ ...current, [fieldId]: next }));
  };

  const problems = useMemo(() => {
    const map = new Map<string, string>();
    for (const problem of save.data?.problems ?? page.data?.problems ?? []) map.set(problem.id, problem.reason);
    return map;
  }, [save.data, page.data]);

  if (page.isLoading) return <div className="text-sm text-muted">Opening the page…</div>;
  if (page.isError) {
    return (
      <div className="rounded-2xl border border-amber-300 bg-amber-50 p-6 text-sm text-amber-900">
        {page.error instanceof ApiError ? page.error.message : "That page could not be opened."}
      </div>
    );
  }
  if (!page.data) return null;

  const { sections, site } = page.data;
  const section = sections.find((candidate) => candidate.id === sectionId) ?? sections[0] ?? null;
  const allFields = sections.flatMap((candidate) => candidate.fields);
  const picked = pickedId ? (allFields.find((field) => field.id === pickedId) ?? null) : null;
  const changedCount = Object.values(edits).filter((edit) => Object.keys(edit).length > 0).length;
  const canPublish = can("website.publish");
  const readOnly = !can("website.edit");

  const status = save.isPending
    ? "Saving…"
    : dirty.current
      ? "Unsaved changes"
      : changedCount > 0
        ? `${changedCount} unpublished change${changedCount === 1 ? "" : "s"}`
        : "Everything published";

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4 border-b border-line pb-5">
        <div>
          <Link to="/website" className="text-xs text-muted underline-offset-2 hover:text-ink hover:underline">
            ← All pages
          </Link>
          <h1 className="mt-2 font-display text-2xl tracking-[-.03em]">{page.data.page.title}</h1>
          <p className="mt-1 text-xs text-muted">
            <span className="font-mono">{page.data.page.path}</span> · read from the {page.data.readFrom}
            {page.data.draft.savedAt && (
              <>
                {" "}
                · saved <RelativeTime value={page.data.draft.savedAt} />
              </>
            )}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className={`text-xs ${dirty.current || changedCount > 0 ? "text-ink" : "text-muted"}`}>{status}</span>
          <div className="flex overflow-hidden rounded-full border border-line">
            {MODES.map((option) => (
              <button
                key={option.key}
                type="button"
                onClick={() => {
                  // The frame renders the *saved* draft, so anything typed has
                  // to be written before switching to a view that shows it.
                  if (option.key !== "edit" && dirty.current) saveNow(edits);
                  setPreviewToken((token) => token + 1);
                  setMode(option.key);
                }}
                className={`px-3 py-1.5 text-[11px] font-semibold ${
                  mode === option.key ? "bg-ink text-cream" : "text-muted hover:text-ink"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
          {changedCount > 0 && !readOnly && (
            <Button variant="ghost" size="sm" onClick={() => discard.mutate()} disabled={discard.isPending}>
              Discard changes
            </Button>
          )}
          {canPublish && (
            <Button
              variant="accent"
              onClick={() => {
                if (dirty.current) saveNow(edits);
                if (window.confirm(`Publish ${page.data!.page.title} to ${site.publicUrl}? This changes the live page.`)) publish.mutate();
              }}
              disabled={publish.isPending || changedCount === 0}
            >
              {publish.isPending ? "Publishing…" : "Publish"}
            </Button>
          )}
        </div>
      </div>

      {published && (
        <div className="mb-6 rounded-2xl border border-line bg-white p-5 text-sm">
          <p className="font-semibold text-ink">
            Published — version {published.version}, {published.changed} change{published.changed === 1 ? "" : "s"}.
          </p>
          <p className="mt-1 text-muted">{published.note}</p>
          <div className="mt-3 flex flex-wrap gap-4 text-xs">
            <a href={published.url} target="_blank" rel="noreferrer" className="text-ink underline-offset-2 hover:underline">
              Open the live page
            </a>
            <a href={published.commit.url} target="_blank" rel="noreferrer" className="text-muted underline-offset-2 hover:underline">
              See the commit
            </a>
          </div>
        </div>
      )}

      {failure && <div className="mb-6 rounded-2xl border border-amber-300 bg-amber-50 p-5 text-sm text-amber-900">{failure}</div>}

      {mode === "visual" ? (
        <VisualEditor
          pageId={pageId}
          previewToken={previewToken}
          device={device}
          onDevice={setDevice}
          frame={frame}
          fields={allFields}
          picked={picked}
          pickedId={pickedId}
          onPick={setPickedId}
          edits={edits}
          problems={problems}
          publicUrl={site.publicUrl}
          readOnly={readOnly}
          loadToken={loadToken}
          onChange={change}
        />
      ) : mode === "preview" ? (
        <div>
          <div className="mb-3 flex items-center gap-2">
            {DEVICES.map((option) => (
              <button
                key={option.key}
                type="button"
                onClick={() => setDevice(option.key)}
                className={`border px-3 py-1.5 font-mono text-[10px] uppercase tracking-[.12em] ${
                  device === option.key ? "border-ink bg-ink text-cream" : "border-ink/20 text-ink/60 hover:border-ink/40"
                }`}
              >
                {option.label}
              </button>
            ))}
            <span className="ml-2 text-xs text-muted">Showing the page with your unpublished changes.</span>
          </div>
          <div className="flex justify-center overflow-hidden rounded-2xl border border-line bg-cream p-4">
            <iframe
              key={`${previewToken}-${device}`}
              title="Page preview"
              src={apiUrl(`/website/pages/${pageId}/preview?v=${previewToken}`)}
              style={{ width: DEVICES.find((option) => option.key === device)!.width }}
              className="h-[70vh] rounded-xl border border-line bg-white"
            />
          </div>
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[240px_1fr]">
          <nav className="lg:sticky lg:top-6 lg:self-start">
            <div className="mb-2 text-[11px] font-bold uppercase tracking-[.1em] text-muted">Sections</div>
            <ul className="space-y-1">
              {sections.map((candidate) => {
                const edited = candidate.fields.some((field) => edits[field.id]);
                return (
                  <li key={candidate.id}>
                    <button
                      type="button"
                      onClick={() => setSectionId(candidate.id)}
                      title={candidate.label}
                      className={`flex w-full items-center justify-between gap-2 rounded-xl px-3 py-2 text-left text-sm ${
                        candidate.id === section?.id ? "bg-ink text-cream" : "text-ink hover:bg-ink/[.04]"
                      }`}
                    >
                      <span className="truncate">{candidate.label}</span>
                      <span className={`shrink-0 text-[10px] ${candidate.id === section?.id ? "text-cream/60" : "text-muted"}`}>
                        {edited ? "●" : candidate.fields.length}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>

          <div className="space-y-3">
            {section ? (
              <>
                <h2 className="font-display text-lg tracking-[-.02em]">{section.label}</h2>
                {section.fields.map((field) => (
                  <FieldRow
                    key={`${loadToken}:${field.id}`}
                    field={field}
                    edit={edits[field.id]}
                    problem={problems.get(field.id)}
                    publicUrl={site.publicUrl}
                    readOnly={readOnly}
                    onChange={(next) => change(field.id, next)}
                  />
                ))}
              </>
            ) : (
              <p className="text-sm text-muted">This page has nothing editable on it.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
