import { useMemo } from "react";

/**
 * The style half of the visual editor.
 *
 * Deliberately a fixed set of controls over an inline `style` attribute, not a
 * CSS box. Two reasons, and the second is the one that matters:
 *
 * A person who wants their heading bigger does not want a text box that takes
 * CSS. They want a bigger-looking heading, and every wrong thing they can type
 * into a free-text box is a broken page they cannot see the cause of.
 *
 * And the site is somebody's hand-written HTML that a developer goes on working
 * in. A rule added to a stylesheet would apply to every page at once and to
 * elements nobody was editing; an inline style changes exactly the element that
 * was clicked, and reads in the published diff as exactly that. The server
 * filters what it is sent regardless — see `safeStyle` — so nothing here is
 * load-bearing for safety, only for sanity.
 *
 * Anything the panel does not have a control for is left untouched: an unknown
 * declaration already on the element rides through the parse and back out
 * again, so editing the colour of something never quietly drops the rest of
 * what a developer wrote on it.
 */

/** Ink, blue, lime and the neutrals — the design system, as swatches. */
const COLOURS = [
  { label: "Ink", value: "#08101F" },
  { label: "Muted", value: "#69758A" },
  { label: "Blue", value: "#3157FF" },
  { label: "Blue light", value: "#6490FF" },
  { label: "Cyan", value: "#6FE4FF" },
  { label: "Lime", value: "#B8FF3D" },
  { label: "Cream", value: "#F4F5F0" },
  { label: "White", value: "#FFFFFF" },
];

const SIZES = ["12px", "14px", "16px", "18px", "20px", "24px", "32px", "40px", "56px", "72px"];
const WEIGHTS = [
  { label: "Light", value: "300" },
  { label: "Normal", value: "400" },
  { label: "Medium", value: "500" },
  { label: "Bold", value: "700" },
];
const ALIGNMENTS = [
  { label: "Left", value: "left" },
  { label: "Centre", value: "center" },
  { label: "Right", value: "right" },
];

/** `"color: red; font-size: 20px"` → `{ color: "red", "font-size": "20px" }`. */
export function parseStyle(style: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const declaration of (style ?? "").split(";")) {
    const colon = declaration.indexOf(":");
    if (colon < 1) continue;
    const property = declaration.slice(0, colon).trim().toLowerCase();
    const value = declaration.slice(colon + 1).trim();
    if (property && value) out[property] = value;
  }
  return out;
}

/** Back to a declaration string, in the order the properties were set. */
export function writeStyle(declarations: Record<string, string>): string {
  return Object.entries(declarations)
    .filter(([, value]) => value !== "")
    .map(([property, value]) => `${property}: ${value}`)
    .join("; ");
}

export function StylePanel({
  style,
  onChange,
  onReset,
  readOnly,
}: {
  style: string | undefined;
  onChange: (next: string) => void;
  onReset: () => void;
  readOnly?: boolean;
}) {
  const declarations = useMemo(() => parseStyle(style), [style]);

  const set = (property: string, value: string) => {
    const next = { ...declarations };
    if (value) next[property] = value;
    else delete next[property];
    onChange(writeStyle(next));
  };

  // Every property this panel does not own, so the person editing can see that
  // the developer's own styling is still there rather than wondering where it
  // went.
  const owned = new Set(["color", "background-color", "font-size", "font-weight", "text-align", "padding", "display"]);
  const untouched = Object.entries(declarations).filter(([property]) => !owned.has(property));

  return (
    <div className={`space-y-4 ${readOnly ? "pointer-events-none opacity-50" : ""}`}>
      <Row label="Text colour">
        <Swatches value={declarations.color ?? ""} onPick={(value) => set("color", value)} />
      </Row>

      <Row label="Background">
        <Swatches value={declarations["background-color"] ?? ""} onPick={(value) => set("background-color", value)} allowNone />
      </Row>

      <Row label="Size">
        <select className={SELECT} value={declarations["font-size"] ?? ""} onChange={(event) => set("font-size", event.target.value)}>
          <option value="">As designed</option>
          {SIZES.map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </select>
      </Row>

      <Row label="Weight">
        <div className="flex flex-wrap gap-1">
          <Chip active={!declarations["font-weight"]} onClick={() => set("font-weight", "")}>
            As designed
          </Chip>
          {WEIGHTS.map((weight) => (
            <Chip key={weight.value} active={declarations["font-weight"] === weight.value} onClick={() => set("font-weight", weight.value)}>
              {weight.label}
            </Chip>
          ))}
        </div>
      </Row>

      <Row label="Alignment">
        <div className="flex flex-wrap gap-1">
          <Chip active={!declarations["text-align"]} onClick={() => set("text-align", "")}>
            As designed
          </Chip>
          {ALIGNMENTS.map((alignment) => (
            <Chip
              key={alignment.value}
              active={declarations["text-align"] === alignment.value}
              onClick={() => set("text-align", alignment.value)}
            >
              {alignment.label}
            </Chip>
          ))}
        </div>
      </Row>

      <Row label="Space around">
        <div className="flex items-center gap-2">
          <input
            type="range"
            min={0}
            max={64}
            step={4}
            value={Number.parseInt(declarations.padding ?? "0", 10) || 0}
            onChange={(event) => set("padding", event.target.value === "0" ? "" : `${event.target.value}px`)}
            className="flex-1 accent-blue"
          />
          <span className="w-12 text-right font-mono text-[10px] uppercase tracking-[.1em] text-ink/40">
            {declarations.padding ?? "—"}
          </span>
        </div>
      </Row>

      <Row label="On the page">
        <div className="flex flex-wrap gap-1">
          <Chip active={declarations.display !== "none"} onClick={() => set("display", "")}>
            Shown
          </Chip>
          {/* Hiding rather than deleting, because nothing here removes an
              element from somebody's file — the parse is a splice, and a
              deletion would move every id after it. */}
          <Chip active={declarations.display === "none"} onClick={() => set("display", "none")}>
            Hidden
          </Chip>
        </div>
      </Row>

      {untouched.length > 0 && (
        <p className="border-t border-line pt-3 text-[11px] text-muted">
          Also styled by the developer, and left alone:{" "}
          <span className="font-mono">{untouched.map(([property]) => property).join(", ")}</span>
        </p>
      )}

      {style && (
        <button
          type="button"
          onClick={onReset}
          className="text-[11px] text-muted underline-offset-2 transition hover:text-ink hover:underline"
        >
          Put this element back the way it was designed
        </button>
      )}
    </div>
  );
}

const SELECT = "w-full rounded-xl border border-line bg-white px-3 py-2 text-sm text-ink outline-none focus:border-blue";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 font-mono text-[10px] uppercase tracking-[.12em] text-ink/40">{label}</div>
      {children}
    </div>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-2.5 py-1 text-[11px] transition ${
        active ? "border-ink bg-ink text-cream" : "border-line text-muted hover:border-ink/40 hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

function Swatches({ value, onPick, allowNone }: { value: string; onPick: (value: string) => void; allowNone?: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <button
        type="button"
        onClick={() => onPick("")}
        title="As designed"
        className={`h-6 rounded-full border px-2 text-[10px] transition ${
          value === "" ? "border-ink bg-ink text-cream" : "border-line text-muted hover:border-ink/40"
        }`}
      >
        {allowNone ? "None" : "As designed"}
      </button>
      {COLOURS.map((colour) => (
        <button
          key={colour.value}
          type="button"
          title={colour.label}
          aria-label={colour.label}
          onClick={() => onPick(colour.value)}
          style={{ background: colour.value }}
          className={`h-6 w-6 rounded-full border transition ${
            value.toLowerCase() === colour.value.toLowerCase() ? "border-blue ring-2 ring-blue/30" : "border-line hover:border-ink/40"
          }`}
        />
      ))}
      <input
        type="color"
        value={/^#[0-9a-f]{6}$/i.test(value) ? value : "#08101F"}
        onChange={(event) => onPick(event.target.value.toUpperCase())}
        title="Any other colour"
        aria-label="Pick any colour"
        className="h-6 w-6 cursor-pointer rounded-full border border-line bg-white p-0"
      />
    </div>
  );
}
