/** CSS framing does not modify image bytes. Every positive ratio is drawable. */
export const IMAGE_ASPECTS = ["16 / 9", "4 / 3", "1 / 1", "3 / 4"] as const;
export function clampFocal(value: number): number { return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 50; }
export function validFramingDeclaration(property: string, value: string): boolean {
  const clean = value.replace(/\s*!\s*important$/i, "").trim();
  if (["inherit", "initial", "unset", "revert"].includes(clean)) return true;
  if (property === "aspect-ratio") {
    if (clean === "auto") return true;
    const parts = clean.replace(/^auto\s+/, "").split("/").map(part => Number(part.trim()));
    return parts.length <= 2 && parts.every(n => Number.isFinite(n) && n > 0);
  }
  if (property === "object-position" && /^[+\-\d.%\s]+$/.test(clean)) {
    const parts = clean.split(/\s+/);
    return parts.length <= 2 && parts.every(part => part === "0" || /^\d+(?:\.\d+)?%$/.test(part) && Number(part.slice(0, -1)) <= 100);
  }
  return true;
}
export function cropResolution(width: number, height: number, ratio: number): { width: number; height: number } {
  if (![width, height, ratio].every(n => Number.isFinite(n) && n > 0)) return { width: 0, height: 0 };
  return width / height > ratio ? { width: height * ratio, height } : { width, height: width / ratio };
}
