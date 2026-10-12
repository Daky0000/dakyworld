import { useRef, useState, type ReactNode } from "react";
import { ColorCodeInput } from "./InspectorControls";
import { allowedAt, expandShorthand, readable, writeProperty, SHORTHANDS } from "../lib/websiteStyleValues";

export { allowedAt, expandShorthand, readable, writeProperty, SHORTHANDS };

/**
 * The pieces the Style tab is built from, in the shape of the page builder the
 * panel follows: a collapsible section, a label with a dot that says where its
 * value comes from, a size with its unit, a row of picture buttons, four linked
 * sides, and a repeater for list-valued properties.
 *
 * Every control reads through one context, `StyleCtx`, so the rules live in one
 * place: what this element has set at this screen size (`map`), what the page's
 * own HTML says (`source`), what a wider screen hands down (`inherited`), and
 * what the browser actually rendered (`computed`, shown as the placeholder).
 * Looking at an element never writes: a control only reports a change when it
 * is changed.
 */

export type Device = "desktop" | "tablet" | "mobile";

export type StyleCtx = {
  /** This draft's declarations at this screen size, shorthands expanded for reading. */
  map: Record<string, string>;
  /** The same declarations as written, for writing back without needless expansion. */
  raw: Record<string, string>;
  /** What the page's own HTML says at this screen size. */
  source: Record<string, string>;
  /** What a wider screen hands down (tablet and phone only). */
  inherited: Record<string, string>;
  computed: Record<string, string>;
  device: Device;
  readOnly: boolean;
  set: (property: string, value: string | null, commit?: boolean) => void;
  setMany: (patch: Record<string, string | null>, commit?: boolean) => void;
  commit: () => void;
};

/* ----------------------------------------------------------- the section */

/** Which sections somebody opened or shut, kept while they move between elements. */
const remembered: Record<string, boolean> = {};

export function StyleSection({ name, title, open, changed, summary, children }: { name: string; title: string; open: boolean; changed?: boolean; summary?: string; children: ReactNode }) {
  const [isOpen, setOpen] = useState(remembered[name] ?? open);
  return (
    <details
      className="dx-acc"
      data-section={name}
      open={isOpen}
      onToggle={(event) => {
        const next = (event.currentTarget as HTMLDetailsElement).open;
        remembered[name] = next;
        setOpen(next);
      }}
    >
      <summary>
        {title}
        {changed && <span className="dx-pdot dx-pdot-changed dx-sum-dot" aria-hidden="true" />}
        {summary && <small>{summary}</small>}
      </summary>
      <div className="dx-accb">{isOpen && children}</div>
    </details>
  );
}

/** "Show more", for the properties fewer people need. */
export function More({ name, defaultOpen = false, children }: { name: string; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(remembered[`more:${name}`] ?? defaultOpen);
  return (
    <>
      {open && children}
      <button
        type="button"
        className="dx-more"
        aria-expanded={open}
        onClick={() => {
          remembered[`more:${name}`] = !open;
          setOpen(!open);
        }}
      >
        {open ? "Show less" : "Show more"}
      </button>
    </>
  );
}

/* ------------------------------------------------------ label and its dot */

export type Origin = "changed" | "page" | "inherited" | null;

const same = (a: string | undefined, b: string | undefined) => (a ?? "").replace(/\s+/g, " ").trim() === (b ?? "").replace(/\s+/g, " ").trim();

/** Where a group of properties gets its value from, at this screen size. */
export function originOf(c: StyleCtx, props: string[]): Origin {
  if (props.some((property) => !same(c.map[property], c.source[property]))) return "changed";
  if (props.some((property) => c.map[property] !== undefined)) return "page";
  if (c.device !== "desktop" && props.some((property) => c.inherited[property] !== undefined)) return "inherited";
  return null;
}

const ORIGIN_TITLE: Record<Exclude<Origin, null>, string> = {
  changed: "Changed here. Click to put back what the page had.",
  page: "Set on this element in the page's HTML.",
  inherited: "Comes from a wider screen. Change it here to override it on this one.",
};

export function PropLabel({ c, label, props, htmlFor, aside }: { c: StyleCtx; label: string; props: string[]; htmlFor?: string; aside?: ReactNode }) {
  const origin = originOf(c, props);
  return (
    <div className="dx-fl">
      <span className="dx-lab">
        <label htmlFor={htmlFor}>{label}</label>
        {origin && (
          <button
            type="button"
            className={`dx-pdot dx-pdot-${origin}`}
            aria-label={origin === "changed" ? `Reset ${label}` : `${label}: ${ORIGIN_TITLE[origin]}`}
            title={ORIGIN_TITLE[origin]}
            disabled={origin !== "changed" || c.readOnly}
            onClick={() => c.setMany(Object.fromEntries(props.map((property) => [property, c.source[property] ?? null])), true)}
          />
        )}
      </span>
      {aside}
    </div>
  );
}

/* --------------------------------------------------------- number + unit */

export const UNITS = ["px", "%", "em", "rem", "vw", "vh", "ch"];
const NUMERIC = /^(-?\d*\.?\d+)([a-z%]*)$/i;

/** What a field shows when this element sets nothing: the wider screen's value, then the rendered one. */
export function placeholderOf(c: StyleCtx, property: string): string {
  const value = c.inherited[property] ?? c.computed[property] ?? "";
  const match = NUMERIC.exec(value.trim());
  if (match && (match[2] === "px" || match[2] === "")) return String(Math.round(Number(match[1]) * 100) / 100);
  return value && value !== "none" && value !== "normal" && value.length < 24 ? value : "";
}

/** A number complete enough to act on: `12`, `-3`, `1.5`, `.5` — not `1.` or `-`. */
const COMPLETE_NUMBER = /^-?\d*\.?\d+$/;

/**
 * What is in a box while somebody is typing in it.
 *
 * A number is written as it is typed, so the page moves under the cursor.
 * Anything else — `auto`, half a `calc(`, a number still waiting for its
 * decimals — stays in the box and is written when the box is left, because
 * `width: ca` is not a value and a draft that autosaved mid-word would hold it
 * as one. The box shows what was typed while it has the caret, and what the
 * element really has once it does not.
 */
export function useTyped(shown: string, write: (raw: string) => void, commit: () => void) {
  const [typing, setTyping] = useState<string | null>(null);
  return {
    value: typing ?? shown,
    onFocus: () => setTyping(shown),
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
      const raw = event.target.value;
      setTyping(raw);
      if (raw.trim() === "" || COMPLETE_NUMBER.test(raw.trim())) write(raw);
    },
    onBlur: () => {
      if (typing !== null) {
        // "12." was a number on its way somewhere; a lone "-" or "." was nothing.
        const left = typing.trim().replace(/\.$/, "");
        if (left !== "" && left !== "-" && !COMPLETE_NUMBER.test(typing.trim()) && typing.trim() !== shown.trim()) write(left);
      }
      setTyping(null);
      commit();
    },
    onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") event.currentTarget.blur();
    },
  };
}

/**
 * Drag a label sideways to change its number. Shift moves ten at a time. A
 * pointer is captured so the drag survives leaving the label.
 */
function useScrub(read: () => number, write: (next: number) => void, done: () => void, step = 1) {
  const start = useRef<{ x: number; value: number } | null>(null);
  return {
    onPointerDown: (event: React.PointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      start.current = { x: event.clientX, value: read() };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    onPointerMove: (event: React.PointerEvent<HTMLElement>) => {
      if (!start.current) return;
      const delta = Math.round((event.clientX - start.current.x) / 2) * step * (event.shiftKey ? 10 : 1);
      if (delta) write(Math.round((start.current.value + delta) * 100) / 100);
    },
    onPointerUp: () => {
      if (start.current) done();
      start.current = null;
    },
  };
}

export function SizeField({
  c,
  label,
  property,
  units = UNITS,
  min,
  aria,
  hideLabel,
  disabledReason,
}: {
  c: StyleCtx;
  label: string;
  property: string;
  units?: string[];
  min?: number;
  /** The accessible name, when the label on screen is shorter than what it means. */
  aria?: string;
  hideLabel?: boolean;
  disabledReason?: string;
}) {
  const name = aria ?? label;
  const current = c.map[property] ?? "";
  const match = NUMERIC.exec(current.trim());
  const bare = units.includes("") ? "" : "px";
  const knownUnit = match && units.includes(match[2] || bare) ? match[2] || bare : null;
  const [unit, setUnit] = useState<string>(knownUnit ?? (current ? "fx" : units[0]!));
  // fx, once chosen, stays chosen so a whole value can be typed; otherwise the
  // value's own unit leads, and an empty box keeps the unit last picked.
  const mode = unit === "fx" ? "fx" : current ? knownUnit ?? "fx" : unit;
  const shown = current ? (mode !== "fx" && knownUnit !== null ? match![1]! : current) : "";
  const disabled = c.readOnly || Boolean(disabledReason);
  const put = (raw: string, nextUnit = mode === "fx" ? bare : mode) => {
    const typed = raw.trim();
    if (!typed) return c.set(property, null);
    if (COMPLETE_NUMBER.test(typed)) {
      const number = min !== undefined ? Math.max(min, Number(typed)) : Number(typed);
      return c.set(property, `${number}${nextUnit}`);
    }
    c.set(property, typed);
  };
  const scrub = useScrub(() => Number(match?.[1] ?? placeholderOf(c, property)) || 0, (next) => put(String(next)), c.commit);
  const box = useTyped(shown, put, c.commit);
  const id = `dx-${property}-${label}`.replace(/[^a-z0-9-]/gi, "-");
  return (
    <div className="dx-f" title={disabledReason}>
      {!hideLabel && <PropLabel c={c} label={label} props={[property]} htmlFor={id} aside={<span className="dx-scrub" aria-hidden="true" {...(disabled ? {} : scrub)}>⇔</span>} />}
      <div className="dx-inp dx-num">
        <input id={id} type="text" inputMode="decimal" aria-label={name} disabled={disabled} placeholder={placeholderOf(c, property) || (mode === "fx" ? "auto" : "")} {...box} />
        <select
          className="dx-unit"
          aria-label={`${name} unit`}
          disabled={disabled}
          value={mode}
          onChange={(event) => {
            const next = event.target.value;
            setUnit(next);
            if (!current || next === "fx") return;
            const number = Number.parseFloat(current);
            if (Number.isFinite(number)) c.set(property, `${number}${next}`, true);
          }}
        >
          {units.map((option) => <option key={option} value={option}>{option === "" ? "—" : option.toUpperCase()}</option>)}
          <option value="fx" title="Type any value: auto, calc(…), min(…)">fx</option>
        </select>
      </div>
    </div>
  );
}

/** A plain number — a z-index, a column count — or blank for the website's own. */
export function NumberProp({ c, label, property, min, max, step = 1, aria, toCss, fromCss }: { c: StyleCtx; label: string; property: string; min?: number; max?: number; step?: number; aria?: string; toCss?: (n: number) => string; fromCss?: (css: string) => string }) {
  const current = c.map[property];
  const shown = current === undefined ? "" : fromCss ? fromCss(current) : current;
  const put = (raw: string) => {
    const typed = raw.trim();
    if (!typed) return c.set(property, null);
    if (!COMPLETE_NUMBER.test(typed)) return;
    let number = Number(typed);
    if (min !== undefined) number = Math.max(min, number);
    if (max !== undefined) number = Math.min(max, number);
    c.set(property, toCss ? toCss(number) : String(number));
  };
  const rendered = () => {
    const value = c.inherited[property] ?? c.computed[property] ?? "";
    return value && fromCss ? fromCss(value) : value === "auto" ? "" : value;
  };
  const scrub = useScrub(() => Number(shown || rendered()) || 0, (next) => put(String(next)), c.commit, step);
  const box = useTyped(shown, put, c.commit);
  const id = `dx-${property}-n`;
  return (
    <div className="dx-f">
      <PropLabel c={c} label={label} props={[property]} htmlFor={id} aside={<span className="dx-scrub" aria-hidden="true" {...(c.readOnly ? {} : scrub)}>⇔</span>} />
      <div className="dx-inp">
        <input id={id} type="text" inputMode="decimal" aria-label={aria ?? label} disabled={c.readOnly} placeholder={rendered() || "auto"} {...box} />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- choices */

export type Choice = { value: string; label: string; icon?: ReactNode };

/**
 * A row of buttons for a short list of values. Pressing the chosen one again
 * clears it, back to the website's own. The value in force is marked even when
 * it comes from the stylesheet, so the row never claims nothing applies.
 */
export function Buttons({ c, label, property, options, write, value, hideLabel }: { c: StyleCtx; label: string; property: string; options: Choice[]; write?: (value: string | null) => void; value?: string; hideLabel?: boolean }) {
  const own = value ?? c.map[property];
  const effective = (own ?? c.inherited[property] ?? c.computed[property] ?? "").trim();
  return (
    <div className="dx-f">
      {!hideLabel && <PropLabel c={c} label={label} props={[property]} />}
      <div className="dx-btns" role="radiogroup" aria-label={label}>
        {options.map((option) => {
          const chosen = own !== undefined && own.trim() === option.value;
          const inForce = !chosen && own === undefined && effective === option.value;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={chosen}
              aria-label={option.label}
              title={option.label}
              className={inForce ? "dx-eff" : undefined}
              disabled={c.readOnly}
              onClick={() => {
                const next = chosen ? null : option.value;
                if (write) write(next);
                else c.set(property, next, true);
              }}
            >
              {option.icon ?? option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function Select({ c, label, property, options, aria, write, value, placeholder }: { c: StyleCtx; label: string; property: string; options: Choice[] | { group: string; options: Choice[] }[]; aria?: string; write?: (value: string | null) => void; value?: string; placeholder?: string }) {
  const own = value ?? c.map[property] ?? "";
  const effective = (c.inherited[property] ?? c.computed[property] ?? "").trim();
  const flat = (options as (Choice | { group: string; options: Choice[] })[]).flatMap((entry) => ("group" in entry ? entry.options : [entry]));
  const known = flat.some((option) => option.value === own);
  const id = `dx-${property}-s`;
  return (
    <div className="dx-f">
      <PropLabel c={c} label={label} props={[property]} htmlFor={id} />
      <select
        id={id}
        aria-label={aria ?? label}
        disabled={c.readOnly}
        value={own}
        onChange={(event) => {
          const next = event.target.value || null;
          if (write) write(next);
          else c.set(property, next, true);
        }}
      >
        <option value="">{placeholder ?? (effective && effective !== "auto" && effective !== "normal" ? `Default (${flat.find((option) => option.value === effective)?.label ?? effective})` : "Default")}</option>
        {own && !known && <option value={own}>{own}</option>}
        {(options as (Choice | { group: string; options: Choice[] })[]).map((entry) =>
          "group" in entry ? (
            <optgroup key={entry.group} label={entry.group}>
              {entry.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </optgroup>
          ) : (
            <option key={entry.value} value={entry.value}>{entry.label}</option>
          ),
        )}
      </select>
    </div>
  );
}

export function ColourProp({ c, label, property, disabledReason }: { c: StyleCtx; label: string; property: string; disabledReason?: string }) {
  const placeholder = c.inherited[property] ?? c.computed[property] ?? "";
  return (
    <div className="dx-f" title={disabledReason}>
      <PropLabel c={c} label={label} props={[property]} />
      <ColorCodeInput
        label={label}
        className="dx-cbtn"
        value={c.map[property] ?? ""}
        placeholder={/^rgba\(0, 0, 0, 0\)$/.test(placeholder) ? "None" : rgbToHex(placeholder) ?? "#000000"}
        disabled={c.readOnly || Boolean(disabledReason)}
        onChange={(next) => c.set(property, next || null)}
        onCommit={c.commit}
      />
    </div>
  );
}

export function rgbToHex(value: string): string | null {
  const match = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(value.trim());
  if (!match) return /^#[0-9a-f]{3,8}$/i.test(value.trim()) ? value.trim() : null;
  const hex = `#${[match[1], match[2], match[3]].map((part) => Number(part).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
  return match[4] !== undefined && Number(match[4]) < 1 ? value.trim() : hex;
}

/* ---------------------------------------------------------- linked sides */

/**
 * Four values that usually move together — margin, padding, border widths,
 * corners. Linked, one box writes all four; unlinked, each side is its own.
 * Starts linked only when all four already agree.
 */
export function Linked({
  c,
  label,
  props,
  names,
  short,
  units = UNITS,
  linkTitle = "Link values",
  min,
}: {
  c: StyleCtx;
  label: string;
  props: string[];
  names: string[];
  /** What each box is called on screen when the full name does not fit; `names` stays the accessible name. */
  short?: string[];
  units?: string[];
  linkTitle?: string;
  min?: number;
}) {
  const values = props.map((property) => c.map[property] ?? "");
  const [linked, setLinked] = useState(values.every((value) => value === values[0]));
  const firstUnit = values.map((value) => NUMERIC.exec(value.trim())?.[2]).find(Boolean);
  const [unit, setUnit] = useState(firstUnit && units.includes(firstUnit) ? firstUnit : units[0]!);
  const disabled = c.readOnly;
  const toCss = (raw: string) => {
    const text = raw.trim();
    if (!text) return null;
    if (/^-?\d*\.?\d+$/.test(text)) return `${min !== undefined ? Math.max(min, Number(text)) : Number(text)}${unit}`;
    return text;
  };
  const shownOf = (value: string) => {
    const match = NUMERIC.exec(value.trim());
    return match && (match[2] || "px") === unit ? match[1]! : value;
  };
  return (
    <div className="dx-f">
      <PropLabel
        c={c}
        label={label}
        props={props}
        aside={
          <span className="dx-linkrow">
            <select
              className="dx-unit"
              aria-label={`${label} unit`}
              disabled={disabled}
              value={unit}
              onChange={(event) => {
                const next = event.target.value;
                setUnit(next);
                const patch: Record<string, string | null> = {};
                for (const [index, property] of props.entries()) {
                  const number = Number.parseFloat(values[index]!);
                  if (values[index] && Number.isFinite(number) && /^-?\d*\.?\d+[a-z%]*$/i.test(values[index]!.trim())) patch[property] = `${number}${next}`;
                }
                if (Object.keys(patch).length) c.setMany(patch, true);
              }}
            >
              {units.map((option) => <option key={option} value={option}>{option.toUpperCase()}</option>)}
            </select>
            <button type="button" className="dx-link" aria-pressed={linked} aria-label={linkTitle} title={linked ? "Linked: one value for every side. Click to set each side." : "Set separately. Click to link them."} disabled={disabled} onClick={() => setLinked(!linked)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                {linked ? <path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1" /> : <path d="M9 15l-1.5 1.5a3.5 3.5 0 01-5-5L4 10M15 9l1.5-1.5a3.5 3.5 0 015 5L20 14M8 8l8 8" />}
              </svg>
            </button>
          </span>
        }
      />
      <div className="dx-sides">
        {props.map((property, index) => (
          <Side
            key={property}
            label={`${label} ${names[index]!.toLowerCase()}`}
            caption={short?.[index] ?? names[index]!}
            title={names[index]!}
            shown={shownOf(values[index]!)}
            placeholder={placeholderOf(c, property) || "0"}
            disabled={disabled}
            onWrite={(raw) => {
              const css = toCss(raw);
              if (linked) c.setMany(Object.fromEntries(props.map((each) => [each, css])));
              else c.set(property, css);
            }}
            onCommit={c.commit}
          />
        ))}
      </div>
    </div>
  );
}

/** One of the linked boxes. Its own component so each keeps what is being typed in it. */
function Side({ label, caption, title, shown, placeholder, disabled, onWrite, onCommit }: { label: string; caption: string; title: string; shown: string; placeholder: string; disabled: boolean; onWrite: (raw: string) => void; onCommit: () => void }) {
  const box = useTyped(shown, onWrite, onCommit);
  return (
    <label className="dx-side">
      <input type="text" inputMode="decimal" aria-label={label} disabled={disabled} placeholder={placeholder} {...box} />
      <span title={title}>{caption}</span>
    </label>
  );
}

/* -------------------------------------------------------------- repeater */

/**
 * A list of stacked values — shadows, transforms, filters, layers. Each item
 * reads as one line and opens into its editor; "+" adds one. A value the rows
 * cannot express is shown as it is, with a way to clear it, never rewritten.
 */
export function Repeater<T>({
  label,
  items,
  summary,
  editor,
  onAdd,
  onRemove,
  onMove,
  unreadable,
  onClear,
  disabled,
  disabledReason,
  addLabel,
  extra,
}: {
  label: string;
  items: T[] | null;
  summary: (item: T) => string;
  editor: (item: T, index: number) => ReactNode;
  onAdd: () => void;
  onRemove: (index: number) => void;
  onMove?: (index: number, by: -1 | 1) => void;
  unreadable?: string;
  onClear?: () => void;
  disabled?: boolean;
  disabledReason?: string;
  addLabel?: string;
  extra?: ReactNode;
}) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div className="dx-rep" title={disabledReason}>
      <div className="dx-fl">
        <span className="dx-lab"><label>{label}</label>{items && items.length > 0 && <span className="dx-pdot dx-pdot-page" aria-hidden="true" />}</span>
        <span className="dx-linkrow">
          {extra}
          <button type="button" className="dx-add" aria-label={addLabel ?? `Add ${label.toLowerCase()}`} title={addLabel ?? `Add ${label.toLowerCase()}`} disabled={disabled || items === null} onClick={() => { onAdd(); setOpen(items?.length ?? 0); }}>+</button>
        </span>
      </div>
      {items === null && (
        <div className="dx-raw">
          <code>{unreadable}</code>
          {onClear && <button type="button" className="dx-rs" disabled={disabled} onClick={onClear}>Clear</button>}
        </div>
      )}
      {items?.map((item, index) => (
        <div key={index} className="dx-item" data-open={open === index || undefined}>
          <div className="dx-item-row">
            <button type="button" className="dx-item-sum" aria-expanded={open === index} onClick={() => setOpen(open === index ? null : index)}>
              {summary(item)}
            </button>
            {onMove && items.length > 1 && (
              <>
                <button type="button" className="dx-ib" aria-label={`Move ${summary(item)} up`} disabled={disabled || index === 0} onClick={() => onMove(index, -1)}>↑</button>
                <button type="button" className="dx-ib" aria-label={`Move ${summary(item)} down`} disabled={disabled || index === items.length - 1} onClick={() => onMove(index, 1)}>↓</button>
              </>
            )}
            <button type="button" className="dx-ib" aria-label={`Remove ${summary(item)}`} title="Remove" disabled={disabled} onClick={() => { onRemove(index); setOpen(null); }}>×</button>
          </div>
          {open === index && <div className="dx-item-ed">{editor(item, index)}</div>}
        </div>
      ))}
    </div>
  );
}

/** A small number box used inside repeater editors, where there is no property behind it. */
export function Num({ label, value, onChange, onCommit, unit, step = 1, min, max, disabled }: { label: string; value: number; onChange: (next: number) => void; onCommit?: () => void; unit?: string; step?: number; min?: number; max?: number; disabled?: boolean }) {
  const [text, setText] = useState(String(value));
  const [focused, setFocused] = useState(false);
  const shown = focused ? text : String(value);
  return (
    <label className="dx-nf">
      <span>{label}</span>
      <span className="dx-inp">
        <input
          type="text"
          inputMode="decimal"
          aria-label={label}
          disabled={disabled}
          value={shown}
          onFocus={() => { setText(String(value)); setFocused(true); }}
          onChange={(event) => {
            setText(event.target.value);
            const number = Number(event.target.value);
            if (event.target.value.trim() !== "" && Number.isFinite(number)) {
              let next = number;
              if (min !== undefined) next = Math.max(min, next);
              if (max !== undefined) next = Math.min(max, next);
              onChange(next);
            }
          }}
          onBlur={() => { setFocused(false); onCommit?.(); }}
          onKeyDown={(event) => {
            if (event.key === "ArrowUp" || event.key === "ArrowDown") {
              event.preventDefault();
              onChange(Math.round((value + (event.key === "ArrowUp" ? step : -step)) * 100) / 100);
            }
          }}
        />
        {unit && <em>{unit}</em>}
      </span>
    </label>
  );
}

/** Two to four options inside a repeater editor, as a segmented switch. */
export function Pick<T extends string>({ label, value, options, onChange, disabled }: { label: string; value: T; options: { value: T; label: string }[]; onChange: (next: T) => void; disabled?: boolean }) {
  return (
    <div className="dx-segc" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button key={option.value} type="button" role="radio" aria-checked={value === option.value} aria-pressed={value === option.value} disabled={disabled} onClick={() => onChange(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

/* ----------------------------------------------------------------- icons */

const line = (d: string, props: { rotate?: number } = {}) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={props.rotate ? { transform: `rotate(${props.rotate}deg)` } : undefined}>
    <path d={d} />
  </svg>
);

export const ICON = {
  arrowRight: line("M5 12h14M13 6l6 6-6 6"),
  arrowDown: line("M12 5v14M6 13l6 6 6-6"),
  arrowLeft: line("M19 12H5M11 6l-6 6 6 6"),
  arrowUp: line("M12 19V5M6 11l6-6 6 6"),
  justifyStart: line("M4 4v16M8 8h4v8H8zM14 8h3v8h-3z"),
  justifyCenter: line("M12 4v16M6 8h4v8H6zM14 8h4v8h-4z"),
  justifyEnd: line("M20 4v16M7 8h3v8H7zM12 8h4v8h-4z"),
  justifyBetween: line("M4 4v16M20 4v16M6 8h3v8H6zM15 8h3v8h-3z"),
  justifyAround: line("M4 4v16M20 4v16M7 8h3v8H7zM14 8h3v8h-3z"),
  justifyEvenly: line("M4 4v16M20 4v16M8 8h3v8H8zM13 8h3v8h-3z"),
  alignStart: line("M4 4h16M7 7h4v10H7zM13 7h4v6h-4z"),
  alignCenter: line("M4 12h16M7 6h4v12H7zM13 9h4v6h-4z"),
  alignEnd: line("M4 20h16M7 7h4v10H7zM13 11h4v6h-4z"),
  alignStretch: line("M4 4h16M4 20h16M7 7h4v10H7zM13 7h4v10h-4z"),
  wrapNo: line("M3 12h14M13 8l4 4-4 4M21 5v14"),
  wrap: line("M3 7h13a4 4 0 010 8H7M10 12l-3 3 3 3"),
  wrapReverse: line("M21 17H8a4 4 0 010-8h9M14 6l3 3-3 3"),
  textLeft: line("M4 6h16M4 10h10M4 14h16M4 18h10"),
  textCenter: line("M4 6h16M7 10h10M4 14h16M7 18h10"),
  textRight: line("M4 6h16M10 10h10M4 14h16M10 18h10"),
  textJustify: line("M4 6h16M4 10h16M4 14h16M4 18h16"),
  none: line("M6 6l12 12M18 6L6 18"),
  eye: line("M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 9a3 3 0 100 6 3 3 0 000-6z"),
  eyeOff: line("M3 3l18 18M10.6 6.1A10 10 0 0112 6c6.5 0 10 6 10 6a17 17 0 01-3.2 3.8M6.6 6.6A17 17 0 002 12s3.5 7 10 7a9.6 9.6 0 004.4-1"),
  scroll: line("M12 3v18M8 7l4-4 4 4M8 17l4 4 4-4"),
  play: line("M7 5l12 7-12 7z"),
  settings: line("M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4"),
  trash: line("M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"),
  desktop: line("M3 5h18v11H3zM8 20h8M12 16v4"),
  tablet: line("M6 3h12v18H6zM11 18h2"),
  phone: line("M8 3h8v18H8zM11 18h2"),
};
