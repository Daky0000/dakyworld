import type { FieldEdit, SiteFieldRow } from "../lib/types";
import { WebsiteIconPicker } from "./WebsiteIconPicker";

/** `btn-primary` under stem `btn` reads as "Primary". */
export function variantLabel(stem: string | undefined, variant: string): string {
  if (!stem || !variant.startsWith(`${stem}-`)) return variant;
  const word = variant.slice(stem.length + 1).replace(/[-_]+/g, " ").trim();
  return word ? word.charAt(0).toUpperCase() + word.slice(1) : variant;
}

/**
 * The extra choices a button carries: its style variant, and whether it opens in a new tab.
 */
export function ButtonControls({
  field,
  edit,
  siteId,
  publicUrl,
  onChange,
  readOnly,
}: {
  field: SiteFieldRow;
  edit: FieldEdit | undefined;
  siteId?: string;
  publicUrl: string;
  onChange: (next: FieldEdit) => void;
  onNameFields?: () => void;
  naming?: boolean;
  readOnly: boolean;
}) {
  const variant = edit?.variant !== undefined ? edit.variant : (field.variant ?? null);
  const newTab = edit?.newTab ?? field.newTab ?? false;
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

      {(field.icon !== undefined || field.iconAddable) && (
        <WebsiteIconPicker
          siteId={siteId}
          publicUrl={publicUrl}
          current={field.icon}
          currentType={field.iconType}
          addable={field.iconAddable}
          position={field.iconPosition}
          choice={edit?.icon}
          choicePosition={edit?.iconPosition ?? field.iconPosition}
          readOnly={readOnly}
          onChoose={(nextIcon, side) => onChange({ ...edit, icon: nextIcon, ...(side ? { iconPosition: side } : {}) })}
          onReset={() => {
            const next = { ...edit };
            delete next.icon;
            delete next.iconPosition;
            onChange(next);
          }}
        />
      )}
    </div>
  );
}
