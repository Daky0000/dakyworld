import { capacity } from "./capacity.js";

let managed = false;
let safeUntil = 0;
export function renewBackgroundOwnership() { managed = true; safeUntil = Date.now() + 30_000; }
export function stopBackgroundOwnership() { managed = true; safeUntil = 0; }
/** Refuse work after an event-loop pause, before the 45-second database lease can change owners. */
export function backgroundRunAllowed() {
  if (capacity.role === "api") return false;
  if (!managed) return capacity.role === "combined";
  return Date.now() < safeUntil;
}
