export type LayerField = { id: string; parentId?: string; order?: number; label: string; preview?: string; tag: string };
export type LayerNode<T extends LayerField> = { field: T; children: LayerNode<T>[]; parent: LayerNode<T> | null };
export type LayerRow<T extends LayerField> = {
  node: LayerNode<T>; depth: number; position: number; siblings: number; hasChildren: boolean; expanded: boolean;
};

/** Build document order from the server's ordinal, never the section-list order. */
export function websiteLayerTree<T extends LayerField>(fields: readonly T[]) {
  const nodes = new Map(fields.map(field => [field.id, { field, children: [], parent: null } as LayerNode<T>]));
  const roots: LayerNode<T>[] = [];
  const ordered = [...fields].sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER));
  for (const field of ordered) {
    const node = nodes.get(field.id)!;
    const parent = field.parentId ? nodes.get(field.parentId) : undefined;
    const seen = new Set([field.id]);
    let at = parent;
    let cycle = false;
    while (at) {
      if (seen.has(at.field.id)) { cycle = true; break; }
      seen.add(at.field.id);
      at = at.field.parentId ? nodes.get(at.field.parentId) : undefined;
    }
    if (parent && !cycle) { node.parent = parent; parent.children.push(node); }
    else roots.push(node);
  }
  return { roots, nodes };
}

export function layerAncestors<T extends LayerField>(node?: LayerNode<T>): LayerNode<T>[] {
  const result: LayerNode<T>[] = [];
  let at = node?.parent;
  while (at) { result.unshift(at); at = at.parent; }
  return result;
}

export function visibleWebsiteLayers<T extends LayerField>(roots: LayerNode<T>[], collapsed: ReadonlySet<string>, matches?: ReadonlySet<string>) {
  const keep = new Set<string>();
  const remember = (node: LayerNode<T>): boolean => {
    const children = node.children.map(remember).some(Boolean);
    const included = !matches || matches.has(node.field.id) || children;
    if (included) keep.add(node.field.id);
    return included;
  };
  roots.forEach(remember);
  const rows: LayerRow<T>[] = [];
  const visit = (siblings: LayerNode<T>[], depth: number) => {
    const shown = siblings.filter(node => keep.has(node.field.id));
    shown.forEach((node, index) => {
      const hasChildren = node.children.some(child => keep.has(child.field.id));
      const expanded = hasChildren && (Boolean(matches) || !collapsed.has(node.field.id));
      rows.push({ node, depth, position: index + 1, siblings: shown.length, hasChildren, expanded });
      if (expanded) visit(node.children, depth + 1);
    });
  };
  visit(roots, 1);
  return rows;
}

/** A hidden selection returns to its nearest visible ancestor when tabbing into the tree. */
export function websiteLayerTabStop<T extends LayerField>(rows: readonly LayerRow<T>[], selected?: LayerNode<T>) {
  const visible = new Set(rows.map(row => row.node.field.id));
  let at = selected;
  while (at) {
    if (visible.has(at.field.id)) return at.field.id;
    at = at.parent ?? undefined;
  }
  return rows[0]?.node.field.id;
}

type LayerNavigation = { select?: string; expand?: string; collapse?: string };

/** Navigation follows the displayed tree, including ancestor-preserving search results. */
export function websiteLayerNavigation<T extends LayerField>(rows: readonly LayerRow<T>[], index: number, key: string, filtering = false): LayerNavigation | null {
  const row = rows[index];
  if (!row) return null;
  switch (key) {
    case "ArrowDown": return { select: rows[index + 1]?.node.field.id };
    case "ArrowUp": return { select: rows[index - 1]?.node.field.id };
    case "Home": return { select: rows[0]?.node.field.id };
    case "End": return { select: rows.at(-1)?.node.field.id };
    case "ArrowRight": {
      if (row.hasChildren && !row.expanded) return { expand: row.node.field.id };
      const next = rows[index + 1];
      return { select: next?.depth === row.depth + 1 ? next.node.field.id : undefined };
    }
    case "ArrowLeft": {
      if (row.expanded && !filtering) return { collapse: row.node.field.id };
      for (let previous = index - 1; previous >= 0; previous--) {
        if (rows[previous].depth < row.depth) return { select: rows[previous].node.field.id };
      }
      return {};
    }
    default: return null;
  }
}
