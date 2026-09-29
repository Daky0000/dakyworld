import { useState } from "react";
import type { DraftConflict, FieldEdit } from "../lib/types";
import { Button } from "./ui";

/** One side of a contested field, as words rather than as markup. */
export function sideText(edit: FieldEdit | null): string {
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
  if (edit.icon !== undefined) parts.push(edit.icon === null ? "icon removed" : "icon changed");
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
export function ConflictDialog({
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
