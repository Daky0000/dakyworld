/**
 * A short-lived memory of what a page's HTML said, so that opening an editor
 * does not re-read the same file from GitHub a dozen times.
 *
 * Reading is the hot path and it was entirely uncached. Opening one page fetches
 * the file to list its fields; the preview frame fetches it again; every autosave
 * fetches it again to stamp each edit with what the page currently says; the
 * publish confirmation fetches it again. On a page somebody is actively editing
 * that is a GitHub API call every few seconds, per editor, for a file that
 * changes when *they* change it.
 *
 * Three things about this cache are load-bearing.
 *
 * **The publish path never reads it.** The conflict check exists to answer "has
 * the page moved under this draft", and answering that from a copy taken ninety
 * seconds ago is answering a different question. `pageSource(..., { fresh: true })`
 * is not an optimisation switch — it is what keeps the guarantee true.
 *
 * **A publish invalidates the page it wrote.** Otherwise the editor spends the
 * rest of the TTL showing the version from before the commit, and the reload
 * that is supposed to confirm the publish confirms the opposite.
 *
 * **The live-site read gets a much shorter life than the repository read.** They
 * are not the same kind of answer. A repository read is exact and immediate — it
 * is the commit itself. A live-site read is whatever GitHub Pages has finished
 * building, which already lags a publish by a minute or two; a two-minute cache
 * on top of a two-minute build is four minutes of an editor insisting that a
 * publish which plainly worked did nothing, which is a bug this module has
 * already shipped once for a different reason.
 *
 * In-process and deliberately so. There is no Redis here, this is one small
 * service, and a cache that outlives the process would have to be invalidated by
 * something the process cannot see. If this ever runs on more than one instance
 * the worst case is that two editors each hold their own ninety seconds of
 * staleness — and the publish path, which is the only place staleness would be
 * dangerous, does not read it at all.
 */

export type CachedSource = { html: string; from: "repository" | "live site" };

type Entry = CachedSource & { until: number };

/** Repository reads: exact, and only invalidated by a commit we make ourselves. */
export const REPO_TTL_MS = 120_000;
/** Live-site reads: already lagging a publish, so kept only long enough to stop a burst. */
export const LIVE_TTL_MS = 20_000;

/**
 * Enough that a busy afternoon on one site never evicts itself, small enough
 * that a page of HTML per entry cannot become the reason this process runs out
 * of memory. Eviction is oldest-deadline-first, which for a uniform TTL is
 * least-recently-written.
 */
const MAX_ENTRIES = 200;

const store = new Map<string, Entry>();

/**
 * Everything that decides which bytes come back.
 *
 * The branch and the ref are in it because reading `main` and reading a release
 * branch are different questions about the same path, and the site id is in it
 * even though the repository coordinates already identify the file: two sites
 * pointed at one repository are two subscriptions, and invalidating one must not
 * silently invalidate the other's.
 */
export function sourceKey(input: { siteId: string; repo: string | null; branch: string; filePath: string; ref?: string }): string {
  return [input.siteId, input.repo ?? "live", input.branch, input.filePath, input.ref ?? ""].join("|");
}

export function readCache(key: string): CachedSource | null {
  const entry = store.get(key);
  if (!entry) return null;
  if (entry.until <= Date.now()) {
    store.delete(key);
    return null;
  }
  return { html: entry.html, from: entry.from };
}

export function writeCache(key: string, value: CachedSource): void {
  if (store.size >= MAX_ENTRIES && !store.has(key)) {
    let oldestKey: string | null = null;
    let oldest = Number.POSITIVE_INFINITY;
    for (const [candidate, entry] of store) {
      if (entry.until < oldest) {
        oldest = entry.until;
        oldestKey = candidate;
      }
    }
    if (oldestKey) store.delete(oldestKey);
  }
  store.set(key, { ...value, until: Date.now() + (value.from === "repository" ? REPO_TTL_MS : LIVE_TTL_MS) });
}

/**
 * Forgets a page, or a whole site.
 *
 * Called after every publish. Matching on the key's own prefix rather than
 * keeping a second index: the number of entries is capped at two hundred, so a
 * scan is cheaper than the bookkeeping that would avoid it.
 */
export function invalidateSource(siteId: string, filePath?: string): number {
  let dropped = 0;
  for (const key of [...store.keys()]) {
    const parts = key.split("|");
    if (parts[0] !== siteId) continue;
    if (filePath !== undefined && parts[3] !== filePath) continue;
    store.delete(key);
    dropped += 1;
  }
  return dropped;
}

/** Test seam. Nothing in the application calls this. */
export function clearSourceCache(): void {
  store.clear();
}

export function sourceCacheSize(): number {
  return store.size;
}
