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
  if (property === "object-position" || property === "background-position") {
    // A background may have several layers, each with a position of its own:
    // `0% 0%, center center`. Each one is held to the same rule; an object has
    // exactly one. Reading the list as one position refused every layered
    // background, and the declaration was dropped on save without a word.
    const layers = property === "background-position" ? clean.split(",").map(layer => layer.trim()) : [clean];
    if (layers.length > 1) return layers.every(layer => layer !== "" && validFramingDeclaration(property, layer));
    const parts = clean.split(/\s+/);
    if (parts.length > 2) return false;
    const validPart = (part: string) => {
      if (part === "0" || part === "0px") return true;
      if (/^(?:center|top|bottom|left|right)$/i.test(part)) return true;
      if (/^[+\-]?\d+(?:\.\d+)?%$/.test(part)) {
        const num = Number(part.slice(0, -1));
        return num >= 0 && num <= 100;
      }
      if (/^[+\-]?\d+(?:\.\d+)?px$/i.test(part)) {
        return Number.isFinite(Number(part.slice(0, -2)));
      }
      return false;
    };
    return parts.every(validPart);
  }
  return true;
}
export function cropResolution(width: number, height: number, ratio: number): { width: number; height: number } {
  if (![width, height, ratio].every(n => Number.isFinite(n) && n > 0)) return { width: 0, height: 0 };
  return width / height > ratio ? { width: height * ratio, height } : { width, height: width / ratio };
}
