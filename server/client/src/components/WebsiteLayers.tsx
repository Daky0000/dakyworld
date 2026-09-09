import { useEffect, useMemo, useRef, useState } from "react";
import type { FieldEdit, SharedFieldScope, SiteFieldRow } from "../lib/types";
import { layerAncestors, visibleWebsiteLayers, websiteLayerNavigation, websiteLayerTabStop, websiteLayerTree } from "../lib/websiteLayers";

export function WebsiteLayers({ fields, edits, problems, shared, selectedId, onSelect, onMove }: {
  fields: SiteFieldRow[]; edits: Record<string, FieldEdit>; problems: Map<string, string>; selectedId: string | null; onSelect: (id: string) => void;
  /** Which fields belong to a shared element, so the tree can say so. */
  shared?: Record<string, SharedFieldScope>;
  onMove?: (id: string, target: string, position: "before" | "after") => void;
}) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; position: "before" | "after" } | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "changed" | "issues">("all");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const tree = useMemo(() => websiteLayerTree(fields), [fields]);
  const query = search.trim().toLowerCase();
  const filtering = Boolean(query || filter !== "all");
  const matches = useMemo(() => filtering ? new Set(fields.filter(field => {
    const label = `${field.label} ${field.tag} ${field.preview} ${field.id}`.toLowerCase();
    return (!query || label.includes(query)) && (filter === "all" || (filter === "changed" ? Object.keys(edits[field.id] ?? {}).length > 0 : problems.has(field.id)));
  }).map(field => field.id)) : undefined, [fields, query, filter, edits, problems, filtering]);
  const rows = useMemo(() => visibleWebsiteLayers(tree.roots, collapsed, matches), [tree, collapsed, matches]);
  const selected = selectedId ? tree.nodes.get(selectedId) : undefined;
  useEffect(() => {
    if (!selected) return;
    setCollapsed(current => { const next = new Set(current); for (const node of layerAncestors(selected)) next.delete(node.field.id); return next; });
    // A canvas selection is always reachable, even after a previous search.
    if (matches && !rows.some(row => row.node.field.id === selected.field.id)) { setSearch(""); setFilter("all"); }
  }, [selectedId]);
  const select = (id: string) => { onSelect(id); buttons.current.get(id)?.focus(); };
  const toggle = (id: string) => {
    if (!collapsed.has(id) && layerAncestors(selected).some(node => node.field.id === id)) select(id);
    setCollapsed(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  };
  const collapseAll = () => {
    const root = layerAncestors(selected)[0];
    if (root) onSelect(root.field.id);
    setCollapsed(new Set(fields.map(field => field.id)));
  };
  const focusableId = websiteLayerTabStop(rows, selected);
  return <div className="flex min-h-0 flex-1 flex-col border-b border-line">
    <div className="space-y-2 px-3 py-3">
      <div className="flex items-center justify-between"><span className="text-xs font-semibold">Layers</span><div className="flex gap-2"><button aria-label="Expand all layers" disabled={filtering} className="text-[10px] text-muted hover:text-ink disabled:cursor-default disabled:opacity-40" type="button" onClick={() => setCollapsed(new Set())}>Expand</button><button aria-label="Collapse all layers" disabled={filtering} className="text-[10px] text-muted hover:text-ink disabled:cursor-default disabled:opacity-40" type="button" onClick={collapseAll}>Collapse</button></div></div>
      <input aria-label="Search layers" className="h-8 w-full rounded-lg border border-line px-2 text-xs outline-none focus:border-blue" placeholder="Find text, image or container…" value={search} onChange={event => setSearch(event.target.value)} />
      <div role="group" className="flex gap-1" aria-label="Filter layers">{(["all", "changed", "issues"] as const).map(value => <button type="button" key={value} aria-pressed={filter === value} onClick={() => setFilter(value)} className={`rounded-lg px-2 py-1 text-[10px] capitalize ${filter === value ? "bg-blue/10 text-blue" : "text-muted hover:bg-sunken"}`}>{value}</button>)}</div>
    </div>
    <div role="tree" aria-label="Page layers" className="min-h-[100px] flex-1 overflow-auto px-2 pb-2">
      {rows.map(({ node, depth, position, siblings, hasChildren, expanded }, index) => {
        const field = node.field;
        return <button key={field.id} draggable={Boolean(onMove && field.structure?.remove)} onDragStart={event => { setDragging(field.id); event.dataTransfer.setData("application/x-dakyworld-field", field.id); event.dataTransfer.effectAllowed = "move"; }} onDragEnd={() => { setDragging(null); setDrop(null); }} onDragOver={event => {
          const source = dragging ? tree.nodes.get(dragging)?.field : undefined;
          if (!onMove || !source?.structure?.group || source.id === field.id || source.structure.group !== field.structure?.group || !field.structure.remove) return;
          event.preventDefault(); event.dataTransfer.dropEffect = "move";
          const rect = event.currentTarget.getBoundingClientRect();
          setDrop({ id: field.id, position: event.clientY < rect.top + rect.height / 2 ? "before" : "after" });
        }} onDrop={event => {
          event.preventDefault();
          if (onMove && dragging && drop?.id === field.id && event.dataTransfer.getData("application/x-dakyworld-field") === dragging) onMove(dragging, field.id, drop.position);
          setDragging(null); setDrop(null);
        }} ref={button => { if (button) buttons.current.set(field.id, button); else buttons.current.delete(field.id); }} type="button" role="treeitem" aria-level={depth} aria-posinset={position} aria-setsize={siblings} aria-selected={field.id === selectedId} aria-expanded={hasChildren ? expanded : undefined} tabIndex={field.id === focusableId ? 0 : -1} title={`${field.label} · ${field.tag}${problems.get(field.id) ? ` · ${problems.get(field.id)}` : ""}`} onClick={() => onSelect(field.id)} onKeyDown={event => {
          const action = websiteLayerNavigation(rows, index, event.key, filtering);
          if (!action) return;
          event.preventDefault();
          if (action.select) select(action.select);
          if (action.expand || action.collapse) toggle(field.id);
        }} style={{ paddingLeft: `${Math.min(depth - 1, 12) * 12 + 6}px`, boxShadow: drop?.id === field.id ? `inset 0 ${drop.position === "before" ? "2px" : "-2px"} #3157ff` : undefined }} className={`flex w-full items-center gap-1.5 rounded-lg py-1.5 pr-2 text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-blue ${dragging === field.id ? "opacity-40" : ""} ${field.id === selectedId ? "bg-blue/10 text-ink" : "text-muted hover:bg-sunken"}`}>
          <span className="w-3 shrink-0 text-center" aria-hidden="true" onClick={event => { if (hasChildren && !filtering) { event.stopPropagation(); toggle(field.id); } }}>{hasChildren ? expanded ? "▾" : "▸" : ""}</span>
          <span className="w-4 shrink-0 text-center font-mono text-[9px]" aria-hidden="true">{field.kind === "container" ? "□" : field.kind === "image" ? "▧" : field.kind === "link" || field.kind === "button" ? "↗" : "T"}</span>
          <span className="min-w-0 flex-1 truncate">{field.kind === "container" ? field.label : field.preview || field.label}</span>
          {shared?.[field.id] && shared[field.id]!.state === "LINKED" && shared[field.id]!.slot === "self" && (
            <span aria-label={`Shared across ${shared[field.id]!.linkedPages} pages`} title={`${shared[field.id]!.name} · shared across ${shared[field.id]!.linkedPages} pages`} className="shrink-0 rounded bg-blue/10 px-1 py-px text-[8px] font-semibold uppercase tracking-[.08em] text-blue">
              Shared
            </span>
          )}
          {shared?.[field.id] && shared[field.id]!.state === "DETACHED" && shared[field.id]!.slot === "self" && (
            <span aria-label="Detached from a shared element" title={`Detached from ${shared[field.id]!.name}. Future changes to it will not reach this page.`} className="shrink-0 rounded bg-sunken px-1 py-px text-[8px] font-semibold uppercase tracking-[.08em] text-muted">
              Detached
            </span>
          )}
          {problems.has(field.id) && <span aria-label="Needs attention" className="text-danger-text">!</span>}
          {Object.keys(edits[field.id] ?? {}).length > 0 && <span aria-label="Changed" className="text-blue">●</span>}
        </button>;
      })}
      {!rows.length && <p role="status" className="p-3 text-xs text-muted">No matching layers. Try another search or filter.</p>}
    </div>
  </div>;
}

export function WebsiteBreadcrumbs({ fields, selectedId, onSelect }: { fields: SiteFieldRow[]; selectedId: string | null; onSelect: (id: string) => void }) {
  const tree = useMemo(() => websiteLayerTree(fields), [fields]);
  const selected = selectedId ? tree.nodes.get(selectedId) : undefined;
  if (!selected) return null;
  return <nav aria-label="Selected element hierarchy" className="flex flex-none items-center gap-1 overflow-x-auto border-b border-line px-3 py-2 text-[10px] text-muted">{[...layerAncestors(selected), selected].map((node, index) => <span key={node.field.id} className="flex shrink-0 items-center gap-1">{index > 0 && <span aria-hidden="true">›</span>}<button type="button" title={node.field.label} aria-current={node === selected ? "location" : undefined} onClick={() => onSelect(node.field.id)} className={`max-w-[100px] truncate rounded px-1 py-0.5 hover:bg-sunken ${node === selected ? "font-semibold text-ink" : "text-blue"}`}>{node.field.tag}</button></span>)}</nav>;
}
