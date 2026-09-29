/** Coalesces overlapping invocations without retaining a completed or rejected promise. */
export function singleFlight<A extends unknown[], T>(work: (...args: A) => Promise<T>) {
  let pending: Promise<T> | undefined;
  const run = (...args: A): Promise<T> => {
    if (!pending) pending = Promise.resolve().then(() => work(...args)).finally(() => { pending = undefined; });
    return pending;
  };
  return Object.assign(run, { idle: () => pending ?? Promise.resolve() });
}
/** Preserves input order while bounding expensive operations within one batch. */
export async function mapConcurrent<T, R>(items: readonly T[], limit: number, work: (item: T, index: number) => Promise<R>): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("Concurrency must be a positive integer");
  const results: R[] = new Array(items.length);
  let next = 0;
  let failed = false;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try { results[index] = await work(items[index]!, index); }
      catch (error) { failed = true; throw error; }
    }
  }));
  return results;
}
