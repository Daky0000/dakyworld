import { capacity } from "./capacity.js";
import { withCapacityLease } from "./leases.js";

/** One-shot calls and individual agent turns share the same database-backed ceiling. */
export function withModelCapacity<T>(work: () => Promise<T>): Promise<T> {
  return capacity.admission ? withCapacityLease("ai", capacity.aiConcurrency, work) : work();
}
