import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { api, ApiError, apiUrl } from "../lib/api";
import { useAuth } from "../lib/auth";
import type { DraftConflict, DraftSaveResult, FieldEdit, PublishResult, SiteFieldRow, SiteSectionRow, SitePageDetail } from "../lib/types";
import { Badge, Button, RelativeTime } from "../components/ui";
import { WebsiteAssetLibrary } from "../components/WebsiteAssetLibrary";
import { MakeSharedPanel, SharedElementPanel, SharedPublishReview } from "../components/WebsiteShared";
import { PublishReview, type WebsiteReview } from "../components/PublishReview";
import { ElementInspector } from "../components/ElementInspector";
import { INSPECTED_PROPERTIES, type ElementFacts } from "../lib/elementInspector";
import { WebsiteLayers, WebsiteBreadcrumbs } from "../components/WebsiteLayers";
import { WebsiteVersions } from "../components/WebsiteVersions";
import { WebsiteAssistant } from "../components/WebsiteAssistant";
import { useWebsiteAccess } from "../components/WebsiteMembers";
import { responsivePreviewCss, safeResponsiveStyle, writeResponsivePreview } from "../lib/websiteResponsive";

/**
 * One page of the website, open at full size, with everything about the thing
 * you clicked on the left.
 *
 * Content and design share a draft. The inspector exposes the selected
 * element and its parent containers while preserving the surrounding source.
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
  { key: "desktop", label: "Desktop", width: "1280px" },
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

/**
 * Changes that do not need the frame reloaded to be true on screen.
 *
 * `value`, `style` and `variant` are pushed straight into the page, so it
 * changes under the cursor. `newTab` is in here for the opposite reason: it
 * changes nothing anybody can see, so reloading the page to show it would throw
 * away somebody's scroll position and their caret in exchange for no visible
 * difference at all.
 */
const LIVE_KEYS = new Set(["value", "style", "responsive", "variant", "newTab"]);

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

/** `btn-primary` under stem `btn` reads as "Primary". */
function variantLabel(stem: string | undefined, variant: string): string {
  if (!stem || !variant.startsWith(`${stem}-`)) return variant;
  const word = variant.slice(stem.length + 1).replace(/[-_]+/g, " ").trim();
  return word ? word.charAt(0).toUpperCase() + word.slice(1) : variant;
}

/**
 * The two things a button has that a link does not.
 *
 * **Its style.** Until now the only way to turn the lime button on a page into
 * the dark one was to edit HTML, which is the thing this editor exists to
 * avoid. The choices are the styles this page already wears somewhere, so
 * picking one can never produce a button the stylesheet has no rule for — and
 * "None" is offered because taking a style off is a real thing to want and
 * there is otherwise no way back to a plain link.
 *
 * **Whether it opens in a new tab.** One switch, never two: the server writes
 * `rel="noopener noreferrer"` alongside `target="_blank"` and takes both away
 * together, because `target` on its own hands the page it opens a live handle
 * on the one it came from, and nobody choosing "open in a new tab" is choosing
 * that.
 */
function ButtonControls({
  field,
  edit,
  onChange,
  readOnly,
}: {
  field: SiteFieldRow;
  edit: FieldEdit | undefined;
  onChange: (next: FieldEdit) => void;
  readOnly: boolean;
}) {
  const variant = edit?.variant !== undefined ? edit.variant : (field.variant ?? null);
  const newTab = edit?.newTab ?? field.newTab ?? false;
  // A button with nothing to change to has no control drawn at all, rather than
  // one drawn with a single option in it that is already selected. A button
  // wearing no style yet still gets one — that is how a style is *added*.
  const choices = field.variants ?? [];
  const canRestyle = choices.some((candidate) => candidate !== variant);

  return (
    <div className="mt-2 space-y-2">
      {canRestyle && (
        <div>
          <span className="mb-1 block text-xs text-muted">Style</span>
          <div className="flex flex-wrap gap-1">
            {choices.map((candidate) => (
              <button
                key={candidate}
                type="button"
                disabled={readOnly}
                onClick={() => onChange({ ...edit, variant: candidate })}
                className={`rounded-xl border px-2.5 py-1 text-[12px] ${
                  variant === candidate ? "border-ink bg-ink text-cream" : "border-line bg-white text-ink hover:border-ink/40"
                } disabled:opacity-50`}
              >
                {variantLabel(field.variantStem, candidate)}
              </button>
            ))}
            <button
              type="button"
              disabled={readOnly}
              onClick={() => onChange({ ...edit, variant: null })}
              className={`rounded-xl border px-2.5 py-1 text-[12px] ${
                variant === null ? "border-ink bg-ink text-cream" : "border-line bg-white text-muted hover:border-ink/40"
              } disabled:opacity-50`}
            >
              None
            </button>
          </div>
        </div>
      )}

      {/* Absent on a `<button>`, which has nowhere to go and so no tab to open. */}
      {field.newTab !== undefined && (
        <label className="flex items-center gap-2 text-[12px] text-ink">
          <input
            type="checkbox"
            checked={newTab}
            disabled={readOnly}
            onChange={(event) => onChange({ ...edit, newTab: event.target.checked })}
            className="h-3.5 w-3.5 accent-blue"
          />
          <span>Opens in a new tab</span>
        </label>
      )}
    </div>
  );
}

function FieldRow({
  field,
  edit,
  problem,
  publicUrl,
  links,
  onChange,
  readOnly,
  bare,
}: {
  field: SiteFieldRow;
  edit: FieldEdit | undefined;
  problem: string | undefined;
  publicUrl: string;
  /** The site's own pages, so a destination is picked rather than spelled. */
  links: Array<{ path: string; title: string }>;
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

  if (field.kind === "container") return <p className="text-xs leading-relaxed text-muted">Select a child to edit its content, or use the controls below to style this container.</p>;

  return (
    <div
      className={
        bare
          ? ""
          : `rounded-2xl border p-4 ${problem ? "border-warn-line bg-warn-surface/40" : changed ? "border-blue/40 bg-blue/[.02]" : "border-line bg-white"}`
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

      {(field.kind === "link" || field.kind === "button") && (
        <>
          <div className={`grid gap-2 ${bare ? "" : "sm:grid-cols-2"}`}>
            <label className="block">
              <span className="mb-1 block text-xs text-muted">
                {field.kind === "button" ? "Words on the button" : "Words on the link"}
              </span>
              <input
                className={INPUT}
                value={value}
                readOnly={readOnly || !field.value}
                placeholder={field.value ? "" : "This link has no words of its own"}
                onChange={(event) => onChange({ ...edit, value: event.target.value })}
              />
            </label>
            {/* A `<button>` has no destination — where it leads is decided by
                script — so the box is not drawn rather than drawn and inert. */}
            {field.href !== undefined && (
              <label className="block">
                <span className="mb-1 block text-xs text-muted">Where it goes</span>
                <input
                  className={`${INPUT} font-mono text-xs`}
                  value={href}
                  readOnly={readOnly}
                  list={`${field.id}-links`}
                  onChange={(event) => onChange({ ...edit, href: event.target.value })}
                />
                {/* The site's own pages, offered rather than imposed. Typing
                    `contact` instead of `/contact` is a link to nowhere that
                    looks exactly like a link until a visitor clicks it — and an
                    address off the site, an anchor and a mailto: all still go in
                    the same box. */}
                <datalist id={`${field.id}-links`}>
                  {links.map((link) => (
                    <option key={link.path} value={link.path}>
                      {link.title}
                    </option>
                  ))}
                </datalist>
              </label>
            )}
          </div>
          {field.kind === "button" && <ButtonControls field={field} edit={edit} onChange={onChange} readOnly={readOnly} />}
        </>
      )}

      {field.kind === "image" && (
        <div className={`flex flex-wrap items-start gap-4 ${bare ? "flex-col" : ""}`}>
          {imageSrc && (
            <img
              src={imageSrc}
              alt=""
              className="h-16 w-16 rounded-xl border border-line bg-cream object-contain p-1"
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
      {problem && <p className="mt-2 text-xs font-semibold text-warn-text">{problem}</p>}
    </div>
  );
}

/** One side of a contested field, as words rather than as markup. */
function sideText(edit: FieldEdit | null): string {
  if (!edit) return "left as it was";
  const parts: string[] = [];
  if (edit.value !== undefined) parts.push(edit.value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim() || "(nothing)");
  if (edit.href !== undefined) parts.push(`links to ${edit.href || "(nowhere)"}`);
  if (edit.alt !== undefined) parts.push(`described as "${edit.alt}"`);
  if (edit.style !== undefined) parts.push(edit.style || "original stylesheet");
  if (edit.responsive !== undefined) {
    parts.push(`Tablet: ${edit.responsive.tablet || "inherit"}`, `Phone: ${edit.responsive.mobile || "inherit"}`);
  }
  if (edit.variant !== undefined) parts.push(`button style: ${edit.variant || "none"}`);
  if (edit.newTab !== undefined) parts.push(edit.newTab ? "opens in new tab" : "opens in same tab");
  return parts.join(" · ") || "left as it was";
}

/**
 * Somebody else saved first — both versions, and a choice per field.
 *
 * Deliberately not a "your changes were lost" notice, because they were not:
 * the refused save changed nothing on the server, and the words are still in
 * this browser. It is also deliberately not an automatic merge. Two people
 * rewrote the same heading; a machine picking one of them and saying nothing is
 * how a client's approved copy quietly reverts to a draft nobody signed off.
 *
 * Fields only one person touched are not a decision and are not presented as
 * one — they are kept, both of them, and counted in a line at the bottom.
 */
function ConflictDialog({
  conflict,
  onKeep,
  onCancel,
}: {
  conflict: DraftConflict;
  onKeep: (choices: Record<string, "yours" | "theirs">) => void;
  onCancel: () => void;
}) {
  const contested = conflict.fields.filter((field) => field.contested);
  const uncontested = conflict.fields.length - contested.length;
  const [choices, setChoices] = useState<Record<string, "yours" | "theirs">>(() =>
    Object.fromEntries(contested.map((field) => [field.id, "yours" as const])),
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-6">
      <div className="flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-line bg-white shadow-xl">
        <div className="flex-none border-b border-line px-6 py-4">
          <h2 className="font-display text-base tracking-[-.02em]">Somebody else saved this page</h2>
          <p className="mt-1 text-xs text-muted">{conflict.error}</p>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          {contested.length === 0 ? (
            <p className="text-sm text-ink">
              You both changed different parts of the page, so nothing has to be decided — keeping both is safe.
            </p>
          ) : (
            <>
              <div className="mb-3 flex items-center gap-2">
                <span className="text-[11px] uppercase tracking-[.1em] text-muted">
                  {contested.length} field{contested.length === 1 ? "" : "s"} you both changed
                </span>
                <button
                  type="button"
                  onClick={() => setChoices(Object.fromEntries(contested.map((field) => [field.id, "yours" as const])))}
                  className="ml-auto text-[11px] text-muted underline-offset-2 hover:text-ink hover:underline"
                >
                  Keep all mine
                </button>
                <button
                  type="button"
                  onClick={() => setChoices(Object.fromEntries(contested.map((field) => [field.id, "theirs" as const])))}
                  className="text-[11px] text-muted underline-offset-2 hover:text-ink hover:underline"
                >
                  Keep all theirs
                </button>
              </div>

              <div className="space-y-3">
                {contested.map((field) => (
                  <div key={field.id} className="rounded-xl border border-line p-3">
                    <div className="mb-2 text-[11px] font-bold uppercase tracking-[.08em] text-muted">{field.label}</div>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {(["yours", "theirs"] as const).map((side) => (
                        <button
                          key={side}
                          type="button"
                          onClick={() => setChoices((current) => ({ ...current, [field.id]: side }))}
                          className={`rounded-xl border p-2.5 text-left text-xs transition ${
                            choices[field.id] === side ? "border-blue bg-blue/[.06] text-ink" : "border-line text-muted hover:border-ink/30"
                          }`}
                        >
                          <div className="mb-1 text-[10px] uppercase tracking-[.1em]">
                            {side === "yours" ? "Yours" : conflict.savedBy?.name ?? "Theirs"}
                          </div>
                          <div className="break-words">{sideText(side === "yours" ? field.yours : field.theirs)}</div>
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {uncontested > 0 && (
            <p className="mt-4 text-xs text-muted">
              {uncontested} other change{uncontested === 1 ? "" : "s"} only one of you made. {uncontested === 1 ? "It is" : "They are"} kept
              either way.
            </p>
          )}
        </div>

        <div className="flex flex-none items-center justify-end gap-2 border-t border-line px-6 py-3">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Leave it for now
          </Button>
          <Button size="sm" onClick={() => onKeep(choices)}>
            Save this version
          </Button>
        </div>
      </div>
    </div>
  );
}

export function WebsiteEditor() {
  const { pageId = "" } = useParams();
  return <WebsitePageEditor key={pageId} pageId={pageId} />;
}

function WebsitePageEditor({ pageId }: { pageId: string }) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const localDraftKey = `website-draft:${user?.id}:${pageId}`;
  const recovered = useRef(false);

  const [edits, setEdits] = useState<Record<string, FieldEdit>>({});
  const [structureBusy, setStructureBusy] = useState(false);
  const structurePending = useRef(false);
  const structuralHistory = useRef<(step: number) => void>(() => {});
  const latestEdits = useRef(edits);
  latestEdits.current = edits;
  const [computed, setComputed] = useState<Record<string, string>>({});
  /** What the frame says the selected element is, as opposed to what it holds. */
  const [domFacts, setDomFacts] = useState<Omit<ElementFacts, "kind"> | null>(null);
  const [styleClipboard, setStyleClipboard] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
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
  const failedSave = useRef<string | null>(null);
  /** An edit the frame cannot be told about — a link's destination, a picture. */
  const needsReload = useRef(false);
  /**
   * The draft revision this editor was last shown, quoted on every save.
   *
   * A ref rather than state because it is read inside the save mutation, which
   * must see the newest value and must not be rebuilt each time it changes — a
   * save closing over a stale revision would refuse its own previous save.
   */
  const revision = useRef(0);
  /**
   * The revision of each shared element on this page, quoted back on every save
   * for the reason the page's own revision is: a header edited from two pages at
   * once is one row on the server, and a save that cannot say which version it
   * saw is a save that silently overwrites somebody.
   */
  const sharedRevisions = useRef<Record<string, number>>({});
  /** Which shared change is open for review, if any. */
  const [sharedReviewId, setSharedReviewId] = useState<string | null>(null);
  const documentHash = useRef<string | null>(null);
  /** Somebody else saved first. Their version and this one, side by side. */
  const [conflict, setConflict] = useState<DraftConflict | null>(null);
  /** The publishing history, and the two ways back out of a bad publish. */
  const [reviewOpen, setReviewOpen] = useState(false);
  const publishPending = useRef(false);
  const [showVersions, setShowVersions] = useState(false);
  /** Optional assistant proposals join the same local draft and undo history. */
  const [showAI, setShowAI] = useState(false);

  /**
   * What the page is really doing with the selected element, at this width.
   *
   * Two things come back and they answer different questions. The computed
   * values are what every control shows when nobody has overridden it — the
   * site's own 72px rather than an empty box marked "As designed". The facts
   * are what the inspector decides *which* controls to draw from: an element's
   * own display and its parent's, which is the only way to know that a `div` is
   * a grid or that an `a` is sitting in a flex row.
   *
   * Reading is all this does. Nothing here goes into the draft, so opening an
   * element cannot rewrite the page.
   */
  useEffect(() => {
    const inspect = () => {
      try {
        const doc = frame.current?.contentDocument;
        const element = pickedId ? doc?.querySelector('[data-dw-field="' + CSS.escape(pickedId) + '"]') : null;
        if (!element || !doc?.defaultView) { setComputed({}); setDomFacts(null); return; }
        const view = doc.defaultView;
        const style = view.getComputedStyle(element);
        setComputed(Object.fromEntries(INSPECTED_PROPERTIES.map(key => [key, style.getPropertyValue(key)])));
        const parent = element.parentElement;
        setDomFacts({
          tag: element.tagName.toLowerCase(),
          display: style.display,
          position: style.position,
          parentDisplay: parent ? view.getComputedStyle(parent).display : "",
          // Text of its own, not a child's: a section wrapping a heading is not
          // a thing anybody sets a line height on.
          hasText: Array.from(element.childNodes).some(node => node.nodeType === 3 && (node.textContent ?? "").trim().length > 0),
          childCount: element.childElementCount,
        });
      } catch { setComputed({}); setDomFacts(null); }
    };
    inspect();
    const iframe = frame.current;
    iframe?.addEventListener("load", inspect);
    const resize = new ResizeObserver(inspect);
    if (iframe) resize.observe(iframe);
    return () => { iframe?.removeEventListener("load", inspect); resize.disconnect(); };
  }, [pickedId, edits, previewToken, device, mode]);

  // Refetching on focus is what used to hand the effect below a fresh copy of
  // the draft in the middle of somebody typing. The guard on that effect is the
  // fix, not switching the refetch off: turning it off also stopped the editor
  // ever catching up with the site, which is its own way of showing somebody
  // stale words and letting them think nothing worked.
  const page = useQuery({
    queryKey: ["website", "page", pageId],
    queryFn: () => api.get<SitePageDetail>(`/website/pages/${pageId}`),
  });

  const access = useWebsiteAccess(page.data?.site.id);
  const canEdit = access.data?.capabilities.edit === true;
  const design = useQuery({ queryKey: ["website", "design", page.data?.site.id], enabled: !!page.data?.site.id, queryFn: () => api.get<{ options: { colours: string[]; fonts: string[]; aiEnabled: boolean } }>(`/website/sites/${page.data!.site.id}/design`) });

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
  const writeInFrame = useCallback(
    (kind: "style" | "responsive" | "image" | "text" | "select" | "variant", id: string | null, value?: string, from?: string): "written" | "absent" | "unreachable" => {
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

    if (kind === "responsive") {
      writeResponsivePreview(doc, el, id, JSON.parse(value ?? "{}"));
      return "written";
    }
    if (kind === "image") {
      el.setAttribute("src", value ?? "");
      el.removeAttribute("srcset");
      return "written";
    }
    if (kind === "style") {
      if (value) el.setAttribute("style", value);
      else el.removeAttribute("style");
      return "written";
    }
    if (kind === "variant") {
      // One token out, one in. Every other class the developer wrote survives,
      // exactly as the server's own swap does — this is the same rule, applied
      // early so the colour changes under the cursor instead of after a save.
      if (from) el.classList.remove(from);
      if (value) el.classList.add(value);
      return "written";
    }
    // Never over the top of the caret: the page is editable in place.
    if (!el.hasAttribute("data-dw-editing")) el.innerHTML = value ?? "";
    return "written";
  },
    [],
  );

  /**
   * Show a change on the page now, and know whether that worked.
   *
   * The direct write settles it in the same tick. Only when the document is out
   * of reach does this fall back to a message and wait to be told — and a push
   * that goes unanswered means the live channel is not working, so the editor
   * says so and starts leaning on the reload instead.
   */
  const push = useCallback(
    (kind: "style" | "responsive" | "image" | "text" | "variant", id: string, value: string, from?: string) => {
      const result = writeInFrame(kind, id, value, from);
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
      tell(
        kind === "style"
          ? { type: "style", id, style: value }
          : kind === "responsive"
            ? { type: "responsive", id, css: responsivePreviewCss(id, JSON.parse(value)) }
          : kind === "image"
            ? { type: "image", id, src: value }
          : kind === "variant"
            ? { type: "variant", id, from, to: value }
            : { type: "text", id, html: value },
      );
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
      if (!canEdit || reviewOpen || showVersions || publishPending.current || structurePending.current) return;
      dirty.current = true;
      setPublished(null);
      if (Object.keys(next).some((key) => !LIVE_KEYS.has(key))) needsReload.current = true;
      // Push what the frame can show straight into it, so the page changes
      // while the slider is still moving rather than after the next save.
      if (!options?.fromFrame) {
        if (next.style !== undefined) push("style", fieldId, next.style);
        if (next.responsive !== undefined) push("responsive", fieldId, JSON.stringify(next.responsive));
        if (next.value !== undefined) push(page.data?.sections.some(section => section.fields.some(field => field.id === fieldId && field.kind === "image")) ? "image" : "text", fieldId, next.value);
        if (next.variant !== undefined) {
          push("variant", fieldId, next.variant ?? "", wornVariant.current[fieldId]);
          // The frame now wears the new one, so the *next* swap has to take
          // that off rather than the class the page loaded with. Without this,
          // picking three styles in a row leaves the button wearing two.
          wornVariant.current[fieldId] = next.variant ?? undefined;
        }
      }
      setEdits((current) => {
        const updated = { ...current, [fieldId]: next };
        if (options?.commit) commitHistory(updated);
        return updated;
      });
    },
    [commitHistory, push, canEdit, reviewOpen, showVersions, page.data],
  );

  // The frame talks back: which element was clicked, which one is being typed
  // into, and what has been typed. It is same-origin but talked to by message
  // anyway — that is the only channel that keeps working if the preview is ever
  // served from the site's own origin, which is where this is heading.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { source?: string; type?: string; id?: string | null; html?: string; final?: boolean };
      if (event.source !== frame.current?.contentWindow || event.origin !== window.location.origin || data?.source !== "dakyworld-preview") return;
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
        // A mode switch or delayed save can reload an older server draft.
        // Reapply the current tab's edits before restoring its selection.
        window.setTimeout(() => {
          const fields = page.data?.sections.flatMap(section => section.fields) ?? [];
          for (const [id, edit] of Object.entries(latestEdits.current)) {
            if (edit.style !== undefined) writeInFrame("style", id, edit.style);
            if (edit.responsive !== undefined) writeInFrame("responsive", id, JSON.stringify(edit.responsive));
            if (edit.value !== undefined) writeInFrame(fields.find(field => field.id === id)?.kind === "image" ? "image" : "text", id, edit.value);
            if (edit.variant !== undefined) writeInFrame("variant", id, edit.variant ?? "", wornVariant.current[id]);
          }
          writeInFrame("select", pickedRef.current);
        }, 0);
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
      } else if (data.type === "text" && data.id && canEdit && !reviewOpen && !showVersions && !publishPending.current && !structurePending.current) {
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
  }, [commitHistory, writeInFrame, canEdit, reviewOpen, showVersions, page.data]);

  /* --------------------------------------------------------- server state */

  // The draft on the server is the starting point, and it is authoritative
  // whenever the page is loaded — including after a publish, which clears it.
  // Which style each button currently wears, kept in a ref rather than a
  // dependency. `change` needs it to push a class swap into the frame, and
  // making it a dependency would rebuild that callback on every background
  // refetch — including the ones that fire while somebody is typing.
  const wornVariant = useRef<Record<string, string | undefined>>({});

  // Kept current on every read of the page, including the paths that keep a
  // local draft: a recovered draft can still be carrying a shared edit.
  useEffect(() => {
    if (!page.data?.shared) return;
    sharedRevisions.current = Object.fromEntries(page.data.shared.elements.map((element) => [element.id, element.revision]));
  }, [page.data]);

  useEffect(() => {
    if (!page.data) return;
    wornVariant.current = Object.fromEntries(
      page.data.sections.flatMap((section) => section.fields).map((field) => [field.id, field.variant]),
    );
  }, [page.data]);

  useEffect(() => {
    if (!page.data) return;
    // Never over the top of unsaved work. Publish, discard and undo all clear
    // this flag before they reload, so the resets that should happen still do.
    if (dirty.current) return;
    if (!recovered.current) {
      recovered.current = true;
      try {
        const local = JSON.parse(sessionStorage.getItem(localDraftKey) ?? "null");
        if (local && Number.isInteger(local.revision) && local.values && typeof local.values === "object" && !Array.isArray(local.values)) {
          setEdits(local.values);
          revision.current = local.revision;
          documentHash.current = local.documentHash ?? null;
          dirty.current = true;
          needsReload.current = true;
          history.current = { list: [JSON.stringify(page.data.draft.values), JSON.stringify(local.values)], index: 1 };
          syncHistoryButtons();
          setFailure("Recovered unsaved changes from this tab. They will be saved when your editing access is confirmed.");
          return;
        }
      } catch { /* Storage may be disabled or full. Server drafts still work. */ }
    }
    setEdits(page.data.draft.values);
    revision.current = page.data.draft.revision;
    documentHash.current = page.data.draft.documentHash ?? null;
    setLoadToken((token) => token + 1);
    dirty.current = false;
    history.current = { list: [JSON.stringify(page.data.draft.values)], index: 0 };
    syncHistoryButtons();
    setSectionId((current) => current ?? page.data.sections[0]?.id ?? null);
  }, [page.data]);

  const save = useMutation({
    mutationFn: (values: Record<string, FieldEdit>) =>
      api.put<DraftSaveResult>(`/website/pages/${pageId}/draft`, {
        ifRevision: revision.current,
        documentHash: documentHash.current,
        sharedRevisions: sharedRevisions.current,
        values,
      }),
    onError: (err, submitted) => {
      failedSave.current = JSON.stringify(submitted);
      // A 409 is not a failure to report and move past — it is a choice to put
      // in front of somebody, with both versions in the body. Everything else is
      // the red bar as before.
      if (err instanceof ApiError && err.status === 409 && err.body && typeof err.body === "object" && "fields" in err.body) {
        setConflict(err.body as DraftConflict);
        // Deliberately left dirty. Until the choice is made these words exist
        // only in this browser, and anything that treats them as saved — the
        // autosave timer, the effect that reseeds from the server — would throw
        // them away while the dialog was still open.
        return;
      }
      setFailure(err instanceof ApiError ? err.message : "Those changes could not be saved.");
    },
    onSuccess: (result, submitted) => {
      setFailure(null);
      dirty.current = Boolean(result.unknown?.length) || JSON.stringify(latestEdits.current) !== JSON.stringify(submitted);
      failedSave.current = result.unknown?.length ? JSON.stringify(submitted) : null;
      revision.current = result.revision;
      // A shared element this save touched has moved on, and the next save has
      // to quote the number it moved to rather than the one this screen loaded.
      if (result.sharedRevisions) sharedRevisions.current = { ...sharedRevisions.current, ...result.sharedRevisions };
      try { if (!dirty.current) sessionStorage.removeItem(localDraftKey); } catch { /* Optional recovery storage. */ }
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
      if (!save.isPending) save.mutate(values);
    },
    [save],
  );

  /**
   * Takes the decision made in the dialog and saves it as one draft.
   *
   * The revision quoted is **theirs** — the one the server answered the refusal
   * with. That is the whole shape of the exchange: this editor has now seen what
   * the other person wrote, so it is current again and allowed to write. Quoting
   * the old number would refuse the resolution for the same reason it refused
   * the save, for ever.
   */
  const resolveConflict = useCallback(
    (choices: Record<string, "yours" | "theirs">) => {
      if (!conflict) return;
      const merged: Record<string, FieldEdit> = {};
      for (const field of conflict.fields) {
        // A field only one side touched is not a decision; both are kept.
        const side = field.contested ? choices[field.id] ?? "yours" : field.yours ? "yours" : "theirs";
        const chosen = side === "yours" ? field.yours : field.theirs;
        if (chosen) merged[field.id] = chosen;
      }
      revision.current = conflict.revision;
      setConflict(null);
      setEdits(merged);
      // Remounts the uncontrolled inputs and reloads the frame: after a merge
      // the panel and the page can both be showing words nobody chose.
      setLoadToken((token) => token + 1);
      setPreviewToken((token) => token + 1);
      commitHistory(merged);
      saveNow(merged);
    },
    [conflict, commitHistory, saveNow],
  );

  // Autosave. Long enough not to write on every keystroke, short enough that
  // leaving the screen almost never loses anything — and the guard below covers
  // the case where it does.
  useEffect(() => {
    if (!dirty.current || !canEdit || reviewOpen || showVersions || publishPending.current || structurePending.current || failedSave.current === JSON.stringify(edits)) return;
    // Not while somebody is deciding whose version to keep. `saveNow` changes
    // identity every time the mutation changes state, so this effect re-runs on
    // its own after each refusal — without this guard an open dialog would sit
    // there firing a save, and being refused, once a second.
    if (conflict) return;
    // When the frame cannot be pushed to, the save is the only thing that will
    // ever show somebody their own change, so it stops being a background
    // convenience and becomes the thing they are waiting for.
    const timer = setTimeout(() => saveNow(edits), liveBlind || needsReload.current ? 500 : 1200);
    return () => clearTimeout(timer);
  }, [edits, saveNow, liveBlind, conflict, canEdit, reviewOpen, showVersions]);

  useEffect(() => {
    if (!dirty.current) return;
    try { sessionStorage.setItem(localDraftKey, JSON.stringify({ revision: revision.current, documentHash: documentHash.current, values: edits })); } catch { /* Server saving remains authoritative. */ }
  }, [edits, localDraftKey]);

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
      if (!canEdit || reviewOpen || showVersions || publishPending.current || structurePending.current) return;
      const state = history.current;
      const index = state.index + step;
      if (index < 0 || index >= state.list.length) { structuralHistory.current(step); return; }
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
    [canEdit, reviewOpen, showVersions],
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
    mutationFn: () => api.delete(`/website/pages/${pageId}/draft?ifRevision=${revision.current}`),
    onError: err => setFailure(err instanceof Error ? err.message : "The draft could not be discarded."),
    onSuccess: () => {
      setEdits({});
      dirty.current = false;
      try { sessionStorage.removeItem(localDraftKey); } catch { /* Optional recovery storage. */ }
      history.current = { list: ["{}"], index: 0 };
      syncHistoryButtons();
      setPreviewToken((token) => token + 1);
      void qc.invalidateQueries({ queryKey: ["website"] });
    },
  });

  const publish = useMutation({
    mutationFn: (review: WebsiteReview) => api.post<PublishResult>(`/website/pages/${pageId}/publish`, { ifRevision: review.revision, sourceHash: review.sourceHash }),
    onMutate: () => { publishPending.current = true; },
    onSettled: () => { publishPending.current = false; },
    onSuccess: (result) => {
      setFailure(null);
      setPublished(result);
      setReviewOpen(false);
      setEdits({});
      dirty.current = false;
      try { sessionStorage.removeItem(localDraftKey); } catch { /* Optional recovery storage. */ }
      if (result.draftRetained) setFailure("Published the reviewed version. A newer saved draft was preserved and is being reloaded.");
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

  async function runStructure(kind: "remove" | "duplicate" | "before" | "after" | "undo" | "redo", fieldId?: string, targetId?: string) {
    if (!canEdit || save.isPending || publishPending.current || structurePending.current || reviewOpen || showVersions) return;
    if (typingId) { setFailure("Press Escape to finish typing on the page, then change its layout."); return; }
    structurePending.current = true; setStructureBusy(true); setFailure(null);
    try {
      if (dirty.current) await save.mutateAsync(latestEdits.current);
      if (dirty.current) throw new Error("Some edits have not saved. Resolve them before changing the layout.");
      const result = await api.post<{ revision: number; selectedId: string | null }>(`/website/pages/${pageId}/structure`, { kind, fieldId, targetId, ifRevision: revision.current });
      dirty.current = false;
      try { sessionStorage.removeItem(localDraftKey); } catch { /* Server checkpoint is saved. */ }
      const refreshed = await qc.fetchQuery({ queryKey: ["website", "page", pageId], queryFn: () => api.get<SitePageDetail>(`/website/pages/${pageId}`), staleTime: 0 });
      revision.current = refreshed.draft.revision; documentHash.current = refreshed.draft.documentHash ?? null;
      latestEdits.current = refreshed.draft.values; setEdits(refreshed.draft.values);
      history.current = { list: [JSON.stringify(refreshed.draft.values)], index: 0 }; syncHistoryButtons();
      setPublished(null); setPickedId(result.selectedId); setLoadToken(token => token + 1); setPreviewToken(token => token + 1);
      void qc.invalidateQueries({ queryKey: ["website", "sites"] });
    } catch (error) { setFailure(error instanceof Error ? error.message : "The layout action could not be completed."); }
    finally { structurePending.current = false; setStructureBusy(false); }
  }
  structuralHistory.current = step => { if (step < 0 ? page.data?.structure?.canUndo : page.data?.structure?.canRedo) void runStructure(step < 0 ? "undo" : "redo"); };

  if (page.isLoading) return <div className="p-10 text-sm text-muted">Opening the page…</div>;
  if (page.isError) {
    return (
      <div className="m-10 rounded-2xl border border-warn-line bg-warn-surface p-6 text-sm text-warn-text">
        {page.error instanceof ApiError ? page.error.message : "That page could not be opened."}
      </div>
    );
  }
  if (!page.data) return null;

  const { sections, site, links } = page.data;
  const section = sections.find((candidate) => candidate.id === sectionId) ?? sections[0] ?? null;
  const allFields = sections.flatMap((candidate) => candidate.fields);
  const picked = pickedId ? (allFields.find((field) => field.id === pickedId) ?? null) : null;
  const changedCount = Object.values(edits).filter((edit) => Object.keys(edit).length > 0).length + (page.data.structure?.changed ? 1 : 0);
  const canPublish = access.data?.capabilities.publish === true;
  const readOnly = !canEdit || publish.isPending || reviewOpen || showVersions || structureBusy;
  const pickedScope = pickedId ? page.data.shared?.scope[pickedId] : undefined;
  const pickedShared = pickedScope ? page.data.shared?.elements.find((element) => element.instanceId === pickedScope.instanceId) : undefined;
  const pickedResponsive = pickedId ? (edits[pickedId]?.responsive ?? picked?.responsive ?? {}) : {};
  const pickedStyle = device === "desktop"
    ? pickedId ? (edits[pickedId]?.style ?? picked?.style ?? "") : ""
    : pickedResponsive[device] ?? "";
  const changePickedStyle = (style: string, commit = false) => {
    if (!picked) return;
    if (device === "desktop") change(picked.id, { ...edits[picked.id], style }, { commit });
    else {
      if (style.split(";").some(declaration => declaration.trim() && !safeResponsiveStyle(declaration))) {
        setFailure("That screen-size style contains a value the editor cannot save. Use layout, colour, typography or gradient values; image URLs belong in the image control.");
        return;
      }
      const responsive = { ...pickedResponsive };
      if (style.trim()) responsive[device] = safeResponsiveStyle(style);
      else delete responsive[device];
      change(picked.id, { ...edits[picked.id], responsive }, { commit });
    }
  };

  const status = structureBusy ? "Updating layout…" : save.isPending
    ? "Saving…"
    : dirty.current
      ? "Unsaved changes"
      : changedCount > 0
        ? `${changedCount} unpublished change${changedCount === 1 ? "" : "s"}`
        : "Everything published";

  const frameWidth = DEVICES.find((option) => option.key === device)!.width;

  const canvas = (
    <div className="min-h-0 flex-1 overflow-auto bg-cream p-4">
      <div className="mx-auto h-full" style={{ width: frameWidth, minWidth: frameWidth, zoom }}>
        <iframe
          ref={mode === "visual" ? frame : undefined}
          key={`${mode}-${previewToken}`}
          title="Page"
          src={apiUrl(`/website/pages/${pageId}/preview?${mode === "visual" ? "pick=1&" : ""}v=${previewToken}`)}
          className="h-full min-h-[400px] w-full rounded-xl border border-line bg-white shadow-sm shadow-ink/5"
        />
      </div>
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {reviewOpen && <PublishReview pageId={pageId} pending={publish.isPending} onClose={() => setReviewOpen(false)} onConfirm={review => publish.mutate(review)} />}
      {showAI && canEdit && <WebsiteAssistant pageId={pageId} selectedFieldId={pickedId} fieldLabel={picked?.label} values={edits} onClose={() => setShowAI(false)} onApply={values => {
        const merged = { ...latestEdits.current };
        for (const [id, value] of Object.entries(values)) { merged[id] = { ...merged[id], ...value }; change(id, merged[id]); }
        commitHistory(merged);
        setLoadToken(token => token + 1);
        setShowAI(false);
      }} />}
      {showVersions && (
        <WebsiteVersions
          pageId={pageId}
          siteId={site.id}
          draftRevision={revision.current}
          onClose={() => setShowVersions(false)}
          onRestored={() => {
            // A restore writes a draft on the server, and this editor is holding
            // its own copy plus a revision that has just moved. Clearing `dirty`
            // is what lets the seeding effect take the server's version — without
            // it the refetch is ignored and the restore appears to have done
            // nothing at all.
            dirty.current = false;
            try { sessionStorage.removeItem(localDraftKey); } catch { /* Optional recovery storage. */ }
            setPublished(null);
            void qc.invalidateQueries({ queryKey: ["website", "page", pageId] });
            setPreviewToken((token) => token + 1);
          }}
        />
      )}
      {sharedReviewId && (
        <SharedPublishReview
          sharedElementId={sharedReviewId}
          onClose={() => setSharedReviewId(null)}
          onPublished={() => {
            setSharedReviewId(null);
            dirty.current = false;
            void qc.invalidateQueries({ queryKey: ["website", "page", pageId] });
            setPreviewToken((token) => token + 1);
          }}
        />
      )}
      {conflict && (
        <ConflictDialog
          conflict={conflict}
          onKeep={resolveConflict}
          // "Leave it for now" keeps the words in the browser and the draft
          // unsaved, which is honest — the alternative is a dialog that can only
          // be escaped by making a decision, and somebody who wants to go and
          // ask a colleague first has nowhere to go.
          onCancel={() => setConflict(null)}
        />
      )}
      {/* ------------------------------------------------------------ bar */}
      <div className="flex flex-none flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-white px-4 py-2.5">
        <Link to="/website/sites" className="shrink-0 text-xs text-muted underline-offset-2 hover:text-ink hover:underline">
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
              disabled={readOnly || save.isPending || (!historyState.canUndo && !page.data.structure?.canUndo)}
              onClick={() => restore(-1)}
              className="flex h-7 w-7 items-center justify-center rounded-xl text-muted transition enabled:hover:bg-sunken enabled:hover:text-ink disabled:opacity-30"
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
              disabled={readOnly || save.isPending || (!historyState.canRedo && !page.data.structure?.canRedo)}
              onClick={() => restore(1)}
              className="flex h-7 w-7 items-center justify-center rounded-xl text-muted transition enabled:hover:bg-sunken enabled:hover:text-ink disabled:opacity-30"
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
            className="flex h-7 w-7 items-center justify-center rounded-xl text-muted transition hover:bg-sunken hover:text-ink"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
              <g stroke="currentColor" strokeWidth="1.25" fill="none" strokeLinecap="round" strokeLinejoin="round">
                <path d="M11.6 7a4.6 4.6 0 1 1-1.4-3.3" />
                <path d="M11.9 1.7v2.9H9" />
              </g>
            </svg>
          </button>

          {mode !== "edit" && <select aria-label="Canvas zoom" value={zoom} onChange={e => setZoom(Number(e.target.value))} className="rounded-xl border border-line px-2 py-1 text-xs">{[0.5, 0.75, 1, 1.25, 1.5].map(value => <option key={value} value={value}>{value * 100}%</option>)}</select>}
          {mode !== "edit" && (
            <div className="flex overflow-hidden rounded-xl border border-line">
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

          <a className="text-xs text-blue" href={apiUrl(`/website/pages/${pageId}/export`)} download onClick={event => { if (dirty.current || save.isPending) { event.preventDefault(); setFailure("Wait for the current changes to save before downloading."); } }}>Download HTML</a>
          <Button variant="ghost" size="sm" disabled={save.isPending || publish.isPending || structureBusy} onClick={async () => {
            try { if (dirty.current) await save.mutateAsync(latestEdits.current); if (!dirty.current) setShowVersions(true); }
            catch { /* Saving reports the failure and preserves local edits. */ }
          }}>
            Versions
          </Button>
          {/* Site settings enable optional, reviewed AI suggestions. */}
          {canEdit && design.data?.options.aiEnabled && (
            <Button variant="ghost" size="sm" onClick={() => setShowAI(true)}>
              AI
            </Button>
          )}
          {changedCount > 0 && !readOnly && (
            <Button variant="ghost" size="sm" onClick={() => discard.mutate()} disabled={discard.isPending || save.isPending || publish.isPending}>
              Discard
            </Button>
          )}
          {canPublish && (
            <Button
              variant="accent"
              size="sm"
              onClick={async () => {
                try {
                  if (dirty.current) await save.mutateAsync(latestEdits.current);
                  if (dirty.current) { setFailure("Your latest edit is still saving. Review once it has saved."); return; }
                  setReviewOpen(true);
                }
                catch { /* The save error is displayed by its mutation. */ }
              }}
              disabled={publish.isPending || save.isPending || changedCount === 0 || !site.repo}
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
              {/* What went out, in words. A count on its own is not something
                  anybody can check, and this is the last moment before it is
                  only recoverable from the version list. */}
              {published.summary.length > 0 && (
                <ul className="mt-1.5 space-y-0.5 text-xs text-muted">
                  {published.summary.slice(0, 5).map((entry, index) => (
                    <li key={`${entry.id}-${entry.part}-${index}`} className="break-words">
                      {entry.label}: “{entry.from}” → “{entry.to}”
                    </li>
                  ))}
                  {published.summary.length > 5 && <li className="text-muted">and {published.summary.length - 5} more</li>}
                </ul>
              )}
              {published.touched.seo && (
                <p className="mt-1.5 text-xs text-warn-text">
                  This changed the page title or its search-result description. The generated link-preview copies need{" "}
                  <code className="font-mono">npm run site</code> in the repository to match.
                </p>
              )}
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
          {failure && <div className="rounded-xl border border-warn-line bg-warn-surface px-3.5 py-2.5 text-sm text-warn-text">{failure}</div>}
        </div>
      )}

      {/* ---------------------------------------------------------- body */}
      <div className="flex min-h-0 flex-1">
        {mode === "visual" && (
          <aside className="flex w-[300px] flex-none flex-col border-r border-line bg-white">
            <div className="flex flex-none items-center justify-between gap-2 border-b border-line px-4 py-2.5">
              <div className="min-w-0">
                <div className="font-mono text-[9px] uppercase tracking-[.14em] text-muted">{picked ? picked.tag : "Nothing selected"}</div>
                <div className="truncate font-display text-[13px] tracking-[-.02em]">{picked ? picked.label : "Pick something"}</div>
              </div>
              {picked && (
                <button type="button" onClick={() => pick(null)} className="shrink-0 text-[11px] text-muted transition hover:text-ink">
                  Clear
                </button>
              )}
            </div>

            {liveBlind && (
              <p className="flex-none border-b border-line bg-warn-surface px-4 py-2 text-[11px] leading-relaxed text-warn-text">
                The page beside this is not keeping up as you type. Your changes are being saved — it will catch up a moment
                after each one.
              </p>
            )}

            <WebsiteBreadcrumbs fields={allFields} selectedId={pickedId} onSelect={pick} />
            {page.data.structure?.stale && <p role="alert" className="bg-warn-surface px-3 py-2 text-xs text-warn-text">The source changed after these layout edits. Your draft is preserved. Discard it to work from the latest source; publishing is blocked.</p>}
            <WebsiteLayers fields={allFields} edits={edits} problems={problems} shared={page.data.shared?.scope} selectedId={pickedId} onSelect={pick} onMove={readOnly || save.isPending ? undefined : (id, target, position) => { void runStructure(position, id, target); }} />
            {picked && <div className="border-b border-line px-3 py-2">
              <div className="flex flex-wrap gap-2 text-[11px]">
                <button type="button" className="text-blue disabled:text-faint" disabled={readOnly || save.isPending || !picked.structure?.previousId} onClick={() => void runStructure("before", picked.id, picked.structure?.previousId)}>Move up</button>
                <button type="button" className="text-blue disabled:text-faint" disabled={readOnly || save.isPending || !picked.structure?.nextId} onClick={() => void runStructure("after", picked.id, picked.structure?.nextId)}>Move down</button>
                <button type="button" className="text-blue disabled:text-faint" title={picked.structure?.duplicateReason} disabled={readOnly || save.isPending || !picked.structure?.duplicate} onClick={() => void runStructure("duplicate", picked.id)}>Duplicate</button>
                <button type="button" className="text-danger-text disabled:text-faint" disabled={readOnly || save.isPending || !picked.structure?.remove} onClick={() => void runStructure("remove", picked.id)}>Remove</button>
              </div>
              <p className="mt-2 text-[10px] text-muted">{picked.structure?.reason || picked.structure?.duplicateReason || "Drag layers to reorder within their container. Changes stay in the draft; Undo brings them back."}</p>
            </div>}

            <div className="max-h-[70%] min-h-0 flex-none overflow-y-auto">
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
                  {/* Before the controls, not beside them: somebody about to
                      change a heading has to know whether they are changing one
                      page or eight, and afterwards is too late. */}
                  {!pickedShared && picked.kind === "container" && (
                    <MakeSharedPanel
                      siteId={site.id}
                      pageId={pageId}
                      fieldId={picked.id}
                      fieldLabel={picked.label}
                      readOnly={readOnly}
                      onCreated={() => {
                        dirty.current = false;
                        void qc.invalidateQueries({ queryKey: ["website", "page", pageId] });
                      }}
                    />
                  )}
                  {pickedShared && (
                    <SharedElementPanel
                      element={pickedShared}
                      pageTitle={page.data.page.title}
                      readOnly={readOnly}
                      onReview={setSharedReviewId}
                      onChanged={() => {
                        // Detaching moves values into this page's own draft, and
                        // re-linking takes them out again. Either way what this
                        // screen is holding is now the old story.
                        dirty.current = false;
                        void qc.invalidateQueries({ queryKey: ["website", "page", pageId] });
                        setPreviewToken((token) => token + 1);
                      }}
                    />
                  )}

                  <div className="border-b border-line px-4 py-3">
                    <p className="mb-2 text-xs font-semibold">{device === "desktop" ? "Base styles · all sizes" : device === "tablet" ? "Tablet styles · 1024px and below" : "Phone styles · 640px and below"}</p>
                    <p className="mb-3 text-[10px] leading-relaxed text-muted">{device === "desktop" ? "Tablet and phone overrides take precedence at smaller widths." : "Only the controls you change override the larger layout. Reset a value to inherit it again."}</p>
                    {device !== "desktop" && /!\s*important/i.test(edits[picked.id]?.style ?? picked.style ?? "") && <p className="mb-3 text-[10px] leading-relaxed text-warn-text">This element has a base style marked !important. That property keeps its base value at every size until you change it under Desktop.</p>}
                    <div className="flex gap-3 text-[11px]">
                      <button type="button" onClick={() => setStyleClipboard(pickedStyle)} className="text-blue">Copy style</button>
                      <button type="button" disabled={readOnly || styleClipboard === null} onClick={() => changePickedStyle(styleClipboard!, true)} className="text-blue disabled:text-faint">Paste style</button>
                      {device !== "desktop" && <button type="button" disabled={readOnly || !pickedStyle} onClick={() => changePickedStyle("", true)} className="text-blue disabled:text-faint">Clear overrides</button>}
                    </div>
                    <p className="mt-2 text-[10px] text-muted">{computed.width || "—"} × {computed.height || "—"} · {picked.confidence === "annotated" ? "Stable field" : "Discovered element"}</p>
                  </div>

                  {/* One inspector, drawn from what the element is. The frame is
                      what knows that — its display, its parent's, whether it has
                      words of its own — and when the frame cannot be reached the
                      field row is the only thing left to go on. */}
                  <ElementInspector
                    key={`${picked.id}:${device}`}
                    facts={{
                      kind: picked.kind,
                      ...(domFacts ?? {
                        tag: picked.tag,
                        display: "block",
                        parentDisplay: "",
                        position: "static",
                        hasText: picked.kind !== "container",
                        childCount: picked.kind === "container" ? 1 : 0,
                      }),
                    }}
                    device={device}
                    style={pickedStyle}
                    source={{
                      sourceStyle: picked.style ?? "",
                      // Only meaningful under a smaller viewport, where the base
                      // edit is what a phone inherits until it overrides it.
                      baseStyle: device === "desktop" ? "" : edits[picked.id]?.style ?? picked.style ?? "",
                      computed,
                    }}
                    palette={design.data?.options.colours}
                    fonts={design.data?.options.fonts}
                    readOnly={readOnly}
                    onChange={(next) => changePickedStyle(next)}
                    onCommit={() => commitHistory(edits)}
                    onReset={() => changePickedStyle(device === "desktop" ? picked.style ?? "" : picked.responsive?.[device] ?? "", true)}
                    content={
                      <>
                        {picked.kind !== "image" && picked.kind !== "container" && (
                          <div className="mb-2 flex justify-end">
                            <button
                              type="button"
                              onClick={() => tell({ type: "edit", id: picked.id })}
                              className="text-[10px] text-muted underline-offset-2 transition hover:text-blue hover:underline"
                            >
                              {typingId === picked.id ? "Typing on the page" : "Type on the page"}
                            </button>
                          </div>
                        )}
                        {absentIds.has(picked.id) && (
                          <p className="mb-2 rounded-xl bg-cream/70 px-2.5 py-2 text-[11px] leading-relaxed text-muted">
                            {picked.id.startsWith("meta.")
                              ? "This one is not on the page itself — it is what browsers and search results show. Nothing here will change in the preview."
                              : "This one cannot be shown while you type. It appears in the page once the draft saves."}
                          </p>
                        )}
                        {picked.kind === "image" && !readOnly && <div className="mb-4"><WebsiteAssetLibrary siteId={site.id} onSelect={asset => change(picked.id, { ...edits[picked.id], value: asset.url, alt: asset.alt || edits[picked.id]?.alt || picked.alt })} /></div>}
                        <FieldRow
                          key={`${loadToken}:${frameEdit}:${picked.id}`}
                          field={picked}
                          edit={edits[picked.id]}
                          problem={problems.get(picked.id)}
                          publicUrl={site.publicUrl}
                          links={links ?? []}
                          readOnly={readOnly}
                          onChange={(next) => change(picked.id, next)}
                          bare
                        />
                      </>
                    }
                  />
                </>
              )}
            </div>
          </aside>
        )}

        {mode === "edit" ? (
          <>
            <aside className="w-[240px] flex-none overflow-y-auto border-r border-line bg-white p-3">
              <div className="mb-2 px-1 font-mono text-[9px] font-bold uppercase tracking-[.14em] text-muted">Sections</div>
              <ul className="space-y-0.5">
                {sections.map((candidate) => {
                  const edited = candidate.fields.some((field) => edits[field.id]);
                  return (
                    <li key={candidate.id}>
                      <button
                        type="button"
                        onClick={() => setSectionId(candidate.id)}
                        title={candidate.label}
                        className={`flex w-full items-center justify-between gap-2 rounded-xl px-2.5 py-1.5 text-left text-[12px] ${
                          candidate.id === section?.id ? "bg-ink text-cream" : "text-ink hover:bg-sunken"
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
                        links={links ?? []}
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
