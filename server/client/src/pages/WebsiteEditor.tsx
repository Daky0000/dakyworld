import { formatActiveText } from "../lib/websiteTextSelection";
import { WebsiteRichText } from "../components/WebsiteRichText";
import { WebsiteTextFormatting } from "../components/WebsiteTextFormatting";
import { WebsiteInteractionStyles } from "../components/WebsiteInteractionStyles";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { api, ApiError, apiUrl } from "../lib/api";
import { useAuth } from "../lib/auth";
import type { DraftConflict, DraftSaveResult, FieldEdit, PublishResult, SiteFieldRow, SiteSectionRow, SitePageDetail } from "../lib/types";
import { Badge, Button, RelativeTime } from "../components/ui";
import { WebsiteQuickStart } from "../components/WebsiteQuickStart";
import { WebsiteGuideModal } from "../components/WebsiteGuideModal";
import { WebsiteImageFraming } from "../components/WebsiteImageFraming";
import { WebsitePresetPicker } from "../components/WebsiteBrandPresets";
import type { BrandPreset } from "../lib/websiteBrandPresets";
import { WebsiteAssetLibrary, WebsiteAssetPickerModal } from "../components/WebsiteAssetLibrary";
import { MakeSharedPanel, SharedElementPanel, SharedPublishReview } from "../components/WebsiteShared";
import { PublishStatus } from "../components/PublishStatus";
import { PublishReview, type WebsiteReview } from "../components/PublishReview";
import { ElementInspector } from "../components/ElementInspector";
import { ColorCodeInput, parseStyle, writeStyle } from "../components/InspectorControls";
import { INSPECTED_PROPERTIES, toHex, type ElementFacts } from "../lib/elementInspector";
import { WebsiteLayers, WebsiteBreadcrumbs } from "../components/WebsiteLayers";
import { WebsiteVersions } from "../components/WebsiteVersions";
import { WebsiteAssistant } from "../components/WebsiteAssistant";
import { WebsiteAgentChat } from "../components/WebsiteAgentChat";
import { WebsitePageSeoInspector } from "../components/WebsitePageSeoInspector";
import {
  WebsiteClientReportModal,
  WebsiteCommandPaletteModal,
  WebsiteRevisionCommentsModal,
  WebsiteSectionLibraryModal,
} from "../components/WebsiteCommandAndSections";
import {
  IconArrowLeft,
  IconBookOpen,
  IconBrush,
  IconCheck,
  IconChevronDown,
  IconCopy,
  IconDesktop,
  IconDownload,
  IconEdit,
  IconEye,
  IconEyeOff,
  IconFileText,
  IconHistory,
  IconLayers,
  IconLayout,
  IconList,
  IconMessageSquare,
  IconMoon,
  IconMoreHorizontal,
  IconPalette,
  IconPaste,
  IconPhoneDevice,
  IconPlusSquare,
  IconRedo,
  IconRefresh,
  IconSave,
  IconSearch,
  IconSidebar,
  IconSliders,
  IconSparkles,
  IconSun,
  IconTablet,
  IconTag,
  IconTarget,
  IconTrash,
  IconUndo,
  IconUploadCloud,
  IconXCircle,
} from "../components/WebsiteIcons";
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
  /** Offered only on a field the editor could unlock by naming it in the code.
   * Absent everywhere else, so the button never appears where it cannot help. */
  onNameFields?: () => void;
  naming?: boolean;
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
  onNameFields,
  naming,
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
  /** Offered only on a field the editor could unlock by naming it in the code.
   * Absent everywhere else, so the button never appears where it cannot help. */
  onNameFields?: () => void;
  naming?: boolean;
  readOnly: boolean;
  /** Inside the visual panel, where the card's own border and title are noise. */
  bare?: boolean;
}) {
  // A field on a built page that no literal in the source produced. It is real
  // and it is on the page; it is simply not ours to change, and saying so here
  // is the difference between knowing now and being refused at the publish.
  readOnly = readOnly || field.sourceManaged === true;
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
          <span className="text-xs font-bold uppercase tracking-[.1em] text-muted">{field.label}</span>
          {changed && <Badge tone="warn">Changed</Badge>}
        </div>
      )}
      {bare && changed && (
        <div className="mb-2">
          <Badge tone="warn">Changed</Badge>
        </div>
      )}

      {(field.kind === "richtext" || (field.kind === "text" && field.tag !== "title" && field.tag !== "meta")) && <WebsiteRichText label={field.label} html={value} readOnly={readOnly} onChange={(next) => onChange({ ...edit, value: next })} />}

      {field.kind === "text" && (field.tag === "title" || field.tag === "meta") && (
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
              <WebsiteRichText label={field.label} html={value} readOnly={readOnly || !field.value} onChange={next => onChange({ ...edit, value: next })} />
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

      {field.sourceManaged && (
        <div className="mt-2 rounded-[10px] bg-sunken px-2 py-1 text-xs text-muted">
          <p>{field.sourceNote ?? "This is written by the code that builds this page, so it cannot be changed here."}</p>
          {field.sourceNameable && onNameFields && (
            <button type="button" className="mt-1.5 rounded-[10px] bg-ink px-2 py-1 text-[11px] font-semibold text-cream disabled:opacity-60" disabled={naming} onClick={onNameFields}>
              {naming ? "Naming…" : "Name these fields"}
            </button>
          )}
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
                <span className="text-xs uppercase tracking-[.1em] text-muted">
                  {contested.length} field{contested.length === 1 ? "" : "s"} you both changed
                </span>
                <button
                  type="button"
                  onClick={() => setChoices(Object.fromEntries(contested.map((field) => [field.id, "yours" as const])))}
                  className="ml-auto text-xs text-muted underline-offset-2 hover:text-ink hover:underline"
                >
                  Keep all mine
                </button>
                <button
                  type="button"
                  onClick={() => setChoices(Object.fromEntries(contested.map((field) => [field.id, "theirs" as const])))}
                  className="text-xs text-muted underline-offset-2 hover:text-ink hover:underline"
                >
                  Keep all theirs
                </button>
              </div>

              <div className="space-y-3">
                {contested.map((field) => (
                  <div key={field.id} className="rounded-xl border border-line p-3">
                    <div className="mb-2 text-xs font-bold uppercase tracking-[.08em] text-muted">{field.label}</div>
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
                          <div className="mb-1 text-xs uppercase tracking-[.1em]">
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
  const [designerMode, setDesignerMode] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<"content" | "seo" | "style" | "interactions">("content");
  const [showLayers, setShowLayers] = useState(false);
  const [showPanel, setShowPanel] = useState(() => typeof window === "undefined" || window.innerWidth > 600);
  const [editorTheme, setEditorTheme] = useState(() => { try { return localStorage.getItem("website-editor-theme") || "dark"; } catch { return "dark"; } });
  const [showGuide, setShowGuide] = useState(false);
  const [guideModalOpen, setGuideModalOpen] = useState(false);
  const [sectionLibraryOpen, setSectionLibraryOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [commentsModalOpen, setCommentsModalOpen] = useState(false);
  const [clientReportOpen, setClientReportOpen] = useState(false);
  useEffect(() => {
    const onGlobalKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCommandPaletteOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", onGlobalKeyDown);
    return () => window.removeEventListener("keydown", onGlobalKeyDown);
  }, []);
  useEffect(() => {
    if (!user?.id) return;
    try { setDesignerMode(localStorage.getItem(`website-designer:${user.id}`) === "yes"); setShowGuide(localStorage.getItem(`website-guide:${user.id}`) !== "done"); } catch { setShowGuide(true); }
  }, [user?.id]);
  const closeGuide = () => { setShowGuide(false); try { localStorage.setItem(`website-guide:${user?.id}`, "done"); } catch { /* Preferences are optional. */ } };
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
  const [textClipboard, setTextClipboard] = useState<string | null>(null);
  const [contextToast, setContextToast] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    fieldId: string | null;
    tag: string | null;
    kind: string | null;
    text: string;
  } | null>(null);
  const showQuickToast = useCallback((msg: string) => {
    setContextToast(msg);
    window.setTimeout(() => {
      setContextToast((prev) => (prev === msg ? null : prev));
    }, 2600);
  }, []);
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setContextMenu(null);
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [contextMenu]);
  const [zoom, setZoom] = useState(1);
  const [sectionId, setSectionId] = useState<string | null>(null);
  const demoIdFromUrl = useMemo(() => {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("demoId");
  }, []);
  const [mode, setMode] = useState<Mode>(() => {
    if (typeof window === "undefined") return "visual";
    const m = new URLSearchParams(window.location.search).get("mode");
    return m === "edit" || m === "preview" || m === "visual" ? m : "visual";
  });
  /** The field the person clicked in the preview. */
  const [pickedId, setPickedId] = useState<string | null>(null);
  useEffect(() => {
    if (pickedId && inspectorTab === "seo") {
      setInspectorTab("content");
    } else if (!pickedId && (inspectorTab === "style" || inspectorTab === "interactions")) {
      setInspectorTab("content");
    }
  }, [pickedId, inspectorTab]);
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
  const [device, setDevice] = useState<Device>(() => typeof window !== "undefined" && window.innerWidth <= 600 ? "mobile" : "desktop");
  useEffect(() => {
    const adapt = () => {
      if (window.innerWidth > 600) return;
      setShowPanel(false);
      setDevice("mobile");
    };
    window.addEventListener("resize", adapt);
    adapt();
    return () => window.removeEventListener("resize", adapt);
  }, []);
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
  const [assetModalOpen, setAssetModalOpen] = useState(false);
  type PeerEditor = { userId: string; name: string; email?: string; color: string };
  const [peers, setPeers] = useState<PeerEditor[]>([]);

  useEffect(() => {
    if (!pageId) return;
    let mounted = true;
    const ping = async () => {
      try {
        const res = await api.post<{ editors: PeerEditor[] }>(`/website/pages/${pageId}/presence`, {});
        if (mounted) setPeers(res.editors ?? []);
      } catch {
        /* Presence is non-blocking */
      }
    };
    void ping();
    const interval = window.setInterval(ping, 15_000);
    return () => {
      mounted = false;
      window.clearInterval(interval);
      void api.delete(`/website/pages/${pageId}/presence`).catch(() => {});
    };
  }, [pageId]);

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
  const design = useQuery({ queryKey: ["website", "design", page.data?.site.id], enabled: !!page.data?.site.id, queryFn: () => api.get<{ options: { colours: string[]; fonts: string[]; aiEnabled: boolean; presets: BrandPreset[] } }>(`/website/sites/${page.data!.site.id}/design`) });

  /* ------------------------------------------------------------- history */

  // Unified undo/redo across both content changes and structural mutations.
  // One Ctrl+Z smoothly takes back the last action regardless of whether it
  // was typing, styling, or duplicating/reordering a block.
  type HistoryItem = {
    kind: "content" | "structure";
    values: Record<string, FieldEdit>;
    action?: string;
    fieldId?: string;
    targetId?: string;
  };

  const history = useRef<{ list: HistoryItem[]; index: number }>({
    list: [{ kind: "content", values: {} }],
    index: 0,
  });
  const [historyState, setHistoryState] = useState({ canUndo: false, canRedo: false });
  const restoring = useRef(false);
  const commitTimer = useRef<number | null>(null);

  const syncHistoryButtons = useCallback(() => {
    const { list, index } = history.current;
    setHistoryState({
      canUndo: index > 0 || Boolean(page.data?.structure?.canUndo),
      canRedo: index < list.length - 1 || Boolean(page.data?.structure?.canRedo),
    });
  }, [page.data?.structure]);

  const commitHistory = useCallback((values: Record<string, FieldEdit>) => {
    if (restoring.current) return;
    if (commitTimer.current !== null) {
      window.clearTimeout(commitTimer.current);
      commitTimer.current = null;
    }
    const state = history.current;
    const current = state.list[state.index];
    const snapshot = JSON.stringify(values);
    if (current && current.kind === "content" && JSON.stringify(current.values) === snapshot) return;
    state.list = state.list.slice(0, state.index + 1);
    state.list.push({ kind: "content", values: { ...values } });
    if (state.list.length > 60) state.list.shift();
    state.index = state.list.length - 1;
    syncHistoryButtons();
  }, [syncHistoryButtons]);

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
      const data = event.data as {
        source?: string;
        type?: string;
        id?: string | null;
        html?: string;
        final?: boolean;
        key?: string;
        shiftKey?: boolean;
        clientX?: number;
        clientY?: number;
        tag?: string | null;
        kind?: string | null;
        text?: string;
      };
      if (event.source !== frame.current?.contentWindow || event.origin !== window.location.origin || data?.source !== "dakyworld-preview") return;
      if (data.type === "shortcut" && data.key && ["s", "z", "Z", "y", "Y", "Enter"].includes(data.key)) {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: data.key, ctrlKey: true, shiftKey: !!data.shiftKey, cancelable: true }));
      } else if (data.type === "select") {
        setContextMenu(null);
        setPickedId(data.id ?? null);
      } else if (data.type === "contextmenu") {
        const rect = frame.current?.getBoundingClientRect();
        const rawX = (rect?.left ?? 0) + (data.clientX ?? 0);
        const rawY = (rect?.top ?? 0) + (data.clientY ?? 0);
        const x = Math.max(12, Math.min(rawX, window.innerWidth - 280));
        const y = Math.max(12, Math.min(rawY, window.innerHeight - 420));
        setPickedId(data.id ?? null);
        setContextMenu({
          x,
          y,
          fieldId: data.id ?? null,
          tag: data.tag ?? null,
          kind: data.kind ?? null,
          text: data.text ?? "",
        });
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
          history.current = {
            list: [
              { kind: "content", values: page.data.draft.values },
              { kind: "content", values: local.values },
            ],
            index: 1,
          };
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
    history.current = { list: [{ kind: "content", values: page.data.draft.values }], index: 0 };
    syncHistoryButtons();
    setSectionId((current) => current ?? page.data.sections[0]?.id ?? null);
  }, [page.data]);

  const save = useMutation({
    // Saving can beat the typing debounce. Preserve that edit as an undo step first.
    onMutate: (values: Record<string, FieldEdit>) => { commitHistory(values); },
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
    async (step: number) => {
      if (!canEdit || reviewOpen || showVersions || publishPending.current || structurePending.current) return;
      if (step < 0 && dirty.current) commitHistory(latestEdits.current);
      const state = history.current;
      const targetIndex = state.index + step;

      if (targetIndex < 0) {
        structuralHistory.current(-1);
        return;
      }
      if (targetIndex >= state.list.length) {
        structuralHistory.current(1);
        return;
      }

      const currentEntry = state.list[state.index];
      const targetEntry = state.list[targetIndex];

      if (step < 0 && currentEntry?.kind === "structure") {
        state.index = targetIndex;
        syncHistoryButtons();
        await runStructure("undo");
        return;
      }

      if (step > 0 && targetEntry?.kind === "structure") {
        state.index = targetIndex;
        syncHistoryButtons();
        await runStructure("redo");
        return;
      }

      restoring.current = true;
      state.index = targetIndex;
      const values = targetEntry ? targetEntry.values : {};
      setEdits(values);
      latestEdits.current = values;
      dirty.current = true;
      setLoadToken((token) => token + 1);
      needsReload.current = true;
      setPreviewToken((token) => token + 1);
      syncHistoryButtons();
      window.setTimeout(() => {
        restoring.current = false;
      }, 0);
    },
    [canEdit, reviewOpen, showVersions, commitHistory, syncHistoryButtons],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const inField = !!target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA");
      if (event.defaultPrevented || showAI || reviewOpen || showVersions) return;
      if ((event.ctrlKey || event.metaKey) && ["s", "Enter"].includes(event.key)) {
        event.preventDefault();
        if (!canEdit || publishPending.current || structurePending.current) return;
        if (event.key === "Enter" && !access.data?.capabilities.publish) return;
        void (async () => { try { if (dirty.current) await save.mutateAsync(latestEdits.current); if (event.key === "Enter" && !dirty.current) setReviewOpen(true); } catch {} })();
        return;
      }
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
        // Escape closes the thing on top, not everything underneath it. An open
        // menu is the top layer, so closing one must not also throw away the
        // element somebody had selected — they pressed Escape to dismiss the
        // menu, and losing their place is not what they asked for.
        const menu = document.querySelector<HTMLDetailsElement>("details[data-editor-menu][open]");
        if (menu) {
          menu.open = false;
          return;
        }
        tell({ type: "stopEdit" });
        pick(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [restore, pick, tell, showAI, reviewOpen, showVersions, canEdit, access.data, save]);

  const discard = useMutation({
    mutationFn: () => api.delete(`/website/pages/${pageId}/draft?ifRevision=${revision.current}`),
    onError: err => setFailure(err instanceof Error ? err.message : "The draft could not be discarded."),
    onSuccess: () => {
      setEdits({});
      dirty.current = false;
      try { sessionStorage.removeItem(localDraftKey); } catch { /* Optional recovery storage. */ }
      history.current = { list: [{ kind: "content", values: {} }], index: 0 };
      syncHistoryButtons();
      setPreviewToken((token) => token + 1);
      void qc.invalidateQueries({ queryKey: ["website"] });
    },
  });

  const publish = useMutation({
    mutationFn: (review: WebsiteReview) =>
      api.post<PublishResult>(`/website/pages/${pageId}/publish`, {
        ifRevision: review.revision,
        sourceHash: review.sourceHash,
        mode: review.mode,
        prTitle: review.prTitle,
      }),
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
      history.current = { list: [{ kind: "content", values: {} }], index: 0 };
      syncHistoryButtons();
      setPreviewToken((token) => token + 1);
      void qc.invalidateQueries({ queryKey: ["website"] });
      void qc.invalidateQueries({ queryKey: ["demos"] });
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
      if (kind !== "undo" && kind !== "redo") {
        const state = history.current;
        state.list = state.list.slice(0, state.index + 1);
        state.list.push({ kind: "structure", action: kind, values: refreshed.draft.values, fieldId, targetId });
        if (state.list.length > 60) state.list.shift();
        state.index = state.list.length - 1;
      }
      syncHistoryButtons();
      setPublished(null); setPickedId(result.selectedId); setLoadToken(token => token + 1); setPreviewToken(token => token + 1);
      void qc.invalidateQueries({ queryKey: ["website", "sites"] });
    } catch (error) { setFailure(error instanceof Error ? error.message : "The layout action could not be completed."); }
    finally { structurePending.current = false; setStructureBusy(false); }
  }
  /**
   * Ask the editor to label the shared-words elements in the code.
   *
   * One commit to the site's repository, so it is deliberate rather than
   * automatic — and the fields it names only become editable once the site
   * rebuilds, which the message says rather than leaving somebody clicking the
   * same locked element wondering.
   */
  const [naming, setNaming] = useState(false);
  async function nameFields() {
    if (naming) return;
    setNaming(true); setFailure(null);
    try {
      const result = await api.post<{ named: number; removed: number; files: string[]; message: string }>(`/website/pages/${pageId}/name-fields`, {});
      setFailure(result.message);
      await qc.invalidateQueries({ queryKey: ["website", "page", pageId] });
      setLoadToken(token => token + 1); setPreviewToken(token => token + 1);
    } catch (error) { setFailure(error instanceof Error ? error.message : "The fields on this page could not be named."); }
    finally { setNaming(false); }
  }

  structuralHistory.current = step => { if (step < 0 ? page.data?.structure?.canUndo : page.data?.structure?.canRedo) void runStructure(step < 0 ? "undo" : "redo"); };

  /**
   * These hooks sit above the early returns below on purpose. React counts
   * hooks per render: the first render of this page is a loading one that
   * returns early, so a hook declared after that return does not exist yet,
   * and appears only once the data arrives -- which throws, and leaves the
   * editor a blank screen. The fields they read are derived from optional
   * data here for the same reason.
   */
  const allFields = (page.data?.sections ?? []).flatMap((candidate) => candidate.fields);

  const [pageColorTokens, setPageColorTokens] = useState<Array<{ key: string; label: string; value: string; isVar: boolean }>>([]);
  const [assetTargetMode, setAssetTargetMode] = useState<"image" | "background">("image");

  const syncPageColorsFromFrame = useCallback(() => {
    try {
      const doc = frame.current?.contentDocument;
      if (!doc) return;
      const bodyField = allFields.find((f) => f.tag === "body");
      const bodyStyleMap = parseStyle(bodyField ? (edits[bodyField.id]?.style ?? bodyField.style ?? "") : "");
      const tokens: Array<{ key: string; label: string; value: string; isVar: boolean }> = [];
      const seenVars = new Set<string>();
      const seenHexes = new Set<string>();

      const styles = Array.from(doc.querySelectorAll("style:not([data-dw-interaction-preview]):not([data-dw-responsive-preview])"));
      const cssText = styles.map((s) => s.textContent || "").join("\n");

      const varRegex = /(--[a-zA-Z0-9_-]+)\s*:\s*(#[0-9a-fA-F]{3,8}|rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+(?:\s*,\s*[\d.]+)?\s*\))/g;
      let match: RegExpExecArray | null;
      while ((match = varRegex.exec(cssText)) !== null) {
        const varName = match[1]!.trim();
        if (varName.startsWith("--dw-")) continue;
        if (seenVars.has(varName)) continue;
        const rawVal = bodyStyleMap[varName] ?? match[2]!.trim();
        const hex = toHex(rawVal) ?? (rawVal.startsWith("#") ? rawVal.toUpperCase() : null);
        if (!hex) continue;
        seenVars.add(varName);
        seenHexes.add(hex.toUpperCase());
        const cleanLabel = varName.replace(/^--/, "").replace(/[-_]+/g, " ");
        tokens.push({
          key: varName,
          label: `${cleanLabel.charAt(0).toUpperCase() + cleanLabel.slice(1)} (${varName})`,
          value: hex.toUpperCase(),
          isVar: true,
        });
      }

      const hexRegex = /#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g;
      while ((match = hexRegex.exec(cssText)) !== null && tokens.length < 18) {
        const hex = (toHex(match[0]) ?? match[0]).toUpperCase();
        if (seenHexes.has(hex)) continue;
        seenHexes.add(hex);
        tokens.push({
          key: hex,
          label: `Page Color ${hex}`,
          value: hex,
          isVar: false,
        });
      }

      // Re-apply any saved body CSS variables into the iframe's root & body
      for (const [prop, val] of Object.entries(bodyStyleMap)) {
        if (prop.startsWith("--") && val) {
          doc.documentElement?.style?.setProperty(prop, val);
          doc.body?.style?.setProperty(prop, val);
        }
      }

      if (tokens.length > 0) setPageColorTokens(tokens);
    } catch {
      /* Cross-origin fallback */
    }
  }, [allFields, edits]);

  const updatePageColorToken = useCallback(
    (tokenKey: string, nextHex: string, isVar: boolean, previousHex: string) => {
      const formatted = nextHex.startsWith("#") ? nextHex.toUpperCase() : `#${nextHex.toUpperCase()}`;
      setPageColorTokens((prev) =>
        prev.map((item) => (item.key === tokenKey ? { ...item, value: formatted } : item)),
      );

      // 1. Update live in the preview iframe immediately
      try {
        const doc = frame.current?.contentDocument;
        if (doc) {
          if (isVar) {
            doc.documentElement?.style?.setProperty(tokenKey, formatted);
            doc.body?.style?.setProperty(tokenKey, formatted);
          }
          if (previousHex && previousHex.toUpperCase() !== formatted) {
            const escapedOld = previousHex.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const re = new RegExp(escapedOld, "gi");
            doc.querySelectorAll("style:not([data-dw-interaction-preview])").forEach((styleEl) => {
              if (styleEl.textContent && re.test(styleEl.textContent)) {
                styleEl.textContent = styleEl.textContent.replace(re, formatted);
              }
            });
          }
        }
      } catch {}

      if (isVar) {
        tell({ type: "cssVar", name: tokenKey, value: formatted });
      }

      // 2. Persist on the body container field (and any element with matching inline hex)
      const bodyField = allFields.find((f) => f.tag === "body") ?? allFields.find((f) => f.kind === "container");
      if (bodyField && isVar) {
        const currentStyle = edits[bodyField.id]?.style ?? bodyField.style ?? "";
        const map = parseStyle(currentStyle);
        map[tokenKey] = formatted;
        change(bodyField.id, { ...edits[bodyField.id], style: writeStyle(map) }, { commit: true });
      }
      if (previousHex) {
        const oldUpper = previousHex.toUpperCase();
        for (const field of allFields) {
          const st = edits[field.id]?.style ?? field.style ?? "";
          if (st && st.toUpperCase().includes(oldUpper)) {
            const replaced = st.replace(new RegExp(previousHex.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), formatted);
            change(field.id, { ...edits[field.id], style: replaced }, { commit: true });
          }
        }
      }
    },
    [allFields, change, edits, tell],
  );
  if (page.isLoading) return <div className="p-10 text-sm text-muted">Opening the page…</div>;
  if (page.isError) {
    // 409 here has one cause: a page whose file is source, with no built copy of
    // it anywhere — no export in the repository, no render service, nothing
    // published yet. Its words are still editable, so the way there is offered
    // rather than left for somebody to find.
    const noBuild = page.error instanceof ApiError && page.error.status === 409;
    return (
      <div className="m-10 rounded-2xl border border-warn-line bg-warn-surface p-6 text-sm text-warn-text">
        {page.error instanceof ApiError ? page.error.message : "That page could not be opened."}
        {noBuild && (
          <Link className="mt-4 block font-semibold text-blue hover:underline" to={`/website/pages/${pageId}/source`}>
            Edit this page&rsquo;s text in its source file
          </Link>
        )}
      </div>
    );
  }
  if (!page.data) return null;

  const { sections, site, links } = page.data;
  const section = sections.find((candidate) => candidate.id === sectionId) ?? sections[0] ?? null;
  const picked = pickedId ? (allFields.find((field) => field.id === pickedId) ?? null) : null;
  const changedCount = Object.values(edits).filter((edit) => Object.keys(edit).length > 0).length + (page.data.structure?.changed ? 1 : 0);
  const canPublish = access.data?.capabilities.publish === true;
  const readOnly = !canEdit || publish.isPending || reviewOpen || showVersions || structureBusy;
  const pickedScope = pickedId ? page.data.shared?.scope[pickedId] : undefined;
  const pickedShared = pickedScope ? page.data.shared?.elements.find((element) => element.instanceId === pickedScope.instanceId) : undefined;
  let pickedElement: HTMLElement | null = null;
  try { pickedElement = pickedId ? frame.current?.contentDocument?.querySelector<HTMLElement>(`[data-dw-field="${CSS.escape(pickedId)}"]`) ?? null : null; } catch { /* Preview reconnects after load. */ }
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
        ? `Draft saved · ${changedCount} unpublished change${changedCount === 1 ? "" : "s"}`
        : "No unpublished changes";

  const frameWidth = DEVICES.find((option) => option.key === device)!.width;

  const openEditorContextMenuFromEvent = (
    clientX: number,
    clientY: number,
    el: HTMLElement | null,
    fallbackTarget?: HTMLElement | null,
    fromIframe = false,
  ) => {
    const id = el ? el.getAttribute("data-dw-field") : null;
    const rect = fromIframe ? frame.current?.getBoundingClientRect() : undefined;
    const rawX = (rect ? rect.left : 0) + clientX * (fromIframe ? zoom : 1);
    const rawY = (rect ? rect.top : 0) + clientY * (fromIframe ? zoom : 1);
    const x = Math.max(12, Math.min(rawX, window.innerWidth - 280));
    const y = Math.max(12, Math.min(rawY, window.innerHeight - 420));
    setPickedId(id ?? null);
    if (id) writeInFrame("select", id);
    const tag = el
      ? el.tagName.toLowerCase()
      : fallbackTarget?.tagName
        ? fallbackTarget.tagName.toLowerCase()
        : null;
    const text = (
      (el ? el.innerText || el.textContent : fallbackTarget ? fallbackTarget.innerText || fallbackTarget.textContent : "") ||
      ""
    ).trim();
    setContextMenu({
      x,
      y,
      fieldId: id ?? null,
      tag,
      kind: el ? el.getAttribute("data-dw-kind") : null,
      text,
    });
  };


  const bindIframeContextMenu = () => {
    syncPageColorsFromFrame();
    try {
      const doc = frame.current?.contentDocument;
      if (!doc) return;
      const docAny = doc as Document & { __dwCtxBound?: boolean };
      if (docAny.__dwCtxBound) return;
      docAny.__dwCtxBound = true;
      doc.addEventListener(
        "contextmenu",
        (event: MouseEvent) => {
          const target = event.target as HTMLElement | null;
          const el = target?.closest ? (target.closest("[data-dw-field]") as HTMLElement | null) : null;
          if (el?.hasAttribute("data-dw-editing")) return;
          event.preventDefault();
          event.stopPropagation();
          openEditorContextMenuFromEvent(event.clientX, event.clientY, el, target, true);
        },
        true,
      );
      doc.addEventListener(
        "click",
        () => {
          setContextMenu(null);
        },
        true,
      );
    } catch {
      /* Cross-origin fallback relies on postMessage from site.ts */
    }
  };

  const canvas = (
    <div
      className="editor-canvas min-h-0 flex-1 overflow-auto bg-cream p-4"
      onContextMenu={(event) => {
        event.preventDefault();
        openEditorContextMenuFromEvent(event.clientX, event.clientY, null, null, false);
      }}
    >
      <div className="mx-auto h-full" style={{ width: frameWidth, minWidth: frameWidth, zoom }}>
        <iframe
          ref={mode === "visual" ? frame : undefined}
          key={`${mode}-${previewToken}`}
          title="Page"
          onLoad={bindIframeContextMenu}
          src={apiUrl(`/website/pages/${pageId}/preview?${mode === "visual" ? "pick=1&" : ""}v=${previewToken}`)}
          className="h-full min-h-[400px] w-full border border-line bg-white shadow-sm shadow-ink/5"
        />
      </div>
    </div>
  );

  return (
    <div className={`website-editor editor-${editorTheme} flex h-full min-h-0 flex-col`}>
      {reviewOpen && <PublishReview pageId={pageId} pending={publish.isPending} onClose={() => setReviewOpen(false)} onConfirm={review => publish.mutate(review)} />}
      {showAI && canEdit && <WebsiteAssistant pageId={pageId} selectedFieldId={pickedId} fieldLabel={picked?.label} values={edits} onClose={() => setShowAI(false)} onApply={async (values, structuralActions) => {
        if (structuralActions && structuralActions.length > 0) {
          for (const action of structuralActions) {
            await runStructure(action.kind, action.fieldId);
          }
        }
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
          // "Leave it for now" keeps the words in the browser and the draft
          // unsaved, which is honest — the alternative is a dialog that can only
          // be escaped by making a decision, and somebody who wants to go and
          // ask a colleague first has nowhere to go.
          onKeep={resolveConflict}
          onCancel={() => setConflict(null)}
        />
      )}
      {showGuide && <WebsiteQuickStart onClose={closeGuide} />}
      <WebsiteGuideModal open={guideModalOpen} onClose={() => setGuideModalOpen(false)} />
      {site && (
        <>
          <WebsiteSectionLibraryModal
            open={sectionLibraryOpen}
            onClose={() => setSectionLibraryOpen(false)}
            siteId={site.id}
            pageId={pageId}
            onInserted={(label) => {
              dirty.current = false;
              setPreviewToken((token) => token + 1);
              showQuickToast(`Inserted section: ${label}`);
            }}
          />
          <WebsiteRevisionCommentsModal
            open={commentsModalOpen}
            onClose={() => setCommentsModalOpen(false)}
            siteId={site.id}
            pageId={pageId}
            selectedFieldId={picked ? picked.id : null}
            selectedFieldLabel={picked ? picked.label : null}
            onSelectField={(fieldId: string) => {
              setShowPanel(true);
              setMode("visual");
              pick(fieldId);
            }}
          />
          <WebsiteClientReportModal
            open={clientReportOpen}
            onClose={() => setClientReportOpen(false)}
            siteId={site.id}
            pageId={pageId}
          />
        </>
      )}
      <WebsiteCommandPaletteModal
        open={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
        fields={allFields.map((f) => ({
          id: f.id,
          label: f.label,
          kind: f.kind,
          value: edits[f.id]?.value ?? f.value ?? "",
        }))}
        onSelectField={(fieldId) => {
          setShowPanel(true);
          setMode("visual");
          pick(fieldId);
        }}
        onOpenSeoTab={() => {
          pick(null);
          setShowPanel(true);
          setMode("visual");
          setInspectorTab("seo");
        }}
        onOpenSectionLibrary={() => setSectionLibraryOpen(true)}
        onOpenAiAssistant={() => setShowAI(true)}
        onSetDevice={(dev) => setDevice(dev)}
        onToggleTheme={() => {
          const next = editorTheme === "dark" ? "light" : "dark";
          setEditorTheme(next);
          try {
            localStorage.setItem("website-editor-theme", next);
          } catch {}
        }}
        onOpenPublishReview={() => setReviewOpen(true)}
      />
      {assetModalOpen && site && picked && (
        <WebsiteAssetPickerModal
          siteId={site.id}
          onSelect={asset => {
            if (assetTargetMode === "background" || picked.kind !== "image") {
              const map = parseStyle(pickedStyle ?? "");
              map["background-image"] = `url('${asset.url.replace(/['"\\]/g, "")}')`;
              if (!map["background-size"]) map["background-size"] = "cover";
              if (!map["background-position"]) map["background-position"] = "center";
              changePickedStyle(writeStyle(map), true);
            } else {
              change(picked.id, { ...edits[picked.id], value: asset.url, alt: asset.alt || edits[picked.id]?.alt || picked.alt }, { commit: true });
            }
            setAssetModalOpen(false);
          }}
          onClose={() => setAssetModalOpen(false)}
        />
      )}
      {/* ------------------------------------------------------------ bar */}
      <div className="editor-toolbar flex flex-none flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-line bg-white px-3.5 py-2">
        {/* Left zone: Back button + Page identity + Status pill */}
        <div className="flex min-w-0 items-center gap-2.5">
          <Link
            to={demoIdFromUrl || page.data.readFrom === "imported file" || /\/demos\/[^/?#]+/i.test(site.publicUrl) ? "/demos" : "/website/sites"}
            title={demoIdFromUrl || page.data.readFrom === "imported file" || /\/demos\/[^/?#]+/i.test(site.publicUrl) ? "Back to Demos list" : "Back to all pages"}
            aria-label="Back"
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-xl border border-line bg-sunken/40 px-2.5 text-xs font-medium text-muted transition hover:border-line-strong hover:bg-sunken hover:text-ink"
          >
            <IconArrowLeft size={14} />
            <span>{demoIdFromUrl || page.data.readFrom === "imported file" || /\/demos\/[^/?#]+/i.test(site.publicUrl) ? "Demos" : "Pages"}</span>
          </Link>

          <div className="h-5 w-px shrink-0 bg-line" aria-hidden="true" />

          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <div className="truncate font-display text-sm font-semibold tracking-[-.02em] text-ink">
                {page.data.page.title}
              </div>
              <span className="shrink-0 rounded-md border border-line bg-sunken/60 px-1.5 py-0.5 font-mono text-[11px] text-muted">
                {page.data.page.path}
              </span>
              <span
                className={`hidden sm:inline-flex items-center gap-1.5 rounded-full border border-line bg-sunken/40 px-2 py-0.5 text-[11px] font-medium ${
                  dirty.current || changedCount > 0 ? "text-ink" : "text-muted"
                }`}
                title={
                  page.data.builtFrom
                    ? `Built from ${page.data.builtFrom.filePath}${page.data.builtFrom.detail ? ` — ${page.data.builtFrom.detail}` : ""}`
                    : status
                }
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    dirty.current || changedCount > 0 ? "bg-amber-500" : "bg-emerald-500"
                  }`}
                />
                <span className="truncate max-w-[180px]">{status}</span>
                {page.data.draft.savedAt && (
                  <span className="text-muted">
                    · <RelativeTime value={page.data.draft.savedAt} />
                  </span>
                )}
              </span>
              {peers.length > 0 && (
                <div
                  className="flex items-center gap-1.5 border-l border-line pl-2"
                  title={`${peers.map((p) => p.name).join(", ")} currently viewing this page`}
                >
                  <div className="flex -space-x-1.5 overflow-hidden">
                    {peers.map((peer) => (
                      <div
                        key={peer.userId}
                        style={{ backgroundColor: peer.color }}
                        className="inline-flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold text-white shadow-xs ring-1 ring-white"
                        title={peer.name}
                      >
                        {peer.name.slice(0, 2).toUpperCase()}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
            {page.data.builtFrom?.problem && (
              <div className="truncate text-[11px] text-warn-text">
                {page.data.builtFrom.writableFields === 0
                  ? "Nothing on this page is editable here"
                  : "Some of this page is not editable here"}
              </div>
            )}
          </div>
        </div>

        {/* Right / Center Controls: Icon groups + Dropdowns + Publish CTA */}
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {/* Quick Command Palette (Ctrl+K) & Insert Section Buttons */}
          <button
            type="button"
            title="Search page elements & commands (Ctrl+K / Cmd+K)"
            aria-label="Command palette"
            onClick={() => setCommandPaletteOpen(true)}
            className="inline-flex h-8 items-center gap-1.5 rounded-xl border border-line bg-sunken/40 px-2.5 text-xs font-medium text-muted transition hover:border-line-strong hover:bg-sunken hover:text-ink"
          >
            <IconSearch size={13} />
            <span className="hidden md:inline">Search</span>
            <kbd className="rounded border border-line bg-white px-1 py-0.2 font-mono text-[10px] text-muted">
              ⌘K
            </kbd>
          </button>

          {canEdit && !readOnly && (
            <button
              type="button"
              title="Insert a pre-built section (Hero, Features, Pricing, FAQ, CTA…)"
              aria-label="Insert section"
              onClick={() => setSectionLibraryOpen(true)}
              className="inline-flex h-8 items-center gap-1.5 rounded-xl border border-line bg-sunken/40 px-2.5 text-xs font-semibold text-ink transition hover:border-blue hover:bg-sunken"
            >
              <IconPlusSquare size={14} className="text-blue" />
              <span className="hidden sm:inline">Section</span>
            </button>
          )}

          <button
            type="button"
            title="Client Pin-Comments & Revision Checklist"
            aria-label="Revision comments"
            onClick={() => setCommentsModalOpen(true)}
            className="inline-flex h-8 items-center gap-1.5 rounded-xl border border-line bg-sunken/40 px-2.5 text-xs font-semibold text-ink transition hover:border-blue hover:bg-sunken"
          >
            <IconMessageSquare size={14} className="text-blue" />
            <span className="hidden lg:inline">Notes</span>
          </button>

          <button
            type="button"
            title="Generate Printable Client SEO & Website Optimization Report"
            aria-label="Client SEO report"
            onClick={() => setClientReportOpen(true)}
            className="inline-flex h-8 items-center gap-1.5 rounded-xl border border-line bg-sunken/40 px-2.5 text-xs font-semibold text-ink transition hover:border-blue hover:bg-sunken"
          >
            <IconFileText size={14} className="text-blue" />
            <span className="hidden xl:inline">Report</span>
          </button>

          {/* History & Refresh Icon Group */}
          <div className="inline-flex items-center rounded-xl border border-line bg-sunken/30 p-0.5">
            <button
              type="button"
              title="Undo (Ctrl+Z)"
              aria-label="Undo"
              disabled={readOnly || save.isPending || (!historyState.canUndo && !page.data.structure?.canUndo)}
              onClick={() => restore(-1)}
              className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-muted transition enabled:hover:bg-white enabled:hover:text-ink disabled:opacity-30"
            >
              <IconUndo size={14} />
            </button>
            <button
              type="button"
              title="Redo (Ctrl+Shift+Z)"
              aria-label="Redo"
              disabled={readOnly || save.isPending || (!historyState.canRedo && !page.data.structure?.canRedo)}
              onClick={() => restore(1)}
              className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-muted transition enabled:hover:bg-white enabled:hover:text-ink disabled:opacity-30"
            >
              <IconRedo size={14} />
            </button>
            <div className="mx-0.5 h-4 w-px bg-line" aria-hidden="true" />
            <button
              type="button"
              title="Reload page from site"
              aria-label="Reload"
              onClick={() => {
                if (dirty.current) saveNow(edits);
                void qc.invalidateQueries({ queryKey: ["website", "page", pageId] });
                setPreviewToken((token) => token + 1);
              }}
              className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-muted transition hover:bg-white hover:text-ink"
            >
              <IconRefresh size={14} />
            </button>
          </div>

          {/* Viewport Device Switcher (Icons) + Zoom Dropdown */}
          {mode !== "edit" && (
            <div className="inline-flex items-center gap-1 rounded-xl border border-line bg-sunken/30 p-0.5">
              {DEVICES.map((option) => {
                const active = device === option.key;
                const DeviceIcon =
                  option.key === "desktop"
                    ? IconDesktop
                    : option.key === "tablet"
                      ? IconTablet
                      : IconPhoneDevice;
                return (
                  <button
                    key={option.key}
                    type="button"
                    title={`${option.label} viewport`}
                    aria-label={option.label}
                    aria-pressed={active}
                    onClick={() => setDevice(option.key)}
                    className={`inline-flex h-7 w-7 items-center justify-center rounded-lg transition ${
                      active
                        ? "bg-ink text-cream shadow-xs"
                        : "text-muted hover:bg-white hover:text-ink"
                    }`}
                  >
                    <DeviceIcon size={14} />
                  </button>
                );
              })}
              <div className="mx-0.5 h-4 w-px bg-line" aria-hidden="true" />
              <select
                aria-label="Canvas zoom"
                title="Canvas zoom level"
                value={zoom}
                onChange={(e) => setZoom(Number(e.target.value))}
                className="h-7 cursor-pointer rounded-lg border-0 bg-transparent px-1.5 font-mono text-[11px] font-medium text-ink outline-none hover:bg-white"
              >
                {[0.5, 0.75, 1, 1.25, 1.5].map((value) => (
                  <option key={value} value={value}>
                    {value * 100}%
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Editor View Mode Dropdown (Visual / List / Preview) */}
          <details
            className="relative"
            data-editor-menu
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.currentTarget.open = false;
                event.stopPropagation();
              }
            }}
          >
            <summary
              title="Switch editor view mode"
              aria-label="Editor view mode"
              className="inline-flex h-8 cursor-pointer list-none items-center gap-1.5 rounded-xl border border-line bg-sunken/40 px-2.5 text-xs font-semibold text-ink transition hover:border-line-strong hover:bg-sunken"
            >
              {mode === "visual" ? (
                <IconLayout size={14} />
              ) : mode === "edit" ? (
                <IconList size={14} />
              ) : (
                <IconEye size={14} />
              )}
              <span>{MODES.find((m) => m.key === mode)?.label ?? "Visual"}</span>
              <IconChevronDown size={12} className="text-muted" />
            </summary>
            <div className="absolute right-0 top-full z-50 mt-1.5 flex w-48 flex-col gap-0.5 rounded-xl border border-line bg-white p-1.5 shadow-xl">
              <div className="px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-muted">
                Editor Mode
              </div>
              {MODES.map((option) => {
                const active = mode === option.key;
                const ModeIcon =
                  option.key === "visual"
                    ? IconLayout
                    : option.key === "edit"
                      ? IconList
                      : IconEye;
                const subtitle =
                  option.key === "visual"
                    ? "Interactive canvas"
                    : option.key === "edit"
                      ? "Structured fields"
                      : "Live page preview";
                return (
                  <button
                    key={option.key}
                    type="button"
                    onClick={(event) => {
                      if (option.key !== "edit" && dirty.current) saveNow(edits);
                      setPreviewToken((token) => token + 1);
                      setMode(option.key);
                      const details = event.currentTarget.closest("details");
                      if (details) details.open = false;
                    }}
                    className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition ${
                      active
                        ? "bg-sunken font-semibold text-ink"
                        : "text-muted hover:bg-sunken/60 hover:text-ink"
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <ModeIcon size={14} />
                      <span>
                        <span className="block leading-tight text-ink">{option.label}</span>
                        <span className="block text-[10px] font-normal text-muted">{subtitle}</span>
                      </span>
                    </span>
                    {active && <IconCheck size={13} className="text-blue" />}
                  </button>
                );
              })}
            </div>
          </details>

          {/* Workspace Panels & Quick Actions Icon Group */}
          <div className="inline-flex items-center rounded-xl border border-line bg-sunken/30 p-0.5">
            <button
              type="button"
              title="Toggle Inspector panel"
              aria-label="Inspector"
              aria-pressed={showPanel}
              onClick={() => setShowPanel((value) => !value)}
              className={`inline-flex h-7 w-7 items-center justify-center rounded-lg transition ${
                showPanel
                  ? "bg-ink text-cream shadow-xs"
                  : "text-muted hover:bg-white hover:text-ink"
              }`}
            >
              <IconSidebar size={14} />
            </button>
            <button
              type="button"
              title="Toggle Layers tree"
              aria-label="Layers"
              aria-pressed={showLayers}
              onClick={() => {
                setShowLayers((value) => !value);
                setShowPanel(true);
                setMode("visual");
              }}
              className={`inline-flex h-7 w-7 items-center justify-center rounded-lg transition ${
                showLayers
                  ? "bg-ink text-cream shadow-xs"
                  : "text-muted hover:bg-white hover:text-ink"
              }`}
            >
              <IconLayers size={14} />
            </button>
            {canEdit && design.data?.options.aiEnabled && (
              <button
                type="button"
                title="Open AI Assistant"
                aria-label="Assistant"
                onClick={() => setShowAI(true)}
                className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-muted transition hover:bg-white hover:text-ink"
              >
                <IconSparkles size={14} />
              </button>
            )}
            {canEdit && (
              <>
                <div className="mx-0.5 h-4 w-px bg-line" aria-hidden="true" />
                <button
                  type="button"
                  title="Save draft (Ctrl/Cmd+S)"
                  aria-label="Save"
                  disabled={save.isPending || readOnly}
                  onClick={() => saveNow(latestEdits.current)}
                  className={`inline-flex h-7 items-center gap-1 rounded-lg px-2 text-xs font-medium transition disabled:opacity-40 ${
                    dirty.current || changedCount > 0
                      ? "bg-white text-ink shadow-2xs hover:text-blue"
                      : "text-muted hover:bg-white hover:text-ink"
                  }`}
                >
                  <IconSave size={13} />
                  <span className="hidden xl:inline">Save</span>
                </button>
              </>
            )}
          </div>

          {/* More Tools & Settings Dropdown */}
          <details
            className="relative"
            data-editor-menu
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.currentTarget.open = false;
                event.stopPropagation();
              }
            }}
          >
            <summary
              title="More tools, Guide, Version history & settings"
              aria-label="More"
              className="inline-flex h-8 w-8 cursor-pointer list-none items-center justify-center rounded-xl border border-line bg-sunken/40 text-muted transition hover:border-line-strong hover:bg-sunken hover:text-ink"
            >
              <IconMoreHorizontal size={15} />
            </summary>
            <div className="absolute right-0 top-full z-50 mt-1.5 flex w-60 flex-col gap-1 rounded-xl border border-line bg-white p-2 shadow-xl">
              <div className="px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-muted">
                Tools & Documentation
              </div>
              <button
                type="button"
                onClick={(event) => {
                  setGuideModalOpen(true);
                  const details = event.currentTarget.closest("details");
                  if (details) details.open = false;
                }}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-xs text-ink transition hover:bg-sunken"
              >
                <IconBookOpen size={14} className="text-muted" />
                <span>Interactive Guide & Docs</span>
              </button>
              <button
                type="button"
                onClick={(event) => {
                  setShowGuide(true);
                  const details = event.currentTarget.closest("details");
                  if (details) details.open = false;
                }}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-xs text-ink transition hover:bg-sunken"
              >
                <IconSparkles size={14} className="text-muted" />
                <span>First edit walkthrough</span>
              </button>
              <button
                type="button"
                disabled={save.isPending || publish.isPending || structureBusy}
                onClick={async (event) => {
                  const details = event.currentTarget.closest("details");
                  if (details) details.open = false;
                  try {
                    if (dirty.current) await save.mutateAsync(latestEdits.current);
                    if (!dirty.current) setShowVersions(true);
                  } catch {
                    /* Saving reports the failure and preserves local edits. */
                  }
                }}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-xs text-ink transition hover:bg-sunken disabled:opacity-40"
              >
                <IconHistory size={14} className="text-muted" />
                <span>Version history</span>
              </button>
              <a
                href={apiUrl(`/website/pages/${pageId}/export`)}
                download
                onClick={(event) => {
                  if (dirty.current || save.isPending) {
                    event.preventDefault();
                    setFailure("Wait for the current changes to save before downloading.");
                  }
                }}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-xs text-ink transition hover:bg-sunken"
              >
                <IconDownload size={14} className="text-muted" />
                <span>Download HTML</span>
              </a>

              <div className="my-1 h-px bg-line" />
              <div className="px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-muted">
                Preferences
              </div>

              <label className="flex w-full cursor-pointer items-center justify-between gap-2.5 rounded-lg px-2.5 py-1.5 text-xs text-ink transition hover:bg-sunken">
                <span className="flex items-center gap-2.5">
                  <IconSliders size={14} className="text-muted" />
                  <span>Designer controls</span>
                </span>
                <input
                  type="checkbox"
                  checked={designerMode}
                  onChange={(event) => {
                    setDesignerMode(event.target.checked);
                    try {
                      localStorage.setItem(
                        `website-designer:${user?.id}`,
                        event.target.checked ? "yes" : "no"
                      );
                    } catch {
                      /* Optional preference. */
                    }
                  }}
                />
              </label>

              <button
                type="button"
                onClick={() => {
                  const next = editorTheme === "dark" ? "light" : "dark";
                  setEditorTheme(next);
                  try {
                    localStorage.setItem("website-editor-theme", next);
                  } catch {}
                }}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-xs text-ink transition hover:bg-sunken"
              >
                {editorTheme === "dark" ? (
                  <IconSun size={14} className="text-muted" />
                ) : (
                  <IconMoon size={14} className="text-muted" />
                )}
                <span>Use {editorTheme === "dark" ? "light" : "dark"} editor theme</span>
              </button>

              {changedCount > 0 && !readOnly && (
                <>
                  <div className="my-1 h-px bg-line" />
                  <button
                    type="button"
                    disabled={discard.isPending || save.isPending || publish.isPending}
                    onClick={(event) => {
                      const details = event.currentTarget.closest("details");
                      if (details) details.open = false;
                      if (
                        window.confirm(
                          "Discard all unpublished changes on this page? The live website stays unchanged."
                        )
                      ) {
                        discard.mutate();
                      }
                    }}
                    className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-xs text-red-600 transition hover:bg-red-50 disabled:opacity-40"
                  >
                    <IconTrash size={14} />
                    <span>Discard unpublished changes</span>
                  </button>
                </>
              )}

              <div className="mt-1 rounded-lg bg-sunken/60 px-2.5 py-1.5 text-[10px] leading-relaxed text-muted">
                Shortcuts: Ctrl/Cmd+S save · Z undo · Shift+Z redo · Enter publish
              </div>
            </div>
          </details>

          {(demoIdFromUrl || page.data.readFrom === "imported file" || /\/demos\/[^/?#]+/i.test(site.publicUrl)) && (
            <>
              <a
                href={site.publicUrl}
                target="_blank"
                rel="noreferrer"
                title="Open the live public demo URL in a new tab"
                className="inline-flex h-8 items-center gap-1.5 rounded-xl border border-line bg-sunken/40 px-2.5 text-xs font-semibold text-ink transition hover:border-blue hover:bg-sunken"
              >
                <IconEye size={13} className="text-blue" />
                <span className="hidden sm:inline">Live Demo</span>
              </a>
              {demoIdFromUrl && (
                <a
                  href={`/api/demos/${demoIdFromUrl}/download`}
                  download={`${page.data.page.filePath || "demo.html"}`}
                  title="Download updated .html file"
                  className="inline-flex h-8 items-center gap-1.5 rounded-xl border border-line bg-sunken/40 px-2.5 text-xs font-semibold text-ink transition hover:border-blue hover:bg-sunken"
                >
                  <IconDownload size={13} className="text-blue" />
                  <span>Download .html</span>
                </a>
              )}
            </>
          )}

          {/* Primary Publish CTA */}
          {canPublish && (
            <Button
              variant="accent"
              size="sm"
              onClick={async () => {
                const isDemoPage =
                  Boolean(demoIdFromUrl) ||
                  page.data.readFrom === "imported file" ||
                  /\/demos\/[^/?#]+/i.test(site.publicUrl);
                try {
                  if (dirty.current) await save.mutateAsync(latestEdits.current);
                  if (dirty.current) {
                    setFailure("Your latest edit is still saving. Review once it has saved.");
                    return;
                  }
                  if (isDemoPage) {
                    publish.mutate({
                      revision: revision.current,
                      sourceHash: "",
                      mode: "direct",
                      prTitle: "",
                    } as unknown as WebsiteReview);
                    return;
                  }
                  setReviewOpen(true);
                } catch {
                  /* The save error is displayed by its mutation. */
                }
              }}
              disabled={
                publish.isPending ||
                save.isPending ||
                (!(Boolean(demoIdFromUrl) || page.data.readFrom === "imported file" || /\/demos\/[^/?#]+/i.test(site.publicUrl)) &&
                  (changedCount === 0 || !site.repo))
              }
            >
              <span className="inline-flex items-center gap-1.5">
                <IconUploadCloud size={14} />
                <span>
                  {publish.isPending
                    ? "Publishing…"
                    : Boolean(demoIdFromUrl) || page.data.readFrom === "imported file" || /\/demos\/[^/?#]+/i.test(site.publicUrl)
                      ? changedCount > 0
                        ? `Publish & Update Demo (${changedCount})`
                        : "Publish & Update Demo"
                      : changedCount > 0
                        ? `Publish (${changedCount})`
                        : "Publish"}
                </span>
              </span>
            </Button>
          )}
        </div>
      </div>

      {(published || failure) && (
        <div className="flex-none border-b border-line px-4 py-3">
          {published && (
            <div className="rounded-xl border border-line bg-white p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-semibold text-ink">
                  {Boolean(demoIdFromUrl) || page.data.readFrom === "imported file" || /\/demos\/[^/?#]+/i.test(site.publicUrl)
                    ? `Demo HTML updated (version ${published.version}) — refresh the live demo URL to see your new changes!`
                    : `Changes sent — version ${published.version}, ${published.changed} change${published.changed === 1 ? "" : "s"}.`}
                </p>
                {(Boolean(demoIdFromUrl) || page.data.readFrom === "imported file" || /\/demos\/[^/?#]+/i.test(site.publicUrl)) && (
                  <div className="flex flex-wrap items-center gap-2">
                    <a
                      href={site.publicUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 rounded-lg border border-blue/30 bg-blue/10 px-2.5 py-1 text-xs font-semibold text-blue hover:bg-blue/15"
                    >
                      <IconEye size={12} />
                      <span>Open Live Demo</span>
                    </a>
                    {demoIdFromUrl && (
                      <a
                        href={`/api/demos/${demoIdFromUrl}/download`}
                        download={`${page.data.page.filePath || "demo.html"}`}
                        className="inline-flex items-center gap-1 rounded-lg border border-line bg-sunken px-2.5 py-1 text-xs font-semibold text-ink hover:bg-line/50"
                      >
                        <IconDownload size={12} />
                        <span>Download .html</span>
                      </a>
                    )}
                  </div>
                )}
              </div>
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
              {/* A commit is not a deployment, and until this says so the only
                  honest claim is that the change is in the repository. */}
              {published.job && <PublishStatus siteId={site.id} jobId={published.job.id} />}
              <p className="mt-1 text-xs text-muted">
                This screen reads the page back from the published site, so it goes on showing the old words until that rebuild
                finishes. It will catch up on its own; the circular arrow in the bar looks again now.
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-4 text-xs">
                {published.prUrl ? (
                  <a href={published.prUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-semibold text-blue underline-offset-2 hover:underline">
                     View Pull Request #{published.prNumber} on GitHub
                  </a>
                ) : (
                  <a href={published.url} target="_blank" rel="noreferrer" className="text-ink underline-offset-2 hover:underline">
                    Open the live page
                  </a>
                )}
                <a href={published.commit.url} target="_blank" rel="noreferrer" className="text-muted underline-offset-2 hover:underline">
                  {published.mode === "pull_request" ? "See PR commit" : "See the commit"}
                </a>
              </div>
            </div>
          )}
          {failure && <div className="rounded-xl border border-warn-line bg-warn-surface px-3.5 py-2.5 text-sm text-warn-text">{failure}</div>}
        </div>
      )}

      {/* ---------------------------------------------------------- body */}
      <div className="flex min-h-0 flex-1">
        {mode === "visual" && showPanel && (
          <aside aria-label="Element inspector" className="editor-sidebar flex flex-none flex-col border-r border-line bg-white">
            {/* What is selected, said once, at the top. The tag is a chip rather
                than a line of its own: it is the one piece of jargon on this
                panel and it should look like a label on a thing, not like a
                heading with the same weight as the thing's name. */}
            <div className="flex flex-none items-center gap-2 border-b border-line px-3 py-2.5">
              <span className="shrink-0 rounded-[10px] bg-sunken px-1.5 py-0.5 font-sans text-xs uppercase tracking-[.06em] text-muted">
                {picked ? picked.tag : "—"}
              </span>
              <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-ink">{picked ? picked.label : "Nothing selected"}</span>
              {picked && (
                <button
                  type="button"
                  onClick={() => pick(null)}
                  aria-label="Clear the selection"
                  title="Clear the selection"
                  className="flex min-h-8 px-2.5 shrink-0 items-center justify-center rounded-[10px] text-muted transition hover:bg-sunken hover:text-ink"
                >Clear
                </button>
              )}
            </div>

            {/* One fact, said once, before the clicking starts. A page whose every
                field is locked used to explain itself three hundred times over,
                a field at a time, and only to somebody who had already selected
                one and found it would not take a word. */}
            {page.data.builtFrom?.problem && (
              <p role="alert" className="flex-none border-b border-line bg-warn-surface px-4 py-2 text-xs leading-relaxed text-warn-text">
                {page.data.builtFrom.problem}
              </p>
            )}

            {liveBlind && (
              <p className="flex-none border-b border-line bg-warn-surface px-4 py-2 text-xs leading-relaxed text-warn-text">
                The page beside this is not keeping up as you type. Your changes are being saved — it will catch up a moment
                after each one.
              </p>
            )}

            <WebsiteBreadcrumbs fields={allFields} selectedId={pickedId} onSelect={pick} />
            {page.data.structure?.stale && <p role="alert" className="bg-warn-surface px-3 py-2 text-xs text-warn-text">The source changed after these layout edits. Your draft is preserved. Discard it to work from the latest source; publishing is blocked.</p>}
            {showLayers && <div className="editor-layers"><WebsiteLayers fields={allFields} edits={edits} problems={problems} shared={page.data.shared?.scope} selectedId={pickedId} onSelect={pick} onMove={!designerMode || readOnly || save.isPending ? undefined : (id, target, position) => { void runStructure(position, id, target); }} /></div>}
            {designerMode && picked && <div className="border-b border-line px-3 py-2">
              <div className="flex flex-wrap gap-2 text-xs">
                <button type="button" className="text-blue disabled:text-faint" disabled={readOnly || save.isPending || !picked.structure?.previousId} onClick={() => void runStructure("before", picked.id, picked.structure?.previousId)}>Move up</button>
                <button type="button" className="text-blue disabled:text-faint" disabled={readOnly || save.isPending || !picked.structure?.nextId} onClick={() => void runStructure("after", picked.id, picked.structure?.nextId)}>Move down</button>
                <button type="button" className="text-blue disabled:text-faint" title={picked.structure?.duplicateReason} disabled={readOnly || save.isPending || !picked.structure?.duplicate} onClick={() => void runStructure("duplicate", picked.id)}>Duplicate</button>
                {(picked.repeatable || picked.structure?.repeatable) && (
                  <button type="button" className="font-semibold text-blue disabled:text-faint" title={picked.structure?.duplicateReason ?? "Add a new item to this repeatable list"} disabled={readOnly || save.isPending || !picked.structure?.duplicate} onClick={() => void runStructure("duplicate", picked.id)}>+ Add Item</button>
                )}
                <button type="button" className="text-danger-text disabled:text-faint" disabled={readOnly || save.isPending || !picked.structure?.remove} onClick={() => void runStructure("remove", picked.id)}>Remove</button>
              </div>
              <p className="mt-2 text-xs text-muted">{picked.structure?.reason || picked.structure?.duplicateReason || "Drag layers to reorder within their container. Changes stay in the draft; Undo brings them back."}</p>
            </div>}

            <div role="tablist" aria-label="Element settings" className="editor-tabs">
              {(!picked ? (["content", "seo"] as const) : (["content", "style", "interactions"] as const)).map(tab => (
                <button
                  type="button"
                  role="tab"
                  aria-selected={inspectorTab === tab}
                  key={tab}
                  onClick={() => setInspectorTab(tab)}
                >
                  {tab === "seo" ? "SEO" : tab[0].toUpperCase() + tab.slice(1)}
                </button>
              ))}
            </div>
            <div className="editor-controls min-h-0 flex-1 overflow-y-auto">
              {!picked ? (
                inspectorTab === "seo" ? (
                  <WebsitePageSeoInspector
                    siteId={site.id}
                    pageId={pageId}
                    pageTitle={page.data.page.title}
                    pagePath={page.data.page.path}
                    readOnly={readOnly}
                    imageFields={allFields
                      .filter((f) => f.kind === "image")
                      .map((f) => ({
                        id: f.id,
                        label: f.label,
                        src: edits[f.id]?.value ?? f.value ?? "",
                        alt: edits[f.id]?.alt ?? f.alt ?? "",
                      }))}
                    onApplyAltFixes={(fixes) => {
                      setEdits((prev) => {
                        const next = { ...prev };
                        for (const fix of fixes) {
                          const existing = next[fix.id] ?? {};
                          const field = allFields.find((f) => f.id === fix.id);
                          next[fix.id] = {
                            ...existing,
                            value: existing.value ?? field?.value ?? "",
                            alt: fix.alt,
                          };
                        }
                        saveNow(next);
                        return next;
                      });
                      showQuickToast(`Applied SEO alt text to ${fixes.length} image${fixes.length === 1 ? "" : "s"}.`);
                    }}
                    onDraftUpdated={() => {
                      dirty.current = false;
                      setPreviewToken((token) => token + 1);
                    }}
                    onOpenClientReport={() => setClientReportOpen(true)}
                  />
                ) : (
                  <div className="px-4 py-5 text-center">
                    <p className="text-[12px] font-semibold text-ink">Click anything on the page</p>
                    <p className="mt-1 text-xs leading-relaxed text-muted">
                      Its words, style, and interactions appear here. Double click to type straight into the page.
                    </p>
                    <p className="mt-2 text-xs text-muted">
                      {allFields.length} editable {allFields.length === 1 ? "thing" : "things"} on this page.
                    </p>

                    {pageColorTokens.length > 0 && (
                      <div className="mt-4 rounded-xl border border-line bg-surface-2/60 p-3 text-left">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[11px] font-bold uppercase tracking-[.06em] text-ink">
                            Page Colors &amp; Theme
                          </span>
                          <span className="text-[10px] text-muted">{pageColorTokens.length} colors</span>
                        </div>
                        <p className="mt-0.5 text-[11px] text-muted">
                          Click any color picker or edit its #HEX code to update that color across the page live.
                        </p>
                        <div className="mt-2.5 space-y-1.5 max-h-[280px] overflow-y-auto pr-0.5">
                          {pageColorTokens.map((token) => (
                            <div key={token.key} className="flex items-center justify-between gap-2 rounded-lg border border-line bg-white px-2.5 py-1.5">
                              <span className="min-w-0 flex-1 truncate font-mono text-[11px] font-medium text-ink" title={token.label}>
                                {token.label}
                              </span>
                              <ColorCodeInput
                                label={token.label}
                                value={token.value}
                                disabled={readOnly}
                                onChange={(nextHex) => updatePageColorToken(token.key, nextHex, token.isVar, token.value)}
                              />
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    <div className="mt-4 flex flex-col gap-2 border-t border-line pt-4">
                      {canEdit && !readOnly && (
                        <button
                          type="button"
                          onClick={() => setSectionLibraryOpen(true)}
                          className="inline-flex w-full items-center justify-center gap-1.5 rounded-xl bg-ink px-3 py-2 text-xs font-semibold text-white transition hover:opacity-90"
                        >
                          <IconPlusSquare size={14} />
                          <span>Insert Pre-Built Section</span>
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => setInspectorTab("seo")}
                        className="inline-flex w-full items-center justify-center gap-1.5 rounded-xl border border-line bg-cream px-3 py-2 text-xs font-semibold text-ink transition hover:border-blue hover:text-blue"
                      >
                        <IconSearch size={14} />
                        <span>Edit Page SEO, Schema &amp; Previews</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setCommandPaletteOpen(true)}
                        className="inline-flex w-full items-center justify-center gap-1.5 rounded-xl border border-line bg-white px-3 py-1.5 text-xs font-medium text-muted transition hover:border-line-strong hover:text-ink"
                      >
                        <IconSearch size={13} />
                        <span>Command Search (Ctrl+K)</span>
                      </button>
                    </div>
                  </div>
                )
              ) : (
                <>
                  {/* Before the controls, not beside them: somebody about to
                      change a heading has to know whether they are changing one
                      page or eight, and afterwards is too late. */}
                  {designerMode && !pickedShared && picked.kind === "container" && (
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

                  {/* Which width is being edited, its measured size, and the
                      three actions that belong to the whole element rather than
                      to any one property. One line each: this bar sits above
                      every panel and is not what somebody came to read. */}
                  <div hidden={inspectorTab !== "style"} className="editor-scope-strip border-b border-line px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className={`rounded-[10px] px-1.5 py-0.5 text-xs font-semibold ${device === "desktop" ? "bg-white text-ink" : "bg-blue/10 text-blue"}`}>
                        {device === "desktop" ? "All sizes" : device === "tablet" ? "Tablet and below" : "Phone only"}
                      </span>
                      <span className="font-mono text-xs text-muted">
                        {computed.width || "—"} × {computed.height || "—"}
                      </span>
                    </div>
                    <p className="mt-1.5 text-xs leading-relaxed text-muted">
                      {device === "desktop"
                        ? "Tablet and phone overrides win at smaller widths."
                        : "Only what you change here overrides the larger layout. Reset a value to inherit it again."}
                    </p>
                    {device !== "desktop" && /!\s*important/i.test(edits[picked.id]?.style ?? picked.style ?? "") && (
                      <p className="mt-1.5 text-xs leading-relaxed text-warn-text">
                        This element has a base style marked !important, so that property keeps its base value at every size until you change it
                        under Desktop.
                      </p>
                    )}
                    {designerMode && <div className="mt-2 flex flex-wrap gap-1">
                      <button type="button" onClick={() => setStyleClipboard(pickedStyle)} className="rounded-[10px] bg-white px-2 py-1 text-xs font-semibold text-ink transition hover:text-blue">Copy style</button>
                      <button type="button" disabled={readOnly || styleClipboard === null} onClick={() => changePickedStyle(styleClipboard!, true)} className="rounded-[10px] bg-white px-2 py-1 text-xs font-semibold text-ink transition hover:text-blue disabled:text-faint">Paste</button>
                      {device !== "desktop" && <button type="button" disabled={readOnly || !pickedStyle} onClick={() => changePickedStyle("", true)} className="rounded-[10px] bg-white px-2 py-1 text-xs font-semibold text-ink transition hover:text-blue disabled:text-faint">Clear overrides</button>}
                      <span className="ml-auto self-center text-xs text-faint">{picked.confidence === "annotated" ? "Stable field" : "Discovered"}</span>
                    </div>}
                  </div>

                  {/* One inspector, drawn from what the element is. The frame is
                      what knows that — its display, its parent's, whether it has
                      words of its own — and when the frame cannot be reached the
                      field row is the only thing left to go on. */}
                  {!readOnly && inspectorTab === "style" && <div className="px-3 pt-3"><WebsitePresetPicker presets={design.data?.options.presets ?? []} kind={picked.kind} tag={picked.tag} style={pickedStyle ?? ""} onApply={next => changePickedStyle(next, true)} /></div>}
                  {picked.kind !== "container" && picked.kind !== "image" && !readOnly && <div className="px-3 pt-2"><WebsiteTextFormatting hideWhenEmpty element={pickedElement} onChange={html => { change(picked.id, { ...edits[picked.id], value: html }, { fromFrame: true, commit: true }); setFrameEdit(token => token + 1); }} /></div>}
                  <div hidden={inspectorTab !== "interactions"}><WebsiteInteractionStyles element={pickedElement} style={edits[picked.id]?.style ?? picked.style ?? ""} readOnly={readOnly} onChange={style => change(picked.id, { ...edits[picked.id], style }, { commit: true })} /></div>
                  <div hidden={inspectorTab === "interactions"}><ElementInspector
                    tab={inspectorTab === "style" ? "style" : "content"}
                    simple={!designerMode}
                    onTextColour={colour => !readOnly && formatActiveText({ color: colour })}
                    onPickBackgroundImage={() => {
                      setAssetTargetMode("background");
                      setAssetModalOpen(true);
                    }}
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
                        {picked.kind === "image" && !readOnly && <WebsiteImageFraming siteId={site.id} key={`${picked.id}:${device}:${edits[picked.id]?.value ?? picked.value}`} src={(() => { try { return new URL(edits[picked.id]?.value ?? picked.value, `${site.publicUrl.replace(/\/+$/, "")}/`).toString(); } catch { return ""; } })()} style={pickedStyle ?? ""} onApply={next => changePickedStyle(next, true)} />}

                        {!readOnly && !picked.sourceManaged && picked.tag !== "title" && picked.tag !== "meta" && picked.kind !== "image" && picked.kind !== "container" && (
                          <div className="mb-2 flex justify-end">
                            <button
                              type="button"
                              onClick={() => tell({ type: "edit", id: picked.id })}
                              className="text-xs text-muted underline-offset-2 transition hover:text-blue hover:underline"
                            >
                              {typingId === picked.id ? "Typing on the page" : "Type on the page"}
                            </button>
                          </div>
                        )}
                        {absentIds.has(picked.id) && (
                          <p className="mb-2 rounded-xl bg-cream/70 px-2.5 py-2 text-xs leading-relaxed text-muted">
                            {picked.id.startsWith("meta.")
                              ? "This one is not on the page itself — it is what browsers and search results show. Nothing here will change in the preview."
                              : "This one cannot be shown while you type. It appears in the page once the draft saves."}
                          </p>
                        )}
                        {picked.kind === "image" && !readOnly && (
                          <div className="mb-4">
                            <Button
                              type="button"
                              size="sm"
                              variant="secondary"
                              onClick={() => {
                                setAssetTargetMode("image");
                                setAssetModalOpen(true);
                              }}
                              className="w-full flex items-center justify-center gap-2"
                            >
                               Choose from Asset Library
                            </Button>
                          </div>
                        )}
                        {/* Carousel / Ticker Item-by-Item Editor */}
                        {(() => {
                          const childCarouselField = picked.kind === "container"
                            ? allFields.find((f) => f.parentId === picked.id && (/carousel|ticker|marquee/i.test(f.label) || /<span>\s*[✦•★·]\s*<\/span>/i.test(edits[f.id]?.value ?? f.value ?? "")))
                            : null;
                          const targetField = childCarouselField ?? ((/carousel|ticker|marquee/i.test(picked.label) || /<span>\s*[✦•★·]\s*<\/span>/i.test(edits[picked.id]?.value ?? picked.value ?? "")) && picked.kind !== "container" ? picked : null);
                          if (!targetField || readOnly) return null;
                          const rawVal = edits[targetField.id]?.value ?? targetField.value ?? "";
                          const sepMatch = /(<span[^>]*>\s*[^<]+\s*<\/span>|\s+[✦•★·]\s+)/i.exec(rawVal);
                          const separator = sepMatch?.[1] ?? " <span>✦</span> ";
                          const parts = rawVal
                            .split(/<span[^>]*>\s*[^<]+\s*<\/span>|\s+[✦•★·]\s+/i)
                            .map((s) => s.replace(/<[^>]+>/g, "").trim())
                            .filter(Boolean);
                          if (parts.length < 2 && !/carousel|ticker|marquee/i.test(targetField.label)) return null;
                          const updateCarouselItems = (nextItems: string[]) => {
                            const joined = nextItems.map((item) => item.trim()).filter(Boolean).join(` ${separator.trim()} `);
                            change(targetField.id, { ...edits[targetField.id], value: joined }, { commit: true });
                          };
                          return (
                            <div className="mb-4 rounded-xl border border-blue/25 bg-blue/5 p-3 space-y-2">
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-xs font-semibold text-ink">Carousel / Ticker Items ({parts.length})</span>
                                <button
                                  type="button"
                                  onClick={() => updateCarouselItems([...parts, "NEW ITEM"])}
                                  className="rounded-lg bg-blue px-2 py-0.5 text-[11px] font-semibold text-white transition hover:opacity-90"
                                >
                                  + Add Item
                                </button>
                              </div>
                              <div className="max-h-52 space-y-1.5 overflow-y-auto pr-0.5">
                                {parts.map((item, idx) => (
                                  <div key={idx} className="flex items-center gap-1.5">
                                    <span className="w-5 text-right font-mono text-[10px] text-muted">{idx + 1}.</span>
                                    <input
                                      type="text"
                                      value={item}
                                      onChange={(event) => {
                                        const next = [...parts];
                                        next[idx] = event.target.value;
                                        updateCarouselItems(next);
                                      }}
                                      className="flex-1 rounded-lg border border-line bg-white px-2 py-1 text-xs text-ink outline-none focus:border-blue"
                                    />
                                    {parts.length > 1 && (
                                      <button
                                        type="button"
                                        onClick={() => updateCarouselItems(parts.filter((_, i) => i !== idx))}
                                        className="rounded-lg border border-line bg-white px-2 py-1 text-[11px] text-muted hover:border-red/30 hover:text-red"
                                        title="Remove item"
                                      >
                                        ×
                                      </button>
                                    )}
                                  </div>
                                ))}
                              </div>
                            </div>
                          );
                        })()}
                        {/* Container / Sticky Header / Logo Icon Content & Appearance Quick Editor */}
                        {picked.kind === "container" && !readOnly && (() => {
                          const styleMap = parseStyle(pickedStyle ?? "");
                          const rawBg = styleMap["background-image"] ?? styleMap.background ?? computed["background-image"] ?? "";
                          const bgUrlMatch = /url\(\s*['"]?([^'")]+)['"]?\s*\)/i.exec(rawBg);
                          const bgUrl = bgUrlMatch?.[1] ?? "";
                          const posVal = (styleMap.position ?? computed.position ?? "static").trim();
                          const bgCol = styleMap["background-color"] ?? computed["background-color"] ?? "";
                          const txtCol = styleMap.color ?? computed.color ?? "";
                          const childFields = allFields.filter((f) => f.parentId === picked.id);
                          const updateProp = (prop: string, val: string) => {
                            const nextMap = { ...styleMap };
                            if (val) nextMap[prop] = val;
                            else delete nextMap[prop];
                            changePickedStyle(writeStyle(nextMap), true);
                          };
                          return (
                            <div className="mb-3 space-y-3">
                              {/* Sticky Header / Position Quick Switch */}
                              {(picked.tag === "header" || picked.tag === "nav" || /header|nav|sticky|manifesto/i.test(picked.label) || posVal === "sticky" || posVal === "fixed") && (
                                <div className="rounded-xl border border-line bg-surface-2/60 p-3 space-y-2">
                                  <div className="flex items-center justify-between gap-2">
                                    <span className="text-xs font-semibold text-ink">Sticky / Fixed Header Behavior</span>
                                    <span className="rounded bg-white px-1.5 py-0.5 font-mono text-[10px] uppercase text-muted">{posVal}</span>
                                  </div>
                                  <div className="grid grid-cols-3 gap-1">
                                    {(["sticky", "fixed", "relative"] as const).map((modePos) => (
                                      <button
                                        key={modePos}
                                        type="button"
                                        onClick={() => {
                                          const nextMap: Record<string, string> = { ...styleMap, position: modePos };
                                          if ((modePos === "sticky" || modePos === "fixed") && !nextMap.top) nextMap.top = "0px";
                                          if ((modePos === "sticky" || modePos === "fixed") && !nextMap["z-index"]) nextMap["z-index"] = "1000";
                                          changePickedStyle(writeStyle(nextMap), true);
                                        }}
                                        className={`rounded-lg border py-1 text-[11px] font-semibold capitalize transition ${
                                          posVal === modePos ? "border-blue bg-blue text-white" : "border-line bg-white text-ink hover:border-blue"
                                        }`}
                                      >
                                        {modePos}
                                      </button>
                                    ))}
                                  </div>
                                  {(posVal === "sticky" || posVal === "fixed") && (
                                    <div className="flex items-center justify-between gap-2 pt-1">
                                      <span className="text-[11px] text-muted">Top Offset</span>
                                      <input
                                        type="text"
                                        value={styleMap.top ?? computed.top ?? "0px"}
                                        onChange={(e) => updateProp("top", e.target.value)}
                                        className="w-24 rounded-lg border border-line bg-white px-2 py-1 text-right font-mono text-[11px] text-ink"
                                      />
                                    </div>
                                  )}
                                </div>
                              )}

                              {/* Background / Logo Icon Image Quick Control */}
                              <div className="rounded-xl border border-line bg-surface-2/60 p-3 space-y-2">
                                <div className="flex items-center justify-between gap-2">
                                  <span className="text-xs font-semibold text-ink">
                                    {/logo|icon|brand-face/i.test(picked.label) ? "Logo Icon / Graphic Image" : "Background Image"}
                                  </span>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setAssetTargetMode("background");
                                      setAssetModalOpen(true);
                                    }}
                                    className="rounded-lg bg-blue px-2.5 py-1 text-[11px] font-semibold text-white transition hover:opacity-90"
                                  >
                                    Choose / Upload Image
                                  </button>
                                </div>
                                {bgUrl && (
                                  <div
                                    className="h-20 w-full rounded-lg border border-line bg-cover bg-center"
                                    style={{ backgroundImage: `url("${bgUrl.replace(/"/g, "")}")` }}
                                  />
                                )}
                                <div className="flex items-center gap-1.5">
                                  <input
                                    type="text"
                                    placeholder="Paste image URL (/assets/... or https://...)"
                                    value={bgUrl}
                                    onChange={(e) => {
                                      const v = e.target.value.trim();
                                      const nextMap = { ...styleMap };
                                      if (!v) {
                                        delete nextMap["background-image"];
                                      } else {
                                        nextMap["background-image"] = `url('${v.replace(/['"\\]/g, "")}')`;
                                        if (!nextMap["background-size"]) nextMap["background-size"] = "cover";
                                        if (!nextMap["background-position"]) nextMap["background-position"] = "center";
                                      }
                                      changePickedStyle(writeStyle(nextMap), true);
                                    }}
                                    className="flex-1 rounded-lg border border-line bg-white px-2 py-1 font-mono text-[11px] text-ink outline-none focus:border-blue"
                                  />
                                  {bgUrl && (
                                    <button
                                      type="button"
                                      onClick={() => updateProp("background-image", "none")}
                                      className="rounded-lg border border-line bg-white px-2 py-1 text-[11px] text-muted hover:text-red"
                                    >
                                      Clear
                                    </button>
                                  )}
                                </div>
                              </div>

                              {/* Quick Color Pickers + #HEXCODE */}
                              <div className="rounded-xl border border-line bg-surface-2/60 p-3 space-y-2">
                                <span className="block text-xs font-semibold text-ink">Colors (Color Picker + #HEX)</span>
                                <div className="flex items-center justify-between gap-2">
                                  <span className="text-[11px] text-muted">Background Color</span>
                                  <ColorCodeInput
                                    label="Background color"
                                    value={toHex(bgCol) ?? bgCol}
                                    onChange={(nextHex) => updateProp("background-color", nextHex)}
                                  />
                                </div>
                                <div className="flex items-center justify-between gap-2">
                                  <span className="text-[11px] text-muted">Text / Icon Color</span>
                                  <ColorCodeInput
                                    label="Text or icon color"
                                    value={toHex(txtCol) ?? txtCol}
                                    onChange={(nextHex) => updateProp("color", nextHex)}
                                  />
                                </div>
                              </div>

                              {/* Child Elements inside this Container */}
                              {childFields.length > 0 && (
                                <div className="rounded-xl border border-line bg-surface-2/60 p-3 space-y-1.5">
                                  <span className="block text-xs font-semibold text-ink">
                                    Elements Inside {picked.label} ({childFields.length})
                                  </span>
                                  <div className="max-h-40 space-y-1 overflow-y-auto">
                                    {childFields.map((cf) => (
                                      <button
                                        key={cf.id}
                                        type="button"
                                        onClick={() => pick(cf.id)}
                                        className="flex w-full items-center justify-between gap-2 rounded-lg border border-line bg-white px-2.5 py-1.5 text-left text-xs text-ink transition hover:border-blue hover:text-blue"
                                      >
                                        <span className="truncate font-medium">{cf.label}: {cf.preview || cf.tag}</span>
                                        <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] uppercase text-muted">{cf.tag}</span>
                                      </button>
                                    ))}
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })()}
                        {(() => {
                          const repeatableTarget = (picked.repeatable || picked.structure?.repeatable)
                            ? picked
                            : allFields.find((f) => f.id === picked.parentId && (f.repeatable || f.structure?.repeatable));
                          if (!repeatableTarget || readOnly) return null;
                          return (
                            <div className="mb-4 rounded-[10px] border border-blue/20 bg-blue/5 p-3">
                              <div className="flex items-center justify-between gap-2">
                                <div>
                                  <div className="text-xs font-semibold text-ink flex items-center gap-1.5">
                                     Repeatable Collection
                                  </div>
                                  <div className="text-[11px] text-muted">
                                    {repeatableTarget.id === picked.id ? "Add another item to this collection." : `Add another item to this list.`}
                                  </div>
                                </div>
                                <Button
                                  type="button"
                                  size="sm"
                                  disabled={save.isPending || !repeatableTarget.structure?.duplicate}
                                  title={repeatableTarget.structure?.duplicateReason ?? "Add a new item to this repeatable list"}
                                  onClick={() => void runStructure("duplicate", repeatableTarget.id)}
                                  className="flex items-center gap-1 shrink-0"
                                >
                                  <span>+</span> Add Item
                                </Button>
                              </div>
                            </div>
                          );
                        })()}
                        <FieldRow
                          key={`${loadToken}:${frameEdit}:${picked.id}`}
                          field={picked}
                          edit={edits[picked.id]}
                          problem={problems.get(picked.id)}
                          publicUrl={site.publicUrl}
                          links={links ?? []}
                          readOnly={readOnly}
                          onChange={(next) => change(picked.id, next)}
                          onNameFields={() => void nameFields()}
                          naming={naming}
                          bare
                        />
                      </>
                    }
                  /></div>
                </>
              )}
            </div>
          </aside>
        )}

        {mode === "edit" ? (
          <>
            <aside className="w-[240px] flex-none overflow-y-auto border-r border-line bg-white p-3">
              <div className="mb-2 px-1 font-sans text-xs font-bold uppercase tracking-[.06em] text-muted">Sections</div>
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
                        <span className={`shrink-0 text-xs ${candidate.id === section?.id ? "text-cream/60" : "text-muted"}`}>
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
                        onNameFields={() => void nameFields()}
                        naming={naming}
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

      {contextToast && (
        <div className="fixed bottom-6 left-1/2 z-[120] -translate-x-1/2 rounded-xl border border-line bg-ink px-4 py-2 text-xs font-semibold text-white shadow-lg">
          {contextToast}
        </div>
      )}

      {contextMenu && (() => {
        const ctxField = contextMenu.fieldId ? allFields.find((f) => f.id === contextMenu.fieldId) ?? null : null;
        const rawTag = (ctxField?.tag || contextMenu.tag || "page").toLowerCase();
        const isHeading = /^h[1-6]$/.test(rawTag);
        const currentText = (
          (ctxField ? (edits[ctxField.id]?.value ?? ctxField.value) : contextMenu.text) ||
          contextMenu.text ||
          ""
        )
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        const currentStyle = ctxField ? (edits[ctxField.id]?.style ?? ctxField.style ?? "") : "";
        const isCurrentlyHidden = /(?:^|;)\s*display\s*:\s*none\b/i.test(currentStyle);
        const hiddenCount = Object.values(edits).filter((e) => /(?:^|;)\s*display\s*:\s*none\b/i.test(e.style ?? "")).length;

        const toggleHideField = (targetField: SiteFieldRow) => {
          const base = edits[targetField.id]?.style ?? targetField.style ?? "";
          let nextStyle: string;
          if (/(?:^|;)\s*display\s*:\s*none\b/i.test(base)) {
            nextStyle = base
              .split(";")
              .map((s) => s.trim())
              .filter((s) => s && !/^display\s*:\s*none$/i.test(s))
              .join("; ");
            showQuickToast(`Restored ${isHeading ? "heading" : targetField.label}`);
          } else {
            nextStyle = [base.trim().replace(/;$/, ""), "display: none"].filter(Boolean).join("; ");
            showQuickToast(`Hidden ${isHeading ? "heading" : targetField.label} to preview layout (Right-click or Ctrl+Z to restore)`);
          }
          change(targetField.id, { ...edits[targetField.id], style: nextStyle }, { commit: true });
          setContextMenu(null);
        };

        const applyQuickSeoFromText = async (modeType: "title" | "description" | "tags") => {
          if (!currentText || !site?.id) return;
          setContextMenu(null);
          try {
            if (modeType === "title") {
              await api.post(`/website/sites/${site.id}/seo/page`, {
                pageId,
                title: currentText.slice(0, 70),
                publishNow: false,
              });
              showQuickToast(`Set "${currentText.slice(0, 42)}" as Page SEO Title`);
            } else if (modeType === "description") {
              await api.post(`/website/sites/${site.id}/seo/page`, {
                pageId,
                description: currentText.slice(0, 160),
                publishNow: false,
              });
              showQuickToast("Set text as Page Meta Description");
            } else {
              const extractedTags = currentText
                .toLowerCase()
                .replace(/[^a-z0-9\s-]/g, " ")
                .split(/\s+/)
                .filter((w) => w.length >= 3)
                .slice(0, 8);
              await api.post(`/website/sites/${site.id}/seo/page`, {
                pageId,
                keywords: extractedTags.join(", "),
                tags: extractedTags,
                publishNow: false,
              });
              showQuickToast(`Added "${extractedTags.join(", ")}" to Page SEO Tags`);
            }
            void qc.invalidateQueries({ queryKey: ["website", "seo", site.id] });
            void qc.invalidateQueries({ queryKey: ["website", "page", pageId] });
            pick(null);
            setShowPanel(true);
            setInspectorTab("seo");
          } catch {
            showQuickToast("Could not update SEO property.");
          }
        };

        return (
          <div
            role="menu"
            aria-label="Visual editor context menu"
            style={{ top: contextMenu.y, left: contextMenu.x }}
            onClick={(e) => e.stopPropagation()}
            className="fixed z-[110] w-64 rounded-2xl border border-line bg-white p-1.5 text-xs shadow-2xl"
          >
            {/* Header Badge */}
            <div className="flex items-center gap-2 border-b border-line px-2.5 py-2">
              <span className="rounded-md bg-ink px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase text-white">
                {rawTag}
              </span>
              <span className="truncate font-semibold text-ink">
                {ctxField ? ctxField.label : "Page Canvas"}
              </span>
            </div>

            {ctxField && (
              <div className="py-1">
                {/* 1. Edit Heading / Element */}
                {!readOnly && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setShowPanel(true);
                      setInspectorTab("content");
                      if (ctxField.kind !== "image" && ctxField.kind !== "container") {
                        tell({ type: "edit", id: ctxField.id });
                      }
                      setContextMenu(null);
                    }}
                    className="flex w-full items-center justify-between rounded-xl px-2.5 py-1.5 text-left font-medium text-ink hover:bg-cream"
                  >
                    <span className="inline-flex items-center gap-2">
                      <IconEdit />
                      <span>{isHeading ? "Edit Heading" : `Edit ${ctxField.label}`}</span>
                    </span>
                    <span className="text-[10px] text-muted">Dbl-Click</span>
                  </button>
                )}

                {/* 2. Copy Heading / Text */}
                {currentText && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setTextClipboard(currentText);
                      void navigator.clipboard?.writeText(currentText).catch(() => {});
                      showQuickToast(`Copied ${isHeading ? "heading" : "text"}: "${currentText.slice(0, 32)}${currentText.length > 32 ? "…" : ""}"`);
                      setContextMenu(null);
                    }}
                    className="flex w-full items-center justify-between rounded-xl px-2.5 py-1.5 text-left text-ink hover:bg-cream"
                  >
                    <span className="inline-flex items-center gap-2">
                      <IconCopy />
                      <span>{isHeading ? "Copy Heading" : "Copy Text"}</span>
                    </span>
                    <span className="text-[10px] text-muted">Ctrl+C</span>
                  </button>
                )}

                {/* 3. Paste Text into Heading / Element */}
                {!readOnly && ctxField.kind !== "image" && ctxField.kind !== "container" && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={async () => {
                      let clip = textClipboard;
                      if (!clip && navigator.clipboard?.readText) {
                        try {
                          clip = await navigator.clipboard.readText();
                        } catch {
                          clip = null;
                        }
                      }
                      if (clip && clip.trim()) {
                        change(ctxField.id, { ...edits[ctxField.id], value: clip.trim() }, { commit: true });
                        showQuickToast(`Pasted into ${isHeading ? "heading" : ctxField.label}`);
                      } else {
                        showQuickToast("Copy a heading or text first to paste.");
                      }
                      setContextMenu(null);
                    }}
                    className="flex w-full items-center justify-between rounded-xl px-2.5 py-1.5 text-left text-ink hover:bg-cream"
                  >
                    <span className="inline-flex items-center gap-2">
                      <IconPaste />
                      <span>{isHeading ? "Paste into Heading" : "Paste Text"}</span>
                    </span>
                    <span className="text-[10px] text-muted">Ctrl+V</span>
                  </button>
                )}

                {/* 4. Hide / Show Heading or Element to preview page layout */}
                {!readOnly && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => toggleHideField(ctxField)}
                    className="flex w-full items-center justify-between rounded-xl px-2.5 py-1.5 text-left font-medium text-ink hover:bg-cream"
                  >
                    <span className="inline-flex items-center gap-2">
                      {isCurrentlyHidden ? <IconEye /> : <IconEyeOff />}
                      <span>
                        {isCurrentlyHidden
                          ? `Show ${isHeading ? "Heading" : "Element"}`
                          : `Hide ${isHeading ? "Heading" : "Element"} (Preview Page)`}
                      </span>
                    </span>
                  </button>
                )}

                {/* 5. Copy Style & Paste Style */}
                <div className="my-1 border-t border-line/70" />
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setStyleClipboard(currentStyle);
                    showQuickToast(`Copied style from ${ctxField.label}`);
                    setContextMenu(null);
                  }}
                  className="flex w-full items-center justify-between rounded-xl px-2.5 py-1.5 text-left text-ink hover:bg-cream"
                >
                  <span className="inline-flex items-center gap-2">
                    <IconPalette />
                    <span>Copy Style</span>
                  </span>
                </button>
                {!readOnly && styleClipboard !== null && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      change(ctxField.id, { ...edits[ctxField.id], style: styleClipboard }, { commit: true });
                      showQuickToast(`Pasted style onto ${ctxField.label}`);
                      setContextMenu(null);
                    }}
                    className="flex w-full items-center justify-between rounded-xl px-2.5 py-1.5 text-left text-ink hover:bg-cream"
                  >
                    <span className="inline-flex items-center gap-2">
                      <IconBrush />
                      <span>Paste Style</span>
                    </span>
                  </button>
                )}

                {/* 6. SEO Power Shortcuts (Right-click Heading -> Use for SEO!) */}
                {!readOnly && currentText && (
                  <>
                    <div className="my-1 border-t border-line/70" />
                    <div className="px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-muted">
                      SEO Power Actions
                    </div>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => void applyQuickSeoFromText("title")}
                      className="flex w-full items-center gap-2 rounded-xl px-2.5 py-1.5 text-left font-medium text-blue hover:bg-blue/10"
                    >
                      <IconTarget />
                      <span>{isHeading ? "Use Heading as SEO Title" : "Use as Page SEO Title"}</span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => void applyQuickSeoFromText("description")}
                      className="flex w-full items-center gap-2 rounded-xl px-2.5 py-1.5 text-left text-ink hover:bg-cream"
                    >
                      <IconFileText />
                      <span>Use as Meta Description</span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => void applyQuickSeoFromText("tags")}
                      className="flex w-full items-center gap-2 rounded-xl px-2.5 py-1.5 text-left text-ink hover:bg-cream"
                    >
                      <IconTag />
                      <span>Extract Words to SEO Tags</span>
                    </button>
                  </>
                )}

                {/* 7. Duplicate / Remove Structure Actions */}
                {!readOnly && (ctxField.structure?.duplicate || ctxField.structure?.remove) && (
                  <>
                    <div className="my-1 border-t border-line/70" />
                    {ctxField.structure?.duplicate && (
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          void runStructure("duplicate", ctxField.id);
                          setContextMenu(null);
                        }}
                        className="flex w-full items-center gap-2 rounded-xl px-2.5 py-1.5 text-left text-ink hover:bg-cream"
                      >
                        <IconPlusSquare />
                        <span>Duplicate {isHeading ? "Heading" : "Element"}</span>
                      </button>
                    )}
                    {ctxField.structure?.remove && (
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          void runStructure("remove", ctxField.id);
                          setContextMenu(null);
                        }}
                        className="flex w-full items-center gap-2 rounded-xl px-2.5 py-1.5 text-left text-danger-text hover:bg-danger-surface"
                      >
                        <IconTrash />
                        <span>Remove {isHeading ? "Heading" : "Element"}</span>
                      </button>
                    )}
                  </>
                )}
              </div>
            )}

            {/* Footer Page-Level Actions */}
            <div className="border-t border-line/70 pt-1">
              {hiddenCount > 0 && !readOnly && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    for (const [id, edit] of Object.entries(edits)) {
                      if (/(?:^|;)\s*display\s*:\s*none\b/i.test(edit.style ?? "")) {
                        const restored = (edit.style ?? "")
                          .split(";")
                          .map((s) => s.trim())
                          .filter((s) => s && !/^display\s*:\s*none$/i.test(s))
                          .join("; ");
                        change(id, { ...edit, style: restored }, { commit: true });
                      }
                    }
                    showQuickToast(`Restored ${hiddenCount} hidden element${hiddenCount > 1 ? "s" : ""}`);
                    setContextMenu(null);
                  }}
                  className="flex w-full items-center justify-between rounded-xl px-2.5 py-1.5 text-left font-semibold text-emerald-700 hover:bg-emerald-500/10"
                >
                  <span className="inline-flex items-center gap-2">
                    <IconEye />
                    <span>Show All Hidden ({hiddenCount})</span>
                  </span>
                </button>
              )}
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setCommentsModalOpen(true);
                  setContextMenu(null);
                }}
                className="flex w-full items-center justify-between rounded-xl px-2.5 py-1.5 text-left font-medium text-ink hover:bg-cream"
              >
                <span className="inline-flex items-center gap-2">
                  <IconMessageSquare />
                  <span>{ctxField ? "Pin Revision Note to Element" : "Open Revision Checklist"}</span>
                </span>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  pick(null);
                  setShowPanel(true);
                  setInspectorTab("seo");
                  setContextMenu(null);
                }}
                className="flex w-full items-center justify-between rounded-xl px-2.5 py-1.5 text-left font-medium text-ink hover:bg-cream"
              >
                <span className="inline-flex items-center gap-2">
                  <IconSearch />
                  <span>Open Page SEO &amp; Repo Tags</span>
                </span>
              </button>
              {picked && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    pick(null);
                    setContextMenu(null);
                  }}
                  className="flex w-full items-center justify-between rounded-xl px-2.5 py-1.5 text-left text-muted hover:bg-cream hover:text-ink"
                >
                  <span className="inline-flex items-center gap-2">
                    <IconXCircle />
                    <span>Clear Selection</span>
                  </span>
                </button>
              )}
            </div>
          </div>
        );
      })()}

      {page.data && (
        <WebsiteAgentChat
          pageId={pageId}
          pageTitle={page.data.page?.title || "Page"}
          siteId={page.data.site?.id || ""}
          siteName={page.data.site?.name || "Website"}
          selectedFieldId={pickedId}
          fieldLabel={picked?.label}
          edits={edits}
          canEdit={canEdit}
          canUndo={historyState.canUndo}
          canRedo={historyState.canRedo}
          onUndo={() => void restore(-1)}
          onRedo={() => void restore(1)}
          onStructureAction={(kind, fieldId, targetId) => {
            void runStructure(kind, fieldId, targetId);
          }}
          onDiscardDraft={() => discard.mutate()}
          onReloadPreview={() => {
            dirty.current = false;
            void qc.invalidateQueries({ queryKey: ["website", "page", pageId] });
            setPreviewToken((token) => token + 1);
          }}
          onApplyLocalEdits={(values) => {
            const merged = { ...latestEdits.current };
            for (const [id, value] of Object.entries(values)) {
              merged[id] = { ...merged[id], ...value };
              change(id, merged[id]);
            }
            commitHistory(merged);
            setLoadToken(token => token + 1);
          }}
        />
      )}
    </div>
  );
}
