import { DeferredPanel } from "../components/DeferredPanel";
import { applyTextFormat, editableInnerHtml, formatActiveText, type TextToggle } from "../lib/websiteTextSelection";
import { WebsiteCanvasOverlay } from "../components/WebsiteCanvasOverlay";
import { WebsiteRichText } from "../components/WebsiteRichText";
import { WebsiteTextFormatting } from "../components/WebsiteTextFormatting";
import { WebsiteMotionPanel } from "../components/WebsiteMotionPanel";
import { WebsiteHoverPanel } from "../components/WebsiteHoverPanel";
import { WebsiteStylePanel } from "../components/WebsiteStylePanel";
import { Seg } from "../components/InspectorDesign";
import { lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { api, ApiError, apiUrl } from "../lib/api";
import { useAuth } from "../lib/auth";
import type { DraftConflict, DraftSaveResult, FieldEdit, PublishResult, SiteFieldRow, SiteSectionRow, SitePageDetail, SitePageRow } from "../lib/types";
import { Badge, Button, RelativeTime } from "../components/ui";
import { TourHost } from "../components/TourHost";
import { HelpDialog } from "../components/HelpDialog";
import { startTour, tourAction, TOUR_EVENTS, TOURS, type TourId } from "../lib/tours";
import { tourSeen, useUiState } from "../lib/uiState";


import { WebsiteImageFraming } from "../components/WebsiteImageFraming";
import { ImagePositionControl } from "../components/ImagePositionControl";
import { WebsitePresetPicker } from "../components/WebsiteBrandPresets";
import type { BrandPreset } from "../lib/websiteBrandPresets";
import { WebsiteAssetLibrary, WebsiteAssetPickerModal, type CapturedHtmlImage } from "../components/WebsiteAssetLibrary";
import { MakeSharedPanel, SharedElementPanel, SharedPublishReview } from "../components/WebsiteShared";
import { PublishStatus } from "../components/PublishStatus";
import { PublishReview, type WebsiteReview } from "../components/PublishReview";
import { ElementInspector } from "../components/ElementInspector";
import { ColorCodeInput, parseStyle, writeStyle } from "../components/InspectorControls";
import { extractColorsFromMarkup } from "../lib/pageColors";
import { INSPECTED_PROPERTIES, toHex, type ElementFacts } from "../lib/elementInspector";
import { WebsiteLayers, WebsiteBreadcrumbs } from "../components/WebsiteLayers";
import { WebsiteVersions } from "../components/WebsiteVersions";
import { WebsiteNotesPanel } from "../components/WebsiteDrawerPanels";

import { WebsiteAssistant } from "../components/WebsiteAssistant";
import { WebsiteAgentChat } from "../components/WebsiteAgentChat";
import { WebsitePageSeoInspector } from "../components/WebsitePageSeoInspector";
import { WebsitePlanChip, notifyTierStatusChanged, useWebsiteTierStatus } from "../components/WebsiteTierStatusBanner";
import { FieldRow } from "../components/WebsiteFieldRow";
import { ConflictDialog } from "../components/WebsiteConflictDialog";

import {
  IconArrowLeft,
  IconExternalLink,
  IconMessageCircle,
  IconRocket,
  IconUsers,
  IconBot,
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
  IconImage,
  IconLayers,
  IconLayout,
  IconList,
  IconLock,
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
import { rewriteWebsiteMediaStyle, websiteMediaPreviewUrl, websiteMediaSourceUrl, type WebsiteMediaAsset } from "../lib/websiteMedia";
import { WebsiteIconPicker } from "../components/WebsiteIconPicker";
import { iconPreviewSrc, svgPreviewSrc } from "../lib/websiteIconPreview";
import { libraryIcon, libraryIconMarkup } from "../../../src/shared/websiteIcons";
import type { IconChoice } from "../lib/types";
import { setPageTitle } from "../lib/surface";
import { reviewStatusLabel, useReviewLinks } from "../components/WebsiteReviewLinks";

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

const WebsiteFindReplaceModal = lazy(() => import("../components/WebsiteFindReplaceModal").then(module => ({ default: module.WebsiteFindReplaceModal })));
const WebsiteClientReportModal = lazy(() => import("../components/WebsiteCommandAndSections").then(module => ({ default: module.WebsiteClientReportModal })));
const WebsiteCommandPaletteModal = lazy(() => import("../components/WebsiteCommandAndSections").then(module => ({ default: module.WebsiteCommandPaletteModal })));
const WebsiteRevisionCommentsModal = lazy(() => import("../components/WebsiteCommandAndSections").then(module => ({ default: module.WebsiteRevisionCommentsModal })));

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

/** The drawers the tool rail opens. One at a time: the page is what matters. */
type EditorPanel = "layers" | "theme" | "media" | "seo" | "grow" | "notes" | "history" | "help";

const RAIL: { key: Exclude<EditorPanel, "help" | "notes" | "history">; label: string; title: string; icon: typeof IconLayers }[] = [
  { key: "layers", label: "Layers", title: "Everything on this page, in order", icon: IconLayers },
  { key: "theme", label: "Theme", title: "Colours and fonts for the whole page", icon: IconPalette },
  { key: "media", label: "Media", title: "Pictures and files", icon: IconImage },
  { key: "seo", label: "SEO", title: "How this page shows up in Google and when shared", icon: IconTarget },
  { key: "grow", label: "Grow", title: "Speed, uptime and ways for visitors to reach you", icon: IconRocket },
];

const RAIL_TITLES: Record<EditorPanel, { title: string; sub: string }> = {
  notes: { title: "Notes", sub: "Revision notes for this page" },
  history: { title: "History", sub: "Restore any earlier version" },
  layers: { title: "Layers", sub: "Everything on this page, in order. Click one to select it." },
  theme: { title: "Theme", sub: "Colours and fonts that apply across the whole page" },
  media: { title: "Media", sub: "Pictures on this page and in your library" },
  seo: { title: "SEO", sub: "How this page appears in Google and when shared" },
  grow: { title: "Grow", sub: "Speed, uptime, and ways for visitors to reach you" },
  help: { title: "Help", sub: "Tours, the guide, and a person to ask" },
};

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
const LIVE_KEYS = new Set(["value", "style", "responsive", "variant", "newTab", "icon", "iconPosition", "alt"]);

/**
 * A field with formatting inside it.
 *
 * Uncontrolled on purpose: React writing `innerHTML` on every keystroke moves
 * the caret to the end of the box, which makes a paragraph impossible to edit in
 * the middle. The DOM owns the content while it is being typed in, and the
 * component is remounted by its key when the page reloads underneath it.
 */



export function WebsiteEditor() {
  const { pageId = "" } = useParams();
  return <WebsitePageEditor key={pageId} pageId={pageId} />;
}

function WebsitePageEditor({ pageId }: { pageId: string }) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const [designerMode, setDesignerMode] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<"content" | "layout" | "theme" | "seo" | "style" | "interactions">("content");
  const [showLayers, setShowLayers] = useState(false);
  const [showPanel, setShowPanel] = useState(() => typeof window === "undefined" || window.innerWidth > 600);
  const [editorTheme, setEditorTheme] = useState(() => { try { return localStorage.getItem("website-editor-theme") || "dark"; } catch { return "dark"; } });
  /**
   * Arriving with ?walkthrough (a new customer, straight after adding their
   * website) starts the editor tour; anybody else is offered it once.
   */
  const [tourOnArrival] = useState<TourId | null>(() => {
    try { return new URLSearchParams(window.location.search).get("walkthrough") ? "editor" : null; } catch { return null; }
  });
  const uiState = useUiState();
  const [helpOpen, setHelpOpen] = useState(false);
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
    try {
      setDesignerMode(localStorage.getItem(`website-designer:${user.id}`) === "yes");
    } catch {
      /* Preferences are optional. */
    }
  }, [user?.id]);
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
    if (m === "edit" || m === "preview" || m === "visual") return m;
    // A phone opens in List mode: the page's words as a form a thumb can edit.
    // Tapping a heading inside a page scaled to fit 390px picks its neighbour
    // as often as it picks the heading. Visual is one tap away in the bar.
    return window.matchMedia?.("(max-width: 640px)").matches ? "edit" : "visual";
  });
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
  const canvasRef = useRef<HTMLDivElement | null>(null);
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
  const [showFindReplace, setShowFindReplace] = useState(false);
  /** Optional assistant proposals join the same local draft and undo history. */
  const [showAI, setShowAI] = useState(false);
  /** The Builder Agent's chat, opened from the toolbar rather than a button floating over the page. */
  const [agentOpen, setAgentOpen] = useState(false);
  /**
   * The site's own pop-ups (cookie banner, chat bubble…) are hidden in the
   * editing frame unless somebody chose to see them. The frame reports how many
   * it hid; the choice is remembered in this browser.
   */
  const [showSitePopups, setShowSitePopups] = useState(() => {
    try { return localStorage.getItem("website-editor-site-popups") === "show"; } catch { return false; }
  });
  const showSitePopupsRef = useRef(showSitePopups);
  showSitePopupsRef.current = showSitePopups;
  const [sitePopups, setSitePopups] = useState<{ hidden: number; hiding: boolean } | null>(null);
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
        const computedMap = Object.fromEntries(INSPECTED_PROPERTIES.map(key => [key, style.getPropertyValue(key)]));

        // If this container's own background-image is "none", check ::before, ::after,
        // or a direct/nested background layer or cover <img> inside the container so
        // the Background Image placeholder always displays the visual image.
        if (!computedMap["background-image"] || computedMap["background-image"] === "none") {
          const beforeBg = view.getComputedStyle(element, "::before").getPropertyValue("background-image");
          const afterBg = view.getComputedStyle(element, "::after").getPropertyValue("background-image");
          if (beforeBg && beforeBg !== "none" && /url\(/i.test(beforeBg)) {
            computedMap["background-image"] = beforeBg;
          } else if (afterBg && afterBg !== "none" && /url\(/i.test(afterBg)) {
            computedMap["background-image"] = afterBg;
          } else {
            const descendants = Array.from(element.querySelectorAll<HTMLElement>("*"));
            for (const desc of descendants) {
              const descBg = view.getComputedStyle(desc).getPropertyValue("background-image");
              if (descBg && descBg !== "none" && /url\(/i.test(descBg)) {
                computedMap["background-image"] = descBg;
                break;
              }
            }
            if (!computedMap["background-image"] || computedMap["background-image"] === "none") {
              const childImg = element.querySelector<HTMLImageElement>("img[src]");
              if (childImg) {
                const imgSrc = childImg.getAttribute("src") || childImg.src;
                if (imgSrc) {
                  computedMap["background-image"] = `url("${imgSrc}")`;
                }
              }
            }
          }
        }

        setComputed(computedMap);
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
    queryFn: ({ signal }) => api.get<SitePageDetail>(`/website/pages/${pageId}`, signal),
  });

  const mediaAssets = useQuery({
    queryKey: ["website", "assets", page.data?.site.id],
    enabled: !!page.data?.site.id,
    queryFn: ({ signal }) => api.get<WebsiteMediaAsset[]>(`/website/sites/${page.data!.site.id}/assets`, signal),
  });
  // A picker selection must be available to the live write immediately,
  // including before React renders or an upload invalidation finishes.
  const selectedMedia = useRef(new Map<string, WebsiteMediaAsset>());
  const resolveImagePreview = useCallback((value: string) => websiteMediaPreviewUrl(value, {
    pageUrl: page.data?.page.url ?? (typeof window !== "undefined" ? window.location.href : ""),
    editorUrl: typeof window !== "undefined" ? window.location.href : "",
    assets: [...selectedMedia.current.values(), ...(mediaAssets.data ?? [])],
  }), [page.data?.page.url, mediaAssets.data]);
  const resolveImageSource = useCallback((value: string) => websiteMediaSourceUrl(value, {
    pageUrl: page.data?.page.url ?? (typeof window !== "undefined" ? window.location.href : ""),
    editorUrl: typeof window !== "undefined" ? window.location.href : "",
    assets: [...selectedMedia.current.values(), ...(mediaAssets.data ?? [])],
  }), [page.data?.page.url, mediaAssets.data]);
  const previewStyle = useCallback((value: string) => rewriteWebsiteMediaStyle(value, resolveImagePreview), [resolveImagePreview]);

  const access = useWebsiteAccess(page.data?.site.id);
  const canEdit = access.data?.capabilities.edit === true;
  /**
   * Where "Live Demo" goes, decided by the server. Not site.publicUrl: an
   * imported page keeps the business's own address there, so the button
   * opened their real website instead of the copy being edited.
   */
  const liveDemoHref = page.data?.liveUrl ?? null;
  // A prospect demo is decided by the demo record on the server, never by how
  // the page arrived: every hosted customer site was "imported from a file"
  // too, and treating those as demos sent customers back to a Demos screen they
  // cannot open and published their pages without the review step.
  const isDemo = Boolean(demoIdFromUrl || page.data?.demo);
  // DakyX serves this page itself: no repository, live the moment it publishes.
  const hostedHere = !page.data?.site.repo && page.data?.readFrom === "imported file";
  const pageTitle = page.data?.page.title;
  useEffect(() => { if (pageTitle) setPageTitle(`Editing ${pageTitle}`); }, [pageTitle]);
  // What the client said about the last draft sent for approval, if anything is
  // still current — shown beside the save status, where the decision is made.
  const reviewLinks = useReviewLinks(pageId);
  const latestReview = reviewLinks.data?.links.find((link) => link.status !== "WITHDRAWN" && !(link.status === "PENDING" && link.expired)) ?? null;
  const latestReviewStatus = latestReview ? reviewStatusLabel(latestReview) : null;
  const design = useQuery({ queryKey: ["website", "design", page.data?.site.id], enabled: !!page.data?.site.id, queryFn: ({ signal }) => api.get<{ options: { colours: string[]; fonts: string[]; aiEnabled: boolean; presets: BrandPreset[] } }>(`/website/sites/${page.data!.site.id}/design`, signal) });

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
    (kind: "style" | "responsive" | "image" | "icon" | "text" | "select" | "variant", id: string | null, value?: string, from?: string): "written" | "absent" | "unreachable" => {
    let doc: Document | null = null;
    try {
      doc = frame.current?.contentDocument ?? null;
    } catch {
      doc = null; // cross-origin one day
    }
    if (!doc || !doc.body) return "unreachable";

    if (kind === "select") {
      // All of them. The frame's own script marks what is clicked and this
      // marks what is chosen from here (Select parent, Layers), so more than
      // one can be left behind — and removing only the first meant clearing
      // the selection left an outline on the page that nothing would take off.
      doc.querySelectorAll("[data-dw-selected]").forEach((was) => was.removeAttribute("data-dw-selected"));
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
      const previewUrl = resolveImagePreview(value ?? "");
      if (el.tagName === "IMG") {
        const currentSrc = el.getAttribute("src") || "";
        const isCurrentPreview = currentSrc.includes("/api/website/sites/") && currentSrc.includes("/assets/");
        const isUnresolvedUpload = previewUrl.includes("/assets/dw/") && !previewUrl.includes("/api/website/");
        if (!isCurrentPreview || !isUnresolvedUpload) {
          el.setAttribute("src", previewUrl);
          el.removeAttribute("srcset");
        }
      } else {
        const img = el.querySelector("img");
        if (img) {
          const currentSrc = img.getAttribute("src") || "";
          const isCurrentPreview = currentSrc.includes("/api/website/sites/") && currentSrc.includes("/assets/");
          const isUnresolvedUpload = previewUrl.includes("/assets/dw/") && !previewUrl.includes("/api/website/");
          if (!isCurrentPreview || !isUnresolvedUpload) {
            img.setAttribute("src", previewUrl);
            img.removeAttribute("srcset");
          }
        } else {
          const htmlEl = el as HTMLElement;
          htmlEl.style.backgroundImage = previewUrl ? `url('${previewUrl.replace(/['"\\]/g, "")}')` : "none";
          el.querySelectorAll<HTMLElement>("*").forEach((desc) => {
            if (doc?.defaultView) {
              const bg = doc.defaultView.getComputedStyle(desc).backgroundImage;
              if (bg && bg !== "none" && /url\(/i.test(bg)) {
                desc.style.backgroundImage = previewUrl ? `url('${previewUrl.replace(/['"\\]/g, "")}')` : "none";
              }
            }
          });
        }
      }
      return "written";
    }
    if (kind === "icon") {
      try {
        const choice = value ? (JSON.parse(value) as IconChoice | null) : null;
        let sheet = doc.querySelector<HTMLStyleElement>("style[data-dw-icon-preview]");
        if (!sheet) {
          sheet = doc.createElement("style");
          sheet.setAttribute("data-dw-icon-preview", "");
          sheet.textContent = `
            [data-dw-icon-replaced]::before, [data-dw-icon-replaced]::after { display: none !important; content: none !important; }
            [data-dw-icon-replaced] { border: none !important; transform: none !important; }
          `;
          (doc.head || doc.body).appendChild(sheet);
        }
        const htmlEl = el as HTMLElement;
        if (!choice) {
          htmlEl.innerHTML = "";
          htmlEl.removeAttribute("data-dw-icon-replaced");
          htmlEl.style.border = "";
          htmlEl.style.borderRadius = "";
          htmlEl.style.transform = "";
          htmlEl.style.backgroundImage = "";
        } else if ("library" in choice) {
          const lib = libraryIcon(choice.library);
          if (lib) {
            htmlEl.innerHTML = libraryIconMarkup(lib);
            htmlEl.setAttribute("data-dw-icon-replaced", "true");
            htmlEl.style.border = "none";
            htmlEl.style.borderRadius = "0";
            htmlEl.style.transform = "none";
            htmlEl.style.backgroundImage = "none";
          }
        } else if ("src" in choice) {
          const src = resolveImagePreview(choice.src);
          htmlEl.innerHTML = `<img src="${src}" alt="" aria-hidden="true" style="width:100%;height:100%;object-fit:contain">`;
          htmlEl.setAttribute("data-dw-icon-replaced", "true");
          htmlEl.style.border = "none";
          htmlEl.style.borderRadius = "0";
          htmlEl.style.transform = "none";
          htmlEl.style.backgroundImage = "none";
        }
      } catch {
        // Fallback
      }
      return "written";
    }
    if (kind === "style") {
      if (value) {
        const nextStyle = previewStyle(value);
        const currentStyle = el.getAttribute("style") || "";
        const isCurrentPreview = currentStyle.includes("/api/website/sites/") && currentStyle.includes("/assets/");
        const isUnresolvedUpload = nextStyle.includes("/assets/dw/") && !nextStyle.includes("/api/website/");
        if (!isCurrentPreview || !isUnresolvedUpload) {
          el.setAttribute("style", nextStyle);
        }
      } else {
        el.removeAttribute("style");
      }
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
    [resolveImagePreview, previewStyle],
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
    (kind: "style" | "responsive" | "image" | "icon" | "text" | "variant", id: string, value: string, from?: string) => {
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
          ? { type: "style", id, style: previewStyle(value) }
          : kind === "responsive"
            ? { type: "responsive", id, css: responsivePreviewCss(id, JSON.parse(value)) }
          : kind === "image"
            ? { type: "image", id, src: resolveImagePreview(value) }
          : kind === "icon"
            ? { type: "icon", id, icon: value }
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
    [tell, writeInFrame, resolveImagePreview, previewStyle],
  );

  const pick = useCallback(
    (id: string | null) => {
      setPickedId(id);
      if (writeInFrame("select", id) === "unreachable") tell({ type: "select", id });
    },
    [tell, writeInFrame],
  );

  useEffect(() => {
    if (!mediaAssets.data) return;
    // Recovered drafts can replay before the asset query finishes. Refresh
    // their visual URLs once metadata arrives without changing saved values.
    const fields = (page.data?.sections ?? []).flatMap(section => section.fields);
    const currentEdits = { ...(page.data?.draft.values ?? {}), ...latestEdits.current };
    for (const [id, edit] of Object.entries(currentEdits)) {
      if (edit.value !== undefined && fields.some(field => field.id === id && field.kind === "image")) writeInFrame("image", id, edit.value);
      if (edit.style !== undefined) writeInFrame("style", id, edit.style);
      if (edit.icon !== undefined) writeInFrame("icon", id, JSON.stringify(edit.icon));
    }
  }, [mediaAssets.data, writeInFrame, page.data?.sections, page.data?.draft.values]);

  const change = useCallback(
    (fieldId: string, next: FieldEdit, options?: { fromFrame?: boolean; commit?: boolean }) => {
      if (!canEdit || reviewOpen || showVersions || publishPending.current || structurePending.current) return;
      const imageField = page.data?.sections.some(section => section.fields.some(field => field.id === fieldId && field.kind === "image"));
      next = {
        ...next,
        ...(imageField && next.value !== undefined ? { value: resolveImageSource(next.value) } : {}),
        ...(next.style !== undefined ? { style: rewriteWebsiteMediaStyle(next.style, resolveImageSource) } : {}),
      };
      dirty.current = true;
      setPublished(null);
      if (Object.keys(next).some((key) => !LIVE_KEYS.has(key))) needsReload.current = true;
      // Push what the frame can show straight into it, so the page changes
      // while the slider is still moving rather than after the next save.
      if (!options?.fromFrame) {
        if (next.style !== undefined) push("style", fieldId, next.style);
        if (next.responsive !== undefined) push("responsive", fieldId, JSON.stringify(next.responsive));
        if (next.value !== undefined) push(imageField ? "image" : "text", fieldId, next.value);
        if (next.icon !== undefined) push("icon", fieldId, JSON.stringify(next.icon));
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
    [commitHistory, push, canEdit, reviewOpen, showVersions, page.data, resolveImageSource],
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
        hidden?: number;
        hiding?: boolean;
      };
      if (event.source !== frame.current?.contentWindow || event.origin !== window.location.origin || data?.source !== "dakyworld-preview") return;
      if (data.type === "overlays") {
        // The frame hides them by default; somebody who chose to see them gets
        // them back on every reload.
        if (data.hiding && showSitePopupsRef.current) {
          frame.current?.contentWindow?.postMessage({ source: "dakyworld-editor", type: "overlays", hide: false }, "*");
          return;
        }
        setSitePopups({ hidden: data.hidden ?? 0, hiding: Boolean(data.hiding) });
        return;
      }
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
            if (edit.icon !== undefined) writeInFrame("icon", id, JSON.stringify(edit.icon));
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
      notifyTierStatusChanged();
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
        void (async () => {
          try {
            if (dirty.current) await save.mutateAsync(latestEdits.current);
            if (event.key === "Enter") setReviewOpen(true);
          } catch {}
        })();
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
      const refreshed = await qc.fetchQuery({ queryKey: ["website", "page", pageId], queryFn: ({ signal }) => api.get<SitePageDetail>(`/website/pages/${pageId}`, signal), staleTime: 0 });
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
      notifyTierStatusChanged();
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

  const { status: tierStatus } = useWebsiteTierStatus(page.data?.site?.id);

  /** Normal or Hover, in the Style tab. A new selection starts at Normal. */
  const [styleState, setStyleState] = useState<"normal" | "hover">("normal");
  useEffect(() => setStyleState("normal"), [pickedId]);

  /** Which rail drawer is open, and which bar menu. */
  const [panel, setPanel] = useState<EditorPanel | null>(null);
  const [menu, setMenu] = useState<null | "mode" | "page" | "publish" | "account">(null);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setMenu(null); };
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);
  const sitePages = useQuery({
    queryKey: ["website", "editor-pages", page.data?.site.id],
    enabled: menu === "page" && Boolean(page.data?.site.id),
    queryFn: ({ signal }) => api.get<{ pages: SitePageRow[] }>(`/website/sites/${page.data!.site.id}/pages?limit=100`, signal),
  });
  /** What the first-edit checklist reads. Remembered for this visit only, except putting it away. */
  const [guideHidden, setGuideHidden] = useState(false);
  useEffect(() => {
    if (!user?.id) return;
    try { setGuideHidden(localStorage.getItem(`website-editor-guide:${user.id}`) === "hidden"); } catch { /* Optional preference. */ }
  }, [user?.id]);
  const [everPicked, setEverPicked] = useState(false);
  useEffect(() => { if (pickedId) setEverPicked(true); }, [pickedId]);
  const [phoneChecked, setPhoneChecked] = useState(false);
  useEffect(() => { if (device === "mobile" && mode !== "edit") setPhoneChecked(true); }, [device, mode]);

  // What a guided tour may be waiting for (lib/tours.ts). Announced from
  // state, so every way of doing the thing counts — clicking the page, the
  // layers list, a keyboard shortcut — not only the one the tour points at.
  useEffect(() => {
    if (!pickedId) return;
    tourAction("field-selected");
    const kind = page.data?.sections.flatMap((section) => section.fields).find((field) => field.id === pickedId)?.kind;
    if (kind === "image") tourAction("image-selected");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickedId]);
  const editedForTour = useRef(0);
  useEffect(() => {
    const count = Object.values(edits).filter((edit) => Object.keys(edit).length > 0).length;
    if (count > editedForTour.current) tourAction("text-edited");
    editedForTour.current = count;
  }, [edits]);
  useEffect(() => {
    if (page.data?.draft.savedAt) tourAction("draft-saved");
  }, [page.data?.draft.savedAt]);
  const deviceForTour = useRef(device);
  useEffect(() => {
    if (device === deviceForTour.current) return;
    deviceForTour.current = device;
    tourAction("device-changed");
  }, [device]);
  const modeForTour = useRef(mode);
  useEffect(() => {
    if (mode === modeForTour.current) return;
    modeForTour.current = mode;
    tourAction(mode === "preview" ? "mode-preview" : mode === "edit" ? "mode-list" : "mode-visual");
  }, [mode]);
  useEffect(() => { if (reviewOpen) tourAction("publish-review-opened"); }, [reviewOpen]);
  useEffect(() => { if (showVersions) tourAction("versions-opened"); }, [showVersions]);
  useEffect(() => { if (assetModalOpen) tourAction("asset-picker-opened"); }, [assetModalOpen]);
  // A step that needs a particular mode asks for it.
  useEffect(() => {
    const onMode = (event: Event) => {
      const next = (event as CustomEvent<{ mode?: Mode }>).detail?.mode;
      if (next) setMode(next);
    };
    const onTab = (event: Event) => {
      const next = (event as CustomEvent<{ tab?: "content" | "style" | "interactions" }>).detail?.tab;
      if (!next) return;
      const field = pickedRef.current ? (page.data?.sections ?? []).flatMap((section) => section.fields).find((candidate) => candidate.id === pickedRef.current) : null;
      setInspectorTab(next === "content" && field?.kind === "container" ? "layout" : next);
      setStyleState("normal");
    };
    window.addEventListener(TOUR_EVENTS.mode, onMode);
    window.addEventListener(TOUR_EVENTS.tab, onTab);
    return () => {
      window.removeEventListener(TOUR_EVENTS.mode, onMode);
      window.removeEventListener(TOUR_EVENTS.tab, onTab);
    };
  }, []);

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
  const pagePalette = useMemo(() => {
    const serverColours = design.data?.options.colours ?? [];
    const fieldColours = extractColorsFromMarkup("", allFields);
    const tokenColours = pageColorTokens.map((t) => t.value);
    const combined = Array.from(new Set([...serverColours, ...tokenColours, ...fieldColours]))
      .filter((c) => /^#[0-9A-Fa-f]{6}$/.test(c))
      .slice(0, 16);
    return combined.length > 0 ? combined : serverColours;
  }, [design.data?.options.colours, pageColorTokens, allFields]);
  const [frameCapturedImages, setFrameCapturedImages] = useState<CapturedHtmlImage[]>([]);
  const [assetTargetMode, setAssetTargetMode] = useState<"image" | "background">("image");

  // Maintain valid active tab as selection changes between containers, elements, and page-level
  useEffect(() => {
    const pickedField = pickedId ? allFields.find((f) => f.id === pickedId) ?? null : null;
    if (!pickedField) {
      const allowed: Array<typeof inspectorTab> = ["content", "theme", "seo"];
      if (!allowed.includes(inspectorTab)) {
        setInspectorTab("content");
      }
    } else if (pickedField.kind === "container") {
      const allowed: Array<typeof inspectorTab> = ["layout", "style", "interactions"];
      if (!allowed.includes(inspectorTab)) {
        setInspectorTab("layout");
      }
    } else {
      const allowed: Array<typeof inspectorTab> = ["content", "style", "interactions"];
      if (!allowed.includes(inspectorTab)) {
        setInspectorTab("content");
      }
    }
  }, [pickedId, allFields, inspectorTab]);

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

      // Also extract all declared colours across inline styles, SVG elements and attributes
      const docHtml = doc.documentElement?.outerHTML || "";
      const markupColours = extractColorsFromMarkup(docHtml, allFields);
      for (const hex of markupColours) {
        if (tokens.length >= 24) break;
        const norm = hex.toUpperCase();
        if (seenHexes.has(norm)) continue;
        seenHexes.add(norm);
        tokens.push({
          key: norm,
          label: `Page Color ${norm}`,
          value: norm,
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

      // Capture all images (<img>, <svg>, and CSS background-image url(...)) from the live HTML document for the Media Library
      const baseUrl = page.data?.page.url || page.data?.site?.publicUrl || window.location.origin;
      const resolveUrl = (raw: string) => {
        const cleaned = resolveImageSource(raw.trim().replace(/^['"]|['"]$/g, ""));
        if (!cleaned || cleaned.startsWith("data:font") || /\.(woff2?|ttf|otf|eot)(\?|$)/i.test(cleaned)) return "";
        if (/^(https?:|data:|blob:|\/api\/)/i.test(cleaned)) return cleaned;
        try {
          return resolveImageSource(new URL(cleaned, baseUrl).href);
        } catch {
          return cleaned;
        }
      };

      const discovered: CapturedHtmlImage[] = [];
      const seenUrls = new Set<string>();
      const pushImg = (rawUrl: string, altText: string, sourceLabel: string, previewUrl?: string) => {
        const resolved = resolveUrl(rawUrl);
        if (!resolved || seenUrls.has(resolved)) return;
        seenUrls.add(resolved);
        discovered.push({
          url: resolved,
          alt: altText.trim() || resolved.split("/").pop()?.split("?")[0] || "Captured image",
          preview: previewUrl ?? resolveImagePreview(resolved),
          source: sourceLabel,
        });
      };

      doc.querySelectorAll<HTMLImageElement>("img[src]").forEach((imgEl) => {
        pushImg(imgEl.getAttribute("src") || imgEl.src, imgEl.getAttribute("alt") || "", "HTML <img>");
      });

      doc.querySelectorAll<SVGElement>("svg").forEach((svgEl, idx) => {
        if (svgEl.closest("[hidden], [style*='display: none'], [style*='display:none']")) return;
        const outer = svgEl.outerHTML;
        if (!outer || outer.length > 500_000) return;
        const withNs = /\sxmlns\s*=/.test(outer.slice(0, outer.indexOf(">") + 1))
          ? outer
          : outer.replace(/^\s*<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
        const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(withNs)}`;
        const label = svgEl.getAttribute("aria-label") || svgEl.getAttribute("id") || `SVG Graphic ${idx + 1}`;
        pushImg(dataUrl, label, "Inline SVG", dataUrl);
      });

      const cssUrlRegex = /url\(\s*['"]?([^'")]+)['"]?\s*\)/gi;
      let urlMatch: RegExpExecArray | null;
      while ((urlMatch = cssUrlRegex.exec(cssText)) !== null) {
        pushImg(urlMatch[1]!, "CSS Background Image", "CSS Background");
      }

      doc.querySelectorAll<HTMLElement>("[style]").forEach((el) => {
        const inlineStyle = el.getAttribute("style") || "";
        let inlineMatch: RegExpExecArray | null;
        while ((inlineMatch = cssUrlRegex.exec(inlineStyle)) !== null) {
          pushImg(inlineMatch[1]!, el.getAttribute("aria-label") || "Inline Background", "CSS Background");
        }
      });

      if (doc.defaultView) {
        doc.querySelectorAll<HTMLElement>("section, header, footer, div, main, article, aside, [data-dw-field]").forEach((el) => {
          const bg = doc.defaultView!.getComputedStyle(el).backgroundImage;
          let bgMatch: RegExpExecArray | null;
          while ((bgMatch = cssUrlRegex.exec(bg || "")) !== null) {
            pushImg(bgMatch[1]!, el.getAttribute("data-dw-field") || "Container Background", "CSS Background");
          }
        });
      }

      if (discovered.length > 0) {
        setFrameCapturedImages(discovered);
      }
    } catch {
      /* Cross-origin fallback */
    }
  }, [allFields, edits, page.data?.site?.publicUrl, page.data?.page.url, resolveImagePreview, resolveImageSource]);

  const capturedHtmlImages = useMemo<CapturedHtmlImage[]>(() => {
    const baseUrl = page.data?.page.url || page.data?.site?.publicUrl || (typeof window !== "undefined" ? window.location.origin : "");
    const resolveUrl = (raw: string) => {
      const cleaned = resolveImageSource(raw.trim().replace(/^['"]|['"]$/g, ""));
      if (!cleaned || cleaned.startsWith("data:font") || /\.(woff2?|ttf|otf|eot)(\?|$)/i.test(cleaned)) return "";
      if (/^(https?:|data:|blob:|\/api\/)/i.test(cleaned)) return cleaned;
      try {
        return resolveImageSource(new URL(cleaned, baseUrl).href);
      } catch {
        return cleaned;
      }
    };
    const list: CapturedHtmlImage[] = [];
    const seen = new Set<string>();
    const add = (rawUrl: string, alt: string, source: string, previewUrl?: string) => {
      const url = resolveUrl(rawUrl);
      if (!url || seen.has(url)) return;
      seen.add(url);
      list.push({
        url,
        alt: alt || url.split("/").pop()?.split("?")[0] || "Page Image",
        preview: previewUrl ?? resolveImagePreview(url),
        source,
      });
    };
    for (const f of allFields) {
      if (f.kind === "image") {
        const val = edits[f.id]?.value ?? f.value ?? "";
        if (val) add(val, edits[f.id]?.alt ?? f.alt ?? f.label, "HTML <img>");
      }
      if (f.kind === "icon" || (f.kind === "button" && f.icon)) {
        const iconMarkup = f.icon;
        if (iconMarkup) {
          const previewSrc = iconPreviewSrc(iconMarkup, page.data?.page.url ?? window.location.href);
          if (previewSrc) {
            add(previewSrc, f.label || "Button Icon", "Icon", previewSrc);
          }
        }
      }
      const st = edits[f.id]?.style ?? f.style ?? "";
      if (st) {
        const m = /url\(\s*['"]?([^'")]+)['"]?\s*\)/i.exec(st);
        if (m?.[1]) add(m[1], f.label, "CSS Background");
      }
    }
    for (const item of frameCapturedImages) {
      add(item.url, item.alt, item.source ?? "Page Media", item.preview);
    }
    return list;
  }, [allFields, edits, frameCapturedImages, page.data?.site?.publicUrl, page.data?.page.url, resolveImagePreview, resolveImageSource]);

  const updatePageColorToken = useCallback(
    (tokenKey: string, nextHex: string, isVar: boolean, previousHex: string) => {
      const formatted = nextHex.startsWith("#") ? nextHex.toUpperCase() : `#${nextHex.toUpperCase()}`;
      const oldUpper = (previousHex || "").toUpperCase();

      setPageColorTokens((prev) =>
        prev.map((item) => {
          if (item.key === tokenKey) return { ...item, value: formatted };
          if (!item.isVar && oldUpper && item.value.toUpperCase() === oldUpper) {
            return { ...item, key: formatted, label: `Page Color ${formatted}`, value: formatted };
          }
          return item;
        }),
      );

      // Compute RGB string equivalent of previousHex so we can match computed styles & rgb() rules
      const hexClean = oldUpper.replace(/^#/, "");
      const oldRgbTuple =
        hexClean.length === 6
          ? [
              parseInt(hexClean.slice(0, 2), 16),
              parseInt(hexClean.slice(2, 4), 16),
              parseInt(hexClean.slice(4, 6), 16),
            ]
          : null;
      const oldRgbPattern = oldRgbTuple
        ? new RegExp(`rgba?\\(\\s*${oldRgbTuple[0]}\\s*,\\s*${oldRgbTuple[1]}\\s*,\\s*${oldRgbTuple[2]}(?:\\s*,\\s*1(?:\\.0+)?)?\\s*\\)`, "gi")
        : null;

      // 1. Update live in the preview iframe immediately (CSS variables, <style> tags, [style] attrs, SVG fill/stroke)
      const matchedFieldStyleUpdates = new Map<string, Record<string, string>>();
      try {
        const doc = frame.current?.contentDocument;
        const win = frame.current?.contentWindow;
        if (doc) {
          if (isVar) {
            doc.documentElement?.style?.setProperty(tokenKey, formatted);
            doc.body?.style?.setProperty(tokenKey, formatted);
          }
          if (oldUpper && oldUpper !== formatted) {
            const escapedOld = previousHex.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const hexRe = new RegExp(escapedOld, "gi");

            doc.querySelectorAll("style:not([data-dw-interaction-preview])").forEach((styleEl) => {
              if (!styleEl.textContent) return;
              let updatedCss = styleEl.textContent;
              if (hexRe.test(updatedCss)) {
                updatedCss = updatedCss.replace(hexRe, formatted);
              }
              if (oldRgbPattern && oldRgbPattern.test(updatedCss)) {
                updatedCss = updatedCss.replace(oldRgbPattern, formatted);
              }
              if (updatedCss !== styleEl.textContent) {
                styleEl.textContent = updatedCss;
              }
            });

            doc.querySelectorAll<HTMLElement>("[style]").forEach((el) => {
              const rawStyle = el.getAttribute("style") || "";
              let nextStyle = rawStyle;
              if (hexRe.test(nextStyle)) nextStyle = nextStyle.replace(hexRe, formatted);
              if (oldRgbPattern && oldRgbPattern.test(nextStyle)) nextStyle = nextStyle.replace(oldRgbPattern, formatted);
              if (nextStyle !== rawStyle) el.setAttribute("style", nextStyle);
            });

            doc.querySelectorAll<SVGElement>("[fill], [stroke]").forEach((svgEl) => {
              const fill = svgEl.getAttribute("fill");
              if (fill && fill.toUpperCase() === oldUpper) svgEl.setAttribute("fill", formatted);
              const stroke = svgEl.getAttribute("stroke");
              if (stroke && stroke.toUpperCase() === oldUpper) svgEl.setAttribute("stroke", formatted);
            });

            // Also check [data-dw-field] elements whose computed color/background/border matched oldRgbTuple
            if (!isVar && oldRgbTuple && win) {
              const targetRgbStr = `rgb(${oldRgbTuple[0]}, ${oldRgbTuple[1]}, ${oldRgbTuple[2]})`;
              doc.querySelectorAll<HTMLElement>("[data-dw-field]").forEach((el) => {
                const fId = el.getAttribute("data-dw-field");
                if (!fId) return;
                const cs = win.getComputedStyle(el);
                const patch: Record<string, string> = {};
                if (cs.backgroundColor === targetRgbStr) patch["background-color"] = formatted;
                if (cs.color === targetRgbStr) patch["color"] = formatted;
                if (cs.borderTopColor === targetRgbStr && parseFloat(cs.borderTopWidth) > 0) patch["border-color"] = formatted;
                if (Object.keys(patch).length > 0) {
                  matchedFieldStyleUpdates.set(fId, patch);
                  for (const [k, v] of Object.entries(patch)) el.style.setProperty(k, v);
                }
              });
            }
          }
        }
      } catch {}

      if (isVar) {
        tell({ type: "cssVar", name: tokenKey, value: formatted });
      }

      // 2. Persist on the body container field and any element with matching color code
      const bodyField = allFields.find((f) => f.tag === "body") ?? allFields.find((f) => f.kind === "container");
      if (bodyField && isVar) {
        const currentStyle = edits[bodyField.id]?.style ?? bodyField.style ?? "";
        const map = parseStyle(currentStyle);
        map[tokenKey] = formatted;
        change(bodyField.id, { ...edits[bodyField.id], style: writeStyle(map) }, { commit: true });
      }
      if (oldUpper) {
        const escapedOld = previousHex.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const hexRe = new RegExp(escapedOld, "gi");
        for (const field of allFields) {
          const st = edits[field.id]?.style ?? field.style ?? "";
          const computedPatch = matchedFieldStyleUpdates.get(field.id);
          let nextStyle = st;
          if (nextStyle && hexRe.test(nextStyle)) {
            nextStyle = nextStyle.replace(hexRe, formatted);
          }
          if (nextStyle && oldRgbPattern && oldRgbPattern.test(nextStyle)) {
            nextStyle = nextStyle.replace(oldRgbPattern, formatted);
          }
          if (computedPatch) {
            const map = parseStyle(nextStyle);
            for (const [k, v] of Object.entries(computedPatch)) map[k] = v;
            nextStyle = writeStyle(map);
          }
          if (nextStyle !== st) {
            change(field.id, { ...edits[field.id], style: nextStyle }, { commit: true });
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
      data-walkthrough="canvas"
      data-tour="canvas"
      ref={canvasRef}
      role="region"
      aria-label="Page canvas"
      tabIndex={0}
      className="editor-canvas relative min-h-0 flex-1 overflow-auto bg-cream p-4"
      onContextMenu={(event) => {
        event.preventDefault();
        openEditorContextMenuFromEvent(event.clientX, event.clientY, null, null, false);
      }}
    >
      {page.data?.site.deletionScheduledFor && (
        <p role="status" className="mx-auto mb-3 max-w-3xl rounded-xl border border-danger-line bg-danger-surface px-3.5 py-2.5 text-xs leading-relaxed text-danger-text">
          This website is offline and will be erased on {new Date(page.data.site.deletionScheduledFor).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })}.
          Nothing can be published until it is restored — <a className="font-semibold underline underline-offset-2" href="/website/account">restore it from your account</a>.
        </p>
      )}
      {mode === "visual" && sitePopups && (sitePopups.hidden > 0 || !sitePopups.hiding) && (
        <p role="status" className="mx-auto mb-3 flex max-w-3xl flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-white px-3.5 py-2 text-xs text-muted">
          <span>
            {sitePopups.hiding
              ? `${sitePopups.hidden} of this site's pop-ups ${sitePopups.hidden === 1 ? "is" : "are"} hidden while you edit — a cookie notice, a chat button or a bar pinned to the screen. Visitors still see ${sitePopups.hidden === 1 ? "it" : "them"}.`
              : "Showing this site's pop-ups, as visitors see them."}
          </span>
          <button
            type="button"
            className="font-semibold text-ink underline underline-offset-2"
            onClick={() => {
              const show = sitePopups.hiding;
              setShowSitePopups(show);
              try { localStorage.setItem("website-editor-site-popups", show ? "show" : "hide"); } catch { /* Optional preference. */ }
              tell({ type: "overlays", hide: !show });
            }}
          >
            {sitePopups.hiding ? "Show them" : "Hide them again"}
          </button>
        </p>
      )}
      {mode === "preview" && (
        <div className="dx-preview-bar">
          Previewing as a visitor
          <button type="button" className="dx-btn dx-soft" onClick={() => setMode("visual")}>Back to editing</button>
        </div>
      )}
      {mode === "visual" && page.data?.drawnByScript && (
        <p role="note" className="mx-auto mb-3 max-w-3xl rounded-xl border border-line bg-white px-3.5 py-2.5 text-xs leading-relaxed text-muted">
          This page is drawn by its own scripts, so the canvas shows it exactly as a visitor sees it and it can't be clicked into.
          Change its words in <button type="button" className="font-semibold text-ink underline underline-offset-2" onClick={() => setMode("edit")}>List</button> mode
          {page.data.builtFrom ? " or under Source files" : ""}.
        </p>
      )}
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
      {mode === "visual" && picked && (
        <WebsiteCanvasOverlay
          stage={canvasRef}
          frame={frame}
          element={pickedElement}
          label={picked.label}
          kind={picked.kind}
          zoom={zoom}
          typing={typingId === picked.id}
          readOnly={readOnly}
          canDuplicate={!readOnly && Boolean(picked.structure?.duplicate)}
          canDelete={!readOnly && Boolean(picked.structure?.remove)}
          hasParent={Boolean(picked.parentId)}
          agent={canEdit && (!tierStatus?.features || tierStatus.features.aiBuilderAgent)}
          onEdit={() => tell({ type: "edit", id: picked.id })}
          onBold={() => formatWhole("bold")}
          onItalic={() => formatWhole("italic")}
          onLink={() => setInspectorTab("content")}
          onReplace={() => { setAssetTargetMode("image"); setAssetModalOpen(true); }}
          onParent={() => picked.parentId && pick(picked.parentId)}
          onAgent={() => setAgentOpen(true)}
          onDuplicate={() => void runStructure("duplicate", picked.id)}
          onDelete={() => void runStructure("remove", picked.id)}
          onFormat={(html) => { change(picked.id, { ...edits[picked.id], value: html }, { fromFrame: true, commit: true }); setFrameEdit((token) => token + 1); }}
        />
      )}
    </div>
  );

  // The one Publish button. Its arrow beside it holds the rest of what
  // happens to the page as a whole: save, download, versions, discard.
  const publishButton = canPublish ? (
    <button
      type="button"
      className="dx-btn dx-go"
      onClick={async () => {
        try {
          if (dirty.current) await save.mutateAsync(latestEdits.current);
          if (dirty.current) {
            setFailure("Your latest edit is still saving. Review once it has saved.");
            return;
          }
          // A demo is DakyXTech's own sales page and goes out in one
          // click. Everything a customer owns goes through the review.
          if (isDemo) {
            publish.mutate({
              revision: revision.current,
              sourceHash: "",
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
        (!isDemo && (changedCount === 0 || !(site.repo || hostedHere)))
      }
    >
      <span className="inline-flex items-center gap-1.5">
        <IconUploadCloud size={14} />
        <span>
          {publish.isPending
            ? "Publishing…"
            : isDemo
              ? changedCount > 0
                ? `Publish & Update Demo (${changedCount})`
                : "Publish & Update Demo"
              : changedCount > 0
                ? `Publish (${changedCount})`
                : "Publish"}
        </span>
      </span>
    </button>
  ) : null;

  /** Bold or italic over the whole of the selected element, from the mini toolbar. Pressed again, it comes off. */
  const formatWhole = (format: TextToggle) => {
    if (!picked || !pickedElement || readOnly) return;
    const range = pickedElement.ownerDocument.createRange();
    range.selectNodeContents(pickedElement);
    if (!applyTextFormat(pickedElement, range, { kind: "toggle", format })) return;
    change(picked.id, { ...edits[picked.id], value: editableInnerHtml(pickedElement) }, { fromFrame: true, commit: true });
    setFrameEdit((token) => token + 1);
  };

  /** Put a chosen file where the selection needs it — a picture, an icon, or a background. */
  const applyAsset = (asset: { url: string; alt?: string; preview?: string }, targetMode: "image" | "background") => {
    if (!picked) return;
    if (asset.preview) selectedMedia.current.set(asset.url, { url: asset.url, preview: asset.preview });
    const previewBackground = `url('${resolveImagePreview(asset.url).replace(/['"\\]/g, "")}')`;
    if (targetMode === "background") {
      const map = parseStyle(pickedStyle ?? "");
      map["background-image"] = `url('${asset.url.replace(/['"\\]/g, "")}')`;
      changePickedStyle(writeStyle(map), true);
      // Also sync any child background layer or cover <img> inside the container in the live iframe
      try {
        const doc = frame.current?.contentDocument;
        const el = doc?.querySelector<HTMLElement>(`[data-dw-field="${CSS.escape(picked.id)}"]`);
        if (el && doc?.defaultView) {
          el.style.backgroundImage = previewBackground;
          if (map["background-size"]) el.style.backgroundSize = map["background-size"];
          if (map["background-position"]) el.style.backgroundPosition = map["background-position"];
          el.querySelectorAll<HTMLElement>("*").forEach((desc) => {
            const bg = doc.defaultView!.getComputedStyle(desc).backgroundImage;
            if (bg && bg !== "none" && /url\(/i.test(bg)) {
              desc.style.backgroundImage = previewBackground;
            }
          });
        }
      } catch {}
    } else if (picked.kind === "icon") {
      change(picked.id, { ...edits[picked.id], icon: { src: asset.url }, value: asset.url }, { commit: true });
    } else {
      const previous = edits[picked.id] ?? {};
      const next: FieldEdit = { ...previous, value: asset.url, alt: asset.alt || previous.alt || picked.alt };
      // An unsized <img> otherwise adopts the new file's natural size.
      // Keep the old box and its crop when replacing the source.
      const image = frame.current?.contentDocument?.querySelector(`[data-dw-field="${CSS.escape(picked.id)}"] img, img[data-dw-field="${CSS.escape(picked.id)}"]`) as HTMLImageElement | null;
      if (picked.kind === "image" && device === "desktop" && image && !image.hasAttribute("width") && !image.hasAttribute("height") && !image.style.width && !image.style.height) {
        const sizing = parseStyle(pickedStyle ?? "");
        if (!sizing.width && !sizing.height) {
          const bounds = image.getBoundingClientRect();
          if (bounds.width > 0 && bounds.height > 0) {
            sizing.width = `${Math.round(bounds.width)}px`;
            sizing.height = `${Math.round(bounds.height)}px`;
            sizing["max-width"] = sizing["max-width"] ?? "100%";
            sizing["object-fit"] = sizing["object-fit"] ?? computed["object-fit"] ?? "fill";
            next.style = writeStyle(sizing);
          }
        }
      }
      change(picked.id, next, { commit: true });
    }
  };

  /** Versions are read against the saved draft, so the draft is saved first. */
  const openVersions = async () => {
    try {
      if (dirty.current) await save.mutateAsync(latestEdits.current);
      if (!dirty.current) { setPanel("history"); setMenu(null); tourAction("versions-opened"); }
    } catch {
      /* Saving reports the failure and preserves local edits. */
    }
  };

  const toggleEditorTheme = () => {
    const next = editorTheme === "dark" ? "light" : "dark";
    setEditorTheme(next);
    try { localStorage.setItem("website-editor-theme", next); } catch { /* Optional preference. */ }
  };

  /** Opening the panel that is already open closes it — the rail is a set of switches. */
  const openPanel = (next: EditorPanel) => {
    setPanel((current) => (current === next ? null : next));
    setMenu(null);
    // A narrow window cannot hold the drawer and the inspector at once.
    if (typeof window !== "undefined" && window.innerWidth <= 1080) pick(null);
  };

  const lockedNotice = (feature: string, status: NonNullable<typeof tierStatus>) => (
    <div className="dx-card warn">
      <h3><IconLock size={13} />Not on the {status.tierName} plan</h3>
      <p className="dx-hint">
        {feature} {feature.endsWith("s") ? "are" : "is"} included from the <b>Pro</b> plan up{status.pricing?.priceDisplay ? ` — you are on ${status.pricing.priceDisplay}/mo` : ""}.
      </p>
      <Link to="/website/balance" className="dx-btn dx-pri" style={{ alignSelf: "flex-start" }}>See plans</Link>
    </div>
  );

  const seoPanel = (section: "seo" | "grow" | "theme") => (
    <WebsitePageSeoInspector
      section={section}
      siteId={site.id}
      pageId={pageId}
      pageTitle={page.data!.page.title}
      pagePath={page.data!.page.path}
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
            next[fix.id] = { ...existing, value: existing.value ?? field?.value ?? "", alt: fix.alt };
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
  );

  const themePanel = (
    <div className="dx-stack">
                  <div className="rounded-xl border border-line bg-surface-2/60 p-3.5 text-left">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] font-bold uppercase tracking-[.06em] text-ink">
                        Page Colors &amp; Theme
                      </span>
                      <span className="text-[11px] text-muted">{pageColorTokens.length} colors</span>
                    </div>
                    <p className="mt-1 text-[11.5px] leading-relaxed text-muted">
                      Click any color picker or edit its #HEX code to update that color across the entire page live.
                    </p>
                    {pageColorTokens.length === 0 ? (
                      <p className="mt-3 rounded-lg border border-line bg-white p-3 text-xs text-muted">
                        No theme tokens or hex colors detected on this page yet.
                      </p>
                    ) : (
                      <div className="mt-3 space-y-2">
                        {pageColorTokens.map((token) => (
                          <div
                            key={token.key}
                            className="flex items-center justify-between gap-2.5 rounded-xl border border-line bg-white px-3 py-2 shadow-2xs"
                          >
                            <span
                              className="min-w-0 flex-1 truncate font-mono text-[11.5px] font-semibold text-ink"
                              title={token.label}
                            >
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
                    )}
                  </div>

                  {/* Global Page Surface & Typography Overrides */}
                  {(() => {
                    const bodyField = allFields.find((f) => f.tag === "body") ?? allFields.find((f) => f.kind === "container");
                    if (!bodyField) return null;
                    const bodyStyle = edits[bodyField.id]?.style ?? bodyField.style ?? "";
                    const bodyMap = parseStyle(bodyStyle);
                    return (
                      <div className="rounded-xl border border-line bg-surface-2/60 p-3.5 text-left">
                        <span className="block text-[11px] font-bold uppercase tracking-[.06em] text-ink">
                          Global Page Surface &amp; Typography
                        </span>
                        <p className="mt-0.5 text-[11px] text-muted">
                          Default background, text color, and font family inherited across the page.
                        </p>
                        <div className="mt-3 space-y-2.5">
                          <div className="flex items-center justify-between gap-2 rounded-xl border border-line bg-white px-3 py-2">
                            <span className="text-xs font-medium text-ink">Page Background</span>
                            <ColorCodeInput
                              label="Page Background"
                              value={bodyMap["background-color"] ?? "#F2EADC"}
                              disabled={readOnly}
                              onChange={(nextHex) => {
                                const nextMap = { ...bodyMap, "background-color": nextHex };
                                change(bodyField.id, { ...edits[bodyField.id], style: writeStyle(nextMap) }, { commit: true });
                              }}
                            />
                          </div>
                          <div className="flex items-center justify-between gap-2 rounded-xl border border-line bg-white px-3 py-2">
                            <span className="text-xs font-medium text-ink">Default Text Color</span>
                            <ColorCodeInput
                              label="Default Text Color"
                              value={bodyMap.color ?? "#12110F"}
                              disabled={readOnly}
                              onChange={(nextHex) => {
                                const nextMap = { ...bodyMap, color: nextHex };
                                change(bodyField.id, { ...edits[bodyField.id], style: writeStyle(nextMap) }, { commit: true });
                              }}
                            />
                          </div>
                        </div>
                      </div>
                    );
                  })()}
      {seoPanel("theme")}
    </div>
  );

  /**
   * The first-edit checklist, read from state. Selecting, changing, looking at
   * a phone and publishing are each something the editor can see happen.
   */
  const firstEditSteps = [
    { label: "Select something on the page", done: everPicked || Boolean(pickedId) },
    { label: "Change its words or style", done: changedCount > 0 || Boolean(published) },
    { label: "Check it on a phone", done: phoneChecked },
    { label: "Publish your changes", done: Boolean(published) },
  ];
  const firstEditDone = firstEditSteps.filter((step) => step.done).length;
  const firstEdit =
    canEdit && !readOnly && !guideHidden && mode === "visual" && !isDemo && firstEditDone < firstEditSteps.length
      ? { steps: firstEditSteps, done: firstEditDone }
      : null;
  const hideGuide = () => {
    setGuideHidden(true);
    try { localStorage.setItem(`website-editor-guide:${user?.id}`, "hidden"); } catch { /* Optional preference. */ }
    showQuickToast("The tours are under Help whenever you want them.");
  };

  return (
    <div className={`website-editor dx-editor editor-${editorTheme} flex h-full min-h-0 flex-col`}>
      {reviewOpen && <PublishReview pageId={pageId} siteId={site.id} hasRepository={Boolean(site.repo)} pending={publish.isPending} onClose={() => setReviewOpen(false)} onConfirm={review => publish.mutate(review)} />}
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
      {showFindReplace && site && (
        <DeferredPanel active={showFindReplace}><WebsiteFindReplaceModal
          siteId={site.id}
          onClose={() => setShowFindReplace(false)}
          onApplied={() => {
            dirty.current = false;
            void qc.invalidateQueries({ queryKey: ["website", "page", pageId] });
            setPreviewToken((token) => token + 1);
          }}
        /></DeferredPanel>
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
      {/* Guided tours (lib/tours.ts): offered once to somebody who can edit,
          started straight away for a customer who has just added a website. */}
      <TourHost scope="editor" offer="editor" autoStart={tourOnArrival} canOffer={canEdit && !readOnly} />
      <HelpDialog open={helpOpen} onClose={() => setHelpOpen(false)} context={page.data?.page.title} />
      {site && (
        <>
          <DeferredPanel active={commentsModalOpen}><WebsiteRevisionCommentsModal
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
          /></DeferredPanel>
          <DeferredPanel active={clientReportOpen}><WebsiteClientReportModal
            open={clientReportOpen}
            onClose={() => setClientReportOpen(false)}
            siteId={site.id}
            pageId={pageId}
          /></DeferredPanel>
        </>
      )}
      <DeferredPanel active={commandPaletteOpen}><WebsiteCommandPaletteModal
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
          setPanel("seo");
        }}
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
      /></DeferredPanel>
      {assetModalOpen && site && picked && (
        <WebsiteAssetPickerModal
          siteId={site.id}
          capturedImages={capturedHtmlImages}
          onSelect={asset => {
            applyAsset(asset, assetTargetMode);
            setAssetModalOpen(false);
          }}
          onClose={() => setAssetModalOpen(false)}
        />
      )}
      {/* ------------------------------------------------------------ bar
          Three groups, and they answer three questions: which page is this
          and is it saved (left), how am I looking at it (middle), and what can
          I do with it (right). Everything that used to sit in More now lives
          on the tool rail, the publish arrow or the account menu. */}
      <header className="dx-top">
        <div className="dx-grp dx-grp-left">
          <Link
            to={isDemo ? "/demos" : "/website/sites"}
            title={isDemo ? "Back to Demos list" : "Back to all pages"}
            aria-label={isDemo ? "Back to Demos" : "Back to Pages"}
            className="dx-ib"
          >
            <IconArrowLeft size={17} />
          </Link>
          <div className="relative min-w-0">
            <button
              type="button"
              className="dx-pagename"
              aria-haspopup="menu"
              aria-expanded={menu === "page"}
              title="Switch page"
              onClick={(event) => { event.stopPropagation(); setMenu(menu === "page" ? null : "page"); }}
            >
              <h1 className="dx-pagename-t"><span className="sr-only">Editing </span>{page.data.page.title}</h1>
              <span className="dx-path">{page.data.page.path}</span>
              <IconChevronDown size={15} />
            </button>
            {menu === "page" && (
              <div className="dx-pop" role="menu" style={{ left: 0 }} onClick={(event) => event.stopPropagation()}>
                <div className="dx-pop-pad">Pages in this website</div>
                {(sitePages.data?.pages ?? []).length === 0 && <div className="dx-pop-pad">Loading pages…</div>}
                {(sitePages.data?.pages ?? []).map((candidate) => (
                  <Link
                    key={candidate.id}
                    role="menuitem"
                    to={`/website/pages/${candidate.id}`}
                    onClick={() => { if (dirty.current) saveNow(latestEdits.current); setMenu(null); }}
                    className={`dx-row${candidate.id === pageId ? " sel" : ""}`}
                  >
                    <IconFileText size={15} />
                    <span className="truncate">{candidate.title || candidate.path}</span>
                    <small>{candidate.path}</small>
                  </Link>
                ))}
                <hr />
                <Link role="menuitem" to="/website/sites" className="dx-row" onClick={() => setMenu(null)}>
                  <IconLayout size={15} />
                  <span>All pages and settings</span>
                </Link>
              </div>
            )}
          </div>
          <span
            data-tour="save-status"
            className={`dx-status${dirty.current || changedCount > 0 ? " dirty" : ""}`}
            title={page.data.builtFrom ? `Built from ${page.data.builtFrom.filePath}${page.data.builtFrom.detail ? ` — ${page.data.builtFrom.detail}` : ""}` : status}
          >
            <span className="dx-dot" />
            <span className="dx-hide-md truncate">{status}</span>
          </span>
          {latestReview && (
            <button
              type="button"
              onClick={() => setReviewOpen(true)}
              title={latestReview.feedback ? `“${latestReview.feedback}”` : "Open the review to see what was sent and any comments"}
              className={`dx-badge dx-hide-md ${latestReviewStatus!.tone === "positive" ? "ok" : latestReviewStatus!.tone === "warn" ? "warn" : ""}`}
            >
              {latestReview.reviewerName && latestReview.status !== "PENDING" ? `${latestReview.reviewerName}: ` : ""}{latestReviewStatus!.text}
            </button>
          )}
          {peers.length > 0 && (
            <div className="dx-peers dx-hide-md" title={`${peers.map((p) => p.name).join(", ")} currently viewing this page`}>
              {peers.map((peer) => (
                <span key={peer.userId} style={{ backgroundColor: peer.color }} title={peer.name}>{peer.name.slice(0, 2).toUpperCase()}</span>
              ))}
            </div>
          )}
        </div>

        <div className="dx-grp dx-grp-mid">
          <div className="relative" data-tour="modes">
            <button
              type="button"
              className="dx-modebtn"
              aria-haspopup="menu"
              aria-expanded={menu === "mode"}
              aria-label={`Editor mode: ${MODES.find((option) => option.key === mode)?.label}`}
              title="Editor mode"
              onClick={(event) => { event.stopPropagation(); setMenu(menu === "mode" ? null : "mode"); }}
            >
              {mode === "visual" ? <IconEdit size={15} /> : mode === "edit" ? <IconList size={15} /> : <IconEye size={15} />}
              <span>{MODES.find((option) => option.key === mode)?.label}</span>
              <IconChevronDown size={14} />
            </button>
            {menu === "mode" && (
              <div className="dx-pop" role="menu" style={{ left: 0, minWidth: 260 }} onClick={(event) => event.stopPropagation()}>
                {MODES.map((option) => (
                  <button
                    key={option.key}
                    type="button"
                    role="menuitemradio"
                    aria-checked={mode === option.key}
                    aria-label={option.label}
                    className="dx-mrow"
                    onClick={() => {
                      if (option.key !== "edit" && dirty.current) saveNow(edits);
                      setPreviewToken((token) => token + 1);
                      setMode(option.key);
                      setMenu(null);
                    }}
                  >
                    {option.key === "visual" ? <IconEdit size={16} /> : option.key === "edit" ? <IconList size={16} /> : <IconEye size={16} />}
                    <div>
                      <b>{option.label}</b>
                      <span>{option.key === "visual" ? "Click and edit on the page" : option.key === "edit" ? "Every word and link on the page as a list" : "See the page as a visitor would"}</span>
                    </div>
                    <IconCheck size={14} className="dx-ck" />
                  </button>
                ))}
              </div>
            )}
          </div>
          {mode !== "edit" && (
            <div className="dx-seg dx-hide-sm" role="group" aria-label="Screen size" data-walkthrough="viewports" data-tour="devices">
              {DEVICES.map((option) => {
                const DeviceIcon = option.key === "desktop" ? IconDesktop : option.key === "tablet" ? IconTablet : IconPhoneDevice;
                return (
                  <button
                    key={option.key}
                    type="button"
                    className="dx-ib"
                    title={`${option.label} viewport`}
                    aria-label={option.label}
                    aria-pressed={device === option.key}
                    onClick={() => setDevice(option.key)}
                  >
                    <DeviceIcon size={16} />
                  </button>
                );
              })}
            </div>
          )}
          {mode !== "edit" && (
            <select
              aria-label="Canvas zoom"
              title="Canvas zoom level"
              value={zoom}
              onChange={(event) => setZoom(Number(event.target.value))}
              className="dx-zoom dx-hide-md"
            >
              {[0.5, 0.75, 1, 1.25, 1.5].map((value) => (
                <option key={value} value={value}>{value * 100}%</option>
              ))}
            </select>
          )}
        </div>

        <div className="dx-grp dx-grp-right">
          <button
            type="button"
            className="dx-search dx-hide-sm"
            data-tour="search"
            title="Search every tool, and everything on this page (Ctrl+K / Cmd+K)"
            aria-label="Command palette"
            onClick={() => setCommandPaletteOpen(true)}
          >
            <IconSearch size={15} />
            <span className="dx-hide-md">Search tools</span>
            <kbd className="dx-hide-md">⌘K</kbd>
          </button>
          <button
            type="button"
            className="dx-ib"
            title="Undo (Ctrl+Z)"
            aria-label="Undo"
            disabled={readOnly || save.isPending || (!historyState.canUndo && !page.data.structure?.canUndo)}
            onClick={() => restore(-1)}
          >
            <IconUndo size={16} />
          </button>
          <button
            type="button"
            className="dx-ib dx-hide-sm"
            title="Redo (Ctrl+Shift+Z)"
            aria-label="Redo"
            disabled={readOnly || save.isPending || (!historyState.canRedo && !page.data.structure?.canRedo)}
            onClick={() => restore(1)}
          >
            <IconRedo size={16} />
          </button>
          <button
            type="button"
            className="dx-ib dx-hide-sm"
            title="Reload the page from the site"
            aria-label="Reload"
            onClick={() => {
              if (dirty.current) saveNow(edits);
              void qc.invalidateQueries({ queryKey: ["website", "page", pageId] });
              setPreviewToken((token) => token + 1);
            }}
          >
            <IconRefresh size={16} />
          </button>
          {canEdit && design.data?.options.aiEnabled && (
            <button type="button" className="dx-ib dx-hide-sm" title="Suggest changes to this page" aria-label="Assistant" onClick={() => setShowAI(true)}>
              <IconSparkles size={16} />
            </button>
          )}
          {/* Drafts save themselves; the button is for a keyboard's Ctrl+S habit. */}
          {canEdit && (
            <button
              type="button"
              className="dx-btn dx-ghost dx-hide-sm"
              title="Save draft (Ctrl/Cmd+S)"
              aria-label="Save"
              disabled={save.isPending || readOnly}
              onClick={() => saveNow(latestEdits.current)}
            >
              <IconSave size={15} />
              <span className="dx-hide-md">Save</span>
            </button>
          )}
          <div className="relative flex" data-walkthrough="publish" data-tour="publish">
            {publishButton}
            <button
              type="button"
              className={publishButton ? "dx-btn dx-go-more" : "dx-btn dx-ghost"}
              aria-label="More publish options"
              aria-haspopup="menu"
              aria-expanded={menu === "publish"}
              onClick={(event) => { event.stopPropagation(); setMenu(menu === "publish" ? null : "publish"); }}
            >
              {publishButton ? <IconChevronDown size={15} /> : <><IconMoreHorizontal size={15} /><span>More</span></>}
            </button>
            {menu === "publish" && (
              <div className="dx-pop" role="menu" style={{ right: 0 }} onClick={(event) => event.stopPropagation()}>
                {canEdit && (
                  <button type="button" role="menuitem" className="dx-row" disabled={save.isPending || readOnly} onClick={() => { saveNow(latestEdits.current); setMenu(null); }}>
                    <IconSave size={15} /><span>Save draft only</span><small>Ctrl+S</small>
                  </button>
                )}
                {liveDemoHref && (isDemo || hostedHere) && (
                  <a role="menuitem" className="dx-row" href={liveDemoHref} target="_blank" rel="noreferrer" onClick={() => setMenu(null)}>
                    <IconExternalLink size={15} /><span>{isDemo ? "Open live demo" : "View live website"}</span>
                  </a>
                )}
                {!isDemo && !hostedHere && page.data.page.url && (
                  <a role="menuitem" className="dx-row" href={page.data.page.url} target="_blank" rel="noreferrer" onClick={() => setMenu(null)}>
                    <IconExternalLink size={15} /><span>Open the live page</span>
                  </a>
                )}
                <a
                  role="menuitem"
                  className="dx-row"
                  href={demoIdFromUrl ? `/api/demos/${demoIdFromUrl}/download` : apiUrl(`/website/pages/${pageId}/export`)}
                  download={demoIdFromUrl ? `${page.data.page.filePath || "demo.html"}` : true}
                  onClick={(event) => {
                    if (dirty.current || save.isPending) {
                      event.preventDefault();
                      setFailure("Wait for the current changes to save before downloading.");
                    }
                    setMenu(null);
                  }}
                >
                  <IconDownload size={15} /><span>Download .html</span>
                </a>
                <button type="button" role="menuitem" className="dx-row" aria-label="Versions" disabled={save.isPending || publish.isPending || structureBusy} onClick={() => { setMenu(null); void openVersions(); }}>
                  <IconHistory size={15} /><span>Version history</span>
                </button>
                <button type="button" role="menuitem" className="dx-row" onClick={() => { setMenu(null); setShowFindReplace(true); }}>
                  <IconSearch size={15} /><span>Find &amp; replace across the site</span>
                </button>
                {changedCount > 0 && !readOnly && (
                  <>
                    <hr />
                    <button
                      type="button"
                      role="menuitem"
                      aria-label="Discard"
                      className="dx-row danger"
                      disabled={discard.isPending || save.isPending || publish.isPending}
                      onClick={() => {
                        setMenu(null);
                        if (window.confirm("Discard all unpublished changes on this page? The live website stays unchanged.")) discard.mutate();
                      }}
                    >
                      <IconTrash size={15} /><span>Discard</span>
                    </button>
                  </>
                )}
                <hr />
                <div className="dx-pop-pad">
                  {page.data.page.lastPublishedAt ? <>Last published <b><RelativeTime value={page.data.page.lastPublishedAt} /></b></> : "Not published from here yet"}
                </div>
              </div>
            )}
          </div>
          <div className="relative">
            <button
              type="button"
              className="dx-avatar"
              aria-label="Account and editor settings"
              aria-haspopup="menu"
              aria-expanded={menu === "account"}
              title="Account, plan and editor settings"
              onClick={(event) => { event.stopPropagation(); setMenu(menu === "account" ? null : "account"); }}
            >
              {(user?.name || user?.email || "You").split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase()}
            </button>
            {menu === "account" && (
              <div className="dx-pop" role="menu" style={{ right: 0, minWidth: 280 }} onClick={(event) => event.stopPropagation()}>
                <div className="dx-pop-pad"><b>{user?.name || "Your account"}</b>{user?.email && <span>{user.email}</span>}</div>
                {tierStatus && (
                  <>
                    <hr />
                    <div className="dx-pop-pad">
                      <div className="dx-kv"><span>Plan</span><b>{tierStatus.tierName}</b></div>
                      {tierStatus.usage.editsLimit !== null && <div className="dx-kv"><span>Edits left</span><b>{tierStatus.usage.editsRemaining}</b></div>}
                      <Link to="/website/balance" className="dx-link" onClick={() => setMenu(null)}>Plan, invoices and upgrades</Link>
                    </div>
                  </>
                )}
                <hr />
                <label className="dx-row dx-switch">
                  <span className="inline-flex items-center gap-2"><IconSliders size={15} />Designer controls</span>
                  <input
                    type="checkbox"
                    aria-label="Designer controls"
                    checked={designerMode}
                    onChange={(event) => {
                      setDesignerMode(event.target.checked);
                      try { localStorage.setItem(`website-designer:${user?.id}`, event.target.checked ? "yes" : "no"); } catch { /* Optional preference. */ }
                    }}
                  />
                </label>
                <button type="button" role="menuitem" className="dx-row" aria-label={`Use ${editorTheme === "dark" ? "light" : "dark"} editor`} onClick={toggleEditorTheme}>
                  {editorTheme === "dark" ? <IconSun size={15} /> : <IconMoon size={15} />}
                  <span>Use {editorTheme === "dark" ? "light" : "dark"} editor</span>
                </button>
                <hr />
                <Link role="menuitem" to="/website/account" className="dx-row" onClick={() => setMenu(null)}>
                  <IconUsers size={15} /><span>Account</span>
                </Link>
              </div>
            )}
          </div>
        </div>
      </header>


      {(published || failure) && (
        <div className="flex-none border-b border-line px-4 py-3">
          {published && (
            <div className="rounded-xl border border-line bg-white p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-semibold text-ink">
                  {isDemo
                    ? `Demo updated (version ${published.version}) — refresh the live demo to see your changes.`
                    : published.hosted
                      ? `Published — version ${published.version}, ${published.changed} change${published.changed === 1 ? "" : "s"}.`
                      : `Changes sent — version ${published.version}, ${published.changed} change${published.changed === 1 ? "" : "s"}.`}
                </p>
                {isDemo && (
                  <div className="flex flex-wrap items-center gap-2">
                    {liveDemoHref && <a
                      href={liveDemoHref}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 rounded-lg border border-blue/30 bg-blue/10 px-2.5 py-1 text-xs font-semibold text-blue hover:bg-blue/15"
                    >
                      <IconEye size={12} />
                      <span>Open Live Demo</span>
                    </a>}
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
              {/* For a hosted page the progress panel below says the same thing. */}
              {!(published.hosted && published.job) && <p className="mt-1 text-xs text-muted">{published.note}</p>}
              {/* A commit is not a deployment, and until this says so the only
                  honest claim is that the change is in the repository. */}
              {published.job && <PublishStatus siteId={site.id} jobId={published.job.id} />}
              {/* Only a repository has a rebuild to wait for. A hosted page is
                  served from here and is already what visitors get. */}
              {!published.hosted && !isDemo && (
                <p className="mt-1 text-xs text-muted">
                  This screen reads the page back from the published site, so it goes on showing the old words until that rebuild
                  finishes. It will catch up on its own; the circular arrow in the bar looks again now.
                </p>
              )}
              <div className="mt-2 flex flex-wrap items-center gap-4 text-xs">
                {published.prUrl ? (
                  <a href={published.prUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-semibold text-blue underline-offset-2 hover:underline">
                     View Pull Request #{published.prNumber} on GitHub
                  </a>
                ) : published.url ? (
                  <a href={published.url} target="_blank" rel="noreferrer" className="text-ink underline-offset-2 hover:underline">
                    Open the live page
                  </a>
                ) : null}
                {published.commit.url && (
                  <a href={published.commit.url} target="_blank" rel="noreferrer" className="text-muted underline-offset-2 hover:underline">
                    {published.mode === "pull_request" ? "See PR commit" : "See the commit"}
                  </a>
                )}
              </div>
            </div>
          )}
          {failure && <div className="rounded-xl border border-warn-line bg-warn-surface px-3.5 py-2.5 text-sm text-warn-text">{failure}</div>}
        </div>
      )}

      {/* ---------------------------------------------------------- body */}
      {/* ---------------------------------------------------------- body
          Tool rail · one drawer at a time · the page · the thing you picked. */}
      <div className={`dx-body${mode === "preview" ? " is-preview" : ""}`}>
        {mode !== "preview" && (
          <nav className="dx-rail" aria-label="Tools" data-tour="more">
            {RAIL.map((item) => (
              <button
                key={item.key}
                type="button"
                title={item.title}
                aria-label={item.label}
                aria-pressed={panel === item.key}
                onClick={() => openPanel(item.key)}
              >
                <item.icon size={18} />
                {item.label}
              </button>
            ))}
            <button type="button" title="Revision notes for this page" aria-label="Notes" aria-pressed={panel === "notes"} onClick={() => openPanel("notes")}>
              <IconMessageSquare size={18} />Notes
            </button>
            <span className="dx-rail-sp" />
            <button type="button" title="Every earlier version of this page" aria-label="History" aria-pressed={panel === "history"} disabled={save.isPending || publish.isPending || structureBusy} onClick={() => void openVersions()}>
              <IconHistory size={18} />History
            </button>
            <button type="button" title="Tours, the guide and a person to ask" aria-label="Help" aria-pressed={panel === "help"} onClick={() => openPanel("help")}>
              <IconBookOpen size={18} />Help
            </button>
          </nav>
        )}

        {panel && mode !== "preview" && (
          <aside className="dx-drawer" aria-label={`${RAIL_TITLES[panel].title} panel`}>
            <div className="dx-dh">
              <div>
                <h2>{RAIL_TITLES[panel].title}</h2>
                <p>{RAIL_TITLES[panel].sub}</p>
              </div>
              <button type="button" className="dx-ib" aria-label="Close panel" onClick={() => setPanel(null)}>
                <IconXCircle size={16} />
              </button>
            </div>
            <div className={`dx-dbody${panel === "layers" ? " is-flush" : ""}`}>
              {panel === "layers" && (
                <WebsiteLayers
                  fields={allFields}
                  edits={edits}
                  problems={problems}
                  shared={page.data.shared?.scope}
                  selectedId={pickedId}
                  onSelect={(id) => { if (mode !== "visual") setMode("visual"); pick(id); }}
                  onClose={() => setPanel(null)}
                  onToggleVisibility={
                    readOnly
                      ? undefined
                      : (targetId) => {
                          const targetField = allFields.find((f) => f.id === targetId);
                          if (!targetField) return;
                          const map = parseStyle(edits[targetId]?.style ?? targetField.style ?? "");
                          if (map.display === "none") delete map.display;
                          else map.display = "none";
                          change(targetId, { ...edits[targetId], style: writeStyle(map) }, { commit: true });
                        }
                  }
                  onMove={!designerMode || readOnly || save.isPending ? undefined : (id, target, position) => void runStructure(position, id, target)}
                />
              )}
              {panel === "theme" && (tierStatus?.features && !tierStatus.features.themeSettings ? lockedNotice("Site colours and page surface", tierStatus) : themePanel)}
              {panel === "media" && (
                <>
                  <p className="dx-hint">
                    {picked && (picked.kind === "image" || picked.kind === "icon" || picked.kind === "container")
                      ? `Choosing a file here puts it in “${picked.label}”.`
                      : "Select a picture on the page, then choose a file here to swap it. Uploads land in the library either way."}
                  </p>
                  <WebsiteAssetLibrary
                    siteId={site.id}
                    capturedImages={capturedHtmlImages}
                    onSelect={(asset) => {
                      if (!picked || readOnly || !(picked.kind === "image" || picked.kind === "icon" || picked.kind === "container")) {
                        showQuickToast("Select a picture on the page first, then choose it here.");
                        return;
                      }
                      applyAsset(asset, picked.kind === "container" ? "background" : "image");
                      showQuickToast(`Picture placed in ${picked.label}`);
                    }}
                  />
                </>
              )}
              {(panel === "seo" || panel === "grow") && (tierStatus?.features && !tierStatus.features.seoInspector
                ? lockedNotice(panel === "seo" ? "Page SEO and structured data" : "Speed, uptime and lead tools", tierStatus)
                : seoPanel(panel))}
              {panel === "notes" && (
                <WebsiteNotesPanel
                  siteId={site.id}
                  pageId={pageId}
                  selectedFieldId={picked ? picked.id : null}
                  selectedFieldLabel={picked ? picked.label : null}
                  onSelectField={(fieldId) => { setMode("visual"); pick(fieldId); }}
                />
              )}
              {panel === "history" && (
                <WebsiteVersions
                  inline
                  pageId={pageId}
                  siteId={site.id}
                  draftRevision={revision.current}
                  draftNote={status}
                  onClose={() => setPanel(null)}
                  onRestored={() => {
                    dirty.current = false;
                    try { sessionStorage.removeItem(localDraftKey); } catch { /* Optional recovery storage. */ }
                    setPublished(null);
                    void qc.invalidateQueries({ queryKey: ["website", "page", pageId] });
                    setPreviewToken((token) => token + 1);
                  }}
                />
              )}
              {panel === "help" && (
                <div className="dx-stack">
                  {(["editor", "publishing", "pictures"] as const).map((id) => (
                    <button key={id} type="button" className="dx-row" onClick={() => { setPanel(null); startTour(id); }}>
                      <IconSparkles size={15} className={tourSeen(uiState, id) ? "" : "text-blue"} />
                      <span className="flex-1">{TOURS[id].title}</span>
                      {uiState.tours?.[id]?.status === "done" ? <IconCheck size={13} aria-label="Taken" /> : <small>{TOURS[id].minutes} min</small>}
                    </button>
                  ))}
                  <a href="https://dakyx.com/website-builder-setup" target="_blank" rel="noreferrer" className="dx-row">
                    <IconBookOpen size={15} /><span>Setup guide</span><IconExternalLink size={13} />
                  </a>
                  <button type="button" className="dx-row" onClick={() => setHelpOpen(true)}>
                    <IconMessageCircle size={15} /><span>Talk to a person</span>
                  </button>
                  <div className="dx-card">
                    <h3>Keyboard shortcuts</h3>
                    {[
                      ["Search tools", "Ctrl+K"],
                      ["Save draft", "Ctrl+S"],
                      ["Undo", "Ctrl+Z"],
                      ["Redo", "Ctrl+Shift+Z"],
                      ["Publish", "Ctrl+Enter"],
                      ["Type into text", "Double-click"],
                      ["Stop typing", "Esc"],
                    ].map(([action, keys]) => (
                      <div key={action} className="dx-kv"><span>{action}</span><kbd>{keys}</kbd></div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </aside>
        )}

        {mode === "edit" ? (
          <div className="dx-listview">
            <div className="dx-listwrap">
              <p className="dx-hint">Every word, link and picture on the page, section by section. Edit here and it updates on the page.</p>
              {sections.length === 0 && <p className="dx-hint">This page has nothing editable on it.</p>}
              {sections.map((candidate) => (
                <details key={candidate.id} className="dx-card dx-listcard" open>
                  <summary>
                    <h3>{candidate.label}</h3>
                    <span className="dx-badge">{candidate.fields.length} item{candidate.fields.length === 1 ? "" : "s"}</span>
                    {candidate.fields.some((field) => edits[field.id]) && <span className="dx-sec-dot" aria-label="Changed here" />}
                  </summary>
                  {candidate.fields.map((field) => (
                    <FieldRow
                      key={`${loadToken}:${field.id}`}
                      field={field}
                      edit={edits[field.id]}
                      problem={problems.get(field.id)}
                      siteId={site.id}
                      publicUrl={page.data.page.url}
                      resolveImagePreview={resolveImagePreview}
                      links={links ?? []}
                      readOnly={readOnly}
                      onChange={(next) => change(field.id, next)}
                      onNameFields={() => void nameFields()}
                      naming={naming}
                      onOpenMediaLibrary={() => {
                        pick(field.id);
                        setAssetTargetMode(field.kind === "container" ? "background" : "image");
                        setAssetModalOpen(true);
                      }}
                    />
                  ))}
                </details>
              ))}
            </div>
          </div>
        ) : (
          <main className="dx-stage">
            {canvas}
            {/* The first-edit checklist. Every tick is read from what has
                actually happened on this page — nothing here is ticked by
                hand, so it cannot say "done" about something that was not. */}
            {firstEdit && (
              <div className="dx-guide" role="region" aria-label="First edit checklist">
                <header>
                  <span>First edit · {firstEdit.done}/{firstEdit.steps.length}</span>
                  <button type="button" className="dx-ib" aria-label="Put the checklist away" onClick={hideGuide}>
                    <IconXCircle size={14} />
                  </button>
                </header>
                <div className="dx-guide-bar"><b style={{ width: `${(firstEdit.done / firstEdit.steps.length) * 100}%` }} /></div>
                <ol>
                  {firstEdit.steps.map((step, index) => (
                    <li key={step.label} className={step.done ? "done" : index === firstEdit.done ? "now" : ""}>
                      <span className="dx-bx">{step.done && <IconCheck size={10} />}</span>
                      {step.label}
                    </li>
                  ))}
                </ol>
                <button type="button" className="dx-tourcta" onClick={() => startTour("editor")}>
                  <IconSparkles size={14} />Take the editor tour
                </button>
              </div>
            )}
            {canEdit && (!tierStatus?.features || tierStatus.features.aiBuilderAgent) && !agentOpen && (
              <button
                type="button"
                className="dx-ai"
                data-tour="agent"
                title="Builder agent — describe a change and it makes it"
                aria-label="Builder agent"
                aria-pressed={agentOpen}
                onClick={() => setAgentOpen(true)}
              >
                <IconBot size={21} />
              </button>
            )}
          </main>
        )}

        {mode === "visual" && picked && (
          <aside data-walkthrough="inspector" data-tour="inspector" aria-label="Element inspector" className="dx-insp editor-sidebar">
            <div className="dx-ih">
              <div className="dx-ih-t">
                <span className="dx-kind">{picked.tag}</span>
                <span className="min-w-0 flex-1 truncate">{picked.label}</span>
                <button type="button" className="dx-ib" onClick={() => pick(null)} aria-label="Clear the selection" title="Clear the selection">
                  <IconXCircle size={15} />
                </button>
              </div>
              <WebsiteBreadcrumbs fields={allFields} selectedId={pickedId} onSelect={pick} />
            </div>
            {page.data.builtFrom?.problem && <p role="alert" className="dx-note warn">{page.data.builtFrom.problem}</p>}
            {liveBlind && (
              <p className="dx-note warn">
                The page beside this is not keeping up as you type. Your changes are being saved — it will catch up a moment after each one.
              </p>
            )}
            {page.data.structure?.stale && <p role="alert" className="dx-note warn">The source changed after these layout edits. Your draft is preserved. Discard it to work from the latest source; publishing is blocked.</p>}
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
            <div role="tablist" aria-label="Element settings" className="editor-tabs dx-tabs">
              {(picked.kind === "container" ? (["layout", "style", "interactions"] as const) : (["content", "style", "interactions"] as const)).map((tab) => (
                <button type="button" role="tab" key={tab} aria-selected={inspectorTab === tab} onClick={() => setInspectorTab(tab)}>
                  {tab[0].toUpperCase() + tab.slice(1)}
                </button>
              ))}
            </div>
            <div className="editor-controls min-h-0 flex-1 overflow-y-auto">
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
                  <div hidden={inspectorTab !== "style" && inspectorTab !== "layout"} className="dx-scope-wrap">
                    {inspectorTab === "style" && (
                      <div className="dx-states" data-tour="style-states">
                        <Seg label="Pick a state to style" value={styleState} options={[{ value: "normal", label: "Normal" }, { value: "hover", label: "Hover" }]} onChange={setStyleState} />
                      </div>
                    )}
                    <div className="dx-scope" title="Desktop styles apply to every screen unless you change them on tablet or phone">
                      {device === "desktop" ? <IconDesktop size={15} /> : device === "tablet" ? <IconTablet size={15} /> : <IconPhoneDevice size={15} />}
                      Editing <b>{device === "desktop" ? "Desktop · all screens" : device === "tablet" ? "Tablet and smaller" : "Phone only"}</b>
                      <span className="dx-dim">{computed.width ? `${parseInt(computed.width)} × ${parseInt(computed.height || "0")}` : "—"}</span>
                    </div>
                    {device !== "desktop" && /!\s*important/i.test(edits[picked.id]?.style ?? picked.style ?? "") && (
                      <p className="dx-note warn">
                        This element has a base style marked !important, so that property keeps its base value at every size until you change it under Desktop.
                      </p>
                    )}
                  </div>

                  {/* One inspector, drawn from what the element is. The frame is
                      what knows that — its display, its parent's, whether it has
                      words of its own — and when the frame cannot be reached the
                      field row is the only thing left to go on. */}
                  {!readOnly && inspectorTab === "style" && styleState === "normal" && <div className="dx-pad" style={{ paddingBottom: 4 }}><WebsitePresetPicker compact presets={design.data?.options.presets ?? []} kind={picked.kind} tag={picked.tag} style={pickedStyle ?? ""} onApply={next => changePickedStyle(next, true)} /></div>}
                  {inspectorTab === "interactions" && (
                    <WebsiteMotionPanel
                      element={pickedElement}
                      style={edits[picked.id]?.style ?? picked.style ?? ""}
                      kind={picked.kind}
                      href={edits[picked.id]?.href ?? picked.href ?? ""}
                      pages={(links ?? []).map((link) => ({ label: link.title || link.path, href: link.path }))}
                      readOnly={readOnly}
                      onChange={(style) => change(picked.id, { ...edits[picked.id], style }, { commit: true })}
                      onHref={(href) => change(picked.id, { ...edits[picked.id], value: edits[picked.id]?.value ?? picked.value, href }, { commit: true })}
                    />
                  )}
                  {inspectorTab === "style" && styleState === "hover" && (
                    <WebsiteHoverPanel
                      element={pickedElement}
                      style={edits[picked.id]?.style ?? picked.style ?? ""}
                      readOnly={readOnly}
                      onChange={(style) => change(picked.id, { ...edits[picked.id], style }, { commit: true })}
                    />
                  )}
                  {inspectorTab === "style" && styleState === "normal" && (
                    <WebsiteStylePanel
                      key={`${picked.id}:${device}`}
                      style={pickedStyle ?? ""}
                      computed={computed}
                      fonts={design.data?.options.fonts}
                      kind={picked.kind}
                      tag={picked.tag}
                      readOnly={readOnly}
                      onChange={(next, commit) => changePickedStyle(next, commit)}
                      onCommit={() => commitHistory(latestEdits.current)}
                      onPickBackgroundImage={() => {
                        setAssetTargetMode("background");
                        setAssetModalOpen(true);
                      }}
                    />
                  )}
                  <div hidden={inspectorTab === "interactions" || inspectorTab === "style"}><ElementInspector
                    tab={inspectorTab === "layout" ? "layout" : inspectorTab === "style" ? "style" : "content"}
                    simple={!designerMode}
                    sitePublicUrl={page.data.page.url}
                    resolveImagePreview={resolveImagePreview}
                    onTextColour={colour => !readOnly && formatActiveText({ color: colour })}
                    onPickBackgroundImage={() => {
                      setAssetTargetMode("background");
                      setAssetModalOpen(true);
                    }}
                    onSetBackgroundImageUrl={(nextUrl) => {
                      const previewBackground = nextUrl ? `url('${resolveImagePreview(nextUrl).replace(/['"\\]/g, "")}')` : "none";
                      try {
                        const doc = frame.current?.contentDocument;
                        const el = doc?.querySelector<HTMLElement>(`[data-dw-field="${CSS.escape(picked.id)}"]`);
                        if (el && doc?.defaultView) {
                          el.style.backgroundImage = previewBackground;
                          el.querySelectorAll<HTMLElement>("*").forEach((desc) => {
                            const bg = doc.defaultView!.getComputedStyle(desc).backgroundImage;
                            if (bg && bg !== "none" && /url\(/i.test(bg)) {
                              desc.style.backgroundImage = previewBackground;
                            }
                          });
                        }
                      } catch {}
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
                    palette={pagePalette}
                    fonts={design.data?.options.fonts}
                    readOnly={readOnly}
                    onChange={(next) => changePickedStyle(next)}
                    onCommit={() => commitHistory(edits)}
                    onReset={() => changePickedStyle(device === "desktop" ? picked.style ?? "" : picked.responsive?.[device] ?? "", true)}
                    content={
                      <>
                        {(picked.kind === "image" ||
                          picked.kind === "icon" ||
                          (picked.kind === "container" &&
                            (/url\(/i.test(pickedStyle ?? "") ||
                              /url\(/i.test(picked.style ?? "") ||
                              /url\(/i.test(computed["background-image"] ?? "")))) &&
                          (() => {
                          const isContainer = picked.kind === "container";
                          const isIcon = picked.kind === "icon";
                          const bgMatch = /url\(\s*['"]?([^'")]+)['"]?\s*\)/i.exec(pickedStyle ?? picked.style ?? computed["background-image"] ?? "");
                          const containerBgUrl = bgMatch?.[1] ?? "";
                          const iconChoice = edits[picked.id]?.icon;
                          const rawImgVal = isContainer
                            ? containerBgUrl
                            : isIcon
                              ? (iconChoice && "src" in iconChoice ? iconChoice.src : (edits[picked.id]?.value ?? picked.value ?? ""))
                              : (edits[picked.id]?.value ?? picked.value ?? "").trim();
                          const resolvedImgUrl = (() => {
                            if (isIcon && iconChoice && "library" in iconChoice) {
                              const lib = libraryIcon(iconChoice.library);
                              return lib ? svgPreviewSrc(libraryIconMarkup(lib)) : "";
                            }
                            if (isIcon && (!rawImgVal || !/^(?:https?:|\/|data:)/i.test(rawImgVal) || rawImgVal.includes("brand-face"))) {
                              const iconSrc = iconPreviewSrc(picked.icon || picked.value, page.data?.page?.url || "");
                              if (iconSrc) return iconSrc;
                            }
                            return resolveImagePreview(rawImgVal);
                          })();
                          const styleMap = parseStyle(pickedStyle ?? "");
                          const currentFit = isContainer
                            ? (styleMap["background-size"] ?? "cover")
                            : (styleMap["object-fit"] ?? computed["object-fit"] ?? "cover");
                          const currentAlt = edits[picked.id]?.alt ?? picked.alt ?? "";
                          const currentHref = edits[picked.id]?.href ?? picked.href ?? "";

                          const posKey = isContainer ? "background-position" : "object-position";
                          const currentPos = styleMap[posKey] ?? "";
                          const focal = /^(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%$/.exec(currentPos);
                          const writePos = (next: string) => {
                            const nextMap = { ...styleMap };
                            if (next) nextMap[posKey] = next;
                            else delete nextMap[posKey];
                            changePickedStyle(writeStyle(nextMap), true);
                            try {
                              const target = frame.current?.contentDocument?.querySelector<HTMLElement>(`[data-dw-field="${CSS.escape(picked.id)}"]`);
                              if (target) {
                                if (isContainer) target.style.backgroundPosition = next;
                                else { target.style.objectPosition = next; target.querySelector<HTMLElement>("img, video")?.style.setProperty("object-position", next); }
                              }
                            } catch { /* The frame may be reloading. */ }
                          };
                          const openLibrary = () => {
                            setAssetTargetMode(isContainer ? "background" : "image");
                            setAssetModalOpen(true);
                          };

                          return (
                            <div className="dx-stack" style={{ marginBottom: 12 }}>
                              <div
                                className="dx-imgprev"
                                role="button"
                                tabIndex={0}
                                aria-label="Set the focal point: click the part of the picture that must stay in view"
                                title="Click to set the focal point"
                                onClick={(event) => {
                                  if (readOnly) return;
                                  const box = event.currentTarget.getBoundingClientRect();
                                  const x = Math.round(((event.clientX - box.left) / box.width) * 100);
                                  const y = Math.round(((event.clientY - box.top) / box.height) * 100);
                                  writePos(`${x}% ${y}%`);
                                  showQuickToast(`Focal point ${x}% × ${y}%`);
                                }}
                                onKeyDown={(event) => { if ((event.key === "Enter" || event.key === " ") && !readOnly) { event.preventDefault(); openLibrary(); } }}
                              >
                                {resolvedImgUrl ? <img src={resolvedImgUrl} alt={currentAlt || (isIcon ? "Selected icon" : "Selected image")} /> : <span className="dx-hint">No picture yet</span>}
                                <span className="dx-fp" style={{ left: `${focal ? focal[1] : 50}%`, top: `${focal ? focal[2] : 50}%` }} />
                              </div>
                              {!readOnly && (
                                <>
                                  <div className="dx-g2">
                                    <button type="button" data-tour="image-replace" className="dx-btn dx-pri" onClick={openLibrary}>Replace</button>
                                    <button type="button" className="dx-btn dx-ghost" onClick={openLibrary}>Upload</button>
                                  </div>
                                  <button type="button" className="dx-btn dx-soft dx-full" onClick={openLibrary}>Media library ({capturedHtmlImages.length})</button>
                                </>
                              )}
                              {!isContainer && !isIcon && (
                                <>
                                  <div className="dx-f">
                                    <div className="dx-fl"><label htmlFor="dx-img-url">Image URL</label></div>
                                    <input
                                      id="dx-img-url"
                                      type="text"
                                      disabled={readOnly}
                                      placeholder="/assets/… or https://…"
                                      value={rawImgVal}
                                      onChange={(e) => change(picked.id, { ...edits[picked.id], value: e.target.value })}
                                    />
                                  </div>
                                  {picked.href !== undefined && (
                                    <div className="dx-f">
                                      <div className="dx-fl"><label htmlFor="dx-img-link">Link <span className="dx-opt">(optional)</span></label></div>
                                      <div className="dx-inp">
                                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1" /></svg>
                                        <input
                                          id="dx-img-link"
                                          type="text"
                                          disabled={readOnly}
                                          value={currentHref}
                                          placeholder="Where clicking the image goes"
                                          onChange={(e) => change(picked.id, { ...edits[picked.id], value: edits[picked.id]?.value ?? picked.value, href: e.target.value })}
                                        />
                                      </div>
                                    </div>
                                  )}
                                </>
                              )}
                              <div className="dx-sub">Fit &amp; crop</div>
                              <div className="dx-f">
                                <div className="dx-fl"><label htmlFor="dx-img-fit">How it fills its box</label></div>
                                <select
                                  id="dx-img-fit"
                                  disabled={readOnly}
                                  value={currentFit}
                                  onChange={(e) => {
                                    const nextMap = { ...styleMap };
                                    if (isContainer) nextMap["background-size"] = e.target.value;
                                    else nextMap["object-fit"] = e.target.value;
                                    changePickedStyle(writeStyle(nextMap), true);
                                  }}
                                >
                                  <option value="cover">Full (cover)</option>
                                  <option value="contain">Contain (whole image)</option>
                                  {isContainer ? (
                                    <>
                                      <option value="100% 100%">Stretch (100% × 100%)</option>
                                      <option value="auto">Original size</option>
                                    </>
                                  ) : (
                                    <>
                                      <option value="fill">Stretch (100% × 100%)</option>
                                      <option value="scale-down">Scale down</option>
                                      <option value="none">Original size</option>
                                    </>
                                  )}
                                </select>
                              </div>
                              <ImagePositionControl value={currentPos || computed[posKey]} device={device} disabled={readOnly} onChange={(next) => writePos(next ?? "")} onCommit={() => commitHistory(edits)} />
                              <p className="dx-hint">Click the preview to set the crop's focal point.</p>
                              {!isContainer && !isIcon && (
                                <>
                                  <div className="dx-sub">Details</div>
                                  <div className="dx-f">
                                    <div className="dx-fl"><label htmlFor="dx-img-alt">Alt text</label></div>
                                    <textarea
                                      id="dx-img-alt"
                                      className="dx-ta"
                                      disabled={readOnly}
                                      value={currentAlt}
                                      placeholder={picked.decorative ? "Marked as decoration" : "Describe it for someone who can't see it"}
                                      onChange={(e) => change(picked.id, { ...edits[picked.id], value: edits[picked.id]?.value ?? picked.value, alt: e.target.value })}
                                    />
                                  </div>
                                </>
                              )}
                            </div>
                          );
                        })()}

                        {picked.kind === "image" && !readOnly && <WebsiteImageFraming siteId={site.id} key={`${picked.id}:${device}:${edits[picked.id]?.value ?? picked.value}`} src={resolveImagePreview(edits[picked.id]?.value ?? picked.value)} style={pickedStyle ?? ""} onApply={next => changePickedStyle(next, true)} />}


                        {(absentIds.has(picked.id) || picked.id.startsWith("meta.") || picked.tag === "title" || picked.tag === "meta") && (
                          <div className="mb-3 rounded-xl border border-line bg-cream/70 p-3 text-xs leading-relaxed text-muted">
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-semibold text-ink">
                                {picked.id.startsWith("meta.") || picked.tag === "meta" || picked.tag === "title"
                                  ? "Page Metadata / Header Tag"
                                  : "Requires Preview Reload"}
                              </span>
                              <button
                                type="button"
                                onClick={() => {
                                  dirty.current = false;
                                  void qc.invalidateQueries({ queryKey: ["website", "page", pageId] });
                                  setPreviewToken((token) => token + 1);
                                }}
                                className="rounded-md border border-line bg-white px-2 py-0.5 text-[11px] font-semibold text-ink shadow-2xs transition hover:border-blue hover:text-blue"
                              >
                                Reload Preview
                              </button>
                            </div>
                            <p className="mt-1 text-muted">
                              {picked.id.startsWith("meta.") || picked.tag === "meta" || picked.tag === "title"
                                ? "This property is stored in the document head for browsers and search engines. Changes take effect on publish or reload."
                                : "This element cannot be updated live while typing. Save draft and reload the preview to view your changes."}
                            </p>
                          </div>
                        )}
                        {picked.kind === "unsupported" && (
                          <div className="mb-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-ink">
                            <div className="flex items-center gap-1.5 font-semibold text-amber-500">
                              <IconLock size={12} />
                              <span>Preserved Element ({picked.tag.toUpperCase()})</span>
                            </div>
                            <p className="mt-1 text-muted">
                              This element ({picked.tag}) is preserved byte-for-byte from your original HTML. Visual editing is limited to maintain script and layout stability.
                            </p>
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
                          const compoundBgColorMatch = styleMap.background ? /,\s*(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|[a-zA-Z]+)\s*$/i.exec(styleMap.background) : null;
                          const bgCol = styleMap["background-color"] ?? compoundBgColorMatch?.[1] ?? computed["background-color"] ?? "";
                          const txtCol = styleMap.color ?? computed.color ?? "";
                          const childFields = allFields.filter((f) => f.parentId === picked.id);
                          const updateProp = (prop: string, val: string) => {
                            const nextMap = { ...styleMap };
                            if (prop === "background-color") {
                              if (val) {
                                nextMap["background-color"] = val;
                                if (nextMap.background && /,\s*(?:#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|[a-zA-Z]+)\s*$/i.test(nextMap.background)) {
                                  nextMap.background = nextMap.background.replace(/,\s*(?:#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|[a-zA-Z]+)\s*$/i, `, ${val}`);
                                }
                              } else {
                                delete nextMap["background-color"];
                                if (nextMap.background && /,\s*(?:#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|[a-zA-Z]+)\s*$/i.test(nextMap.background)) {
                                  nextMap.background = nextMap.background.replace(/,\s*(?:#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|[a-zA-Z]+)\s*$/i, "");
                                }
                              }
                            } else if (prop === "background-image") {
                              if (val && val !== "none") {
                                nextMap["background-image"] = val;
                              } else {
                                delete nextMap["background-image"];
                                if (nextMap.background) {
                                  const colorMatch = /,\s*(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|[a-zA-Z]+)\s*$/i.exec(nextMap.background);
                                  if (colorMatch?.[1]) {
                                    nextMap["background-color"] = colorMatch[1];
                                  }
                                  delete nextMap.background;
                                }
                              }
                            } else {
                              if (val) nextMap[prop] = val;
                              else delete nextMap[prop];
                            }
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
                                    style={{ backgroundImage: `url("${resolveImagePreview(bgUrl).replace(/"/g, "")}")` }}
                                  />
                                )}
                                <div className="flex items-center gap-1.5">
                                  <input
                                    type="text"
                                    placeholder="Paste image URL (/assets/... or https://...)"
                                    value={bgUrl}
                                    onChange={(e) => {
                                      const v = e.target.value.trim();
                                      updateProp("background-image", v ? `url('${v.replace(/['"\\]/g, "")}')` : "");
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
                        {picked.kind !== "image" && <FieldRow
                          key={`${loadToken}:${frameEdit}:${picked.id}`}
                          field={picked}
                          edit={edits[picked.id]}
                          problem={problems.get(picked.id)}
                          siteId={site.id}
                          publicUrl={page.data.page.url}
                          resolveImagePreview={resolveImagePreview}
                          links={links ?? []}
                          readOnly={readOnly}
                          onChange={(next) => change(picked.id, next)}
                          onNameFields={() => void nameFields()}
                          naming={naming}
                          onOpenMediaLibrary={() => {
                            setAssetTargetMode(picked.kind === "container" ? "background" : "image");
                            setAssetModalOpen(true);
                          }}
                          computedBackgroundUrl={computed["background-image"]}
                          onTypeOnPage={() => tell({ type: "edit", id: picked.id })}
                          bare
                        />}
                      </>
                    }
                  /></div>
                </>
            </div>
          </aside>
        )}
      </div>

      {contextToast && (
        <div className="fixed bottom-6 left-1/2 z-[120] -translate-x-1/2 rounded-xl border border-line bg-ink px-4 py-2 text-xs font-semibold text-white shadow-lg">
          {contextToast}
        </div>
      )}

      {contextMenu && (() => {
        const ctxField = contextMenu.fieldId ? allFields.find((f) => f.id === contextMenu.fieldId) ?? null : null;
        const close = () => setContextMenu(null);
        if (!ctxField) {
          return (
            <div role="menu" aria-label="Page actions" style={{ top: contextMenu.y, left: contextMenu.x }} onClick={(e) => e.stopPropagation()} className="dx-pop dx-ctx" >
              <div className="dx-pop-pad"><b>Page</b></div>
              <button type="button" role="menuitem" className="dx-row" onClick={() => { close(); setPanel("notes"); }}><IconMessageSquare size={15} /><span>Add a note</span></button>
              <button type="button" role="menuitem" className="dx-row" onClick={() => { close(); setPanel("seo"); }}><IconTarget size={15} /><span>Page SEO</span></button>
            </div>
          );
        }
        const isText = ctxField.kind !== "image" && ctxField.kind !== "container" && ctxField.kind !== "icon" && ctxField.kind !== "unsupported" && ctxField.tag !== "title" && ctxField.tag !== "meta";
        const isImage = ctxField.kind === "image" || ctxField.kind === "icon";
        const currentText = (edits[ctxField.id]?.value ?? ctxField.value ?? contextMenu.text ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        const currentStyle = edits[ctxField.id]?.style ?? ctxField.style ?? "";
        const phoneStyle = (edits[ctxField.id]?.responsive ?? ctxField.responsive ?? {}).mobile ?? "";
        const hiddenOnPhone = /(?:^|;)\s*display\s*:\s*none\b/i.test(phoneStyle);
        const parent = ctxField.parentId ? allFields.find((f) => f.id === ctxField.parentId) : undefined;
        const busy = readOnly || save.isPending;
        const item = (label: string, icon: React.ReactNode, onClick: () => void, opts: { keys?: string; disabled?: boolean; danger?: boolean; title?: string } = {}) => (
          <button type="button" role="menuitem" className={`dx-row${opts.danger ? " danger" : ""}`} disabled={opts.disabled} title={opts.title} onClick={() => { close(); onClick(); }}>
            {icon}<span>{label}</span>{opts.keys && <small>{opts.keys}</small>}
          </button>
        );
        return (
          <div role="menu" aria-label="Element actions" style={{ top: contextMenu.y, left: contextMenu.x }} onClick={(e) => e.stopPropagation()} className="dx-pop dx-ctx">
            <div className="dx-pop-pad"><b>{ctxField.label}</b></div>
            {isText && !readOnly && item("Edit text", <IconEdit size={15} />, () => { setInspectorTab("content"); tell({ type: "edit", id: ctxField.id }); }, { keys: "Dbl-click" })}
            {isImage && !readOnly && item("Replace image", <IconImage size={15} />, () => { setAssetTargetMode("image"); setAssetModalOpen(true); })}
            {canEdit && (!tierStatus?.features || tierStatus.features.aiBuilderAgent) && item("Ask the agent about this", <IconSparkles size={15} />, () => setAgentOpen(true))}
            {item("Add a note", <IconMessageSquare size={15} />, () => setPanel("notes"))}
            <hr />
            {item("Copy", <IconCopy size={15} />, () => {
              setTextClipboard(currentText);
              void navigator.clipboard?.writeText(currentText).catch(() => {});
              showQuickToast("Copied");
            }, { keys: "Ctrl+C", disabled: !currentText })}
            {isText && item("Paste", <IconPaste size={15} />, async () => {
              let clip = textClipboard;
              if (!clip && navigator.clipboard?.readText) { try { clip = await navigator.clipboard.readText(); } catch { clip = null; } }
              if (clip?.trim()) { change(ctxField.id, { ...edits[ctxField.id], value: clip.trim() }, { commit: true }); showQuickToast("Pasted"); }
              else showQuickToast("Nothing copied yet");
            }, { keys: "Ctrl+V", disabled: busy })}
            {item("Duplicate", <IconPlusSquare size={15} />, () => void runStructure("duplicate", ctxField.id), { disabled: busy || !ctxField.structure?.duplicate, title: ctxField.structure?.duplicateReason })}
            <hr />
            {item("Copy style", <IconPalette size={15} />, () => { setStyleClipboard(currentStyle); showQuickToast("Style copied"); })}
            {styleClipboard !== null && item("Paste style", <IconBrush size={15} />, () => { change(ctxField.id, { ...edits[ctxField.id], style: styleClipboard }, { commit: true }); showQuickToast("Style pasted"); }, { disabled: busy })}
            {item("Reset to website default", <IconRefresh size={15} />, () => {
              const next = { ...edits[ctxField.id] };
              delete next.style;
              delete next.responsive;
              change(ctxField.id, next, { commit: true });
              showQuickToast("Back to the website default");
            }, { disabled: busy || (!edits[ctxField.id]?.style && !edits[ctxField.id]?.responsive) })}
            <hr />
            {item("Move up", <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6" /></svg>, () => void runStructure("before", ctxField.id, ctxField.structure?.previousId), { disabled: busy || !designerMode || !ctxField.structure?.previousId, title: designerMode ? undefined : "Turn on Designer controls to move things" })}
            {item("Move down", <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 5v14M6 13l6 6 6-6" /></svg>, () => void runStructure("after", ctxField.id, ctxField.structure?.nextId), { disabled: busy || !designerMode || !ctxField.structure?.nextId, title: designerMode ? undefined : "Turn on Designer controls to move things" })}
            {item("Select parent", <IconLayers size={15} />, () => parent && pick(parent.id), { disabled: !parent })}
            {item(hiddenOnPhone ? "Show on phone" : "Hide on phone", hiddenOnPhone ? <IconEye size={15} /> : <IconEyeOff size={15} />, () => {
              const responsive = { ...(edits[ctxField.id]?.responsive ?? ctxField.responsive ?? {}) };
              const kept = phoneStyle.split(";").map((part) => part.trim()).filter((part) => part && !/^display\s*:/i.test(part));
              if (!hiddenOnPhone) kept.push("display: none");
              if (kept.length) responsive.mobile = safeResponsiveStyle(kept.join("; "));
              else delete responsive.mobile;
              change(ctxField.id, { ...edits[ctxField.id], responsive }, { commit: true });
              showQuickToast(hiddenOnPhone ? "Shown on phone screens again" : "Hidden on phone screens");
            }, { disabled: busy })}
            <hr />
            {item("Delete", <IconTrash size={15} />, () => void runStructure("remove", ctxField.id), { keys: "Del", danger: true, disabled: busy || !ctxField.structure?.remove, title: ctxField.structure?.reason })}
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
          onClearSelection={() => pick(null)}
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
          open={agentOpen}
          onOpenChange={setAgentOpen}
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
