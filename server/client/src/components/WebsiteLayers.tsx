import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { FieldEdit, SharedFieldScope, SiteFieldRow } from "../lib/types";
import { layerAncestors, visibleWebsiteLayers, websiteLayerNavigation, websiteLayerTabStop, websiteLayerTree } from "../lib/websiteLayers";

const ROW_HEIGHT = 34;

/** A block that can be lifted and put down beside a sibling. Page data from before `move` says so with `remove`. */
const movable = (field: SiteFieldRow | undefined) => Boolean(field?.structure?.move ?? field?.structure?.remove);

function classifyStructureNode(field: SiteFieldRow): {
  kindKey: "container" | "header" | "footer" | "carousel" | "logo" | "heading" | "divider" | "text" | "button" | "image";
  title: string;
  subtitle: string;
} {
  const tag = (field.tag || "").toLowerCase();
  const label = field.label || "";
  const preview = (field.preview || "").trim();

  if (/carousel|ticker|marquee|slider/i.test(label)) {
    return { kindKey: "carousel", title: "Slider", subtitle: preview && preview !== label ? preview : "" };
  }
  if (/logo|icon|brand-face/i.test(label) || tag === "svg" || tag === "i") {
    return { kindKey: "logo", title: "Icon", subtitle: label.replace(/^Logo\s*\/\s*Icon\s*/i, "") };
  }
  if (tag === "hr" || /divider|separator/i.test(label)) {
    return { kindKey: "divider", title: "Divider", subtitle: "" };
  }
  if (field.kind === "container") {
    if (tag === "header" || /^header\b/i.test(label)) {
      return { kindKey: "header", title: "Header", subtitle: label.replace(/^header\s*/i, "") };
    }
    if (tag === "footer" || /^footer\b/i.test(label)) {
      return { kindKey: "footer", title: "Footer", subtitle: "" };
    }
    if (tag === "nav") {
      return { kindKey: "container", title: "Navigation", subtitle: "" };
    }
    const cleanSub = /^container\s+\d+$/i.test(label) || /^(div|section|main|article)\s+\d+$/i.test(label) ? "" : label;
    return { kindKey: "container", title: tag === "section" ? "Section" : "Group", subtitle: cleanSub };
  }
  if (field.kind === "image" || tag === "img") {
    return { kindKey: "image", title: "Image", subtitle: preview || label };
  }
  if (field.kind === "link" || tag === "a" || tag === "button") {
    return { kindKey: "button", title: tag === "button" || /button/i.test(label) ? "Button" : "Link", subtitle: preview || label };
  }
  if (/^h[1-6]$/.test(tag) || /heading/i.test(label)) {
    return { kindKey: "heading", title: "Heading", subtitle: preview };
  }
  return { kindKey: "text", title: "Text", subtitle: preview };
}

function StructureIcon({ kindKey }: { kindKey: ReturnType<typeof classifyStructureNode>["kindKey"] }) {
  switch (kindKey) {
    case "container":
    case "header":
    case "footer":
      return (
        <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor">
          <rect x="2" y="4" width="16" height="12" rx="1.5" strokeWidth="1.4" />
          <rect x="4.5" y="6.5" width="11" height="7" strokeWidth="1.2" strokeDasharray="2 1.5" />
        </svg>
      );
    case "carousel":
      return (
        <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor">
          <rect x="4" y="4" width="12" height="12" rx="1.5" strokeWidth="1.4" />
          <path d="M1.5 6.5v7M18.5 6.5v7" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      );
    case "logo":
      return (
        <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor">
          <circle cx="10" cy="10" r="6.5" strokeWidth="1.4" />
          <path d="M10 6.5 11.5 9l2.5.5-2 1.8.5 2.5-2.5-1.3-2.5 1.3.5-2.5-2-1.8L8.5 9 10 6.5Z" strokeWidth="1.1" />
        </svg>
      );
    case "heading":
      return (
        <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor">
          <path d="M4 5h12v2.5M4 5v2.5M9 5v10.5M11 5v10.5M7 15.5h6" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "divider":
      return (
        <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor">
          <path d="M3 9h14M3 11h14" strokeWidth="1.3" strokeLinecap="round" />
          <path d="M10 4.5 8 6.5h4l-2-2ZM10 15.5 8 13.5h4l-2 2Z" strokeWidth="1.2" strokeLinejoin="round" />
        </svg>
      );
    case "text":
      return (
        <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor">
          <path d="M3.5 5.5h13M3.5 8.5h13M3.5 11.5h13M3.5 14.5h8.5" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      );
    case "image":
      return (
        <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor">
          <rect x="3" y="4" width="14" height="12" rx="1.5" strokeWidth="1.4" />
          <circle cx="7.2" cy="8" r="1.3" strokeWidth="1.2" />
          <path d="m4.5 14.5 4-4 2.5 2.5 2.5-2 3 3.5" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "button":
      return (
        <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor">
          <rect x="2.5" y="6" width="15" height="8" rx="4" strokeWidth="1.4" />
          <path d="M7 10h6" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      );
  }
}

export function WebsiteLayers({
  fields,
  edits,
  problems,
  shared,
  selectedId,
  onSelect,
  onMove,
  onToggleVisibility,
  onClose,
}: {
  fields: SiteFieldRow[];
  edits: Record<string, FieldEdit>;
  problems: Map<string, string>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Which fields belong to a shared element, so the tree can say so. */
  shared?: Record<string, SharedFieldScope>;
  onMove?: (id: string, target: string, position: "before" | "after") => void;
  onToggleVisibility?: (id: string) => void;
  onClose?: () => void;
}) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; position: "before" | "after" } | null>(null);
  const [search, setSearch] = useState("");
  const [showSearch, setShowSearch] = useState(false);
  const [filter, setFilter] = useState<"all" | "changed" | "issues">("all");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [scrollTop, setScrollTop] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());

  const visualFields = useMemo(
    () =>
      fields.filter(
        (f) => f.tag !== "title" && f.tag !== "meta" && f.tag !== "body" && f.label !== "Page Body & Theme"
      ),
    [fields]
  );

  const tree = useMemo(() => websiteLayerTree(visualFields), [visualFields]);
  const query = search.trim().toLowerCase();
  const filtering = Boolean(query || filter !== "all");
  const matches = useMemo(
    () =>
      filtering
        ? new Set(
            visualFields
              .filter((field) => {
                const label = `${field.label} ${field.tag} ${field.preview} ${field.id}`.toLowerCase();
                return (
                  (!query || label.includes(query)) &&
                  (filter === "all" ||
                    (filter === "changed" ? Object.keys(edits[field.id] ?? {}).length > 0 : problems.has(field.id)))
                );
              })
              .map((field) => field.id)
          )
        : undefined,
    [visualFields, query, filter, edits, problems, filtering]
  );
  const rows = useMemo(() => visibleWebsiteLayers(tree.roots, collapsed, matches), [tree, collapsed, matches]);
  const selected = selectedId ? tree.nodes.get(selectedId) : undefined;

  useEffect(() => {
    if (!selected) return;
    setCollapsed((current) => {
      const next = new Set(current);
      for (const node of layerAncestors(selected)) next.delete(node.field.id);
      return next;
    });
    if (matches && !rows.some((row) => row.node.field.id === selected.field.id)) {
      setSearch("");
      setFilter("all");
    }
  }, [selectedId]);

  useEffect(() => {
    if (!selectedId || !containerRef.current) return;
    const selectedIndex = rows.findIndex((r) => r.node.field.id === selectedId);
    if (selectedIndex === -1) {
      // Hidden behind a search or filter: clear them so the selection shows.
      if (filtering && selected) { setSearch(""); setFilter("all"); }
      return;
    }
    const itemTop = selectedIndex * ROW_HEIGHT;
    const itemBottom = itemTop + ROW_HEIGHT;
    const currentScroll = containerRef.current.scrollTop;
    const viewHeight = containerRef.current.clientHeight;
    // The list is only its own scroller when the panel bounds its height; docked
    // in a drawer it can grow and the drawer scrolls instead. So bring the row
    // near first (it may not be rendered yet when the list is virtualised), then
    // ask the row itself, which reaches whichever ancestor actually scrolls.
    if (itemTop < currentScroll || itemBottom > currentScroll + viewHeight) {
      containerRef.current.scrollTop = Math.max(0, itemTop - viewHeight / 2);
    }
    // Not scrollIntoView: that also scrolls the editor shell and slides its header away.
    const frame = requestAnimationFrame(() => {
      const row = buttons.current.get(selectedId);
      let box = row?.parentElement ?? null;
      while (box && !(/(auto|scroll)/.test(getComputedStyle(box).overflowY) && box.scrollHeight > box.clientHeight)) box = box.parentElement;
      if (!row || !box) return;
      const r = row.getBoundingClientRect(), b = box.getBoundingClientRect();
      if (r.top < b.top) box.scrollTop -= b.top - r.top + 8;
      else if (r.bottom > b.bottom) box.scrollTop += r.bottom - b.bottom + 8;
    });
    return () => cancelAnimationFrame(frame);
  }, [selectedId, rows]);

  const select = (id: string) => {
    onSelect(id);
    buttons.current.get(id)?.focus();
  };
  const toggle = (id: string) => {
    if (!collapsed.has(id) && layerAncestors(selected).some((node) => node.field.id === id)) select(id);
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const allCollapsed = collapsed.size > 0 && tree.roots.every((r) => collapsed.has(r.field.id));
  const toggleCollapseAll = () => {
    if (allCollapsed) {
      setCollapsed(new Set());
    } else {
      const root = layerAncestors(selected)[0];
      if (root) onSelect(root.field.id);
      setCollapsed(new Set(visualFields.map((field) => field.id)));
    }
  };
  const focusableId = websiteLayerTabStop(rows, selected);

  const isVirtualized = rows.length > 50;
  const containerHeight = containerRef.current?.clientHeight || 400;
  const totalHeight = rows.length * ROW_HEIGHT;
  const startIndex = isVirtualized ? Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - 4) : 0;
  const endIndex = isVirtualized
    ? Math.min(rows.length, Math.ceil((scrollTop + containerHeight) / ROW_HEIGHT) + 4)
    : rows.length;
  const visibleSlice = rows.slice(startIndex, endIndex);
  const offsetY = startIndex * ROW_HEIGHT;

  // Docked in the editor's Layers drawer by default; it can still be popped
  // out into a window you drag around, and that choice is remembered.
  const [isFloating, setIsFloating] = useState<boolean>(() => {
    try {
      return localStorage.getItem("dw-structure-floating") === "floating";
    } catch {
      return false;
    }
  });

  const [winBounds, setWinBounds] = useState<{ x: number; y: number; w: number; h: number }>(() => {
    const defaultW = 284;
    const defaultH = 470;
    const defaultX = typeof window !== "undefined" ? Math.max(24, window.innerWidth - defaultW - 28) : 900;
    const defaultY = 74;
    try {
      const saved = JSON.parse(localStorage.getItem("dw-structure-bounds") || "null");
      if (saved && typeof saved.x === "number" && typeof saved.y === "number") {
        const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
        const vh = typeof window !== "undefined" ? window.innerHeight : 800;
        return {
          x: Math.max(12, Math.min(vw - 220, saved.x)),
          y: Math.max(12, Math.min(vh - 140, saved.y)),
          w: Math.max(240, Math.min(480, saved.w || defaultW)),
          h: Math.max(240, Math.min(vh - 40, saved.h || defaultH)),
        };
      }
    } catch {}
    return { x: defaultX, y: defaultY, w: defaultW, h: defaultH };
  });

  const [interactingWindow, setInteractingWindow] = useState<"drag" | "resize" | null>(null);
  const [dockedHeight, setDockedHeight] = useState<number | null>(() => {
    try { const saved = Number(localStorage.getItem("dw-layers-height")); return saved > 0 ? saved : null; } catch { return null; }
  });
  const panelRef = useRef<HTMLDivElement>(null);
  /** The slot left in the drawer while the panel floats: where it is dropped to dock again. */
  const homeRef = useRef<HTMLDivElement>(null);
  /**
   * Where the floating window is drawn. It used to be `document.body`, which is
   * outside `.website-editor` — and every colour this panel has is a variable
   * declared there. Out of its reach the background resolved to nothing, so the
   * window came loose see-through, with the page showing between the rows.
   */
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [dockArmed, setDockArmed] = useState(false);
  useLayoutEffect(() => {
    setHost(isFloating ? (homeRef.current?.closest<HTMLElement>(".website-editor") ?? document.body) : null);
  }, [isFloating]);

  useEffect(() => {
    const clampOnResize = () => {
      setWinBounds((prev) => ({
        x: Math.max(8, Math.min(window.innerWidth - 220, prev.x)),
        y: Math.max(8, Math.min(window.innerHeight - 120, prev.y)),
        w: Math.max(240, Math.min(480, prev.w)),
        h: Math.max(220, Math.min(window.innerHeight - 32, prev.h)),
      }));
    };
    window.addEventListener("resize", clampOnResize);
    return () => window.removeEventListener("resize", clampOnResize);
  }, []);

  const toggleFloatingMode = (nextVal?: boolean) => {
    const next = nextVal ?? !isFloating;
    setIsFloating(next);
    try {
      localStorage.setItem("dw-structure-floating", next ? "floating" : "docked");
    } catch {}
  };

  const startHeaderDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    // Ignore clicks on buttons/inputs inside the header bar
    const target = event.target as HTMLElement;
    if (target.closest("button") || target.closest("input")) return;
    event.preventDefault();

    const startClientX = event.clientX;
    const startClientY = event.clientY;
    const initialX = isFloating ? winBounds.x : Math.max(16, event.clientX - Math.round(winBounds.w / 2));
    const initialY = isFloating ? winBounds.y : Math.max(16, event.clientY - 18);
    let moved = false;
    // Home is the drawer the panel lives in. Carried back over it and let go,
    // the panel docks — which is how anybody tries to put it back, and until
    // 12 Oct 2026 nothing happened when they did.
    const drawer = (homeRef.current ?? panelRef.current)?.closest<HTMLElement>(".dx-drawer") ?? null;
    const cameFrom = isFloating ? { x: winBounds.x, y: winBounds.y } : null;
    let overHome = false;

    setInteractingWindow("drag");

    const onMove = (moveEvt: PointerEvent) => {
      const dx = moveEvt.clientX - startClientX;
      const dy = moveEvt.clientY - startClientY;
      if (!moved && Math.hypot(dx, dy) > 4) {
        moved = true;
        if (!isFloating) toggleFloatingMode(true);
      }
      if (!moved) return;
      const home = (drawer ?? homeRef.current)?.getBoundingClientRect();
      overHome = Boolean(home && moveEvt.clientX >= home.left && moveEvt.clientX <= home.right && moveEvt.clientY >= home.top && moveEvt.clientY <= home.bottom);
      setDockArmed(overHome);
      const nextX = Math.max(8, Math.min(window.innerWidth - winBounds.w - 8, initialX + dx));
      const nextY = Math.max(8, Math.min(window.innerHeight - 80, initialY + dy));
      setWinBounds((prev) => {
        const updated = { ...prev, x: nextX, y: nextY };
        try {
          localStorage.setItem("dw-structure-bounds", JSON.stringify(updated));
        } catch {}
        return updated;
      });
    };

    const onUp = () => {
      setInteractingWindow(null);
      setDockArmed(false);
      if (moved && overHome) {
        toggleFloatingMode(false);
        // The window was last drawn on top of its own drawer. Floated again it
        // should open where it was before this drag, not over the slot it left.
        setWinBounds((prev) => {
          const restored = { ...prev, x: cameFrom?.x ?? Math.max(24, window.innerWidth - prev.w - 28), y: cameFrom?.y ?? 74 };
          try {
            localStorage.setItem("dw-structure-bounds", JSON.stringify(restored));
          } catch {}
          return restored;
        });
      }
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const startResizeDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!isFloating) {
      event.preventDefault();
      const startY = event.clientY;
      const initial = panelRef.current?.getBoundingClientRect().height ?? 300;
      setInteractingWindow("resize");
      let last = initial;
      const onMove = (moveEvt: PointerEvent) => {
        last = Math.max(140, Math.min(window.innerHeight - 160, initial + moveEvt.clientY - startY));
        setDockedHeight(last);
      };
      const onUp = () => {
        setInteractingWindow(null);
        try { localStorage.setItem("dw-layers-height", String(Math.round(last))); } catch {}
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startY = event.clientY;
    const initialW = winBounds.w;
    const initialH = winBounds.h;

    setInteractingWindow("resize");

    const onMove = (moveEvt: PointerEvent) => {
      const nextW = Math.max(240, Math.min(480, initialW + (moveEvt.clientX - startX)));
      const nextH = Math.max(220, Math.min(window.innerHeight - winBounds.y - 16, initialH + (moveEvt.clientY - startY)));
      setWinBounds((prev) => {
        const updated = { ...prev, w: nextW, h: nextH };
        try {
          localStorage.setItem("dw-structure-bounds", JSON.stringify(updated));
        } catch {}
        return updated;
      });
    };

    const onUp = () => {
      setInteractingWindow(null);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const panelBody = (
    <div
      ref={panelRef}
      data-docking={isFloating && dockArmed ? "" : undefined}
      style={
        isFloating
          ? {
              top: `${winBounds.y}px`,
              left: `${winBounds.x}px`,
              width: `${winBounds.w}px`,
              height: `${winBounds.h}px`,
            }
          : dockedHeight
            ? { height: `${dockedHeight}px`, maxHeight: "none", flex: "none" }
            : undefined
      }
      className={
        isFloating
          ? "dx-layers dx-layers-float fixed z-[9980] flex flex-col overflow-hidden"
          : "dx-layers editor-layers flex min-h-0 flex-1 flex-col"
      }
    >
      {/* Header: drag it to float the panel, and back over its drawer to dock it. */}
      <div
        onPointerDown={startHeaderDrag}
        title={isFloating ? "Drag to move. Drop it back on the Layers drawer to dock it." : "Drag to float the Layers panel"}
        className="dx-layers-head flex cursor-grab select-none items-center justify-between px-3 py-2.5 active:cursor-grabbing"
      >
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            disabled={filtering}
            onClick={toggleCollapseAll}
            aria-label={allCollapsed ? "Expand all layers" : "Collapse all layers"}
            title={allCollapsed ? "Expand all containers" : "Collapse all containers"}
            className="dx-ltool disabled:opacity-40"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="2" y="2" width="12" height="12" rx="1.5" />
              {allCollapsed ? (
                <path d="M6.5 5.5 9.5 8l-3 2.5" strokeLinecap="round" strokeLinejoin="round" />
              ) : (
                <path d="M5.5 6.5 8 9.5l2.5-3" strokeLinecap="round" strokeLinejoin="round" />
              )}
            </svg>
          </button>
          <button
            type="button"
            onClick={() => setShowSearch((s) => !s)}
            aria-label="Search or filter layers"
            title="Search and filter"
            aria-pressed={showSearch || filtering}
            className="dx-ltool"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
              <circle cx="7" cy="7" r="4.5" />
              <path d="m10.5 10.5 3.5 3.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <span className="pointer-events-none flex items-center gap-1.5 text-[13px] font-semibold">
          <span>Layers</span>
          <span className="dx-lcount">{rows.length}</span>
        </span>

        <div className="flex items-center gap-1">
          {!allCollapsed ? (
            <button
              type="button"
              onClick={() => setCollapsed(new Set())}
              className="sr-only"
              aria-label="Expand all layers"
            >
              Expand
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => toggleFloatingMode()}
            aria-label={isFloating ? "Dock Layers to the sidebar" : "Float the Layers panel"}
            title={isFloating ? "Dock Layers to the sidebar" : "Float the Layers panel"}
            className="dx-ltool"
          >
            {isFloating ? (
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
                <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
                <path d="M6 2.5v11" />
              </svg>
            ) : (
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
                <rect x="4.5" y="2.5" width="9" height="8.5" rx="1.2" />
                <path d="M2.5 5.5v6.8a1.2 1.2 0 0 0 1.2 1.2h6.8" strokeLinecap="round" />
              </svg>
            )}
          </button>
          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close Layers"
              title="Close Layers"
              className="dx-ltool"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />
              </svg>
            </button>
          ) : (
            <span className="w-6" />
          )}
        </div>
      </div>

      {/* Collapsible Search & Filter Drawer */}
      {(showSearch || filtering) && (
        <div className="dx-layers-search space-y-1.5 px-2.5 py-2">
          <input
            aria-label="Search layers"
            className="dx-lsearch h-8 w-full rounded-lg px-2.5 text-xs outline-none"
            placeholder="Find a section, heading, text…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <div role="group" className="flex gap-1" aria-label="Filter layers">
            {(["all", "changed", "issues"] as const).map((value) => (
              <button
                type="button"
                key={value}
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
                className="dx-chip rounded-full px-2.5 py-0.5 text-[10px] font-medium capitalize"
              >
                {value}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* The tree */}
      <div
        ref={containerRef}
        role="tree"
        aria-label="Page layers"
        onScroll={(event) => setScrollTop((event.target as HTMLElement).scrollTop)}
        className="min-h-[140px] flex-1 overflow-auto py-1"
      >
        <div style={{ height: isVirtualized ? `${totalHeight}px` : "auto", position: "relative" }}>
          <div style={{ transform: isVirtualized ? `translateY(${offsetY}px)` : "none" }}>
            {visibleSlice.map(({ node, depth, position, siblings, hasChildren, expanded }, sliceIdx) => {
              const index = startIndex + sliceIdx;
              const field = node.field;
              const info = classifyStructureNode(field);
              const isSelected = field.id === selectedId;
              const currentStyle = edits[field.id]?.style ?? field.style ?? "";
              const isHidden = /(?:^|;)\s*display\s*:\s*none\b/i.test(currentStyle);
              const isEdited = Object.keys(edits[field.id] ?? {}).length > 0;

              return (
                <button
                  key={field.id}
                  draggable={Boolean(onMove && movable(field))}
                  onDragStart={(event) => {
                    setDragging(field.id);
                    event.dataTransfer.setData("application/x-dakyworld-field", field.id);
                    event.dataTransfer.effectAllowed = "move";
                    const row = event.currentTarget;
                    const ghost = row.cloneNode(true) as HTMLElement;
                    ghost.classList.add("dx-lghost");
                    ghost.style.width = `${row.offsetWidth}px`;
                    ghost.style.position = "fixed";
                    ghost.style.top = "-1000px";
                    (row.closest(".dx-layers") ?? document.body).appendChild(ghost);
                    event.dataTransfer.setDragImage(ghost, 24, 16);
                    requestAnimationFrame(() => ghost.remove());
                  }}
                  onDragEnd={() => {
                    setDragging(null);
                    setDrop(null);
                  }}
                  onDragOver={(event) => {
                    const source = dragging ? tree.nodes.get(dragging)?.field : undefined;
                    if (dragging === field.id) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; setDrop(null); return; }
                    if (
                      !onMove ||
                      !source?.structure?.group ||
                      source.id === field.id ||
                      source.structure.group !== field.structure?.group ||
                      !movable(field)
                    )
                      return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                    const rect = event.currentTarget.getBoundingClientRect();
                    setDrop({ id: field.id, position: event.clientY < rect.top + rect.height / 2 ? "before" : "after" });
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    if (
                      onMove &&
                      dragging &&
                      drop?.id === field.id &&
                      event.dataTransfer.getData("application/x-dakyworld-field") === dragging
                    ) {
                      onMove(dragging, field.id, drop.position);
                    }
                    setDragging(null);
                    setDrop(null);
                  }}
                  ref={(button) => {
                    if (button) buttons.current.set(field.id, button);
                    else buttons.current.delete(field.id);
                  }}
                  type="button"
                  role="treeitem"
                  aria-level={depth}
                  aria-posinset={position}
                  aria-setsize={siblings}
                  aria-selected={isSelected}
                  aria-expanded={hasChildren ? expanded : undefined}
                  tabIndex={field.id === focusableId ? 0 : -1}
                  title={`${info.title}${info.subtitle ? ` — ${info.subtitle}` : ""} (${field.tag})`}
                  onClick={() => onSelect(field.id)}
                  onKeyDown={(event) => {
                    const action = websiteLayerNavigation(rows, index, event.key, filtering);
                    if (!action) return;
                    event.preventDefault();
                    if (action.select) select(action.select);
                    if (action.expand || action.collapse) toggle(field.id);
                  }}
                  style={{
                    height: `${ROW_HEIGHT}px`,
                    paddingLeft: `${Math.min(depth - 1, 10) * 14 + 8}px`,
                    boxShadow:
                      drop?.id === field.id
                        ? `inset 0 ${drop.position === "before" ? "2px" : "-2px"} var(--editor-accent)`
                        : undefined,
                  }}
                  className={`dx-lrow group ${dragging === field.id ? "dx-ldragging" : ""} ${isHidden ? "opacity-50" : ""}`}
                >
                  {Array.from({ length: Math.min(depth - 1, 10) }, (_, level) => (
                    <span key={level} aria-hidden="true" className="dx-lguide" style={{ left: `${level * 14 + 15}px` }} />
                  ))}
                  {/* Expand / collapse */}
                  <span
                    aria-hidden="true"
                    onClick={(event) => {
                      if (hasChildren && !filtering) {
                        event.stopPropagation();
                        toggle(field.id);
                      }
                    }}
                    className={`flex h-4 w-4 shrink-0 items-center justify-center rounded ${
                      hasChildren ? "dx-lcaret cursor-pointer" : "pointer-events-none opacity-0"
                    }`}
                  >
                    {hasChildren && (
                      <svg width="9" height="9" viewBox="0 0 10 10" fill="currentColor">
                        <path d="M3 1.5 7.5 5 3 8.5V1.5Z" style={{ transformOrigin: "5px 5px", transform: expanded ? "rotate(90deg)" : "none", transition: "transform .15s" }} />
                      </svg>
                    )}
                  </span>

                  <span className="dx-lkind" data-kind={info.kindKey} aria-hidden="true"><StructureIcon kindKey={info.kindKey} /></span>

                  {/* Element Title & Subtle Preview */}
                  <span className="min-w-0 flex-1 truncate">
                    <span className="tracking-[0.01em]">{info.title}</span>
                    {info.subtitle && (
                      <span className="dx-lsub ml-1.5 text-[11px] font-normal">{info.subtitle}</span>
                    )}
                  </span>

                  {/* Status Badges */}
                  {shared?.[field.id] && shared[field.id]!.state === "LINKED" && shared[field.id]!.slot === "self" && (
                    <span
                      aria-label={`Shared across ${shared[field.id]!.linkedPages} pages`}
                      className="dx-lshared shrink-0 rounded-full px-1.5 py-px text-[9px] font-semibold uppercase tracking-wider"
                    >
                      Shared
                    </span>
                  )}
                  {problems.has(field.id) && (
                    <span aria-label="Needs attention" className="shrink-0 text-xs font-bold text-amber-400">
                      !
                    </span>
                  )}
                  {isEdited && !isSelected && (
                    <span aria-label="Changed" className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--editor-accent)]" />
                  )}

                  {/* Show / hide on the page */}
                  {onToggleVisibility && (
                    <span
                      role="button"
                      tabIndex={-1}
                      title={isHidden ? "Show element on page" : "Hide element on page"}
                      onClick={(event) => {
                        event.stopPropagation();
                        onToggleVisibility(field.id);
                      }}
                      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded transition ${
                        isHidden
                          ? "text-amber-400 opacity-100"
                          : isSelected
                            ? "dx-leye opacity-90"
                            : "dx-leye opacity-0 group-hover:opacity-100"
                      }`}
                    >
                      {isHidden ? (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
                          <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
                          <line x1="1" y1="1" x2="23" y2="23" />
                        </svg>
                      ) : (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z" />
                          <circle cx="12" cy="12" r="3" />
                        </svg>
                      )}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
        {!rows.length && (
          <p role="status" className="dx-lsub p-3 text-center text-xs">
            Nothing on this page matches.
          </p>
        )}
      </div>

      {/* Resize handle while floating */}
      <div
        onPointerDown={startResizeDrag}
        title="Drag to resize"
        className="dx-layers-foot relative flex h-3 flex-none cursor-ns-resize select-none items-center justify-center"
      >
        <span className="dx-lgrip" />
        {isFloating && (
          <span
            onPointerDown={startResizeDrag}
            title="Drag to resize width & height"
            className="dx-lsub absolute right-1 bottom-0.5 h-3 w-3 cursor-nwse-resize"
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.3">
              <path d="M9 3 3 9M9 6.5 6.5 9" strokeLinecap="round" />
            </svg>
          </span>
        )}
      </div>
    </div>
  );

  const fullContent = (
    <>
      {interactingWindow && (
        <div
          className={`fixed inset-0 z-[9979] ${
            interactingWindow === "drag" ? "cursor-grabbing" : "cursor-nwse-resize"
          }`}
        />
      )}
      {panelBody}
    </>
  );

  if (isFloating && typeof document !== "undefined") {
    return (
      <>
        <div ref={homeRef} className="dx-layers-home" data-armed={dockArmed ? "" : undefined}>
          <svg width="22" height="22" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
            <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
            <path d="M6 2.5v11" />
          </svg>
          <b>{dockArmed ? "Let go to dock Layers here" : "Layers is floating"}</b>
          {!dockArmed && <span>Drag it back here to dock it.</span>}
          <button type="button" className="dx-btn dx-ghost" onClick={() => toggleFloatingMode(false)}>
            Dock it here
          </button>
        </div>
        {host && createPortal(fullContent, host)}
      </>
    );
  }
  return fullContent;
}

export function WebsiteBreadcrumbs({ fields, selectedId, onSelect }: { fields: SiteFieldRow[]; selectedId: string | null; onSelect: (id: string) => void }) {
  const tree = useMemo(() => websiteLayerTree(fields), [fields]);
  const selected = selectedId ? tree.nodes.get(selectedId) : undefined;
  if (!selected) return null;
  return <nav aria-label="Selected element hierarchy" className="flex flex-none items-center gap-1 overflow-x-auto border-b border-line px-3 py-2 text-[11px] text-muted">{[...layerAncestors(selected), selected].map((node, index) => <span key={node.field.id} className="flex shrink-0 items-center gap-1">{index > 0 && <span aria-hidden="true">›</span>}<button type="button" title={node.field.label} aria-current={node === selected ? "location" : undefined} onClick={() => onSelect(node.field.id)} className={`max-w-[100px] truncate rounded px-1 py-0.5 hover:bg-sunken ${node === selected ? "font-semibold text-ink" : "text-blue"}`}>{node.field.tag}</button></span>)}</nav>;
}
