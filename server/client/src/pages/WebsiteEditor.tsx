import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { api, ApiError, apiUrl } from "../lib/api";
import { useAuth } from "../lib/auth";
import type { DraftSaveResult, FieldEdit, PublishResult, SiteFieldRow, SiteSectionRow, SitePageDetail } from "../lib/types";
import { Badge, Button, RelativeTime } from "../components/ui";
import { StylePanel } from "../components/StylePanel";

/**
 * One page of the website, open at full size, with everything about the thing
 * you clicked on the left.
 *
 * The design of the page is not editable here and that is the point. What a
 * client gets is every heading, paragraph, button, link and picture with a plain
 * label on it — "Main heading", not "h1" — grouped under the section it appears
 * in, with the section named after its own heading. Nobody has to know what a
 * `<div>` is, and nobody can break the layout by editing one.
 *
 * Three things make it feel like editing the page rather than filling in a form
 * about the page, and all three are worth keeping:
 *
 *  1. **The page fills the screen.** Not a card in a column — the editor takes
 *     the whole window under the header, and the panel sits beside it.
 *  2. **You type on the page.** Double click any words and the caret is in
 *     them, at the real size, in the real typeface. The boxes in the panel are
 *     the way to reach a field with nothing visible to click — the page title,
 *     a picture's description — not the main way in.
 *  3. **Changes show while you make them.** Text and style are pushed straight
 *     into the frame, so a colour changes while the slider is still moving. The
 *     frame only reloads for the few edits that cannot be pushed.
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
 * that can answer "did I miss anything". **Preview** is the page as it will be,
 * with no editor furniture on it at all.
 */
type Mode = "visual" | "edit" | "preview";

const MODES: { key: Mode; label: string }[] = [
  { key: "visual", label: "Visual" },
  { key: "edit", label: "List" },
  { key: "preview", label: "Preview" },
];

const INPUT =
  "w-full rounded-xl border border-line bg-white px-3 py-2 text-sm text-ink outline-none focus:border-blue focus:ring-2 focus:ring-blue/20";

/** Fields whose value the frame can push and be pushed; everything else reloads. */
const LIVE_KEYS = new Set(["value", "style"]);

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

      {field.kind === "richtext" && <RichText html={value} onChange={(next) => onChange({ ...edit, value: next })} />}

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
        <div className={`grid gap-2 ${bare ? "" : "sm:grid-cols-2"}`}>
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
        <div className={`flex flex-wrap items-start gap-4 ${bare ? "flex-col" : ""}`}>
          {imageSrc && (
            <img
              src={imageSrc}
              alt=""
              className="h-16 w-16 rounded-lg border border-line bg-cream object-contain p-1"
              onError={(event) => ((event.target as HTMLImageElement).style.visibility = "hidden")}
            />
          )}
          <div className={`space-y-2 ${bare ? "w-full" : "min-w-[240px] flex-1"}`}>
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
              <span className="mb-1 block text-xs text-muted">Description, for somebody who cannot see it</span>
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
 * Everything on the page, in the order it appears on it.
 *
 * The visual editor can only reach what is visible; this is how you get to the
 * page title, a picture's description, or a heading that is three screens down.
 * It is also the only place that can answer "have I missed anything", which is
 * why the edited marks are on it.
 */
function LayerList({
  sections,
  edits,
  problems,
  pickedId,
  onPick,
}: {
  sections: SiteSectionRow[];
  edits: Record<string, FieldEdit>;
  problems: Map<string, string>;
  pickedId: string | null;
  onPick: (id: string) => void;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
      {sections.map((section) => (
        <div key={section.id} className="mb-2">
          <div className="px-2 pb-1 pt-1.5 font-mono text-[9px] font-bold uppercase tracking-[.14em] text-ink/35">{section.label}</div>
          <ul>
            {section.fields.map((field) => {
              const picked = field.id === pickedId;
              const changed = edits[field.id] !== undefined && Object.keys(edits[field.id]!).length > 0;
              return (
                <li key={field.id}>
                  <button
                    type="button"
                    onClick={() => onPick(field.id)}
                    title={field.label}
                    className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] transition ${
                      picked ? "bg-blue/10 text-ink" : "text-ink/80 hover:bg-ink/[.04] hover:text-ink"
                    }`}
                  >
                    <span
                      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded font-mono text-[8px] uppercase ${
                        picked ? "bg-blue text-white" : "bg-ink/[.06] text-ink/45"
                      }`}
                    >
                      {field.kind === "image" ? "▣" : field.kind === "link" ? "↗" : "T"}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{field.preview || field.label}</span>
                    {problems.has(field.id) && <span className="shrink-0 text-[9px] text-amber-600">!</span>}
                    {changed && <span className="shrink-0 text-[9px] text-blue">●</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
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
  /** The same, readable from listeners that must not be re-registered. */
  const pickedRef = useRef<string | null>(null);
  pickedRef.current = pickedId;
  /** The field being typed into, on the page itself. */
  const [typingId, setTypingId] = useState<string | null>(null);
  /** Fields the frame has no element for, so nothing can be shown live. */
  const [absentIds, setAbsentIds] = useState<Set<string>>(new Set());
  /**
   * True once a push has gone unanswered.
   *
   * Everything here rests on the frame acting on what it is sent, and there is
   * no way to prove from this side that it did. So the frame acknowledges, and
   * a push with no acknowledgement means the live channel is not working —
   * whatever the reason. The editor stops pretending it is: it says so, and
   * falls back to reloading the frame after each save, which is slower but
   * always right.
   */
  const [liveBlind, setLiveBlind] = useState(false);
  const awaiting = useRef(0);
  const frame = useRef<HTMLIFrameElement | null>(null);
  const [device, setDevice] = useState<Device>("desktop");
  const [previewToken, setPreviewToken] = useState(0);
  const [published, setPublished] = useState<PublishResult | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  /** Bumped when the server's copy replaces local state, to remount the uncontrolled fields. */
  const [loadToken, setLoadToken] = useState(0);
  /** Bumped when the page finishes handing typing back, so the panel's box catches up. */
  const [frameEdit, setFrameEdit] = useState(0);
  const dirty = useRef(false);
  /** An edit the frame cannot be told about — a link's destination, a picture. */
  const needsReload = useRef(false);

  // Refetching on focus is what used to hand the effect below a fresh copy of
  // the draft in the middle of somebody typing. The guard on that effect is the
  // fix, not switching the refetch off: turning it off also stopped the editor
  // ever catching up with the site, which is its own way of showing somebody
  // stale words and letting them think nothing worked.
  const page = useQuery({
    queryKey: ["website", "page", pageId],
    queryFn: () => api.get<SitePageDetail>(`/website/pages/${pageId}`),
  });

  /* ------------------------------------------------------------- history */

  // Undo is over the whole draft, not per field: one Ctrl+Z should take back
  // the thing that just happened, and "the thing that just happened" is as
  // likely to be a colour as a word. Snapshots are cheap — a draft is a handful
  // of short strings — so the simple version is the right one.
  const history = useRef<{ list: string[]; index: number }>({ list: ["{}"], index: 0 });
  const [historyState, setHistoryState] = useState({ canUndo: false, canRedo: false });
  const restoring = useRef(false);
  const commitTimer = useRef<number | null>(null);

  const syncHistoryButtons = () => {
    const { list, index } = history.current;
    setHistoryState({ canUndo: index > 0, canRedo: index < list.length - 1 });
  };

  const commitHistory = useCallback((values: Record<string, FieldEdit>) => {
    if (restoring.current) return;
    if (commitTimer.current !== null) {
      window.clearTimeout(commitTimer.current);
      commitTimer.current = null;
    }
    const snapshot = JSON.stringify(values);
    const state = history.current;
    if (state.list[state.index] === snapshot) return;
    state.list = state.list.slice(0, state.index + 1);
    state.list.push(snapshot);
    if (state.list.length > 60) state.list.shift();
    state.index = state.list.length - 1;
    syncHistoryButtons();
  }, []);

  // Typing is continuous; a keystroke is not a step. Discrete actions call
  // `commitHistory` directly and this only catches what nothing else did.
  useEffect(() => {
    if (restoring.current) return;
    if (commitTimer.current !== null) window.clearTimeout(commitTimer.current);
    commitTimer.current = window.setTimeout(() => commitHistory(edits), 550);
    return () => {
      if (commitTimer.current !== null) window.clearTimeout(commitTimer.current);
    };
  }, [edits, commitHistory]);

  /* ------------------------------------------------------------ the frame */

  const tell = useCallback((message: Record<string, unknown>) => {
    frame.current?.contentWindow?.postMessage({ source: "dakyworld-editor", ...message }, "*");
  }, []);

  /**
   * Write into the page directly.
   *
   * The frame is same-origin, so this does not need a message at all — and a
   * message is the part that was going wrong. A `postMessage` can be dropped by
   * things outside this codebase; setting an attribute on a node the editor is
   * holding cannot. So the direct write is the way this works, and the message
   * stays as the fallback for the day a preview is served from the site's own
   * origin and `contentDocument` is null.
   *
   * Returns what happened, because the three answers need different things:
   * written, no element to write on, or no reachable document.
   */
  const writeInFrame = useCallback((kind: "style" | "text" | "select", id: string | null, value?: string): "written" | "absent" | "unreachable" => {
    let doc: Document | null = null;
    try {
      doc = frame.current?.contentDocument ?? null;
    } catch {
      doc = null; // cross-origin one day
    }
    if (!doc || !doc.body) return "unreachable";

    if (kind === "select") {
      const was = doc.querySelector("[data-dw-selected]");
      if (was) was.removeAttribute("data-dw-selected");
      if (!id) return "written";
      const el = doc.querySelector(`[data-dw-field="${id.replace(/"/g, "")}"]`);
      if (!el) return "absent";
      el.setAttribute("data-dw-selected", "");
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      return "written";
    }

    if (!id) return "absent";
    const el = doc.querySelector(`[data-dw-field="${id.replace(/"/g, "")}"]`);
    if (!el) return "absent";

    if (kind === "style") {
      if (value) el.setAttribute("style", value);
      else el.removeAttribute("style");
      return "written";
    }
    // Never over the top of the caret: the page is editable in place.
    if (!el.hasAttribute("data-dw-editing")) el.innerHTML = value ?? "";
    return "written";
  }, []);

  /**
   * Show a change on the page now, and know whether that worked.
   *
   * The direct write settles it in the same tick. Only when the document is out
   * of reach does this fall back to a message and wait to be told — and a push
   * that goes unanswered means the live channel is not working, so the editor
   * says so and starts leaning on the reload instead.
   */
  const push = useCallback(
    (kind: "style" | "text", id: string, value: string) => {
      const result = writeInFrame(kind, id, value);
      if (result === "written") {
        awaiting.current = 0;
        setLiveBlind(false);
        return;
      }
      if (result === "absent") {
        needsReload.current = true;
        setAbsentIds((current) => (current.has(id) ? current : new Set(current).add(id)));
        return;
      }
      tell(kind === "style" ? { type: "style", id, style: value } : { type: "text", id, html: value });
      awaiting.current += 1;
      const at = awaiting.current;
      window.setTimeout(() => {
        if (awaiting.current !== at) return; // something was acknowledged since
        needsReload.current = true;
        setLiveBlind(true);
      }, 900);
    },
    [tell, writeInFrame],
  );

  const pick = useCallback(
    (id: string | null) => {
      setPickedId(id);
      if (writeInFrame("select", id) === "unreachable") tell({ type: "select", id });
    },
    [tell, writeInFrame],
  );

  const change = useCallback(
    (fieldId: string, next: FieldEdit, options?: { fromFrame?: boolean; commit?: boolean }) => {
      dirty.current = true;
      setPublished(null);
      if (Object.keys(next).some((key) => !LIVE_KEYS.has(key))) needsReload.current = true;
      // Push what the frame can show straight into it, so the page changes
      // while the slider is still moving rather than after the next save.
      if (!options?.fromFrame) {
        if (next.style !== undefined) push("style", fieldId, next.style);
        if (next.value !== undefined) push("text", fieldId, next.value);
      }
      setEdits((current) => {
        const updated = { ...current, [fieldId]: next };
        if (options?.commit) commitHistory(updated);
        return updated;
      });
    },
    [commitHistory, push],
  );

  // The frame talks back: which element was clicked, which one is being typed
  // into, and what has been typed. It is same-origin but talked to by message
  // anyway — that is the only channel that keeps working if the preview is ever
  // served from the site's own origin, which is where this is heading.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { source?: string; type?: string; id?: string | null; html?: string; final?: boolean };
      if (data?.source !== "dakyworld-preview") return;
      if (data.type === "select") {
        setPickedId(data.id ?? null);
      } else if (data.type === "applied") {
        // The channel is alive after all.
        awaiting.current = 0;
        setLiveBlind(false);
      } else if (data.type === "ready") {
        // A reloaded frame carries the saved draft but no selection, and the
        // outline is how somebody knows which thing the panel is talking about.
        awaiting.current = 0;
        setLiveBlind(false);
        window.setTimeout(() => writeInFrame("select", pickedRef.current), 0);
      } else if (data.type === "editing") {
        setTypingId(data.id ?? null);
        if (!data.id) setFrameEdit((token) => token + 1);
      } else if (data.type === "absent") {
        // The frame has no element for that field — the page title and
        // description have none by design, and a handful of others were never
        // given an insertion point by the parse. Nothing can be pushed there,
        // so fall back to reloading the frame once the draft is saved, and say
        // so on screen: an edit that changes nothing visible and explains
        // nothing is indistinguishable from an editor that is broken.
        if (data.id) {
          const id = data.id;
          if (!id.startsWith("meta.")) needsReload.current = true;
          setAbsentIds((current) => (current.has(id) ? current : new Set(current).add(id)));
        }
      } else if (data.type === "text" && data.id) {
        const id = data.id;
        setEdits((current) => {
          const updated = { ...current, [id]: { ...current[id], value: data.html ?? "" } };
          if (data.final) commitHistory(updated);
          return updated;
        });
        dirty.current = true;
        setPublished(null);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [commitHistory, writeInFrame]);

  /* --------------------------------------------------------- server state */

  // The draft on the server is the starting point, and it is authoritative
  // whenever the page is loaded — including after a publish, which clears it.
  useEffect(() => {
    if (!page.data) return;
    // Never over the top of unsaved work. Publish, discard and undo all clear
    // this flag before they reload, so the resets that should happen still do.
    if (dirty.current) return;
    setEdits(page.data.draft.values);
    setLoadToken((token) => token + 1);
    dirty.current = false;
    history.current = { list: [JSON.stringify(page.data.draft.values)], index: 0 };
    syncHistoryButtons();
    setSectionId((current) => current ?? page.data.sections[0]?.id ?? null);
  }, [page.data]);

  const save = useMutation({
    mutationFn: (values: Record<string, FieldEdit>) => api.put<DraftSaveResult>(`/website/pages/${pageId}/draft`, { values }),
    onError: (err) => {
      setFailure(err instanceof ApiError ? err.message : "Those changes could not be saved.");
    },
    onSuccess: (result) => {
      setFailure(null);
      dirty.current = false;
      // A field the server does not know is a draft written against a page that
      // has since moved. Silence here reads as "saved" and it is not.
      if (result.unknown?.length) {
        setFailure(
          `${result.unknown.length} change${result.unknown.length === 1 ? "" : "s"} could not be saved because that part of the page has moved. Reopen the page to see it as it is now.`,
        );
      }
      // Only when something changed that the frame could not be told about —
      // reloading it would throw away the scroll position and the caret.
      if (needsReload.current) {
        needsReload.current = false;
        setPreviewToken((token) => token + 1);
      }
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
    // When the frame cannot be pushed to, the save is the only thing that will
    // ever show somebody their own change, so it stops being a background
    // convenience and becomes the thing they are waiting for.
    const timer = setTimeout(() => saveNow(edits), liveBlind || needsReload.current ? 500 : 1200);
    return () => clearTimeout(timer);
  }, [edits, saveNow, liveBlind]);

  useEffect(() => {
    const onLeave = (event: BeforeUnloadEvent) => {
      if (!dirty.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onLeave);
    return () => window.removeEventListener("beforeunload", onLeave);
  }, []);

  useEffect(() => {
    setAbsentIds(new Set());
  }, [previewToken]);

  const restore = useCallback(
    (step: number) => {
      const state = history.current;
      const index = state.index + step;
      if (index < 0 || index >= state.list.length) return;
      restoring.current = true;
      state.index = index;
      const values = JSON.parse(state.list[index]!) as Record<string, FieldEdit>;
      setEdits(values);
      dirty.current = true;
      setLoadToken((token) => token + 1);
      // Everything is back to a state the frame has not been told about.
      needsReload.current = true;
      setPreviewToken((token) => token + 1);
      syncHistoryButtons();
      window.setTimeout(() => {
        restoring.current = false;
      }, 0);
    },
    [],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const inField = !!target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if ((event.ctrlKey || event.metaKey) && (event.key === "z" || event.key === "Z") && !inField) {
        event.preventDefault();
        restore(event.shiftKey ? 1 : -1);
        return;
      }
      if ((event.ctrlKey || event.metaKey) && (event.key === "y" || event.key === "Y") && !inField) {
        event.preventDefault();
        restore(1);
        return;
      }
      if (event.key === "Escape" && !inField) {
        tell({ type: "stopEdit" });
        pick(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [restore, pick, tell]);

  const discard = useMutation({
    mutationFn: () => api.delete(`/website/pages/${pageId}/draft`),
    onSuccess: () => {
      setEdits({});
      dirty.current = false;
      history.current = { list: ["{}"], index: 0 };
      syncHistoryButtons();
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
      history.current = { list: ["{}"], index: 0 };
      syncHistoryButtons();
      setPreviewToken((token) => token + 1);
      void qc.invalidateQueries({ queryKey: ["website"] });
      // The commit lands at once; the site it is read back from does not. Until
      // Pages has rebuilt, the editor is showing the page as it was, which
      // looks exactly like a publish that did nothing. Keep looking.
      for (const delay of [20000, 45000, 90000]) {
        window.setTimeout(() => {
          if (dirty.current) return;
          void qc.invalidateQueries({ queryKey: ["website", "page", pageId] });
          setPreviewToken((token) => token + 1);
        }, delay);
      }
    },
    onError: (err) => {
      setPublished(null);
      setFailure(err instanceof ApiError ? err.message : "The publish did not finish.");
      // The page may have moved under the draft; reload so the editor shows it
      // as it now is rather than as it was when this screen opened.
      void qc.invalidateQueries({ queryKey: ["website", "page", pageId] });
    },
  });

  const problems = useMemo(() => {
    const map = new Map<string, string>();
    for (const problem of save.data?.problems ?? page.data?.problems ?? []) map.set(problem.id, problem.reason);
    return map;
  }, [save.data, page.data]);

  if (page.isLoading) return <div className="p-10 text-sm text-muted">Opening the page…</div>;
  if (page.isError) {
    return (
      <div className="m-10 rounded-2xl border border-amber-300 bg-amber-50 p-6 text-sm text-amber-900">
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
  const pickedStyle = pickedId ? (edits[pickedId]?.style ?? picked?.style ?? "") : "";

  const status = save.isPending
    ? "Saving…"
    : dirty.current
      ? "Unsaved changes"
      : changedCount > 0
        ? `${changedCount} unpublished change${changedCount === 1 ? "" : "s"}`
        : "Everything published";

  const frameWidth = DEVICES.find((option) => option.key === device)!.width;

  const canvas = (
    <div className="min-h-0 flex-1 overflow-auto bg-cream p-4">
      <div className="mx-auto h-full" style={{ width: frameWidth, maxWidth: "100%" }}>
        <iframe
          ref={mode === "visual" ? frame : undefined}
          key={`${mode}-${previewToken}-${device}`}
          title="Page"
          src={apiUrl(`/website/pages/${pageId}/preview?${mode === "visual" ? "pick=1&" : ""}v=${previewToken}`)}
          className="h-full min-h-[400px] w-full rounded-xl border border-line bg-white shadow-sm shadow-ink/5"
        />
      </div>
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* ------------------------------------------------------------ bar */}
      <div className="flex flex-none flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-white px-4 py-2.5">
        <Link to="/website" className="shrink-0 text-xs text-muted underline-offset-2 hover:text-ink hover:underline">
          ← All pages
        </Link>
        <div className="min-w-0">
          <div className="truncate font-display text-sm tracking-[-.02em]">{page.data.page.title}</div>
          <div className="truncate text-[10px] text-muted">
            <span className="font-mono">{page.data.page.path}</span>
            {page.data.draft.savedAt && (
              <>
                {" · saved "}
                <RelativeTime value={page.data.draft.savedAt} />
              </>
            )}
          </div>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <span className={`text-[11px] ${dirty.current || changedCount > 0 ? "text-ink" : "text-muted"}`}>{status}</span>

          <div className="flex items-center gap-0.5">
            <button
              type="button"
              title="Undo (Ctrl+Z)"
              disabled={!historyState.canUndo}
              onClick={() => restore(-1)}
              className="flex h-7 w-7 items-center justify-center rounded-lg text-muted transition enabled:hover:bg-ink/[.05] enabled:hover:text-ink disabled:opacity-30"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
                <g stroke="currentColor" strokeWidth="1.3" fill="none" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4.4 2.9L1.8 5.5l2.6 2.6" />
                  <path d="M1.8 5.5h5.9a3.8 3.8 0 0 1 0 7.6H5.4" />
                </g>
              </svg>
            </button>
            <button
              type="button"
              title="Redo (Ctrl+Shift+Z)"
              disabled={!historyState.canRedo}
              onClick={() => restore(1)}
              className="flex h-7 w-7 items-center justify-center rounded-lg text-muted transition enabled:hover:bg-ink/[.05] enabled:hover:text-ink disabled:opacity-30"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
                <g stroke="currentColor" strokeWidth="1.3" fill="none" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9.6 2.9l2.6 2.6-2.6 2.6" />
                  <path d="M12.2 5.5H6.3a3.8 3.8 0 0 0 0 7.6h2.3" />
                </g>
              </svg>
            </button>
          </div>

          <button
            type="button"
            title="Read the page again from the site"
            onClick={() => {
              if (dirty.current) saveNow(edits);
              void qc.invalidateQueries({ queryKey: ["website", "page", pageId] });
              setPreviewToken((token) => token + 1);
            }}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-muted transition hover:bg-ink/[.05] hover:text-ink"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
              <g stroke="currentColor" strokeWidth="1.25" fill="none" strokeLinecap="round" strokeLinejoin="round">
                <path d="M11.6 7a4.6 4.6 0 1 1-1.4-3.3" />
                <path d="M11.9 1.7v2.9H9" />
              </g>
            </svg>
          </button>

          {mode !== "edit" && (
            <div className="flex overflow-hidden rounded-lg border border-line">
              {DEVICES.map((option) => (
                <button
                  key={option.key}
                  type="button"
                  onClick={() => setDevice(option.key)}
                  className={`px-2.5 py-1 font-mono text-[9px] uppercase tracking-[.12em] ${
                    device === option.key ? "bg-ink text-cream" : "text-muted hover:text-ink"
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          )}

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
                className={`px-3 py-1.5 text-[11px] font-semibold ${mode === option.key ? "bg-ink text-cream" : "text-muted hover:text-ink"}`}
              >
                {option.label}
              </button>
            ))}
          </div>

          {changedCount > 0 && !readOnly && (
            <Button variant="ghost" size="sm" onClick={() => discard.mutate()} disabled={discard.isPending}>
              Discard
            </Button>
          )}
          {canPublish && (
            <Button
              variant="accent"
              size="sm"
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

      {(published || failure) && (
        <div className="flex-none border-b border-line px-4 py-3">
          {published && (
            <div className="rounded-xl border border-line bg-white p-3 text-sm">
              <p className="font-semibold text-ink">
                Published — version {published.version}, {published.changed} change{published.changed === 1 ? "" : "s"}.
              </p>
              <p className="mt-1 text-xs text-muted">{published.note}</p>
              <p className="mt-1 text-xs text-muted">
                This screen reads the page back from the published site, so it goes on showing the old words until that rebuild
                finishes. It will catch up on its own; the circular arrow in the bar looks again now.
              </p>
              <div className="mt-2 flex flex-wrap gap-4 text-xs">
                <a href={published.url} target="_blank" rel="noreferrer" className="text-ink underline-offset-2 hover:underline">
                  Open the live page
                </a>
                <a href={published.commit.url} target="_blank" rel="noreferrer" className="text-muted underline-offset-2 hover:underline">
                  See the commit
                </a>
              </div>
            </div>
          )}
          {failure && <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">{failure}</div>}
        </div>
      )}

      {/* ---------------------------------------------------------- body */}
      <div className="flex min-h-0 flex-1">
        {mode === "visual" && (
          <aside className="flex w-[300px] flex-none flex-col border-r border-line bg-white">
            <div className="flex flex-none items-center justify-between gap-2 border-b border-line px-4 py-2.5">
              <div className="min-w-0">
                <div className="font-mono text-[9px] uppercase tracking-[.14em] text-ink/40">{picked ? picked.tag : "Nothing selected"}</div>
                <div className="truncate font-display text-[13px] tracking-[-.02em]">{picked ? picked.label : "Pick something"}</div>
              </div>
              {picked && (
                <button type="button" onClick={() => pick(null)} className="shrink-0 text-[11px] text-muted transition hover:text-ink">
                  Clear
                </button>
              )}
            </div>

            {liveBlind && (
              <p className="flex-none border-b border-line bg-amber-50 px-4 py-2 text-[11px] leading-relaxed text-amber-900">
                The page beside this is not keeping up as you type. Your changes are being saved — it will catch up a moment
                after each one.
              </p>
            )}

            <LayerList sections={sections} edits={edits} problems={problems} pickedId={pickedId} onPick={pick} />

            <div className="max-h-[58%] min-h-0 flex-none overflow-y-auto border-t border-line">
              {!picked ? (
                <div className="px-4 py-6 text-center">
                  <p className="text-[12px] font-semibold text-ink">Click anything on the page</p>
                  <p className="mt-1 text-[11px] leading-relaxed text-muted">
                    Its words and its look appear here. Double click to type straight into the page.
                  </p>
                  <p className="mt-3 text-[10px] text-muted">
                    {allFields.length} editable {allFields.length === 1 ? "thing" : "things"} on this page.
                  </p>
                </div>
              ) : (
                <>
                  <div className="border-b border-line px-4 py-3.5">
                    <div className="mb-2.5 flex items-center justify-between">
                      <span className="font-mono text-[10px] font-bold uppercase tracking-[.14em] text-ink/40">Content</span>
                      {picked.kind !== "image" && (
                        <button
                          type="button"
                          onClick={() => tell({ type: "edit", id: picked.id })}
                          className="text-[10px] text-muted underline-offset-2 transition hover:text-blue hover:underline"
                        >
                          {typingId === picked.id ? "Typing on the page" : "Type on the page"}
                        </button>
                      )}
                    </div>
                    {absentIds.has(picked.id) && (
                      <p className="mb-2 rounded-lg bg-cream/70 px-2.5 py-2 text-[11px] leading-relaxed text-muted">
                        {picked.id.startsWith("meta.")
                          ? "This one is not on the page itself — it is what browsers and search results show. Nothing here will change in the preview."
                          : "This one cannot be shown while you type. It appears in the page once the draft saves."}
                      </p>
                    )}
                    <FieldRow
                      key={`${loadToken}:${frameEdit}:${picked.id}`}
                      field={picked}
                      edit={edits[picked.id]}
                      problem={problems.get(picked.id)}
                      publicUrl={site.publicUrl}
                      readOnly={readOnly}
                      onChange={(next) => change(picked.id, next)}
                      bare
                    />
                  </div>

                  <StylePanel
                    style={pickedStyle}
                    readOnly={readOnly}
                    onChange={(next) => change(picked.id, { ...edits[picked.id], style: next })}
                    onCommit={() => commitHistory(edits)}
                    onReset={() => change(picked.id, { ...edits[picked.id], style: "" }, { commit: true })}
                  />
                </>
              )}
            </div>
          </aside>
        )}

        {mode === "edit" ? (
          <>
            <aside className="w-[240px] flex-none overflow-y-auto border-r border-line bg-white p-3">
              <div className="mb-2 px-1 font-mono text-[9px] font-bold uppercase tracking-[.14em] text-ink/40">Sections</div>
              <ul className="space-y-0.5">
                {sections.map((candidate) => {
                  const edited = candidate.fields.some((field) => edits[field.id]);
                  return (
                    <li key={candidate.id}>
                      <button
                        type="button"
                        onClick={() => setSectionId(candidate.id)}
                        title={candidate.label}
                        className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] ${
                          candidate.id === section?.id ? "bg-ink text-cream" : "text-ink hover:bg-ink/[.04]"
                        }`}
                      >
                        <span className="truncate">{candidate.label}</span>
                        <span className={`shrink-0 text-[9px] ${candidate.id === section?.id ? "text-cream/60" : "text-muted"}`}>
                          {edited ? "●" : candidate.fields.length}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </aside>
            <div className="min-h-0 flex-1 overflow-y-auto bg-cream px-6 py-6">
              <div className="mx-auto max-w-3xl space-y-3">
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
          </>
        ) : (
          canvas
        )}
      </div>
    </div>
  );
}
