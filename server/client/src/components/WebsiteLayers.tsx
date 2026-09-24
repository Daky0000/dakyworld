import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { FieldEdit, SharedFieldScope, SiteFieldRow } from "../lib/types";
import { layerAncestors, visibleWebsiteLayers, websiteLayerNavigation, websiteLayerTabStop, websiteLayerTree } from "../lib/websiteLayers";

const ROW_HEIGHT = 34;

function classifyStructureNode(field: SiteFieldRow): {
  kindKey: "container" | "header" | "footer" | "carousel" | "logo" | "heading" | "divider" | "text" | "button" | "image";
  title: string;
  subtitle: string;
} {
  const tag = (field.tag || "").toLowerCase();
  const label = field.label || "";
  const preview = (field.preview || "").trim();

  if (/carousel|ticker|marquee|slider/i.test(label)) {
    return { kindKey: "carousel", title: "Carousel", subtitle: preview && preview !== label ? preview : "" };
  }
  if (/logo|icon|brand-face/i.test(label) || tag === "svg" || tag === "i") {
    return { kindKey: "logo", title: "Logo / Icon", subtitle: label.replace(/^Logo\s*\/\s*Icon\s*/i, "") };
  }
  if (tag === "hr" || /divider|separator/i.test(label)) {
    return { kindKey: "divider", title: "Divider", subtitle: "" };
  }
  if (field.kind === "container") {
    if (tag === "header" || /^header\b/i.test(label)) {
      return { kindKey: "header", title: "Header Container", subtitle: label.replace(/^header\s*/i, "") };
    }
    if (tag === "footer" || /^footer\b/i.test(label)) {
      return { kindKey: "footer", title: "Footer Container", subtitle: "" };
    }
    if (tag === "nav") {
      return { kindKey: "container", title: "Nav Container", subtitle: "" };
    }
    const cleanSub = /^container\s+\d+$/i.test(label) || /^(div|section|main|article)\s+\d+$/i.test(label) ? "" : label;
    return { kindKey: "container", title: "Container", subtitle: cleanSub };
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
  return { kindKey: "text", title: "Text Editor", subtitle: preview };
}

function StructureIcon({ kindKey }: { kindKey: ReturnType<typeof classifyStructureNode>["kindKey"] }) {
  switch (kindKey) {
    case "container":
    case "header":
    case "footer":
      return (
        <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" className="shrink-0 opacity-85">
          <rect x="2" y="4" width="16" height="12" rx="1.5" strokeWidth="1.4" />
          <rect x="4.5" y="6.5" width="11" height="7" strokeWidth="1.2" strokeDasharray="2 1.5" />
        </svg>
      );
    case "carousel":
      return (
        <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" className="shrink-0 opacity-85">
          <rect x="4" y="4" width="12" height="12" rx="1.5" strokeWidth="1.4" />
          <path d="M1.5 6.5v7M18.5 6.5v7" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      );
    case "logo":
      return (
        <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" className="shrink-0 opacity-85">
          <circle cx="10" cy="10" r="6.5" strokeWidth="1.4" />
          <path d="M10 6.5 11.5 9l2.5.5-2 1.8.5 2.5-2.5-1.3-2.5 1.3.5-2.5-2-1.8L8.5 9 10 6.5Z" strokeWidth="1.1" />
        </svg>
      );
    case "heading":
      return (
        <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" className="shrink-0 opacity-85">
          <path d="M4 5h12v2.5M4 5v2.5M9 5v10.5M11 5v10.5M7 15.5h6" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "divider":
      return (
        <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" className="shrink-0 opacity-85">
          <path d="M3 9h14M3 11h14" strokeWidth="1.3" strokeLinecap="round" />
          <path d="M10 4.5 8 6.5h4l-2-2ZM10 15.5 8 13.5h4l-2 2Z" strokeWidth="1.2" strokeLinejoin="round" />
        </svg>
      );
    case "text":
      return (
        <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" className="shrink-0 opacity-85">
          <path d="M3.5 5.5h13M3.5 8.5h13M3.5 11.5h13M3.5 14.5h8.5" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      );
    case "image":
      return (
        <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" className="shrink-0 opacity-85">
          <rect x="3" y="4" width="14" height="12" rx="1.5" strokeWidth="1.4" />
          <circle cx="7.2" cy="8" r="1.3" strokeWidth="1.2" />
          <path d="m4.5 14.5 4-4 2.5 2.5 2.5-2 3 3.5" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "button":
      return (
        <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" className="shrink-0 opacity-85">
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
    if (selectedIndex === -1) return;
    const itemTop = selectedIndex * ROW_HEIGHT;
    const itemBottom = itemTop + ROW_HEIGHT;
    const currentScroll = containerRef.current.scrollTop;
    const viewHeight = containerRef.current.clientHeight;
    if (itemTop < currentScroll) {
      containerRef.current.scrollTop = itemTop;
    } else if (itemBottom > currentScroll + viewHeight) {
      containerRef.current.scrollTop = itemBottom - viewHeight;
    }
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

  // Floating & Draggable Structure Window State (Elementor style — floats by default)
  const [isFloating, setIsFloating] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem("dw-structure-floating");
      return saved ? saved !== "docked" : true;
    } catch {
      return true;
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

    setInteractingWindow("drag");

    const onMove = (moveEvt: PointerEvent) => {
      const dx = moveEvt.clientX - startClientX;
      const dy = moveEvt.clientY - startClientY;
      if (!moved && Math.hypot(dx, dy) > 4) {
        moved = true;
        if (!isFloating) toggleFloatingMode(true);
      }
      if (!moved && !isFloating) return;
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
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const startResizeDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!isFloating) return;
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
      style={
        isFloating
          ? {
              top: `${winBounds.y}px`,
              left: `${winBounds.x}px`,
              width: `${winBounds.w}px`,
              height: `${winBounds.h}px`,
            }
          : undefined
      }
      className={
        isFloating
          ? "fixed z-[9980] flex flex-col overflow-hidden rounded-xl border border-[#2C2F36] bg-[#1E2024] text-[#E2E4E9] shadow-[0_24px_64px_rgba(0,0,0,0.65)] ring-1 ring-white/10"
          : "editor-layers flex min-h-0 flex-1 flex-col border-b border-[#2C2F36] bg-[#1E2024] text-[#E2E4E9]"
      }
    >
      {/* Elementor-style Draggable "Structure" Header Bar */}
      <div
        onPointerDown={startHeaderDrag}
        title="Drag to move Structure window anywhere on screen"
        className="flex cursor-grab select-none items-center justify-between border-b border-[#2C2F36] bg-[#191B1F] px-3 py-2.5 active:cursor-grabbing"
      >
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            disabled={filtering}
            onClick={toggleCollapseAll}
            aria-label={allCollapsed ? "Expand all layers" : "Collapse all layers"}
            title={allCollapsed ? "Expand all containers" : "Collapse all containers"}
            className="flex h-6 w-6 items-center justify-center rounded text-[#A4A8B3] transition hover:bg-white/10 hover:text-white disabled:opacity-40"
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
            aria-label="Filter or search structure"
            title="Search & filter structure"
            className={`flex h-6 w-6 items-center justify-center rounded transition ${
              showSearch || filtering ? "bg-white/15 text-white" : "text-[#A4A8B3] hover:bg-white/10 hover:text-white"
            }`}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
              <path d="M8 2.2 9.2 5.8 12.8 7 9.2 8.2 8 11.8 6.8 8.2 3.2 7 6.8 5.8 8 2.2Z" strokeLinejoin="round" />
              <path d="M12.5 11.2 13 12.7 14.5 13.2 13 13.7 12.5 15.2 12 13.7 10.5 13.2 12 12.7 12.5 11.2Z" strokeLinejoin="round" />
            </svg>
          </button>
        </div>

        <span className="pointer-events-none flex items-center gap-1.5 text-[13px] font-medium tracking-wide text-white">
          <span>Structure</span>
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
            aria-label={isFloating ? "Dock Structure to sidebar" : "Float Structure window"}
            title={isFloating ? "Dock Structure to sidebar" : "Float Structure window (drag anywhere)"}
            className="flex h-6 w-6 items-center justify-center rounded text-[#A4A8B3] transition hover:bg-white/10 hover:text-white"
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
              aria-label="Close structure panel"
              title="Close Structure"
              className="flex h-6 w-6 items-center justify-center rounded text-[#A4A8B3] transition hover:bg-white/10 hover:text-white"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />
              </svg>
            </button>
          ) : (
            <span className="w-6 text-right font-mono text-[10px] text-[#787D8A]">{rows.length}</span>
          )}
        </div>
      </div>

      {/* Collapsible Search & Filter Drawer */}
      {(showSearch || filtering) && (
        <div className="space-y-1.5 border-b border-[#2C2F36] bg-[#191B1F]/80 px-2.5 py-2">
          <input
            aria-label="Search layers"
            className="h-7 w-full rounded-lg border border-[#323640] bg-[#131519] px-2.5 text-xs text-white outline-none placeholder:text-[#787D8A] focus:border-[#4C82FB]"
            placeholder="Find Container, Heading, Text Editor…"
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
                className={`rounded-md px-2 py-0.5 text-[10px] font-medium capitalize transition ${
                  filter === value ? "bg-[#4C82FB]/25 text-[#6FA0FF]" : "text-[#9095A2] hover:bg-white/5 hover:text-white"
                }`}
              >
                {value}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Elementor Structure Tree Body */}
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
                  draggable={Boolean(onMove && field.structure?.remove)}
                  onDragStart={(event) => {
                    setDragging(field.id);
                    event.dataTransfer.setData("application/x-dakyworld-field", field.id);
                    event.dataTransfer.effectAllowed = "move";
                  }}
                  onDragEnd={() => {
                    setDragging(null);
                    setDrop(null);
                  }}
                  onDragOver={(event) => {
                    const source = dragging ? tree.nodes.get(dragging)?.field : undefined;
                    if (
                      !onMove ||
                      !source?.structure?.group ||
                      source.id === field.id ||
                      source.structure.group !== field.structure?.group ||
                      !field.structure.remove
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
                    paddingLeft: `${Math.min(depth - 1, 10) * 16 + 10}px`,
                    boxShadow:
                      drop?.id === field.id
                        ? `inset 0 ${drop.position === "before" ? "2px" : "-2px"} #4C82FB`
                        : undefined,
                  }}
                  className={`group flex w-full items-center gap-2 border-b border-white/[0.03] pr-2.5 text-left text-[12.5px] outline-none transition ${
                    dragging === field.id ? "opacity-40" : ""
                  } ${
                    isSelected
                      ? "bg-[#2C3039] font-medium text-white"
                      : depth === 1 && hasChildren && !expanded
                        ? "bg-[#26282E] text-[#D5D8DF] hover:bg-[#2B2E36]"
                        : "text-[#C5C8D1] hover:bg-[#252830] hover:text-white"
                  } ${isHidden ? "opacity-50" : ""}`}
                >
                  {/* Expand / Collapse Triangle Chevron */}
                  <span
                    aria-hidden="true"
                    onClick={(event) => {
                      if (hasChildren && !filtering) {
                        event.stopPropagation();
                        toggle(field.id);
                      }
                    }}
                    className={`flex h-4 w-4 shrink-0 items-center justify-center rounded ${
                      hasChildren ? "cursor-pointer text-[#A4A8B3] hover:text-white" : "pointer-events-none opacity-0"
                    }`}
                  >
                    {hasChildren && (
                      <svg width="9" height="9" viewBox="0 0 10 10" fill="currentColor">
                        {expanded ? <path d="M1.5 3 5 7.5 8.5 3H1.5Z" /> : <path d="M3 1.5 7.5 5 3 8.5V1.5Z" />}
                      </svg>
                    )}
                  </span>

                  {/* Elementor Wireframe Icon */}
                  <StructureIcon kindKey={info.kindKey} />

                  {/* Element Title & Subtle Preview */}
                  <span className="min-w-0 flex-1 truncate">
                    <span className="tracking-[0.01em]">{info.title}</span>
                    {info.subtitle && (
                      <span className="ml-1.5 text-[11px] font-normal text-[#7E8494]">{info.subtitle}</span>
                    )}
                  </span>

                  {/* Status Badges */}
                  {shared?.[field.id] && shared[field.id]!.state === "LINKED" && shared[field.id]!.slot === "self" && (
                    <span
                      aria-label={`Shared across ${shared[field.id]!.linkedPages} pages`}
                      className="shrink-0 rounded bg-[#4C82FB]/20 px-1 py-px text-[9px] font-semibold uppercase tracking-wider text-[#78A9FF]"
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
                    <span aria-label="Changed" className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#4C82FB]" />
                  )}

                  {/* Right-side Eye Visibility Toggle (Elementor style) */}
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
                          ? "text-amber-400 opacity-100 hover:bg-white/10"
                          : isSelected
                            ? "text-[#A4A8B3] opacity-90 hover:bg-white/10 hover:text-white"
                            : "text-[#8E93A2] opacity-0 group-hover:opacity-100 hover:bg-white/10 hover:text-white"
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
          <p role="status" className="p-3 text-center text-xs text-[#8E93A2]">
            No matching structure items.
          </p>
        )}
      </div>

      {/* Bottom Resize Handle Bar (matching Elementor Structure footer) */}
      <div
        onPointerDown={startResizeDrag}
        title={isFloating ? "Drag to resize Structure window" : undefined}
        className={`relative flex h-4 select-none items-center justify-center border-t border-[#2C2F36] bg-[#191B1F] text-[#787D8A] ${
          isFloating ? "cursor-ns-resize hover:text-white" : ""
        }`}
      >
        <span className="text-[10px] leading-none tracking-widest">•••</span>
        {isFloating && (
          <span
            onPointerDown={startResizeDrag}
            title="Drag to resize width & height"
            className="absolute right-1 bottom-0.5 h-3 w-3 cursor-nwse-resize text-[#787D8A] hover:text-white"
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
    return createPortal(fullContent, document.body);
  }
  return fullContent;
}

export function WebsiteBreadcrumbs({ fields, selectedId, onSelect }: { fields: SiteFieldRow[]; selectedId: string | null; onSelect: (id: string) => void }) {
  const tree = useMemo(() => websiteLayerTree(fields), [fields]);
  const selected = selectedId ? tree.nodes.get(selectedId) : undefined;
  if (!selected) return null;
  return <nav aria-label="Selected element hierarchy" className="flex flex-none items-center gap-1 overflow-x-auto border-b border-line px-3 py-2 text-[11px] text-muted">{[...layerAncestors(selected), selected].map((node, index) => <span key={node.field.id} className="flex shrink-0 items-center gap-1">{index > 0 && <span aria-hidden="true">›</span>}<button type="button" title={node.field.label} aria-current={node === selected ? "location" : undefined} onClick={() => onSelect(node.field.id)} className={`max-w-[100px] truncate rounded px-1 py-0.5 hover:bg-sunken ${node === selected ? "font-semibold text-ink" : "text-blue"}`}>{node.field.tag}</button></span>)}</nav>;
}
