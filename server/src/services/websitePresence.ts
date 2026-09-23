export type EditorPresence = {
  userId: string;
  name: string;
  email?: string;
  color: string;
  lastSeenAt: number;
};

const PRESENCE_TTL_MS = 45_000;

// Deterministic pleasing palette for user avatars
const PALETTE = [
  "#2563eb", // blue
  "#059669", // emerald
  "#d97706", // amber
  "#7c3aed", // violet
  "#db2777", // pink
  "#0891b2", // cyan
  "#ea580c", // orange
  "#4f46e5", // indigo
];

function pickColor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash << 5) - hash + id.charCodeAt(i);
  return PALETTE[Math.abs(hash) % PALETTE.length];
}

// Map<pageId, Map<userId, EditorPresence>>
const pagePresence = new Map<string, Map<string, EditorPresence>>();

function prune(pageId: string): Map<string, EditorPresence> {
  const map = pagePresence.get(pageId);
  if (!map) return new Map();
  const now = Date.now();
  for (const [userId, entry] of map.entries()) {
    if (now - entry.lastSeenAt > PRESENCE_TTL_MS) {
      map.delete(userId);
    }
  }
  if (map.size === 0) {
    pagePresence.delete(pageId);
  }
  return map;
}

export function recordPresence(
  pageId: string,
  user: { id: string; name?: string | null; email?: string | null },
): EditorPresence[] {
  let map = pagePresence.get(pageId);
  if (!map) {
    map = new Map();
    pagePresence.set(pageId, map);
  }
  const now = Date.now();
  const name = user.name?.trim() || user.email?.split("@")[0] || "Editor";
  map.set(user.id, {
    userId: user.id,
    name,
    email: user.email ?? undefined,
    color: pickColor(user.id),
    lastSeenAt: now,
  });

  const active = prune(pageId);
  return Array.from(active.values()).filter((item) => item.userId !== user.id);
}

export function removePresence(pageId: string, userId: string): void {
  const map = pagePresence.get(pageId);
  if (map) {
    map.delete(userId);
    if (map.size === 0) pagePresence.delete(pageId);
  }
}

export function getPresence(pageId: string, excludeUserId?: string): EditorPresence[] {
  const active = prune(pageId);
  return Array.from(active.values()).filter((item) => !excludeUserId || item.userId !== excludeUserId);
}
