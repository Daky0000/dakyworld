import { clampFocal, cropResolution, IMAGE_ASPECTS } from "../../../src/shared/websiteImageFraming";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { parseStyle, writeStyle } from "./InspectorControls";

export function WebsiteImageFraming({ src, siteId, style, onApply }: { src: string; siteId?: string; style: string; onApply: (style: string) => void }) {
  const existing = parseStyle(style);
  const assets = useQuery({ queryKey: ["website", "assets", siteId], enabled: !!siteId, queryFn: () => api.get<Array<{ url: string; preview: string }>>(`/website/sites/${siteId}/assets`) });
  // Both sides can be relative (`/assets/hero.png` is the common case), so both
  // are resolved against the page before they are compared. Resolving one
  // against the other discards it whenever it is already absolute, which made
  // this match nothing at all for every relative `src`.
  const absolute = (value: string) => { try { return new URL(value, window.location.href).href; } catch { return value; } };
  const previewSrc = assets.data?.find(asset => absolute(asset.url) === absolute(src))?.preview ?? src;
  const [x, setX] = useState(() => Number(/^(\d+)%/.exec(existing["object-position"] ?? "")?.[1] ?? 50));
  const [y, setY] = useState(() => Number(/ (\d+)%$/.exec(existing["object-position"] ?? "")?.[1] ?? 50));
  const [ratio, setRatio] = useState(() => existing["aspect-ratio"] || "16 / 9");
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const [a, b] = ratio.split("/").map(Number);
  const resolution = cropResolution(dimensions.width, dimensions.height, a / b);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [previewSrc]);
  const position = `${x}% ${y}%`;
  return <details className="mb-3 rounded-xl border border-line p-3">
    <summary className="cursor-pointer text-sm font-semibold">Crop & focal point</summary>
    <p className="my-2 text-xs text-muted">Choose the visible area. The original image is kept. Apply at Desktop for all sizes, or Phone for a phone override.</p>
    <label className="block text-xs">Shape<select aria-label="Shape" className="my-2 block w-full rounded-lg border border-line p-2" value={ratio} onChange={e => setRatio(e.target.value)}>{!IMAGE_ASPECTS.includes(ratio as typeof IMAGE_ASPECTS[number]) && <option value={ratio}>Current ratio ? {ratio}</option>}<option value="16 / 9">Wide · 16:9</option><option value="4 / 3">Landscape · 4:3</option><option value="1 / 1">Square</option><option value="3 / 4">Portrait · 3:4</option></select></label>
    <div className="grid grid-cols-2 items-start gap-2">{["Desktop", "Phone"].map(device => <figure key={device} className={device === "Phone" ? "mx-auto w-3/4" : "w-full"}><figcaption className="mb-1 text-xs text-muted">{device} framing</figcaption><button type="button" aria-label={`Set focal point in ${device} image`} className="relative block w-full overflow-hidden rounded-lg bg-sunken" style={{ aspectRatio: ratio }} onClick={e => { const rect = e.currentTarget.getBoundingClientRect(); setX(clampFocal(Math.round(100 * (e.clientX - rect.left) / rect.width))); setY(clampFocal(Math.round(100 * (e.clientY - rect.top) / rect.height))); }}><img src={previewSrc} alt="Image crop preview" onLoad={e => setDimensions({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })} onError={() => setFailed(true)} className="h-full w-full" style={{ objectFit: "cover", objectPosition: position }} /><span aria-hidden className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-blue" style={{ left: `${x}%`, top: `${y}%` }} /></button></figure>)}</div>
    {resolution.width > 0 && <p className="my-2 text-xs text-muted">Crop resolution: {Math.round(resolution.width)} ? {Math.round(resolution.height)} pixels.{resolution.width < 800 ? " Use a larger image for crisp full-width display." : ""}</p>}
    {failed && <p role="alert" className="my-2 text-xs text-danger-text">This image could not be previewed. Choose an image from the library.</p>}
    {([["Horizontal", x, setX], ["Vertical", y, setY]] as const).map(([label, value, update]) => <label key={label} className="mt-3 block text-xs">{label} focal point · {value}%<input className="block w-full" type="range" min="0" max="100" value={value} onChange={e => update(clampFocal(Number(e.target.value)))} /></label>)}
    <p className="my-2 text-xs text-muted">These show the chosen crop at two widths. Check the page preview for the surrounding layout.</p>
    <button type="button" disabled={failed} className="rounded-lg bg-ink px-3 py-2 text-xs text-white disabled:opacity-50" onClick={() => onApply(writeStyle({ ...existing, "object-fit": "cover", "object-position": position, "aspect-ratio": ratio, width: "100%", height: "auto" }))}>Apply crop to draft</button>
  </details>;
}
