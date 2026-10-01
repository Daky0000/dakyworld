import React, { useEffect, useState } from "react";
import { IconDesktop, IconTablet, IconPhone } from "./WebsiteIcons";

export const POSITION_PRESETS = [
  { label: "Default", value: "" },
  { label: "Center Center", value: "center center" },
  { label: "Center Left", value: "left center" },
  { label: "Center Right", value: "right center" },
  { label: "Top Center", value: "center top" },
  { label: "Top Left", value: "left top" },
  { label: "Top Right", value: "right top" },
  { label: "Bottom Center", value: "center bottom" },
  { label: "Bottom Left", value: "left bottom" },
  { label: "Bottom Right", value: "right bottom" },
  { label: "Custom", value: "custom" },
] as const;

export function normalizePositionValue(raw: string | undefined): { mode: string; xVal: number; xUnit: "px" | "%"; yVal: number; yUnit: "px" | "%" } {
  const clean = (raw ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!clean || clean === "default" || clean === "initial" || clean === "unset") {
    return { mode: "", xVal: 0, xUnit: "px", yVal: 0, yUnit: "px" };
  }

  // Check preset matches
  if (clean === "center center" || clean === "center" || clean === "50% 50%") {
    return { mode: "center center", xVal: 50, xUnit: "%", yVal: 50, yUnit: "%" };
  }
  if (clean === "left center" || clean === "center left" || clean === "left" || clean === "0% 50%") {
    return { mode: "left center", xVal: 0, xUnit: "%", yVal: 50, yUnit: "%" };
  }
  if (clean === "right center" || clean === "center right" || clean === "right" || clean === "100% 50%") {
    return { mode: "right center", xVal: 100, xUnit: "%", yVal: 50, yUnit: "%" };
  }
  if (clean === "center top" || clean === "top center" || clean === "top" || clean === "50% 0%") {
    return { mode: "center top", xVal: 50, xUnit: "%", yVal: 0, yUnit: "%" };
  }
  if (clean === "left top" || clean === "top left" || clean === "0% 0%") {
    return { mode: "left top", xVal: 0, xUnit: "%", yVal: 0, yUnit: "%" };
  }
  if (clean === "right top" || clean === "top right" || clean === "100% 0%") {
    return { mode: "right top", xVal: 100, xUnit: "%", yVal: 0, yUnit: "%" };
  }
  if (clean === "center bottom" || clean === "bottom center" || clean === "bottom" || clean === "50% 100%") {
    return { mode: "center bottom", xVal: 50, xUnit: "%", yVal: 100, yUnit: "%" };
  }
  if (clean === "left bottom" || clean === "bottom left" || clean === "0% 100%") {
    return { mode: "left bottom", xVal: 0, xUnit: "%", yVal: 100, yUnit: "%" };
  }
  if (clean === "right bottom" || clean === "bottom right" || clean === "100% 100%") {
    return { mode: "right bottom", xVal: 100, xUnit: "%", yVal: 100, yUnit: "%" };
  }

  // Parse numeric/custom coordinates
  const parts = clean.split(/\s+/);
  const parseCoord = (part: string | undefined): { val: number; unit: "px" | "%" } => {
    if (!part) return { val: 0, unit: "px" };
    if (part === "center") return { val: 50, unit: "%" };
    if (part === "top" || part === "left") return { val: 0, unit: "%" };
    if (part === "bottom" || part === "right") return { val: 100, unit: "%" };
    const m = /^(-?[\d.]+)(px|%)?$/i.exec(part);
    if (m) {
      return { val: parseFloat(m[1]!) || 0, unit: (m[2]?.toLowerCase() === "%" ? "%" : "px") };
    }
    return { val: 0, unit: "px" };
  };

  const x = parseCoord(parts[0]);
  const y = parseCoord(parts[1] ?? parts[0]);
  return { mode: "custom", xVal: x.val, xUnit: x.unit, yVal: y.val, yUnit: y.unit };
}

export function ImagePositionControl({
  value,
  device = "desktop",
  disabled = false,
  onChange,
  onCommit,
}: {
  value: string | undefined;
  device?: "desktop" | "tablet" | "mobile";
  disabled?: boolean;
  onChange: (nextValue: string) => void;
  onCommit?: () => void;
}) {
  const parsed = normalizePositionValue(value);
  const [selectedMode, setSelectedMode] = useState<string>(parsed.mode);
  const [xVal, setXVal] = useState<number>(parsed.xVal);
  const [xUnit, setXUnit] = useState<"px" | "%">(parsed.xUnit);
  const [yVal, setYVal] = useState<number>(parsed.yVal);
  const [yUnit, setYUnit] = useState<"px" | "%">(parsed.yUnit);

  useEffect(() => {
    const next = normalizePositionValue(value);
    setSelectedMode(next.mode);
    setXVal(next.xVal);
    setXUnit(next.xUnit);
    setYVal(next.yVal);
    setYUnit(next.yUnit);
  }, [value]);

  const DeviceIcon = device === "desktop" ? IconDesktop : device === "tablet" ? IconTablet : IconPhone;

  const handleModeChange = (newMode: string) => {
    setSelectedMode(newMode);
    if (newMode === "") {
      onChange("");
      onCommit?.();
    } else if (newMode === "custom") {
      const pos = `${xVal}${xUnit} ${yVal}${yUnit}`;
      onChange(pos);
      onCommit?.();
    } else {
      onChange(newMode);
      onCommit?.();
    }
  };

  const updateCustomX = (nextVal: number, nextUnit: "px" | "%") => {
    const val = nextUnit === "%" ? Math.max(0, Math.min(100, nextVal)) : Math.max(-2000, Math.min(2000, nextVal));
    setXVal(val);
    setXUnit(nextUnit);
    setSelectedMode("custom");
    onChange(`${val}${nextUnit} ${yVal}${yUnit}`);
  };

  const updateCustomY = (nextVal: number, nextUnit: "px" | "%") => {
    const val = nextUnit === "%" ? Math.max(0, Math.min(100, nextVal)) : Math.max(-2000, Math.min(2000, nextVal));
    setYVal(val);
    setYUnit(nextUnit);
    setSelectedMode("custom");
    onChange(`${xVal}${xUnit} ${val}${nextUnit}`);
  };

  const isCustom = selectedMode === "custom";

  return (
    <div className="space-y-2.5 pt-1">
      {/* Position Header Row */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-[11px] font-medium text-ink-2">
          <span>Position</span>
          <span className="text-muted/80" title={`Current breakpoint: ${device}`}>
            <DeviceIcon size={13} />
          </span>
        </div>
        <select
          disabled={disabled}
          value={selectedMode}
          onChange={(e) => handleModeChange(e.target.value)}
          className="h-7 w-40 rounded-lg border border-line bg-white px-2 text-[11px] font-medium text-ink outline-none transition focus:border-blue"
        >
          {POSITION_PRESETS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
      </div>

      {/* Custom X & Y Position Sliders & Inputs */}
      {isCustom && (
        <div className="space-y-2 rounded-lg border border-line/70 bg-sunken/40 p-2.5">
          {/* X Position */}
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5 text-[10px] font-semibold text-ink-2">
                <span>X Position</span>
                <span className="text-muted/80">
                  <DeviceIcon size={12} />
                </span>
              </div>
              <select
                disabled={disabled}
                value={xUnit}
                onChange={(e) => {
                  const u = e.target.value as "px" | "%";
                  updateCustomX(xVal, u);
                  onCommit?.();
                }}
                className="h-5 rounded border border-line bg-white px-1 font-mono text-[10px] text-ink outline-none focus:border-blue"
              >
                <option value="px">px</option>
                <option value="%">%</option>
              </select>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="range"
                disabled={disabled}
                min={xUnit === "%" ? 0 : -500}
                max={xUnit === "%" ? 100 : 500}
                step={1}
                value={xVal}
                onChange={(e) => updateCustomX(Number(e.target.value), xUnit)}
                onMouseUp={() => onCommit?.()}
                onTouchEnd={() => onCommit?.()}
                className="h-1.5 flex-1 cursor-pointer accent-blue"
              />
              <input
                type="number"
                disabled={disabled}
                min={xUnit === "%" ? 0 : -2000}
                max={xUnit === "%" ? 100 : 2000}
                value={xVal}
                onChange={(e) => updateCustomX(Number(e.target.value) || 0, xUnit)}
                onBlur={() => onCommit?.()}
                className="h-6 w-14 rounded border border-line bg-white px-1.5 text-right font-mono text-[11px] text-ink outline-none focus:border-blue"
              />
            </div>
          </div>

          {/* Y Position */}
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5 text-[10px] font-semibold text-ink-2">
                <span>Y Position</span>
                <span className="text-muted/80">
                  <DeviceIcon size={12} />
                </span>
              </div>
              <select
                disabled={disabled}
                value={yUnit}
                onChange={(e) => {
                  const u = e.target.value as "px" | "%";
                  updateCustomY(yVal, u);
                  onCommit?.();
                }}
                className="h-5 rounded border border-line bg-white px-1 font-mono text-[10px] text-ink outline-none focus:border-blue"
              >
                <option value="px">px</option>
                <option value="%">%</option>
              </select>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="range"
                disabled={disabled}
                min={yUnit === "%" ? 0 : -500}
                max={yUnit === "%" ? 100 : 500}
                step={1}
                value={yVal}
                onChange={(e) => updateCustomY(Number(e.target.value), yUnit)}
                onMouseUp={() => onCommit?.()}
                onTouchEnd={() => onCommit?.()}
                className="h-1.5 flex-1 cursor-pointer accent-blue"
              />
              <input
                type="number"
                disabled={disabled}
                min={yUnit === "%" ? 0 : -2000}
                max={yUnit === "%" ? 100 : 2000}
                value={yVal}
                onChange={(e) => updateCustomY(Number(e.target.value) || 0, yUnit)}
                onBlur={() => onCommit?.()}
                className="h-6 w-14 rounded border border-line bg-white px-1.5 text-right font-mono text-[11px] text-ink outline-none focus:border-blue"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
