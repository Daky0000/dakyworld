import { useEffect, useSyncExternalStore } from "react";
import { api } from "./api";
import { useAuth } from "./auth";

/**
 * What a person has already been shown: guided tours finished or dismissed, the
 * welcome done, the getting-started list hidden.
 *
 * Kept on the account (`User.uiState`, PATCH /api/auth/ui-state) so a tour
 * finished on a laptop does not start again on a phone, with this browser's
 * storage as a write-through copy. The copy is what keeps a dismissal when the
 * server cannot be reached, and it is merged on the way in: a tour either copy
 * says is finished or dismissed stays that way — the one thing that must never
 * happen is a tour somebody closed reappearing.
 */

export type TourStatus = "done" | "dismissed" | "started";
export type TourRecord = { status: TourStatus; step?: number; at: string };
export type UiState = {
  tours?: Record<string, TourRecord>;
  welcome?: { status: "done" | "skipped"; at: string };
  checklist?: { hidden: boolean };
};

const RANK: Record<TourStatus, number> = { started: 0, dismissed: 1, done: 2 };

function merge(base: UiState, patch: UiState): UiState {
  const tours = { ...(base.tours ?? {}) };
  for (const [id, record] of Object.entries(patch.tours ?? {})) {
    const before = tours[id];
    // A later "started" never undoes a "done"; anything else takes the newer word.
    tours[id] = before && RANK[before.status] > RANK[record.status] && record.status === "started" ? before : record;
  }
  return {
    ...base,
    ...patch,
    tours,
    welcome: patch.welcome ?? base.welcome,
    checklist: patch.checklist ?? base.checklist,
  };
}

function isUiState(value: unknown): value is UiState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  // Nothing but the three keys this keeps: a reply that is some other object
  // must not be merged in as somebody's progress.
  if (!Object.keys(value).every((key) => key === "tours" || key === "welcome" || key === "checklist")) return false;
  const tours = (value as UiState).tours;
  return tours === undefined || (typeof tours === "object" && tours !== null && !Array.isArray(tours));
}

let current: UiState = {};
let owner: string | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());
const storageKey = (id: string) => `dakyx-ui-state:${id}`;

function readCopy(id: string): UiState {
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey(id)) ?? "{}");
    return isUiState(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeCopy() {
  if (!owner) return;
  try { localStorage.setItem(storageKey(owner), JSON.stringify(current)); } catch { /* Optional copy. */ }
}

/** Loads one account's state, once per account. */
function hydrate(id: string, server: unknown) {
  if (owner === id) return;
  owner = id;
  current = merge(readCopy(id), isUiState(server) ? server : {});
  writeCopy();
  emit();
}

/** Records a change here at once, then on the account. */
export function updateUiState(patch: UiState) {
  current = merge(current, patch);
  writeCopy();
  emit();
  void api.patch<unknown>("/auth/ui-state", patch).then(
    (saved) => {
      // Only a real state is taken back; a server that answered with
      // something else leaves what this browser already knows.
      if (isUiState(saved)) {
        current = merge(current, saved);
        writeCopy();
        emit();
      }
    },
    () => { /* The local copy stands until the next save reaches the server. */ },
  );
}

export function useUiState(): UiState {
  const { user } = useAuth();
  const serverState = (user as { uiState?: unknown } | null)?.uiState;
  useEffect(() => {
    if (user) hydrate(user.id, serverState);
  }, [user, serverState]);
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    () => current,
    () => current,
  );
}

/** Whether a tour has been finished or put away by this person. */
export function tourSeen(state: UiState, id: string): boolean {
  const status = state.tours?.[id]?.status;
  return status === "done" || status === "dismissed";
}
