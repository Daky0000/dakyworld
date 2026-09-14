import { useState } from "react";
import { ColourField, NumberField, Row, SelectField, parseStyle, toNumber, writeStyle } from "./InspectorControls";

/**
 * The style controls for one block of a framework page.
 *
 * Deliberately the same controls the HTML inspector uses, not lookalikes: the
 * colour picker, the number field with its scrub handle and the select are
 * imported from `InspectorControls`, so a colour chosen on a `.tsx` page behaves
 * exactly as it does on an HTML one and there is one set of these to maintain.
 *
 * What differs is how much is offered. The HTML editor reads computed values out
 * of a live preview frame, so it can show where a value came from — the site's
 * stylesheet, an inline style, an override. Here there is no frame we control:
 * the picture beside the panel is the customer's published page, built by their
 * host from code we do not run. So this shows what is written on the element in
 * the file and nothing else, and says so, rather than implying the panel knows
 * what the visitor sees.
 *
 * The declarations it writes are ordinary CSS. `sourceStyle.ts` turns them into
 * whichever spelling the language wants — a `style` attribute for a template, a
 * style object for JSX — and runs them through the same sanitiser as the HTML
 * side, so a value refused there is refused here.
 */
const ALIGN = [
  { label: "Default", value: "" },
  { label: "Left", value: "left" },
  { label: "Centre", value: "center" },
  { label: "Right", value: "right" },
];

const DEVICES = [
  { key: "base" as const, label: "Desktop" },
  { key: "tablet" as const, label: "Tablet" },
  { key: "mobile" as const, label: "Phone" },
];

export function SourceBlockStyle({ style, responsive, hoverable, devicesEditable, deviceReason, disabled, onChange, onResponsive }: {
  style: string;
  responsive?: { tablet?: string; mobile?: string };
  hoverable?: boolean;
  devicesEditable?: boolean;
  deviceReason?: string;
  disabled?: boolean;
  onChange: (next: string) => void;
  onResponsive?: (next: { tablet?: string; mobile?: string }) => void;
}) {
  /**
   * Which width is being edited, and whether the hover values are showing.
   *
   * Desktop writes the element's own style; Tablet and Phone write overrides
   * that become media rules. Hover is a third pass over the same controls,
   * writing `--dw-hover-*` custom properties into the desktop style — which is
   * how the HTML editor does it, so one fixed stylesheet block serves both.
   */
  const [device, setDevice] = useState<"base" | "tablet" | "mobile">("base");
  const [hover, setHover] = useState(false);
  const editing = device === "base" ? style : (responsive?.[device] ?? "");
  const declarations = parseStyle(editing);
  const prefix = hover && device === "base" ? "--dw-hover-" : "";
  const read = (property: string) => declarations[`${prefix}${property}`] ?? "";
  const set = (property: string, value: string) => {
    const next = { ...declarations };
    const key = `${prefix}${property}`;
    if (value) next[key] = value; else delete next[key];
    const written = writeStyle(next);
    if (device === "base") onChange(written);
    else onResponsive?.({ ...responsive, [device]: written });
  };
  const pixels = (property: string) => (next: number | null) => set(property, next === null ? "" : `${next}px`);
  const clear = () => {
    if (device === "base") onChange("");
    else onResponsive?.({ ...responsive, [device]: "" });
  };
  return <div className="mt-3 space-y-2 rounded-xl border border-line bg-sunken p-3">
    <div className="flex flex-wrap items-center gap-1">
      {DEVICES.map(entry => {
        const unavailable = entry.key !== "base" && !devicesEditable;
        return <button key={entry.key} type="button" disabled={disabled || unavailable} title={unavailable ? deviceReason ?? "Screen-size styling is not available for this block" : `Edit this block at ${entry.label.toLowerCase()} width`}
          className={`rounded px-2 py-1 text-xs disabled:opacity-40 ${device === entry.key ? "bg-white text-blue" : "text-muted hover:text-ink"}`}
          onClick={() => { setDevice(entry.key); if (entry.key !== "base") setHover(false); }}>{entry.label}{entry.key !== "base" && responsive?.[entry.key] ? " ·" : ""}</button>;
      })}
      {device === "base" && hoverable !== false && <button type="button" disabled={disabled}
        className={`ml-auto rounded px-2 py-1 text-xs disabled:opacity-40 ${hover ? "bg-white text-blue" : "text-muted hover:text-ink"}`}
        title="Edit what this block looks like while the pointer is over it"
        onClick={() => setHover(!hover)}>Hover{Object.keys(declarations).some(key => key.startsWith("--dw-hover-")) ? " ·" : ""}</button>}
    </div>
    <Row label="Text" control={<ColourField label="Text colour" bare allowNone value={read("color")} disabled={disabled} onChange={value => set("color", value)} />} />
    <Row label="Background" control={<ColourField label="Background colour" bare allowNone value={read("background-color")} disabled={disabled} onChange={value => set("background-color", value)} />} />
    {!(hover && device === "base") && <Row label="Text size" control={<NumberField label="Font size" bare unit="px" min={8} max={200} value={toNumber(read("font-size"))} disabled={disabled} onChange={pixels("font-size")} />} />}
    {!(hover && device === "base") && <Row label="Align" control={<SelectField label="Text align" bare value={read("text-align")} options={ALIGN} disabled={disabled} onChange={value => set("text-align", value)} />} />}
    {!(hover && device === "base") && <Row label="Padding" control={<NumberField label="Padding" bare unit="px" min={0} max={400} value={toNumber(read("padding"))} disabled={disabled} onChange={pixels("padding")} />} />}
    {!(hover && device === "base") && <Row label="Space above" control={<NumberField label="Margin top" bare unit="px" min={-200} max={400} value={toNumber(read("margin-top"))} disabled={disabled} onChange={pixels("margin-top")} />} />}
    {!(hover && device === "base") && <Row label="Corners" control={<NumberField label="Border radius" bare unit="px" min={0} max={200} value={toNumber(read("border-radius"))} disabled={disabled} onChange={pixels("border-radius")} />} />}
    <p className="text-xs text-muted">{device === "base"
      ? (hover ? "Shown while the pointer is over this block. Colour, background, shadow, opacity and transform can differ on hover; sizes and spacing cannot." : "Written onto the element in the source file. Anything your site's own stylesheet sets is not shown here, and a rule with higher specificity there can still win.")
      : `Applied at ${device === "tablet" ? "1024px" : "640px"} wide and below, as a rule in your site's stylesheet. Phones inherit tablet values until you change them here.`}</p>
    {editing && <button type="button" className="text-xs text-blue hover:underline disabled:opacity-50" disabled={disabled} onClick={clear}>
      {device === "base" ? "Clear styling on this block" : `Clear ${device === "tablet" ? "tablet" : "phone"} styling on this block`}
    </button>}
  </div>;
}
