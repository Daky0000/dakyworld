import { discoverFields, sanitizeValue, type FieldValue } from "./index.js";
import { restoreDocument } from "./document.js";

/** Restore the saved result, not the incremental edits made during that publish. */
export function versionDraft(source: string, current: Record<string, FieldValue>, snapshot: string, framework: boolean, label: string) {
  if (source === snapshot) return { values: {} as Record<string, FieldValue>, dropped: [] as string[] };
  if (!framework) return { values: restoreDocument(source, current, snapshot, label), dropped: [] as string[] };

  // Framework drafts must remain source edits: rendered HTML cannot replace TSX.
  const fields = new Map(discoverFields(source).fields.map(field => [field.id, field]));
  const values: Record<string, FieldValue> = {};
  const dropped: string[] = [];
  for (const previous of discoverFields(snapshot).fields) {
    const field = fields.get(previous.id);
    if (!field || field.tag !== previous.tag || field.kind !== previous.kind) { dropped.push(previous.id); continue; }
    const edit = sanitizeValue(field, {
      value: previous.value,
      ...(field.href !== undefined ? { href: previous.href ?? "" } : {}),
      ...(field.kind === "image" ? { alt: previous.alt ?? "" } : {}),
      style: previous.style ?? "",
      responsive: previous.responsive ?? {},
      ...(field.kind === "button" ? { variant: previous.variant ?? null, newTab: Boolean(previous.newTab) } : {}),
    });
    if (Object.keys(edit).length) values[field.id] = edit;
  }
  return { values, dropped };
}
