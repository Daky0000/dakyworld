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

export function SourceBlockStyle({ style, disabled, onChange }: { style: string; disabled?: boolean; onChange: (next: string) => void }) {
  const declarations = parseStyle(style);
  const set = (property: string, value: string) => {
    const next = { ...declarations };
    if (value) next[property] = value; else delete next[property];
    onChange(writeStyle(next));
  };
  const pixels = (property: string) => (next: number | null) => set(property, next === null ? "" : `${next}px`);
  return <div className="mt-3 space-y-2 rounded-xl border border-line bg-sunken p-3">
    <Row label="Text" control={<ColourField label="Text colour" bare allowNone value={declarations.color ?? ""} disabled={disabled} onChange={value => set("color", value)} />} />
    <Row label="Background" control={<ColourField label="Background colour" bare allowNone value={declarations["background-color"] ?? ""} disabled={disabled} onChange={value => set("background-color", value)} />} />
    <Row label="Text size" control={<NumberField label="Font size" bare unit="px" min={8} max={200} value={toNumber(declarations["font-size"])} disabled={disabled} onChange={pixels("font-size")} />} />
    <Row label="Align" control={<SelectField label="Text align" bare value={declarations["text-align"] ?? ""} options={ALIGN} disabled={disabled} onChange={value => set("text-align", value)} />} />
    <Row label="Padding" control={<NumberField label="Padding" bare unit="px" min={0} max={400} value={toNumber(declarations.padding)} disabled={disabled} onChange={pixels("padding")} />} />
    <Row label="Space above" control={<NumberField label="Margin top" bare unit="px" min={-200} max={400} value={toNumber(declarations["margin-top"])} disabled={disabled} onChange={pixels("margin-top")} />} />
    <Row label="Corners" control={<NumberField label="Border radius" bare unit="px" min={0} max={200} value={toNumber(declarations["border-radius"])} disabled={disabled} onChange={pixels("border-radius")} />} />
    <p className="text-xs text-muted">These are written onto the element in the source file. Anything your site's own stylesheet sets is not shown here, and a rule with higher specificity there can still win.</p>
    {style && <button type="button" className="text-xs text-blue hover:underline disabled:opacity-50" disabled={disabled} onClick={() => onChange("")}>Clear styling on this block</button>}
  </div>;
}
