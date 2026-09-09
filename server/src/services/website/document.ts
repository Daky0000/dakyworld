import { createHash } from "node:crypto";
import type { FieldValue } from "./regions.js";
import type { FieldChangeSummary } from "./index.js";

/** Reserved metadata is only written by the server's structure endpoint. */
export const DOCUMENT_KEY = "$document";
export type DocumentSnapshot = { html: string; values: Record<string, FieldValue>; changes: string[]; summary?: FieldChangeSummary[] };
export type DraftDocument = { baseHash: string; html: string; changes: string[]; summary?: FieldChangeSummary[]; undo: DocumentSnapshot[]; redo: DocumentSnapshot[] };
export const sourceHash = (html: string) => createHash("sha256").update(html).digest("hex");
export const draftDocument = (values: Record<string, FieldValue>) => values[DOCUMENT_KEY]?.document;
export const fieldValues = (values: Record<string, FieldValue>) => Object.fromEntries(Object.entries(values).filter(([id]) => id !== DOCUMENT_KEY));
export const editingSource = (source: string, values: Record<string, FieldValue>) => draftDocument(values)?.html ?? source;
export const documentChanged = (source: string, values: Record<string, FieldValue>) => Boolean(draftDocument(values) && draftDocument(values)!.html !== source);

/** Bound stored snapshots to 20 actions and six megabytes of history. */
export function boundedHistory(snapshots: DocumentSnapshot[]): DocumentSnapshot[] {
  const kept: DocumentSnapshot[] = [];
  let bytes = 0;
  for (const snapshot of snapshots.slice(-20).reverse()) {
    const size = Buffer.byteLength(JSON.stringify(snapshot));
    if (bytes + size > 6 * 1024 * 1024) break;
    kept.unshift(snapshot); bytes += size;
  }
  return kept;
}

export function versionValues(values: Record<string, FieldValue>): Record<string, FieldValue> {
  const document = draftDocument(values);
  return document ? { ...values, [DOCUMENT_KEY]: { document: { ...document, undo: [], redo: [] } } } : values;
}

export function restoreDocument(source: string, values: Record<string, FieldValue>, html: string, label: string): Record<string, FieldValue> {
  const previous = draftDocument(values);
  const snapshot = { html: editingSource(source, values), values: fieldValues(values), changes: previous?.changes ?? [], summary: previous?.summary };
  return { [DOCUMENT_KEY]: { document: { baseHash: sourceHash(source), html, changes: [label], undo: boundedHistory([snapshot]), redo: [] } } };
}
