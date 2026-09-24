import { useEffect, useState } from "react";

const LENGTH_PROPERTIES = new Set([
  "width",
  "height",
  "max-width",
  "min-width",
  "min-height",
  "max-height",
  "font-size",
  "line-height",
  "letter-spacing",
  "border-radius",
  "row-gap",
  "column-gap",
  "gap",
  "top",
  "right",
  "bottom",
  "left",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
]);

function getUnitsForProperty(property: string): string[] {
  if (property === "width" || property === "max-width" || property === "min-width") {
    return ["px", "%", "vw"];
  }
  if (property === "height" || property === "min-height" || property === "max-height") {
    return ["px", "%", "vh"];
  }
  if (property === "font-size" || property === "line-height" || property === "letter-spacing") {
    return ["px", "rem", "em", "%"];
  }
  return ["px", "%", "rem"];
}

function splitCssNumericAndUnit(raw: string, fallbackUnit: string): { num: string; unit: string } {
  const trimmed = (raw ?? "").trim();
  if (!trimmed || trimmed === "auto" || trimmed === "none" || trimmed === "normal") {
    return { num: "", unit: fallbackUnit };
  }
  const match = /^(-?[\d.]+)\s*([a-z%]*)$/i.exec(trimmed);
  if (match) {
    const num = match[1] ?? "";
    const unit = (match[2] || fallbackUnit).toLowerCase();
    return { num, unit };
  }
  return { num: trimmed, unit: fallbackUnit };
}

export function UnitPillSelector({
  units,
  value,
  disabled,
  onChange,
}: {
  units: string[];
  value: string;
  disabled?: boolean;
  onChange: (unit: string) => void;
}) {
  return (
    <span className="inline-flex items-center gap-0.5 text-[10px] font-bold uppercase tracking-wider">
      {units.map((u) => {
        const active = value.toLowerCase() === u.toLowerCase();
        return (
          <button
            key={u}
            type="button"
            disabled={disabled}
            onClick={() => onChange(u)}
            className={`rounded-md px-1.5 py-0.5 uppercase transition ${
              active
                ? "bg-blue/15 text-blue shadow-2xs"
                : "text-muted hover:text-ink"
            }`}
          >
            {u}
          </button>
        );
      })}
    </span>
  );
}

export function CssValueField({
  property,
  label,
  name,
  prefix,
  value,
  disabled,
  bare,
  unitOverride,
  hideUnitSelector,
  onChange,
}: {
  property: string;
  label: string;
  name?: string;
  /** A letter inside or below the well — W, H — where two fields share one row label. */
  prefix?: string;
  value: string;
  disabled?: boolean;
  bare?: boolean;
  unitOverride?: string;
  hideUnitSelector?: boolean;
  onChange: (value: string) => void;
}) {
  const isLength = LENGTH_PROPERTIES.has(property);
  const units = getUnitsForProperty(property);
  const parsed = splitCssNumericAndUnit(value, unitOverride ?? units[0] ?? "px");

  const [numText, setNumText] = useState(isLength ? parsed.num : value);
  const [unit, setUnit] = useState(unitOverride ?? parsed.unit);
  const [error, setError] = useState(false);

  useEffect(() => {
    const nextParsed = splitCssNumericAndUnit(value, unitOverride ?? units[0] ?? "px");
    setNumText(isLength ? nextParsed.num : value);
    setUnit(unitOverride ?? nextParsed.unit);
    setError(false);
  }, [value, unitOverride, isLength]);

  const emitLength = (nextNum: string, nextUnit: string) => {
    const clean = nextNum.trim();
    if (!clean) {
      setError(false);
      if (value !== "") onChange("");
      return;
    }
    if (clean === "auto" || clean === "none" || clean === "normal") {
      setError(false);
      onChange(clean);
      return;
    }
    const numVal = Number(clean);
    if (!Number.isFinite(numVal)) {
      setError(true);
      return;
    }
    const candidate = `${clean}${nextUnit}`;
    setError(false);
    if (candidate !== value) onChange(candidate);
  };

  const commitFree = () => {
    if (isLength) {
      emitLength(numText, unitOverride ?? unit);
      return;
    }
    const next = numText.trim();
    if (
      next &&
      (!CSS.supports(property, next) ||
        next.length > 120 ||
        /url\s*\(|expression\s*\(|[<>"'`\\]/i.test(next))
    ) {
      setError(true);
      return;
    }
    setError(false);
    if (next !== value) onChange(next);
  };

  const box = `h-7 w-full rounded-lg border bg-white px-2 text-center font-mono text-[11px] text-ink outline-none transition placeholder:text-faint focus:border-blue focus:ring-2 focus:ring-blue/20 hover:border-line-strong ${
    error ? "border-danger-solid" : "border-line"
  }`;

  const field = (
    <input
      aria-label={label}
      aria-invalid={error}
      type={isLength ? "number" : "text"}
      step="any"
      className={box}
      value={numText}
      disabled={disabled}
      placeholder="0"
      onChange={(event) => {
        const raw = event.target.value;
        setNumText(raw);
        if (isLength && (raw === "" || /^-?\d+(\.\d+)?$/.test(raw.trim()))) {
          emitLength(raw, unitOverride ?? unit);
        }
      }}
      onBlur={commitFree}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          setNumText(isLength ? parsed.num : value);
          setError(false);
        }
      }}
    />
  );

  const problem = error ? (
    <span role="alert" className="mt-1 block text-[11px] text-danger-text">
      Enter a valid number.
    </span>
  ) : null;

  if (bare) {
    return (
      <span className="block min-w-0 flex-1">
        {isLength && !hideUnitSelector && !unitOverride && (
          <span className="mb-1 flex items-center justify-end">
            <UnitPillSelector
              units={units}
              value={unit}
              disabled={disabled}
              onChange={(nextU) => {
                setUnit(nextU);
                if (numText.trim()) emitLength(numText, nextU);
              }}
            />
          </span>
        )}
        {field}
        {prefix && (
          <span
            aria-hidden
            className="mt-0.5 block text-center font-sans text-[10px] text-muted"
          >
            {prefix}
          </span>
        )}
        {problem}
      </span>
    );
  }

  return (
    <label className="min-w-0 flex-1 text-[11px] text-muted">
      <span className="mb-1 flex items-center justify-between gap-1">
        <span>{name ?? label}</span>
        {isLength && !hideUnitSelector && (
          <UnitPillSelector
            units={units}
            value={unitOverride ?? unit}
            disabled={disabled}
            onChange={(nextU) => {
              setUnit(nextU);
              if (numText.trim()) emitLength(numText, nextU);
            }}
          />
        )}
      </span>
      {field}
      {problem}
    </label>
  );
}
